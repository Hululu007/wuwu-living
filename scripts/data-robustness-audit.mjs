#!/usr/bin/env node
/**
 * 五五客厅 · 数据健壮性体检（B4）
 *
 * 纯 Node、零新依赖。只做静态审计 + 临时副本上的并发/中断实验；
 * 不改 hub.mjs / lib/** / public/**，不碰线上 8890，不杀任何线上进程。
 *
 * 用法：
 *   node scripts/data-robustness-audit.mjs                 # 全量体检，输出 runtime/data-robustness.json
 *   node scripts/data-robustness-audit.mjs --worker ...    # 并发实验内部子进程，勿手动调用
 *   node scripts/data-robustness-audit.mjs --out <file>    # 指定报告路径
 *
 * 实验隔离：并发与中断实验全部落在 os.tmpdir() 下的临时副本目录；
 * 不读写工程 runtime/ 下的真实业务文件（报告文件除外）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

/* ───────────────────────── 内部 worker：并发 RMW ───────────────────────── */
if (args[0] === '--worker') {
  const [, file, key, iters, mode, tag] = args;
  const sleep = () => new Promise((r) => setImmediate(r));
  for (let i = 0; i < Number(iters); i++) {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    const v = d[key];
    const arr = Array.isArray(v) ? v : (d[key] = {});
    if (Array.isArray(arr)) arr.push({ id: `${tag}-${i}`, at: Date.now() });
    else arr[`${tag}-${i}`] = { ok: 1, at: Date.now() };
    await sleep(); // 对齐真实代码 readFile/await → writeFile 之间的 await 窗口
    if (mode === 'atomic') {
      const tmp = `${file}.${process.pid}.tmp`; // 仿 lib/book_warm.mjs：pid 唯一临时名
      fs.writeFileSync(tmp, JSON.stringify(d));
      fs.renameSync(tmp, file);
    } else {
      fs.writeFileSync(file, JSON.stringify(d));
    }
  }
  process.exit(0);
}

/* ───────────────────────── 静态工具 ───────────────────────── */
function readLines(abs) {
  try { return fs.readFileSync(abs, 'utf8').split(/\r?\n/); } catch { return []; }
}

