/**
 * 相册 —— 索引本地相片目录，按时间轴出缩略图、大图查看，支持 DLNA 投屏
 *
 * 数据：runtime/photos.json（纯 JSON，重启不丢）
 * 缩略图：runtime/photos/thumbs/<sha1(绝对路径)>.jpg
 *
 * 只读原则：绝不写、改、删用户原始文件，绝不移动文件；写入只发生在 runtime/photos/。
 * 索引与缩略图生成都在后台跑，进度通过 /api/photos/scan-status 暴露；缩略图并发上限 4。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { roomConfig } from './rooms.mjs';
import { dlnaDiscover, dlnaCast } from './photos_dlna.mjs';

export const meta = { id: 'photos', name: '相册', color: '#7FB4C4' };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = path.join(ROOT, 'runtime', 'photos.json');
const THUMB_DIR = path.join(ROOT, 'runtime', 'photos', 'thumbs');

const IMG_EXT = ['jpg', 'jpeg', 'png', 'heic', 'webp', 'gif'];
const VID_EXT = ['mov', 'mp4', 'm4v'];
const ALL_EXT = new Set([...IMG_EXT, ...VID_EXT]);

const SIPS = '/usr/bin/sips';
const FFPROBE = '/usr/local/bin/ffprobe';
const FFMPEG = '/usr/local/bin/ffmpeg';

/* ───────────────────────── 配置 ───────────────────────── */

function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

const defaults = {
  dirs: ['~/Downloads', '~/Desktop', '~/Pictures'],
  concurrency: 4,
  thumbSize: 480,
  maxDepth: 12,
};
const cfg = roomConfig('photos', defaults);
const CONCURRENCY = Math.max(1, Math.min(8, Number(cfg.concurrency) || 4));
const THUMB_SIZE = Number(cfg.thumbSize) || 480;
const MAX_DEPTH = Number(cfg.maxDepth) || 12;
const SCAN_DIRS = (Array.isArray(cfg.dirs) && cfg.dirs.length ? cfg.dirs : defaults.dirs).map(expandHome);

/* ───────────────────────── 数据缓存 ───────────────────────── */

let cache = null; // { updatedAt, dirs, skipped:[], items:[] }
let writeTimer = null;
let writePending = false;

async function load() {
  if (cache) return cache;
  try {
    const raw = await fsp.readFile(DATA_FILE, 'utf8');
    const d = JSON.parse(raw);
    cache = {
      updatedAt: d.updatedAt || 0,
      dirs: Array.isArray(d.dirs) ? d.dirs : SCAN_DIRS.slice(),
      skipped: Array.isArray(d.skipped) ? d.skipped : [],
      items: Array.isArray(d.items) ? d.items : [],
    };
  } catch {
    cache = { updatedAt: 0, dirs: SCAN_DIRS.slice(), skipped: [], items: [] };
  }
  return cache;
}

async function save() {
  if (!cache) return;
  writePending = true;
  if (writeTimer) return;
  writeTimer = setTimeout(async () => {
    writeTimer = null;
    if (!writePending) return;
    writePending = false;
    try {
      await fsp.mkdir(path.dirname(DATA_FILE), { recursive: true });
      const tmp = DATA_FILE + '.tmp';
      await fsp.writeFile(tmp, JSON.stringify({
        updatedAt: Date.now(),
        dirs: cache.dirs,
        skipped: cache.skipped,
        items: cache.items,
      }, null, 2));
      await fsp.rename(tmp, DATA_FILE);
    } catch (e) {
      console.error('[photos] 落盘失败:', e && e.message);
    }
  }, 250);
}

/* ───────────────────────── 工具 ───────────────────────── */

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const extOf = (p) => path.extname(p).slice(1).toLowerCase();
const kindOf = (ext) => (VID_EXT.includes(ext) ? 'video' : 'image');
const monthKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const monthLabel = (key) => {
  const [y, m] = key.split('-');
  return `${y} 年 ${Number(m)} 月`;
};

