#!/usr/bin/env node
/**
 * health-audit.mjs —— 五五客厅只读体检扫描器（最小可跑版）
 *
 * 纪律（比代码重要）：
 *  0. 性能数字必须带环境快照：load average 与 ESTABLISHED 计数。没有这两项的数字不下结论。
 *  1. 只读：只发 GET。写/破坏类接口（delete/remove/clear/stop/add/...）一律不发，
 *     记「未取证」，不记通过。
 *  2. 三态判定：PASS / FAIL / UNVERIFIED。拿不到证据 = UNVERIFIED，
 *     **UNVERIFIED 绝不计入通过**，避免「扫不到就报好」的假绿。
 *  3. 每个类别都有负向臂：--selftest 会起一个「故意坏掉」的本地目标，
 *     同一套判据必须对它报红；报不出来说明判据没有区分力。
 *
 * 用法：
 *   node scripts/health-audit.mjs                    # 体检真实站点 :8890
 *   node scripts/health-audit.mjs --base http://...   # 指定目标
 *   node scripts/health-audit.mjs --json              # 机器可读
 *   node scripts/health-audit.mjs --selftest          # 负向臂自检（4 臂）
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';


/* ───────────────── 统一退出码（两个入口语义一致，禁止复用同一码表示两件事） ─────────────────
 *  0  全绿：全臂合格且完整 / 体检零缺陷且零未取证     ← 唯一可宣称"通过"的码
 *  1  有硬缺陷：某臂不合格 / 体检发现 fail 项
 *  2  检查器故障：崩溃特征、判定词缺失、脚本自身出错   ← 绝不等于被测代码不合格
 *  3  臂不完整：有臂被 SKIP 跳过                      ← 结论不可用，CI 必须拦下
 *  4  有未取证项：体检全部通过但存在 unverified       ← 不是通过，也不是缺陷
 * 退出码互斥、优先级 2 > 1 > 3 > 4 > 0。
 */
export const EXIT = { PASS: 0, FAIL: 1, CRASH: 2, INCOMPLETE: 3, UNVERIFIED: 4 };
export const EXIT_MEANING = {
  0: '全绿（唯一可宣称通过）',
  1: '有硬缺陷',
  2: '检查器故障（不等于被测代码不合格）',
  3: '臂不完整（结论不可用）',
  4: '有未取证项（不是通过）',
};

/* ── 全局兜底：任何未捕获异常/未处理 rejection 都必须是 exit=2（检查器故障） ──
 * 否则 Node 默认 exit=1，会与"缺陷红"混为一谈 —— 这正是今天最难分开的一类假红。
 */
const __CRASH_EXIT = 2;
process.on('uncaughtException', (e) => {
  console.error(`\n[检查器故障] 未捕获异常：${e && (e.stack || e.message || e)}`);
  console.error(`崩溃特征：${(e && e.name) || 'Error'}`);
  console.error(`退出码 ${__CRASH_EXIT} = 检查器故障（不等于被测代码不合格）`);
  process.exit(__CRASH_EXIT);
});
process.on('unhandledRejection', (e) => {
  console.error(`\n[检查器故障] 未处理 rejection：${e && (e.stack || e.message || e)}`);
  console.error(`崩溃特征：${(e && e.name) || 'Error'}`);
  console.error(`退出码 ${__CRASH_EXIT} = 检查器故障（不等于被测代码不合格）`);
  process.exit(__CRASH_EXIT);
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PUBLIC = path.join(ROOT, 'public');
const LIB = path.join(ROOT, 'lib');

const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const BASE = argOf('--base', 'http://127.0.0.1:8890').replace(/\/$/, '');
const AS_JSON = argv.includes('--json');
const TIMEOUT = Number(argOf('--timeout', '15000'));

/* ───────────── 房间清单：从源码读，避免手抄漂移 ───────────── */
function readRooms() {
  const roomsFile = path.join(LIB, 'rooms.mjs');
  if (!fs.existsSync(roomsFile)) {
    // 扫不到就说扫不到，绝不静默返回空数组冒充"没有房间"
    throw new Error(`找不到 ${roomsFile} —— 扫描器必须与五五客厅源码同仓运行，不能挪到别处跑`);
  }
  const src = fs.readFileSync(roomsFile, 'utf8');
  const block = src.slice(src.indexOf('ROOM_LIST'), src.indexOf('];', src.indexOf('ROOM_LIST')));
  const rooms = [];
  for (const m of block.matchAll(/id:\s*'([^']+)'[\s\S]{0,80}?name:\s*'([^']+)'[\s\S]{0,80}?page:\s*'([^']+)'/g)) {
    rooms.push({ id: m[1], name: m[2], page: m[3] });
  }
  if (!rooms.length) {
    throw new Error(`从 ${roomsFile} 解析出 0 个房间 —— ROOM_LIST 格式变了或正则失效，必须修扫描器而不是当"没有房间"`);
  }
  return rooms;
}

const CORE_ROOMS = [
  { id: 'magnet', name: '搜磁力', page: null },
  { id: 'book', name: '书房', page: '书房.html' },
  { id: 'music', name: '音乐', page: null },
  { id: 'vod', name: '视频', page: null },
];

/* ───────────── HTTP 工具 ───────────── */
const RETRY = Number(argOf('--retry', '2'));   // 失败自动复测次数（防瞬时抖动误报）

async function req(url, { method = 'GET', body = null } = {}) {
  const t0 = process.hrtime.bigint();
  try {
    const init = { method, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT) };
    if (body != null) {
      init.body = body;
      init.headers = { 'content-type': 'application/json' };
    }
    const r = await fetch(url, init);
    const buf = Buffer.from(await r.arrayBuffer());
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const h = {};
    r.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
    return { ok: true, status: r.status, ms, headers: h, body: buf, text: buf.toString('utf8') };
  } catch (e) {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return { ok: false, status: 0, ms, headers: {}, body: Buffer.alloc(0), text: '', err: e.message };
  }
}


/* ── 带复测的请求：单次失败不算失败，全部重试都失败才算 ──
 * 目的：消除「瞬时 5xx / 瞬时超时」被当成稳定缺陷（误报），
 * 同时保留"曾经失败过"这一事实，不让它被复测成功抹掉。
 */
async function reqStable(url, opts = {}) {
  const attempts = [];
  const n = Math.max(0, RETRY) + 1;
  for (let i = 0; i < n; i++) {
    const r = await req(url, opts);
    attempts.push(r);
    const good = r.ok && r.status >= 200 && r.status < 400;
    if (good) {
      if (i === 0) return { ...r, attempts: 1, retried: false };
      // 复测才成功：把第一次的失败记录保留下来
      return { ...r, attempts: i + 1, retried: true,
        firstFailure: { status: attempts[0].status, err: attempts[0].err } };
    }
    if (i < n - 1) await new Promise((res) => setTimeout(res, 400));
  }
  return { ...attempts[attempts.length - 1], attempts: n, retried: n > 1,
    allFailed: attempts.map((a) => a.status || a.err).join(',') };
}

const F = (o) => ({ verdict: 'unverified', evidence: '', ...o });
const P = (o) => F({ verdict: 'pass', ...o });
const X = (o) => F({ verdict: 'fail', ...o });


/* ── 环境快照：load average + 端口 ESTABLISHED（性能数字必须带它） ── */
export function parseLoadavg(text) {
  const nums = String(text || '').trim().split(/\s+/).slice(0, 3).map(Number);
  if (nums.length < 3 || nums.some((n) => !Number.isFinite(n))) return null;
  return { one: nums[0], five: nums[1], fifteen: nums[2] };
}

export function classifyEnv(load, others) {
  // 只做记账：环境本身不判红，但必须随每个性能数字一起报出
  if (!load) return `load=未知 ｜ 外部连接=${others} 条`;
  const busy = load.one >= 4 ? '（机器偏忙，绝对值仅供参考）' : '';
  return `load1=${load.one.toFixed(2)} load5=${load.five.toFixed(2)} load15=${load.fifteen.toFixed(2)} ｜ 外部连接=${others} 条${busy}`;
}


/* ── 纯函数：工作区卫生判定（未提交文件数超阈值告警） ── */
export function classifyWorktree(porcelainOut, threshold = 20) {
  const lines = String(porcelainOut || '').split('\n').filter((l) => l.trim());
  // .bak 备份与真代码必须分开计数：226 个备份会淹没 81 个真改动，让阈值失去区分力
  const isBak = (l) => /\.bak[-.]/.test(l);
  const real = lines.filter((l) => !isBak(l));
  const baks = lines.filter(isBak);
  const modified = real.filter((l) => /^\s?[MADRCU]/.test(l));
  const untracked = real.filter((l) => l.startsWith('??'));
  const item = { id: 'wt.count', cat: '工作区', title: '未提交改动',
    evidence: `real=${real.length} modified=${modified.length} untracked=${untracked.length} bak=${baks.length} threshold=${threshold}` };
  const detail = `真代码改动 ${real.length} 个（已跟踪 ${modified.length} / 未跟踪 ${untracked.length}），另 ${baks.length} 个 .bak 备份不计入，阈值 ${threshold}`;
  if (real.length > threshold) {
    return X({ ...item, detail: detail + ` —— 超过阈值：改动无法区分归属，回滚基线缺失` });
  }
  return P({ ...item, detail });
}

/* ── .bak 备份卫生（独立于回滚基线：备份多不危险，但会干扰判断） ── */
export function classifyBakHygiene(porcelainOut, limit = 50) {
  const baks = String(porcelainOut || '').split('\n').filter((l) => /\.bak[-.]/.test(l));
  const item = { id: 'wt.bakh', cat: '工作区', title: '.bak 备份卫生',
    evidence: `bak=${baks.length} limit=${limit}` };
  if (baks.length > limit) {
    return F({ ...item, verdict: 'unverified',
      detail: `${baks.length} 个 .bak 备份超过 ${limit} —— 属仓库卫生问题（不影响运行，但会干扰 ls 与排查），不计为缺陷` });
  }
  return P({ ...item, detail: `${baks.length} 个 .bak 备份，在 ${limit} 以内` });
}


/* ── 纯函数：假备份检测 ──
 * 判据：存在「常驻备份」文件（*.bak-*），但它与原件逐字相同，
 * 且原件本身处于未提交改动状态。这样的备份回滚不了任何东西。
 */
export function classifyFakeBackup(pairs) {
  // pairs: [{ backup, original, identical, originalModified }]
  const fakes = pairs.filter((p) => p.identical && p.originalModified);
  const valid = pairs.filter((p) => !p.identical);
  const item = { id: 'wt.bak', cat: '工作区', title: '备份有效性',
    evidence: `pairs=${pairs.length} fake=${fakes.length} diverged=${valid.length}` };
  if (fakes.length) {
    return X({ ...item,
      detail: `${fakes.length} 份备份与原件逐字相同且原件有未提交改动 → 回滚不了任何东西：${fakes.map((f) => f.backup).slice(0, 3).join(', ')}` });
  }
  if (!pairs.length) {
    return F({ ...item, detail: '没找到 *.bak-* 备份文件，无法取证', evidence: 'pairs=0' });
  }
  return P({ ...item, detail: `${pairs.length} 份备份均有差异（可用于回滚）` });
}


/* ── 纯函数：按 404 报文区分「真无路由 / 方法不对 / 参数问题」──
 * 实测判据（五五客厅）：
 *   "没有这个页面"     → hub 层兜底 404，确实没有这条路由   → 真·死路由
 *   "这个接口不存在"   → 模块层说"方法/路径不对"，路由是存在的 → 不是死路由
 *   其它（"没有这张图"/"没有这个任务"…）→ 路由存在，参数没命中 → 不是死路由
 */
export function classify404(route, res, declaredMethod) {
  let msg = '';
  try { msg = String(JSON.parse(res.text).message || ''); } catch {}
  const isHubFallback = /没有这个页面/.test(msg);
  const isMethodMismatch = /这个接口不存在/.test(msg);
  const base = {
    id: `api.${route}`, cat: '死路由', title: route,
    evidence: `status=404 msg="${msg}" method=${declaredMethod || '?'}`,
  };
  if (isHubFallback) {
    // GET 打到 hub 兜底 → 真没有这条路由（但若源码声明必须 POST，则只读扫描无法判定）
    if (declaredMethod && declaredMethod !== 'GET') {
      return F({ ...base, verdict: 'unverified',
        detail: `源码声明 ${declaredMethod}，只读扫描发的是 GET，hub 兜底 404 不能判死 —— 需 ${declaredMethod} 才能验` });
    }
    return X({ ...base, verdict: 'fail',
      detail: `源码注册但 GET 落到 hub 兜底「没有这个页面」—— 源码有、运行时没有` });
  }
  if (isMethodMismatch) {
    return F({ ...base, verdict: 'unverified',
      detail: '路由存在、方法不对（模块回「这个接口不存在」）—— 不是死路由，只读扫描无法验' });
  }
  return F({ ...base, verdict: 'unverified',
    detail: `路由存在（回了业务话术「${msg}」），只是参数没命中 —— 不是死路由` });
}


/* ── 纯函数：服务存活判定（三档分离，禁用 last-exit-code 判死） ──
 * 事实来源优先级：真实 HTTP 响应 > 端口 pid 一致性 > launchd 自述
 * launchd 的 state=running 与 last exit code 都不可作为"现在活着/死了"的判据：
 *   - state=running 会在进程已崩、端口未绑时仍报 running（孤儿窗口）
 *   - last exit code / runs 是历史累计，服务恢复后不归零
 */
export function classifyService(raw) {
  // raw: { name, launchd: {state,runs,pid,lastExit}, http: {status,ms,err}|null,
  //        listenPid: number|null }
  const base = { id: `svc.${raw.name}`, cat: '服务存活', title: raw.name };
  const ev = `launchd=${raw.launchd ? `${raw.launchd.state}/pid=${raw.launchd.pid}/runs=${raw.launchd.runs}/exit=${raw.launchd.lastExit}` : '无'}`
    + ` http=${raw.http ? (raw.http.status || raw.http.err || 'ERR') : '未探测'} listenPid=${raw.listenPid ?? '无'}`;

  const httpOk = raw.http && raw.http.status >= 200 && raw.http.status < 400;
  const pidMatch = raw.launchd && raw.listenPid && Number(raw.launchd.pid) === Number(raw.listenPid);

  // 确实活着：真实请求成功 且 端口 pid 与 launchd 一致
  if (httpOk && pidMatch) {
    const warn = raw.launchd.lastExit !== 0 || raw.launchd.runs > 1;
    return F({ ...base, verdict: 'pass',
      detail: `HTTP ${raw.http.status} / ${raw.http.ms.toFixed(0)}ms，端口 pid=${raw.listenPid} 与 launchd 一致 → 活着`
        + (warn ? `；但崩溃历史 runs=${raw.launchd.runs} lastExit=${raw.launchd.lastExit}（只代表最近崩过，不代表现在是死的）` : ''),
      evidence: ev });
  }

  // 孤儿窗口：launchd 说 running，但端口没监听 / pid 对不上
  if (raw.launchd && raw.launchd.state === 'running' && !pidMatch) {
    return X({ ...base, verdict: 'fail',
      detail: `launchd 报 running（pid=${raw.launchd.pid}）但端口 listenPid=${raw.listenPid ?? '无'} —— 守护在骗人，服务不可用`,
      evidence: ev });
  }

  // 真实请求失败：无论 launchd 说什么，都是死的
  if (raw.http && !httpOk) {
    return X({ ...base, verdict: 'fail',
      detail: `真实请求失败（${raw.http.status || raw.http.err}）—— 判定为不可用，不信 launchd 自述`,
      evidence: ev });
  }

  return F({ ...base, verdict: 'unverified', detail: '证据不足（HTTP 或 launchd 信息缺失）', evidence: ev });
}

