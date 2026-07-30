(function (root) {
  'use strict';

  const COLOR_TO_INT = { red: 0, yellow: 1, blue: 2, green: 3 };
  const INT_TO_COLOR = ['red', 'yellow', 'blue', 'green'];
  const PHASE_TO_INT = { awaitRoll: 0, selectDie: 1, selectPiece: 2, chooseSwapOrder: 3, gameOver: 4 };
  const MODE_TO_INT = { classic: 0, speed: 1 };
  const ZONE_TO_INT = { airport: 0, launch: 1, main: 2, lane: 3, finished: 4, unused: 5 };
  const ACTION_SPACE = 292;
  const OBS_DIM = 350;

  function decodeFloat32(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    if (new Uint16Array(new Uint8Array([1, 0]).buffer)[0] === 1) {
      return new Float32Array(bytes.buffer);
    }
    const view = new DataView(bytes.buffer);
    const out = new Float32Array(bytes.byteLength / 4);
    for (let i = 0; i < out.length; i += 1) out[i] = view.getFloat32(i * 4, true);
    return out;
  }

  function oneHot(target, index, size) {
    for (let i = 0; i < size; i += 1) target.push(i === index ? 1 : 0);
  }

  function globalPieceIndex(pieceOrId) {
    const id = typeof pieceOrId === 'string' ? pieceOrId : pieceOrId.id;
    const [color, rawIndex] = id.split('-');
    return COLOR_TO_INT[color] * 4 + Number(rawIndex);
  }

  function pieceIdFromGlobal(index) {
    return `${INT_TO_COLOR[Math.floor(index / 4)]}-${index % 4}`;
  }

  function pieceLogicalState(piece, active) {
    if (!active) {
      return { active: 0, color: COLOR_TO_INT[piece.color], zone: 5, zoneColor: COLOR_TO_INT[piece.color], position: piece.index, direction: 1, finished: 0 };
    }
    const location = piece.location;
    const state = {
      active: 1,
      color: COLOR_TO_INT[piece.color],
      zone: ZONE_TO_INT[location.zone],
      zoneColor: COLOR_TO_INT[piece.color],
      position: 0,
      direction: Number(location.direction || 1),
      finished: piece.finished ? 1 : 0
    };
    if (location.zone === 'airport') {
      state.zoneColor = COLOR_TO_INT[location.zoneColor];
      state.position = Number(location.slot);
    } else if (location.zone === 'launch') {
      state.zoneColor = COLOR_TO_INT[location.zoneColor];
    } else if (location.zone === 'main') {
      state.zoneColor = -1;
      state.position = Number(location.mainIndex);
    } else if (location.zone === 'lane') {
      state.zoneColor = COLOR_TO_INT[location.laneColor];
      state.position = Number(location.laneIndex);
    } else if (location.zone === 'finished') {
      state.zoneColor = COLOR_TO_INT[location.finishColor];
    }
    return state;
  }

  function encodeObservation(engine, openingRollPending) {
    if (!engine) throw new Error('AI无法读取尚未开始的游戏。');
    const v = [];
    oneHot(v, engine.currentPlayerId === 'A' ? 0 : 1, 2);
    oneHot(v, PHASE_TO_INT[engine.phase] ?? 4, 5);
    oneHot(v, MODE_TO_INT[engine.mode] ?? 0, 2);
    oneHot(v, engine.rollSpec.type === 'single' ? 1 : 0, 2);
    const lockedColor = engine.rollSpec.lockedColor == null ? -1 : COLOR_TO_INT[engine.rollSpec.lockedColor];
    oneHot(v, lockedColor + 1, 5);

    const roll = engine.currentRoll;
    for (let i = 0; i < 2; i += 1) v.push(roll && roll.values[i] ? Number(roll.values[i]) / 6 : 0);
    for (let i = 0; i < 2; i += 1) v.push(roll && roll.spent[i] ? 1 : 0);
    for (let i = 0; i < 2; i += 1) {
      const color = roll && roll.colorByDie[i] ? COLOR_TO_INT[roll.colorByDie[i]] : -1;
      oneHot(v, color + 1, 5);
    }
    for (const color of INT_TO_COLOR) {
      v.push(Math.min(1, Math.max(0, Number(engine.colorState[color].consecutiveSixes || 0) / 2)));
    }
    for (const color of INT_TO_COLOR) v.push(engine.isProtected(color) ? 1 : 0);
    for (let die = 1; die <= 6; die += 1) v.push(engine.launchValues.includes(die) ? 1 : 0);
    v.push(openingRollPending ? 1 : 0, engine.gameOver ? 1 : 0);

    for (const color of INT_TO_COLOR) {
      for (let index = 0; index < 4; index += 1) {
        const active = index < engine.pieceCount;
        const piece = active ? engine.pieces[color][index] : { color, index };
        const p = pieceLogicalState(piece, active);
        v.push(p.active);
        oneHot(v, p.color, 4);
        oneHot(v, p.zone, 6);
        oneHot(v, p.zoneColor + 1, 5);
        const denom = p.zone === 2 ? 47 : 5;
        v.push(Math.max(-1, Math.min(1, denom ? p.position / denom : 0)));
        v.push(p.direction);
        v.push(p.finished);
      }
    }

    if (v.length !== OBS_DIM) throw new Error(`AI观察维度错误：${v.length}，应为${OBS_DIM}`);
    return new Float32Array(v);
  }

  function legalActions(engine) {
    if (!engine || engine.gameOver || engine.phase === 'gameOver') return [];
    const actions = [];
    if (engine.phase === 'awaitRoll') {
      actions.push(0);
      if (engine.canSwap()) {
        const colors = engine.getCurrentPlayer().colors;
        const first = engine.getSwapEligiblePieceIds(colors[0]).map(globalPieceIndex);
        const second = engine.getSwapEligiblePieceIds(colors[1]).map(globalPieceIndex);
        for (const a of first) {
          for (const b of second) {
            const pa = engine.getPiece(pieceIdFromGlobal(a));
            const pb = engine.getPiece(pieceIdFromGlobal(b));
            if (engine.getPhysicalLocationKey(pa) !== engine.getPhysicalLocationKey(pb)) actions.push(20 + a * 16 + b);
          }
        }
      }
    } else if (engine.phase === 'selectDie') {
      if (engine.canPassTurn()) actions.push(1);
      for (const dieIndex of engine.getSelectableDieIndices()) {
        if (engine.getMovablePieceIdsForDie(dieIndex).length) actions.push(2 + dieIndex);
      }
    } else if (engine.phase === 'selectPiece') {
      for (const id of engine.getMovablePieceIdsForSelectedDie()) actions.push(4 + globalPieceIndex(id));
    } else if (engine.phase === 'chooseSwapOrder') {
      const plan = engine.analyzePendingSwap();
      if (plan.equivalent) actions.push(276 + globalPieceIndex(plan.automaticFirstPieceId));
      else for (const id of plan.pieceIds) actions.push(276 + globalPieceIndex(id));
    }
    return Array.from(new Set(actions)).sort((a, b) => a - b);
  }

  function denseRelu(input, weights, bias, rows, cols) {
    const output = new Float32Array(rows);
    for (let row = 0; row < rows; row += 1) {
      let sum = bias[row];
      const offset = row * cols;
      for (let col = 0; col < cols; col += 1) sum += weights[offset + col] * input[col];
      output[row] = sum > 0 ? sum : 0;
    }
    return output;
  }

  function denseLinear(input, weights, bias, rows, cols) {
    const output = new Float32Array(rows);
    for (let row = 0; row < rows; row += 1) {
      let sum = bias[row];
      const offset = row * cols;
      for (let col = 0; col < cols; col += 1) sum += weights[offset + col] * input[col];
      output[row] = sum;
    }
    return output;
  }

  class PolicyModel {
    constructor(definition) {
      if (!definition || !definition.metadata || !definition.tensors) throw new Error('人机模型文件不完整。');
      this.metadata = definition.metadata;
      this.tensors = {};
      for (const [key, value] of Object.entries(definition.tensors)) this.tensors[key] = decodeFloat32(value);
      if (this.metadata.observationDim !== OBS_DIM || this.metadata.actionDim !== ACTION_SPACE) {
        throw new Error('人机模型的观察或动作维度与游戏不匹配。');
      }
    }

    logits(observation) {
      const t = this.tensors;
      const h1 = denseRelu(observation, t.w1, t.b1, 256, 350);
      const h2 = denseRelu(h1, t.w2, t.b2, 256, 256);
      const h3 = denseRelu(h2, t.w3, t.b3, 128, 256);
      return denseLinear(h3, t.wa, t.ba, 292, 128);
    }

    predict(engine, openingRollPending) {
      const legal = legalActions(engine);
      if (!legal.length) throw new Error('当前局面没有可供人机执行的合法动作。');
      const observation = encodeObservation(engine, openingRollPending);
      const logits = this.logits(observation);
      let bestAction = legal[0];
      let bestScore = logits[bestAction];
      for (let i = 1; i < legal.length; i += 1) {
        const action = legal[i];
        const score = logits[action];
        if (score > bestScore || (score === bestScore && action < bestAction)) {
          bestScore = score;
          bestAction = action;
        }
      }
      return { action: bestAction, score: bestScore, legal, logits, observation };
    }
  }

  const registry = new Map();
  const modelOptions = [];
  function registerModel(definition, fallbackId, fallbackLabel) {
    if (!definition) return;
    const model = new PolicyModel(definition);
    const id = model.metadata.id || fallbackId;
    const label = model.metadata.label || fallbackLabel;
    registry.set(id, model);
    modelOptions.push({ id, label });
  }
  registerModel(root.DoubleFlightAIModelNormal, 'normal-v1', '正常');
  registerModel(root.DoubleFlightAIModelAdvanced, 'advanced-v1', '高级');

  root.DoubleFlightAI = {
    ACTION_SPACE,
    OBS_DIM,
    COLOR_TO_INT,
    INT_TO_COLOR,
    globalPieceIndex,
    pieceIdFromGlobal,
    encodeObservation,
    legalActions,
    models: registry,
    modelOptions,
    predict(modelId, engine, openingRollPending) {
      const model = registry.get(modelId);
      if (!model) throw new Error(`找不到人机模型：${modelId}`);
      return model.predict(engine, openingRollPending);
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
