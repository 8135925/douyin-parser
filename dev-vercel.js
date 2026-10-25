// ============================================================
// 本地模拟 Vercel Functions 环境（不需要装 vercel CLI）
//
//   node dev-vercel.js            -> http://127.0.0.1:3100
//
// 作用：把 api/*.js 当成 Vercel 那样直接调用，用同一套 req/res，
// 这样本地就能验证「Vercel 版代码路径」——包括 3MB 分片、4.5MB 上限
// 这类只在云平台才会暴露的问题。部署前先跑这个，能省掉反复推代码。
// ============================================================
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3100;
const HERE = __dirname;

// 本地模拟时顺便读一下 .env（Vercel 线上由平台注入环境变量，不走这里）
(function loadDotEnv() {
  const f = path.join(HERE, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const k = m[1];
    let v = m[2];
    v = v.replace(/^(['"])([\s\S]*)\1$/, '$2');
    if (process.env[k] === undefined) process.env[k] = v;
  }
})();

// Vercel 的响应体上限（用于本地跟线上对齐校验）
const VERCEL_BODY_LIMIT = 4.5 * 1024 * 1024;

const ROUTES = {
  '/api/parse': require('./api/parse.js'),
  '/api/media': require('./api/media.js'),
  '/api/health': require('./api/health.js'),
  '/api/diag': require('./api/diag.js'),
  '/api/config': require('./api/config.js'),
  '/api/asr': require('./api/asr.js'),
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/';

  // 统计响应体大小，超 4.5MB 直接报警（模拟 Vercel 会 500）
  const origEnd = res.end.bind(res);
  let sent = 0;
  res.end = function (chunk, ...rest) {
    if (chunk) sent += Buffer.byteLength(chunk);
    if (sent > VERCEL_BODY_LIMIT) {
      console.error('[warn] 响应体 ' + (sent / 1024 / 1024).toFixed(2) + 'MB 超过 Vercel 4.5MB 上限！' + p);
    }
    return origEnd(chunk, ...rest);
  };

  const handler = ROUTES[p];
  if (handler) {
    // 还原 Vercel 注入的 req.query
    const q = {};
    for (const [k, v] of url.searchParams) q[k] = v;
    req.query = q;
    try {
      await handler(req, res);
    } catch (e) {
      console.error('[handler error]', p, e);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
      }
      origEnd(JSON.stringify({ code: 500, message: e.message }));
    }
    return;
  }

  // 静态文件（模拟 Vercel 的静态托管）
  let rel = p === '/' ? '/index.html' : p;
  const file = path.join(HERE, rel);
  if (!file.startsWith(HERE)) {
    res.statusCode = 403;
    return origEnd('forbidden');
  }
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    const ext = path.extname(file).toLowerCase();
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    return origEnd(fs.readFileSync(file));
  }

  res.statusCode = 404;
  origEnd('Not Found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('vercel-sim listening on http://127.0.0.1:' + PORT);
  console.log('routes:', Object.keys(ROUTES).join(', '));
});
