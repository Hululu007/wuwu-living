#!/usr/bin/env node
/**
 * semantic-color-regress.mjs —— 语义色回归锁
 *
 * 为什么需要（2026-11-22 实测）：
 *   --warn / --danger 一天内漂移了两版（#d99a2b → #cab549、#d92d20 → #de4217），
 *   没有任何判据阻止。这次改后的值恰好仍合格，纯属运气；
 *   下一次若有人改回「与房色撞色」的值，视觉上「某房间的警告」和「书房的品牌色」
 *   就分不清了 —— 而所有功能判据依然全绿。
 *
 * 两条判据：
 *   ① 语义色（ok/warn/danger）与全部房间品牌色两两 ΔE76 ≥ MIN_DELTA_E
 *      —— 「感知可分」，不是「值不相等」。
 *   ② 页面内联的 rgba(...) 若与某个语义色同值，必须与 token 同源
 *      —— 防止改 token 后内联不跟随（今天 toast.js 就漏过一处）。
 *
 * 用法：
 *   node scripts/semantic-color-regress.mjs            真项目
 *   node scripts/semantic-color-regress.mjs --root DIR 指定根
 *   node scripts/semantic-color-regress.mjs --arm=neg  负向臂（故意撞色，必须红）
 *
 * 退出码：0 = 通过；1 = 有缺陷；2 = 检查器故障
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argOf = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const ROOT = path.resolve(argOf('--root', path.join(HERE, '..')));
const ARM = process.argv.find((a) => a.startsWith('--arm='))?.split('=')[1] || 'pos';
const MIN_DELTA_E = Number(argOf('--min-de', '10'));

const CSS = path.join(ROOT, 'public', 'assets', 'room.css');
if (!fs.existsSync(CSS)) {
  console.error(`[检查器故障] 缺文件：${CSS}`);
  process.exit(2);
}

const hexToRgb = (h) => {
  let s = String(h).trim().replace(/^#/, '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  if (s.length < 6) return null;
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
};
// CIE76 ΔE（Lab 欧氏距离）。够用于「两色是否可辨」，且无需引入依赖。
const rgbToLab = ([r, g, b]) => {
  const f = (v) => { v /= 255; return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92; };
  const [R, G, B] = [f(r), f(g), f(b)];
  let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  let y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
  let z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const g2 = (v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  [x, y, z] = [g2(x), g2(y), g2(z)];
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
};
const deltaE = (a, b) => {
  const [l1, a1, b1] = rgbToLab(a);
  const [l2, a2, b2] = rgbToLab(b);
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
};

const css = fs.readFileSync(CSS, 'utf8');
const rootBlock = (css.match(/:root\s*\{([\s\S]*?)\}/) || [, ''])[1];
const vars = {};
for (const m of rootBlock.matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
  vars[m[1]] = m[2];
}
const SEMANTIC = ['ok', 'warn', 'danger'];
const ROOM_COLORS = Object.keys(vars).filter((k) => !SEMANTIC.includes(k) && !['bg', 'ink', 'muted', 'faint', 'brass'].includes(k));

const problems = [];
const rows = [];

// 负向臂：把 danger 强制改成与 music 同值，必须报红
if (ARM === 'neg') {
  if (vars.music) vars.danger = vars.music;
}

for (const sem of SEMANTIC) {
  if (!vars[sem]) { problems.push(`缺语义色 token --${sem}`); continue; }
  const semRgb = hexToRgb(vars[sem]);
  if (!semRgb) { problems.push(`--${sem} 不是合法 hex：${vars[sem]}`); continue; }
  for (const room of ROOM_COLORS) {
    const roomRgb = hexToRgb(vars[room]);
    if (!roomRgb) continue;
    const de = deltaE(semRgb, roomRgb);
    rows.push({ sem, room, de, semHex: vars[sem], roomHex: vars[room] });
    if (de < MIN_DELTA_E) {
      problems.push(`--${sem}(${vars[sem]}) 与 --${room}(${vars[room]}) ΔE=${de.toFixed(2)} < ${MIN_DELTA_E} → 人眼难分`);
    }
  }
}

// 判据②：页面内联 rgba 若与语义色同值，必须存在（同源即可，不要求改写法）
const SEM_RGB = SEMANTIC.filter((k) => vars[k]).map((k) => ({ k, rgb: hexToRgb(vars[k]) })).filter((x) => x.rgb);
const pagesDir = path.join(ROOT, 'public');
const staleInline = [];
if (fs.existsSync(pagesDir)) {
  for (const f of fs.readdirSync(pagesDir)) {
    if (!f.endsWith('.html') || f.includes('.bak')) continue;
    const src = fs.readFileSync(path.join(pagesDir, f), 'utf8');
    for (const m of src.matchAll(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/g)) {
      const rgb = [Number(m[1]), Number(m[2]), Number(m[3])];
      for (const s of SEM_RGB) {
        const de = deltaE(rgb, s.rgb);
        // 近似但不完全等于某语义色（ΔE 在 0.5~MIN 之间）→ 抄歪了
        if (de > 0.5 && de < MIN_DELTA_E) {
          staleInline.push(`${f}: rgba(${rgb.join(',')}) 近似 --${s.k}(${vars[s.k]}) 但不同值，ΔE=${de.toFixed(2)}`);
        }
      }
    }
  }
}
for (const s of staleInline) problems.push(s);

const sorted = rows.slice().sort((a, b) => a.de - b.de);
console.log(`语义色回归 · root=${ROOT} · 阈值 ΔE≥${MIN_DELTA_E}`);
console.log('─'.repeat(66));
console.log('最接近的 6 对（越小越危险）：');
for (const r of sorted.slice(0, 6)) {
  console.log(`  --${r.sem}(${r.semHex}) vs --${r.room}(${r.roomHex})  ΔE=${r.de.toFixed(2)}`);
}
console.log('─'.repeat(66));
if (problems.length) {
  console.log(`❌ 发现 ${problems.length} 处问题：`);
  for (const p of problems) console.log('   · ' + p);
  console.log('\n退出码 1 = 有硬缺陷（语义色不可辨 / 内联抄歪）');
  process.exit(1);
}
console.log(`✅ 全部 ${rows.length} 对语义色 × 房色 ΔE ≥ ${MIN_DELTA_E}；内联无抄歪（ΔE 0.5~${MIN_DELTA_E} 区间为空）`);
process.exit(0);