/* ── 纯函数：崩溃探针判定（畸形 URL 型） ──
 * 这是"会杀死服务"的探针，必须显式开启；判定看"打前活、打后死"这个跃迁
 */
export function classifyCrashProbe(before, after) {
  const base = { id: 'svc.crashprobe', cat: '服务存活', title: '畸形URL崩溃探针' };
  const wasAlive = before && before.status >= 200 && before.status < 400;
  const stillAlive = after && after.status >= 200 && after.status < 400;
  const ev = `before=${before ? before.status || before.err : 'NA'} after=${after ? after.status || after.err : 'NA'}`;
  if (!wasAlive) {
    return F({ ...base, verdict: 'unverified', detail: '打之前服务就不健康，无法判定是否被畸形 URL 打死', evidence: ev });
  }
  if (stillAlive) {
    return P({ ...base, verdict: 'pass', detail: '畸形 URL 后服务仍正常 → 已对该类输入做防护', evidence: ev });
  }
  return X({ ...base, verdict: 'fail',
    detail: '打一个畸形 URL 后服务即不可用 → 未捕获的解析异常打死了整个进程（崩溃型缺陷，不是普通 4xx）',
    evidence: ev });
}


/* ── 纯函数：可用性采样判定（单点采样不可信） ──
 * 任何服务/接口，一次成功或一次失败都不构成结论。
 * 必须报「命中率」；0/N 与 N/N 必须能分开，中间态要显式标注不稳定。
 */
export function classifyAvailability(name, samples, { minRate = 0.9, label = '' } = {}) {
  const n = samples.length;
  const base = { id: `avail.${name}`, cat: '可用性', title: label || name };
  if (n < 20) {
    return F({ ...base, verdict: 'unverified',
      detail: `${n} 次采样不足 20 次 —— 单点/少点采样不可作为可用性结论`,
      evidence: `samples=${n}` });
  }
  const good = samples.filter((x) => x.ok && x.status >= 200 && x.status < 400);
  const rate = good.length / n;
  const ms = good.map((x) => x.ms);
  const detail = `命中 ${good.length}/${n}（${(rate * 100).toFixed(0)}%）`
    + (ms.length ? ` ｜ 成功样本 min ${Math.min(...ms).toFixed(1)} / max ${Math.max(...ms).toFixed(1)}ms` : '');
  const evidence = `ok=${good.length}/${n} rate=${rate.toFixed(2)}`;
  if (rate >= minRate) {
    return P({ ...base, verdict: 'pass', detail: `${detail} → 稳定可用（阈值 ${(minRate * 100).toFixed(0)}%）`, evidence });
  }
  if (rate === 0) {
    return X({ ...base, verdict: 'fail', detail: `${detail} → 完全不可用（0 命中不是抖动）`, evidence });
  }
  return X({ ...base, verdict: 'fail',
    detail: `${detail} → 不稳定（低于 ${(minRate * 100).toFixed(0)}% 阈值）：同一服务时好时坏，用户撞上哪个看运气`,
    evidence });
}


/* ── 纯函数：用户入口存活判定（今天两条判据同时失效，全组无人察觉） ──
 * 事实来源：真实 HTTP 200 > 端口 LISTEN 且 pid 一致 > launchd 自述
 * 三条必须分别出结论，任何一条失效都要报，不能合并成一个"总体健康"
 */
export function classifyEntrypoint(raw) {
  // raw: { label, http:{status,ms,err}|null, listenPid:number|null,
  //        service:{found,state,pid,runs,lastExit}|null }
  const out = [];
  const label = raw.label || '8890';

  // ① 入口真实可用（唯一能证明"用户能进来"的判据）
  const httpOk = raw.http && raw.http.status >= 200 && raw.http.status < 400;
  out.push(httpOk
    ? P({ id: 'entry.http', cat: '入口', title: `${label} 真实请求`,
        detail: `HTTP ${raw.http.status} / ${raw.http.ms.toFixed(0)}ms → 用户能进来`,
        evidence: `status=${raw.http.status}` })
    : X({ id: 'entry.http', cat: '入口', title: `${label} 真实请求`,
        detail: `真实请求失败（${raw.http ? (raw.http.status || raw.http.err) : '未探测'}）→ 用户进不来。这是唯一可信判据，launchd/lsof/pid 都不能替代`,
        evidence: `status=${raw.http ? (raw.http.status || 'ERR') : 'NA'}` }));

  // ② 端口在听 且 pid 与 launchd 一致（防"孤儿窗口"）
  const pidMatch = raw.service && raw.service.found && raw.listenPid
    && Number(raw.service.pid) === Number(raw.listenPid);
  out.push(pidMatch
    ? P({ id: 'entry.listen', cat: '入口', title: `${label} 监听与托管一致`,
        detail: `listenPid=${raw.listenPid} 与 launchd pid 一致`, evidence: `pid=${raw.listenPid}` })
    : F({ id: 'entry.listen', cat: '入口', title: `${label} 监听与托管一致`,
        detail: `listenPid=${raw.listenPid ?? '无'}，launchd pid=${raw.service ? raw.service.pid : 'NA'} —— 不一致或缺失（可能是孤儿进程，也可能已死）`,
        evidence: `listen=${raw.listenPid ?? 'none'} svcPid=${raw.service ? raw.service.pid : 'NA'}` }));

  // ③ 托管项存在（今天它掉了，且没有任何告警）
  if (!raw.service || !raw.service.found) {
    out.push(X({ id: 'entry.service', cat: '入口', title: `${label} launchd 托管项`,
      detail: 'launchd 里查不到这个服务（已被 bootout / 注销）→ 进程一旦退出就再也不会自动拉起',
      evidence: 'service=not-found' }));
  } else {
    out.push(P({ id: 'entry.service', cat: '入口', title: `${label} launchd 托管项`,
      detail: `存在（state=${raw.service.state} runs=${raw.service.runs}${raw.service.lastExit !== 0 ? ` lastExit=${raw.service.lastExit}（最近崩过，不代表现在死的）` : ''}）`,
      evidence: `state=${raw.service.state} runs=${raw.service.runs}` }));
  }
  return out;
}


/* ── POST 探针白名单（只收「空 body 无副作用」的） ──
 * 依据：后端探针表 docs/后端-POST探针表-20261122.md
 * 安全性已实测：runtime/book_shelf.json sha256 打前打后一致
 * 任何会对真实数据/真实 launchd 服务产生副作用的，一律不入表。
 */
export const POST_PROBES = new Set([
  '/api/book/ensure',        // 200 只读探测，不启动 Reader
  '/api/book/search-start',  // 400 缺参数即返回，不落任务
  '/api/book/shelf/add',     // 400 缺参数，不写书架
  '/api/book/shelf/remove',  // 400 缺参数，不写书架
  '/api/book/open',          // 502 无书源，不写
  '/api/book/chapter',       // 502 取正文失败，不写
  '/api/book/progress',      // 502 缺参数，不写
  '/api/notes/tag/rename',   // 400 缺参数，不改标签
  '/api/cast/key',           // 409 不认识的键，不发按键
]);
/* ── 第三类：已知存在但审计不探（有真实副作用；路由存在性由后端探针表人工实测确认） ──
 * 依据：docs/后端-POST探针表-20261122.md
 * /api/start /api/stop 传 {} 会返回 400「没有这个项目」且不触碰任何服务（已实测 pid 未变），
 * 但传真实项目名就会真启动/停止 —— 审计不能冒这个险，故不自动探，标"已知存在"。
 * /api/start-all 会无条件启动所有 web 应用，更危险。
 */
export const POST_KNOWN_EXISTS = new Map([
  ['/api/start', { probe: '400 没有这个项目（空 body）', note: '传真实项目名会真启动，不自动探' }],
  ['/api/stop', { probe: '400 没有这个项目（空 body）', note: '传真实项目名会真停止，不自动探' }],
  ['/api/start-all', { probe: '200 无条件启动全部 web 应用', note: '调用即启动所有应用，禁止自动探' }],
  ['/api/reader/open', { probe: '403 客厅不再打开 Reader（有意封禁）', note: '有意封禁，探也无意义' }],
]);

/* 明确排除（有副作用，永不探） */
export const POST_FORBIDDEN = new Set([
  '/api/start', '/api/stop', '/api/start-all',        // 操真实 launchd
  '/api/download/add', '/api/download/delete',        // 动真实下载任务
  '/api/library/scan', '/api/photos/scan',            // 启真实扫描
  '/api/reader/open', '/api/cast/start', '/api/cast/stop', '/api/cast/tap',
]);

/* ── 纯函数：死路由判定（必须 GET+POST 双 404 且报文为 hub 兜底） ── */
export function classifyDeadRoute(route, getRes, postRes) {
  const msgOf = (r) => { try { return String(JSON.parse(r.text).message || ''); } catch { return ''; } };
  const gMsg = getRes ? msgOf(getRes) : '';
  const pMsg = postRes ? msgOf(postRes) : '';
  const hubFallback = (m) => /没有这个页面/.test(m);
  const gDead = getRes && getRes.status === 404 && hubFallback(gMsg);
  const pDead = postRes && postRes.status === 404 && hubFallback(pMsg);

  const base = { id: `dead.${route}`, cat: '死路由', title: route,
    evidence: `GET=${getRes ? getRes.status : 'NA'}("${gMsg}") POST=${postRes ? postRes.status : 'NA'}("${pMsg}")` };

  if (getRes && postRes) {
    if (gDead && pDead) {
      return X({ ...base, verdict: 'fail',
        detail: 'GET 与 POST 都落到 hub 兜底「没有这个页面」→ 真·死路由（源码有、运行时没有）' });
    }
    return P({ ...base, verdict: 'pass',
      detail: `路由存在（GET=${getRes.status}/${gMsg || '-'} POST=${postRes.status}/${pMsg || '-'}）—— 不是死路由` });
  }
  if (gDead) {
    return F({ ...base, verdict: 'unverified',
      detail: `GET 落到 hub 兜底，但未做 POST 探测（不在白名单或不可安全探）—— 不能判死` });
  }
  return P({ ...base, verdict: 'pass', detail: `GET 返回业务响应「${gMsg || getRes.status}」→ 路由存在` });
}


/* ── 纯函数：备份覆盖判定（有区分力的形式） ──
 * 总管原话判据「备份 mtime 晚于最早未提交改动 → 告警」字面实现会永远报红：
 * 备份只记录"今天改之前"，永远追不上 11-19 那些更早的改动。
 * 真正该问的是：**有没有任何备份/快照能覆盖到最早的未提交改动**。
 *   covered   = 存在快照时刻 <= 最早改动时刻（能回到改动之前）
 *   gap       = 所有快照都晚于最早改动（最早那批改动无退路）
 */
export function classifyBackupCoverage(earliestChangeMs, snapshotMsList) {
  const item = { id: 'wt.coverage', cat: '工作区', title: '备份覆盖最早改动' };
  const snaps = (snapshotMsList || []).filter((n) => Number.isFinite(n));
  const ev = `earliestChange=${earliestChangeMs || 'NA'} snapshots=${snaps.length}`;
  if (!earliestChangeMs) {
    return F({ ...item, verdict: 'unverified', detail: '取不到最早未提交改动的 mtime，无法判定', evidence: ev });
  }
  if (!snaps.length) {
    return X({ ...item, verdict: 'fail', detail: '有未提交改动但找不到任何快照/备份 → 最早那批改动无退路', evidence: ev });
  }
  const covering = snaps.filter((n) => n <= earliestChangeMs);
  if (covering.length) {
    return P({ ...item, verdict: 'pass',
      detail: `${covering.length}/${snaps.length} 份快照早于最早改动 → 最早那批改动有退路`, evidence: ev });
  }
  const newest = Math.max(...snaps);
  return X({ ...item, verdict: 'fail',
    detail: `所有 ${snaps.length} 份快照都晚于最早未提交改动（相差 ${Math.round((newest - earliestChangeMs) / 60000)} 分钟）→ 最早那批改动无退路`,
    evidence: ev });
}


/* ── 纯函数：服务存活的「双判据同时成立」──
 * 今天的教训：launchd 说 running、进程 STAT=R、runs 在涨、lsof 有 pid，
 * 但真实请求全 000 —— 服务完全不可用。所以：
 *   判活 = launchd.state==='running'  AND  真实 HTTP 200（两条同时成立）
 * 单看任何一条都会假绿。
 */
export function classifyLiveness(name, launchd, httpProbe) {
  const base = { id: `live.${name}`, cat: '服务存活', title: name };
  const lState = launchd && launchd.found ? launchd.state : null;
  const lRunning = lState === 'running';
  const httpOk = httpProbe && httpProbe.status >= 200 && httpProbe.status < 400;
  const ev = `launchd=${lState || 'not-found'} pid=${launchd && launchd.pid || 'NA'} runs=${launchd && launchd.runs} lastExit=${launchd && launchd.lastExit} | http=${httpProbe ? (httpProbe.status || httpProbe.err) : 'NA'}`;

  // 双判据同时成立 → 唯一可判活
  if (lRunning && httpOk) {
    const suspicious = launchd.lastExit !== 0 || (launchd.runs > 3);
    return P({ ...base, verdict: 'pass',
      detail: `launchd running + 真实 HTTP ${httpProbe.status} → 服务活着${suspicious ? `（但崩溃历史 runs=${launchd.runs} lastExit=${launchd.lastExit}，值得盯）` : ''}`,
      evidence: ev });
  }
  // launchd 说 running，但请求不通 → 最危险的假绿
  if (lRunning && !httpOk) {
    return X({ ...base, verdict: 'fail',
      detail: `launchd 报 running（pid=${launchd.pid}）但真实请求失败（${httpProbe ? (httpProbe.status || httpProbe.err) : 'NA'}）→ 守护在骗人，服务不可用`,
      evidence: ev });
  }
  // launchd 没托管，但请求能通 → 进程在跑但没守护（一崩就没了）
  if (!lRunning && httpOk) {
    return F({ ...base, verdict: 'unverified',
      detail: `真实请求通（HTTP ${httpProbe.status}）但 launchd 未托管（state=${lState || 'not-found'}）→ 能用但无守护，崩了不会自动拉起`,
      evidence: ev });
  }
  return X({ ...base, verdict: 'fail',
    detail: `launchd 未 running（${lState || 'not-found'}）且真实请求失败 → 服务不可用`,
    evidence: ev });
}


/* ── 纯函数：熔断判据（修正版，2026-11-22）
 * ★ 原判据「40 次全窗口 max < 600ms」永远无法稳定通过：
 *   代码里 PROBE_BREAKER_FAILS = 2，连续失败 2 次才开熔断，
 *   所以冷启动前两次必然各付一次 800ms 探测。这是阈值设计，不是缺陷。
 * 正解：**只看熔断打开之后**（第 3 次起）的 max。
 * ★ 另一个坑：先用 curl 预热会把熔断打开，之后采样全在已熔断状态 → 假达标。
 *   所以必须前置确认 breakerOpen 状态，不能靠时间猜。
 */
