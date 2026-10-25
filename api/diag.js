// ============================================================
// GET /api/diag
//   部署后自检：判断「这台函数所在的云环境」能不能连通抖音。
//   换平台（Vercel / Cloudflare / 自建）第一件事就是打这个端点。
//
// 返回内容：
//   egress   出口 IP 与地区（判断是否被风控的关键依据）
//   region   函数运行区域
//   net      各抖音域名的可达性 + 耗时（TLS 握手 + 首字节）
//   ttwid    分享页能否下发设备标识
//   parse    端到端解析是否成功
// ============================================================
'use strict';

const { resolveShare, extractRouterData, pickItem, collectSetCookie, MOBILE_UA } = require('../lib/douyin');
const { sendJson, sendOptions, getQuery, one } = require('../lib/http');

const PROBE_ID = process.env.DIAG_ID || '7699401710581697826';

async function timed(name, url, headers, ms) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      headers: headers || { 'User-Agent': MOBILE_UA },
      redirect: 'manual',
      signal: AbortSignal.timeout(ms || 8000),
    });
    const buf = await r.arrayBuffer().catch(() => new ArrayBuffer(0));
    return {
      name,
      // 判「网络可达」而非「业务成功」：只要拿到 HTTP 响应就说明 DNS/TLS/路由都通。
      // 抖音不少域名根路径返回 404/403，那是正常的，不能当成不通。
      ok: true,
      status: r.status,
      ms: Date.now() - t0,
      bytes: buf.byteLength,
    };
  } catch (e) {
    return {
      name,
      ok: false,
      status: 0,
      ms: Date.now() - t0,
      error: (e && e.message) || String(e),
    };
  }
}

async function egressInfo() {
  const sources = [
    { url: 'https://api.ipify.org?format=json', pick: j => ({ ip: j.ip }) },
    { url: 'https://ipinfo.io/json', pick: j => ({ ip: j.ip, country: j.country, city: j.city, org: j.org }) },
    { url: 'https://www.cloudflare.com/cdn-cgi/trace', pick: t => ({ ip: (t.match(/^ip=(.+)$/m) || [])[1], loc: (t.match(/^loc=(.+)$/m) || [])[1] }) },
  ];
  for (const s of sources) {
    try {
      const r = await fetch(s.url, { signal: AbortSignal.timeout(6000) });
      const txt = await r.text();
      let j;
      try { j = JSON.parse(txt); } catch (e) { j = txt; }
      const info = s.pick(j);
      if (info && (info.ip || info.loc)) return { source: s.url, ...info };
    } catch (e) { /* 换下一个源 */ }
  }
  return { source: null, ip: null, note: '出口 IP 查询全部失败（可能出站被限）' };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return sendOptions(res);
  const q = getQuery(req);
  const doParse = one(q.parse) !== '0';

  const started = Date.now();
  const out = {
    runtime: 'vercel-functions',
    region: process.env.VERCEL_REGION || process.env.VERCEL_REGION_HINT || 'local',
    node: process.version,
    egress: null,
    net: [],
    ttwid: null,
    parse: null,
    verdict: '',
    elapsed: 0,
  };

  // 并行跑：出口 IP + 域名连通性
  const [egress, ...probes] = await Promise.all([
    egressInfo(),
    timed('iesdouyin.com', 'https://www.iesdouyin.com/'),
    timed('douyin.com', 'https://www.douyin.com/'),
    timed('v.douyin.com', 'https://v.douyin.com/'),
    timed('aweme.snssdk.com', 'https://aweme.snssdk.com/'),
    timed('api.ipify.org', 'https://api.ipify.org?format=json'),
  ]);
  out.egress = egress;
  out.net = probes;

  // ttwid：分享页自下发（最可靠）
  const shareUrl = 'https://www.iesdouyin.com/share/video/' + PROBE_ID + '/';
  try {
    const r = await fetch(shareUrl, {
      headers: { 'User-Agent': MOBILE_UA, Referer: 'https://www.iesdouyin.com/' },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
    });
    const html = await r.text();
    const jar = collectSetCookie(r.headers);
    const data = extractRouterData(html);
    out.ttwid = {
      status: r.status,
      bytes: html.length,
      setCookie: jar.length ? jar.join('; ').slice(0, 120) : '(无)',
      hasRouterData: !!data,
      hasItem: !!pickItem(data),
      note: pickItem(data) ? '带空 cookie 就拿到数据（出口状态良好）' : '空 cookie 只拿到空壳（正常，需带 ttwid 重发）',
    };
  } catch (e) {
    out.ttwid = { error: e.message };
  }

  // 端到端解析
  if (doParse) {
    const t0 = Date.now();
    try {
      const d = await resolveShare(shareUrl, { budgetMs: 20000 });
      out.parse = {
        ok: true,
        ms: Date.now() - t0,
        aweme_id: d.aweme_id,
        title: String(d.title || '').slice(0, 40),
        author: d.author,
        size: d.width + 'x' + d.height,
        video_url: String(d.video_url || '').slice(0, 90),
      };
    } catch (e) {
      out.parse = { ok: false, ms: Date.now() - t0, error: e.message };
    }
  }

  // 结论
  const netOk = out.net.filter(p => p.name !== 'api.ipify.org').every(p => p.ok);
  if (out.parse && out.parse.ok) {
    out.verdict = '全部正常：函数出口可访问抖音并成功解析。';
  } else if (!netOk) {
    out.verdict = '网络不通：至少一个抖音域名不可达。建议把函数区域切到 hkg1（香港）后重试。';
  } else {
    out.verdict = '域名可达但解析失败：多半是出口 IP 被风控。建议 ① 切 hkg1；② 稍后重试；③ 换用其他出口。';
  }

  out.elapsed = Date.now() - started;
  return sendJson(res, 200, out, { 'Cache-Control': 'no-store' });
};

module.exports.config = { maxDuration: 60 };
