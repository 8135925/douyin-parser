// ============================================================
// GET /api/media?url={媒体直链}
//   媒体中转：抖音 CDN 无 CORS 头，浏览器侧无法直接播放 / 下载 / 解码音频。
//
// 【平台限制与对策】
//   Vercel Serverless 的响应体上限是 4.5MB，而抖音原片动辄 3–30MB，
//   所以这里强制走 Range 分片：
//     · 客户端不带 Range      -> 返回前 3MB（206 + Content-Range 带总长）
//     · 客户端 bytes=N-       -> 自动截成 N ~ N+3MB-1
//     · 客户端 bytes=N-M      -> 若跨度 ≤3MB 原样透传，否则也截断
//   浏览器看到 206 + Content-Range 会自动续请求后续分片，播放不受影响；
//   下载侧由前端按 Range 循环拼装（见页面 downloadVideo 的 chunked 路径）。
// ============================================================
'use strict';

const { fetchMedia, MAX_CHUNK } = require('../lib/douyin');
const { sendBuffer, sendJson, sendOptions, getQuery, one } = require('../lib/http');

// 单片上限：平台 4.5MB 留 1.5MB 余量（含头部与编码开销）
const CHUNK = Math.min(MAX_CHUNK, 3 * 1024 * 1024);

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return sendOptions(res);

  const q = getQuery(req);
  const target = one(q.url);
  if (!target) return sendJson(res, 400, { code: 400, message: '缺少 url 参数' });

  try {
    const r = await fetchMedia(target, req.headers.range || '', {
      maxChunk: CHUNK,
      timeoutMs: 30000,
    });

    if (req.method === 'HEAD') {
      res.statusCode = r.status;
      for (const [k, v] of r.headers) res.setHeader(k, v);
      return res.end();
    }

    // 一次性读成 Buffer 再发：单片 ≤3MB，内存压力可忽略，
    // 比流式更稳（Serverless 环境下 res.write 中途被中断更难排查）。
    const reader = r.body && r.body.getReader ? r.body.getReader() : null;
    if (!reader) {
      res.statusCode = r.status;
      for (const [k, v] of r.headers) res.setHeader(k, v);
      return res.end();
    }
    const chunks = [];
    let size = 0;
    // 硬上限兜底：上游无视 Range 时也不能把整个文件读进来爆内存
    const HARD_CAP = CHUNK + 512 * 1024;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > HARD_CAP) {
        try { await reader.cancel(); } catch (e) {}
        break;
      }
      chunks.push(Buffer.from(value));
    }
    const buf = Buffer.concat(chunks);

    const headers = r.headers;
    headers.set('X-Dy-Chunked', r.ranged ? '1' : '0');
    headers.set('Cache-Control', 'public, max-age=3600');

    return sendBuffer(res, r.status, buf, headers);
  } catch (e) {
    const status = e.status || 502;
    return sendJson(res, status, { code: status, message: e.message || '媒体中转失败' });
  }
};

module.exports.config = { maxDuration: 60 };
