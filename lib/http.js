// ============================================================
// Vercel Functions 的轻量响应工具
//   Vercel 的 Node runtime 直接把 (req, res) 交给函数，req/res 是标准
//   Node IncomingMessage / ServerResponse，所以不需要额外框架。
// ============================================================
'use strict';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  // Range 必须显式列出：部分浏览器在 CORS 预检时不会因 * 而放行 Range
  'Access-Control-Allow-Headers': 'Range, Content-Type, Accept, Origin, X-Dy-Cookie, X-Requested-With',
  'Access-Control-Expose-Headers':
    'Content-Length, Content-Range, Accept-Ranges, Content-Type, X-Dy-Cookie, X-Dy-Region, X-Dy-Chunked',
  'Access-Control-Max-Age': '86400',
};

function sendJson(res, status, obj, extra) {
  const body = JSON.stringify(obj);
  res.statusCode = status;
  for (const k of Object.keys(CORS)) res.setHeader(k, CORS[k]);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  if (extra) for (const k of Object.keys(extra)) res.setHeader(k, extra[k]);
  res.end(body);
}

function sendBuffer(res, status, buf, headers) {
  res.statusCode = status;
  for (const k of Object.keys(CORS)) res.setHeader(k, CORS[k]);
  if (headers) {
    for (const [k, v] of headers) res.setHeader(k, v);
  }
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
}

function sendOptions(res) {
  res.statusCode = 204;
  for (const k of Object.keys(CORS)) res.setHeader(k, CORS[k]);
  res.end();
}

/** 读请求 query（Vercel 已帮我们解析好 req.query，这里做兜底） */
function getQuery(req) {
  if (req.query && typeof req.query === 'object') return req.query;
  const u = new URL(req.url || '/', 'http://localhost');
  const o = {};
  for (const [k, v] of u.searchParams) o[k] = v;
  return o;
}

/** 单值取值（Vercel 对重复参数返回数组） */
function one(v) {
  return Array.isArray(v) ? v[0] : (v == null ? '' : String(v));
}

module.exports = { CORS, sendJson, sendBuffer, sendOptions, getQuery, one };
