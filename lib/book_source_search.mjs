#!/usr/bin/env node
/**
 * 多书源搜索（Legado 规则引擎驱动）。
 *
 * 每源调用引擎 `searchSource(source, key, {page, timeoutMs})`，由引擎按
 * legado 规则完成请求与字段抽取；本模块只负责：装载启用可搜源、健康排序、
 * 三波并发调度、先完成先增量推送、相关性排序与按书源优先级去重分组。
 * 详情/目录/正文由 hub.mjs 调引擎 bookInfo/chapterList/chapterContent。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSources as poolLoadSources, searchSource, __core } from './legado/index.mjs';

// 书源清单是一次性启动期装载：直连内核读取本地全量缓存，不占 worker 池、不与首批搜索任务排队。
const loadSourcesCore = typeof __core?.loadSources === 'function' ? __core.loadSources : poolLoadSources;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FULL_CACHE_PATH = path.join(ROOT, 'runtime', 'book-sources-full.json');
const HEALTH_PATH = path.join(ROOT, 'runtime', 'book_source_health.json');
const HEALTH_TTL_MS = 14 * 24 * 3600 * 1000;
// 引擎 worker 池只有 4 槽 + 200 队列；搜索侧滑窗保持 8 在飞，避免一次性打爆队列。
const SEARCH_CONCURRENCY = 8;
const BUSY_RETRY_MAX = 3;
const BUSY_RETRY_BASE_MS = 120;

let sourceCache = [];
let sourcePromise = null;
let lastStats = null;
const queryCache = new Map();

/* ───────────────────────── 源成功率 / 耗时健康缓存（落盘） ───────────────────────── */
let healthCache = null;

// 无健康缓存时的冷启动兜底：常见实测可靠站名关键词，命中加分。
const GOOD_NAME_PATTERNS = [
  /顶点小说/, /笔趣阁/, /笔趣小说/, /爱久久/, /UC小说/, /爱下小说/, /青困小说/, /番茄/,
  /飞卢/, /SF轻小说/, /书旗/, /追书/, /少年梦/, /漫客栈/, /得间/, /小米阅读/, /爱优漫/,
];

// 冷启动实测快源（直连内核单源 <1.5s），无健康缓存时排进波0；失败降权由健康缓存覆盖。
const FAST_HOST_ORDER = [/api\.17k\.com/i, /23uswx\.la/i, /aixiaxsw\.com/i, /ixdzs8\.com/i];
const FAST_URL_PATTERNS = FAST_HOST_ORDER;

// 已对照 Reader 确认只能搜到书目、目录为空的源：不换源刷通过率，仅在展示层降权并打标。
const SEARCH_ONLY_HOST_PATTERNS = [/api\.17k\.com/i];

function hostOfUrl(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return String(url || '').toLowerCase(); }
}

function isSearchOnlySource(source) {
  const raw = String(source?.url || source?.sourceId || source?.bookSourceUrl || '');
  return SEARCH_ONLY_HOST_PATTERNS.some((pattern) => pattern.test(raw));
}

function loadHealth() {
  if (healthCache) return healthCache;
  healthCache = { updatedAt: 0, sources: {} };
  try {
    if (fs.existsSync(HEALTH_PATH)) {
      const raw = JSON.parse(fs.readFileSync(HEALTH_PATH, 'utf8'));
      const now = Date.now();
      for (const [url, h] of Object.entries(raw.sources || {})) {
        if (h && now - (h.last || 0) < HEALTH_TTL_MS) healthCache.sources[url] = h;
      }
      healthCache.updatedAt = raw.updatedAt || 0;
    }
  } catch {
    healthCache = { updatedAt: 0, sources: {} };
  }
  return healthCache;
}

/** 健康分：成功率 50% + 响应速度 50%，24h 内新鲜度加权；无记录返回 0。 */
function healthScore(h) {
  if (!h) return 0;
  const total = (h.ok || 0) + (h.fail || 0);
  if (!total) return 0;
  const rate = (h.ok || 0) / total;
  const speed = Math.max(0, 1 - ((h.avgMs || 1500) / 1500));
  const fresh = Date.now() - (h.last || 0) < 24 * 3600 * 1000 ? 1 : 0.6;
  return (rate * 0.5 + speed * 0.5) * fresh;
}

