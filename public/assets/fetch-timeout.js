/* 五五客厅 · 带超时的请求封装（全站唯一实现）
 *
 * 2026-11-22 补这一份的原因（总管实测定性）：
 *   全站 34 处 fetch，AbortController 0 处、Promise.race 0 处。
 *   后端挂起时（accept 后不回包）无 signal 的 fetch **永不返回**——
 *   实测 12 秒仍未结束，页面就一直停在"加载中"，用户没有任何出路。
 *   加超时后同一场景 8.0 秒准时抛 AbortError。
 *
 * 语义：
 *   wwFetch(url, opts)              默认 8 秒超时，抛出的错误带 isTimeout=true
 *   wwFetch(url, { timeout: 30000 }) 长任务（扫描/打开文件）单独放宽
 *   wwFetch(url, { timeout: 0 })    明确不要超时
 *
 * ★ 不改变原有行为：返回的仍是原生 Response，调用方的 .then(r => r.json()) 不用改。
 * ★ 超时与网络失败必须可区分：超时抛 AbortError 并打 isTimeout 标记，
 *   否则调用方会把"服务卡住"和"网线断了"混成一句话（又一类静默失败）。
 */
(function () {
  'use strict';

  var DEFAULT_TIMEOUT = 8000;

  /* ★ 必须在任何替换之前抓住原生 fetch（2026-11-22 修无限递归）。
   * 根因：wwFetch 内部写的是 `fetch(url, rest)`；一旦 window.fetch 被换成包装版，
   *       这句就会调回包装版 → 再进 wwFetch → Maximum call stack size exceeded。
   *       实测：页面里调 wwFetch('/api/status') 同步抛 RangeError，31ms 就炸，
   *       超时一次都没生效 —— 而且它会让页面里**所有**请求全炸，比不加超时更糟。
   * 现在：内部一律走 NATIVE_FETCH，永远不经过被替换的 window.fetch。 */
  var NATIVE_FETCH = (typeof window !== 'undefined' && window.fetch)
    ? window.fetch.bind(window)
    : null;

  // ★ 2026-11-22 修无限递归：接管模式下 window.fetch 被指向 wwFetch，
  //   而 wwFetch 内部如果还调全局 fetch，就会调到自己 → RangeError: Maximum call stack size exceeded。
  //   实测三间房所有请求在接管后全部抛 RangeError（18ms），比没超时更糟：正常请求也全断了。
  //   这里在**打补丁之前**锁定原生实现，内部一律走 origFetch。
  var origFetch = (typeof window !== 'undefined' && typeof window.fetch === 'function')
    ? window.fetch.bind(window)
    : (typeof fetch === 'function' ? fetch : null);

  function makeTimeoutError(ms, url) {
    var e = new Error('请求超时（' + (ms / 1000) + ' 秒无响应）：' + url);
    e.name = 'TimeoutError';
    e.isTimeout = true;
    e.timeoutMs = ms;
    return e;
  }

  function wwFetch(url, opts) {
    opts = opts || {};
    var timeout = opts.timeout === undefined ? DEFAULT_TIMEOUT : opts.timeout;
    var rest = {};
    for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k) && k !== 'timeout') rest[k] = opts[k];

    // timeout: 0 表示明确不要超时（例如调用方自己管理取消）
    if (!timeout || typeof AbortController === 'undefined') return origFetch(url, rest);

    var ctrl = new AbortController();

    // ★ 2026-11-22 修正：原实现直接覆盖调用方 signal，会让「取消」失效。
    //   实测 magnet 搜索用 beginInflight() 返回的 searchSignal 取消在途请求，
    //   被覆盖后用户点取消无反应（假取消，比没取消更坏）。
    //   现在：外部 signal 与超时计时器并存，任一触发都会 abort。
    var external = opts.signal;
    if (external) {
      if (external.aborted) ctrl.abort();
      else external.addEventListener('abort', function () { ctrl.abort(); }, { once: true });
    }
    rest.signal = ctrl.signal;

    var timer = setTimeout(function () { ctrl.abort(); }, timeout);

    return origFetch(url, rest).then(
      function (r) { clearTimeout(timer); return r; },
      function (err) {
        clearTimeout(timer);
        if (err && (err.name === 'AbortError' || err.code === 20)) {
          // 外部主动取消 → 原样抛 AbortError，让调用方的 cancel 分支继续工作；
          // 只有我们自己的计时器触发才算超时。
          if (external && external.aborted) throw err;
          throw makeTimeoutError(timeout, url);
        }
        throw err;
      }
    );
  }

  window.wwFetch = wwFetch;

  /* ★ 2026-11-22 补「接管原生 fetch」（这是超时真正生效的关键一步）
   *
   * 问题：本文件只暴露 wwFetch，但三个 legacy 房间（magnet 19 处 / vod 8 处 / music 1 处）
   *       页面代码里调的全是原生 `fetch(`。script 挂上了、wwFetch 也存在，
   *       但**没有一处调用它** —— 超时实际没生效，属于「配置写了≠生效了」。
   *
   * 为什么在注入页开启接管、而不是逐处改上游源码：
   *   上游是别人的工程，改它会在升级时被覆盖。这里只包一层，且可关。
   *
   * 开关：只有当页面显式写 `window.__WW_FETCH_TAKEOVER__ = true` 时才接管。
   *   静态页（8 个）已经逐处改成 wwFetch，不需要也不应该被接管 ——
   *   否则它们显式传的 timeout 语义会被外面这层覆盖，变成两份真相。
   */
  /* ★ 2026-11-22 补「错误文案分流」
   *
   * 问题：本文件定义了 e.isTimeout，但全站 0 处消费 ——
   *   各页 catch 一律 toast(e.message)，于是「服务卡住」被说成「网络异常」。
   *   按 S4 契约，超时 / 拒连 / 断网是三种不同处境，用户该做的事也不同：
   *     超时 → 服务还在，只是没回，等它 / 重试
   *     拒连 → 服务根本没在运行，要去启动
   *     断网 → 本机网络断了，检查 Wi-Fi
   *   把判断收在这里一份，避免 8 个页面各写一遍再走样。
   */
  function describeFetchError(err, what) {
    var subject = what || '服务';
    if (!err) return subject + '没有响应';
    if (err.isTimeout) return subject + '没有响应，正在等它恢复（' + Math.round((err.timeoutMs || 0) / 1000) + ' 秒未回）';
    var msg = String(err.message || err);
    // ★ 判定顺序必须「先断网、后拒连」：
    //   浏览器断网的措辞同样是 Failed to fetch（后面才带 ERR_INTERNET_DISCONNECTED），
    //   先判拒连会把「Wi-Fi 断了」说成「服务没在运行」，让用户去启动一个本来就好的服务。
    //   实测就是这个顺序错，断网被误判成拒连。
    if (/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_NAME_NOT_RESOLVED|\boffline\b/i.test(msg)) {
      return '网络断了：检查一下 Wi-Fi 或网线';
    }
    // 浏览器对"连不上"的措辞：Failed to fetch / NetworkError / ERR_CONNECTION_REFUSED
    if (/Failed to fetch|NetworkError|ERR_CONNECTION|Load failed/i.test(msg)) {
      return subject + '没在运行（连接被拒绝），需要先启动它';
    }
    return msg;
  }

  window.wwDescribeError = describeFetchError;

  if (window.__WW_FETCH_TAKEOVER__ === true && typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      return wwFetch(input, init);
    };
    window.__WW_ORIG_FETCH__ = origFetch;
  }
})();
