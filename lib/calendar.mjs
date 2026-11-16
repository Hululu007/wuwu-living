/**
 * 追更日历 —— RSS 订阅 + B 站番剧表 + 手动追更，凑成一张本周时间表
 *
 * 数据：runtime/calendar.json（纯 JSON，重启不丢；损坏当空数据继续跑，不许 500）
 * 封面：runtime/calendar/covers/，本地缓存，不热链 B 站
 * 抓取：页面打开超过 10 分钟后台补抓；模块内每 10 分钟自查一次；请求永远先返回缓存
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { fetchFeed, UA } from './calendar_feeds.mjs';

export const meta = { id: 'calendar', name: '追更日历', color: '#C489A9' };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = path.join(ROOT, 'runtime', 'calendar.json');
const CONFIG_FILE = path.join(ROOT, 'config', 'calendar.json');
const COVER_DIR = path.join(ROOT, 'runtime', 'calendar', 'covers');
const BILI_TIMELINE = 'https://api.bilibili.com/pgc/web/timeline?types=1&before=6&after=6';

const DEFAULT_CFG = {
  feeds: [
    { url: 'https://sspai.com/feed', name: '少数派' },
    { url: 'https://www.gcores.com/rss', name: '机核' },
    { url: 'https://36kr.com/feed', name: '36 氪' },
  ],
  fetchIntervalMin: 10,
  bangumiCacheMin: 60,
  maxItemsPerFeed: 30,
};

const KIND_NAMES = ['番剧', '剧集', '连载书'];
const WEEK_CN = ['一', '二', '三', '四', '五', '六', '日'];

/* ───────────────────────── 配置 / 数据 ───────────────────────── */

function loadConfig() {
  let disk = {};
  try { disk = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}; } catch {}
  return Object.assign({}, DEFAULT_CFG, disk);
}
const cfg = loadConfig();

let cache = null;
let writeTimer = null;
let writePending = false;
let feedRunning = false;
let bangumiRunning = false;

async function load() {
  if (cache) return cache;
  let disk = null;
  try { disk = JSON.parse(await fsp.readFile(DATA_FILE, 'utf8')); } catch { disk = null; }
  if (!disk || typeof disk !== 'object') disk = {};
  cache = {
    feeds: Array.isArray(disk.feeds) ? disk.feeds : [],
    tracks: Array.isArray(disk.tracks) ? disk.tracks : [],
    seenAt: Number(disk.seenAt) || 0,
    bangumi: (disk.bangumi && typeof disk.bangumi === 'object') ? disk.bangumi : { at: 0, days: [] },
    lastFeedsFetchAt: Number(disk.lastFeedsFetchAt) || 0,
  };
  // 首次启动：把配置里的默认源种进去（只种一次，之后用户增删以 runtime 为准）
  if (!cache.feeds.length && Array.isArray(cfg.feeds)) {
    cache.feeds = cfg.feeds.map((f) => seedFeed(f.url, f.name));
  }
  for (const f of cache.feeds) {
    if (!f.items) f.items = [];
    if (f.ok == null) f.ok = null;
  }
  for (const t of cache.tracks) {
    if (!t.rule) t.rule = {};
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
        feeds: cache.feeds,
        tracks: cache.tracks,
        seenAt: cache.seenAt,
        bangumi: cache.bangumi,
        lastFeedsFetchAt: cache.lastFeedsFetchAt,
        updatedAt: Date.now(),
      }, null, 2));
      await fsp.rename(tmp, DATA_FILE);
    } catch (e) {
      console.error('[calendar] 落盘失败:', e && e.message);
    }
  }, 200);
}

const uid = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const WEEKDAY_CN = (wd) => WEEK_CN[(wd || 1) - 1] || '一';

/* ───────────────────────── RSS 抓取 ───────────────────────── */

function seedFeed(url, name) {
  return {
    id: uid('f'),
    url,
    name: name || '',
    ok: null,
    lastOkAt: 0,
    lastFailAt: 0,
    failReason: '',
    lastFetchAt: 0,
    items: [],
  };
}

async function refreshOne(st, f) {
  f.lastFetchAt = Date.now();
  try {
    const parsed = await fetchFeed(f.url);
    f.items = (parsed.items || []).slice(0, cfg.maxItemsPerFeed).map((i) => ({ ...i, feedId: f.id }));
    f.ok = true;
    f.lastOkAt = Date.now();
    f.failReason = '';
    if (parsed.title && !f.name) f.name = parsed.title;
  } catch (e) {
    f.ok = false;
    f.lastFailAt = Date.now();
    f.failReason = (e && e.message) || String(e);
    // 保留上次成功的条目，不假装成功
  }
}

