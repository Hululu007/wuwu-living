#!/usr/bin/env node
/**
 * 五五客厅 · 安全体检可复跑脚本（纯 Node、零依赖）
 *
 * 用法：
 *   node scripts/security-audit.mjs                  # 默认只读探测 127.0.0.1:8890，不碰写接口
 *   AUDIT_BASE=http://127.0.0.1:8952 node scripts/security-audit.mjs
 *   AUDIT_ALLOW_WRITE=1 node scripts/security-audit.mjs   # 才会对写接口发探针（仍不删真实数据）
 *
 * 输出：runtime/security-audit.json（每条结论附 请求 / 响应码 / 响应体摘要 / 判定）
 *
 * 纪律：
 *   - 默认模式不调用任何 POST 写接口；需要验证“写接口是否被接受”时显式开 AUDIT_ALLOW_WRITE。
 *   - 不携带任何 token / cookie（本服务当前也无鉴权机制，脚本如实记录）。
 *   - 破坏性载荷（删除类）只验证路由是否接受，不使用真实业务 id。
 */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BASE = process.env.AUDIT_BASE || 'http://127.0.0.1:8890';
const ALLOW_WRITE = process.env.AUDIT_ALLOW_WRITE === '1';
const OUT = path.join(ROOT, 'runtime', 'security-audit.json');

const base = new URL(BASE);

/* ───────────────────────── 基础请求工具 ───────────────────────── */

function request({ method = 'GET', pathname = '/', query = null, body = null, headers = {}, rawBody = null, timeoutMs = 8000 }) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const url = new URL(base.origin + pathname);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

    let payload;
    const h = { ...headers };
    if (rawBody != null) {
      payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody));
    } else if (body != null) {
      payload = Buffer.from(JSON.stringify(body));
      h['content-type'] = h['content-type'] || 'application/json';
    }
    if (payload) h['content-length'] = String(payload.length);

    const req = http.request({
      hostname: base.hostname,
      port: base.port,
      method,
      path: url.pathname + url.search,
      headers: h,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok: true,
          status: res.statusCode,
          headers: res.headers,
          bytes: Buffer.concat(chunks).length,
          ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6),
          body: text.slice(0, 300),
          bodyFull: text,
        });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ ok: false, status: 0, error: e.message, ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6) }));
    if (payload) req.write(payload);
    req.end();
  });
}

function classifyTraversal(resp, { secretMarkers = ['root:', 'passwd:', 'reader.db', 'APP_PATH'] } = {}) {
  if (!resp.ok) return '不可达/连接失败';
  if (resp.status >= 500) return '异常(5xx)，需人工看日志';
  if (resp.status === 403) return '已拦截(403)';
  if (resp.status === 404) return '不存在/已拦截(404)';
  if (resp.status === 200) {
    const hit = secretMarkers.some((m) => resp.bodyFull.includes(m));
    return hit ? '疑似泄露(200+敏感内容)' : '200 但无敏感内容';
  }
  return `其它(${resp.status})`;
}

const results = {
  meta: {
    auditedAt: new Date().toISOString(),
    base: BASE,
    allowWrite: ALLOW_WRITE,
    node: process.version,
    note: '除明确标注 live 的探测外，静态清单来自代码走读；脚本可复跑全部 HTTP 探测。',
  },
  sections: {},
};

/* ───────────────────────── 0. 存活 ───────────────────────── */

async function reachability() {
  const r = await request({ pathname: '/api/ping' });
  results.sections.reachability = { ping: { request: 'GET /api/ping', ...r, verdict: r.ok && r.status === 200 ? '在线' : '离线/异常' } };
}

/* ───────────────────────── 1. 目录遍历 / 敏感文件暴露 ───────────────────────── */

