/**
 * 下载中心 —— 直链流式下载 + 磁力下载（webtorrent 惰性加载）
 *
 * 数据：runtime/download.json（纯 JSON，重启不丢；未完成任务重启后停在 paused）
 * 落盘：config/download.json 的 dir（默认 ~/Downloads/五五下载），重名自动加 (1)，绝不覆盖已有文件
 *
 * 接口：
 *   GET  /api/download/list        任务列表 + 汇总速度
 *   POST /api/download/add          { url, name } 或 { magnet }
 *   POST /api/download/pause         { id }
 *   POST /api/download/resume        { id }
 *   POST /api/download/delete       { id, removeFile }
 *   POST /api/download/clear-done   清空已完成记录（保留文件）
 *   GET  /api/download/detail?id=
 *
 * 跨源：所有响应带 Access-Control-Allow-Origin: *，预请求 OPTIONS 直接放行。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { writeJson, readJsonFile } from './json_store.mjs';
import { roomConfig } from './rooms.mjs';
import { runtimePath } from './runtime_dir.mjs';

export const meta = { id: 'download', name: '下载中心', color: '#5FADA8' };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = runtimePath(ROOT, 'download.json');

/* ───────────────────────── 配置 ───────────────────────── */

const DEFAULTS = {
  dir: '~/Downloads/五五下载',
  concurrency: 3,
  webtorrentEnabled: true,
  httpTimeoutMs: 60000,
};
const cfg = Object.assign({}, DEFAULTS, roomConfig('download', DEFAULTS));

const expandHome = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const DOWNLOAD_DIR = expandHome(cfg.dir || DEFAULTS.dir);
const CONCURRENCY = Math.max(1, Number(cfg.concurrency) || 3);

/** 可在浏览器里直接播的音视频扩展名；其余类型（zip/pdf 等）不显示播放 */
const VIDEO_EXTS = ['.mp4', '.webm', '.mov', '.mkv', '.m4v', '.avi', '.ts', '.flv', '.rmvb', '.wmv'];
const AUDIO_EXTS = ['.mp3', '.flac', '.m4a', '.wav', '.aac', '.ogg', '.opus'];

function mediaKind(absPath) {
  const e = path.extname(absPath || '').toLowerCase();
  if (VIDEO_EXTS.includes(e)) return 'video';
  if (AUDIO_EXTS.includes(e)) return 'audio';
  return null;
}

/** 落盘目录的真实路径（解析软链），用于防路径越权 */
let downloadDirReal = null;
function getDownloadDirReal() {
  if (downloadDirReal) return downloadDirReal;
  try { downloadDirReal = fs.realpathSync(DOWNLOAD_DIR); } catch { downloadDirReal = DOWNLOAD_DIR; }
  return downloadDirReal;
}

/** 只允许任务自己落盘目录内的文件；不存在或越权一律返回 null */
function safeDownloadFile(abs) {
  if (!abs || typeof abs !== 'string') return null;
  let resolved;
  try { resolved = fs.realpathSync(abs); } catch { return null; }
  const dir = getDownloadDirReal();
  if (resolved === dir || resolved.startsWith(dir + path.sep)) return resolved;
  return null;
}

/* ───────────────────────── 数据读写 ───────────────────────── */

let cache = null;

async function load() {
  if (cache) return cache;
  // 读坏当空数据继续跑（不许让客厅 500），但坏文件已由 readJsonFile 备份，可人工恢复
  const d = await readJsonFile(DATA_FILE);
  cache = { tasks: Array.isArray(d && d.tasks) ? d.tasks : [] };
  return cache;
}

/**
 * 进度类写入不逐次落盘：下载过程中每收到一批数据都会 save()，
 * 同步等 fsync 会把下载循环拖慢。这里做 250ms 合并，最后一次写完为止。
 * 关键状态变更（新增/完成/失败/删除/暂停）仍走 await save()，保证顺序与终态不丢。
 */
