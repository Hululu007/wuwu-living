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
import { searchAllSources, getSourceStats, ensureSourceCache, groupBooks, groupKeyOf, getSourceByUrl, awaitSourceCache } from './lib/book_source_search.mjs';
import { appendLog as _appendLog, logPath as _logPath } from './lib/log_dir.mjs';
import { searchdHealth, healthCacheSnapshot, searchViaSearchd, searchdBase } from './lib/book_searchd.mjs';
import { raceOpenViaSearchd, chapterContentViaSearchd } from './lib/book_open_searchd.mjs';
import { bookInfo as engineBookInfo, chapterList as engineChapterList, chapterContent as engineChapterContent, warmup as engineWarmup } from './lib/legado/index.mjs';
import { READER_SEARCH_FACTS, probeReaderHealth, probeRoute } from './lib/reader_api.mjs';
import { rankSources, remainingBudget, recordOutcome, shouldSwitchFor } from './lib/book_sched.mjs';
import { raceOpen } from './lib/book_race.mjs';
import { warmOnSearchHits } from './lib/book_warm.mjs';
import { loadRooms, roomRoutes, roomSummaries, roomsReady, ROOM_LIST } from './lib/rooms.mjs';
import { readJson, readRaw as readRawBytes, BodyError } from './lib/http_body.mjs';
import { writeJsonSync } from './lib/json_store.mjs';
import { acquireInstanceLock, installInstanceLockCleanup } from './lib/instance_lock.mjs';
import { homeSummary, homeTodos } from './lib/home.mjs';
import { readShelf, addToShelf, removeFromShelf, touchShelfProgress } from './lib/book_shelf.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// 同一 runtime/ 只允许一个可写实例。旧实现只靠 per-path Promise 链 + 原子 rename，
// 进程内安全，但第二个进程启动后各自持有独立 cache，read-modify-write 会互相覆盖
// （实测 2 进程各 100 次只剩约 100 条）。实验实例必须另给 WUWU_RUNTIME_DIR。
const RUNTIME_DIR = process.env.WUWU_RUNTIME_DIR
  ? path.resolve(process.env.WUWU_RUNTIME_DIR)
  : path.join(ROOT, 'runtime');
const INSTANCE_LOCK = path.join(RUNTIME_DIR, '.instance.lock');
if (process.env.WUWU_ALLOW_MULTI_INSTANCE !== '1') {
  try {
    acquireInstanceLock(INSTANCE_LOCK, { label: '五五客厅' });
    installInstanceLockCleanup(INSTANCE_LOCK);
  } catch (e) {
    console.error(`[boot] ${e.message || e}`);
    process.exit(78); // EX_CONFIG：配置/部署错误，不是服务内部异常
  }
}

// 进程级兜底：规则引擎个别源在请求构造/定时器里可能抛异常，记录后留在进程内，绝不让单源异常打挂主线程。
// ★ 2026-11-22 修正（隔离端口实测的僵尸态）：原实现吞掉所有 uncaught，
// 连 listen EADDRINUSE 也被吞 —— 实测 PORT=19080 被占时进程 state=S 继续存活、
// 端口由别人响应、日志只留一行 uncaught，launchd 的 KeepAlive=1 因进程还在
// 而不会重启，于是"state=running 但服务不可用"。
// 现在只吞非致命异常（规则引擎个别源偶发抛错），端口类致命错误必须非 0 退出。
const FATAL_EXIT_CODES = new Set(['EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL']);
process.on('uncaughtException', (err) => {
  // 崩溃兜底必须写在持久目录：/tmp 会被系统清理，证据会在被查到之前消失（2026-11-22）
  try { _appendLog('book-search.log', `[${new Date().toISOString()}] uncaught: ${err && err.message ? err.message : err}\n`); } catch { /* ignore */ }
  if (err && FATAL_EXIT_CODES.has(err.code)) {
    try { _appendLog('book-search.log', `[${new Date().toISOString()}] fatal: ${err.code} → exit(1) 让 launchd 重启\n`); } catch { /* ignore */ }
    console.error(`[fatal] ${err.code}：端口类致命错误，以 exit=1 退出以便 launchd 重启`);
    process.exit(1);
  }
});
process.on('unhandledRejection', (err) => {
  try { _appendLog('book-search.log', `[${new Date().toISOString()}] unhandled rejection: ${err && err.message ? err.message : err}\n`); } catch { /* ignore */ }
});

const bootStartedAt = Date.now();
const PORT = Number(process.env.PORT || 8890);
const LAN = process.argv.includes('--lan');
const BIND = process.env.BIND || (LAN ? '0.0.0.0' : '127.0.0.1');

const CONFIG_FILE = path.join(ROOT, 'config', 'apps.json');
const PAGE_FILE = path.join(ROOT, 'public', '五五客厅.html');
const BOOK_FILE = path.join(ROOT, 'public', '书房.html');
// 静态页启动期读入内存，请求处理路径上不再做同步文件读。
// ★ 2026-11-22：这两页是「启动快照」——改了磁盘不重启就不生效。
//   今天因此误判过多次（有人改完首页以为立刻生效、有人拿 mtime 判生效）。
//   现在把「快照时刻」记下来，经 /api/ping 暴露，让「改了≠生效」变成可读信号。
const PAGE_HTML = fs.readFileSync(PAGE_FILE, 'utf8');
const BOOK_HTML = fs.readFileSync(BOOK_FILE, 'utf8');
const SNAPSHOT_AT = Date.now();
const SNAPSHOT_MTIME = (() => {
  try {
    return {
      '五五客厅.html': fs.statSync(PAGE_FILE).mtimeMs,
      '书房.html': fs.statSync(BOOK_FILE).mtimeMs,
    };
  } catch { return {}; }
})();
const ACTION_LOG = _logPath('actions.log');

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
const staticPageCache = new Map();
const STATIC_PAGE_TTL = 5000;
// 书房状态缓存。ttl 从原来的 12s（Reader 未跑时）/45s 统一提到 300s：
// 旧值 12 秒等于没缓存——用户每 12 秒就撞一次 2.5–3.2 秒的 python 查询。
// 书籍/书源数据不是秒级变化的，5 分钟足够；过期也只在后台补，请求路径不再等。
const bookCache = { t: 0, data: null, pending: null, ttl: 300 * 1000, failed: false, lastError: null };
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

