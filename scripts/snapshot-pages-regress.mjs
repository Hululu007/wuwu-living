#!/usr/bin/env node
/**
 * snapshot-pages-regress.mjs —— 快照页清单完整性
 *
 * 为什么需要（2026-11-22）：
 *   `hub.mjs` 里首页与书房是「启动期读入内存」的快照页，改了不重启不生效。
 *   判据是 `/api/ping` 的 stalePages。但**清单本身可能漏**：
 *   将来若第三页改成快照却忘了登记，/api/ping 会永远说「一致」——
 *   那一页改了不生效，而所有判据全绿。这是「判据覆盖不全 = 假绿」。
 *
 * 三条判据：
 *   ① `/api/ping` 必须返回 snapshotPages（清单可读）
 *   ② 清单里每一页在 snapshot 明细里都有条目（无漏登）
 *   ③ 源码里出现的「启动期快照」读文件语句，页数必须与清单长度一致
 *      —— 用 `fs.readFileSync(<X>_FILE, 'utf8')` 作为快照特征
 *
 * 用法：node scripts/snapshot-pages-regress.mjs [--base http://127.0.0.1:8890]
 * 退出码：0 通过 / 1 有缺陷 / 2 检查器故障
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argOf = (k, d) => { const i = process.argv.indexOf(k); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const BASE = argOf('--base', 'http://127.0.0.1:8890');

const HUB = path.join(ROOT, 'hub.mjs');
if (!fs.existsSync(HUB)) { console.error(`[检查器故障] 缺文件：${HUB}`); process.exit(2); }

const getJson = (url) => new Promise((resolve) => {
  const req = http.get(url, { timeout: 8000 }, (res) => {
    let b = ''; res.on('data', (d) => { b += d; });
    res.on('end', () => { try { resolve({ ok: res.statusCode === 200, json: JSON.parse(b) }); } catch { resolve({ ok: false, json: null }); } });
  });
  req.on('error', (e) => resolve({ ok: false, json: null, err: e.message }));
  req.on('timeout', () => { req.destroy(); resolve({ ok: false, json: null, err: 'timeout' }); });
});

const problems = [];
const r = await getJson(`${BASE}/api/ping`);
if (!r.ok || !r.json) {
  console.error(`[检查器故障] /api/ping 不可达或非 JSON（${r.err || 'unknown'}）`);
  process.exit(2);
}

const pages = r.json.snapshotPages;
if (!Array.isArray(pages) || pages.length === 0) {
  problems.push('/api/ping 未返回 snapshotPages（清单不可读 → 无法判断覆盖是否完整）');
} else {
  const detail = r.json.snapshot || {};
  const missing = pages.filter((n) => !detail[n]);
  if (missing.length) problems.push(`清单登记了但明细缺失：${missing.join(' / ')}`);
  const extra = Object.keys(detail).filter((n) => !pages.includes(n));
  if (extra.length) problems.push(`明细里有清单未登记的页：${extra.join(' / ')}`);
}

// 源码特征：启动期把**整页 HTML** 读进内存。
// ★ 2026-11-22 修误判：第一版只按 `*_FILE` 命名匹配，抓到 4 个
//   （PAGE_FILE / BOOK_FILE / CONFIG_FILE / FANQIE_CACHE_FILE），
//   但后两个是 config/apps.json 与 runtime/fanqie_recommend.json —— 不是页面快照。
//   判据必须**顺着常量定义找到真实路径**，只认 `public/*.html`。
const src = fs.readFileSync(HUB, 'utf8');
const constPath = new Map();
for (const m of src.matchAll(/const\s+([A-Z][A-Z0-9_]*_FILE)\s*=\s*path\.join\(([^;]+)\);/g)) {
  const parts = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  constPath.set(m[1], parts.join('/'));
}
const snapshotReads = [...src.matchAll(/fs\.readFileSync\(\s*([A-Z][A-Z0-9_]*_FILE)\s*,\s*'utf8'\s*\)/g)]
  .map((m) => m[1])
  .filter((name) => {
    const p = constPath.get(name) || '';
    return /\.html$/.test(p); // 只认页面
  });
const uniqReads = [...new Set(snapshotReads)];
if (Array.isArray(pages) && uniqReads.length !== pages.length) {
  problems.push(`源码里有 ${uniqReads.length} 处启动期读页面（${uniqReads.join(' / ')}），但清单只登记 ${pages.length} 页 → 可能有快照页漏登`);
}

console.log(`快照页清单回归 · ${BASE}`);
console.log('─'.repeat(60));
console.log(`  /api/ping snapshotPages = ${Array.isArray(pages) ? pages.join(' / ') : '(无)'}`);
console.log(`  源码启动期读页 = ${uniqReads.join(' / ') || '(无)'}`);
console.log('─'.repeat(60));
if (problems.length) {
  console.log(`❌ 发现 ${problems.length} 处问题：`);
  for (const p of problems) console.log('   · ' + p);
  process.exit(1);
}
console.log(`✅ 清单 ${pages.length} 页与明细、与源码启动期读页数一致`);
process.exit(0);
