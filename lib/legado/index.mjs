#!/usr/bin/env node
/**
 * Legado（阅读 3.0）规则引擎统一内核：书房搜书 / 详情 / 目录 / 正文。
 *
 * 对外契约（签名勿改）：
 *  loadSources(opts)
 *  searchSource(source, key, opts)
 *  bookInfo(source, book, opts)
 *  chapterList(source, book, opts)
 *  chapterContent(source, book, chapter, opts)
 *  matchBookUrl(source, url)
 *
 * 所有函数永不抛异常：失败返回 {ok:false,error:'中文原因'}，ms 为耗时毫秒。
 */

import { fetchText, parseHeader } from './fetch.mjs';
import { renderUrl, render } from './template.mjs';
import { loadSources as sourceLoadSources, matchBookUrl, baseOf } from './sources.mjs';
import { createRuntime } from './jsrt.mjs';
import { loadDoc, isJsonPath, jsonPath } from './selector.mjs';
import { evaluate, queryNodes, resolveUrl, collapse, cleanAuthor } from './values.mjs';

/* ───────────────────────── 内部工具 ───────────────────────── */

function startMs() {
  return Date.now();
}

/** 统一兜底出口。 */
function fail(error, ms) {
  return { ok: false, error: String(error || '未知错误'), ms };
}

/** 组装求值上下文。 */
function makeCtx(source, book, chapter, extra = {}) {
  const ctx = {
    $: extra.$ || null,
    rootNodes: extra.rootNodes || [],
    text: extra.text || '',
    json: extra.json ?? null,
    baseUrl: extra.baseUrl || baseOf(source?.url || ''),
    source,
    book: book || {},
    chapter: chapter || {},
    key: extra.key || '',
    page: extra.page || 1,
    cookie: typeof source?.cookie === 'string' && source.cookie ? parseCookieString(source.cookie) : {},
    result: extra.result != null ? extra.result : '',
    rt: null,
  };
  const selectorEval = (rule, nodes) => evaluate(rule, { ...ctx, rootNodes: nodes || [] });
  ctx.rt = createRuntime(ctx, selectorEval);
  return ctx;
}

function parseCookieString(str) {
  const out = {};
  for (const pair of String(str || '').split(/;\s*/)) {
    const m = pair.match(/^([^=]+)=(.*)$/);
    if (m) out[m[1].trim()] = m[2];
  }
  return out;
}