async function refreshFeeds(force = false, onlyId = null) {
  const st = await load();
  const interval = Number(cfg.fetchIntervalMin) || 10;
  if (!force && st.lastFeedsFetchAt && Date.now() - st.lastFeedsFetchAt < interval * 60000) return false;
  if (feedRunning) return false;
  feedRunning = true;
  try {
    const targets = onlyId
      ? st.feeds.filter((f) => f.id === onlyId)
      : st.feeds.slice();
    if (!targets.length) return false;
    // 并发 3，不打爆出口
    const queue = targets.slice();
    const workers = [0, 1, 2].map(async () => {
      while (queue.length) {
        const f = queue.shift();
        await refreshOne(st, f);
      }
    });
    await Promise.all(workers);
    st.lastFeedsFetchAt = Date.now();
    await save();
    return true;
  } finally {
    feedRunning = false;
  }
}

function kickFeeds(force = false, onlyId = null) {
  refreshFeeds(force, onlyId).catch((e) => console.error('[calendar] 后台抓源失败:', e && e.message));
}

/* ───────────────────────── B 站番剧 ───────────────────────── */

function coverName(url) {
  const h = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
  const ext = (url.match(/\.(png|jpe?g|webp|gif)/i) || [, 'png'])[1].toLowerCase();
  return `${h}.${ext === 'jpeg' ? 'jpg' : ext}`;
}

function localCover(url) {
  if (!url) return null;
  return `/calendar/cover/${coverName(url)}`;
}

function normalizeEpisode(ep, day) {
  return {
    id: 'ep' + ep.episode_id,
    title: ep.title || '',
    cover: localCover(ep.cover),
    coverUrl: ep.cover || '',
    pubTime: ep.pub_time || '',
    pubTs: Number(ep.pub_ts) || 0,
    episode: ep.pub_index || '',
    weekday: Number(day.day_of_week) || 1,
    date: day.date || '',
    seasonId: ep.season_id || 0,
    episodeId: ep.episode_id || 0,
    delay: ep.delay ? 1 : 0,
    delayReason: ep.delay_reason || '',
    url: ep.episode_id ? `https://www.bilibili.com/bangumi/play/ep${ep.episode_id}` : '',
  };
}

async function fetchBangumi(force = false) {
  const st = await load();
  const cacheMin = Number(cfg.bangumiCacheMin) || 60;
  if (!force && st.bangumi.at && Date.now() - st.bangumi.at < cacheMin * 60000) return st.bangumi;
  if (bangumiRunning) return st.bangumi;
  bangumiRunning = true;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch(BILI_TIMELINE, {
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (j.code !== 0) throw new Error(`B站接口返回 ${j.code}: ${j.message || ''}`);
    const days = (j.result || []).map((d) => ({
      date: d.date,
      weekday: Number(d.day_of_week) || 1,
      episodes: (d.episodes || []).map((ep) => normalizeEpisode(ep, d)),
    }));
    st.bangumi = { at: Date.now(), days };
    await save();
  } catch (e) {
    console.error('[calendar] 番剧表抓取失败:', e && e.message);
    // 保留旧缓存，不置空
  } finally {
    bangumiRunning = false;
  }
  return st.bangumi;
}

/** 封面按需下载：本地有就发本地，没有就带 Referer 拉回 B 站图床 */
async function serveCover(ctx, name) {
  if (!/^[a-z0-9]{16}\.(png|jpg|webp|gif)$/.test(name)) return ctx.json(404, { ok: false });
  fs.mkdirSync(COVER_DIR, { recursive: true });
  const abs = path.join(COVER_DIR, name);
  if (fs.existsSync(abs)) return ctx.file(abs);

  // 在番剧缓存里找原始 URL
  let origin = '';
  for (const day of (cache && cache.bangumi.days) || []) {
    for (const ep of day.episodes || []) {
      if (ep.coverUrl && localCover(ep.coverUrl) === '/calendar/cover/' + name) { origin = ep.coverUrl; break; }
    }
    if (origin) break;
  }
  if (!origin) return ctx.json(404, { ok: false, message: '封面缓存不到了' });
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const r = await fetch(origin, { headers: { referer: 'https://www.bilibili.com/', 'user-agent': UA }, signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    await fsp.writeFile(abs, buf);
    return ctx.file(abs);
  } catch (e) {
    return ctx.json(502, { ok: false, message: '封面拉取失败: ' + ((e && e.message) || e) });
  }
}

/* ───────────────────────── 排期计算 ───────────────────────── */

function parseTime(s) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(s || '20:00').trim());
  const h = m ? Math.min(23, Math.max(0, Number(m[1]))) : 20;
  const min = m ? Math.min(59, Math.max(0, Number(m[2]))) : 0;
  return [h, min];
}

