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
 * 上游房间（magnet / vod / music）的超时兜底：给页面里的原生 fetch 加默认超时。
 *
 * 为什么需要（2026-11-22 实测）：
 *   这三间房是反向代理的上游页面，页面里共 28 处原生 fetch（magnet 19 / vod 8 / music 1），
 *   一处超时都没有。而它们依赖的正是最容易挂起的那层（上游进程 accept 后不回包）。
 *   实测无 signal 的 fetch 对「accept 但不回包」的服务**永不返回**（12 秒仍未结束），
 *   用户看到的就是永久转圈。加超时后同一场景 8 秒准时抛 TimeoutError。
 *
 * 为什么用 monkey-patch 而不是逐处改上游源码：
 *   上游是别人的工程，改它会在上游升级时被覆盖。这里只包一层，且**可关**：
 *   `window.__WW_FETCH_TIMEOUT__ = 0` 即可退回原生行为。
 *
 * ★ 安全性前提（已实测）：这三页 EventSource / getReader / response.body 均为 0，
 *   没有流式连接，所以统一超时不会打断长连接。
 * ★ 超时与网络失败必须可区分：抛出的错误带 isTimeout 标记，
 *   否则调用方会把「上游卡住」和「网线断了」说成同一句话。
 */
export const UPSTREAM_FETCH_TIMEOUT_MS = 8000;

export const UPSTREAM_FETCH_TIMEOUT_SNIPPET = `<script data-ww-fetch-timeout>(function(){
  if (typeof window === 'undefined' || !window.fetch || typeof AbortController === 'undefined') return;
  var DEF = ${UPSTREAM_FETCH_TIMEOUT_MS};
  var orig = window.fetch;
  window.fetch = function(input, init){
    init = init || {};
    var ms = (window.__WW_FETCH_TIMEOUT__ === undefined) ? DEF : window.__WW_FETCH_TIMEOUT__;
    // 调用方自己给了 signal 或显式关掉超时 → 原样放行，不抢别人的取消权
    if (!ms || init.signal) return orig.call(this, input, init);
    var ctrl = new AbortController();
    var timer = setTimeout(function(){ ctrl.abort(); }, ms);
    var opts = {}; for (var k in init) if (Object.prototype.hasOwnProperty.call(init, k)) opts[k] = init[k];
    opts.signal = ctrl.signal;
    return orig.call(this, input, opts).then(function(r){ clearTimeout(timer); return r; },
      function(e){ clearTimeout(timer);
        if (e && e.name === 'AbortError') {
          var t = new Error('上游 ' + (ms/1000) + ' 秒无响应');
          t.name = 'TimeoutError'; t.isTimeout = true; t.timeoutMs = ms;
          throw t;
        }
        throw e;
      });
  };
})();</script>`;


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
