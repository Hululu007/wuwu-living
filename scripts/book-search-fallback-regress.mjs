#!/usr/bin/env node
/* book-search-fallback-regress.mjs —— 「搜书失败不许伪装成没结果」的端到端回归锁
 *
 * 为什么要有这一条（2026-11-23）：
 *   线上实测：连续第二次搜书 61ms 收尾、报「0 本 / 0 源」，
 *   日志是 `searchd 搜索失败，回落本地引擎: fetch failed`。
 *   根因是回落目标（本地引擎）当时 0 源，却仍走「成功」收尾路径。
 *   用户看到的是「搜完了，没有这本书」，与真的没有结果同形 —— 这是假空的一种。
 *
 * 判据（真进程 + 真 HTTP，不看源码字面）：
 *   ① 负向臂：searchd 连不上 + 本地 0 源 ⇒ 任务必须是 error，且 error 里有「引擎」；
 *      **必须不是** done/0 本（旧实现正是这个假绿）。
 *   ② 正向臂：mock searchd 正常吐 SSE ⇒ 任务必须 done 且拿到 ≥1 本书。
 *      证明本套不是「见 job 就判红」，能区分成功与失败。
 *   ③ 自愈臂：本地原始书源 JSON 可用时，/api/book/info 的 searchRules > 0。
 *      证明 runtime/book-sources-full.json 丢失后能自己重建，不再靠 Reader 常驻。
 *
 * 三臂各自一个隔离实例（独立 PORT + WUWU_RUNTIME_DIR），互不污染，也不碰运行时 8890。
 *
 * 用法：node scripts/book-search-fallback-regress.mjs [--json]
 * 退出码：0 全过 / 1 断言不合格 / 2 检查器故障
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const HUB = path.join(ROOT, 'hub.mjs');
const AS_JSON = process.argv.includes('--json');

const results = [];
function record(arm, ok, detail) {
  results.push({ arm, ok, detail });
  if (!AS_JSON) console.log(`${ok ? 'PASS' : 'FAIL'} ${arm}: ${detail}`);
}

function fault(message) {
  console.error(`[检查器故障] ${message}`);
  process.exit(2);
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitHttp(url, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        await res.text();
        return true;
      }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function startHub(env) {
  const child = spawn(process.execPath, [HUB], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += String(d); });
  child.stdout.on('data', () => {});
  child.__stderr = () => stderr;
  return child;
}

function killHub(child) {
  if (!child || child.killed) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
}

async function postJson(base, pathname, body) {
  const res = await fetch(base + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  return res.json();
}

async function getJson(base, pathname) {
  const res = await fetch(base + pathname, { signal: AbortSignal.timeout(10000) });
  return res.json();
}

async function pollJob(base, id, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await getJson(base, `/api/book/search-status?job=${encodeURIComponent(id)}`);
    const job = last?.job;
    if (job && job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 250));
  }
  return last?.job || null;
}

/* ───────── 臂①：searchd 不通 + 本地 0 源 ⇒ 必须是 error ───────── */
async function armErrorNotFakeEmpty() {
  const dir = tmpDir('ww-arm-nolocal');
  const port = await freePort();
  const dead = await freePort();  // 拿完就关，保证没人监听
  const child = startHub({
    PORT: String(port),
    BIND: '127.0.0.1',
    WUWU_RUNTIME_DIR: dir,
    READER_SEARCH_BASE: `http://127.0.0.1:${dead}`,
    READER_BASE: `http://127.0.0.1:${dead}`,
    WW_SOURCE_RAW_DISABLE: '1',
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    if (!(await waitHttp(`${base}/api/ping`))) {
      record('①searchd不通+本地0源', false, `hub 没起来：${child.__stderr().slice(0, 300)}`);
      return;
    }
    const started = await postJson(base, '/api/book/search-start', { q: '回归测试书名' });
    const job = started?.job;
    if (!job?.id) {
      record('①searchd不通+本地0源', false, `search-start 没返回 job：${JSON.stringify(started).slice(0, 200)}`);
      return;
    }
    const final = await pollJob(base, job.id, 20000);
    if (!final) {
      record('①searchd不通+本地0源', false, '任务 20s 内没有终态（疑似挂死）');
      return;
    }
    const isError = final.status === 'error';
    const messageOk = /引擎|不可用|重试/.test(String(final.error || ''));
    const isFakeDone = final.status === 'done' && final.hits === 0;
    if (isError && messageOk && !isFakeDone) {
      record('①searchd不通+本地0源', true, `status=${final.status} error=${final.error}`);
    } else if (isFakeDone) {
      record('①searchd不通+本地0源', false, `假绿：status=done / hits=0 / note=${final.note || ''}（旧实现的错误形态）`);
    } else {
      record('①searchd不通+本地0源', false, `status=${final.status} hits=${final.hits} error=${final.error || '(空)'}`);
    }
  } finally {
    killHub(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ───────── 臂②：mock searchd 正常 ⇒ 必须 done 且有结果 ───────── */
function startMockSearchd() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/health')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, app: 'mock-searchd', sources: 2, enabled: 2, concurrency: 4 }));
      return;
    }
    if (req.url.startsWith('/search/stream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(`data: ${JSON.stringify({ type: 'start', total: 2 })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: 'items',
        source: { name: 'mock源', url: 'http://mock.example' },
        books: [{ name: '回归测试书名', author: '测试作者', bookUrl: 'http://mock.example/book/1', origin: 'http://mock.example' }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done', stats: { ok: 1, empty: 1, failed: 0, elapsedMs: 12 } })}\n\n`);
      res.end();
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function armPositive() {
  const dir = tmpDir('ww-arm-pos');
  const port = await freePort();
  const server = await startMockSearchd();
  const mockPort = server.address().port;
  const child = startHub({
    PORT: String(port),
    BIND: '127.0.0.1',
    WUWU_RUNTIME_DIR: dir,
    READER_SEARCH_BASE: `http://127.0.0.1:${mockPort}`,
    READER_BASE: 'http://127.0.0.1:1',
    WW_SOURCE_RAW_DISABLE: '1',
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    if (!(await waitHttp(`${base}/api/ping`))) {
      record('②mock引擎成功', false, `hub 没起来：${child.__stderr().slice(0, 300)}`);
      return;
    }
    const started = await postJson(base, '/api/book/search-start', { q: '回归测试书名' });
    const job = started?.job;
    if (!job?.id) {
      record('②mock引擎成功', false, `search-start 没返回 job：${JSON.stringify(started).slice(0, 200)}`);
      return;
    }
    const final = await pollJob(base, job.id, 15000);
    if (final && final.status === 'done' && (final.items?.length || 0) >= 1) {
      record('②mock引擎成功', true, `status=done hits=${final.hits} items=${final.items.length} engine=${final.stats?.engine || '?'}`);
    } else {
      record('②mock引擎成功', false, `status=${final?.status} hits=${final?.hits} items=${final?.items?.length} error=${final?.error || ''}`);
    }
  } finally {
    killHub(child);
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ───────── 臂③：本地原始书源可自愈重建 ───────── */
async function armSelfHeal() {
  const dir = tmpDir('ww-arm-heal');
  const port = await freePort();
  const fixture = path.join(dir, 'raw-fixture.json');
  fs.writeFileSync(fixture, JSON.stringify([{
    bookSourceName: '夹具源',
    bookSourceUrl: 'http://fixture.example',
    searchUrl: 'http://fixture.example/search?q={{key}}',
    bookSourceGroup: '夹具',
    enabled: true,
    ruleSearch: {
      bookList: '//div[@class="item"]',
      name: '//h3/text()',
      author: '//span/text()',
      bookUrl: '//a/@href',
    },
  }]), 'utf8');
  const child = startHub({
    PORT: String(port),
    BIND: '127.0.0.1',
    WUWU_RUNTIME_DIR: dir,
    LEGADO_RAW_FALLBACK: fixture,
    WW_SOURCE_RAW_DISABLE: '0',
    READER_SEARCH_BASE: 'http://127.0.0.1:1',
    READER_BASE: 'http://127.0.0.1:1',
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    if (!(await waitHttp(`${base}/api/ping`))) {
      record('③本地源自愈', false, `hub 没起来：${child.__stderr().slice(0, 300)}`);
      return;
    }
    // 等启动期 ensureSourceCache 异步装载完成（读到 raw fixture 后会写 full cache）
    const deadline = Date.now() + 8000;
    let info = null;
    while (Date.now() < deadline) {
      info = await getJson(base, '/api/book/info');
      if (info && Number(info.searchRules) > 0) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const cacheFile = path.join(dir, 'book-sources-full.json');
    const wroteCache = fs.existsSync(cacheFile);
    if (info && Number(info.searchRules) > 0 && wroteCache) {
      record('③本地源自愈', true, `searchRules=${info.searchRules} 已落盘 ${path.basename(cacheFile)}`);
    } else {
      record('③本地源自愈', false, `searchRules=${info?.searchRules} cacheExists=${wroteCache}`);
    }
  } finally {
    killHub(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (!fs.existsSync(HUB)) fault(`找不到 ${HUB}`);

try {
  await armErrorNotFakeEmpty();
  await armPositive();
  await armSelfHeal();
} catch (error) {
  fault(`执行异常：${error?.stack || error}`);
}

const failed = results.filter((r) => !r.ok);
if (AS_JSON) console.log(JSON.stringify({ arms: results, failed: failed.length }, null, 2));
if (failed.length) {
  console.error(`\n${failed.length}/${results.length} 臂不合格`);
  process.exit(1);
}
console.log(`\n全部 ${results.length} 臂通过`);
process.exit(0);
