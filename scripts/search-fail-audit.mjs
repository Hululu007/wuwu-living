#!/usr/bin/env node
/**
 * 书房搜书失败率审计脚本（只读 8890 线上实例；本地 legado 引擎逐源直测）。
 *
 * 产出：
 *  - runtime/search-fail-audit.json：每失败源 source/host/stage/reason/error/ms + 复测 + 汇总
 *  - 死源经 lib/book_sched.mjs 的 recordOutcome 写入健康缓存（不另写存储）
 *
 * 口径：
 *  - 分母「已尝试源数」= 本地实际调用过引擎的源（busy/队列满单列，不计入）；
 *    「全量可搜源数」= 启用且带搜索规则的源总数，两个口径都报。
 *  - Reader 真值：1122 无 HTTP 搜书路由（search_book_multi_sse 仅 Tauri IPC），
 *    DB/缓存无搜书结果留存；本脚本退化为「逐源直测复测基准」，报告中明确标注。
 *
 * 用法：
 *   node scripts/search-fail-audit.mjs [--keywords=流浪地球,诡秘之主] [--max=N]
 *     [--no-online] [--no-dead-write] [--timeout=10000] [--concurrency=8]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { searchSource } from '../lib/legado/index.mjs';
import {
  classifyLeaf,
  markDeadSources,
  applyDeadMarker,
  summarize,
  hostOf,
  sliceErr,
  bookIdentity,
  DEAD_THRESHOLD,
} from '../lib/source_triage.mjs';
import { recordOutcome } from '../lib/book_sched.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FULL_CACHE = path.join(ROOT, 'runtime', 'book-sources-full.json');
const OUT_PATH = path.join(ROOT, 'runtime', 'search-fail-audit.json');

/* ───────────────────────── 参数解析 ───────────────────────── */

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
const flags = Object.fromEntries(
  ['no-online', 'no-dead-write', 'no-retest'].map((f) => [f, process.argv.includes(`--${f}`)])
);

const KEYWORDS = String(arg('keywords', '流浪地球,诡秘之主')).split(',').map((s) => s.trim()).filter(Boolean);
const HALL_BASE = String(arg('hall', 'http://127.0.0.1:8890'));
const MAX_SOURCES = Number(arg('max', 0)) || 0;
const TIMEOUT_MS = Number(arg('timeout', 10000));
const CONCURRENCY = Number(arg('concurrency', 8));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────────────────────── 书源装载 ───────────────────────── */

function loadSearchableSources() {
  const raw = JSON.parse(fs.readFileSync(FULL_CACHE, 'utf8'));
  const all = Array.isArray(raw) ? raw : raw.sources || [];
  const list = all.filter(
    (s) => s && s.enabled !== false && s.url && (s.searchUrl || s.rules?.search?.bookList)
  );
  return { total: all.length, list: MAX_SOURCES ? list.slice(0, MAX_SOURCES) : list };
}

/* ───────────────────────── 线上 8890 快照（只读） ───────────────────────── */

