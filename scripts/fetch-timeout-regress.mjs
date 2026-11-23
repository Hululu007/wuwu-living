#!/usr/bin/env node
/* fetch-timeout-regress.mjs —— 超时封装的回归锁
 *
 * 为什么要有这一条（2026-11-22 总管实测定性）：
 *   后端「accept 后不回包」时，无 signal 的 fetch 永不返回，页面永远停在加载中。
 *   而 wwFetch 的存在**不等于**生效——它自己曾经因为内部调全局 fetch 而无限递归，
 *   结果所有请求 18ms 就抛 RangeError，比不加超时更糟。
 *   ⇒ 必须端到端验证：真起一个挂起服务，真跑 assets/fetch-timeout.js，量真实毫秒。
 *
 * 三臂：
 *   臂1 裸 fetch 无 signal   → 必须不返回（看门狗兜住），证明问题真实存在
 *   臂2 wwFetch 默认 8s      → 必须 ~8000ms 抛 TimeoutError 且 isTimeout=true
 *   臂3 wwFetch(timeout:0)   → 必须不超时（明确退出机制仍可用）
 *
 * 用法：node scripts/fetch-timeout-regress.mjs [--json]
 * 退出码：0 全过 / 1 有臂不合格 / 2 检查器故障
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(HERE, '..', 'public');
const SRC = path.join(PUB, 'assets', 'fetch-timeout.js');
const AS_JSON = process.argv.includes('--json');

/* ── 端口：动态取，不用写死的 19779 ────────────────────────────────
 * 2026-11-22 后端管家报「每次运行泄漏 19779、连跑三次全 EADDRINUSE」。
 * 实测结论（三次干净单跑 + 一次并发对照）：
 *   · 单跑连跑三次 → 全部 exit=0，退出后 lsof 19779 立即为空 ⇒ **没有泄漏**；
 *   · 两个实例同时在跑 → 第二个必然 EADDRINUSE ⇒ 真因是**并发抢同一端口**，
 *     不是「上次没释放」。
 * 本套是唯一不查 regress.lock 的套件，所以任何时候单独跑它，都会和
 * regress-all 里的同名子套撞端口（那 1 个 FAULT 位就是这么来的）。
 * 根治办法不是加锁，是**不占固定端口**：在夹具段内扫一对相邻空闲端口。
 * ─────────────────────────────────────────────────────────────── */
const PORT_MIN = 19100;      // 夹具段 19000–19999，不碰项目端口
const PORT_MAX = 19998;      // 留出 PORT+1 给「防误报」臂
const HANG_MS = 12000;   // 臂1 看门狗：只需证明「远超 8s 仍未返回」
const arms = [];
const arm = (name, pass, detail) => arms.push({ name, pass: !!pass, detail });

let srv = null;
/* 挂起服务上建立的每条 socket 都记下来：close() 只是「不再 accept」，
 * 不会断开已建立的连接；不显式 destroy，srv.close(cb) 的回调永远等不到。 */
const sockets = new Set();
const cleanup = async () => {
  for (const s of sockets) { try { s.destroy(); } catch {} }
  sockets.clear();
  await new Promise((r) => { try { srv ? srv.close(r) : r(); } catch { r(); } });
};

/* 取一对相邻端口并**当场把服务绑上去**。
 * ★ 不要写成「先探空闲 → close → 再 listen」：那中间有个窗口，两个实例会
 *   同时探到同一个端口、同时 close、然后一个成功一个 EADDRINUSE 崩溃
 *   （2026-11-22 我自己第一版就这么写，被并发负向臂抓到了）。
 * 正确做法：直接绑真实服务，绑不上就换下一个端口 —— 没有探测窗口就没有竞态。 */
const bindPair = async () => {
  for (let p = PORT_MIN; p <= PORT_MAX; p += 1) {
    const hang = net.createServer((s) => {
      sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => {});
    });
    const ok = await new Promise((r) => {
      const onErr = () => { hang.removeListener('listening', onOk); r(false); };
      const onOk = () => { hang.removeListener('error', onErr); r(true); };
      hang.once('error', onErr);
      hang.once('listening', onOk);
      hang.listen(p, '127.0.0.1');
    });
    if (!ok) { try { hang.close(); } catch {} continue; }

    const okSrv = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    const ok2 = await new Promise((r) => {
      const onErr = () => { okSrv.removeListener('listening', onOk2); r(false); };
      const onOk2 = () => { okSrv.removeListener('error', onErr); r(true); };
      okSrv.once('error', onErr);
      okSrv.once('listening', onOk2);
      okSrv.listen(p + 1, '127.0.0.1');
    });
    if (ok2) return { port: p, hang, okSrv };
    await new Promise((r) => { try { hang.close(r); } catch { r(); } });
  }
  return null;
};