function recordHealth(url, ok, ms) {
  const cache = loadHealth();
  const h = cache.sources[url] || { ok: 0, fail: 0, avgMs: 0, last: 0 };
  if (ok) {
    h.ok = (h.ok || 0) + 1;
    h.avgMs = h.avgMs ? Math.round(0.7 * h.avgMs + 0.3 * ms) : Math.round(ms);
  } else {
    h.fail = (h.fail || 0) + 1;
  }
  h.last = Date.now();
  cache.sources[url] = h;
}

function persistHealth() {
  try {
    fs.mkdirSync(path.join(ROOT, 'runtime'), { recursive: true });
    fs.writeFileSync(HEALTH_PATH, JSON.stringify({ updatedAt: Date.now(), sources: loadHealth().sources }));
  } catch {
    /* 落盘失败不影响搜书主流程 */
  }
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.appendFileSync('/tmp/wuwu-book-search.log', line);
  } catch {
    /* ignore */
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isBusyError(error) {
  const text = String(error && (error.message || error) || '');
  return /繁忙|队列已满|queue (full|limit)|busy/i.test(text);
}

/** 调引擎搜索；池繁忙属于调度抖动，带抖动短重试，不计入源失败与健康缓存。 */
async function callSearchSource(source, key, opts, stats) {
  let lastError = null;
  for (let attempt = 0; attempt < BUSY_RETRY_MAX; attempt += 1) {
    try {
      const res = await searchSource(source, key, opts);
      if (res && !res.ok && isBusyError(res.error)) {
        lastError = res.error;
        stats.busy = (stats.busy || 0) + 1;
        stats.busyRetries = (stats.busyRetries || 0) + 1;
        await sleep(BUSY_RETRY_BASE_MS + Math.random() * 180);
        continue;
      }
      return res;
    } catch (error) {
      lastError = error;
      if (isBusyError(error)) {
        stats.busy = (stats.busy || 0) + 1;
        stats.busyRetries = (stats.busyRetries || 0) + 1;
        await sleep(BUSY_RETRY_BASE_MS + Math.random() * 180);
        continue;
      }
      return { ok: false, error: error.message || String(error), ms: 0 };
    }
  }
  return { ok: false, error: lastError || '引擎繁忙（重试后仍排队）', ms: 0, busy: true };
}

/* ───────────────────────── 书源装载（引擎全量缓存） ───────────────────────── */

function isSearchable(source) {
  return !!(source && source.url && (source.searchUrl || source.rules?.search?.bookList));
}

/** 异步装载引擎归一化书源（loadSources 内部读全量缓存，不在主线程做同步大 JSON 解析）。 */
async function loadEngineSources() {
  if (!sourcePromise) {
    sourcePromise = loadSourcesCore({})
      .then((all) => {
        sourceCache = all.filter((s) => s.enabled !== false && isSearchable(s));
        return sourceCache;
      })
      .catch((e) => {
        log(`engine source load failed: ${e && e.message ? e.message : e}`);
        sourceCache = [];
        return sourceCache;
      });
  }
  return sourcePromise;
}

/** 启动期预热 worker 池：投一个会被内核快速判空的任务，触发 4 个 worker 模块加载。 */
export function warmEnginePool() {
  void searchSource({}, ' ', { page: 1, timeoutMs: 600 }).catch(() => {});
}

/** 触发异步装载（同步返回当前内存清单，首次可能为空，统计以异步回调为准）。 */
export function ensureSourceCache(force = false) {
  if (force) sourcePromise = null;
  void loadEngineSources();
  return sourceCache;
}

export function getSourceStats() {
  const sources = sourceCache;
  return {
    total: sources.length,
    direct: sources.length,
    groups: new Set(sources.map((s) => s.group).filter(Boolean)).size,
    generatedAt: Date.now(),
  };
}

export function getSourceByUrl(url) {
  return sourceCache.find((s) => s.url === url) || null;
}

/** 打开/详情链路等待源清单装载完成；首次调用会触发异步装载，后续复用同一 Promise。 */
export async function awaitSourceCache() {
  return loadEngineSources();
}

/* ───────────────────────── 并发池（每源独立、先完成先返回） ───────────────────────── */

async function runPool(items, limit, worker, onProgress) {
  let cursor = 0;
  let done = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        await worker(items[index], index);
      } catch (error) {
        log(`worker failed ${items[index]?.name}: ${error.message}`);
      }
      done++;
      if (onProgress && (done % 50 === 0 || done === items.length)) onProgress(done, items.length);
    }
  });
  await Promise.all(runners);
}

