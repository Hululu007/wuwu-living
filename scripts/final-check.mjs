#!/usr/bin/env node
/**
 * 终验脚本：对指定 base 跑「冷搜索首条 / 搜索收尾条数 / 10 本不同书名打开 / 搜索进行中十路由」。
 * 纯只读，不重启任何实例；由组织者手动在自测端口调用。
 * 用法：node scripts/final-check.mjs --base http://127.0.0.1:8950 --out runtime/final-check.json
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const BASE = argOf('--base', 'http://127.0.0.1:8950');
const OUT = argOf('--out', 'runtime/final-check.json');
const KW = [argOf('--kw1', '流浪地球'), argOf('--kw2', '诡秘之主')];

const routes = ['/', '/book/', '/magnet/', '/music/', '/vod/', '/download/', '/library/', '/notes/', '/calendar/', '/photos/'];
const report = { base: BASE, at: new Date().toISOString(), searches: [], opens: [], latency: {}, notes: [] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jf = async (url, opts) => {
  const r = await fetch(url, opts);
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t.slice(0, 200) }; }
};

async function latencyProbe(ms) {
  const samples = {};
  const until = Date.now() + ms;
  for (const p of routes) samples[p] = [];
  while (Date.now() < until) {
    for (const p of routes) {
      const t0 = Date.now();
      try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 1500);
        const r = await fetch(BASE + p, { signal: ctrl.signal });
        clearTimeout(to);
        await r.text();
        samples[p].push({ ms: Date.now() - t0, code: r.status });
      } catch {
        samples[p].push({ ms: Date.now() - t0, code: 0 });
      }
    }
    await sleep(300);
  }
  const out = {};
  for (const p of routes) {
    const arr = samples[p].map((s) => s.ms).sort((a, b) => a - b);
    const codes = samples[p].map((s) => s.code);
    const q = (f) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(f * arr.length))] : 0);
    out[p] = {
      n: arr.length,
      p50: q(0.5),
      p95: q(0.95),
      max: arr[arr.length - 1] || 0,
      code200: codes.filter((c) => c === 200).length,
      codeOther: codes.filter((c) => c !== 200).length,
      otherCodes: [...new Set(codes.filter((c) => c !== 200))],
    };
  }
  return out;
}

async function runSearch(kw) {
  const st = await jf(`${BASE}/api/book/search-start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ q: kw }),
  });
  const job = st.body && st.body.job ? st.body.job.id : null;
  if (!job) return { kw, error: '未能创建搜索任务', raw: st.body };
  const t0 = Date.now();
  let firstAt = null, firstInfo = null, snapped = null;
  const budget = 150000;
  while (Date.now() - t0 < budget) {
    const s = await jf(`${BASE}/api/book/search-status?job=${job}`);
    const j = (s.body && s.body.job) || {};
    const items = j.items || [];
    if (!firstAt && items.length) {
      firstAt = Date.now() - t0;
      firstInfo = { name: items[0].name, url: items[0].bookSourceUrl || items[0].url, bookUrl: items[0].bookUrl };
    }
    // 只在任务真正收尾时取快照。
    // 旧写法 `j.done` 是个「已结算源数」计数器，一开始有进度就为真，
    // 于是 snapped 抓到的是流式中途的快照：那时条目按「谁先返回」追加，
    // 17K 这类秒回但打不开的源全挤在最前面，后面 10 本全按它去开必然失败。
    // 实测这个假象会让人误判「打开链路 100% 失败」。
    if (!snapped && j.status !== 'running') snapped = j;
    // 只能用 status 判收尾。`j.done` 是「已结算源数」，搜索一开始有进度就 > 0，
    // 旧写法会让 runSearch 在 4 秒时就把中途快照当成完整结果返回——
    // 那时列表前面全是 17K 秒回条目，于是 10 本全按打不开的源去 open，
    // 报出「打开链路 100% 失败」的假象（实测修正后能拿到完整 320 条）。
    if (j.status !== 'running') {
      return {
        kw, job,
        firstItemMs: firstAt,
        firstItem: firstInfo,
        done: true,
        totalElapsedMs: Date.now() - t0,
        hits: (snapped ? snapped.hits : j.hits),
        items: (snapped ? snapped.items || [] : items).length,
        itemsList: (snapped ? snapped.items || [] : items).slice(0, 400),
        answered: j.answered,
        failed: j.failed,
        total: j.total,
        status: j.status,
      };
    }
    await sleep(120);
  }
  return { kw, job, firstItemMs: firstAt, firstItem: firstInfo, done: false, timeout: true, hits: null };
}

function pickTen(items) {
  const byTitle = new Map();
  for (const it of items) {
    const key = String(it.name || '').replace(/\s/g, '');
    if (!key) continue;
    if (!byTitle.has(key)) byTitle.set(key, it);
  }
  return [...byTitle.values()].slice(0, 10);
}

async function run() {
  for (const kw of KW) {
    const s = await runSearch(kw);
    report.searches.push({ ...s, itemsList: undefined });
    // 搜索进行中十路由采样
    report.latency[kw] = await latencyProbe(35000);
    if (report.opens.length) continue;
    const ten = pickTen(s.itemsList || []);
    report.notes.push(`${kw} 命中 ${(s.itemsList || []).length} 条，取不同书名 ${ten.length} 本打开`);
    for (const it of ten) {
      const srcUrl = it.bookSourceUrl || it.url || it.origin;
      const sources = (Array.isArray(it.sources) && it.sources.length ? it.sources : [{ name: it.name, url: srcUrl, bookUrl: it.bookUrl }])
        .filter((x) => x && x.url && x.bookUrl)
        .map((x) => ({ name: x.name || it.name, url: x.url, bookUrl: x.bookUrl }));
      const payload = { bookUrl: it.bookUrl, bookSourceUrl: srcUrl, origin: srcUrl, name: it.name, originName: it.name, sources };
      const t0 = Date.now();
      let r;
      try {
        r = await jf(`${BASE}/api/book/open`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
        });
      } catch (e) {
        r = { status: 0, body: { message: String(e && e.message) } };
      }
      const b = r.body || {};
      report.opens.push({
        name: it.name,
        source: it.bookSourceUrl || it.url || '',
        bookUrl: it.bookUrl,
        status: r.status,
        ok: !!b.ok,
        engine: b.engine || '',
        chapters: (b.chapters || []).length,
        firstLen: (b.firstChapter && b.firstChapter.length) || 0,
        ms: Date.now() - t0,
        message: b.message || '',
      });
    }
  }
  const okCount = report.opens.filter((o) => o.ok).length;
  report.summary = {
    opensTotal: report.opens.length,
    opensOk: okCount,
    openFailRate: report.opens.length ? (1 - okCount / report.opens.length) * 100 : null,
    coldUnder3s: report.opens.filter((o) => o.ok && o.ms < 3000).length,
    firstItemMs: report.searches.map((s) => s.firstItemMs),
  };
  const dir = path.dirname(OUT);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report.summary));
}

run().catch((e) => {
  console.error('压测失败', e && e.message);
  process.exit(1);
});
