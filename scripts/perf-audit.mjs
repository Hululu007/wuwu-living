#!/usr/bin/env node
/**
 * 五五客厅 · 性能体检脚本（纯 Node、零新依赖，只读探测，不改任何产品代码）。
 *
 * 口径与 scripts/final-check.mjs 对齐：本地 fetch 计时（TTFB/总耗时）、字节数、
 * 服务端响应头；前端静态解析 public/*.html 与 lib/*.mjs 得出懒加载/接口/分页/热点行号。
 *
 * 用法：
 *   node scripts/perf-audit.mjs --base http://127.0.0.1:8950 \
 *       --upstream-music http://127.0.0.1:8811 \
 *       --out runtime/perf-audit.json [--samples 30]
 *
 * 只读约束：不重启/stop/kill 任何实例；线上 8890 请勿作为 --base。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argOf = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const BASE = argOf('--base', 'http://127.0.0.1:8950').replace(/\/+$/, '');
const MUSIC_UP = argOf('--upstream-music', 'http://127.0.0.1:8811').replace(/\/+$/, '');
const OUT = argOf('--out', 'runtime/perf-audit.json');
const N = Math.max(10, Number(argOf('--samples', '30')) || 30);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
const pct = (a, f) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : 0; };
const fmt = (x) => Number(x.toFixed(2));

/* ───────────────────────── 1. 首屏页面度量 ───────────────────────── */

const PAGES = [
  { p: '/', file: '五五客厅.html' },
  { p: '/book/', file: '书房.html' },
  { p: '/library/', file: '媒体库.html' },
  { p: '/music/', file: '待反代（无本地 HTML 文件）' },
];

function parseHtml(html) {
  const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)];
  const links = [...html.matchAll(/<link\b([^>]*)>/gi)];
  let blocking = 0, ext = 0, inline = 0;
  for (const m of scripts) {
    const a = m[1] || '';
    if (/\bsrc\s*=/i.test(a)) ext++; else inline++;
    if (!/\b(async|defer)\b/i.test(a)) blocking++;
  }
  return {
    scriptTotal: scripts.length,
    scriptExt: ext,
    scriptInline: inline,
    scriptBlocking: blocking,
    linkTotal: links.length,
    cssLink: links.filter((m) => /stylesheet/i.test(m[1] || '')).length,
  };
}

async function fetchProbe(url) {
  const t0 = process.hrtime.bigint();
  const r = await fetch(url, { redirect: 'follow' });
  const ttfb = ms(t0);
  const body = await r.arrayBuffer();
  const total = ms(t0);
  const h = Object.fromEntries(r.headers);
  return {
    status: r.status,
    bytes: body.byteLength,
    ttfbMs: fmt(ttfb),
    totalMs: fmt(total),
    cacheControl: h['cache-control'] || null,
    etag: h['etag'] || null,
    lastModified: h['last-modified'] || null,
    contentType: h['content-type'] || null,
    ...parseHtml(new TextDecoder().decode(body)),
  };
}

async function section1() {
  const out = [];
  for (const page of PAGES) {
    // 冷：首次；热：紧随第二次；热2：第三次（看服务端/上游是否命中进程内缓存，浏览器缓存由 no-store 头决定）
    const cold = await fetchProbe(BASE + page.p);
    await sleep(120);
    const warm = await fetchProbe(BASE + page.p);
    await sleep(120);
    const warm2 = await fetchProbe(BASE + page.p);
    out.push({ path: page.p, sourceFile: page.file, cold, warm, warm2, note: 'cache-control 为 no-store/no-cache 时浏览器不缓存；热命中只反映进程内缓存壳' });
  }
  return out;
}

/* ───────────────────────── 2. /music/ 缓存与耗时 ───────────────────────── */

async function sampleUrl(url, n) {
  const arr = [];
  let headers = {}, bytes = 0;
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint();
    const r = await fetch(url, { redirect: 'follow' });
    const ttfb = ms(t0);
    const body = await r.arrayBuffer();
    bytes = body.byteLength;
    if (i === 0) headers = Object.fromEntries(r.headers);
    arr.push({ ttfb: fmt(ttfb), total: fmt(ms(t0)) });
    await sleep(25);
  }
  return {
    url, n, bytes,
    headers: {
      'cache-control': headers['cache-control'] || null,
      etag: headers['etag'] || null,
      'last-modified': headers['last-modified'] || null,
      'content-type': headers['content-type'] || null,
    },
    ttfb: { p50: fmt(pct(arr.map((x) => x.ttfb), 0.5)), p95: fmt(pct(arr.map((x) => x.ttfb), 0.95)), max: fmt(Math.max(...arr.map((x) => x.ttfb))) },
    total: { p50: fmt(pct(arr.map((x) => x.total), 0.5)), p95: fmt(pct(arr.map((x) => x.total), 0.95)), max: fmt(Math.max(...arr.map((x) => x.total))) },
  };
}

