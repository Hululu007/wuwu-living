#!/usr/bin/env node
/**
 * 打开加速：搜索命中后的后台预热与磁盘缓存模块。
 *
 * 设计约束：
 *  - 不依赖、不起任何 HTTP 服务；引擎能力来自 `./legado/index.mjs`（契约冻结，不改签名）。
 *  - 全模块永不抛异常：任何失败返回 `{ok:false,error}`；预热在后台并发进行，不阻塞主线程。
 *  - 缓存落 `runtime/books/<sha1(sourceId|bookUrl)>.json`，7 天 TTL，临时文件 + rename 原子写。
 *
 * 对外导出：
 *  - warmOnSearchHits(hits, opts)   搜索命中后后台预取 info + 目录 + 可选首章正文
 *  - readBookCache(sourceId, bookUrl)  读缓存，返回 {hit, age, book, ...}；过期视为未命中但文件保留
 *  - writeBookCache(sourceId, bookUrl, payload)  原子写缓存
 *  - warmStats()                    内存计数：命中/未命中/预热成功率/最近 N 次预热耗时/峰值并发
 *  - __resetStats()                 测试用内部钩子，清空内存统计
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as legado from './legado/index.mjs';
import { runtimePath } from './runtime_dir.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOOKS_DIR = runtimePath(ROOT, 'books');

const TTL_MS = 7 * 24 * 3600 * 1000;
const DEFAULT_LIMIT = 5;
const CONCURRENCY = 3;
const RECENT_LIMIT = 20;
const TIMEOUT = { info: 8000, toc: 10000, content: 10000 };

/* ───────────────────────── 内存统计（进程内，不落盘） ───────────────────────── */

const stats = {
  cacheHits: 0,
  cacheMiss: 0,
  warmOk: 0,
  warmFail: 0,
  recentWarmMs: [],
  peakConcurrency: 0,
};

export function __resetStats() {
  stats.cacheHits = 0;
  stats.cacheMiss = 0;
  stats.warmOk = 0;
  stats.warmFail = 0;
  stats.recentWarmMs = [];
  stats.peakConcurrency = 0;
}

/* ───────────────────────── 缓存路径与键 ───────────────────────── */

function cacheKey(sourceId, bookUrl) {
  return crypto.createHash('sha1').update(`${sourceId || ''}|${bookUrl || ''}`).digest('hex');
}

function cacheFile(sourceId, bookUrl) {
  return path.join(BOOKS_DIR, `${cacheKey(sourceId, bookUrl)}.json`);
}

/**
 * 读缓存。TTL 过期视为未命中（hit=false），文件保留不删。
 * @returns {{hit:boolean, age:number|null, at:number|null, book:object|null, reason:string}}
 */
export function readBookCache(sourceId, bookUrl) {
  if (!bookUrl) {
    stats.cacheMiss += 1;
    return { hit: false, age: null, at: null, book: null, reason: 'no-bookUrl' };
  }
  try {
    const file = cacheFile(sourceId, bookUrl);
    if (!fs.existsSync(file)) {
      stats.cacheMiss += 1;
      return { hit: false, age: null, at: null, book: null, reason: 'absent' };
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const at = Number(data.at) || 0;
    const age = Date.now() - at;
    if (age > TTL_MS) {
      stats.cacheMiss += 1;
      return { hit: false, age, at, book: data, reason: 'expired' };
    }
    stats.cacheHits += 1;
    return { hit: true, age, at, book: data, reason: 'fresh' };
  } catch (error) {
    stats.cacheMiss += 1;
    return { hit: false, age: null, at: null, book: null, reason: String(error && error.message || error) };
  }
}

/**
 * 原子写缓存：先写同目录临时文件，再 rename 覆盖。
 * @returns {{ok:boolean, path?:string, error?:string}}
 */
export function writeBookCache(sourceId, bookUrl, payload) {
  if (!bookUrl) return { ok: false, error: '缺少 bookUrl' };
  const file = cacheFile(sourceId, bookUrl);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(BOOKS_DIR, { recursive: true });
    const body = JSON.stringify({ at: Date.now(), ...payload });
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, file);
    return { ok: true, path: file };
  } catch (error) {
    try { fs.existsSync(tmp) && fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    return { ok: false, error: String(error && error.message || error) };
  }
}

/* ───────────────────────── 引擎调用包装（双保险超时，永不抛） ───────────────────────── */