/* ───────────────────────── 文本 / URL 工具 ───────────────────────── */

function collapseText(value) {
  return String(value == null ? '' : value)
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanAuthor(value) {
  let author = collapseText(value)
    .replace(/^(作者|播音|分类|类型)[：:]\s*/, '')
    .replace(/^\s*作者\s*/, '');
  if (!author) return '佚名';
  author = author.replace(/^[\[【（(]\s*/, '').replace(/^[^\w一-龥]+/, '');
  author = author.split(/\s+(?:类型|状态|总点击|月点击|周点击|总推荐|月推荐|周推荐|最新章节)/)[0];
  if (author.includes('/')) {
    const parts = author.split('/').map((part) => part.trim()).filter(Boolean);
    if (parts.length) author = parts[parts.length - 1];
  }
  author = author.replace(/[（(].*$/, '').replace(/[）)]/g, '').trim();
  return author.slice(0, 60);
}

function isUsableBookUrl(url) {
  const u = String(url || '');
  if (!u) return false;
  if (/<js>|%3Cjs%3E|%7B%7B|{{|}}|@js:|\$\{/i.test(u)) return false;
  if (/\/api\/|get-album-list|\/book\/app\/book|\/voddetail/i.test(u)) return false;
  return true;
}

function isJunkItem(item) {
  const author = String(item.author || '');
  const name = String(item.name || '');
  const url = String(item.bookUrl || '');
  const source = String(item.originName || '');
  if (/\[object Object\]/.test(author + ' ' + name)) return true;
  if (/^(最后更新|内容简介|作者：|作者:)/.test(author)) return true;
  if (/\/voddetail|\/api\/|get-album-list|\/book\/app\/book/.test(url)) return true;
  if (/影视|漫画|听书|音乐|听|国漫/.test(source)) return true;
  if (!isUsableBookUrl(url)) return true;
  if (/最后更新：|内容简介：/.test(author)) return true;
  return false;
}

/* ───────────────────────── 排序与去重 ───────────────────────── */

function sourcePriority(source) {
  let score = 0;
  const group = String(source.group || '');
  if (group.includes('搜索链接规则为空')) score -= 20;
  if (group.includes('已检')) score -= 10;
  if (source.bookUrlPattern) score += 8;
  if (/^https:/i.test(source.url)) score += 2;
  if (source.name.includes('🎃')) score -= 3;
  return score;
}

/** 解析章节/更新时间，返回 epoch ms；无法解析返回 0（排序中视为中性）。 */
function bookTimeEpoch(item) {
  for (const field of ['updateTime', 'latestChapter', 'lastChapter', 'wordCount']) {
    const raw = String(item[field] || '').trim();
    if (!raw) continue;
    const m = raw.match(/(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/);
    if (m) {
      const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
      if (Number.isFinite(t)) return t;
    }
    const d = Date.parse(raw);
    if (Number.isFinite(d)) return d;
  }
  return 0;
}

/**
 * 排序口径：书名完全匹配 > 别名/近似 > 作者匹配 > 最新章节时间新；
 * 书源可信度、非兜底作为附加分。
 */
function relevance(item, key) {
  const name = String(item.name || '');
  const author = String(item.author || '');
  const needle = String(key || '').trim();
  let score = 0;
  if (needle && name === needle) score += 100;
  if (needle && name.includes(needle)) score += 50;
  if (needle && author.includes(needle)) score += 20;
  const time = bookTimeEpoch(item);
  if (time > 0) score += Math.min(15, Math.round(time / 1e12));
  if (!item.fallback) score += 10;
  if (item.searchOnly) score -= 100;
  if (!item.author) score -= 6;
  if (/影视|漫画|听书/.test(String(item.originName || ''))) score -= 30;
  if (/\/voddetail|\/api\/|get-album-list/.test(String(item.bookUrl || ''))) score -= 40;
  if (author.split(',').length >= 3) score -= 15;
  if (/最后更新|内容简介|作者：/.test(author)) score -= 30;
  score += Math.min(40, (Number(item.sourceCount) || 1) * 0.6);
  if (item.originName && !/🎃/.test(item.originName)) score += 2;
  return score;
}

function sourceConfidence(item) {
  let score = 0;
  const name = String(item.originName || '');
  if (!item.fallback) score += 50;
  if (item.searchOnly) score -= 100;
  if (/顶点/.test(name)) score += 28;
  if (/笔趣阁|书吧|文学|读书|小说/.test(name)) score += 12;
  if (/影视|漫画|听书|音乐|听|国漫/.test(name)) score -= 15;
  if (/🎃/.test(name)) score -= 5;
  if (!isUsableBookUrl(item.bookUrl)) score -= 60;
  else score += 15;
  return score;
}

function groupResults(items) {
  const groups = new Map();
  for (const item of items) {
    const identity = `${collapseText(item.name).toLowerCase()}|${collapseText(item.author).toLowerCase()}`;
    const sourceEntry = {
      name: item.originName ? `${item.originName}${item.searchOnly ? '（仅搜索）' : ''}` : '',
      rawName: item.originName || '',
      url: item.bookSourceUrl,
      bookUrl: item.bookUrl,
      fallback: !!item.fallback,
      searchOnly: !!item.searchOnly,
    };
    let group = groups.get(identity);
    if (!group) {
      group = {
        ...item,
        _score: sourceConfidence(item),
        sources: item.originName ? [sourceEntry] : [],
        searchOnly: !!item.searchOnly,
      };
      groups.set(identity, group);
      continue;
    }
    if (item.originName && !group.sources.some((source) => source.rawName === sourceEntry.rawName && source.bookUrl === item.bookUrl)) {
      group.sources.push(sourceEntry);
    }
    group.searchOnly = group.sources.every((source) => source.searchOnly);
    const score = sourceConfidence(item);
    const itemUsable = isUsableBookUrl(item.bookUrl);
    const groupUsable = isUsableBookUrl(group.bookUrl);
    const itemOpenable = !item.searchOnly && itemUsable;
    const groupOpenable = !group.searchOnly && groupUsable;
    const shouldReplace = (!itemOpenable && groupOpenable)
      ? false
      : (itemOpenable && !groupOpenable) || ((itemOpenable === groupOpenable) && ((!groupUsable && itemUsable) || score > group._score));
    if (shouldReplace) {
      group._score = score;
      group.bookUrl = item.bookUrl;
      group.origin = item.origin;
      group.originName = item.originName;
      group.bookSourceUrl = item.bookSourceUrl;
      group.bookSourceName = item.bookSourceName;
      group.coverUrl = item.coverUrl || group.coverUrl;
      group.latestChapter = item.latestChapter || group.latestChapter;
      group.lastChapter = item.lastChapter || group.lastChapter;
      group.intro = item.intro || group.intro;
      group.fallback = group.searchOnly || !!item.fallback;
      group.searchOnly = !!item.searchOnly;
    }
  }
  return Array.from(groups.values()).map((group) => {
    const { _score, ...clean } = group;
    const primaryLabel = group.originName || group.sources[0]?.rawName || group.sources[0]?.name || '书源';
    const label = group.sources.length > 1
      ? `${primaryLabel} 等 ${group.sources.length} 个源`
      : (group.searchOnly ? `${primaryLabel}（仅搜索）` : primaryLabel);
    return {
      ...clean,
      fallback: group.searchOnly || !!group.fallback,
      searchOnly: group.searchOnly,
      sourceCount: group.sources.length,
      sourceLabel: label,
    };
  });
}

/** 引擎书籍 → 前端既有字段映射。 */
function mapEngineBook(source, book) {
  const searchOnly = isSearchOnlySource(source);
  return {
    name: collapseText(book.name),
    author: cleanAuthor(book.author),
    bookUrl: book.bookUrl,
    coverUrl: book.coverUrl || '',
    intro: book.intro || '',
    kind: book.kind || '',
    lastChapter: book.lastChapter || '',
    latestChapter: book.lastChapter || '',
    wordCount: book.wordCount || '',
    sourceId: book.sourceId || source.url,
    sourceName: book.sourceName || source.name,
    originName: book.sourceName || source.name,
    bookSourceUrl: book.sourceId || source.url,
    origin: book.sourceId || source.url,
    fallback: searchOnly,
    searchOnly,
  };
}

/* ───────────────────────── 全源搜索 ───────────────────────── */

export async function searchAllSources(query, options = {}) {
  const key = String(query || '').trim();
  if (!key) return { items: [], stats: { total: 0, searched: 0, withResults: 0, elapsedMs: 0 } };
  const cacheKey = `${key}::${options.limit || 300}`;
  const cached = queryCache.get(cacheKey);
  if (!options.force && !options.maxSources && cached && Date.now() - cached.at < 10 * 60 * 1000) {
    return cached.value;
  }

  const allSources = await loadEngineSources();
  const health = loadHealth();
  const sources = allSources
    .filter((source) => source.enabled !== false)
    .filter(isSearchable)
    .sort((a, b) => {
      const fa = FAST_URL_PATTERNS.some((p) => p.test(a.url || '')) ? 1 : 0;
      const fb = FAST_URL_PATTERNS.some((p) => p.test(b.url || '')) ? 1 : 0;
      if (fa !== fb) return fb - fa;
      const hs = healthScore(health.sources[a.url]) - healthScore(health.sources[b.url]);
      if (hs !== 0) return hs;
      const sp = sourcePriority(b) - sourcePriority(a);
      if (sp !== 0) return sp;
      const ga = GOOD_NAME_PATTERNS.some((p) => p.test(a.name || '')) ? 1 : 0;
      const gb = GOOD_NAME_PATTERNS.some((p) => p.test(b.name || '')) ? 1 : 0;
      return gb - ga || String(a.name).localeCompare(String(b.name), 'zh');
    });

  const started = Date.now();
  const items = [];
  const stats = {
    total: sources.length,
    searched: 0,
    answered: 0,
    withResults: 0,
    failed: 0,
    empty: 0,
    skipped: 0,
    busy: 0,
    busyRetries: 0,
    elapsedMs: 0,
  };
  const perSourceTimeout = Number(options.timeout) || 4500;
  const maxTotal = Number(options.limit) || 300;
  const maxSources = Math.max(0, Number(options.maxSources) || 0);
  const limitedSources = maxSources ? sources.slice(0, maxSources) : sources;

  // 波0 极快波：同一主机只留一个（避免重复源占满 4 个池槽），按实测速度排序，1200ms 超时；
  // 波1 中速波 30 个 3000ms；波2 其余慢源放宽到 10s，后台补齐。
  const hostOf = (u) => { try { return new URL(u).hostname; } catch { return String(u || '').toLowerCase(); } };
  const fastRank = (s) => {
    const idx = FAST_HOST_ORDER.findIndex((p) => p.test(s.url || ''));
    return idx < 0 ? FAST_HOST_ORDER.length : idx;
  };
  const wave0Hosts = new Set();
  const wave0 = [];
  for (const source of limitedSources) {
    if (wave0.length >= 8) break;
    const host = hostOf(source.url);
    if (wave0Hosts.has(host)) continue;
    wave0Hosts.add(host);
    wave0.push(source);
  }
  wave0.sort((a, b) => fastRank(a) - fastRank(b));
  const wave1 = limitedSources.filter((s) => !wave0Hosts.has(hostOf(s.url))).slice(0, 30);
  const wave1Hosts = new Set(wave1.map((s) => hostOf(s.url)));
  const wave2 = limitedSources.filter((s) => !wave0Hosts.has(hostOf(s.url)) && !wave1Hosts.has(hostOf(s.url)));
  const seenUrls = new Set();

  log(`engine search "${key}" across ${limitedSources.length} sources (fast ${wave0.length}, mid ${wave1.length}, slow ${wave2.length})`);

  const runWave = async (list, waveConcurrency, timeoutMs) => {
    await runPool(
      list,
      waveConcurrency,
      async (source) => {
        const t0 = Date.now();
        const res = await callSearchSource(source, key, { page: 1, timeoutMs }, stats);
        const elapsed = res.ms != null ? res.ms : Date.now() - t0;
        if (timeoutMs <= 1200) {
          log(`wave0 ${source.name} ${source.url} ${res.ok ? 'OK' : 'FAIL'} wall=${Date.now() - t0}ms engine=${elapsed}ms books=${res.books?.length || 0}`);
        } else if (elapsed > 3000) {
          log(`慢调用[searchSource] ${source.name} ${source.url} ${res.ok ? 'OK' : 'FAIL'} ${elapsed}ms${res.error ? ' ' + res.error : ''}`);
        }
        if (res.busy) {
          stats.skipped++;
          return;
        }
        if (!res.ok) {
          stats.failed++;
          recordHealth(source.url, false, elapsed);
          return;
        }
        stats.answered++;
        recordHealth(source.url, true, elapsed);
        if (!Array.isArray(res.books) || !res.books.length) {
          stats.empty++;
          return;
        }
        stats.withResults++;
        const added = [];
        for (const book of res.books) {
          const item = mapEngineBook(source, book);
          if (!item.bookUrl || seenUrls.has(item.bookUrl) || isJunkItem(item)) continue;
          seenUrls.add(item.bookUrl);
          items.push(item);
          added.push(item);
        }
        if (added.length && typeof options.onItems === 'function') {
          try { options.onItems(added, { done: stats.searched, total: limitedSources.length, hits: items.length }); } catch { /* ignore */ }
        }
        stats.searched++;
      },
      (done, total) => {
        if (done % 300 === 0) log(`progress ${done}/${total}, hits ${items.length}`);
        if (typeof options.onProgress === 'function') {
          try {
            options.onProgress({
              done,
              total,
              hits: items.length,
              sourcesWithResults: stats.withResults,
              answered: stats.answered,
              failed: stats.failed,
              skipped: stats.skipped,
              busy: stats.busy,
            });
          } catch { /* ignore callback errors */ }
        }
      }
    );
  };

  await runWave(wave0, Math.min(4, wave0.length), 1200);
  await runWave(wave1, Math.min(SEARCH_CONCURRENCY, wave1.length), 3000);
  await runWave(wave2, Math.min(SEARCH_CONCURRENCY, wave2.length), Math.max(perSourceTimeout, 10000));
  persistHealth();

  stats.elapsedMs = Date.now() - started;
  items.sort((a, b) => relevance(b, key) - relevance(a, key) || String(a.name).localeCompare(String(b.name), 'zh'));
  const grouped = groupResults(items);
  grouped.sort((a, b) => relevance(b, key) - relevance(a, key) || String(a.name).localeCompare(String(b.name), 'zh'));
  const finalItems = grouped.slice(0, maxTotal);
  stats.returned = finalItems.length;
  stats.unique = items.length;
  stats.books = grouped.length;
  stats.sourceNames = new Set(items.map((item) => item.originName).filter(Boolean)).size;
  lastStats = stats;
  const value = { items: finalItems, stats };
  if (!options.maxSources) {
    queryCache.set(cacheKey, { at: Date.now(), value });
    if (queryCache.size > 20) queryCache.delete(queryCache.keys().next().value);
  }
  log(`engine search "${key}" done: ${stats.withResults}/${stats.searched} sources with results, ${items.length} books -> ${grouped.length} groups, ${stats.elapsedMs}ms`);
  if (typeof options.onProgress === 'function') {
    try {
      options.onProgress({
        done: stats.searched,
        total: sources.length,
        hits: items.length,
        sourcesWithResults: stats.withResults,
        answered: stats.answered,
        failed: stats.failed,
        skipped: stats.skipped,
        finished: true,
      });
    } catch { /* ignore */ }
  }
  return value;
}

export function groupKeyOf(item) {
  return `${collapseText(item.name).toLowerCase()}|${collapseText(item.author).toLowerCase()}`;
}

export function groupBooks(items) {
  return groupResults(items);
}

export function getLastSearchStats() {
  return lastStats;
}
