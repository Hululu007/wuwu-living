#!/usr/bin/env node
/**
 * 一把跑完所有回归。任何一条失败都以非 0 退出。
 * 用法：node scripts/regress-all.mjs
 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
/* ★ 2026-11-22 回归运行锁：
 *   实测两次假红都因为「回归在跑、同时有人重启 8890」——
 *   toast-behavior 报 library「window.toast 未加载」、整轮 fetch failed，
 *   而稳定后单跑 8/8 全过。锁的作用是让重启方知道现在别动。
 *   锁文件带 pid 与开始时刻；进程退出时删除（含异常退出）。 */
const LOCK = path.join(ROOT, 'runtime', 'regress.lock');

/* ★★ 2026-11-22 加 `--wait-lock=秒`（本轮实测倒逼出来的）：
 *   本机多个管家会各自跑整套回归。没有这个参数时，只要别人在跑，
 *   自己就立刻 exit 3 —— 实测 21:15 那一轮，我等了 100 秒锁刚释放，
 *   自己的进程刚起来，另一个管家的新一轮又抢先拿到锁，于是又 exit 3。
 *   反复十几次都跑不完整套，**这不是缺陷，是缺一个排队能力**。
 *   语义：
 *     --wait-lock=0（默认）→ 立刻 exit 3，保持原行为（适合 CI / 手动探活）
 *     --wait-lock=N        → 最多排队 N 秒，每 5 秒打一行心跳（与 probe-lock 一致，
 *                            心跳是为了让外层「空闲超时」能区分「排队」与「卡死」）
 *   排队期间**不持锁**，只是重试 takeLock。 */
const WAIT_LOCK_S = Number((process.argv.slice(2)
  .find((a) => a.startsWith('--wait-lock=')) || '--wait-lock=0').slice('--wait-lock='.length)) || 0;