/**
 * 包一层超时与异常兜底：引擎契约永不抛，但池层 reject / 卡死也要被兜住。
 * @returns {Promise<{ok:boolean,error?:string,ms:number,...}>}
 */
function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: `${label}超时（${ms}ms）`, ms }), ms);
  });
  const guarded = Promise.resolve(promise).catch((error) => ({
    ok: false,
    error: String(error && error.message || error),
    ms,
  }));
  return Promise.race([guarded, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function pickSourceId(hit) {
  return hit.sourceId || hit.bookSourceUrl || hit.origin || hit.url || hit.sourceUrl || '';
}

function findSource(sources, sourceId) {
  if (!Array.isArray(sources) || !sourceId) return null;
  return sources.find((s) => s && (s.url === sourceId || s.id === sourceId)) || null;
}

/* ───────────────────────── 单本预热：info → 目录 → 可选首章 ───────────────────────── */

async function warmOne(hit, engine, sources) {
  const t0 = Date.now();
  const sourceId = pickSourceId(hit);
  const bookUrl = hit.bookUrl;
  const source = findSource(sources, sourceId);
  if (!source) {
    return { ok: false, stage: 'source', error: '未找到对应书源', sourceId, bookUrl, totalMs: Date.now() - t0 };
  }

  // 1. 详情（8s）
  const info = await withTimeout(
    engine.bookInfo(source, { bookUrl, name: hit.name, author: hit.author }, { timeoutMs: TIMEOUT.info }),
    TIMEOUT.info,
    '详情'
  );
  if (!info.ok) {
    return {
      ok: false, stage: 'info', error: info.error || '详情解析失败',
      sourceId: source.url, bookUrl, infoMs: info.ms, tocMs: null, contentMs: null,
      totalMs: Date.now() - t0,
    };
  }

  const book = {
    name: info.name || hit.name || '未命名',
    author: info.author || hit.author || '',
    bookUrl,
    origin: source.url,
    originName: source.name,
    coverUrl: info.coverUrl || hit.coverUrl || '',
    tocUrl: info.tocUrl || bookUrl,
    intro: info.intro || hit.intro || '',
    kind: info.kind || hit.kind || '',
    lastChapter: info.lastChapter || hit.lastChapter || '',
    latestChapter: info.lastChapter || hit.lastChapter || '',
    wordCount: info.wordCount || hit.wordCount || '',
    sourceName: source.name,
    sourceId: source.url,
  };

  // 2. 目录（10s）；目录失败不落盘（与现有打开链路口径一致）
  const toc = await withTimeout(
    engine.chapterList(source, book, { timeoutMs: TIMEOUT.toc }),
    TIMEOUT.toc,
    '目录'
  );
  if (!toc.ok || !Array.isArray(toc.chapters) || !toc.chapters.length) {
    return {
      ok: false, stage: 'toc', error: toc.error || '目录为空',
      sourceId: source.url, bookUrl, infoMs: info.ms, tocMs: toc.ms, contentMs: null,
      totalMs: Date.now() - t0,
    };
  }

  const chapters = toc.chapters.map((c, i) => ({
    title: (c.name || '').trim() || `第 ${i + 1} 章`,
    url: c.url,
    index: i,
    isVip: false,
    isPay: false,
    isVolume: false,
  }));

  // 3. 首章正文（10s，可选；失败不影响 info/目录落盘）
  let firstChapter = null;
  let contentMs = null;
  const first = chapters[0];
  if (first && first.url) {
    const content = await withTimeout(
      engine.chapterContent(source, book, { name: first.title, url: first.url }, { timeoutMs: TIMEOUT.content }),
      TIMEOUT.content,
      '首章'
    );
    contentMs = typeof content.ms === 'number' ? content.ms : null;
    if (content.ok && content.content) {
      firstChapter = {
        title: first.title,
        url: first.url,
        index: 0,
        content: content.content,
        length: String(content.content).length,
      };
    }
  }

  const payload = {
    book,
    saved: false,
    saveError: '本地规则引擎未写入书架',
    chapters,
    firstChapter,
    engine: 'legado-warm',
    warmedAt: Date.now(),
  };
  const wr = writeBookCache(source.url, bookUrl, payload);
  if (!wr.ok) {
    return {
      ok: false, stage: 'write', error: wr.error,
      sourceId: source.url, bookUrl, infoMs: info.ms, tocMs: toc.ms, contentMs,
      totalMs: Date.now() - t0,
    };
  }

  return {
    ok: true,
    sourceId: source.url,
    bookUrl,
    infoMs: info.ms,
    tocMs: toc.ms,
    contentMs,
    totalMs: Date.now() - t0,
    chapterCount: chapters.length,
    contentReady: firstChapter != null,
  };
}

/* ───────────────────────── 并发限流（上限 3） ───────────────────────── */

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length).fill(null);
  let cursor = 0;
  let active = 0;

  async function loop() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      active += 1;
      if (active > stats.peakConcurrency) stats.peakConcurrency = active;
      try {
        results[i] = await worker(items[i], i);
      } catch (error) {
        results[i] = { ok: false, error: String(error && error.message || error) };
      } finally {
        active -= 1;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => loop()));
  return results;
}

