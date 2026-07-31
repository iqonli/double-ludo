'use strict';
const assert = require('assert');
const {
  DoubleFlightEngine,
  COLORS,
  SHORTCUTS,
  PATH_COLORS,
  PATH_START_INDEX,
  FINISH_ENTRY_INDEX,
  ENTRY_COLOR_BY_INDEX,
  BOARD_PATH_LENGTH,
  forwardDistance
} = require('../shared/engine.js');

function classic(extra = {}) {
  return new DoubleFlightEngine({
    mode: 'classic',
    playerAColors: ['red', 'yellow'],
    firstPlayer: 'A',
    ...extra
  });
}

function moveWithDie(game, dieIndex, pieceId) {
  const selected = game.selectDie(dieIndex);
  assert(!selected.noMoveForDie, `骰子 ${dieIndex} 应可移动`);
  return game.moveSelectedPiece(pieceId);
}

(function boardDefinitionIsComplete() {
  assert.equal(BOARD_PATH_LENGTH, 48);
  assert.deepEqual(PATH_START_INDEX, { yellow: 0, blue: 12, green: 24, red: 36 });
  assert.deepEqual(FINISH_ENTRY_INDEX, { yellow: 45, blue: 9, green: 21, red: 33 });
  assert.deepEqual(ENTRY_COLOR_BY_INDEX, { 9: 'blue', 21: 'green', 33: 'red', 45: 'yellow' });
  assert.equal(Object.values(PATH_COLORS).flat().length, 48);
})();

(function openingAutoRotation() {
  const game = classic();
  game.skipOpeningRoll([1, 4]);
  assert.equal(game.currentPlayerId, 'B');
  game.skipOpeningRoll([2, 3]);
  assert.equal(game.currentPlayerId, 'A');
  assert.throws(() => game.skipOpeningRoll([5, 2]), /可起飞点数/);
})();

(function launchValuesAreConfigurable() {
  const game = classic({ launchValues: [1, 3, 4] });
  game.rollDice([1, 2]);
  moveWithDie(game, 0, 'red-0');
  assert.equal(game.pieces.red[0].location.zone, 'launch');

  const noSix = classic({ launchValues: [2] });
  noSix.rollDice([6, 2]);
  const six = noSix.selectDie(0);
  assert.equal(six.noMoveForDie, true);
  const two = noSix.selectDie(1);
  assert(two.movablePieceIds.includes('red-0'));
})();

(function noLegalMoveOffersPassInsteadOfColourAssignment() {
  const game = classic();
  game.rollDice([2, 4]);
  const result = game.selectDie(0);
  assert.equal(result.noMoveForDie, true);
  assert.equal(result.canPassTurn, true);
  assert.equal(game.assignments.length, 0);
  assert.equal(game.phase, 'selectDie');
  assert.equal(game.canPassTurn(), true);
  game.passTurn();
  assert.equal(game.currentPlayerId, 'B');
  assert.equal(game.phase, 'awaitRoll');
})();

(function noLegalMoveWithSixKeepsBonusChance() {
  const game = classic({ launchValues: [5] });
  game.rollDice([6, 2]);
  const result = game.selectDie(0);
  assert.equal(result.noMoveForDie, true);
  assert.equal(result.canPassTurn, true);
  const pass = game.passTurn();
  assert.equal(pass.bonusFromSixNoMove, true);
  assert.equal(game.currentPlayerId, 'A', '掷出6时不应切换玩家');
  assert.equal(game.phase, 'awaitRoll');
  assert.equal(game.rollSpec.type, 'single');
  assert.equal(game.rollSpec.lockedColor, 'red');
})();

(function openingNoLaunchWithSixStopsAutoRotationAndKeepsBonus() {
  const game = classic({ launchValues: [5] });
  const result = game.skipOpeningRoll([6, 2]);
  assert.equal(result.bonusFromSixNoMove, true);
  assert.equal(game.currentPlayerId, 'A');
  assert.equal(game.phase, 'awaitRoll');
  assert.equal(game.rollSpec.type, 'single');
  assert.equal(game.rollSpec.lockedColor, 'red');
})();

(function doubleSixWithNoLegalMoveKeepsDoubleBonus() {
  const game = classic({ launchValues: [5] });
  game.rollDice([6, 6]);
  const pass = game.passTurn();
  assert.equal(pass.bonusFromSixNoMove, true);
  assert.equal(game.currentPlayerId, 'A');
  assert.equal(game.phase, 'awaitRoll');
  assert.equal(game.rollSpec.type, 'double');
})();

