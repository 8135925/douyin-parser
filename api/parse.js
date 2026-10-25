// ============================================================
// GET /api/parse?url={抖音链接}
//   -> { code: 0, data: {...} }
//   -> { code: 500, message: "原因" }
//
// 可选参数：
//   ck=ttwid%3D...   客户端回带的 cookie（减少一次往返，提高命中率）
//   id=7699...       直接给作品 ID，跳过短链跳转
// ============================================================
'use strict';

const { resolveShare } = require('../lib/douyin');
const { sendJson, sendOptions, getQuery, one } = require('../lib/http');

// Vercel 函数最长执行时间（Hobby 支持 60s，留足海外慢网余量）
const MAX_DURATION = 60;

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return sendOptions(res);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { code: 405, message: '仅支持 GET' });
  }

  const q = getQuery(req);
  const target = one(q.url) || one(q.shorturl) || '';
  const awemeId = one(q.id) || '';
  const cookie = one(q.ck) || req.headers['x-dy-cookie'] || '';

  if (!target && !awemeId) {
    return sendJson(res, 400, {
      code: 400,
      message: '缺少 url 参数，用法：/api/parse?url=抖音分享链接',
    });
  }

  const t0 = Date.now();
  try {
    // 预算压在 25s 内：平台超时 60s，但用户等不了那么久，
    // 且留出余量避免函数被硬杀导致前端只看到网关 504。
    const data = await resolveShare(target.trim() || '', {
      cookie,
      awemeId,
      budgetMs: 25000,
    });

    const ck = data._cookie || '';
    delete data._cookie;

    const extra = {
      'X-Dy-Region': process.env.VERCEL_REGION || 'local',
      'Cache-Control': 'no-store',
    };
    if (ck) extra['X-Dy-Cookie'] = ck;

    console.log('[parse] ok', data.aweme_id, data.author, Date.now() - t0 + 'ms');
    return sendJson(res, 200, { code: 0, message: 'ok', ms: Date.now() - t0, data }, extra);
  } catch (e) {
    console.log('[parse] fail', String(target).slice(0, 80), e.message);
    return sendJson(
      res,
      200,
      {
        code: 500,
        message: e.message || '解析失败',
        ms: Date.now() - t0,
        region: process.env.VERCEL_REGION || 'local',
      },
      { 'Cache-Control': 'no-store' }
    );
  }
};

module.exports.config = { maxDuration: MAX_DURATION };