let saveQueued = null;
let saveTimer = null;
function saveSoon() {
  if (saveQueued) return saveQueued;
  saveQueued = new Promise((resolve) => {
    // 定时器必须能被 flushSave() 立刻兑现：任务「完成」是终态，
    // 后面还有 pump() 会立刻起下一个任务，如果只在 250ms 后才写盘，
    // 中途 kill 就可能丢掉刚完成那条的 done 状态。
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      saveQueued = null;
      try { await save(); } catch { /* save 内部已记日志 */ }
      resolve();
    }, 250);
    saveTimer.unref?.();
  });
  return saveQueued;
}

/** 终态前把排队中的进度写立刻兑现，保证「完成即落盘」。 */
async function flushSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  saveQueued = null;
  await save();
}

async function save() {
  if (!cache) return;
  // 旧实现：await save() 只排了个 200ms 定时器就返回，接口先回 200、进程退出即丢任务清单。
  // 现在写盘是同步等待的，写入路径由 json_store 串行化并用独立临时名。
  try {
    await writeJson(DATA_FILE, {
      updatedAt: Date.now(),
      tasks: cache.tasks.map(publicPersist),
    });
  } catch (e) {
    console.error('[download] 落盘失败:', e && e.message);
  }
}

/** 落盘时剥掉运行态字段（采样窗口、句柄等不进 JSON） */
function publicPersist(t) {
  const out = {};
  const keep = ['id', 'kind', 'url', 'magnet', 'name', 'state', 'total', 'done', 'error',
    'file', 'files', 'createdAt', 'updatedAt', 'doneAt', 'magnetInfoHash'];
  for (const k of keep) if (k in t) out[k] = t[k];
  return out;
}

/* ───────────────────────── 运行态 ───────────────────────── */

/** id -> runner：url 是 { controller }，magnet 是 { torrent } */
const runners = new Map();

/** webtorrent 惰性加载：第一次真加磁力任务才 import */
let wtClient = null;
let wtAttempted = false;
let wtError = '';

async function ensureWebTorrent() {
  if (wtClient) return { ok: true };
  if (wtAttempted) return { ok: false, message: wtError || '磁力组件没装好' };
  wtAttempted = true;
  try {
    const mod = await import('webtorrent');
    const W = mod.default || mod;
    // DHT / LSD / UPnP 显式开启（默认即开，这里写死避免被环境配置关掉）
    wtClient = new W({ maxConns: 55, dht: true, lsd: true, natUpnp: true });
    wtClient.on('error', () => {});
    return { ok: true };
  } catch (e) {
    wtError = String(e && e.message || e);
    return { ok: false, message: '磁力组件没装好，直链下载不受影响：' + wtError };
  }
}

/* ───────────────────────── 工具 ───────────────────────── */

