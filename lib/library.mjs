/**
 * 媒体库 —— 本地影片聚合、豆瓣刮削、海报缓存、续播进度
 *
 * 数据：runtime/library.json（影片分组 + 进度 + 刮削缓存），重启不丢
 * 缓存：runtime/library/posters/<doubanId>.jpg（海报只写这里，原始影片只读）
 * 配置：config/library.json（扫描目录、并发、缓存天数），缺文件用代码默认值
 *
 * 契约：
 *   export meta / handle(ctx) / summary() / init()
 *   handle 返回 true 已处理；false 没这接口；undefined 已自行响应
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { parseFileName, queryParts, fmtSize, fmtDuration } from './library_parse.mjs';
import { matchSubject, abstract, downloadPoster, pool } from './library_douban.mjs';
import { walkVideos, expandHome, statInfo, probe, DEFAULT_EXTS } from './library_media.mjs';

export const meta = { id: 'library', name: '媒体库', color: '#9CAC69' };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = path.join(ROOT, 'runtime', 'library.json');
const CONFIG_FILE = path.join(ROOT, 'config', 'library.json');
const POSTERS_DIR = path.join(ROOT, 'runtime', 'library', 'posters');

const DEFAULTS = {
  roots: ['~/Movies', '~/Downloads/五五下载', '~/Downloads'],
  extensions: DEFAULT_EXTS,
  concurrency: 4,
  ttlDays: 30,
  maxDepth: 4,
};

let cache = null;
let writeTimer = null;
let writePending = false;

/* ───────────────────────── 配置 / 落盘 ───────────────────────── */

function getConfig() {
  let disk = {};
  try { disk = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}; } catch {}
  return Object.assign({}, DEFAULTS, disk);
}

async function load() {
  if (cache) return cache;
  try {
    const raw = await fsp.readFile(DATA_FILE, 'utf8');
    const d = JSON.parse(raw);
    cache = {
      movies: Array.isArray(d.movies) ? d.movies : [],
      series: Array.isArray(d.series) ? d.series : [],
      progress: d.progress && typeof d.progress === 'object' ? d.progress : {},
      scrapeCache: d.scrapeCache && typeof d.scrapeCache === 'object' ? d.scrapeCache : {},
      updatedAt: d.updatedAt || 0,
    };
  } catch {
    // JSON 损坏当空数据继续跑，不许让客厅 500
    cache = { movies: [], series: [], progress: {}, scrapeCache: {}, updatedAt: 0 };
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
        movies: cache.movies,
        series: cache.series,
        progress: cache.progress,
        scrapeCache: cache.scrapeCache,
        updatedAt: cache.updatedAt,
      }, null, 2));
      await fsp.rename(tmp, DATA_FILE);
    } catch (e) {
      console.error('[library] 落盘失败:', e && e.message);
    }
  }, 200);
}

/* ───────────────────────── 工具 ───────────────────────── */

function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return 'g' + (h >>> 0).toString(36);
}

/** 校验绝对路径确实落在配置的扫描目录内，防任意文件读取 */
function safeMediaPath(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const cfg = getConfig();
  const roots = cfg.roots.map((r) => path.resolve(expandHome(r)));
  const abs = path.resolve(raw);
  for (const root of roots) {
    if (abs === root || abs.startsWith(root + path.sep)) return abs;
  }
  return null;
}

/* ───────────────────────── 刮削 ───────────────────────── */

async function scrapeGroup(g, cfg, data) {
  const queries = queryParts(g.localTitle);
  let m;
  try {
    m = await matchSubject(queries, g.localTitle, g.year);
  } catch {
    return null;
  }
  if (!m || !m.id) return null;

  const ttl = cfg.ttlDays * 24 * 3600 * 1000;
  let cached = data.scrapeCache[m.id];
  const fresh = cached && (Date.now() - (cached.scrapedAt || 0) < ttl);

  if (!fresh) {
    let ab = {};
    try { ab = await abstract(m.id); } catch { ab = {}; }
    const poster = await downloadPoster(m.img, m.id, POSTERS_DIR);
    cached = Object.assign({}, m, ab, { poster, scrapedAt: Date.now() });
    data.scrapeCache[m.id] = cached;
  }

  return {
    id: cached.id,
    title: cached.title || m.title,
    year: cached.year || m.year,
    subTitle: cached.subTitle || '',
    type: cached.type || '',
    rate: cached.rate || '',
    episodesCount: cached.episodesCount || '',
    intro: cached.intro || '',
    types: cached.types || [],
    region: cached.region || '',
    duration: cached.duration || '',
    poster: !!cached.poster,
    scrapedAt: cached.scrapedAt,
  };
}