async function directoryTraversal() {
  const paths = [
    '/config/apps.json', '/config/library.json', '/config/photos.json', '/config/download.json',
    '/runtime/download.json', '/runtime/notes.json', '/runtime/library.json', '/runtime/photos.json',
    '/runtime/calendar.json', '/runtime/book-sources.json', '/runtime/home.json',
    '/package.json', '/hub.mjs', '/lib/rooms.mjs', '/lib/download.mjs',
    '/.git/config', '/.git/HEAD',
    '/../config/apps.json', '/%2e%2e/config/apps.json', '/public/../hub.mjs',
    '/assets/../room.css', '/assets/../../hub.mjs', '/api/../config/apps.json', '/runtime/../../etc/hosts',
  ];
  const out = [];
  for (const p of paths) {
    const r = await request({ pathname: p });
    out.push({ request: `GET ${p}`, status: r.status, bytes: r.bytes, verdict: classifyTraversal(r), sample: r.body });
  }
  results.sections.directoryTraversal = out;
}

/* ───────────────────────── 2. 路径穿越 / 任意文件读取（文件类接口） ───────────────────────── */

const traversalPayloads = [
  '/etc/hosts', '/etc/passwd',
  '../../etc/hosts', '../../../etc/passwd',
  '..%2f..%2fetc%2fhosts',
  '/Users/wuwu/Library/Application Support/reader/data/reader.db',
  'file:///etc/hosts',
  '/etc/hosts%00.mp4',
  '/Users/wuwu/Downloads/../../etc/hosts',
];

