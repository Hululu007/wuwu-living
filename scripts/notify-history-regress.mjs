#!/usr/bin/env node
/**
 * 五五客厅 · 消息回看（S8）验收探针 —— 真浏览器
 *
 * 为什么必须用真浏览器：
 *   「关闭浮层不删记录」只有在真的点击之后才能证明。读源码只能看到
 *   `t.onclick = ...` 这一行，证明不了「点完之后 history 里还有」。
 *
 * 覆盖设计管家《交互契约-toast-Rev2》判据 1–6：
 *   1. 制造失败 → 入口出现且角标 = 1
 *   2. 等 10 秒（原 toast 早该消失）→ 点开仍能读到完整文本
 *   3. 点 toast 关闭 → 记录仍在 history（关的是浮层，不是记录）★核心
 *   4. 成功操作 → 不产生 error 记录、角标不增加
 *   5. 同一条失败连打 3 次 → 只有 1 条但带 ×3
 *   6. 刷新后清空（仅内存，不落 localStorage）
 *
 * 负向臂（缺了等于没测）：
 *   把 toast.js 换成「关闭即删记录」的坏实现，判据 3 必须报红。
 *   用法：--arm=neg 时探针自己注入坏实现覆盖 window.toast，
 *        然后断言「判据 3 必须失败」——如果它没失败，说明我们的断言测不出东西。
 *
 * 用法：node notify-history-regress.mjs [--base=...] [--rooms=...] [--arm=ok|neg]
 * 退出码 0 全绿 / 1 有缺陷 / 2 探针自身故障
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// ★ 2026-11-23：六个真浏览器探针必须共用一个锁。缺了它，
//   两个探针同时各 spawn 一个 Chrome，会把标签页挤到后台 →
//   Chrome 冻结渲染时间线 → 量出来的可见性/过渡全是假值。
import { acquireProbeLock } from './probe-lock.mjs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const argv = process.argv.slice(2);
const BASE = (argv.find((a) => a.startsWith('--base=')) || '--base=http://127.0.0.1:8890').slice(7);
const ARM = (argv.find((a) => a.startsWith('--arm=')) || '--arm=ok').slice(6);
const ROOMS = (argv.find((a) => a.startsWith('--rooms=')) || '--rooms=notes,photos,library,calendar,download').slice(8).split(',').filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const net = await import('node:net');
  for (let i = 0; i < 60; i++) {
    const p = 15000 + Math.floor(Math.random() * 3000);
    const ok = await new Promise((res) => {
      const s = net.createServer();
      s.once('error', () => res(false));
      s.once('listening', () => s.close(() => res(true)));
      s.listen(p, '127.0.0.1');
    });
    if (ok) return p;
  }
  throw new Error('找不到空闲端口');
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
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

/* 在页面里执行的一段完整验收脚本；返回结构化结果，判据在 Node 侧判。 */
const RUN = (arm) => `(async () => {
  const out = { arm: ${JSON.stringify(arm)}, steps: {} };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const btn = () => document.getElementById('ww-notify-entry');

  if (typeof window.toast !== 'function' || !window.Notify) {
    out.fatal = '页面没有 toast/Notify（脚本未加载）';
    return out;
  }

  // ── 负向臂：装一个「关闭即删记录」的坏实现，验证我们的断言有区分力
  if (${JSON.stringify(arm)} === 'neg') {
    const bad = [];
    window.Notify = {
      history: () => bad.slice(),
      count: () => bad.length,
      clear: () => { bad.length = 0; },
      latest: () => bad[bad.length - 1] || null,
    };
    window.toast = function (msg, kind) {
      const t = document.getElementById('toast');
      const isErr = kind === true || kind === 'err' || kind === 'bad';
      bad.push({ text: String(msg), at: Date.now(), n: 1 });
      t.textContent = String(msg);
      t.className = 'toast on' + (isErr ? ' err' : '');
      if (isErr) {
        t.onclick = function () {
          // 坏行为：关闭浮层的同时把记录也删掉
          bad.length = 0;
          t.className = 'toast'; t.onclick = null;
        };
      }
    };
  }

  // ── 判据 1：制造一次失败 → 入口可见且角标 = 1
  window.Notify.clear && window.Notify.clear();
  window.toast('探针注入的失败', 'err');
  await sleep(200);
  const b1 = btn();
  out.steps.c1 = {
    entryExists: !!b1,
    entryVisible: !!(b1 && !b1.hidden && b1.getBoundingClientRect().width > 0),
    count: window.Notify.count(),
    badge: b1 ? (b1.textContent || '').trim() : '',
  };

  // ── 判据 3（核心）：点 toast 的关闭 → 记录仍在
  const t = document.getElementById('toast');
  if (t && t.onclick) { t.onclick(); } else { try { t.click(); } catch (_) {} }
  await sleep(300);
  const histAfterClose = window.Notify.history();
  out.steps.c3 = {
    toastStillShown: !!(t && getComputedStyle(t).visibility !== 'hidden' && parseFloat(getComputedStyle(t).opacity || '1') > 0.01),
    historyLen: histAfterClose.length,
    firstText: histAfterClose.length ? histAfterClose[histAfterClose.length - 1].text : null,
  };

  // ── 判据 2：等 10 秒（远超成功提示 2.4 秒）→ 仍能读到
  await sleep(10000);
  const b2 = btn();
  const hist10 = window.Notify.history();
  out.steps.c2 = {
    entryStillVisible: !!(b2 && !b2.hidden),
    historyLen: hist10.length,
    readable: hist10.length > 0 && hist10[0].text === '探针注入的失败',
  };

  // ── 判据 4：成功操作不产生 error 记录
  const before = window.Notify.count();
  window.toast('探针注入的成功', 'good');
  await sleep(300);
  out.steps.c4 = { before, after: window.Notify.count(), delta: window.Notify.count() - before };

  // ── 判据 5：同一条失败连打 3 次 → 1 条 + ×3
  window.Notify.clear && window.Notify.clear();
  window.toast('同一条失败', 'err');
  window.toast('同一条失败', 'err');
  window.toast('同一条失败', 'err');
  await sleep(200);
  const h5 = window.Notify.history();
  out.steps.c5 = { len: h5.length, n: h5.length ? (h5[h5.length - 1].n || 1) : 0 };

  // ── 判据 6：不落 localStorage
  let ls = 0;
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/notify|toast|history/i.test(k)) ls++; } } catch (_) {}
  out.steps.c6 = { localStorageKeys: ls };

  return out;
})()`;