/* ───────────────────────── 扫描 ───────────────────────── */

const scanState = {
  running: false,
  startedAt: 0,
  finishedAt: 0,
  found: 0,
  scraped: 0,
  message: '尚未扫描',
};

async function runScan() {
  if (scanState.running) return scanState;
  scanState.running = true;
  scanState.startedAt = Date.now();
  scanState.finishedAt = 0;
  scanState.message = '正在扫描目录…';

  const cfg = getConfig();
  const data = await load();

  try {
    // 1. 收集视频文件（异步遍历，深度封顶）
    let files = [];
    for (const root of cfg.roots) {
      const v = await walkVideos(root, cfg.extensions, cfg.maxDepth);
      files.push(...v);
    }
    files = [...new Set(files)];
    scanState.found = files.length;
    scanState.message = '正在读取文件信息…';

    // 2. 取大小/时长/分辨率，限并发
    const entries = await pool(files, cfg.concurrency, async (abs) => {
      const parsed = parseFileName(path.basename(abs));
      const [st, pr] = await Promise.all([statInfo(abs), probe(abs)]);
      return {
        abs, parsed,
        size: st.size, mtime: st.mtime,
        duration: pr.duration, width: pr.width, height: pr.height,
      };
    });

    // 3. 分组：有季集 / 多集归剧集，其余为电影
    const groups = new Map();
    for (const e of entries) {
      const k = e.parsed.key;
      if (!groups.has(k)) {
        groups.set(k, {
          id: hashStr(k),
          kind: e.parsed.isEpisode ? 'series' : 'movie',
          localTitle: e.parsed.title,
          year: e.parsed.year,
          files: [],
          scrape: null,
        });
      }
      const g = groups.get(k);
      g.files.push({
        key: e.abs,
        path: e.abs,
        name: path.basename(e.abs),
        size: e.size,
        mtime: e.mtime,
        season: e.parsed.season,
        episode: e.parsed.episode,
        duration: e.duration,
        width: e.width,
        height: e.height,
      });
    }
    for (const g of groups.values()) {
      if (g.files.length > 1) g.kind = 'series';
    }

    // 4. 豆瓣刮削，限并发；失败不阻塞页面
    scanState.message = '正在刮削豆瓣…';
    const grpArr = [...groups.values()];
    await pool(grpArr, cfg.concurrency, async (g) => {
      try { g.scrape = await scrapeGroup(g, cfg, data); } catch { g.scrape = null; }
    });

    // 5. 落盘；进度与刮削缓存保留
    data.movies = grpArr.filter((g) => g.kind === 'movie');
    data.series = grpArr.filter((g) => g.kind !== 'movie');
    data.updatedAt = Date.now();
    scanState.scraped = grpArr.filter((g) => g.scrape).length;
    scanState.message = '扫描完成';
    await save();
  } catch (e) {
    scanState.message = '扫描出错：' + (e && e.message || e);
    console.error('[library] 扫描失败:', e && e.message);
  } finally {
    scanState.running = false;
    scanState.finishedAt = Date.now();
    await save();
  }
  return scanState;
}

/* ───────────────────────── 对外视图 ───────────────────────── */

function publicFile(f, progress) {
  const p = progress[f.key];
  return {
    key: f.key,
    path: f.path,
    name: f.name,
    size: f.size,
    sizeText: fmtSize(f.size),
    season: f.season,
    episode: f.episode,
    duration: f.duration,
    durationText: fmtDuration(f.duration),
    width: f.width,
    height: f.height,
    progress: p ? { seconds: p.seconds, duration: p.duration, updatedAt: p.updatedAt } : null,
  };
}

