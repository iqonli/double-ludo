'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('../public/ai-model-normal.js');
require('../public/ai-model-advanced.js');
require('../public/ai-controller.js');
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, '../public/model-reference-advanced.json'), 'utf8'));
const model = globalThis.DoubleFlightAI.models.get('advanced-v1');
assert(model, 'advanced model missing');
assert.equal(model.metadata.label, '高级');
assert.equal(model.metadata.numTimesteps, 46367872);
assert(globalThis.DoubleFlightAI.modelOptions.some(item => item.id === 'advanced-v1' && item.label === '高级'));
let maxError = 0;
for (const item of cases) {
  const got = model.logits(new Float32Array(item.obs));
  assert.equal(got.length, 292);
  for (let i = 0; i < got.length; i += 1) {
    const error = Math.abs(got[i] - item.logits[i]);
    maxError = Math.max(maxError, error);
    assert(error < 2e-5, `advanced logit ${i} mismatch: ${got[i]} vs ${item.logits[i]}`);
  }
}
console.log(`advanced model inference tests passed; max abs error=${maxError}`);
