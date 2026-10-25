# 抖音解析服务

零依赖，一份核心逻辑（`lib/douyin.js`）同时支持两种部署形态：

| 形态 | 入口 | 适用 |
|---|---|---|
| 自托管长驻进程 | `server.js` | 自己的服务器 / 本机 / Docker |
| Serverless | `api/*.js` | **Vercel**、或任何 Node 函数平台 |

## 本机启动

**方式一：双击 `start.bat`**（推荐）

会自动检查 Node、启动服务、2 秒后打开浏览器。关闭窗口即停止。

**方式二：命令行**

```bash
cd douyin-service
node server.js        # → http://127.0.0.1:3000

# 换端口
PORT=3001 node server.js          # Git Bash / macOS / Linux
set PORT=3001 && node server.js   # Windows CMD
$env:PORT=3001; node server.js    # PowerShell
```

启动后：

```
http://127.0.0.1:3000/            页面（同源，解析/播放/下载/转文字全可用）
http://127.0.0.1:3000/api/health  健康检查
http://127.0.0.1:3000/api/diag    连通性自检（看出口 IP、ttwid、解析耗时）
```

> 直接双击 `douyin-parser.html`（file://）也能用——它默认把接口指向
> `http://127.0.0.1:3000`，所以只要上面的服务在跑，效果与网页版一致。

**方式三：模拟 Vercel 环境**（验证 Serverless 路径，不用装 CLI）

```bash
node dev-vercel.js    # → http://127.0.0.1:3100
```

---

## 一、部署到 Vercel

### 1. 推代码

把 **`douyin-service/` 目录**作为项目根目录（不是上一级）：

```bash
cd douyin-service
vercel            # 首次会问你项目名，一路回车
vercel --prod     # 发布到生产
```

也可以直接在 Vercel 网页端导入 Git 仓库，把 **Root Directory 设成 `douyin-service`**。

> 不需要装依赖（`package.json` 里零依赖），不需要 build 命令，
> Vercel 会自动识别 `api/` 目录为 Functions。
> 环境变量是可选的：只有想让「音频转文字」免手填 Key 时才需要配，见下一节。

### 2. 配置音频转文字 Key（可选，推荐）

在 Vercel 里加一个环境变量 `SILICONFLOW_API_KEY`，页面就不用每次手填 Key：

**网页端**：Project → Settings → Environment Variables → Add New

| 字段 | 值 |
|---|---|
| Key | `SILICONFLOW_API_KEY` |
| Value | `sk-...`（硅基流动控制台 → API 密钥） |
| Environments | 勾选 Production（Preview 建议一起勾） |

保存后必须 **Deployments → 最新一次部署 → Redeploy** 才生效（改环境变量不会自动重新部署）。

**命令行**：

```bash
vercel env add SILICONFLOW_API_KEY production
vercel --prod        # 重新部署，让变量生效
```

**本地调试**：`dev-vercel.js` 会自动读取项目根目录的 `.env`：

```ini
SILICONFLOW_API_KEY=sk-你的key
```

**工作机制**：

- 页面启动时请求 `GET /api/config`，只拿到「服务端有没有 Key」的布尔值（Key 永不下发浏览器）
- 有 → 音频上传到 `POST /api/asr`，由函数补上 `Authorization` 转发给硅基流动
- 没有 → 回退到页面里手填 Key 直连（老行为，Key 只存本机 localStorage）

> ⚠️ Vercel 单次请求体上限 **4.5 MB**，16 kHz 单声道 WAV 约 32 KB/秒，即最长约 **2 分钟**音频。
> 超长音频请在页面「设置」里填自己的 Key 直连，或用本机 `node server.js`。

### 3. 部署后先自检（重要）

```
https://你的域名/api/diag
```

这个端点会一次性告诉你：

- **函数实际运行的区域**（`region`）——决定网络质量的关键
- **出口 IP 与归属**（`egress`）——判断是否被抖音风控的依据
- **各抖音域名的可达性与耗时**（`net`）
- **分享页能否拿到设备标识**（`ttwid`）
- **端到端解析是否成功**（`parse`），以及一句结论（`verdict`）

`parse.ok === true` 就说明这条链路在你这个部署上是通的，可以直接用页面。

### 4. 用起来

```
https://你的域名/           页面（同源，自动指向自己的 /api/parse）
https://你的域名/api/parse?url=<抖音链接>
https://你的域名/api/media?url=<媒体直链>
```

