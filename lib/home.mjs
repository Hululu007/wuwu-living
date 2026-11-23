/**
 * 首页概览：天气、今日待办、下载进度、最近在读、下次追更
 *
 * 这里只做聚合，不抢各房间的活：
 *   - 天气走 open-meteo（杭州，免 key），10 分钟缓存
 *   - 待办是本机 runtime/home.json 里的一小份清单
 *   - 下载/追更/笔记的数字来自各房间模块的 summary()
 *   - 在读来自书房（Reader 数据库）
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { writeJson } from './json_store.mjs';
import { fileURLToPath } from 'node:url';
import { roomSummaries } from './rooms.mjs';
import { readJson } from './http_body.mjs';
import { runtimePath } from './runtime_dir.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TODO_FILE = runtimePath(ROOT, 'home.json');

const CITY = { name: '杭州', lat: 30.2741, lon: 120.1551 };

/* 天气代码 → 中文（WMO） */
const WCODE = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
  45: '有雾', 48: '雾凇',
  51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 56: '冻毛毛雨', 57: '冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '米雪',
  80: '阵雨', 81: '阵雨', 82: '强阵雨', 85: '阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '雷阵雨伴冰雹',
};

const weatherCache = { t: 0, data: null, pending: null };

async function fetchWeather() {
  const u = new URL('https://api.open-meteo.com/v1/forecast');
  u.searchParams.set('latitude', String(CITY.lat));
  u.searchParams.set('longitude', String(CITY.lon));
  u.searchParams.set('current', 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m');
  u.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset');
  u.searchParams.set('timezone', 'Asia/Shanghai');
  u.searchParams.set('forecast_days', '5');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 6000);
  try {
    const r = await fetch(u, { signal: ac.signal, cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    const cur = d.current || {};
    const day = d.daily || {};
    const items = (day.time || []).map((t, i) => ({
      date: t,
      code: day.weather_code?.[i],
      text: WCODE[day.weather_code?.[i]] || '未知',
      high: Math.round(day.temperature_2m_max?.[i] ?? 0),
      low: Math.round(day.temperature_2m_min?.[i] ?? 0),
      rain: day.precipitation_probability_max?.[i] ?? null,
    }));
    return {
      ok: true,
      city: CITY.name,
      ts: Date.now(),
      temp: Math.round(cur.temperature_2m ?? 0),
      feels: Math.round(cur.apparent_temperature ?? 0),
      humidity: Math.round(cur.relative_humidity_2m ?? 0),
      wind: Math.round(cur.wind_speed_10m ?? 0),
      code: cur.weather_code,
      text: WCODE[cur.weather_code] || '未知',
      sunrise: day.sunrise?.[0] || null,
      sunset: day.sunset?.[0] || null,
      days: items,
    };
  } finally {
    clearTimeout(timer);
  }
}

// 失败后 5 分钟内不再重撞：旧值只有 1 分钟，等于每分钟都要白等一次 6s 超时。
const WEATHER_OK_TTL = 10 * 60 * 1000;
const WEATHER_FAIL_TTL = 5 * 60 * 1000;

function kickWeather() {
  if (weatherCache.pending) return weatherCache.pending;
  weatherCache.pending = (async () => {
    try {
      const d = await fetchWeather();
      weatherCache.data = d;
      weatherCache.t = Date.now();
      weatherCache.failed = false;
      return d;
    } catch (e) {
      weatherCache.t = Date.now();
      weatherCache.failed = true;
      return weatherCache.data || { ok: false, city: CITY.name, message: '天气没取到：' + (e.message || e) };
    } finally {
      weatherCache.pending = null;
    }
  })();
  return weatherCache.pending;
}

/**
 * 首页概览专用的非阻塞天气。
 *
 * 实测：open-meteo 不可达时 fetchWeather 要等满 6s 超时，
 * 于是 /api/home/summary 每次都 6s 以上（整个首页跟着卡）。
 * 概览不该被一个可选信息拖住：有旧数据就先给旧数据（带 stale 标记），
 * 没有就立刻返回 pending 占位并在后台去取，下次刷新自然就有了。
 */
function weatherForSummary() {
  const now = Date.now();
  const ttl = weatherCache.failed ? WEATHER_FAIL_TTL : WEATHER_OK_TTL;
  if (weatherCache.data && now - weatherCache.t < ttl) return weatherCache.data;
  if (weatherCache.data) {
    // 过期但可用：先给旧的，同时后台刷新
    void kickWeather();
    return Object.assign({}, weatherCache.data, { stale: true });
  }
  void kickWeather();
  // 已经明确失败过（不是首次加载）就如实说没取到，别一直挂着「正在获取」
  if (weatherCache.failed) {
    return { ok: false, stale: true, city: CITY.name, message: '天气没取到（外部接口不可达）' };
  }
  return { ok: false, pending: true, city: CITY.name, message: '天气正在获取' };
}

/* ───────────────────────── 待办 ───────────────────────── */

async function readTodos() {
  try {
    const raw = await fsp.readFile(TODO_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data.todos) ? data.todos : [];
  } catch {
    return [];
  }
}

async function writeTodos(todos) {
  // 同路径写串行化 + 独立临时名，避免并发请求互相覆盖临时文件
  await writeJson(TODO_FILE, { todos, updatedAt: Date.now() });
}

/**
 * 待办的「读 → 改 → 写」必须整体排队。
 * 只串行化写盘是不够的：20 个并发 add 会各自读到同一份旧数组，
 * 最后一个写完覆盖前面 19 条（实测 20 条只剩 1 条）。
 */
let todoChain = Promise.resolve();
function withTodos(fn) {
  const run = todoChain.then(fn, fn);
  todoChain = run.then(() => {}, () => {});
  return run;
}

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** 今日待办只统计今天的；没写日期的算今天 */
const isToday = (t) => !t.date || t.date === todayStr();

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

// 与 hub/rooms 共用一份读取实现：非法 JSON 抛 400、超限抛 413，不再伪装成空对象
function readBody(req) {
  return readJson(req, { limit: 512 * 1024 });
}

/** /api/home/todos  —— 增 / 勾 / 删 / 挪到明天 */
export async function homeTodos(req, res, url) {
  const p = url.pathname;
  if (p !== '/api/home/todos' && !p.startsWith('/api/home/todos/')) return false;

  // 这里用的是原始 req.method（不是 ctx.method），所以 HEAD 要显式当 GET：
  // 否则 `curl -I /api/home/todos` 会掉进 405 分支，返回「只认 GET 和 POST」。
  const method = req.method === 'HEAD' ? 'GET' : req.method;

  if (method === 'GET') {
    const todos = await readTodos();
    sendJson(res, 200, { ok: true, todos, today: todos.filter(isToday), date: todayStr() });
    return true;
  }

  if (method !== 'POST') {
    sendJson(res, 405, { ok: false, message: '只认 GET 和 POST' });
    return true;
  }

  // 请求体在排队之前读掉：读的是本请求的流，与别的请求无关，先读完再抢写权
  const body = await readBody(req);
  const action = String(body.action || 'add');
  const id = String(body.id || '');

  if (action !== 'add' && action !== 'clear-done' && !id) {
    sendJson(res, 400, { ok: false, message: '缺少待办 id' });
    return true;
  }
  if (!['add', 'toggle', 'delete', 'tomorrow', 'clear-done'].includes(action)) {
    // 旧行为：未知 action 静默 200，前端以为改成功了，实际什么都没发生
    sendJson(res, 400, { ok: false, message: `不认识的待办动作：${action}` });
    return true;
  }
  if (action === 'add' && !String(body.text || '').trim()) {
    sendJson(res, 400, { ok: false, message: '待办不能是空的' });
    return true;
  }

  const result = await withTodos(async () => {
    let todos = await readTodos();
    const hadId = !!id && todos.some((t) => t.id === id);
    const beforeDone = todos.filter((t) => t.done).length;

    if (action === 'add') {
      todos.unshift({
        id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        text: String(body.text).trim().slice(0, 200),
        done: false,
        date: body.date || todayStr(),
        createdAt: Date.now(),
      });
    } else if (action === 'toggle') {
      todos = todos.map((t) => (t.id === id ? Object.assign(t, { done: !t.done, doneAt: !t.done ? Date.now() : null }) : t));
    } else if (action === 'delete') {
      todos = todos.filter((t) => t.id !== id);
    } else if (action === 'tomorrow') {
      const d = new Date(Date.now() + 86400000);
      const s = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      todos = todos.map((t) => (t.id === id ? Object.assign(t, { date: s, done: false }) : t));
    } else if (action === 'clear-done') {
      todos = todos.filter((t) => !t.done);
    }

    const trimmed = todos.slice(0, 500);
    // 只有真的改到了东西才写盘：toggle/delete 打错 id 时不该产生无谓写入
    let changed;
    if (action === 'add') changed = true;
    else if (action === 'clear-done') changed = beforeDone > 0;
    else changed = hadId;
    if (changed) await writeTodos(trimmed);
    return { todos: trimmed, changed };
  });

  if (!result.changed && !['add', 'clear-done'].includes(action)) {
    sendJson(res, 404, { ok: false, message: '没有这条待办', todos: result.todos, date: todayStr() });
    return true;
  }

  const today = result.todos.filter(isToday);
  sendJson(res, 200, { ok: true, todos: result.todos, today, date: todayStr() });
  return true;
}

/* ───────────────────────── 汇总 ───────────────────────── */

/**
 * @param {{apps:object, allStatus:function, bookInfo:function}} deps 由 hub.mjs 注入，避免重复探测
 */
export async function homeSummary(deps = {}) {
  const rooms = await roomSummaries().catch(() => ({}));
  const w = weatherForSummary();

  let status = null;
  try {
    status = deps.allStatus ? await deps.allStatus() : null;
  } catch {}

  // 下载进度：取下载中心的小结
  const dl = rooms.download || {};
  const downloads = {
    ready: !!dl.ready,
    active: dl.active ?? 0,
    total: dl.total ?? 0,
    speed: dl.speed ?? 0,
    tasks: Array.isArray(dl.tasks) ? dl.tasks.slice(0, 4) : [],
  };

  // 最近在读：书房
  let reading = { ok: false };
  try {
    if (deps.bookInfo) {
      const b = await deps.bookInfo();
      reading = {
        ok: !!b.webRunning,
        lastBook: b.lastBook || '',
        todayMinutes: b.todayMinutes || 0,
        sources: b.sources || 0,
      };
    }
  } catch {}

  // 下次追更：追更日历的小结
  const cal = rooms.calendar || {};
  const nextUpdate = cal.next || null;

  const todos = await readTodos();

  return {
    ok: true,
    ts: Date.now(),
    date: todayStr(),
    weather: w,
    todos: { todo: todos.filter(isToday), all: todos.length },
    downloads,
    reading,
    nextUpdate,
    notes: rooms.notes || { ready: false },
    photos: rooms.photos || { ready: false },
    library: rooms.library || { ready: false },
    rooms,
    apps: status ? status.apps : [],
  };
}