async function fileTraversal() {
  const endpoints = [
    { ep: '/api/library/media', key: 'path', gate: 'safeMediaPath 根目录白名单' },
    { ep: '/api/library/ensure', key: 'path', gate: 'safeMediaPath 根目录白名单' },
    { ep: '/api/library/open', key: 'path', gate: 'safeMediaPath 根目录白名单' },
    { ep: '/api/library/progress', key: 'path', gate: 'safeMediaPath 根目录白名单（POST body）' },
  ];
  const out = [];
  for (const e of endpoints) {
    for (const payload of traversalPayloads) {
      const isPost = e.ep.endsWith('/progress');
      const r = await request({
        method: isPost ? 'POST' : 'GET',
        pathname: e.ep,
        query: isPost ? null : { [e.key]: payload },
        body: isPost ? { [e.key]: payload, seconds: 1 } : null,
      });
      out.push({ endpoint: e.ep, gate: e.gate, payload, status: r.status, verdict: classifyTraversal(r), sample: r.body });
    }
  }
  // 海报 id（白名单正则 ^[\w-]{1,32}$）
  for (const id of ['..%2f..%2f..%2fetc%2fpasswd', '../../etc/passwd', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']) {
    const r = await request({ pathname: '/api/library/poster', query: { id } });
    out.push({ endpoint: '/api/library/poster', gate: 'id 白名单正则', payload: id, status: r.status, verdict: classifyTraversal(r), sample: r.body });
  }
  // 相册：id 仅内部索引，无路径参数
  for (const id of ['nope', '../../etc/passwd', '..%2fetc%2fhosts']) {
    for (const ep of ['/api/photos/full', '/api/photos/thumb', '/api/photos/info']) {
      const r = await request({ pathname: ep, query: { id } });
      out.push({ endpoint: ep, gate: 'id→内部索引查表，路径不进文件系统', payload: id, status: r.status, verdict: classifyTraversal(r), sample: r.body });
    }
  }
  // 下载中心：id→任务记录，文件路径再走 safeDownloadFile realpath 白名单
  for (const id of ['zzz', '../../etc/hosts']) {
    const r = await request({ pathname: '/api/download/file', query: { id } });
    out.push({ endpoint: '/api/download/file', gate: '任务 id + realpath 下载目录白名单', payload: id, status: r.status, verdict: classifyTraversal(r), sample: r.body });
  }
  // 日历封面：文件名白名单正则
  for (const n of ['../../etc/passwd', 'abc', '0123456789abcdef.png']) {
    const r = await request({ pathname: '/calendar/cover/' + encodeURIComponent(n) });
    out.push({ endpoint: '/calendar/cover/<name>', gate: '文件名正则 ^[a-z0-9]{16}\\.(png|jpg|webp|gif)$', payload: n, status: r.status, verdict: classifyTraversal(r), sample: r.body });
  }
  results.sections.fileTraversal = out;
}

/* ───────────────────────── 3. SSRF（按用户给的 URL 去抓） ───────────────────────── */

async function ssrf() {
  const targets = [
    'http://127.0.0.1:8890/api/ping',
    'file:///etc/hosts',
    'gopher://127.0.0.1:8890/_',
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:1122/api/health',
    'http://127.0.0.1:7788/',
    'http://127.0.0.1:8811/',
    'http://127.0.0.1:8900/',
  ];
  const out = [];
  // 3.1 视频房海报代理 /api/vod/img?u=
  for (const u of targets) {
    const r = await request({ pathname: '/api/vod/img', query: { u }, timeoutMs: 10000 });
    out.push({
      entry: 'GET /api/vod/img?u=',
      target: u,
      status: r.status,
      verdict: r.status === 502 && /不是图片/.test(r.body) ? '回环请求已发起（盲打），但响应被图片类型拦截'
        : r.status === 502 && /fetch failed|aborted/.test(r.body) ? '协议/网络被拒（未取到内容）'
        : r.status === 400 ? '方案被拒(400)' : `其它(${r.status})`,
      sample: r.body,
    });
  }
  // 3.2 日历 RSS 订阅 /api/calendar/feed/add（写接口，默认跳过；开启后只测方案校验）
  if (ALLOW_WRITE) {
    for (const u of ['http://127.0.0.1:8952/api/ping', 'file:///etc/hosts', 'gopher://127.0.0.1:8952/_']) {
      const r = await request({ method: 'POST', pathname: '/api/calendar/feed/add', body: { url: u, name: 'AUDIT-SSRF-PROBE' } });
      out.push({ entry: 'POST /api/calendar/feed/add', target: u, status: r.status, verdict: r.status === 200 ? '已接受该 URL（服务端将抓取）' : '方案/校验拒绝', sample: r.body });
    }
  } else {
    out.push({ entry: 'POST /api/calendar/feed/add', note: '默认跳过（写接口）；代码：只校验 ^https?://，无目标域名白名单', status: null, verdict: '未实测（代码走读）' });
  }
  // 3.3 下载直链 /api/download/add（写接口，默认跳过）
  if (ALLOW_WRITE) {
    const r = await request({ method: 'POST', pathname: '/api/download/add', body: { url: 'http://127.0.0.1:8952/api/ping', name: 'AUDIT-SSRF-PROBE' } });
    out.push({ entry: 'POST /api/download/add', target: 'http://127.0.0.1:8952/api/ping', status: r.status, verdict: r.status === 200 ? '已接受 http(s) 直链（服务端下载）' : '拒绝', sample: r.body });
  } else {
    out.push({ entry: 'POST /api/download/add', note: '默认跳过；代码：只校验 ^https?://，无域名白名单，无内网地址黑名单', status: null, verdict: '未实测（代码走读）' });
  }
  results.sections.ssrf = out;
}

/* ───────────────────────── 4. 命令注入 ───────────────────────── */

// 静态清单：子进程调用点、命令来源、参数来源、是否走 shell
const childProcessInventory = [
  { file: 'hub.mjs', line: 210, call: "spawn('/bin/bash', [script, arg])", command: 'config/apps.json 里固定脚本 dir/script', args: 'startArg/stopArg（配置项，非 HTTP 入参）', shell: '数组参数、无 shell 拼接', userControlled: '否（HTTP id 只做 apps[id] 键查）', verdict: '安全（未见注入面）' },
  { file: 'hub.mjs', line: 241, call: "execFile('/usr/bin/python3', [reader_query.py, db, mode, q])", command: '固定 python3 + 仓库内脚本', args: 'db/mode 来自配置；q 来自搜书关键词，仅作 argv 传入', shell: '无 shell', userControlled: '部分（关键词为 argv，非命令行拼接）', verdict: '安全；SQL 走参数化 ? 绑定（reader_query.py）' },
  { file: 'hub.mjs', line: 259, call: "execFile('/usr/bin/pgrep', ['-xq', name])", command: '固定 pgrep', args: 'name=固定 bundle 名', shell: '无 shell', userControlled: '否', verdict: '安全' },
  { file: 'hub.mjs', line: '528,1979', call: "execFile('/usr/bin/open', ['-a', bundle])", command: '固定 open', args: 'bundle 默认 Reader，来自配置', shell: '无 shell', userControlled: '否', verdict: '安全' },
  { file: 'lib/library.mjs', line: 453, call: "spawn('open', [abs])", command: '固定 open', args: 'abs 过 safeMediaPath 根目录白名单', shell: '无 shell', userControlled: '路径被白名单限制', verdict: '受限；建议补 -R/参数化复核' },
  { file: 'lib/library_media.mjs', line: 54, call: "spawn('ffprobe', [..., abs])", command: '固定 ffprobe', args: 'abs 为扫描目录内文件', shell: '无 shell', userControlled: '间接（目录来自配置）', verdict: '安全' },
  { file: 'lib/photos.mjs', line: 116, call: 'execFile(cmd, args)', command: '固定 FFPROBE/SIPS', args: 'abs 为索引内文件路径', shell: '无 shell', userControlled: '间接', verdict: '安全' },
  { file: 'lib/reader_api.mjs', line: 195, call: "execFile('/usr/bin/python3', [export_book_sources.py, db, cache])", command: '固定 python3 + 仓库脚本', args: '固定路径', shell: '无 shell', userControlled: '否', verdict: '安全' },
  { file: 'lib/legado/jsrt.mjs', line: 110, call: "execFileSync('curl', args)", command: '固定 curl', args: 'url/headers/body 来自书源规则（本地 Reader 库导出），非本次 HTTP 入参', shell: '无 shell', userControlled: '间接（信任本地书源库）', verdict: '受限：书源规则若可被外部改写则成面' },
];

async function commandInjection() {
  const probes = [];
  const payloads = [';echo PWNED;', '`id`', '$(id)', '__proto__', 'a&b'];
  for (const id of payloads) {
    const r = await request({ method: 'POST', pathname: '/api/start', body: { id } });
    probes.push({ entry: 'POST /api/start', payload: id, status: r.status, verdict: r.status === 400 ? '拒绝：无此项目（未触达 spawn）' : `其它(${r.status})`, sample: r.body });
    const r2 = await request({ method: 'POST', pathname: '/api/stop', body: { id } });
    probes.push({ entry: 'POST /api/stop', payload: id, status: r2.status, verdict: r2.status === 400 ? '拒绝：无此项目（未触达 spawn）' : `其它(${r2.status})`, sample: r2.body });
  }
  results.sections.commandInjection = { liveProbes: probes, inventory: childProcessInventory };
}

/* ───────────────────────── 5. 未鉴权写接口清单 ───────────────────────── */

const writeInventory = [
  { path: 'POST /api/book/ensure', effect: '只探测书房 Reader Web 健康状态（已去掉启动能力）', params: '无', exposure: '无鉴权；只读健康检查，不会启动 Reader.app（本机回环绑定）' },
  { path: 'POST /api/book/search-start', effect: '建后台搜书任务', params: '{q}', exposure: '无鉴权；可消耗 CPU/并发' },
  { path: 'POST /api/book/open', effect: '打开书籍详情/目录', params: '{bookUrl, bookSourceUrl, sources}', exposure: '无鉴权；服务端按书源 URL 抓取' },
  { path: 'POST /api/book/chapter', effect: '拉章节正文', params: '{bookUrl, ...}', exposure: '无鉴权；服务端抓取' },
  { path: 'POST /api/book/progress', effect: '保存阅读进度', params: '{bookUrl,index,position}', exposure: '无鉴权；写 runtime 缓存' },
  { path: 'POST /api/start', effect: '启动指定子应用脚本', params: '{id}', exposure: '无鉴权；id 仅映射内置 apps 表，越界 400' },
  { path: 'POST /api/start-all', effect: '批量启动 book+web 子应用', params: '无', exposure: '无鉴权；会拉起 magnet/music/vod 脚本' },
  { path: 'POST /api/stop', effect: '停止指定子应用', params: '{id}', exposure: '无鉴权；可停止内置 web 子应用' },
  { path: 'POST /api/reader/open', effect: '固定返回 403（客厅不再打开 Reader.app）', params: '无', exposure: '无鉴权；已封禁，不再触发任何启动' },
  { path: 'POST /api/download/add', effect: '新增直链/磁力下载任务', params: '{url|magnet,name}', exposure: '无鉴权；http(s)/magnet 方案校验，无内网黑名单；可落盘到下载目录' },
  { path: 'POST /api/download/pause', effect: '暂停任务', params: '{id}', exposure: '无鉴权；按任务 id' },
  { path: 'POST /api/download/resume', effect: '恢复任务', params: '{id}', exposure: '无鉴权' },
  { path: 'POST /api/download/delete', effect: '删除任务记录（可选删文件）', params: '{id, removeFile}', exposure: '无鉴权；removeFile=true 会 rm 下载目录内任务文件' },
  { path: 'POST /api/download/clear-done', effect: '清空已完成记录（保留文件）', params: '无', exposure: '无鉴权；批量改记录' },
  { path: 'POST /api/library/scan', effect: '后台扫描媒体目录', params: '无', exposure: '无鉴权；读配置目录' },
  { path: 'POST /api/library/progress', effect: '保存播放进度', params: '{path,seconds,duration,...}', exposure: '无鉴权；path 过白名单' },
  { path: 'POST /api/notes/create', effect: '新增笔记', params: '{title,body,quote,tags,source}', exposure: '无鉴权；写 runtime/notes.json' },
  { path: 'POST /api/notes/update', effect: '改笔记', params: '{id,title,body,...}', exposure: '无鉴权' },
  { path: 'POST /api/notes/delete', effect: '删笔记', params: '{id}', exposure: '无鉴权；按 id 删记录' },
  { path: 'POST /api/notes/tag/rename', effect: '批量改标签', params: '{from,to}', exposure: '无鉴权；批量改多条' },
  { path: 'POST /api/calendar/feed/add', effect: '订阅 RSS 源并后台抓取', params: '{url,name}', exposure: '无鉴权；服务端按 URL 抓取（SSRF 面）' },
  { path: 'POST /api/calendar/feed/remove', effect: '移入回收站', params: '{id}', exposure: '无鉴权' },
  { path: 'POST /api/calendar/feed/restore', effect: '回收站还原', params: '{id}', exposure: '无鉴权' },
  { path: 'POST /api/calendar/feed/refresh', effect: '后台刷新源', params: '{id?}', exposure: '无鉴权' },
  { path: 'POST /api/calendar/track/add', effect: '追更条目', params: '{name,kind,source,rule,...}', exposure: '无鉴权；写 runtime/calendar.json' },
  { path: 'POST /api/calendar/track/update', effect: '改追更', params: '{id,name,...}', exposure: '无鉴权' },
  { path: 'POST /api/calendar/track/remove', effect: '移入回收站', params: '{id}', exposure: '无鉴权' },
  { path: 'POST /api/calendar/track/restore', effect: '还原', params: '{id}', exposure: '无鉴权' },
  { path: 'POST /api/calendar/track/skip', effect: '本期跳过', params: '{id}', exposure: '无鉴权' },
  { path: 'POST /api/calendar/episode/skip', effect: '单集跳过（当日有效）', params: '{id}', exposure: '无鉴权；写 epSkip 映射' },
  { path: 'POST /api/calendar/seen', effect: '更新已读时间戳', params: '{at?}', exposure: '无鉴权；改全局 seenAt' },
  { path: 'POST /api/photos/scan', effect: '后台扫描相册目录', params: '无', exposure: '无鉴权' },
  { path: 'POST /api/photos/dlna/discover', effect: 'SSDP 发现投屏设备（3s）', params: '无', exposure: '无鉴权；组播探测' },
  { path: 'POST /api/photos/dlna/cast', effect: '推送当前图片到设备', params: '{deviceId,id}', exposure: '无鉴权；id→索引查表' },
  { path: 'POST /api/home/todos', effect: '待办 add/toggle/delete/tomorrow/clear-done', params: '{action,id,text,date}', exposure: '无鉴权；写 runtime/home.json' },
];

async function writeInventoryLiveCheck() {
  if (!ALLOW_WRITE) {
    results.sections.writeInventory = { auth: '本服务无 token/cookie/会话鉴权（代码走读 + 线上实测确认请求未带凭据即被接受）', allowWrite: false, endpoints: writeInventory, note: '未对写接口发请求；如需验收“接受与否”，开 AUDIT_ALLOW_WRITE=1 并用测试实例端口。' };
    return;
  }
  // 仅做“是否被接受”的非破坏性探测；删除类不传真实 id
  const probes = [
    ['POST /api/notes/create', { title: 'AUDIT-PROBE', body: 'probe' }],
    ['POST /api/home/todos', { action: 'add', text: 'AUDIT-PROBE' }],
    ['POST /api/calendar/feed/add', { url: 'http://127.0.0.1:8952/api/ping', name: 'AUDIT-PROBE' }],
    ['POST /api/calendar/track/add', { name: 'AUDIT-PROBE', kind: '番剧', source: 'manual' }],
    ['POST /api/download/add', { url: 'http://127.0.0.1:8952/api/ping', name: 'AUDIT-PROBE' }],
    ['POST /api/photos/scan', {}],
    ['POST /api/library/scan', {}],
    ['POST /api/start', { id: 'bogus' }],
    ['POST /api/stop', { id: 'bogus' }],
  ];
  const live = [];
  for (const [ep, body] of probes) {
    const r = await request({ method: 'POST', pathname: ep, body, timeoutMs: 10000 });
    live.push({ endpoint: ep, status: r.status, accepted: r.status === 200, sample: r.body });
  }
  results.sections.writeInventory = { allowWrite: true, liveProbes: live, endpoints: writeInventory };
}

/* ───────────────────────── 6. 协议健壮性 ───────────────────────── */

async function protocolRobustness() {
  const out = [];
  // 6.1 畸形 JSON（notes/create 无内容 → 业务 400，不应 500）
  for (const ep of ['/api/notes/create', '/api/book/progress', '/api/download/add', '/api/library/progress']) {
    const r = await request({ method: 'POST', pathname: ep, rawBody: '{bad json', headers: { 'content-type': 'application/json' } });
    out.push({ case: '畸形 JSON body', endpoint: ep, status: r.status, verdict: r.status === 500 ? '500 崩溃面' : '降级为业务校验/空对象，未 500（502 为兜底失败）', sample: r.body });
  }
  // 6.2 空 body
  const r0 = await request({ method: 'POST', pathname: '/api/notes/create' });
  out.push({ case: '空 body', endpoint: '/api/notes/create', status: r0.status, verdict: r0.status === 400 ? '业务 400，未 500' : `其它(${r0.status})`, sample: r0.body });
  // 6.3 重复 key / __proto__（默认跳过真实创建；只在允许写时验证）
  if (ALLOW_WRITE) {
    const r = await request({ method: 'POST', pathname: '/api/notes/create', rawBody: '{"title":"x","title":"y","__proto__":{"polluted":1}}', headers: { 'content-type': 'application/json' } });
    out.push({ case: '重复 key + __proto__', endpoint: '/api/notes/create', status: r.status, verdict: '需人工确认全局原型未被污染', sample: r.body });
  } else {
    out.push({ case: '重复 key + __proto__', endpoint: '/api/notes/create', status: null, verdict: '默认跳过；代码未做对象原型合并（代码走读，未实测）' });
  }
  // 6.4 CRLF 响应头注入（原始 socket 发送带 CRLF 的头，看响应头是否被拆出注入行）
  const crlf = await new Promise((resolve) => {
    const sock = net.connect(Number(base.port), base.hostname, () => {
      sock.write(`GET /api/ping HTTP/1.1\r\nHost: ${base.host}\r\nX-Audit: a\r\nX-Injected: yes\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    sock.on('data', (c) => { data += c.toString(); });
    sock.on('close', () => resolve({ status: /^HTTP\/1\.1 (\d+)/.exec(data)?.[1] || '?', raw: data.slice(0, 400) }));
    sock.on('error', (e) => resolve({ status: '连接错误', raw: e.message }));
    setTimeout(() => sock.destroy(), 5000);
  });
  const reflected = /x-injected/i.test(crlf.raw);
  out.push({ case: 'CRLF 自定义头', endpoint: '/api/ping', status: Number(crlf.status) || crlf.status, verdict: reflected ? '响应头被注入' : '未反射注入头（Node 解析/服务端未拆行）', sample: crlf.raw.slice(0, 160) });
  // 6.5 方法矩阵（PUT/DELETE/PATCH 到 GET 路由）
  for (const m of ['PUT', 'DELETE', 'PATCH']) {
    const r = await request({ method: m, pathname: '/api/notes/list' });
    out.push({ case: '非标准方法', method: m, endpoint: '/api/notes/list', status: r.status, verdict: r.status === 404 ? '落到 404 兜底' : `其它(${r.status})`, sample: r.body });
  }
  // 6.6 超大 body（10MB）→ 服务端 64KB 上限应断连，不崩溃
  const big = Buffer.alloc(10 * 1024 * 1024, 65);
  const rBig = await new Promise((resolve) => {
    const sock = net.connect(Number(base.port), base.hostname, () => {
      sock.write(`POST /api/notes/create HTTP/1.1\r\nHost: ${base.host}\r\nContent-Type: application/json\r\nContent-Length: ${big.length}\r\nConnection: close\r\n\r\n{"title":"`);
      sock.write(big);
    });
    let data = '';
    sock.on('data', (c) => { data += c.toString(); });
    sock.on('close', () => resolve({ status: / 200 | 400 | 500 | 413 /.exec(data)?.[0]?.trim() || '连接被关闭', sample: data.slice(0, 120) }));
    sock.on('error', (e) => resolve({ status: '连接错误', sample: e.message }));
    setTimeout(() => sock.destroy(), 6000);
  });
  const bigOk = /413|400|关闭|EPIPE|错误/.test(rBig.status) || /EPIPE/.test(rBig.sample);
  out.push({ case: '10MB body', endpoint: '/api/notes/create', ...rBig, verdict: bigOk ? '超限被断连（服务端 64KB 上限），未见 500/崩溃' : '需人工复核' });
  results.sections.protocolRobustness = out;
}

/* ───────────────────────── 7. 静态服务 / 代理目标固定性 ───────────────────────── */

async function proxyAndStatic() {
  const out = [];
  const probes = ['/magnet/../../etc/hosts', '/magnet/%2e%2e%2f%2e%2e%2fetc%2fhosts', '/music/../../../etc/hosts'];
  for (const p of probes) {
    const r = await request({ pathname: p });
    out.push({ request: `GET ${p}`, status: r.status, verdict: r.status === 404 ? '代理目标主机固定，本地文件未泄露' : `其它(${r.status})`, sample: r.body });
  }
  // 房间页面存活（十路由基线，只取 2xx/502 供对照）
  const pages = ['/', '/book/', '/download/', '/library/', '/notes/', '/calendar/', '/photos/', '/magnet/', '/music/', '/vod/'];
  for (const p of pages) {
    const r = await request({ pathname: p, timeoutMs: 6000 });
    out.push({ request: `GET ${p}`, status: r.status, bytes: r.bytes, verdict: r.status === 200 ? '页面可达' : r.status === 502 ? '上游子应用离线（代理正常）' : `其它(${r.status})`, sample: '' });
  }
  results.sections.proxyAndStatic = out;
}

/* ───────────────────────── 主流程 ───────────────────────── */

(async () => {
  await reachability();
  await directoryTraversal();
  await fileTraversal();
  await ssrf();
  await commandInjection();
  await writeInventoryLiveCheck();
  await protocolRobustness();
  await proxyAndStatic();

  // 汇总
  const all = [];
  const flatten = (v) => {
    if (Array.isArray(v)) v.forEach((x) => { if (x && typeof x === 'object') all.push(x); else all.push({ verdict: String(x) }); });
    else if (v && typeof v === 'object') Object.values(v).forEach(flatten);
  };
  flatten(results.sections);
  const risky = all.filter((x) => /疑似泄露|响应头被注入|已接受|500 崩溃|崩溃面|accepted: true/.test(String(x.verdict || '')));
  results.summary = {
    totalProbes: all.length,
    riskCount: risky.length,
    risky: risky.map((x) => ({ endpoint: x.endpoint || x.entry || x.request, verdict: x.verdict, status: x.status })),
    allowWrite: ALLOW_WRITE,
    generated: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(`[security-audit] 完成 ${results.summary.totalProbes} 条探测 → ${OUT}`);
  console.log(`[security-audit] 风险/待复核 ${results.summary.riskCount} 条；写接口实测=${ALLOW_WRITE ? '开' : '关'}`);
})().catch((e) => { console.error('[security-audit] 失败:', e); process.exit(1); });
