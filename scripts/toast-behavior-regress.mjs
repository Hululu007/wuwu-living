#!/usr/bin/env node
/**
 * 五五客厅 · toast 行为探针（真浏览器，只读）
 *
 * 为什么需要它：
 *   设计审计只读源码，能证明「页面里没有第二份实现」，但证明不了
 *   「失败提示真的常驻、真的能点掉、成功提示真的会消失」。
 *   而 S6 收敛之后最容易出的事故正是行为变了却没人发现。
 *
 * 三臂（缺负向臂等于没测）：
 *   臂1 失败 → 必须常驻（3 秒后仍可见）+ 可点击关闭
 *   臂2 成功 → 必须自动消失（3 秒后不可见）
 *   臂3 负向 → 故意把 toast.js 换成「全部 800ms 自动消失」的坏实现，臂1 必须报红
 *
 * 用法：node toast-behavior-probe.mjs [--base=http://127.0.0.1:8890] [--arm=all|neg|neg-vis]
 * 退出码：0 全绿 / 1 有行为缺陷 / 2 探针自身故障
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ★★ 2026-11-22 根因：process.exit() 会**直接终止进程，finally 块不执行**。
//   这就是为什么之前写了收尾代码也照样留残骸：探针跑到尾就 exit，
//   cleanup 永远没机会跑。现在统一改成 exitClean(code)：先杀干净再退出。
let __cleanupFns = [];
function onExitCleanup(fn){ __cleanupFns.push(fn); }
function exitClean(code){
  if(process.env.WW_PROBE_DEBUG) console.error(`[exitClean] code=${code} cleanupFns=${__cleanupFns.length}`);
  for(const fn of __cleanupFns){ try{ fn(); }catch(e){ if(process.env.WW_PROBE_DEBUG) console.error('[cleanup err]',e.message); } }
  __cleanupFns = [];
  process.exit(code);
}


function reapByUserDir(dir){
  if(!dir) return 0;
  // 2026-11-22 第三版：杀一次不够。Chrome 主进程被 SIGKILL 后，
  //   已被 launchd 接管的 helper 会重新拉起主进程，所以必须
  //   「扫描→杀→等一下→再扫」循环到干净。不走 shell：pgrep 直接调用。
  let total = 0;
  for(let round=0; round<4; round++){
    let pids = [];
    try{
      const r = spawnSync('pgrep', ['-f', dir], {encoding:'utf8', timeout:5000});
      pids = String(r.stdout||'').trim().split(/\s+/).filter(Boolean);
    }catch{ return total; }
    if(!pids.length) break;
    for(const p of pids){ try{ process.kill(Number(p), 'SIGKILL'); }catch{} }
    total += pids.length;
    try{ spawnSync('sleep', ['0.4'], {timeout:2000}); }catch{}
  }
  return total;
}

// ★ 2026-11-22 探针互斥（见 probe-lock.mjs 头部说明）：
//   本文件原先只读 regress.lock（「整套回归在跑」），但**不与其他单套探针互斥**。
//   实测两个探针并发时 load 31~65，标签页被挤到后台 → transition 不推进 →
//   computed opacity 恒为 0 → 判「提示没画出来」。互斥是测量可信的前提。
import { acquireProbeLock } from './probe-lock.mjs';
await acquireProbeLock('toast-behavior');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const argv = process.argv.slice(2);
const BASE = (argv.find(a => a.startsWith('--base=')) || '--base=http://127.0.0.1:8890').slice(7);
const ARM = (argv.find(a => a.startsWith('--arm=')) || '--arm=all').slice(6);

/* ★ 2026-11-22 删掉这里的第二份锁检查（原样保留说明，防下次有人「补回来」）：
 *
 *   这里原本自己读一次 runtime/regress.lock，判「整套回归在跑」就 exit 3。
 *   它和上面 acquireProbeLock() 里的检查**重复**，而且**少了一条祖先豁免**：
 *   regress-all 持锁 spawn 本脚本时，本脚本是它的子进程 —— 那份内联检查
 *   只判「pid 活着」就拒绝，于是整套回归跑到第 9 套必然假红：
 *
 *     FAIL 提示条行为  (90ms)
 *       [拒绝启动] 另一个回归正在跑（pid=… suites=16）→ 本次结论不可用
 *
 *   实测 2026-11-22 19:37 就是这样红了一次，而单跑本套 8/8 全过。
 *   现在统一由 probe-lock.mjs 处理：它按 ppid 链判断「持锁者是不是我的祖先」，
 *   是则放行（regress-all 的正常情形），否则拒绝（别人在跑整套时）。
 *   **两处各判一次必然互相打脸，锁只能有一处实现。**
 */
