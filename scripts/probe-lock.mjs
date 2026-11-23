/**
 * 五五客厅 · 真浏览器探针互斥锁（2026-11-22）
 *
 * 为什么必须有它：
 *   实测 2026-11-22 19:11，本机 8 核 / 8GB，load average 31~65 的情况下
 *   同时有 **两个** `node scripts/toast-behavior-regress.mjs` 在跑
 *   （父进程链都指向同一个 DS Bot 宿主，即不同管家各自手动跑）。
 *   六个用真浏览器的探针里**只有 toast-behavior 一个读了 regress.lock**，
 *   其余五个既不读锁、也不互相避让。
 *
 *   后果不是「跑得慢」，而是**测量结论不可信**：
 *     · 每个探针都 spawn 一个独立 Chrome，各自再开 8 个标签页；
 *     · 负载把标签页挤到后台 → Chrome 冻结渲染时间线 → transition 不推进 →
 *       computed opacity 恒为 0 → 判「提示根本没画出来」；
 *     · 于是同一份代码两次跑出**不同的缺陷页**（photos / calendar / library）。
 *   这正是今天反复出现的「假红」，也是我上一轮误判成「后台标签页」的那条的上一层根因。
 *
 * 用法（每个真浏览器探针开头）：
 *   import { acquireProbeLock, releaseProbeLock } from './probe-lock.mjs';
 *   await acquireProbeLock('toast-behavior');   // 拿不到就等；等不到 exit 3
 *
 * 语义与 regress-all 的运行锁一致：
 *   · 拿到 → 正常跑；
 *   · 别人持有且活着 → 排队等待（默认最多 240 秒）；
 *   · 等超时 → exit 3「本次结论不可用」，**不报红、不报绿**；
 *   · 持有者已死（陈旧锁）→ 覆盖，并打印一行说明。
 * 为什么要排队而不是直接退出：手动跑单套是很常见的动作，
 * 直接拒绝会让人「绕开锁」，那锁就白做了。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
/* 锁路径可用环境变量覆盖：这是为了让「验证锁本身」也能在隔离环境里做，
 * 不必去抢真实 runtime 目录下的锁（本机常有其他管家在跑整套回归）。 */
const PROBE_LOCK = process.env.WW_PROBE_LOCK || path.join(ROOT, 'runtime', 'browser-probe.lock');
const REGRESS_LOCK = process.env.WW_REGRESS_LOCK || path.join(ROOT, 'runtime', 'regress.lock');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readPid(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    const m = raw.match(/pid=(\d+)/);
    return { pid: m ? Number(m[1]) : 0, raw };
  } catch { return { pid: 0, raw: '' }; }
}
function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ★★ 2026-11-22 修（由臂2 抓出）：`kill(pid,0)` 抛错**不等于进程不存在**。
    //   EPERM = 进程在、但当前用户无权给它发信号 —— 它是**活的**。
    //   原实现 `catch { return false }` 把 EPERM 当成「已死」，
    //   于是会把一个活着的锁判成陈旧锁直接覆盖，互斥当场失效。
    //   实测臂2：lock 写 pid=1（launchd，活着但非祖先）→ 原实现放行（错误），
    //   期望是 exit 3 拒绝。修后：只有 ESRCH 才算死。
    if (e && e.code === 'EPERM') return true;
    return false;   // ESRCH 或其它：视为不存在
  }
}
/**
 * 沿 ppid 链上溯，判断 pid 是不是自己的祖先。
 * 为什么需要：regress-all 持锁 spawn 子探针时，子探针**必须**放行，
 * 否则整套回归第二套起全部 exit 3。
 * 注意：本机是 macOS，没有 /proc —— 只能用 ps（原先写 /proc 是错的）。
 */
function ppidOf(pid) {
  // ★★ 2026-11-22 实测教训（这条是 bug 本体）：
  //   原实现只走 `execSync('ps …')`，而 execSync 要 fork 一个子进程。
  //   本机 8 核 / 8GB，跑整套回归时 load 能到 30+，此时 **spawn 会 EAGAIN**。
  //   原代码 `catch { return 0 }` 把「fork 失败」静默变成了「没有父进程」，
  //   于是 isAncestor 一律返回 false —— regress-all 持锁 spawn 的子探针
  //   被**自己的父进程**判成「别人在跑」，6 个浏览器探针全部 exit 3。
  //   实测证据：2026-11-22 19:44 那轮 通过 11 / 故障 6，故障全是
  //   「[拒绝启动] 整套回归正在跑（pid=64910 …）」—— 64910 就是那轮的 regress-all。
  //   修法：第一层父进程用 Node 自带的 process.ppid（**零 fork，永不失败**），
  //   只有再往上才需要 ps，而再往上不是本场景必需的。
  if (pid === process.ppid) return process.ppid;   // 快路径：直接父进程
  if (pid === process.pid) return process.pid;
  let cur = process.pid;
  for (let i = 0; i < 24; i++) {
    let ppid;
    if (cur === process.pid) ppid = process.ppid;
    else { try { ppid = Number(execSync(`ps -o ppid= -p ${cur}`, { encoding: 'utf8' }).trim()) || 0; } catch { ppid = 0; } }
    if (!ppid || ppid <= 1) return 0;
    if (ppid === pid) return pid;
    cur = ppid;
  }
  return 0;
}
function isAncestor(pid) {
  if (!pid) return false;
  if (pid === process.ppid) return true;   // regress-all spawn 我们的正常情形
  return ppidOf(pid) === pid;
}