function publicGroup(g, progress) {
  const files = g.files.map((f) => publicFile(f, progress));
  const watched = files.filter((f) => f.progress);
  return {
    id: g.id,
    kind: g.kind,
    localTitle: g.localTitle,
    year: g.year,
    fileCount: files.length,
    files,
    scrape: g.scrape,
    posterUrl: g.scrape && g.scrape.poster ? `/library/poster/${g.scrape.id}` : '',
    watchedCount: watched.length,
  };
}

function findGroup(data, id) {
  return data.movies.find((g) => g.id === id) || data.series.find((g) => g.id === id) || null;
}

/** 按文件路径找所属分组；找不到返回 null */
function findGroupByFile(data, abs) {
  for (const g of [...data.movies, ...data.series]) {
    if ((g.files || []).some((f) => f.key === abs || f.path === abs)) return g;
  }
  return null;
}

/**
 * 单文件 upsert：下载完直接跳进媒体库用。
 * 复用现有解析 / stat / probe / 刮削；已索引就原地返回，缺分组才新建。
 */
async function upsertFile(abs, cfg, data) {
  const existing = findGroupByFile(data, abs);
  if (existing) return existing;

  const parsed = parseFileName(path.basename(abs));
  const [st, pr] = await Promise.all([statInfo(abs), probe(abs)]);
  const group = {
    id: hashStr(parsed.key),
    kind: parsed.isEpisode ? 'series' : 'movie',
    localTitle: parsed.title,
    year: parsed.year,
    files: [{
      key: abs,
      path: abs,
      name: path.basename(abs),
      size: st.size,
      mtime: st.mtime,
      season: parsed.season,
      episode: parsed.episode,
      duration: pr.duration,
      width: pr.width,
      height: pr.height,
    }],
    scrape: null,
  };

  const same = findGroup(data, group.id);
  if (same) {
    if (!same.files.some((f) => f.path === abs)) same.files.push(group.files[0]);
    if (same.files.length > 1) same.kind = 'series';
    return same;
  }

  try { group.scrape = await scrapeGroup(group, cfg, data); } catch { group.scrape = null; }
  if (group.kind === 'series') data.series.push(group);
  else data.movies.push(group);
  return group;
}

/* ───────────────────────── 路由 ───────────────────────── */