function run(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 256 * 1024 }, (err, stdout) => {
      resolve({ ok: !err, stdout: String(stdout || '') });
    });
  });
}

/** 时间下限：2000-01-01；更早的（如纪元零值 1970-01-01）视为无效 */
const MIN_VALID_MS = 946684800000;
function validMs(ms) { return Number.isFinite(ms) && ms >= MIN_VALID_MS; }

/** 元数据时间：视频先 ffprobe，图片先 sips，都失败退到 mtime */
async function readMetaDate(abs, ext, mtimeMs) {
  if (VID_EXT.includes(ext)) {
    const r = await run(FFPROBE, ['-v', 'quiet', '-print_format', 'json', '-show_entries', 'format_tags=creation_time', '-i', abs]);
    if (r.ok) {
      try {
        const j = JSON.parse(r.stdout);
        const t = j && j.format && j.format.tags && j.format.tags.creation_time;
        if (t) {
          const ms = Date.parse(t);
          if (validMs(ms)) return { date: ms, source: 'metadata' };
        }
      } catch {}
    }
  } else {
    const r = await run(SIPS, ['-g', 'creation', abs]);
    if (r.ok) {
      const m = /creation:\s*(.+)/.exec(r.stdout);
      if (m && !/<nil>/.test(m[1])) {
        const ms = Date.parse(m[1].trim());
        if (validMs(ms)) return { date: ms, source: 'metadata' };
      }
    }
  }
  return { date: mtimeMs, source: 'mtime' };
}

/** 并发池：最多 n 个同时跑 */
async function pool(n, items, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** 本机局域网 IPv4（非内网回环） */
function lanIPv4() {
  const ifs = os.networkInterfaces();
  for (const list of Object.values(ifs)) {
    for (const it of list || []) {
      if (it.family === 'IPv4' && !it.internal) return it.address;
    }
  }
  return null;
}

/* ───────────────────────── 目录遍历 ───────────────────────── */

async function walkDir(abs, depth, acc, skipped) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = await fsp.readdir(abs, { withFileTypes: true });
  } catch (e) {
    const reason = e && e.code === 'EPERM'
      ? '系统相册库受保护，未索引（读取被拒绝 EPERM）'
      : `读取失败：${e && e.message || e.code || '未知错误'}`;
    if (!skipped.some((s) => s.dir === abs)) skipped.push({ dir: abs, reason });
    return;
  }
  for (const ent of entries) {
    const full = path.join(abs, ent.name);
    if (ent.isDirectory()) {
      if (ent.name.endsWith('.photoslibrary')) {
        if (!skipped.some((s) => s.dir === full)) {
          skipped.push({ dir: full, reason: '系统相册库受保护，未索引（包目录，EPERM）' });
        }
        continue;
      }
      if (ent.name.startsWith('.')) continue; // 隐藏目录不钻
      await walkDir(full, depth + 1, acc, skipped);
    } else if (ent.isFile()) {
      const ext = extOf(ent.name);
      if (!ALL_EXT.has(ext)) continue;
      let st;
      try { st = await fsp.stat(full); } catch { continue; }
      acc.push({ path: full, name: ent.name, ext, size: st.size, mtime: st.mtimeMs });
    }
  }
}

/* ───────────────────────── 缩略图 ───────────────────────── */

const thumbPathOf = (id) => path.join(THUMB_DIR, `${id}.jpg`);

async function thumbStat(id) {
  try { return await fsp.stat(thumbPathOf(id)); } catch { return null; }
}

async function thumbExists(id) {
  const st = await thumbStat(id);
  return !!(st && st.size > 0);
}