let held = false;

export async function acquireProbeLock(name, { waitMs = 240000 } = {}) {
  // ① 先看 regress-all 的运行锁：有人在跑整套时，**别插进来**，
  //    除非那把锁正是我们的祖先（regress-all spawn 我们时的正常情形）。
  const rl = readPid(REGRESS_LOCK);
  if (alive(rl.pid) && rl.pid !== process.pid && !isAncestor(rl.pid)) {
    console.error(`[拒绝启动] 整套回归正在跑（${rl.raw}）→ 本次结论不可用`);
    console.error(`  等它跑完再跑单套；若确认它已死：rm -f ${REGRESS_LOCK}`);
    process.exit(3);
  }

  // ② 探针之间的互斥：排队，不硬拒。
  //
  // ★★ 2026-11-22 修竞态（三进程实验抓出，A 与 C **同时**拿到了锁）：
  //   原写法是 `openSync(PROBE_LOCK,'wx')` 建空文件 → 再 writeSync 内容。
  //   在「建好文件、还没写内容」这段窗口里，别人 open 会拿到 EEXIST，
  //   接着 readPid 读到**空内容** → pid=0 → alive(0)=false →
  //   判定成「陈旧锁」→ unlink 抢走。互斥当场失效。
  //   实测：三进程并发，A=4ms、C=1ms 同时进入临界区。
  //
  //   修法：**先写自己的临时文件，再用 link() 原子占位**。
  //   link 的语义是「目标已存在就失败」，且落地的是一份**内容完整**的文件 ——
  //   不存在「文件在、内容空」的中间态。
  const deadline = Date.now() + waitMs;
  const t0 = Date.now();
  let announced = false;
  let lastBeat = 0;
  const tmp = `${PROBE_LOCK}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `pid=${process.pid} name=${name} started=${new Date().toISOString()}\n`);
  // ★ 2026-11-23 补（隔离臂2 抓出）：exit(3)（等锁超时/整套回归在跑）不经过
  //   release，会留下 `${PROBE_LOCK}.${pid}.tmp` 残骸。挂一个无条件 exit 清理，
  //   正常路径 link 成功后本来就会 unlink（幂等，多清一次无副作用）。
  process.on('exit', () => { try { fs.unlinkSync(tmp); } catch {} });
  for (;;) {
    try {
      fs.linkSync(tmp, PROBE_LOCK);   // 原子：目标存在即抛 EEXIST，且内容已完整
      held = true;
      try { fs.unlinkSync(tmp); } catch {}
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') { try { fs.unlinkSync(tmp); } catch {} throw e; }
      const cur = readPid(PROBE_LOCK);
      if (!alive(cur.pid)) {
        console.error(`[探针锁] 覆盖陈旧锁（持有进程 ${cur.pid} 已不在）`);
        try { fs.unlinkSync(PROBE_LOCK); } catch {}
        continue;
      }
      /* ★★ 2026-11-22 修（父框架的空闲超时抓出）：原实现只在**第一次**被挡时
       *   打一行「排队等待」，之后每 500ms 静默重试。而 regress-all 现在按
       *   「有没有输出」判断子套是否卡死 —— 静默等锁会被判成卡死并 SIGKILL。
       *   实测 2026-11-22 20:36：state-visual 等锁 180 秒后被杀，日志只有一句
       *   「已 180000ms 没有任何输出 → 判定卡死」。
       *   修法：等锁期间每 ~5 秒打一行心跳（带已等秒数），让「排队」与「卡死」
       *   在父框架里可区分。心跳频率远低于超时窗口，不会刷屏。
       */
      if (!announced) {
        console.error(`[探针锁] 另一个浏览器探针在跑（${cur.raw}）→ 排队等待，最多 ${Math.round(waitMs / 1000)} 秒`);
        announced = true;
        lastBeat = Date.now();
      } else if (Date.now() - lastBeat >= 5000) {
        const waited = Math.round((Date.now() - t0) / 1000);
        console.error(`[探针锁] 仍在排队…已等 ${waited} 秒（持有者 ${cur.pid}）`);
        lastBeat = Date.now();
      }
      if (Date.now() > deadline) {
        console.error('[探针锁] 等待超时 → 本次结论不可用（exit 3，不是产品缺陷）');
        process.exit(3);
      }
      await sleep(500);
    }
  }

  const release = () => {
    if (!held) return;
    held = false;
    try {
      const cur = readPid(PROBE_LOCK);
      if (cur.pid === process.pid) fs.unlinkSync(PROBE_LOCK);
    } catch {}
  };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { release(); process.exit(130); });
  }
  return release;
}

export function releaseProbeLock() {
  if (!held) return;
  held = false;
  try {
    const cur = readPid(PROBE_LOCK);
    if (cur.pid === process.pid) fs.unlinkSync(PROBE_LOCK);
  } catch {}
}
