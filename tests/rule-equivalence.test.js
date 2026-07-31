'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const V028_ENGINE_SHA256 = '9f0b9724d6a96a6fda97eeafd51006f9a1be6991b2ee31181fcaa50454f5f890';

test('共享规则核心与双飞 v0.28 AI版逐字节一致', () => {
  const file = path.join(__dirname, '..', 'shared', 'engine.js');
  const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.equal(digest, V028_ENGINE_SHA256);
});
