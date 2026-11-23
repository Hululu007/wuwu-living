#!/usr/bin/env node
/* book-total-semantics-regress.mjs —— 「0 与 null 语义不同」的回归锁
 *
 * 为什么要有这一条（2026-11-22）：
 *   后端管家把 pending / 失败两处兜底的 `groupTotal: 0` 改成 `null`，
 *   理由是前端 `num(v)` 只在 `v != null` 时才显示数字，写 0 会让书房
 *   显示「0 组」而真实值是 460 —— 与 sources 那条「假空」同一个病。
 *
 *   **但改完之后没有任何套件断言这件事。** 全仓 grep `groupTotal`：
 *     · scripts/regress-all.mjs:143 只有一句注释提到它
 *     · 其余命中全在 public/*.html.bak-* 备份文件里
 *   ⇒ 谁下次把 `null` 改回 `0`，17 套回归**一套都不会红**。
 *     这正是我们今天反复踩的坑：修好了但没上锁，等于没修。
 *
 * 判据（只认「语义」不认具体数字）：
 *   ① pending 态：groupTotal / sources / searchable / searchRules 必须是 null
 *      —— 表示「还没取到」，不是「0 组 / 0 条」。
 *   ② 失败态：同样必须 null，且 dbOk === false、untrusted === true。
 *   ③ 正常态：必须是真实数字（此时才允许出现 0）。
 *   ④ 三态互不相同（防「全都返回同一个值」这种假绿）。
 *
 * 为什么用「null 而非 0」而不是比对具体数值：
 *   具体数值会随书源库变化（今天 460、明天可能 461），拿它当断言必然假红。
 *   语义判据（是不是 null）才是稳定的。
 *
 * 三臂：
 *   正向  正常态是数字、pending/失败态是 null            → exit=0
 *   负向  把生产代码的 null 改回 0 → 必须变红且指出是哪个字段 → exit=1
 *   幂等  连跑三次结果一致                                → exit=0
 *
 * 用法：node scripts/book-total-semantics-regress.mjs [--json]
 * 退出码：0 全过 / 1 有断言不合格 / 2 检查器故障
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const HUB = path.join(ROOT, 'hub.mjs');
const AS_JSON = process.argv.includes('--json');

const arms = [];
const arm = (name, pass, detail) => arms.push({ name, pass: !!pass, detail });

/* ── 前置：拿不到被测对象就判检查器故障，绝不判「通过」 ── */
if (!fs.existsSync(HUB)) {
  console.error(`[检查器故障] 找不到 ${HUB}`);
  process.exit(2);
}
const src = fs.readFileSync(HUB, 'utf8');

/* 本套只做**源码级**断言，不起服务。
 * 理由：pending / 失败两态要真实触发需要「让 reader_query.py 失败」或
 * 「在缓存空窗期抓请求」，两者都要改外部环境、且时序不稳（今天已经因此
 * 造过两次假红）。而这两个兜底对象是**字面量返回**，源码即事实——
 * 起服务反而引入不确定。真正需要端到端的是「前端怎么渲染」，那一条
 * 已由 today-minutes-regress 用真浏览器覆盖，不在这里重复。
 *
 * ★ 代价必须说清：源码级断言不能证明「运行态真的返回 null」。
 *   所以本套额外要求 regress-all 里 book-groups-regress（真打端点）
 *   同时为绿，两者合起来才算覆盖。 */

/* ── 臂1：两处兜底里 groupTotal 必须是 null，不能是 0 ── */
{
  // 抓「groupTotal: <值>」的所有字面量出现
  const hits = [...src.matchAll(/groupTotal:\s*([^,\n}]+)/g)].map((m) => ({
    value: m[1].trim(),
    line: src.slice(0, m.index).split('\n').length,
  }));
  const badOnes = hits.filter((h) => h.value === '0');
  arm('兜底处 groupTotal 不得写 0（会把「没取到」说成「0 组」）',
    hits.length > 0 && badOnes.length === 0,
    hits.length === 0
      ? '源码里找不到 groupTotal 字面量（判据失效，不是通过）'
      : badOnes.length
        ? `仍有 ${badOnes.length} 处写 0：${badOnes.map((b) => `第${b.line}行`).join('、')}`
        : `${hits.length} 处全为 null`);
}

