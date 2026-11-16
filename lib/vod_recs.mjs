/**
 * 视频房推荐首页 · 服务端取数与聚合
 *
 * 只读采集站配置：/Users/wuwu/D盘/项目/请看/config/endpoints.json
 * 对 enabled 的站并发 4 拉 `?ac=videolist&pg=1`（6 秒超时、浏览器 UA），
 * 按 type_name 归到 电影 / 电视剧 / 短剧 / 综艺 四个分区，跨站挑 8 部进精选。
 *
 * 缓存：内存 + runtime/vod.json 落盘，10 分钟有效期。
 * vodRecs() 绝不抛错：取不到就 ok:false + 中文原因。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENDPOINTS_FILE = '/Users/wuwu/D盘/项目/请看/config/endpoints.json';
const CACHE_FILE = path.join(ROOT, 'runtime', 'vod.json');
const CACHE_TTL = 10 * 60 * 1000;
const FETCH_TIMEOUT = 6000;
const CONCURRENCY = 4;
const PER_SECTION_CAP = 30;
const FEATURED_COUNT = 8;
const PAGES = [1, 2, 3];
/**
 * 实测类型号映射（各站略有差异，仅在条目归类吻合时采用）：
 * 1/6-12/20 电影片类（动作/喜剧/爱情/科幻/恐怖/剧情/战争/记录片）
 * 2/13-16 连续剧类；3 综艺；4 动漫（不进四个分区）
 */
const T_SECTION = {
  1: 'movie', 6: 'movie', 7: 'movie', 8: 'movie', 9: 'movie',
  10: 'movie', 11: 'movie', 12: 'movie', 20: 'movie',
  2: 'drama', 13: 'drama', 14: 'drama', 15: 'drama', 16: 'drama',
  3: 'variety', 4: null,
};
const T_PROBE = Object.keys(T_SECTION).map(Number);

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const SECTIONS = [
  { key: 'movie', name: '电影' },
  { key: 'drama', name: '电视剧' },
  { key: 'short', name: '短剧' },
  { key: 'variety', name: '综艺' },
];

/* ───────────────────────── 分类 ───────────────────────── */

/** 剧集兜底：只认「全12集」「18集完结」这类总集数 ≤24 的；「更新至第N集」不算 */
function shortDramaFallback(remarks) {
  const s = String(remarks || '');
  const m = s.match(/全\s*(\d+)\s*集/) || s.match(/(\d+)\s*集完结/);
  if (!m) return false;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 && n <= 24;
}

/** 返回 movie / drama / short / variety / null */
function classify(typeName, remarks) {
  const t = String(typeName || '');
  if (/短剧|微短剧/.test(t)) return 'short';
  if (/综艺/.test(t)) return 'variety';
  if (/电影|片/.test(t) && !/动漫|动画片|动漫片/.test(t)) return 'movie';
  if (/剧/.test(t)) {
    if (shortDramaFallback(remarks)) return 'short';
    return 'drama';
  }
  return null;
}

function cleanText(s) {
  return String(s == null ? '' : s)
    .replace(/&nbsp;|\s+/g, ' ')
    .trim();
}

function parseScore(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : '';
}

/** 单条原始记录 → 推荐条目 */
function toItem(v, source) {
  return {
    name: cleanText(v.vod_name || v.vod_sub || ''),
    pic: cleanText(v.vod_pic || ''),
    year: cleanText(v.vod_year || ''),
    remarks: cleanText(v.vod_remarks || ''),
    score: parseScore(v.vod_score || v.vod_douban_score),
    typeName: cleanText(v.type_name || v.vod_class || ''),
    sourceName: source.name,
    sourceId: source.id,
    vodId: String(v.vod_id || ''),
  };
}

/* ───────────────────────── 取数 ───────────────────────── */

async function getList(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    return Array.isArray(j.list) ? j.list : [];
  } finally {
    clearTimeout(timer);
  }
}

