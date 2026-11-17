#!/usr/bin/env node
/**
 * reader-searchd 客户端：把 Reader（阅读3.0）的 Rust 规则引擎当搜书后端用。
 *
 * searchd 走 SSE 增量推送：每完成一个源推一条 items，定期推 tick，最后推 done。
 * 本模块只做协议解析、批量合并与字段映射；按 name|author 聚合、排序仍由 hub 负责。
 */

const BASE = (process.env.READER_SEARCH_BASE || 'http://127.0.0.1:1180').replace(/\/+$/, '');
const HEALTH_TTL_MS = 5 * 60 * 1000;
const FLUSH_INTERVAL_MS = 120;
const FLUSH_SIZE = 400;

let healthCache = { at: 0, ok: false, info: null };

export function searchdBase() {
  return BASE;
}

/** 探测 searchd 是否在线；15s 内复用上次结果。 */
export function healthCacheSnapshot() {
  return healthCache;
}

export async function searchdHealth(force = false, timeoutMs = 5000) {
  const ttl = healthCache.ok ? HEALTH_TTL_MS : 10 * 1000;
  if (!force && Date.now() - healthCache.at < ttl) return healthCache;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/health`, { signal: ac.signal, cache: 'no-store' });
    const data = await res.json();
    healthCache = { at: Date.now(), ok: !!(res.ok && data && data.ok), info: data };
  } catch {
    // 失败只记 10 秒：引擎忙时 /health 会慢，不能因此把它判死 5 分钟。
    healthCache = { at: Date.now(), ok: false, info: null };
  } finally {
    clearTimeout(timer);
  }
  return healthCache;
}

/* ───────────── 相关性：只留和搜索词真有关的书，按匹配度先排 ───────────── */

const PUNCT_RE = /[，,。：:、|·!！?？"'“”‘’（）()【】\[\]《》<>~—\-\s]/g;

/** 归一化：小写 + 去标点空白，用于比较。 */
function normalizeText(value) {
  return String(value || '').toLowerCase().replace(PUNCT_RE, '');
}

/** 主标题：取逗号/冒号前的第一段，避免整串长句把匹配度稀释。 */
function primaryKey(key) {
  const head = String(key || '').split(/[，,：:、|]/)[0];
  return head.trim() || String(key || '').trim();
}

/** 中文按 2-gram 切，英文数字按原样。 */
function bigrams(text) {
  const t = normalizeText(text);
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  if (!set.size && t) set.add(t);
  return set;
}

/**
 * 0~1 的匹配度：
 *  1.00 书名与搜索词完全一致
 *  0.95 书名包含完整搜索词
 *  0.85 书名包含主标题
 *  0.60 作者命中
 *  0.00~0.70 按 2-gram 覆盖率折算
 */
function matchScore(name, author, key) {
  const n = normalizeText(name);
  const a = normalizeText(author);
  const k = normalizeText(key);
  if (!k) return 0;
  if (n === k) return 1;
  if (n.includes(k)) return 0.95;
  const p = normalizeText(primaryKey(key));
  if (p.length >= 2 && n.includes(p)) return 0.85;
  if (a && (a.includes(k) || (p.length >= 2 && a.includes(p)))) return 0.6;
  const qb = bigrams(primaryKey(key) || key);
  if (!qb.size) return 0;
  let hit = 0;
  for (const gram of qb) if (n.includes(gram)) hit += 1;
  return Math.min(0.7, (hit / qb.size) * 0.7);
}

/** 作者字段清洗：去掉「作者：」前缀和明显的占位符。 */
function cleanAuthorName(author) {
  const cleaned = String(author || '')
    .replace(/^(作者|作\s*者)\s*[：:]\s*/, '')
    .replace(/\[object Object\]/gi, '')
    .replace(/^(最后更新|内容简介)\s*[：:]?\s*/, '')
    .replace(/^[@＠]+/, '')
    .replace(/(著|编著|原作)$/, '')
    .trim();
  // 佚名/未知/空统一成空串，让同一本书在不同源里能合并成一条。
  if (!cleaned || /^(佚名|未知|不详|无|n\/a|unknown)$/i.test(cleaned)) return '';
  // 少数源把整段 HTML 塞进作者字段，直接清空，别让它污染书名卡片。
  if (/<|>|href|class=|内容简介|最后更新|font/i.test(cleaned)) return '';
  if (cleaned.length > 24) return '';
  return cleaned;
}

/** 书名清洗：去书名号与多余空白。 */
function cleanBookName(name) {
  const cleaned = String(name || '')
    .replace(/^《(.*)》$/, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  // 中文书名里被插空格（如「高武 严父 ， 永远」）会影响合并，统一压掉。
  if (/[\u4e00-\u9fa5]/.test(cleaned)) return cleaned.replace(/\s+/g, '');
  return cleaned;
}

/** 引擎书籍 → 书房既有字段。source 为当前书源 {name,url}。 */
function mapBook(book, source, searchKey) {
  const lastChapter = book.lastChapter || '';
  const name = cleanBookName(book.name);
  const author = cleanAuthorName(book.author);
  return {
    name,
    author,
    matchScore: matchScore(name, author, searchKey),
    bookUrl: book.bookUrl || '',
    coverUrl: book.coverUrl || '',
    intro: book.intro || '',
    kind: book.kind || '',
    lastChapter,
    latestChapter: lastChapter,
    updateTime: book.updateTime || '',
    wordCount: book.wordCount || '',
    origin: source.url || '',
    originName: source.name || '',
    bookSourceUrl: source.url || '',
    bookSourceName: source.name || '',
    sourceId: source.url || '',
    fallback: false,
    searchOnly: false,
  };
}

/**
 * 走 searchd 流式搜书。
 * @param {string} key 关键词
 * @param {object} opts { onItems(added, meta), onProgress(p), timeoutMs, page, group, signal }
 * @returns {Promise<{items: object[], stats: object}>}
 */
export async function searchViaSearchd(key, opts = {}) {
  const { onItems, onProgress, timeoutMs = 180000, page = 1, group = '' } = opts;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const external = opts.signal;
  if (external) external.addEventListener('abort', () => ac.abort(), { once: true });

  const stats = {
    total: 0,
    searched: 0,
    withResults: 0,
    answered: 0,
    failed: 0,
    skipped: 0,
    elapsedMs: 0,
  };
  const items = [];
  const pending = [];
  let flushTimer = null;
  let failedMidway = null;
  let dropped = 0;
  const primary = primaryKey(key);
  // 主标题够长（>=2 字）才启用过滤；短词（如「三体」）照单全收，避免误杀。
  const minMatch = normalizeText(primary).length >= 2 ? 0.55 : 0;

  const flush = () => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!pending.length) return;
    // 同一批内高分先出，首屏更像 Reader 的顺序。
    pending.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));
    const batch = pending.splice(0, pending.length);
    if (typeof onItems === 'function') {
      try {
        onItems(batch, { done: stats.searched, total: stats.total, hits: items.length });
      } catch {
        /* 回调异常不影响搜索 */
      }
    }
  };

  const schedule = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
  };

  const handleEvent = (payload) => {
    let evt;
    try {
      evt = JSON.parse(payload);
    } catch {
      return;
    }
    if (evt.type === 'start') {
      stats.total = Number(evt.total) || 0;
      return;
    }
    if (evt.type === 'items') {
      const source = evt.source || {};
      for (const book of evt.books || []) {
        const item = mapBook(book, source, key);
        if (!item.name || !item.bookUrl) continue;
        // 有些源会把搜索页标题当书名返回（「全文检索 关键字：…」），直接丢。
        if (/^(全文检索|关键字|搜索：|搜索结果)/.test(item.name)) { dropped += 1; continue; }
        // 站点的「搜索结果页」「免费阅读」标题会被当成书名，一并丢掉。
        if (/搜索结果|免费阅读|免费全文|无弹窗|全文阅读|最新章节列表|在线阅读/.test(item.name)) { dropped += 1; continue; }
        // 长搜索词时，很多源会返回整页泛匹配（只共享前两个字）。
        // 低于门槛的直接丢掉，否则正确结果会被埋在几千条无关书后面。
        if (minMatch > 0 && item.matchScore < minMatch) {
          dropped += 1;
          continue;
        }
        items.push(item);
        pending.push(item);
      }
      if (pending.length >= FLUSH_SIZE) flush();
      else schedule();
      return;
    }
    if (evt.type === 'tick') {
      stats.searched = Number(evt.done) || stats.searched;
      stats.total = Number(evt.total) || stats.total;
      stats.withResults = Number(evt.ok) || stats.withResults;
      stats.answered = (Number(evt.ok) || 0) + (Number(evt.empty) || 0);
      stats.failed = Number(evt.failed) || 0;
      if (typeof onProgress === 'function') {
        try {
          onProgress({
            done: stats.searched,
            total: stats.total,
            hits: items.length,
            sourcesWithResults: stats.withResults,
            answered: stats.answered,
            failed: stats.failed,
            skipped: 0,
          });
        } catch {
          /* ignore */
        }
      }
      return;
    }
    if (evt.type === 'done') {
      const s = evt.stats || {};
      stats.withResults = Number(s.ok) || stats.withResults;
      stats.answered = (Number(s.ok) || 0) + (Number(s.empty) || 0);
      stats.failed = Number(s.failed) || stats.failed;
      stats.elapsedMs = Number(s.elapsedMs) || 0;
      stats.searched = stats.total;
      if (typeof onProgress === 'function') {
        try {
          onProgress({ ...stats, done: stats.total, hits: items.length, finished: true });
        } catch {
          /* ignore */
        }
      }
      return;
    }
    if (evt.type === 'error') throw new Error(evt.message || 'searchd 搜索失败');
  };

  try {
    const qs = new URLSearchParams({ key, page: String(page) });
    if (group) qs.set('group', group);
    const res = await fetch(`${BASE}/search/stream?${qs.toString()}`, {
      headers: { accept: 'text/event-stream' },
      signal: ac.signal,
    });
    if (!res.ok || !res.body) throw new Error(`searchd 返回 ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() || '';
      for (const block of blocks) {
        for (const line of block.split('\n')) {
          const trimmed = line.replace(/\r$/, '');
          if (trimmed.startsWith('data:')) handleEvent(trimmed.slice(5).trim());
        }
      }
    }
  } catch (error) {
    // 中途断掉但已经有结果：当作部分成功，别把已经拿到的书全丢了再回落到慢引擎。
    if (!items.length) throw error;
    failedMidway = error && error.message ? error.message : String(error);
  } finally {
    clearTimeout(timer);
    flush();
  }

  stats.dropped = dropped;
  stats.primaryKey = primary;
  return { items, stats, partial: !!failedMidway, error: failedMidway || '' };
}