(function unmovableTwoDoesNotStealAColourFromSix() {
  const game = new DoubleFlightEngine({
    mode: 'classic',
    playerAColors: ['yellow', 'blue'],
    firstPlayer: 'B'
  });
  game.rollDice([2, 6]);
  const two = game.selectDie(0);
  assert.equal(two.noMoveForDie, true);
  assert.deepEqual(game.currentRoll.colorByDie, [null, null]);
  const six = game.selectDie(1);
  assert(new Set(six.movablePieceIds).has('red-0'));
  assert(new Set(six.movablePieceIds).has('green-0'));
  game.moveSelectedPiece('green-0');
  assert.equal(game.currentRoll, null, '剩余2点对红色不可用时应自动作废并完成本次双骰');
  assert.equal(game.rollSpec.type, 'single');
  assert.equal(game.rollSpec.lockedColor, 'green');
})();

(function lockedSingleWithNoLegalMoveIsConsumedAutomatically() {
  const game = classic({ launchValues: [5] });
  game.rollSpec = { type: 'single', lockedColor: 'red' };
  game.rollDice([2]);
  const result = game.selectDie(0);
  assert.equal(result.autoSkipped, true);
  assert.equal(game.currentPlayerId, 'B');
  assert.equal(game.phase, 'awaitRoll');
})();

(function diceMustGoToDifferentActiveColours() {
  const game = classic();
  game.pieces.red[0].location = { zone: 'launch', zoneColor: 'red' };
  game.pieces.yellow[0].location = { zone: 'launch', zoneColor: 'yellow' };
  game.rollDice([2, 3]);
  moveWithDie(game, 1, 'yellow-0');
  assert.deepEqual(game.getEligibleColorsForDie(0), ['red']);
})();

(function singleAndDoubleSixBonuses() {
  const single = classic();
  single.rollDice([6, 3]);
  moveWithDie(single, 0, 'red-0'); // remaining yellow 3 is automatically consumed
  assert.equal(single.rollSpec.type, 'single');
  assert.equal(single.rollSpec.lockedColor, 'red');

  const double = classic();
  double.rollDice([6, 6]);
  moveWithDie(double, 0, 'red-0');
  moveWithDie(double, 1, 'yellow-0');
  assert.equal(double.rollSpec.type, 'double');
  assert.equal(double.currentPlayerId, 'A');
})();

(function swapAvailabilityMatchesBonusType() {
  const game = classic();
  game.pieces.red[0].location = { zone: 'launch', zoneColor: 'red' };
  game.pieces.yellow[0].location = { zone: 'launch', zoneColor: 'yellow' };
  assert.equal(game.canSwap(), true, '普通双骰投掷前允许交换');

  game.rollSpec = { type: 'single', lockedColor: 'red' };
  assert.equal(game.canSwap(), false, '锁定单骰追加时禁止交换');

  game.rollSpec = { type: 'double', lockedColor: null };
  assert.equal(game.canSwap(), true, '双6追加双骰投掷前允许交换');
})();

(function airportPiecesCannotSwap() {
  const game = classic();
  game.pieces.red[0].location = { zone: 'launch', zoneColor: 'red' };
  game.pieces.yellow[0].location = { zone: 'launch', zoneColor: 'yellow' };
  assert.throws(() => game.beginSwap('red-1', 'yellow-0'), /机场内尚未起飞/);
})();

(function everyLaneInterruptsThePublicTrack() {
  for (const laneColor of COLORS) {
    for (const pieceColor of COLORS) {
      const game = classic();
      const piece = game.pieces[pieceColor][0];
      piece.location = { zone: 'main', mainIndex: FINISH_ENTRY_INDEX[laneColor] };
      const events = game._movePiece(piece, 1);
      assert.deepEqual(events[0].location, {
        zone: 'lane', laneColor, laneIndex: 0, direction: 1
      }, `${pieceColor}从${laneColor}跑道前一格前进时应进入该跑道`);
    }
  }
})();

(function reportedRedThreeBeforeYellowEntersYellowLane() {
  const game = classic();
  const piece = game.pieces.red[0];
  piece.location = {
    zone: 'main',
    mainIndex: (FINISH_ENTRY_INDEX.yellow - 2 + BOARD_PATH_LENGTH) % BOARD_PATH_LENGTH
  };
  const events = game._movePiece(piece, 3);
  assert.deepEqual(events.slice(0, 3).map(event => event.location), [
    { zone: 'main', mainIndex: 44 },
    { zone: 'main', mainIndex: 45 },
    { zone: 'lane', laneColor: 'yellow', laneIndex: 0, direction: 1 }
  ]);
})();

