(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DoubleFlight = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const COLORS = ['red', 'yellow', 'blue', 'green'];
  const COLOR_NAMES = { red: '红', yellow: '黄', blue: '蓝', green: '绿' };
  const COLOR_PRIORITY = ['yellow', 'blue', 'green', 'red'];

  // 15×15 CSV board: 48 public-track cells and four separate take-off cells.
  // Physical orientation: top-left yellow, top-right blue,
  // bottom-right green, bottom-left red.
  const BOARD_PATH_LENGTH = 48;
  const PATH_START_INDEX = { yellow: 0, blue: 12, green: 24, red: 36 };
  const FINISH_ENTRY_INDEX = { yellow: 45, blue: 9, green: 21, red: 33 };
  const ENTRY_COLOR_BY_INDEX = Object.fromEntries(
    Object.entries(FINISH_ENTRY_INDEX).map(([color, index]) => [index, color])
  );
  const PATH_COLORS = {
    red:    [0, 4, 8, 11, 15, 19, 22, 26, 30, 37, 41, 45],
    yellow: [1, 5, 9, 12, 16, 20, 23, 27, 31, 34, 38, 42],
    blue:   [2, 6, 13, 17, 21, 24, 28, 32, 35, 39, 43, 46],
    green:  [3, 7, 10, 14, 18, 25, 29, 33, 36, 40, 44, 47]
  };
  const SHORTCUTS = {
    red: { trigger: 4, destination: 15 },
    yellow: { trigger: 16, destination: 27 },
    blue: { trigger: 28, destination: 39 },
    green: { trigger: 40, destination: 3 }
  };

  function forwardDistance(fromIndex, toIndex) {
    return (toIndex - fromIndex + BOARD_PATH_LENGTH) % BOARD_PATH_LENGTH;
  }

  function jumpCrossesFinishEntry(color, fromIndex, toIndex) {
    const entryDistance = forwardDistance(fromIndex, FINISH_ENTRY_INDEX[color]);
    const destinationDistance = forwardDistance(fromIndex, toIndex);
    return entryDistance > 0 && entryDistance < destinationDistance;
  }

  function isPreFinishJump(color, index) {
    // The first finish-lane cell is the fourth movement step from this
    // same-colour public-track square: three public cells, then lane 0.
    return PATH_COLORS[color].includes(index) &&
      forwardDistance(index, FINISH_ENTRY_INDEX[color]) === 3;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function locationKey(location) {
    if (!location) return 'none';
    switch (location.zone) {
      case 'airport': return `airport:${location.zoneColor}:${location.slot}`;
      case 'launch': return `launch:${location.zoneColor}`;
      case 'main': return `main:${location.mainIndex}`;
      case 'lane': return `lane:${location.laneColor}:${location.laneIndex}`;
      case 'finished': return `finished:${location.finishColor}`;
      default: return 'none';
    }
  }

  class DoubleFlightEngine {
    constructor(options) {
      const opts = options || {};
      this.mode = opts.mode === 'speed' ? 'speed' : 'classic';
      const requestedLaunchValues = Array.isArray(opts.launchValues) ? opts.launchValues : [5, 6];
      this.launchValues = Array.from(new Set(requestedLaunchValues))
        .filter(value => Number.isInteger(value) && value >= 1 && value <= 6)
        .sort((a, b) => a - b);
      if (this.launchValues.length === 0) throw new Error('至少选择一个起飞点数');
      this.tripleSixPenalty = opts.tripleSixPenalty !== false;
      const aColors = Array.from(new Set(opts.playerAColors || [])).filter(color => COLORS.includes(color));
      if (aColors.length !== 2) throw new Error('玩家A必须选择两个不同颜色');
      const bColors = COLORS.filter(color => !aColors.includes(color));

      this.players = [
        { id: 'A', name: opts.playerAName || '玩家A', colors: aColors },
        { id: 'B', name: opts.playerBName || '玩家B', colors: bColors }
      ];
      this.ownerByColor = {};
      this.players.forEach(player => player.colors.forEach(color => { this.ownerByColor[color] = player.id; }));

      this.pieceCount = this.mode === 'speed' ? 1 : 4;
      const protectedColors = new Set(this.mode === 'speed' ? [] : (opts.protectedColors || []));
      this.colorState = {};
      this.pieces = {};
      COLORS.forEach(color => {
        this.colorState[color] = {
          protected: protectedColors.has(color),
          consecutiveSixes: 0
        };
        this.pieces[color] = [];
        for (let index = 0; index < this.pieceCount; index += 1) {
          this.pieces[color].push({
            id: `${color}-${index}`,
            color,
            index,
            location: this.mode === 'speed'
              ? { zone: 'launch', zoneColor: color }
              : { zone: 'airport', zoneColor: color, slot: index },
            finished: false
          });
        }
      });

      this.currentPlayerId = opts.firstPlayer === 'B' ? 'B' : 'A';
      this.phase = 'awaitRoll';
      this.rollSpec = { type: 'double', lockedColor: null };
      this.currentRoll = null;
      this.selectedDieIndex = null;
      this.assignments = [];
      this.pendingSwap = null;
      this.pendingDefeat = null;
      this.gameOver = false;
      this.winner = null;
      this.remainderComplete = false;
      this.acknowledgedWinners = [];
      this.turnNumber = 1;
      this.messages = [];
      this.lastAction = null;
      this._log(`${this.getCurrentPlayer().name}先手。`);
    }

    _log(message) {
      this.messages.push(message);
      if (this.messages.length > 160) this.messages.shift();
      this.lastAction = message;
    }

    getCurrentPlayer() {
      return this.players.find(player => player.id === this.currentPlayerId);
    }

    getPlayer(playerId) {
      return this.players.find(player => player.id === playerId);
    }

    getPiece(pieceId) {
      for (const color of COLORS) {
        const piece = this.pieces[color].find(candidate => candidate.id === pieceId);
        if (piece) return piece;
      }
      return null;
    }

    getAllPieces() {
      return COLORS.flatMap(color => this.pieces[color]);
    }

    isColorComplete(color) {
      return this.pieces[color].every(piece => piece.finished);
    }

    getActiveColors(playerId) {
      return this.getPlayer(playerId).colors.filter(color => !this.isColorComplete(color));
    }

    isProtected(color) {
      return this.colorState[color].protected;
    }

    canSwap() {
      if (this.phase !== 'awaitRoll' || this.gameOver) return false;
      // A normal double roll and a double-six bonus roll may be replaced by a swap.
      // A colour-locked single-die bonus may never be replaced by a swap.
      if (this.rollSpec.type !== 'double') return false;
      const player = this.getCurrentPlayer();
      const [firstColor, secondColor] = player.colors;
      const firstPieces = this.getSwapEligiblePieceIdsUnchecked(firstColor).map(id => this.getPiece(id));
      const secondPieces = this.getSwapEligiblePieceIdsUnchecked(secondColor).map(id => this.getPiece(id));
      return firstPieces.some(first => secondPieces.some(second =>
        locationKey(first.location) !== locationKey(second.location)
      ));
    }

    getSwapEligiblePieceIdsUnchecked(color) {
      return this.pieces[color]
        .filter(piece => !piece.finished && piece.location.zone !== 'airport')
        .map(piece => piece.id);
    }

    getSwapEligiblePieceIds(color) {
      if (this.phase !== 'awaitRoll' || this.gameOver) return [];
      if (!this.getCurrentPlayer().colors.includes(color)) return [];
      return this.getSwapEligiblePieceIdsUnchecked(color);
    }

    beginSwap(pieceAId, pieceBId) {
      if (this.phase !== 'awaitRoll' || this.gameOver || this.rollSpec.type !== 'double') {
        throw new Error('当前不能交换');
      }
      const pieceA = this.getPiece(pieceAId);
      const pieceB = this.getPiece(pieceBId);
      if (!pieceA || !pieceB) throw new Error('棋子不存在');
      if (pieceA.finished || pieceB.finished) throw new Error('已完成棋子不能交换');
      if (pieceA.location.zone === 'airport' || pieceB.location.zone === 'airport') {
        throw new Error('机场内尚未起飞的棋子不能交换');
      }
      if (pieceA.color === pieceB.color) throw new Error('必须选择两个不同颜色的棋子');
      if (locationKey(pieceA.location) === locationKey(pieceB.location)) {
        throw new Error('位于同一格的两个棋子不能交换');
      }
      if (this.ownerByColor[pieceA.color] !== this.currentPlayerId || this.ownerByColor[pieceB.color] !== this.currentPlayerId) {
        throw new Error('只能交换自己的棋子');
      }

      const locationA = clone(pieceA.location);
      pieceA.location = clone(pieceB.location);
      pieceB.location = locationA;
      this.pendingSwap = { pieceIds: [pieceA.id, pieceB.id] };
      this.phase = 'chooseSwapOrder';
      this._log(`${this.getCurrentPlayer().name}交换了${this.pieceLabel(pieceA)}与${this.pieceLabel(pieceB)}的位置。`);
      return clone(this.pendingSwap);
    }

    analyzePendingSwap() {
      if (this.phase !== 'chooseSwapOrder' || !this.pendingSwap) throw new Error('没有待结算的交换');
      const ids = this.pendingSwap.pieceIds.slice();
      const baseline = this._snapshotForSimulation();
      const outcomes = ids.map(firstPieceId => {
        this._restoreSimulationSnapshot(baseline);
        const order = firstPieceId === ids[0] ? ids : [ids[1], ids[0]];
        const events = [];
        order.forEach(id => events.push(...this._resolveLanding(this.getPiece(id), 2, '交换')));
        return {
          firstPieceId,
          stateKey: JSON.stringify(this.pieces),
          events: clone(events)
        };
      });
      this._restoreSimulationSnapshot(baseline);
      const equivalent = outcomes[0].stateKey === outcomes[1].stateKey;
      const automaticFirstPieceId = ids.slice().sort((a, b) => {
        const pa = COLOR_PRIORITY.indexOf(this.getPiece(a).color);
        const pb = COLOR_PRIORITY.indexOf(this.getPiece(b).color);
        return pa - pb;
      })[0];
      return {
        equivalent,
        pieceIds: ids,
        automaticFirstPieceId,
        outcomes
      };
    }

    _snapshotForSimulation() {
      return {
        pieces: clone(this.pieces),
        messages: this.messages.slice(),
        lastAction: this.lastAction,
        gameOver: this.gameOver,
        winner: this.winner,
        remainderComplete: this.remainderComplete,
        acknowledgedWinners: this.acknowledgedWinners.slice()
      };
    }

    _restoreSimulationSnapshot(snapshot) {
      this.pieces = clone(snapshot.pieces);
      this.messages = snapshot.messages.slice();
      this.lastAction = snapshot.lastAction;
      this.gameOver = snapshot.gameOver;
      this.winner = snapshot.winner;
      this.remainderComplete = Boolean(snapshot.remainderComplete);
      this.acknowledgedWinners = (snapshot.acknowledgedWinners || []).slice();
    }

    resolveSwapOrder(firstPieceId) {
      if (this.phase !== 'chooseSwapOrder' || !this.pendingSwap) throw new Error('没有待结算的交换');
      const ids = this.pendingSwap.pieceIds;
      if (!ids.includes(firstPieceId)) throw new Error('结算顺序无效');
      const order = firstPieceId === ids[0] ? ids : [ids[1], ids[0]];
      const events = [];
      order.forEach(id => {
        const piece = this.getPiece(id);
        events.push(...this._resolveLanding(piece, 2, '交换'));
      });
      this.pendingSwap = null;
      this._checkWinner();
      if (!this.gameOver) this._endTurn();
      return events;
    }

    skipOpeningRoll(values) {
      if (this.phase !== 'awaitRoll' || this.gameOver) throw new Error('当前不能跳过开局投骰');
      if (this.rollSpec.type !== 'double') throw new Error('开局自动轮转只适用于双骰');
      if (!Array.isArray(values) || values.length !== 2 || values.some(value => !Number.isInteger(value) || value < 1 || value > 6)) {
        throw new Error('骰子点数无效');
      }
      if (values.some(value => this.launchValues.includes(value))) {
        throw new Error('出现可起飞点数时不能自动跳过');
      }
      if (values.includes(6)) {
        this.rollDice(values);
        this._log('没有可起飞点数，但掷出6，保留追加机会。');
        return this._consumeNoLegalRollWithSixBonus();
      }
      this._log(`${this.getCurrentPlayer().name}投出 ${values.join('、')}，没有可起飞点数，自动轮到下一位。`);
      this._endTurn();
      return { passed: true, bonusFromSixNoMove: false, events: [] };
    }

    rollDice(values) {
      if (this.phase !== 'awaitRoll' || this.gameOver) throw new Error('当前不能投骰');
      const expected = this.rollSpec.type === 'single' ? 1 : 2;
      if (!Array.isArray(values) || values.length !== expected || values.some(value => !Number.isInteger(value) || value < 1 || value > 6)) {
        throw new Error('骰子点数无效');
      }

      const activeColors = this.getActiveColors(this.currentPlayerId);
      if (activeColors.length === 0) {
        if (!this._checkWinner()) this._endTurn();
        return;
      }

      if (this.rollSpec.type === 'single' && !activeColors.includes(this.rollSpec.lockedColor)) {
        this._log(`${COLOR_NAMES[this.rollSpec.lockedColor]}色已经完成，锁定单骰作废。`);
        this._endTurn();
        return;
      }

      this.currentRoll = {
        type: this.rollSpec.type,
        lockedColor: this.rollSpec.lockedColor,
        values: values.slice(),
        spent: values.map(() => false),
        colorByDie: values.map(() => null),
        activeColors: this.rollSpec.type === 'single' ? [this.rollSpec.lockedColor] : activeColors.slice(),
        requiredAssignments: this.rollSpec.type === 'single' ? 1 : Math.min(2, activeColors.length)
      };
      this.assignments = [];
      this.selectedDieIndex = null;
      this.phase = 'selectDie';

      if (this.currentRoll.type === 'single') {
        this._log(`${this.getCurrentPlayer().name}为${COLOR_NAMES[this.currentRoll.lockedColor]}色投出单骰 ${values[0]}。`);
      } else {
        this._log(`${this.getCurrentPlayer().name}投出 ${values.join('、')}。`);
      }
    }

    getSelectableDieIndices() {
      if (!this.currentRoll || !['selectDie', 'selectPiece'].includes(this.phase)) return [];
      return this.currentRoll.spent
        .map((spent, index) => (!spent ? index : -1))
        .filter(index => index >= 0);
    }

    getEligibleColorsForDie(dieIndex) {
      if (!this.currentRoll || !this.getSelectableDieIndices().includes(dieIndex)) return [];
      if (this.currentRoll.type === 'single') return [this.currentRoll.lockedColor];
      if (this.currentRoll.activeColors.length === 1) return this.currentRoll.activeColors.slice();
      const used = new Set(this.currentRoll.colorByDie.filter(Boolean));
      return this.currentRoll.activeColors.filter(color => !used.has(color));
    }

    selectDie(dieIndex) {
      if (!this.currentRoll || !['selectDie', 'selectPiece'].includes(this.phase)) throw new Error('当前不能选择骰子');
      if (!this.getSelectableDieIndices().includes(dieIndex)) throw new Error('该骰子已经使用');

      if (this.phase === 'selectPiece' && this.selectedDieIndex === dieIndex) {
        this.selectedDieIndex = null;
        this.phase = 'selectDie';
        return { deselected: true, movablePieceIds: [] };
      }

      this.selectedDieIndex = dieIndex;
      const eligibleColors = this.getEligibleColorsForDie(dieIndex);
      const value = this.currentRoll.values[dieIndex];

      // A locked single die has only one possible colour. On the third six,
      // resolve the defeat immediately instead of asking the user to pick a piece.
      if (this.tripleSixPenalty && this.currentRoll.type === 'single' && eligibleColors.length === 1 &&
          value === 6 && this.colorState[eligibleColors[0]].consecutiveSixes >= 2) {
        const color = eligibleColors[0];
        const result = this._applyDieAssignment(dieIndex, color, null);
        this._advanceRoll();
        return { autoPenalty: true, movablePieceIds: [], ...result };
      }

      const movablePieceIds = eligibleColors.flatMap(color => this.getMovablePieceIds(color, value));
      if (movablePieceIds.length === 0 && this.currentRoll.type === 'single' && eligibleColors.length === 1) {
        const result = this._applyDieAssignment(dieIndex, eligibleColors[0], null);
        this._advanceRoll();
        return { autoSkipped: true, movablePieceIds: [], ...result };
      }
      if (movablePieceIds.length === 0) {
        this.selectedDieIndex = null;
        this.phase = 'selectDie';
        return {
          noMoveForDie: true,
          canPassTurn: this.canPassTurn(),
          movablePieceIds: []
        };
      }

      this.phase = 'selectPiece';
      return { movablePieceIds };
    }

    deselectDie() {
      if (this.phase !== 'selectPiece') return false;
      this.selectedDieIndex = null;
      this.phase = 'selectDie';
      return true;
    }

    getSelectedDieValue() {
      if (!this.currentRoll || this.selectedDieIndex === null) return null;
      return this.currentRoll.values[this.selectedDieIndex];
    }

    canPieceMoveWithValue(piece, value) {
      if (!piece || piece.finished) return false;
      if (piece.location.zone === 'airport') return this.launchValues.includes(value);
      return true;
    }

    getMovablePieceIds(color, value) {
      if (!this.getCurrentPlayer().colors.includes(color)) return [];
      return this.pieces[color]
        .filter(piece => this.canPieceMoveWithValue(piece, value))
        .map(piece => piece.id);
    }

    getMovablePieceIdsForDie(dieIndex) {
      if (!this.currentRoll) return [];
      const value = this.currentRoll.values[dieIndex];
      return this.getEligibleColorsForDie(dieIndex)
        .flatMap(color => this.getMovablePieceIds(color, value));
    }

    canPassTurn() {
      if (!this.currentRoll || !['selectDie', 'selectPiece'].includes(this.phase)) return false;
      if (this.assignments.length !== 0) return false;
      return this.getSelectableDieIndices().every(index => this.getMovablePieceIdsForDie(index).length === 0);
    }

    passTurn() {
      if (!this.canPassTurn()) throw new Error('当前仍有可以移动的棋子');
      const values = this.currentRoll.values.slice();
      if (values.includes(6)) {
        this._log(`${this.getCurrentPlayer().name}的 ${values.join('、')} 均无合法移动，但掷出6，保留追加机会。`);
        return this._consumeNoLegalRollWithSixBonus();
      }
      this._log(`${this.getCurrentPlayer().name}的 ${values.join('、')} 均无合法移动，结束本回合。`);
      this.currentRoll = null;
      this.assignments = [];
      this.selectedDieIndex = null;
      this._endTurn();
      return { passed: true, bonusFromSixNoMove: false, events: [] };
    }

    _consumeNoLegalRollWithSixBonus() {
      if (!this.currentRoll || !this.currentRoll.values.includes(6)) {
        return { bonusFromSixNoMove: false, events: [] };
      }
      const events = [];
      let penaltyColor = null;
      const sixFirst = this.getSelectableDieIndices()
        .sort((a, b) => Number(this.currentRoll.values[b] === 6) - Number(this.currentRoll.values[a] === 6) || a - b);

      for (const dieIndex of sixFirst) {
        if (this.assignments.length >= this.currentRoll.requiredAssignments) break;
        if (this.currentRoll.spent[dieIndex]) continue;
        const eligibleColors = this.getEligibleColorsForDie(dieIndex);
        if (!eligibleColors.length) continue;
        const color = eligibleColors[0];
        const result = this._applyDieAssignment(dieIndex, color, null);
        events.push(...(result.events || []));
        if (result.assignment && result.assignment.penalty) penaltyColor = result.assignment.color;
      }

      this._completeRoll();
      return {
        bonusFromSixNoMove: true,
        events,
        penaltyColor,
        pendingDefeat: Boolean(this.pendingDefeat)
      };
    }

    getMovablePieceIdsForSelectedDie() {
      if (this.phase !== 'selectPiece' || this.selectedDieIndex === null) return [];
      return this.getMovablePieceIdsForDie(this.selectedDieIndex);
    }

    moveSelectedPiece(pieceId) {
      if (this.phase !== 'selectPiece' || this.selectedDieIndex === null) throw new Error('请先选择一个骰子');
      const dieIndex = this.selectedDieIndex;
      const piece = this.getPiece(pieceId);
      if (!piece || !this.getMovablePieceIdsForSelectedDie().includes(pieceId)) throw new Error('该棋子不能使用当前骰子');

      const result = this._applyDieAssignment(dieIndex, piece.color, piece.id);
      this._checkWinner();
      if (!this.gameOver) this._advanceRoll();
      return result.events;
    }

    _applyDieAssignment(dieIndex, color, pieceId) {
      const value = this.currentRoll.values[dieIndex];
      this.currentRoll.spent[dieIndex] = true;
      this.currentRoll.colorByDie[dieIndex] = color;
      this.selectedDieIndex = null;

      const state = this.colorState[color];
      let penalty = false;
      let events = [];
      if (value === 6) {
        state.consecutiveSixes += 1;
        if (this.tripleSixPenalty && state.consecutiveSixes >= 3) {
          penalty = true;
          this.pendingDefeat = {
            color,
            pieces: this.pieces[color].map(piece => ({
              id: piece.id,
              location: clone(piece.location),
              finished: piece.finished
            }))
          };
          events = this._sendColorHome(color);
          state.consecutiveSixes = 0;
          this._log(`${COLOR_NAMES[color]}色连续获得第三个6，该颜色所有棋子回到机场，本次6不移动。`);
        }
      } else {
        state.consecutiveSixes = 0;
      }

      const assignment = { dieIndex, color, value, pieceId, penalty };
      this.assignments.push(assignment);
      if (!penalty && pieceId) {
        events = this._movePiece(this.getPiece(pieceId), value);
      } else if (!penalty) {
        this._log(`${COLOR_NAMES[color]}色没有可使用 ${value} 点的棋子，该骰子作废。`);
      }
      return { assignment: clone(assignment), events };
    }

    _advanceRoll() {
      if (this.gameOver) return;
      if (this.assignments.length >= this.currentRoll.requiredAssignments) {
        this._completeRoll();
        return;
      }

      // After one colour has acted, the remaining colour is determined. If no
      // unspent die can move that colour, consume one deterministically so the
      // completed assignment still controls six-bonus and three-six rules.
      if (this.assignments.length > 0) {
        for (const dieIndex of this.getSelectableDieIndices()) {
          const eligibleColors = this.getEligibleColorsForDie(dieIndex);
          if (eligibleColors.length !== 1) continue;
          if (this.getMovablePieceIdsForDie(dieIndex).length > 0) continue;
          this._applyDieAssignment(dieIndex, eligibleColors[0], null);
          if (this.assignments.length >= this.currentRoll.requiredAssignments) {
            this._completeRoll();
            return;
          }
        }
      }
      this.phase = 'selectDie';
    }

    _completeRoll() {
      if (this.gameOver) return;
      let nextRollSpec = null;
      if (this.currentRoll.type === 'double' && this.currentRoll.values[0] === 6 && this.currentRoll.values[1] === 6) {
        nextRollSpec = { type: 'double', lockedColor: null };
      } else {
        const sixAssignment = this.assignments.find(assignment => assignment.value === 6 && !assignment.penalty);
        if (sixAssignment) nextRollSpec = { type: 'single', lockedColor: sixAssignment.color };
      }

      this.currentRoll = null;
      this.assignments = [];
      this.selectedDieIndex = null;

      if (nextRollSpec) {
        this.rollSpec = nextRollSpec;
        this.phase = 'awaitRoll';
        if (nextRollSpec.type === 'single') {
          this._log(`${COLOR_NAMES[nextRollSpec.lockedColor]}色获得一次锁定单骰。`);
        } else {
          this._log('双6：获得一次新的双骰。');
        }
      } else {
        this._endTurn();
      }
    }

    _movePiece(piece, steps) {
      const events = [];
      if (!piece || piece.finished) return events;

      if (piece.location.zone === 'airport') {
        const launchColor = piece.location.zoneColor;
        piece.location = { zone: 'launch', zoneColor: launchColor };
        this._log(`${this.pieceLabel(piece)}进入${COLOR_NAMES[launchColor]}色起飞位。`);
        events.push({ type: 'takeoff', pieceId: piece.id, location: clone(piece.location) });
        events.push(...this._resolveLanding(piece, 2, '移动'));
        return events;
      }

      let remaining = steps;
      let ownLaneAtWall = false;
      let ownLaneReturning = false;

      while (remaining > 0 && !piece.finished) {
        const location = piece.location;

        if (ownLaneAtWall) {
          piece.location = { zone: 'lane', laneColor: piece.color, laneIndex: 5, direction: 1 };
          ownLaneAtWall = false;
          ownLaneReturning = true;
          remaining -= 1;
          events.push({ type: 'bounce', pieceId: piece.id, location: clone(piece.location) });
          continue;
        }

        // Own home lane: advance toward fin6 and the centre. Exact arrival at
        // the virtual centre finishes; surplus points bounce within this move.
        if (location.zone === 'lane' && location.laneColor === piece.color) {
          if (ownLaneReturning) {
            piece.location = {
              zone: 'lane',
              laneColor: piece.color,
              laneIndex: Math.max(0, location.laneIndex - 1),
              direction: 1
            };
            remaining -= 1;
            events.push({ type: 'step', pieceId: piece.id, location: clone(piece.location) });
            continue;
          }

          if (location.laneIndex < 5) {
            piece.location = {
              zone: 'lane',
              laneColor: piece.color,
              laneIndex: location.laneIndex + 1,
              direction: 1
            };
            remaining -= 1;
            events.push({ type: 'step', pieceId: piece.id, location: clone(piece.location) });
            continue;
          }

          // One virtual step from fin6 reaches the centre.
          remaining -= 1;
          if (remaining === 0) {
            piece.location = { zone: 'finished', finishColor: piece.color };
            piece.finished = true;
            events.push({ type: 'finish', pieceId: piece.id, location: clone(piece.location) });
            this._log(`${this.pieceLabel(piece)}到达终点。`);
            return events;
          }

          ownLaneAtWall = true;
          continue;
        }

        const event = this._advanceOneStep(piece);
        events.push(event);
        remaining -= 1;
      }

      this._log(`${this.pieceLabel(piece)}移动 ${steps} 步。`);
      events.push(...this._resolveLanding(piece, 2, '移动'));
      return events;
    }

    _advanceOneStep(piece) {
      const location = piece.location;

      if (location.zone === 'launch') {
        piece.location = { zone: 'main', mainIndex: PATH_START_INDEX[location.zoneColor] };
        return { type: 'step', pieceId: piece.id, location: clone(piece.location) };
      }

      if (location.zone === 'main') {
        const laneColor = ENTRY_COLOR_BY_INDEX[location.mainIndex];
        if (laneColor) {
          // fin1 is physically part of the through route. Every colour spends
          // one step on fin1; only the matching colour continues to fin2.
          piece.location = { zone: 'lane', laneColor, laneIndex: 0, direction: 1 };
        } else {
          piece.location = { zone: 'main', mainIndex: (location.mainIndex + 1) % BOARD_PATH_LENGTH };
        }
        return { type: 'step', pieceId: piece.id, location: clone(piece.location) };
      }

      if (location.zone !== 'lane') throw new Error(`无法移动未知位置：${location.zone}`);

      // A foreign-colour piece can normally visit only fin1. Its next step
      // leaves the lane and resumes clockwise after the lane entrance.
      if (location.laneColor !== piece.color && location.laneIndex === 0) {
        piece.location = {
          zone: 'main',
          mainIndex: (FINISH_ENTRY_INDEX[location.laneColor] + 1) % BOARD_PATH_LENGTH
        };
        return { type: 'step', pieceId: piece.id, location: clone(piece.location) };
      }

      // fin2-fin6 can contain a foreign piece only after a swap. It travels
      // toward fin6, bounces, returns to fin1, then exits clockwise.
      const direction = location.direction === -1 ? -1 : 1;
      if (direction > 0 && location.laneIndex < 5) {
        piece.location = {
          zone: 'lane',
          laneColor: location.laneColor,
          laneIndex: location.laneIndex + 1,
          direction: 1
        };
        return { type: 'step', pieceId: piece.id, location: clone(piece.location) };
      }
      if (direction > 0) {
        piece.location = {
          zone: 'lane',
          laneColor: location.laneColor,
          laneIndex: 4,
          direction: -1
        };
        return { type: 'bounce', pieceId: piece.id, location: clone(piece.location) };
      }
      if (location.laneIndex > 0) {
        piece.location = {
          zone: 'lane',
          laneColor: location.laneColor,
          laneIndex: location.laneIndex - 1,
          direction: -1
        };
        return { type: 'step', pieceId: piece.id, location: clone(piece.location) };
      }

      piece.location = {
        zone: 'main',
        mainIndex: (FINISH_ENTRY_INDEX[location.laneColor] + 1) % BOARD_PATH_LENGTH
      };
      return { type: 'step', pieceId: piece.id, location: clone(piece.location) };
    }

    _resolveLanding(piece, maxSpecialActions, source) {
      const events = [];
      if (!piece || piece.finished) return events;
      const used = new Set();

      for (let count = 0; count < maxSpecialActions; count += 1) {
        if (piece.location.zone !== 'main') break;
        const color = piece.color;
        const index = piece.location.mainIndex;
        let action = null;

        if (!used.has('flight') && SHORTCUTS[color].trigger === index) {
          action = 'flight';
        } else if (!used.has('jump') && (isPreFinishJump(color, index) ||
                   (PATH_COLORS[color].includes(index) && index !== FINISH_ENTRY_INDEX[color]))) {
          action = 'jump';
        }
        if (!action) break;

        if (action === 'flight') {
          piece.location = { zone: 'main', mainIndex: SHORTCUTS[color].destination };
          this._log(`${this.pieceLabel(piece)}触发飞线。`);
        } else {
          let destination;
          if (isPreFinishJump(color, index)) {
            piece.location = { zone: 'lane', laneColor: color, laneIndex: 0, direction: 1 };
          } else {
            const positions = PATH_COLORS[color];
            const current = positions.indexOf(index);
            destination = positions[(current + 1) % positions.length];
            if (jumpCrossesFinishEntry(color, index, destination)) break;
            piece.location = { zone: 'main', mainIndex: destination };
          }
          this._log(`${this.pieceLabel(piece)}跳四。`);
        }

        used.add(action);
        events.push({ type: action, pieceId: piece.id, location: clone(piece.location) });
      }

      // Capture is evaluated once, after all jump/flight landing effects finish.
      // Trigger cells and cells merely crossed during movement never capture.
      events.push(...this._captureAt(piece, source));
      return events;
    }

    _captureAt(attacker, source) {
      const events = [];
      if (this.mode === 'speed' || attacker.finished ||
          !['launch', 'main', 'lane'].includes(attacker.location.zone)) return events;
      const attackerOwner = this.ownerByColor[attacker.color];
      const attackerProtected = this.isProtected(attacker.color);
      const key = locationKey(attacker.location);

      this.getAllPieces().forEach(target => {
        if (target.id === attacker.id || target.finished) return;
        if (locationKey(target.location) !== key) return;
        if (this.ownerByColor[target.color] === attackerOwner) return;
        if (attackerProtected || this.isProtected(target.color)) return;
        const fromLocation = clone(target.location);
        this._sendPieceHome(target);
        this._log(`${this.pieceLabel(attacker)}吃掉了${this.pieceLabel(target)}。`);
        events.push({
          type: 'capture',
          attackerId: attacker.id,
          targetId: target.id,
          targetColor: target.color,
          source,
          fromLocation,
          location: clone(target.location)
        });
      });
      return events;
    }

    _sendPieceHome(piece) {
      piece.finished = false;
      piece.location = { zone: 'airport', zoneColor: piece.color, slot: piece.index };
    }

    _sendColorHome(color) {
      const events = [];
      this.pieces[color].forEach(piece => {
        this._sendPieceHome(piece);
        events.push({ type: 'returnHome', pieceId: piece.id, location: clone(piece.location) });
      });
      return events;
    }


    acceptPendingDefeat() {
      if (!this.pendingDefeat) return null;
      const result = clone(this.pendingDefeat);
      this.pendingDefeat = null;
      return result;
    }

    undoPendingDefeat() {
      if (!this.pendingDefeat) throw new Error('当前没有可反悔的三连6惩罚');
      const pending = this.pendingDefeat;
      const events = [];
      pending.pieces.forEach(saved => {
        const piece = this.getPiece(saved.id);
        if (!piece) return;
        piece.location = clone(saved.location);
        piece.finished = Boolean(saved.finished);
        events.push({ type: 'undoReturnHome', pieceId: piece.id, location: clone(piece.location) });
      });
      this.pendingDefeat = null;
      this._log(`${COLOR_NAMES[pending.color]}色完成10次反悔，取消回机场惩罚。`);
      return events;
    }

    _endTurn() {
      const current = this.getCurrentPlayer();
      current.colors.forEach(color => { this.colorState[color].consecutiveSixes = 0; });
      const candidateId = this.currentPlayerId === 'A' ? 'B' : 'A';
      const candidateComplete = this.getActiveColors(candidateId).length === 0;
      this.currentPlayerId = candidateComplete && this.acknowledgedWinners.includes(candidateId)
        ? current.id
        : candidateId;
      this.turnNumber += 1;
      this.phase = 'awaitRoll';
      this.rollSpec = { type: 'double', lockedColor: null };
      this.currentRoll = null;
      this.selectedDieIndex = null;
      this.assignments = [];
      this._log(`轮到${this.getCurrentPlayer().name}。`);
    }

    continueAfterWin() {
      if (!this.gameOver || !this.winner || this.remainderComplete) return false;
      const winnerId = this.winner;
      if (!this.acknowledgedWinners.includes(winnerId)) this.acknowledgedWinners.push(winnerId);
      this.gameOver = false;
      this.winner = null;
      this.remainderComplete = false;
      this.phase = 'awaitRoll';
      this.currentRoll = null;
      this.selectedDieIndex = null;
      this.assignments = [];
      this.rollSpec = { type: 'double', lockedColor: null };
      this._log(`${this.getPlayer(winnerId).name}选择继续残局。`);
      this._endTurn();
      return true;
    }

    _checkWinner() {
      for (const player of this.players) {
        if (this.acknowledgedWinners.includes(player.id)) continue;
        if (player.colors.every(color => this.isColorComplete(color))) {
          this.gameOver = true;
          this.phase = 'gameOver';
          this.currentRoll = null;
          this.selectedDieIndex = null;
          if (this.acknowledgedWinners.length > 0) {
            this.winner = null;
            this.remainderComplete = true;
            this._log('残局结束。');
          } else {
            this.winner = player.id;
            this.remainderComplete = false;
            this._log(`${player.name}获胜。`);
          }
          return true;
        }
      }
      return false;
    }

    previewSelectedPiece(pieceId) {
      if (this.phase !== 'selectPiece' || this.selectedDieIndex === null) return null;
      if (!this.getMovablePieceIdsForSelectedDie().includes(pieceId)) return null;
      const piece = this.getPiece(pieceId);
      const value = this.getSelectedDieValue();
      const startLocation = clone(piece.location);
      if (!this.canPieceMoveWithValue(piece, value)) {
        return {
          startLocation,
          location: clone(piece.location),
          penalty: false,
          assignmentOnly: true,
          events: []
        };
      }
      if (this.tripleSixPenalty && value === 6 && this.colorState[piece.color].consecutiveSixes >= 2) {
        return {
          startLocation,
          location: { zone: 'airport', zoneColor: piece.color, slot: piece.index },
          penalty: true,
          events: []
        };
      }

      const savedPieces = clone(this.pieces);
      const savedMessages = this.messages.slice();
      const savedLastAction = this.lastAction;
      let result;
      try {
        const events = this._movePiece(piece, value);
        result = { startLocation, location: clone(piece.location), penalty: false, events: clone(events) };
      } finally {
        this.pieces = savedPieces;
        this.messages = savedMessages;
        this.lastAction = savedLastAction;
      }
      return result;
    }

    pieceLabel(piece) {
      return `${COLOR_NAMES[piece.color]}${piece.index + 1}`;
    }

    getPhysicalLocationKey(piece) {
      return locationKey(piece.location);
    }

    restore(snapshot) {
      if (!snapshot || !Array.isArray(snapshot.players) || !snapshot.pieces) {
        throw new Error('无效的游戏快照');
      }
      this.mode = snapshot.mode;
      this.launchValues = clone(snapshot.launchValues);
      this.tripleSixPenalty = snapshot.tripleSixPenalty !== false;
      this.players = clone(snapshot.players);
      this.ownerByColor = {};
      this.players.forEach(player => player.colors.forEach(color => { this.ownerByColor[color] = player.id; }));
      this.pieceCount = snapshot.pieceCount;
      this.colorState = clone(snapshot.colorState);
      this.pieces = clone(snapshot.pieces);
      this.currentPlayerId = snapshot.currentPlayerId;
      this.phase = snapshot.phase;
      this.rollSpec = clone(snapshot.rollSpec);
      this.currentRoll = clone(snapshot.currentRoll);
      this.selectedDieIndex = snapshot.selectedDieIndex;
      this.assignments = clone(snapshot.assignments || []);
      this.pendingSwap = clone(snapshot.pendingSwap);
      this.pendingDefeat = clone(snapshot.pendingDefeat);
      this.gameOver = Boolean(snapshot.gameOver);
      this.winner = snapshot.winner || null;
      this.remainderComplete = Boolean(snapshot.remainderComplete);
      this.acknowledgedWinners = clone(snapshot.acknowledgedWinners || []);
      this.turnNumber = snapshot.turnNumber;
      this.messages = clone(snapshot.messages || []);
      this.lastAction = snapshot.lastAction || null;
      return this.serialize();
    }

    serialize() {
      return clone({
        mode: this.mode,
        launchValues: this.launchValues,
        tripleSixPenalty: this.tripleSixPenalty,
        players: this.players,
        pieceCount: this.pieceCount,
        colorState: this.colorState,
        pieces: this.pieces,
        currentPlayerId: this.currentPlayerId,
        phase: this.phase,
        rollSpec: this.rollSpec,
        currentRoll: this.currentRoll,
        selectedDieIndex: this.selectedDieIndex,
        assignments: this.assignments,
        pendingSwap: this.pendingSwap,
        pendingDefeat: this.pendingDefeat,
        gameOver: this.gameOver,
        winner: this.winner,
        remainderComplete: this.remainderComplete,
        acknowledgedWinners: this.acknowledgedWinners.slice(),
        turnNumber: this.turnNumber,
        messages: this.messages,
        lastAction: this.lastAction
      });
    }
  }

  return {
    DoubleFlightEngine,
    COLORS,
    COLOR_NAMES,
    COLOR_PRIORITY,
    PATH_START_INDEX,
    FINISH_ENTRY_INDEX,
    ENTRY_COLOR_BY_INDEX,
    PATH_COLORS,
    SHORTCUTS,
    BOARD_PATH_LENGTH,
    locationKey,
    forwardDistance,
    jumpCrossesFinishEntry,
    isPreFinishJump
  };
});