try {
  /* ── 前置：文件必须存在，否则判检查器故障而不是"通过" ── */
  if (!fs.existsSync(SRC)) {
    console.error(`[检查器故障] 找不到 ${SRC}`);
    process.exit(2);
  }
  const src = fs.readFileSync(SRC, 'utf8');

  /* ── 先占一对空闲端口（并发安全：两个实例各拿各的）── */
  const bound = await bindPair();
  if (!bound) {
    console.error(`[检查器故障] 夹具段 ${PORT_MIN}–${PORT_MAX} 找不到一对相邻空闲端口`);
    process.exit(2);
  }
  const PORT = bound.port;
  srv = bound.hang;
  const okSrv = bound.okSrv;

  /* ── 在最小 window 环境里执行真实文件 ── */
  const win = { fetch: globalThis.fetch };
  const ww = new Function('window', src + '\n;return window.wwFetch;')(win);
  if (typeof ww !== 'function') {
    console.error('[检查器故障] fetch-timeout.js 没有导出 window.wwFetch');
    await cleanup();
    process.exit(2);
  }

  const URL = `http://127.0.0.1:${PORT}/`;
  const timed = async (make) => {
    const t0 = Date.now();
    try { await make(); return { ms: Date.now() - t0, name: '(未抛错)' }; }
    catch (e) { return { ms: Date.now() - t0, name: e.name, isTimeout: !!e.isTimeout }; }
  };
  const watchdog = (ms) => new Promise((_, rej) =>
    setTimeout(() => rej(Object.assign(new Error('watchdog'), { name: 'Watchdog' })), ms));

  /* 臂1 裸 fetch 无 signal：必须被看门狗兜住（证明"永不返回"真实存在） */
  const a1 = await timed(() => Promise.race([fetch(URL).then(() => 'returned'), watchdog(HANG_MS)]));
  arm('裸 fetch 无 signal 必须不返回',
    a1.name === 'Watchdog' && a1.ms >= HANG_MS - 1000,
    `${a1.ms}ms ${a1.name}`);

  /* 臂2 wwFetch 默认 8s：必须准时抛 TimeoutError 且 isTimeout=true
   * ★ 必须自带看门狗：若超时功能被破坏（DEFAULT_TIMEOUT=0），
   *   裸跑会一直挂到系统超时（实测 300 秒），让回归慢到不可用。
   *   有看门狗后：坏掉时 12 秒内报 Watchdog → 判红，且快。 */
  const a2 = await timed(() => Promise.race([ww(URL), watchdog(12000)]));
  const inRange = a2.ms >= 7500 && a2.ms <= 9000;
  arm('wwFetch 默认 8s 必须准时超时',
    a2.name === 'TimeoutError' && a2.isTimeout === true && inRange,
    `${a2.ms}ms ${a2.name} isTimeout=${a2.isTimeout}`);

  /* 臂3 wwFetch(timeout:0)：明确不要超时 → 必须不超时（看门狗兜住） */
  const a3 = await timed(() => Promise.race([ww(URL, { timeout: 0 }), watchdog(4000)]));
  arm('wwFetch(timeout:0) 必须不超时',
    a3.name === 'Watchdog',
    `${a3.ms}ms ${a3.name}`);

  /* 臂4 防误报：正常服务不得被超时误杀
   * ★ 必须用 http.createServer：裸 net 发 'ok' 不是合法 HTTP 响应，
   *   fetch 会抛 TypeError（我第一版就栽在这，被自己的负向臂抓到）。
   * okSrv 在 bindPair 里已经绑好（与挂起服务同一对相邻端口）。 */
  const a4 = await timed(() => ww(`http://127.0.0.1:${PORT + 1}/`).then((r) => r.json()));
  await new Promise((r) => okSrv.close(r));
  arm('防误报·正常响应不得超时', a4.name === '(未抛错)' && a4.ms < 2000, `${a4.ms}ms ${a4.name}`);
} catch (e) {
  console.error(`[检查器故障] ${e && (e.stack || e.message || e)}`);
  await cleanup();
  process.exit(2);
}

await cleanup();

const failed = arms.filter((a) => !a.pass);
if (AS_JSON) {
  console.log(JSON.stringify({ arms, failed: failed.length }, null, 2));
} else {
  for (const a of arms) console.log(`${a.pass ? '✅' : '❌'} ${a.name} :: ${a.detail}`);
  console.log(`\n臂完整性：${arms.length}/${arms.length}｜不合格 ${failed.length}`);
}
process.exit(failed.length ? 1 : 0);
