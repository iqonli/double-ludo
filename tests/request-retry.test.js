'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const retry = require('../public/request-retry.js');

test('404重试计划为10次100ms、10次200ms、5次300ms', () => {
  assert.equal(retry.RETRY_404_DELAYS.length, 25);
  assert.deepEqual(retry.RETRY_404_DELAYS.slice(0, 10), Array(10).fill(100));
  assert.deepEqual(retry.RETRY_404_DELAYS.slice(10, 20), Array(10).fill(200));
  assert.deepEqual(retry.RETRY_404_DELAYS.slice(20), Array(5).fill(300));
});

test('应用请求遇到404时完成25次重试，成功后立即返回', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return {
      status: calls <= 25 ? 404 : 200,
      body: { cancel() {} }
    };
  };
  try {
    const response = await retry.fetch('https://example.invalid/api', {}, { delays: Array(25).fill(0) });
    assert.equal(response.status, 200);
    assert.equal(calls, 26);
  } finally {
    global.fetch = originalFetch;
  }
});

test('25次重试后仍为404时返回最后一次404', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return { status: 404, body: { cancel() {} } };
  };
  try {
    const response = await retry.fetch('https://example.invalid/missing', {}, { delays: Array(25).fill(0) });
    assert.equal(response.status, 404);
    assert.equal(calls, 26);
  } finally {
    global.fetch = originalFetch;
  }
});