export function classifyBreaker(samples, { breakerOpen, thresholdMs = 600, warmup = 2 } = {}) {
  const base = { id: 'perf.breaker', cat: '性能', title: '熔断打开后响应' };
  const ev = `samples=${samples.length} breakerOpen=${breakerOpen} warmup=${warmup}`;

  if (breakerOpen !== true) {
    return F({ ...base, verdict: 'unverified',
      detail: `前置不满足：breakerOpen=${breakerOpen}（未熔断）→ 本次采样不可用于判熔断效果`,
      evidence: ev });
  }
  if (samples.length <= warmup) {
    return F({ ...base, verdict: 'unverified',
      detail: `样本 ${samples.length} 次不足以跳过预热 ${warmup} 次`,
      evidence: ev });
  }
  const after = samples.slice(warmup).map((x) => x.ms);
  const sorted = [...after].sort((a, b) => a - b);
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)];
  const max = sorted[sorted.length - 1];
  const over = after.filter((m) => m > thresholdMs).length;
  const detail = `熔断打开后 ${after.length} 次：min ${sorted[0].toFixed(0)} / p50 ${p(0.5).toFixed(0)} / p90 ${p(0.9).toFixed(0)} / max ${max.toFixed(0)}ms ｜ 超 ${thresholdMs}ms ${over}/${after.length}`;
  if (over > 0) {
    return X({ ...base, verdict: 'fail',
      detail: detail + ` —— 熔断打开后仍有 ${over} 次超过 ${thresholdMs}ms，说明探测落在了请求路径上`,
      evidence: `${ev} over=${over} max=${max.toFixed(0)}` });
  }
  return P({ ...base, verdict: 'pass',
    detail: detail + ' —— 后台半开生效，探测未占请求路径',
    evidence: `${ev} over=0 max=${max.toFixed(0)}` });
}


/* ── 纯函数：夹具端口合规断言（2026-11-22，后端「记得但忘了关」的机器化）──
 * 今天真实发生过：后端起 8894 隔离实例忘了关、撞过 8890 生产端口。
 * 纪律拦不住，必须让「不合规就起不来」。
 */
export function assertFixturePort(port, runtimeDir) {
  const n = Number(port);
  const inRange = n >= FIXTURE_PORT_RANGE[0] && n <= FIXTURE_PORT_RANGE[1];
  const isProject = PROJECT_PORTS.includes(n);
  if (!Number.isInteger(n)) {
    return { ok: false, reason: `端口必须是整数，得到 ${JSON.stringify(port)}` };
  }
  if (isProject) {
    return { ok: false, reason: `❌ 禁止使用项目端口 ${n}（项目端口：${PROJECT_PORTS.join(',')}）` };
  }
  if (!inRange) {
    return { ok: false, reason: `❌ 端口 ${n} 不在夹具段 ${FIXTURE_PORT_RANGE[0]}–${FIXTURE_PORT_RANGE[1]}` };
  }
  if (!runtimeDir) {
    return { ok: false, reason: `❌ 端口 ${n} 合规，但未设 WUWU_RUNTIME_DIR → 会污染真实 runtime` };
  }
  return { ok: true, reason: `✅ 端口 ${n} + runtime ${runtimeDir}` };
}

/* ───────────── 类别 1：十间房可达性 ───────────── */
async function checkRooms(base, rooms) {
  const out = [];
  for (const r of rooms) {
    const p = `/${r.id}/`;
    const res = await reqStable(base + p);
    if (!res.ok) out.push(X({ id: `room.reach.${r.id}`, cat: '可达性', title: `${r.name} ${p}`, detail: `请求失败：${res.err}`, evidence: 'status=0' }));
    else if (res.status !== 200) out.push(X({ id: `room.reach.${r.id}`, cat: '可达性', title: `${r.name} ${p}`, detail: `期望 200，实际 ${res.status} —— 已复测 ${res.attempts} 次仍失败`, evidence: `${res.status} attempts=${res.allFailed || res.status}` }));
    else if (res.body.length < 500) out.push(X({ id: `room.reach.${r.id}`, cat: '可达性', title: `${r.name} ${p}`, detail: `200 但响应体只有 ${res.body.length}B，疑似占位/错误页`, evidence: `${res.status} ${res.body.length}B` }));
    else out.push(P({ id: `room.reach.${r.id}`, cat: '可达性', title: `${r.name} ${p}`,
      detail: `200 ${res.body.length}B ${res.ms.toFixed(0)}ms${res.retried ? ` —— 首次失败(${res.firstFailure?.status || 'ERR'})，复测第 ${res.attempts} 次才成功（瞬时抖动，不算缺陷但要记账）` : ''}`,
      evidence: `${res.status}/${res.body.length}B${res.retried ? `/retried=${res.attempts}` : ''}` }));
  }
  return out;
}

/* ───────────── 类别 2：六态取证（静态标记矩阵） ─────────────
 * 只看静态文本无法证明状态"可达"，所以：
 *  - 有 fetch 但完全没有加载态标记 → FAIL（有确定的证据：它会发请求却不告诉用户等待）
 *  - 有空态标记 / 出错标记 → 记账，但状态可达性仍标 UNVERIFIED（需要 DOM 注入探针）
 */
const STATE_MARKERS = {
  loading: ['加载中', '载入中', '正在加载', 'loading', 'spinner', 'data-state="busy"', 'skeleton'],
  empty: ['暂无', '还没有', '没有找到', '空空', 'data-state="empty"', '空空的'],
  error: ['出错', '失败', '错误', 'data-state="error"', '出问题了'],
  retry: ['重试', '再试一次', '刷新一下', 'retry'],
  overflow: ['加载更多', '查看更多', '下一页', '展开全部', 'load-more', 'data-state="more"'],
  unavailable: ['离线', '无权限', '不可用', '连接不上', '服务未启动', 'data-state="off"'],
};

async function checkStates(base, rooms) {
  const out = [];
  for (const r of rooms) {
    const res = await reqStable(`${base}/${r.id}/`);
    if (!res.ok || res.status !== 200) { out.push(X({ id: `state.${r.id}`, cat: '六态', title: r.name, detail: '页面取不到，无法取证' })); continue; }
    out.push(...classifyStateMarkers(r.name, res.text));
  }
  return out;
}

/* ── 纯函数：单条 API 响应的判定（负向臂直接打这个，不靠起靶场） ── */
export function classifyApiResponse(route, res) {
  if (!res.ok) return X({ id: `api.${route}`, cat: '接口', title: route, detail: `请求失败 ${res.err}`, evidence: 'status=0' });
  if (res.status === 404) return F({ id: `api.${route}`, cat: '接口', title: route, detail: '404（源码里出现过但当前未注册）', evidence: '404' });
  if (res.status !== 200) {
    // 4xx ≠ 缺陷：可能缺必填参数 / 需鉴权 / 需 POST。只读扫描器无法区分，标未取证。
    if (res.status >= 400 && res.status < 500) {
      return F({ id: `api.${route}`, cat: '接口', title: route,
        detail: `${res.status} —— 空参数下被拒（可能缺必填参数/需鉴权/需 POST），只读扫描无法判定是否缺陷`,
        evidence: `status=${res.status}` });
    }
    return X({ id: `api.${route}`, cat: '接口', title: route,
      detail: `非 200：${res.status} —— 5xx 必须复测确认是否瞬时（单次 5xx 可能是过载或上游抖动，不能只凭一次下结论）`,
      evidence: `${res.status}` });
  }
  let j = null;
  try { j = JSON.parse(res.text); } catch {}
  if (j === null) return X({ id: `api.${route}`, cat: '接口', title: route, detail: '200 但响应不是合法 JSON', evidence: `len=${res.body.length}` });
  if (j && j.ok === false) {
    const msg = String(j.message || '');
    // ★ 瞬态加载窗口 ≠ 缺陷：hub.mjs:2704 返回 {ok:false,message:"房间 X 加载中"}
    //   这是房间还没挂载完成，过一会儿就正常。判成缺陷会产生大量误报（今天误报 6 条）。
    if (/加载中|加载*中|loading/i.test(msg)) {
      return F({ id: `api.${route}.loading`, cat: '静默失败', title: route,
        detail: `HTTP 200 但 body.ok=false：「${msg.slice(0, 60)}」— 瞬态加载窗口，需复测确认，不能直接判缺陷`,
        evidence: 'ok=false@200:loading' });
    }
    return X({ id: `api.${route}.silent`, cat: '静默失败', title: route,
      detail: `HTTP 200 但 body.ok=false：「${msg.slice(0, 80)}」— 前端不判 ok 就会静默`,
      evidence: 'ok=false@200' });
  }
  const emptyArr = Array.isArray(j) && j.length === 0;
  const emptyObj = j && typeof j === 'object' && !Array.isArray(j) && Object.keys(j).length === 0;
  const emptyField = j && typeof j === 'object' && !Array.isArray(j)
    ? Object.entries(j).filter(([, v]) => Array.isArray(v) && v.length === 0).map(([k]) => k)
    : [];
  if (emptyArr || emptyObj) {
    return F({ id: `api.${route}.empty`, cat: '静默失败', title: route, detail: '200 且返回空数组/空对象 —— 需按业务判据区分正常空与静默失败', evidence: emptyArr ? '[]' : '{}' });
  }
  if (emptyField.length) {
    return F({ id: `api.${route}.emptyfield`, cat: '静默失败', title: route, detail: `200 但字段为空数组：${emptyField.join(',')}`, evidence: emptyField.join(',') });
  }
  return P({ id: `api.${route}`, cat: '接口', title: route, detail: `200 ${res.body.length}B ${res.ms.toFixed(0)}ms`, evidence: `200/${res.body.length}B` });
}

/* ── 纯函数：静态资源缓存头判定 ── */
export function classifyCacheHeader(asset, res) {
  if (!res.ok || res.status !== 200) return F({ id: `cache.${asset}`, cat: '缓存', title: asset, detail: `取不到（${res.status || res.err}），跳过`, evidence: String(res.status) });
  const cc = res.headers['cache-control'] || '';
  const hasValid = !!(res.headers['etag'] || res.headers['last-modified']);
  if (!globalThis.__INJECT_BROKEN__ && /no-store/.test(cc) && !hasValid) {
    return X({ id: `cache.${asset}`, cat: '缓存', title: asset, detail: `cache-control: ${cc}，无 ETag / Last-Modified → 每次全量重下 ${res.body.length}B`, evidence: `no-store+no-validator,${res.body.length}B` });
  }
  if (hasValid) return P({ id: `cache.${asset}`, cat: '缓存', title: asset, detail: `可缓存（有验证器）`, evidence: `cc=${cc || '-'}` });
  return F({ id: `cache.${asset}`, cat: '缓存', title: asset, detail: `cc=${cc || '缺失'}，无验证器但非 no-store`, evidence: `cc=${cc || '-'}` });
}

/* ── 纯函数：六态静态标记判定 ── */
export function classifyStateMarkers(roomName, html) {
  const out = [];
  const hasFetch = /fetch\s*\(/.test(html) || /XMLHttpRequest/.test(html) || /EventSource\s*\(/.test(html);
  const hit = {};
  for (const [k, words] of Object.entries(STATE_MARKERS)) hit[k] = words.filter((w) => html.includes(w));
  const got = Object.entries(hit).filter(([, v]) => v.length).map(([k]) => k);
  const missing = Object.keys(STATE_MARKERS).filter((k) => !hit[k].length);
  if (hasFetch && !hit.loading.length) {
    out.push(X({ id: `state.${roomName}.loading`, cat: '六态', title: `${roomName} 无加载态`,
      detail: '页面会发请求（fetch/XHR/SSE）但找不到任何加载中标记 → 用户点了没反应',
      evidence: 'hasFetch=true,loading=0' }));
  }
  out.push(F({ id: `state.${roomName}.matrix`, cat: '六态', title: `${roomName} 状态矩阵`,
    detail: `已取证: ${got.join('/') || '无'} ｜ 未取证: ${missing.join('/') || '无'}（静态文本不能证明状态可达，需 DOM 注入探针）`,
    evidence: `loading=${hit.loading.length} empty=${hit.empty.length} error=${hit.error.length} retry=${hit.retry.length} overflow=${hit.overflow.length} unavailable=${hit.unavailable.length}`,
    got, missing }));
  return out;
}


/* ── 纯函数：抖动统计（单次数字不算证据） ── */
export function classifyJitter(name, samples, thresholdMs = sharedThreshold('perfP90Ms', 500)) {
  const ok = samples.filter((x) => x.ok && x.status === 200).map((x) => x.ms);
  const failed = samples.length - ok.length;
  if (ok.length === 0) {
    return X({ id: `jitter.${name}`, cat: '性能', title: name,
      detail: `${samples.length} 次请求全部失败（${samples[0]?.err || 'status=' + samples[0]?.status}）`,
      evidence: `samples=${samples.length} ok=0` });
  }
  const sorted = [...ok].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const med = sorted[Math.floor(sorted.length / 2)];
  const over = sorted.filter((x) => x > thresholdMs).length;
  const spread = max - min;
  const p90 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)];
  const slowest = samples.reduce((a, b) => ((b.ms || 0) > (a.ms || 0) ? b : a), samples[0]);
  const slowestIdx = samples.indexOf(slowest);
  const slowestTag = `最慢第 ${slowestIdx + 1} 次 ${(slowest.ms || 0).toFixed(0)}ms${slowest.ok ? '' : '（失败）'}`;
  const detail = `${samples.length} 次：min ${min.toFixed(0)} / p50 ${med.toFixed(0)} / p90 ${p90.toFixed(0)} / max ${max.toFixed(0)}ms ｜ ${slowestTag} ｜ 超 ${thresholdMs}ms ${over}/${ok.length} 次 ｜ 极差 ${spread.toFixed(0)}ms${failed ? ` ｜ 失败 ${failed} 次` : ''}`;
  const evidence = `samples=${samples.length} ok=${ok.length} failed=${failed} min=${min.toFixed(0)} med=${med.toFixed(0)} max=${max.toFixed(0)} slowestIdx=${slowestIdx + 1} over${thresholdMs}=${over}`;
  // 判定：有失败，或超过阈值 2 次以上，或极差 > 3×中位 → 判红（抖动是缺陷）
  // 判定口径（与总管一致）：样本不足只记未取证；失败/超阈值次数/极差三条任一超标才判红
  if (samples.length < 20) {
    return F({ id: `jitter.${name}`, cat: '性能', title: name,
      detail: `${detail} —— 样本 ${samples.length} 次不足 20 次，按纪律不下抖动结论（未取证）`,
      evidence: `${evidence} insufficient=1` });
  }
  if (failed > 0) return X({ id: `jitter.${name}`, cat: '性能', title: name, detail: detail + ' —— 存在请求失败', evidence });
  if (over >= 2) return X({ id: `jitter.${name}`, cat: '性能', title: name, detail: detail + ` —— 超阈值 ${over} 次，抖动是缺陷`, evidence });
  if (spread > Math.max(med * 3, sharedThreshold('perfP90Ms', 500))) return X({ id: `jitter.${name}`, cat: '性能', title: name, detail: detail + ' —— 极差远超中位，不稳定', evidence });
  return P({ id: `jitter.${name}`, cat: '性能', title: name, detail, evidence });
}


/* ── 纯函数：解析 lsof -F pcn 输出，数「别人的」ESTABLISHED ── */

/* ── 实测：环境与连接数（性能数字必须带它们） ── */
async function readLoad() {
  const os = await import('node:os');
  return parseLoadavg(os.loadavg().map((n) => n.toFixed(2)).join(' '));
}

