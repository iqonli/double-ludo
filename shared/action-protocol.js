(function (root, factory) {
  const engineApi = typeof module === 'object' && module.exports
    ? require('./engine.js')
    : root.DoubleFlight;
  const api = factory(engineApi);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DoubleFlightProtocol = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (engineApi) {
  'use strict';

  if (!engineApi || !engineApi.DoubleFlightEngine) throw new Error('缺少 DoubleFlight 规则引擎');

  const COLOR_TO_INT = { red: 0, yellow: 1, blue: 2, green: 3 };
  const INT_TO_COLOR = ['red', 'yellow', 'blue', 'green'];
  const ACTION_SPACE = 292;

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function globalPieceIndex(pieceOrId) {
    const id = typeof pieceOrId === 'string' ? pieceOrId : pieceOrId.id;
    const [color, rawIndex] = String(id).split('-');
    if (!(color in COLOR_TO_INT)) throw new Error(`未知棋子颜色：${color}`);
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0 || index > 3) throw new Error(`棋子编号无效：${id}`);
    return COLOR_TO_INT[color] * 4 + index;
  }

  function pieceIdFromGlobal(index) {
    const value = Number(index);
    if (!Number.isInteger(value) || value < 0 || value >= 16) throw new Error(`全局棋子编号无效：${index}`);
    return `${INT_TO_COLOR[Math.floor(value / 4)]}-${value % 4}`;
  }

  function swapAction(firstPieceId, secondPieceId) {
    return 20 + globalPieceIndex(firstPieceId) * 16 + globalPieceIndex(secondPieceId);
  }

  // Swap pairs are logically unordered, but the model/action protocol stores only
  // one direction: the piece whose colour appears first in the current player's
  // colour list must occupy the high 4 bits. Normalize reverse click order without
  // expanding the legal action set or changing the trained AI action mapping.
  function normalizeSwapAction(engine, actionCode) {
    const action = ensureActionCode(actionCode);
    if (!engine || action < 20 || action > 275) return action;
    const packed = action - 20;
    const firstId = pieceIdFromGlobal(Math.floor(packed / 16));
    const secondId = pieceIdFromGlobal(packed % 16);
    const firstPiece = engine.getPiece(firstId);
    const secondPiece = engine.getPiece(secondId);
    const player = engine.getCurrentPlayer();
    const colors = player && Array.isArray(player.colors) ? player.colors : [];
    if (!firstPiece || !secondPiece || firstPiece.color === secondPiece.color) return action;
    const firstOrder = colors.indexOf(firstPiece.color);
    const secondOrder = colors.indexOf(secondPiece.color);
    if (firstOrder < 0 || secondOrder < 0 || firstOrder <= secondOrder) return action;
    return swapAction(secondId, firstId);
  }

  function legalActions(engine) {
    if (!engine || engine.gameOver || engine.phase === 'gameOver' || engine.pendingDefeat) return [];
    const actions = [];
    if (engine.phase === 'awaitRoll') {
      actions.push(0);
      if (engine.canSwap()) {
        const colors = engine.getCurrentPlayer().colors;
        const first = engine.getSwapEligiblePieceIds(colors[0]);
        const second = engine.getSwapEligiblePieceIds(colors[1]);
        for (const a of first) {
          for (const b of second) {
            const pa = engine.getPiece(a);
            const pb = engine.getPiece(b);
            if (engine.getPhysicalLocationKey(pa) !== engine.getPhysicalLocationKey(pb)) {
              actions.push(swapAction(a, b));
            }
          }
        }
      }
    } else if (engine.phase === 'selectDie') {
      if (engine.canPassTurn()) actions.push(1);
      for (const dieIndex of engine.getSelectableDieIndices()) {
        if (engine.getMovablePieceIdsForDie(dieIndex).length) actions.push(2 + dieIndex);
      }
    } else if (engine.phase === 'selectPiece') {
      // The rules engine permits selecting the current die again to deselect it,
      // or selecting another unspent usable die before choosing a piece.
      for (const dieIndex of engine.getSelectableDieIndices()) {
        if (engine.getMovablePieceIdsForDie(dieIndex).length) actions.push(2 + dieIndex);
      }
      for (const id of engine.getMovablePieceIdsForSelectedDie()) actions.push(4 + globalPieceIndex(id));
    } else if (engine.phase === 'chooseSwapOrder') {
      const plan = engine.analyzePendingSwap();
      if (plan.equivalent) actions.push(276 + globalPieceIndex(plan.automaticFirstPieceId));
      else for (const id of plan.pieceIds) actions.push(276 + globalPieceIndex(id));
    }
    return Array.from(new Set(actions)).sort((a, b) => a - b);
  }

  function fnv1a32(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
  }

  function stateHash(snapshot, openingRollPending) {
    return fnv1a32(JSON.stringify({ snapshot, openingRollPending: Boolean(openingRollPending) }));
  }

  function autoSelectForcedDice(engine) {
    const events = [];
    const results = [];
    while (engine && !engine.pendingDefeat && engine.phase === 'selectDie' && engine.currentRoll) {
      const indices = engine.getSelectableDieIndices();
      const forcedSingle = engine.currentRoll.type === 'single' && indices.length === 1;
      const forcedRemainder = indices.length === 1 && engine.assignments.length > 0;
      if (!forcedSingle && !forcedRemainder) break;
      const result = engine.selectDie(indices[0]);
      results.push(clone(result));
      if (result && Array.isArray(result.events)) events.push(...result.events);
      if (result && (result.noMoveForDie || engine.phase === 'selectPiece')) break;
    }
    return { events, results };
  }

  function ensureActionCode(actionCode) {
    const action = Number(actionCode);
    if (!Number.isInteger(action) || action < 0 || action >= ACTION_SPACE) {
      throw new Error(`动作编号无效：${actionCode}`);
    }
    return action;
  }

  function executeAction(engine, actionCode, context) {
    const ctx = context || {};
    const requestedAction = ensureActionCode(actionCode);
    const action = normalizeSwapAction(engine, requestedAction);
    const legal = legalActions(engine);
    if (!legal.includes(action)) throw new Error(`当前局面不允许动作 ${requestedAction}`);

    const randomDie = typeof ctx.randomDie === 'function'
      ? ctx.randomDie
      : () => Math.floor(Math.random() * 6) + 1;
    let openingRollPending = Boolean(ctx.openingRollPending);
    const events = [];
    const meta = { actionCode: action };

    if (action === 0) {
      if (openingRollPending && engine.mode === 'classic' && engine.rollSpec.type === 'double') {
        let attempts = 0;
        const rolls = [];
        while (openingRollPending) {
          attempts += 1;
          if (attempts > 10000) throw new Error('开局自动投骰次数异常');
          const values = [randomDie(), randomDie()];
          rolls.push(values.slice());
          if (values.some(value => engine.launchValues.includes(value)) || values.includes(6)) {
            engine.rollDice(values);
            openingRollPending = false;
            break;
          }
          const skipped = engine.skipOpeningRoll(values);
          if (skipped && Array.isArray(skipped.events)) events.push(...skipped.events);
        }
        meta.rolls = rolls;
        meta.values = rolls[rolls.length - 1] || [];
      } else {
        const count = engine.rollSpec.type === 'single' ? 1 : 2;
        const values = Array.from({ length: count }, randomDie);
        engine.rollDice(values);
        meta.values = values;
      }
      const forced = autoSelectForcedDice(engine);
      events.push(...forced.events);
      meta.forced = forced.results;
    } else if (action === 1) {
      const result = engine.passTurn();
      if (result && Array.isArray(result.events)) events.push(...result.events);
      const forced = autoSelectForcedDice(engine);
      events.push(...forced.events);
      meta.result = clone(result);
      meta.forced = forced.results;
    } else if (action >= 2 && action <= 3) {
      const result = engine.selectDie(action - 2);
      if (result && Array.isArray(result.events)) events.push(...result.events);
      meta.result = clone(result);
    } else if (action >= 4 && action <= 19) {
      const pieceId = pieceIdFromGlobal(action - 4);
      events.push(...engine.moveSelectedPiece(pieceId));
      meta.pieceId = pieceId;
      if (!engine.pendingDefeat && !engine.gameOver) {
        const forced = autoSelectForcedDice(engine);
        events.push(...forced.events);
        meta.forced = forced.results;
      }
    } else if (action >= 20 && action <= 275) {
      const packed = action - 20;
      const firstId = pieceIdFromGlobal(Math.floor(packed / 16));
      const secondId = pieceIdFromGlobal(packed % 16);
      engine.beginSwap(firstId, secondId);
      const plan = engine.analyzePendingSwap();
      meta.pieceIds = [firstId, secondId];
      meta.swapEquivalent = plan.equivalent;
      if (plan.equivalent) {
        events.push(...engine.resolveSwapOrder(plan.automaticFirstPieceId));
        meta.firstPieceId = plan.automaticFirstPieceId;
      }
    } else if (action >= 276 && action <= 291) {
      const pieceId = pieceIdFromGlobal(action - 276);
      events.push(...engine.resolveSwapOrder(pieceId));
      meta.firstPieceId = pieceId;
    }

    return {
      openingRollPending,
      events: clone(events),
      meta,
      snapshot: engine.serialize()
    };
  }

  function executeCommand(engine, command) {
    const name = String(command || '');
    let events = [];
    if (name === 'accept-defeat') {
      if (!engine.pendingDefeat) throw new Error('没有待确认的三连6遣返');
      engine.acceptPendingDefeat();
    } else if (name === 'undo-defeat') {
      if (!engine.pendingDefeat) throw new Error('没有待撤销的三连6遣返');
      events = engine.undoPendingDefeat();
    } else if (name === 'continue-after-win') {
      if (!engine.gameOver || engine.remainderComplete || !engine.winner) throw new Error('当前不能继续残局');
      engine.continueAfterWin();
    } else {
      throw new Error(`未知命令：${name}`);
    }
    return { events: clone(events), snapshot: engine.serialize() };
  }

  return {
    ACTION_SPACE,
    COLOR_TO_INT,
    INT_TO_COLOR,
    globalPieceIndex,
    pieceIdFromGlobal,
    swapAction,
    normalizeSwapAction,
    legalActions,
    stateHash,
    fnv1a32,
    autoSelectForcedDice,
    executeAction,
    executeCommand
  };
});