/** 单站：pg=1..3 多页 + t=1..4 类型探测；同站同名同年去重，有海报优先 */
async function fetchEndpoint(ep) {
  const base = `${ep.base}${ep.path}?ac=videolist`;
  const items = [];
  const seen = new Map(); // name|year -> item
  const tValid = [];
  let fatal = '';

  const add = (v) => {
    if (!v || v.vod_id == null) return;
    const sec = classify(v.type_name || v.vod_class, v.vod_remarks);
    if (!sec) return;
    const it = toItem(v, ep);
    if (!it.name) return;
    const key = it.name + '|' + it.year;
    const old = seen.get(key);
    if (old) {
      // 已有条目缺海报而新条目有海报时替换；否则保留先到的
      if (!old.pic && it.pic) {
        const idx = items.findIndex((x) => x.item === old);
        if (idx >= 0) items[idx] = { section: sec, item: it };
        seen.set(key, it);
      }
      return;
    }
    seen.set(key, it);
    items.push({ section: sec, item: it });
  };

  const tasks = [];

  // 多页抓取
  for (const pg of PAGES) {
    tasks.push(
      getList(`${base}&pg=${pg}`)
        .then((list) => list.forEach(add))
        .catch(() => {})
    );
  }

  // 类型号探测：仅当该 t 返回的条目归类与目标分区吻合时计入有效 t
  for (const t of T_PROBE) {
    const target = T_SECTION[t];
    tasks.push(
      getList(`${base}&t=${t}`)
        .then((list) => {
          if (!target) return;
          let kept = 0;
          for (const v of list) {
            if (!v || v.vod_id == null) continue;
            if (classify(v.type_name || v.vod_class, v.vod_remarks) !== target) continue;
            add(v);
            kept++;
          }
          if (kept > 0) tValid.push({ t, section: target, count: kept });
        })
        .catch(() => {})
    );
  }

  try {
    await Promise.all(tasks);
  } catch (e) {
    fatal = e && e.name === 'AbortError' ? '超时（6 秒无响应）' : String(e.message || e);
  }

  const ok = items.length > 0;
  return {
    source: { id: ep.id, name: ep.name, ok, count: items.length, error: fatal, tValid },
    items,
  };
}

/** 并发 4 分批拉取；跨站同名同年去重，无海报条目排在尾部 */
async function fetchAll(endpoints) {
  const started = Date.now();
  const sources = [];
  const buckets = { movie: [], drama: [], short: [], variety: [] };
  const all = [];

  let idx = 0;
  async function worker() {
    while (idx < endpoints.length) {
      const ep = endpoints[idx++];
      const { source, items } = await fetchEndpoint(ep);
      sources.push(source);
      for (const { section, item } of items) {
        buckets[section].push(item);
        all.push({ section, item });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, endpoints.length) }, worker));

  // 跨站去重：同名同年只留一条，有海报优先，其次评分/年份
  const dedup = (list) => {
    const seen = new Map();
    for (const it of list) {
      const key = it.name + '|' + it.year;
      const old = seen.get(key);
      if (!old) {
        seen.set(key, it);
      } else if ((!old.pic && it.pic) || (old.pic === it.pic && (it.score || 0) > (old.score || 0))) {
        seen.set(key, it);
      }
    }
    return [...seen.values()];
  };

  // 排序：有海报优先、有评分优先、年份新优先
  const rank = (a, b) => {
    const ay = Number(a.year) || 0;
    const by = Number(b.year) || 0;
    const ap = a.pic ? 1 : 0;
    const bp = b.pic ? 1 : 0;
    if (bp !== ap) return bp - ap;
    if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
    return by - ay;
  };

  for (const sec of Object.keys(buckets)) {
    buckets[sec] = dedup(buckets[sec]).sort(rank);
  }

  const sections = SECTIONS.map((s) => ({
    key: s.key,
    name: s.name,
    count: buckets[s.key].length,
    items: buckets[s.key].slice(0, PER_SECTION_CAP),
  }));

  // 精选：跨区挑 8 部，优先有海报/评分/较新；分区尽量均衡
  const featured = [];
  const usedNames = new Set();
  const bySec = {};
  for (const { section, item } of all) {
    if (!item.pic) continue;
    (bySec[section] = bySec[section] || []).push(item);
  }
  for (const sec of Object.keys(bySec)) bySec[sec].sort(rank);
  const secKeys = Object.keys(bySec).sort((x, y) => bySec[y].length - bySec[x].length);
  let round = 0;
  while (featured.length < FEATURED_COUNT && secKeys.length) {
    let progressed = false;
    for (const k of secKeys) {
      const it = bySec[k][round];
      if (it && !usedNames.has(it.name)) {
        usedNames.add(it.name);
        featured.push(it);
        progressed = true;
        if (featured.length >= FEATURED_COUNT) break;
      }
    }
    round++;
    if (!progressed) break;
  }

  return { sections, featured, sources, elapsedMs: Date.now() - started };
}