/** 下一次周更时间（weekday: 周一=1 … 周日=7） */
function nextWeekly(rule, now) {
  const [h, m] = parseTime(rule.time);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  const todayWd = d.getDay() || 7;
  const target = Math.min(7, Math.max(1, Number(rule.weekday) || 1));
  let diff = target - todayWd;
  if (diff === 0 && d.getTime() <= now) diff = 7;
  const next = new Date(d);
  next.setDate(d.getDate() + diff);
  return next.getTime();
}

/** 每 N 天：锚点向后按周期滚动 */
function nextInterval(rule, now) {
  const period = Math.max(1, Number(rule.days) || 7) * 86400000;
  const [h, m] = parseTime(rule.time);
  const anchor = Number(rule.anchor) || now;
  const a = new Date(anchor);
  a.setHours(h, m, 0, 0);
  let next = a.getTime();
  if (next > now) return next;
  const steps = Math.ceil((now - next) / period);
  next += steps * period;
  if (next <= now) next += period;
  return next;
}

function nextOf(track, now = Date.now()) {
  const rule = track.rule || {};
  return rule.type === 'interval' ? nextInterval(rule, now) : nextWeekly(rule, now);
}

function countdown(ms) {
  if (ms <= 0) return { inDays: 0, inText: '已更新', overdue: true };
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  let inText;
  if (d > 0) inText = `还有 ${d} 天 ${h} 小时`;
  else if (h > 0) inText = `还有 ${h} 小时 ${m} 分`;
  else inText = `还有 ${m} 分`;
  return { inDays: d, inText, overdue: false };
}

function ruleLabel(rule) {
  if (!rule) return '';
  if (rule.type === 'interval') return `每 ${Math.max(1, Number(rule.days) || 7)} 天 · ${rule.time || '20:00'}`;
  return `每周${WEEKDAY_CN(rule.weekday)} · ${rule.time || '20:00'}`;
}

function decorateTrack(t, now = Date.now()) {
  const nextAt = nextOf(t, now);
  const cd = countdown(nextAt - now);
  const d = new Date(nextAt);
  const wd = d.getDay() || 7;
  return {
    id: t.id,
    name: t.name,
    kind: t.kind || '番剧',
    rule: t.rule || {},
    ruleLabel: ruleLabel(t.rule),
    sourceUrl: t.sourceUrl || '',
    progress: t.progress || '',
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    nextAt,
    nextAtText: d.toLocaleString('zh-CN', { hour12: false }),
    weekday: wd,
    inDays: cd.inDays,
    inText: cd.inText,
    overdue: cd.overdue,
  };
}

function validateRule(rule) {
  if (!rule || typeof rule !== 'object') return { ok: false, message: '更新规律没填' };
  if (rule.type === 'interval') {
    const days = Math.floor(Number(rule.days));
    if (!Number.isFinite(days) || days < 1) return { ok: false, message: '间隔天数至少 1 天' };
    return { ok: true, rule: { type: 'interval', days, time: String(rule.time || '20:00'), anchor: Number(rule.anchor) || 0 } };
  }
  const weekday = Math.floor(Number(rule.weekday));
  if (!Number.isFinite(weekday) || weekday < 1 || weekday > 7) return { ok: false, message: '周几要在 1~7 之间' };
  return { ok: true, rule: { type: 'weekly', weekday, time: String(rule.time || '20:00') } };
}

/* ───────────────────────── 组装 overview ───────────────────────── */

function feedPublic(f, seenAt) {
  const items = (f.items || []).slice(0, 12);
  const unread = items.filter((i) => (i.date || 0) > seenAt).length;
  return {
    id: f.id,
    url: f.url,
    name: f.name || f.url,
    ok: f.ok,
    failReason: f.failReason || '',
    lastOkAt: f.lastOkAt || 0,
    lastFailAt: f.lastFailAt || 0,
    lastFetchAt: f.lastFetchAt || 0,
    unread,
    total: (f.items || []).length,
    items: items.map((i) => ({
      id: i.id, title: i.title, link: i.link, date: i.date, dateText: i.dateText, summary: i.summary || '',
    })),
  };
}