function roomBootPlaceholder(roomId) {
  const room = ROOM_LIST.find((r) => r.id === roomId);
  const name = room?.name || roomId;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name} · 加载中</title><style>body{margin:0;min-height:100vh;background:#151311;color:#d8d2c7;display:grid;place-items:center;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif}main{text-align:center;padding:24px}h1{font-size:18px;font-weight:600;margin:0 0 10px}p{font-size:13px;color:#8b8b8b;margin:0}</style></head><body><main><h1>${name}</h1><p>房间加载中，稍后再试…</p></main></body></html>`;
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

// 请求体读取统一走 lib/http_body.mjs：按 Buffer 拼（不切坏跨块汉字）、
// 超限抛 413、非法 JSON 抛 400，都由顶层 catch 映射成真正的错误码。
function readBody(req) {
  return readJson(req, { limit: 64 * 1024 });
}

function readRaw(req, limit = 8 * 1024 * 1024) {
  return readRawBytes(req, { limit });
}

function logLine(msg) {
  try {
    fs.appendFileSync(ACTION_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

// 引擎慢调用告警：任一阶段 >3s 记录源名/阶段/结果/耗时，异常不吞。
async function timedEngine(stage, source, fn) {
  const t0 = Date.now();
  let res;
  try {
    res = await fn();
  } catch (error) {
    const ms = Date.now() - t0;
    if (ms > 3000) {
      logLine(`慢调用[${stage}] ${source?.name || source?.url || ''} 异常 ${ms}ms: ${error?.message || error}`);
    }
    throw error;
  }
  const ms = res?.ms != null ? res.ms : Date.now() - t0;
  if (ms > 3000) {
    logLine(`慢调用[${stage}] ${source?.name || source?.url || ''} ${res?.ok ? 'OK' : 'FAIL'} ${ms}ms${res?.error ? ' ' + res.error : ''}`);
  }
  return res;
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

/**
 * 探活：带熔断，避免「上游 accept 了却不回包」把首页一起拖死。
 *
 * 实测背景：8811（音乐房）会出现「端口在听、进程 STAT=S、%CPU=1.7、accept 后不回包」的挂起态，
 * 直打根路径 8s 超时 3/3 全超。客厅若每次都等满超时，首页每条请求白付这笔钱。
 *
 * 三条纪律：
 *   1. 超时默认 800ms（不是 1800/5000）——上游健康时响应是 1–20ms，800ms 足够宽容；
 *   2. 连续 2 次失败即开熔断，60s 内直接返回 degraded，不再发请求；
 *   3. 熔断期一律如实带 `degraded:true`，界面能据此说「状态未知」而不是假装「已停止」。
 */
const probeBreaker = new Map(); // base -> { fails, openUntil, lastMs, lastCode }
const PROBE_BREAKER_FAILS = 2;
const PROBE_BREAKER_MS = 60 * 1000;
const PROBE_OK_TTL = 8 * 1000; // 成功探测结果缓存 8s（music 首打 707ms，不该每请求都付）

function probeBreakerState(base) {
  const b = probeBreaker.get(base);
  if (b && b.openUntil && Date.now() < b.openUntil) return b;
  return null;
}

/**
 * 真正发一次探测请求（会等）。
 * 只有两个地方可以调它：① 熔断关闭时的前台探测（用户主动看状态）；
 * ② 熔断到期后的**后台**半开探测（绝不在请求路径上等）。
 */
function probeFetch(base, healthPath, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  const t0 = process.hrtime.bigint();
  return fetch(base + healthPath, { signal: ac.signal, cache: 'no-store' })
    .then((r) => {
      const prev = probeBreaker.get(base) || { fails: 0 };
      // 5xx 也算失败：能回包但服务不可用，同样不该反复探测
      if (r.status >= 500) {
        probeBreaker.set(base, Object.assign({}, prev, { fails: (prev.fails || 0) + 1, openUntil: 0, lastCode: r.status }));
      } else {
        // 一次成功即清零，但**保留记录本身**：直接 delete 会把 inflight/halfOpenPending 一起抹掉，
        // 导致并发请求各自新发一次探测（实测 3 个并发各等 666–792ms，正是这个 bug）。
        probeBreaker.set(base, Object.assign({}, prev, { fails: 0, openUntil: 0, lastCode: r.status }));
      }
      return {
        running: r.status < 500,
        status: r.status,
        ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6),
        degraded: false,
      };
    })
    .catch(() => {
      const prev = probeBreaker.get(base) || { fails: 0 };
      const fails = (prev.fails || 0) + 1;
      const openUntil = fails >= PROBE_BREAKER_FAILS ? Date.now() + PROBE_BREAKER_MS : 0;
      probeBreaker.set(base, Object.assign({}, prev, { fails, openUntil, lastCode: 0 }));
      return { running: false, status: 0, ms: null, degraded: fails >= PROBE_BREAKER_FAILS, breakerOpen: openUntil > 0 };
    })
    .finally(() => clearTimeout(timer));
}

/**
 * 探活（请求路径用）。**保证不会为同一个上游等待两次**：
 *   · 熔断开着 → 立刻返回 degraded；
 *   · 熔断刚好到期 → 立刻返回 degraded，同时**后台**半开探测（这次不付 800ms）；
 *   · 有在途探测 → 复用它的 Promise，不重复发请求；
 *   · 否则前台探一次（只有「从没失败过」的正常状态会走这里，代价 ~10ms）。
 */
function probe(base, healthPath = '/', ms = 800) {
  const open = probeBreakerState(base);
  if (open) {
    const left = Math.max(0, open.openUntil - Date.now());
    // 还没到期且没在途探测：直接短路
    if (left > 0) {
      return Promise.resolve({
        running: false, status: 0, ms: null,
        degraded: true, breakerOpen: true, retryInMs: left,
      });
    }
  }
  // 到了半开时刻：先给结论，后台去探。这样周期性的 800ms 不会打到任何请求上。
  const state = probeBreaker.get(base);
  if (state && state.openUntil) {
    if (!state.halfOpenPending) {
      state.halfOpenPending = probeFetch(base, healthPath, ms).finally(() => {
        const cur = probeBreaker.get(base);
        if (cur) cur.halfOpenPending = null;
      });
    }
    return Promise.resolve({
      running: false, status: 0, ms: null,
      degraded: true, breakerOpen: true, retryInMs: 0,
    });
  }
  // 正常状态：若已有同上游在途探测，复用它（并发只发一次请求）
  const cur0 = probeBreaker.get(base) || { fails: 0, openUntil: 0 };
  if (cur0.inflight) return cur0.inflight;
  // 成功结果也缓存：music 首打实测 707ms（它 accept 后要等半秒才回包），
  // 而进程重启后每个首页请求都付一次这笔钱。8s 内的成功结果直接复用。
  if (cur0.okAt && Date.now() - cur0.okAt < PROBE_OK_TTL && cur0.okResult) {
    return Promise.resolve(Object.assign({}, cur0.okResult, { cached: true }));
  }
  // 自己那一层 promise 才是 inflight：外面包一层 finally 清引用，
  // 但返回给调用方的是同一个 promise，所以并发方拿到的是它、不会新发请求。
  const task = probeFetch(base, healthPath, ms).then((r) => {
    if (r && r.running) {
      const cur = probeBreaker.get(base);
      if (cur) { cur.okAt = Date.now(); cur.okResult = r; }
    }
    return r;
  }).finally(() => {
    const cur = probeBreaker.get(base);
    if (cur && cur.inflight === task) cur.inflight = null;
  });
  cur0.inflight = task;
  probeBreaker.set(base, cur0);
  return task;
}

/** 用户手动「启动/停止」后立刻允许重新探测，别让 60s 熔断挡住操作 */
function resetProbeBreaker(base) {
  if (base) probeBreaker.delete(base);
  else probeBreaker.clear();
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
    env.PATH = '/usr/local/bin:' + (env.PATH || process.env.PATH || '');
    delete env.PORT; // hub 自身监听端口不应泄漏给子 Web 脚本，避免子进程抢绑 8890
    const child = spawn('/bin/bash', [script, arg], {
      cwd: app.dir,
      detached: true,
      stdio: 'ignore',
      env,
    });
    child.unref();
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) logLine(`spawn ${app.script} ${arg} exited code ${code}`);
    });
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

// pgrep 结果缓存：每次 fork 一个进程实测 0.24s（20 次采样 p50=131ms、max=358ms），
// 而进程存在与否是秒级事实。60s 内复用结果，避免首页每条请求都白付一次 fork。
const procRunCache = new Map(); // name -> { at, value, pending }
const PROC_RUN_TTL = 60 * 1000;

function processRunning(name, ttl = PROC_RUN_TTL) {
  const hit = procRunCache.get(name);
  if (hit && hit.value != null && Date.now() - hit.at < ttl) return Promise.resolve(hit.value);
  if (hit && hit.pending) return hit.pending;
  const task = new Promise((resolve) => {
    execFile('/usr/bin/pgrep', ['-xq', name], (err) => resolve(!err));
  }).then((value) => {
    procRunCache.set(name, { at: Date.now(), value, pending: null });
    return value;
  });
  procRunCache.set(name, { at: hit ? hit.at : 0, value: hit ? hit.value : null, pending: task });
  return task;
}

/** 状态变更后主动让进程探测失效（启动/停止项目时用），避免缓存拖住用户操作 */
function invalidateProcessRunning(name) {
  if (name) procRunCache.delete(name);
  else procRunCache.clear();
}

/**
 * 取一次书房状态（贵路径）。只在「后台刷新」里被调用，绝不在请求路径上同步等。
 *
 * 实测成本（20+ 次采样）：
 *   reader_query.py 查 28MB sqlite：1.9–2.9s（其中 groups 全表 json 解析占 0.5–1.1s）
 *   pgrep -xq Reader：p50=131ms / max=358ms
 *   curl 1122（无监听）：ECONNREFUSED 1–80ms（不是等满 1500ms 超时）
 */
async function bookInfoFetch() {
  const app = apps.book || {};
  const bundle = app.bundle || 'Reader';
  const db = app.db || '';
  const installed = fs.existsSync(`/Applications/${bundle}.app`);
  const appRunning = installed ? await processRunning(bundle) : false;
  const webRunning = installed ? await readerHealth() : false;

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

  return {
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
}

/**
 * 后台刷新书房状态：并发只跑一份，失败保留旧值（不把界面打空）。
 * 结构照抄 lib/home.mjs 的 weatherForSummary()：旧值先用、后台补新、如实标 stale。
 */
function kickBookRefresh() {
  if (bookCache.pending) return bookCache.pending;
  const task = bookInfoFetch()
    .then((data) => {
      bookCache.t = Date.now();
      bookCache.data = data;
      bookCache.failed = false;
      return data;
    })
    .catch((e) => {
      bookCache.failed = true;
      bookCache.lastError = e && (e.message || String(e));
      logLine('bookInfo 后台刷新失败: ' + bookCache.lastError);
      return bookCache.data || null;
    })
    .finally(() => {
      if (bookCache.pending === task) bookCache.pending = null;
    });
  bookCache.pending = task;
  return task;
}

/**
 * 书房状态：**永不阻塞请求路径**。
 * 有值立刻给（过期就带 stale 并在后台补），没值立刻给 pending 占位并在后台去取。
 */
async function bookInfo() {
  const ttl = bookCache.ttl || 300000;
  if (bookCache.data) {
    // bookCache.t = 0 是「标记过期」而不是「时间戳」：直接算 Date.now()-0 会得出
    // 1795338328630ms（epoch 差值）这种假 age。这里把 0 视作「已过期、未知年龄」。
    const age = bookCache.t > 0 ? Date.now() - bookCache.t : null;
    const expired = age === null || age >= ttl;
    if (expired) {
      void kickBookRefresh();
      return Object.assign({}, bookCache.data, { stale: true, ageMs: age });
    }
    return Object.assign({}, bookCache.data, { stale: false, ageMs: age });
  }
  void kickBookRefresh();
  if (bookCache.failed) {
    // 明确失败过：如实说没取到，别一直挂着「正在获取」
    return {
      installed: fs.existsSync(`/Applications/${apps.book?.bundle || 'Reader'}.app`),
      running: false,
      webRunning: false,
      appRunning: false,
      sources: null,
      lastBook: '',
      todaySeconds: 0,
      todayMinutes: 0,
      groups: [],
      groupTotal: 0,
      searchable: null,
      searchRules: null,
      engine: 'Reader 书源引擎',
      apiBase: READER_BASE,
      ok: false,
      pending: false,
      stale: true,
      message: '书房状态没取到：' + (bookCache.lastError || '未知原因'),
    };
  }
  return {
    installed: fs.existsSync(`/Applications/${apps.book?.bundle || 'Reader'}.app`),
    running: false,
    webRunning: false,
    appRunning: false,
    sources: null,
    lastBook: '',
    todaySeconds: 0,
    todayMinutes: 0,
    groups: [],
    groupTotal: 0,
    searchable: null,
    searchRules: null,
    engine: 'Reader 书源引擎',
    apiBase: READER_BASE,
    pending: true,
    stale: true,
    message: '书房状态正在获取',
  };
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

/**
 * 书源分组明细。从 bookInfo 里拆出来的：只有书房「浏览书源」弹层用得到，
 * 却让每次 info 都付 0.5–1.1 秒的全表 json 解析。按需拉 + 60s 缓存。
 */
const bookGroupsCache = { t: 0, data: null, pending: null };
const BOOK_GROUPS_TTL = 60 * 1000;

function bookGroups() {
  const hit = bookGroupsCache.data && Date.now() - bookGroupsCache.t < BOOK_GROUPS_TTL;
  if (hit) return Promise.resolve(bookGroupsCache.data);
  if (bookGroupsCache.pending) return bookGroupsCache.pending;
  const app = apps.book || {};
  const empty = { groups: [], error: '书房数据库不可用' };
  const task = (async () => {
    if (!app.db || !fs.existsSync(app.db)) return empty;
    const r = await readerQuery(app.db, 'groups');
    const groups = r && Array.isArray(r.groups) ? r.groups : [];
    const out = { groups, total: groups.length };
    bookGroupsCache.t = Date.now();
    bookGroupsCache.data = out;
    return out;
  })()
    .catch((e) => {
      logLine('bookGroups error: ' + (e.message || e));
      return bookGroupsCache.data || empty;
    })
    .finally(() => {
      if (bookGroupsCache.pending === task) bookGroupsCache.pending = null;
    });
  bookGroupsCache.pending = task;
  return task;
}

/* ───────────────────── 书房：搜索 + Reader 内容引擎 ───────────────────── */

const READER_BASE = (apps.book && apps.book.base) || 'http://127.0.0.1:1122';
const BOOK_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/* ★ 2026-11-20：五五客厅不启动 Reader.app。
   书房永远用本地多源引擎；只有在 Reader 已经自己运行时，才把它的 Web 引擎当兜底。
   这里不保留任何 `open -a Reader` 的路径。 */

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

/* ───────────── 番茄热榜（推荐页数据） ───────────── */

const FANQIE_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const FANQIE_TTL_MS = 10 * 60 * 1000;
const FANQIE_CACHE_FILE = path.join(RUNTIME_DIR, 'fanqie_recommend.json');
const fanqieCache = { t: 0, items: [], updatedAt: 0 };
let fanqiePending = null;

async function fanqieGetJson(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': FANQIE_UA, accept: 'application/json, text/plain, */*' },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`番茄接口 HTTP ${res.status}`);
  return res.json();
}

function fanqieBook(raw, tag) {
  const bookId = String(raw.bookId || raw.book_id || '');
  const name = cleanText(raw.bookName || raw.book_name || '');
  if (!bookId || !name) return null;
  return {
    id: bookId,
    name,
    author: cleanText(raw.author || '') || '佚名',
    abstract: cleanText(raw.abstract || raw.book_abstract || '').slice(0, 160),
    cover: cleanText(raw.thumbUri || raw.thumb_url || raw.cover || ''),
    url: `https://fanqienovel.com/page/${bookId}`,
    tag,
  };
}

function readFanqieFile() {
  try {
    const data = JSON.parse(fs.readFileSync(FANQIE_CACHE_FILE, 'utf8'));
    return { items: Array.isArray(data.items) ? data.items : [], updatedAt: Number(data.updatedAt) || 0 };
  } catch {
    return { items: [], updatedAt: 0 };
  }
}

async function fanqieRecommend(force = false) {
  if (!force && fanqieCache.items.length && Date.now() - fanqieCache.t < FANQIE_TTL_MS) {
    return { items: fanqieCache.items, updatedAt: fanqieCache.updatedAt, stale: false };
  }
  if (fanqiePending) return fanqiePending;
  fanqiePending = (async () => {
    const urls = [
      ['https://fanqienovel.com/api/rank/recommend/list', '番茄推荐'],
      ['https://fanqienovel.com/api/rank/list?rank_type=1', '人气榜'],
    ];
    const lists = await Promise.all(urls.map(async ([url, tag]) => {
      try {
        const json = await fanqieGetJson(url);
        const data = (json && json.data) || {};
        const list = Array.isArray(data.list) ? data.list : [];
        return list.map((x) => fanqieBook(x, tag)).filter(Boolean);
      } catch (e) {
        logLine('fanqie list failed: ' + (e.message || e));
        return [];
      }
    }));
    const seen = new Set();
    const items = [];
    for (const list of lists) {
      for (const book of list) {
        const key = book.id || `${book.name}|${book.author}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(book);
      }
    }
    if (items.length) {
      fanqieCache.t = Date.now();
      fanqieCache.items = items;
      fanqieCache.updatedAt = Date.now();
      try {
        // 直写目标文件时被杀 → 半截 JSON → 下次解析失败，推荐位空一整个 TTL。
        // 走 json_store 的临时名 + rename，中断也保得住旧缓存。
        writeJsonSync(FANQIE_CACHE_FILE, { updatedAt: fanqieCache.updatedAt, items });
      } catch { /* 缓存落盘失败不影响展示 */ }
      return { items, updatedAt: fanqieCache.updatedAt, stale: false };
    }
    const fallback = readFanqieFile();
    return { items: fallback.items, updatedAt: fallback.updatedAt, stale: true };
  })();
  try {
    return await fanqiePending;
  } finally {
    fanqiePending = null;
  }
}