const uid = () => 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function sanitizeName(name, fallback) {
  let s = String(name || '').replace(/[\\/:*?"<>|\r\n\t]/g, ' ').trim();
  s = s.replace(/\s+/g, ' ').slice(0, 160);
  return s || fallback;
}

function nameFromUrl(u) {
  try {
    const x = new URL(u);
    const base = decodeURIComponent(x.pathname.split('/').filter(Boolean).pop() || '');
    return base || '未命名文件';
  } catch {
    return '未命名文件';
  }
}

/** 绝不覆盖已有文件：重名加 (1) */
function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let cand = path.join(dir, name);
  let i = 1;
  while (fs.existsSync(cand)) {
    cand = path.join(dir, `${stem} (${i})${ext}`);
    i += 1;
  }
  return cand;
}

function pushSample(task, bytes) {
  const now = Date.now();
  const arr = task._samples || (task._samples = []);
  arr.push({ t: now, bytes });
  while (arr.length > 2 && now - arr[0].t > 5000) arr.shift();
}

/** 最近 5 秒滑动平均速度（字节/秒） */
function taskSpeed(task) {
  const arr = task._samples;
  if (!arr || arr.length < 2) return 0;
  const now = Date.now();
  const last = arr[arr.length - 1];
  let old = arr[0];
  for (const a of arr) {
    if (now - a.t <= 5000) { old = a; break; }
  }
  const dt = (last.t - old.t) / 1000;
  if (dt <= 0.05) return 0;
  return Math.max(0, (last.bytes - old.bytes) / dt);
}

function findTask(id) {
  const st = cache && cache.tasks;
  return st ? st.find((t) => t.id === id) : null;
}

/* ───────────────────────── 直链下载 ───────────────────────── */

async function startUrl(task) {
  if (runners.has(task.id)) return;
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  // 落盘路径（首次确定，重名加序号）
  if (!task.file || !task.file.final) {
    const base = sanitizeName(task.name || nameFromUrl(task.url), '未命名文件');
    const final = uniquePath(DOWNLOAD_DIR, base);
    task.file = { final, part: final + '.part' };
  }
  const part = task.file.part;

  let existing = 0;
  try { existing = fs.statSync(part).size; } catch { existing = 0; }

  const headers = {};
  if (existing > 0) headers.Range = `bytes=${existing}-`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Number(cfg.httpTimeoutMs) || 60000);
  runners.set(task.id, { controller: ac, kind: 'url' });

  let resp;
  try {
    resp = await fetch(task.url, { headers, signal: ac.signal, redirect: 'follow' });
  } catch (e) {
    clearTimeout(timer);
    return failUrl(task, ac, existing > 0 ? `连接中断：${e.message || e}` : `连接失败：${e.message || e}`);
  }

  let append = false;
  if (resp.status === 206) {
    append = true;
    task.done = existing;
    const cr = resp.headers.get('content-range') || '';
    const m = /\/(\d+)$/.exec(cr);
    if (m) task.total = Number(m[1]);
  } else if (resp.ok) {
    append = false;
    task.done = 0;
    const len = Number(resp.headers.get('content-length'));
    if (len > 0) task.total = len;
  } else {
    clearTimeout(timer);
    runners.delete(task.id);
    return failUrl(task, ac, `服务器返回 HTTP ${resp.status}`, false);
  }

  pushSample(task, task.done);

  const ws = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
  const rs = Readable.fromWeb(resp.body);
  rs.on('data', (chunk) => {
    task.done += chunk.length;
    task.updatedAt = Date.now();
    pushSample(task, task.done);
  });

  try {
    await pipeline(rs, ws);
    clearTimeout(timer);
  } catch (e) {
    clearTimeout(timer);
    if (task.state === 'paused') {
      runners.delete(task.id);
      task.error = '';
      await save();
      return;
    }
    return failUrl(task, ac, `下载中断：${e.message || e}`, append);
  }

  // 完成：原子重命名 .part -> 最终文件
  try {
    if (task.total && task.done < task.total) {
      throw new Error(`文件不完整（${task.done}/${task.total} 字节）`);
    }
    await fsp.rename(part, task.file.final);
    task.state = 'done';
    task.doneAt = Date.now();
    task.error = '';
    task.name = path.basename(task.file.final);
  } catch (e) {
    return failUrl(task, ac, `落盘失败：${e.message || e}`, append);
  }

  runners.delete(task.id);
  await flushSave(); // 直链完成同样先把排队的进度写兑现
  await save();
  pump();
}

function failUrl(task, ac, message, keepPart = true) {
  runners.delete(task.id);
  task.state = 'error';
  task.error = message;
  task.updatedAt = Date.now();
  void save();
  pump();
}

/* ───────────────────────── 磁力下载 ───────────────────────── */

/** 内置公共 tracker，提高节点发现概率；网络受限环境下仍以 webtorrent 实际结果为准 */
const PUBLIC_TRACKERS = [
  'https://torrent.ubuntu.com/announce',
  'udp://tracker.ubuntu.com:6969/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://tracker.leechers-paradise.org:6969/announce',
  'udp://explodie.org:6969/announce',
  'http://tracker.files.fm:6969/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.stealth.si:80/announce',
];