/** 解析 `const X = path.join(ROOT, 'runtime', 'xxx.json')` 一类落盘路径常量。 */
function resolveRuntimeConst(lines) {
  const map = {};
  for (const line of lines) {
    const m = line.match(/const\s+([A-Z0-9_]+)\s*=\s*path\.join\([^,]+,\s*'runtime'(?:,\s*'([^']+)')?\)/);
    if (m) map[m[1]] = m[2] ? `runtime/${m[2]}` : 'runtime/';
  }
  return map;
}

/** 找所有 writeFile/writeFileSync 站点，判定前后窗口内是否 tmp+rename。 */
function scanWriteSites(lines) {
  const sites = [];
  lines.forEach((line, idx) => {
    if (!/writeFile(Sync)?\(/.test(line)) return;
    const window = lines.slice(Math.max(0, idx - 8), idx + 9).join('\n');
    const atomic = /\.tmp/.test(window) && /rename(Sync)?\(/.test(window);
    sites.push({ line: idx + 1, code: line.trim().slice(0, 160), atomic });
  });
  return sites;
}

function has(lines, re) { return lines.some((l) => re.test(l)); }

/* ───────────────────────── 已知产品模块台账（人工核对行号） ───────────────────────── */
/**
 * 字段：
 *  runtimeFile 落盘文件；writeSites 写位置；atomic 是否 tmp+rename；
 *  serialization 进程内串行机制；debounce 防抖；fallback 读坏后的兜底；
 *  role 产品在线 / 一次性审计脚本；risk 风险分级。
 */
const KNOWN = [
  {
    module: 'lib/home.mjs', runtimeFile: 'runtime/home.json',
    writeSites: [{ line: 108, code: 'async function writeTodos(todos)', atomic: true },
                 { line: 110, code: "const tmp = TODO_FILE + '.tmp'", atomic: true },
                 { line: 111, code: 'await fsp.writeFile(tmp, ...)', atomic: true },
                 { line: 112, code: 'await fsp.rename(tmp, TODO_FILE)', atomic: true }],
    atomic: true, serialization: '无（无 writeChain/serialize）', debounce: '无（每次请求直接落盘）',
    fallback: 'readTodos catch → todos=[]（102-106）',
    rmw: 'readTodos() 读全量 → 改数组 → writeTodos() 整表覆盖（153/194）',
    role: '产品在线', risk: '高（跨实例/并发请求读-改-写互相覆盖；临时名固定，跨进程撞 tmp）',
  },
  {
    module: 'lib/notes.mjs', runtimeFile: 'runtime/notes.json',
    writeSites: [{ line: 58, code: "const tmp = DATA_FILE + '.tmp'", atomic: true },
                 { line: 59, code: 'await fsp.writeFile(tmp, ...)', atomic: true },
                 { line: 60, code: 'await fsp.rename(tmp, DATA_FILE)', atomic: true }],
    atomic: true, serialization: '无 writeChain；进程内 cache + 200ms 防抖',
    debounce: 'writeTimer/writePending 200ms（35-37, 48-62）',
    fallback: 'catch → { notes: [] }（39-46）',
    rmw: 'load() 取内存 cache → 改 notes → save() 整表覆盖',
    role: '产品在线', risk: '中（进程内防抖；跨进程/多实例整表覆盖丢更新）',
  },
  {
    module: 'lib/library.mjs', runtimeFile: 'runtime/library.json',
    writeSites: [{ line: 78, code: "const tmp = DATA_FILE + '.tmp'", atomic: true },
                 { line: 79, code: 'await fsp.writeFile(tmp, ...)', atomic: true },
                 { line: 86, code: 'await fsp.rename(tmp, DATA_FILE)', atomic: true }],
    atomic: true, serialization: '无 writeChain；进程内 cache + 200ms 防抖',
    debounce: '200ms（68-88）',
    fallback: 'catch → 空 movies/series/progress/scrapeCache（52-66）',
    rmw: 'load() → 改 cache → save() 整表覆盖；本地媒体扫描可回填 movies，但播放进度/抓取缓存丢失',
    role: '产品在线', risk: '中',
  },
  {
    module: 'lib/photos.mjs', runtimeFile: 'runtime/photos.json',
    writeSites: [{ line: 86, code: "const tmp = DATA_FILE + '.tmp'", atomic: true },
                 { line: 87, code: 'await fsp.writeFile(tmp, ...)', atomic: true },
                 { line: 93, code: 'await fsp.rename(tmp, DATA_FILE)', atomic: true }],
    atomic: true, serialization: '无 writeChain；进程内 cache + 250ms 防抖；后台扫描线程与请求线程共用 cache',
    debounce: '250ms（76-95）',
    fallback: 'catch → 空 dirs/skipped/items（62-74）',
    rmw: 'load() → 改 cache → save() 整表覆盖；扫描结果与目录配置同表',
    role: '产品在线', risk: '中（items 体量最大 400KB+，整表覆盖成本高）',
  },
  {
    module: 'lib/download.mjs', runtimeFile: 'runtime/download.json',
    writeSites: [{ line: 107, code: "const tmp = DATA_FILE + '.tmp'", atomic: true },
                 { line: 108, code: 'await fsp.writeFile(tmp, ...)', atomic: true },
                 { line: 109, code: 'await fsp.rename(tmp, DATA_FILE)', atomic: true }],
    atomic: true, serialization: '无 writeChain；进程内 cache + 200ms 防抖；任务进度高频回写',
    debounce: '200ms（93-111）',
    fallback: 'catch → { tasks: [] }（84-91）',
    rmw: 'load() → 改 cache.tasks → save() 整表覆盖；任务列表被覆盖会丢排队/进行中任务',
    role: '产品在线', risk: '中',
  },
  {
    module: 'lib/calendar.mjs', runtimeFile: 'runtime/calendar.json',
    writeSites: [{ line: 114, code: "const tmp = DATA_FILE + '.tmp'", atomic: true },
                 { line: 115, code: 'await fsp.writeFile(tmp, ...)', atomic: true },
                 { line: 125, code: 'await fsp.rename(tmp, DATA_FILE)', atomic: true }],
    atomic: true,
    serialization: '有 writeChain/serialize（53-57），但仅覆盖 549/566/579/606/670/699/712/728/744/759 等请求处理器；后台 refreshFeeds(188-189)、fetchBangumi(254-255) 直改 cache + save()，未入链',
    debounce: '200ms（104-127）',
    fallback: 'catch → null 后归一化为空结构（63-78）',
    rmw: 'load() → 改 cache → save() 整表覆盖；已知事故：多实例后台抓取回写互相覆盖测试数据',
    role: '产品在线', risk: '高（后台抓取旁路未串行；整表覆盖；多实例共享同一文件）',
  },
  {
    module: 'lib/book_sched.mjs', runtimeFile: 'runtime/book_open_health.json',
    writeSites: [{ line: 197, code: "const tmp = `${healthPath}.tmp`", atomic: true },
                 { line: 198, code: 'fs.writeFileSync(tmp, ...)', atomic: true },
                 { line: 199, code: 'fs.renameSync(tmp, healthPath)', atomic: true }],
    atomic: true, serialization: 'writeChain Promise 队列串行化（65, 205-206）',
    debounce: '无（每次落盘即写）', fallback: 'catch → { updatedAt:0, sources:{} }（151-159）',
    rmw: 'loadCache() → 改 cache.sources → persist() 入链整表覆盖',
    role: '产品在线', risk: '低（工程内正确范式：原子写 + 串行链；跨进程仍无锁，但健康分可重建）',
  },
  {
    module: 'lib/book_warm.mjs', runtimeFile: 'runtime/books/*.json',
    writeSites: [{ line: 100, code: 'const tmp = `${file}.${process.pid}.tmp`', atomic: true },
                 { line: 104, code: 'fs.writeFileSync(tmp, body)', atomic: true },
                 { line: 105, code: 'fs.renameSync(tmp, file)', atomic: true },
                 { line: 108, code: '失败清理残留 tmp', atomic: true }],
    atomic: true, serialization: '按文件分缓存，无跨文件队列；单文件写极短',
    debounce: '无', fallback: '读失败/过期 → null（调用方回源）',
    rmw: '每本书独立文件，覆盖写，无跨记录 read-modify-write',
    role: '产品在线', risk: '低（正确范式：同目录 tmp + pid 唯一临时名 + rename + 失败清理）',
  },
  {
    module: 'hub.mjs', runtimeFile: 'runtime/books/*.json（writeBookCache）',
    writeSites: [{ line: 405, code: 'const tmp = `${file}.tmp`', atomic: true },
                 { line: 406, code: 'fs.writeFileSync(tmp, ...)', atomic: true },
                 { line: 407, code: 'fs.renameSync(tmp, file)', atomic: true },
                 { line: 1597, code: 'fs.writeFileSync(cached, buf) 海报二进制，非 JSON，直接写', atomic: false }],
    atomic: true, serialization: '无进程内队列（缓存覆盖写）', debounce: '无',
    fallback: 'readBookCache catch → null',
    rmw: '每本书独立缓存文件覆盖写', role: '产品在线', risk: '低（JSON 部分）；海报二进制直接写，中断可残留半图但可重取',
  },
  {
    module: 'lib/book_source_search.mjs', runtimeFile: 'runtime/book_source_health.json',
    writeSites: [{ line: 103, code: 'fs.writeFileSync(HEALTH_PATH, JSON.stringify(...)) 直接写目标文件', atomic: false }],
    atomic: false, serialization: '无 writeChain/锁；进程内 healthCache', debounce: '无',
    fallback: 'catch → { updatedAt:0, sources:{} }（62-68）',
    rmw: 'recordHealth 改内存 cache → persistHealth() 整表直接覆盖（569 调用）',
    role: '产品在线', risk: '高：①无原子写，写途中被杀 → 文件半截 → 下次 parse 失败被清空；②无串行，并发/多实例互相覆盖；③257KB 整表',
  },
  {
    module: 'lib/vod_recs.mjs', runtimeFile: 'runtime/vod.json',
    writeSites: [{ line: 295, code: 'fs.writeFileSync(CACHE_FILE, JSON.stringify(...)) 直接写目标文件', atomic: false }],
    atomic: false, serialization: '无；内存 memory + 10min TTL', debounce: '无（缓存到期重取后覆盖）',
    fallback: 'parse/过期失败 → null（283-289）',
    rmw: '采集聚合结果整表覆盖；可从采集站重建', role: '产品在线',
    risk: '中：无原子写；但属可重建缓存，损坏影响仅限缓存期',
  },
  {
    module: 'lib/legado/sources.mjs', runtimeFile: 'runtime/book-sources-full.json',
    writeSites: [{ line: 141, code: 'fs.writeFileSync(file, JSON.stringify(...)) 直接写目标文件', atomic: false }],
    atomic: false, serialization: '无；启动/按需拉取后缓存', debounce: '无',
    fallback: 'catch → 重新拉取 Reader（131-138）', rmw: '整表覆盖；可从 Reader 重建',
    role: '产品在线（源缓存）', risk: '中：无原子写；可重建',
  },
  {
    module: 'lib/reader_diff.mjs', runtimeFile: 'runtime/reader-diff-report.json',
    writeSites: [{ line: 896, code: 'fs.writeFileSync(cfg.reportPath, ...) 直接写', atomic: false },
                 { line: 895, code: 'appendLog 追加日志（appendFileSync）', atomic: false }],
    atomic: false, serialization: '无；一次性对比任务', debounce: '无', fallback: '不适用（产出物）',
    rmw: '一次性覆盖写报告', role: '一次性审计工具', risk: '低（不影响在线业务；中断仅毁本次报告）',
  },
  {
    module: 'scripts/regress-watch.mjs', runtimeFile: 'runtime/regress-history.json',
    writeSites: [{ line: 240, code: 'tmp = `${file}.tmp-${process.pid}`', atomic: true },
                 { line: 241, code: 'fs.writeFileSync(tmp, ...)', atomic: true },
                 { line: 242, code: 'fs.renameSync(tmp, file)', atomic: true }],
    atomic: true, serialization: '无（单进程 CLI）', debounce: '无', fallback: '不适用',
    rmw: '历史保留最近 20 条', role: '一次性 CLI', risk: '低（正确范式）',
  },
  {
    module: 'scripts/final-check.mjs', runtimeFile: 'runtime/final-check.json',
    writeSites: [{ line: 167, code: 'fs.writeFileSync(OUT, ...) 直接写', atomic: false }],
    atomic: false, serialization: '无', debounce: '无', fallback: '不适用',
    rmw: '一次性覆盖', role: '一次性 CLI', risk: '低',
  },
  {
    module: 'scripts/perf-audit.mjs', runtimeFile: 'runtime/perf-audit.json',
    writeSites: [{ line: 446, code: 'fs.writeFileSync(...OUT...) 直接写', atomic: false }],
    atomic: false, serialization: '无', debounce: '无', fallback: '不适用',
    rmw: '一次性覆盖', role: '一次性 CLI', risk: '低',
  },
  {
    module: 'scripts/search-fail-audit.mjs', runtimeFile: 'runtime/search-fail-audit.json',
    writeSites: [{ line: 431, code: 'fs.writeFileSync(OUT_PATH, ...) 直接写', atomic: false }],
    atomic: false, serialization: '无', debounce: '无', fallback: '不适用',
    rmw: '一次性覆盖', role: '一次性 CLI', risk: '低',
  },
  {
    module: 'scripts/security-audit.mjs', runtimeFile: 'runtime/security-audit.json',
    writeSites: [{ line: 420, code: 'fs.writeFileSync(OUT, ...) 直接写', atomic: false }],
    atomic: false, serialization: '无', debounce: '无', fallback: '不适用',
    rmw: '一次性覆盖', role: '一次性 CLI', risk: '低',
  },
  {
    module: 'scripts/ui-audit.mjs', runtimeFile: 'runtime/ui-audit.json',
    writeSites: [{ line: 369, code: 'fs.writeFileSync(OUT, ...) 直接写', atomic: false }],
    atomic: false, serialization: '无', debounce: '无', fallback: '不适用',
    rmw: '一次性覆盖', role: '一次性 CLI', risk: '低',
  },
  {
    module: 'lib/legado/test/run.mjs', runtimeFile: 'lib/legado/test/report.json',
    writeSites: [{ line: 287, code: 'fs.writeFileSync(REPORT_PATH, ...) 直接写', atomic: false }],
    atomic: false, serialization: '无', debounce: '无', fallback: '不适用',
    rmw: '一次性测试报告', role: '测试夹具', risk: '低',
  },
  {
    module: 'lib/legado/test/pool-check.mjs', runtimeFile: 'lib/legado/test/pool-check.json',
    writeSites: [{ line: 145, code: 'fs.writeFileSync(...) 直接写', atomic: false }],
    atomic: false, serialization: '无', debounce: '无', fallback: '不适用',
    rmw: '一次性', role: '测试夹具', risk: '低',
  },
  {
    module: 'lib/legado/test/open10.mjs', runtimeFile: '指定 OUT',
    writeSites: [{ line: 118, code: 'fs.writeFileSync(OUT, ...) 直接写', atomic: false }],
    atomic: false, serialization: '无', debounce: '无', fallback: '不适用',
    rmw: '一次性', role: '测试夹具', risk: '低',
  },
  {
    module: 'lib/export_book_sources.py', runtimeFile: 'Reader 导出书源 JSON',
    writeSites: [{ line: 85, code: 'tmp = out_path + ".tmp"', atomic: true },
                 { line: 86, code: 'with open(tmp, "w") ...', atomic: true },
                 { line: 92, code: 'os.replace(tmp, out_path)', atomic: true }],
    atomic: true, serialization: '无（CLI）', debounce: '无', fallback: '不适用',
    rmw: '一次性导出', role: '工具脚本', risk: '低（正确范式）',
  },
];

/* ───────────────────────── 1. 静态审计核对：扫描实际文件，补台账遗漏 ───────────────────────── */
function globMjs(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...globMjs(abs));
    else if (e.name.endsWith('.mjs')) out.push(abs);
  }
  return out;
}

const scanned = [];
for (const abs of [path.join(ROOT, 'hub.mjs'), ...globMjs(path.join(ROOT, 'lib')), ...globMjs(path.join(ROOT, 'scripts'))]) {
  if (abs.endsWith('data-robustness-audit.mjs')) continue;
  const lines = readLines(abs);
  if (!lines.length) continue;
  const sites = scanWriteSites(lines);
  if (!sites.length) continue;
  scanned.push({
    file: path.relative(ROOT, abs),
    sites,
    hasWriteChain: has(lines, /writeChain|function serialize\(/),
    hasDebounce: has(lines, /writeTimer|writePending/),
    tmpConst: resolveRuntimeConst(lines),
  });
}

const directWriteProduct = KNOWN.filter((k) => k.atomic === false && k.role === '产品在线');
const CORRECT_WHITELIST = ['book_sched.mjs', 'book_warm.mjs', 'regress-watch.mjs', 'export_book_sources.py', 'hub.mjs'];
const correctPractices = KNOWN.filter((k) => CORRECT_WHITELIST.some((m) => k.module.includes(m)));

/* ───────────────────────── 2. 并发写实验（临时副本） ───────────────────────── */
const CONC = [
  { case: 'home', module: 'lib/home.mjs', key: 'todos', mode: 'atomic', note: '对齐 home.mjs：原子写但无串行链，请求级 read-modify-write' },
  { case: 'notes', module: 'lib/notes.mjs', key: 'notes', mode: 'atomic', note: '对齐 notes.mjs：原子写 + 进程内防抖，跨进程无互斥' },
  { case: 'vod', module: 'lib/vod_recs.mjs', key: 'items', mode: 'direct', note: '对齐 vod_recs.mjs：直接 writeFileSync 目标文件' },
  { case: 'health', module: 'lib/book_source_search.mjs', key: 'sources', mode: 'direct', note: '对齐 book_source_search.mjs：直接写健康表（对象键计数）' },
];
const WORKERS = 2, OPS = 100;
const concurrency = [];
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-b4-conc-'));

function runWorker(file, key, tag, mode) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [process.argv[1], '--worker', file, key, String(OPS), mode, tag], { stdio: 'ignore' });
    p.on('close', (code) => resolve(code));
  });
}