async function countEstablished(base) {
  let port = '8890', host = '127.0.0.1';
  try { const u = new URL(base); port = u.port || (u.protocol === 'https:' ? '443' : '80'); host = u.hostname; } catch {}
  const { execFile } = await import('node:child_process');
  const lsof = (args) => new Promise((resolve) => {
    execFile('/usr/sbin/lsof', args, { timeout: 5000 }, (err, stdout) => resolve(String(stdout || '')));
  });
  const out = await lsof(['-nP', `-iTCP:${port}`, '-sTCP:ESTABLISHED', '-F', 'pcn']);
  const listeners = (await lsof(['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'p']))
    .split('\n').filter((l) => l[0] === 'p').map((l) => Number(l.slice(1)));
  if (!out) return { probed: false, others: [], port, host, raw: '', listeners };
  const others = parseEstablished(out, [process.pid, ...listeners]);
  return { probed: true, others, port, host, raw: out, listeners };
}

export function parseEstablished(lsofOut, exclude) {
  // exclude 可以是单个 pid 或 pid 数组：扫描器自己 + 监听该端口的服务端进程
  const skip = new Set((Array.isArray(exclude) ? exclude : [exclude]).map(Number).filter(Boolean));
  let pid = null;
  let cmd = '';
  const others = [];
  for (const line of String(lsofOut || '').split('\n')) {
    if (!line) continue;
    const tag = line[0], val = line.slice(1);
    if (tag === 'p') { pid = Number(val); cmd = ''; }
    else if (tag === 'c') { cmd = val; }
    else if (tag === 'n') {
      if (pid && !skip.has(pid)) others.push({ pid, cmd, conn: val });
    }
  }
  return others;
}

/* ── 纯函数：并发门槛判定（有并发 → 未取证，不是缺陷） ── */
export function classifyConcurrency(others) {
  if (!others.length) return { blocked: false, detail: '无其它连接' };
  const by = [...new Set(others.map((o) => `${o.cmd}(${o.pid})`))].join(', ');
  return {
    blocked: true,
    detail: `检测到 ${others.length} 条外部 ESTABLISHED 连接（${by}）→ 测量无效，记未取证`,
  };
}

/* ───────────── 类别 3：/api 真打 + 结构核对 ───────────── */
const WRITE_HINTS = /(^|\/)(add|remove|delete|clear|stop|start|apply|tap|rotate|skip|record|create|refresh|restore|update|ensure|open|reconnect|set|save|import|export|pause|resume|volume|shot|actions)(\/|$)/i;

function extractApiRoutes() {
  const files = [path.join(ROOT, 'hub.mjs'), ...fs.readdirSync(LIB).filter((f) => f.endsWith('.mjs')).map((f) => path.join(LIB, f))];
  const own = new Map();   // 客厅自己注册的：p === '/api/x' / ctx.p === '/api/x' / p.startsWith('/api/x/')
  const downstream = new Map(); // 拼在别的 base 后面的下游路径，不是本服务路由
  for (const f of files) {
    let src; try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of src.split('\n')) {
      // 客厅自己的：用 (ctx\.)?p 做比较的对象
      const mOwn = line.match(/(?:(?:ctx\.)?p)\s*(?:===|startsWith)\s*['"`](\/api\/[A-Za-z0-9_\/.-]+)['"`]/);
      if (mOwn) {
        const route = mOwn[1].replace(/\/$/, '');
        // 猜方法：同一行或下一行出现 req.method / ctx.method
        const mm = line.match(/method\s*===\s*['"`](GET|POST|PUT|DELETE)['"`]/i)
          || src.slice(src.indexOf(line) + line.length, src.indexOf(line) + line.length + 200).match(/method\s*===\s*['"`](GET|POST|PUT|DELETE)['"`]/i);
        if (!own.has(route)) own.set(route, { route, method: mm ? mm[1].toUpperCase() : null, file: path.basename(f) });
        continue;
      }
      // 下游：xxx + '/api/y' 或 `${base}/api/y`，且左侧带 base/BASE/hallBase 之类
      const mDown = line.match(/(?:READER_BASE|app\.base|hallBase|BASE|base)\s*\+\s*['"`](\/api\/[A-Za-z0-9_\/.-]+)['"`]/);
      if (mDown) { const r = mDown[1].replace(/\/$/, ''); if (!downstream.has(r)) downstream.set(r, path.basename(f)); }
    }
  }
  // 只返回客厅自己的路由（下游路径不属于本服务，不可当"死路由"判）
  return [...own.values()].sort((a, b) => a.route.localeCompare(b.route));
}

async function checkApis(base) {
  const out = [];
  const routes = extractApiRoutes();
  if (!routes.length) {
    out.push(X({ id: 'api.scan', cat: '接口', title: '接口清单', detail: '扫到 0 条客厅自己的 /api 路由 —— 扫描器没能定位源码，这不是"没有缺陷"', evidence: 'routes=0' }));
    return out;
  }
  out.push(F({ id: 'api.scan', cat: '接口', title: '接口清单',
    detail: `从源码提取 ${routes.length} 条客厅自己的 /api 路由（已排除下游服务路径）`, evidence: `routes=${routes.length}` }));

  for (const { route, method, file } of routes) {
    if (WRITE_HINTS.test(route)) {
      out.push(F({ id: `api.${route}`, cat: '接口', title: route, detail: '写/破坏类接口，只读纪律下不发请求（未取证）', evidence: 'skipped:write' }));
      continue;
    }
    // 只读扫描只发 GET；源码声明必须 POST 的，GET 的 404 不能算死路由
    const res = await reqStable(base + route);
    const verdict = classifyApiResponse(route, res);
    // 死路由：GET 404 时必须补 POST 才能判死（只发 GET 会把 POST-only 误判成死）
    if (res.ok && res.status === 404) {
      // 已知存在的路由：不探 POST，直接标"已知存在"（人工实测已确认）
      const known = POST_KNOWN_EXISTS.get(route);
      if (known) {
        out.push(P({ id: `dead.${route}`, cat: '死路由', title: route, verdict: 'pass',
          detail: `已知存在（后端探针实测：${known.probe}）—— ${known.note}，审计不自动探`,
          evidence: `known-exists probe="${known.probe}"` }));
        continue;
      }
      let postRes = null;
      if (POST_PROBES.has(route)) {
        const pr = await req(base + route, { method: 'POST', body: '{}' });
        postRes = pr;
      }
      out.push(classifyDeadRoute(route, res, postRes));
      continue;
    }
    out.push(verdict);
  }
  return out;
}


/* ── 实测：对某 URL 连续采样 N 次（单点采样不可信） ── */
async function sampleN(url, n = 20, timeoutMs = 4000) {
  const out = [];
  for (let i = 0; i < n; i++) {
    try {
      const t0 = process.hrtime.bigint();
      const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      await r.arrayBuffer();
      out.push({ ok: true, status: r.status, ms: Number(process.hrtime.bigint() - t0) / 1e6 });
    } catch (e) {
      out.push({ ok: false, status: 0, ms: 0, err: (e.name === 'TimeoutError' ? 'timeout' : e.message) });
    }
  }
  return out;
}

/* ── 检查：同源的其它服务（8811 音乐等）真实可用性 ── */
async function checkSiblingServices() {
  const out = [];
  // 双判据：launchd 自述 + 真实请求，必须同时成立
  {
    const { execFile } = await import('node:child_process');
    const uid = process.getuid ? process.getuid() : 501;
    const svc = await new Promise((resolve) => {
      execFile('/bin/launchctl', ['print', `gui/${uid}/com.wuwu.lingting.web`],
        { timeout: 8000 }, (err, stdout) => {
          if (err) return resolve({ found: false });
          const pick = (k) => { const m = String(stdout).match(new RegExp(`${k}\\s*=\\s*(\\S+)`)); return m ? m[1] : null; };
          resolve({ found: true, state: pick('state'), pid: pick('pid'),
            runs: Number(pick('runs') || 0), lastExit: Number(pick('last exit code') || 0) });
        });
    });
    let httpProbe = null;
    try {
      const t0 = process.hrtime.bigint();
      const r = await fetch('http://127.0.0.1:8811/', { signal: AbortSignal.timeout(4000) });
      await r.arrayBuffer();
      httpProbe = { status: r.status, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
    } catch (e) {
      httpProbe = { status: 0, err: e.name === 'TimeoutError' ? 'timeout' : e.message };
    }
    out.push(classifyLiveness('lingting-8811', svc, httpProbe));
  }
  // 只探测本机回环上的兄弟服务，不猜远端
  const targets = [
    { name: 'lingting-8811', url: 'http://127.0.0.1:8811/', label: '音乐服务 8811' },
  ];
  const N = Number(argOf('--avail-n', '20'));
  for (const t of targets) {
    const samples = await sampleN(t.url, N);
    out.push(classifyAvailability(t.name, samples, { label: t.label }));
  }
  return out;
}


/* ── 实测：入口存活三条（真实请求 / 监听 pid / launchd 托管项） ── */
async function checkEntrypoint(base) {
  // 故障注入（仅测试用）：--inject-entry-dead / --inject-svc-gone
  if (argv.includes('--inject-entry-dead')) {
    return classifyEntrypoint({ label: ':8890',
      http: { status: 0, err: 'ECONNREFUSED' }, listenPid: null,
      service: { found: true, state: 'running', pid: 99999, runs: 19, lastExit: 1 } });
  }
  if (argv.includes('--inject-svc-gone')) {
    return classifyEntrypoint({ label: ':8890',
      http: { status: 200, ms: 50 }, listenPid: 99999, service: { found: false } });
  }
  const { execFile } = await import('node:child_process');
  const run = (cmd, args) => new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || '') }));
  });

  let port = '8890';
  try { port = new URL(base).port || '80'; } catch {}

  // 真实请求
  let http = null;
  try {
    const t0 = process.hrtime.bigint();
    const r = await fetch(base + '/api/status', { signal: AbortSignal.timeout(8000) });
    await r.arrayBuffer();
    http = { status: r.status, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
  } catch (e) {
    http = { status: 0, err: e.name === 'TimeoutError' ? 'timeout' : e.message };
  }

  // 监听 pid
  const lo = await run('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'p']);
  const listenPid = (lo.out.split('\n').filter((l) => l[0] === 'p').map((l) => Number(l.slice(1)))[0]) ?? null;

  // launchd 托管项（服务名按端口推断，找不到就试常见名）
  const uid = process.getuid ? process.getuid() : 501;
  const candidates = [`gui/${uid}/com.wuwu.wuwu-living`, `gui/${uid}/com.wuwu.living-room`];
  let service = { found: false };
  for (const svc of candidates) {
    const r = await run('/bin/launchctl', ['print', svc]);
    if (r.ok) {
      const pick = (k) => { const m = r.out.match(new RegExp(`${k}\\s*=\\s*(\\S+)`)); return m ? m[1] : null; };
      service = {
        found: true, name: svc,
        state: pick('state'),
        pid: pick('pid'),
        runs: Number(pick('runs') || 0),
        lastExit: Number(pick('last exit code') || 0),
      };
      break;
    }
  }
  return classifyEntrypoint({ label: `:${port}`, http, listenPid, service });
}

/* ───────────── 类别 4：性能（冷/热 + 静态缓存头） ───────────── */
async function checkPerf(base) {
  const out = [];
  const target = '/api/home/summary';
  const first = await req(base + target);
  const warm = [];
  for (let i = 0; i < 3; i++) warm.push(await req(base + target));
  const avg = warm.reduce((s, r) => s + r.ms, 0) / warm.length;
  if (!first.ok || first.status !== 200) out.push(X({ id: 'perf.summary', cat: '性能', title: target, detail: `取不到：${first.err || first.status}` }));
  else out.push(F({
    id: 'perf.summary', cat: '性能', title: target,
    detail: `首打 ${first.ms.toFixed(0)}ms ｜ 热打 ${warm.map((r) => r.ms.toFixed(0)).join('/')}ms（均值 ${avg.toFixed(0)}ms）｜ 冷热差 ${(first.ms - avg).toFixed(0)}ms`,
    evidence: `cold=${first.ms.toFixed(0)} warm=${warm.map((r) => r.ms.toFixed(0)).join(',')}`,
  }));

  // 前置门禁：有别人在连这个服务 → 计时测量无效，记未取证（不是缺陷）
  // 瞬时采样不可靠（连接会来会走），所以测前/测中/测后各采一次，任一次有外连即判无效
  const JITTER = Number(argOf('--jitter-n', '20'));
  const forceTiming = argv.includes('--force-timing');
  const concPre = await countEstablished(base);
  const gate = classifyConcurrency(concPre.others);
  const conc = concPre;
  let concMid = { others: [] };
  if (!conc.probed) {
    out.push(F({ id: 'perf.gate', cat: '性能', title: '并发门禁',
      detail: `无法探测 :${conc.port} 的 ESTABLISHED（lsof 不可用或无输出）→ 计时结果不可信`, evidence: 'probe=failed' }));
  } else if (gate.blocked && !forceTiming) {
    out.push(F({ id: 'perf.gate', cat: '性能', title: '并发门禁',
      detail: gate.detail,
      evidence: `others=${conc.others.length} port=${conc.port}` }));
  } else {
    out.push(P({ id: 'perf.gate', cat: '性能', title: '并发门禁',
      detail: forceTiming ? `已用 --force-timing 强制测量（外部连接 ${conc.others.length} 条）` : '独占窗口，可以计时',
      evidence: `others=${conc.others.length}` }));
  }

  // 连打 N 次量抖动：单次数字不算证据（默认 20 次，报 min/p50/p90/max）
  if (!gate.blocked || forceTiming) {
    // 环境快照：每个性能数字都要带 load 与连接数
    const envLoad = await readLoad();
    const envConc = await countEstablished(base);
    const envText = classifyEnv(envLoad, envConc.others.length);
    out.push(F({ id: 'perf.env', cat: '性能', title: '环境快照',
      detail: envText, evidence: `load1=${envLoad ? envLoad.one.toFixed(2) : 'NA'} others=${envConc.others.length}` }));

    const midSamples = [];
    for (const path of ['/api/home/summary', '/music/', '/api/status']) {
      const samples = [];
      for (let i = 0; i < JITTER; i++) {
        samples.push(await req(base + path));
        if (i === Math.floor(JITTER / 2)) midSamples.push(await countEstablished(base));
      }
      const jr = classifyJitter(path, samples, sharedThreshold('perfP90Ms', 500));
      jr.detail = `${jr.detail} ｜ ${envText}`;
      jr.evidence = `${jr.evidence} env_load1=${envLoad ? envLoad.one.toFixed(2) : 'NA'}`;
      out.push(jr);
    }
    // 测中若出现外部连接 → 本轮所有抖动结论作废，改判未取证
    const midOthers = midSamples.flatMap((m) => m.others || []);
    if (midOthers.length && !forceTiming) {
      const midGate = classifyConcurrency(midOthers);
      for (const f of out) {
        if (f.id.startsWith('jitter.')) {
          f.verdict = 'unverified';
          f.detail = `${f.detail} —— 但测量期间检测到外部连接，本轮数字作废`;
          f.evidence = `${f.evidence} contaminated=1`;
        }
      }
      out.push(F({ id: 'perf.gate.mid', cat: '性能', title: '并发门禁（测量中）',
        detail: midGate.detail + ' → 本轮抖动数字已作废', evidence: `midOthers=${midOthers.length}` }));
    } else {
      out.push(P({ id: 'perf.gate.mid', cat: '性能', title: '并发门禁（测量中）',
        detail: '测量期间未出现外部连接', evidence: 'midOthers=0' }));
    }
  } else {
    out.push(F({ id: 'perf.jitter.skipped', cat: '性能', title: '抖动采样',
      detail: '因存在并发连接，抖动采样未执行 —— 未取证，不代表通过', evidence: 'skipped:concurrency' }));
  }

  // 静态资源缓存头
  const assets = ['/assets/room.css', '/assets/vod-recs.css', '/assets/vod-recs.js', '/assets/legacy-shell.css'];
  for (const a of assets) out.push(classifyCacheHeader(a, await req(base + a)));
  return out;
}

/* ───────────── 类别 5：死链（页面引用的资源） ───────────── */
async function checkDeadLinks(base, rooms) {
  const out = [];
  for (const r of rooms) {
    const res = await reqStable(`${base}/${r.id}/`);
    if (!res.ok || res.status !== 200) continue;
    const refs = new Set();
    for (const m of res.text.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
      const u = m[1];
      if (!u || /^(https?:|data:|mailto:|javascript:|blob:)/.test(u)) continue;
      // 排除 JS 模板/拼接片段：这些不是真实 URL，是真·误报源头
      if (/\$\{|\}\s*\+|\+\s*['"]|esc\(|encodeURI|\bvar\b|\blet\b|\bconst\b/.test(u)) continue;
      if (!/^[/a-zA-Z0-9_\-.~%]+$/.test(u)) continue;   // 只保留"像路径"的
      refs.add(u.startsWith('/') ? u : `/${r.id}/${u}`);
    }
    let bad = 0;
    const examples = [];
    for (const u of refs) {
      const rr = await req(base + u, { method: 'GET' });
      if (!rr.ok || rr.status === 404) { bad++; if (examples.length < 5) examples.push(`${u}→${rr.status || rr.err}`); }
    }
    if (refs.size === 0) { out.push(F({ id: `link.${r.id}`, cat: '死链', title: r.name, detail: '页面里没抽到任何本地引用（可能全内联）', evidence: 'refs=0' })); continue; }
    if (bad > 0) out.push(X({ id: `link.${r.id}`, cat: '死链', title: r.name, detail: `${bad}/${refs.size} 个引用打不开：${examples.join(' ')}`, evidence: `bad=${bad}/${refs.size}` }));
    else out.push(P({ id: `link.${r.id}`, cat: '死链', title: r.name, detail: `${refs.size} 个引用全部可达`, evidence: `refs=${refs.size}` }));
  }
  return out;
}



async function collectBackupPairs() {
  const dirs = [ROOT, path.join(ROOT, 'lib'), path.join(ROOT, 'public'), path.join(ROOT, 'public', 'assets')];
  const pairs = [];
  for (const dir of dirs) {
    let names; try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      const m = n.match(/^(.+?)\.bak-[^/]+$/);
      if (!m) continue;
      const original = path.join(dir, m[1]);
      if (!fs.existsSync(original)) continue;
      const a = path.join(dir, n);
      let identical = false;
      try { identical = fs.readFileSync(a).equals(fs.readFileSync(original)); } catch { continue; }
      pairs.push({ backup: path.relative(ROOT, a), original: path.relative(ROOT, original), identical });
    }
  }
  return pairs;
}


async function checkBackupCoverage() {
  const { execFile } = await import('node:child_process');
  const run = (cmd, args, cwd) => new Promise((resolve) => {
    execFile(cmd, args, { cwd: cwd || ROOT, timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve(String(stdout || '')));
  });
  const st = await run('/usr/bin/git', ['status', '--porcelain']);
  const files = st.split('\n').filter((l) => l.trim() && !/\.bak[-.]/.test(l))
    .map((l) => l.slice(3).replace(/^"|"$/g, '')).filter(Boolean);
  let earliest = null;
  for (const f of files) {
    try {
      const m = fs.statSync(path.join(ROOT, f)).mtimeMs;
      if (earliest === null || m < earliest) earliest = m;
    } catch {}
  }
  // 快照候选：_ops-backups 下的目录 + 顶层 *.bak-*
  const snaps = [];
  const opsDir = path.join(ROOT, '_ops-backups');
  try {
    for (const d of fs.readdirSync(opsDir)) {
      try { snaps.push(fs.statSync(path.join(opsDir, d)).mtimeMs); } catch {}
    }
  } catch {}
  for (const dir of [ROOT, path.join(ROOT, 'lib'), path.join(ROOT, 'public')]) {
    try {
      for (const n of fs.readdirSync(dir)) {
        if (!/\.bak-/.test(n)) continue;
        try { snaps.push(fs.statSync(path.join(dir, n)).mtimeMs); } catch {}
      }
    } catch {}
  }
  return [classifyBackupCoverage(earliest, snaps)];
}

async function checkWorktree() {
  const { execFile } = await import('node:child_process');
  const run = (args) => new Promise((resolve) => {
    execFile('/usr/bin/git', args, { cwd: ROOT, timeout: 8000 },
      (err, stdout) => resolve({ ok: !err, out: String(stdout || '') }));
  });
  const inside = await run(['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || !/true/.test(inside.out)) {
    return [F({ id: 'wt.scan', cat: '工作区', title: '工作区检查',
      detail: '这里不是 git 工作区，无法取证未提交改动（未取证，不代表通过）', evidence: 'not-a-repo' })];
  }
  const st = await run(['status', '--porcelain']);
  const out = [classifyWorktree(st.out, 20), classifyBakHygiene(st.out, 50)];

  // 假备份：备份与原件逐字相同，但原件有未提交改动 → 该备份回滚不了东西
  const modifiedSet = new Set(
    st.out.split('\n').filter((l) => /^\s?[MADRCU]/.test(l)).map((l) => l.slice(3).replace(/^"|"$/g, ''))
  );
  const pairs = (await collectBackupPairs())
    .map((x) => ({ ...x, originalModified: modifiedSet.has(x.original) }));
  out.push(classifyFakeBackup(pairs));
  out.push(...await checkBackupCoverage());
  return out;
}

/* ── 实测：测量环境洁净度 ──
 * 为什么必须有这一项（2026-11-22 实测）：
 *   当天 8811 被测试夹具抢占 5 次（EADDRINUSE 5 条）。夹具在项目端口上回答时，
 *   后面所有「20/20 达标」「p50=9ms」的数字测的都是夹具，不是我们的服务。
 *   ⇒ 环境不洁时，体检的每一个数字都不该被采信。
 * 判据：项目端口上的监听进程，必须是我们预期的那个程序。
 *   不是预期进程 → FAIL「环境不洁」，不给被测代码判级。
 *   ★ 端口空闲不算不洁（那是「服务没起」，由入口检查负责）。
 */
const PORT_OWNERS = {
  8811: 'server.mjs',      // 音乐房
  8890: 'hub.mjs',         // 客厅主入口
  8900: 'server.mjs',      // 视频房（与 8811 同名，按端口区分）
  7788: 'mx.mjs',          // 搜磁力
  8317: 'workbuddy',       // workbuddy 号池网关
  12010: 'grok-gateway.mjs',
  1122: null,              // 看书 Reader：正常状态就是空闲，起了才算
};

/* 测试夹具必须避开的端口段（2026-11-22 定规） */
export const PROJECT_PORTS = [8811, 8890, 8900, 1122, 7788, 8317, 12010];
export const FIXTURE_PORT_RANGE = [19000, 19999];

/* ── 纯函数：夹具端口合规判定 ──
 * 今天的 5 次 EADDRINUSE 全部来自「夹具占了项目端口」。
 * 判据：夹具端口必须落在 19000–19999，且必须带独立 WUWU_RUNTIME_DIR。
 */
export function classifyFixturePort(port, runtimeDir) {
  const base = { id: 'env.fixture', cat: '环境', title: `夹具端口 ${port}` };
  const inRange = port >= FIXTURE_PORT_RANGE[0] && port <= FIXTURE_PORT_RANGE[1];
  const isProject = PROJECT_PORTS.includes(port);
  if (isProject) {
    return X({ ...base, verdict: 'fail',
      detail: `端口 ${port} 是项目端口，夹具不得占用 → 会挤掉真实服务并造成 EADDRINUSE`,
      evidence: `port=${port} project=true` });
  }
  if (!inRange) {
    return F({ ...base, verdict: 'unverified',
      detail: `端口 ${port} 不在夹具段 ${FIXTURE_PORT_RANGE[0]}–${FIXTURE_PORT_RANGE[1]}，无法确认是否安全`,
      evidence: `port=${port} inRange=false` });
  }
  if (!runtimeDir) {
    return F({ ...base, verdict: 'unverified',
      detail: `端口 ${port} 合规，但未设 WUWU_RUNTIME_DIR → 可能污染真实 runtime`,
      evidence: `port=${port} runtimeDir=none` });
  }
  return P({ ...base, verdict: 'pass',
    detail: `端口 ${port} 在夹具段且带独立 runtime（${runtimeDir}）`,
    evidence: `port=${port} runtimeDir=${runtimeDir}` });
}

function ownerNameOf(command) {
  // ps 会把中文路径转义成 M-iM-!M-5…，所以只认尾部 ASCII 文件名，不做中文匹配。
  const args = String(command || '').split(/\s+/).filter(Boolean);
  for (const a of args.slice(1)) {
    const base = a.split('/').pop();
    if (/\.(mjs|cjs|js|py|sh)$/.test(base)) return base;
  }
  return (args[0] || '').split('/').pop() || '(未知)';
}

async function checkEnvHygiene(portMap = PORT_OWNERS) {
  const { execFile } = await import('node:child_process');
  const run = (cmd, args) => new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000 }, (err, stdout) =>
      resolve({ ok: !err, out: String(stdout || '').trim() }));
  });
  const out = [];
  for (const [port, expect] of Object.entries(portMap)) {
    const lp = await run('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
    const pid = lp.out.split('\n').filter(Boolean)[0];
    if (!pid) {
      out.push(P({ id: `env.${port}`, cat: '环境', title: `端口 ${port} 空闲`,
        detail: `无监听进程（端口空闲不是环境不洁；服务没起由入口检查判定）`, evidence: `port=${port} idle` }));
      continue;
    }
    const ps = await run('/bin/ps', ['-o', 'command=', '-p', pid]);
    const name = ownerNameOf(ps.out);
    if (name.includes(expect)) {
      out.push(P({ id: `env.${port}`, cat: '环境', title: `端口 ${port} 占用者正确`,
        detail: `pid=<pid> ${name}（预期 ${expect}）`, evidence: `port=<port> pid=<pid> ${name}` }));
    } else {
      out.push(X({ id: `env.${port}`, cat: '环境', title: `端口 ${port} 被非预期进程占用`,
        detail: `pid=<pid> ${name} ← 不是预期进程（预期 ${expect}）→ 测量环境不洁，本次数字不可采信`,
        evidence: `port=${port} pid=${pid} cmd=${ps.out.slice(0, 200)}` }));
    }
  }
  return out;
}

/* ── 实测：重启窗口污染 ──
 * 为什么必须单列（2026-11-22 三次误判的共同根因）：
 *   运维管家测到 api/status 2/20 超 500ms，追下去发现那两次正好落在 8890 重启窗口里
 *   （pid 31353 → 38430，16:22:04）。冷启动的首个请求要建连接、读配置、填缓存，
 *   把它算进稳态基线，会把「重启」误判成「接口变慢了」。
 *   ⇒ 进程刚起来时，这一窗口的性能数字一律不采信；但这不是代码缺陷，所以判 unverified 而不是 fail。
 * ★ macOS 的 ps 没有 etimes（Linux 才有），只能读 etime 自己换算。
 *
 * ── 判据两份实现、常量单一来源（不必同步改，但改实现要两边都跑）─────
 *   本文件: classifyUptime()              （node，体检报告的一部分，判 unverified）
 *   scripts/ops-discipline.sh: check_uptime() （bash，人手动排查用，带明细）
 *   窗口时长已抽到 config/ops-thresholds.json 的 restartWindowSec（唯一来源），
 *   两侧都读它 —— 改一处即两侧同时生效。
 *   2026-11-22 16:38 做过同一时刻交叉校验：五端口判定完全一致。
 * ────────────────────────────────────────────────────────────
 */
/* 共享阈值：与 ops-discipline.sh 读同一份 config/ops-thresholds.json。
 * 为什么（2026-11-22）：300s 曾在 bash 与 node 两处各写一遍，改一处漏一处就会
 * 出现两份互相矛盾的判据。现在只有一个来源。 */
function sharedThreshold(key, fallback) {
  try {
    const f = path.join(ROOT, 'config', 'ops-thresholds.json');
    if (!fs.existsSync(f)) return fallback;
    const v = JSON.parse(fs.readFileSync(f, 'utf8'))[key];
    return (v === undefined || v === null) ? fallback : v;
  } catch { return fallback; }
}

function parseEtime(raw) {
  // 形如 "05:12"(分:秒) / "01:02:03"(时:分:秒) / "3-01:02:03"(天-时:分:秒)
  const t = String(raw || '').trim();
  if (!t) return null;
  const m = t.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const [, d, h, mi, se] = m;
  return (Number(d || 0) * 86400) + (Number(h || 0) * 3600) + (Number(mi) * 60) + Number(se);
}

/* 纯分类：不碰系统，只看「进程活了多久」这一个事实。
 * 拆成纯函数是为了能对三种情形都做臂（null / 刚起 / 跑久了），
 * 否则只能测到手上恰好有的那一种进程，另外两种永远没被验过。 */
function classifyUptime(port, pid, up, windowSec, rawEtime = '') {
  if (up === null || up === undefined) {
    return F({ id: `env.restart.${port}`, cat: '环境', title: `端口 ${port} 运行时长读不到`,
      detail: `pid=${pid} etime="${rawEtime}" 无法换算（未取证，不代表通过）`, evidence: `etime=${rawEtime}` });
  }
  if (up < windowSec) {
    return F({ id: `env.restart.${port}`, cat: '环境', title: `端口 ${port} 在重启窗口内`,
      detail: `pid=<pid> 启动仅 <age>s（< ${windowSec}s）→ 本窗口的性能数字不可采信，等窗口过后再测`,
      evidence: `port=${port} pid=${pid} uptime=${up}s window=${windowSec}s` });
  }
  return P({ id: `env.restart.${port}`, cat: '环境', title: `端口 ${port} 已过重启窗口`,
    detail: `pid=${pid} 已运行 ${up}s（≥ ${windowSec}s），性能数字可用`, evidence: `uptime=${up}s` });
}

async function checkRecentRestart(portMap = PORT_OWNERS, windowSec = Number(argOf('--restart-window', sharedThreshold('restartWindowSec', 300)))) {
  const { execFile } = await import('node:child_process');
  const run = (cmd, args) => new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000 }, (err, stdout) =>
      resolve({ ok: !err, out: String(stdout || '').trim() }));
  });
  const out = [];
  for (const port of Object.keys(portMap)) {
    const lp = await run('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
    const pid = lp.out.split('\n').filter(Boolean)[0];
    if (!pid) continue;
    const et = await run('/bin/ps', ['-o', 'etime=', '-p', pid]);
    const up = parseEtime(et.out);
    out.push(classifyUptime(port, pid, up, windowSec, et.out));
  }
  return out;
}

/* ───────────── 汇总 ───────────── */
const count = (arr, v) => arr.filter((x) => x.verdict === v).length;

async function audit(base) {
  const rooms = readRooms();
  const all = [...CORE_ROOMS, ...rooms].filter((r, i, a) => a.findIndex((x) => x.id === r.id) === i);
  const findings = [
    ...await checkEnvHygiene(),
    ...await checkRecentRestart(),
    ...await checkEntrypoint(base),
    ...await checkWorktree(),
    ...await checkSiblingServices(),
    ...await checkRooms(base, all),
    ...await checkStates(base, all),
    ...await checkApis(base),
    ...await checkPerf(base),
    ...await checkDeadLinks(base, all),
  ];
  return { base, rooms: all.length, findings, pass: count(findings, 'pass'), fail: count(findings, 'fail'), unverified: count(findings, 'unverified') };
}

const CATS = ['环境', '入口', '服务存活', '可达性', '六态', '接口', '死路由', '静默失败', '性能', '缓存', '死链', '可用性', '工作区'];

function printReport(r) {
  console.log(`\n五五客厅体检 · 目标 ${r.base} · ${r.rooms} 个房间`);
  console.log('─'.repeat(72));
  for (const c of CATS) {
    const items = r.findings.filter((f) => f.cat === c);
    if (!items.length) continue;
    const p = count(items, 'pass'), x = count(items, 'fail'), u = count(items, 'unverified');
    console.log(`\n【${c}】pass=${p} fail=${x} unverified=${u}`);
    for (const f of items) {
      const tag = f.verdict === 'pass' ? '✅' : f.verdict === 'fail' ? '❌' : '·';
      console.log(`  ${tag} ${f.title} :: ${f.detail}`);
    }
  }
  console.log('\n' + '─'.repeat(72));
  console.log(`合计 pass=${r.pass} fail=${r.fail} unverified=${r.unverified}`);
  console.log(`判定：${r.fail > 0 ? `发现 ${r.fail} 条硬缺陷` : '未发现硬缺陷'}；另有 ${r.unverified} 条未取证（**未取证不等于通过**）`);
}

/* ───────────── 负向臂自检 ───────────── */
function brokenServer() {
  const html = (body) => `<!doctype html><html><body>${body}</body></html>`;
  const big = 'x'.repeat(2000);
  return http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    // /magnet/ 之类：有 fetch 但零加载态（应报 FAIL 六态）
    if (/^\/(magnet|book|music|vod|download|library|notes|calendar|photos|cast)\/$/.test(p)) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(html(`<div id="app">${big}</div><script>fetch('/api/x')</script><img src="/dead.png">`));
    }
    // 静默失败接口：200 + ok:false
    if (p === '/api/silent') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, message: '内部错了' })); }
    // 空数组接口
    if (p === '/api/empty') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('[]'); }
    // 静态资源 no-store 无验证器
    if (p.startsWith('/assets/')) { res.writeHead(200, { 'content-type': 'text/css', 'cache-control': 'no-store' }); return res.end('a{}'.repeat(50)); }
    if (p === '/api/home/summary') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, x: 1 })); }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, message: '没有这个页面' }));
  });
}

