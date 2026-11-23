/* 五五客厅 · 消息回看入口（S8 契约第③条）
 *
 * 为什么单独一个文件、而不是改 8 个页面的 HTML：
 *   8 页的页脚结构并不统一（书房、投屏没有 <footer>），
 *   逐页插入要写 8 种位置，必然漂移；且页面改版会把它弄丢。
 *   这里由脚本自挂：只要页面引了 toast.js + 本文件，入口就自动出现。
 *
 * 为什么必须有这个入口（2026-11-22 实测缺口）：
 *   toast 的失败提示虽然常驻，但用户一点关闭就永久消失；
 *   除 console.error（普通用户不开控制台）没有任何回看通道。
 *   设计管家把它定为 S8：「关掉的是浮层，不是记录」。
 *
 * 判据：window.Notify.history() 能读到已关闭的错误；页面上有可见入口。
 */
(function () {
  'use strict';
  if (!window.Notify || typeof window.Notify.history !== 'function') return;

  var ID = 'ww-notify-entry';
  var PANEL = 'ww-notify-panel';

  function fmt(ts) {
    try {
      var d = new Date(ts);
      return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    } catch (_) { return ''; }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function ensureStyle() {
    if (document.getElementById(ID + '-style')) return;
    var st = document.createElement('style');
    st.id = ID + '-style';
    st.textContent =
      '#' + ID + '{position:fixed;right:14px;bottom:14px;z-index:9998;' +
        'font-family:var(--sans,system-ui);font-size:11px;letter-spacing:.04em;' +
        'padding:6px 10px;border-radius:3px;cursor:pointer;' +
        'background:var(--card,rgba(20,20,20,.86));color:var(--muted,#c9c4bb);' +
        'border:1px solid var(--edge,rgba(255,255,255,.14));}' +
      '#' + ID + '[hidden]{display:none}' +
      '#' + ID + ' b{color:var(--danger,#de4217);font-weight:600}' +
      '#' + PANEL + '{position:fixed;right:14px;bottom:48px;z-index:9999;width:min(420px,calc(100vw - 28px));' +
        'max-height:50vh;overflow:auto;padding:10px 12px;border-radius:3px;' +
        'background:var(--card,rgba(20,20,20,.96));color:var(--ink,#efe9dd);' +
        'border:1px solid var(--edge,rgba(255,255,255,.16));font-size:12px;line-height:1.6;' +
        'font-family:var(--sans,system-ui);box-shadow:0 6px 24px rgba(0,0,0,.4);}' +
      '#' + PANEL + '[hidden]{display:none}' +
      '#' + PANEL + ' h4{margin:0 0 8px;font-size:11px;letter-spacing:.1em;color:var(--muted,#c9c4bb);font-weight:500}' +
      '#' + PANEL + ' li{list-style:none;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.07)}' +
      '#' + PANEL + ' li:last-child{border-bottom:0}' +
      '#' + PANEL + ' time{color:var(--muted,#c9c4bb);margin-right:8px;font-variant-numeric:tabular-nums}' +
      '#' + PANEL + ' .empty{color:var(--muted,#c9c4bb);opacity:.75}';
    (document.head || document.documentElement).appendChild(st);
  }

  function render() {
    var list = window.Notify.history();
    var p = document.getElementById(PANEL);
    if (!p) return;
    var body = list.length
      ? '<ul>' + list.slice().reverse().map(function (it) {
          // ★ 契约判据 5：同一条失败重复 N 次只留 1 行，但要显示 ×N，
          //   否则用户以为只失败过一次。
          var times = (it.n && it.n > 1) ? ' <b style="opacity:.7">×' + it.n + '</b>' : '';
          return '<li><time>' + fmt(it.at) + '</time>' + esc(it.text) + times + '</li>';
        }).join('') + '</ul>'
      : '<div class="empty">还没有错误消息</div>';
    p.innerHTML = '<h4>消息记录（关闭提示不会删掉这里）</h4>' + body;
  }

  function syncBadge() {
    var btn = document.getElementById(ID);
    if (!btn) return;
    var n = window.Notify.count();
    btn.innerHTML = n ? '消息记录 <b>' + n + '</b>' : '消息记录';
    btn.hidden = false;
  }

  function mount() {
    ensureStyle();
    if (document.getElementById(ID)) return;

    var panel = document.createElement('div');
    panel.id = PANEL;
    panel.hidden = true;
    panel.setAttribute('role', 'log');
    panel.setAttribute('aria-live', 'polite');

    var btn = document.createElement('button');
    btn.id = ID;
    btn.type = 'button';
    btn.textContent = '消息记录';
    btn.setAttribute('aria-label', '查看消息记录');
    btn.onclick = function () {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) render();
    };

    document.body.appendChild(panel);
    document.body.appendChild(btn);
    syncBadge();

    // 有新错误时刷新角标（轮询而非改 toast.js，避免两处耦合）
    setInterval(syncBadge, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
