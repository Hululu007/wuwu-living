#!/usr/bin/env node
/**
 * 五五客厅 · 设计契约只读审计器
 *
 * 只读：不写任何业务文件，不改任何页面。仅读取 public/ 下的 css/html 并输出判句。
 * 三态判句：PASS / FAIL / 未取证（拿不到证据一律「未取证」，绝不算通过）
 *
 * 用法：
 *   node design/design-audit.mjs                 # 审计当前工程
 *   node design/design-audit.mjs --root <dir>    # 审计指定根目录（负向臂用）
 *   node design/design-audit.mjs --json          # 机器可读
 *
 * 退出码：0 = 全部 PASS；1 = 至少一条 FAIL；2 = 审计器自身故障（文件读不到等）
 * 故障判定：抛异常 / 目标目录不存在 / 关键文件缺失 → exit 2，并明确写「审计器故障，本次结果无效」
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

// ── 参数 ────────────────────────────────────────────────
const argv = process.argv.slice(2);
const wantJson = argv.includes('--json');
const rootIdx = argv.indexOf('--root');
const ROOT = rootIdx >= 0 ? argv[rootIdx + 1] : process.cwd();
const PUB = join(ROOT, 'public');
const CSS = join(PUB, 'assets', 'room.css');

// ── 判句收集 ─────────────────────────────────────────────
const rows = [];
function rec(id, name, verdict, detail) {
  rows.push({ id, name, verdict, detail });
}

function readOrFail(p) {
  if (!existsSync(p)) {
    console.error(`[审计器故障] 缺文件：${p}`);
    process.exit(2);
  }
  return readFileSync(p, 'utf8');
}

function listHtml(dir) {
  if (!existsSync(dir)) {
    console.error(`[审计器故障] 缺目录：${dir}`);
    process.exit(2);
  }
  return readdirSync(dir)
    .filter((f) => extname(f) === '.html')
    .map((f) => join(dir, f));
}

// ── 0. 前置：确认读得到 ───────────────────────────────────
const css = readOrFail(CSS);
const pages = listHtml(PUB);
if (pages.length === 0) {
  console.error('[审计器故障] public/ 下没有任何 .html，无法判定');
  process.exit(2);
}

// ── 1. token 定义 ────────────────────────────────────────
// 不能按行解析：写在一行里的 `:root{--a:x;--b:y}` 是合法 CSS，
// 按行匹配会一个都抓不到，V3/V4 就会空过变成假绿。
const tokenDefs = {};
for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;{}]+);/gim)) {
  tokenDefs[m[1]] = m[2].trim();
}
// 「裸色值」判定要先剥掉定义行（含单行定义），否则 token 值本身会被算成裸色值。
// ★ 2026-11-22：必须连注释一起剥。实测 V1 报的 10 处「同值裸 hex」全部来自
//   CSS 注释里解释配色决策的文字（`#d6a05e / #dd7768 / …`），
//   不是任何真实声明 —— 把注释当代码是判据的错，不是代码的错。
const cssNoComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
const cssNoDefs = cssNoComments.replace(/--[a-z0-9-]+\s*:\s*[^;{}]+;/gim, '');
const tokenCount = Object.keys(tokenDefs).length;

// ── 2. 视觉契约：裸色值 ───────────────────────────────────
// cssNoDefs 已在上面剥掉所有 token 定义（含单行写法）
const colorRe = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;
const cssBareColors = (cssNoDefs.match(colorRe) || []).length;

let inlineTotal = 0;
const perPageInline = {};
for (const p of pages) {
  const src = readFileSync(p, 'utf8');
  const styleBlocks = (src.match(/<style[\s\S]*?<\/style>/gi) || []).join('\n');
  const styleAttr = (src.match(/style="[^"]*"/gi) || []).join(' ');
  const n =
    (styleBlocks.match(colorRe) || []).length +
    (styleAttr.match(colorRe) || []).length;
  perPageInline[basename(p)] = n;
  inlineTotal += n;
}

// ★ 2026-11-22 修 V1/V2 判据（与 V6 同类错误：判据依据不在规范里，且算法太粗）。
//   原判据：任何 `#hex` 或 `rgba()` 都算裸色值，要求 0 处。
//   实测 422 处里绝大多数**不是违规**：
//     · token-alpha  rgba(239,233,221,.18) = token 加透明度   → 合法派生
//     · white/black-alpha  遮罩与浮层                          → 合法派生
//     · 同值 hex    #efe9dd 这种 token 值被直接写出来          → 该换 token（真问题）
//   规范《前端设计规范.md》第二节只给了 token 表，**没有「禁止透明度派生」这一条**；
//   要求 0 处等于要求把 rgba(0,0,0,.8) 也做成 token，那是为判据造 token。
//   现在只把「能与 token 同值的裸 hex」算作不合格（这才是抄手抄歪的部分），
//   并把派生量与真新色分开报数。
const tokenRgbSet = new Set();
for (const v of Object.values(tokenDefs)) {
  const mm = String(v).trim().match(/^#([0-9a-fA-F]{3,8})$/);
  if (!mm) continue;
  let h = mm[1].toLowerCase();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length >= 6) tokenRgbSet.add(h.slice(0, 6));
}
function classifyColor(v) {
  const raw = String(v).trim();
  if (raw.startsWith('#')) {
    let h = raw.slice(1).toLowerCase();
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const key = h.slice(0, 6);
    return tokenRgbSet.has(key) ? 'tokenHex' : 'newHex';
  }
  const m2 = raw.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
  if (!m2) return 'other';
  const rgb = [1, 2, 3].map((i) => Math.round(Number(m2[i])));
  const key = rgb.map((n) => n.toString(16).padStart(2, '0')).join('');
  if (tokenRgbSet.has(key)) return 'tokenAlpha';
  if (rgb[0] === 255 && rgb[1] === 255 && rgb[2] === 255) return 'whiteAlpha';
  if (rgb[0] === 0 && rgb[1] === 0 && rgb[2] === 0) return 'blackAlpha';
  return 'newRgb';
}
function colorBreakdown(text) {
  const out = { tokenHex: 0, tokenAlpha: 0, whiteAlpha: 0, blackAlpha: 0, newHex: 0, newRgb: 0, other: 0 };
  for (const v of text.match(colorRe) || []) out[classifyColor(v)]++;
  return out;
}
const cssBreak = colorBreakdown(cssNoDefs);
// 不合格 = 能用 token 却写成裸 hex（真抄歪）
const cssBareHex = cssBreak.tokenHex;
rec(
  'V1',
  'room.css 无「本可用 token 却写裸 hex」的色值（:root 外）',
  cssBareHex === 0 ? 'PASS' : 'FAIL',
  cssBareHex === 0
    ? `无同值裸 hex；合法派生 ${cssBreak.tokenAlpha + cssBreak.whiteAlpha + cssBreak.blackAlpha} 处（token+透明度/黑白遮罩），自定义新色 ${cssBreak.newHex + cssBreak.newRgb} 处`
    : `${cssBareHex} 处 hex 与 token 同值（应换 var(--…)）；另有合法派生 ${cssBreak.tokenAlpha + cssBreak.whiteAlpha + cssBreak.blackAlpha} 处、新色 ${cssBreak.newHex + cssBreak.newRgb} 处；token 共 ${tokenCount} 个`
);

const worstPages = Object.entries(perPageInline)
  .filter(([, n]) => n > 0)
  .sort((a, b) => b[1] - a[1]);
// 页面内联同口径：只把「与 token 同值的裸 hex」算不合格
const inlineBreak = { tokenHex: 0, tokenAlpha: 0, whiteAlpha: 0, blackAlpha: 0, newHex: 0, newRgb: 0, other: 0 };
for (const p of pages) {
  const src = readFileSync(p, 'utf8');
  // ★★ 2026-11-23 修 V2 误报（与 V1 剥注释是同一类错，这是第二次）：
  //   原实现把整段 <style> 原样扫，于是**页面里自己定义的 token**（如书房不引
  //   room.css，必须在本地 :root 里补 --on-accent:#15110c）连同定义行的 hex
  //   一起被算成「裸色值」，报出 4 处——其中 2 处还是注释里的值说明。
  //   判据要测的是「使用处有没有本可用 token 却写死」，不是「定义行长什么样」。
  //   修法：先剥注释，再剥 --token: value; 定义行，最后才统计。
  const rawBlocks = (src.match(/<style[\s\S]*?<\/style>/gi) || []).join('\n');
  const blocks = rawBlocks
    .replace(/\/\*[\s\S]*?\*\//g, '')            // 剥 CSS 注释（值说明不算使用）
    .replace(/--[a-z0-9-]+\s*:\s*[^;{}]+;/gim, ''); // 剥 token 定义行
  const attrs = (src.match(/style="[^"]*"/gi) || []).join(' ')
    .replace(/--[a-z0-9-]+\s*:\s*[^;]+;?/gim, '');
  const b = colorBreakdown(blocks + ' ' + attrs);
  for (const k of Object.keys(inlineBreak)) inlineBreak[k] += b[k];
}
const inlineBareHex = inlineBreak.tokenHex;
rec(
  'V2',
  '页面内联无「本可用 token 却写裸 hex」的色值',
  inlineBareHex === 0 ? 'PASS' : 'FAIL',
  inlineBareHex === 0
    ? `无同值裸 hex；合法派生 ${inlineBreak.tokenAlpha + inlineBreak.whiteAlpha + inlineBreak.blackAlpha} 处，自定义新色 ${inlineBreak.newHex + inlineBreak.newRgb} 处`
    : `${inlineBareHex} 处 hex 与 token 同值（应换 var(--…)）；另有合法派生 ${inlineBreak.tokenAlpha + inlineBreak.whiteAlpha + inlineBreak.blackAlpha} 处、新色 ${inlineBreak.newHex + inlineBreak.newRgb} 处`
);

// ── 3. 视觉契约：近似色漂移 ───────────────────────────────
// 与某个 token 值仅差 1 个十六进制字符 → 说明是抄手抄歪的，不是新色
function hexNorm(s) {
  const m = s.match(/^#([0-9a-fA-F]{6})$/);
  return m ? m[1].toLowerCase() : null;
}
function distance1(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  return diff === 1;
}
const tokenHex = Object.entries(tokenDefs)
  .map(([k, v]) => [k, hexNorm(v)])
  .filter(([, v]) => v);

const allColorUse = (
  (cssNoDefs.match(/#[0-9a-fA-F]{6}\b/g) || []).join(' ') +
  ' ' +
  pages.map((p) => readFileSync(p, 'utf8').match(/#[0-9a-fA-F]{6}\b/g)?.join(' ') || '').join(' ')
).match(/#[0-9a-fA-F]{6}\b/g) || [];

const driftMap = new Map();
for (const raw of allColorUse) {
  const h = hexNorm(raw);
  if (!h) continue;
  for (const [name, th] of tokenHex) {
    if (th === h) continue;
    if (distance1(th, h)) {
      const key = `${raw} ≈ ${name}(${tokenDefs[name]})`;
      driftMap.set(key, (driftMap.get(key) || 0) + 1);
    }
  }
}
const drifts = [...driftMap.entries()].sort((a, b) => b[1] - a[1]);
rec(
  'V3',
  '无与 token 差一位的近似色',
  drifts.length === 0 ? 'PASS' : 'FAIL',
  drifts.length === 0
    ? '无'
    : `${drifts.length} 组，最重：${drifts.slice(0, 3).map(([k, n]) => `${k}×${n}`).join('；')}`
);

// ── 4. 视觉契约：语义色与房色必须「人眼可分」────────────────
// ★ 只看「色值是否相等」不够：实测出现过 --warn=#d99a2b vs --book=#d6a05e，
//   值不相等但 CIEDE2000 只有 6.7（远低于可区分阈值 12），人眼依然分不出。
//   所以必须用感知色差，阈值 ΔE00 ≥ 12；同时语义色对底色要过 WCAG AA（4.5）。
const SEM_MIN_DE = 12;   // 语义色 vs 任一房色，感知色差下限
const SEM_MIN_CT = 4.5;  // 语义色对 --bg 的 WCAG 对比度下限（AA 正文）

const hex2rgb = (h) => {
  const s = h.replace('#', '');
  return s.length === 3
    ? [0, 1, 2].map((i) => parseInt(s[i] + s[i], 16))
    : [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
};
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const rgb2lab = (h) => {
  const [r, g, b] = hex2rgb(h).map(lin);
  const X = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const Y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
  const Z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
};
const deltaE00 = (h1, h2) => {
  const [L1, a1, b1] = rgb2lab(h1), [L2, a2, b2] = rgb2lab(h2);
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const d2r = Math.PI / 180, r2d = 180 / Math.PI;
  let h1p = Math.atan2(b1, a1p) * r2d % 360, h2p = Math.atan2(b2, a2p) * r2d % 360;
  if (h1p < 0) h1p += 360; if (h2p < 0) h2p += 360;
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360; else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(dhp / 2 * d2r);
  const Lbp = (L1 + L2) / 2, Cbp = (C1p + C2p) / 2;
  let hbp = 0;
  if (C1p * C2p === 0) hbp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) hbp = (h1p + h2p) / 2;
  else if (h1p + h2p < 360) hbp = (h1p + h2p + 360) / 2;
  else hbp = (h1p + h2p - 360) / 2;
  const T = 1 - 0.17 * Math.cos((hbp - 30) * d2r) + 0.24 * Math.cos(2 * hbp * d2r)
    + 0.32 * Math.cos((3 * hbp + 6) * d2r) - 0.20 * Math.cos((4 * hbp - 63) * d2r);
  const dTh = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const RC = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const SL = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const SC = 1 + 0.045 * Cbp, SH = 1 + 0.015 * Cbp * T;
  const RT = -Math.sin(2 * dTh * d2r) * RC;
  return Math.sqrt((dLp / SL) ** 2 + (dCp / SC) ** 2 + (dHp / SH) ** 2
    + RT * (dCp / SC) * (dHp / SH));
};
const contrastOn = (fg, bg) => {
  const rl = (h) => {
    const [r, g, b] = hex2rgb(h).map(lin);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const L1 = rl(fg), L2 = rl(bg);
  const hi = Math.max(L1, L2), lo = Math.min(L1, L2);
  return (hi + 0.05) / (lo + 0.05);
};

const semantic = ['--ok', '--warn', '--danger'];
const roomsList = [
  '--magnet', '--book', '--music', '--vod', '--download',
  '--library', '--notes', '--calendar', '--photos', '--cast',
];
const isHex = (v) => /^#[0-9a-fA-F]{6}$/.test(v);
const BG = isHex(tokenDefs['--bg'] || '') ? tokenDefs['--bg'] : '#0a0d0b';

const semIssues = [];
const semChecked = [];
for (const s of semantic) {
  if (!isHex(tokenDefs[s] || '')) continue;
  const cs = tokenDefs[s];
  let closest = { d: Infinity, name: null, color: null };
  for (const r of roomsList) {
    if (!isHex(tokenDefs[r] || '')) continue;
    const d = deltaE00(cs, tokenDefs[r]);
    if (d < closest.d) closest = { d, name: r, color: tokenDefs[r] };
  }
  const ct = contrastOn(cs, BG);
  semChecked.push(`${s}=${cs} 最近房色 ${closest.name} ΔE=${closest.d.toFixed(1)} 对比=${ct.toFixed(2)}`);
  if (Number.isFinite(closest.d) && closest.d < SEM_MIN_DE) {
    semIssues.push(`${s}(${cs}) ↔ ${closest.name}(${closest.color}) ΔE=${closest.d.toFixed(1)} < ${SEM_MIN_DE} → 人眼分不出`);
  }
  if (ct < SEM_MIN_CT) {
    semIssues.push(`${s}(${cs}) 对底色 ${BG} 对比仅 ${ct.toFixed(2)} < ${SEM_MIN_CT}（AA 不达标）`);
  }
}
rec(
  'V4',
  `语义色与房色感知可分（ΔE00≥${SEM_MIN_DE}）且对底色对比≥${SEM_MIN_CT}`,
  semChecked.length === 0 ? '未取证'
    : semIssues.length === 0 ? 'PASS' : 'FAIL',
  semChecked.length === 0
    ? '未取证：room.css 里没解析到可比的十六进制语义色与房色'
    : semIssues.length === 0
      ? semChecked.join('；')
      : semIssues.join('；')
);

// ── 5. 视觉契约：字号阶梯 ────────────────────────────────
// ★ 2026-11-22 修盲区：原来只扫 room.css（那一份清到 0 处后永远 PASS），
//   而全站实际有 37 处 <11px 散在 6 个页面与 vod-recs.css 里 —— 判据报了绿灯，
//   缺陷却还在。这是「测一半当全测」的典型，比没有判据更危险。
//   现在扫 room.css + 其余 assets/*.css + 全部 public/*.html（内联 <style> 与 style=""）。
const FONT_MIN = 11; // 项目自身规范第 36 行：辅助文字不小于 11px
const fontSources = [];
{
  const assetDir = join(PUB, 'assets');
  if (existsSync(assetDir)) {
    for (const f of readdirSync(assetDir)) {
      if (/\.css$/.test(f)) fontSources.push({ name: `assets/${f}`, text: readFileSync(join(assetDir, f), 'utf8') });
    }
  }
  // 不能依赖 pagesByRoom：它在本判据之后才构造（V5 必须早于状态判定执行）。
  for (const f of readdirSync(PUB)) {
    if (!/\.html$/.test(f)) continue;
    fontSources.push({ name: f, text: readFileSync(join(PUB, f), 'utf8') });
  }
}
const allFontPx = [];
const smallByFile = {};
for (const { name, text } of fontSources) {
  for (const m of text.matchAll(/font-size:\s*([0-9.]+)px/g)) {
    const n = parseFloat(m[1]);
    allFontPx.push(n);
    if (n < FONT_MIN) smallByFile[name] = (smallByFile[name] || 0) + 1;
  }
}
const fontSizes = [...new Set(allFontPx)].sort((a, b) => a - b);
const smallTotal = Object.values(smallByFile).reduce((a, b) => a + b, 0);
rec(
  'V5',
  `无小于 ${FONT_MIN}px 的字号（违反项目自身规范，全站扫描）`,
  allFontPx.length === 0 ? '未取证' : smallTotal === 0 ? 'PASS' : 'FAIL',
  allFontPx.length === 0
    ? '未取证：全站没找到任何 font-size，无法判定（不当作通过）'
    : smallTotal === 0
      ? `全站 ${allFontPx.length} 处 font-size 全部 ≥${FONT_MIN}px；取值 ${fontSizes.length} 档：${fontSizes.join('/')}`
      : `全站小于 ${FONT_MIN}px 共 ${smallTotal} 处（扫描 ${fontSources.length} 个文件）：` +
        Object.entries(smallByFile).sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f}=${n}`).join(' / ')
);

// ── 6. 视觉契约：间距为 4 的倍数（基准网格）────────────────
const spacings = [...new Set(
  (css.match(/(?:padding|margin|gap)[a-z-]*:\s*([0-9.]+)px/g) || [])
    .map((s) => parseFloat(s.replace(/[^\d.]/g, '')))
)].sort((a, b) => a - b);
const offGrid = spacings.filter((n) => n % 4 !== 0);
rec(
  'V6',
  '间距取值落在 4px 基准网格上（参考项，非项目规范）',
  // ★ 2026-11-22 修判据依据：`前端设计规范.md` 里只规定了
  //   「正文 14–15px / 辅助文字不小于 11px」「圆角 2–3px」「优先 1px 线」，
  //   **没有任何 4px 网格条款**。把自创标准当硬性 FAIL 会让团队去改
  //   24 档既有间距 —— 那是高风险重构，收益是"更整齐"，不是用户能感知的缺陷。
  //   因此降级为参考项：数值照报，但不计入 FAIL。
  spacings.length === 0 ? '未取证' : 'REF',
  spacings.length === 0
    ? '未取证：没找到任何 padding/margin/gap 的 px 取值（不当作通过）'
    : `参考（规范未要求 4px 网格）：共 ${spacings.length} 档，脱离 4 倍数 ${offGrid.length} 档（${offGrid.join('/')}）`
);

// ── 7. 视觉契约：圆角不超过 3px（规范第 38 行）──────────────
const radii = [...new Set(
  (css.match(/border-radius:\s*([0-9.]+)px/g) || [])
    .map((s) => parseFloat(s.replace(/[^\d.]/g, '')))
)].sort((a, b) => a - b);
const bigRadius = radii.filter((n) => n > 3);
rec(
  'V7',
  '圆角 ≤ 3px（面板 2–3px）',
  radii.length === 0 ? '未取证' : bigRadius.length === 0 ? 'PASS' : 'FAIL',
  radii.length === 0
    ? '未取证：没找到任何 border-radius 的 px 取值（不当作通过）'
    : `取值：${radii.join('/')}${bigRadius.length ? `；超限 ${bigRadius.join('/')}` : ''}`
);

// ── 8. 交互契约：六态覆盖（每间房 × 空/加载/出错）──────────
const pagesByRoom = {};
for (const p of pages) pagesByRoom[basename(p, '.html')] = readFileSync(p, 'utf8');

const stateRows = [];
for (const [room, src] of Object.entries(pagesByRoom)) {
  const hasEmpty = /class="[^"]*\b(empty|no-data)\b[^"]*"/i.test(src);
  const hasLoading = /class="[^"]*\b(loading|skeleton|spinner)\b[^"]*"/i.test(src);
  const hasError = /class="[^"]*\b(error|alert|failed|fail-state|errbox|error-box)\b[^"]*"/i.test(src);
  const hasOverflowHint = /还有\s*\d+|共\s*\d+\s*条|显示更多|加载更多/.test(src);
  const hasUnavailable = /无权限|不可用|离线|未授权|权限不足/.test(src);
  stateRows.push({ room, hasEmpty, hasLoading, hasError, hasOverflowHint, hasUnavailable });
}

// 出错态：不是「有没有渲染错误信息」，而是「错误与空内容能不能被区分」。
// 实测本项目 7 间房都渲染了错误文案，但全部复用 .empty 样式（虚线框+居中），
// 与「暂无数据」长得一模一样 ⇒ 真正缺陷是「视觉不可区分」，不是「没有出错态」。
const errIndistinct = [];
const errMissing = [];
for (const [room, src] of Object.entries(pagesByRoom)) {
  const rendersErr = /(读不出|没读|读取失败|加载失败|请求失败|出错|没连上|没起来|读不到|拉不到|失败)/.test(src);
  // ★ 2026-11-22 修误报：投屏用 .errbox 承载「上次没起来」，是真正的独立错误容器，
  //   但旧正则只认 error/alert/failed ⇒ 把有错误呈现的房间判成「完全没有」。
  //   类名清单必须按项目实际用到的写法，而不是我猜的英文单词。
  // ★ 2026-11-22 第三次修 S1（前两版都栽在「措辞覆盖不全」）：
  //   ① 只认 error/alert/failed → 投屏用 errbox 被判「完全没有」
  //   ② 补了 errbox/unavailable，但仍测措辞 → 媒体库改说「暂时读不出来」又不认
  //   根因：判据在测措辞，措辞一改就漏。改成结构判据：
  //   只要源码里存在独立态类片段（可出现在 JS 字符串里），且确有失败文案，即具备。
  // 只认真的写在 class 里（或 classList 操作里）的态名，不认 s.error 这类普通属性。
  const STATE_TOKEN = /(?:class="[^"]*\b(error|errbox|error-box|fail-state|unavailable|failed)\b|classList\.(?:add|toggle)\([^)]*['"](?:error|errbox|error-box|fail-state|unavailable|failed)['"])/;
  const ownErrClass = STATE_TOKEN.test(src);
  if (!rendersErr) errMissing.push(room);
  else if (!ownErrClass) errIndistinct.push(room);
}
// ★ 2026-11-22 修报告缺陷：原来用 if/else 只显示一类，
//   实测「投屏 缺呈现」与「7 间房呈现与空态同形」同时存在时，
//   详情只报前者 ⇒ 修完投屏会以为 S1 已解决，其实还有 7 间没修。
//   现在两类并列显示，缺一不可。
const s1Parts = [];
if (errMissing.length > 0) {
  s1Parts.push(`${errMissing.length} 间房完全没有出错呈现：${errMissing.join(' / ')}`);
}
if (errIndistinct.length > 0) {
  s1Parts.push(
    `${errIndistinct.length} 间房有错误文案但复用 .empty 样式 → 与「暂无数据」同形，用户分不出「坏了」还是「空着」：${errIndistinct.join(' / ')}`
  );
}
rec(
  'S1',
  '「出错」与「空内容」在视觉上可区分',
  s1Parts.length === 0 ? 'PASS' : 'FAIL',
  s1Parts.length === 0 ? '全部具备独立出错样式' : s1Parts.join('；')
);

const noLoading = stateRows.filter((r) => !r.hasLoading).map((r) => r.room);
rec(
  'S2',
  '每间房有「加载」容器',
  noLoading.length === 0 ? 'PASS' : 'FAIL',
  noLoading.length === 0 ? '全部具备' : `${noLoading.length}/${stateRows.length} 间房缺：${noLoading.join(' / ')}`
);

// 超量态：判据不是「有没有 `还有 N 条`文案」，而是「截断后用户能否知道被截了、且能展开」。
//
// 三条修正（都是实测踩出来的，否则误报/漏报各占一半）：
//  ① 排除字符串截断：`esc(x).slice(0,16)`、`toTimeString().slice(0,8)` 是取子串，不是列表截断。
//  ② 支持常量名：`day.episodes.slice(0, WEEK_EP_LIMIT)` 用常量，按数字匹配会整条漏掉。
//  ③ 「有提示」必须同时有「还有 N」文案 + 真实展开逻辑（expanded 状态或 data-*-more 按钮），
//     只有文案没有按钮不算（用户看得到却点不动）。
const overflowSites = [];
for (const [room, src] of Object.entries(pagesByRoom)) {
  const lines = src.split('\n');
  const consts = {};
  for (const m of src.matchAll(/(?:var|let|const)\s+([A-Z][A-Z0-9_]+)\s*=\s*(\d+)\s*;/g)) {
    consts[m[1]] = Number(m[2]);
  }
  lines.forEach((l, i) => {
    const m = l.match(/\.slice\(\s*0\s*,\s*([A-Za-z_][A-Za-z0-9_]*|\d+)\s*\)/);
    if (!m) return;
    // ① 字符串截断排除：截断目标不是列表变量
    if (/esc\s*\(|toTimeString|toString|JSON\.stringify|\.name\s*\)\.slice|url|title\s*\)\.slice/i.test(l)) return;
    const raw = m[1];
    const cap = /^\d+$/.test(raw) ? Number(raw) : consts[raw];
    if (cap === undefined) return; // 常量查不到值，不下判断
    if (cap > 40) return; // 过长，基本是文本截断
    // 必须是列表语义的变量名
    if (!/(shelf|watched|items|list|todos|rows|eps|episodes|results|res|feeds|tracks)/i.test(l)) return;

    // ③ 「有提示」= 附近出现「还有 N」+ 存在展开机制
    const near = lines.slice(Math.max(0, i - 3), i + 14).join('\n');
    const hasCopy = /还有\s*['"+]|还有\s*\d|还有\s*['"]\s*\+/.test(near);
    const hasExpand = /data-[a-z-]*more|Expanded\s*\[|expanded\s*\)?\s*\?|收起/.test(near);
    const hasHint = hasCopy && hasExpand;
    overflowSites.push({ room, line: i + 1, cap, hasHint, hasCopy, hasExpand });
  });
}
const noHint = overflowSites.filter((s) => !s.hasHint);
rec(
  'S3',
  '列表被截断处告知「还有多少」且能展开（超量态）',
  overflowSites.length === 0 ? '未取证'
    : noHint.length === 0 ? 'PASS' : 'FAIL',
  overflowSites.length === 0
    ? '未取证：没找到列表级截断点'
    : `${overflowSites.length} 处列表截断，${noHint.length} 处不合格：` +
      noHint.slice(0, 4).map((s) =>
        `${s.room}:${s.line} slice(0,${s.cap})` +
        (!s.hasCopy ? '（无「还有 N」文案）' : '') +
        (s.hasCopy && !s.hasExpand ? '（有文案但无展开）' : '')
      ).join('；')
);

// ★ 2026-11-22 重写 S4 判据（原判据太弱，可被一个词骗过）：
//   原来只测 /无权限|不可用|离线|未授权|权限不足/ 是否出现 ——
//   在页面里随手写一句「不可用」就算通过，而用户看到的可能仍是空白。
//   按设计管家《交互契约-不可用态-S4-Rev1》的四类重写：
//     ① 服务挂了 ② 功能降级 ③ 无权限 ④ 上游能力不可用
//   契约硬门槛：**没有动作的不可用态不合格**（每类必须有按钮或明确「无需操作」）。
//   同时承认一种正当情况：某些房间确实不存在该态（如纯本地记事没有上游），
//   但必须由页面自己写出理由，不许默不作声。
const UNAVAIL_RULES = [
  { key: '服务挂了', re: /(没在运行|没起来|服务进程已停止|启动失败)/ },
  { key: '功能降级', re: /(状态未知|自动重试|degraded|熔断)/ },
  { key: '无权限',   re: /(无权限|权限不足|未授权|EPERM|受保护|被拒绝)/ },
  { key: '上游不可用', re: /(DHT|受限|版权|上游|节点|换源|ffprobe|扫描器)/ },
];
// ★ 2026-11-22 第二次修 S4：第一版只测关键词（太弱），第二版四类词表太窄
//   （媒体库写「扫描器或 ffprobe 不可用」一条都不命中，被判「没有不可用态」）。
//   根因同 S1：判据在测措辞。改成结构判据：
//     有独立态类片段（unavailable/errbox/error…，可出现在 JS 字符串里）→ 具备该态
//     且有动作（button/a）或明确「无需操作 / 会自动恢复」              → 合格
//   四类关键词保留，只用于说明「覆盖了哪几类」，不再当通过门槛。
// ★ 只认「真的写在 class 里」的态名：必须出现在 class="..." 或 classList 操作里。
//   上一版用裸 token 匹配，把 `s.error`（普通数据属性）也当成态类名 —— 负向臂
//   抹掉所有类名后仍判「已覆盖 7/8」，这是假绿。
const UNAVAIL_TOKEN = /(?:class="[^"]*\b(unavailable|errbox|error-box|error|fail-state)\b|classList\.(?:add|toggle)\([^)]*['"](?:unavailable|errbox|error-box|error|fail-state)['"])/;
const s4Rows = [];
for (const [room, src] of Object.entries(pagesByRoom)) {
  const hits = UNAVAIL_RULES.filter((r) => r.re.test(src)).map((r) => r.key);
  const hasToken = UNAVAIL_TOKEN.test(src);
  const hasAction = /<(button|a)\b[^>]*>|无需操作|会自动恢复/.test(src);
  const declaresNa = /(不涉及|不存在|本机私有|没有上游)/.test(src);
  s4Rows.push({ room, hits, hasToken, hasAction, declaresNa });
}
const s4Missing = s4Rows.filter((r) => !r.hasToken && r.hits.length === 0 && !r.declaresNa);
// 有态但没有动作 = 不合格（契约硬门槛：没有动作的不可用态不合格）
const s4NoAction = s4Rows.filter((r) => (r.hasToken || r.hits.length > 0) && !r.hasAction);
const s4Parts = [];
if (s4Missing.length) s4Parts.push(`${s4Missing.length} 间房没有不可用态：${s4Missing.map((r) => r.room).join(' / ')}`);
if (s4NoAction.length) s4Parts.push(`${s4NoAction.length} 间房有不可用文案但无动作（不合格）：${s4NoAction.map((r) => r.room).join(' / ')}`);
const s4Covered = s4Rows.filter((r) => r.hasToken || r.hits.length > 0).length;
const s4Kinds = new Set();
for (const r of s4Rows) for (const k of r.hits) s4Kinds.add(k);
rec(
  'S4',
  '有「不可用 / 无权限」态文案，且每类带用户可执行动作',
  s4Parts.length === 0 ? 'PASS' : 'FAIL',
  s4Parts.length === 0
    ? `${s4Covered}/${s4Rows.length} 间房覆盖不可用态，动作齐备；四类命中：${[...s4Kinds].join('/') || '按类名判定'}`
    : s4Parts.join('；') + `｜已覆盖 ${s4Covered}/${s4Rows.length}`
);

// 出错态是否只有 toast（瞬态）承载 → 静默失败风险
//
// ★ 2026-11-22 修判据：原实现只检测「有没有 toast」，判据文案却说「消息 2 秒后消失」，
//   二者不是一回事 —— 于是把失败 toast 改成常驻之后，这条仍然报 FAIL（结论过时）。
//   现在真去读源码里错误分支有没有挂定时器：错误态若仍 setTimeout 淡出，才算不合格。
// ★ 2026-11-22 二次修判据（S6 收敛后暴露的假通过）：
//   toast 已收敛到 assets/toast.js，页面里不再有 `function toast`，
//   旧实现只认页面内定义 ⇒ 8 间房全被 `continue` 跳过 ⇒ 报出「0/0 间房，全部可回看」。
//   这是「测不到」被当成「通过」。现在分两路取证：
//     A. 页面内自带 toast 实现 → 读它的错误分支有没有提前 return（不设定时器）
//     B. 页面改为委托共享实现 → 读共享文件里错误分支是否常驻，并且页面确实引用了它
//   两路都拿不到证据 → 记入 unknown，绝不判 PASS。
// ★ 2026-11-22 修：原来「读到第一个含 function toast( 的 .js 就 return」——
//   实测 assets 里有多个 js 时（shared.js / toast.js），readdir 顺序决定取到哪个，
//   取到不含 history 的那个就会把 S8 误判成「没有记录容器」。
//   现在优先取文件名含 toast 的；找不到再退回「含 toast 定义且最像实现（有 onclick/err）」的。
const sharedToastSrc = (() => {
  const dir = join(PUB, 'assets');
  if (!existsSync(dir)) return '';
  const jsFiles = readdirSync(dir).filter((f) => /\.js$/.test(f) && !/\.bak/.test(f));
  const pick = (f) => readFileSync(join(dir, f), 'utf8');
  const named = jsFiles.filter((f) => /toast/i.test(f)).find((f) => /function\s+toast\s*\(/.test(pick(f)));
  if (named) return pick(named);
  const cands = jsFiles.filter((f) => /function\s+toast\s*\(/.test(pick(f)));
  // 优先挑「真的是实现」的：含 onclick 或 err 分支
  const best = cands.find((f) => /onclick|['"]err['"]/.test(pick(f))) || cands[0];
  return best ? pick(best) : '';
})();
// 共享实现是否把错误态做成常驻：错误分支提前 return 且不排定时器
//
// ★★ 2026-11-23 修「窗口写死导致误报回退」：
//   原正则用 {0,400} 限制错误分支的长度。我按契约判据 5 加去重逻辑（约 700 字）后，
//   错误分支变长、`return` 落到窗口之外 ⇒ sharedSticky 变 false ⇒
//   S5 立刻把 3 间房报成「错误仍瞬态消失」，而实际行为完全没变（反而更强了）。
//   这是判据脆弱，不是产品回退。
//   修法：不再用固定字符窗口，改成**按花括号配对取整个 if 块**再判断，
//   块内有 return 且块内没有 setTimeout 才算常驻。
const sharedSticky = (() => {
  const m = /if\s*\(\s*k\s*===\s*['"]err['"]\s*\)\s*\{/.exec(sharedToastSrc);
  if (!m) return false;
  let i = sharedToastSrc.indexOf('{', m.index);
  if (i < 0) return false;
  let depth = 0, end = -1;
  for (let j = i; j < sharedToastSrc.length; j++) {
    const ch = sharedToastSrc[j];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = j; break; } }
  }
  if (end < 0) return false;
  const body = sharedToastSrc.slice(i, end + 1);
  const hasReturn = /\breturn\b\s*;?/.test(body);
  const hasTimer = /setTimeout\s*\(/.test(body);
  return hasReturn && !hasTimer;
})();

let toastOnly = [];
let stickyOk = [];
let s5Unknown = [];
for (const [room, src] of Object.entries(pagesByRoom)) {
  const errCatch = /\.catch\s*\([^)]*\)\s*=>?\s*\{?[^}]*toast\(/.test(src) || /catch[\s\S]{0,120}toast\(/.test(src);
  const errContainer = /class="[^"]*\b(error|alert)\b[^"]*"/i.test(src);
  if (!errCatch || errContainer) continue;

  const localDef = /function\s+toast\s*\(/.test(src);
  if (localDef) {
    // A：页面自带实现
    const sticky = /if\s*\(\s*(?:err|bad|kind\s*===\s*['"]bad['"])\s*\)\s*\{[\s\S]{0,220}?return\s*;?[\s\S]{0,20}?\}/.test(src);
    if (sticky) stickyOk.push(room); else toastOnly.push(room);
    continue;
  }
  // B：委托共享实现 —— 页面必须真的引用了那个文件，且共享实现错误态常驻
  const usesShared = /<script[^>]+src="[^"]*toast\.js"/.test(src);
  if (usesShared && sharedSticky) stickyOk.push(room);
  else if (usesShared) toastOnly.push(room);
  else s5Unknown.push(room);
}
const s5pass = toastOnly.length === 0 && s5Unknown.length === 0;
rec(
  'S5',
  '出错提示可回看（错误态常驻或进入可回看容器，不靠 2 秒瞬态）',
  s5pass ? 'PASS' : 'FAIL',
  s5pass
    ? `全部可回看（${stickyOk.length} 间房错误分支常驻；共享实现常驻=${sharedSticky}）`
    : (toastOnly.length ? `${toastOnly.length} 间房错误仍瞬态消失：${toastOnly.join(' / ')}` : '') +
      (s5Unknown.length ? `${s5Unknown.length} 间房取不到证据（既无本地实现也未引共享）：${s5Unknown.join(' / ')}` : '') +
      (stickyOk.length ? ` ｜ 已常驻：${stickyOk.join(' / ')}` : '')
);

// ── S8. 错误「关掉后还能不能查到」────────────────────────────
// ★ 2026-11-22 新增，因为 S5 的判据名在骗人：它叫「可回看」，实际只测「常驻」。
//   实测 toast.js 里 localStorage/history/queue 命中 0、8 页「消息」入口 0 ——
//   失败会常驻，但用户一点关闭就永久消失，除 console.error 外没有任何回看通道。
//   契约（交互契约-toast-Rev2 §A.3）的核心判据是：
//     「点关闭 → 那条记录仍在 history 里（关掉的是浮层，不是记录）」
//   现在两者是同一件事，所以这条必须单独立项测，不能靠 S5 混过去。
const histSrc = sharedToastSrc;
const hasHistoryStore = /(history|log|records|entries)\s*[:=]\s*\[|push\(\s*\{[^}]*message|localStorage|sessionStorage/.test(histSrc);
// 读取接口：必须真的定义成函数（能返回记录），不能只是出现 history 这个词。
// 实测第一版只认 `history: function` / `Notify.history` 两种写法，把
// `function history(){}` 与简写 `{ history }` 漏了；反过来又会被注释里的 history 骗过。
const histCode = histSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const hasHistoryApi =
  /(history|entries|records)\s*:\s*(function\s*\([^)]*\)|\([^)]*\)\s*=>|function\s+\w+)/.test(histCode) ||
  /function\s+(history|entries|records)\s*\([^)]*\)\s*\{/.test(histCode) ||
  /\bhistory\s*=\s*function\s*\([^)]*\)/.test(histCode) ||
  /return\s+(log|records|entries)\s*\.\s*slice\s*\(/.test(histCode);
// 页面侧：是否有「消息 / 记录」入口（按钮或链接）
// ★ 2026-11-22 修正：第一版只匹配 HTML 里的字面词（消息记录 / data-ww-history），
//   负向臂拔出来是假绿 —— 把 notify-panel.js 掏空到 14 字节、甚至把 <script> 换成
//   一句 <!-- 消息记录 --> 注释，判据照样 PASS。字面词谁都能写，它证明不了入口存在。
//   现在只认结构：页面里必须真有脚本（内联或引用的外部 .js，且文件存在、不是占位）
//   调用了 Notify.history() / Notify.count() / Notify.latest()。
const stripHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
// ★ 必须先剥注释再判调用：实测 toast.js:20 的注释里就写着「对外暴露 Notify.history() 可读」，
//   不剥注释时它被当成真实调用，把掏空面板的负向臂放过去了（同一类错今天已犯多次）。
const stripJsComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
const readsNotify = (js) => /Notify\s*\.\s*(history|count|latest)\s*\(/.test(stripJsComments(js));
const historyEntryRooms = [];
const historyEntryWhy = {};
for (const [room, rawSrc] of Object.entries(pagesByRoom)) {
  const src = stripHtmlComments(rawSrc);
  let hit = '';
  // ① 页面内联脚本自己读记录
  const inlineJs = [...src.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  if (inlineJs.some(readsNotify)) hit = 'inline';
  // ② 页面引用的外部脚本读记录（文件必须存在、且不是占位/掏空）
  if (!hit) {
    for (const m of src.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) {
      const href = m[1].split('?')[0];
      if (!/\.js$/i.test(href)) continue;
      const abs = join(PUB, href.replace(/^\/+/, ''));
      if (!existsSync(abs)) continue;
      const js = readFileSync(abs, 'utf8');
      const codeLen = js.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').replace(/\s/g, '').length;
      if (codeLen < 80) continue; // 掏空/占位脚本不算入口
      // ★ 2026-11-22 修自证循环：定义方不能算调用方。
      //   实测：toast.js 里有 `history: function(){ return log.slice(); }` 和
      //   `toast.history = Notify.history;` —— 那是**定义**，但 readsNotify 的正则
      //   把 `Notify.history` 当成调用，于是 8 页全部命中 toast.js 自己。
      //   后果：把 notify-panel.js 掏空到 14 字节，S8 照样 PASS（设计管家拔出的假绿）。
      //   判据必须区分「谁提供接口」与「谁消费接口」：提供方（sharedToastSrc 那个文件）
      //   一律排除，只认真正读记录的第三方脚本。
      const isProvider = /window\.Notify\s*=|toast\.history\s*=\s*Notify\.history/.test(js);
      if (isProvider) continue;
      if (readsNotify(js)) { hit = href; break; }
    }
  }
  if (hit) historyEntryRooms.push(room);
  else historyEntryWhy[room] = '页面无脚本读取 Notify.history/count/latest';
}
const s8Parts = [];
if (!hasHistoryStore) s8Parts.push('toast.js 没有内存记录容器（history/log/queue 均未定义）');
if (!hasHistoryApi) s8Parts.push('toast.js 没有对外读取接口（Notify.history）');
// ★ 2026-11-22 修判据过松：原来只要求「至少 1 间房有入口」就 PASS，
//   实测把 8 间房里 7 间的 script 删掉，仍然 PASS 且文案写「1 间房回看入口齐备」——
//   「齐备」这个词在撒谎。S8 的要求是 8 间房都能回看，缺一间就是缺。
const totalRooms = Object.keys(pagesByRoom).length;
const missingEntry = Object.keys(pagesByRoom).filter((r) => !historyEntryRooms.includes(r));
if (historyEntryRooms.length === 0) {
  s8Parts.push(`${totalRooms} 间房都没有真正读取记录的脚本入口（不认字面词，只认 Notify.history/count/latest 调用）`);
} else if (missingEntry.length > 0) {
  s8Parts.push(`${missingEntry.length}/${totalRooms} 间房缺回看入口：${missingEntry.join(' / ')}（其余 ${historyEntryRooms.length} 间已有）`);
}
rec(
  'S8',
  '错误关掉后仍可查（记录与浮层分离，有回看入口）',
  s8Parts.length === 0 ? 'PASS' : 'FAIL',
  s8Parts.length === 0
    ? `记录容器 + 读取接口 + ${historyEntryRooms.length} 间房回看入口齐备`
    : s8Parts.join('；') + ' → 失败信息一点关闭就永久丢失，用户回看不到原因'
);

// toast 实现是否已收敛（同一实现一处定义）
const toastSigs = {};
for (const [room, src] of Object.entries(pagesByRoom)) {
  if (!/function\s+toast/.test(src)) continue;
  const body = (src.match(/function\s+toast[\s\S]{0,400}/) || [''])[0].replace(/\s+/g, '');
  toastSigs[room] = body.length;
}
const toastPages = Object.keys(toastSigs).length;
const toastShared = /function\s+toast/.test(
  (existsSync(join(PUB, 'assets')) ? readdirSync(join(PUB, 'assets')).filter((f) => /\.(js|css)$/.test(f)).map((f) => readFileSync(join(PUB, 'assets', f), 'utf8')).join('\n') : '')
);
// ★ 2026-11-22：原说明文字把「页面里没有实现」写成「未取证」，与 PASS 自相矛盾。
//   现在说清是哪种情形：全部委托共享 / 还有几页各写一份 / 两边都没有。
const sharedFile = (() => {
  const dir = join(PUB, 'assets');
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir)) {
    if (!/\.js$/.test(f)) continue;
    if (/function\s+toast\s*\(/.test(readFileSync(join(dir, f), 'utf8'))) return f;
  }
  return null;
})();
rec(
  'S6',
  'toast 组件已收敛到共享文件（不在每页各写一份）',
  toastPages === 0 && toastShared ? 'PASS' : toastPages === 0 ? '未取证' : 'FAIL',
  toastPages === 0 && toastShared
    ? `8 个页面全部委托 assets/${sharedFile}，页面内零份实现`
    : toastPages === 0
      ? '未取证：页面里没有 toast 实现，assets/ 里也没有共享定义'
      : `共 ${toastPages} 个页面各写一份，assets/ 内共享定义=${toastShared}`
);

// ── S7. 语义色同源：共享 JS 里硬编码的颜色必须与 room.css 的 token 一致 ─────
// ★ 2026-11-22 新增。实测踩过：--danger 从 #e23c30 改成 #de4217 后，
//   toast.js:30 的 rgba(226,60,48,.45) 停在旧值 —— good 行跟上了、err 行漏了。
//   眼睛看不出来（ΔE 约 2），但这是「同一语义两处定义」的种子，今天已因此返工 6 次。
//   为什么 toast.js 不能用 var(--danger)：书房与五五客厅不引 room.css，
//   var 在那两页会失效，所以必须硬编码 —— 那就必须靠判据守住同源。
const hexToDec = (h) => {
  const s = h.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16)).join(',');
};
const SEM_TOKENS = ['--danger', '--ok', '--warn'];
const tokenDec = {};
for (const t of SEM_TOKENS) {
  const v = tokenDefs[t];
  if (v && /^#[0-9a-fA-F]{6}$/.test(v)) tokenDec[hexToDec(v)] = { token: t, hex: v };
}
const jsColorMismatch = [];
const jsColorChecked = [];
// ★ 2026-11-22 扩范围：原来只扫 assets/*.js —— 实测页面内联才是大头
//   （历史备份里 106 处旧 danger 色全在 .html 里，S7 一处都没扫到）。
//   现在扫 assets/*.{js,css} + 全部 public/*.html 的生效文件，跳过 .bak 备份。
const s7Sources = [];
const assetDir = join(PUB, 'assets');
if (existsSync(assetDir)) {
  for (const f of readdirSync(assetDir)) {
    if (!/\.(js|css)$/.test(f) || /\.bak/.test(f)) continue;
    s7Sources.push({ name: `assets/${f}`, src: readFileSync(join(assetDir, f), 'utf8') });
  }
}
for (const f of readdirSync(PUB)) {
  if (!/\.html$/.test(f) || /\.bak/.test(f)) continue;
  s7Sources.push({ name: f, src: readFileSync(join(PUB, f), 'utf8') });
}
{
  for (const { name: f, src } of s7Sources) {
    // 只取 rgba(r,g,b,...) 三元组；命中已知语义色族的才算（避免误报中性灰）
    for (const m of src.matchAll(/rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,/g)) {
      const key = `${m[1]},${m[2]},${m[3]}`;
      const r = +m[1], g = +m[2], b = +m[3];
      // ★ 2026-11-22 修误报：容差 ±40 太宽，把房色/品牌色误判成「语义色不同源」。
      //   实测 #5fada8=--download、#e0a46e=--cast、#d6a05e=--book、#c4a36e=--brass
      //   全被报成「近似 --ok / --warn」——它们本来就不该跟语义色同源。
      //   现在先排除「与任一非语义 token 完全同值」的色（房色/品牌色/中性色），
      //   再用更紧的容差（每通道 <= 12）判「近似某语义色但不同源」。
      const allTokenDec = new Set();
      for (const [k, v] of Object.entries(tokenDefs)) {
        if (!/^#[0-9a-fA-F]{6}$/.test(v)) continue;
        if (SEM_TOKENS.includes(k)) continue; // 语义色本身不排除
        allTokenDec.add(hexToDec(v));
      }
      if (allTokenDec.has(key)) continue; // 是某个房色/品牌色/中性色，与语义色无关
      // ★ 2026-11-22 第三次修：逐通道容差会漏抓。
      //   实测旧色 #e23c30=(226,60,48) vs 新 token #de4217=(222,66,23)：
      //   通道差 [4,6,25] —— 蓝通道差 25 超出容差 12，负向臂因此漏抓（判成「未取证」）。
      //   改用感知色差 ΔE76 ≤ 14 判「同一语义族的旧值」：该对 ΔE=11.62 能抓到，
      //   而房色/品牌色（#5fada8 等）ΔE 远大于 14，不会被误报。
      const de76 = (h1, h2) => {
        const toLab = (h) => {
          const [r0, g0, b0] = hex2rgb(h);
          const r = lin(r0), g = lin(g0), b = lin(b0);
          const X = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
          const Y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
          const Z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883;
          const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
          return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
        };
        const A = toLab(h1), B = toLab(h2);
        return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
      };
      const rgbToHex = (r, g, b) =>
        '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
      const curHex = rgbToHex(r, g, b);
      let near = null;
      for (const [dec, info] of Object.entries(tokenDec)) {
        const d = de76(curHex, info.hex);
        if (d <= 14 && (!near || d < near.d)) near = { dec, info, d };
      }
      if (!near) continue;
      if (key !== near.dec) {
        jsColorMismatch.push(`${f}: rgba(${key}) 近似 ${near.info.token}(${near.info.hex}=rgb(${near.dec})) 但不同源`);
      } else {
        // 去重：同一文件同一色值只记一次（实测 room.css 里 --danger 派生色出现 12 次）
        const tag = `${f}: rgba(${key}) = ${near.info.token} ✅`;
        if (!jsColorChecked.includes(tag)) jsColorChecked.push(tag);
      }
    }
  }
}
rec(
  'S7',
  '共享 JS 里的语义色与 room.css token 同源',
  jsColorMismatch.length > 0 ? 'FAIL' : jsColorChecked.length === 0 ? '未取证' : 'PASS',
  jsColorMismatch.length > 0
    ? jsColorMismatch.join('；')
    : jsColorChecked.length === 0
      ? '未取证：assets/*.js 里没找到与语义色接近的 rgba（不当作通过）'
      : jsColorChecked.join('；')
);

// ── 9. 命名契约：可见文字 vs title/aria-label 是否同词 ─────
// 只审「返回/回到客厅」这一类入口；品牌 logo（.brand）不是返回入口，必须排除，
// 否则「55 / 五五客厅首页」是合理的品牌对应，会被误报成命名不一致。
const namingIssues = [];
for (const [room, src] of Object.entries(pagesByRoom)) {
  const re = /<a\b([^>]*(?:title|aria-label)="([^"]*客厅[^"]*)"[^>]*)>([\s\S]{0,300}?)<\/a>/g;
  for (const m of src.matchAll(re)) {
    const attrs = m[1];
    if (/\bclass="[^"]*\bbrand\b/.test(attrs)) continue; // 品牌，非返回入口
    const attr = m[2];
    const span = (m[3].match(/<span[^>]*>([^<]*)<\/span>/) || [, ''])[1].trim();
    if (span && span !== attr) namingIssues.push(`${room}: 可见「${span}」/ 无障碍「${attr}」`);
  }
}
rec(
  'N1',
  '返回入口的可见文字与 title/aria-label 同词',
  namingIssues.length === 0 ? 'PASS' : 'FAIL',
  namingIssues.length === 0 ? '无' : namingIssues.slice(0, 4).join('；') + (namingIssues.length > 4 ? ` …共 ${namingIssues.length} 处` : '')
);

// 返回入口可见实例数（每页只允许 1 个可见）
const multiHome = [];
for (const [room, src] of Object.entries(pagesByRoom)) {
  const visible = (src.match(/>\s*(回客厅|客厅|返回五五客厅)\s*</g) || []).length;
  if (visible > 1) multiHome.push(`${room}=${visible}`);
}
rec(
  'N2',
  '每页只有一个可见的「回客厅」入口',
  multiHome.length === 0 ? 'PASS' : 'FAIL',
  multiHome.length === 0 ? '无重复入口' : `重复：${multiHome.join(' / ')}`
);

// ── 10. 交互契约：点击深度（首页 → 房间 → 具体内容）────────
const homeSrc = pagesByRoom['五五客厅'];
if (homeSrc) {
  // 十间房目录用 data-id 标注（早期版本用 data-room，两者都认）；统计去重后数量
  const ids = new Set();
  for (const m of homeSrc.matchAll(/data-(?:id|room)="([a-z]+)"/g)) ids.add(m[1]);
  const eleven = ['magnet', 'book', 'music', 'vod', 'download', 'library', 'notes', 'calendar', 'photos', 'cast'];
  const missing = eleven.filter((r) => !ids.has(r));
  rec(
    'N3',
    '首页直达每间房（点击深度 ≤ 2）',
    missing.length === 0 ? 'PASS' : 'FAIL',
    missing.length === 0
      ? `十间房入口齐全（命中 ${ids.size} 个 data-id）`
      : `缺 ${missing.join('/')}（命中 ${ids.size}）`
  );
} else {
  rec('N3', '首页直达每间房（点击深度 ≤ 2）', '未取证', '未找到 五五客厅.html');
}

// ── 输出 ────────────────────────────────────────────────
const fails = rows.filter((r) => r.verdict === 'FAIL');
const unknown = rows.filter((r) => r.verdict === '未取证');
const passes = rows.filter((r) => r.verdict === 'PASS');
// ★ REF = 参考项：数值照报，但不计入 FAIL（依据不足或属重构级收益）。
const refs = rows.filter((r) => r.verdict === 'REF');

// ★ 2026-11-22 加取数时刻与输入 mtime：今天因「拿到的是旧数还是新数」误判 5 次
//   （文件被别人在 16:47 改过，而我报的是改前的 6/8 与 37 处）。
//   现在每次输出都带扫描时刻 + 最新被扫文件的 mtime，任何人可直接判断数据是否过时。
const SCAN_AT = new Date();
const newestInput = (() => {
  let best = { path: '', mtime: 0 };
  const candidates = [];
  const assetDir = join(PUB, 'assets');
  if (existsSync(assetDir)) {
    for (const f of readdirSync(assetDir)) candidates.push(join(assetDir, f));
  }
  for (const f of readdirSync(PUB)) if (/\.html$/.test(f)) candidates.push(join(PUB, f));
  for (const f of candidates) {
    try {
      const st = statSync(f);
      if (st.mtimeMs > best.mtime) best = { path: f.replace(ROOT + '/', ''), mtime: st.mtimeMs };
    } catch (_) { /* 读不到就跳过，不影响主判定 */ }
  }
  return best;
})();
const fmtLocal = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

