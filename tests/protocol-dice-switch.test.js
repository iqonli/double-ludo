'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DoubleFlightEngine } = require('../shared/engine.js');
const Protocol = require('../shared/action-protocol.js');

test('已选择一枚骰子后仍可取消或切换到另一枚可用骰子', () => {
  const engine = new DoubleFlightEngine({
    mode: 'classic', playerAColors: ['red','yellow'], protectedColors: [],
    launchValues: [1,2,3,4,5,6], tripleSixPenalty: true, firstPlayer: 'A'
  });
  engine.rollDice([1, 2]);
  assert.deepEqual(Protocol.legalActions(engine).filter(a => a === 2 || a === 3), [2,3]);
  engine.selectDie(0);
  assert.equal(engine.phase, 'selectPiece');
  assert.equal(engine.selectedDieIndex, 0);
  const legal = Protocol.legalActions(engine);
  assert(legal.includes(2), '应允许再次点击当前骰子取消选择');
  assert(legal.includes(3), '应允许切换到另一枚可用骰子');
  Protocol.executeAction(engine, 3, {});
  assert.equal(engine.phase, 'selectPiece');
  assert.equal(engine.selectedDieIndex, 1);
});
