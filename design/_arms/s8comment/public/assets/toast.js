/* 五五客厅 · 共享提示条（全站唯一实现）
 *
 * 2026-11-22 收敛原因（S6）：
 *   原先 8 个页面各写一份 toast —— 类名三种（err / bad / good）、
 *   成功时长四种（2200 / 2400 / 2600 / 3200）、书房里还藏着第二份 toast2，
 *   同一句"失败"在不同页面长相和行为都不一样。这里收敛成一份。
 *
 * 语义（唯一约定）：
 *   toast('已保存')                 成功：2.4 秒自动消失
 *   toast('保存失败', true)         失败：常驻，点击关闭，并写进控制台留痕
 *   toast('已发送', 'good')         同成功
 *   toast('失败', 'bad' | 'err')    同失败
 *
 * 失败必须常驻的理由：瞬态提示 = 用户永远不知道为什么失败（静默失败）。
 *
 * ★ 2026-11-22 补 S8（记录与浮层分离）：
 *   原来「点关闭」= 那条信息永久消失，除 console.error（普通用户不开控制台）
 *   没有任何回看通道 —— 常驻只是把窗口从 2.4 秒延长到「直到用户点掉」。
 *   现在：所有 err 都进内存记录 log[]，关闭只收浮层、不删记录；
 *   对外暴露 Notify.history() 可读。这是契约「关掉的是浮层，不是记录」的落地。
 */
(function () {
  'use strict';

  var SUCCESS_MS = 2400;
  var STYLE_ID = 'ww-toast-style';
  var timer = null;

  /* 错误记录：只进不出，除非调用方显式 clear。上限防止长会话无限增长。 */
  var MAX_LOG = 200;
  var log = [];

  /* 状态样式由本文件负责注入：书房这类页面不引 room.css，
     若把 err/good 交给各页 CSS，必然又出现"某页失败不变色"。 */
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent =
      '.toast.err{border-color:rgba(222,66,23,.45);color:#f0b3a9}' +
      '.toast.good{border-color:rgba(79,181,131,.45);color:#c4e4cb}' +
      '.toast.err.on{cursor:pointer;pointer-events:auto}' +
      '.toast.err.on::after{content:" · 点此关闭";opacity:.55;font-size:11px}';
    (document.head || document.documentElement).appendChild(st);
  }

  function normalize(kind) {
    if (kind === true || kind === 'bad' || kind === 'err' || kind === 'error') return 'err';
    if (kind === 'good' || kind === 'ok') return 'good';
    return '';
  }

  function toast(msg, kind) {
    ensureStyle();
    var t = document.getElementById('toast');
    var text = String(msg == null ? '' : msg);
    var k = normalize(kind);

    if (!t) {
      // 页面没有提示条时不能静默：失败进控制台，成功也留一行，便于排障。
      try { (k === 'err' ? console.error : console.log)('[toast:无元素] ' + text); } catch (_) {}
      return;
    }

    t.textContent = text;
    t.className = 'toast on' + (k ? ' ' + k : '');
    if (timer) { clearTimeout(timer); timer = null; }
    t.onclick = null;
    t.removeAttribute('title');

    if (k === 'err') {
      // ★ 先记档，再挂关闭：关掉的是浮层，记录必须留着（S8）
      log.push({ text: text, at: Date.now() });
      if (log.length > MAX_LOG) log.shift();
      t.title = '点击关闭';
      t.onclick = function () { t.className = 'toast'; t.onclick = null; };  // 只收浮层
      try { console.error('[toast] ' + text); } catch (_) {}
      return; // 失败常驻，不排定时器
    }
    timer = setTimeout(function () { t.className = 'toast'; }, SUCCESS_MS);
  }

  /* 供需要主动收起的地方调用（例如提交成功后关闭常驻错误） */
  toast.close = function () {
    if (timer) { clearTimeout(timer); timer = null; }
    var t = document.getElementById('toast');
    if (!t) return;
    t.className = 'toast';
    t.onclick = null;
  };

  /* 回看接口：返回错误记录副本（调用方改不到内部数组）。 */
  var Notify = {
    history: function () { return log.slice(); },
    count: function () { return log.length; },
    clear: function () { log = []; },
    /* 最近一条，供页面在页脚显示「N 条消息」用 */
    latest: function () { return log.length ? log[log.length - 1] : null; }
  };
  toast.history = Notify.history;
  toast.clearHistory = Notify.clear;
  window.Notify = Notify;
  window.toast = toast;
})();
