#!/usr/bin/env node
/**
 * 走 reader-searchd 打开书籍：详情 → 目录 → 首章正文，多候选并行、先成功先用。
 *
 * 契约与 lib/book_race.mjs 的 raceOpen 一致，方便 hub 无感切换：
 *   成功 { ok:true, sourceId, book, chapters, firstChapter, ms, tried }
 *   失败 { ok:false, error, ms, tried }
 *
 * 章节统一成 { name, url }（searchd 返回的原始字段是 title）。
 */

import { searchdHealth, searchdBase } from './book_searchd.mjs';

const STAGE_TIMEOUT_MS = 9000;

async function call(path, params, timeoutMs = STAGE_TIMEOUT_MS) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && String(v) !== '') qs.set(k, String(v));
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${searchdBase()}${path}?${qs.toString()}`, {
      signal: ac.signal,
      cache: 'no-store',
    });
    if (!res.ok) return { ok: false, error: `searchd ${path} 返回 ${res.status}` };
    const body = await res.json();
    if (!body || !body.ok) return { ok: false, error: (body && body.message) || '引擎未返回结果' };
    return { ok: true, data: body.data };
  } catch (error) {
    const msg = error && error.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (error && error.message) || String(error);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeChapters(data) {
  const list = Array.isArray(data) ? data : (data && (data.chapters || data.list)) || [];
  return list
    .filter((c) => c && c.url)
    .map((c) => ({
      name: String(c.title || c.name || ''),
      url: String(c.url),
      isVolume: !!c.isVolume,
    }));
}

async function runCandidate(candidate, deadline) {
  const startedAt = Date.now();
  const sourceId = String(candidate.bookSourceUrl || '');
  const entry = { sourceId, stage: null, error: null, ms: 0, startedAt, endedAt: null };
  const fail = (stage, error) => {
    entry.stage = stage;
    entry.error = error || '未知错误';
    entry.ms = Date.now() - startedAt;
    entry.endedAt = Date.now();
    return { ok: false, entry };
  };
  const outOfTime = () => Date.now() > deadline;

  if (outOfTime()) return fail('info', '超预算');

  const info = await call('/info', {
    url: candidate.bookUrl,
    bookSourceUrl: sourceId,
  });
  if (!info.ok) return fail('info', info.error);

  const data = info.data || {};
  const book = {
    name: String(data.name || candidate.name || ''),
    author: String(data.author || ''),
    bookUrl: String(candidate.bookUrl),
    origin: sourceId,
    originName: String(data.originName || ''),
    coverUrl: String(data.coverUrl || ''),
    intro: String(data.intro || ''),
    tocUrl: String(data.tocUrl || candidate.bookUrl),
    lastChapter: String(data.lastChapter || ''),
    sourceId,
  };

  if (outOfTime()) return fail('toc', '超预算');

  const toc = await call('/toc', {
    tocUrl: book.tocUrl,
    bookUrl: book.bookUrl,
    bookSourceUrl: sourceId,
  });
  if (!toc.ok) return fail('toc', toc.error);

  let chapters = normalizeChapters(toc.data);
  if (!chapters.length) return fail('toc', '目录为空');

  // 有些站点目录一页正好 100 章，第一页先返回、其余在引擎后台补。
  // 第一页不足 100 章时再同步要一次全量目录，避免站点按 20/50/100 章分页时被截断。
  if (chapters.length <= 100) {
    const fullToc = await call('/toc', {
      tocUrl: book.tocUrl,
      bookUrl: book.bookUrl,
      bookSourceUrl: sourceId,
      full: 'true',
    }, 30000);
    if (fullToc.ok) {
      const all = normalizeChapters(fullToc.data);
      if (all.length > chapters.length) chapters = all;
    }
  }

  // 卷标题没有正文，从第一个非卷章节开始读。
  const first = chapters.find((c) => !c.isVolume) || chapters[0];

  if (outOfTime()) return fail('content', '超预算');

  const content = await call('/content', {
    chapterUrl: first.url,
    bookUrl: book.bookUrl,
    bookSourceUrl: sourceId,
    chapterTitle: first.name,
  });
  if (!content.ok) return fail('content', content.error);

  const text = typeof content.data === 'string' ? content.data : '';
  if (!text.trim()) return fail('content', '正文为空');

  entry.stage = 'content';
  entry.endedAt = Date.now();
  entry.ms = entry.endedAt - startedAt;

  return {
    ok: true,
    sourceId,
    book,
    chapters,
    firstChapter: {
      name: first.name,
      url: first.url,
      content: text,
      length: text.length,
      ms: entry.ms,
    },
    ms: entry.ms,
    entry,
  };
}

/**
 * 单章正文（searchd 版）：引擎会自己顺着「下一页」把整章拼完。
 * @returns {Promise<{ok:boolean, content?:string, error?:string}>}
 */
export async function chapterContentViaSearchd(payload = {}) {
  const out = await call('/content', {
    chapterUrl: payload.chapterUrl,
    bookUrl: payload.bookUrl,
    bookSourceUrl: payload.bookSourceUrl || payload.bookSourceUrl === '' ? payload.bookSourceUrl : payload.bookSourceUrl,
    chapterTitle: payload.chapterTitle,
  }, 12000);
  if (!out.ok) return { ok: false, error: out.error };
  const text = typeof out.data === 'string' ? out.data : '';
  if (!text.trim()) return { ok: false, error: '正文为空' };
  return { ok: true, content: text };
}

/**
 * 多候选并行打开（searchd 版）。
 * @param {Array<{bookSourceUrl:string, bookUrl:string, name?:string}>} candidates
 * @param {{attempts?:number, budgetMs?:number}} options
 */
export async function raceOpenViaSearchd(candidates, options = {}) {
  const t0 = Date.now();
  const list = Array.isArray(candidates) ? candidates.filter((c) => c && c.bookUrl && c.bookSourceUrl) : [];
  if (!list.length) return { ok: false, error: '无候选书源', tried: [], ms: 0 };

  // 同样不做健康门禁：健康接口忙时慢，真连不上时这里的请求会快速失败。

  const attempts = Math.max(1, Math.min(Number(options.attempts) || 3, list.length));
  const budgetMs = Number(options.budgetMs) || 15000;
  const deadline = t0 + budgetMs;
  const tried = [];

  return new Promise((resolve) => {
    let settled = false;
    let finished = 0;
    let best = null;
    let budgetTimer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (budgetTimer) clearTimeout(budgetTimer);
      resolve({ ...result, tried, ms: Date.now() - t0 });
    };

    // 多候选时不再「谁先回谁赢」：先记住章数最多的，等其余候选或预算结束再定。
    // 目录达到 300 章基本可判定为完整源，立即采用，避免正常书也被拖慢。
    const consider = (res) => {
      if (!res || !res.ok) return;
      const count = Array.isArray(res.chapters) ? res.chapters.length : 0;
      if (!best || count > best.chapters.length) best = res;
      if (best.chapters.length > 200) finish(best);
    };

    budgetTimer = setTimeout(() => {
      finish(best || { ok: false, error: '超预算', tried });
    }, budgetMs);
    budgetTimer.unref?.();

    for (const candidate of list.slice(0, attempts)) {
      runCandidate(candidate, deadline)
        .then((res) => {
          tried.push(res.entry || { sourceId: candidate.bookSourceUrl, ok: false });
          finished += 1;
          consider(res);
          if (res.ok && best && best.chapters.length > 200) return;
          if (finished >= attempts) {
            if (best) finish(best);
            else {
              const firstError = tried.find((t) => t && t.error);
              finish({ ok: false, error: (firstError && firstError.error) || '全部候选失败', tried });
            }
          }
        })
        .catch((error) => {
          finished += 1;
          tried.push({ sourceId: candidate.bookSourceUrl, stage: 'unknown', error: error && error.message });
          if (finished >= attempts) {
            if (best) finish(best);
            else finish({ ok: false, error: '全部候选失败', tried });
          }
        });
    }
  });
}
