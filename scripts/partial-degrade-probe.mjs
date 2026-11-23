#!/usr/bin/env node
/**
 * 部分降级（partial degradation）判据 —— 产品管家定，2026-11-22
 *
 * 背景：
 *   `lib/vod_recs.mjs:407` 引入 `warn` 字段，语义是「这一站 ok=true 但部分请求失败」。
 *   实测生产 8890：modu ok=true count=74 warn="超时 2.5s 无响应"，
 *   而它单独跑（无并发压力）是 7/7 全过、140 条。
 *   也就是说：**它只供了一半数据，而前端一个字都不显示。**
 *
 * 为什么这是缺陷而不是「可接受的降级」：
 *   · 完全失败 3 站，前端显示「电影天堂（超时 2.5s 无响应）」——用户知道
 *   · 部分降级 1 站，前端显示「无」——用户不知道
 *   · 脚注「来源 4/7 站在线」把「部分降级」算成「完全在线」，这个数是错的
 *
 * 判据（三条，任一不过即 FAIL）：
 *   ① 无孤儿字段：warn 非空时，必须有消费方（前端渲染 / 监控 / 回归锁）
 *   ② 脚注口径诚实：ok=true 且 warn 非空的站，不得计入「在线」而不加标注
 *   ③ 降级可见：部分降级的站在页面上必须有可见提示，且与完全失败可区分
 *
 * 三态退出码：
 *   0 = 通过
 *   1 = 有缺陷（产品缺陷）
 *   2 = 无法判定（接口不可达 / 快照未重启）—— **不是缺陷**
 *
 * 用法：
 *   node scripts/partial-degrade-probe.mjs                 # 打生产 8890
 *   node scripts/partial-degrade-probe.mjs --base http://127.0.0.1:19175
 *   node scripts/partial-degrade-probe.mjs --json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const getArg = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const BASE = getArg('--base', 'http://127.0.0.1:8890');
const JSON_OUT = argv.includes('--json');
const IS_PROD = /127\.0\.0\.1:8890|localhost:8890/.test(BASE);

const out = [];
const rec = (ok, name, detail) => out.push({ ok, name, detail });

/* ── 1. 取数 ───────────────────────────────────────────── */
let data;
try {
  const r = await fetch(BASE + '/api/vod/recs', { signal: AbortSignal.timeout(30000) });
  if (!r.ok) {
    rec(null, '接口可达', `HTTP ${r.status}`);
    finish(2);
  }
  data = await r.json();
} catch (e) {
  rec(null, '接口可达', String(e.message || e));
  finish(2);
}

const sources = Array.isArray(data.sources) ? data.sources : [];
const okOnes = sources.filter((s) => s.ok);
const partial = okOnes.filter((s) => s.warn);
const full = sources.filter((s) => !s.ok);
const total = (data.sections || []).reduce((n, s) => n + s.count, 0);

rec(sources.length > 0, 'sources 非空', `${sources.length} 站`);

/* ── 2. 判据① 孤儿字段 ─────────────────────────────────── */
// warn 是否有人消费：查前端渲染 + 监控 + 回归锁（剥注释、剥 .bak）
const CONSUMER_FILES = [
  'public/assets/vod-recs.js',
  'scripts/ops-monitor.sh',
  'ops-monitor.sh',
];
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/<!--[\s\S]*?-->/g, '');
}
let consumerHits = [];
for (const rel of CONSUMER_FILES) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) continue;
  const body = stripComments(fs.readFileSync(p, 'utf8'));
  // 只认真正的字段读取：s.warn / source.warn / .warn（排除 CSS 变量 --warn 与 notice.warn）
  const m = body.match(/\b(?:s|source|src|item)\s*\.\s*warn\b/g) || [];
  if (m.length) consumerHits.push(`${rel}:${m.length}`);
}

const hasOrphan = partial.length > 0 && consumerHits.length === 0;
rec(
  !hasOrphan,
  '判据① warn 无孤儿（部分降级时必须有人读）',
  partial.length === 0
    ? '本轮无部分降级站，判据不适用'
    : hasOrphan
      ? `${partial.length} 站部分降级（${partial.map((s) => s.id).join(',')}）但 warn 消费方 = 0`
      : `消费方：${consumerHits.join(' ')}`
);