async function section2() {
  const upstream = await sampleUrl(MUSIC_UP + '/', N);
  const proxy = await sampleUrl(BASE + '/music/', N);

  // 轻路由（无 body）对照：304 分支理论耗时下界，参照 /api/ping
  const ping = [];
  for (let i = 0; i < N; i++) {
    const t0 = process.hrtime.bigint();
    const r = await fetch(BASE + '/api/ping');
    await r.arrayBuffer();
    ping.push(ms(t0));
    await sleep(15);
  }

  // 代理内存缓存命中窗口（staticPageCache，TTL 5s）：TTL 内连发
  await sleep(5600); // 等上一轮把缓存熬过期
  const hit = [];
  for (let i = 0; i < 10; i++) {
    const t0 = process.hrtime.bigint();
    const r = await fetch(BASE + '/music/');
    await r.arrayBuffer();
    hit.push(fmt(ms(t0)));
    await sleep(120);
  }

  // 代理 miss：每发都等 TTL 过期，测「回上游 + 全量重写」真实耗时（样本少，间隔长）
  const miss = [];
  for (let i = 0; i < 5; i++) {
    await sleep(5600);
    const t0 = process.hrtime.bigint();
    const r = await fetch(BASE + '/music/');
    await r.arrayBuffer();
    miss.push(fmt(ms(t0)));
  }

  return {
    upstream,
    proxy,
    rewrite: {
      upstreamBytes: upstream.bytes,
      proxyBytes: proxy.bytes,
      deltaBytes: proxy.bytes - upstream.bytes,
      deltaPct: upstream.bytes ? fmt(((proxy.bytes - upstream.bytes) / upstream.bytes) * 100) : null,
    },
    proxyInMemoryCache: { window: 'staticPageCache TTL 5000ms (hub.mjs L74)', hitTimesMs: hit, hitP50: fmt(pct(hit, 0.5)) },
    proxyMiss: { samples: miss, p50: fmt(pct(miss, 0.5)), min: fmt(Math.min(...miss)), max: fmt(Math.max(...miss)), note: '每发前等 5.6s 让 5s 壳过期；含上游重生成 + 代理重写 103KB' },
    lightweightRouteBaseline: { path: '/api/ping', n: N, p50: fmt(pct(ping, 0.5)), max: fmt(Math.max(...ping)), note: '无响应体的本地路由，作为条件请求 304 分支的耗时参照' },
    estimate: {
      currentProxyMissMedianMs: fmt(pct(miss, 0.5)),
      conditional304ExpectedMs: `介于轻路由 p50 ${fmt(pct(ping, 0.5))}ms 与内存命中 ${fmt(pct(hit, 0.5))}ms 之间；304 无 body，不再重写 103KB`,
      savedBodyBytesPerRepeat: proxy.bytes,
    },
  };
}

/* ───────────────────────── 3. 图片懒加载静态盘点 ───────────────────────── */