const lockWaitStart = Date.now();
function takeLock() {
  // ★★ 2026-11-22 修「并发取锁互相覆盖」（真缺陷）：
  //   原写法是「existsSync → read → 判活 → writeFileSync」四步，
  //   两个进程可以**同时通过检查**，后写的把先写的覆盖掉。
  //   实测后果（2026-11-22 19:51 那轮）：我这个 regress-all 持锁跑着，
  //   另一个 regress-all 把锁覆盖成它自己的 pid，于是我的子套
  //   拿到的锁里写的是**别人的 pid** → 判成「别人在跑」→ 7 套 FAULT。
  //   修法：用 `wx`（O_CREAT|O_EXCL）原子创建——只有一个能成功；
  //   只有在「已存在且持有者已死」时才先 unlink 再重试。
  try {
    fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  } catch {}
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(LOCK, 'wx');   // 原子：已存在就抛 EEXIST
      fs.writeSync(fd, `pid=${process.pid} started=${new Date().toISOString()} suites=${suites.length}\n`);
      fs.closeSync(fd);
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') return;     // 锁失败不阻断回归本身
      let raw = '';
      try { raw = fs.readFileSync(LOCK, 'utf8').trim(); } catch { continue; }
      const pid = Number((raw.match(/pid=(\d+)/) || [])[1]);
      let alive = false;
      if (pid) {
        try { process.kill(pid, 0); alive = true; }
        catch (e) {
          // ★ 2026-11-22：`kill(pid,0)` 抛错不等于进程不存在。
          //   EPERM = 进程在、但无权发信号 —— 它是活的，锁有效，必须拒绝启动。
          //   原实现把 EPERM 当「已死」，会覆盖别人的活锁（互斥失效）。
          alive = (e && e.code === 'EPERM');
        }
      }
      if (alive) {
        if (WAIT_LOCK_S > 0) {
          const waited = Math.round((Date.now() - lockWaitStart) / 1000);
          if (waited < WAIT_LOCK_S) {
            if (waited === 0 || waited % 5 === 0) {
              console.error(`[等待锁] 另一个回归正在跑（pid=${pid}）→ 排队中，已等 ${waited} 秒 / 上限 ${WAIT_LOCK_S} 秒`);
            }
            try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); } catch {}
            attempt--;           // 排队不算消耗重试次数
            continue;
          }
          console.error(`[拒绝启动] 已排队 ${WAIT_LOCK_S} 秒仍未拿到锁（持有者 pid=${pid}）→ 本次结论不可用`);
          process.exit(3);
        }
        console.error(`[拒绝启动] 另一个回归正在跑（${raw}）。`);
        console.error(`  若确认它已死：rm -f ${LOCK}`);
        console.error(`  想排队等它：加 --wait-lock=300`);
        process.exit(3);
      }
      // 陈旧锁：先删再重试（并发场景下可能删失败，下一轮再试）
      try { fs.unlinkSync(LOCK); } catch {}
    }
  }
}
function releaseLock() {
  try {
    if (!fs.existsSync(LOCK)) return;
    const raw = fs.readFileSync(LOCK, 'utf8');
    if (raw.includes(`pid=${process.pid}`)) fs.unlinkSync(LOCK);
  } catch { /* ignore */ }
}
process.on('exit', releaseLock);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { releaseLock(); process.exit(130); });
const suites = [
  ['HTTP 契约（Range / HEAD / 请求体）', 'http-contract-regress.mjs'],
  ['JSON 落盘（原子写 / 读坏备份 / 串行化）', 'json-store-regress.mjs'],
  ['内容模块（笔记 / 待办 / 追更）', 'content-regress.mjs'],
  ['书房搜索（调度 / 取消 / 引擎流）', 'book-regress.mjs'],
  ['实例锁 / runtime 目录（跨进程互斥）', 'instance-lock-regress.mjs'],
  ['图片缓存（原子落盘 / 不留坏缓存）', 'img-cache-regress.mjs'],
  ['重复入口（一个语义一个可见控件）', 'dup-entry-regress.mjs'],
  // ★ 2026-11-22 新增：toast 行为回归。
  //   S6 把 8 份实现收敛成 assets/toast.js 之后，「失败常驻、成功自动消失」
  //   这个语义只存在于共享文件里，一旦改坏没有任何源码级判据能发现 ——
  //   必须用真浏览器量。探针自带负向臂（--arm=neg 时换坏实现必须报红）。
  // ★ 2026-11-22 新增：请求超时回归。
  //   总管实测定性：后端「accept 后不回包」时，无 signal 的 fetch 永不返回，
  //   页面永远停在加载中。而 wwFetch 存在 ≠ 生效 —— 它自己曾因内部调全局 fetch
  //   无限递归，所有请求 18ms 抛 RangeError，比不加超时更糟。
  //   ⇒ 必须端到端：真起挂起服务、真跑 fetch-timeout.js、量真实毫秒。
  //   四臂：裸 fetch 必须不返回 / wwFetch 必须 8s 准时超时 / timeout:0 必须不超时 / 正常响应不得误杀。
  //   ★ 约 24 秒：臂1 与臂3 靠看门狗兜底，这是「证明它不返回」的必要代价。
  ['请求超时（无 signal 永不返回 / 8s 准时 abort）', 'fetch-timeout-regress.mjs'],
  ['提示条行为（失败常驻 / 点击关闭 / 成功消失）', 'toast-behavior-regress.mjs'],
  // ★ 2026-11-22 新增：加载态回归。
  //   源码级判据只能证明「页面里有 .loading 类名」，证明不了「请求挂起时真的画出来」。
  //   实测投屏页就栽在这：骨架写在 refresh() 里，而 boot 先 await presets，
  //   探针把 presets 挂起时页面整段空白 —— 光看源码会误判成已修好。
  ['加载态（请求挂起时骨架可见、放行后撤掉）', 'loading-state-regress.mjs'],
  // ★ 2026-11-22 新增：三态视觉区分回归（S1）。
  //   源码里写了 class="empty error" 不等于「用户分得出」——
  //   探针在真页面里并排造出空态/出错态，量计算样式并做去色测试：
  //   只有颜色不同、结构性差异为 0 时必须报红（色盲与灰度打印会失效）。
  ['三态视觉区分（空/出错去色后仍可分）', 'state-visual-regress.mjs'],
  // ★ 2026-11-22 新增：语义色回归锁。
  //   为什么必须锁：--warn/--danger 一天内漂移两版（#d99a2b→#cab549、#d92d20→#de4217），
  //   没有任何判据阻止。这次改后恰好仍合格纯属运气 —— 下次改回「与房色撞色」的值，
  //   所有功能判据仍全绿，但用户分不清「某房间的警告」和「书房的品牌色」。
  //   判据是 ΔE76 ≥ 10（感知可分），不是「值不相等」；另查内联 rgba 是否抄歪。
  ['语义色可分（ΔE≥10 且内联不抄歪）', 'semantic-color-regress.mjs'],
  // ★ 2026-11-22 新增：快照页清单完整性。
  //   首页/书房是启动期读入内存的快照页，改了不重启不生效；判据是 /api/ping 的 stalePages。
  //   但**清单本身可能漏**：第三页改成快照却忘了登记，ping 会永远说「一致」，
  //   那一页改了不生效而所有判据全绿。这条比对「清单 / 明细 / 源码启动期读页数」三者。
  ['快照页清单完整（清单=明细=源码读页数）', 'snapshot-pages-regress.mjs'],
  // ★ 2026-11-22 新增：失败提示不能长得像成功（A/B 五处）。
  //   为什么单独立一套：toast-behavior-regress 测的是 toast.js 自身的语义，
  //   测不到「调用方传错了 kind」。实测 3 处失败走单参 toast() → 与成功同 class、
  //   同 2400ms 自动消失，用户看到「启动没成功」却以为是好消息。
  //   本套在真页面注入失败响应、点真按钮，量 className 与 3 秒后是否仍为 err。
  ['失败提示不走成功样式（A/B 五处）', 'toast-err-e2e.mjs'],
  // ★ 2026-11-22 新增：tone 三态必须真能区分。
  //   为什么单独立一套：契约 Rev2 要求 tone = error/success/info，
  //   但 normalize() 原本**没有 info 分支** —— 传 'info' 落到默认 ''，
  //   与「不传 tone」完全同色，等于「改了跟没改一样」。
  //   本套在真页面依次发 info/good/err，量边框色三者互不相同，
  //   且 info 不带「点此关闭」、err 必须带。
  ['tone 三态可区分（info/good/err 边框互不相同）', 'toast-tone-regress.mjs'],
  // ★ 2026-11-22 新增：契约 Rev3 的四维区分（符号 / 边框虚实 / 边框粗细 / 无 emoji）。
  //   为什么必须在**真浏览器**里量：设计侧的量具 toast-contrast.py 解析的是 CSS 文本，
  //   它读到的是转义原文 `\\2713` / `\\00B7`，无法证明浏览器真的把这些转义渲染成了
  //   ✓ 和 ·。实测两者都能渲染，但「量具读到转义」和「用户看到字形」是两件事 ——
  //   本套用 getComputedStyle(t,'::before').content 取浏览器解析后的真实字形，
  //   并顺带断言 textContent 不会冲掉 ::before（Rev3 假设，必须验）。
  ['三态符号四维区分（·/✓/! 真渲染 + 边框虚实粗细）', 'toast-symbol-regress.mjs'],
  // ★ 2026-11-22 新增：书房「书源库」弹窗必须真能拉到分组。
  //   起因：后端把分组明细从 /api/book/info 挪到 /api/book/groups 后，
  //   前端仍读 info.groups（实测已变 undefined），于是 chips 全空 +
  //   首屏拼出 ?group= 返回空列表 —— 用户看到「空分组 + 空列表」，像正常。
  //   判据：点开弹窗后 chips > 0、确实发了 /api/book/groups、首屏列表非空、
  //   且首屏 URL 不带空 group 参数。
  ['书源库弹窗（分组按需拉 + chips 非空）', 'book-groups-regress.mjs'],
  // ★ 2026-11-22 新增：首页「在读」格的 todayMinutes 三态。
  //   起因：`rd.todayMinutes || 0` 把 null 也变成 0，于是「还没取到」被写成
  //   「今天 0 分钟」—— 用户读到的是「今天没读书」。这与后端那条
  //   `groupTotal: 0` 是同一个病（假空），不同的是它在前端渲染层。
  //   判据：真 0 / null / 42 三种输入必须渲染出**三种不同**文案。
  ['在读时长三态（真 0 / — / 42 互异）', 'today-minutes-regress.mjs'],
  // ★ 2026-11-22 新增：`groupTotal: 0 → null` 那处修复的回归锁。
  //   起因：后端管家改了 pending / 失败两处兜底，但**全仓没有一套断言它**——
  //   grep `groupTotal` 在 scripts/ 下只命中一句注释，其余全是 *.html.bak-* 备份。
  //   即「谁把它改回 0，17 套回归一套都不会红」。
  //   判据：兜底处 groupTotal / sources / searchable / searchRules 必须是 null；
  //   失败态带 dbOk:false+untrusted:true；pending 态带 dbOk:false+pending:true；
  //   并自带一条负向自检（把 null 换回 0 时判据必须报红）。
  ['书源统计语义（没取到必须是 null，不是 0）', 'book-total-semantics-regress.mjs'],
  // ★ 2026-11-22 新增：跨端点同一份数据字段必须一致。
  //   appStatus 的 book 块曾漏掉 untrusted/dbOk，导致 dbOk=false 且 TTL 未过期时
  //   首页把「没取到」渲染成「0 条书源」（第三种假空）。判据只查字段存在性，不比取值。
  ['跨端点字段一致（status 的 book 必须透出 untrusted/dbOk）', 'status-book-fields-regress.mjs'],
  // ★ 2026-11-23 新增：消息回看（S8 契约判据 1–6）。
  //   这是设计管家指出的最后一条真缺口：「失败提示常驻可点关，但点掉即永久丢失」。
  //   源码级判据只能证明 history() 函数存在，证明不了「点完关闭之后还读得到」。
  //   探针真点关闭再读，自带负向臂（--arm=neg 换成"关闭即删记录"必须报红）。
  ['消息回看（关闭浮层不删记录 / 10 秒后可读 / 同错去重）', 'notify-history-regress.mjs'],
  // ★ 2026-11-23 新增：搜书「失败不许伪装成没结果」。
  //   线上实测第二次搜书 61ms 收尾、报「0 本 / 0 源」，日志却是 searchd fetch failed；
  //   回落目标（本地引擎）当时 0 源，仍走成功收尾 ⇒ 与「真的没有这本书」同形。
  //   三臂：①不通+0源必须 error（旧实现是 done/0，负向臂已实测报红）
  //        ②mock searchd 正常必须 done 且有结果（证明不是见 job 就判红）
  //        ③本地原始书源可自愈重建（searchRules>0 且 full cache 落盘）
  ['搜书失败语义（不通不许报 0 本 + 本地源自愈）', 'book-search-fallback-regress.mjs'],
];