/* ───────────── 书籍详情/目录磁盘缓存 + 打开链路健康 ───────────── */

const BOOKS_DIR = path.join(RUNTIME_DIR, 'books');
const BOOK_CACHE_TTL = 7 * 24 * 3600 * 1000;

/* 打开链路的超时分级、健康落账与失败降权统一由 lib/book_sched.mjs 承担；
   旧的 flat 健康文件（runtime/book_open_health.json）结构与新模块一致，模块加载时容忍旧字段。 */

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
    // 临时名带 pid + 随机后缀：多个实例同时打开同一本书时，
    // 固定 `.tmp` 会撞在一起，后写的 rename 可能把别人写了一半的文件搬上去。
    const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(16).slice(2, 8)}`;
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

/** 正文清洗：有些书源把 HTML 片段直接塞进正文，`<br>`、`&nbsp;` 会当文字显示。
    这里把换行标签还原成换行、解码实体、剥掉残余标签，保留段落结构。 */
function cleanChapterText(s) {
  let t = String(s || '').replace(/\r\n?/g, '\n');
  t = t
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<\/?(?:div|section|article|li)[^>]*>/gi, '\n')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  t = decodeHtml(t).replace(/\u00a0/g, ' ');
  // 有些站点把广告脚本调用当正文塞进来：read2(); / read3(); 之类，直接删掉。
  t = t.replace(/\b(read\d+|chaptererror|readx|bdshare)\(\)\s*;/gi, ' ');
  t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return t.trim();
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
    kind: cleanText(b.kind),
    lastChapter: cleanText(b.lastChapter),
    latestChapter: cleanText(b.latestChapter || b.lastChapter),
    wordCount: cleanText(b.wordCount),
    sourceName: cleanText(b.sourceName || b.originName),
    sourceId: cleanText(b.sourceId || b.origin),
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
    if (job.status !== 'running' && now - job.startedAt > 60 * 60 * 1000) searchJobs.delete(id);
  }
}

/**
 * 搜书引擎选择：reader-searchd（Reader 原生 Rust 引擎）在线就优先用它，
 * 不在线或中途失败再回落本地 Node 引擎。两者返回结构一致，供同一套任务管线消费。
 */
// 引擎健康探测要 1.4 秒左右，启动时先预热，别让第一次搜索为它白等。
void searchdHealth(true).catch(() => {});
// 书源缓存也预热：书房页要显示「可直连/有搜索规则」的条数，第一次打开不能是 0。
void ensureSourceCache();

function searchBooksWithBestEngine(query, handlers) {
  const localOptions = {
    concurrency: 150,
    timeout: 4500,
    limit: 320,
    // 整体时限：本地引擎兜底也不能无限跑，超时按「跳过」结算，任务必须能收尾。
    // 实测 12 槽跑满 3370 源需要约 450–500s，取 720s（12 分钟）留出余量，
    // 走 searchd（Rust 引擎，60–90s）时完全用不到。
    totalTimeout: 720000,
    onItems: handlers.onItems,
    onProgress: handlers.onProgress,
  };
  // 不再用 /health 当门禁：引擎忙着搜书时 /health 会慢，判成离线就把整轮打回旧引擎，
  // 用户看到的就是「还是慢、还是不准」。直接连引擎，连不上再回落。
  return Promise.resolve().then(() => {
    const health = healthCacheSnapshot();
    logLine(`book search engine: ${health.ok ? 'reader-searchd' : 'reader-searchd(try)'}${health.info ? ' (' + health.info.sources + ' 源)' : ''}`);
    return searchViaSearchd(query, {
      onItems: handlers.onItems,
      onProgress: handlers.onProgress,
      timeoutMs: 150000,
      // 上游被取消时整轮立即收手：旧实现会继续把 3370 个源跑完，
      // 用户早就离开书房了，进程还在替一个没人要的结果耗 CPU 和带宽。
      signal: handlers.signal,
    })
      .then((result) => {
        // searchd 返回的是「每源原始命中」，这里补一次与本地引擎同口径的聚合，
        // 保证任务收尾时 result.items 也是分组结构（含每本书的 sources 列表）。
        let grouped = [];
        try {
          grouped = groupBooks(result.items, query);
        } catch {
          grouped = result.items;
        }
        // 按匹配度优先：搜「高武严父，永远比儿子高五个境界」时，
        // 只共享「高武」两字的泛匹配不能排在真书前面。
        try {
          // 排序三层：能不能真打开 → 匹配度 → 命中源数。
          // searchOnly 源（17K 接口）秒回结果但目录恒空，让它们霸占列表头部，
          // 用户点前几本必然报「只提供搜索」，所以可开组必须整体前置。
          grouped.sort((a, b) => (a.searchOnly ? 1 : 0) - (b.searchOnly ? 1 : 0)
            || (Number(b.matchScore) || 0) - (Number(a.matchScore) || 0)
            || (Number(b.sourceCount) || 0) - (Number(a.sourceCount) || 0));
        } catch { /* ignore */ }
        return {
          items: grouped,
          stats: {
            total: result.stats.total,
            searched: result.stats.searched,
            withResults: result.stats.withResults,
            answered: result.stats.answered,
            failed: result.stats.failed,
            skipped: 0,
            unique: grouped.length,
            books: result.items.length,
            sourceNames: 0,
            elapsedMs: result.stats.elapsedMs,
            engine: 'reader-searchd',
          },
        };
      })
      .catch((error) => {
        logLine('searchd 搜索失败，回落本地引擎: ' + (error && error.message ? error.message : error));
        return searchAllSources(query, localOptions);
      });
  });
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
  searchBooksWithBestEngine(query, {
    // 边搜边出：新增条目先进缓冲，按 200ms 节流聚合，避免每来一批就把上万个条目整表重排、
    // 把事件循环卡住（卡住会让状态轮询的连接被重置）。
    onItems(added) {
      for (const item of added) job.items.push(item);
      if (job._flushTimer) return;
      job._flushTimer = setTimeout(() => {
        job._flushTimer = null;
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
      }, 120);
      job._flushTimer.unref?.();
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
    if (job._flushTimer) { clearTimeout(job._flushTimer); job._flushTimer = null; }
    // 最终结果以收尾时的有序列表为准整体替换：流式阶段先到的未必最相关。
    if (Array.isArray(result.items) && result.items.length) {
      job.grouped = result.items.slice();
      job.seen = new Set(job.grouped.map((g) => groupKeyOf(g)));
      job.revision++;
    }
    job.stats = result.stats || null;
    // 旧写法无条件把 done 拉满到 total：到时限提前收手时，
    // 界面照样报「已搜 3370 / 3370 个源」，而实际只真搜了几百个——假完成。
    // 现在 done 取引擎如实回报的「已结算源数」，并把提前收手单独标记出来。
    const settled = Number(result.stats?.searched);
    job.done = Number.isFinite(settled) && settled > 0 ? Math.min(settled, job.total) : job.total;
    if (result.stats?.deadlineHit) {
      job.deadlineHit = true;
      job.note = `到总时限收手：${settled}/${job.total} 个源已搜完，其余未搜（已拿到的结果都在下面）`;
    }
    job.hits = job.grouped.length || result.stats?.unique || job.hits;
    job.sourcesWithResults = result.stats?.withResults || job.sourcesWithResults;
    job.sourcesWithNames = result.stats?.sourceNames || 0;
    job.answered = result.stats?.answered || job.answered;
    job.failed = result.stats?.failed || job.failed;
    job.skipped = result.stats?.skipped || job.skipped;
    job.finishedAt = Date.now();
    logLine(`book search job ${id} done: ${job.hits} books / ${job.sourcesWithResults} sources in ${job.stats?.elapsedMs || 0}ms`);
    // 后台预热前若干本的详情/目录/首章（lib/book_warm：并发 3、原子写、失败隔离），不阻塞任务完成与首屏。
    // 预热选源：跳过「只能搜不能开」的 17K 类源，并且每组只热「排在最前的可开源」，否则热了也打不开。
    void warmOnSearchHits(
      job.grouped.slice(0, 8).flatMap((g) =>
        (g.sources || []).filter((s) => s && s.url && s.bookUrl && !/api\.17k\.com/i.test(String(s.url))).slice(0, 1).map((s) => ({
          sourceId: s.url,
          bookUrl: s.bookUrl,
          name: g.name,
          author: g.author,
          coverUrl: g.coverUrl,
          intro: g.intro,
          wordCount: g.wordCount,
        }))
      ),
      { limit: 3, engine: gatedWarmEngine }
    );
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
    items: job.grouped.length > 400 ? job.grouped.slice(0, 400) : job.grouped,
    totalGroups: job.grouped.length,
    revision: job.revision,
    rawHits: job.rawHits || job.items.length,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    stats: job.stats,
    deadlineHit: !!job.deadlineHit,
    note: job.note || '',
    error: job.error,
  };
}


/* 用户打开优先闸门：预热任务在有人正在打开书时让道，避免抢占 4 个引擎槽。 */
let openInFlight = 0;
const warmWaiters = [];
function holdWarm() {
  openInFlight += 1;
}
function releaseWarm() {
  openInFlight = Math.max(0, openInFlight - 1);
  if (openInFlight === 0) {
    while (warmWaiters.length) {
      const resolve = warmWaiters.shift();
      resolve();
    }
  }
}
function warmGate() {
  if (openInFlight === 0) return Promise.resolve();
  return new Promise((resolve) => warmWaiters.push(resolve));
}
const gatedWarmEngine = {
  bookInfo: async (...args) => { await warmGate(); return engineBookInfo(...args); },
  chapterList: async (...args) => { await warmGate(); return engineChapterList(...args); },
  chapterContent: async (...args) => { await warmGate(); return engineChapterContent(...args); },
};

/**
 * 快速探一下候选源的目录首页有多少章，用来避开只有 20/100 章的残缺源。
 * 超时或失败返回 -1，排序时保持原顺序。
 */
async function probeTocCount(candidate, timeoutMs = 5000) {
  const qs = new URLSearchParams({
    bookUrl: candidate.bookUrl,
    bookSourceUrl: candidate.bookSourceUrl,
    probe: 'true',
  });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${searchdBase()}/toc?${qs.toString()}`, { signal: ac.signal, cache: 'no-store' });
    if (!res.ok) return -1;
    const body = await res.json();
    return Array.isArray(body.data) ? body.data.length : -1;
  } catch {
    return -1;
  } finally {
    clearTimeout(timer);
  }
}