function section3() {
  const dir = path.join(ROOT, 'public');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.html')).sort();
  let grand = { total: 0, lazy: 0, async: 0, size: 0 };
  const perPage = files.map((file) => {
    const html = fs.readFileSync(path.join(dir, file), 'utf8');
    const tags = [...html.matchAll(/<img\b([^>]*)>/gi)].map((m) => m[1] || '');
    const rows = tags.map((a) => ({
      lazy: /\bloading\s*=\s*["']lazy["']/i.test(a),
      decodingAsync: /\bdecoding\s*=\s*["']async["']/i.test(a),
      hasSize: /\b(width|height)\s*=/i.test(a),
      src: ((/src\s*=\s*["']([^"']{0,48})/i.exec(a)) || [])[1] || '',
    }));
    const r = {
      file, total: tags.length,
      lazy: rows.filter((x) => x.lazy).length,
      decodingAsync: rows.filter((x) => x.decodingAsync).length,
      sizeDeclared: rows.filter((x) => x.hasSize).length,
      rows,
    };
    grand.total += r.total; grand.lazy += r.lazy; grand.async += r.decodingAsync; grand.size += r.sizeDeclared;
    return r;
  });
  return {
    perPage,
    grand,
    notes: [
      '全部 <img> 均出现在 JS 模板字符串里（运行时动态插入），无静态首屏 <img>。',
      '封面容器多带 aspect-ratio（媒体库 2/3、日历 3/4），img 填满容器，CLS 由容器兜底；但 img 自身无 width/height 属性、无 decoding="async"。',
    ],
  };
}

/* ───────────────────────── 4. 进页接口 / N+1 / 分页 ───────────────────────── */

const PAGE_ROUTES = [
  { route: '/', file: '五五客厅.html', apiPrefix: '/api/home' },
  { route: '/book/', file: '书房.html', apiPrefix: '/api/book' },
  { route: '/library/', file: '媒体库.html', apiPrefix: '/api/library' },
  { route: '/photos/', file: '相册.html', apiPrefix: '/api/photos' },
  { route: '/notes/', file: '笔记库.html', apiPrefix: '/api/notes' },
  { route: '/calendar/', file: '追更日历.html', apiPrefix: '/api/calendar' },
  { route: '/download/', file: '下载中心.html', apiPrefix: '/api/download' },
];

// 进页即发接口（人工核对源码调用链后固化；静态提取见 rawCalls 作佐证）。
const BOOT_TRUTH = [
  { route: '/', file: '五五客厅.html', calls: [{ method: 'GET', path: '/api/home/summary', note: 'refresh() 进页即调，8s 轮询；todos 数据由 summary 下发' }] },
  { route: '/book/', file: '书房.html', calls: [
    { method: 'GET', path: '/api/book/info', note: 'build→loadInfo' },
    { method: 'POST', path: '/api/book/ensure', note: '只读 readerHealth，不启动 Reader' },
    { method: 'GET', path: '/api/book/shelf', note: 'loadShelf，委托 Reader 1122 /reader3/getBookshelf' },
  ] },
  { route: '/library/', file: '媒体库.html', calls: [{ method: 'GET', path: '/api/library/list', note: 'load() 进页；30s 周期刷新；scan-status 仅扫描中轮询' }] },
  { route: '/photos/', file: '相册.html', calls: [
    { method: 'GET', path: '/api/photos/lan', note: 'loadLan() 进页' },
    { method: 'GET', path: '/api/photos/list?offset=0&limit=60', note: 'loadMore() 进页首屏，之后滚动分页' },
    { method: 'GET', path: '/api/photos/scan-status', note: 'pollStatus() 进页；15s setInterval 轮询' },
  ] },
  { route: '/notes/', file: '笔记库.html', calls: [
    { method: 'GET', path: '/api/notes/list?limit=200', note: 'load() 进页；30s 无筛选时刷新' },
    { method: 'GET', path: '/api/notes/stats', note: 'load() 同发' },
  ] },
  { route: '/calendar/', file: '追更日历.html', calls: [{ method: 'GET', path: '/api/calendar/overview', note: 'load() 进页；30s 刷新；1s tick 为本地倒计时不发请求' }] },
  { route: '/download/', file: '下载中心.html', calls: [{ method: 'GET', path: '/api/download/list', note: 'load() 进页；2.5s 轮询' }] },
];

function extractApiCalls(html, apiPrefix) {
  const lines = html.split('\n');
  const calls = [];
  let currentFn = '(顶层)';
  const varPath = {}; // 函数内 var u = '/api/...'
  lines.forEach((line, i) => {
    const fnDecl = /function\s+([A-Za-z0-9_$]+)\s*\(/.exec(line);
    if (fnDecl) currentFn = fnDecl[1];
    const v = /var\s+(\w+)\s*=\s*['"](\/api\/[^'"]+)['"]/.exec(line);
    if (v) varPath[v[1]] = v[2];
    // 直接字符串调用
    const re = /(?:fetch|apiGet|apiPost|api)\s*\(\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      let path = m[1];
      if (!path.startsWith('/api/')) path = apiPrefix + path;
      const method = /apiPost/.test(m[0]) ? 'POST' : 'GET';
      calls.push({ line: i + 1, method, path, enclosingFn: currentFn });
    }
    // 变量调用 fetch(u)
    const vu = /fetch\(\s*(\w+)\s*\)/.exec(line);
    if (vu && varPath[vu[1]]) calls.push({ line: i + 1, method: 'GET', path: varPath[vu[1]], enclosingFn: currentFn });
  });
  return calls;
}

function section4Static() {
  const truthByRoute = new Map(BOOT_TRUTH.map((x) => [x.route, x]));
  const out = [];
  for (const pr of PAGE_ROUTES) {
    const html = fs.readFileSync(path.join(ROOT, 'public', pr.file), 'utf8');
    const rawCalls = extractApiCalls(html, pr.apiPrefix);
    const truth = truthByRoute.get(pr.route);
    out.push({
      route: pr.route, file: pr.file,
      bootCalls: truth ? truth.calls : [],
      bootCallCount: truth ? truth.calls.length : 0,
      rawCalls,
    });
  }
  return out;
}

// 分页/单页上限：读后端源码正则
function section4Pagination() {
  const lib = path.join(ROOT, 'lib');
  const grab = (mod, re) => {
    const t = fs.readFileSync(path.join(lib, mod), 'utf8');
    const m = re.exec(t);
    return m ? m[0] : null;
  };
  return [
    { room: '相册', endpoint: '/api/photos/list', pageSize: 60, serverCap: 'limit=Math.min(60, …)', pagination: 'offset 滚动分页，IntersectionObserver 触发 loadMore', evidence: 'lib/photos.mjs L461-477' },
    { room: '笔记库', endpoint: '/api/notes/list', pageSize: 200, serverCap: 'limit=Math.min(…, 500)', pagination: '单次拉取切片，无滚动分页', evidence: 'lib/notes.mjs L161-191' },
    { room: '媒体库', endpoint: '/api/library/list', pageSize: '全量分组', serverCap: '无 limit', pagination: '全量返回 movies/series，无分页', evidence: 'lib/library.mjs L356-368' },
    { room: '追更日历', endpoint: '/api/calendar/overview', pageSize: '全量', serverCap: '无 limit', pagination: '全量 tracks/feeds 组装，无分页', evidence: 'lib/calendar.mjs L462-500' },
    { room: '下载中心', endpoint: '/api/download/list', pageSize: '全量任务', serverCap: '无 limit', pagination: '全量返回，无分页', evidence: 'lib/download.mjs L30,82-88' },
  ].map((r) => ({ ...r, sourceLimit: grab(r.endpoint.split('/')[2] + '.mjs', /Math\.min\([^;)]*\)/) || null }));
}

// 进页接口实测耗时（GET；POST 只登记不调）
const BOOT_ENDPOINTS = [
  '/api/home/summary', '/api/home/todos',
  '/api/book/info', '/api/book/shelf',
  '/api/library/list',
  '/api/photos/lan', '/api/photos/list?offset=0&limit=60', '/api/photos/scan-status',
  '/api/notes/list?limit=200', '/api/notes/stats',
  '/api/calendar/overview',
  '/api/download/list',
];

async function section4Latency(n = 10) {
  const out = [];
  for (const p of BOOT_ENDPOINTS) {
    const arr = []; let bytes = 0, status = 0;
    for (let i = 0; i < n; i++) {
      const t0 = process.hrtime.bigint();
      try {
        const r = await fetch(BASE + p);
        status = r.status;
        const b = await r.arrayBuffer();
        bytes = b.byteLength;
        arr.push(ms(t0));
      } catch (e) {
        arr.push(NaN);
      }
      await sleep(20);
    }
    const ok = arr.filter((x) => !Number.isNaN(x));
    out.push({
      path: p, status, bytes, n: ok.length,
      p50: fmt(pct(ok, 0.5)), p95: fmt(pct(ok, 0.95)), max: fmt(ok.length ? Math.max(...ok) : NaN),
    });
  }
  return out;
}

/* ───────────────────────── 5. 服务端热点静态定位 ───────────────────────── */

function section5Static() {
  // 发请求的轮询（人工核对）；network=true 表示该定时器回调里有 fetch/接口调用
  const pollTruth = [
    { file: '五五客厅.html', fn: 'refresh', everyMs: 8000, network: true, endpoint: '/api/home/summary', note: '概览 8s 刷新；tick 30s 为本地时钟不发请求' },
    { file: '书房.html', fn: 'pollSearchJob', everyMs: 300, network: true, endpoint: '/api/book/search-status', note: '仅搜索 running 时；失败回落 1600ms；600ms 定时器为本地 DOM 检查' },
    { file: '媒体库.html', fn: 'load', everyMs: 30000, network: true, endpoint: '/api/library/list', note: '无扫描中时 30s 刷新；pollStatus 1800/3000ms 仅扫描中' },
    { file: '媒体库.html', fn: 'pollStatus', everyMs: 1800, network: true, endpoint: '/api/library/scan-status', note: '仅扫描运行中递归；失败 3000ms' },
    { file: '相册.html', fn: 'pollStatus', everyMs: 15000, network: true, endpoint: '/api/photos/scan-status', note: 'setInterval；扫描中递归 1800ms' },
    { file: '笔记库.html', fn: 'load', everyMs: 30000, network: true, endpoint: '/api/notes/list', note: '无筛选条件时 30s 刷新' },
    { file: '追更日历.html', fn: 'load', everyMs: 30000, network: true, endpoint: '/api/calendar/overview', note: '1s tick 为本地倒计时不发请求' },
    { file: '下载中心.html', fn: 'load', everyMs: 2500, network: true, endpoint: '/api/download/list', note: '任务列表 2.5s 轮询' },
  ];

  // 静态扫描所有定时器作佐证（含本地 UI 定时器）
  const dir = path.join(ROOT, 'public');
  const pollsRaw = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(dir, f), 'utf8');
    const lines = html.split('\n');
    lines.forEach((line, i) => {
      const iv = /setInterval\([^,]+,\s*(\d+)\)/.exec(line);
      const to = /setTimeout\([^,]+,\s*(\d+)\)/.exec(line);
      if (iv) pollsRaw.push({ file: f, line: i + 1, kind: 'setInterval', everyMs: Number(iv[1]), snippet: line.trim().slice(0, 90) });
      else if (to) pollsRaw.push({ file: f, line: i + 1, kind: 'recursive/one-shot setTimeout', everyMs: Number(to[1]), snippet: line.trim().slice(0, 90) });
    });
  }

  // 模块数据缓存机制 + 请求路径上的 readFile/parse 行号
  const lib = path.join(ROOT, 'lib');
  const dataModules = ['notes.mjs', 'library.mjs', 'photos.mjs', 'download.mjs', 'calendar.mjs'].map((mod) => {
    const t = fs.readFileSync(path.join(lib, mod), 'utf8');
    const lines = t.split('\n');
    const reads = [];
    lines.forEach((line, i) => {
      if (/readFileSync|fsp\.readFile/.test(line)) reads.push({ line: i + 1, snippet: line.trim().slice(0, 90) });
    });
    const memCache = /if \(cache\) return cache/.test(t);
    return { module: mod, memoryCacheHit: memCache, diskReads: reads };
  });

  // hub.mjs 请求路径上的同步读/parse
  const hub = fs.readFileSync(path.join(ROOT, 'hub.mjs'), 'utf8');
  const hubLines = hub.split('\n');
  const hubReads = [];
  hubLines.forEach((line, i) => {
    if (/readFileSync|JSON\.parse/.test(line)) hubReads.push({ line: i + 1, snippet: line.trim().slice(0, 90) });
  });

  return {
    polling: pollTruth,
    pollingRaw: pollsRaw,
    note: 'search-status：书房搜索 running 时 300ms 递归轮询（public/书房.html L938），失败回落 1600ms（L962）；后端为 Map 内存读取 + publicJob 全量序列化（hub.mjs L1837-1845, L739-757），无磁盘读。',
    dataModules,
    hubSyncReads: hubReads,
    homeTodosNoCache: {
      file: 'lib/home.mjs',
      lines: 'L98-106 readTodos：每次 /api/home/todos 请求都 readFile + JSON.parse，无内存缓存；当前 runtime/home.json 仅 47B，体量小、非热点，但模式与其它房间不一致。',
    },
  };
}

/* ───────────────────────── 主流程 ───────────────────────── */

async function run() {
  const meta = {
    base: BASE, upstreamMusic: MUSIC_UP, samples: N,
    at: new Date().toISOString(),
    node: process.version,
    warnings: [
      '本机常有并行网络任务；耗时取 p50/p95/max，max 受并行负载影响，解读时看 p50。',
      '冷/热口径：冷=进程内首次；热=紧随第二次。cache-control=no-store 时浏览器不缓存，热命中只反映服务端进程内缓存壳。',
      '/music/ 代理 5s TTL 内存壳；TTL 外的 miss 才回上游并重写。',
    ],
  };

  console.log('[1/5] 首屏页面度量 …');
  const section1Out = await section1();
  console.log('[2/5] /music/ 上游与代理采样 …');
  const section2Out = await section2();
  console.log('[3/5] 图片懒加载静态盘点 …');
  const section3Out = section3();
  console.log('[4/5] 进页接口静态解析 + 实测 …');
  const section4StaticOut = section4Static();
  const section4PageOut = section4Pagination();
  const section4LatencyOut = await section4Latency();
  console.log('[5/5] 服务端热点静态定位 …');
  const section5Out = section5Static();

  const report = {
    meta,
    section1Landing: section1Out,
    section2Music: section2Out,
    section3Images: section3Out,
    section4Api: { pages: section4StaticOut, pagination: section4PageOut, endpointLatency: section4LatencyOut },
    section5ServerHot: section5Out,
  };

  fs.mkdirSync(path.dirname(path.join(ROOT, OUT)), { recursive: true });
  fs.writeFileSync(path.join(ROOT, OUT), JSON.stringify(report, null, 1));

  // 控制台表
  const tbl = (rows, cols) => {
    console.log('\n' + cols.map((c) => c.label.padEnd(c.w)).join(' | '));
    console.log('-'.repeat(cols.reduce((s, c) => s + c.w + 3, 0)));
    for (const r of rows) console.log(cols.map((c) => String(r[c.key]).padEnd(c.w)).join(' | '));
  };

  console.log('\n===== 1. 首屏（冷 / 热1 / 热2，total ms · 字节 · 阻塞脚本） =====');
  for (const p of section1Out) {
    console.log(`${p.path.padEnd(12)} cold ${p.cold.totalMs}ms/${p.cold.bytes}B/阻塞${p.cold.scriptBlocking}  ` +
      `warm ${p.warm.totalMs}ms/${p.warm.bytes}B  warm2 ${p.warm2.totalMs}ms  CC=${p.cold.cacheControl}`);
  }

  console.log('\n===== 2. /music/ 耗时 p50/p95/max (ms) · 字节 · 缓存头 =====');
  console.log(`上游 ${section2Out.upstream.total.p50}/${section2Out.upstream.total.p95}/${section2Out.upstream.total.max} ${section2Out.upstream.bytes}B CC=${section2Out.upstream.headers['cache-control']} ETag=${section2Out.upstream.headers.etag||'无'} LM=${section2Out.upstream.headers['last-modified']||'无'}`);
  console.log(`代理 ${section2Out.proxy.total.p50}/${section2Out.proxy.total.p95}/${section2Out.proxy.total.max} ${section2Out.proxy.bytes}B CC=${section2Out.proxy.headers['cache-control']} ETag=${section2Out.proxy.headers.etag||'无'}`);
  console.log(`内存壳命中 p50 ${section2Out.proxyInMemoryCache.hitP50}ms；miss p50 ${section2Out.proxyMiss.p50}ms（${section2Out.proxyMiss.samples.length} 样本）；轻路由对照 p50 ${section2Out.lightweightRouteBaseline.p50}ms；重写增量 ${section2Out.rewrite.deltaBytes}B (${section2Out.rewrite.deltaPct}%)`);

  console.log('\n===== 3. 图片懒加载 =====');
  console.log(`总计 ${section3Out.grand.total}：lazy ${section3Out.grand.lazy}，decoding=async ${section3Out.grand.async}，声明尺寸 ${section3Out.grand.size}`);

  console.log('\n===== 4. 进页接口条数 / 实测 =====');
  for (const p of section4StaticOut) console.log(`${p.route.padEnd(12)} 进页 ${p.bootCallCount} 个：${p.bootCalls.map((c) => c.method + ' ' + c.path).join('、') || '—'}`);
  tbl(section4LatencyOut, [
    { key: 'path', label: '接口', w: 42 }, { key: 'p50', label: 'p50', w: 8 }, { key: 'p95', label: 'p95', w: 8 }, { key: 'max', label: 'max', w: 8 }, { key: 'bytes', label: 'B', w: 8 },
  ]);

  console.log('\n===== 5. 发请求的轮询 =====');
  for (const x of section5Out.polling) console.log(`${x.file}:${x.fn} ${x.everyMs}ms → ${x.endpoint}${x.network ? '' : '（本地）'}`);

  console.log(`\n报告已写入 ${OUT}`);
}

run().catch((e) => { console.error('体检失败', e && e.stack || e); process.exit(1); });
