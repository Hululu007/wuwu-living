#!/usr/bin/env node
/**
 * 五五客厅 · 四合一服务
 *
 * 对外只有一个地址：http://127.0.0.1:8890
 *   /            客厅
 *   /magnet/     搜磁力
 *   /music/      听音乐
 *   /vod/        看视频
 *   /book/       书房（接 Reader 数据）
 *
 * 三个 Web 项目仍在各自进程里跑，但只由客厅这一条通道对外；
 * 客厅会把它们页面里的本地绝对路径改写到各自的前缀下，所以四条通道同源。
 *
 * 用法：
 *   node hub.mjs              本机 http://127.0.0.1:8890
 *   node hub.mjs --lan        同 Wi-Fi 的手机也能打开
 *   PORT=8891 node hub.mjs    换端口
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { searchAllSources, getSourceStats, ensureSourceCache, groupBooks, groupKeyOf } from './lib/book_source_search.mjs';
import { READER_SEARCH_FACTS, probeReaderHealth, probeRoute } from './lib/reader_api.mjs';
import { loadRooms, roomRoutes, roomSummaries, ROOM_LIST } from './lib/rooms.mjs';
import { homeSummary, homeTodos } from './lib/home.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8890);
const LAN = process.argv.includes('--lan');
const BIND = process.env.BIND || (LAN ? '0.0.0.0' : '127.0.0.1');

const CONFIG_FILE = path.join(ROOT, 'config', 'apps.json');
const PAGE_FILE = path.join(ROOT, 'public', '五五客厅.html');
const BOOK_FILE = path.join(ROOT, 'public', '书房.html');
const ACTION_LOG = '/tmp/wuwu-living-actions.log';

const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const apps = cfg.apps || {};
const ORDER = ['magnet', 'book', 'music', 'vod'];

// 每个 Web 项目页面里需要改写到前缀下的本地绝对路径。
// 只改引号/反引号紧跟的路径，避免误伤正文与外部 URL。
const REWRITE = {
  magnet: ['/api/', '/lib/', '/player', '/favicon.ico'],
  music: ['/api/', '/assets/'],
  vod: ['/api/', '/hls.min.js', '/proxy'],
};

const busy = new Map();
const extraCache = new Map();
const bookCache = { t: 0, data: null, pending: null };
const searchJobs = new Map();
let searchJobSeq = 0;

/* ───────────────────────── 小工具 ───────────────────────── */

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHtml(res, html, code = 200) {
  const buf = Buffer.isBuffer(html) ? html : Buffer.from(String(html));
  res.writeHead(code, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': buf.length,
  });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function readRaw(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function logLine(msg) {
  try {
    fs.appendFileSync(ACTION_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

async function getJson(url, ms = 3000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal, cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function probe(base, healthPath = '/', ms = 1800) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  const t0 = process.hrtime.bigint();
  return fetch(base + healthPath, { signal: ac.signal, cache: 'no-store' })
    .then((r) => ({
      running: r.status < 500,
      status: r.status,
      ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6),
    }))
    .catch(() => ({ running: false, status: 0, ms: null }))
    .finally(() => clearTimeout(timer));
}

function cachedExtra(id, ttl, fn) {
  const hit = extraCache.get(id);
  if (hit && Date.now() - hit.t < ttl) return Promise.resolve(hit.data);
  return fn()
    .then((data) => {
      extraCache.set(id, { t: Date.now(), data });
      return data;
    })
    .catch(() => (hit ? hit.data : null));
}

function runScript(app, arg) {
  const script = path.join(app.dir, app.script);
  if (!fs.existsSync(script)) {
    return { ok: false, message: `找不到启动脚本：${script}` };
  }
  try {
    const env = { ...process.env, ...(app.env || {}) };
    const child = spawn('/bin/bash', [script, arg], {
      cwd: app.dir,
      detached: true,
      stdio: 'ignore',
      env,
    });
    child.unref();
    logLine(`spawn ${app.script} ${arg} (pid ${child.pid})`);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: String(e.message || e) };
  }
}

function markBusy(id) {
  busy.set(id, Date.now());
  setTimeout(() => busy.delete(id), 45000);
}

function prefixOf(id, app) {
  return (app.path || '/' + id + '/').replace(/\/$/, '');
}

/* ───────────────────────── 读书（本地 Reader） ───────────────────────── */

function readerQuery(db, mode = 'info', arg = '') {
  // launchd 上下文里 `sqlite3 -readonly` 打不开 WAL 库；python 的只读 URI 可以，
  // 也不会动 Reader 的数据。
  return new Promise((resolve) => {
    const args = [path.join(ROOT, 'lib', 'reader_query.py'), db, mode];
    if (arg) args.push(arg);
    execFile('/usr/bin/python3', args, { timeout: 6000, killSignal: 'SIGTERM' }, (err, stdout, stderr) => {
      if (err) {
        const detail = [err.message, `code=${err.code}`, `signal=${err.signal}`, stderr && stderr.trim()]
          .filter(Boolean).join(' | ');
        logLine('reader query error: ' + detail);
        return resolve(null); // 失败只降级为 null，不影响 /api/ping、/ 等轻路由
      }
      try { resolve(JSON.parse(String(stdout).trim())); }
      catch (e) {
        logLine('reader query parse error: ' + stdout);
        resolve(null);
      }
    });
  });
}

function processRunning(name) {
  return new Promise((resolve) => {
    execFile('/usr/bin/pgrep', ['-xq', name], (err) => resolve(!err));
  });
}

async function bookInfo() {
  if (bookCache.data && Date.now() - bookCache.t < (bookCache.ttl || 45000)) return bookCache.data;
  // 并发请求共用同一次 Python 查询，避免状态接口和书房页同时拉两个进程
  if (bookCache.pending) return bookCache.pending;

  const task = (async () => {
    const app = apps.book || {};
    const bundle = app.bundle || 'Reader';
    const db = app.db || '';
    const installed = fs.existsSync(`/Applications/${bundle}.app`);
    const appRunning = installed ? await processRunning(bundle) : false;
    const webRunning = installed ? await readerHealth() : false;
    const cacheTtl = webRunning ? 45000 : 12000;

    let sources = null;
    let lastBook = '';
    let todaySeconds = 0;
    let groups = [];
    let groupTotal = 0;
    let searchable = null;
    let searchRules = null;

    if (installed && db && fs.existsSync(db)) {
      const q = await readerQuery(db, 'info');
      if (q) {
        if (q.sources != null) sources = Number(q.sources) || 0;
        lastBook = q.lastBook || '';
        todaySeconds = Number(q.todaySeconds) || 0;
        groups = Array.isArray(q.groups) ? q.groups : [];
        groupTotal = Number(q.groupTotal) || groups.length;
      }
    }

    try {
      const cacheStats = getSourceStats();
      searchable = cacheStats.direct;
      searchRules = cacheStats.total;
    } catch (e) {
      logLine('source cache stats error: ' + (e.message || e));
    }

    const data = {
      installed,
      running: webRunning,
      webRunning,
      appRunning,
      sources,
      lastBook,
      todaySeconds,
      todayMinutes: Math.round(todaySeconds / 60),
      groups,
      groupTotal,
      searchable,
      searchRules,
      engine: 'Reader 书源引擎',
      apiBase: READER_BASE,
    };
    bookCache.t = Date.now();
    bookCache.ttl = cacheTtl;
    bookCache.data = data;
    return data;
  })();

  bookCache.pending = task;
  try {
    return await task;
  } finally {
    if (bookCache.pending === task) bookCache.pending = null;
  }
}

async function bookSearch(q) {
  const app = apps.book || {};
  if (!q || !app.db || !fs.existsSync(app.db)) return [];
  const r = await readerQuery(app.db, 'search', q);
  return r && Array.isArray(r.items) ? r.items : [];
}

async function bookGroup(name) {
  const app = apps.book || {};
  if (!name || !app.db || !fs.existsSync(app.db)) return [];
  const r = await readerQuery(app.db, 'group', name);
  return r && Array.isArray(r.items) ? r.items : [];
}

/* ───────────────────── 书房：搜索 + Reader 内容引擎 ───────────────────── */

const READER_BASE = (apps.book && apps.book.base) || 'http://127.0.0.1:1122';
const BOOK_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

let readerEnsurePromise = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, opts = {}, ms = 15000) {
  const r = await fetchWithTimeout(url, opts, ms);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.text();
}

/* ───────────── 书籍详情/目录磁盘缓存 + 打开链路健康 ───────────── */

const BOOKS_DIR = path.join(ROOT, 'runtime', 'books');
const OPEN_HEALTH_PATH = path.join(ROOT, 'runtime', 'book_open_health.json');
const BOOK_CACHE_TTL = 7 * 24 * 3600 * 1000;
const OPEN_HEALTH_TTL = 14 * 24 * 3600 * 1000;
let openHealthCache = null;

function loadOpenHealth() {
  if (openHealthCache) return openHealthCache;
  try {
    openHealthCache = JSON.parse(fs.readFileSync(OPEN_HEALTH_PATH, 'utf8'));
  } catch {
    openHealthCache = { sources: {} };
  }
  if (!openHealthCache.sources) openHealthCache.sources = {};
  const now = Date.now();
  for (const [url, h] of Object.entries(openHealthCache.sources)) {
    if (!h || now - (h.last || 0) > OPEN_HEALTH_TTL) delete openHealthCache.sources[url];
  }
  return openHealthCache;
}

function saveOpenHealth() {
  try {
    fs.writeFileSync(OPEN_HEALTH_PATH, JSON.stringify({ updatedAt: Date.now(), sources: loadOpenHealth().sources }));
  } catch { /* 缓存失败不影响主流程 */ }
}

// 详情/目录链路健康：按书源累计成功/失败与平均耗时；连续失败由成功率自然降权，不永久排除。
function recordOpenHealth(origin, stage, ok, ms) {
  if (!origin) return;
  try {
    const cache = loadOpenHealth();
    const h = cache.sources[origin] || {};
    h[`${stage}Ok`] = (h[`${stage}Ok`] || 0) + (ok ? 1 : 0);
    h[`${stage}Fail`] = (h[`${stage}Fail`] || 0) + (ok ? 0 : 1);
    const prev = h[`${stage}AvgMs`] || ms;
    h[`${stage}AvgMs`] = Math.round(prev * 0.7 + ms * 0.3);
    h.last = Date.now();
    cache.sources[origin] = h;
    saveOpenHealth();
  } catch { /* ignore */ }
}

function openHealthScore(origin) {
  const h = loadOpenHealth().sources[origin];
  if (!h) return 0;
  const ok = (h.infoOk || 0) + (h.tocOk || 0);
  const fail = (h.infoFail || 0) + (h.tocFail || 0);
  if (ok + fail === 0) return 0;
  const rate = ok / (ok + fail);
  return rate - 0.00001 * ((h.infoAvgMs || 0) + (h.tocAvgMs || 0));
}

function bookCacheKey(origin, bookUrl) {
  return createHash('sha1').update(`${origin || ''}|${bookUrl || ''}`).digest('hex');
}

function readBookCache(origin, bookUrl) {
  if (!bookUrl) return null;
  try {
    const file = path.join(BOOKS_DIR, `${bookCacheKey(origin, bookUrl)}.json`);
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Date.now() - (data.at || 0) > BOOK_CACHE_TTL) return null;
    return data;
  } catch {
    return null;
  }
}