/** 按书源配置发起请求，返回 {url,status,text,json,$}。 */
async function request(source, url, opts = {}) {
  const headers = { ...parseHeader(source?.header, source?.cookie), ...(opts.headers || {}) };
  const res = await fetchText(url, {
    headers,
    charset: source?.charset,
    timeoutMs: opts.timeoutMs || 8000,
    method: opts.method,
    body: opts.body,
  });
  let json = null;
  const trimmed = (res.text || '').trim();
  if (/^[{[]/.test(trimmed)) {
    try {
      json = JSON.parse(res.text);
    } catch {
      json = null;
    }
  }
  const $ = json == null ? loadDoc(res.text) : null;
  return { url: res.url, status: res.status, text: res.text, json, $ };
}

/** 判断响应是否 JSON。 */
function looksJson(payload) {
  return payload.json !== null && payload.json !== undefined;
}

/** 解码 data:;base64,<id> 描述符为裸 ID；非 data: 原样返回。 */
function decodeDataUrl(u) {
  const raw = String(u || '');
  const m = /^data:;base64,([^,]+)/.exec(raw);
  if (!m) return raw;
  try {
    return Buffer.from(m[1], 'base64').toString('utf-8');
  } catch {
    return raw;
  }
}

/** 是否为 legado 请求描述符：`url,{method,body,headers}`。 */
function isRequestDescriptor(url) {
  return /^https?:\/\/[^,]+,\s*\{/.test(String(url || ''));
}

/** 解析请求描述符；纯 URL 时返回默认 GET。 */
function parseDescriptor(url) {
  const fallback = { url: String(url || ''), method: 'GET', body: null, headers: {} };
  if (!isRequestDescriptor(url)) return fallback;
  const raw = String(url);
  const comma = raw.indexOf(',{');
  const target = raw.slice(0, comma);
  try {
    const extra = JSON.parse(raw.slice(comma + 1));
    return {
      url: target,
      method: (extra.method || 'GET').toUpperCase(),
      body: extra.body != null ? (typeof extra.body === 'string' ? extra.body : JSON.stringify(extra.body)) : null,
      headers: extra.headers || {},
    };
  } catch {
    return { ...fallback, url: target };
  }
}

/** 渲染可能是 @js 的搜索 URL。 */
function buildSourceUrl(rule, ctx) {
  const ruleStr = String(rule || '').trim();
  if (!ruleStr) return '';
  if (ruleStr.startsWith('@js:')) {
    const out = ctx.rt.run(ruleStr.slice(4), '');
    return String(out || '').trim();
  }
  return renderUrl(ruleStr, { key: ctx.key, page: ctx.page, book: ctx.book, source: ctx.source });
}

/* ───────────────────────── 对外接口 ───────────────────────── */

/**
 * 装载归一化书源。
 * @param {{file?:string, refresh?:boolean}} opts
 * @returns {Promise<Array>}
 */
let cachedSources = null;

async function coreLoadSources(opts = {}) {
  const ms = startMs();
  try {
    if (!cachedSources || opts.refresh) {
      cachedSources = await sourceLoadSources(opts);
    }
    return cachedSources;
  } catch (error) {
    fail(`装载书源失败：${error.message || error}`, startMs() - ms);
    return [];
  }
}

/**
 * 单源搜索。
 * @param {object} source 归一化书源
 * @param {string} key 关键词
 * @param {{page?:number, timeoutMs?:number}} opts
 * @returns {Promise<{ok:boolean,books:Array,error?:string,ms:number}>}
 */
async function coreSearchSource(source, key, opts = {}) {
  const ms = startMs();
  if (!source) return fail('书源为空', ms);
  if (source.enabled === false) return fail('书源未启用，已跳过', ms);
  if (!key) return fail('搜索关键词为空', ms);

  try {
    const page = opts.page || 1;
    const ctx = makeCtx(source, {}, {}, { key, page });

    // searchUrl 可为普通模板，也可为 @js / <js> 脚本（返回 URL 或请求对象）
    const su = String(source.searchUrl || '');
    let rawSearchUrl = '';
    if (/^\s*@js:/.test(su) || /^\s*<js>/.test(su)) {
      const code = su.replace(/^\s*@js:/, '').replace(/^\s*<js>/i, '').replace(/<\/js>\s*$/i, '');
      const jsOut = ctx.rt.run(code, key);
      rawSearchUrl = jsOut && typeof jsOut === 'object' ? jsOut.url || '' : String(jsOut ?? '');
    } else {
      rawSearchUrl = buildSourceUrl(source.searchUrl, ctx);
    }
    if (!rawSearchUrl) return fail('搜索地址为空', ms);
    const searchUrl = resolveUrl(rawSearchUrl, baseOf(source.url));

    const payload = await request(source, searchUrl, { timeoutMs: opts.timeoutMs || 8000 });
    const baseUrl = baseOf(payload.url || source.url);

    const listRule = source.rules.search.bookList;
    if (!listRule) return fail('书源缺少书单规则', ms);

    let books = [];
    if (looksJson(payload) && isJsonPath(listRule)) {
      const items = queryNodes({ json: payload.json, rootNodes: [] }, listRule);
      for (const item of items.slice(0, 30)) {
        const itemCtx = makeCtx(source, {}, {}, { json: item, result: '' });
        const book = extractBookItem(itemCtx, baseUrl);
        if (book) books.push(book);
      }
    } else {
      if (!payload.$) return fail('响应不是可解析的 HTML', ms);
      const rootNodes = [payload.$('html').get(0) || payload.$.root().get(0)];
      const nodes = queryNodes({ rootNodes, $: payload.$ }, listRule);
      for (const node of nodes.slice(0, 30)) {
        const itemCtx = makeCtx(source, {}, {}, { rootNodes: [node], $: payload.$, result: '' });
        const book = extractBookItem(itemCtx, baseUrl);
        if (book) books.push(book);
      }
    }

    return { ok: true, books, ms: startMs() - ms };
  } catch (error) {
    return fail(error.message || String(error), startMs() - ms);
  }
}

/** 从单条结果节点 / 对象抽取书籍字段。 */
function extractBookItem(ctx, baseUrl) {
  const r = ctx.source.rules.search;
  const name = collapse(evaluate(r.name, ctx));
  const author = cleanAuthor(evaluate(r.author, ctx), name);
  let bookUrl = evaluate(r.bookUrl, ctx);
  bookUrl = resolveUrl(bookUrl, baseUrl || baseOf(ctx.source.url));
  if (!name || !bookUrl) return null;
  return {
    name,
    author,
    bookUrl,
    coverUrl: resolveUrl(evaluate(r.coverUrl, ctx), baseUrl || baseOf(ctx.source.url)),
    intro: collapse(evaluate(r.intro, ctx)).slice(0, 240),
    kind: collapse(evaluate(r.kind, ctx)),
    lastChapter: collapse(evaluate(r.lastChapter, ctx)),
    wordCount: collapse(evaluate(r.wordCount, ctx)),
    sourceId: ctx.source.url,
    sourceName: ctx.source.name,
  };
}

/**
 * 书籍详情。
 * @param {object} source
 * @param {{bookUrl:string,tocUrl?:string}} book
 * @param {{timeoutMs?:number}} opts
 */
async function coreBookInfo(source, book, opts = {}) {
  const ms = startMs();
  if (!source) return fail('书源为空', ms);
  if (!book || !book.bookUrl) return fail('书籍地址为空', ms);

  try {
    const isDataDescriptor = /^data:/.test(String(book.bookUrl || ''));
    let payload = { json: null, $: null, text: '', url: book.bookUrl };
    let baseUrl = baseOf(book.bookUrl);
    if (!isDataDescriptor) {
      payload = await request(source, book.bookUrl, { timeoutMs: opts.timeoutMs || 8000 });
      baseUrl = baseOf(payload.url || book.bookUrl);
    }
    let docCtx = makeCtx(source, book, {}, {
      json: payload.json,
      $: payload.$,
      rootNodes: payload.$ ? [payload.$('html').get(0)] : [],
      result: decodeDataUrl(book.bookUrl || ''),
    });

    // init 规则：可拉取另一页面，或脚本/JSONPath 直接产出新结果（对象/JSON 串）
    const initRule = source.rules.bookInfo.init;
    if (initRule && initRule.trim()) {
      // JSONPath init 直接抽出对象作为后续字段数据源
      let initObj = null;
      if (isJsonPath(initRule) && payload.json) {
        const hits = jsonPath(payload.json, initRule);
        initObj = hits.find((x) => x && typeof x === 'object') || null;
      }

      const initOut = evaluate(initRule, docCtx);
      const initUrl = resolveUrl(initOut, baseUrl);
      if (initObj) {
        docCtx = makeCtx(source, book, {}, { json: initObj, $: null, rootNodes: [], result: initOut });
      } else if (initUrl && /^https?:/i.test(initUrl)) {
        payload = await request(source, initUrl, { timeoutMs: opts.timeoutMs || 8000 });
        baseUrl = baseOf(payload.url || initUrl);
        docCtx = makeCtx(source, book, {}, {
          json: payload.json,
          $: payload.$,
          rootNodes: payload.$ ? [payload.$('html').get(0)] : [],
          result: initOut,
        });
      } else if (initOut) {
        // 脚本产出对象/JSON 串，作为后续字段的 JSONPath 数据源
        let json = null;
        try {
          json = JSON.parse(initOut);
        } catch {
          json = null;
        }
        docCtx = makeCtx(source, book, {}, { json, $: null, rootNodes: [], result: initOut });
      }
    }

    const r = source.rules.bookInfo;
    const tocUrlRaw = evaluate(r.tocUrl, docCtx);
    const tocUrl = resolveUrl(tocUrlRaw, baseUrl) || book.bookUrl;

    const infoName = collapse(evaluate(r.name, docCtx)) || book.name || '';
    const infoAuthor = cleanAuthor(evaluate(r.author, docCtx), infoName) || book.author || '';
    const info = {
      ok: true,
      name: infoName,
      author: infoAuthor,
      coverUrl: resolveUrl(evaluate(r.coverUrl, docCtx), baseUrl),
      intro: collapse(evaluate(r.intro, docCtx)),
      lastChapter: collapse(evaluate(r.lastChapter, docCtx)),
      tocUrl,
      ms: startMs() - ms,
    };
    if (!info.name) {
      return { ...fail('详情页未解析到书名', ms), ...info, ok: false };
    }
    return info;
  } catch (error) {
    return fail(error.message || String(error), startMs() - ms);
  }
}

/**
 * 目录列表（含 nextTocUrl 分页合并、按 URL 去重）。
 */
async function coreChapterList(source, book, opts = {}) {
  const ms = startMs();
  if (!source) return fail('书源为空', ms);
  if (!book) return fail('书籍信息为空', ms);
  const tocUrl = book.tocUrl || book.bookUrl;
  if (!tocUrl) return fail('目录地址为空', ms);

  try {
    const chapters = new Map();
    let currentUrl = tocUrl;
    let baseUrl = baseOf(tocUrl);
    const tocRule = source.rules.toc;

    for (let pageNo = 0; pageNo < 10 && currentUrl; pageNo++) {
      const isDataDesc = /^data:/.test(currentUrl);
      const payload = isDataDesc
        ? { json: null, $: null, text: '', url: currentUrl }
        : await request(source, currentUrl, { timeoutMs: opts.timeoutMs || 10000 });
      baseUrl = isDataDesc ? baseUrl : baseOf(payload.url || currentUrl);
      const rootNodes = payload.$ ? [payload.$('html').get(0)] : [];
      const ctx = makeCtx(source, book, {}, {
        json: payload.json,
        $: payload.$,
        rootNodes,
        page: pageNo + 1,
        result: decodeDataUrl(currentUrl),
      });

      // @js 书单：脚本直接返回章节对象数组
      let jsItems = null;
      if (/^\s*@js:/.test(tocRule.chapterList) || /^\s*<js>/.test(tocRule.chapterList)) {
        const code = tocRule.chapterList.replace(/^\s*@js:/, '').replace(/^\s*<js>/i, '').replace(/<\/js>\s*$/i, '');
        const raw = ctx.rt.run(code, decodeDataUrl(currentUrl));
        if (Array.isArray(raw)) jsItems = raw;
        else if (typeof raw === 'string' && raw.trim()) {
          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) jsItems = parsed;
          } catch {
            jsItems = null;
          }
        }
      }

      let nodes;
      if (jsItems != null) {
        nodes = jsItems;
      } else if (looksJson(payload) && isJsonPath(tocRule.chapterList)) {
        nodes = queryNodes({ json: payload.json, rootNodes: [] }, tocRule.chapterList);
      } else {
        nodes = queryNodes(ctx, tocRule.chapterList);
      }

      for (const node of nodes) {
        const isTagNode = node && typeof node === 'object' && node.type === 'tag';
        const itemCtx = makeCtx(source, book, {}, {
          json: !isTagNode && node && typeof node === 'object' ? node : (looksJson(payload) ? node : null),
          $: payload.$,
          rootNodes: payload.$ && isTagNode ? [node] : [],
          baseUrl,
          result: '',
        });
        const name = collapse(evaluate(tocRule.chapterName, itemCtx));
        let url = evaluate(tocRule.chapterUrl, itemCtx);
        // 描述符形式 `url,{method,body,headers}` 保留原样，正文阶段再解析为 POST
        url = isRequestDescriptor(url) ? url : resolveUrl(url, baseUrl);
        if (!name || !url) continue;
        if (!chapters.has(url)) chapters.set(url, { name, url });
      }

      // 分页目录
      let nextUrl = '';
      if (tocRule.nextTocUrl) {
        const rawNext = evaluate(tocRule.nextTocUrl, ctx);
        nextUrl = resolveUrl(buildSourceUrl(rawNext, ctx), baseUrl);
      }
      currentUrl = nextUrl && nextUrl !== currentUrl ? nextUrl : '';
    }

    return { ok: true, chapters: [...chapters.values()], ms: startMs() - ms };
  } catch (error) {
    return fail(error.message || String(error), startMs() - ms);
  }
}

/**
 * 章节正文。
 */
async function coreChapterContent(source, book, chapter, opts = {}) {
  const ms = startMs();
  if (!source) return fail('书源为空', ms);
  if (!chapter || !chapter.url) return fail('章节地址为空', ms);

  try {
    const descriptor = parseDescriptor(chapter.url);
    const isDataDesc = /^data:/.test(chapter.url);
    const payload = isDataDesc
      ? { json: null, $: null, text: '', url: chapter.url }
      : await request(source, descriptor.url, {
          timeoutMs: opts.timeoutMs || 8000,
          method: descriptor.method,
          body: descriptor.body,
          headers: descriptor.headers,
        });
    const baseUrl = baseOf(payload.url || chapter.url);
    const ctx = makeCtx(source, book, chapter, {
      json: payload.json,
      $: payload.$,
      rootNodes: payload.$ ? [payload.$('html').get(0)] : [],
      result: decodeDataUrl(chapter.url),
    });

    const r = source.rules.content;
    let content = evaluate(r.content, ctx);

    // sourceRegex：切片提取（取首个捕获组，无组取整段）
    if (r.sourceRegex && r.sourceRegex.trim()) {
      try {
        const m = content.match(new RegExp(r.sourceRegex));
        if (m) content = m[1] != null ? m[1] : m[0];
      } catch {
        // 规则非法则保留原文
      }
    }

    // replaceRegex：多行多条 `正则##替换`
    if (r.replaceRegex && r.replaceRegex.trim()) {
      for (const line of r.replaceRegex.split(/\n/)) {
        const parts = line.split('##');
        if (parts.length >= 2 && parts[0]) {
          try {
            content = content.replace(new RegExp(parts[0], 'g'), parts[1]);
          } catch {
            // 忽略非法正则
          }
        }
      }
    }

    content = cleanContent(content);
    if (!content) return fail('正文为空', ms);
    return { ok: true, content, ms: startMs() - ms };
  } catch (error) {
    return fail(error.message || String(error), startMs() - ms);
  }
}

/** 正文清洗：换行、实体、空行收敛。 */
function cleanContent(text) {
  let t = String(text == null ? '' : text);
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<\/p\s*>/gi, '\n');
  t = t.replace(/&nbsp;/g, ' ');
  t = t.replace(/&amp;/g, '&');
  t = t.replace(/&lt;/g, '<');
  t = t.replace(/&gt;/g, '>');
  // 残留标签剥除（保留纯文本）
  t = t.replace(/<[^>]+>/g, '');
  t = t.replace(/[ \t　]+/g, ' ');
  t = t.split('\n').map((l) => l.trim()).filter((l) => l).join('\n');
  return t.trim();
}