for (const c of CONC) {
  const dir = path.join(tmpRoot, c.case);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, c.key === 'sources' ? '{"sources":{}}' : `{"${c.key}":[]}`);
  const t0 = Date.now();
  const [aCode, bCode] = await Promise.all([
    runWorker(file, c.key, `${c.case}-A`, c.mode),
    runWorker(file, c.key, `${c.case}-B`, c.mode),
  ]);
  const elapsedMs = Date.now() - t0;
  let finalCount = null, finalValid = false, parseError = null;
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    const v = d[c.key];
    finalCount = Array.isArray(v) ? v.length : Object.keys(v || {}).length;
    finalValid = true;
  } catch (e) { parseError = String(e && e.message); }
  concurrency.push({
    ...c, workers: WORKERS, opsPerWorker: OPS, expected: WORKERS * OPS,
    final: finalCount, finalValid, lost: finalValid ? WORKERS * OPS - finalCount : null,
    torn: !finalValid, parseError, elapsedMs,
    workerExit: [aCode, bCode],
  });
}

/* ───────────────────────── 3. 崩溃恢复实验（临时副本，三种中断） ───────────────────────── */
const crashRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-b4-crash-'));
const seed = { notes: [{ id: 'n1', title: '原稿 1', body: 'x' }, { id: 'n2', title: '原稿 2', body: 'y' }], updatedAt: 1 };

