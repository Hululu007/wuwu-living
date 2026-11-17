#!/usr/bin/env node
/**
 * 回归闸门（只诊断不修；不起任何 HTTP 实例，只跑一轮现有测试套件）。
 *
 * 用法：
 *   node scripts/regress-watch.mjs                  # 跑一轮 run.mjs → 逐源比对「最好基线」→ 闸门退出码
 *   node scripts/regress-watch.mjs --dry           # 不跑套件，只读现有 report.json 与基线比对
 *   node scripts/regress-watch.mjs --promote        # 人工确认后把当前结果提升为新基线
 *   node scripts/regress-watch.mjs --baseline f.json --report f.json
 *
 * 选项：
 *   --baseline <file>  显式基线（完整 report.json 或本工具快照；只读引用，不回写）
 *   --report <file>   当前报告路径（默认 lib/legado/test/report.json）
 *   --dry              只读现有报告，不调用套件
 *   --promote          强制把当前结果提升为新基线（默认基线文件 runtime/regress-baseline.json）
 *   --no-history      不追加历史（自测用）
 *
 * 基线策略：默认基线取「历史最好一次」runtime/regress-baseline.json；
 * 仅当本次通过数 ≥ 基线通过数时自动更新，一次坏掉的运行不会拉低基线。
 *
 * 退出码：
 *   0  无回归
 *   2  套件异常 / 报告缺失
 *   3  出现 newFail（上次 pass → 本次 fail）
 *   4  通过数低于基线（无 newFail 但整体回落，如源被剔除 / 未对齐源失败）
 *   5  通过数达标但 regex 覆盖低于基线（专项盯 regex）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = path.join(ROOT, 'lib', 'legado', 'test', 'run.mjs');
const DEFAULT_REPORT = path.join(ROOT, 'lib', 'legado', 'test', 'report.json');
const HISTORY_PATH = path.join(ROOT, 'runtime', 'regress-history.json');
const BASELINE_PATH = path.join(ROOT, 'runtime', 'regress-baseline.json');
const HISTORY_KEEP = 20;
const SUITE_TIMEOUT_MS = 15 * 60 * 1000; // 单轮上限，不循环压测

/* ───────────────────── 套件执行（一轮，SIGTERM 回收挂住的 worker 池） ───────────────────── */

function runSuite() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER], { cwd: ROOT });
    let settled = false;
    let markerFired = false;
    let stdoutBuf = '';

    const timer = setTimeout(() => finish(null, new Error(`套件超过 ${SUITE_TIMEOUT_MS / 1000}s 未完成`)), SUITE_TIMEOUT_MS);

    function finish(code, err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(code);
    }

    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      stdoutBuf += chunk.toString();
      if (!markerFired && /报告已写入/.test(stdoutBuf)) {
        markerFired = true;
        setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* 已退出 */ } }, 200);
      }
    });
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.on('error', (err) => finish(null, err));
    child.on('close', (code) => finish(markerFired ? 0 : code, null));
  });
}

/* ───────────────────── 参数解析 ───────────────────── */