async function hallPost(pathname, body, ms = 8000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(HALL_BASE + pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
      cache: 'no-store',
    });
    return { status: r.status, data: await r.json().catch(() => null) };
  } catch (e) {
    return { status: 0, error: e.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

async function hallGet(pathname, ms = 8000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(HALL_BASE + pathname, { signal: ac.signal, cache: 'no-store' });
    return { status: r.status, data: await r.json().catch(() => null) };
  } catch (e) {
    return { status: 0, error: e.message || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** 起任务并轮询到 done；返回线上快照（聚合书 + stats）。 */
async function captureHallSnapshot(keyword, maxWaitMs = 600000) {
  const start = await hallPost('/api/book/search-start', { q: keyword });
  if (!start.data?.ok || !start.data.job?.id) {
    return { ok: false, error: start.error || `search-start 失败 status=${start.status}`, job: null };
  }
  const jobId = start.data.job.id;
  const deadline = Date.now() + maxWaitMs;
  let last = null;
  while (Date.now() < deadline) {
    const st = await hallGet(`/api/book/search-status?job=${encodeURIComponent(jobId)}`);
    last = st.data?.job || null;
    if (last && (last.status === 'done' || last.status === 'error')) break;
    await sleep(2000);
  }
  const job = last || {};
  return {
    ok: job.status === 'done',
    incomplete: job.status !== 'done',
    jobId,
    status: job.status,
    query: job.query,
    stats: job.stats || null,
    online: {
      total: job.total,
      answered: job.answered,
      failed: job.failed,
      skipped: job.skipped,
      hits: job.hits,
      sourcesWithResults: job.sourcesWithResults,
      elapsedMs: job.finishedAt && job.startedAt ? job.finishedAt - job.startedAt : 0,
    },
    items: (job.items || []).map((it) => ({
      name: it.name,
      author: it.author,
      bookUrl: it.bookUrl,
      sourceName: it.originName || it.sourceName,
      bookSourceUrl: it.bookSourceUrl || it.sourceId,
      sourceCount: it.sourceCount,
      sources: (it.sources || []).map((s) => ({ name: s.name, url: s.url, bookUrl: s.bookUrl, fallback: !!s.fallback })),
    })),
  };
}

/* ───────────────────────── 本地引擎直测 ───────────────────────── */

async function engineSearch(source, key) {
  try {
    const res = await searchSource(source, key, { page: 1, timeoutMs: TIMEOUT_MS });
    return res && typeof res === 'object' ? res : { ok: false, error: String(res), ms: 0 };
  } catch (e) {
    return { ok: false, error: e.message || String(e), ms: 0 };
  }
}

/** 滑窗并发跑一批源；返回记录数组。 */
async function runBatch(sources, keyword, onProgress) {
  const records = [];
  let cursor = 0;
  let done = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, sources.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= sources.length) return;
      const source = sources[i];
      const res = await engineSearch(source, keyword);
      const leaf = classifyLeaf(res);
      records.push({
        keyword,
        source: source.url,
        name: source.name,
        host: hostOf(source.url),
        stage: 'search',
        ok: !!res.ok,
        books: Array.isArray(res.books) ? res.books.length : 0,
        error: sliceErr(res.error || '', 120),
        ms: Number(res.ms) || 0,
        reason: leaf.reason,
        leaf: leaf.leaf,
        detail: leaf.detail,
      });
      done++;
      if (onProgress && (done % 100 === 0 || done === sources.length)) onProgress(done, sources.length);
    }
  });
  await Promise.all(runners);
  return records;
}

/** 失败源复测第二次：判定规则可用（调度漏掉）还是源问题。 */
async function retestFailed(records) {
  const targets = records.filter((r) => r.reason !== 'answered' && r.reason !== 'busy');
  let i = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, targets.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= targets.length) return;
      const rec = targets[idx];
      await sleep(120 + Math.random() * 180);
      const full = sourceByUrl.get(rec.source);
      const res2 = full ? await engineSearch(full, rec.keyword) : { ok: false, error: '源清单缺失，无法复测', ms: 0 };
      const books = Array.isArray(res2.books) ? res2.books.length : 0;
      let verdict;
      if (res2.ok && books > 0) verdict = '规则可用：复测出结果，属本轮调度/慢波漏掉';
      else if (res2.ok) verdict = '规则命中为空：源内无此书';
      else verdict = '源问题：复测仍失败';
      rec.retest = {
        ok: !!res2.ok,
        books,
        error: sliceErr(res2.error || '', 120),
        ms: Number(res2.ms) || 0,
        verdict,
        sampleBooks: (res2.books || []).slice(0, 3).map((b) => ({ name: b.name, author: b.author, bookUrl: b.bookUrl })),
      };
    }
  });
  await Promise.all(runners);
  return records;
}

/* ───────────────────────── Reader 书架（只读，非搜书结果） ───────────────────────── */

const READER_BASE = process.env.READER_BASE || 'http://127.0.0.1:1122';

async function fetchReaderShelf(ms = 10000) {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    const r = await fetch(`${READER_BASE}/reader3/getBookshelf`, { signal: ac.signal, cache: 'no-store' });
    clearTimeout(timer);
    const payload = await r.json().catch(() => null);
    const list = (payload && Array.isArray(payload.data)) ? payload.data : [];
    return {
      ok: r.ok,
      items: list.map((b) => ({
        name: b.name,
        author: String(b.author || '').replace(/^作\s*者[：:]/, '').trim(),
        bookUrl: b.bookUrl,
        source: b.origin,
        sourceName: b.originName,
        candidates: (b.sourceCandidates || []).map((c) => ({ name: c.name, author: c.author, bookUrl: c.bookUrl, origin: c.origin })),
      })),
    };
  } catch (e) {
    return { ok: false, error: e.message || String(e), items: [] };
  }
}

/** 书架留存是否命中关键词（名字含关键词词片，或作者命中目标作者）。 */
function shelfMatchesKeyword(book, keyword) {
  const tokens = [keyword, ...String(keyword).split('').filter((c) => /[一-龥]/.test(c))];
  const name = String(book.name || '');
  const author = String(book.author || '');
  if ([...new Set(tokens)].some((t) => t.length >= 2 && name.includes(t))) return true;
  // 目标作者兜底：刘慈欣 / 爱潜水的乌贼
  if (/刘慈欣/.test(author) || /爱潜水的乌贼/.test(author)) return true;
  return false;
}