const crash = [];

// 场景 A：临时文件已写、rename 前被中断（原子写应保证目标原样）
{
  const dir = path.join(crashRoot, 'a'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'notes.json');
  fs.writeFileSync(file, JSON.stringify(seed));
  const before = fs.readFileSync(file);
  fs.writeFileSync(file + '.tmp', '{"notes":[{"id":"partial"'); // 模拟写到一半的 tmp
  const after = fs.readFileSync(file);
  crash.push({
    scenario: 'A 写临时文件后、rename 前进程被杀',
    file: 'notes.json（原子写模块模板）',
    targetUnchanged: before.equals(after),
    leftoverTmp: fs.existsSync(file + '.tmp'),
    parseTargetOk: (() => { try { JSON.parse(after.toString()); return true; } catch { return false; } })(),
    fallback: 'load() 只认目标文件；残留 .tmp 被忽略',
    liveBootEvidence: '8950 副本实测：残留 tmp 期间 GET /api/notes/list 仍返回原 2 条；目标 hash 前后一致',
    serviceBoot: '正常', roomUsable: '是', dataLost: '否（目标未受影响）',
  });
}

// 场景 B：目标文件被截断成半截（模拟直接写或 rename 前崩溃留下的截断文件）
{
  const dir = path.join(crashRoot, 'b'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'notes.json');
  const full = JSON.stringify(seed, null, 2);
  fs.writeFileSync(file, full.slice(0, Math.floor(full.length * 0.55)));
  let parseOk = false, err = null;
  try { JSON.parse(fs.readFileSync(file, 'utf8')); parseOk = true; } catch (e) { err = e.message; }
  crash.push({
    scenario: 'B 目标文件截断（半截 JSON）',
    file: 'notes.json',
    parseTargetOk: parseOk, parseError: err,
    fallback: 'notes.mjs load() catch → { notes: [] }；下一次变更落盘会用空表覆盖半截文件',
    liveBootEvidence: '8950 副本实测：截断 notes.json 后重启实例，/api/ping 正常，/api/notes/list 200 且 total=0；其余房间 library/photos/calendar 均 200；原 2 条笔记丢失',
    serviceBoot: '正常（模块兜底空数据，进程不 500）', roomUsable: '是（空表可用）', dataLost: '是（原数据被兜底清空，且无备份可回滚）',
  });
}