/* ── 3. 判据② 脚注口径诚实 ─────────────────────────────── */
/* ★ 这里也曾经写错一次，同一类错误：
 *   第一版拼了一个 `footnoteSays = '来源 4/7 站在线'` 再去正则匹配它，
 *   那是我自己拼的字符串，永远含「N/M 站在线」⇒ partial>0 时永远红。
 *   正解：从 `public/assets/vod-recs.js` 里抽**真实脚注表达式**，
 *   看它在计算「在线」数时有没有把 partial 区分出来。 */
const VODJS = path.join(ROOT, 'public/assets/vod-recs.js');
let footnoteExpr = '';
if (fs.existsSync(VODJS)) {
  const body = stripComments(fs.readFileSync(VODJS, 'utf8'));
  const m = body.match(/foot\.textContent\s*=\s*[^;]+;/);
  if (m) footnoteExpr = m[0];
}
// 脚注里只要对 warn/partial 做了区分（出现 partial 计数或 warn 判断），就算口径诚实
const footnoteDistinguishes = /warn|partial|降级|部分/.test(footnoteExpr);
rec(
  partial.length === 0 || footnoteDistinguishes,
  '判据② 脚注不得把部分降级算成完全在线',
  partial.length === 0
    ? '无部分降级，判据不适用'
    : footnoteDistinguishes
      ? `脚注已区分：${footnoteExpr.slice(0, 120).replace(/\s+/g, ' ')}…`
      : `口径错：脚注只数 ok，把 ${partial.length} 个部分降级站（${partial.map((s) => s.id).join(',')}）算成「完全在线」`
);

/* ── 4. 判据③ 降级可见且可区分 ─────────────────────────── */
/* ★ 这里曾经写错一次，必须留痕：
 *   第一版拿 `partial.map(s => s.name + '（' + s.warn + '）')` 拼出一个字符串，
 *   然后断言「字符串非空」⇒ 永远为真 ⇒ 假绿。
 *   那段文案是**我自己拼的**，不是前端渲染的。数据里有 warn ≠ 用户看得见。
 *   正解：判据③ 只能建立在「前端代码里真的读了这个字段」之上。 */
const frontendRendersWarn = consumerHits.some((h) => h.startsWith('public/'));
rec(
  partial.length === 0 || frontendRendersWarn,
  '判据③ 部分降级在页面上可见（须前端真读该字段）',
  partial.length === 0
    ? '无部分降级'
    : frontendRendersWarn
      ? `前端已消费：${consumerHits.filter((h) => h.startsWith('public/')).join(' ')}`
      : `不可见：${partial.length} 站降级（${partial.map((s) => s.id).join(',')}），前端读 warn = 0 处；` +
        `接口里有 warn 字段但没有任何页面渲染它`
);

/* ── 5. 汇总 ───────────────────────────────────────────── */
function finish(code) {
  const fails = out.filter((x) => x.ok === false);
  const unver = out.filter((x) => x.ok === null);
  const exit = unver.length ? 2 : fails.length ? 1 : 0;

  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        {
          base: BASE,
          total,
          sources: sources.map((s) => ({ id: s.id, ok: s.ok, count: s.count, error: s.error, warn: s.warn })),
          checks: out,
          exit,
        },
        null,
        2
      )
    );
    process.exit(exit);
  }

  console.log(`目标 ${BASE}${IS_PROD ? '（生产）' : '（夹具）'}`);
  console.log(`总量 ${total} 条｜完全失败 ${full.length} 站｜部分降级 ${partial.length} 站｜正常 ${okOnes.length - partial.length} 站`);
  console.log('');
  for (const x of out) {
    const mark = x.ok === true ? '✅' : x.ok === false ? '❌' : '⚠️ ';
    console.log(`${mark} ${x.name}`);
    console.log(`     ${x.detail}`);
  }
  console.log('');
  if (exit === 2) console.log('结论：无法判定（不是缺陷）  EXIT=2');
  else if (exit === 1) console.log(`结论：${fails.length} 条不合格  EXIT=1`);
  else console.log('结论：全部通过  EXIT=0');
  process.exit(exit);
}

finish();