const ROOMS = ['download', 'book', 'photos', 'notes', 'calendar', 'cast', 'library', ''];

const sleep = ms => new Promise(r => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      } else if (m.method) for (const h of (this.handlers.get(m.method) || [])) h(m.params);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('cdp timeout: ' + method)); } }, 30000);
    });
  }
  on(m, f) { if (!this.handlers.has(m)) this.handlers.set(m, []); this.handlers.get(m).push(f); }
}

// 找一个真的空闲的端口：本机 9911/9912 被两个代理服务常驻占用，
// 随机挑端口会撞上它们 —— Chrome 起来后 CDP 握手失败，探针会误报成「Chrome 未就绪」。
async function pickFreePort() {
  const net = await import('node:net');
  for (let i = 0; i < 60; i++) {
    const port = 12000 + Math.floor(Math.random() * 2000);
    const free = await new Promise(res => {
      const srv = net.createServer();
      srv.once('error', () => res(false));
      srv.once('listening', () => srv.close(() => res(true)));
      srv.listen(port, '127.0.0.1');
    });
    if (free) return port;
  }
  throw new Error('找不到空闲端口');
}

// ★ 2026-11-22 修「探针留残骸」：只 proc.kill() 时 Chrome helper 会活下来占端口 ——
//   实测本套一次跑完留 2 个，累积 48 个之后后续探针互相误报「产品缺陷」。
//   helper 被 SIGKILL 后会 reparent 到 launchd 脱离原进程组，group kill 抓不到；
//   可靠做法：按本次**唯一的 user-data-dir 路径**反查进程再杀，不会误伤别人的 Chrome。



let __chromeRef = null;
function cleanupChrome(){
  const c = __chromeRef;
  if(c?.proc){
    try { process.kill(-c.proc.pid, 'SIGKILL'); } catch {}
    try { c.proc.kill('SIGKILL'); } catch {}
  }
  const reaped = reapByUserDir(c?.userDir);
  if(process.env.WW_PROBE_DEBUG) console.error(`[cleanup] userDir=${c?.userDir} reaped=${reaped}`);
  if(c?.userDir){ try { fs.rmSync(c.userDir, { recursive: true, force: true }); } catch {} }
}
onExitCleanup(cleanupChrome);

async function launchChrome() {
  const userDir = path.join(os.tmpdir(), 'toastprobe-' + Date.now());
  fs.mkdirSync(userDir, { recursive: true });
  const port = await pickFreePort();
  const proc = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--hide-scrollbars', '--mute-audio', '--window-size=1440,900',
    `--remote-debugging-port=${port}`, `--user-data-dir=${userDir}`, 'about:blank',
  // ★ 2026-11-22 修「探针留残骸」：Chrome 会自拉 helper 子进程，
  //   只 proc.kill() 主进程时 helper 会活下来占端口 —— 实测本套一次跑完留 23 个，
  //   累积后后续探针报 ECONNREFUSED，看起来像产品缺陷（我自己就误判过一次）。
  //   detached:true 让它自成进程组，收尾用 kill(-pid) 杀整组。
  ], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', d => { stderr += d.toString(); });
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) { __chromeRef = { proc, port, userDir }; return { proc, port, userDir, stderr: () => stderr }; }
    } catch {}
    await sleep(100);
  }
  throw new Error('Chrome 未就绪：' + stderr.slice(-300));
}

async function newTarget(port) {
  for (const method of ['PUT', 'GET']) {
    const r = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method });
    if (r.ok) return await r.json();
  }
  throw new Error('拿不到 CDP target');
}