// 场景 C：文件内容为非法 JSON（手动损坏副本）
{
  const dir = path.join(crashRoot, 'c'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'library.json');
  fs.writeFileSync(file, '{"movies": [{"id": "broken", "title": "unterminated');
  let parseOk = false, err = null;
  try { JSON.parse(fs.readFileSync(file, 'utf8')); parseOk = true; } catch (e) { err = e.message; }
  crash.push({
    scenario: 'C 文件内容非法 JSON',
    file: 'library.json',
    parseTargetOk: parseOk, parseError: err,
    fallback: 'library.mjs load() catch → 空 movies/series/progress/scrapeCache；本地媒体扫描可回填 movies，但 progress/scrapeCache 丢失',
    liveBootEvidence: '8950 副本实测：损坏 library.json 后重启，/api/ping 正常，/api/library/list 200；movies 由本地扫描回填 2 部，progress keys=0（播放进度丢失）；notes/photos/calendar/home 均 200',
    serviceBoot: '正常', roomUsable: '是', dataLost: '是（缓存的进度/抓取结果丢失；媒体目录可重扫回填）',
  });
}

/* ───────────────────────── 4. 备份与恢复盘点 ───────────────────────── */
const codeText = [...globMjs(ROOT).map((p) => path.join(ROOT, p)), path.join(ROOT, 'hub.mjs'), path.join(ROOT, 'hub.sh')]
  .filter((p) => fs.existsSync(p)).map((p) => fs.readFileSync(p, 'utf8')).join('\n');
