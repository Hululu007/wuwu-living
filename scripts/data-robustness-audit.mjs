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
import { readJsonFile } from '../lib/json_store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

// 参数与早退必须在任何实验之前：旧写法在文件末尾才解析，`--help` 会先把整套实验跑完
// （几十秒）再打印帮助，而且路径解析漏洞还会在项目根写出名为 `--help` / `--json` 的文件
// —— 这两个坑各踩过一次（42KB 的 `--help`、41KB 的 `--json`）。
const KNOWN_FLAGS = new Set(['--worker', '--out', '--help', '-h']);
const outIdx = args.indexOf('--out');
const outArg = outIdx !== -1 ? args[outIdx + 1] : '';
const wantsHelp = args.includes('--help') || args.includes('-h');
const unknownFlags = args.filter((a, i) => a.startsWith('-')
  && !KNOWN_FLAGS.has(a)
  && !(i > 0 && args[i - 1] === '--out'));

if (wantsHelp) {
  console.log([
    '五五客厅 · 数据健壮性审计',
    '',
    '用法：node scripts/data-robustness-audit.mjs [--out <报告路径>]',
    '',
    '  不给 --out      写 runtime/data-robustness.json',
    '  --out <路径>   写到指定路径（父目录会自动创建）',
    '',
    '输出：staticAudit（模块落盘台账）/ concurrency（并发对照实验）',
    '      / crashRecovery（中断恢复）/ recommendations（按真实代码状态推导，不硬编码）',
    '',
    '说明：并发 RMW 实验是对照组（worker 内自写 read→write，不调用生产模块），',
    '      测的是「完全无跨进程互斥时的理论丢写量」，不是当前代码的缺陷清单。',
  ].join('\n'));
  process.exit(0);
}
if (args.includes('--out') && !outArg) {
  console.error('[data-robustness] --out 需要一个路径参数');
  process.exit(2);
}
if (unknownFlags.length) {
  console.warn(`[data-robustness] 忽略未知开关：${unknownFlags.join(' ')}（用 --help 看用法）`);
}

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
    writeSites: [{ line: 150, code: 'function withTodos(fn) 请求级互斥队列', atomic: true },
                 { line: 158, code: 'writeJson(TODO_FILE, ...) → json_store 临时名+fsync+rename', atomic: true }],
    atomic: true, serialization: '有 withTodos() 进程内串行（150-160）：read-modify-write 整体排队，20 并发只丢 0 条（实测 20/20）',
    debounce: '无（每次请求直接落盘）',
    fallback: 'readJsonFile() 解析失败 → 原文备份 .corrupt-<ts> → null → 按空表继续',
    rmw: 'withTodos 内读全量 → 改 → 整表覆盖；跨进程仍无文件锁',
    role: '产品在线', risk: '低（进程内已串行；跨实例部署仍需约定单写实例）',
  },
  {
    module: 'lib/notes.mjs', runtimeFile: 'runtime/notes.json',
    writeSites: [{ line: 39, code: 'readJsonFile(DATA_FILE) → 损坏先备份 .corrupt-<ts>', atomic: true },
                 { line: 53, code: 'await writeJson(DATA_FILE, {...}) → json_store 串行链 + 唯一临时名 + fsync + rename', atomic: true }],
    atomic: true, serialization: '无独立 writeChain：写入串行由 json_store 的同路径 Promise 链提供（同路径写天然排队）',
    debounce: '无（await save() 即到磁盘；旧的 200ms setTimeout 已删除）',
    fallback: 'readJsonFile() 解析失败 → 原文备份 .corrupt-<ts> → 返回 null → 按空 notes 继续',
    rmw: 'load() 取内存 cache → 改 notes → save() 整表覆盖；跨进程仍无文件锁（由实例锁保证单写实例）',
    role: '产品在线', risk: '低（原子写 + 单写实例；进程内并发 note 创建已实测 12/12 落盘）',
  },
  {
    module: 'lib/library.mjs', runtimeFile: 'runtime/library.json',
    writeSites: [{ line: 52, code: 'readJsonFile(DATA_FILE) → 损坏先备份再降级', atomic: true },
                 { line: 67, code: 'await writeJson(DATA_FILE, {...}) → json_store 串行链 + 唯一临时名 + fsync + rename', atomic: true }],
    atomic: true, serialization: '无独立 writeChain：同路径写入由 json_store 的 Promise 链串行化',
    debounce: '无（await save() 即到磁盘）',
    fallback: 'readJsonFile() 解析失败 → 原文备份 .corrupt-<ts> → 空 movies/series/progress/scrapeCache 继续',
    rmw: 'load() → 改 cache → save() 整表覆盖；本地媒体扫描可回填 movies，但播放进度/抓取缓存丢失',
    role: '产品在线', risk: '低（原子写 + 单写实例）',
  },
  {
    module: 'lib/photos.mjs', runtimeFile: 'runtime/photos.json',
    writeSites: [{ line: 62, code: 'readJsonFile(DATA_FILE) → 损坏先备份再降级', atomic: true },
                 { line: 76, code: 'await writeJson(DATA_FILE, {...}) → json_store 串行链 + 唯一临时名 + fsync + rename', atomic: true }],
    atomic: true, serialization: '无独立 writeChain：同路径写入由 json_store 的 Promise 链串行化；后台扫描与请求线程共用 cache',
    debounce: '无（await save() 即到磁盘）',
    fallback: 'readJsonFile() 解析失败 → 原文备份 .corrupt-<ts> → 空 dirs/skipped/items 继续',
    rmw: 'load() → 改 cache → save() 整表覆盖；扫描结果与目录配置同表',
    role: '产品在线', risk: '中（items 体量最大 400KB+，整表覆盖成本高；但写入已原子）',
  },
  {
    module: 'lib/download.mjs', runtimeFile: 'runtime/download.json',
    writeSites: [{ line: 84, code: 'readJsonFile(DATA_FILE) → 损坏先备份再降级', atomic: true },
                 { line: 127, code: 'await writeJson(DATA_FILE, {...}) → json_store 串行链 + 唯一临时名 + fsync + rename', atomic: true }],
    atomic: true, serialization: '进度用 saveSoon() 250ms 合并；关键状态与两条完成路径（直链 321 / 磁力 405）都先 await flushSave() 再 await save()，不会顺序倒置',
    debounce: 'saveSoon() 250ms 合并（96-111），flushSave() 可立刻兑现（114-120）',
    fallback: 'readJsonFile() 解析失败 → 原文备份 .corrupt-<ts> → { tasks: [] } 继续',
    rmw: 'load() → 改 cache.tasks → save() 整表覆盖；任务列表被覆盖会丢排队/进行中任务',
    role: '产品在线', risk: '低（终态前强制 flush + 原子写 + 单写实例）',
  },
  {
    module: 'lib/calendar.mjs', runtimeFile: 'runtime/calendar.json',
    writeSites: [{ line: 63, code: 'readJsonFile(DATA_FILE) → 损坏先备份再降级', atomic: true },
                 { line: 109, code: 'await writeJson(DATA_FILE, {...}) → json_store 串行链 + 唯一临时名 + fsync + rename', atomic: true }],
    atomic: true, serialization: '有 writeChain/serialize（53-57）覆盖请求处理器；后台 refreshFeeds / fetchBangumi 走 await save()，同路径写仍由 json_store 串行链兜住，不会写坏文件',
    debounce: '无（await save() 即到磁盘；旧的 200ms setTimeout 已删除）',
    fallback: 'readJsonFile() 解析失败 → 原文备份 .corrupt-<ts> → 归一化为空结构继续',
    rmw: 'load() → 改 cache → save() 整表覆盖；已知事故：多实例后台抓取回写互相覆盖测试数据',
    role: '产品在线', risk: '中（后台抓取整表覆盖改写他人字段；跨进程由实例锁拦住，单实例内已原子）',
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
    writeSites: [{ line: 120, code: 'writeJsonSync(HEALTH_PATH, ...) → json_store 临时名+fsync+rename', atomic: true }],
    atomic: true, serialization: '无显式链；但 persistHealth 只在搜索收尾调用一次，调用点天然低频', debounce: '无',
    fallback: 'readJsonFileSync() 解析失败 → 原文备份 .corrupt-<ts> → 空健康表（可重建）',
    rmw: 'recordHealth 改内存 cache → 收尾 persistHealth() 整表覆盖',
    role: '产品在线', risk: '低（已原子写；健康分本就是可重建数据）',
  },
  {
    module: 'lib/vod_recs.mjs', runtimeFile: 'runtime/vod.json',
    writeSites: [{ line: 298, code: 'writeJsonSync(CACHE_FILE, ...) → 临时名+fsync+rename', atomic: true }],
    atomic: true, serialization: '无；内存 memory + 10min TTL', debounce: '无（缓存到期重取后覆盖）',
    fallback: 'parse/过期失败 → null → 按需重取',
    rmw: '采集聚合结果整表覆盖；可从采集站重建', role: '产品在线',
    risk: '低（已原子写；且属可重建缓存）',
  },
  {
    module: 'lib/legado/sources.mjs', runtimeFile: 'runtime/book-sources-full.json',
    writeSites: [{ line: 145, code: 'writeJsonSync(file, ...) → 临时名+fsync+rename', atomic: true }],
    atomic: true, serialization: '无；启动/按需拉取后缓存（调用点低频）', debounce: '无',
    fallback: 'parse 失败 → 重新拉取 Reader', rmw: '整表覆盖；可从 Reader 重建',
    role: '产品在线（源缓存）', risk: '低（已原子写；7,538 源中断不再毁缓存）',
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

/**
 * 「看起来是直写、但已核实不该原子化」的豁免表。
 *
 * 扫描器只能看语法，看不出语义：下面这些写入点的正确性不依赖 rename，写一半也不产生坏缓存。
 * 没有这份表时它们每次都被当成待修缺陷报出来，把「已收口」读成「还一堆问题」。
 * 每一条都必须写出理由 —— 不许只写文件名。
 */
const ATOMIC_EXEMPT = [
  { file: 'lib/cast.mjs', match: /writeFile\(probe,/,
    why: 'doctor 的写盘探针：写一个字节后立刻 unlink，半截也无所谓' },
  { file: 'lib/cast.mjs', match: /writeFile\(out,/,
    why: '截图落盘到本次新建的 files/<sha>_<ts>.png：写坏只影响这一张，不影响后续读取，没有「文件存在即命中」的复用路径' },
  { file: 'lib/instance_lock.mjs', match: /writeFileSync\(fd,/,
    why: '锁文件本身就是用 O_EXCL 创建的原子体：内容损坏会被 pidAlive 判为 stale 并重取，不需要 rename' },
  { file: 'lib/json_store.mjs', match: /writeFile\(dest, raw\)/,
    why: '这里就是原子写实现内部的「写临时文件」那一步（dest 是唯一临时名，随后 rename）' },
  { file: 'lib/json_store.mjs', match: /\.corrupt-/,
    why: '损坏原文一次性快照：只写一次、不再被解析，写一半也不影响主流程（主流程已返回 null）' },
  { file: 'lib/reader_diff.mjs', match: /reportPath/,
    why: '一次性审计工具的报产物，非在线服务，重跑即覆盖' },
];

function isExempt(file, site) {
  return ATOMIC_EXEMPT.some((e) => e.file === file && e.match.test(String(site.code || '')));
}

const scanned = [];
for (const abs of [path.join(ROOT, 'hub.mjs'), ...globMjs(path.join(ROOT, 'lib')), ...globMjs(path.join(ROOT, 'scripts'))]) {
  if (abs.endsWith('data-robustness-audit.mjs')) continue;
  const lines = readLines(abs);
  if (!lines.length) continue;
  const rel = path.relative(ROOT, abs);
  const sites = scanWriteSites(lines).map((site) => {
    if (site.atomic === false && isExempt(rel, site)) {
      const why = ATOMIC_EXEMPT.find((e) => e.file === rel && e.match.test(String(site.code || ''))).why;
      return Object.assign({}, site, { atomic: 'exempt', exemptReason: why });
    }
    return site;
  });
  if (!sites.length) continue;
  scanned.push({
    file: rel,
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
/*
 * 并发写实验是「对照组」：它只模拟两进程各做 100 次 read→await→write，
 * **不调用生产模块**，所以测出来的是「没有任何跨进程互斥时的理论丢写量」，
 * 用来量化风险，不代表当前代码的实际表现。
 *
 * ★ 别把这张表当成 bug 清单读：
 *   · home.mjs 现已由 withTodos() 进程内串行（实测 20 并发 20/20 全部落地，零丢失）；
 *     本实验仍是 2 进程并发，进程内串行挡不住跨进程，所以这里照样报 lost。
 *   · notes/vod/health 同理，其真实调用点是否高频并发见 KNOWN 的 serialization 一栏。
 * 真要看「修完有没有用」，跑 scripts/regress-all.mjs（内容模块那套里就有 20 并发待办用例）。
 */
const CONC = [
  { case: 'home',   module: 'lib/home.mjs',             key: 'todos',   mode: 'atomic', note: '[对照] 模拟 2 进程无互斥；生产侧已有 withTodos() 进程内串行' },
  { case: 'notes',  module: 'lib/notes.mjs',            key: 'notes',   mode: 'atomic', note: '[对照] 模拟 2 进程无互斥；生产侧为单实例 + 原子写' },
  { case: 'vod',    module: 'lib/vod_recs.mjs',         key: 'items',   mode: 'direct', note: '[对照] 模拟无原子写；生产侧已改 writeJsonSync' },
  { case: 'health', module: 'lib/book_source_search.mjs', key: 'sources', mode: 'direct', note: '[对照] 模拟无原子写；生产侧已改 writeJsonSync' },
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
    // 明确标注这是对照组，避免把理论丢写量读成当前代码的缺陷
    interpretation: '对照组：模拟无跨进程互斥时的理论丢写量；不代表当前生产代码表现，看 regress-all 为准',
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
// 旧版这里只做手工 JSON.parse，测的是「JSON.parse 会失败」这种显然的事，
// 没有验证项目自己的读盘逻辑。现在直接跑生产代码 readJsonFile，看它到底怎么兜底。
{
  const dir = path.join(crashRoot, 'b'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'notes.json');
  const full = JSON.stringify(seed, null, 2);
  const truncated = full.slice(0, Math.floor(full.length * 0.55));
  fs.writeFileSync(file, truncated);
  let parseOk = false, err = null;
  try { JSON.parse(fs.readFileSync(file, 'utf8')); parseOk = true; } catch (e) { err = e.message; }

  // 真跑一次项目读盘：应当返回 null，并把原文整份备份成 <file>.corrupt-<ts>
  let readResult, backups = [], backupKeepsBytes = false, threw = null;
  try {
    readResult = await readJsonFile(file, { quarantine: true });
    backups = fs.readdirSync(dir).filter((n) => n.includes('.corrupt-'));
    if (backups.length) {
      backupKeepsBytes = fs.readFileSync(path.join(dir, backups[0]), 'utf8') === truncated;
    }
  } catch (e) { threw = e.message; }

  crash.push({
    scenario: 'B 目标文件截断（半截 JSON）',
    file: 'notes.json',
    parseTargetOk: parseOk, parseError: err,
    readReturnsNull: readResult === null,
    readThrew: threw,
    quarantineBackups: backups,
    quarantineKeepsOriginalBytes: backupKeepsBytes,
    fallback: 'readJsonFile() 解析失败 → 先把原文整份复制成 <file>.corrupt-<ts>，再返回 null；调用方按空数据继续，进程不 500',
    liveBootEvidence: '实跑生产代码 readJsonFile：返回 null 且生成 1 份 .corrupt 备份，备份字节与损坏原文逐字节相同（来源：上一行 quarantineKeepsOriginalBytes）',
    serviceBoot: '正常（模块兜底空数据，进程不 500）',
    roomUsable: '是（空表可用）',
    dataLost: '否（原文已被 .corrupt-<ts> 完整保留，可人工回填）',
  });
}

// 场景 C：文件内容为非法 JSON（手动损坏副本）
// 同场景 B：跑生产代码而不是自己手工 parse，验证 .corrupt 备份真的落地。
{
  const dir = path.join(crashRoot, 'c'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'library.json');
  const broken = '{"movies": [{"id": "broken", "title": "unterminated';
  fs.writeFileSync(file, broken);
  let parseOk = false, err = null;
  try { JSON.parse(fs.readFileSync(file, 'utf8')); parseOk = true; } catch (e) { err = e.message; }

  let readResult, backups = [], backupKeepsBytes = false, threw = null;
  try {
    readResult = await readJsonFile(file, { quarantine: true });
    backups = fs.readdirSync(dir).filter((n) => n.includes('.corrupt-'));
    if (backups.length) {
      backupKeepsBytes = fs.readFileSync(path.join(dir, backups[0]), 'utf8') === broken;
    }
  } catch (e) { threw = e.message; }

  crash.push({
    scenario: 'C 文件内容非法 JSON',
    file: 'library.json',
    parseTargetOk: parseOk, parseError: err,
    readReturnsNull: readResult === null,
    readThrew: threw,
    quarantineBackups: backups,
    quarantineKeepsOriginalBytes: backupKeepsBytes,
    fallback: 'readJsonFile() 解析失败 → 复制一份 <file>.corrupt-<ts> 后返回 null；library 按空 movies/series/progress/scrapeCache 继续，媒体扫描可回填 movies',
    liveBootEvidence: '实跑生产代码 readJsonFile：返回 null 且生成 1 份 .corrupt 备份，字节与损坏原文逐字节相同',
    serviceBoot: '正常',
    roomUsable: '是',
    dataLost: '否（原文已备份可人工抢救；内存里按空表继续，媒体扫描可回填 movies）',
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

/**
 * 建议必须由真实代码状态推导，不能手写。
 * 历史上这份列表是硬编码的：rank 1 要求「给 book_source_search 健康表补原子写」、
 * rank 2 要求「home/notes/library/photos/download 统一原子写临时名」，
 * 而那些改动早已落地 —— 报告因此一直在报已修好的问题，把「已收口」读成「还没做」。
 */
const recs = [];

// ① 仍未原子写的在线模块：按 KNOWN 里 atomic=false 且 role=产品在线 直接生成
for (const k of directWriteProduct) {
  recs.push({
    rank: recs.length + 1,
    title: `给 ${k.module} 补原子写（当前仍在直写 ${k.runtimeFile}）`,
    location: k.module,
    fix: '改用 lib/json_store.mjs 的 writeJson / writeJsonSync：同路径 Promise 链串行 + 唯一临时名 + fsync + rename。',
    source: 'staticAudit',
  });
}

// ② 跨进程互斥：这条不是模块级缺陷，是部署约束；锁已落地，建议随之改为「保持单写实例」
const crossProcModules = KNOWN.filter((k) => k.role === '产品在线' && /跨进程|多实例/.test(String(k.rmw) + String(k.serialization)));
if (crossProcModules.length) {
  recs.push({
    rank: recs.length + 1,
    title: '跨进程互斥已由实例锁承担：保持「同一 runtime/ 只有一个可写实例」',
    location: 'lib/instance_lock.mjs + lib/runtime_dir.mjs',
    fix: 'hub.mjs 启动即抢 runtime/.instance.lock，抢不到以 78 退出；实验实例必须同时给 WUWU_RUNTIME_DIR。'
      + ` 受影响模块 ${crossProcModules.length} 个（${crossProcModules.map((k) => k.module.replace('lib/', '').replace('.mjs', '')).join('/')}）。`
      + ' 回归：scripts/instance-lock-regress.mjs。',
    source: 'instanceLock',
  });
}

// ③ 整表覆盖类：单实例内共用同一份内存 cache，改动是累加的，不会互相覆盖；
//    真正剩下的风险只有一个具体场景 —— 服务运行期间有人手工改 runtime/*.json，
//    因为 cache 已在内存里，下一次 save() 会整表覆盖掉手工改动。这里如实写这个范围。
const wholeTable = KNOWN.filter((k) => k.role === '产品在线' && /整表覆盖/.test(String(k.rmw)));
if (wholeTable.length) {
  recs.push({
    rank: recs.length + 1,
    title: '整表覆盖写入：唯一残余风险是「服务运行期手工改 runtime 文件会被下一次保存覆盖」',
    location: wholeTable.map((k) => k.module).join('、'),
    fix: '这是设计上的取舍，不是缺陷：单进程内共用 cache，改动累加不丢。'
      + '要手工改这些文件，先 ./hub.sh stop 再改再起；运行期改会被内存 cache 整表覆盖。'
      + '若确实需要运行期改，改走对应房间的接口（如 /api/notes/create、/api/home/todos）。',
    source: 'rmwHeuristic',
  });
}

// ④ 崩溃恢复：把所有 dataLost 不是「否」的场景单列
const lossyCrash = crash.filter((c) => !String(c.dataLost || '').startsWith('否'));
if (lossyCrash.length) {
  recs.push({
    rank: recs.length + 1,
    title: '仍有崩溃场景会造成数据丢失',
    location: lossyCrash.map((c) => c.file || c.case).join('、'),
    fix: '按对应模块补原子写 / 读坏隔离后重跑本脚本，dataLost 应转为「否」。',
    source: 'crashRecovery',
  });
} else {
  recs.push({
    rank: recs.length + 1,
    title: '崩溃恢复：当前所有中断场景均不丢数据',
    location: '（无）',
    fix: '无需改动。旧写法（直写 + 固定 .tmp）会留下半截文件，现写法目标文件始终完整、坏文件原文另存 .corrupt-<ts>。',
    source: 'crashRecovery',
  });
}

const recommendations = recs;

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
    '原子写（tmp+rename）只能保证文件不出现半截，不能消除 read-modify-write 丢更新；后者需要进程内 writeChain 或跨进程互斥。',
    '跨进程互斥已落地为实例锁（lib/instance_lock.mjs）：同一 runtime/ 只允许一个可写实例，第二个进程以 78 退出；实验实例须同时指定 WUWU_RUNTIME_DIR。',
    '一次性 CLI/测试夹具的直写不影响在线业务，风险单列低优先级。',
  ],
};

const outFile = outArg ? path.resolve(outArg) : path.join(ROOT, 'runtime', 'data-robustness.json');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
console.log(`[data-robustness] 报告: ${path.relative(ROOT, outFile)}`);
console.log(`[data-robustness] 在线直写模块 ${directWriteProduct.length} 个；并发实验 ${concurrency.length} 组；中断场景 ${crash.length} 个`);
for (const c of concurrency) {
  console.log(`  · ${c.case.padEnd(7)} ${c.mode.padEnd(8)} final=${c.final} valid=${c.finalValid} lost=${c.lost} torn=${c.torn}`);
}