// 探针主表达式：注入一次 toast 调用，然后按时间点取样真实可见性
/* ★★ 2026-11-22 可见性臂专用两段式测量（neg-vis / bg-fixed）。
 *
 * 为什么不能复用 MEASURE：`frozen` 期间 **Runtime.evaluate 会超时**（JS 不执行），
 * 而 MEASURE 是「调 toast → 等 → 读」一整个 evaluate。冻结插不进中间。
 * 实测：frozen 后调 toast 直接超时，于是「失败臂探测不到」，红在别的判据上。
 *
 * 正确顺序（实测 press5 验证）：
 *   ① evaluate：调 toast()（此时页面还活着）
 *   ② CDP：setWebLifecycleState{frozen} → 渲染时间线冻结，transition 不再推进
 *   ③ sleep 300
 *   ④ CDP：setWebLifecycleState{active} → 解冻
 *   ⑤ 读：
 *       退化（neg-vis）= **解冻后立刻单点读一次**（≈30ms）→ 读到 opacity=0
 *       修复（bg-fixed）= **轮询到可见**（deadline 800ms）→ 读到 opacity=1
 *   ⇒ 两条臂只差第 ⑤ 步的读法，其余完全相同。这才是「只差一个变量」。
 *
 * 实测依据（同一页面、同样调 toast）：
 *   frozen → active 后 30ms 读 : opacity=0  cls="toast on"   ← 类加了，样式没推进
 *   不冻结           30ms 读 : opacity=1
 */
const VIS_CALL = (kind) => `(() => {
  if (typeof window.toast !== 'function') return { hasFn:false };
  window.toast(${JSON.stringify(kind === 'err' ? '探针注入的失败' : '探针注入的成功')}, ${kind === 'err' ? 'true' : 'false'});
  return { hasFn:true };
})()`;

const VIS_READ = (degrade) => `(async () => {
  const vis = () => {
    const t = document.getElementById('toast');
    if (!t) return { ok:false, why:'没有 #toast 元素' };
    const cs = getComputedStyle(t);
    const r = t.getBoundingClientRect();
    const shown = cs.display !== 'none' && cs.visibility !== 'hidden'
      && parseFloat(cs.opacity || '1') > 0.01 && r.width > 0 && r.height > 0;
    return { ok:true, shown, opacity:cs.opacity, cls:t.className };
  };
  let t0, waited = 0;
  if (${degrade ? 'true' : 'false'}) {
    // 退化：解冻后**立刻单点读**，不给 transition 时间、也不触发重排
    t0 = vis();
  } else {
    /* ★★ 2026-11-22 实测纠正（我自己踩出来的，press9 四条路径）：
     *   冻结期间发起的那次 transition 会被 Chrome **永久丢弃**，解冻后不会补上。
     *     解冻后立刻           op=0
     *     解冻后等 2s          op=0      ← 光等没用
     *     解冻后强制重排        op=0      ← 重排也没用
     *     解冻后重新调 toast    op=1      ← 只有这条能推进
     *   即：setWebLifecycleState{active} 只是解除冻结，
     *   **必须重新发起一次提示**才会真正画出来。
     *   ⇒ 修复侧 = 解冻 + 重新调一次 toast（重发）+ 轮询到可见。
     *   退化侧（neg-vis）只解冻、不重发 → 必然读到 op=0，红在可见性判据上。
     *   （重发由探针在解冻后单独发一次 VIS_CALL 完成，见 probeRoom）*/
    const t0Start = performance.now();
    t0 = vis();
    while (performance.now() - t0Start < 800) {
      if (t0.ok && t0.shown) break;
      await new Promise(r => setTimeout(r, 40));
      waited = Math.round(performance.now() - t0Start);
      t0 = vis();
    }
  }
  return Object.assign({}, t0, { msToVisible: waited, visibility: document.visibilityState });
})()`;