页面通过 `location.origin` 自动指向同源 API，**不需要改任何配置**。
如果你要在本地用 `file://` 打开 HTML 并指向这个 Vercel 域名，加参数即可：

```
douyin-parser.html?origin=https://你的域名
```

---

## 二、网络连通性：Vercel 上最容易踩的坑

抖音的解析依赖「境外/云端出口 → 中国大陆 CDN」，这是整件事最脆弱的一环。
下面每一条都是实测过的，按严重程度排序。

### ① 区域（region）—— 决定成败的第一因素

Vercel 默认把函数放在 **`iad1`（美国华盛顿）**。从美东访问 `iesdouyin.com`，
绕行太平洋，延迟 300ms+，而且美东云厂商 IP 段是抖音风控的重点关照对象。

**本项目已在 `vercel.json` 里把区域设成香港：**

```json
{ "regions": ["hkg1"] }
```

香港离大陆最近、路由最好，实测是 Vercel 上最优选择。
如果 `hkg1` 被风控，按这个顺序往下换（改 `vercel.json` 一行，重新部署即可）：

```
hkg1（香港，首选） → sin1（新加坡） → kix1（大阪） → iad1（美东，最差）
```

> Hobby 计划只允许 **1 个区域**，所以只能一个一个试。
> 别指望运行时用环境变量切区域——区域是部署时就定死的，改不了。

### ② 出口 IP 被风控

即使域名可达，抖音也可能只给你「空壳页面」（HTTP 200，但内容里没有 `item_list`）。
这是最常见的失败形态，而且**看起来像成功**（状态码 200）。

本项目的对策是「多轮尝试 + 换 UA」：

1. 第一轮空 cookie 请求 → 从响应 `Set-Cookie` 里收 `ttwid`（这是命中率的分水岭：
   同一个手机 UA，无 cookie 命中 0/8，带 ttwid 命中 8/8）
2. 带 `ttwid` 重发
3. 仍拿不到 → 换 Android Chrome UA 再试
4. 共 5 轮，单轮失败间隔递增

全失败时会返回带原因的报错，并在提示里点明「可能是出口 IP 风控」。

### ③ 4.5 MB 响应体上限（这是会直接报错的硬限制）

Vercel Serverless 单次响应体 **最大 4.5 MB**，而抖音原片动辄 3–30 MB。

直接透传整个视频 → 函数 500 / 网关报错。**本项目已用 Range 分片解决**：

- `/api/media` 收到开放式 Range（`bytes=0-`）或不带 Range 时，
  **主动截成 3 MB 单片**，返回 `206 + Content-Range: bytes 0-3145727/总长`
- 浏览器看到 206 + 总长，会自动继续请求后续分片 → `<video>` 播放不受影响
- 页面下载走 `fetchMediaAll()`，按 Content-Range 循环取全后拼装成 Blob

正确的分片行为（`test-chunk.mjs` 有完整校验，7.16 MB 文件切 3 片、md5 字节级一致）：

```
GET /api/media?url=...                      -> 206  bytes 0-3145727/7503540
GET /api/media?url=...  Range: bytes=3145728- -> 206  bytes 3145728-6291455/7503540
GET /api/media?url=...  Range: bytes=6291456- -> 206  bytes 6291456-7503539/7503540
```

> 本地自托管不受此限制，但 `server.js` 刻意也用 3 MB 分片，
> 这样本地测过的结论对线上同样成立。

### ④ 函数执行时间

`vercel.json` 里设了 `maxDuration: 60`（Hobby 上限）。
解析本身通常 1–2 秒，但海外网络慢时首轮可能要 5–10 秒，
所以 `resolveShare` 内部还压了一层 25 秒预算，宁可自己超时返回结构化报错，
也不要被平台硬杀导致前端只看到一个 504。

### ⑤ 冷启动

Serverless 没有常驻进程，**每次冷启动都要重新取 ttwid**（多一次往返，约 +0.5–1 秒）。
所以本项目**不做跨请求 cookie 缓存**——在 Serverless 里那基本是白存。

作为补偿，解析成功时会把 cookie 通过 `X-Dy-Cookie` 响应头返回，
前端二次请求时可以带上（`?ck=...`），省掉一次取 cookie 的往返。

### ⑥ 调用量消耗

