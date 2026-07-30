'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('../public/ai-model-normal.js');
require('../public/ai-controller.js');
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/model-reference.json'), 'utf8'));
const model = globalThis.DoubleFlightAI.models.get('normal-v1');
assert(model, 'normal model missing');
let maxError = 0;
for (const item of cases) {
  const got = model.logits(new Float32Array(item.obs));
  assert.equal(got.length, 292);
  for (let i = 0; i < got.length; i += 1) {
    const error = Math.abs(got[i] - item.logits[i]);
    maxError = Math.max(maxError, error);
    assert(error < 2e-5, `logit ${i} mismatch: ${got[i]} vs ${item.logits[i]}`);
  }
}
console.log(`model inference tests passed; max abs error=${maxError}`);