/**
 * 缩略图是否仍然有效：
 * - 视频首帧必须由 ffmpeg 生成（旧记录由 sips 出黑图，没有 thumbKind 标记 → 判失效重生成）；
 * - 源文件改过（mtime/大小变化）后旧缩略图也作废；
 * - 记录了 thumbError 的条目不再重试生成（页面走明确卡片兜底）。
 */
async function thumbFresh(item) {
  if (item.thumbError) return false;
  const st = await thumbStat(item.id);
  if (!st || st.size <= 0) return false;
  if (item.kind === 'video' && item.thumbKind !== 'video') return false;
  if (item.thumbMtime && item.mtime > item.thumbMtime) return false;
  if (item.thumbSize && item.size !== item.thumbSize) return false;
  return true;
}

/** 视频时长（秒），取不到返回 null */
async function readDuration(abs) {
  const r = await run(FFPROBE, ['-v', 'quiet', '-print_format', 'json', '-show_entries', 'format=duration', '-i', abs]);
  if (r.ok) {
    try {
      const j = JSON.parse(r.stdout);
      const d = Number(j && j.format && j.format.duration);
      if (Number.isFinite(d) && d > 0) return Math.round(d);
    } catch {}
  }
  return null;
}

async function makeThumb(item) {
  const out = thumbPathOf(item.id);
  await fsp.mkdir(THUMB_DIR, { recursive: true });

  if (item.kind === 'video') {
    // 视频：ffmpeg 抽帧。片头常是黑标题卡，按候选时间点依次试；
    // 输出太小（< 8KB）视为黑帧继续往后挑；全部不达标才判失败。
    const vf = `scale=${THUMB_SIZE}:-2`;
    const FRAME_MIN_BYTES = 8000;
    for (const ss of ['0.5', '1', '3', '6', '20', '0']) {
      const r = await run(FFMPEG, ['-y', '-ss', ss, '-i', item.path, '-frames:v', '1', '-vf', vf, '-q:v', '4', out], 15000);
      const st = await thumbStat(item.id);
      if (r.ok && st && st.size >= FRAME_MIN_BYTES) {
        item.thumbKind = 'video';
        item.thumbMtime = item.mtime;
        item.thumbSize = item.size;
        item.thumbError = false;
        return true;
      }
    }
    // 失败：删掉可能残留的黑帧文件，避免接口继续吐出纯黑缩略图
    try { await fsp.rm(out, { force: true }); } catch {}
    item.thumbError = true;
    return false;
  }

  const r1 = await run(SIPS, ['-Z', String(THUMB_SIZE), '-s', 'format', 'jpeg', item.path, '--out', out], 12000);
  if (r1.ok && await thumbExists(item.id)) {
    item.thumbKind = 'image';
    item.thumbMtime = item.mtime;
    item.thumbSize = item.size;
    item.thumbError = false;
    return true;
  }
  // ffmpeg 兜底（sips 搞不定的格式）
  const vf = `scale=w=${THUMB_SIZE}:h=${THUMB_SIZE}:force_original_aspect_ratio=decrease`;
  const r2 = await run(FFMPEG, ['-y', '-i', item.path, '-frames:v', '1', '-vf', vf, out], 15000);
  if (r2.ok && await thumbExists(item.id)) {
    item.thumbKind = 'image';
    item.thumbMtime = item.mtime;
    item.thumbSize = item.size;
    item.thumbError = false;
    return true;
  }
  item.thumbError = true;
  return false;
}

/* ───────────────────────── 扫描任务 ───────────────────────── */

const status = {
  running: false,
  phase: 'idle', // idle | walk | meta | thumbs | done
  total: 0,
  metaDone: 0,
  thumbsDone: 0,
  thumbsFail: 0,
  thumbsTotal: 0,
  current: '',
  startedAt: 0,
  finishedAt: 0,
  message: '',
};