function writeBookCache(origin, bookUrl, payload) {
  if (!bookUrl) return;
  try {
    fs.mkdirSync(BOOKS_DIR, { recursive: true });
    const file = path.join(BOOKS_DIR, `${bookCacheKey(origin, bookUrl)}.json`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), ...payload }));
    fs.renameSync(tmp, file);
  } catch { /* 落盘失败不阻断打开 */ }
}

function decodeHtml(s) {
  const named = {
    nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
    hellip: '…', mdash: '—', ndash: '–', middot: '·', times: '×',
    copy: '©', reg: '®', deg: '°', laquo: '«', raquo: '»',
  };
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const n = parseInt(h, 16);
      return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    })
    .replace(/&#(\d+);/g, (_, d) => {
      const n = Number(d);
      return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    })
    .replace(/&([a-z]+);/gi, (m, name) => named[String(name).toLowerCase()] ?? m)
    .replace(/\u00a0/g, ' ');
}

function stripTags(s) {
  return decodeHtml(String(s || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanText(s) {
  return decodeHtml(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanAuthor(s) {
  const v = stripTags(s).replace(/^作者[：:]\s*/, '').replace(/^\s*作者\s*/, '').trim();
  return v || '佚名';
}

function guessBookOrigin(bookUrl) {
  if (/23uswx\.la|x23us\.us/i.test(String(bookUrl || ''))) return 'http://www.23uswx.la/';
  return '';
}

function normalizeBook(info, fallback = {}) {
  const b = info || {};
  const bookUrl = cleanText(b.bookUrl) || cleanText(fallback.bookUrl);
  const origin = cleanText(b.origin) || cleanText(fallback.origin) || guessBookOrigin(bookUrl);
  return {
    name: cleanText(b.name) || '未命名',
    author: cleanAuthor(b.author),
    bookUrl,
    origin,
    originName: cleanText(b.originName) || 'Reader 书源',
    coverUrl: cleanText(b.coverUrl),
    tocUrl: cleanText(b.tocUrl) || bookUrl,
    intro: cleanText(b.intro),
    charset: b.charset || null,
    type: Number.isFinite(b.type) ? b.type : 0,
    canUpdate: b.canUpdate !== false,
    durChapterIndex: Number.isFinite(b.durChapterIndex) ? b.durChapterIndex : null,
    durChapterTitle: cleanText(b.durChapterTitle),
    totalChapterNum: Number.isFinite(b.totalChapterNum) ? b.totalChapterNum : null,
  };
}

async function readerHealth() {
  try {
    const d = await getJson(READER_BASE + '/api/health', 1500);
    return !!d.ok;
  } catch {
    return false;
  }
}

async function readerRequest(method, pathname, body, ms = 30000) {
  // 同源本地 JSON 请求：复用同一套 header 组合（本地服务无 cookie 会话，握手开销可忽略）。
  const headers = { accept: 'application/json' };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  const init = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const r = await fetchWithTimeout(READER_BASE + pathname, init, ms);
  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Reader 返回了非 JSON（${r.status}）`);
  }
  if (!r.ok) throw new Error(data.errorMsg || `Reader HTTP ${r.status}`);
  return data;
}

function readerData(d, label) {
  if (!d || d.isSuccess === false) {
    throw new Error((d && d.errorMsg) || (label || 'Reader') + '失败');
  }
  return d.data;
}

async function ensureReaderWeb(waitMs = 24000) {
  if (await readerHealth()) return true;
  if (readerEnsurePromise) return readerEnsurePromise;

  const app = apps.book || {};
  const installed = fs.existsSync(`/Applications/${app.bundle || 'Reader'}.app`);
  if (!installed) return false;

  readerEnsurePromise = (async () => {
    logLine('starting Reader web engine');
    try {
      execFile('/usr/bin/open', ['-a', app.bundle || 'Reader'], (err) => {
        if (err) logLine('open Reader failed: ' + err.message);
      });
    } catch (e) {
      logLine('open Reader error: ' + e.message);
    }
    const t0 = Date.now();
    while (Date.now() - t0 < waitMs) {
      await sleep(700);
      if (await readerHealth()) {
        bookCache.t = 0;
        logLine('Reader web engine is ready');
        return true;
      }
    }
    logLine('Reader web engine timeout');
    return false;
  })();

  try {
    return await readerEnsurePromise;
  } finally {
    readerEnsurePromise = null;
  }
}

/**
 * 顶点小说搜索页解析。
 * 搜索结果是一张很规整的 HTML 表：tr#nr，6 个 td（书名链接 / 最新章节 / 作者 / 字数 / 更新 / 状态）。
 * 这里只负责“找到一个可交给 Reader 的 bookUrl”，详情、目录、正文全部由 Reader 书源引擎完成。
 */
async function bookSearchTitles(query) {
  const key = String(query || '').trim();
  if (!key) return [];
  const qs = encodeURIComponent(key);
  let html = '';
  let via = '';

  const candidates = [
    { url: `http://www.23uswx.la/modules/article/search.php?q=${qs}`, label: '顶点小说' },
    { url: `https://www.x23us.us/modules/article/search.php?q=${qs}`, label: '顶点小说（镜像）' },
  ];
  for (const c of candidates) {
    try {
      html = await fetchText(c.url, {
        headers: {
          'user-agent': BOOK_UA,
          'accept-language': 'zh-CN,zh;q=0.9',
          accept: 'text/html,application/xhtml+xml',
        },
      }, 16000);
      if (html && /<tr[^>]+id=["']nr["']/i.test(html)) {
        via = c.label;
        break;
      }
    } catch (e) {
      logLine(`book search ${c.label} failed: ${e.message}`);
    }
  }
  if (!html) return [];

  const rows = [...html.matchAll(/<tr[^>]+id=["']nr["'][^>]*>([\s\S]*?)<\/tr>/gi)];
  const items = [];
  const seen = new Set();

  for (const row of rows) {
    const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (cells.length < 3) continue;
    const firstLink = cells[0].match(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!firstLink) continue;
    let bookUrl = decodeHtml(firstLink[1]).trim();
    const name = stripTags(firstLink[2]);
    if (!bookUrl || !name) continue;
    bookUrl = bookUrl.replace(/^\/\//, 'http://').replace(/https?:\/\/(www\.)?x23us\.us/i, 'http://www.23uswx.la');
    if (!/^http/i.test(bookUrl)) continue;
    if (seen.has(bookUrl)) continue;
    seen.add(bookUrl);
    const latestLink = cells[1] && cells[1].match(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    items.push({
      name,
      author: cleanAuthor(cells[2]),
      bookUrl,
      latestChapter: latestLink ? stripTags(latestLink[2]) : '',
      wordCount: cells[3] ? stripTags(cells[3]) : '',
      updateTime: cells[4] ? stripTags(cells[4]) : '',
      status: cells[5] ? stripTags(cells[5]) : '',
      origin: 'http://www.23uswx.la/',
      originName: '顶点小说⑤',
      source: via || '顶点小说',
      coverUrl: '',
    });
    if (items.length >= 24) break;
  }
  return items;
}


/* ───────────────────────── 全源搜书任务 ───────────────────────── */

function pruneSearchJobs() {
  const now = Date.now();
  for (const [id, job] of searchJobs) {
    if (now - job.startedAt > 15 * 60 * 1000) searchJobs.delete(id);
  }
}

function startBookSearchJob(query) {
  pruneSearchJobs();
  ensureSourceCache();
  const stats = getSourceStats();
  const id = `bs_${Date.now().toString(36)}_${++searchJobSeq}`;
  const job = {
    id,
    query,
    status: 'running',
    done: 0,
    total: stats.total,
    hits: 0,
    sourcesWithResults: 0,
    sourcesWithNames: 0,
    answered: 0,
    failed: 0,
    skipped: 0,
    items: [],      // 原始命中（去重前按 bookUrl 去重）
    grouped: [],    // 展示用：按「书名|作者」聚合后的书，只追加、不重排
    seen: new Set(),
    revision: 0,
    stats: null,
    startedAt: Date.now(),
    finishedAt: 0,
    error: '',
  };
  searchJobs.set(id, job);
  searchAllSources(query, {
    concurrency: 150,
    timeout: 4500,
    limit: 320,
    // 边搜边出：每个源一有命中，立刻聚合并推进 revision，页面轮询即可增量追加
    onItems(added) {
      for (const item of added) job.items.push(item);
      let fresh = [];
      try {
        fresh = groupBooks(job.items, query);
      } catch { return; }
      let changed = false;
      for (const group of fresh) {
        const key = groupKeyOf(group);
        if (job.seen.has(key)) continue;
        job.seen.add(key);
        job.grouped.push(group);
        changed = true;
      }
      if (changed) {
        job.revision++;
        job.hits = job.grouped.length;
      }
    },
    onProgress(progress) {
      job.done = progress.done;
      job.total = progress.total || job.total;
      job.rawHits = progress.hits || job.rawHits || 0;   // 原始命中条数（未聚合）
      job.hits = job.grouped.length || job.hits;          // 展示口径：聚合后的书数
      job.sourcesWithResults = progress.sourcesWithResults || job.sourcesWithResults;
      job.answered = progress.answered || 0;
      job.failed = progress.failed || 0;
      job.skipped = progress.skipped || 0;
      if (progress.finished) job.status = 'done';
    },
  }).then((result) => {
    job.status = 'done';
    // 把关掉任务时才算出的权威聚合结果里「还没出现过的书」补到末尾，已有顺序一律不动
    for (const group of result.items || []) {
      const key = groupKeyOf(group);
      if (job.seen.has(key)) continue;
      job.seen.add(key);
      job.grouped.push(group);
    }
    job.stats = result.stats || null;
    job.done = job.total;
    job.hits = job.grouped.length || result.stats?.unique || job.hits;
    job.sourcesWithResults = result.stats?.withResults || job.sourcesWithResults;
    job.sourcesWithNames = result.stats?.sourceNames || 0;
    job.answered = result.stats?.answered || job.answered;
    job.failed = result.stats?.failed || job.failed;
    job.skipped = result.stats?.skipped || job.skipped;
    job.finishedAt = Date.now();
    logLine(`book search job ${id} done: ${job.hits} books / ${job.sourcesWithResults} sources in ${job.stats?.elapsedMs || 0}ms`);
    // 后台预热前若干本的详情/目录/首章，不阻塞任务完成与首屏。
    void warmTopBooks(job.grouped.slice(0, 10));
  }).catch((error) => {
    job.status = 'error';
    job.error = error.message || String(error);
    job.finishedAt = Date.now();
    logLine(`book search job ${id} failed: ${job.error}`);
  });
  return job;
}

function publicJob(job) {
  return {
    id: job.id,
    query: job.query,
    status: job.status,
    done: job.done,
    total: job.total,
    hits: job.hits,
    sourcesWithResults: job.sourcesWithResults,
    sourcesWithNames: job.sourcesWithNames,
    answered: job.answered,
    failed: job.failed,
    skipped: job.skipped,
    // 关键改动：搜索中就开始返回已有结果（以前要等 done 才吐 items）
    items: job.grouped,
    revision: job.revision,
    rawHits: job.rawHits || job.items.length,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    stats: job.stats,
    error: job.error,
  };
}


async function openBookWithSources(body) {
  const candidates = [];
  const push = (item) => {
    if (!item || !item.bookUrl) return;
    const url = String(item.url || item.bookSourceUrl || item.origin || '').trim();
    if (!url) return;
    if (candidates.some((c) => c.bookUrl === item.bookUrl && c.bookSourceUrl === url)) return;
    candidates.push({ bookUrl: item.bookUrl, bookSourceUrl: url, name: item.name || '' });
  };
  push({ bookUrl: body.bookUrl, bookSourceUrl: body.bookSourceUrl || body.origin, name: body.originName });
  if (Array.isArray(body.sources)) {
    for (const item of body.sources) push(item);
  }
  if (!candidates.length) throw new Error('这本书没有可用的书源');

  // 点击先查磁盘缓存：任一候选源命中就直接返回，不再转圈请求。
  for (const candidate of candidates) {
    const cached = readBookCache(candidate.bookSourceUrl, candidate.bookUrl);
    if (cached) return { ...cached, cached: true };
  }

  // 静态站名权重 + 详情/目录历史成功率排序；失败源自然降权，不永久排除。
  const ordered = candidates
    .map((c) => ({ ...c, _rank: sourceRank(c.name) + openHealthScore(c.bookSourceUrl) }))
    .sort((a, b) => b._rank - a._rank)
    .map(({ _rank, ...c }) => c);

  // 前 3 个候选同时起跑，谁先成功用谁；并发上限 3，去重已在 push 完成。
  const BATCH = 3;
  const MAX_TRY = 8;
  let lastError = null;
  for (let i = 0; i < Math.min(ordered.length, MAX_TRY); i += BATCH) {
    const batch = ordered.slice(i, i + BATCH);
    const winner = await new Promise((resolve, reject) => {
      let settled = 0;
      let firstReject = null;
      let done = false;
      batch.forEach((candidate) => {
        openBook(candidate.bookUrl, candidate.bookSourceUrl)
          .then((out) => {
            if (done) return;
            done = true;
            out.sourceUsed = candidate.name || out.book.originName || '';
            out.triedSources = ordered.indexOf(candidate) + 1;
            resolve(out);
          })
          .catch((error) => {
            if (done) return;
            settled += 1;
            firstReject = error;
            lastError = error;
            logLine(`open book source failed (${candidate.name || candidate.bookSourceUrl}): ${error.message}`);
            if (settled === batch.length) reject(firstReject || new Error('这本书没有可用的书源'));
          });
      });
    });
    return winner;
  }
  throw lastError || new Error('这本书没有可用的书源');
}

// 列表浏览期后台预热：并发 3 抓前 10 本的详情+目录+首章，落磁盘缓存；失败只跳过，不影响搜索。
async function warmTopBooks(groups) {
  if (!Array.isArray(groups) || !groups.length) return;
  try {
    if (!(await readerHealth())) return;
  } catch {
    return;
  }
  const queued = groups.slice(0, 10);
  const CONCURRENCY = 3;
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const group = queued[cursor++];
      if (!group) return;
      const first = (group.sources && group.sources[0]) || {};
      if (!first.bookUrl) continue;
      if (readBookCache(first.url, first.bookUrl)) continue;
      try {
        await openBookWithSources({
          bookUrl: first.bookUrl,
          bookSourceUrl: first.url,
          origin: first.name,
          sources: group.sources,
        });
      } catch (error) {
        logLine(`warm skip ${group.name || first.bookUrl}: ${error.message || error}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queued.length) }, () => worker())).catch(() => {});
}

function sourceRank(name) {
  const n = String(name || '');
  if (/顶点/.test(n)) return 100;
  if (/笔趣阁/.test(n)) return 95;
  if (/奇书|九五|全本|书吧|文学/.test(n)) return 85;
  if (/小说/.test(n)) return 60;
  return 40;
}

async function openBook(bookUrl, bookSourceUrl) {
  if (!bookUrl) throw new Error('缺少 bookUrl');
  const origin = bookSourceUrl || guessBookOrigin(bookUrl);
  if (!origin) throw new Error('这本书没有可用的书源');

  let stageT0 = Date.now();
  let info;
  try {
    info = readerData(
      await readerRequest('POST', '/reader3/getBookInfo', { url: bookUrl, bookSourceUrl: origin }, 8000),
      '取书籍详情'
    );
    recordOpenHealth(origin, 'info', true, Date.now() - stageT0);
  } catch (error) {
    recordOpenHealth(origin, 'info', false, Date.now() - stageT0);
    throw error;
  }
  const book = normalizeBook(info, { bookUrl, origin });

  stageT0 = Date.now();
  let chapters;
  try {
    chapters = readerData(
      await readerRequest('POST', '/reader3/getChapterList', {
        bookUrl: book.bookUrl,
        bookSourceUrl: book.origin,
        tocUrl: book.tocUrl || book.bookUrl,
        refresh: 0,
      }, 10000),
      '取目录'
    );
    recordOpenHealth(origin, 'toc', true, Date.now() - stageT0);
  } catch (error) {
    recordOpenHealth(origin, 'toc', false, Date.now() - stageT0);
    throw error;
  }

  if (!Array.isArray(chapters) || !chapters.length) throw new Error('这本书没有取到目录');

  // 目录成功不代表正文能读；先读第一章，读不到就换下一个源。
  const probeChapter = chapters.find((c) => !c.isVip && !c.isPay && !c.isVolume) || chapters[0];
  const probe = await readChapter({
    bookUrl: book.bookUrl,
    bookSourceUrl: book.origin,
    chapterUrl: probeChapter.url,
    index: probeChapter.index,
    chapterTitle: probeChapter.title,
  }, 10000);
  if (!probe.content) throw new Error('第一章没有取到正文');

  let saved = false;
  let saveError = '';
  try {
    readerData(await readerRequest('POST', '/reader3/saveBook', book, 6000), '保存书籍');
    saved = true;
  } catch (e) {
    saveError = e.message || String(e);
    logLine(`saveBook failed: ${saveError}`);
  }

  const chaptersOut = chapters.map((c, i) => ({
    title: cleanText(c.title) || `第 ${i + 1} 章`,
    url: c.url,
    index: Number.isFinite(c.index) ? c.index : i,
    isVip: !!c.isVip,
    isPay: !!c.isPay,
    isVolume: !!c.isVolume,
  }));
  const firstChapter = {
    title: chaptersOut[0]?.title || '',
    url: probeChapter.url,
    index: Number.isFinite(probeChapter.index) ? probeChapter.index : 0,
    content: probe.content,
    length: probe.length,
  };
  const out = { book, saved, saveError, chapters: chaptersOut, firstChapter };
  writeBookCache(origin, book.bookUrl, out);
  return out;
}

function contentToText(html) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<\/div\s*>/gi, '\n')
    .replace(/<\/h[1-6]\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  s = decodeHtml(s);
  s = s.replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s;
}

async function readChapter({ bookUrl, bookSourceUrl, chapterUrl, index, chapterTitle }, ms = 35000) {
  if (!bookUrl || !chapterUrl) throw new Error('缺少书籍或章节地址');
  const origin = bookSourceUrl || guessBookOrigin(bookUrl);
  const data = readerData(
    await readerRequest('POST', '/reader3/getBookContent', {
      bookUrl,
      chapterUrl,
      bookSourceUrl: origin,
      index: Number.isFinite(index) ? index : 0,
      chapterTitle: chapterTitle || '',
      refresh: 0,
    }, ms),
    '取正文'
  );
  const content = contentToText(data);
  if (!content) throw new Error('这一章没有取到正文');
  return { content, length: content.length };
}

async function saveReadingProgress({ bookUrl, index, position }) {
  if (!bookUrl || !Number.isFinite(index)) throw new Error('缺少书籍或章节进度');
  return readerData(
    await readerRequest('POST', '/reader3/saveBookProgress', {
      bookUrl,
      index,
      position: Number.isFinite(position) ? position : 0,
    }, 15000),
    '保存进度'
  );
}

async function readerShelf() {
  const data = readerData(await readerRequest('GET', '/reader3/getBookshelf', undefined, 15000), '取书架');
  if (!Array.isArray(data)) return [];
  return data.map((b) => {
    const book = normalizeBook(b);
    book.durChapterIndex = Number.isFinite(b.durChapterIndex) ? b.durChapterIndex : null;
    book.durChapterTitle = cleanText(b.durChapterTitle);
    book.totalChapterNum = Number.isFinite(b.totalChapterNum) ? b.totalChapterNum : null;
    return book;
  });
}


/* ───────────────────────── 状态 ───────────────────────── */

async function appStatus(id) {
  const app = apps[id];
  if (!app) return null;

  if (app.kind === 'app') {
    const b = await bookInfo();
    return {
      id,
      name: app.name,
      kind: 'room',
      action: 'room',
      path: prefixOf(id, app) + '/',
      running: b.webRunning,
      installed: b.installed,
      webRunning: b.webRunning,
      appRunning: b.appRunning,
      busy: busy.has(id) && !b.webRunning,
      stats: {
        sources: b.sources,
        lastBook: b.lastBook,
        todayMinutes: b.todayMinutes,
        groups: b.groupTotal,
      },
    };
  }

  const healthPath = id === 'music' ? '/api/health' : '/';
  const p = await probe(app.base, healthPath);
  if (p.running) busy.delete(id);

  let stats = null;
  if (p.running) {
    if (id === 'magnet') {
      stats = await cachedExtra(id, 20000, async () => {
        const d = await getJson(app.base + '/api/sources', 5000);
        const list = Array.isArray(d.sources) ? d.sources : [];
        return { total: list.length, enabled: list.filter((s) => s.enabled).length };
      });
    } else if (id === 'vod') {
      stats = await cachedExtra(id, 20000, async () => {
        const d = await getJson(app.base + '/api/pool', 5000);
        return { total: d.pool.total, active: d.pool.active };
      });
    } else if (id === 'music') {
      stats = await cachedExtra(id, 20000, async () => {
        const d = await getJson(app.base + '/api/health', 5000);
        return { ok: !!d.ok, sources: 2 };
      });
    }
  }

  return {
    id,
    name: app.name,
    kind: 'web',
    action: 'embed',
    path: prefixOf(id, app) + '/',
    port: app.port,
    base: app.base,
    running: p.running,
    latency: p.ms,
    busy: busy.has(id) && !p.running,
    stats,
  };
}

async function allStatus() {
  const list = await Promise.all(ORDER.map((id) => appStatus(id).catch(() => null)));
  const rooms = await roomSummaries().catch(() => ({}));
  const roomApps = ROOM_LIST.map((r) => {
    const s = rooms[r.id] || {};
    return {
      id: r.id,
      name: r.name,
      kind: 'local',
      action: 'room',
      path: `/${r.id}/`,
      port: PORT,
      running: !!s.ready,
      ready: !!s.ready,
      busy: false,
      color: r.color,
      stats: s,
    };
  });
  return { ts: Date.now(), apps: list.filter(Boolean).concat(roomApps) };
}

/* ───────────────────────── 启动 / 停止 ───────────────────────── */

function startApp(id) {
  const app = apps[id];
  if (!app) return { ok: false, message: '没有这个项目' };

  if (id === 'book') {
    const bundle = app.bundle || 'Reader';
    if (!fs.existsSync(`/Applications/${bundle}.app`)) {
      return { ok: false, message: '没有找到 Reader.app' };
    }
    if (busy.has('book')) return { ok: true, message: '书房引擎正在启动中' };
    markBusy('book');
    bookCache.t = 0;
    ensureReaderWeb()
      .then((ok) => {
        if (ok) busy.delete('book');
        logLine('book engine start ' + (ok ? 'ok' : 'timeout'));
      })
      .catch((e) => logLine('book engine start error: ' + e.message));
    return { ok: true, message: '正在启动书房引擎' };
  }

  if (app.kind !== 'web') return { ok: false, message: '这个项目没有可启动的服务' };
  if (busy.has(id)) return { ok: true, message: '正在启动中' };
  markBusy(id);
  extraCache.delete(id);
  const r = runScript(app, app.startArg || 'start');
  return r.ok ? { ok: true, message: '已发出启动指令' } : { ok: false, message: r.message };
}

function stopApp(id) {
  const app = apps[id];
  if (!app) return { ok: false, message: '没有这个项目' };
  if (id === 'book') {
    return { ok: false, message: '书房引擎由 Reader 提供，请在阅读器里退出 Reader' };
  }
  if (app.kind !== 'web') return { ok: false, message: '这个项目没有可停的服务' };
  const r = runScript(app, app.stopArg || 'stop');
  extraCache.delete(id);
  bookCache.t = 0;
  return r.ok ? { ok: true, message: '已停止' } : { ok: false, message: r.message };
}

/* ───────────────────────── 单端口转发 ───────────────────────── */

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rewriteText(text, prefix, paths, m3u8) {
  let out = text;

  // 页面/JS/JSON 里引号或反引号紧跟的本地绝对路径
  for (const p of paths) {
    const re = new RegExp("([\"'`])" + escapeRe(p), 'g');
    out = out.replace(re, (_m, q) => q + prefix + p);
  }

  // 播放列表里的裸路径与 URI="..."
  if (m3u8) {
    out = out
      .replace(/(^|\r?\n)\/proxy\?/g, `$1${prefix}/proxy?`)
      .replace(/URI="\/proxy\?/g, `URI="${prefix}/proxy?`)
      .replace(/(^|\r?\n)\/api\//g, `$1${prefix}/api/`)
      .replace(/URI="\/api\//g, `URI="${prefix}/api/`);
  }

  return out;
}

function proxyError(res, app) {
  if (res.headersSent) return res.destroy();
  const name = app && app.name ? app.name : '这间屋子';
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>${name} · 暂时没开</title>
<style>
html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#0b0c0e;color:#efe9df;
font:14px/1.9 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;text-align:center}
h1{font:600 26px/1.3 "Songti SC",serif;margin:0 0 10px}p{color:#918c83;margin:0 0 22px}
.ww-home{display:inline-flex;align-items:center;gap:5px;padding:6px 10px;border:1px solid rgba(255,255,255,.06);border-radius:8px;font-size:12px;letter-spacing:.1em;color:#8b8b8b;text-decoration:none;line-height:1}
.ww-home:hover{color:#efe9df;border-color:rgba(255,255,255,.18)}
</style><body><div><h1>${name}暂时没开</h1><p>客厅没连上里面的服务。回客厅点一下这扇门，它会自己启动。</p>
<a class="ww-home" href="/" title="返回五五客厅" aria-label="返回五五客厅"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M15 6l-6 6 6 6"/></svg><span>回客厅</span></a></div></body></html>`;
  sendHtml(res, html, 502);
}

/**
 * 客厅给磁力搜索页加的一条小通道：每条结果后面多一个「加入下载」。
 * 不动 /Users/wuwu/D盘/magnet-search 里的任何代码，只在转发回来的 HTML 末尾补一段脚本。
 * 点一下就把这条磁力丢给 /download/ 的队列。
 */
function injectMagnetDownload(html) {
  if (!html.includes('id="results"') || html.includes('wuwu-dl-injected')) return html;
  const script = `
<!-- wuwu-dl-injected: 客厅给磁力结果加的「加入下载」 -->
<script>
(function () {
  'use strict';
  var MARK = 'wuwu-dl-injected';
  var busy = {};

  function addBtn(item) {
    if (item.getAttribute('data-wdl') === '1') return;
    var box = item.querySelector('.actions');
    if (!box) return;
    var magEl = item.querySelector('.magnet');
    if (!magEl) return;
    var magnet = (magEl.textContent || '').trim();
    if (!/^magnet:\\?xt=urn:btih/i.test(magnet)) return;
    item.setAttribute('data-wdl', '1');
    var titleEl = item.querySelector('.title');
    var btn = document.createElement('button');
    btn.className = 'act dl';
    btn.type = 'button';
    btn.textContent = '⬇ 加入下载';
    btn.title = '把这条磁力丢进客厅的下载中心';
    btn.style.cssText = 'color:#5fada8;border-color:rgba(95,173,168,.4)';
    btn.onclick = function (e) {
      e.preventDefault();
      e.stopPropagation();
      var name = (titleEl ? titleEl.textContent : '').trim().slice(0, 120);
      if (busy[magnet]) return;
      busy[magnet] = true;
      btn.disabled = true;
      btn.textContent = '加入中…';
      fetch('/api/download/add', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ magnet: magnet, name: name })
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (!d.ok) throw new Error(d.message || '加不进去');
        btn.textContent = '✓ 已加入下载';
        btn.style.color = '#7fbb8c';
        btn.style.borderColor = 'rgba(127,187,140,.45)';
      }).catch(function (err) {
        btn.textContent = '加入失败';
        btn.style.color = '#dd7768';
        btn.title = String(err.message || err);
        setTimeout(function () {
          btn.disabled = false;
          btn.textContent = '⬇ 加入下载';
          btn.style.color = '#5fada8';
          btn.style.borderColor = 'rgba(95,173,168,.4)';
          busy[magnet] = false;
        }, 2600);
      });
    };
    box.appendChild(btn);
  }

  function scan() {
    var root = document.getElementById('results');
    if (!root) return;
    var items = root.querySelectorAll('.item');
    for (var i = 0; i < items.length; i++) addBtn(items[i]);
  }

  function boot() {
    scan();
    var root = document.getElementById('results');
    if (root && window.MutationObserver) {
      new MutationObserver(function () { scan(); }).observe(root, { childList: true, subtree: true });
    }
    setInterval(scan, 2500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
</script>
`;
  const at = html.lastIndexOf('</body>');
  if (at === -1) return html + script;
  return html.slice(0, at) + script + html.slice(at);
}

/**
 * 客厅给视频页加一个「记一笔」——边看边把念头写进 /notes/。
 * 同样不动 /Users/wuwu/D盘/项目/请看 里的代码，只在转发回来的 HTML 末尾补一段脚本。
 */
function injectVodNote(html) {
  if (!html.includes('id="video"') || html.includes('wuwu-note-injected')) return html;
  const script = `
<!-- wuwu-note-injected: 客厅给视频页加的「记一笔」 -->
<script>
(function () {
  'use strict';
  var btn, panel, bodyBox, tagBox, hidden = false;

  function videoName() {
    var t = document.getElementById('dTitle');
    if (t && t.textContent.trim()) return t.textContent.trim();
    var h = document.querySelector('#videoWrap');
    return '视频';
  }
  function episodeName() {
    var sel = document.getElementById('epSelPlay');
    if (!sel || !sel.selectedOptions || !sel.selectedOptions[0]) return '';
    var txt = (sel.selectedOptions[0].textContent || '').trim();
    return txt && txt !== '—' ? txt : '';
  }
  function nowTime() {
    var v = document.getElementById('video');
    if (!v || !isFinite(v.currentTime) || !v.currentTime) return '';
    var s = Math.floor(v.currentTime);
    var m = Math.floor(s / 60), ss = String(s % 60).padStart(2, '0');
    return '看到 ' + m + ':' + ss + ' · ';
  }

  function toast(msg) {
    var el = document.getElementById('toast');
    if (!el) { return; }
    el.textContent = msg;
    el.className = 'on';
    setTimeout(function () { el.className = ''; }, 2200);
  }

  function build() {
    var css = document.createElement('style');
    css.textContent = [
      '#wuwuNoteBtnV{position:fixed;right:18px;bottom:22px;z-index:80;display:none;align-items:center;gap:6px;',
      'font:12px/1 -apple-system,"PingFang SC",sans-serif;letter-spacing:.04em;color:#efe9df;',
      'padding:10px 13px;border-radius:9px;border:1px solid rgba(192,183,156,.36);',
      'background:rgba(16,18,22,.94);box-shadow:0 14px 34px -18px rgba(0,0,0,.9);cursor:pointer;backdrop-filter:blur(8px)}',
      '#wuwuNoteBtnV:hover{border-color:rgba(192,183,156,.7);color:#c0b79c}',
      '#wuwuNotePanelV{position:fixed;right:18px;bottom:64px;z-index:81;display:none;width:min(360px,92vw);',
      'background:#101216;border:1px solid rgba(239,233,223,.14);border-radius:12px;padding:13px 14px;',
      'box-shadow:0 30px 70px -30px rgba(0,0,0,.95);font:12.5px/1.7 -apple-system,"PingFang SC",sans-serif;color:#efe9df}',
      '#wuwuNotePanelV .h{display:flex;align-items:center;gap:8px;margin-bottom:8px}',
      '#wuwuNotePanelV .h b{font-size:13px;letter-spacing:.08em}',
      '#wuwuNotePanelV .h i{font-style:normal;font-size:10.5px;color:#5e5b55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '#wuwuNotePanelV .x{margin-left:auto;background:none;border:0;color:#918c83;cursor:pointer;font:inherit}',
      '#wuwuNotePanelV textarea,#wuwuNotePanelV input{width:100%;box-sizing:border-box;margin-bottom:8px;padding:8px 10px;',
      'font:12.5px/1.7 inherit;color:#efe9df;background:rgba(255,255,255,.04);border:1px solid rgba(239,233,223,.1);',
      'border-radius:7px;outline:none;resize:vertical}',
      '#wuwuNotePanelV .acts{display:flex;gap:8px;justify-content:flex-end}',
      '#wuwuNotePanelV .acts button{font:12px inherit;padding:7px 12px;border-radius:7px;cursor:pointer;border:1px solid rgba(239,233,223,.14);',
      'background:rgba(255,255,255,.03);color:#efe9df}',
      '#wuwuNotePanelV .acts .ok{background:rgba(192,183,156,.16);border-color:rgba(192,183,156,.4);color:#c0b79c}',
    ].join('');
    document.head.appendChild(css);

    btn = document.createElement('button');
    btn.id = 'wuwuNoteBtnV';
    btn.type = 'button';
    btn.innerHTML = '✎ 记一笔';
    btn.title = '边看边记，存进客厅笔记库';
    document.body.appendChild(btn);

    panel = document.createElement('div');
    panel.id = 'wuwuNotePanelV';
    panel.innerHTML =
      '<div class="h"><b>记一笔</b><i id="wuwuNoteSrcV"></i><button class="x" type="button" id="wuwuNoteCloseV">关闭</button></div>' +
      '<textarea id="wuwuNoteBodyV" rows="3" placeholder="看到这里想到什么？"></textarea>' +
      '<input id="wuwuNoteTagsV" placeholder="标签，空格分开">' +
      '<div class="acts"><button type="button" id="wuwuNoteCancelV">算了</button><button class="ok" type="button" id="wuwuNoteSaveV">存下来</button></div>';
    document.body.appendChild(panel);

    bodyBox = panel.querySelector('#wuwuNoteBodyV');
    tagBox = panel.querySelector('#wuwuNoteTagsV');

    btn.addEventListener('click', open);
    panel.querySelector('#wuwuNoteCloseV').addEventListener('click', close);
    panel.querySelector('#wuwuNoteCancelV').addEventListener('click', close);
    panel.querySelector('#wuwuNoteSaveV').addEventListener('click', save);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && panel.style.display === 'block') close();
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && panel.style.display === 'block') save();
    });

    setInterval(function () {
      var pb = document.getElementById('playerBox');
      var show = pb && pb.style.display !== 'none' && !hidden;
      btn.style.display = show ? 'inline-flex' : 'none';
    }, 700);
  }

  function open() {
    var ep = episodeName();
    panel.querySelector('#wuwuNoteSrcV').textContent = videoName() + (ep ? ' · ' + ep : '');
    bodyBox.value = nowTime();
    tagBox.value = '';
    panel.style.display = 'block';
    bodyBox.focus();
  }
  function close() { panel.style.display = 'none'; }

  function save() {
    var ep = episodeName();
    var body = bodyBox.value.trim();
    if (!body) { toast('写一句再存'); return; }
    var b = panel.querySelector('#wuwuNoteSaveV');
    b.disabled = true;
    b.textContent = '存…';
    fetch('/api/notes/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: (videoName() + (ep ? ' · ' + ep : '')).slice(0, 40),
        body: body,
        tags: tagBox.value.trim(),
        sourceKind: 'video',
        sourceLabel: (videoName() + (ep ? ' · ' + ep : '')).slice(0, 80),
        sourceUrl: location.href
      })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) throw new Error(d.message || '存不进去');
      close();
      toast('已存进笔记库');
    }).catch(function (e) {
      toast('没存上：' + (e.message || e));
    }).finally(function () {
      b.disabled = false;
      b.textContent = '存下来';
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
</script>
`;
  const at = html.lastIndexOf('</body>');
  if (at === -1) return html + script;
  return html.slice(0, at) + script + html.slice(at);
}

/* ── 视频房海报代理：/api/vod/img?u=<原始图片地址>
   采集站海报常带防盗链/证书问题，这里统一取一次、落盘缓存，前端只吃本地缓存。 ── */
const VOD_IMG_DIR = path.join(ROOT, 'runtime', 'vod', 'posters');
async function serveVodImage(res, rawUrl) {
  let u = String(rawUrl || '').trim();
  if (!/^https?:\/\//i.test(u)) {
    u = 'https://' + u.replace(/^\/\//, '');
  }
  if (!/^https?:\/\//i.test(u)) return sendJson(res, 400, { ok: false, message: '图片地址不合法' });
  let origin = '';
  try { origin = new URL(u).origin + '/'; } catch { return sendJson(res, 400, { ok: false, message: '图片地址不合法' }); }
  const key = createHash('sha1').update(u).digest('hex');
  const cached = path.join(VOD_IMG_DIR, key + '.img');
  try {
    fs.mkdirSync(VOD_IMG_DIR, { recursive: true });
    const stat = fs.statSync(cached);
    if (stat.size > 0) {
      const typeFile = cached + '.type';
      const ct = fs.existsSync(typeFile) ? fs.readFileSync(typeFile, 'utf8').trim() : 'image/jpeg';
      res.writeHead(200, { 'content-type': ct, 'cache-control': 'public, max-age=86400', 'x-img-cache': 'hit' });
      return fs.createReadStream(cached).pipe(res);
    }
  } catch { /* 没缓存就走网络 */ }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch(u, {
      signal: ctrl.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/157 Safari/537.36', referer: origin, accept: 'image/*,*/*' },
    });
    clearTimeout(timer);
    if (!r.ok) return sendJson(res, 502, { ok: false, message: '海报取不到：HTTP ' + r.status });
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 8 * 1024 * 1024) return sendJson(res, 502, { ok: false, message: '海报体积异常' });
    const ct = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
    if (!/^image\//i.test(ct)) return sendJson(res, 502, { ok: false, message: '不是图片：' + ct });
    try {
      fs.writeFileSync(cached, buf);
      fs.writeFileSync(cached + '.type', ct);
    } catch { /* 缓存失败不影响本次响应 */ }
    res.writeHead(200, { 'content-type': ct, 'content-length': String(buf.length), 'cache-control': 'public, max-age=86400', 'x-img-cache': 'miss' });
    return res.end(buf);
  } catch (e) {
    return sendJson(res, 502, { ok: false, message: '海报取不到：' + (e.message || e) });
  }
}

/* ── 统一外壳：三个旧前端套同一套顶栏/页脚（lib/legacy_shell.mjs 由子代理产出，缺了就原样返回） ── */
let legacyShellMod;
async function applyShellSafe(html, id) {
  try {
    if (legacyShellMod === undefined) {
      legacyShellMod = await import('./lib/legacy_shell.mjs').catch(() => null);
    }
    if (!legacyShellMod || typeof legacyShellMod.applyShell !== 'function') return html;
    return legacyShellMod.applyShell(html, id) || html;
  } catch (e) {
    logLine('legacy shell error: ' + (e.stack || e.message || e));
    return html;
  }
}

/* ── 视频房推荐首页：把 vod-recs.css / vod-recs.js 内联进 /vod/ 页面 ── */
let vodRecsMod;
let vodRecsCache = { css: '', js: '', mtime: 0 };
function readVodRecsAssets() {
  const dir = path.join(ROOT, 'public', 'assets');
  const cssFile = path.join(dir, 'vod-recs.css');
  const jsFile = path.join(dir, 'vod-recs.js');
  let mtime = 0;
  try {
    mtime = Math.max(fs.statSync(cssFile).mtimeMs, fs.statSync(jsFile).mtimeMs);
  } catch {
    return null;
  }
  if (mtime !== vodRecsCache.mtime) {
    vodRecsCache = {
      mtime,
      css: fs.readFileSync(cssFile, 'utf8'),
      js: fs.readFileSync(jsFile, 'utf8'),
    };
  }
  return vodRecsCache;
}

function injectVodRecs(html) {
  const assets = readVodRecsAssets();
  if (!assets) return html;
  let out = html;
  if (out.includes('</head>')) out = out.replace('</head>', `<style>
${assets.css}
</style>
</head>`);
  if (out.includes('</body>')) out = out.replace('</body>', `<script>
${assets.js}
</script>
</body>`);
  return out;
}

async function proxy(req, res, id, app, prefix) {
  const rest = req.url.slice(prefix.length) || '/';
  let target;
  try {
    target = new URL(app.base + rest);
  } catch (e) {
    logLine(`proxy ${id} invalid target url: ${e.message || e}`);
    return proxyError(res, app);
  }

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (['host', 'connection', 'keep-alive', 'transfer-encoding', 'content-length', 'accept-encoding'].includes(k)) continue;
    headers[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  headers['accept-encoding'] = 'identity';
  headers['x-forwarded-host'] = req.headers.host || '';
  headers['x-forwarded-prefix'] = prefix;

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = await readRaw(req);
    headers['content-length'] = String(body.length);
  }

  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });

  let r;
  try {
    r = await fetch(target, {
      method: req.method,
      headers,
      body,
      redirect: 'manual',
      signal: ac.signal,
    });
  } catch (e) {
    logLine(`proxy ${id} error: ${e.message || e}`);
    return proxyError(res, app);
  }

  const ct = (r.headers.get('content-type') || '').toLowerCase();
  const disposition = r.headers.get('content-disposition') || '';
  const m3u8 = /mpegurl|m3u8/.test(ct) || /\.m3u8(\?|$)/i.test(target.pathname + target.search);
  const isText = !/attachment/i.test(disposition) && (
    /text\/html/.test(ct) ||
    /javascript|ecmascript/.test(ct) ||
    /application\/json|\+json/.test(ct) ||
    m3u8 ||
    /text\/plain/.test(ct) && m3u8
  );

  const outHeaders = {};
  for (const [k, v] of r.headers) {
    if (['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive'].includes(k)) continue;
    if (k === 'location' && v.startsWith('/')) {
      outHeaders[k] = prefix + v;
      continue;
    }
    outHeaders[k] = v;
  }
  const cookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  if (cookies.length) outHeaders['set-cookie'] = cookies;

  if (isText) {
    // HEAD 没有响应体，保留上游的 content-length，不能按空 body 重算成 0
    if (req.method === 'HEAD') {
      const len = r.headers.get('content-length');
      if (len) outHeaders['content-length'] = len;
      res.writeHead(r.status, outHeaders);
      return res.end();
    }
    let text;
    try {
      text = await r.text();
    } catch (e) {
      logLine(`proxy ${id} read error: ${e.message || e}`);
      return proxyError(res, app);
    }
    const rewritten = rewriteText(text, prefix, REWRITE[id] || [], m3u8);
    let finalText = rewritten;
    if (/text\/html/.test(ct)) {
      if (id === 'magnet') finalText = injectMagnetDownload(finalText);
      if (id === 'vod') {
        finalText = injectVodNote(finalText);
        finalText = injectVodRecs(finalText);
      }
      // 三个旧前端统一外壳：顶栏「← 回客厅」、房名、页脚（内部 DOM 与脚本一律不动）
      finalText = await applyShellSafe(finalText, id);
    }
    const buf = Buffer.from(finalText, 'utf8');
    outHeaders['content-length'] = String(buf.length);
    res.writeHead(r.status, outHeaders);
    return res.end(buf);
  }

  const len = r.headers.get('content-length');
  if (len) outHeaders['content-length'] = len;
  res.writeHead(r.status, outHeaders);
  if (req.method === 'HEAD' || !r.body) return res.end();
  // 客户端提前断开时，反向代理的上游流会抛 AbortError；不接住会让整个客厅进程退出。
  let responseStream;
  try {
    responseStream = Readable.fromWeb(r.body);
  } catch (e) {
    logLine('proxy body error: ' + (e.message || e));
    return res.end();
  }
  responseStream.on('error', (e) => {
    if (e && e.name !== 'AbortError') logLine('proxy stream error: ' + (e.message || e));
    if (!res.writableEnded) res.end();
  });
  res.on('close', () => {
    if (!responseStream.destroyed) responseStream.destroy();
  });
  responseStream.pipe(res);
}

/* ───────────────────────── HTTP ───────────────────────── */

// 新房模块要在开始接客之前挂好（缺模块不影响启动，只会那间房报「还没装好」）
await loadRooms();

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (e) {
    logLine('invalid request url: ' + req.url);
    return sendJson(res, 400, { ok: false, message: '请求路径不合法' });
  }
  const p = url.pathname;

  try {
    if (p === '/' || p === '/五五客厅') {
      return sendHtml(res, fs.readFileSync(PAGE_FILE));
    }

    if (p === '/book' || p === '/book/') {
      return sendHtml(res, fs.readFileSync(BOOK_FILE));
    }

    if (p === '/api/status') {
      return sendJson(res, 200, await allStatus());
    }

    if (p === '/api/book/info') {
      return sendJson(res, 200, Object.assign({ ok: true }, await bookInfo()));
    }

    if (p === '/api/book/ensure' && req.method === 'POST') {
      const ok = await ensureReaderWeb();
      bookCache.t = 0;
      return sendJson(res, ok ? 200 : 503, {
        ok,
        webRunning: ok,
        message: ok ? '书房引擎已就绪' : '书房引擎没有起来，请确认 Reader.app 已安装且 Web 阅读服务已启用',
      });
    }

    if (p === '/api/book/search-start' && req.method === 'POST') {
      const body = await readBody(req);
      const q = String(body.q || '').trim();
      if (!q) return sendJson(res, 400, { ok: false, message: '缺少书名或作者' });
      const job = startBookSearchJob(q);
      return sendJson(res, 200, { ok: true, job: publicJob(job) });
    }

    if (p === '/api/book/search-status') {
      const id = (url.searchParams.get('job') || '').trim();
      const job = searchJobs.get(id);
      if (!job) return sendJson(res, 404, { ok: false, message: '搜书任务不存在或已过期' });
      return sendJson(res, 200, { ok: true, job: publicJob(job) });
    }

    // 同源代理：书房搜书先尝试委托 Reader 客户端接口。
    // 勘查结论：1122 只注册了书架/目录/书源管理等 axum 路由，搜书命令仅存在于 Tauri IPC
    // （search_book_multi_sse 等），外部 HTTP 无法调起；这里回落本地多源引擎，复用 Reader 书源规则。
    if (p === '/api/book/reader/search') {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const q = String(body.q || body.key || url.searchParams.get('q') || '').trim();
      if (!q) return sendJson(res, 400, { ok: false, message: '缺少书名或作者关键词' });
      let readerRunning = false;
      try {
        const health = await probeReaderHealth(1200);
        readerRunning = !!health.ok;
      } catch (e) {
        logLine('reader health probe failed: ' + (e && e.message ? e.message : e));
      }
      try {
        const result = await searchAllSources(q, { concurrency: 120, timeout: 4500, limit: 220 });
        return sendJson(res, 200, {
          ok: true,
          query: q,
          readerRunning,
          readerRouteFound: READER_SEARCH_FACTS.httpRouteFound,
          source: 'local-multi-source',
          note: READER_SEARCH_FACTS.note,
          items: result.items,
          stats: result.stats,
        });
      } catch (e) {
        logLine('reader proxy search error: ' + (e.stack || e.message || e));
        return sendJson(res, 502, {
          ok: false,
          items: [],
          message: '书房搜书失败：' + (e.message || e),
        });
      }
    }

    // 保留同步接口给脚本/旧页面；新书房页走上面的任务接口，避免一次请求挂太久。
    if (p === '/api/book/search-books') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return sendJson(res, 200, { ok: true, items: [], query: '' });
      try {
        const result = await searchAllSources(q, { concurrency: 120, timeout: 4500, limit: 220 });
        return sendJson(res, 200, {
          ok: true,
          items: result.items,
          query: q,
          source: '全部书源',
          stats: result.stats,
        });
      } catch (e) {
        logLine('book title search error: ' + (e.stack || e.message || e));
        return sendJson(res, 502, { ok: false, items: [], message: '搜书失败：' + (e.message || e) });
      }
    }

    if (p === '/api/book/search') {
      const q = (url.searchParams.get('q') || '').trim();
      const group = (url.searchParams.get('group') || '').trim();
      if (group) {
        return sendJson(res, 200, { ok: true, items: await bookGroup(group), group });
      }
      if (!q) return sendJson(res, 200, { ok: true, items: [], query: '' });
      return sendJson(res, 200, { ok: true, items: await bookSearch(q), query: q });
    }

    if (p === '/api/book/shelf') {
      try {
        if (!(await ensureReaderWeb())) throw new Error('书房引擎没有起来');
        const items = await readerShelf();
        const info = await bookInfo();
        return sendJson(res, 200, { ok: true, items, sources: info.sources, groups: info.groupTotal });
      } catch (e) {
        return sendJson(res, 502, { ok: false, items: [], message: e.message || String(e) });
      }
    }

    if (p === '/api/book/open' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        if (!(await ensureReaderWeb())) throw new Error('书房引擎没有起来');
        const out = await openBookWithSources(body);
        return sendJson(res, 200, Object.assign({ ok: true }, out));
      } catch (e) {
        logLine('book open error: ' + (e.stack || e.message || e));
        return sendJson(res, 502, { ok: false, message: '打开这本书失败：' + (e.message || e) });
      }
    }

    if (p === '/api/book/chapter' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        if (!(await ensureReaderWeb())) throw new Error('书房引擎没有起来');
        const out = await readChapter(body);
        return sendJson(res, 200, Object.assign({ ok: true }, out));
      } catch (e) {
        logLine('book chapter error: ' + (e.stack || e.message || e));
        return sendJson(res, 502, { ok: false, message: '取正文失败：' + (e.message || e) });
      }
    }

    if (p === '/api/book/progress' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        await saveReadingProgress(body);
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 502, { ok: false, message: e.message || String(e) });
      }
    }

    if (p === '/api/start' && req.method === 'POST') {
      const body = await readBody(req);
      const id = body.id || url.searchParams.get('id');
      const r = startApp(id);
      return sendJson(res, r.ok ? 200 : 400, r);
    }

    if (p === '/api/start-all' && req.method === 'POST') {
      const results = {};
      for (const id of ORDER) {
        if (!apps[id]) continue;
        if (id === 'book' || apps[id].kind === 'web') results[id] = startApp(id);
      }
      return sendJson(res, 200, { ok: true, results });
    }

    if (p === '/api/stop' && req.method === 'POST') {
      const body = await readBody(req);
      const id = body.id || url.searchParams.get('id');
      const r = stopApp(id);
      return sendJson(res, r.ok ? 200 : 400, r);
    }

    if (p === '/api/reader/open' && req.method === 'POST') {
      const b = await bookInfo();
      if (!b.installed) return sendJson(res, 400, { ok: false, message: '没有找到 Reader.app' });
      execFile('/usr/bin/open', ['-a', 'Reader'], (err) => {
        if (err) logLine('open reader failed: ' + err.message);
      });
      return sendJson(res, 200, { ok: true, message: '正在打开阅读器' });
    }

    if (p === '/api/ping') {
      return sendJson(res, 200, { ok: true, service: 'wuwu-living-room', port: PORT, ts: Date.now() });
    }

    /* 站点图标：浏览器会自动请求 /favicon.ico，这里统一给一个，避免 404 噪音 */
    if (p === '/favicon.ico' || p === '/favicon.svg' || p === '/apple-touch-icon.png') {
      try {
        const icon = fs.readFileSync(path.join(ROOT, 'public', 'favicon.svg'));
        res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=604800' });
        return res.end(icon);
      } catch {
        res.writeHead(204).end();
        return;
      }
    }

    /* ── 首页概览：天气 / 待办 / 下载 / 在读 / 追更 ── */
    if (p === '/api/home/summary') {
      const summary = await homeSummary({ apps, allStatus, bookInfo });
      return sendJson(res, 200, summary);
    }

    if (p === '/api/home/todos' || p.startsWith('/api/home/todos/')) {
      const handled = await homeTodos(req, res, url);
      if (handled) return;
    }

    /* ── 视频房海报：统一代理 + 落盘缓存 ── */
    if (p === '/api/vod/img') {
      return serveVodImage(res, url.searchParams.get('u') || '');
    }

    /* ── 视频房推荐首页：真实采集站数据，10 分钟缓存 ── */
    if (p === '/api/vod/recs') {
      try {
        vodRecsMod = vodRecsMod || await import('./lib/vod_recs.mjs').catch(() => null);
        if (!vodRecsMod || typeof vodRecsMod.vodRecs !== 'function') {
          return sendJson(res, 200, { ok: false, message: '推荐模块还没装好' });
        }
        const data = await vodRecsMod.vodRecs();
        return sendJson(res, 200, data);
      } catch (e) {
        logLine('vod recs error: ' + (e.stack || e.message || e));
        return sendJson(res, 200, { ok: false, message: '推荐数据没取到：' + (e.message || e) });
      }
    }

    /* ── 后装的五间新房：页面、接口、静态资源都从这里进 ── */
    if (await roomRoutes(req, res, url)) return;

    // 三个 Web 项目：同一个端口下的三条通道
    for (const id of ['magnet', 'music', 'vod']) {
      const app = apps[id];
      if (!app) continue;
      const prefix = prefixOf(id, app);
      if (p === prefix) {
        return res.writeHead(308, { location: prefix + '/' + url.search }).end();
      }
      if (p.startsWith(prefix + '/')) {
        return proxy(req, res, id, app, prefix);
      }
    }

    // 走到这里说明没人处理；但如果前面已经有响应写出去了（比如模块发了一半），
    // 就绝不能再补一个 404，否则会 ERR_HTTP_HEADERS_SENT。
    if (res.headersSent || res.writableEnded) return;
    return sendJson(res, 404, { ok: false, message: '没有这个页面' });
  } catch (e) {
    logLine('http error: ' + (e && e.stack ? e.stack : e));
    if (!res.headersSent) {
      return sendJson(res, 500, { ok: false, message: '客厅内部出错了：' + String(e.message || e) });
    }
    res.destroy();
  }
});

server.listen(PORT, BIND, () => {
  console.log(`五五客厅  →  http://${BIND === '0.0.0.0' ? '127.0.0.1' : BIND}:${PORT}`);
  console.log(`  /magnet/  /music/  /vod/  /book/`);
  console.log(`  /download/  /library/  /notes/  /calendar/  /photos/`);
});
