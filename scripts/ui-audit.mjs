#!/usr/bin/env node
/**
 * 前端一致性体检脚本（B2 · 只读静态审计，零依赖）
 *
 * 用法：
 *   node scripts/ui-audit.mjs [--root <工程根>] [--out runtime/ui-audit.json]
 *                              [--render runtime/render-sample.json]
 *
 * 采集范围：
 *   · 客厅自有页：public/*.html（内联 <style> + style 属性 + JS 模板串里的 style="..."）
 *   · 公共样式：public/assets/room.css、legacy-shell.css、vod-recs.css
 *   · 外部 app（magnet / music / vod）：各自源码目录里的 html/css/js/mjs，单独成组
 *
 * 输出 runtime/ui-audit.json：
 *   colors / radius / spacing / fontSizes / motion / states / tokens / external
 *   每张表都标注采集方式（static-grep）；渲染采样由 --render 注入的 JSON 合并进来。
 *
 * 本脚本只读 public/**、lib/**、hub.mjs，不做任何修改。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argOf = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const OUT = path.resolve(ROOT, argOf('--out', 'runtime/ui-audit.json'));
const RENDER_FILE = argOf('--render', '');

/* ── 页面登记表 ─────────────────────────────────────────────── */
const LOCAL_PAGES = [
  { id: 'home',     route: '/',        file: '五五客厅.html', room: '首页' },
  { id: 'book',    route: '/book/',    file: '书房.html',     room: '书房' },
  { id: 'download', route: '/download/', file: '下载中心.html', room: '下载中心' },
  { id: 'library', route: '/library/', file: '媒体库.html',   room: '媒体库' },
  { id: 'notes',    route: '/notes/',   file: '笔记库.html',    room: '笔记库' },
  { id: 'calendar', route: '/calendar/', file: '追更日历.html', room: '追更日历' },
  { id: 'photos',   route: '/photos/',  file: '相册.html',     room: '相册' },
];

const SHARED_ASSETS = [
  { id: 'room.css',          file: 'assets/room.css' },
  { id: 'legacy-shell.css',  file: 'assets/legacy-shell.css' },
  { id: 'vod-recs.css',     file: 'assets/vod-recs.css' },
];

const EXTERNAL_APPS = [
  { id: 'magnet', route: '/magnet/', dir: '/Users/wuwu/D盘/magnet-search',
    files: ['server.mjs', 'mx.mjs'] },
  { id: 'music',  route: '/music/', dir: '/Users/wuwu/Doubao/chats/2026-11-16/new-chat-1/聆听音乐网页版',
    files: ['index.html', 'server.mjs'] },
  { id: 'vod',    route: '/vod/', dir: '/Users/wuwu/D盘/项目/请看',
    files: ['public/index.html', 'server.mjs'] },
];

/* ── 基础正则 ──────────────────────────────────────────────── */
const HEX_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
const RGB_RE = /rgba?\(\s*\d{1,3}[^)]*\)/g;
const DECL_RE = /([a-z-]+)\s*:\s*([^;}]+)/g;
const DURATION_RE = /[\d.]+(?:ms|s)\b/g;
const LENGTH_RE = /-?[\d.]+(?:px|rem|em|vh|vw|%)\b/g;
const EASING_RE = /(cubic-bezier\([^)]*\)|linear|ease(?:-in|-out|-in-out)?)/g;

function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

