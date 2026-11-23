/* 正例夹具：真的读 Notify.history() 的入口脚本 */
(function () {
  if (!window.Notify || typeof window.Notify.history !== 'function') return;
  function mount() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '消息';
    btn.onclick = function () {
      var list = window.Notify.history();
      var n = window.Notify.count();
      alert('共 ' + n + ' 条，最近：' + (list.length ? list[list.length - 1].text : '无'));
    };
    document.body.appendChild(btn);
  }
  document.addEventListener('DOMContentLoaded', mount);
})();