/** 按 bookUrlPattern 校验（纯函数，主线程直接执行，不阻塞）。 */
export { matchBookUrl };

/* ───────────────────────── Worker 池委托 ───────────────────────── */

import { runInPool, ensurePool } from './pool.mjs';

/** 实现层（worker 内调用），不对外暴露。 */
const __core = {
  loadSources: coreLoadSources,
  searchSource: coreSearchSource,
  bookInfo: coreBookInfo,
  chapterList: coreChapterList,
  chapterContent: coreChapterContent,
};
export { __core };

/** 对外异步契约：全部经 worker 池执行，主线程不做规则解析与同步子进程。 */
export function loadSources(opts) {
  return runInPool('loadSources', [opts]);
}

export function searchSource(source, key, opts) {
  return runInPool('searchSource', [source, key, opts]);
}

export function bookInfo(source, book, opts) {
  return runInPool('bookInfo', [source, book, opts]);
}

export function chapterList(source, book, opts) {
  return runInPool('chapterList', [source, book, opts]);
}

export function chapterContent(source, book, chapter, opts) {
  return runInPool('chapterContent', [source, book, chapter, opts]);
}

/**
 * 惰性预热：供集成方在服务 listen 之后调用；异步、可超时、失败不抛异常。
 * import 阶段不建池、不读 27MB 缓存，避免阻塞宿主启动。
 */
export async function warmup(opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) || 5000;
  try {
    ensurePool();
    await Promise.race([
      runInPool('loadSources', []),
      new Promise((_, reject) => setTimeout(() => reject(new Error('预热超时')), timeoutMs)),
    ]);
  } catch {
    // 预热失败不阻断业务；首个真实任务仍会惰性建池
  }
}