async function scanTask() {
  const st = await load();
  status.running = true;
  status.phase = 'walk';
  status.startedAt = Date.now();
  status.finishedAt = 0;
  status.message = '正在遍历目录…';

  const found = [];
  const skipped = [];
  for (const dir of SCAN_DIRS) {
    status.current = dir;
    let ok = true;
    try {
      await fsp.stat(dir);
    } catch {
      ok = false;
      skipped.push({ dir, reason: '目录不存在' });
    }
    if (ok) await walkDir(dir, 0, found, skipped);
  }

  // 以路径去重，保留旧记录里已有的元数据
  const oldByPath = new Map(st.items.map((x) => [x.path, x]));
  const items = found.map((f) => {
    const old = oldByPath.get(f.path);
    return old && old.mtime === f.mtime && old.size === f.size && validMs(old.date)
      ? old
      : {
          id: sha1(f.path),
          path: f.path,
          name: f.name,
          ext: f.ext,
          kind: kindOf(f.ext),
          size: f.size,
          mtime: f.mtime,
          date: f.mtime,
          month: monthKey(f.mtime),
          dateSource: 'mtime',
        };
  });

  st.items = items;
  st.dirs = SCAN_DIRS.slice();
  st.skipped = skipped;
  status.total = items.length;
  status.metaDone = 0;
  status.message = `已找到 ${items.length} 个文件，正在读取拍摄时间…`;
  await save();

  // 元数据时间补全（并发 4）
  status.phase = 'meta';
  const needMeta = items.filter((x) => x.dateSource !== 'metadata' || (x.kind === 'video' && x.duration == null));
  await pool(CONCURRENCY, needMeta, async (it) => {
    const meta = await readMetaDate(it.path, it.ext, it.mtime);
    it.date = meta.date;
    it.month = monthKey(meta.date);
    it.dateSource = meta.source;
    if (it.kind === 'video') it.duration = await readDuration(it.path);
    status.metaDone += 1;
    status.current = it.name;
  });
  status.message = `时间读取完成，正在生成缩略图（并发 ${CONCURRENCY}）…`;
  await save();

  // 缩略图队列（并发 4，已存在跳过）
  status.phase = 'thumbs';
  const missing = [];
  for (const it of items) {
    if (await thumbFresh(it)) status.thumbsDone += 1;
    else missing.push(it);
  }
  status.thumbsTotal = status.thumbsDone + missing.length;
  status.thumbsFail = 0;

  await pool(CONCURRENCY, missing, async (it) => {
    status.current = it.name;
    const ok = await makeThumb(it);
    if (ok) status.thumbsDone += 1;
    else status.thumbsFail += 1;
  });

  status.phase = 'done';
  status.finishedAt = Date.now();
  status.running = false;
  status.message = `完成：${items.length} 个文件，${status.thumbsDone} 张缩略图，${status.thumbsFail} 个失败`;
  await save();
}

function startScan() {
  if (status.running) return false;
  scanTask().catch((e) => {
    status.running = false;
    status.phase = 'done';
    status.message = '扫描出错：' + (e && e.message || e);
    console.error('[photos] 扫描失败:', e);
  });
  return true;
}

/* ───────────────────────── 路由辅助 ───────────────────────── */

function publicItem(it, hasThumb) {
  return {
    id: it.id,
    name: it.name,
    ext: it.ext,
    kind: it.kind,
    size: it.size,
    date: it.date,
    month: it.month,
    dir: path.dirname(it.path),
    dateSource: it.dateSource,
    duration: it.duration ?? null,
    thumbError: !!it.thumbError,
    thumb: !!hasThumb,
  };
}

function findItem(id) {
  return cache.items.find((x) => x.id === id) || null;
}

async function ensureThumbInline(item) {
  if (await thumbFresh(item)) return true;
  try {
    return await makeThumb(item);
  } catch {
    item.thumbError = true;
    return false;
  }
}

/* ───────────────────────── 路由 ───────────────────────── */

