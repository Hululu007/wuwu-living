/**
 * 嵌入态标记 —— 全客厅唯一一条「返回入口」双态规则
 *
 * 规则（对九间房一致，不分旧房 / 新房 / 书房，不做逐页特例）：
 *   · 嵌入态：页面被舞台壳用 <iframe> 打开，舞台头已有自己的「‹ 客厅」按钮，
 *             页面内所有 .ww-home 一律隐藏，不允许出现第二个可见入口；
 *   · 独立态：浏览器直接访问 /<id>/ 这类地址，页面内 .ww-home 正常显示；
 *   · 判定在 <head> 早期完成（先于 body 渲染 / 首帧绘制），不会「先闪两个入口再消失」。
 *
 * 选型依据（客户端判定 window.top !== window）：
 *   · 舞台 iframe 的 src 是客厅首页脚本拼的（五五客厅.html openStage），
 *     hub.mjs / rooms.mjs 的静态响应在服务端拿不到「是不是 iframe」；
 *     改走 ?embed=1 要么动 hub.mjs（禁止），要么动首页拼装逻辑，服务端还要再判 query；
 *   · 跨域旧房（magnet/music/vod 走代理）与同源新房 / 书房，`window.top !== window`
 *     这个引用比较本身不会抛跨域错误；取不到 top 时 fail-closed 按嵌入处理。
 */

/**
 * 早期内联脚本：放在 <head> 最前，DOM/样式还没解析完就给 <html> 打 data-embedded。
 * 跨域访问失败时按嵌入处理（fail-closed，宁可藏掉页面内入口，也不许露出第二个）。
 */
export const EMBED_DETECT_SNIPPET = `<script data-ww-embed-detect>(function(){try{var e=(window.top!==window)?'1':'0';}catch(_){e='1';}if(e==='1')document.documentElement.setAttribute('data-embedded','1');})();</script>`;

/**
 * CSS 兜底：嵌入态隐藏全部页面内返回入口。
 * 选择器特异性 html[data-embedded] .ww-home = (0,2,1)，
 * 高于 shell/room.css 里的 .ww-home / .ww-bar .ww-home，不需要 !important。
 * 舞台头那个 .stage-back 在顶层文档里，不在 iframe 内，不受这条规则影响。
 */
export const EMBED_CSS = `html[data-embedded] .ww-home{display:none}`;

/**
 * 把早期判定脚本 + 兜底 CSS 注入一段房间 HTML（无 </head> 时原样返回，不抛错）。
 * 旧房 shell、新房静态页、书房共用这一个注入函数，保证规则只有一份。
 * @param {string} html
 * @returns {string}
 */
export function injectEmbedFlag(html) {
  if (typeof html !== 'string' || html.length === 0) return html;
  const headClose = /<\/head>/i.exec(html);
  if (!headClose) return html;
  const headPart = html.slice(0, headClose.index);
  const tailPart = html.slice(headClose.index);
  const block = `\n${EMBED_DETECT_SNIPPET}\n<style data-ww-embed>\n${EMBED_CSS}\n</style>`;
  return headPart + block + tailPart;
}