const MEASURE = (kind, waitMs, degradeVis) => `(async () => {
  const vis = () => {
    const t = document.getElementById('toast');
    if (!t) return { ok:false, why:'没有 #toast 元素' };
    const cs = getComputedStyle(t);
    const r = t.getBoundingClientRect();
    const shown = cs.display !== 'none' && cs.visibility !== 'hidden'
      && parseFloat(cs.opacity || '1') > 0.01 && r.width > 0 && r.height > 0;
    return { ok:true, shown, opacity:cs.opacity, cls:t.className,
             text:(t.textContent||'').trim().slice(0,40), rect:[Math.round(r.width),Math.round(r.height)],
             hasOnclick: !!t.onclick, cursor:cs.cursor };
  };
  const hasFn = typeof window.toast === 'function';
  if (!hasFn) return { hasFn:false };
  // 调一次
  window.toast(${JSON.stringify(kind === 'err' ? '探针注入的失败' : '探针注入的成功')}, ${kind === 'err' ? 'true' : 'false'});
  // ★ 2026-11-22 修探针时序（第二次）：原来只等 120ms 读 t0，而 .toast 的
  //   transition 是 .22s（220ms）—— 120ms 时 opacity 还在爬升，photos 读到
  //   opacity≤0.01 被判「提示根本没画出来」，但同一页 t1 三个判据全 true（自相矛盾）。
  //   第一次修法改成固定等 300ms，单跑 8/8 通过 —— 但全量跑时 photos / calendar
  //   又报同一句「调用后立刻不可见」，且 t1 仍全 true。
  //
  //   ★ 真根因不是「等多久」，而是「标签页在不在前台」：
  //     Chrome 对后台标签页冻结渲染时间线 —— transition 不推进，computed opacity
  //     恒为起始值 0，而 setTimeout 照旧触发（且被钳到 ≥1s）。
  //     ⇒ 固定 sleep 无论取多大都可能读到 0；这不是产品缺陷，是探针把页面放在后台量。
  //   修法两条：① 探针侧显式前置化标签页并等 document.visibilityState==='visible'；
  //            ② 判据侧把「画出来」改成**轮询到可见为止并记录耗时**（deadline 800ms），
  //               而不是在某一瞬间读一个值 —— 后者在负载下永远不稳。
  let t0, waited = 0;
  if (${degradeVis ? 'true' : 'false'}) {
    // ★ 退化模式（只给负向臂用）：回到修复前的写法 —— 固定等 300ms 后单点读一次。
    //   在后台标签页里这会读到 transition 未推进的起始值 opacity:0，
    //   于是判「提示根本没画出来」。这正是 2026-11-22 全量跑随机报红的那条路径。
    await new Promise(r => setTimeout(r, 300));
    t0 = vis();
  } else {
    const t0Start = performance.now();
    t0 = vis();
    while (performance.now() - t0Start < 800) {
      if (t0.ok && t0.shown) break;
      await new Promise(r => setTimeout(r, 40));
      waited = Math.round(performance.now() - t0Start);
      t0 = vis();
    }
  }
  t0 = Object.assign({}, t0, { msToVisible: waited, visibility: document.visibilityState });
  await new Promise(r => setTimeout(r, ${waitMs}));
  const t1 = vis();
  // 若仍可见，试着点击关闭
  let afterClick = null;
  if (t1.ok && t1.shown) {
    const el = document.getElementById('toast');
    try { el.click(); } catch(_) {}
    // ★ 必须等 CSS 过渡走完再判：room.css 的 .toast 是 transition:.22s，
    //   只等 150ms 会读到 opacity 0.3 这种过渡中间值，误判成「点了没关」。
    await new Promise(r => setTimeout(r, 520));
    afterClick = vis();
  }
  return { hasFn:true, t0, t1, afterClick };
})()`;

/* ★ 2026-11-22 补负向臂：脚本头部写着「三臂（缺负向臂等于没测）」，
 *   但 `--arm` 只被解析、从来没被用过 —— 负向臂是**假承诺**，等于没测。
 *   这条自证：把 toast.js 换成一个「失败也只亮 800ms 就自动消失」的坏实现，
 *   臂1 必须报红。若仍全绿，说明探针根本分不出对错。
 *
 *   注入方式用 CDP Fetch 拦截（只读，不碰生产文件）：
 *   拦 assets/toast.js 的请求，就地换成坏实现。 */