/** 并发探测候选目录，任意一个超过 200 章就立即采用，不必等最慢的源。 */
async function probeBestSource(list, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let best = { count: -1, i: -1 };
    let done = 0;
    const finish = () => resolve(best);
    list.forEach((candidate, i) => {
      probeTocCount(candidate, timeoutMs)
        .then((count) => {
          done += 1;
          if (count > best.count) best = { count, i };
          if (best.count > 200 || done >= list.length) finish();
        })
        .catch(() => {
          done += 1;
          if (done >= list.length) finish();
        });
    });
    if (!list.length) finish();
  });
}

async function openBookWithSources(body) {
  holdWarm();
  try {
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
  // 主书地址：body 里没带就以排序前的第一个候选为准（原实现误用了未定义变量 bookUrl）。
  const primaryBookUrl = String(body.bookUrl || candidates[0].bookUrl || '').trim();
  if (!primaryBookUrl) throw new Error('这本书没有可用的书源');

  // 点击先查磁盘缓存：取候选里章数最多的一份，避免被只有 20 章的残缺源缓存劫持。
  // 少于 100 章的缓存一律不用；正好 100 章则可能是分页只抓了第一页，也重新打开拿全量。
  let cachedBest = null;
  for (const candidate of candidates) {
    const cached = readBookCache(candidate.bookSourceUrl, candidate.bookUrl);
    const chapterCount = Array.isArray(cached && cached.chapters) ? cached.chapters.length : 0;
    if (!cached || chapterCount < 100 || chapterCount === 100) continue;
    if (!cachedBest || chapterCount > (cachedBest.chapters || []).length) cachedBest = cached;
  }
  if (cachedBest) return { ...cachedBest, cached: true };

  // 健康分 + 历史阶段 P50 + 24h 降权名单排序（lib/book_sched：失败源自然降权，不永久排除）。
  let ordered = rankSources(candidates)
    .map(({ _score, _p50, _deprioritized, ...c }) => c);

  // 打开前先探目录首页：谁章数多用谁，避免健康分把「只有 20 章的残缺源」排到前面。
  const probeList = ordered.slice(0, 5);
  const bestProbe = await probeBestSource(probeList);
  if (bestProbe.i > 0) {
    const winner = probeList[bestProbe.i];
    ordered = [winner, ...ordered.filter((c) => c !== winner)];
    logLine(`book source probe: ${winner.bookSourceUrl} 首页 ${bestProbe.count} 章，优先打开`);
  }

  // 多候选并行 race：前 3 个不同源同时起跑「详情 → 目录 → 首章」，先成功先用（lib/book_race）。
  // 失败按阶段回灌健康账；全部失败就直接报错，不再走 Reader 兜底。
  await awaitSourceCache();
  // 已知「能搜不能开」的源（返回空目录/无正文）不进打开候选，避免用户点第一本白等一轮超时；
  // 判定依据是实测：api.17k.com 搜索秒回但目录恒为空。健康账仍会记录它，长期降权。
  const OPEN_BAD_HOSTS = /api\.17k\.com/i;
  // 判定要同时看「书源地址」和「这本书的地址」：
  // 17K 的条目可能挂在普通书源名下，只查 source.url 会被它溜进打开候选，
  // 白等一轮超时再报「只提供搜索」。
  const engineCandidates = ordered
    .map((c) => ({ sourceId: c.bookSourceUrl, source: getSourceByUrl(c.bookSourceUrl), bookUrl: c.bookUrl, name: c.name }))
    .filter((c) => c.source
      && !OPEN_BAD_HOSTS.test(String(c.source.url || ''))
      && !OPEN_BAD_HOSTS.test(String(c.bookUrl || '')));
  let lastError = null;
  const MAX_TRY = 8;
  if (!engineCandidates.length && ordered.length) {
    lastError = new Error('这本书命中的书源只提供搜索、不提供目录正文（17K 接口），换一本来读');
    logLine(`all candidates are search-only sources: ${ordered.map((c) => c.bookSourceUrl).join(', ')}`);
  }
  if (engineCandidates.length) {
    // 多源时并行 3 路比较目录完整度，单候选就 1 路；谁章数多用谁，避免残缺源胜出。
    // 探测到完整目录（>200 章）就只开这一路；首页都不足 200 章时才并行 3 路比完整度。
    const attempts = engineCandidates.length > 1 ? (bestProbe.count > 200 ? 1 : 3) : 1;

    // searchd 与本地引擎同时起跑，哪个先成功就用哪个：
    // searchd 能正确解析描述符 bookUrl 且无子进程开销，本地引擎覆盖 searchd 解析不了的源。
    const fastRacePromise = raceOpenViaSearchd(
      ordered.slice(0, MAX_TRY).map((c) => ({
        bookSourceUrl: c.bookSourceUrl,
        bookUrl: c.bookUrl,
        name: c.name,
      })),
      { attempts, budgetMs: 12000 }
    ).catch((error) => ({ ok: false, error: error && error.message, tried: [] }));
    const slowRacePromise = raceOpen(engineCandidates.slice(0, MAX_TRY), {
      attempts,
      budgetMs: 14000,
      timeoutMs: 9000,
    });

    const firstOk = await new Promise((resolve) => {
      let settled = 0;
      let best = null;
      const done = (kind) => (r) => {
        settled += 1;
        if (r && r.ok) {
          const count = Array.isArray(r.chapters) ? r.chapters.length : 0;
          if (!best || count > best.count) best = { kind, race: r, count };
          // 目录超过 200 章基本可判定完整，立即采用；否则等另一引擎的结果再比一次。
          if (best.count > 200) resolve({ kind: best.kind, race: best.race });
        }
        if (settled >= 2) resolve(best ? { kind: best.kind, race: best.race } : null);
      };
      fastRacePromise.then(done('searchd')).catch(() => done('searchd')(null));
      slowRacePromise.then(done('legado')).catch(() => done('legado')(null));
    });

    if (firstOk && firstOk.kind === 'searchd') {
      const fastRace = firstOk.race;
      const origin = fastRace.sourceId;
      const winnerSource = getSourceByUrl(origin);
      const out = {
        book: normalizeBook(
          { ...fastRace.book, originName: (winnerSource && winnerSource.name) || fastRace.book.originName || '', origin },
          { bookUrl: fastRace.book.bookUrl || primaryBookUrl, origin }
        ),
        saved: false,
        saveError: '本地规则引擎未写入书架',
        chapters: (fastRace.chapters || []).map((c, i) => ({
          title: cleanText(c.name) || `第 ${i + 1} 章`,
          url: c.url,
          index: i,
          isVip: false,
          isPay: false,
          isVolume: !!c.isVolume,
        })),
        firstChapter: {
          title: cleanText(fastRace.firstChapter?.name) || '第 1 章',
          url: fastRace.firstChapter?.url || '',
          index: 0,
          content: fastRace.firstChapter?.content || '',
          length: (fastRace.firstChapter?.content || '').length,
        },
        engine: 'reader-searchd',
        sourceUsed: (winnerSource && winnerSource.name) || '',
        triedSources: (fastRace.tried || []).length,
      };
      writeBookCache(origin, out.book.bookUrl || primaryBookUrl, out);
      logLine(`searchd open ok (${out.sourceUsed}) in ${fastRace.ms}ms`);
      return out;
    }
    const race = firstOk && firstOk.kind === 'legado' ? firstOk.race : await slowRacePromise;
    if (race.ok) {
      const winnerSource = getSourceByUrl(race.sourceId);
      const origin = race.sourceId;
      const book = normalizeBook(
        { ...race.book, originName: (winnerSource && winnerSource.name) || race.book.originName || '', origin },
        { bookUrl: race.book.bookUrl || primaryBookUrl, origin }
      );
      const chaptersOut = (race.chapters || []).map((c, i) => ({
        title: cleanText(c.name) || `第 ${i + 1} 章`,
        url: c.url,
        index: i,
        isVip: false,
        isPay: false,
        isVolume: false,
      }));
      const first = race.firstChapter || {};
      const out = {
        book,
        saved: false,
        saveError: '本地规则引擎未写入书架',
        chapters: chaptersOut,
        firstChapter: {
          title: cleanText(first.name) || (chaptersOut[0] && chaptersOut[0].title) || '第 1 章',
          url: first.url || (chaptersOut[0] && chaptersOut[0].url) || '',
          index: 0,
          content: first.content || '',
          length: (first.content || '').length,
        },
        engine: 'legado',
        sourceUsed: (winnerSource && winnerSource.name) || '',
        triedSources: (race.tried || []).length + 1,
      };
      writeBookCache(origin, out.book.bookUrl || primaryBookUrl, out);
      logLine(`engine race open ok (${out.sourceUsed}) in ${race.ms}ms, tried ${out.triedSources}${race.timeline ? ' | ' + JSON.stringify(race.timeline).slice(0, 700) : ''}`);
      return out;
    }
    const STAGE_MAP = { bookInfo: 'info', chapterList: 'toc', chapterContent: 'content' };
    for (const t of race.tried || []) {
      recordOutcome(t.sourceId, STAGE_MAP[t.stage] || 'info', { ok: false, ms: t.ms || 0, error: t.error });
    }
    lastError = new Error(race.error || '这本书没有可用的书源');
    logLine(`engine race failed: ${lastError.message}（试了 ${(race.tried || []).length} 个源）`);
  }

  // ★ 2026-11-20：客厅不再通过 Reader 打开/解析任何书；本地引擎失败就直接报错。
  throw lastError || new Error('这本书没有可用的书源');
  } finally {
    releaseWarm();
  }
}

