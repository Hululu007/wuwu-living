#!/usr/bin/env node
/**
 * 重复入口回归（一个语义只允许一个可见控件）
 *
 * 真实缺陷（2026-11-21 修）：视频页与磁力页各有两个「回客厅」。
 *   · 顶栏那个是统一入口：嵌入态发 postMessage 关舞台
 *   · 上游遗留那个是 <a href="/">：在 iframe 里点会把客厅首页装进 iframe，叠两层
 *   · 上游靠 `body:not(.ww-shell) .mx-home{display:none}` 与
 *     `html[data-embedded] #homeLink{display:none!important}` 隐藏；
 *     统一外壳恰好给 body 加了 ww-shell、独立态又无 data-embedded
 *     ⇒ 两个选择器同时反向失效，本该藏的反露出来
 *
 * 本回归只测「外壳层的收敛规则」：上游页面里同时存在遗留按钮时，
 * applyShell 必须注入去重样式，且该样式在两个状态下都只留下恰当的入口数。
 *
 * ★ 为什么不用真实浏览器：本套件要在 CI/无头环境跑。
 *   样式是否真生效由人工用 headless Chrome 验收一次（见 docs 与本轮记录），
 *   这里断言的是「规则被注入且选择器覆盖了遗留控件」——回归锁的目的是防止
 *   某次改动把这条规则删掉，而不是替代一次性的浏览器验收。
 *   为此额外加一条负向臂：删掉规则时检测函数必须报警，否则本套件没有区分力。
 */
import assert from 'node:assert/strict';

let passed = 0;
const fails = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { fails.push(name); console.error(`FAIL ${name}: ${e.message}`); process.exitCode = 1; }
}

const MOD = new URL('../lib/legacy_shell.mjs', import.meta.url).href;
const { applyShell } = await import(MOD);

/* ── 夹具：照抄上游真实结构（请看 / 磁力搜索）── */
const UPSTREAM_VOD = `<!doctype html><html lang="zh-CN"><head><title>t</title>
<style>#homeLink{display:inline-flex}html[data-embedded] #homeLink{display:none!important}</style>
</head><body>
<header id="top"><div id="brand">
<a id="homeLink" class="ww-home" href="/" title="返回五五客厅"><span>←</span> 客厅</a>
</div></header>
</body></html>`;

const UPSTREAM_MAGNET = `<!doctype html><html><head><title>t</title>
<style>body:not(.ww-shell) .mx-home{display:none}html[data-embedded] .mx-home{display:none!important}</style>
</head><body>
<div class="top"><a class="mx-home" href="/" title="返回五五客厅"><span>←</span> 客厅</a></div>
</body></html>`;

/** 抽出注入的去重样式块正文 */
function dedupCss(html) {
  const m = /<style data-ww-dedup>([\s\S]*?)<\/style>/.exec(html);
  return m ? m[1] : '';
}

/** 关键检测：规则必须覆盖「上游遗留控件」且不误伤顶栏自己的锚点 */
function coversLegacy(css) {
  const hasBodyScope = /body\.ww-shell/.test(css);
  const hasMx = /\.mx-home/.test(css);
  const hasId = /#homeLink/.test(css);
  const hasGeneric = /a\[title="返回五五客厅"\]/.test(css) && /:not\(\[data-ww-home\]\)/.test(css);
  const hides = /display\s*:\s*none\s*!important/.test(css);
  return hasBodyScope && hasMx && hasId && hasGeneric && hides;
}

/* ═════════ 正臂 ═════════ */

await test('视频页：套壳后注入去重规则，且覆盖 #homeLink', () => {
  const out = applyShell(UPSTREAM_VOD, 'vod');
  const css = dedupCss(out);
  assert.ok(css, '必须注入 data-ww-dedup 样式块');
  assert.ok(coversLegacy(css), '规则必须覆盖 body.ww-shell 下的 #homeLink / .mx-home / 通用后备');
  assert.match(css, /#homeLink/, '必须点到具体 id，否则压不过上游同等优先级规则');
});

await test('磁力页：套壳后注入去重规则，且覆盖 .mx-home', () => {
  const out = applyShell(UPSTREAM_MAGNET, 'magnet');
  const css = dedupCss(out);
  assert.ok(css, '必须注入 data-ww-dedup 样式块');
  assert.ok(coversLegacy(css), '规则必须覆盖遗留控件');
  assert.match(css, /\.mx-home/, '必须点到具体 class');
});

await test('规则不得把顶栏自己的入口一起藏掉（:not([data-ww-home]) 兜底必须带排除）', () => {
  const css = dedupCss(applyShell(UPSTREAM_VOD, 'vod'));
  const generic = /a\[title="返回五五客厅"\]:not\(\[data-ww-home\]\)/.exec(css);
  assert.ok(generic, '通用后备选择器必须排除 [data-ww-home]，否则会藏掉顶栏唯一出口');
});

await test('两种状态都不保留上游按钮（嵌入态出口在舞台头，不是页面内）', () => {
  const css = dedupCss(applyShell(UPSTREAM_VOD, 'vod'));
  assert.doesNotMatch(css, /html\[data-embedded\][\s\S]*display\s*:\s*inline-flex/,
    '嵌入态不得把上游按钮放回来——那正是「iframe 里叠两层客厅」的成因');
});

await test('幂等：二次套壳不得再插一份去重样式', () => {
  const once = applyShell(UPSTREAM_VOD, 'vod');
  const twice = applyShell(once, 'vod');
  assert.equal((twice.match(/data-ww-dedup/g) || []).length, 1, '去重样式必须只有一份');
  assert.equal(twice, once, '已套壳的输入必须原样返回');
});

await test('非目标房间 / 非 HTML：原样返回，不注入也不抛错', () => {
  assert.equal(applyShell(UPSTREAM_VOD, 'nope'), UPSTREAM_VOD, '未知房间必须原样返回');
  assert.equal(applyShell('', 'vod'), '', '空串原样返回');
  assert.equal(applyShell(null, 'vod'), null, 'null 原样返回');
  assert.equal(applyShell('{"ok":true}', 'vod'), '{"ok":true}', 'JSON 原样返回');
});

/* ═════════ 负向臂：证明本套件有区分力 ═════════ */

await test('负向臂：去掉规则后检测函数必须报 false（否则本套件是假绿）', () => {
  const css = dedupCss(applyShell(UPSTREAM_VOD, 'vod'));
  const broken = css.replace(/display\s*:\s*none\s*!important/g, 'display:block');
  assert.equal(coversLegacy(css), true, '原规则应通过');
  assert.equal(coversLegacy(broken), false, '把 display:none!important 去掉后必须判定为不合格');
});

await test('负向臂：套壳前上游确实只有一个锚点，套壳后 DOM 里变两个（问题真实存在）', () => {
  const count = (h) => (h.match(/<a[^>]*title="返回五五客厅"/g) || []).length;
  assert.equal(count(UPSTREAM_VOD), 1, '上游原始 HTML 只有一个锚点');
  assert.equal(count(applyShell(UPSTREAM_VOD, 'vod')), 2, '套壳后会多一个顶栏锚点 —— 靠 CSS 收敛，不靠删 DOM');
});

/* ═════════ 收尾 ═════════ */

console.log(`\n重复入口：${passed} 通过，${fails.length} 失败`);
if (fails.length) {
  console.error('失败用例：', fails.join(' / '));
  process.exitCode = 1;
}