/* ───────────────────────── 缓存 ───────────────────────── */

let memory = { t: 0, data: null };

function readFileCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const stat = fs.statSync(CACHE_FILE);
    if (Date.now() - stat.mtimeMs > CACHE_TTL) return null;
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeFileCache(data) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ savedAt: Date.now(), ...data }), 'utf8');
  } catch {
    /* 落盘失败不影响内存缓存 */
  }
}

function loadEndpoints() {
  const raw = JSON.parse(fs.readFileSync(ENDPOINTS_FILE, 'utf8'));
  return (raw.endpoints || []).filter((e) => e.enabled);
}

/* ───────────────────────── 对外接口 ───────────────────────── */

/**
 * 取推荐首页数据。绝不抛错。
 * @returns {Promise<{ok:boolean, updatedAt:string, sections:Array, featured:Array,
 *   sources:Array, message?:string}>}
 */
export async function vodRecs() {
  const now = Date.now();

  // 1) 内存缓存
  if (memory.data && now - memory.t < CACHE_TTL) {
    return memory.data;
  }

  // 2) 文件缓存（重启后仍有数据，避免冷启动直接打采集站）
  const fc = readFileCache();
  if (fc && Array.isArray(fc.sections)) {
    const data = { ...fc, ok: true, updatedAt: new Date(fc.savedAt || now).toISOString() };
    memory = { t: now, data };
    return data;
  }

  let endpoints = [];
  try {
    endpoints = loadEndpoints();
  } catch (e) {
    return {
      ok: false,
      message: '采集站配置读取失败：' + (e.message || e),
      updatedAt: new Date().toISOString(),
      sections: SECTIONS.map((s) => ({ key: s.key, name: s.name, count: 0, items: [] })),
      featured: [],
      sources: [],
    };
  }

  if (!endpoints.length) {
    return {
      ok: false,
      message: '配置里没有启用的采集站',
      updatedAt: new Date().toISOString(),
      sections: SECTIONS.map((s) => ({ key: s.key, name: s.name, count: 0, items: [] })),
      featured: [],
      sources: [],
    };
  }

  let gathered;
  try {
    gathered = await fetchAll(endpoints);
  } catch (e) {
    return {
      ok: false,
      message: '推荐数据拉取异常：' + (e.message || e),
      updatedAt: new Date().toISOString(),
      sections: SECTIONS.map((s) => ({ key: s.key, name: s.name, count: 0, items: [] })),
      featured: [],
      sources: [],
    };
  }

  const okSources = gathered.sources.filter((s) => s.ok).length;
  const total = gathered.sections.reduce((n, s) => n + s.count, 0);
  const ok = okSources > 0 && total > 0;

  const data = {
    ok,
    message: ok
      ? ''
      : okSources === 0
        ? '所有采集站暂时不可用，请稍后重试'
        : '暂时没有拉到可分类的影片',
    updatedAt: new Date().toISOString(),
    sections: gathered.sections,
    featured: gathered.featured,
    sources: gathered.sources,
    elapsedMs: gathered.elapsedMs,
  };

  memory = { t: now, data };
  writeFileCache(data);
  return data;
}

/** 启动预热（可选）：后台跑一次，不阻塞启动 */
export function initVodRecs() {
  vodRecs().catch(() => {});
}