(function foreignPieceUsesOnlyFin1DuringNormalTravel() {
  for (const laneColor of COLORS) {
    for (const pieceColor of COLORS.filter(color => color !== laneColor)) {
      const game = classic();
      const piece = game.pieces[pieceColor][0];
      piece.location = { zone: 'main', mainIndex: FINISH_ENTRY_INDEX[laneColor] };
      const first = game._movePiece(piece, 1);
      assert.deepEqual(first[0].location, {
        zone: 'lane', laneColor, laneIndex: 0, direction: 1
      }, `${pieceColor}经过${laneColor}跑道时第一步应落在fin1`);
      const second = game._movePiece(piece, 1);
      assert.deepEqual(second[0].location, {
        zone: 'main', mainIndex: (FINISH_ENTRY_INDEX[laneColor] + 1) % BOARD_PATH_LENGTH
      }, `${pieceColor}从${laneColor}fin1下一步应继续公共航道`);
    }
  }
})();

(function matchingColourContinuesFromFin1ToFin2() {
  for (const color of COLORS) {
    const game = classic();
    const piece = game.pieces[color][0];
    piece.location = { zone: 'lane', laneColor: color, laneIndex: 0, direction: 1 };
    game._movePiece(piece, 1);
    assert.deepEqual(piece.location, { zone: 'lane', laneColor: color, laneIndex: 1, direction: 1 });
  }
})();

(function swapIntoForeignFin1ContinuesForward() {
  const game = classic();
  const red = game.pieces.red[0];
  red.location = { zone: 'lane', laneColor: 'yellow', laneIndex: 0, direction: 1 };
  game._movePiece(red, 1);
  assert.deepEqual(red.location, { zone: 'main', mainIndex: 46 });
})();

(function swapIntoForeignFin2ToFin6BouncesAndExitsClockwise() {
  const game = classic();
  const piece = game.pieces.green[0];
  piece.location = { zone: 'lane', laneColor: 'red', laneIndex: 4, direction: 1 };
  const firstRoll = game._movePiece(piece, 3);
  assert.deepEqual(firstRoll.map(event => event.location), [
    { zone: 'lane', laneColor: 'red', laneIndex: 5, direction: 1 },
    { zone: 'lane', laneColor: 'red', laneIndex: 4, direction: -1 },
    { zone: 'lane', laneColor: 'red', laneIndex: 3, direction: -1 }
  ]);
  assert.equal(firstRoll[1].type, 'bounce');

  const secondRoll = game._movePiece(piece, 6);
  assert.deepEqual(secondRoll.slice(0, 5).map(event => event.location), [
    { zone: 'lane', laneColor: 'red', laneIndex: 2, direction: -1 },
    { zone: 'lane', laneColor: 'red', laneIndex: 1, direction: -1 },
    { zone: 'lane', laneColor: 'red', laneIndex: 0, direction: -1 },
    { zone: 'main', mainIndex: 34 },
    { zone: 'main', mainIndex: 35 }
  ]);
  const publicIndexes = secondRoll.filter(event => event.location && event.location.zone === 'main').map(event => event.location.mainIndex);
  assert.deepEqual(publicIndexes.slice(0, 3), [34, 35, 36], '退出异色跑道后应继续沿公共航道顺时针');
  assert.equal(piece.location.mainIndex, 3, '最终落到本色格后仍按规则结算跳四与飞线');
})();

(function ownLaneRequiresExactFinishAndBouncesSurplus() {
  const exact = classic();
  const p1 = exact.pieces.red[0];
  p1.location = { zone: 'lane', laneColor: 'red', laneIndex: 5, direction: 1 };
  exact._movePiece(p1, 1);
  assert.equal(p1.finished, true);

  const surplus = classic();
  const p2 = surplus.pieces.red[0];
  p2.location = { zone: 'lane', laneColor: 'red', laneIndex: 5, direction: 1 };
  const events = surplus._movePiece(p2, 3);
  assert.deepEqual(p2.location, { zone: 'lane', laneColor: 'red', laneIndex: 4, direction: 1 });
  assert(events.some(event => event.type === 'bounce'));
})();