/* ★ 2026-11-22 加子进程超时兜底（后端管家指出 close vs exit 的隐患）：
 *   'close' 要等 stdio 全部关闭；若子套有未清的定时器/浏览器句柄，
 *   'close' 可能迟迟不触发，把「跑完了」拖成「卡住」——整个回归无限挂起。
 *   实测 regress-all 全程 100–130 秒，其中 toast/loading 两套各占 30–40 秒，
 *   一旦某套泄漏一个 timer，后面所有套件都等不到。
 *   策略：
 *     · 每套默认 180 秒上限（最长单套实测 42 秒，留 4 倍余量）；
 *     · 超时 → SIGKILL 子进程，并判 **exit=2 检查器故障**，不判产品失败；
 *     · 一旦 'close' 或 'exit' 任一先到就落定，避免重复 resolve。 */
const SUITE_TIMEOUT_MS = Number(process.env.REGRESS_SUITE_TIMEOUT_MS || 180000);

const runOne = (file) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(HERE, file)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let settled = false;
  let killedByTimeout = false;
  const finish = (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    // 超时被杀：判检查器故障(2)，不判产品失败(1)
    resolve({ code: killedByTimeout ? 2 : code, out, timedOut: killedByTimeout });
  };
  /* ★★ 2026-11-22 修「等锁被算成超时」（我自己引入的缺陷）：
   *
   *   加了 probe-lock 之后，子探针可能**排队等锁**（别的探针在跑）。
   *   原来这里是一个固定的 180 秒总超时，等锁时间也算在里面 ——
   *   实测 2026-11-22 20:16：toast-tone 正常只需 4 秒，却在 180003ms 被杀，
   *   因为它一直在等另一个探针放锁。日志里表现为「子套超时」，
   *   看起来像产品卡死，实际是排队。
   *
   *   修法：改成**空闲超时**——只要子进程还在往 stdout/stderr 写东西，
   *   就说明它活着（等锁时 probe-lock 每 500ms 会打一行「排队等待」），
   *   计时器随之重置。真正卡死（一句话都不说）才判超时。
   *   这同时修掉了另一个隐患：慢但正常的套件不会被误杀。
   */
  let timer = null;
  const armTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      killedByTimeout = true;
      out += `\n[回归框架] 子套 ${file} 已 ${SUITE_TIMEOUT_MS}ms 没有任何输出 → 判定卡死，SIGKILL（检查器故障，不是产品失败）\n`;
      try { child.kill('SIGKILL'); } catch {}
      finish(null);
    }, SUITE_TIMEOUT_MS);
  };
  armTimer();
  child.stdout.on('data', (d) => { out += d.toString(); armTimer(); });
  child.stderr.on('data', (d) => { out += d.toString(); armTimer(); });
  child.on('close', finish);
  child.on('exit', (code) => { if (killedByTimeout) finish(code); });
});