分片意味着**一次下载 = 多次函数调用**。一个 30 MB 的原片约 10 次调用。
Hobby 每月 100 万次调用，日常用完全够，但别拿它做批量爬取。

### ⑦ 想彻底绕开这些限制

如果 Vercel 的出口实在不行，把 `douyin-service/` 扔到一台**能直连大陆的机器**上
（`node server.js`，就一个进程，无依赖），页面里的「解析接口 / 媒体代理」改成那台机器的地址即可。
这是最稳的方案，Vercel 版本适合「没机器、图省事」的场景。

---

## 三、接口

### `GET /api/parse?url={抖音链接}`

```jsonc
{
  "code": 0,
  "ms": 1300,
  "data": {
    "aweme_id": "7699401710581697826",
    "type": "video",                    // video | images
    "title": "作品文案…",
    "author": "极目新闻",
    "cover": "https://…",
    "video_url": "https://aweme.snssdk.com/aweme/v1/play/?…",   // 无水印
    "video_url_backup": "https://…",
    "duration": 16400,                  // 毫秒
    "width": 1080, "height": 1920,
    "create_time": 1792656661,
    "statistics": { "digg": 86306, "comment": 43818, "share": 30916, "collect": 13443, "play": 0 },
    "music": { "title": "…", "author": "…", "url": "" }
  }
}
```

失败返回 `{ "code": 500, "message": "原因", "region": "hkg1" }`（HTTP 仍是 200，方便前端统一处理）。

可选参数：`id=` 直接给作品 ID 跳过短链跳转；`ck=` 回带上一次返回的 cookie。

### `GET /api/media?url={媒体直链}`

媒体中转。带 CORS、支持 Range、域名白名单防 SSRF（仅抖音系域名）。
详见上文「4.5 MB 响应体上限」。

### `POST /api/asr`

音频转文字中转（`multipart/form-data`：`model` + `file`）。
服务端补 `Authorization: Bearer $SILICONFLOW_API_KEY` 转发到硅基流动，结果原样返回。
未配环境变量时返回 `501` + 说明。

### `GET /api/config`

```json
{ "ok": true, "asr": { "serverKey": true, "proxyPath": "/api/asr" } }
```

只告诉前端「服务端有没有 Key」，不下发 Key 本身。

### `GET /api/health` / `GET /api/diag`

健康检查 / 部署自检。

---

## 四、本地验证（部署前先跑一遍）

```bash
# 1. 模拟 Vercel 环境（把 api/*.js 当 Vercel 那样调用）
node dev-vercel.js
# 另开终端：
curl "http://127.0.0.1:3100/api/diag"

# 2. 分片正确性（字节级校验，参数传任意一个大于 3MB 的 mp4 即可）
node test-chunk.mjs D:/某个视频.mp4
```

`test-chunk.mjs` 会临时起一个支持 Range 的源站，把 3 MB 分片拼回来对比 md5，
并断言**每一片都不超过 4.5 MB**——这是本地能提前发现 Vercel 上限问题的地方。

---

## 五、目录

```
douyin-service/
├── api/                # Vercel Functions 入口
│   ├── parse.js        # 解析
│   ├── media.js        # 媒体中转（Range 分片）
│   ├── asr.js          # 音频转文字中转（用环境变量里的 Key）
│   ├── config.js       # 告诉前端服务端是否配了 Key
│   ├── health.js
│   └── diag.js         # 部署自检
├── lib/
│   ├── douyin.js       # 核心逻辑（解析配方、归一化、媒体取流）—— 两种形态共用
│   └── http.js         # 响应工具
├── index.html          # 前端页面（与上一级 douyin-parser.html 内容相同）
├── start.bat           # Windows 一键启动（双击即用）
├── server.js           # 自托管长驻入口
├── dev-vercel.js       # 本地模拟 Vercel
├── test-chunk.mjs      # 分片正确性测试（Vercel 路径：api/media.js）
├── test-server-chunk.mjs  # 分片正确性测试（自托管路径：server.js）
├── vercel.json         # 区域 / 超时 / CORS
└── .vercelignore
```

两个测试脚本的区别：`test-chunk.mjs` 走 `api/media.js`（Vercel 函数入口），
`test-server-chunk.mjs` 走 `server.js`（长驻服务入口）。两者共用 `lib/douyin.js` 的取流逻辑，
但响应写出方式不同，所以分别验证。