(function jumpFourTurnsIntoOwnLaneAtTheBoundary() {
  for (const color of COLORS) {
    const game = classic();
    const piece = game.pieces[color][0];
    const entry = FINISH_ENTRY_INDEX[color];
    const start = PATH_COLORS[color].find(index => forwardDistance(index, entry) === 3);
    assert.notEqual(start, undefined);
    piece.location = { zone: 'main', mainIndex: start };
    const events = game._resolveLanding(piece, 2, 'test');
    assert.equal(events[0].type, 'jump');
    assert.deepEqual(piece.location, { zone: 'lane', laneColor: color, laneIndex: 0, direction: 1 });
  }
})();

(function normalJumpNeverCrossesOwnFinishEntry() {
  for (const color of COLORS) {
    const positions = PATH_COLORS[color];
    for (let i = 0; i < positions.length; i += 1) {
      const from = positions[i];
      const game = classic();
      const piece = game.pieces[color][0];
      piece.location = { zone: 'main', mainIndex: from };
      game._resolveLanding(piece, 2, 'test');
      if (piece.location.zone === 'main') {
        assert(forwardDistance(from, piece.location.mainIndex) <= forwardDistance(from, FINISH_ENTRY_INDEX[color]) ||
          forwardDistance(from, FINISH_ENTRY_INDEX[color]) === 0,
          `${color}跳四不得越过本色终点入口`);
      }
    }
  }
})();

(function specialChainHasAtMostTwoDifferentStages() {
  const game = classic();
  const piece = game.pieces.red[0];
  piece.location = { zone: 'main', mainIndex: SHORTCUTS.red.trigger };
  const events = game._resolveLanding(piece, 2, 'test').filter(event => ['jump', 'flight'].includes(event.type));
  assert.deepEqual(events.map(event => event.type), ['flight', 'jump']);
})();

(function captureOccursOnlyAtFinalLanding() {
  const game = classic();
  const attacker = game.pieces.red[0];
  const triggerVictim = game.pieces.blue[0];
  const finalVictim = game.pieces.green[0];
  attacker.location = { zone: 'main', mainIndex: SHORTCUTS.red.trigger };
  triggerVictim.location = { zone: 'main', mainIndex: SHORTCUTS.red.trigger };
  finalVictim.location = { zone: 'main', mainIndex: 19 };
  const events = game._resolveLanding(attacker, 2, 'test');
  assert.equal(triggerVictim.location.zone, 'main');
  assert.equal(finalVictim.location.zone, 'airport');
  assert.deepEqual(events.map(event => event.type), ['flight', 'jump', 'capture']);
})();

(function fin1AndSwappedLaneCellsAreLandingCellsForCapture() {
  const fin1 = classic();
  const attacker = fin1.pieces.red[0];
  const victim = fin1.pieces.blue[0];
  attacker.location = { zone: 'lane', laneColor: 'yellow', laneIndex: 0, direction: 1 };
  victim.location = { zone: 'lane', laneColor: 'yellow', laneIndex: 0, direction: 1 };
  fin1._captureAt(attacker, 'test');
  assert.equal(victim.location.zone, 'airport');

  const deeper = classic();
  const attacker2 = deeper.pieces.red[0];
  const victim2 = deeper.pieces.blue[0];
  attacker2.location = { zone: 'lane', laneColor: 'yellow', laneIndex: 3, direction: 1 };
  victim2.location = { zone: 'lane', laneColor: 'yellow', laneIndex: 3, direction: 1 };
  deeper._captureAt(attacker2, '交换');
  assert.equal(victim2.location.zone, 'airport');
})();

(function protectionAndFriendlyCoexistence() {
  const game = classic({ protectedColors: ['red'] });
  game.pieces.red[0].location = { zone: 'main', mainIndex: 12 };
  game.pieces.blue[0].location = { zone: 'main', mainIndex: 12 };
  game._captureAt(game.pieces.red[0], 'test');
  assert.equal(game.pieces.blue[0].location.zone, 'main');
  game._captureAt(game.pieces.blue[0], 'test');
  assert.equal(game.pieces.red[0].location.zone, 'main');
  game.pieces.yellow[0].location = { zone: 'main', mainIndex: 12 };
  game._captureAt(game.pieces.yellow[0], 'test');
  assert.equal(game.pieces.red[0].location.zone, 'main');
})();