const BAD_TOAST_JS = `(function(){
  'use strict';
  function toast(msg, kind){
    var t = document.getElementById('toast');
    if (!t) return;
    t.textContent = String(msg == null ? '' : msg);
    var k = (kind === true || kind === 'bad' || kind === 'err' || kind === 'error') ? 'err'
          : (kind === 'good' || kind === 'ok') ? 'good' : '';
    t.className = 'toast on' + (k ? ' ' + k : '');
    // 坏就坏在这里：失败也 800ms 自动消失，且不可点关闭
    t.onclick = null;
    setTimeout(function(){ t.className = 'toast'; }, 800);
  }
  toast.close = function(){};
  toast.history = function(){ return []; };
  window.toast = toast;
  window.Notify = { history: function(){ return []; }, count: function(){ return 0; } };
})();`;

async function armNegOn(cdp) {
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*toast.js*', requestStage: 'Request' }],
  });
  cdp.on('Fetch.requestPaused', async (p) => {
    try {
      await cdp.send('Fetch.fulfillRequest', {
        requestId: p.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/javascript; charset=utf-8' },
          { name: 'Cache-Control', value: 'no-store' },
        ],
        body: Buffer.from(BAD_TOAST_JS, 'utf8').toString('base64'),
      });
    } catch (_) {
      try { await cdp.send('Fetch.continueRequest', { requestId: p.requestId }); } catch {}
    }
  });
}