/** 从 HTML/源码里抠出可统计的 CSS 文本：<style> 块 + style="..." 属性（含 JS 模板串） */
function extractCssText(src) {
  const blocks = [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  const attrs = [...src.matchAll(/style=["']([^"']+)["']/g)].map((m) => m[1]);
  return { blocks: blocks.join('\n'), attrs: attrs.join('\n'), css: blocks.join('\n') + '\n' + attrs.join('\n') };
}

function hexToRgb(hex) {
  let h = hex.slice(1).toLowerCase();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const a = h.length === 8;
  const n = parseInt(h.slice(0, 6), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, alpha: a ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
}

/** 颜色粗分类（用于报告里「同语义多值」归组） */
function classifyColor(hex) {
  const { r, g, b } = hexToRgb(hex);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b);
  const sat = max === 0 ? 0 : (max - min) / max;
  if (sat < 0.09) {
    if (lum < 60) return 'dark-bg';
    if (lum > 185) return 'light-ink';
    return 'muted-gray';
  }
  if (r > g && r > b && g < 130 && b < 130) return 'danger';
  if (r >= g && g > b && r < 230 && b < 170) return 'warn-warm';
  if (g > r && g > b) return 'ok-green';
  if (b > r && b > g) return 'blue-purple';
  return 'accent-other';
}

/** 统计一份 CSS 文本里的色值 / 圆角 / 间距 / 字号 / 动效 */
function auditCss(css) {
  const colors = new Map();
  const rgbLiterals = new Map();
  const radius = new Map();
  const padding = new Map();
  const margin = new Map();
  const fontSize = new Map();
  const durations = new Map();
  const easings = new Map();
  const transitionDecls = [];
  const animationDecls = [];

  for (const m of css.matchAll(HEX_RE)) {
    const hex = m[0].toLowerCase();
    colors.set(hex, (colors.get(hex) || 0) + 1);
  }
  for (const m of css.matchAll(RGB_RE)) {
    const v = m[0].replace(/\s+/g, '');
    rgbLiterals.set(v, (rgbLiterals.get(v) || 0) + 1);
  }

  for (const m of css.matchAll(DECL_RE)) {
    const prop = m[1].toLowerCase();
    const val = m[2].trim();
    if (prop === 'border-radius') bump(radius, val);
    else if (prop === 'padding') bump(padding, val);
    else if (prop === 'margin') bump(margin, val);
    else if (prop === 'font-size') bump(fontSize, val);
    else if (prop === 'transition' || prop === 'transition-property' || prop.startsWith('transition-')) {
      transitionDecls.push(val);
      collectMotion(val, durations, easings);
    } else if (prop === 'animation' || prop === 'animation-name' || prop.startsWith('animation-')) {
      animationDecls.push(val);
      collectMotion(val, durations, easings);
    }
  }

  // 单值长度 token（padding/margin 拆开后便于看档位分布）
  const padTokens = new Map(), marginTokens = new Map();
  for (const m of css.matchAll(/padding\s*:\s*([^;}]+)/g)) for (const t of m[1].matchAll(LENGTH_RE)) bump(padTokens, t[0]);
  for (const m of css.matchAll(/margin\s*:\s*([^;}]+)/g)) for (const t of m[1].matchAll(LENGTH_RE)) bump(marginTokens, t[0]);

  return {
    hex: mapToArr(colors),
    rgb: mapToArr(rgbLiterals),
    radius: mapToArr(radius),
    padding: mapToArr(padding),
    margin: mapToArr(margin),
    paddingTokens: mapToArr(padTokens),
    marginTokens: mapToArr(marginTokens),
    fontSize: mapToArr(fontSize),
    durations: mapToArr(durations),
    easings: mapToArr(easings),
    transitionCount: transitionDecls.length,
    animationCount: animationDecls.length,
    transitionDecls: transitionDecls.slice(0, 60),
    animationDecls: animationDecls.slice(0, 60),
  };

  function bump(map, v) { map.set(v, (map.get(v) || 0) + 1); }
  function collectMotion(val, d, e) {
    for (const dm of val.matchAll(DURATION_RE)) bump(d, dm[0]);
    for (const em of val.matchAll(EASING_RE)) bump(e, em[0]);
  }
}

