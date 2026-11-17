#!/usr/bin/env node
/**
 * 多候选并行 race 与会话复用模块（纯 Node，无新依赖）。
 *
 * 职责：
 *  - raceOpen：前 attempts 个候选并行跑「详情 → 目录 → 首章正文」，先成功先用，
 *    迟到结果用标志位丢弃；全部失败 / 超预算返回结构化失败结果。
 *  - sessionStore：按 sourceId 进程内复用 cookie / 自定义 header，Map + 200 条 LRU。
 *  - 模块内全局并发槽：同时最多 6 个在跑引擎任务，超出排队。
 *
 * 引擎契约（冻结，来自 lib/legado/index.mjs）：
 *  bookInfo(source, book, {timeoutMs})
 *  chapterList(source, book, {timeoutMs})
 *  chapterContent(source, book, chapter, {timeoutMs})
 *  全异步；正常返回 {ok, ..., ms}；异常路径（worker 退出 / 超时 / 队列满）会 reject，
 *  本模块统一 catch 成 {ok:false, error}。
 *
 * 本模块任何对外函数都不抛异常：错误一律折叠进返回对象。
 */

import {
  bookInfo as engineBookInfo,
  chapterList as engineChapterList,
  chapterContent as engineChapterContent,
} from './legado/index.mjs';

/* ───────────────────────── 全局并发槽（模块内计数） ───────────────────────── */

const MAX_INFLIGHT = 6;
let inflight = 0;
const slotWaiters = [];

/** 占用一个引擎任务槽；槽满则排队等待，O(队列长度) 唤醒调度。 */
async function acquireSlot() {
  if (inflight < MAX_INFLIGHT) {
    inflight += 1;
    return;
  }
  await new Promise((resolve) => slotWaiters.push(resolve));
  inflight += 1;
}

/** 释放槽位，并唤醒一个排队任务。 */
function releaseSlot() {
  inflight -= 1;
  const next = slotWaiters.shift();
  if (next) next();
}

/** 自检 / 监控用：当前在跑与排队数。 */
export function raceStats() {
  return { inflight, maxInflight: MAX_INFLIGHT, queued: slotWaiters.length, sessions: sessionSize() };
}

/* ───────────────────────── 会话 LRU 存储（O(1) 读写） ───────────────────────── */

const SESSION_LIMIT = 200;
const sessionMap = new Map();

/** 规整外部写入的会话结构；空会话返回 null。 */
function normalizeSession(input) {
  if (!input || typeof input !== 'object') return null;
  const cookie = typeof input.cookie === 'string' && input.cookie.trim() ? input.cookie : '';
  const rawHeaders = input.headers;
  const headers = rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)
    ? Object.fromEntries(Object.entries(rawHeaders).filter(([, v]) => v != null))
    : {};
  if (!cookie && !Object.keys(headers).length) return null;
  return { cookie, headers, at: Date.now() };
}

function sessionSize() {
  return sessionMap.size;
}

/**
 * 按 sourceId 复用 cookie / header 的进程内 LRU 存储。
 * - getSession：命中即移到尾部（最近使用）；未命中返回 null。
 * - setSession：写入并移到尾部；超上限淘汰最旧（头部）。
 * - prune：主动裁剪到上限，返回淘汰条数。
 */
export const sessionStore = {
  getSession(sourceId) {
    const key = String(sourceId || '');
    if (!key) return null;
    const hit = sessionMap.get(key);
    if (!hit) return null;
    sessionMap.delete(key);
    sessionMap.set(key, hit);
    return { cookie: hit.cookie, headers: { ...hit.headers } };
  },

  setSession(sourceId, sess) {
    const key = String(sourceId || '');
    if (!key) return false;
    const normalized = normalizeSession(sess);
    if (!normalized) return false;
    sessionMap.delete(key);
    sessionMap.set(key, normalized);
    pruneSessions(SESSION_LIMIT);
    return true;
  },

  prune(limit = SESSION_LIMIT) {
    return pruneSessions(limit);
  },
};

function pruneSessions(limit) {
  let evicted = 0;
  while (sessionMap.size > limit) {
    const oldest = sessionMap.keys().next().value;
    sessionMap.delete(oldest);
    evicted += 1;
  }
  return evicted;
}

/* ───────────────────────── 引擎调用包装（槽位 + 不抛异常） ───────────────────────── */