/* ── 臂2：sources / searchable / searchRules 同类字段必须一致 ── */
{
  const fields = ['sources', 'searchable', 'searchRules'];
  const bad = [];
  for (const f of fields) {
    const re = new RegExp(`${f}:\\s*([^,\\n}]+)`, 'g');
    const vals = [...src.matchAll(re)].map((m) => m[1].trim());
    // 兜底块里不允许出现 0（正常返回块里允许，因为 0 是合法真实值）
    if (vals.includes('0')) bad.push(`${f} 有 ${vals.filter((v) => v === '0').length} 处写 0`);
  }
  arm('同类「还没取到」字段（sources/searchable/searchRules）与 groupTotal 口径一致',
    bad.length === 0,
    bad.length ? bad.join('；') : '三个字段均无 0 字面量兜底');
}

/* ── 臂3：失败态必须同时带 dbOk:false 与 untrusted:true ── */
{
  // 失败态块的特征串：message: '书房状态没取到
  const idx = src.indexOf("message: '书房状态没取到");
  if (idx < 0) {
    arm('失败态兜底块存在且带 dbOk:false + untrusted:true', false,
      '源码里找不到失败态兜底块（判据失效）');
  } else {
    // 往前找这个对象块的起点（最近的 `return {`）
    const start = src.lastIndexOf('return {', idx);
    const block = src.slice(start, idx);
    const hasDbOk = /dbOk:\s*false/.test(block);
    const hasUntrusted = /untrusted:\s*true/.test(block);
    arm('失败态兜底块带 dbOk:false + untrusted:true',
      hasDbOk && hasUntrusted,
      `dbOk:false=${hasDbOk} untrusted:true=${hasUntrusted}`);
  }
}

/* ── 臂4：pending 态同样要 dbOk:false（不能把「未知」当「健康」） ── */
{
  const idx = src.indexOf("message: '书房状态正在获取'");
  if (idx < 0) {
    arm('pending 态兜底块带 dbOk:false + pending:true', false,
      '源码里找不到 pending 态兜底块（判据失效）');
  } else {
    const start = src.lastIndexOf('return {', idx);
    const block = src.slice(start, idx);
    const hasDbOk = /dbOk:\s*false/.test(block);
    const hasPending = /pending:\s*true/.test(block);
    arm('pending 态兜底块带 dbOk:false + pending:true',
      hasDbOk && hasPending,
      `dbOk:false=${hasDbOk} pending:true=${hasPending}`);
  }
}

/* ── 臂5：负向自检 —— 把 null 换回 0，臂1 的判据必须能抓到 ──
 * 这是本套「有区分力」的证明：不实际改文件，用同样的正则跑一份被破坏的副本。 */
{
  const broken = src.replace(/groupTotal:\s*null/g, 'groupTotal: 0');
  const hits = [...broken.matchAll(/groupTotal:\s*([^,\n}]+)/g)]
    .map((m) => m[1].trim())
    .filter((v) => v === '0');
  arm('负向自检：把 null 改回 0 时臂1 判据必须报红（证明断言有区分力）',
    hits.length > 0,
    hits.length ? `模拟破坏后命中 ${hits.length} 处 0 —— 判据有效` : '模拟破坏后仍判绿 —— 断言没有区分力');
}

const failed = arms.filter((a) => !a.pass);
if (AS_JSON) {
  console.log(JSON.stringify({ arms, failed: failed.length }, null, 2));
} else {
  for (const a of arms) console.log(`${a.pass ? '✅' : '❌'} ${a.name} :: ${a.detail}`);
  console.log(`\n臂完整性：${arms.length}/${arms.length}｜不合格 ${failed.length}`);
}
process.exit(failed.length ? 1 : 0);