/** 规则引擎链路：详情 → 目录 → 首章正文，全部走 legado 引擎（单源版本，保留给兜底/调试）。 */
async function openBookViaEngine(source, bookUrl, origin) {
  const openT0 = Date.now();
  let stageT0 = openT0;
  const info = await timedEngine('bookInfo', source, () => engineBookInfo(source, { bookUrl }, { timeoutMs: remainingBudget(0, origin, 'info') }));
  if (!info.ok) {
    recordOutcome(origin, 'info', { ok: false, ms: info.ms || Date.now() - stageT0, error: info.error });
    throw new Error(info.error || '详情解析失败');
  }
  recordOutcome(origin, 'info', { ok: true, ms: info.ms || Date.now() - stageT0 });
  // 慢但成功也换源：该源此阶段历史 P50 存在且本次超过 1.5 倍时，放弃它去试下一个候选（冷启动无基线不触发）。
  if (shouldSwitchFor(origin, 'info', { ok: true, ms: info.ms || Date.now() - stageT0 })) {
    throw new Error(`慢源切换：info ${info.ms}ms 超出历史基线 1.5 倍`);
  }
  const book = normalizeBook({ ...info, originName: source.name, origin }, { bookUrl, origin });

  stageT0 = Date.now();
  const toc = await timedEngine('chapterList', source, () => engineChapterList(source, book, { timeoutMs: remainingBudget(Date.now() - openT0, origin, 'toc') }));
  if (!toc.ok || !Array.isArray(toc.chapters) || !toc.chapters.length) {
    recordOutcome(origin, 'toc', { ok: false, ms: toc.ms || Date.now() - stageT0, error: toc.error || '目录为空' });
    throw new Error(toc.error || '目录为空');
  }
  recordOutcome(origin, 'toc', { ok: true, ms: toc.ms || Date.now() - stageT0 });
  if (shouldSwitchFor(origin, 'toc', { ok: true, ms: toc.ms || Date.now() - stageT0 })) {
    throw new Error(`慢源切换：toc ${toc.ms}ms 超出历史基线 1.5 倍`);
  }

  const chaptersOut = toc.chapters.map((c, i) => ({
    title: cleanText(c.name) || `第 ${i + 1} 章`,
    url: c.url,
    index: i,
    isVip: false,
    isPay: false,
    isVolume: false,
  }));
  const first = chaptersOut[0];
  stageT0 = Date.now();
  const content = await timedEngine('chapterContent', source, () => engineChapterContent(source, book, { name: first.title, url: first.url }, { timeoutMs: remainingBudget(Date.now() - openT0, origin, 'content') }));
  if (!content.ok) {
    recordOutcome(origin, 'content', { ok: false, ms: content.ms || Date.now() - stageT0, error: content.error });
    throw new Error(content.error || '第一章正文为空');
  }
  recordOutcome(origin, 'content', { ok: true, ms: content.ms || Date.now() - stageT0 });

  const firstChapter = {
    title: first.title,
    url: first.url,
    index: 0,
    content: content.content,
    length: content.content.length,
  };
  const out = {
    book,
    saved: false,
    saveError: '本地规则引擎未写入书架',
    chapters: chaptersOut,
    firstChapter,
    engine: 'legado',
  };
  writeBookCache(origin, book.bookUrl, out);
  return out;
}

