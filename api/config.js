// ============================================================
// GET /api/config
//   告诉前端「服务端有没有配好转写 Key」——只返回布尔值，
//   绝不返回 Key 本身，避免密钥泄露到浏览器。
// ============================================================
'use strict';

const { sendJson, sendOptions } = require('../lib/http');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return sendOptions(res);

  const key = String(process.env.SILICONFLOW_API_KEY || process.env.SILICONFLOW_KEY || '').trim();

  return sendJson(res, 200, {
    ok: true,
    asr: {
      serverKey: !!key,
      proxyPath: '/api/asr',
    },
  });
};