/* ───────────────────────── 主流程 ───────────────────────── */

const sourceByUrl = new Map();

async function main() {
  const startedAt = Date.now();
  const loaded = loadSearchableSources();
  const sources = loaded.list;
  for (const s of sources) sourceByUrl.set(s.url, s);

  console.log(`[audit] 可搜源 ${sources.length}，关键词 ${KEYWORDS.join(' / ')}，超时 ${TIMEOUT_MS}ms，并发 ${CONCURRENCY}`);

  // 1) 线上快照（只读 8890）
  const online = {};
  if (!flags['no-online']) {
    for (const kw of KEYWORDS) {
      console.log(`[online] 抓取 8890「${kw}」…`);
      online[kw] = await captureHallSnapshot(kw);
      const o = online[kw].online || {};
      console.log(`[online] 「${kw}」total=${o.total} answered=${o.answered} failed=${o.failed} skipped=${o.skipped} hits=${o.hits}`);
    }
  }

  // 2) 本地逐源直测
  const allRecords = [];
  const perKeyword = {};
  for (const kw of KEYWORDS) {
    console.log(`[local] 直测「${kw}」…`);
    const recs = await runBatch(sources, kw, (done, total) => {
      console.log(`[local] 「${kw}」${done}/${total}`);
    });
    if (!flags['no-retest']) await retestFailed(recs);
    allRecords.push(...recs);
    perKeyword[kw] = recs;
    // 增量落盘，避免进程中断丢失已完成关键词的数据
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, JSON.stringify({ partial: true, generatedAt: Date.now(), params: { keywords: KEYWORDS, timeoutMs: TIMEOUT_MS, concurrency: CONCURRENCY }, records: recs, perKeyword: { [kw]: recs } }, null, 1));
    console.log(`[local] 「${kw}」增量落盘 ${recs.length} 条`);
  }

  // 3) 死源聚合 + 标注
  const { dead, bySource } = markDeadSources(allRecords, DEAD_THRESHOLD);
  applyDeadMarker(allRecords, dead);

  // 4) 每关键词汇总（分母：已尝试源；busy 单列）
  const summary = {};
  for (const kw of KEYWORDS) {
    const recs = perKeyword[kw];
    const attempted = recs.filter((r) => r.reason !== 'busy');
    const busy = recs.filter((r) => r.reason === 'busy');
    const sum = summarize(attempted, { denominator: attempted.length });
    const deadAttempts = attempted.filter((r) => r.reason === 'dead-source').length;
    const answered = attempted.filter((r) => r.reason === 'answered').length;
    const withResults = attempted.filter((r) => r.ok && r.books > 0).length;
    summary[kw] = {
      searchableTotal: sources.length,
      attempted: attempted.length,
      busy: busy.length,
      answered,
      withResults,
      failed: attempted.length - answered,
      empty: attempted.filter((r) => r.ok && r.books === 0).length,
      deadAttempts,
      deadSources: [...dead].filter((u) => attempted.some((r) => r.source === u)).length,
      classification: sum.counts,
      successRate: {
        before: attempted.length ? Math.round((answered / attempted.length) * 10000) / 100 : 0,
        afterDeadExcluded:
          attempted.length - deadAttempts > 0
            ? Math.round((answered / (attempted.length - deadAttempts)) * 10000) / 100
            : 0,
      },
    };
  }

  // 5) Reader 基准差集（搜书真值不可得；书架留存作为弱基准）
  const shelf = await fetchReaderShelf();
  const diffByKeyword = {};
  for (const kw of KEYWORDS) {
    const hallItems = online[kw]?.items || [];
    const hallIds = new Set(hallItems.map((it) => bookIdentity(it.name, it.author)));
    const shelfItems = shelf.items.filter((b) => shelfMatchesKeyword(b, kw));
    const shelfIds = new Set(shelfItems.map((b) => bookIdentity(b.name, b.author)));
    // 书架有、客厅线上结果没有（弱口径：书架留存 ≠ 本轮 Reader 搜书结果）
    const shelfOnly = shelfItems
      .filter((b) => !hallIds.has(bookIdentity(b.name, b.author)))
      .map((b) => ({
        name: b.name,
        author: b.author,
        readerSource: b.sourceName,
        readerSourceUrl: b.source,
        bookUrl: b.bookUrl,
        note: '书架留存口径，非本轮 Reader 搜书结果；漏搜原因待 Reader 搜书真值复核',
      }));
    // 客厅有、书架没有（仅信息参考）
    const hallOnly = hallItems
      .filter((it) => !shelfIds.has(bookIdentity(it.name, it.author)))
      .map((it) => ({ name: it.name, author: it.author, source: it.sourceName, bookUrl: it.bookUrl }));
    diffByKeyword[kw] = { shelfMatches: shelfItems.length, shelfOnly, hallOnly };
  }

  // 退化基准：复测出结果的「首轮失败源」= 调度/慢波漏掉候选（不是 Reader 真值）
  const missedBySchedule = allRecords
    .filter((r) => r.retest?.verdict?.startsWith('规则可用：复测出结果'))
    .map((r) => ({
      keyword: r.keyword,
      name: r.retest.sampleBooks?.[0]?.name || '',
      author: r.retest.sampleBooks?.[0]?.author || '',
      source: r.source,
      sourceName: r.name,
      host: r.host,
      firstError: r.error,
      retestBooks: r.retest.books,
      reason: '该源本轮未轮到/在慢波被砍（复测规则可用）',
    }));

  const diff = {
    readerBaseline: {
      status: 'degraded-shelf',
      note:
        'Reader 1122 axum 路由无搜书接口（/reader3/searchBookMulti GET 回 HTML、POST 405）；' +
        'search_book_multi_sse 仅存在于 Tauri WebView IPC，外部 HTTP 无法调起；reader.db 无搜书结果表，' +
        'storage/cache 为章节正文缓存。本轮 Reader 搜书真值不可得，退化为：(a) 书架留存弱基准（getBookshelf，历史收藏，非本轮搜索）；' +
        '(b) 逐源直测复测基准（首轮失败源第二次调用，规则可用=调度漏掉，仍失败=源问题）。hallOnly/readerOnly 真值差集留空。',
      evidence: {
        httpRoutesProbed: ['/reader3/searchBookMulti', '/reader3/searchBook', '/api/search', '/api/books/search'],
        tauriCommand: 'search_book_multi_sse',
        dbTables: ['book_sources', 'reading_book_stats', 'reading_stats', 'users', 'user_sessions', 'json_documents'],
        shelfEndpoint: '/reader3/getBookshelf',
        shelfCount: shelf.items.length,
      },
    },
    shelf,
    byKeyword: diffByKeyword,
    hallOnly: null,
    readerOnly: null,
    degradedMissedBySchedule: missedBySchedule,
  };

  // 6) 死源写入健康缓存（复用 book_sched.recordOutcome，不另写存储）
  const deadWrite = [];
  if (!flags['no-dead-write']) {
    for (const url of dead) {
      const entry = bySource.get(url);
      const res = recordOutcome(url, 'info', {
        ok: false,
        ms: entry?.lastMs || 0,
        error: entry?.lastError || 'dead-source: 连续连接层失败',
      });
      deadWrite.push({ source: url, host: entry?.host, recorded: res.recorded, consecutiveFails: res.consecutiveFails, deprioritized: res.deprioritized });
    }
  }

  const report = {
    generatedAt: Date.now(),
    elapsedMs: Date.now() - startedAt,
    params: { keywords: KEYWORDS, timeoutMs: TIMEOUT_MS, concurrency: CONCURRENCY, maxSources: MAX_SOURCES || sources.length, hallBase: HALL_BASE },
    sourceCounts: { full: loaded.total, searchable: sources.length },
    readerBaseline: diff.readerBaseline,
    online,
    summary,
    diff,
    dead: {
      threshold: DEAD_THRESHOLD,
      rule: `同一源本轮 ≥${DEAD_THRESHOLD} 次尝试（跨关键词）全部为 DNS/连接层失败且无成功记录；沿用健康缓存 14 天 TTL，连续失败降权窗口 24h。`,
      urls: [...dead],
      write: deadWrite,
    },
    records: allRecords,
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 1));
  console.log(`[audit] 落盘 ${OUT_PATH}（${allRecords.length} 条记录，死源 ${dead.size}）`);

  for (const kw of KEYWORDS) {
    const s = summary[kw];
    console.log(
      `[${kw}] attempted=${s.attempted} answered=${s.answered} failed=${s.failed} empty=${s.empty} dead=${s.deadAttempts} ` +
        `成功率 before=${s.successRate.before}% after=${s.successRate.afterDeadExcluded}%`
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[audit] 致命错误：', e);
    process.exit(1);
  });
