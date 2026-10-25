// ============================================================
// POST /api/asr
//   音频转文字中转：浏览器把音频原样（multipart/form-data）传上来，
//   这里补上 Authorization 转发到硅基流动，再把结果原样返回。
//
// 【为什么需要这一层】
//   把 API Key 放进 Vercel 环境变量后，前端就不用再手填 Key，
//   Key 也永远不会出现在浏览器里（页面只知道自己「能用」）。
//
// 【配置】
//   Vercel 项目 -> Settings -> Environment Variables
//     Name : SILICONFLOW_API_KEY
//     Value: sk-xxxxxxxx
//   未配置时本接口返回 501，前端自动回退到「本机 Key 直连」模式。
//
// 【平台限制】
//   Vercel Serverless 单次请求体上限 4.5MB，16kHz 单声道 WAV 约 32KB/秒，
//   即最长约 2 分钟音频。超限请改用页面里手动填 Key 的直连方式。
// ============================================================
'use strict';

const { sendJson, sendOptions } = require('../lib/http');

const ASR_URL = 'https://api.siliconflow.cn/v1/audio/transcriptions';
// 平台上限 4.5MB，这里留一点余量给 multipart 的边界字段
const MAX_BODY = 4 * 1024 * 1024;

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        const err = new Error(
          '音频约 ' + (size / 1024 / 1024).toFixed(1) + 'MB，超过 4MB 上限（Vercel 单次请求体 4.5MB）。' +
          '请把视频截短，或在页面「设置」里填自己的 API Key 直连硅基流动。'
        );
        err.status = 413;
        // 不 destroy：否则连接被重置，前端拿不到这段 JSON 提示
        req.pause();
        return reject(err);
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return sendOptions(res);
  if (req.method !== 'POST') {
    return sendJson(res, 405, { code: 405, message: '仅支持 POST' });
  }

  const key = String(process.env.SILICONFLOW_API_KEY || process.env.SILICONFLOW_KEY || '').trim();
  if (!key) {
    return sendJson(res, 501, {
      code: 501,
      message: '服务端未配置 SILICONFLOW_API_KEY。请在 Vercel 项目设置里添加该环境变量后重新部署。',
    });
  }

  const ctype = req.headers['content-type'] || '';
  if (!/multipart\/form-data/i.test(ctype)) {
    return sendJson(res, 415, { code: 415, message: '请以 multipart/form-data 上传（字段：model、file）' });
  }

  let body;
  try {
    body = await readBody(req, MAX_BODY);
  } catch (e) {
    return sendJson(res, e.status || 400, { code: e.status || 400, message: e.message });
  }

  try {
    const r = await fetch(ASR_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': ctype },
      body,
    });
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { /* 上游返回非 JSON */ }

    if (!r.ok) {
      const msg =
        (data && (data.message || data.error || data.msg)) ||
        text.slice(0, 200).replace(/\s+/g, ' ') ||
        ('HTTP ' + r.status);
      return sendJson(res, r.status, { code: r.status, message: msg });
    }
    if (!data) {
      return sendJson(res, 502, {
        code: 502,
        message: 'ASR 返回非 JSON：' + text.slice(0, 120).replace(/\s+/g, ' '),
      });
    }
    return sendJson(res, 200, data);
  } catch (e) {
    return sendJson(res, 502, {
      code: 502,
      message: '转写请求失败：' + (e && e.message ? e.message : String(e)),
    });
  }
};

module.exports.config = { maxDuration: 60 };