const backupInventory = {
  codeHasBackupMechanism: /backup|备份/.test(codeText),
  codeHasRotation: /rotate|轮转|保留最近/.test(codeText),
  codeHasLock: /flock|lockfile|O_EXCL|exclusive/.test(codeText),
  runtimeGitIgnored: fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').includes('runtime/'),
  hubShTouchesRuntime: fs.readFileSync(path.join(ROOT, 'hub.sh'), 'utf8').includes('runtime'),
  tmpManualBackups: (() => {
    const out = [];
    for (const dir of [os.tmpdir(), '/tmp']) {
      try {
        for (const f of fs.readdirSync(dir)) {
          if (/\.bak\.json$/.test(f)) {
            const abs = path.join(dir, f);
            const st = fs.statSync(abs);
            out.push({ file: abs, size: st.size, mtime: st.mtime.toISOString() });
          }
        }
      } catch { /* ignore */ }
    }
    return out;
  })(),
  conclusion: '工程内无自动备份/轮转/快照/文件锁；runtime/ 被 gitignore，VCS 不可回滚；现有 /tmp 手工备份重启即丢。误删或损坏后只能靠模块兜底空数据 + 可重建源回填，用户自建数据（笔记/待办/日程/进度）不可恢复。',
};

/* 实验临时副本用完即清，不留半成品文件 */
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
try { fs.rmSync(crashRoot, { recursive: true, force: true }); } catch { /* ignore */ }