async function buildOverview() {
  const st = await load();
  const now = Date.now();

  // 超 10 分钟就后台补抓，不等返回
  kickFeeds();
  await fetchBangumi();

  const tracks = st.tracks.map((t) => decorateTrack(t, now));
  const sorted = tracks.slice().sort((a, b) => a.nextAt - b.nextAt);
  const nextTrack = sorted[0] || null;

  const next = nextTrack
    ? {
        title: nextTrack.name,
        when: nextTrack.nextAt,
        inDays: nextTrack.inDays,
        inText: nextTrack.inText,
        source: nextTrack.kind,
      }
    : null;

  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const today = todayStart.getTime();
  const todayEnd = today + 86400000;
  const todayCount = tracks.filter((t) => t.nextAt >= today && t.nextAt < todayEnd).length;

  const feeds = st.feeds.map((f) => feedPublic(f, st.seenAt));
  const unread = feeds.reduce((s, f) => s + f.unread, 0);

  // 周视图：周一到周日七列
  const week = WEEK_CN.map((cn, i) => {
    const wd = i + 1;
    return {
      weekday: wd,
      label: cn,
      isToday: wd === (new Date().getDay() || 7),
      tracks: tracks.filter((t) => t.weekday === wd).map((t) => ({
        id: t.id, title: t.name, kind: t.kind, time: t.rule.time || '',
        inText: t.inText, nextAt: t.nextAt, sourceUrl: t.sourceUrl, progress: t.progress,
      })),
      episodes: (st.bangumi.days || []).filter((d) => d.weekday === wd)
        .flatMap((d) => d.episodes || [])
        .map((ep) => ({
          id: ep.id, title: ep.title, cover: ep.cover, pubTime: ep.pubTime,
          episode: ep.episode, url: ep.url, delay: ep.delay,
        })),
    };
  });

  return {
    ok: true,
    now,
    seenAt: st.seenAt,
    next,
    today: todayCount,
    unread,
    feeds,
    tracks,
    week,
    bangumi: { at: st.bangumi.at, days: st.bangumi.days || [] },
    updatedAt: Date.now(),
  };
}

/* ───────────────────────── 路由 ───────────────────────── */

const okJson = (ctx, obj) => ctx.json(200, Object.assign({ ok: true }, obj));