/* ───────────────────────── 对外：搜索命中预热 ───────────────────────── */

/**
 * 搜索命中后后台并发预取前 N 个候选的 info + 目录 + 可选首章。
 * @param {Array<{sourceId?:string,bookSourceUrl?:string,origin?:string,url?:string,bookUrl:string,name?:string,author?:string,coverUrl?:string,intro?:string,kind?:string,lastChapter?:string,wordCount?:string}>} hits
 * @param {{limit?:number, engine?:object}} opts  limit 默认 5；engine 仅测试注入，默认 legado 引擎
 * @returns {Promise<{ok:boolean, scheduled?:number, skippedCached?:number, success?:number, fail?:number, results:Array, error?:string}>}
 */
export async function warmOnSearchHits(hits, opts = {}) {
  try {
    if (!Array.isArray(hits) || !hits.length) return { ok: true, scheduled: 0, skippedCached: 0, success: 0, fail: 0, results: [] };

    const limit = Math.max(1, Number(opts.limit) || DEFAULT_LIMIT);
    const engine = opts.engine || legado;
    const candidates = hits.slice(0, limit).filter((h) => h && h.bookUrl);
    if (!candidates.length) return { ok: true, scheduled: 0, skippedCached: 0, success: 0, fail: 0, results: [] };

    // 装载归一化书源（引擎内部有缓存；失败给空数组，后续按未找到书源逐条记失败）
    const sources = await Promise.resolve(engine.loadSources({})).catch(() => []);

    // 已有未过期缓存的跳过，不重复抓
    const queue = [];
    for (const h of candidates) {
      const cached = readBookCache(pickSourceId(h), h.bookUrl);
      if (!cached.hit) queue.push(h);
    }
    const skippedCached = candidates.length - queue.length;

    const results = await mapLimit(queue, CONCURRENCY, (h) => warmOne(h, engine, sources));

    let okCount = 0;
    let failCount = 0;
    for (const r of results) {
      if (r && r.ok) {
        okCount += 1;
        stats.warmOk += 1;
        stats.recentWarmMs.push(r.totalMs);
        if (stats.recentWarmMs.length > RECENT_LIMIT) stats.recentWarmMs.shift();
      } else {
        failCount += 1;
        stats.warmFail += 1;
      }
    }
    return { ok: true, scheduled: queue.length, skippedCached, success: okCount, fail: failCount, results };
  } catch (error) {
    return { ok: false, error: String(error && error.message || error), results: [] };
  }
}

/* ───────────────────────── 统计 ───────────────────────── */

/**
 * 预热/缓存内存计数。
 * @returns {{cacheHits:number, cacheMiss:number, cacheHitRate:number|null, warmOk:number, warmFail:number, warmSuccessRate:number|null, recentWarmMs:number[], recentAvgMs:number|null, peakConcurrency:number}}
 */
export function warmStats() {
  const cacheTotal = stats.cacheHits + stats.cacheMiss;
  const warmTotal = stats.warmOk + stats.warmFail;
  const recent = [...stats.recentWarmMs];
  const recentAvgMs = recent.length ? Math.round(recent.reduce((a, b) => a + b, 0) / recent.length) : null;
  return {
    cacheHits: stats.cacheHits,
    cacheMiss: stats.cacheMiss,
    cacheHitRate: cacheTotal ? Number((stats.cacheHits / cacheTotal).toFixed(3)) : null,
    warmOk: stats.warmOk,
    warmFail: stats.warmFail,
    warmSuccessRate: warmTotal ? Number((stats.warmOk / warmTotal).toFixed(3)) : null,
    recentWarmMs: recent,
    recentAvgMs,
    peakConcurrency: stats.peakConcurrency,
  };
}