/** Reader /reader3 兜底链路：仅引擎失败或无源、且 Reader 健康时试一次。 */
async function openBookViaReader(bookUrl, bookSourceUrl) {
  const origin = bookSourceUrl || guessBookOrigin(bookUrl);
  let stageT0 = Date.now();
  let info;
  try {
    info = readerData(
      await readerRequest('POST', '/reader3/getBookInfo', { url: bookUrl, bookSourceUrl: origin }, 8000),
      '取书籍详情'
    );
    recordOutcome(origin, 'info', { ok: true, ms: Date.now() - stageT0 });
  } catch (error) {
    recordOutcome(origin, 'info', { ok: false, ms: Date.now() - stageT0, error: error && error.message });
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
    recordOutcome(origin, 'toc', { ok: true, ms: Date.now() - stageT0 });
  } catch (error) {
    recordOutcome(origin, 'toc', { ok: false, ms: Date.now() - stageT0, error: error && error.message });
    throw error;
  }

  if (!Array.isArray(chapters) || !chapters.length) throw new Error('这本书没有取到目录');

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
  const out = { book, saved, saveError, chapters: chaptersOut, firstChapter, engine: 'reader3' };
  writeBookCache(origin, book.bookUrl, out);
  return out;
}

async function openBook(bookUrl, bookSourceUrl) {
  if (!bookUrl) throw new Error('缺少 bookUrl');
  const origin = bookSourceUrl || guessBookOrigin(bookUrl);
  if (!origin) throw new Error('这本书没有可用的书源');

  await awaitSourceCache();
  const source = getSourceByUrl(origin);
  if (source) {
    try {
      return await openBookViaEngine(source, bookUrl, origin);
    } catch (engineError) {
      // openBookViaEngine 内部已按阶段落健康账，这里不再重复记一笔，避免失败被计两次。
      logLine(`engine open failed (${source.name}): ${engineError.message || engineError}`);
      logLine(`engine open failed (${source.name}): ${engineError.message || engineError}`);
    }
  }
  // ★ 2026-11-20：不再回落 Reader（只有它已经自己开着时才允许复用，现在连复用也去掉）
  throw new Error(source ? `本地引擎打开失败：${source.name}` : '这本书没有可用的书源');
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

/** 正文：规则引擎优先，失败再回落 Reader /reader3。 */
async function readChapterWithEngine(payload) {
  const origin = payload.bookSourceUrl || guessBookOrigin(payload.bookUrl);
  // 本地引擎优先：searchd 会顺着书源的「下一页」把整章拼完，拿不到才用 Node 规则引擎。
  // ★ 2026-11-20：两条都失败就报错，不再回落 Reader。
  try {
    const fast = await chapterContentViaSearchd({
      bookUrl: payload.bookUrl,
      bookSourceUrl: origin,
      chapterUrl: payload.chapterUrl,
      chapterTitle: payload.chapterTitle,
    });
    if (fast.ok && fast.content && fast.content.trim().length >= 40) {
      const content = cleanChapterText(fast.content);
      return { content, length: content.length, engine: 'reader-searchd' };
    }
    if (fast.ok) logLine(`searchd chapter too short (${(fast.content || '').length} 字)`);
    else logLine('searchd chapter failed: ' + (fast.error || ''));
  } catch (e) {
    logLine('searchd chapter error: ' + (e.message || e));
  }
  const source = getSourceByUrl(origin);
  if (source) {
    const res = await timedEngine('chapterContent', source, () => engineChapterContent(
      source,
      { bookUrl: payload.bookUrl },
      { name: payload.chapterTitle || '', url: payload.chapterUrl },
      { timeoutMs: 8000 }
    ));
    const text = (res && res.content) || '';
    if (res.ok && text.trim() && text.trim().length >= 40) {
      const content = cleanChapterText(text);
      return { content, length: content.length, engine: 'legado' };
    }
    logLine(`engine chapter failed (${source.name}): ${res.error || ('正文过短 ' + text.length + ' 字')}`);
  }
  // ★ 2026-11-20：不再回落 Reader /reader3；本地引擎拿不到正文就明确报错。
  throw new Error('本地引擎没取到这一章；客厅不会用 Reader 取正文');
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
      // 三态必须透出到首页：SWR 把「慢」换成了「旧」，
      // 只给 stats 不给 pending/stale，首页只能把 null 渲染成「—」+「书架还空着」= 假空。
      // 与 /api/book/info 保持同一语义：pending=还在取、stale=给的是旧值、都没有=确实没有。
      pending: !!b.pending,
      stale: !!b.stale,
      ageMs: b.ageMs == null ? null : b.ageMs,
      degraded: false,
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
      // probe 已经证明它能回包，这里只为拿明细；超时跟 probe 保持一致，别单独放大到 5s
      stats = await cachedExtra(id, 20000, async () => {
        const d = await getJson(app.base + '/api/health', 800);
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
    // degraded：上游不可信（熔断中或刚连续失败）。界面据此显示「状态未知」，
    // 不能把「探不到」说成「已停止」——那是静默失败。
    degraded: !!p.degraded,
    breakerOpen: !!p.breakerOpen,
    retryInMs: p.retryInMs || 0,
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
    // 书房没有「启动」这回事：页面常驻，Reader 引擎可选且**永不**由客厅拉起
    bookCache.t = 0; // 标记过期：下次请求先给旧值，同时后台补新（不阻塞）
    void kickBookRefresh();
    return { ok: true, message: '书房不用启动；客厅不会打开 Reader，直接用本地引擎' };
  }

  if (app.kind !== 'web') return { ok: false, message: '这个项目没有可启动的服务' };
  if (busy.has(id)) return { ok: true, message: '正在启动中' };
  markBusy(id);
  extraCache.delete(id);
  invalidateProcessRunning(); // 刚拉起一个服务，进程探测结果立刻作废
  resetProbeBreaker(app.base); // 用户手动启动了：立刻允许重新探测，别被 60s 熔断挡住
  const r = runScript(app, app.startArg || 'start');
  bookCache.t = 0;
  void kickBookRefresh();
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
  invalidateProcessRunning(); // 刚停了一个服务，进程探测结果立刻作废
  resetProbeBreaker(app.base);
  bookCache.t = 0;
  void kickBookRefresh();
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
<script>(function(){try{if(window.top!==window)document.documentElement.setAttribute('data-embedded','1');}catch(e){document.documentElement.setAttribute('data-embedded','1');}})();</script>
<style>
html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#0b0c0e;color:#efe9df;
font:14px/1.9 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;text-align:center}
h1{font:600 26px/1.3 "Songti SC",serif;margin:0 0 10px}p{color:#918c83;margin:0 0 22px}
.ww-home{display:inline-flex;align-items:center;gap:5px;padding:6px 10px;border:1px solid rgba(255,255,255,.06);border-radius:8px;font-size:12px;letter-spacing:.1em;color:#8b8b8b;text-decoration:none;line-height:1}
.ww-home:hover{color:#efe9df;border-color:rgba(255,255,255,.18)}
html[data-embedded] .ww-home{display:none}
</style><body><div><h1>${name}暂时没开</h1><p>客厅没连上里面的服务。回客厅点一下这扇门，它会自己启动。</p>
<a class="ww-home" href="/" title="返回五五客厅" aria-label="返回五五客厅"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M15 6l-6 6 6 6"/></svg><span>回客厅</span></a></div>
<script>(function(){var a=document.querySelector('.ww-home');if(a)a.addEventListener('click',function(e){try{if(window.top!==window){e.preventDefault();window.parent.postMessage({type:'wuwu:close'},location.origin);}}catch(_){}});})();</script>
</body></html>`;
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
const VOD_IMG_DIR = path.join(RUNTIME_DIR, 'vod', 'posters');
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
      // 必须先写临时文件再 rename：命中判定只要求 stat.size > 0，
      // 直写被中断会留下半截图，而半截图 size 也大于 0 —— 之后每次请求都命中它，
      // 用户看到的是永久损坏的海报，且不会自动重取。
      const tmp = `${cached}.${process.pid}.${Math.random().toString(16).slice(2, 8)}.tmp`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, cached);
      const typeTmp = `${cached}.type.${process.pid}.tmp`;
      fs.writeFileSync(typeTmp, ct);
      fs.renameSync(typeTmp, cached + '.type');
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

  if (id === 'music' && req.method === 'GET' && rest === '/') {
    const cached = staticPageCache.get(id);
    if (cached && Date.now() - cached.at < STATIC_PAGE_TTL) {
      res.writeHead(cached.status, cached.headers);
      return res.end(cached.body);
    }
  }

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
    if (id === 'music' && rest === '/' && r.status === 200) {
      staticPageCache.set(id, { at: Date.now(), status: r.status, headers: { ...outHeaders }, body: buf });
    }
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

// 房间模块在 bind 之后异步加载；未就绪期间对应前缀先回 200 占位，不阻塞 ping/客厅。
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
      return sendHtml(res, PAGE_HTML);
    }

    if (p === '/book' || p === '/book/') {
      return sendHtml(res, BOOK_HTML);
    }

    if (p === '/api/status') {
      return sendJson(res, 200, await allStatus());
    }

    if (p === '/api/book/info') {
      return sendJson(res, 200, Object.assign({ ok: true }, await bookInfo()));
    }

    if (p === '/api/book/ensure' && req.method === 'POST') {
      // 只检查 Reader Web 现在在不在，绝不启动 Reader.app
      const ok = await readerHealth();
      bookCache.t = 0; // 标记过期 + 后台刷新（这次请求不再等 python）
      void kickBookRefresh();
      return sendJson(res, 200, {
        ok,
        webRunning: ok,
        message: ok ? 'Reader 引擎已在运行' : 'Reader 未运行；客厅不会启动它，书房用本地引擎',
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

    if (p === '/api/book/groups') {
      const out = await bookGroups();
      return sendJson(res, 200, { ok: !out.error, groups: out.groups, total: out.groups.length, error: out.error || null });
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

    if (p === '/api/book/recommend') {
      try {
        const out = await fanqieRecommend(false);
        return sendJson(res, 200, { ok: true, items: out.items, updatedAt: out.updatedAt, stale: out.stale });
      } catch (e) {
        const fallback = readFanqieFile();
        return sendJson(res, 200, { ok: true, items: fallback.items, updatedAt: fallback.updatedAt, stale: true });
      }
    }

    // 书房自己的书架：只收用户主动点「加入书架」的书，打开书不会自动入库。
    if (p === '/api/book/shelf') {
      const items = readShelf();
      return sendJson(res, 200, { ok: true, items, count: items.length });
    }

    if (p === '/api/book/shelf/add' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const items = addToShelf(body || {});
        logLine(`book shelf add: ${body && body.name ? body.name : body && body.bookUrl}`);
        return sendJson(res, 200, { ok: true, items, count: items.length });
      } catch (e) {
        return sendJson(res, 400, { ok: false, message: e.message || String(e) });
      }
    }

    if (p === '/api/book/shelf/remove' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const items = removeFromShelf(body && body.bookUrl);
        logLine(`book shelf remove: ${body && body.bookUrl}`);
        return sendJson(res, 200, { ok: true, items, count: items.length });
      } catch (e) {
        return sendJson(res, 400, { ok: false, message: e.message || String(e) });
      }
    }

    if (p === '/api/book/open' && req.method === 'POST') {
      const body = await readBody(req);
      try {
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
        const out = await readChapterWithEngine(body);
        // 已在书架的书顺手记进度；不在书架的不会被自动加进去。
        try { touchShelfProgress(body.bookUrl, Number(body.index), body.chapterTitle); } catch {}
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
        // 书房不在这里「启动」：它的页面常驻，Reader 只是可选解析引擎，
        // 一键启动不该顺手把 Reader 窗口弹出来；书房用本地引擎，没有启动按钮。
        if (!apps[id] || id === 'book') continue;
        if (apps[id].kind === 'web') results[id] = startApp(id);
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
      // 这个接口原来会 open -a Reader；按“客厅永不开 Reader”的要求直接封掉
      return sendJson(res, 403, { ok: false, message: '客厅不再打开 Reader' });
    }

    if (p === '/api/ping') {
      // snapshot：哪些页是启动快照、快照时磁盘是什么时候、现在磁盘是什么时候。
      // 判据：diskMtime > snapshotMtime ⇒ 该页改了但没重启，页面仍是旧版。
      const snapshot = {};
      let stalePages = [];
      for (const [name, snapMs] of Object.entries(SNAPSHOT_MTIME)) {
        let diskMs = null;
        try {
          diskMs = fs.statSync(path.join(ROOT, 'public', name)).mtimeMs;
        } catch { /* 文件被删，保持 null */ }
        const stale = diskMs !== null && diskMs > snapMs + 1000; // 1s 容差，避开同秒写入
        snapshot[name] = {
          snapshotAt: new Date(snapMs).toISOString(),
          diskAt: diskMs === null ? null : new Date(diskMs).toISOString(),
          stale,
        };
        if (stale) stalePages.push(name);
      }
      return sendJson(res, 200, {
        ok: true,
        service: 'wuwu-living-room',
        port: PORT,
        ts: Date.now(),
        snapshotAt: new Date(SNAPSHOT_AT).toISOString(),
        snapshot,
        stalePages,
        staleNote: stalePages.length
          ? `这些页改了但未重启，线上仍是旧版：${stalePages.join(' / ')}`
          : '快照页与磁盘一致',
      });
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
    const pendingRoom = ROOM_LIST.find((r) => (p === `/${r.id}/` || p.startsWith(`/${r.id}/`) || p === `/api/${r.id}` || p.startsWith(`/api/${r.id}/`)))?.id;
    if (pendingRoom && !roomsReady().includes(pendingRoom)) {
      if (p.startsWith('/api/')) return sendJson(res, 200, { ok: false, message: `房间 ${pendingRoom} 加载中` });
      return sendHtml(res, roomBootPlaceholder(pendingRoom), 200);
    }
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
        // 必须 await：handler 是 async，`return promise` 不会把 rejection 交给外层 catch。
        // 旧写法的后果是实测过的——代理路径上请求体超限时 readRaw 抛错逃出 try，
        // 既不回 413 也不关连接，客户端 curl 一直挂到超时（status=000, exit=28）。
        return await proxy(req, res, id, app, prefix);
      }
    }

    // 走到这里说明没人处理；但如果前面已经有响应写出去了（比如模块发了一半），
    // 就绝不能再补一个 404，否则会 ERR_HTTP_HEADERS_SENT。
    if (res.headersSent || res.writableEnded) return;
    return sendJson(res, 404, { ok: false, message: '没有这个页面' });
  } catch (e) {
    // 请求体类错误（非法 JSON / 超限）是客户端问题，不是客厅故障：
    // 必须回 400/413 并带上可读原因，否则前端只能看到「缺少书名」这种误导信息。
    if (e instanceof BodyError || Number(e && e.statusCode) >= 400) {
      const code = Number(e.statusCode) || 400;
      logLine(`bad request: ${req.method} ${req.url} → ${code} ${e.message || ''}`);
      if (!res.headersSent) return sendJson(res, code, { ok: false, message: e.message || '请求不合法' });
      return;
    }
    logLine('http error: ' + (e && e.stack ? e.stack : e));
    if (!res.headersSent) {
      return sendJson(res, 500, { ok: false, message: '客厅内部出错了：' + String(e.message || e) });
    }
    res.destroy();
  }
});

// 监听失败单独兜底：确保一定以非 0 退出。这是 launchd KeepAlive 能重启的前提。
server.on('error', (e) => {
  try { _appendLog('book-search.log', `[${new Date().toISOString()}] server.error: ${e && e.code} ${e && e.message}\n`); } catch { /* ignore */ }
  console.error('[server.error]', e && e.code, e && e.message);
  process.exit(1);
});

server.listen(PORT, BIND, () => {
  console.log(`[boot] bind ok in ${Date.now() - bootStartedAt}ms → http://${BIND === '0.0.0.0' ? '127.0.0.1' : BIND}:${PORT}`);
  console.log(`五五客厅  →  http://${BIND === '0.0.0.0' ? '127.0.0.1' : BIND}:${PORT}`);
  console.log(`  /magnet/  /music/  /vod/  /book/`);
  console.log(`  /download/  /library/  /notes/  /calendar/  /photos/`);

  // bind 之后再做重活：房间逐个 8s 超时；引擎预热 5s；失败只记日志，不阻塞 ping/客厅。
  void (async () => {
    try {
      await loadRooms({ initTimeoutMs: 8000 });
    } catch (e) {
      logLine(`rooms background init failed: ${e && e.message ? e.message : e}`);
      console.error('[rooms] 后台初始化失败:', e && (e.stack || e.message));
    }
    try {
      await engineWarmup({ timeoutMs: 5000 });
    } catch (e) {
      logLine(`engine warmup failed: ${e && e.message ? e.message : e}`);
    }
  })();
});