takeLock();

let passed = 0;
let failed = 0;
let faults = 0;
/* ★★ 2026-11-22 加「锁归属校验」——本轮自己的测量事故倒逼出来的：
 *
 *   我用 `(sleep 3; rm -f runtime/regress.lock) &` 做「排队臂」时，
 *   那个后台 rm 在我已经拿到锁**之后**才触发，把我自己的锁删了。
 *   于是另一轮 regress-all 立刻占锁，我的后续子探针拿到的是**别人的 pid**，
 *   判成「环境冲突」→ 20 套里 3 套 FAULT。
 *
 *   原来框架对此完全无感：它只在**开头** takeLock 一次，之后再不检查，
 *   子套报上来的「另一个回归正在跑」被当成正常环境冲突记进 faults。
 *   结论看起来像「环境不好」，真相是「我自己的锁被删了」。
 *
 *   修法：每套开始前核对锁归属。
 *     · 锁不见了，或被写成别人的 pid → 标记 lockLost，**后面全部不再采信**；
 *     · 结尾把它当「本次结论不可用」单列，不混进产品失败、也不报绿。
 *   这一条同时能抓「别人手滑 rm 了锁」与「我的测试脚本自己删锁」两种情形。 */
let lockLost = false;
const checkLockOwnership = () => {
  try {
    const raw = fs.readFileSync(LOCK, 'utf8').trim();
    const pid = Number((raw.match(/pid=(\d+)/) || [])[1]);
    if (pid !== process.pid) { lockLost = true; return false; }
    return true;
  } catch { lockLost = true; return false; }
};