export async function handle(ctx) {
  const st = await load();
  const p = ctx.p;

  /* 列表：按月分组，分页懒加载（一次最多 60） */
  if (p === '/api/photos/list' && ctx.method === 'GET') {
    const month = (ctx.query.get('month') || '').trim();
    const offset = Math.max(0, Number(ctx.query.get('offset') || 0));
    const limit = Math.min(60, Math.max(1, Number(ctx.query.get('limit') || 60)));

    let sorted = st.items.slice().sort((a, b) => (b.date || 0) - (a.date || 0));
    if (month) sorted = sorted.filter((x) => x.month === month);

    // 月份分组（全量，只给 key/label/count，不塞文件）
    const byMonth = new Map();
    for (const x of st.items) {
      const m = byMonth.get(x.month) || { key: x.month, label: monthLabel(x.month), count: 0 };
      m.count += 1;
      byMonth.set(x.month, m);
    }
    const months = [...byMonth.values()].sort((a, b) => b.key.localeCompare(a.key));

    const page = sorted.slice(offset, offset + limit);
    const thumbs = await pool(1, page, async (it) => {
      if (it.kind === 'video' && it.duration == null) it.duration = await readDuration(it.path);
      return { it, has: await thumbFresh(it) };
    });
    await save();

    return ctx.json(200, {
      ok: true,
      total: sorted.length,
      months,
      offset,
      limit,
      items: thumbs.map((t) => publicItem(t.it, t.has)),
      dirs: st.dirs,
      skipped: st.skipped,
      updatedAt: st.updatedAt,
    });
  }

  /* 触发扫描（后台跑，立即返回） */
  if (p === '/api/photos/scan' && ctx.method === 'POST') {
    const started = startScan();
    return ctx.json(200, { ok: true, started, status: statusSnapshot() });
  }

  /* 扫描 / 缩略图进度 */
  if (p === '/api/photos/scan-status' && ctx.method === 'GET') {
    return ctx.json(200, { ok: true, status: statusSnapshot(), total: st.items.length });
  }

  /* 缩略图 */
  if (p === '/api/photos/thumb' && ctx.method === 'GET') {
    const id = (ctx.query.get('id') || '').trim();
    const it = findItem(id);
    if (!it) return ctx.json(404, { ok: false, message: '没有这张图' });
    if (!(await thumbFresh(it))) {
      // 按需生成/重生成（受全局并发上限保护：后台任务与内联共用同一批资源）
      await ensureThumbInline(it);
      await save();
    }
    const fp = thumbPathOf(id);
    if (await thumbExists(id)) {
      await ctx.file(fp, { 'content-type': 'image/jpeg' });
      return true;
    }
    return ctx.json(500, { ok: false, message: '缩略图生成失败' });
  }

  /* 原图（支持 Range，ctx.file 处理） */
  if (p === '/api/photos/full' && ctx.method === 'GET') {
    const id = (ctx.query.get('id') || '').trim();
    const it = findItem(id);
    if (!it) return ctx.json(404, { ok: false, message: '文件不见了' });
    await ctx.file(it.path);
    return true;
  }

  /* 单条信息 */
  if (p === '/api/photos/info' && ctx.method === 'GET') {
    const id = (ctx.query.get('id') || '').trim();
    const it = findItem(id);
    if (!it) return ctx.json(404, { ok: false, message: '没有这张图' });
    let dims = null;
    let duration = it.duration ?? null;
    if (it.kind === 'image') {
      const r = await run(SIPS, ['-g', 'pixelWidth', '-g', 'pixelHeight', it.path]);
      const w = /pixelWidth:\s*(\d+)/.exec(r.stdout);
      const h = /pixelHeight:\s*(\d+)/.exec(r.stdout);
      if (w && h) dims = { width: Number(w[1]), height: Number(h[1]) };
    } else {
      const r = await run(FFPROBE, ['-v', 'quiet', '-print_format', 'json', '-show_entries', 'stream=width,height:format=duration', '-i', it.path]);
      if (r.ok) {
        try {
          const j = JSON.parse(r.stdout);
          const s = (j.streams || [])[0];
          if (s && s.width && s.height) dims = { width: Number(s.width), height: Number(s.height) };
          const d = Number(j && j.format && j.format.duration);
          if (Number.isFinite(d) && d > 0) duration = Math.round(d);
        } catch {}
      }
    }
    return ctx.json(200, {
      ok: true,
      item: Object.assign(publicItem(it, true), {
        path: it.path,
        dims,
        duration,
        thumbUrl: `/api/photos/thumb?id=${id}`,
        fullUrl: `/api/photos/full?id=${id}`,
      }),
    });
  }

  /* 本机网络信息（投屏提示用） */
  if (p === '/api/photos/lan' && ctx.method === 'GET') {
    return ctx.json(200, {
      ok: true,
      lanIP: lanIPv4(),
      lanMode: process.argv.includes('--lan'),
      port: Number(process.env.PORT || 8890),
      bound: process.argv.includes('--lan') ? '0.0.0.0' : '127.0.0.1',
    });
  }

  /* DLNA 发现（限时 3 秒） */
  if (p === '/api/photos/dlna/discover' && ctx.method === 'POST') {
    const res = await dlnaDiscover(3000).catch((e) => ({ devices: [], message: '发现过程出错：' + (e && e.message || e) }));
    return ctx.json(200, {
      ok: true,
      lanIP: lanIPv4(),
      lanMode: process.argv.includes('--lan'),
      port: Number(process.env.PORT || 8890),
      devices: res.devices || [],
      message: res.message || '',
    });
  }

  /* DLNA 投屏 */
  if (p === '/api/photos/dlna/cast' && ctx.method === 'POST') {
    const b = await ctx.body();
    const deviceId = String(b.deviceId || '');
    const id = String(b.id || '');
    const it = findItem(id);
    if (!it) return ctx.json(404, { ok: false, message: '没有这张图' });
    const lanIP = lanIPv4();
    const lanMode = process.argv.includes('--lan');
    const port = Number(process.env.PORT || 8890);
    const uri = lanIP ? `http://${lanIP}:${port}/api/photos/full?id=${id}` : '';
    const res = await dlnaCast(deviceId, uri).catch((e) => ({ ok: false, message: '投屏失败：' + (e && e.message || e) }));
    return ctx.json(200, {
      ok: !!res.ok,
      message: res.message || (res.ok ? '已发送到电视' : '投屏未成功'),
      device: res.device || null,
      uri,
      lanIP,
      lanMode,
      warning: lanMode ? null : '客厅当前只监听 127.0.0.1，电视无法访问这个直链；需用 --lan 方式重启客厅。',
    });
  }

  return false;
}

function statusSnapshot() {
  return Object.assign({}, status);
}

/* ───────────────────────── 首页小结（绝不抛错） ───────────────────────── */

export async function summary() {
  try {
    const st = await load();
    const items = st.items || [];
    const months = new Set(items.map((x) => x.month));
    let thumbs = 0;
    for (const it of items) {
      if (fs.existsSync(thumbPathOf(it.id))) thumbs += 1;
    }
    const latest = items.slice().sort((a, b) => (b.date || 0) - (a.date || 0))[0];
    return {
      ready: true,
      path: '/photos/',
      total: items.length,
      months: months.size,
      thumbs,
      latest: latest ? { id: latest.id, date: latest.date, name: latest.name } : null,
      skipped: st.skipped || [],
      scanning: status.running,
    };
  } catch (e) {
    return { ready: true, path: '/photos/', total: 0, months: 0, thumbs: 0, latest: null, skipped: [] };
  }
}

export async function init() {
  const st = await load();
  // 首次没有数据时，后台开扫，不阻塞启动；已有数据就等页面点「重新扫描」
  if (!st.items.length) {
    setTimeout(() => startScan(), 600);
  }
}