if (wantJson) {
  console.log(JSON.stringify({
    root: ROOT,
    scannedAt: SCAN_AT.toISOString(),
    newestInput: newestInput.path ? { path: newestInput.path, mtime: new Date(newestInput.mtime).toISOString() } : null,
    rows,
    summary: { pass: passes.length, fail: fails.length, unknown: unknown.length },
  }, null, 2));
} else {
  console.log(`设计契约审计 · root=${ROOT}`);
  console.log(`扫描时刻 ${fmtLocal(SCAN_AT)} · 最新输入 ${newestInput.path || '—'} @ ${newestInput.mtime ? fmtLocal(new Date(newestInput.mtime)) : '—'}`);
  console.log(`（若你的数据与此时刻不符，说明文件在那之后被改过，请重跑）`);
  console.log(`页面 ${pages.length} 个 · token ${tokenCount} 个\n`);
  for (const r of rows) {
    const mark = r.verdict === 'PASS' ? '✅' : r.verdict === 'FAIL' ? '❌'
      : r.verdict === 'REF' ? '📋' : '⚠️ ';
    console.log(`${mark} ${r.id} ${r.name}`);
    if (r.detail) console.log(`     ${r.detail}`);
  }
  console.log(`\nPASS ${passes.length} / FAIL ${fails.length} / 未取证 ${unknown.length}` +
    (refs.length ? ` / 参考 ${refs.length}` : ''));
}

process.exit(fails.length === 0 ? 0 : 1);
