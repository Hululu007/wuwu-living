/**
 * Worker 池阻塞/自愈验证（纯 node，不碰 8890）。
 * 输出：主线程定时器抖动、并发上限、任务超时自愈证据。
 * 运行：node lib/legado/test/pool-check.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSources, searchSource } from '../index.mjs';
import { runInPool, runInPoolTimed, poolStats } from '../pool.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

const report = { generatedAt: new Date().toISOString(), jitter: {}, concurrency: {}, timeout: {} };

// 先在定时器外完成书源装载，避免一次性大对象结构化克隆计入抖动
const srcs = await loadSources();
const seed = srcs.find((x) => x.url === 'http://www.23uswx.la/') || srcs[0];

/* ── 1. 主线程抖动：20 个并发搜索，50ms 定时器实测间隔 ── */
const deltas = [];
let last = Date.now();
const timer = setInterval(() => {
  const now = Date.now();
  deltas.push(now - last);
  last = now;
}, 50);

const busySamples = [];
const queueSamples = [];
const sampler = setInterval(() => {
  busySamples.push(poolStats().busy);
  queueSamples.push(poolStats().queue);
}, 20);

const jobs = Array.from({ length: 20 }, () =>
  searchSource(seed, '凡人修仙传', { timeoutMs: 10000 })
);
const settled = await Promise.allSettled(jobs);

clearInterval(timer);
clearInterval(sampler);

report.jitter = {
  expectedMs: 50,
  samples: deltas.length,
  meanMs: Math.round((deltas.reduce((a, b) => a + b, 0) / deltas.length) * 10) / 10,
  p95Ms: Math.round(pct(deltas, 95) * 10) / 10,
  p99Ms: Math.round(pct(deltas, 99) * 10) / 10,
  maxMs: Math.round(Math.max(...deltas) * 10) / 10,
  passed: pct(deltas, 99) < 100,
};
report.concurrency = {
  submitted: 20,
  poolSize: poolStats().workers,
  maxBusy: Math.max(...busySamples),
  queueMax: Math.max(...queueSamples),
  passed: Math.max(...busySamples) <= 4,
};
report.searchOk = settled.filter((x) => x.status === 'fulfilled' && x.value.ok).length;

/* ── 1b. 50 任务压力：同一源同一关键词，并发 4，三段耗时不随任务数递增 ── */
const PRESSURE = 50;
const CHUNK = 4;
const pressure = [];
for (let i = 0; i < PRESSURE; i += CHUNK) {
  const batch = Array.from({ length: Math.min(CHUNK, PRESSURE - i) }, () =>
    runInPoolTimed('searchSource', [seed, '凡人修仙传', { timeoutMs: 10000 }])
  );
  const settledBatch = await Promise.allSettled(batch);
  for (const s of settledBatch) {
    pressure.push(s.status === 'fulfilled' ? s.value : { result: null, metrics: null });
  }
}
const metric = (key) => pressure.map((x) => x.metrics?.[key] || 0);
const summarize = (key) => ({
  p50: Math.round(pct(metric(key), 50) * 10) / 10,
  p95: Math.round(pct(metric(key), 95) * 10) / 10,
  max: Math.round(Math.max(...metric(key)) * 10) / 10,
});
const firstWall = pressure[0]?.metrics?.wallMs || 0;
const wallAll = metric('wallMs');
const first10 = wallAll.slice(0, 10);
const last10 = wallAll.slice(-10);
const median = (arr) => pct(arr, 50);
report.pressure = {
  submitted: PRESSURE,
  concurrency: CHUNK,
  firstWallMs: firstWall,
  queueWait: summarize('queueWaitMs'),
  engine: summarize('engineMs'),
  wall: summarize('wallMs'),
  success: pressure.filter((x) => x.result?.ok).length,
  wallP95RatioToFirst: firstWall > 0 ? Math.round((summarize('wallMs').p95 / firstWall) * 10) / 10 : null,
  first10WallMedianMs: Math.round(median(first10)),
  last10WallMedianMs: Math.round(median(last10)),
  // 槽位泄漏判定：队列等待必须为 0；墙钟波动单独看首末段趋势，不混入排队结论。
  passed: summarize('queueWaitMs').p95 === 0 && summarize('queueWaitMs').max === 0 &&
    pressure.filter((x) => x.result?.ok).length === PRESSURE,
  latencyTrend: median(last10) <= median(first10) * 1.2,
};

/* ── 2. 死循环 @js 源：10s 超时掐掉，worker 重建后下一任务正常 ── */
const deadLoopSource = {
  url: 'dead-loop#test',
  header: '',
  searchUrl: '@js:while(true){}',
  rules: { search: { bookList: 'x' } },
};

const t0 = Date.now();
let rejected = null;
try {
  await runInPool('searchSource', [deadLoopSource, 'k']);
} catch (e) {
  rejected = String(e.message || e);
}
const timeoutElapsed = Date.now() - t0;

// 自愈：超时回收后，再投一个真实任务应正常返回
let healOk = false;
try {
  const heal = await runInPool('loadSources', []);
  healOk = Array.isArray(heal) && heal.length > 0;
} catch {
  healOk = false;
}

report.timeout = {
  rejected: rejected != null,
  reason: rejected,
  elapsedMs: timeoutElapsed,
  workerRebuilt: poolStats().workers === 4,
  nextTaskOk: healOk,
  passed: rejected != null && healOk,
};

fs.writeFileSync(path.join(here, 'pool-check.json'), JSON.stringify(report, null, 2));

console.log('── 主线程抖动 ──', JSON.stringify(report.jitter));
console.log('── 并发上限 ──', JSON.stringify(report.concurrency));
console.log('── 50 任务压力 ──', JSON.stringify(report.pressure));
console.log('── 超时自愈 ──', JSON.stringify(report.timeout));
console.log('搜索成功任务数：', report.searchOk, '/20');
process.exit(0);
