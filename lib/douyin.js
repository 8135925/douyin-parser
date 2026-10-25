// ============================================================
// 抖音解析核心逻辑（平台无关）
//   被 server.js（长驻 Node 服务）与 api/*.js（Vercel Functions）共用。
//
// 只做「纯逻辑 + 纯 fetch」，不接触 req/res，方便在不同运行时复用。
// ============================================================
'use strict';

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// 备用 UA：极少数情况下 iOS Safari UA 会被挑出来风控，换安卓 Chrome 再试
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ============================================================
   一、从分享页 HTML 中抠出 window._ROUTER_DATA
   ------------------------------------------------------------
   必须做括号配平扫描：正则匹配不了嵌套 JSON（字符串里还有花括号）。
   ============================================================ */
function extractRouterData(html) {
  if (!html) return null;
  const marker = 'window._ROUTER_DATA = ';
  let idx = html.indexOf(marker);
  let start = idx >= 0 ? idx + marker.length : -1;
  if (start < 0) {
    idx = html.indexOf('_ROUTER_DATA');
    if (idx < 0) return null;
    const eq = html.indexOf('=', idx);
    if (eq < 0) return null;
    start = eq + 1;
  }
  while (start < html.length && /\s/.test(html[start])) start++;
  if (html[start] !== '{') return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(start, i + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

/* ============================================================
   二、在 routerData 中定位作品节点
   ============================================================ */
function pickItem(data) {
  if (!data) return null;
  // 快路径：SSR 固定结构
  const page = data.loaderData && data.loaderData['video_(id)/page'];
  if (page && page.videoInfoRes) {
    const list = page.videoInfoRes.item_list;
    if (Array.isArray(list) && list.length) return list[0];
  }
  // 兜底：递归搜索（兼容 slides / note / 合集等其它页面结构）
  let hit = null;
  (function walk(o, depth) {
    if (hit || !o || typeof o !== 'object' || depth > 12) return;
    if (Array.isArray(o)) { for (const v of o) walk(v, depth + 1); return; }
    if (o.aweme_id && (o.video || o.images)) { hit = o; return; }
    for (const k of Object.keys(o)) walk(o[k], depth + 1);
  })(data, 0);
  return hit;
}

/* ============================================================
   三、Cookie 采集
   ------------------------------------------------------------
   命中率的分水岭：同一个手机 UA，无 cookie 命中 0/8，带 ttwid 命中 8/8。
   ttwid 两个来源，优先「分享页自己的 Set-Cookie」——它在受限网络下更可靠
   （云端沙箱访问 www.douyin.com 不通时，首页那条路是死的）。
   ============================================================ */
function collectSetCookie(headers) {
  const jar = [];
  let list = [];
  try {
    if (typeof headers.getSetCookie === 'function') list = headers.getSetCookie() || [];
  } catch (e) { list = []; }
  if (!list.length) {
    const raw = headers.get('set-cookie') || '';
    if (raw) list = raw.split(/,(?=[^;]+=)/);
  }
  for (const line of list) {
    const kv = String(line).split(';')[0].trim();
    if (kv && kv.indexOf('=') > 0) jar.push(kv);
  }
  return jar;
}

function mergeCookie(current, jar) {
  if (!jar || !jar.length) return current;
  const map = new Map();
  for (const kv of String(current || '').split(';').map(s => s.trim()).filter(Boolean)) {
    map.set(kv.split('=')[0], kv);
  }
  for (const kv of jar) map.set(kv.split('=')[0], kv);
  return [...map.values()].join('; ');
}

async function getTtwidFromHome(ua) {
  try {
    const r = await fetch('https://www.iesdouyin.com/', {
      headers: { 'User-Agent': ua || MOBILE_UA },
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    });
    const jar = collectSetCookie(r.headers);
    return jar.find(c => c.startsWith('ttwid=')) || '';
  } catch (e) {
    return '';
  }
}

/* ============================================================
   四、链接 → 作品 ID
   ============================================================ */
function extractAwemeId(s) {
  if (!s) return '';
  let m = s.match(/\/(?:video|note|slides)\/(\d{15,25})/);
  if (m) return m[1];
  m = s.match(/[?&](?:modal_id|aweme_id|item_ids)=(\d{15,25})/);
  if (m) return m[1];
  m = s.match(/^(\d{15,25})$/);
  if (m) return m[1];
  return '';
}

/* ============================================================
   五、归一化输出
   ============================================================ */
function firstUrl(node) {
  if (!node) return '';
  if (Array.isArray(node.url_list) && node.url_list.length) return node.url_list[0];
  if (Array.isArray(node.urlList) && node.urlList.length) return node.urlList[0];
  return '';
}

function buildPlayUrl(uri) {
  if (!uri) return '';
  return (
    'https://aweme.snssdk.com/aweme/v1/play/?line=0&logo_name=aweme_diversion_search&ratio=720p&video_id=' +
    uri
  );
}

function normalize(item, awemeId) {
  const video = item.video || {};
  const images = Array.isArray(item.images) ? item.images : [];

  // 无水印：url_list 给的是 playwm 地址，把 playwm 换成 play
  const rawPlay = firstUrl(video.play_addr);
  let videoUrl = rawPlay ? rawPlay.replace('/playwm/', '/play/').replace('playwm?', 'play?') : '';
  const backup = buildPlayUrl(video.play_addr && video.play_addr.uri);
  if (!videoUrl) videoUrl = backup;

  const cover = firstUrl(video.cover) || firstUrl(video.origin_cover) || firstUrl(video.dynamic_cover);
  const coverList = [
    firstUrl(video.cover),
    firstUrl(video.origin_cover),
    firstUrl(video.dynamic_cover),
  ].filter(Boolean);

  const stats = item.statistics || {};
  const music = item.music || {};

  return {
    aweme_id: String(item.aweme_id || awemeId),
    type: images.length ? 'images' : 'video',
    title: item.desc || item.preview_title || '',
    desc: item.desc || '',
    author: (item.author && item.author.nickname) || '',
    author_id: (item.author && (item.author.sec_uid || item.author.uid)) || '',
    avatar: firstUrl(item.author && item.author.avatar_thumb),
    cover,
    cover_list: [...new Set(coverList)],
    images: images.map(im => firstUrl(im)).filter(Boolean),
    video_url: videoUrl,
    video_url_backup: backup,
    duration: video.duration || 0,
    width: video.width || 0,
    height: video.height || 0,
    ratio: video.ratio || '',
    create_time: item.create_time || 0,
    statistics: {
      digg: stats.digg_count || 0,
      comment: stats.comment_count || 0,
      share: stats.share_count || 0,
      collect: stats.collect_count || 0,
      play: stats.play_count || 0,
    },
    music: {
      title: music.title || '',
      author: music.author || '',
      url: firstUrl(music.play_url),
    },
  };
}

/* ============================================================
   六、主解析流程
   ------------------------------------------------------------
   无状态设计：cookie 只作「本轮提示」，不做跨请求内存缓存。
   原因是 Vercel 每次冷启动都是新进程，内存缓存基本白存；
   而分享页每次都会下发新 cookie，本轮内部消化掉就够了。
   拿到 cookie 后通过返回值交给上层回写响应头，让客户端下次带上，
   这样第二次起就少一次往返。
   ============================================================ */
async function resolveShare(target, options) {
  const opts = options || {};
  const wantCookie = opts.cookie || '';   // 客户端带回来的 cookie
  const wantId = opts.awemeId || '';
  let budget = opts.budgetMs || 22000;    // 总时间预算，留给平台超时余量
  const t0 = Date.now();
  const left = () => Math.max(1500, budget - (Date.now() - t0));

  let awemeId = wantId || extractAwemeId(target);

  // 短链 / 网页链接：跟随跳转拿 ID（海外网络这一步可能偏慢，单独给 10s）
  if (!awemeId) {
    let r;
    try {
      r = await fetch(target, {
        headers: { 'User-Agent': MOBILE_UA, 'Referer': 'https://www.douyin.com/' },
        redirect: 'follow',
        signal: AbortSignal.timeout(Math.min(10000, left())),
      });
    } catch (e) {
      throw new Error('无法访问该链接（网络或链接格式问题）：' + e.message);
    }
    awemeId = extractAwemeId(r.url) || extractAwemeId(await r.text().catch(() => ''));
    if (!awemeId) throw new Error('链接中找不到作品 ID，请确认是抖音作品分享链接');
  }

  const shareUrl = 'https://www.iesdouyin.com/share/video/' + awemeId + '/';
  let cookie = wantCookie || '';
  let lastErr = '';
  let ua = MOBILE_UA;

  for (let attempt = 0; attempt < 5; attempt++) {
    if (left() < 1200) { lastErr = lastErr || '解析超时'; break; }

    let resp, html;
    try {
      resp = await fetch(shareUrl, {
        headers: {
          'User-Agent': ua,
          'Referer': 'https://www.iesdouyin.com/',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(Math.min(12000, left())),
      });
      html = await resp.text();
    } catch (e) {
      lastErr = '分享页请求失败：' + e.message;
      await sleep(300);
      continue;
    }

    // 本轮响应若下发新 cookie（首次访问必然有 ttwid），立刻用于下一轮
    const nextCookie = mergeCookie(cookie, collectSetCookie(resp.headers));
    if (nextCookie !== cookie) cookie = nextCookie;

    const data = extractRouterData(html);
    if (!data) {
      lastErr = '分享页未返回结构数据（HTTP ' + resp.status + '，' + html.length + ' 字节）';
      await sleep(250);
      continue;
    }

    const item = pickItem(data);
    if (item) {
      const out = normalize(item, awemeId);
      if (out.video_url || out.images.length) {
        out._cookie = cookie;  // 交给上层回写 Set-Cookie
        return out;
      }
      lastErr = '作品数据不完整（可能已删除或设为私密）';
    } else {
      const gone = /作品不存在|已被删除|当前作品无法查看|not\s*found/i.test(html);
      lastErr = gone
        ? '作品不存在、已删除或为私密作品'
        : '分享页只返回了空壳（' + html.length + ' 字节，无 videoInfoRes）';
      // 空壳 + 已带 cookie → 换 UA 再试，区分「风控」与「海外出口被限」
      if (!gone && attempt >= 2 && ua === MOBILE_UA) ua = ANDROID_UA;
    }
    await sleep(200 + attempt * 250);
  }

  const hint =
    /空壳|超时|请求失败/.test(lastErr) && !wantCookie
      ? '（若反复出现，通常是服务端出口 IP 被风控，可尝试把函数区域切到 hkg1，或改用境外可用的中转）'
      : '';
  throw new Error((lastErr || '解析失败') + hint);
}

/* ============================================================
   七、媒体中转
   ------------------------------------------------------------
   抖音 CDN 无 CORS 头，浏览器无法直接播放/下载/解码，必须服务端取字节。
   白名单防 SSRF：只允许抖音系域名，避免被当成开放代理。
   ============================================================ */
const MEDIA_HOSTS = [
  'aweme.snssdk.com', 'snssdk.com', 'douyin.com', 'douyinpic.com',
  'douyinvod.com', 'byteimg.com', 'zjcdn.com', 'ixigua.com',
  'douyinstatic.com', 'bytedance.com', 'pstatp.com', 'amemv.com',
];

function hostAllowed(h) {
  h = String(h || '').toLowerCase();
  return MEDIA_HOSTS.some(d => h === d || h.endsWith('.' + d));
}

// Vercel Serverless 响应体上限 4.5MB，留出余量后单片 3MB 最稳。
const MAX_CHUNK = 3 * 1024 * 1024;

/**
 * 取上游媒体。
 * @param {string} target   上游直链
 * @param {string} rangeHdr 客户端 Range 头（可空）
 * @returns {Promise<{status:number, headers:Headers, body:ReadableStream|null, ranged:boolean, total:number|null}>}
 *
 * 关键：当客户端发的是开放式 Range（如 bytes=0-）时，主动截成固定大小分片，
 * 否则上游会返回整个文件 → 超过 Vercel 4.5MB 上限 → 函数报错。
 * 浏览器看到 206 + Content-Range（含总长）会自动继续请求后续分片。
 */
async function fetchMedia(target, rangeHdr, opts) {
  const options = opts || {};
  let u;
  try { u = new URL(target); } catch (e) {
    const err = new Error('url 参数不是合法地址'); err.status = 400; throw err;
  }
  if (!/^https?:$/.test(u.protocol)) {
    const err = new Error('仅支持 http/https'); err.status = 400; throw err;
  }
  if (!hostAllowed(u.hostname)) {
    const err = new Error('该域名不在媒体白名单内：' + u.hostname); err.status = 403; throw err;
  }

  // 解析客户端 Range，判断是否需要自行分片
  let start = 0, end = null, hadRange = false;
  if (rangeHdr) {
    const m = String(rangeHdr).match(/bytes=(\d*)-(\d*)/);
    if (m && (m[1] || m[2])) {
      hadRange = true;
      if (m[1] === '') {
        // 后缀范围 bytes=-N（取末尾 N 字节）—— 原样透传，体积天然可控
        start = null;
        end = m[2] ? Number(m[2]) : null;
      } else {
        start = Number(m[1]);
        end = m[2] ? Number(m[2]) : null;
      }
    }
  }

  const maxChunk = options.maxChunk || MAX_CHUNK;
  let capped = false;
  // 开放式结尾（bytes=N- 或不带 Range）→ 主动截片，避免超出平台上限
  if (start !== null && (end === null || end - start + 1 > maxChunk)) {
    end = start + maxChunk - 1;
    capped = true;
  }

  const upstreamRange =
    start === null
      ? 'bytes=-' + end
      : 'bytes=' + start + '-' + end;

  const headers = {
    'User-Agent': MOBILE_UA,
    'Referer': 'https://www.douyin.com/',
    Range: upstreamRange,
  };

  let upstream;
  try {
    upstream = await fetch(u.toString(), {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(options.timeoutMs || 25000),
    });
  } catch (e) {
    const err = new Error('上游取流失败：' + e.message); err.status = 502; throw err;
  }

  if (!upstream.ok && upstream.status !== 206) {
    const err = new Error('上游返回 HTTP ' + upstream.status);
    err.status = upstream.status === 404 ? 404 : 502;
    err.upstreamStatus = upstream.status;
    throw err;
  }

  // 从 Content-Range 解析总长，供 Content-Range 回填
  const cr = upstream.headers.get('content-range') || '';
  const total = (cr.match(/\/(\d+)/) || [])[1] || null;

  const out = new Headers();
  const pass = ['content-type', 'etag', 'last-modified'];
  for (const k of pass) {
    const v = upstream.headers.get(k);
    if (v) out.set(k, v);
  }
  if (!out.get('content-type')) out.set('content-type', 'application/octet-stream');
  out.set('accept-ranges', 'bytes');

  const bodyLen = upstream.headers.get('content-length');
  const status = capped || hadRange ? 206 : (upstream.status === 206 ? 206 : 200);

  if (status === 206) {
    const s = start === null ? (total ? Math.max(0, Number(total) - Number(end)) : 0) : start;
    const e = start === null
      ? (total ? Number(total) - 1 : '')
      : (bodyLen ? s + Number(bodyLen) - 1 : end);
    out.set('content-range', 'bytes ' + s + '-' + e + '/' + (total || '*'));
  }
  if (bodyLen) out.set('content-length', bodyLen);

  return {
    status,
    headers: out,
    body: upstream.body,
    ranged: status === 206,
    total: total ? Number(total) : null,
    capped,
  };
}

module.exports = {
  MOBILE_UA,
  ANDROID_UA,
  extractRouterData,
  pickItem,
  collectSetCookie,
  mergeCookie,
  getTtwidFromHome,
  extractAwemeId,
  normalize,
  resolveShare,
  fetchMedia,
  hostAllowed,
  MEDIA_HOSTS,
  MAX_CHUNK,
};