export async function handle(ctx) {
  const data = await load();
  const cfg = getConfig();
  const p = ctx.p;

  /* 列表 */
  if (p === '/api/library/list' && ctx.method === 'GET') {
    const movies = data.movies.map((g) => publicGroup(g, data.progress));
    const series = data.series.map((g) => publicGroup(g, data.progress));
    return ctx.json(200, {
      ok: true,
      totalFiles: movies.reduce((s, g) => s + g.fileCount, 0) + series.reduce((s, g) => s + g.fileCount, 0),
      movies,
      series,
      scan: { ...scanState },
      updatedAt: data.updatedAt,
      roots: cfg.roots,
    });
  }

  /* 手动触发扫描（后台跑，接口先返回） */
  if (p === '/api/library/scan' && ctx.method === 'POST') {
    if (!scanState.running) {
      // 后台异步，不挂死请求
      runScan().catch(() => {});
    }
    return ctx.json(200, { ok: true, scan: { ...scanState } });
  }

  /* 扫描进度 */
  if (p === '/api/library/scan-status' && ctx.method === 'GET') {
    return ctx.json(200, { ok: true, scan: { ...scanState } });
  }

  /* 详情 */
  if (p === '/api/library/detail' && ctx.method === 'GET') {
    const id = ctx.query.get('id') || '';
    const g = findGroup(data, id);
    if (!g) return ctx.json(404, { ok: false, message: '没有这部片子' });
    return ctx.json(200, { ok: true, item: publicGroup(g, data.progress) });
  }

  /* 下载中心深链：按绝对路径定位；未索引则先 upsert 进库，返回分组 id */
  if (p === '/api/library/ensure' && ctx.method === 'GET') {
    const abs = safeMediaPath(ctx.query.get('path') || '');
    if (!abs) return ctx.json(403, { ok: false, message: '路径不在允许的目录内' });
    try { await fsp.stat(abs); } catch { return ctx.json(404, { ok: false, message: '文件不存在' }); }
    const g = await upsertFile(abs, cfg, data);
    await save();
    return ctx.json(200, { ok: true, id: g.id, item: publicGroup(g, data.progress) });
  }

  /* 海报：/api/library/poster?id= 与 /library/poster/<id> */
  let posterId = null;
  if (p === '/api/library/poster' && ctx.method === 'GET') {
    posterId = ctx.query.get('id') || '';
  } else if (p.startsWith('/library/poster/')) {
    posterId = decodeURIComponent(p.slice('/library/poster/'.length));
  }
  if (posterId !== null) {
    if (!/^[\w-]{1,32}$/.test(posterId)) return ctx.json(404, { ok: false, message: '海报编号不合法' });
    const file = path.join(POSTERS_DIR, `${posterId}.jpg`);
    try {
      await fsp.stat(file);
    } catch {
      return ctx.json(404, { ok: false, message: '海报还没缓存' });
    }
    await ctx.file(file);
    return true;
  }

  /* 本地视频流（Range 由 ctx.file 处理；路径必须在扫描目录内） */
  if (p === '/api/library/media' && ctx.method === 'GET') {
    const abs = safeMediaPath(ctx.query.get('path') || '');
    if (!abs) return ctx.json(403, { ok: false, message: '路径不在允许的目录内' });
    await ctx.file(abs);
    return true;
  }

  /* 进度上报 */
  if (p === '/api/library/progress' && ctx.method === 'POST') {
    const b = await ctx.body();
    const abs = safeMediaPath(b.path || '');
    if (!abs) return ctx.json(403, { ok: false, message: '路径不在允许的目录内' });
    const seconds = Math.max(0, Number(b.seconds) || 0);
    const duration = Math.max(0, Number(b.duration) || 0);
    data.progress[abs] = {
      seconds,
      duration,
      updatedAt: Date.now(),
      groupId: String(b.groupId || ''),
      title: String(b.title || '').slice(0, 120),
      episode: b.episode == null ? null : String(b.episode),
    };
    await save();
    return ctx.json(200, { ok: true, progress: data.progress[abs] });
  }

  /* 用系统播放器打开（子进程，detached，不阻塞） */
  if (p === '/api/library/open' && ctx.method === 'GET') {
    const abs = safeMediaPath(ctx.query.get('path') || '');
    if (!abs) return ctx.json(403, { ok: false, message: '路径不在允许的目录内' });
    try {
      const c = spawn('open', [abs], { detached: true, stdio: 'ignore' });
      c.unref();
      return ctx.json(200, { ok: true });
    } catch (e) {
      return ctx.json(500, { ok: false, message: e && e.message || '打不开' });
    }
  }

  return false;
}

/* ───────────────────────── 首页小结 ───────────────────────── */

export async function summary() {
  const data = await load();
  let totalFiles = 0;
  let scraped = 0;
  for (const g of [...data.movies, ...data.series]) {
    totalFiles += (g.files || []).length;
    if (g.scrape) scraped += 1;
  }
  const playing = Object.entries(data.progress)
    .map(([path, p]) => ({
      path,
      groupId: p.groupId || '',
      title: p.title || path.basename(path),
      episode: p.episode || null,
      progress: p.duration > 0 ? Math.min(1, p.seconds / p.duration) : 0,
      seconds: p.seconds,
      duration: p.duration,
      updatedAt: p.updatedAt,
    }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 3);

  return {
    ready: true,
    path: '/library/',
    total: totalFiles,
    movies: data.movies.length,
    series: data.series.length,
    scraped,
    playing,
  };
}

/* ───────────────────────── 启动 ───────────────────────── */

export async function init() {
  await load();
  // 首次启动后台自动扫一次；不阻塞启动，也不与手动触发重复
  setTimeout(() => { runScan().catch(() => {}); }, 300);
}