/**
 * 构造透传给引擎的 opts：
 *  - timeoutMs 按阶段给；
 *  - 会话 headers 经 opts.headers 透传（引擎 request 已合并 opts.headers，支持）；
 *  - 会话 cookie 经 Cookie 请求头通道带上（不改引擎源码）；
 *  - 同时挂 opts.session 供未来引擎原生识别；当前内核忽略它，只存不用。
 */
function buildEngineOpts(session, timeoutMs) {
  const opts = { timeoutMs };
  if (session) {
    if (session.headers && Object.keys(session.headers).length) {
      opts.headers = { ...session.headers };
    }
    if (session.cookie) {
      opts.headers = { ...(opts.headers || {}), Cookie: session.cookie };
    }
    opts.session = { cookie: session.cookie, headers: { ...(session.headers || {}) } };
  }
  return opts;
}

/**
 * 占槽执行一次引擎调用；任何 reject / 坏结果都折叠成 {ok:false, error, ms}。
 * @returns {Promise<{ok:boolean,error?:string,ms:number,...}>}
 */
async function callEngine(stage, source, book, chapter, session, timeoutMs) {
  const t0 = Date.now();
  await acquireSlot();
  let res;
  try {
    const opts = buildEngineOpts(session, timeoutMs);
    if (stage === 'bookInfo') res = await engineBookInfo(source, book, opts);
    else if (stage === 'chapterList') res = await engineChapterList(source, book, opts);
    else res = await engineChapterContent(source, book, chapter, opts);
  } catch (error) {
    return { ok: false, error: error?.message || String(error), ms: Date.now() - t0 };
  } finally {
    releaseSlot();
  }
  if (!res || typeof res !== 'object') return { ok: false, error: '引擎返回异常', ms: Date.now() - t0 };
  if (typeof res.ms !== 'number') res.ms = Date.now() - t0;
  return res;
}

/* ───────────────────────── 单候选三段流水线 ───────────────────────── */

/**
 * 跑一个候选：bookInfo → chapterList → chapterContent(首章)。
 * @returns 成功 {ok:true,...}；失败 {ok:false, entry:{sourceId,stage,error,ms,startedAt,endedAt}}
 */
async function runCandidate(candidate, ctx) {
  const startedAt = Date.now();
  const sourceId = String(candidate.sourceId || candidate.source?.url || '');
  const source = candidate.source;
  const bookUrl = String(candidate.bookUrl || '');
  const session = sessionStore.getSession(sourceId);

  const entry = {
    sourceId,
    stage: null,
    error: null,
    ms: 0,
    startedAt,
    endedAt: null,
  };
  // 独立于胜者丢弃逻辑的生命周期记录：用于并行时间戳取证（含被放弃的候选）。
  const rec = { sourceId, startedAt, endedAt: null, stage: null, ok: null };
  ctx.timeline.push(rec);

  const finishRec = (stage, ok, error) => {
    rec.endedAt = Date.now();
    rec.stage = stage;
    rec.ok = ok;
    rec.error = error || null;
  };

  const fail = (stage, stageRes) => {
    entry.stage = stage;
    entry.error = stageRes?.error || '未知错误';
    entry.ms = Date.now() - startedAt;
    entry.endedAt = Date.now();
    finishRec(stage, false, entry.error);
    return { ok: false, entry };
  };

  // 预算已耗尽则不再占用引擎槽。
  if (ctx.budgetReached()) return fail('bookInfo', { error: '超预算' });

  const seedBook = { bookUrl, name: candidate.name || '', author: candidate.author || '' };

  const info = await callEngine('bookInfo', source, seedBook, null, session, ctx.timeoutMs);
  if (!info.ok) return fail('bookInfo', info);

  const book = {
    ...seedBook,
    name: info.name || seedBook.name,
    author: info.author || seedBook.author,
    coverUrl: info.coverUrl || '',
    intro: info.intro || '',
    tocUrl: info.tocUrl || bookUrl,
    lastChapter: info.lastChapter || '',
    sourceId,
    sourceName: source?.name || '',
  };

  if (ctx.budgetReached()) return fail('chapterList', { error: '超预算' });

  const toc = await callEngine('chapterList', source, book, null, session, ctx.timeoutMs);
  if (!toc.ok) return fail('chapterList', toc);
  if (!Array.isArray(toc.chapters) || !toc.chapters.length) {
    return fail('chapterList', { error: '目录为空', ms: toc.ms });
  }
  const chapters = toc.chapters;
  const first = chapters[0];

  if (ctx.budgetReached()) return fail('chapterContent', { error: '超预算' });

  const content = await callEngine('chapterContent', source, book, first, session, ctx.timeoutMs);
  if (!content.ok) return fail('chapterContent', content);

  entry.stage = 'chapterContent';
  entry.endedAt = Date.now();
  entry.ms = entry.endedAt - startedAt;
  finishRec('chapterContent', true);

  return {
    ok: true,
    sourceId,
    book,
    chapters,
    firstChapter: {
      name: first.name,
      url: first.url,
      content: content.content,
      length: String(content.content || '').length,
      ms: content.ms,
    },
    ms: entry.ms,
    entry,
  };
}

