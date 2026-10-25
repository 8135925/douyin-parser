// ============================================================
// GET /api/config           -> 只告知「服务端有没有配 Key」
// GET /api/config?reveal=1  -> 额外返回 Key 本身，供浏览器直连使用
//
// 什么时候需要 reveal：
//   音频经 /api/asr 中转受 Vercel 4.5MB 请求体上限限制（约 2 分钟 WAV）。
//   超过该体积时，前端会取回 Key 改为浏览器直连硅基流动，绕开上限。
//
// 注意：?reveal=1 对任何知道该地址的人都有效。私有部署可以接受，
// 公开站点不建议（等于把 Key 交给访问者）。不想暴露可设环境变量
//   ASR_ALLOW_KEY_REVEAL=0
// 关掉后本接口只回 serverKey 布尔值，超长音频会提示改用本机 Key。
// ============================================================
'use strict';

const { sendJson, sendOptions, getQuery, one } = require('../lib/http');

function readKey() {
  return String(process.env.SILICONFLOW_API_KEY || process.env.SILICONFLOW_KEY || '').trim();
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return sendOptions(res);

  const key = readKey();
  const q = getQuery(req);
  const reveal = one(q.reveal) === '1' || one(q.reveal) === 'true';
  const allowReveal = String(process.env.ASR_ALLOW_KEY_REVEAL || '1') !== '0';

  const asr = { serverKey: !!key, proxyPath: '/api/asr' };
  if (reveal && key && allowReveal) asr.key = key;

  return sendJson(res, 200, { ok: true, asr: asr });
};