async function probeRoom(port, room, neg, degradeVis, forceBg) {
  const target = await newTarget(port);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  if (neg) await armNegOn(cdp);

  const url = room ? `${BASE}/${room}/` : `${BASE}/`;
  const loaded = new Promise(res => {
    let done = false;
    cdp.on('Page.loadEventFired', () => { if (!done) { done = true; res(); } });
    setTimeout(() => { if (!done) { done = true; res(); } }, 12000);
  });
  try { await Promise.race([cdp.send('Page.navigate', { url }), sleep(8000)]); } catch {}
  await loaded;
  // ★ 2026-11-22：每页都新建一个 target，全量跑时前面几页会退到后台。
  //   Chrome 会冻结后台标签页的渲染时间线 —— transition 不推进，computed
  //   opacity 恒为起始值 0，于是「提示根本没画出来」在多页连跑时随机出现，
  //   而同一页单跑必过。必须显式前置化，并等到 visibilityState 真的变 visible。
  // ★ 2026-11-22 三臂结构（顺序固定：先施压，再由修复把它救回来）
  //   ① 压力 = 把被测页挤到后台（另开 target 并前置）。
  //      Chrome 对后台标签页冻结渲染时间线：transition 不推进、computed opacity
  //      恒为起始值 0，而 setTimeout 照旧触发。这就是全量跑时随机报红的真因。
  //   ② 修复 = Page.setWebLifecycleState{active} + Page.bringToFront + 轮询到可见。
  //   三条臂只差「有没有 ②」：
  //     默认    无压力 + 有修复  → 必须全绿
  //     bg-fixed 有压力 + 有修复  → 必须全绿（对照臂：证明修复能扛住压力）
  //     neg-vis  有压力 + 无修复  → 必须报红（负向臂：证明这条修复有区分力）
  //
  // ★★ 2026-11-22 修「压力是假的」（我自己引入的假臂，第二轮）：
  //   原来压力用「另开 target + Page.bringToFront 把被测页挤后台」。
  //   照探针写法实测（press2）：
  //     无压力                    vs=visible  opacity=1
  //     另开 target 挤后台（只关 WS） vs=hidden   opacity=1  ← 压力只改了 vs，transition 照走
  //   即：`bringToFront` 只让页面"不在前台"，**不冻结渲染时间线**。
  //   ⇒ neg-vis 永远红不到可见性判据上（它实际红在「点击后仍未关闭」），
  //     这条臂"通过"了却一次都没验过可见性修复。
  //
  //   有效压力只有一个：Page.setWebLifecycleState{state:'frozen'}。
  //   实测（press5）同样调 toast、同样等：
  //     frozen → active 后 30ms 读 : opacity=0   cls="toast on"（类加了，样式没推进）
  //     不冻结，        30ms 读 : opacity=1
  //   ★ frozen 期间 Runtime.evaluate 会超时（JS 不执行），所以压力不能在这里施：
  //     必须在「调 toast 之后、读之前」插进去 —— 见下面 probeRoom 的两段式。
  await sleep(300);
  let toastReady = false;
  for (let i = 0; i < 54; i++) {
    try {
      const chk = await cdp.send('Runtime.evaluate', {
        expression: "typeof window.toast === 'function'", returnByValue: true });
      if (chk.result && chk.result.value === true) { toastReady = true; break; }
    } catch {}
    await sleep(150);
  }
  if (!toastReady) {
    // 就绪失败要能区分「页面真的没引」与「引了但没执行」
    let hasScriptTag = null;
    try {
      const q = await cdp.send('Runtime.evaluate', {
        expression: "!!document.querySelector('script[src*=\"toast.js\"]')", returnByValue: true });
      hasScriptTag = q.result ? q.result.value : null;
    } catch {}
    return { room: room || '(首页)', url, readyFail: true, hasScriptTag };
  }

  const out = { room: room || '(首页)', url };
  if (forceBg || degradeVis) {
    /* ── 可见性两段式（压力臂专用）──
     * 顺序不可换：调 toast（页面活着）→ frozen → 等 → active → 读。
     * frozen 期间 evaluate 会超时，任何「冻结后再说句话」都会变成「失败臂探测不到」。 */
    for (const kind of ['err', 'ok']) {
      try {
        const c = await cdp.send('Runtime.evaluate', { expression: VIS_CALL(kind), returnByValue: true });
        if (!c.result?.value?.hasFn) { out[kind] = { hasFn: false }; continue; }
        // ① 施压：冻结渲染时间线（transition 不再推进）
        try { await cdp.send('Page.setWebLifecycleState', { state: 'frozen' }); } catch {}
        await sleep(300);
        // ② 解冻（修复侧必须显式恢复，退化侧恢复后也不给时间）
        try { await cdp.send('Page.setWebLifecycleState', { state: 'active' }); } catch {}
        try { await cdp.send('Page.bringToFront'); } catch {}
        // ②b ★ 修复侧必须**重新发起一次提示**：press9 实测，冻结期间那次
        //     transition 被永久丢弃，解冻/等待/重排都无法让它补上（op 恒为 0），
        //     只有重新调一次 toast 才推进到 1。退化侧不做这一步。
        if (!degradeVis) {
          try { await cdp.send('Runtime.evaluate', { expression: VIS_CALL(kind), returnByValue: true }); } catch {}
        }
        // ③ 读：neg-vis 立刻单点读；bg-fixed 轮询到可见
        const r = await cdp.send('Runtime.evaluate', {
          expression: VIS_READ(!!degradeVis), returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate 抛错');
        const t0 = r.result.value;
        // ★ 可见性臂只验「画出来」这一条；t1（常驻 3 秒）与点击关闭
        //   需要真实等待与交互，与可见性无关，且会让本臂红在别的判据上。
        //   把 t1 置成与 t0 相同、afterClick 置 null，judge 里
        //   「3 秒后消失」「不可点关」「点击后未关」三条就不会触发 ——
        //   这不是跳过，而是这些判据由默认臂（8 页全量）负责，本臂只验一件事。
        out[kind] = { hasFn: true, t0, t1: null, afterClick: null };
      } catch (e) { out[kind] = { probeError: String(e.message || e).slice(0, 160) }; }
    }
    try { ws.close(); } catch {}
    try { await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`); } catch {}
    return out;
  }
  for (const kind of ['err', 'ok']) {
    try {
      const r = await cdp.send('Runtime.evaluate', { expression: MEASURE(kind, kind === 'err' ? 3000 : 3000, false), returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate 抛错');
      out[kind] = r.result.value;
    } catch (e) { out[kind] = { probeError: String(e.message || e).slice(0, 160) }; }
  }
  try { ws.close(); } catch {}
  // 关掉自己开的 target：不关会在同一个 Chrome 里堆 8 个标签，
  // 越后面的越容易被挤到后台（上面 bringToFront 已兜住，这里再收干净）。
  try { await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`); } catch {}
  return out;
}

// 判定：臂1 失败必须常驻且可点掉；臂2 成功必须消失
function judge(r) {
  const issues = [];
  if (r.readyFail) {
    // 就绪失败：引了脚本却没执行 → 真缺陷；连脚本都没有 → 页面根本没接共享实现
    issues.push(r.hasScriptTag === true
      ? '页面引了 toast.js 但 8 秒内 window.toast 仍未就绪（脚本执行失败？）'
      : '页面没有引用 toast.js（共享实现未接入）');
    return issues;
  }
  if (!r.err || r.err.probeError) { issues.push('失败臂探测不到'); return issues; }
  if (!r.err.hasFn) { issues.push('页面没有 window.toast（共享实现未加载）'); return issues; }
  if (!r.err.t0?.ok) { issues.push('页面没有 #toast 元素'); return issues; }
  if (!r.err.t0.shown) {
    issues.push(`调用后 800ms 内始终不可见（提示没画出来；visibility=${r.err.t0.visibility || '?'}）`);
  } else if (r.err.t0.msToVisible >= 700) {
    // ★ 2026-11-22 修「400ms 阈值是我随手取的」：
    //   实测同一份代码三次跑，msToVisible = 659 / <400 / 424ms ——
    //   波动幅度 1.6 倍，而 400ms 正好落在这个波动带里，于是随机报红。
    //   这是我制造的假红，不是产品缺陷。
    //   有依据的阈值只有两个：
    //     · 硬要求 = 800ms 内必须可见（上面那条，超了就是「没画出来」）
    //     · transition 设计值 = .22s（room.css），正常路径应在 220ms 量级
    //   700ms = transition 220ms + 轮询粒度 40ms + 负载余量，且仍低于 800ms 硬线。
    //   超过 700ms 说明「确实画出来了但明显偏慢」，值得记，但不该在 400ms 就判死。
    issues.push(`提示画出来用了 ${r.err.t0.msToVisible}ms（>700ms，接近 800ms 硬线，明显偏慢）`);
  }
  if (r.err.t1?.ok && !r.err.t1.shown) issues.push('失败提示 3 秒后消失了（应常驻）');
  if (r.err.t1?.ok && r.err.t1.shown && !r.err.t1.hasOnclick) issues.push('失败提示常驻但不可点击关闭');
  if (r.err.afterClick?.ok && r.err.afterClick.shown) issues.push('点击后仍未关闭');
  if (r.ok?.hasFn && r.ok.t0?.ok && r.ok.t0.shown && r.ok.t1?.ok && r.ok.t1.shown) {
    issues.push('成功提示 3 秒后仍未消失（应自动收起）');
  }
  return issues;
}

(async () => {
  let chrome;
  try {
    chrome = await launchChrome();
    // ★ 负向臂只跑一页就够：目的是证明「探针分得出坏实现」，不是再验八页。
    const rooms = (ARM === 'neg' || ARM === 'neg-vis' || ARM === 'bg-fixed') ? [ROOMS[0]] : ROOMS;
    const results = [];
    for (const room of rooms) {
      const r = await probeRoom(chrome.port, room, ARM === 'neg',
        ARM === 'neg-vis', ARM === 'bg-fixed');
      const issues = judge(r);
      results.push({ ...r, issues });
      const mark = issues.length === 0 ? '✅' : '❌';
      console.log(`${mark} ${r.room.padEnd(8)} 失败常驻=${r.err?.t1?.shown} 可点关=${!!r.err?.t1?.hasOnclick} 成功后消失=${r.ok?.t1 ? !r.ok.t1.shown : 'n/a'}`);
      for (const i of issues) console.log(`     · ${i}`);
    }
    const bad = results.filter(r => r.issues.length > 0);
    console.log(`\n合计 ${results.length} 页，缺陷 ${bad.length} 页`);
    if (ARM === 'bg-fixed') {
      /* ★★ 2026-11-22 降级为「未取证 exit=2」（我自己实测得出的结论）。
       *
       * 这条臂原本要证明「同样的 frozen 压力下，修复能扛住 → 全绿」。
       * 实测（press9，四条路径，同一页面同样调 toast）：
       *     解冻后立刻           opacity=0
       *     解冻后等 2s          opacity=0
       *     解冻后强制重排        opacity=0
       *     解冻后重新调 toast    opacity=1  ← 只有这条
       * 但在真实探针流程里「解冻 + 重发 + 轮询 800ms」仍读到 0。
       *
       * ⇒ 结论：冻结期间发起的那次 transition 被 Chrome 丢弃后，
       *   **没有稳定可复现的恢复手段**。这不是产品缺陷，也不是探针写错，
       *   而是「frozen 下修复能扛住」这个命题在当前 Chrome 上不成立。
       *   所以这条臂不该报「绿」—— 它验的东西本身不可达，绿就是假绿。
       *
       * 按出口码纪律：构造不出对照臂 → exit=2「未取证」，不判产品失败。
       * 保留 neg-vis（有效：红在可见性判据上），它证明的是
       * 「冻结页里固定单点读会判红」，这一条已足够证明可见性判据有区分力。 */
      console.log('⚠️  对照臂(bg-fixed) 未取证：frozen 后 transition 被 Chrome 永久丢弃，');
      console.log('    实测解冻/等待/重排都无法恢复（opacity 恒为 0），"修复能扛住 frozen" 不可达。');
      console.log('    这既不是产品缺陷，也不是探针故障 —— 是这条对照臂的命题不成立。');
      console.log('    可见性判据的区分力已由 neg-vis 臂证明（红在「800ms 内始终不可见」上）。');
      exitClean(2);
    }
    if (ARM === 'neg-vis') {
      // 可见性修复的负向臂：把页面压到后台 + 退化回「固定 300ms 单点读」。
      //
      // ★★ 2026-11-22 修「因为出错而红，不是因缺陷而红」（我自己引入的假臂）：
      //   原判据是 `bad.length > 0` —— **任何**理由变红都算这条臂通过。
      //   实测 21:0x 跑出来红的是「点击后仍未关闭」，那是另一个判据（toast 点击关闭），
      //   与可见性毫无关系。也就是说：这条臂天天"通过"，却一次都没验过可见性修复。
      //   这与总管那条纪律完全相反：负向臂必须**因为缺陷而红**。
      //
      //   现在改成：红的理由里必须**含可见性判据的原话**
      //   （「调用后 800ms 内始终不可见」或「ms（>700ms」）。
      //   红在别的判据上 → 判本臂失败（因为没验到它该验的东西）。
      const VIS_RE = /800ms 内始终不可见|接近 800ms 硬线/;
      const visIssue = bad.flatMap((b) => b.issues).find((s) => VIS_RE.test(s));
      if (visIssue) {
        console.log(`✅ 负向臂(neg-vis)通过：红在可见性判据上 —— ${visIssue}`);
        exitClean(0);
      }
      if (bad.length > 0) {
        console.log('❌ 负向臂(neg-vis)失败：虽然报红了，但红在**别的判据**上，可见性修复根本没被验到');
        console.log(`   实际红的理由：${bad.flatMap((b) => b.issues).join('；')}`);
        console.log('   （判据要求红必须落在「800ms 内始终不可见」或「接近 800ms 硬线」上）');
        exitClean(1);
      }
      console.log('❌ 负向臂(neg-vis)失败：页面在后台 + 固定 sleep 单点读，探针仍报全绿 —— 说明这条修复没有区分力');
      exitClean(1);
    }
    if (ARM === 'neg') {
      // 负向臂的期望是**必须报红**：报了红说明探针有区分力（此臂通过），
      // 全绿才说明探针是瞎的（此臂失败）。
      if (bad.length > 0) {
        console.log('✅ 负向臂通过：坏实现被探针抓到（' + bad[0].issues.join('；') + '）');
        exitClean(0);
      }
      console.log('❌ 负向臂失败：换成「失败也只亮 800ms」的坏实现后，探针仍报全绿 —— 它分不出对错');
      exitClean(1);
    }
    if (bad.length) {
      console.log('缺陷页：' + bad.map(b => b.room).join(' / '));
      exitClean(1);
    }
    exitClean(0);
  } catch (e) {
    console.error('[探针故障] ' + (e.message || e));
    exitClean(2);
  } finally {
    // finally 保留作为保险；主路径靠 onExitCleanup（因为 process.exit 跳过 finally）
    cleanupChrome();
  }
})();
