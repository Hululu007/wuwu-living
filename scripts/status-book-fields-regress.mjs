#!/usr/bin/env node
/* status-book-fields-regress.mjs —— 「跨端点同一份数据字段必须一致」的回归锁
 *
 * 为什么要有这一条（2026-11-22）：
 *   运维管家的 `check_xendpoint` 抓到：同一份 book 数据，两个端点字段集合不同。
 *     /api/book/info      → pending / stale / untrusted / dbOk / ageMs
 *     /api/status 的 book → pending / stale / ageMs      ← 缺 untrusted、缺 dbOk
 *
 *   缺口后果（真会发生的假空）：
 *     dbOk=false 且 TTL 未过期时，info 侧给 untrusted=true / stale=false / sources=null，
 *     而 status 侧 untrusted 丢失、stale=false ⇒ 前端 `五五客厅.html:902` 的
 *     `blank = pending ? … : (stale ? … : null)` 得到 null
 *     ⇒ `sourcesText` 落到 '0' ⇒ 首页显示「0 条书源」。
 *     这是「把没取到伪装成 0」的第三种假空，与 sources、groupTotal 同源。
 *
 *   **修完之后没有任何套件断言这件事**：全仓 grep `untrusted`，只有
 *   book-total-semantics-regress.mjs（只查 bookInfo 的三个兜底块，不含 appStatus）
 *   和 regress-all.mjs 的一句注释。⇒ 谁把 appStatus 那两行删了，19 套一套都不会红。
 *
 * 判据（只认「字段在不在」，不比对具体取值）：
 *   ① appStatus 的 book 返回块必须透出 untrusted
 *   ② appStatus 的 book 返回块必须透出 dbOk
 *   ③ 必须保留既有的 pending / stale / ageMs（防「补两个删三个」）
 *   ④ 负向自检：模拟删掉 untrusted 那行，判据必须报红（证明有区分力）
 *
 * 为什么不比对取值：
 *   info 与 status 是两次独立调用，取值时机不同（SWR 可能刚好在两次之间刷新），
 *   比对数值必然假红。字段存在性才是稳定判据。
 *
 * 用法：node scripts/status-book-fields-regress.mjs [--json]
 * 退出码：0 全过 / 1 有断言不合格 / 2 检查器故障
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const HUB = path.join(ROOT, 'hub.mjs');
const AS_JSON = process.argv.includes('--json');

if (!fs.existsSync(HUB)) {
  console.error(`[检查器故障] 找不到 ${HUB}`);
  process.exit(2);
}

const src = fs.readFileSync(HUB, 'utf8');

/* 定位 appStatus 里 book 的返回块。
 * 锚点用「stats: { sources: b.sources」这一行 —— 它只在这个块里出现，
 * 比按函数名截取更精确（appStatus 里还有 magnet/music/vod 等其它分支）。 */