/* ───────────────────────── 对外：并行 race 打开 ───────────────────────── */

/**
 * 多候选并行打开：取前 attempts 个候选同时跑三段流水线，先成功先用。
 *
 * @param {Array<{sourceId:string, source:object, bookUrl:string, name?:string, author?:string}>} candidates
 * @param {{attempts?:number, budgetMs?:number, timeoutMs?:number}} options
 *   attempts  并行候选数，默认 3；
 *   budgetMs  整体预算，默认 12000ms；超预算直接 ok:false；
 *   timeoutMs 单阶段引擎超时，默认 8000ms。
 * @returns {Promise<{ok:true,sourceId,book,chapters,firstChapter,ms,tried:Array}>
 *          | {ok:false,error:string,ms:number,tried:Array<{sourceId,stage,error,ms,startedAt,endedAt}>}>}
 */
export async function raceOpen(candidates, options = {}) {
  const t0 = Date.now();
  try {
    const list = Array.isArray(candidates) ? candidates : [];
    const attempts = Math.max(1, Math.min(
      Number(options.attempts) > 0 ? Number(options.attempts) : 3,
      list.length,
    ));
    const budgetMs = Number(options.budgetMs) > 0 ? Number(options.budgetMs) : 12000;
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 8000;

    if (!list.length) {
      return { ok: false, error: '无候选书源', tried: [], timeline: [], ms: Date.now() - t0 };
    }

    const timeline = [];
    const ctx = {
      timeoutMs,
      budgetReached: () => Date.now() - t0 >= budgetMs,
      timeline,
    };

    const slice = list.slice(0, attempts);
    let done = false;                 // 已有胜者：迟到结果一律丢弃
    let winner = null;
    let settledCount = 0;
    const tried = [];

    let resolveFirst;
    const firstSettle = new Promise((resolve) => { resolveFirst = resolve; });

    let budgetTimer = null;
    const budgetPromise = new Promise((resolve) => {
      budgetTimer = setTimeout(() => resolve({ budget: true }), budgetMs);
      // unref：预算定时器不阻止进程退出；race 返回后显式 clearTimeout 释放。
      budgetTimer.unref?.();
    });

    const pending = slice.map((candidate) => (async () => {
      let res;
      try {
        res = await runCandidate(candidate, ctx);
      } catch (error) {
        res = {
          ok: false,
          entry: {
            sourceId: String(candidate.sourceId || candidate.source?.url || ''),
            stage: 'unknown',
            error: error?.message || String(error),
            ms: Date.now() - t0,
            startedAt: Date.now(),
            endedAt: Date.now(),
          },
        };
      }

      if (done) return; // 已有胜者，结果丢弃，不再参与统计

      if (res.ok) {
        done = true;
        winner = res;
        tried.push(res.entry);
        resolveFirst({ winner: true });
        return;
      }
      tried.push(res.entry);
      settledCount += 1;
      if (settledCount === slice.length) resolveFirst({ allFailed: true });
    })());

    const outcome = await Promise.race([firstSettle, budgetPromise]);
    if (budgetTimer) clearTimeout(budgetTimer);

    if (winner) {
      return {
        ok: true,
        sourceId: winner.sourceId,
        book: winner.book,
        chapters: winner.chapters,
        firstChapter: winner.firstChapter,
        ms: Date.now() - t0,
        tried,
        timeline,
      };
    }

    if (outcome && outcome.budget) {
      return { ok: false, error: '超预算', tried, timeline, ms: Date.now() - t0 };
    }

    const firstError = tried.find((x) => x.error)?.error;
    return {
      ok: false,
      error: firstError || '全部候选打开失败',
      tried,
      timeline,
      ms: Date.now() - t0,
    };
  } catch (error) {
    return { ok: false, error: error?.message || String(error), tried: [], timeline: [], ms: Date.now() - t0 };
  }
}

export default { raceOpen, sessionStore, raceStats };