function magnetHash(magnet) {
  const m = /urn:btih:([0-9a-fA-F]{40})/.exec(String(magnet || ''));
  return m ? m[1].toLowerCase() : '';
}

/** 把公共 tracker 直接拼进磁力 URI（tr= 参数）；手工拼接，避免 new URL 把 urn:btih: 编码坏 */
function magnetWithTrackers(magnet) {
  const base = magnet.replace(/(?:&|\?)tr=[^&]*/g, '');
  const tr = PUBLIC_TRACKERS.map((t) => '&tr=' + encodeURIComponent(t)).join('');
  return base + tr;
}

async function startMagnet(task) {
  if (runners.has(task.id)) return;
  const wt = await ensureWebTorrent();
  if (!wt.ok) {
    // 组件没装好：不挂红字错误，保持等待态并如实说明，直链不受影响
    task.state = 'waiting';
    task.error = wt.message;
    task.updatedAt = Date.now();
    await save();
    return;
  }
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  task.error = ''; // 新一轮尝试清掉上一轮残留的旧错误描述

  const hash = task.magnetInfoHash || magnetHash(task.magnet);
  const magnetURI = magnetWithTrackers(task.magnet);
  let torrent = wtClient.torrents.find((t) => (hash && t.infoHash === hash) || t.magnetURI === task.magnet);
  if (!torrent) {
    torrent = wtClient.add(magnetURI, { path: DOWNLOAD_DIR, announce: PUBLIC_TRACKERS });
    task.magnetInfoHash = torrent.infoHash || hash;
  }

  const onMetadata = () => {
    if (task.state !== 'done') task.state = 'active';
    task.error = '';
    sync();
    void saveSoon();
  };
  // 必须是 async：终态要等任务清单真正落盘再 pump，
  // 否则进程在写入前退出会留下一条「已完成但磁盘上还是 active」的记录。
  const onDone = async () => {
    sync();
    const sorted = torrent.files.slice().sort((a, b) => b.length - a.length);
    // 多文件磁力：优先挑最大的视频文件作为可播放主文件；没有视频再取最大文件
    const main = sorted.find((f) => VIDEO_EXTS.includes(path.extname(f.name || '').toLowerCase())) || sorted[0];
    task.state = 'done';
    task.doneAt = Date.now();
    task.error = '';
    task.file = main ? { final: path.join(DOWNLOAD_DIR, main.path), name: main.name } : null;
    runners.delete(task.id);
    try { torrent.destroy({ destroyStore: false }); } catch {}
    await flushSave(); // 先把排队的进度写兑现，再写终态，避免顺序倒置
    await save();
    pump();
  };
  const sync = () => {
    if (torrent.name) task.name = torrent.name;
    if (torrent.files && torrent.files.length) {
      task.total = torrent.files.reduce((s, f) => s + f.length, 0);
    }
    task.done = Math.round((task.total || 0) * (torrent.progress || 0));
    task.updatedAt = Date.now();
    pushSample(task, task.done);
    task._speed = torrent.downloadSpeed || 0;
    task._peers = torrent.numPeers || 0;
    task._conns = torrent._numConns || 0;
    task._eta = torrent.timeRemaining && isFinite(torrent.timeRemaining) ? torrent.timeRemaining : null;
    task.files = torrent.files.map((f) => ({
      name: f.name,
      length: f.length,
      path: path.join(DOWNLOAD_DIR, f.path),
    }));
  };
  // 磁力在受限网络里拿不到节点/元数据是常态，不判死：降级为等待态，页面如实提示
  const onError = (e) => {
    if (task.state === 'done') return;
    // 占位阻断：不立刻自动重连循环；用户点「继续」时再解除
    runners.set(task.id, { kind: 'magnet', blocked: true });
    task.state = 'waiting';
    task.error = '本机 UDP/DHT 受限，暂未连上外网节点；直链下载不受影响。' + (e && e.message ? `（${e.message}）` : '');
    task.updatedAt = Date.now();
    void save();
    pump();
  };

  torrent.on('metadata', onMetadata);
  torrent.on('download', sync);
  torrent.on('error', onError);
  // onDone 是 async：EventEmitter 不会接它的 rejection，自己兜住
  torrent.on('done', () => { onDone().catch((e) => console.error('[download] 完成收尾失败:', e && e.message)); });
  sync();
  if (torrent.done) onDone();
  else if (task.state === 'active' && torrent.files && torrent.files.length) onMetadata();

  runners.set(task.id, { torrent, kind: 'magnet', onDone, sync });
}

