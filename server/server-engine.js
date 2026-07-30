'use strict';

const crypto = require('node:crypto');
const { DoubleFlightEngine, COLORS } = require('../shared/engine.js');
const protocol = require('../shared/action-protocol.js');
const { ApiError, assert } = require('./protocol.js');

function sanitizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const mode = input.mode === 'speed' ? 'speed' : 'classic';
  const playerAColors = Array.isArray(input.playerAColors)
    ? Array.from(new Set(input.playerAColors.filter(color => COLORS.includes(color))))
    : [];
  assert(playerAColors.length === 2, 422, 'INVALID_CONFIG', '玩家A必须选择两个不同颜色');

  const launchValues = Array.isArray(input.launchValues)
    ? Array.from(new Set(input.launchValues.map(Number).filter(value => Number.isInteger(value) && value >= 1 && value <= 6))).sort((a, b) => a - b)
    : [];
  assert(launchValues.length > 0, 422, 'INVALID_CONFIG', '至少选择一个起飞点数');

  const protectedColors = mode === 'speed' ? [] : Array.isArray(input.protectedColors)
    ? Array.from(new Set(input.protectedColors.filter(color => COLORS.includes(color))))
    : [];

  const firstPlayer = mode === 'speed' && input.firstPlayer === 'B' ? 'B' : 'A';
  return {
    mode,
    playerAColors,
    protectedColors,
    launchValues,
    tripleSixPenalty: input.tripleSixPenalty !== false,
    firstPlayer
  };
}

function configFromSnapshot(snapshot) {
  assert(snapshot && typeof snapshot === 'object', 422, 'INVALID_SAVE', '对局文件缺少棋局快照');
  const players = Array.isArray(snapshot.players) ? snapshot.players : [];
  const playerA = players.find(player => player && player.id === 'A');
  const playerAColors = playerA && Array.isArray(playerA.colors) ? playerA.colors : [];
  const protectedColors = Object.entries(snapshot.colorState || {})
    .filter(([, value]) => value && value.protected)
    .map(([color]) => color);
  return sanitizeConfig({
    mode: snapshot.mode,
    playerAColors,
    protectedColors,
    launchValues: snapshot.launchValues,
    tripleSixPenalty: snapshot.tripleSixPenalty !== false,
    firstPlayer: snapshot.currentPlayerId === 'B' ? 'B' : 'A'
  });
}

class ServerEngine {
  constructor(config) {
    this.config = sanitizeConfig(config);
    this.engine = new DoubleFlightEngine(this.config);
    this.openingRollPending = this.config.mode === 'classic';
  }

  static fromSave(raw) {
    try {
      const value = raw && typeof raw === 'object' ? raw : {};
      const snapshot = value.snapshot || value.state;
      const config = value.config ? sanitizeConfig(value.config) : configFromSnapshot(snapshot);
      const restored = new ServerEngine(config);
      restored.engine.restore(snapshot);
      restored.config = configFromSnapshot(restored.engine.serialize());
      restored.openingRollPending = value.openingRollPending === undefined
        ? (restored.config.mode === 'classic' && restored.engine.turnNumber <= 1 && restored.engine.phase === 'awaitRoll')
        : Boolean(value.openingRollPending);
      // This is intentionally a loose compatibility check rather than a signed or
      // exhaustive validator. It merely prevents malformed JSON from replacing a
      // working room with an object that cannot be used by the engine at all.
      restored.snapshot();
      restored.hash();
      restored.legalActions();
      return restored;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'INVALID_SAVE') throw error;
      throw new ApiError(422, 'INVALID_SAVE', `无法恢复对局：${error.message}`);
    }
  }

  snapshot() {
    return this.engine.serialize();
  }

  exportData() {
    return {
      config: { ...this.config, playerAColors: this.config.playerAColors.slice(), protectedColors: this.config.protectedColors.slice(), launchValues: this.config.launchValues.slice() },
      openingRollPending: this.openingRollPending,
      snapshot: this.snapshot()
    };
  }

  hash() {
    return protocol.stateHash(this.snapshot(), this.openingRollPending);
  }

  legalActions() {
    return protocol.legalActions(this.engine);
  }

  currentPlayerId() {
    return this.engine.currentPlayerId;
  }

  step(actionCode) {
    try {
      const result = protocol.executeAction(this.engine, actionCode, {
        openingRollPending: this.openingRollPending,
        randomDie: () => crypto.randomInt(1, 7)
      });
      this.openingRollPending = result.openingRollPending;
      return result;
    } catch (error) {
      throw new ApiError(422, 'ILLEGAL_ACTION', error.message, {
        legalActions: this.legalActions()
      });
    }
  }

  command(command) {
    try {
      return protocol.executeCommand(this.engine, command);
    } catch (error) {
      throw new ApiError(422, 'ILLEGAL_COMMAND', error.message);
    }
  }
}

module.exports = { ServerEngine, sanitizeConfig, configFromSnapshot };