function extractBookBlock(text) {
  const anchor = text.indexOf('stats: {');
  // 找到包含 groups: b.groupTotal 的那个 stats 块
  const marker = 'groups: b.groupTotal';
  const gi = text.indexOf(marker);
  if (gi < 0) return null;
  // 向前找到该 return 块的起点
  const start = text.lastIndexOf('return {', gi);
  if (start < 0) return null;
  // 向后找到配平的 }
  let depth = 0, started = false;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') { started = true; depth++; }
    else if (text[i] === '}') { depth--; if (started && depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

const block = extractBookBlock(src);
if (!block) {
  console.error('[检查器故障] 定位不到 appStatus 的 book 返回块（源码结构变了，需更新锚点）');
  process.exit(2);
}

/* ★ 2026-11-23 扩展：端点对清单不再只覆盖 book 一处（后端管家遗留）。
 * appStatus 的其它分支（magnet/music/vod 共用的 web 块）与 allStatus 的
 * roomApps 块也是手写返回块，同样会发生「补 A 删 B」「分支间字段漂移」。
 * 判据仍只认「字段在不在」：
 *   ① 每个状态块必须有公共基字段 id/name/kind/action/path
 *      （前端五五客厅.html 按 id 索引、按 kind 分流、按 path 拼入口，
 *        少任何一个都会让该条状态在首页静默消失或渲染错栏）
 *   ② web 块（magnet/music/vod 共用）必须有连接层四件套
 *      running/latency/degraded/busy —— degraded 缺失会退回「把探不到
 *      说成已停止」的静默失败（S4 修过的同一类病）
 *   ③ roomApps 块必须有 running/ready/busy/stats
 *   ④ 负向自检 ×2：删掉 book 的 untrusted、删掉 web 的 degraded，判据必须报红 */
function extractBlockByAnchor(text, anchor) {
  const ai = text.indexOf(anchor);
  if (ai < 0) return null;
  const start = text.lastIndexOf('return {', ai);
  if (start < 0) return null;
  let depth = 0, started = false;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') { started = true; depth++; }
    else if (text[i] === '}') { depth--; if (started && depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}

const webBlock = extractBlockByAnchor(src, 'retryInMs: p.retryInMs');
const roomBlock = extractBlockByAnchor(src, 'running: !!s.ready');

const arms = [];
const arm = (name, pass, detail) => arms.push({ name, pass: !!pass, detail });

/* 字段判法：token 后跟 `:`（正常键值）或 `,`（ES6 简写属性，如 `id,`）。
 * 不能只认 `\bk\s*:`——会漏掉简写；也不能裸 `\bk\b`——会把注释里提到的词当字段。 */
const fieldRe = (k) => new RegExp(`\\b${k}\\b\\s*[,:]`);
const has = (k) => fieldRe(k).test(block);
const blockHas = (blk, k) => !!blk && fieldRe(k).test(blk);

arm('appStatus 的 book 块必须透出 untrusted', has('untrusted'),
  has('untrusted') ? '已透出' : '缺失 → 首页会把 untrusted 状态当正常，显示「0 条书源」');
arm('appStatus 的 book 块必须透出 dbOk', has('dbOk'),
  has('dbOk') ? '已透出' : '缺失 → 跨端点字段集合不一致');
arm('必须保留既有三态字段 pending/stale/ageMs', has('pending') && has('stale') && has('ageMs'),
  `pending=${has('pending')} stale=${has('stale')} ageMs=${has('ageMs')}`);

/* 公共基字段：三个状态块各查一遍 */
const BASE = ['id', 'name', 'kind', 'action', 'path'];
for (const [label, blk] of [['book', block], ['web(magnet/music/vod)', webBlock], ['roomApps', roomBlock]]) {
  if (!blk) { arm(`公共基字段 ${label} 块可定位`, false, '锚点失效（源码结构变了，需更新）'); continue; }
  const miss = BASE.filter((k) => !blockHas(blk, k));
  arm(`公共基字段 id/name/kind/action/path · ${label}`, miss.length === 0,
    miss.length ? `缺 ${miss.join('/')} → 该条状态在首页静默消失或渲染错栏` : '齐');
}

/* web 块连接层四件套 */
if (webBlock) {
  const missW = ['running', 'latency', 'degraded', 'busy'].filter((k) => !blockHas(webBlock, k));
  arm('web 块必须透出 running/latency/degraded/busy', missW.length === 0,
    missW.length ? `缺 ${missW.join('/')} → degraded 丢失会退回「把探不到说成已停止」` : '齐');
} else {
  arm('web 块必须透出 running/latency/degraded/busy', false, '锚点失效');
}

/* roomApps 块 */
if (roomBlock) {
  const missR = ['running', 'ready', 'busy', 'stats'].filter((k) => !blockHas(roomBlock, k));
  arm('roomApps 块必须透出 running/ready/busy/stats', missR.length === 0,
    missR.length ? `缺 ${missR.join('/')} → 房间可用性在首页退化为「—」` : '齐');
} else {
  arm('roomApps 块必须透出 running/ready/busy/stats', false, '锚点失效');
}

/* 负向自检 ×2：把判据针对的字段从块里删掉，判据必须能报出来。
 * 这是「证明断言有区分力」的关键一步 —— 只测正向无法排除「判据永远为真」。 */
const brokenBlock = block.replace(/^\s*untrusted\s*:[^\n]*\n/m, '');
const brokenHas = /\buntrusted\s*:/.test(brokenBlock);
arm('负向自检：删掉 untrusted 行时臂1 必须报红', !brokenHas,
  brokenHas ? '模拟破坏后仍判定有 untrusted —— 断言无区分力' : '模拟破坏后正确判定缺失 —— 判据有效');

const brokenWeb = webBlock ? webBlock.replace(/^\s*degraded\s*:[^\n]*\n/m, '') : null;
const brokenWebHas = brokenWeb ? /\bdegraded\s*:/.test(brokenWeb) : true;
arm('负向自检：删掉 web 块 degraded 行时四件套臂必须报红', webBlock && !brokenWebHas,
  !webBlock ? 'web 块未定位' : (brokenWebHas ? '模拟破坏后仍判定有 degraded —— 断言无区分力' : '模拟破坏后正确判定缺失 —— 判据有效'));

const failed = arms.filter((a) => !a.pass);
if (AS_JSON) {
  console.log(JSON.stringify({ arms, failed: failed.length }, null, 2));
} else {
  for (const a of arms) console.log(`${a.pass ? '✅' : '❌'} ${a.name} :: ${a.detail}`);
  console.log(`\n臂完整性：${arms.length}/${arms.length}｜不合格 ${failed.length}`);
}
process.exit(failed.length ? 1 : 0);