function parseArgv(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

const args = parseArgv(process.argv);
const reportPath = path.resolve(ROOT, args.report || DEFAULT_REPORT);
const baselinePath = args.baseline ? path.resolve(ROOT, args.baseline) : null;
const dry = args.dry === true || args.dry === 'true';
const promote = args.promote === true || args.promote === 'true';
const noHistory = args['no-history'] === true || args['no-history'] === 'true';

/* ───────────────────── 快照 / 对齐键 ───────────────────── */

function hostOf(url) {
  if (!url) return '';
  try { return new URL(url).host; } catch { return String(url).split('#')[0]; }
}

function keyOf(source) {
  return `${hostOf(source.url)}::${source.name}`;
}

function stageOf(record) {
  const st = record.stages || {};
  if (st.search) return 'search';
  if (st.info) return 'info';
  if (st.toc) return 'toc';
  if (st.content) return 'content';
  if (record.firstBook == null) return 'search';
  if ((record.tocCount || 0) === 0) return 'toc';
  return 'info';
}

function summarizeError(record) {
  const raw = record.error || Object.values(record.stages || {}).find(Boolean) || '（无错误原文）';
  return String(raw).replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** 初步归因（只诊断分类，不改引擎）：规则语法缺口 / 站点不可达 / 超时 / JS 桥缺失。 */
function attribute(record) {
  const text = `${record.error || ''} ${Object.values(record.stages || {}).join(' ')}`;
  const js = Boolean(record.tags && record.tags.js);
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|EPIPE/.test(text)) return '站点不可达';
  if (/请求超时/.test(text)) return '站点不可达';
  if (/任务超时|worker|已回收重建/.test(text)) return '超时';
  if (/桥|bridge|未实现|is not a function|undefined|ajax 地址非法|java\./i.test(text)) {
    return js ? 'JS 桥缺失' : '规则语法缺口';
  }
  return '规则语法缺口';
}

function sourceRow(source) {
  return {
    name: source.name,
    host: hostOf(source.url),
    url: source.url,
    tags: source.tags || {},
    ok: Boolean(source.ok),
    stage: stageOf(source),
    error: summarizeError(source),
    attribution: attribute(source),
    ms: source.ms,
    failureClass: source.failureClass || '',
  };
}

/** 从完整 report.json 提取快照（含逐源状态，供逐源 diff）。 */
function snapshotFromReport(report) {
  const sources = report.sources || [];
  const byKey = {};
  for (const s of sources) byKey[keyOf(s)] = sourceRow(s);
  const summary = report.summary || {};
  return {
    at: report.generatedAt ? new Date(report.generatedAt).toISOString() : new Date().toISOString(),
    passed: summary.passed ?? sources.filter((s) => s.ok).length,
    total: summary.total ?? sources.length,
    passRate: summary.passRate ?? (sources.length ? (summary.passed ?? sources.filter((s) => s.ok).length) / sources.length : 0),
    tagCoverage: summary.tagCoverage || {},
    engineUnit: report.engineUnit ? { passed: report.engineUnit.passed, total: report.engineUnit.total } : null,
    sources: byKey,
  };
}

/** 兼容本工具基线快照与完整 report.json 两种形态。 */
function normalizeBaseline(data) {
  if (data && data.sources && !Array.isArray(data.sources)) return data; // 快照
  return snapshotFromReport(data || {});
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/* ───────────────────── 逐源 / 逐标签 diff ───────────────────── */

function diffSources(prev, cur) {
  const prevSources = prev?.sources || {};
  const curSources = cur.sources;
  const keys = new Set([...Object.keys(prevSources), ...Object.keys(curSources)]);
  const rows = [];
  for (const key of keys) {
    const p = prevSources[key] || null;
    const c = curSources[key] || null;
    let change;
    if (p && c) {
      if (p.ok && !c.ok) change = 'newFail';
      else if (!p.ok && c.ok) change = 'recovered';
      else if (!p.ok && !c.ok) change = 'stillFail';
      else change = 'stable';
    } else if (!p && c) change = prev ? (c.ok ? 'newSource' : 'unmatchedFail') : (c.ok ? 'stable' : 'stillFail');
    else change = 'dropped';

    rows.push({
      key,
      name: c?.name || p?.name || key,
      host: c?.host || p?.host || '',
      prevOk: p ? p.ok : null,
      curOk: c ? c.ok : null,
      change,
      stage: c?.stage || p?.stage || '',
      error: c?.error || p?.error || '',
      attribution: c?.attribution || p?.attribution || '',
      tags: c?.tags || p?.tags || {},
      ms: c?.ms ?? p?.ms,
    });
  }
  return {
    rows,
    newFail: rows.filter((r) => r.change === 'newFail'),
    recovered: rows.filter((r) => r.change === 'recovered'),
    stillFail: rows.filter((r) => r.change === 'stillFail'),
    unmatched: rows.filter((r) => r.change === 'unmatchedFail' || r.change === 'newSource' || r.change === 'dropped'),
  };
}

function diffTags(prev, cur) {
  const keys = new Set([...Object.keys(cur.tagCoverage), ...Object.keys(prev?.tagCoverage || {})]);
  return [...keys].map((tag) => {
    const c = cur.tagCoverage[tag] || { pass: 0, total: 0 };
    const b = prev ? prev.tagCoverage[tag] || { pass: 0, total: 0 } : null;
    return {
      tag,
      curPass: c.pass, curTotal: c.total,
      prevPass: b ? b.pass : null, prevTotal: b ? b.total : null,
      passDelta: b ? c.pass - b.pass : null,
      totalDelta: b ? c.total - b.total : null,
    };
  });
}

/* ───────────────────── 原子写 ───────────────────── */

function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

function loadHistory() {
  if (!fs.existsSync(HISTORY_PATH)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/* ───────────────────── 输出 ───────────────────── */

const MARK = { newFail: '✗ newFail', recovered: '✓ recovered', stillFail: '• stillFail', stable: '= stable', unmatched: '? 未对齐' };

function printSourceTable(title, rows) {
  console.log(`\n${title}（${rows.length}）`);
  if (!rows.length) { console.log('  无'); return; }
  console.log('  源 | 上次 | 本次 | 变化 | 阶段 | 原因');
  for (const r of rows) {
    const prev = r.prevOk == null ? '—' : r.prevOk ? 'pass' : 'fail';
    const cur = r.curOk == null ? '—' : r.curOk ? 'pass' : 'fail';
    const reason = r.error ? `${r.attribution}｜${r.error}` : r.attribution;
    console.log(`  ${r.name} | ${prev} | ${cur} | ${MARK[r.change] || r.change} | ${r.stage} | ${reason}`);
  }
}

/* ───────────────────── 主流程 ───────────────────── */

async function main() {
  // 1. 视情况跑一轮套件
  if (!dry) {
    if (!fs.existsSync(RUNNER)) {
      console.error('[闸门] 找不到套件入口：', RUNNER);
      process.exit(2);
    }
    console.log('[闸门] 运行单轮套件：node lib/legado/test/run.mjs（不出 HTTP 服务）');
    let runCode = 0;
    try {
      runCode = await runSuite();
    } catch (err) {
      console.error('[闸门] 套件启动/运行失败：', err.message || err);
      process.exit(2);
    }
    if (runCode !== 0) {
      console.error(`[闸门] 套件异常退出，退出码 ${runCode}`);
      process.exit(2);
    }
  } else {
    console.log('[闸门] --dry：跳过套件，只读现有报告');
  }

  // 2. 解析当前报告
  if (!fs.existsSync(reportPath)) {
    console.error('[闸门] 报告缺失：', reportPath);
    process.exit(2);
  }
  const current = snapshotFromReport(loadJson(reportPath));

  // 3. 加载基线：显式文件（只读）> 默认最好基线文件
  let baseline = null;
  let baselineNote = '无基线（本次结果将作为初始基线）';
  if (baselinePath) {
    baseline = normalizeBaseline(loadJson(baselinePath));
    baselineNote = `显式基线：${path.relative(ROOT, baselinePath)}`;
  } else if (fs.existsSync(BASELINE_PATH)) {
    baseline = normalizeBaseline(loadJson(BASELINE_PATH));
    baselineNote = `最好基线：${path.relative(ROOT, BASELINE_PATH)}（${baseline.at || '未知时间'}）`;
  }

  // 4. 逐源 / 逐标签 diff
  const diff = diffSources(baseline, current);
  const tagDiff = diffTags(baseline, current);

  // 5. 基线维护：--promote 强制提升；否则仅当本次通过数 ≥ 基线时自动更新（不回写显式文件）
  if (!baselinePath) {
    if (promote) {
      atomicWriteJson(BASELINE_PATH, current);
      console.log(`[闸门] --promote：当前结果已提升为新基线（${current.passed}/${current.total}）`);
    } else if (!baseline || current.passed >= baseline.passed) {
      atomicWriteJson(BASELINE_PATH, current);
      if (baseline) console.log(`[闸门] 基线已刷新：${baseline.passed} → ${current.passed}（本次 ≥ 基线）`);
      else console.log('[闸门] 初始基线已建立');
    } else {
      console.log(`[闸门] 基线保持不变：${baseline.passed} > ${current.passed}（本次未达标，不拉低基线）`);
    }
  }

  // 6. 控制台输出
  const pct = (current.passRate * 100).toFixed(1);
  console.log('\n──────── 本次结果 ────────');
  console.log(`通过：${current.passed}/${current.total}（${pct}%）`);
  if (current.engineUnit) console.log(`引擎纯函数单测：${current.engineUnit.passed}/${current.engineUnit.total}`);
  console.log(`基线：${baselineNote}`);

  console.log('──────── 逐源差异 ────────');
  if (!baseline) {
    console.log('（无基线，仅记录当前状态）');
  } else {
    printSourceTable('newFail（pass → fail）', diff.newFail);
    printSourceTable('recovered（fail → pass）', diff.recovered);
    printSourceTable('stillFail（持续失败）', diff.stillFail);
    if (diff.unmatched.length) printSourceTable('未对齐源（基线/当前缺一侧）', diff.unmatched);
  }

  console.log('\n──────── 标签覆盖（当前 / 基线） ────────');
  for (const t of tagDiff) {
    const prev = t.prevPass == null ? '—' : `${t.prevPass}/${t.prevTotal}`;
    const delta = t.passDelta == null ? '' : `（pass ${t.passDelta >= 0 ? '+' : ''}${t.passDelta}，total ${t.totalDelta >= 0 ? '+' : ''}${t.totalDelta}）`;
    console.log(`  ${t.tag.padEnd(10)} ${t.curPass}/${t.curTotal} / ${prev} ${delta}`);
  }

  // 7. 历史落盘（同结构，保留最近 20 条）
  if (!noHistory) {
    const historyEntry = {
      at: new Date().toISOString(),
      passed: current.passed,
      total: current.total,
      passRate: current.passRate,
      tagCoverage: current.tagCoverage,
      engineUnit: current.engineUnit,
      baselineAt: baseline ? baseline.at : null,
      newFail: diff.newFail,
      recovered: diff.recovered,
      stillFail: diff.stillFail,
      unmatched: diff.unmatched,
      rows: diff.rows.filter((r) => r.change !== 'stable'),
      dry: Boolean(dry),
    };
    const history = loadHistory();
    history.push(historyEntry);
    atomicWriteJson(HISTORY_PATH, history.slice(-HISTORY_KEEP));
    console.log(`\n[闸门] 历史已追加：${path.relative(ROOT, HISTORY_PATH)}（保留最近 ${HISTORY_KEEP} 条）`);
  }

  // 8. 退出码判定
  const baseRegex = baseline?.tagCoverage?.regex;
  const curRegex = current.tagCoverage?.regex;
  let code = 0;
  if (promote) {
    code = 0;
  } else if (!baseline) {
    code = 0;
  } else if (diff.newFail.length > 0) {
    code = 3;
  } else if (current.passed < baseline.passed) {
    code = 4;
  } else if (baseRegex && curRegex && curRegex.pass < baseRegex.pass) {
    code = 5;
  }

  if (code === 3) console.error(`[闸门] 判定 3：${diff.newFail.length} 个源 pass→fail，回归告警`);
  else if (code === 4) console.error(`[闸门] 判定 4：通过数 ${current.passed} < 基线 ${baseline.passed}`);
  else if (code === 5) console.error(`[闸门] 判定 5：regex 覆盖 ${curRegex.pass}/${curRegex.total} 低于基线 ${baseRegex.pass}/${baseRegex.total}`);
  else console.log('[闸门] 判定 0：无回归');
  process.exit(code);
}

main().catch((error) => {
  console.error('[闸门] 工具异常：', (error && error.stack) || error);
  process.exit(2);
});
