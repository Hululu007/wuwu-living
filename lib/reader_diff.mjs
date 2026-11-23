#!/usr/bin/env node
/**
 * 金标准对照器（P3）：Reader.app（127.0.0.1:1122）直连接口 vs 五五客厅书房接口
 * （127.0.0.1:8890），对同一本书逐项比对书名 / 作者 / 目录条数 / 首章正文相似度，
 * 追加写日志、落结构化报告，供验收与长期回归使用。
 *
 * 约束：
 *  - 只读调用两侧服务，不重启、不 kill、不改业务代码；
 *  - 纯 Node 内置能力（fetch / AbortController / fs），零新依赖；
 *  - 任一接口超时或失败不崩，记 FAIL 后继续下一本；
 *  - 串行处理，不并发轰炸。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimePath } from './runtime_dir.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULTS = Object.freeze({
  hallBase: 'http://127.0.0.1:8890',
  readerBase: 'http://127.0.0.1:1122',
  books: 10,
  keywords: ['流浪地球', '诡秘之主', '剑来', '三体', '凡人修仙传'],
  readerTimeout: 10000, // Reader 侧单请求超时 10s
  hallTimeout: 15000,   // 客厅侧单请求超时 15s
  pollInterval: 1500,   // 搜书任务轮询间隔
  searchMaxWait: 90000, // 单个关键词搜书最长等待（等任务收尾再取完整候选集）
  reportPath: runtimePath(ROOT, 'reader-diff-report.json'),
  logPath: runtimePath(ROOT, 'reader-diff.log'),
});

/* ───────────────────────── 文本归一化 ───────────────────────── */