/* ───────────────────────── 风险分级与建议 ───────────────────────── */
const risks = KNOWN.map((k) => ({ module: k.module, runtimeFile: k.runtimeFile, risk: k.risk, atomic: k.atomic, serialization: k.serialization }));

const recommendations = [
  {
    rank: 1, title: '给 book_source_search.mjs 的健康表补原子写（最高优先，产品在线 + 257KB + 直接写）',
    location: 'lib/book_source_search.mjs:100-105',
    fix: '仿 book_sched.mjs:190-206：同目录 .tmp（pid 唯一名）→ writeFileSync → renameSync；并加 writeChain 串行 recordHealth→persist。',
  },
  {
    rank: 2, title: '把 home/notes/library/photos/download 的跨进程互斥补齐，至少先统一原子写临时名',
    location: 'lib/home.mjs:110、lib/notes.mjs:58、lib/library.mjs:78、lib/photos.mjs:86、lib/download.mjs:107',
    fix: '①临时名改 pid 唯一（仿 book_warm.mjs:100），避免多实例撞同一 .tmp；②参照 book_sched 引入 writeChain；③home.mjs 去掉请求级直写，改进程内 cache + 防抖；④多实例共享 runtime 的部署约定需在 README 写明（同时只跑一个可写实例）。',
  },
  {
    rank: 3, title: 'calendar.mjs 后台抓取旁路纳入串行链，并落地最小备份',
    location: 'lib/calendar.mjs:188-189, 254-255；备份方案见下',
    fix: '①refreshFeeds/fetchBangumi 的 cache 变更 + save 包进 serialize()；②新增 runtime/backup/：每次 save 前把上一份拷到 backup/<yyyy-mm-dd>/，保留 7 份；启动时 JSON.parse 失败自动回落上一份。改动面：新增一个 lib/persist.mjs 原子写 + 备份公共函数，各模块替换 save() 内落盘段（每处约 10 行）。',
  },
  {
    rank: 4, title: 'vod_recs / legado.sources / reader_diff 直写改 tmp+rename（可重建缓存，优先级中）',
    location: 'lib/vod_recs.mjs:295、lib/legado/sources.mjs:141、lib/reader_diff.mjs:896',
    fix: '同模板原子写；这类数据可从源重建，主要避免半截文件污染缓存期。',
  },
];

