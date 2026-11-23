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
import { EMBED_DETECT_SNIPPET, EMBED_CSS } from './embed_flag.mjs';

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
  // ★ 去重补丁：上游页面自带的「回客厅」必须被收编，否则站内会出现两个返回入口。
  //   历史原因：上游靠 `body:not(.ww-shell) .mx-home{display:none}` / 只在
  //   `html[data-embedded]` 下隐藏 `#homeLink` —— 本模块恰好给 body 加了 ww-shell、
  //   独立态又没有 data-embedded，两处选择器都「反向失效」，上游按钮反而露出来。
  //   收敛规则（只在本模块注入，不改上游代码）：
  //     · 独立态：隐藏上游遗留按钮（mx-home / homeLink），只留顶栏那一个
  //     · 嵌入态：顶栏整条隐藏（见 EMBED_CSS），此时把上游按钮放回来当唯一出口
  //   `!important` 是必要的：上游用了同等优先级的 !important 与内联 style。
  const dupHomeCss = [
    '<style data-ww-dedup>',
    '/* 上游遗留的「回客厅」一律收起：本页只允许一个返回语义。',
    '   独立态由顶栏 .ww-home 提供出口；嵌入态由舞台头的 .stage-back 提供出口',
    '   （见 lib/embed_flag.mjs 的双态规则），因此两种状态下上游按钮都不该出现。',
    '   !important 必要：上游用了同等优先级的 !important，且个别按钮带内联 style。 */',
    'body.ww-shell .mx-home,',
    'body.ww-shell #homeLink,',
    'body.ww-shell a[title="返回五五客厅"]:not([data-ww-home]){',
    '  display:none!important;',
    '}',
    '/* ★ 2026-11-22 修「进得去出不来」：magnet / vod 两间房可见返回入口曾经 = 0。',
    '   这两条规则各藏各的，叠起来两头都藏：',
    '     · 上游自带 html body[data-room="magnet"].ww-shell .ww-bar{display:none!important}',
    '       （magnet-search/server.mjs:659；请看/public/index.html:97 同型用于 vod）',
    '       把顶栏整条藏掉，而客厅唯一的 <a class="ww-home"> 就在这条顶栏里；',
    '     · 本文件上面的 dedup 又把上游自己的 .mx-home 藏掉。',
    '   修法：把顶栏在这两间房重新显示，不碰上游文件。',
    '   ★ 为什么选择器要写到这个长度：上游那条特异性是「html + body[attr] + .ww-shell + .ww-bar」',
    '     = (0,1,4)。同特异性的规则谁后出现谁赢，而依赖位置不稳（本样式块会被插到',
    '     head 起始处，上游规则在其后）。所以这里用更高特异性 header.ww-bar[data-ww-bar]',
    '     加属性选择器 + 额外的 body.ww-shell[data-room] 复合条件，稳定压过上游，不看顺序。',
    '   ★ 为什么加 html:not([data-embedded])：嵌入态顶栏必须保持隐藏（出口由舞台头',
    '     .stage-back 提供）。实测独立态 bar=flex / 可见入口=1，嵌入态 bar=none / 入口=0。 */',
    'html:not([data-embedded]) body.ww-shell[data-room="magnet"] header.ww-bar[data-ww-bar],',
    'html:not([data-embedded]) body.ww-shell[data-room="vod"] header.ww-bar[data-ww-bar]{',
    '  display:flex!important;',
    '}',
    '</style>',
  ].join('');
  const styleBlock = `<style data-ww-shell>\n${css}\n${EMBED_CSS}\n</style>\n${dupHomeCss}`;

  const bar = [
    '<header class="ww-bar" data-ww-bar>',
    `  <a class="ww-home" data-ww-home href="/" title="返回五五客厅" aria-label="返回五五客厅"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M15 6l-6 6 6 6"/></svg><span>回客厅</span></a>`,
    `  <span class="ww-dot" aria-hidden="true"></span>`,
    `  <span class="ww-name">${escapeHtml(room.name)}</span>`,
    `  <span class="ww-sub">${escapeHtml(sub)}</span>`,
    `  <span class="ww-grow"></span>`,
    `  <span class="ww-acts" data-ww-status>${status ? escapeHtml(status) : ''}</span>`,
    '</header>',
    // 双保险：顶栏自身也带 data-embedded 标记（与 <html> 上的同源），CSS 可直接按栏隐藏；
    // 独立态必须移除属性（空串属性同样会命中 [data-embedded] 存在性选择器）
    '<script data-ww-bar-flag>(function(){var h=document.currentScript&&document.currentScript.previousElementSibling;if(h){if(document.documentElement.hasAttribute("data-embedded"))h.setAttribute("data-embedded","1");else h.removeAttribute("data-embedded");}})();</script>',
    // ★ 2026-11-18：嵌入态点「回客厅」不能走 href="/"——那会把客厅首页装进舞台 iframe，
    //   叠出两层客厅 / 两个返回。改为给舞台发关闭消息，由客厅自己 closeStage()。
    '<script data-ww-home-close>(function(){var a=document.querySelector("[data-ww-home]");if(!a)return;a.addEventListener("click",function(e){try{if(window.top!==window){e.preventDefault();window.parent.postMessage({type:"wuwu:close"},location.origin);}}catch(_){}});})();</script>',
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

  // 有 </head>：判定脚本先于样式进 head（早期执行，避免先闪两个入口），<style> 紧随其后；
  // 没有闭合标签就退到 <head> 开标签后
  // ★ 2026-11-22：三个 legacy 房间（magnet/music/vod）原本 0 处超时——
  //   实测 magnet 19 处、vod 8 处、music 1 处裸 fetch，后端挂起时永不返回
  //   （vod 推荐页曾出现首打 45 秒白屏）。这里统一引入全站唯一实现，
  //   并放在 head 最前，保证后续所有内联脚本都能拿到 window.wwFetch。
  // ★ 2026-11-22：只挂 script 不够。这三个 legacy 房间（magnet 19 / vod 8 / music 1 处）
  //   页面代码调的全是原生 fetch，wwFetch 挂上了却没人调 —— 超时实际没生效。
  //   现在先置接管开关再加载脚本（顺序不能反：脚本执行时读这个开关）。
  //   静态 8 页不设这个开关，它们已逐处改成 wwFetch，避免两层超时互相覆盖。
  const FETCH_TIMEOUT_TAG =
    '<script data-ww-takeover>window.__WW_FETCH_TAKEOVER__=true;</script>' +
    '<script src="/assets/fetch-timeout.js"></script>';
  if (headClose) {
    headPart = headPart + '\n' + FETCH_TIMEOUT_TAG + '\n' + EMBED_DETECT_SNIPPET + '\n' + styleBlock;
  } else {
    headPart = headPart.replace(/<head[^>]*>/i, (m) => `${m}\n${FETCH_TIMEOUT_TAG}\n${EMBED_DETECT_SNIPPET}\n${styleBlock}`);
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