function mapToArr(map) {
  return [...map.entries()].map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/* ── 三态关键词静态扫描 ─────────────────────────────────────── */
const STATE_RULES = {
  empty: [
    /class=["'][^"']*\b(?:empty|empty-state|empty-mark|shelf-empty|day-empty|dlna-empty|modal-empty)\b/i,
    /暂无|还空着|还没有|没读出来|还没拉到|还没订阅|没有排期|没有发现|空着/,
  ],
  loading: [
    /class=["'][^"']*\b(?:loading|spinner|skeleton|skel)\b/i,
    /加载中|正在继续|正在打开|正在拉取|正在读取|shimmer|ww-bounce/,
  ],
  errorMarkup: [
    /class=["'][^"']*\b(?:error|err)\b/i,
  ],
  errorText: [
    /出错|失败|没连上|没读出来|抓取失败|解析失败|请求失败|删除失败|操作失败|启动请求失败|停止请求失败/,
  ],
};
const CATCH_RE = /\.catch\s*\(/g;

function auditStates(src) {
  const lines = src.split(/\r?\n/);
  const out = {
    empty: { found: false, count: 0, samples: [] },
    loading: { found: false, count: 0, samples: [] },
    errorMarkup: { found: false, count: 0, samples: [] },
    errorText: { found: false, count: 0, samples: [] },
    catchHandlers: 0,
  };

  for (const [cat, rules] of Object.entries(STATE_RULES)) {
    for (const line of lines) {
      if (rules.some((re) => re.test(line))) {
        out[cat].count++;
        if (out[cat].samples.length < 3) out[cat].samples.push(line.trim().slice(0, 120));
      }
    }
    out[cat].found = out[cat].count > 0;
  }
  out.catchHandlers = (src.match(CATCH_RE) || []).length;
  // 错误态判定：有错误专用 DOM 为「错误 UI」；仅 catch + toast/文本为「失败提示（无独立错误面板）」
  out.errorState = out.errorMarkup.found ? 'error-panel' : (out.errorText.found || out.catchHandlers > 0 ? 'catch-toast-only' : 'none');
  return out;
}

/** 解析 :root 里的 CSS 变量清单 */
function parseTokens(css) {
  const vars = [];
  const re = /--([\w-]+)\s*:\s*([^;]+);/g;
  for (const m of css.matchAll(re)) vars.push({ name: '--' + m[1], value: m[2].trim() });
  return vars;
}

/* ── 汇总一份文件 ──────────────────────────────────────────── */
function auditFile(rel, abs) {
  const src = readText(abs);
  if (src == null) return { file: rel, readable: false, css: null, states: null };
  const isCss = /\.css$/i.test(rel);
  const { blocks, attrs, css: inlineCss } = extractCssText(src);
  const css = isCss ? src : inlineCss;
  return {
    file: rel,
    readable: true,
    size: src.length,
    inlineStyleBlocks: (src.match(/<style[^>]*>/gi) || []).length,
    inlineStyleAttrs: (src.match(/style=["']/g) || []).length,
    css,
    audit: auditCss(css),
    states: auditStates(src),
    tokens: parseTokens(css),
  };
}

/* ── 主流程 ────────────────────────────────────────────────── */
const report = {
  generatedAt: new Date().toISOString(),
  root: ROOT,
  method: {
    static: 'grep/正则提取（<style> 块、style 属性、JS 模板串 style="..."）',
    render: RENDER_FILE ? `渲染采样合并自 ${RENDER_FILE}` : '未注入（--render 未提供）',
    note: '静态计数与渲染采样不一致时，以渲染采样为准；本报告 states.render 列为渲染实测。',
  },
  localPages: [],
  sharedAssets: [],
  external: [],
  rollups: null,
  renderSample: null,
};

const pub = path.join(ROOT, 'public');
for (const p of LOCAL_PAGES) {
  const f = auditFile(p.file, path.join(pub, p.file));
  f.route = p.route; f.room = p.room; f.id = p.id;
  report.localPages.push(f);
}
for (const a of SHARED_ASSETS) {
  const f = auditFile(a.file, path.join(pub, a.file));
  f.id = a.id;
  report.sharedAssets.push(f);
}

for (const app of EXTERNAL_APPS) {
  const files = [];
  for (const rel of app.files) {
    const abs = path.join(app.dir, rel);
    const f = auditFile(rel, abs);
    files.push(f);
  }
  // 外部 app 汇总：把各文件的 CSS 计数合并
  const merged = mergeAudits(files.map((f) => f.audit).filter(Boolean), files.map((f) => f.file));
  report.external.push({ id: app.id, route: app.route, dir: app.dir, files, audit: merged,
    note: '外部 app 内部样式不归客厅外壳管理；此处仅记录硬编码规模，便于边界划分。' });
}

/* 公共 CSS 变量（room.css / legacy-shell.css） */
const sharedTokenSrc = report.sharedAssets.map((a) => a.css).join('\n');
report.tokens = parseTokens(sharedTokenSrc);

/* ── 汇总 rollups（仅客厅自有页 + 公共资产） ────────────────── */
const localFiles = [...report.localPages, ...report.sharedAssets].filter((f) => f.audit);
const localLabels = localFiles.map((f) => f.room || f.id);
const localMerged = mergeAudits(localFiles.map((f) => f.audit), localLabels);
report.rollups = {
  colors: localMerged.hex,
  radius: localMerged.radius,
  padding: localMerged.padding,
  margin: localMerged.margin,
  paddingTokens: localMerged.paddingTokens,
  marginTokens: localMerged.marginTokens,
  fontSize: localMerged.fontSize,
  durations: localMerged.durations,
  easings: localMerged.easings,
  transitionCount: localMerged.transitionCount,
  animationCount: localMerged.animationCount,
  stateMatrix: report.localPages.map((p) => ({
    route: p.route, room: p.room,
    empty: p.states.empty.found, loading: p.states.loading.found,
    errorState: p.states.errorState,
    errorMarkup: p.states.errorMarkup.found, errorText: p.states.errorText.found,
    catchHandlers: p.states.catchHandlers,
    emptySamples: p.states.empty.samples, loadingSamples: p.states.loading.samples,
    errorSamples: [...p.states.errorMarkup.samples, ...p.states.errorText.samples].slice(0, 3),
  })),
};

/* 颜色分类归组（同语义多值线索） */
report.rollups.colorGroups = groupColors(report.rollups.colors);

function mergeAudits(audits, labels) {
  const buckets = ['hex', 'rgb', 'radius', 'padding', 'margin', 'paddingTokens', 'marginTokens', 'fontSize', 'durations', 'easings'];
  const merged = Object.fromEntries(buckets.map((b) => [b, new Map()]));
  let transitionCount = 0, animationCount = 0;
  audits.forEach((a, i) => {
    const label = labels ? labels[i] : null;
    for (const b of buckets) {
      for (const item of a[b]) {
        const prev = merged[b].get(item.value) || { count: 0, pages: [] };
        prev.count += item.count;
        if (label && !prev.pages.includes(label)) prev.pages.push(label);
        merged[b].set(item.value, prev);
      }
    }
    transitionCount += a.transitionCount;
    animationCount += a.animationCount;
  });
  const out = {
    ...Object.fromEntries(buckets.map((b) => [b, [...merged[b].entries()].map(([value, v]) => ({
      value, count: v.count, pages: v.pages || [],
    })).sort((x, y) => y.count - x.count || x.value.localeCompare(y.value))])),
    transitionCount, animationCount,
  };
  return out;
}

function groupColors(hexArr) {
  const groups = {};
  for (const c of hexArr) {
    const cls = classifyColor(c.value);
    (groups[cls] = groups[cls] || []).push(c);
  }
  for (const k of Object.keys(groups)) groups[k].sort((a, b) => b.count - a.count);
  return groups;
}

/* ── 渲染采样合并（可选） ───────────────────────────────────── */
if (RENDER_FILE && fs.existsSync(RENDER_FILE)) {
  try {
    report.renderSample = JSON.parse(fs.readFileSync(RENDER_FILE, 'utf8'));
  } catch (e) {
    report.renderSample = { error: String(e && e.message) };
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

/* 终端简报 */
const summary = {
  pages: report.localPages.length,
  sharedAssets: report.sharedAssets.length,
  externalApps: report.external.length,
  distinctHex: report.rollups.colors.length,
  distinctRadius: report.rollups.radius.length,
  distinctFontSize: report.rollups.fontSize.length,
  states: report.rollups.stateMatrix.map((s) => `${s.room}:${s.empty ? '空' : '—'}${s.loading ? '载' : '—'}${s.errorState === 'error-panel' ? '错' : s.errorState === 'catch-toast-only' ? '捕' : '—'}`).join(' '),
  out: OUT,
};
console.log(JSON.stringify(summary, null, 2));