/* ───────────────────────── 调度 ───────────────────────── */

async function startTask(task) {
  try {
    if (task.kind === 'magnet') await startMagnet(task);
    else await startUrl(task);
  } catch (e) {
    runners.delete(task.id);
    task.state = 'error';
    task.error = String(e && e.message || e);
    task.updatedAt = Date.now();
    void save();
    pump();
  }
}

function pump() {
  if (!cache) return;
  const queued = cache.tasks.filter((t) => (t.state === 'active' || t.state === 'waiting') && !runners.has(t.id));
  for (const t of queued) {
    if (runners.size >= CONCURRENCY) break;
    void startTask(t);
  }
}

/* ───────────────────────── 投影 ───────────────────────── */

const STATE_NAME = { active: '进行中', paused: '已暂停', waiting: '等待 DHT 节点', done: '已完成', error: '出错' };

function fileExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function publicTask(t) {
  const waiting = t.state === 'waiting';
  const speed = waiting ? 0 : (t.kind === 'magnet' && t._speed != null ? t._speed : taskSpeed(t));
  const remaining = Math.max(0, (t.total || 0) - (t.done || 0));
  const eta = waiting ? null : (t.kind === 'magnet' && t._eta != null && t._eta > 0
    ? t._eta
    : (speed > 0 ? Math.round(remaining / speed * 1000) : null));
  const progress = t.total > 0 ? Math.min(100, (t.done / t.total) * 100) : (t.state === 'done' ? 100 : 0);
  return {
    id: t.id,
    kind: t.kind,
    name: t.name || '未命名',
    url: t.url || '',
    magnet: t.magnet || '',
    state: t.state,
    stateName: STATE_NAME[t.state] || t.state,
    progress: Math.round(progress * 10) / 10,
    total: t.total || 0,
    done: t.done || 0,
    speed: Math.round(speed),
    peers: t.kind === 'magnet' ? (t._peers || 0) : null,
    conns: t.kind === 'magnet' ? (t._conns || 0) : null,
    eta,
    error: t.error || '',
    file: t.file ? { name: path.basename(t.file.final || t.file.name || ''), path: t.file.final || '', exists: fileExists(t.file.final || '') } : null,
    media: mediaKind(t.file && t.file.final),
    playable: t.state === 'done' && !!(t.file && t.file.final && fileExists(t.file.final)) && !!mediaKind(t.file.final),
    files: t.files || [],
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    doneAt: t.doneAt || null,
  };
}

/* ───────────────────────── 响应 ───────────────────────── */

function sendJson(ctx, code, obj) {
  const body = JSON.stringify(obj);
  ctx.res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  ctx.res.end(body);
}

async function wtStatus() {
  if (!cfg.webtorrentEnabled) return { available: false, message: '配置里关闭了磁力下载' };
  if (wtClient) return { available: true, message: '磁力组件已就绪' };
  if (wtAttempted) return { available: false, message: wtError || '磁力组件没装好，直链下载不受影响' };
  return { available: null, message: '尚未加载（第一次加磁力任务时才加载）' };
}

/* ───────────────────────── 路由 ───────────────────────── */

