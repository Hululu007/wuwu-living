/**
 * 旧前端统一外壳 —— 搜磁力 / 听音乐 / 看视频
 *
 * 只套外壳，不动人家内部：
 *   ① <head> 末尾内联 legacy-shell.css 全文（不再多一次请求）+ 该房主色
 *   ② <body> 开头插统一顶栏（回客厅 / 主色圆点 / 房间名 / 右侧状态位）
 *   ③ </body> 前插统一页脚（五五客厅 · 房间名 · 数据仍是自家那一套；返回入口只在顶栏）
 *   ④ <body> 挂 class="ww-shell" data-room="<id>"
 *
 * 硬约束：不删改原有 DOM、不替换原有脚本、不动原有 CSS 选择器；
 * 上游页面取不到 / 非 HTML 时原样返回，不抛错；重复套壳（已含 ww-bar）幂等返回。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS_FILE = path.join(ROOT, 'public', 'assets', 'legacy-shell.css');

/** 房间元数据：名字、主色、自家那一套的称呼（页脚用） */
const ROOMS = {
  magnet: { name: '搜磁力', color: '#7EA6E0', sub: 'mx 多源聚合', own: '磁力搜索 mx' },
  music:  { name: '听音乐', color: '#DD7768', sub: '聆听音乐 · 网页版', own: '聆听音乐网页版' },
  vod:    { name: '看视频', color: '#A996DD', sub: '请看', own: '请看' },
};

let cssCache = null;
function readShellCss() {
  if (cssCache !== null) return cssCache;
  try {
    cssCache = fs.readFileSync(CSS_FILE, 'utf8');
  } catch {
    cssCache = '';
  }
  return cssCache;
}

/** 给标签属性串里补一个 class（已存在则不重复） */
function addClassToAttrs(attrs, cls) {
  const m = /\sclass="([^"]*)"/i.exec(attrs);
  if (m) {
    const existing = m[1].trim();
    if (existing.split(/\s+/).includes(cls)) return attrs;
    return attrs.replace(m[0], ` class="${existing} ${cls}"`);
  }
  return `${attrs} class="${cls}"`;
}

/** 给标签属性串里补一个 data-* 属性 */
function setDataAttrToAttrs(attrs, key, value) {
  const re = new RegExp(`\\s${key}="[^"]*"`, 'i');
  if (re.test(attrs)) return attrs.replace(re, ` ${key}="${value}"`);
  return `${attrs} ${key}="${value}"`;
}

/**
 * 套统一外壳。
 * @param {string} html 上游 HTML 文本（可能已经过 hub 的磁力/视频注入）
 * @param {string} roomId 'magnet' | 'music' | 'vod'
 * @param {{sub?:string, own?:string, status?:string}} [opts] 覆盖副标题 / 自家称呼 / 右侧状态位文案
 * @returns {string} 注入后的 HTML；不可注入时原样返回
 */
export function applyShell(html, roomId, opts = {}) {
  // 取不到 / 非字符串：原样返回，不抛错
  if (typeof html !== 'string' || html.length === 0) return html;
  const room = ROOMS[roomId];
  if (!room) return html;

  // 非 HTML（JSON / 纯文本 / 空响应）：原样返回
  const head = html.slice(0, 4096);
  if (!/<html[\s>]|<!doctype html/i.test(head) && !/<body[\s>]/i.test(head)) return html;

  // 幂等：已经套过外壳（hub 可能重复转发 / 多次调用），不再重复注入
  if (/class="[^"]*ww-shell|data-ww-bar/i.test(html)) return html;

  const sub = opts.sub || room.sub;
  const own = opts.own || room.own;
  const status = opts.status || '';

  const css = readShellCss();
  const styleBlock = `<style data-ww-shell>\n${css}\n</style>`;

  const bar = [
    '<header class="ww-bar" data-ww-bar>',
    `  <a class="ww-home" href="/" title="返回五五客厅" aria-label="返回五五客厅"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M15 6l-6 6 6 6"/></svg><span>回客厅</span></a>`,
    `  <span class="ww-dot" aria-hidden="true"></span>`,
    `  <span class="ww-name">${escapeHtml(room.name)}</span>`,
    `  <span class="ww-sub">${escapeHtml(sub)}</span>`,
    `  <span class="ww-grow"></span>`,
    `  <span class="ww-acts" data-ww-status>${status ? escapeHtml(status) : ''}</span>`,
    '</header>',
  ].join('\n');

  // 全站只保留顶栏这一个返回入口，页脚不再放第二个「回客厅」
  const foot = [
    '<footer class="ww-foot" data-ww-foot>',
    `  <span>五五客厅 · ${escapeHtml(room.name)} · 数据仍是 ${escapeHtml(own)} 自己那一套</span>`,
    '</footer>',
  ].join('\n');

  let out = html;

  // ① 先按 </head> 切成 head / body 两段：注入的 <style> 只进 head，
  //    避免把 CSS 注释里出现的 <body> 字样误当成真实 body 标签。
  const headClose = /<\/head>/i.exec(out);
  let headPart, tailPart;
  if (headClose) {
    headPart = out.slice(0, headClose.index);
    tailPart = out.slice(headClose.index);
  } else if (/<head[\s>]/i.test(out)) {
    headPart = out; tailPart = '';
  } else {
    return html; // 没有 head/body 结构，保持原样
  }

  // 有 </head>：<style> 插在 head 末尾（</head> 前）；没有闭合标签就退到 <head> 开标签后
  if (headClose) {
    headPart = headPart + '\n' + styleBlock;
  } else {
    headPart = headPart.replace(/<head[^>]*>/i, (m) => `${m}\n${styleBlock}`);
  }

  // ② 只在 head 之后的正文段里找真实 <body> 标签：挂 class / data-room / 主色，开头插顶栏
  const bodyRe = /<body([^>]*)>/i;
  const bodyM = bodyRe.exec(tailPart);
  if (!bodyM) return html; // 连 body 都没有，保持原样
  let bodyAttrs = addClassToAttrs(bodyM[1], 'ww-shell');
  bodyAttrs = setDataAttrToAttrs(bodyAttrs, 'data-room', roomId);
  bodyAttrs = bodyAttrs.replace(/\sstyle="([^"]*)"/i, (m, st) => {
    const add = `--ww-a:${room.color};--ww-soft:${soft(room.color)};--ww-edge:${edge(room.color)}`;
    return ` style="${st}${st ? ';' : ''}${add}"`;
  });
  if (!/\sstyle="/i.test(bodyAttrs)) {
    bodyAttrs = `${bodyAttrs} style="--ww-a:${room.color};--ww-soft:${soft(room.color)};--ww-edge:${edge(room.color)}"`;
  }
  const newBodyTag = `<body${bodyAttrs}>`;
  tailPart = tailPart.replace(bodyRe, `${newBodyTag}\n${bar}`);

  // ③ </body> 前插页脚；没有 </body> 就追加到末尾
  if (/<\/body>/i.test(tailPart)) {
    tailPart = tailPart.replace(/<\/body>/i, `${foot}\n</body>`);
  } else {
    tailPart = tailPart + '\n' + foot;
  }

  return headPart + tailPart;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/** 主色 14% 软底 / 34% 描边（与 room.css 的 --soft/--edge 一致） */
function soft(hex) { return `${hex}24`; }
function edge(hex) { return `${hex}57`; }

export const LEGACY_ROOMS = Object.freeze(ROOMS);