/** 去标签 + 折叠空白 + trim。 */
export function cleanText(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 作者归一化：先去全部空白，再去掉「作者：」「作者」前缀。 */
export function normalizeAuthor(s) {
  return cleanText(s)
    .replace(/\s+/g, '')
    .replace(/^作者[：:]/, '')
    .replace(/^作者/, '')
    .trim();
}

function decodeHtml(s) {
  return String(s)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** 正文 HTML 转纯文本（与书房侧 contentToText 同口径的子集）。 */
export function stripHtml(html) {
  const t = String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<\/div\s*>/gi, '\n')
    .replace(/<\/h[1-6]\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');
  return decodeHtml(t).replace(/\r\n?/g, '\n').trim();
}

/** 正文比较前的最终归一化：去标签后再去掉全部空白。 */
export function normalizeContent(html) {
  return stripHtml(html).replace(/\s+/g, '');
}

/**
 * 字符级相似度：LCS 长度 / 较长串长度。
 * 串长已截断到 100，DP 开销可控。
 */
export function lcsSimilarity(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (!x && !y) return 1;
  if (!x || !y) return 0;
  const n = x.length;
  const m = y.length;
  const dp = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    let prev = 0;
    for (let j = 1; j <= m; j += 1) {
      const cur = dp[j];
      dp[j] = x[i - 1] === y[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = cur;
    }
  }
  return dp[m] / Math.max(n, m);
}

/* ───────────────────────── 通用 HTTP ───────────────────────── */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 网络/调用失败分类：timeout / econnreset / network-other。 */
function classifyNetworkError(e) {
  const name = e && e.name;
  const msg = String((e && e.message) || e || '');
  if (name === 'AbortError' || /超时|timeout/i.test(msg)) return 'timeout';
  if (/ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|socket hang up|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH/i.test(msg)) {
    return 'econnreset';
  }
  return 'network-other';
}

/** 带超时的 JSON 请求；失败不抛异常，统一返回结构化结果。 */
async function httpRequest(base, pathname, { method = 'GET', body, timeout, headers = {} } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  const t0 = Date.now();
  let status = 0;
  let contentType = '';
  let text = '';
  let error = '';
  let errorKind = '';
  try {
    const init = {
      method,
      headers: { accept: 'application/json', ...headers },
      signal: ac.signal,
      cache: 'no-store',
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers['content-type'] = 'application/json';
    }
    const r = await fetch(base.replace(/\/+$/, '') + pathname, init);
    status = r.status;
    contentType = r.headers.get('content-type') || '';
    text = await r.text();
  } catch (e) {
    errorKind = classifyNetworkError(e);
    error = e && e.name === 'AbortError' ? `请求超时（${timeout}ms）` : String((e && e.message) || e);
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return {
    status,
    ok: !error && status >= 200 && status < 300,
    contentType,
    text,
    data,
    error,
    errorKind,
    elapsedMs: Date.now() - t0,
  };
}

/** Reader 信封解包：{isSuccess, errorMsg, data}。 */
function unwrapReader(resp) {
  if (resp.error) return { ok: false, error: resp.error, errorKind: resp.errorKind || 'network-other', data: null, raw: resp.text.slice(0, 200) };
  if (resp.data && resp.data.isSuccess === false) {
    return { ok: false, error: resp.data.errorMsg || 'Reader 返回失败', errorKind: 'rule-miss', data: null, raw: resp.text.slice(0, 200) };
  }
  if (resp.data && typeof resp.data.isSuccess === 'boolean') {
    return { ok: true, data: resp.data.data, raw: resp.text.slice(0, 200) };
  }
  return { ok: resp.ok, data: resp.data, raw: resp.text.slice(0, 200), note: '非标准信封' };
}

/* ─────────────────────── Reader 侧取数（1122） ─────────────────────── */

async function readerInfo(readerBase, bookUrl, sourceUrl, timeout) {
  const resp = await httpRequest(readerBase, '/reader3/getBookInfo', {
    method: 'POST',
    body: { url: bookUrl, bookSourceUrl: sourceUrl },
    timeout,
  });
  const w = unwrapReader(resp);
  const info = (w.ok && w.data) || {};
  return {
    ok: w.ok,
    error: w.error || '',
    errorKind: w.ok ? '' : (w.errorKind || 'field-missing'),
    elapsedMs: resp.elapsedMs,
    status: resp.status,
    name: cleanText(info.name),
    author: normalizeAuthor(info.author),
    bookUrl: cleanText(info.bookUrl),
    sourceUrl: cleanText(info.origin || info.bookSourceUrl),
    raw: w.raw,
  };
}

async function readerToc(readerBase, bookUrl, sourceUrl, tocUrl, timeout) {
  const resp = await httpRequest(readerBase, '/reader3/getChapterList', {
    method: 'POST',
    body: { bookUrl, bookSourceUrl: sourceUrl, tocUrl: tocUrl || bookUrl, refresh: 0 },
    timeout,
  });
  const w = unwrapReader(resp);
  const list = w.ok && Array.isArray(w.data) ? w.data : [];
  const first = list.find((c) => !c.isVip && !c.isPay && !c.isVolume) || list[0] || null;
  return {
    ok: w.ok,
    error: w.error || '',
    errorKind: w.ok ? '' : (w.errorKind || 'field-missing'),
    elapsedMs: resp.elapsedMs,
    count: list.length || null,
    chapterUrl: cleanText(first && first.url),
    chapterTitle: cleanText(first && first.title),
    chapterIndex: first && Number.isFinite(first.index) ? first.index : 0,
  };
}

async function readerContent(readerBase, bookUrl, sourceUrl, chapter, timeout) {
  const resp = await httpRequest(readerBase, '/reader3/getBookContent', {
    method: 'POST',
    body: {
      bookUrl,
      chapterUrl: chapter.url,
      bookSourceUrl: sourceUrl,
      index: chapter.index,
      chapterTitle: chapter.title,
      refresh: 0,
    },
    timeout,
  });
  const w = unwrapReader(resp);
  let head = '';
  if (w.ok) {
    head = normalizeContent(typeof w.data === 'string' ? w.data : JSON.stringify(w.data ?? ''));
  }
  return {
    ok: w.ok,
    error: w.error || '',
    errorKind: w.ok ? '' : (w.errorKind || 'field-missing'),
    elapsedMs: resp.elapsedMs,
    contentHead: head,
  };
}

/** Reader 书架清单（搜索限流/为空时兜底取书）。 */
async function readerShelf(readerBase, timeout) {
  const resp = await httpRequest(readerBase, '/reader3/getBookshelf', { method: 'GET', timeout });
  const w = unwrapReader(resp);
  const list = w.ok && Array.isArray(w.data) ? w.data : [];
  return list
    .map((b) => ({
      name: cleanText(b.name),
      author: normalizeAuthor(b.author),
      bookUrl: cleanText(b.bookUrl),
      sourceUrl: cleanText(b.origin || b.bookSourceUrl),
      sourceName: cleanText(b.originName),
    }))
    .filter((x) => x.bookUrl && x.sourceUrl);
}

/** Reader 侧一本书的完整取数（详情→目录→首章正文），任一步失败记 FAIL 不中断。 */
async function readerSide(readerBase, book, timeout) {
  const side = {
    ok: false,
    name: '',
    author: '',
    error: '',
    errorKind: '',
    tocCount: null,
    tocError: '',
    tocErrorKind: '',
    chapterUrl: '',
    contentHead: '',
    contentError: '',
    contentErrorKind: '',
    elapsedMs: 0,
    stageMs: { info: 0, toc: 0, content: 0 },
  };

  const info = await readerInfo(readerBase, book.bookUrl, book.sourceUrl, timeout);
  side.ok = info.ok;
  side.name = info.name;
  side.author = info.author;
  side.error = info.error;
  side.errorKind = info.errorKind;
  side.stageMs.info = info.elapsedMs;
  side.elapsedMs += info.elapsedMs;
  if (!info.ok) return side;
  if (!info.name) {
    side.ok = false;
    side.error = '详情缺少书名等关键字段';
    side.errorKind = 'field-missing';
    return side;
  }

  const toc = await readerToc(readerBase, book.bookUrl, book.sourceUrl, info.bookUrl, timeout);
  side.tocCount = toc.count;
  side.tocError = toc.error;
  side.tocErrorKind = toc.errorKind;
  side.chapterUrl = toc.chapterUrl;
  side.stageMs.toc = toc.elapsedMs;
  side.elapsedMs += toc.elapsedMs;
  if (!toc.ok) {
    side.error = toc.error;
    side.errorKind = toc.errorKind;
    return side;
  }
  if (!toc.chapterUrl) {
    side.ok = false;
    side.error = '目录为空或缺少章节地址';
    side.errorKind = 'field-missing';
    return side;
  }

  const content = await readerContent(
    readerBase,
    book.bookUrl,
    book.sourceUrl,
    { url: toc.chapterUrl, index: toc.chapterIndex, title: toc.chapterTitle },
    timeout,
  );
  side.contentHead = content.contentHead;
  side.contentError = content.error;
  side.contentErrorKind = content.errorKind;
  side.stageMs.content = content.elapsedMs;
  side.elapsedMs += content.elapsedMs;
  if (!content.ok) {
    side.error = content.error;
    side.errorKind = content.errorKind;
  }
  return side;
}

/* ─────────────────────── 客厅侧取数（8890） ─────────────────────── */

async function hallSearchOnce(hallBase, q, timeout, maxWait, pollInterval) {
  const start = await httpRequest(hallBase, '/api/book/search-start', {
    method: 'POST',
    body: { q },
    timeout,
  });
  if (!start.ok || !start.data || start.data.ok !== true) {
    return {
      ok: false,
      error: (start.data && start.data.message) || start.error || '搜书任务启动失败',
      errorKind: start.errorKind || 'network-other',
      items: [],
    };
  }
  const jobId = start.data.job && start.data.job.id;
  if (!jobId) return { ok: false, error: '搜书任务未返回 jobId', errorKind: 'field-missing', items: [] };
  const t0 = Date.now();
  let lastItems = [];
  while (Date.now() - t0 < maxWait) {
    await sleep(pollInterval);
    const st = await httpRequest(hallBase, `/api/book/search-status?job=${encodeURIComponent(jobId)}`, { timeout });
    const job = st.data && st.data.job;
    if (!job) continue;
    if (Array.isArray(job.items)) lastItems = job.items;
    if (job.status === 'done' || job.status === 'error') {
      return {
        ok: job.status === 'done',
        error: job.error || '',
        errorKind: job.status === 'error' ? 'rule-miss' : '',
        items: Array.isArray(job.items) ? job.items : [],
      };
    }
  }
  // 超时不丢弃已出的部分候选，标注 incomplete 供报告区分
  return { ok: false, error: '搜书任务超时（候选集未收尾，仅保留部分命中）', errorKind: 'timeout', items: lastItems, incomplete: true };
}

/** 把聚合后的分组书拍平成候选（bookUrl + sourceUrl 唯一）。 */
function titleKey(name) {
  return cleanText(name).toLowerCase().replace(/\s+/g, '');
}

/** 过滤两侧都无法开链的特殊 API 地址（17K merge 接口、data: 源）。 */
function openableUrl(u) {
  if (!u) return false;
  if (/^data:/i.test(u)) return false;
  if (/api\.17k\.com/i.test(u)) return false;
  if (/\/split1\/merge/i.test(u)) return false;
  return /^https?:\/\//i.test(u);
}

function candidatesFromGroups(groups) {
  const out = [];
  const seenUrl = new Set();
  const seenTitle = new Set();
  for (const g of groups || []) {
    const rawSources = g.sources && g.sources.length
      ? g.sources
      : [{ name: g.originName, url: g.bookSourceUrl, bookUrl: g.bookUrl }];
    // 保留整组可开链候选源，open 时整包交给客厅多候选 race；每组只选一个主源做对照主键
    const sources = rawSources
      .map((s) => ({
        name: cleanText(s.name),
        url: cleanText(s.url || s.bookSourceUrl),
        bookUrl: cleanText(s.bookUrl),
        fallback: !!s.fallback,
      }))
      .filter((x) => x.bookUrl && x.url && openableUrl(x.bookUrl));
    if (!sources.length) continue;
    const primary = openableUrl(g.bookUrl)
      ? { name: cleanText(g.originName), url: cleanText(g.bookSourceUrl), bookUrl: cleanText(g.bookUrl) }
      : sources[0];
    const bookUrl = primary.bookUrl || g.bookUrl;
    const sourceUrl = primary.url || g.bookSourceUrl;
    if (!bookUrl || !sourceUrl || !openableUrl(bookUrl)) continue;
    const uk = `${bookUrl}|${sourceUrl}`;
    if (seenUrl.has(uk)) continue;
    const tk = titleKey(g.name);
    if (seenTitle.has(tk)) continue;
    seenUrl.add(uk);
    seenTitle.add(tk);
    out.push({
      name: cleanText(g.name),
      author: normalizeAuthor(g.author),
      bookUrl,
      sourceUrl,
      sourceName: primary.name || cleanText(g.originName),
      sources,
    });
  }
  return out;
}

/** 客厅返回消息归类：规则/书源不命中 vs 字段缺失。 */
function classifyHubMessage(msg) {
  if (/规则|书源|不命中|没有可用|没抓到|解析|页面|打开这本书失败/i.test(String(msg || ''))) return 'rule-miss';
  return 'field-missing';
}

async function hallOpen(hallBase, book, timeout) {
  const resp = await httpRequest(hallBase, '/api/book/open', {
    method: 'POST',
    body: {
      bookUrl: book.bookUrl,
      bookSourceUrl: book.sourceUrl,
      origin: book.sourceUrl,
      originName: book.sourceName,
      sources: Array.isArray(book.sources) ? book.sources : [],
    },
    timeout,
  });
  const d = resp.data || {};
  const chapters = Array.isArray(d.chapters) ? d.chapters : [];
  const first = chapters.find((c) => !c.isVip && !c.isPay && !c.isVolume) || chapters[0] || null;
  const fc = d.firstChapter || {};
  return {
    ok: resp.ok && d.ok === true,
    error: d.message || resp.error || '',
    errorKind: resp.errorKind || (d.ok === false ? classifyHubMessage(d.message) : ''),
    elapsedMs: resp.elapsedMs,
    name: cleanText(d.book && d.book.name),
    author: normalizeAuthor(d.book && d.book.author),
    tocCount: chapters.length || null,
    chapterUrl: cleanText(first && first.url),
    chapterTitle: cleanText(first && first.title),
    chapterIndex: first && Number.isFinite(first.index) ? first.index : 0,
    firstChapter: {
      title: cleanText(fc.title),
      url: cleanText(fc.url),
      index: Number.isFinite(fc.index) ? fc.index : 0,
      length: Number.isFinite(fc.length) ? fc.length : null,
      content: String(fc.content || ''),
    },
    cached: d.cached === true,
    sourceUsed: cleanText(d.sourceUsed),
  };
}

async function hallChapter(hallBase, book, chapter, timeout) {
  const resp = await httpRequest(hallBase, '/api/book/chapter', {
    method: 'POST',
    body: {
      bookUrl: book.bookUrl,
      bookSourceUrl: book.sourceUrl,
      chapterUrl: chapter.url,
      index: chapter.index,
      chapterTitle: chapter.title,
    },
    timeout,
  });
  const d = resp.data || {};
  return {
    ok: resp.ok && d.ok === true,
    error: d.message || resp.error || '',
    errorKind: resp.errorKind || (d.ok === false ? classifyHubMessage(d.message) : ''),
    elapsedMs: resp.elapsedMs,
    contentHead: normalizeContent(d.content || ''),
  };
}

/** 客厅侧一本书的完整取数。 */
async function hallSide(hallBase, book, timeout) {
  const side = {
    ok: false,
    name: '',
    author: '',
    error: '',
    errorKind: '',
    tocCount: null,
    tocError: '',
    tocErrorKind: '',
    chapterUrl: '',
    contentHead: '',
    contentError: '',
    contentErrorKind: '',
    elapsedMs: 0,
    stageMs: { open: 0, content: 0 },
    cached: false,
    sourceUsed: '',
  };

  const open = await hallOpen(hallBase, book, timeout);
  side.ok = open.ok;
  side.name = open.name;
  side.author = open.author;
  side.error = open.error;
  side.errorKind = open.errorKind;
  side.tocCount = open.tocCount;
  side.chapterUrl = open.chapterUrl;
  side.cached = open.cached;
  side.sourceUsed = open.sourceUsed;
  side.stageMs.open = open.elapsedMs;
  side.elapsedMs += open.elapsedMs;
  if (!open.ok) {
    side.tocError = open.error;
    side.tocErrorKind = open.errorKind;
    return side;
  }
  if (!open.name) {
    side.ok = false;
    side.error = '详情缺少书名等关键字段';
    side.errorKind = 'field-missing';
    return side;
  }
  if (!open.chapterUrl) {
    side.ok = false;
    side.error = '目录为空或缺少章节地址';
    side.errorKind = 'field-missing';
    return side;
  }

  // open 已带回首章正文时直接复用，避免再打一次易超时的 chapter 接口
  let content;
  if (open.firstChapter && open.firstChapter.content) {
    content = {
      ok: true,
      error: '',
      errorKind: '',
      elapsedMs: 0,
      contentHead: normalizeContent(open.firstChapter.content),
    };
  } else {
    content = await hallChapter(
      hallBase,
      book,
      { url: open.chapterUrl, index: open.chapterIndex, title: open.chapterTitle },
      timeout,
    );
  }
  side.contentHead = content.contentHead;
  side.contentError = content.error;
  side.contentErrorKind = content.errorKind || '';
  side.stageMs.content = content.elapsedMs;
  side.elapsedMs += content.elapsedMs;
  if (!content.ok) {
    side.error = content.error;
    side.errorKind = content.errorKind || side.errorKind;
  }
  return side;
}

/* ───────────────────────── 四项比对 ───────────────────────── */

function failBoth(reason) {
  return { status: 'FAIL', reason };
}

const KIND_LABEL = {
  timeout: '超时',
  econnreset: '连接重置',
  'field-missing': '字段缺失',
  'rule-miss': '规则不命中',
  'network-other': '其他网络错误',
};

function kindOf(side) {
  return side && side.errorKind ? `（${KIND_LABEL[side.errorKind] || side.errorKind}）` : '';
}

function checkName(r, h) {
  if (!r.ok && !h.ok) return failBoth(`两侧详情均失败：Reader${kindOf(r)} ${r.error || '无'}；客厅${kindOf(h)} ${h.error || '无'}`);
  if (!r.ok) return { status: 'FAIL', reason: `Reader 详情失败${kindOf(r)}：${r.error}` };
  if (!h.ok) return { status: 'FAIL', reason: `客厅详情失败${kindOf(h)}：${h.error}` };
  const pass = r.name === h.name;
  return {
    status: pass ? 'PASS' : 'DIFF',
    reason: pass ? '书名一致' : `书名不一致：Reader「${r.name}」 vs 客厅「${h.name}」`,
    reader: r.name,
    hall: h.name,
  };
}

function checkAuthor(r, h) {
  if (!r.ok && !h.ok) return failBoth(`两侧详情均失败：Reader${kindOf(r)} ${r.error || '无'}；客厅${kindOf(h)} ${h.error || '无'}`);
  if (!r.ok) return { status: 'FAIL', reason: `Reader 详情失败${kindOf(r)}：${r.error}` };
  if (!h.ok) return { status: 'FAIL', reason: `客厅详情失败${kindOf(h)}：${h.error}` };
  const pass = r.author === h.author;
  return {
    status: pass ? 'PASS' : 'DIFF',
    reason: pass ? '作者一致' : `作者不一致：Reader「${r.author}」 vs 客厅「${h.author}」`,
    reader: r.author,
    hall: h.author,
  };
}

function checkToc(r, h) {
  if (!r.ok && !h.ok) return failBoth(`两侧目录均失败：Reader${kindOf(r)} ${r.error || r.tocError || '无'}；客厅${kindOf(h)} ${h.error || h.tocError || '无'}`);
  if (!r.ok) return { status: 'FAIL', reason: `Reader 目录失败${kindOf(r)}：${r.error || r.tocError}` };
  if (!h.ok) return { status: 'FAIL', reason: `客厅目录失败${kindOf(h)}：${h.error || h.tocError}` };
  const a = r.tocCount;
  const b = h.tocCount;
  if (a == null || b == null) return failBoth('目录条数缺失');
  const max = Math.max(a, b) || 1;
  const diff = Math.abs(a - b);
  const ratio = diff / max;
  const pass = ratio <= 0.05;
  return {
    status: pass ? 'PASS' : 'DIFF',
    reason: `Reader ${a} 章 vs 客厅 ${b} 章，差 ${diff}（${(ratio * 100).toFixed(1)}%，阈值 ±5%）`,
    reader: a,
    hall: b,
    diff,
    ratio,
  };
}

function checkContent(r, h) {
  if (!r.ok && !h.ok) return failBoth(`两侧正文均失败：Reader${kindOf(r)} ${r.error || r.contentError || '无'}；客厅${kindOf(h)} ${h.error || h.contentError || '无'}`);
  if (!r.ok) return { status: 'FAIL', reason: `Reader 正文失败${kindOf(r)}：${r.error || r.contentError}` };
  if (!h.ok) return { status: 'FAIL', reason: `客厅正文失败${kindOf(h)}：${h.error || h.contentError}` };
  const a = (r.contentHead || '').slice(0, 100);
  const b = (h.contentHead || '').slice(0, 100);
  if (!a || !b) return failBoth('首章正文为空');
  const sim = lcsSimilarity(a, b);
  const pass = sim >= 0.9;
  return {
    status: pass ? 'PASS' : 'DIFF',
    reason: `首章正文相似度 ${(sim * 100).toFixed(1)}%（阈值 90%）`,
    similarity: Number(sim.toFixed(4)),
    reader: a,
    hall: b,
  };
}

/* ───────────────────── Reader 接口勘查事实 ───────────────────── */

/** 2026-11-16 实测登记；未确认项明确标注，不猜参数。 */
export const READER_ENDPOINT_FACTS = Object.freeze([
  {
    path: '/api/health',
    method: 'GET',
    params: '—',
    envelope: '{ok, app}',
    confirmed: true,
    curl: 'curl -s http://127.0.0.1:1122/api/health',
    sample: '{"ok":true,"app":"reader-web"}',
  },
  {
    path: '/reader3/getBookSources',
    method: 'GET',
    params: '—',
    envelope: '{isSuccess, errorMsg, data:[]}（约 28.6MB 完整书源）',
    confirmed: true,
    curl: 'curl -s http://127.0.0.1:1122/reader3/getBookSources',
    sample: 'HTTP 200, content-type: application/json, content-length: 28594810',
  },
  {
    path: '/reader3/getBookSource',
    method: 'POST',
    params: '{bookSourceUrl}',
    envelope: '{isSuccess, errorMsg, data:书源对象}',
    confirmed: true,
    curl: "curl -s -X POST http://127.0.0.1:1122/reader3/getBookSource -H 'content-type: application/json' -d '{\"bookSourceUrl\":\"http://www.23uswx.la/\"}'",
    sample: '{"isSuccess":true,"errorMsg":"","data":{"bookSourceName":"顶点小说⑤","bookSourceUrl":"http://www.23uswx.la/",...}}',
    note: 'GET 同路径空响应；缺 bookSourceUrl 时返回 isSuccess:false + errorMsg: bad request: bookSourceUrl required',
  },
  {
    path: '/reader3/getBookshelf',
    method: 'GET',
    params: '—',
    envelope: '{isSuccess, errorMsg, data:[]}',
    confirmed: true,
    curl: 'curl -s http://127.0.0.1:1122/reader3/getBookshelf',
    sample: '{"isSuccess":true,"errorMsg":"","data":[{"name":"流浪地球","author":"刘慈欣",...}]}',
  },
  {
    path: '/reader3/getBookInfo',
    method: 'POST',
    params: '{url, bookSourceUrl}',
    envelope: '{isSuccess, errorMsg, data:书籍对象}',
    confirmed: true,
    curl: "curl -s -X POST http://127.0.0.1:1122/reader3/getBookInfo -H 'content-type: application/json' -d '{\"url\":\"http://www.23uswx.la/64_64078/\",\"bookSourceUrl\":\"http://www.23uswx.la/\"}'",
    sample: '{"isSuccess":true,"errorMsg":"","data":{"name":"流浪地球","author":"作者：\\n                     刘慈欣",...}}',
    note: 'GET 同路径返回空响应；无需 {req:{...}} 包装；author 带「作者：」前缀与换行空白，比对前已归一化',
  },
  {
    path: '/reader3/getChapterList',
    method: 'POST',
    params: '{bookUrl, bookSourceUrl, tocUrl, refresh:0}',
    envelope: '{isSuccess, errorMsg, data:[]}',
    confirmed: true,
    curl: "curl -s -X POST http://127.0.0.1:1122/reader3/getChapterList -H 'content-type: application/json' -d '{\"bookUrl\":\"http://www.23uswx.la/64_64078/\",\"bookSourceUrl\":\"http://www.23uswx.la/\",\"tocUrl\":\"http://www.23uswx.la/64_64078/\",\"refresh\":0}'",
    sample: '{"isSuccess":true,"errorMsg":"","data":[{"title":"刹车时代","url":".../25958709.html","index":0,"isVip":false,...}]}',
  },
  {
    path: '/reader3/getBookContent',
    method: 'POST',
    params: '{bookUrl, chapterUrl, bookSourceUrl, index, chapterTitle, refresh:0}',
    envelope: '{isSuccess, errorMsg, data:HTML 字符串}',
    confirmed: true,
    curl: "curl -s -X POST http://127.0.0.1:1122/reader3/getBookContent -H 'content-type: application/json' -d '{\"bookUrl\":\"http://www.23uswx.la/64_64078/\",\"chapterUrl\":\"http://www.23uswx.la/64_64078/25958709.html\",\"bookSourceUrl\":\"http://www.23uswx.la/\",\"index\":0,\"chapterTitle\":\"刹车时代\",\"refresh\":0}'",
    sample: '{"isSuccess":true,"errorMsg":"","data":"<div name=\\"content\\" id=\\"content\\">..."}',
    note: 'data 为原始 HTML，比对前已去标签并去空白',
  },
  {
    path: '/reader3/saveBook',
    method: 'POST',
    params: '写操作（未实测）',
    envelope: '—',
    confirmed: false,
    note: '只读约束下未调用，调用方式未确认',
  },
  {
    path: '/reader3/saveBookProgress',
    method: 'POST',
    params: '写操作（未实测）',
    envelope: '—',
    confirmed: false,
    note: '只读约束下未调用，调用方式未确认',
  },
]);

/* ───────────────────────── 主流程 ───────────────────────── */

export async function runDiff(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const keywords = opts.keyword ? [opts.keyword] : cfg.keywords;

  // 1) 取候选清单：优先客厅搜索真实命中的书
  const candidates = [];
  const searchNotes = [];
  for (const q of keywords) {
    const res = await hallSearchOnce(cfg.hallBase, q, cfg.hallTimeout, cfg.searchMaxWait, cfg.pollInterval);
    searchNotes.push({ keyword: q, ok: res.ok, error: res.error, errorKind: res.errorKind || '', incomplete: !!res.incomplete, rawItems: res.items.length });
    for (const c of candidatesFromGroups(res.items)) candidates.push({ ...c, keyword: q });
  }
  // 跨关键词去重：先按 bookUrl+sourceUrl，再按归一化书名（保证 10 本不同书名）
  const dedup = [];
  const seenUrl = new Set();
  const seenTitle = new Set();
  for (const c of candidates) {
    const uk = `${c.bookUrl}|${c.sourceUrl}`;
    if (seenUrl.has(uk)) continue;
    const tk = titleKey(c.name);
    if (seenTitle.has(tk)) continue;
    seenUrl.add(uk);
    seenTitle.add(tk);
    dedup.push(c);
  }
  // 搜索不足时用 Reader 书架兜底，按归一化书名去重补齐到目标本数
  let shelfFallback = false;
  if (dedup.length < cfg.books) {
    shelfFallback = true;
    const shelf = await readerShelf(cfg.readerBase, cfg.readerTimeout);
    for (const s of shelf) {
      const tk = titleKey(s.name);
      if (seenTitle.has(tk)) continue;
      seenUrl.add(`${s.bookUrl}|${s.sourceUrl}`);
      seenTitle.add(tk);
      dedup.push({ ...s, keyword: '书架兜底' });
    }
  }
  const selected = dedup.slice(0, cfg.books);

  // 2) 逐本串行对照
  const books = [];
  for (const book of selected) {
    const reader = await readerSide(cfg.readerBase, book, cfg.readerTimeout);
    const hall = await hallSide(cfg.hallBase, book, cfg.hallTimeout);
    const checks = {
      name: checkName(reader, hall),
      author: checkAuthor(reader, hall),
      toc: checkToc(reader, hall),
      content: checkContent(reader, hall),
    };
    books.push({
      keyword: book.keyword,
      name: book.name,
      author: book.author,
      sourceName: book.sourceName,
      sourceUrl: book.sourceUrl,
      bookUrl: book.bookUrl,
      sources: book.sources || [],
      reader,
      hall,
      checks,
    });
  }

  // 3) 汇总
  const n = books.length;
  const passOf = (field) => books.filter((b) => b.checks[field].status === 'PASS').length;
  const readerOk = books.filter((b) => b.reader.ok).length;
  const hallOk = books.filter((b) => b.hall.ok).length;
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, x) => a + x, 0) / arr.length) : 0);
  const avgReaderMs = avg(books.map((b) => b.reader.elapsedMs));
  const avgHallMs = avg(books.map((b) => b.hall.elapsedMs));

  const diffs = [];
  for (const b of books) {
    for (const [field, check] of Object.entries(b.checks)) {
      if (check.status !== 'PASS') {
        diffs.push({
          bookUrl: b.bookUrl,
          sourceName: b.sourceName,
          field,
          status: check.status,
          reason: check.reason,
          readerErrorKind: b.reader.errorKind || '',
          hallErrorKind: b.hall.errorKind || '',
        });
      }
    }
  }

  const distinctTitles = new Set(
    books.map((b) => titleKey(b.reader.name || b.hall.name || b.bookUrl)),
  ).size;

  const summary = {
    total: n,
    distinctTitles,
    shelfFallback,
    readerOk,
    hallOk,
    namePass: passOf('name'),
    authorPass: passOf('author'),
    tocPass: passOf('toc'),
    contentPass: passOf('content'),
    avgReaderMs,
    avgHallMs,
    diffCount: diffs.length,
    hallEngine: '客厅侧 = legado 引擎直连，非 Reader 代理',
  };

  const report = {
    generatedAt: new Date().toISOString(),
    status: 'final',
    hallEngine: '客厅侧 = legado 引擎直连，非 Reader 代理',
    params: {
      hallBase: cfg.hallBase,
      readerBase: cfg.readerBase,
      books: cfg.books,
      keywords,
      readerTimeout: cfg.readerTimeout,
      hallTimeout: cfg.hallTimeout,
    },
    searchNotes,
    summary,
    diffs,
    readerEndpointFacts: READER_ENDPOINT_FACTS,
    books,
  };

  // 4) 落盘：追加日志 + 覆盖报告
  fs.mkdirSync(path.dirname(cfg.logPath), { recursive: true });
  fs.mkdirSync(path.dirname(cfg.reportPath), { recursive: true });
  appendLog(cfg.logPath, books);
  fs.writeFileSync(cfg.reportPath, JSON.stringify(report, null, 2), 'utf8');

  return report;
}

function appendLog(logPath, books) {
  const lines = books.map((b) => {
    const c = b.checks;
    return [
      `[${new Date().toISOString()}]`,
      `source=${b.sourceName || '-'}`,
      `bookUrl=${b.bookUrl}`,
      `name=${c.name.status}`,
      `author=${c.author.status}`,
      `toc=${c.toc.status}`,
      `content=${c.content.status}`,
      `readerMs=${b.reader.elapsedMs}`,
      `hallMs=${b.hall.elapsedMs}`,
      b.reader.error ? `readerErr=${b.reader.error}` : '',
      b.hall.error ? `hallErr=${b.hall.error}` : '',
    ].filter(Boolean).join(' ');
  });
  fs.appendFileSync(logPath, lines.join('\n') + '\n', 'utf8');
}
