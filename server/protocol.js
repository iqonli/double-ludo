'use strict';

class ApiError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function assert(condition, status, code, message, details = null) {
  if (!condition) throw new ApiError(status, code, message, details);
}

function jsonBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const finishReject = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        finishReject(new ApiError(413, 'BODY_TOO_LARGE', '请求内容过大'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        reject(new ApiError(400, 'INVALID_JSON', '请求不是有效JSON'));
      }
    });
    req.on('aborted', () => finishReject(new ApiError(400, 'REQUEST_ABORTED', '请求在传输完成前中断')));
    req.on('error', error => finishReject(new ApiError(400, 'REQUEST_STREAM_ERROR', error.message)));
  });
}

function commonHeaders() {
  return {
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Content-Type-Options': 'nosniff'
  };
}

function sendJson(res, status, payload) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...commonHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendJsonDownload(res, payload, filename) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(payload, null, 2) + '\n';
  const safeName = String(filename || 'double-flight-save.json').replace(/[^\w.\-]/g, '_');
  res.writeHead(200, {
    ...commonHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Content-Disposition': `attachment; filename="${safeName}"`
  });
  res.end(body);
}

function sendNoContent(res) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(204, commonHeaders());
  res.end();
}

function sendError(res, error) {
  if (res.writableEnded || res.destroyed) return;
  if (error instanceof ApiError) {
    sendJson(res, error.status, {
      ok: false,
      error: error.code,
      message: error.message,
      details: error.details
    });
    return;
  }
  console.error(error);
  sendJson(res, 500, {
    ok: false,
    error: 'INTERNAL_ERROR',
    message: '服务端内部错误'
  });
}

module.exports = { ApiError, assert, jsonBody, sendJson, sendJsonDownload, sendNoContent, sendError, commonHeaders };