for (const [name, file] of suites) {
  if (!lockLost && !checkLockOwnership()) {
    console.error(`\n[锁丢失] 本进程的锁已被删除或被他人覆盖（期望 pid=${process.pid}）→ 后续结论不可采信`);
    console.error('  常见原因：有人手动 rm 了锁、或测试脚本自己删锁、或另一轮回归强制覆盖。');
  }
  const t0 = Date.now();
  const { code, out } = await runOne(file);
  const ms = Date.now() - t0;
  const tail = out.trim().split('\n').filter(Boolean).slice(-1)[0] || '';
  /* ★★ 2026-11-22 修「假绿」——这是本文件最严重的一个缺陷，原样保留说明防复发：
   *
   *   原实现只有两个分支：`code === 0` 打印 PASS，`code === 2` 计 faults，
   *   **退出码 1（子套真的失败了）没有任何分支** —— 既不打印、也不计入 failed。
   *   后果：任何一套真的红了，日志里只是**少一行 PASS**，末尾照样打印
   *   「全部 16 套通过」，`process.exitCode` 保持 0。
   *
   *   实测证据（2026-11-22 19:41 那轮）：登记 17 套，日志里只有 11 行 PASS，
   *   末尾却写「全部 16 套通过」，退出码 0。差的 6 套里就有真失败。
   *   这正是产品管家今天反复报的「登记 13 套只跑 7 套仍报全部通过」的**真正根因**
   *   —— 不是「被跳过没跑」，而是「跑了、红了、被吞了」。
   *
   *   现在：每个非 0 码都必须落到一个显式分支，且**数量必须对得上**
   *   （passed + failed + faults === suites.length），否则本身算框架故障。 */
  if (code === 0) {
    passed++;
    console.log(`PASS ${name}  (${ms}ms)  ${tail}`);
  } else if (code === 2) {
    // 检查器故障（含子套超时被杀）——不算产品失败，但要单独计数并让最终退出码非 0
    faults++;
    console.error(`FAULT ${name}  (${ms}ms)  ← 检查器故障/超时，不是产品缺陷`);
    console.error(out.trim().split('\n').slice(-25).map((l) => '  ' + l).join('\n'));
  } else if (code === 3) {
    // 子套因「别人正在跑」而拒绝启动（probe-lock 的 exit 3）——结论不可用
    faults++;
    console.error(`FAULT ${name}  (${ms}ms)  ← 环境冲突（另有回归在跑），本次结论不可用`);
    console.error(out.trim().split('\n').slice(-8).map((l) => '  ' + l).join('\n'));
  } else {
    // ★ 退出码 1（以及任何其它非 0）：这是**真的产品失败**，必须报红。
    failed++;
    console.error(`FAIL ${name}  (${ms}ms)  exit=${code}`);
    const lines = out.trim().split('\n').filter(Boolean);
    console.error(lines.slice(-25).map((l) => '  ' + l).join('\n'));
  }
}

const total = suites.length;
const accounted = passed + failed + faults;
if (lockLost) {
  console.error(`\n通过 ${passed} / 失败 ${failed} / 故障 ${faults}（登记 ${total} 套）`);
  console.error('[结论不可用] 运行期间锁被删除/覆盖 —— 本次不采信（既不是产品失败，也不是通过）');
  releaseLock();
  process.exit(4);   // 顶层不能用 return，直接以 4 退出（不可采信，与 0/1/2/3 都不同）
}
console.log(`\n通过 ${passed} / 失败 ${failed} / 故障 ${faults}（登记 ${total} 套）`);
if (accounted !== total) {
  // 记账不平 = 框架自身有问题，绝不能报绿
  console.error(`[框架故障] 记账不平：通过${passed}+失败${failed}+故障${faults}=${accounted}，但登记 ${total} 套`);
  releaseLock();
  process.exitCode = 2;
} else if (failed || faults) {
  console.error(failed ? `\n${failed} 套失败` : `\n${faults} 套检查器故障`);
  releaseLock();
  process.exitCode = failed ? 1 : 2;
} else {
  console.log(`\n全部 ${total} 套通过`);
  releaseLock();
}
