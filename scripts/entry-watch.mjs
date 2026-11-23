#!/usr/bin/env node
// 入口存活监控 —— 唯一可信判据是真实 HTTP 200
//
// 为什么需要它：2026-11-22 全组 7 人都没发现 8890 整个服务已从 launchd 注销。
// 当时所有"本地证据"都是绿的：launchctl 报 running、lsof 有 pid、进程 STAT=R。
//
// 三态退出码：
//   0 = 全绿
//   1 = 有入口不可用
//   2 = 检查器自身故障（不是被测服务的问题）
//
// ★ 目标之间必须并发探测，不能串行：一个服务卡满超时会连累下一个被误判。
//   这是实测发现的自身缺陷（黑洞端口下 8811 被连带判死，而它当时真的 200）。
//
// 用法：node scripts/entry-watch.mjs [--json]

import { execFileSync } from 'node:child_process';

const AS_JSON = process.argv.includes('--json');

const TARGETS = [
  { name: '客厅 8890', port: 8890, url: 'http://127.0.0.1:8890/api/status', label: 'com.wuwu.wuwu-living', expectCmd: 'hub.mjs' },
  { name: '音乐 8811', port: 8811, url: 'http://127.0.0.1:8811/',          label: 'com.wuwu.lingting.web', expectCmd: null },
];

const SAMPLES = 5;        // 每目标采样次数
const NEED = 4;           // 判定可用的门槛（留 1 次抖动余量）
const TIMEOUT_MS = 4000;  // 单次请求超时

function hit(t) {
  return new Promise((resolve) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const t0 = Date.now();
    fetch(t.url, { signal: ctrl.signal })
      .then((r) => resolve({ code: r.status, ms: Date.now() - t0 }))
      .catch((e) => {
        const kind = e && e.name === 'AbortError' ? 'TIMEOUT' : 'REFUSED';
        resolve({ code: 0, ms: Date.now() - t0, kind });
      })
      .finally(() => clearTimeout(timer));
  });
}

// 该目标的 N 次采样并发发出，互不阻塞
function sampleTarget(t) {
  return Promise.all(Array.from({ length: SAMPLES }, () => hit(t)));
}

// launchd 记账。state=running 不能证明服务可用（今天是反例）。
// last exit code 字段可能不存在，缺字段 ≠ 崩溃。
function launchdState(label) {
  try {
    const out = execFileSync('launchctl', ['print', `gui/${process.getuid()}/${label}`], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return {
      found: true,
      state: (out.match(/^\tstate = (\S+)/m) || [])[1] || null,
      pid: (out.match(/^\tpid = (\d+)/m) || [])[1] || null,
      exit: (out.match(/last exit code = (\S+)/m) || [])[1] || null,
      runs: (out.match(/^\truns = (\d+)/m) || [])[1] || null,
    };
  } catch {
    return { found: false };
  }
}

// 实例身份核对：防止拿实验实例（PORT=8896 等）的 200 冒充生产。
// 用进程命令行里的英文锚点（hub.mjs），避开 ps 对中文的渲染问题。
function instanceIdentity(port, expectCmd) {
  try {
    const pid = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().split('\n')[0];
    if (!pid) return { pid: null, ok: null };
    const cmd = execFileSync('ps', ['-p', pid, '-o', 'command='], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return { pid, ok: expectCmd ? cmd.includes(expectCmd) : null };
  } catch {
    return { pid: null, ok: null };
  }
}

async function main() {
  // ★ 所有目标并发采样，一个卡住不连累另一个
  const results = await Promise.all(TARGETS.map((t) => sampleTarget(t)));

  const report = [];
  let dead = 0;

  for (let i = 0; i < TARGETS.length; i++) {
    const t = TARGETS[i];
    const rs = results[i];
    const ok = rs.filter((r) => r.code === 200).length;
    const timeouts = rs.filter((r) => r.kind === 'TIMEOUT').length;
    const refused = rs.filter((r) => r.kind === 'REFUSED').length;
    const times = rs.filter((r) => r.code === 200).map((r) => r.ms);
    const alive = ok >= NEED;
    if (!alive) dead++;

    const ld = launchdState(t.label);
    const warn = [];
    if (ld.found && ld.state === 'running' && !alive) warn.push('launchd 报 running 但服务不可用 —— launchd 在骗你');
    if (!ld.found && alive) warn.push('launchd 查不到但服务可用 —— 托管项掉了，重启即失守');
    if (ld.found && ld.exit !== null && ld.exit !== '0' && ld.state === 'running') warn.push(`state=running 但 last exit=${ld.exit} —— 崩溃循环指纹`);

    report.push({
      name: t.name, alive, ok, timeouts, refused, samples: SAMPLES, need: NEED,
      avgMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
      maxMs: times.length ? Math.max(...times) : null,
      launchd: ld, warn,
    });
  }

  const ident = instanceIdentity(8890, 'hub.mjs');

  if (AS_JSON) {
    console.log(JSON.stringify({ targets: report, identity: { port: 8890, ...ident }, dead }, null, 2));
    process.exit(dead === 0 && ident.ok !== false ? 0 : 1);
  }

  for (const r of report) {
    console.log(`${r.alive ? '✅ 可用' : '❌ 死  '}  ${r.name}`);
    console.log(`        HTTP 200: ${r.ok}/${r.samples}（门槛 ${r.need}）  平均 ${r.avgMs ?? '-'}ms  最慢 ${r.maxMs ?? '-'}ms  超时 ${r.timeouts}  拒连 ${r.refused}`);
    const ld = r.launchd;
    console.log(`        launchd: ${ld.found ? `${ld.state}  pid=${ld.pid}  last exit=${ld.exit ?? 'n/a'}  runs=${ld.runs ?? 'n/a'}` : '⚠️ 查不到服务'}`);
    for (const w of r.warn) console.log(`        ⚠️ ${w}`);
  }

  console.log(`\n实例身份：8890 pid=${ident.pid ?? '无'}`);
  if (ident.ok === false) console.log('        ⚠️ 命令行不含「hub.mjs」—— 可能打到别的实例，本次结论不可用于生产');
  else if (ident.ok === true) console.log('        ✅ 与预期实例一致');

  console.log(dead === 0 ? '\n全绿：入口均可用' : `\n有 ${dead} 个入口不可用`);
  process.exit(dead === 0 && ident.ok !== false ? 0 : 1);
}

main().catch((e) => {
  console.error('[检查器故障]', e && e.message);
  process.exit(2);
});