async function probeRoom(port, room) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  let target = list.find((t) => t.type === 'page');
  if (!target) {
    for (const m of ['PUT', 'GET']) {
      const r = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: m });
      if (r.ok) { target = await r.json(); break; }
    }
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const loaded = new Promise((res) => {
    let d = false;
    cdp.on('Page.loadEventFired', () => { if (!d) { d = true; res(); } });
    setTimeout(() => { if (!d) { d = true; res(); } }, 15000);
  });
  try { await Promise.race([cdp.send('Page.navigate', { url: `${BASE}/${room}/` }), sleep(10000)]); } catch {}
  await loaded;
  await sleep(900);

  let value;
  try {
    const r = await cdp.send('Runtime.evaluate', { expression: RUN(ARM), returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate 抛错');
    value = r.result.value;
  } catch (e) {
    value = { fatal: String(e.message || e).slice(0, 200) };
  }
  try { ws.close(); } catch {}
  return { room, ...value };
}

function judge(r) {
  const bad = [];
  if (r.fatal) { bad.push('探针故障：' + r.fatal); return bad; }
  const s = r.steps || {};
  if (!s.c1?.entryExists) bad.push('判据1：页面没有消息入口');
  else if (!s.c1.entryVisible) bad.push('判据1：入口存在但不可见');
  if (s.c1 && s.c1.count < 1) bad.push('判据1：失败后记录数仍为 0');
  if (s.c3 && s.c3.historyLen < 1) bad.push('判据3（核心）：关闭浮层后记录被删了');
  if (s.c3 && s.c3.toastStillShown) bad.push('判据3：点了关闭浮层还在');
  if (s.c2 && !s.c2.readable) bad.push('判据2：10 秒后读不到那条失败');
  if (s.c4 && s.c4.delta !== 0) bad.push(`判据4：成功提示产生了 ${s.c4.delta} 条 error 记录`);
  if (s.c5 && s.c5.len !== 1) bad.push(`判据5：连打 3 次留下 ${s.c5.len} 条（应 1 条）`);
  if (s.c5 && s.c5.n !== 3) bad.push(`判据5：计数为 ${s.c5.n}（应 3）`);
  if (s.c6 && s.c6.localStorageKeys > 0) bad.push('判据6：记录写进了 localStorage');
  return bad;
}

(async () => {
  await acquireProbeLock('notify-history');
  let chrome;
  try {
    const port = await freePort();
    const userDir = path.join(os.tmpdir(), 'notifyprobe-' + Date.now());
    fs.mkdirSync(userDir, { recursive: true });
    chrome = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--hide-scrollbars', '--mute-audio', '--window-size=1440,900',
      `--remote-debugging-port=${port}`, `--user-data-dir=${userDir}`, 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    chrome.stderr.on('data', (d) => { stderr += d.toString(); });
    for (let i = 0; i < 120; i++) {
      try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) break; } catch {}
      await sleep(100);
    }

    const results = [];
    for (const room of ROOMS) {
      const r = await probeRoom(port, room);
      const issues = judge(r);
      results.push({ ...r, issues });
      console.log(`${issues.length ? '❌' : '✅'} ${room.padEnd(9)} 入口=${r.steps?.c1?.entryVisible} 关闭后记录=${r.steps?.c3?.historyLen} 10秒可读=${r.steps?.c2?.readable} ×N=${r.steps?.c5?.n}`);
      for (const i of issues) console.log('     · ' + i);
    }

    const failedPages = results.filter((r) => r.issues.length > 0);
    console.log(`\n合计 ${results.length} 页，缺陷 ${failedPages.length} 页（arm=${ARM}）`);

    if (ARM === 'neg') {
      // 负向臂的期望是「判据 3 必须红」。没红 = 断言没有区分力。
      const caught = results.some((r) => r.issues.some((i) => i.includes('判据3')));
      if (caught) { console.log('✅ 负向臂成立：坏实现被「关闭即删记录」判据抓到'); process.exit(0); }
      console.error('❌ 负向臂失败：坏实现没被抓到 → 本套断言没有区分力，结论不可用');
      process.exit(1);
    }
    process.exit(failedPages.length ? 1 : 0);
  } catch (e) {
    console.error('[探针故障] ' + (e.message || e));
    process.exit(2);
  } finally {
    if (chrome) { try { chrome.kill(); } catch {} }
  }
})();