(function lockedThirdSixIsAutomaticAndUndoable() {
  const game = classic();
  game.pieces.red[0].location = { zone: 'main', mainIndex: 20 };
  game.colorState.red.consecutiveSixes = 2;
  game.rollSpec = { type: 'single', lockedColor: 'red' };
  game.rollDice([6]);
  const result = game.selectDie(0);
  assert.equal(result.autoPenalty, true);
  assert.equal(game.pieces.red[0].location.zone, 'airport');
  game.undoPendingDefeat();
  assert.equal(game.pieces.red[0].location.zone, 'main');
  assert.equal(game.currentPlayerId, 'B', '反悔只取消遣返，不退回原回合');
})();

(function tripleSixCanBeDisabled() {
  const game = classic({ tripleSixPenalty: false });
  game.pieces.red[0].location = { zone: 'main', mainIndex: 20 };
  game.colorState.red.consecutiveSixes = 2;
  game.rollSpec = { type: 'single', lockedColor: 'red' };
  game.rollDice([6]);
  const result = game.selectDie(0);
  assert.equal(result.autoPenalty, undefined);
  assert.equal(game.phase, 'selectPiece');
})();

(function speedModeHasOnePieceAndNoCapture() {
  const game = new DoubleFlightEngine({ mode: 'speed', playerAColors: ['red', 'yellow'], firstPlayer: 'B' });
  assert.equal(game.pieceCount, 1);
  assert.equal(game.pieces.red[0].location.zone, 'launch');
  game.pieces.red[0].location = { zone: 'main', mainIndex: 12 };
  game.pieces.blue[0].location = { zone: 'main', mainIndex: 12 };
  game._captureAt(game.pieces.red[0], 'test');
  assert.equal(game.pieces.blue[0].location.zone, 'main');
})();

(function victoryAndRemainderEnd() {
  const game = classic();
  game.players[0].colors.forEach(color => game.pieces[color].forEach(piece => {
    piece.finished = true;
    piece.location = { zone: 'finished', finishColor: color };
  }));
  assert.equal(game._checkWinner(), true);
  assert.equal(game.winner, 'A');
  assert.equal(game.continueAfterWin(), true);
  game.players[1].colors.forEach(color => game.pieces[color].forEach(piece => {
    piece.finished = true;
    piece.location = { zone: 'finished', finishColor: color };
  }));
  assert.equal(game._checkWinner(), true);
  assert.equal(game.remainderComplete, true);
  assert.equal(game.winner, null);
})();


(function sameSquarePiecesCannotSwap() {
  const game = classic();
  game.pieces.red[0].location = { zone: 'main', mainIndex: 12 };
  game.pieces.yellow[0].location = { zone: 'main', mainIndex: 12 };
  assert.throws(() => game.beginSwap('red-0', 'yellow-0'), /同一格/);

  game.pieces.red.forEach(piece => { piece.location = { zone: 'main', mainIndex: 12 }; });
  game.pieces.yellow.forEach(piece => { piece.location = { zone: 'main', mainIndex: 12 }; });
  assert.equal(game.canSwap(), false, '若两个颜色所有可交换棋子均在同一格，不应开放交换');
})();

(function captureEventsContainFullAnimationPath() {
  const game = classic();
  const attacker = game.pieces.red[0];
  const victim = game.pieces.blue[0];
  attacker.location = { zone: 'main', mainIndex: 12 };
  victim.location = { zone: 'main', mainIndex: 12 };
  const events = game._captureAt(attacker, 'test');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].fromLocation, { zone: 'main', mainIndex: 12 });
  assert.deepEqual(events[0].location, { zone: 'airport', zoneColor: 'blue', slot: 0 });
  assert.equal(events[0].targetColor, 'blue');
})();

(function serializedStateCanRestoreAcrossPlayerChanges() {
  const game = classic();
  game.pieces.red[0].location = { zone: 'launch', zoneColor: 'red' };
  game.pieces.yellow[0].location = { zone: 'launch', zoneColor: 'yellow' };
  game.rollDice([2, 3]);
  game.selectDie(0);
  const before = game.serialize();
  game.moveSelectedPiece('red-0');
  assert.notDeepEqual(game.serialize(), before);
  const restored = game.restore(before);
  assert.deepEqual(restored, before, '完整快照恢复后应与操作前状态逐字段一致');
  assert.equal(game.currentPlayerId, 'A');
  assert.equal(game.phase, 'selectPiece');
  assert.equal(game.selectedDieIndex, 0);
  assert.deepEqual(game.currentRoll.values, [2, 3]);
  assert.deepEqual(game.pieces.red[0].location, { zone: 'launch', zoneColor: 'red' });
})();

console.log('engine tests passed');