export async function handle(ctx) {
  const st = await load();
  const p = ctx.p;

  // 跨源预请求
  if (ctx.method === 'OPTIONS') {
    ctx.res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    });
    ctx.res.end();
    return true;
  }

  if (p === '/api/download/list' && ctx.method === 'GET') {
    const items = st.tasks.map(publicTask);
    const active = items.filter((t) => t.state === 'active');
    const speed = active.reduce((s, t) => s + t.speed, 0);
    return sendJson(ctx, 200, {
      ok: true,
      dir: DOWNLOAD_DIR,
      concurrency: CONCURRENCY,
      magnet: await wtStatus(),
      totals: {
        total: items.length,
        active: active.length,
        paused: items.filter((t) => t.state === 'paused').length,
        waiting: items.filter((t) => t.state === 'waiting').length,
        done: items.filter((t) => t.state === 'done').length,
        error: items.filter((t) => t.state === 'error').length,
        speed,
      },
      items,
    });
  }

  if (p === '/api/download/add' && ctx.method === 'POST') {
    const b = await ctx.body();
    const magnet = String(b.magnet || '').trim();
    const url = String(b.url || '').trim();

    if (magnet) {
      if (!/^magnet:\?/i.test(magnet)) return sendJson(ctx, 400, { ok: false, message: '这不是磁力链接（应以 magnet:? 开头）' });
      const task = {
        id: uid(), kind: 'magnet', magnet, name: String(b.name || '').trim() || '磁力任务',
        state: 'waiting', total: 0, done: 0, error: '', file: null, files: [],
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      st.tasks.unshift(task);
      await save(); pump();
      return sendJson(ctx, 200, { ok: true, task: publicTask(task) });
    }

    if (url) {
      if (!/^https?:\/\//i.test(url)) return sendJson(ctx, 400, { ok: false, message: '直链需要以 http:// 或 https:// 开头' });
      const task = {
        id: uid(), kind: 'url', url,
        name: sanitizeName(b.name || nameFromUrl(url), nameFromUrl(url)),
        state: 'active', total: 0, done: 0, error: '', file: null, files: [],
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      st.tasks.unshift(task);
      await save(); pump();
      return sendJson(ctx, 200, { ok: true, task: publicTask(task) });
    }

    return sendJson(ctx, 400, { ok: false, message: '给一个直链 url，或一个磁力 magnet' });
  }

  if (p === '/api/download/pause' && ctx.method === 'POST') {
    const b = await ctx.body();
    const task = findTask(String(b.id || ''));
    if (!task) return sendJson(ctx, 404, { ok: false, message: '没有这个任务' });
    if (task.state !== 'active' && task.state !== 'waiting') return sendJson(ctx, 200, { ok: true, task: publicTask(task), message: '任务不在进行中' });

    task.state = 'paused';
    task.updatedAt = Date.now();
    const runner = runners.get(task.id);
    if (runner) {
      if (runner.kind === 'url' && runner.controller) runner.controller.abort();
      else if (runner.kind === 'magnet' && runner.torrent) {
        try { runner.torrent.pause(); } catch {}
        runners.delete(task.id);
      }
    }
    await save();
    return sendJson(ctx, 200, { ok: true, task: publicTask(task) });
  }

  if (p === '/api/download/resume' && ctx.method === 'POST') {
    const b = await ctx.body();
    const task = findTask(String(b.id || ''));
    if (!task) return sendJson(ctx, 404, { ok: false, message: '没有这个任务' });
    if (task.state === 'active') return sendJson(ctx, 200, { ok: true, task: publicTask(task), message: '已经在下载了' });
    if (task.state === 'done') return sendJson(ctx, 200, { ok: true, task: publicTask(task), message: '已经下完了' });

    task.state = task.kind === 'magnet' ? 'waiting' : 'active';
    task.error = '';
    task.updatedAt = Date.now();
    if (task._samples) task._samples = [];
    const blocked = runners.get(task.id);
    if (blocked && blocked.blocked) runners.delete(task.id);
    await save(); pump();
    return sendJson(ctx, 200, { ok: true, task: publicTask(task) });
  }

  if (p === '/api/download/delete' && ctx.method === 'POST') {
    const b = await ctx.body();
    const task = findTask(String(b.id || ''));
    if (!task) return sendJson(ctx, 404, { ok: false, message: '没有这个任务' });
    const removeFile = !!b.removeFile;

    const runner = runners.get(task.id);
    if (runner) {
      if (runner.kind === 'url' && runner.controller) runner.controller.abort();
      if (runner.kind === 'magnet' && runner.torrent) {
        try { runner.torrent.destroy({ destroyStore: removeFile }); } catch {}
      }
      runners.delete(task.id);
    }

    if (removeFile) {
      for (const f of [task.file && task.file.final, task.file && task.file.part]) {
        if (f) { try { await fsp.rm(f, { force: true }); } catch {} }
      }
      for (const f of task.files || []) {
        if (f && f.path) { try { await fsp.rm(f.path, { force: true }); } catch {} }
      }
    }

    st.tasks = st.tasks.filter((t) => t.id !== task.id);
    await save();
    return sendJson(ctx, 200, { ok: true, removed: 1, fileRemoved: removeFile });
  }

  if (p === '/api/download/clear-done' && ctx.method === 'POST') {
    const before = st.tasks.length;
    st.tasks = st.tasks.filter((t) => t.state !== 'done');
    await save();
    return sendJson(ctx, 200, { ok: true, removed: before - st.tasks.length });
  }

  if (p === '/api/download/detail' && ctx.method === 'GET') {
    const task = findTask(String(ctx.query.get('id') || ''));
    if (!task) return sendJson(ctx, 404, { ok: false, message: '没有这个任务' });
    return sendJson(ctx, 200, { ok: true, dir: DOWNLOAD_DIR, magnet: await wtStatus(), task: publicTask(task) });
  }

  /* 已完成任务的落盘文件直出（Range 由 ctx.file 处理；只允许该任务自己落盘的文件） */
  if (p === '/api/download/file' && ctx.method === 'GET') {
    const task = findTask(String(ctx.query.get('id') || ''));
    if (!task) return sendJson(ctx, 404, { ok: false, message: '没有这个任务' });
    if (task.state !== 'done') return sendJson(ctx, 409, { ok: false, message: '任务还没完成，暂不能播放' });
    const abs = safeDownloadFile(task.file && task.file.final);
    if (!abs) return sendJson(ctx, 404, { ok: false, message: '文件还没落盘或已被移走' });
    await ctx.file(abs, { 'access-control-allow-origin': '*' });
    return true;
  }

  return false;
}

/** 首页概览用，绝不抛错 */
export async function summary() {
  try {
    const st = await load();
    const items = st.tasks.map(publicTask);
    const active = items.filter((t) => t.state === 'active');
    const speed = active.reduce((s, t) => s + t.speed, 0);
    const recent = items.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 4);
    return {
      ready: true,
      path: '/download/',
      total: items.length,
      active: active.length,
      paused: items.filter((t) => t.state === 'paused').length,
      waiting: items.filter((t) => t.state === 'waiting').length,
      done: items.filter((t) => t.state === 'done').length,
      speed: Math.round(speed),
      dir: DOWNLOAD_DIR,
      tasks: recent.map((t) => ({
        id: t.id, name: t.name, state: t.state,
        progress: t.progress, speed: t.speed, eta: t.eta,
      })),
    };
  } catch {
    return { ready: true, path: '/download/', total: 0, active: 0, paused: 0, done: 0, speed: 0, dir: DOWNLOAD_DIR, tasks: [] };
  }
}

/** 启动：未完成的任务停在 paused，保留记录；已完成留着；不自动排队 */
export async function init() {
  const st = await load();
  for (const t of st.tasks) {
    if (t.state === 'active') { t.state = 'paused'; t.error = t.error || '重启后已暂停，点继续重新排队'; }
    // 历史遗留的磁力失败记录不挂红字：降级为等待节点态，直链失败保留 error 可重试
    if (t.kind === 'magnet' && t.state === 'error') {
      t.state = 'waiting';
      t.error = '本机 UDP/DHT 受限，暂未连上外网节点；直链下载不受影响。';
    }
  }
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  await save();
}
