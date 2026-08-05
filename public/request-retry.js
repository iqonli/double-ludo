(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.DoubleLudoRequestRetry = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  // Initial request, then 25 retries: 10 × 100 ms, 10 × 200 ms, 5 × 300 ms.
  const RETRY_404_DELAYS = Object.freeze([
    ...Array(10).fill(100),
    ...Array(10).fill(200),
    ...Array(5).fill(300)
  ]);

  function abortError() {
    const error = new Error('请求已取消');
    error.name = 'AbortError';
    return error;
  }

  function delay(ms, signal) {
    if (signal && signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = root.setTimeout(() => {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        if (settled) return;
        settled = true;
        root.clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        reject(abortError());
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function discardResponse(response) {
    try {
      const result = response && response.body && typeof response.body.cancel === 'function'
        ? response.body.cancel()
        : null;
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch (_) {}
  }

  async function fetchWith404Retry(input, init = {}, retryOptions = {}) {
    if (typeof root.fetch !== 'function') throw new Error('当前环境不支持fetch');
    const retry404 = retryOptions.retry404 !== false;
    const delays = Array.isArray(retryOptions.delays) ? retryOptions.delays : RETRY_404_DELAYS;
    let response = await root.fetch(input, init);
    if (!retry404) return response;
    for (const waitMs of delays) {
      if (!response || response.status !== 404) return response;
      discardResponse(response);
      await delay(waitMs, init && init.signal);
      response = await root.fetch(input, init);
    }
    return response;
  }

  return { RETRY_404_DELAYS, fetch: fetchWith404Retry, delay };
});
