// ============================================================
// GET /api/health
// ============================================================
'use strict';

const { sendJson, sendOptions } = require('../lib/http');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return sendOptions(res);
  return sendJson(res, 200, {
    ok: true,
    service: 'douyin-parser',
    runtime: 'vercel-functions',
    region: process.env.VERCEL_REGION || 'local',
    uptime: Math.round(process.uptime()),
    now: new Date().toISOString(),
    node: process.version,
  });
};