export async function handle(ctx) {
  const p = ctx.p;

  // 本地封面（/calendar/cover/xxx.png）
  if (p.startsWith('/calendar/cover/')) {
    const name = decodeURIComponent(p.slice('/calendar/cover/'.length));
    await serveCover(ctx, name);
    return true;
  }

  if (p === '/api/calendar/overview' && ctx.method === 'GET') {
    const data = await buildOverview();
    return ctx.json(200, data);
  }

  if (p === '/api/calendar/feed/add' && ctx.method === 'POST') {
    const st = await load();
    const b = await ctx.body();
    const url = String(b.url || '').trim();
    if (!/^https?:\/\/.+/.test(url)) return ctx.json(400, { ok: false, message: '填一个 http(s) 链接' });
    if (st.feeds.some((f) => f.url === url)) return ctx.json(400, { ok: false, message: '这个源已经订阅了' });
    const name = String(b.name || '').trim();
    const f = seedFeed(url, name);
    st.feeds.push(f);
    await save();
    kickFeeds(true, f.id);
    return okJson(ctx, { feed: feedPublic(f, st.seenAt) });
  }

  if (p === '/api/calendar/feed/remove' && ctx.method === 'POST') {
    const st = await load();
    const b = await ctx.body();
    const before = st.feeds.length;
    st.feeds = st.feeds.filter((f) => f.id !== b.id);
    await save();
    return okJson(ctx, { removed: before - st.feeds.length });
  }

  if (p === '/api/calendar/feed/refresh' && ctx.method === 'POST') {
    const b = await ctx.body();
    kickFeeds(true, b.id || null);
    return okJson(ctx, { kicked: true, message: '后台刷新中，稍后回来看' });
  }

  if (p === '/api/calendar/bangumi' && ctx.method === 'GET') {
    const force = ctx.query.get('refresh') === '1';
    const bg = await fetchBangumi(force);
    return ctx.json(200, { ok: true, at: bg.at, days: bg.days || [] });
  }

  if (p === '/api/calendar/track/add' && ctx.method === 'POST') {
    const st = await load();
    const b = await ctx.body();
    const name = String(b.name || '').trim();
    if (!name) return ctx.json(400, { ok: false, message: '起个名字再存' });
    const kind = KIND_NAMES.includes(b.kind) ? b.kind : '番剧';
    const v = validateRule(b.rule);
    if (!v.ok) return ctx.json(400, { ok: false, message: v.message });
    const now = Date.now();
    const track = {
      id: uid('t'),
      name: name.slice(0, 80),
      kind,
      rule: v.rule,
      sourceUrl: String(b.sourceUrl || '').trim().slice(0, 500),
      progress: String(b.progress || '').trim().slice(0, 80),
      createdAt: now,
      updatedAt: now,
    };
    st.tracks.push(track);
    await save();
    return okJson(ctx, { track: decorateTrack(track, now) });
  }

  if (p === '/api/calendar/track/update' && ctx.method === 'POST') {
    const st = await load();
    const b = await ctx.body();
    const t = st.tracks.find((x) => x.id === b.id);
    if (!t) return ctx.json(404, { ok: false, message: '没有这条追更' });
    if (b.name != null) t.name = String(b.name).trim().slice(0, 80) || t.name;
    if (b.kind != null) t.kind = KIND_NAMES.includes(b.kind) ? b.kind : t.kind;
    if (b.sourceUrl != null) t.sourceUrl = String(b.sourceUrl).trim().slice(0, 500);
    if (b.progress != null) t.progress = String(b.progress).trim().slice(0, 80);
    if (b.rule != null) {
      const v = validateRule(b.rule);
      if (!v.ok) return ctx.json(400, { ok: false, message: v.message });
      // 间隔类型保留旧锚点，避免改一次规律就从头算
      v.rule.anchor = v.rule.type === 'interval' ? (Number(v.rule.anchor) || Number(t.rule.anchor) || t.createdAt) : 0;
      t.rule = v.rule;
    }
    t.updatedAt = Date.now();
    await save();
    return okJson(ctx, { track: decorateTrack(t) });
  }

  if (p === '/api/calendar/track/remove' && ctx.method === 'POST') {
    const st = await load();
    const b = await ctx.body();
    const before = st.tracks.length;
    st.tracks = st.tracks.filter((t) => t.id !== b.id);
    await save();
    return okJson(ctx, { removed: before - st.tracks.length });
  }

  if (p === '/api/calendar/seen' && ctx.method === 'POST') {
    const st = await load();
    const b = await ctx.body();
    st.seenAt = Number(b.at) || Date.now();
    await save();
    return okJson(ctx, { seenAt: st.seenAt });
  }

  return false;
}

/* ───────────────────────── 首页小结（绝不抛错） ───────────────────────── */

export async function summary() {
  try {
    const st = await load();
    const now = Date.now();
    const tracks = st.tracks.map((t) => decorateTrack(t, now));
    const sorted = tracks.slice().sort((a, b) => a.nextAt - b.nextAt);
    const nextTrack = sorted[0] || null;
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const today = todayStart.getTime();
    const todayEnd = today + 86400000;
    const feeds = st.feeds.map((f) => feedPublic(f, st.seenAt));
    return {
      ready: true,
      path: '/calendar/',
      next: nextTrack
        ? { title: nextTrack.name, when: nextTrack.nextAt, inDays: nextTrack.inDays, inText: nextTrack.inText, source: nextTrack.kind }
        : null,
      today: tracks.filter((t) => t.nextAt >= today && t.nextAt < todayEnd).length,
      unread: feeds.reduce((s, f) => s + f.unread, 0),
      feeds: st.feeds.length,
      tracks: st.tracks.length,
    };
  } catch (e) {
    return { ready: true, path: '/calendar/', next: null, today: 0, unread: 0, feeds: 0, tracks: 0 };
  }
}

let started = false;
export async function init() {
  await load();
  fs.mkdirSync(COVER_DIR, { recursive: true });
  if (started) return;
  started = true;
  // 启动后稍候抓一轮；之后每 10 分钟自查
  setTimeout(() => kickFeeds(), 1500);
  const interval = Math.max(3, Number(cfg.fetchIntervalMin) || 10) * 60000;
  setInterval(() => kickFeeds(), interval);
  // 番剧表缓存在接口调用时懒加载，init 里也预热一轮
  setTimeout(() => fetchBangumi(), 3000);
}