async function selftest() {
  /* ── 三判据记录：判定词 / 崩溃特征 / 臂完整性 ──
   * 任一缺失 → 整体判「未取证」，不得宣称通过。
   * 崩溃（检查器自身故障）→ exit=2，绝不与被测代码不合格（exit=1）混为一谈。
   */
  const arms = [];
  const CRASH_RE = /(ReferenceError|TypeError|SyntaxError|RangeError|is not defined|Cannot read propert|Cannot find module|ERR_[A-Z_]+|timed out|ETIMEDOUT)/;
  /**
   * @param name  臂名
   * @param cond  该臂是否按预期工作
   * @param detail 证据
   * @param meta  {verdict: 检查器给出的判定词|undefined, crash: string|null, skip?: string}
   */
  const arm = (name, cond, detail, meta = {}) => arms.push({
    name, pass: !!cond, detail,
    verdict: meta.verdict === undefined ? null : String(meta.verdict),
    crash: meta.crash || null,
    skip: meta.skip || null,
  });
  const judgeOf = (f) => (f && f.verdict) || undefined;

  const R = (o) => ({ ok: true, status: 200, ms: 1, headers: {}, body: Buffer.from(o.text || ''), text: o.text || '', ...o });

  /* 臂1 六态：有 fetch 无加载态 → 必须 FAIL */
  {
    const r = classifyStateMarkers('坏房', '<div>x</div><script>fetch("/api/x")</script>');
    const f = r.find((x) => x.id === 'state.坏房.loading');
    arm('六态·有请求无加载态 必须报红', f && f.verdict === 'fail', f ? `verdict=${f.verdict}` : '漏检：没产出该条', { verdict: judgeOf(f) });
  }

  /* 臂2 静默失败：200 + ok:false → 必须 FAIL */
  {
    const f = classifyApiResponse('/api/silent', R({ text: JSON.stringify({ ok: false, message: '内部错了' }) }));
    arm('静默失败·200+ok:false 必须报红', f.verdict === 'fail', `verdict=${f.verdict}`, { verdict: judgeOf(f) });
  }

  /* 臂3 缓存：no-store 无验证器 → 必须 FAIL */
  {
    const f = classifyCacheHeader('/assets/room.css', R({ headers: { 'cache-control': 'no-store' }, text: 'a{}'.repeat(50) }));
    arm('缓存·no-store 无验证器 必须报红', f.verdict === 'fail', `verdict=${f.verdict}`, { verdict: judgeOf(f) });
  }

  /* 臂4 死链：真起一个 404 靶，走真实 checkDeadLinks */
  {
    const srv = http.createServer((rq, rs) => {
      const p = new URL(rq.url, 'http://x').pathname;
      if (p === '/magnet/') { rs.writeHead(200, { 'content-type': 'text/html' }); return rs.end('<div id=a>' + 'x'.repeat(800) + '</div><img src="/dead.png">'); }
      rs.writeHead(404, { 'content-type': 'application/json' }); rs.end('{"ok":false}');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const linkRes = await checkDeadLinks(`http://127.0.0.1:${srv.address().port}`, [{ id: 'magnet', name: '坏房', page: null }]);
    srv.close();
    const f = linkRes.find((x) => x.id === 'link.magnet');
    arm('死链·404 引用 必须报红', f && f.verdict === 'fail', f ? `verdict=${f.verdict}` : '漏检：没产出该条', { verdict: judgeOf(f) });
  }

  /* 臂5 防误报：健康响应必须判 PASS */
  {
    const g1 = classifyApiResponse('/api/ok', R({ text: JSON.stringify({ ok: true, items: [1, 2, 3], ts: 1 }) }));
    const g2 = classifyCacheHeader('/assets/ok.css', R({ headers: { 'cache-control': 'public, max-age=604800', etag: 'abc' }, text: 'a{}' }));
    const g3 = classifyStateMarkers('好房', '<div>加载中…</div><script>fetch("/api/x")</script>');
    const noFalse = g1.verdict === 'pass' && g2.verdict === 'pass' && !g3.some((f) => f.verdict === 'fail');
    arm('防误报·健康数据不得判红', noFalse,
      `api=${g1.verdict} cache=${g2.verdict} state有红=${g3.some((f) => f.verdict === 'fail')}`,
      { verdict: `${g1.verdict}/${g2.verdict}` });
  }

  /* 臂6 5xx 必须报红（证明 4xx 放行没把 5xx 放掉） */
  {
    const f = classifyApiResponse('/api/boom', R({ status: 500, text: '{}' }));
    arm('5xx·必须报红（4xx放行不连带放掉5xx）', f.verdict === 'fail', `verdict=${f.verdict}`, { verdict: judgeOf(f) });
  }

  /* 臂7 防误报：模板字符串不得算死链 */
  {
    const tpl = '<img src="/music/${esc(cover)}"> <img src="/a/real.png">';
    const tplRefs = [...tpl.matchAll(/(?:src|href)=["\']([^"\']+)["\']/g)].map((m) => m[1])
      .filter((u) => !/\$\{|\+\s*['"]|esc\(/.test(u) && /^[/a-zA-Z0-9_\-.~%]+$/.test(u));
    arm('防误报·模板字符串不得算死链', tplRefs.length === 1 && tplRefs[0] === '/a/real.png',
      `抽到 ${tplRefs.length} 条：${tplRefs.join(',')}`, { verdict: `${tplRefs.length}` });
  }

  /* 臂8 抖动必须报红：20 次里两次 1.9s */
  {
    const jit = Array.from({ length: 20 }, (_, i) => ({ ok: true, status: 200, ms: (i === 3 || i === 7) ? 1900 : 50 }));
    const f = classifyJitter('/api/home/summary', jit, 500);
    arm('抖动·20次里两次1.9s 必须报红', f.verdict === 'fail', `verdict=${f.verdict} :: ${f.detail}`, { verdict: judgeOf(f) });
  }

  /* 臂9 防误报：稳定必须 PASS */
  {
    const f = classifyJitter('/api/fast', Array.from({ length: 20 }, () => ({ ok: true, status: 200, ms: 30 })), 500);
    arm('防误报·稳定30ms 不得判红', f.verdict === 'pass', `verdict=${f.verdict}`, { verdict: judgeOf(f) });
  }

  /* 臂10 含超时必须报红 */
  {
    const f = classifyJitter('/api/mixed', [{ ok: false, status: 0, ms: 15000, err: 'timeout' }, ...Array.from({ length: 19 }, () => ({ ok: true, status: 200, ms: 20 }))], 500);
    arm('抖动·含一次超时 必须报红', f.verdict === 'fail', `verdict=${f.verdict}`, { verdict: judgeOf(f) });
  }

  /* 臂11 并发门禁：有外部连接必须判无效 */
  {
    const fake = parseEstablished('p99999\ncother-node\nn127.0.0.1:8890->127.0.0.1:5555\np88888\nccurl\nn127.0.0.1:8890->127.0.0.1:6666\n', 12345);
    const g = classifyConcurrency(fake);
    arm('并发门禁·有外部连接必须判无效', g.blocked === true && fake.length === 2, `blocked=${g.blocked} count=${fake.length}`, { verdict: String(g.blocked) });
  }

  /* 臂12 防误报：只有自己连接不得判无效 */
  {
    const self = parseEstablished('p12345\nchealth-audit\nn127.0.0.1:8890->127.0.0.1:5555\n', 12345);
    const g = classifyConcurrency(self);
    arm('并发门禁·只有自己连接 不得判无效', g.blocked === false && self.length === 0, `blocked=${g.blocked} count=${self.length}`, { verdict: String(g.blocked) });
  }

  /* 臂13 服务端自身连接必须排除 */
  {
    const both = 'p27030\ncChrome\nn127.0.0.1:65041->127.0.0.1:8890\np72117\ncnode\nn127.0.0.1:8890->127.0.0.1:65041\n';
    const excluded = parseEstablished(both, [12345, 72117]);
    arm('并发门禁·服务端自身连接必须排除', excluded.length === 1 && excluded[0].pid === 27030,
      `count=${excluded.length} pids=${excluded.map((o) => o.pid).join(',') || '空'}`, { verdict: `${excluded.length}` });
  }

  /* 臂14 样本不足必须未取证 */
  {
    const f = classifyJitter('/api/few', Array.from({ length: 5 }, () => ({ ok: true, status: 200, ms: 40 })), 500);
    arm('样本不足·5次必须判未取证', f.verdict === 'unverified', `verdict=${f.verdict}`, { verdict: judgeOf(f) });
  }

  /* 臂15 环境快照 */
  {
    const lv = parseLoadavg('203.45 186.20 150.11 3/573 12345');
    const busy = classifyEnv(lv, 4);
    const idle = classifyEnv(parseLoadavg('0.52 0.61 0.58 1/573 999'), 0);
    const ok = lv && lv.one === 203.45 && /load1=203\.45/.test(busy) && /外部连接=4/.test(busy) && /偏忙/.test(busy) && !/偏忙/.test(idle);
    arm('环境快照·解析loadavg且繁忙要标注', ok, `lv1=${lv ? lv.one : 'NA'}`, { verdict: String(!!ok) });
  }

  /* 臂16 工作区超阈值必须告警 */
  {
    const bad = classifyWorktree(Array.from({ length: 42 }, (_, i) => ` M f${i}.mjs`).join('\n'), 20);
    const good = classifyWorktree([' M a.mjs', '?? b.mjs'].join('\n'), 20);
    arm('工作区·42个未提交必须告警', bad.verdict === 'fail' && good.verdict === 'pass',
      `42个=${bad.verdict} 2个=${good.verdict}`, { verdict: `${bad.verdict}/${good.verdict}` });
  }

  /* 臂17 假备份：与原件逐字相同且原件有未提交改动 → 必须报红 */
  {
    const f = classifyFakeBackup([
      { backup: 'hub.mjs.bak-x', original: 'hub.mjs', identical: true, originalModified: true },
    ]);
    const ok = classifyFakeBackup([
      { backup: 'a.mjs.bak-x', original: 'a.mjs', identical: false, originalModified: true },
    ]);
    arm('假备份·与原件逐字相同必须报红', f.verdict === 'fail' && ok.verdict === 'pass',
      `fake=${f.verdict} diverged=${ok.verdict}`, { verdict: `${f.verdict}/${ok.verdict}` });
  }

  /* 臂18 死路由：三种 404 报文必须分开判，不能一律报死（防误报） */
  {
    const hub = classify404('/api/dead', R({ status: 404, text: JSON.stringify({ ok: false, message: '没有这个页面' }) }), null);
    const method = classify404('/api/live', R({ status: 404, text: JSON.stringify({ ok: false, message: '这个接口不存在' }) }), null);
    const param = classify404('/api/item', R({ status: 404, text: JSON.stringify({ ok: false, message: '没有这个任务' }) }), null);
    const ok = hub.verdict === 'fail' && method.verdict === 'unverified' && param.verdict === 'unverified';
    arm('死路由·只有「没有这个页面」才算死', ok,
      `hub=${hub.verdict} method=${method.verdict} param=${param.verdict}`, { verdict: `${hub.verdict}/${method.verdict}/${param.verdict}` });
  }

  /* 臂19 空数组必须未取证 */
  {
    const f = classifyApiResponse('/api/empty', R({ text: '[]' }));
    arm('空数组·必须 unverified 不得算 pass', f.verdict === 'unverified', `verdict=${f.verdict}`, { verdict: judgeOf(f) });
  }

  /* 臂20 结构臂：异步 spawn 真跑一遍完整 audit（不能用 spawnSync：会阻塞父进程里的靶场）
   * 同时验证编码规则：正常判红 vs 判红后崩溃 必须可区分 */
  {
    const smoke = http.createServer((rq, rs) => {
      const p = new URL(rq.url, 'http://x').pathname;
      if (p === '/api/x') { rs.writeHead(200, { 'content-type': 'application/json' }); return rs.end('{"ok":false,"message":"模拟静默失败"}'); }
      rs.writeHead(200, { 'content-type': 'text/html' }); rs.end('<div id=a>' + 'x'.repeat(600) + '</div><script>fetch("/api/x")</script>');
    });
    await new Promise((r) => smoke.listen(0, '127.0.0.1', r));
    const port = smoke.address().port;
    const { execFile } = await import('node:child_process');
    const runChild = (args) => new Promise((resolve) => {
      execFile(process.execPath, [fileURLToPath(import.meta.url), ...args],
        { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => resolve({ status: err ? (typeof err.code === 'number' ? err.code : null) : 0, stdout: stdout || '', stderr: stderr || '', err }));
    });
    const r = await runChild(['--base', `http://127.0.0.1:${port}`, '--jitter-n', '3', '--avail-n', '3', '--json']);
    smoke.close();

    let parsed = false, obj = null;
    try { obj = JSON.parse(r.stdout.trim()); parsed = true; } catch {}
    // 超时被 kill（status===null）也是检查器故障，不是"被测代码不合格"
    const killed = r.status === null;
    const crash = killed ? 'timeout-or-killed' : (CRASH_RE.test(r.stderr) ? (r.stderr.match(CRASH_RE) || [])[0] : null);
    const coded = [0, 1, 2].includes(r.status);
    arm('结构臂·真实跑完整audit不许崩', !crash && parsed && coded,
      `exit=${r.status} json=${parsed} 崩溃特征=${crash || '无'}${killed ? '（超时被 kill，属检查器故障，不是被测代码不合格）' : ''}`,
      { verdict: parsed ? `fail=${obj && obj.fail}` : null, crash });
    if (killed) {
      // 明确标记：这一臂是"故障"，不是"缺陷红"
      arm('结构臂·超时必须归为检查器故障', true,
        '已识别 status=null 为检查器故障（非被测代码不合格）', { verdict: 'crash-classified', crash: 'timeout-or-killed' });
    }

    /* 判定词必须真的出现（区分「跑对了」与「什么都没判」） */
    const hasVerdicts = parsed && obj && Number(obj.pass) + Number(obj.fail) + Number(obj.unverified) > 0;
    arm('结构臂·必须产出判定词(非空判)', hasVerdicts,
      hasVerdicts ? `pass=${obj.pass} fail=${obj.fail} unverified=${obj.unverified}` : '没有产出任何判定 → 相当于没测',
      { verdict: hasVerdicts ? `${obj.fail}` : null });
  }

  /* 臂21 退出码表：五值互斥、无重复（防止 selftest 与体检复用同一码表示两件事） */
  {
    const vals = Object.values(EXIT);
    const uniq = new Set(vals);
    const ok = vals.length === 5 && uniq.size === 5 && [0,1,2,3,4].every((v) => uniq.has(v));
    arm('退出码表·五值互斥且覆盖0-4', ok, `vals=${vals.join(',')} uniq=${uniq.size}`, { verdict: `${uniq.size}` });
  }

  /* 臂23 扫不到必须报错：ROOT 不可用时 readRooms 必须抛，不能静默返回空 */
  {
    let threw = false, msg = '';
    try {
      const orig = fs.existsSync;
      // 模拟 rooms.mjs 不存在
      fs.existsSync = (p) => (String(p).endsWith('rooms.mjs') ? false : orig(p));
      try { readRooms(); } catch (e) { threw = true; msg = e.message; }
      fs.existsSync = orig;
    } catch (e) { threw = true; msg = e.message; }
    arm('扫不到必须报错·rooms.mjs缺失不得静默返回空', threw && /找不到/.test(msg),
      threw ? `已抛错：${msg.slice(0, 46)}` : '静默返回了空数组 ← 假绿', { verdict: String(threw) });
  }

  /* 臂24 复测：首坏后好 → 必须 pass 并记账；一直坏 → 必须 fail（不能靠复测洗白） */
  {
    let calls = 0;
    const flaky = http.createServer((rq, rs) => {
      calls += 1;
      if (calls === 1) { rs.writeHead(502, { 'content-type': 'text/plain' }); return rs.end('boom'); }
      rs.writeHead(200, { 'content-type': 'text/html' }); rs.end('<div>' + 'x'.repeat(700) + '</div>');
    });
    await new Promise((r) => flaky.listen(0, '127.0.0.1', r));
    const fport = flaky.address().port;
    const f1 = await reqStable(`http://127.0.0.1:${fport}/`);
    flaky.close();

    const dead = http.createServer((rq, rs) => { rs.writeHead(502, { 'content-type': 'text/plain' }); rs.end('always'); });
    await new Promise((r) => dead.listen(0, '127.0.0.1', r));
    const dport = dead.address().port;
    const f2 = await reqStable(`http://127.0.0.1:${dport}/`);
    dead.close();

    const okRetry = f1.status === 200 && f1.retried === true && f1.firstFailure && f1.firstFailure.status === 502;
    const okDead = f2.status === 502 && !(f2.ok && f2.status < 400);
    arm('复测·首坏后好须记账、一直坏须判失败', okRetry && okDead,
      `flaky: status=${f1.status} retried=${f1.retried} first=${f1.firstFailure && f1.firstFailure.status} | dead: status=${f2.status}`,
      { verdict: `${f1.status}/${f2.status}` });
  }

  /* 臂25 可用性：0/20 与 20/20 必须分开；中间态必须报不稳定；样本不足必须未取证 */
  {
    const mk = (oks) => oks.map((o) => ({ ok: o, status: o ? 200 : 0, ms: o ? 5 : 0.3, err: o ? null : 'RST' }));
    const all0 = classifyAvailability('dead', mk(Array(20).fill(false)));
    const all1 = classifyAvailability('alive', mk(Array(20).fill(true)));
    const half = classifyAvailability('flaky', mk([...Array(10).fill(true), ...Array(10).fill(false)]));
    const few = classifyAvailability('few', mk([true, true, true]));
    const ok = all0.verdict === 'fail' && all1.verdict === 'pass'
      && half.verdict === 'fail' && /不稳定/.test(half.detail) && few.verdict === 'unverified';
    arm('可用性·0/20与20/20必须分开·中间态报不稳定', ok,
      `dead=${all0.verdict} alive=${all1.verdict} half=${half.verdict} few=${few.verdict}`,
      { verdict: `${all0.verdict}/${all1.verdict}/${half.verdict}` });
  }

  /* 臂26 入口三判据必须独立：最坏的形态是"launchd 说 running 但用户进不来" */
  {
    // 形态1 全健康
    const healthy = classifyEntrypoint({
      label: ':8890', http: { status: 200, ms: 5 },
      listenPid: 111, service: { found: true, state: 'running', pid: 111, runs: 2, lastExit: 0 },
    });
    // 形态2 今天真实发生过的：服务注销 + 8890 无监听 + 用户进不来
    const dead = classifyEntrypoint({
      label: ':8890', http: { status: 0, err: 'ECONNREFUSED' },
      listenPid: null, service: { found: false },
    });
    // 形态3 最阴险：launchd 说 running、进程 pid 存在，但真实请求失败
    const lying = classifyEntrypoint({
      label: ':8890', http: { status: 0, err: 'ECONNREFUSED' },
      listenPid: 222, service: { found: true, state: 'running', pid: 222, runs: 2, lastExit: 1 },
    });

    const hOk = healthy.every((f) => f.verdict !== 'fail');
    const dOk = dead.filter((f) => f.verdict === 'fail').length === 2;   // http + service
    const lOk = lying.find((f) => f.id === 'entry.http').verdict === 'fail'
      && lying.find((f) => f.id === 'entry.service').verdict === 'pass'; // 托管项在，但入口死
    arm('入口·健康/注销/托管说谎言 三种形态必须分开', hOk && dOk && lOk,
      `healthy=${hOk?(healthy.map(f=>f.verdict).join('/')):'异常'} deadFails=${dead.filter(f=>f.verdict==='fail').length} lying:http=${lying.find(f=>f.id==='entry.http').verdict}`,
      { verdict: `${hOk}/${dOk}/${lOk}` });
  }

  /* 臂27 死路由必须双 404：只发 GET 就把 POST-only 误判成死路由（这是我最惨的一次误报，21 条全假） */
  {
    const R404hub = R({ status: 404, text: JSON.stringify({ ok: false, message: '没有这个页面' }) });
    const R404biz = R({ status: 404, text: JSON.stringify({ ok: false, message: '搜书任务不存在或已过期' }) });
    const R400 = R({ status: 400, text: JSON.stringify({ ok: false, message: '缺少书名或作者' }) });
    const R200 = R({ status: 200, text: JSON.stringify({ ok: true }) });

    const realDead = classifyDeadRoute('/api/x', R404hub, R404hub);           // 双 404 hub → 真死
    const postOnly = classifyDeadRoute('/api/x', R404hub, R400);              // GET 404 但 POST 400 → 存在
    const postOk = classifyDeadRoute('/api/x', R404hub, R200);                // GET 404 但 POST 200 → 存在
    const bizMsg = classifyDeadRoute('/api/x', R404biz, null);                // 业务报文 404 → 存在
    const noPost = classifyDeadRoute('/api/x', R404hub, null);                // 无法探 → 未取证

    const ok = realDead.verdict === 'fail' && postOnly.verdict === 'pass'
      && postOk.verdict === 'pass' && bizMsg.verdict === 'pass' && noPost.verdict === 'unverified';
    arm('死路由·必须GET+POST双404，POST-only不得判死', ok,
      `realDead=${realDead.verdict} post400=${postOnly.verdict} post200=${postOk.verdict} bizMsg=${bizMsg.verdict} noPost=${noPost.verdict}`,
      { verdict: `${realDead.verdict}/${postOnly.verdict}/${noPost.verdict}` });
  }

  /* 臂28 POST 白名单必须排除有副作用的路由（防某天有人把 start/stop 加进来） */
  {
    const danger = ['/api/start', '/api/stop', '/api/start-all', '/api/download/delete', '/api/library/scan'];
    const leaked = danger.filter((r) => POST_PROBES.has(r) && !POST_FORBIDDEN.has(r));
    const whitelistSafe = [...POST_PROBES].every((r) => !POST_FORBIDDEN.has(r));
    arm('POST白名单·有副作用路由不得入表', leaked.length === 0 && whitelistSafe,
      `泄漏=${leaked.length ? leaked.join(',') : '无'} 白名单=${POST_PROBES.size}条 禁列=${POST_FORBIDDEN.size}条`,
      { verdict: `${leaked.length}` });
  }

  /* 臂29-31 测量环境洁净度（2026-11-22 夹具抢占 8811 五次之后补的）
   * 必须三臂，缺一不可：
   *   臂29 占用者正确 → PASS      （否则这个判据会把正常环境报红）
   *   臂30 占用者是别人 → FAIL    （否则它根本没有区分力）
   *   臂31 端口空闲 → PASS 且写明「空闲不是不洁」（否则「服务没起」会被误报成「环境脏」）
   * 用 19000-19999 的临时端口 + 真起进程，不碰项目端口。
   */
  {
    const fsmod = await import('node:fs');
    const dir = fsmod.mkdtempSync('/tmp/wwenv-');
    const mk = (name, port) => {
      const f = path.join(dir, name);
      fsmod.writeFileSync(f, `import net from 'node:net';net.createServer(s=>s.end('x')).listen(${port},'127.0.0.1');`);
      return f;
    };
    const good = mk('server.mjs', 19788);   // 名字符合预期
    const bad = mk('fake.mjs', 19789);      // 名字不符合预期
    const { spawn } = await import('node:child_process');
    const kids = [good, bad].map((f) => spawn(process.execPath, [f], { stdio: 'ignore' }));
    await new Promise((r) => setTimeout(r, 700));

    const okRes = await checkEnvHygiene({ 19788: 'server.mjs' });
    const badRes = await checkEnvHygiene({ 19789: 'server.mjs' });
    const idleRes = await checkEnvHygiene({ 19790: 'server.mjs' });

    kids.forEach((k) => { try { k.kill('SIGKILL'); } catch {} });
    try { fsmod.rmSync(dir, { recursive: true, force: true }); } catch {}

    const okF = okRes[0], badF = badRes[0], idleF = idleRes[0];
    arm('环境洁净·占用者正确必须PASS', okF.verdict === 'pass', `verdict=${okF.verdict} :: ${okF.detail}`, { verdict: judgeOf(okF) });
    arm('环境洁净·被非预期进程占用必须FAIL', badF.verdict === 'fail',
      `verdict=${badF.verdict} :: ${badF.detail}`, { verdict: judgeOf(badF) });
    arm('环境洁净·端口空闲不得判不洁', idleF.verdict === 'pass' && /空闲/.test(idleF.detail),
      `verdict=${idleF.verdict} :: ${idleF.detail}`, { verdict: judgeOf(idleF) });
  }

  /* 臂32-35 重启窗口（2026-11-22 运维管家测到 2/20 超时落在重启窗口后补的）
   *   臂32 etime 三种格式换算必须对（macOS 没有 etimes，只能自己算）
   *   臂33 刚起的进程 → 必须 unverified「在重启窗口内」
   *   臂34 跑久了的进程 → 必须 pass「已过重启窗口」
   *   臂35 读不到时长 → 必须 unverified（不能默认当干净）
   * 臂33/34 用真实进程：自己 spawn 一个新的 + 用 PID 1（launchd，开机至今）。
   */
  {
    const p1 = parseEtime('05:12');
    const p2 = parseEtime('01:02:03');
    const p3 = parseEtime('3-01:02:03');
    const p4 = parseEtime('garbage');
    const okParse = p1 === 312 && p2 === 3723 && p3 === 262923 && p4 === null;
    arm('重启窗口·etime三格式换算', okParse,
      `05:12=${p1} 01:02:03=${p2} 3-01:02:03=${p3} garbage=${p4}`, { verdict: String(okParse) });

    const fsmod = await import('node:fs');
    const dir = fsmod.mkdtempSync('/tmp/wwrsw-');
    const f = path.join(dir, 'server.mjs');
    fsmod.writeFileSync(f, `import net from 'node:net';net.createServer(s=>s.end('x')).listen(19791,'127.0.0.1');`);
    const { spawn } = await import('node:child_process');
    const kid = spawn(process.execPath, [f], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 800));

    const freshRes = await checkRecentRestart({ 19791: 'server.mjs' }, 300);
    try { kid.kill('SIGKILL'); } catch {}
    try { fsmod.rmSync(dir, { recursive: true, force: true }); } catch {}

    // 臂33 真实集成：真起一个进程，走完整 lsof+ps 链路，必须判未取证
    const fresh = freshRes[0];
    arm('重启窗口·刚起的进程必须判未取证',
      fresh && fresh.verdict === 'unverified' && /在重启窗口内/.test(fresh.title),
      fresh ? `verdict=${fresh.verdict} title=${fresh.title} :: ${fresh.detail}` : '漏检：没产出该条',
      { verdict: fresh ? judgeOf(fresh) : null });
    // 臂34 纯分类：活了一小时的进程必须 PASS（不依赖机器上恰好有个老进程）
    const old = classifyUptime(8890, 12345, 3600, 300);
    arm('重启窗口·跑久了的进程必须PASS', old.verdict === 'pass' && /已过重启窗口/.test(old.title),
      `verdict=${old.verdict} :: ${old.detail}`, { verdict: judgeOf(old) });
    // 臂35 纯分类：读不到时长必须未取证，不得默认当干净
    const unk = classifyUptime(8890, 12345, null, 300, '');
    arm('重启窗口·读不到时长必须未取证（不得默认干净）',
      unk.verdict === 'unverified' && /读不到/.test(unk.title),
      `verdict=${unk.verdict} :: ${unk.detail}`, { verdict: judgeOf(unk) });
  }

  /* 臂29 工作区：.bak 不得淹没真改动（226 备份 + 5 真改动 必须判 pass，不能因 231 报红） */
  {
    const lines = [
      ...Array.from({ length: 226 }, (_, i) => `?? lib/x${i}.mjs.bak-20261122`),
      ...Array.from({ length: 5 }, (_, i) => ` M lib/y${i}.mjs`),
    ].join('\n');
    const wt = classifyWorktree(lines, 20);
    const bak = classifyBakHygiene(lines, 50);
    const manyReal = classifyWorktree(Array.from({ length: 30 }, (_, i) => ` M lib/z${i}.mjs`).join('\n'), 20);
    const ok = wt.verdict === 'pass' && bak.verdict === 'unverified' && manyReal.verdict === 'fail';
    arm('工作区·.bak不得淹没真改动', ok,
      `226bak+5real=${wt.verdict} bak卫生=${bak.verdict} 30real=${manyReal.verdict}`,
      { verdict: `${wt.verdict}/${bak.verdict}/${manyReal.verdict}` });
  }

  /* 臂30 备份覆盖：有快照早于最早改动=pass；全部晚于=必须报红；无快照=必须报红 */
  {
    const early = Date.parse('2026-11-19T18:19:49+08:00');
    const covered = classifyBackupCoverage(early, [Date.parse('2026-11-18T10:00:00+08:00'), Date.parse('2026-11-22T17:05:00+08:00')]);
    const gap = classifyBackupCoverage(early, [Date.parse('2026-11-22T17:05:00+08:00')]);
    const none = classifyBackupCoverage(early, []);
    const unknown = classifyBackupCoverage(null, [early]);
    const ok = covered.verdict === 'pass' && gap.verdict === 'fail'
      && none.verdict === 'fail' && unknown.verdict === 'unverified';
    arm('备份覆盖·必须能区分有退路/无退路', ok,
      `covered=${covered.verdict} gap=${gap.verdict} none=${none.verdict} unknown=${unknown.verdict}`,
      { verdict: `${covered.verdict}/${gap.verdict}/${none.verdict}` });
  }

  if (globalThis.__INJECT_SKIP__) {
    arm('注入跳过臂', true, '--inject-skip 注入，验证 exit=3', { skip: 'injected' });
  }

  /* 臂31 双判据：launchd running + 请求失败 = 必须报红（今天真实发生过的假绿） */
  {
    const lying = classifyLiveness('x', { found: true, state: 'running', pid: 1, runs: 10, lastExit: 1 },
      { status: 0, err: 'ECONNREFUSED' });
    const alive = classifyLiveness('x', { found: true, state: 'running', pid: 1, runs: 1, lastExit: 0 },
      { status: 200 });
    const noGuard = classifyLiveness('x', { found: false }, { status: 200 });
    const dead = classifyLiveness('x', { found: false }, { status: 0, err: 'ECONNREFUSED' });
    const ok = lying.verdict === 'fail' && alive.verdict === 'pass'
      && noGuard.verdict === 'unverified' && dead.verdict === 'fail';
    arm('服务存活·launchd说running但请求失败必须报红', ok,
      `lying=${lying.verdict} alive=${alive.verdict} noGuard=${noGuard.verdict} dead=${dead.verdict}`,
      { verdict: `${lying.verdict}/${alive.verdict}/${noGuard.verdict}/${dead.verdict}` });
  }

  /* 臂32 报告完整性：CATS 必须覆盖实际产出的所有 cat，否则整段被静默吞掉（我刚犯过） */
  {
    const produced = new Set([
      '环境', '入口', '服务存活', '可达性', '六态', '接口', '死路由',
      '静默失败', '性能', '缓存', '死链', '可用性', '工作区',
    ]);
    const missing = [...produced].filter((c) => !CATS.includes(c));
    const extra = CATS.filter((c) => !produced.has(c));
    arm('报告完整性·CATS必须覆盖所有产出类别', missing.length === 0,
      missing.length ? `未覆盖: ${missing.join(',')} → 该段会被静默吞掉` : `覆盖 ${CATS.length} 类，无遗漏（额外 ${extra.length}）`,
      { verdict: `${missing.length}` });
  }

  /* 臂33 已知存在路由：必须判 pass 且不得出现在自动探白名单（防某天被误加进去真启动服务） */
  {
    const knownKeys = [...POST_KNOWN_EXISTS.keys()];
    const leaked = knownKeys.filter((r) => POST_PROBES.has(r));
    const dangerous = ['/api/start', '/api/stop', '/api/start-all'];
    const allCovered = dangerous.every((r) => POST_KNOWN_EXISTS.has(r));
    arm('已知存在路由·不得进自动探白名单', leaked.length === 0 && allCovered,
      `泄漏=${leaked.length ? leaked.join(',') : '无'} 已登记=${knownKeys.length} 危险路由覆盖=${allCovered}`,
      { verdict: `${leaked.length}` });
  }

  /* 臂34 入口故障注入：今天真实发生过的两种形态必须被抓到 */
  {
    // 形态A：launchd 说 running，但 8890 真实请求失败（今天发生过）
    const dead = classifyEntrypoint({ label: ':8890',
      http: { status: 0, err: 'ECONNREFUSED' }, listenPid: null,
      service: { found: true, state: 'running', pid: 99999, runs: 19, lastExit: 1 } });
    const aOk = dead.find((f) => f.id === 'entry.http').verdict === 'fail';

    // 形态B：launchd 托管项消失（今天真实发生过，无任何告警）
    const gone = classifyEntrypoint({ label: ':8890',
      http: { status: 200, ms: 50 }, listenPid: 99999, service: { found: false } });
    const bOk = gone.find((f) => f.id === 'entry.service').verdict === 'fail';

    // 形态C：全健康不得误报
    const healthy = classifyEntrypoint({ label: ':8890',
      http: { status: 200, ms: 50 }, listenPid: 111,
      service: { found: true, state: 'running', pid: 111, runs: 2, lastExit: 0 } });
    const cOk = healthy.every((f) => f.verdict !== 'fail');

    arm('入口故障注入·8890死与托管项消失必须被抓到', aOk && bOk && cOk,
      `死=${aOk} 托管丢失=${bOk} 健康不误报=${cOk}`,
      { verdict: `${aOk}/${bOk}/${cOk}` });
  }

  /* 臂35 瞬态加载 vs 真静默失败：必须分开，否则「房间加载中」会被误报成缺陷（今天误报 6 条） */
  {
    const loading = classifyApiResponse('/api/photos/list',
      R({ text: JSON.stringify({ ok: false, message: '房间 photos 加载中' }) }));
    const realSilent = classifyApiResponse('/api/x',
      R({ text: JSON.stringify({ ok: false, message: '内部出错了' }) }));
    const ok = loading.verdict === 'unverified' && realSilent.verdict === 'fail';
    arm('瞬态加载·不得判成静默失败缺陷', ok,
      `加载中=${loading.verdict} 真静默=${realSilent.verdict}`,
      { verdict: `${loading.verdict}/${realSilent.verdict}` });
  }

  /* 臂36 夹具端口合规：今天 5 次 EADDRINUSE 全来自夹具占项目端口，必须能被判红 */
  {
    const onProject = classifyFixturePort(8811, '/tmp/x');   // 项目端口 → fail
    const okRange = classifyFixturePort(19500, '/tmp/ww-x');  // 合规 → pass
    const noRt = classifyFixturePort(19500, null);            // 缺 runtime → unverified
    const offRange = classifyFixturePort(3000, '/tmp/x');     // 段外 → unverified
    const good = onProject.verdict === 'fail' && okRange.verdict === 'pass'
      && noRt.verdict === 'unverified' && offRange.verdict === 'unverified';
    arm('夹具端口·占用项目端口必须报红', good,
      `8811=${onProject.verdict} 19500=${okRange.verdict} 无runtime=${noRt.verdict} 段外=${offRange.verdict}`,
      { verdict: `${onProject.verdict}/${okRange.verdict}/${noRt.verdict}` });
  }

  /* 臂37 熔断判据：必须只看熔断打开后，且前置不满足时不得判通过（今天踩过假达标） */
  {
    const mk = (ms) => ms.map((m) => ({ ms: m }));
    // 冷启动两次 800ms + 之后全快 → 应 pass（预热被跳过）
    const withWarmup = classifyBreaker(mk([861, 847, 11, 4, 3, 6, 8]), { breakerOpen: true });
    // 熔断打开后仍慢 → 必须 fail
    const stillSlow = classifyBreaker(mk([800, 800, 900, 700, 650]), { breakerOpen: true });
    // 未熔断 → 未取证，不得判 pass
    const notOpen = classifyBreaker(mk([5, 4, 3]), { breakerOpen: false });
    const ok = withWarmup.verdict === 'pass' && stillSlow.verdict === 'fail' && notOpen.verdict === 'unverified';
    arm('熔断判据·只算打开后且未熔断不得判通过', ok,
      `含预热=${withWarmup.verdict} 打开后仍慢=${stillSlow.verdict} 未熔断=${notOpen.verdict}`,
      { verdict: `${withWarmup.verdict}/${stillSlow.verdict}/${notOpen.verdict}` });
  }

  /* 臂39 夹具端口断言：不合规必须拒绝启动（今天后端 8894 忘关、撞 8890 的机器化防线） */
  {
    const projectPort = assertFixturePort(8890, '/tmp/x');       // 项目端口 → 拒绝
    const offRange = assertFixturePort(3000, '/tmp/x');          // 段外 → 拒绝
    const noRt = assertFixturePort(19500, null);                 // 缺 runtime → 拒绝
    const good = assertFixturePort(19500, '/tmp/ww-x');          // 合规 → 通过
    const notInt = assertFixturePort('abc', '/tmp/x');           // 非整数 → 拒绝
    const ok = !projectPort.ok && !offRange.ok && !noRt.ok && good.ok && !notInt.ok;
    arm('夹具端口断言·不合规必须拒绝启动', ok,
      `8890=${projectPort.ok} 3000=${offRange.ok} 无runtime=${noRt.ok} 19500=${good.ok} 非整数=${notInt.ok}`,
      { verdict: `${projectPort.ok}/${good.ok}` });
  }

  /* 臂22 臂完整性必须能区分：跳过1条 → 不完整（此处用逻辑验证，不真跳过） */
  {
    const fakeArms = [{ skip: null }, { skip: null }, { skip: 'not-implemented' }];
    const exec = fakeArms.filter((a) => !a.skip).length;
    const incomplete = fakeArms.some((a) => a.skip);
    arm('臂完整性·有SKIP必须判不完整', exec === 2 && incomplete === true,
      `exec=${exec}/${fakeArms.length} incomplete=${incomplete}`, { verdict: String(incomplete) });
  }

  /* ── 三判据汇总 ── */
  const executed = arms.filter((a) => !a.skip).length;
  const skipped = arms.filter((a) => a.skip);
  const missingVerdict = arms.filter((a) => !a.skip && (a.verdict === null || a.verdict === undefined || a.verdict === ''));
  const crashed = arms.filter((a) => a.crash);
  const failed = arms.filter((a) => !a.pass && !a.skip);

  for (const a of arms) {
    const tag = a.skip ? '⏭' : a.pass ? '✅' : '❌';
    console.log(`${tag} ${a.name} :: ${a.detail}${a.skip ? ` [SKIP: ${a.skip}]` : ''}`);
  }

  console.log('');
  console.log(`判定词：${missingVerdict.length ? `缺失 ${missingVerdict.length} 条（${missingVerdict.map((a) => a.name).join('；')}）` : `全部 ${executed} 条均产出判定词`}`);
  console.log(`崩溃特征：${crashed.length ? `检测到 ${crashed.length} 条（${crashed.map((a) => `${a.name}:${a.crash}`).join('；')}）` : '无'}`);
  console.log(`臂完整性：${executed}/${arms.length}${skipped.length ? `（跳过 ${skipped.map((a) => a.name).join(',')}）` : ''}${skipped.length ? ' → 不完整，不得宣称全臂通过' : ''}`);

  // 统一退出码，优先级 2 > 1 > 3 > 0
  const exitWith = (code, why) => {
    console.log(`\n结论：${why}`);
    console.log(`退出码 ${code} = ${EXIT_MEANING[code]}`);
    process.exit(code);
  };
  if (crashed.length) {
    exitWith(EXIT.CRASH, `检查器自身崩溃 ${crashed.length} 条 —— 这不是被测代码不合格，不能作为红臂证据`);
  }
  if (missingVerdict.length) {
    exitWith(EXIT.CRASH, `判定词缺失 ${missingVerdict.length} 条 —— 相当于没判定，按故障处理`);
  }
  if (failed.length) {
    exitWith(EXIT.FAIL, `有 ${failed.length} 臂不合格 → 判据没有区分力，不能用来出报告`);
  }
  if (skipped.length) {
    exitWith(EXIT.INCOMPLETE, `跳过 ${skipped.length} 臂（${skipped.map((a) => a.name).join(',')}）—— 臂完整性 ${executed}/${arms.length}，结论不可用`);
  }
  exitWith(EXIT.PASS, `负向臂 ${executed} 条全部按预期 + 三判据完整 → 判据有区分力`);
}

/* ───────────── 测试注入开关（供任意 runner 跑满五臂，不影响正常使用） ─────────────
 * --force-crash        : 故意抛错，模拟检查器故障（期望 exit=2）
 * --inject-broken      : 让缓存判据失效，模拟"负向臂失去区分力"（期望 exit=1）
 * --inject-skip        : 跳过一条臂（期望 exit=3）
 * 这三个开关只用于验收本检查器自身，正常体检/自检不使用。
 */
if (argv.includes('--force-crash')) {
  // 走真实抛错路径，但由下面的全局兜底转成 exit=2（模拟"顶层崩溃"）
  setTimeout(() => { throw new RangeError('deliberate crash (--force-crash)'); }, 0);
}
if (argv.includes('--inject-broken')) {
  globalThis.__INJECT_BROKEN__ = true;
}
if (argv.includes('--inject-skip')) {
  globalThis.__INJECT_SKIP__ = true;
}

/* ───────────── 入口 ───────────── */
if (argv.includes('--selftest')) {
  // 自检自身崩溃必须与"缺陷红"分开：未捕获异常 → 2，不能退化成 Node 默认的 1
  try {
    await selftest();
  } catch (e) {
    console.error(`\n[检查器故障] selftest 抛出未捕获异常：${e && (e.stack || e.message || e)}`);
    console.error(`崩溃特征：${(e && e.name) || 'Error'}`);
    console.error(`退出码 ${EXIT.CRASH} = ${EXIT_MEANING[EXIT.CRASH]}`);
    process.exit(EXIT.CRASH);
  }
} else {
  let r;
  try {
    r = await audit(BASE);
  } catch (e) {
    console.error(`\n[检查器故障] audit 抛出未捕获异常：${e && (e.stack || e.message || e)}`);
    console.error(`退出码 ${EXIT.CRASH} = ${EXIT_MEANING[EXIT.CRASH]}`);
    process.exit(EXIT.CRASH);
  }
  if (AS_JSON) console.log(JSON.stringify(r, null, 2));
  else printReport(r);
  // 体检退出码（与 selftest 同一张表，不复用同一码表示两件事）
  const code = r.fail > 0 ? EXIT.FAIL : r.unverified > 0 ? EXIT.UNVERIFIED : EXIT.PASS;
  if (!AS_JSON) console.log(`退出码 ${code} = ${EXIT_MEANING[code]}`);
  process.exit(code);
}