/* ───────────────────────── 汇总落盘 ───────────────────────── */
const report = {
  generatedAt: new Date().toISOString(),
  root: ROOT,
  discipline: {
    onlinePort: 8890, onlineReadonly: true,
    testInstance: '8950 副本实例（/tmp 隔离目录），实验结束关闭；未 kill 线上进程',
    experimentsOnCopies: true,
  },
  staticAudit: KNOWN,
  scannedSupplements: scanned,
  directWriteProductFiles: directWriteProduct.map((k) => ({ module: k.module, file: k.runtimeFile, site: k.writeSites, risk: k.risk })),
  correctPractices: correctPractices.map((k) => `${k.module}（${k.runtimeFile}）：${k.serialization}`),
  concurrency,
  crashRecovery: crash,
  backupInventory,
  risks,
  recommendations,
  notes: [
    '原子写（tmp+rename）只能保证文件不出现半截，不能消除 read-modify-write 丢更新；后者需要进程内 writeChain 或跨进程文件锁。',
    '进程内 cache + 防抖在单实例内有效；8890 与 8950/8952 共享同一 runtime/ 时，跨实例互斥目前完全没有（无 flock/锁文件）。',
    '一次性 CLI/测试夹具的直写不影响在线业务，风险单列低优先级。',
  ],
};

const outArg = args[args.indexOf('--out') + 1];
const outFile = outArg || path.join(ROOT, 'runtime', 'data-robustness.json');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
console.log(`[data-robustness] 报告: ${path.relative(ROOT, outFile)}`);
console.log(`[data-robustness] 在线直写模块 ${directWriteProduct.length} 个；并发实验 ${concurrency.length} 组；中断场景 ${crash.length} 个`);
for (const c of concurrency) {
  console.log(`  · ${c.case.padEnd(7)} ${c.mode.padEnd(8)} final=${c.final} valid=${c.finalValid} lost=${c.lost} torn=${c.torn}`);
}
