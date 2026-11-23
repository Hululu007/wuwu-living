/* ─────────────────────────────────────────────────────────────
   视频房推荐首页 · 注入脚本（由客厅内联进 /vod/ 页面）
   无框架、无外部 CDN；只操作自己的 #vr-board 子树。
   路径一律用数组 join 拼，避开页面代理对本地绝对路径的改写。
   ───────────────────────────────────────────────────────────── */
(function () {
  if (window.__vodRecsInjected) return;
  window.__vodRecsInjected = true;

  var READY = function (fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  };

  var ORIGIN = location.origin;
  var RECS_URL = ORIGIN + ['', 'api', 'vod', 'recs'].join('/');
  var IMG_BASE = ORIGIN + ['', 'api', 'vod', 'img'].join('/');

  READY(init);

  function init() {
    var viewPane = document.querySelector('#viewPane');
    var empty = document.querySelector('#empty');
    if (!viewPane) return;

    var board = document.createElement('div');
    board.id = 'vr-board';
    viewPane.insertBefore(board, viewPane.firstChild);
    if (empty) empty.style.display = 'none';

    var collapsed = false;
    function collapse() {
      if (collapsed) return;
      collapsed = true;
      board.style.display = 'none';
    }

    // 用户一旦搜索出结果（左栏出现 .item）或点开详情，就收起推荐板。
    var listBox = document.querySelector('#list');
    if (listBox && window.MutationObserver) {
      new MutationObserver(function () {
        if (listBox.querySelector('.item:not(.sk-item)')) collapse();
      }).observe(listBox, { childList: true, subtree: true });
    }
    var detailBox = document.querySelector('#detail');
    if (detailBox && window.MutationObserver) {
      new MutationObserver(function () {
        if (detailBox.style && detailBox.style.display === 'block') collapse();
      }).observe(detailBox, { attributes: true, attributeFilter: ['style'] });
    }

    renderSkeleton(board);
    load(board, empty);
  }

  function load(board, empty) {
    // ★ 2026-11-22：原先这里用裸 fetch，拿的是 8 秒默认超时，冷路径必然被砍。
    //
    // 超时值怎么定（实测，不是拍脑袋）：
    //   · 服务端 `lib/vod_recs.mjs:35` 有请求级硬预算 TOTAL_BUDGET_MS = 6000，
    //     所以这个接口的响应时间**有确定上界 6s**，不会无限拖。
    //   · 隔离实例（:19078，每次杀进程重建 runtime 造真冷）八次实测：
    //     4.821 / 5.067 / 5.121 / 5.169 / 5.181 / 5.234 / 5.312 / 5.418s
    //     最坏 5.418s —— 已经贴着 6000ms 硬预算。
    //   · 因此客户端**不能**也设 6000：实测 6s 客户端超时下冷打 5.504s 返回，
    //     只剩 0.5s 余量，任何一次上游稍慢就会被掐断，退回「要点两次」。
    //   取 12000ms：对最坏冷路径有 2.2 倍余量，同时仍是硬上限（真挂住也只转 12s，
    //   不是原来的 20s）。后端建议的 6000 不采纳，理由是它与服务端预算等值、没有余量。
    wwFetch(RECS_URL, { headers: { accept: 'application/json' }, timeout: 12000 })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || data.ok === false) {
          renderError(board, (data && data.message) || '推荐数据暂时不可用', function () {
            renderSkeleton(board);
            load(board, empty);
          });
          return;
        }
        renderBoard(board, data);
        if (empty) empty.style.display = 'none';
      })
      .catch(function (e) {
        renderError(board, '网络异常：' + (e && e.message ? e.message : e), function () {
          renderSkeleton(board);
          load(board, empty);
        });
      });
  }

  /* ───────────────────── 渲染 ───────────────────── */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  function posterUrl(pic) {
    if (!pic) return '';
    return IMG_BASE + '?u=' + encodeURIComponent(pic);
  }

  function renderIntro(board, data) {
    var intro = el('div', 'vr-intro');
    intro.appendChild(el('span', 'vr-eyebrow', 'FIVE FIVE · SCREENING ROOM'));
    intro.appendChild(el('h1', 'vr-h1', '今晚，挑一部。'));
    intro.appendChild(el('p', 'vr-sub', '多源片库，线路自己挑。挑一张海报，剩下的交给放映室。'));

    var sources = Array.isArray(data.sources) ? data.sources : [];
    var ok = sources.filter(function (s) { return s.ok; }).length;
    var total = 0;
    (Array.isArray(data.sections) ? data.sections : []).forEach(function (sec) {
      total += Number(sec.count || 0);
    });

    var stats = el('div', 'vr-stats');
    if (ok) {
      var live = el('span', 'on');
      live.appendChild(el('i'));
      live.appendChild(el('span', null, ok + ' / ' + sources.length + ' 个源在线'));
      stats.appendChild(live);
      stats.appendChild(el('span', 'sep', '/'));
    }
    if (total) stats.appendChild(el('span', null, '片库 ' + total + ' 部'));
    if (total) stats.appendChild(el('span', 'sep', '/'));
    stats.appendChild(el('span', null, '自动换源 · HLS'));
    intro.appendChild(stats);
    board.appendChild(intro);
  }

  function renderIntroSkeleton(board) {
    var intro = el('div', 'vr-intro vr-intro-skel');
    intro.appendChild(el('span', 'vr-eyebrow', 'FIVE FIVE · SCREENING ROOM'));
    intro.appendChild(el('h1', 'vr-h1', '今晚，挑一部。'));
    intro.appendChild(el('p', 'vr-sub', '正在把片库搬进来…'));
    var stats = el('div', 'vr-stats');
    stats.appendChild(el('span', null, '多源片库'));
    stats.appendChild(el('span', 'sep', '/'));
    stats.appendChild(el('span', null, '自动换源 · HLS'));
    intro.appendChild(stats);
    board.appendChild(intro);
  }

  function makeCard(it, big) {
    var card = el('div', 'vr-card');
    card.setAttribute('role', 'button');

    var poster = el('div', 'poster');
    // 首字底先铺上：图没来/取不到时也有内容，不会出现一块纯黑
    poster.appendChild(el('div', 'ph', firstChar(it.name)));
    if (it.pic) {
      var img = new Image();
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.onload = function () {
        if (img.naturalWidth > 0) {
          var ph = poster.querySelector('.ph');
          if (ph) ph.remove();
        }
      };
      var triedDirect = false;
      img.onerror = function () {
        // 第一次失败多半是代理取图失败，直接试原始地址；再失败就保留首字底
        if (!triedDirect) {
          triedDirect = true;
          img.src = it.pic;
          return;
        }
        img.remove();
      };
      img.src = posterUrl(it.pic);
      poster.appendChild(img);
    }

    if (it.score) {
      var sc = el('span', 'badge sc', String(it.score));
      poster.appendChild(sc);
    } else if (it.remarks) {
      var rm = el('span', 'badge', it.remarks);
      poster.appendChild(rm);
    }

    var meta = el('div', 'meta');
    meta.appendChild(el('div', 't', it.name));
    var sub = [it.year, it.typeName].filter(Boolean).join(' · ');
    if (it.remarks) sub = sub ? sub + ' · ' + it.remarks : it.remarks;
    meta.appendChild(el('div', 's', sub || it.sourceName || ''));

    card.appendChild(poster);
    card.appendChild(meta);

    card.addEventListener('click', function () {
      openRecsItem(it);
    });
    return card;
  }

  function firstChar(name) {
    var s = String(name || '');
    return s ? s.trim().charAt(0) : '片';
  }

  function openRecsItem(it) {
    if (typeof window.openItem !== 'function') return;
    var item = {
      name: it.name,
      year: it.year || '',
      area: it.area || '',
      type: it.typeName || '',
      remarks: it.remarks || '',
      score: it.score || '',
      blurb: '',
      pic: it.pic || '',
      sources: [{ id: it.vodId, source: it.sourceId }]
    };
    window.openItem(item, null);
  }

  function renderBoard(board, data) {
    board.innerHTML = '';
    renderIntro(board, data);

    // 顶部精选
    var featured = Array.isArray(data.featured) ? data.featured : [];
    if (featured.length) {
      var feat = el('section', 'vr-feat');
      var fh = el('div', 'vr-feat-h');
      fh.appendChild(el('span', 'dot'));
      fh.appendChild(el('h2', null, '精选'));
      fh.appendChild(el('span', 'sub', '今日热门 · 自动聚合'));
      feat.appendChild(fh);

      var ftrack = el('div', 'vr-track');
      featured.forEach(function (it) { ftrack.appendChild(makeCard(it, true)); });
      feat.appendChild(ftrack);
      board.appendChild(feat);
    }

    // 四个分区
    var sections = Array.isArray(data.sections) ? data.sections : [];
    sections.forEach(function (sec) {
      var node = el('section', 'vr-sec');
      var h = el('div', 'vr-sec-h');
      h.appendChild(el('span', 'dot'));
      h.appendChild(el('h2', null, sec.name));
      h.appendChild(el('span', 'count', '共 ' + String(sec.count || 0) + ' 部'));
      var srcs = (sec.items || []).map(function (i) { return i.sourceName; });
      var uniq = [];
      srcs.forEach(function (s) { if (uniq.indexOf(s) < 0) uniq.push(s); });
      if (uniq.length) h.appendChild(el('span', 'src', uniq.slice(0, 3).join(' / ')));
      node.appendChild(h);

      if (!sec.items || !sec.items.length) {
        node.appendChild(el('div', 'vr-empty-sec', '这个分区暂时没有数据'));
      } else {
        var row = el('div', 'vr-row');
        sec.items.forEach(function (it) { row.appendChild(makeCard(it, false)); });
        node.appendChild(row);
      }
      board.appendChild(node);
    });

    // 来源脚注
    var sources = Array.isArray(data.sources) ? data.sources : [];
    if (sources.length) {
      var ok = sources.filter(function (s) { return s.ok; });
      var bad = sources.filter(function (s) { return !s.ok; });
      var foot = el('div', 'vr-foot');
      foot.textContent = '来源 ' + ok.length + '/' + sources.length + ' 站在线' +
        (bad.length ? '：' + bad.map(function (s) { return s.name + '（' + s.error + '）'; }).join('、') : '') +
        (data.updatedAt ? ' · 更新于 ' + new Date(data.updatedAt).toLocaleString() : '');
      board.appendChild(foot);
    }
  }

  function renderSkeleton(board) {
    board.innerHTML = '';
    renderIntroSkeleton(board);
    var feat = el('section', 'vr-feat');
    var fh = el('div', 'vr-feat-h');
    fh.appendChild(el('span', 'dot'));
    fh.appendChild(el('h2', null, '精选'));
    feat.appendChild(fh);
    var ft = el('div', 'vr-track vr-skel');
    for (var i = 0; i < 6; i++) ft.appendChild(skelCard(true));
    feat.appendChild(ft);
    board.appendChild(feat);

    var names = ['电影', '电视剧', '短剧', '综艺'];
    names.forEach(function (n) {
      var sec = el('section', 'vr-sec');
      var h = el('div', 'vr-sec-h');
      h.appendChild(el('span', 'dot'));
      h.appendChild(el('h2', null, n));
      sec.appendChild(h);
      var row = el('div', 'vr-row vr-skel');
      for (var j = 0; j < 6; j++) row.appendChild(skelCard(false));
      sec.appendChild(row);
      board.appendChild(sec);
    });
  }

  function skelCard(big) {
    var c = el('div', 'vr-card' + (big ? ' vr-feat-card' : ''));
    c.appendChild(el('div', 'poster'));
    var m = el('div', 'meta');
    m.appendChild(el('div', 't'));
    m.appendChild(el('div', 's'));
    c.appendChild(m);
    return c;
  }

  function renderError(board, message, retry) {
    board.innerHTML = '';
    var box = el('div', 'vr-error');
    box.appendChild(el('div', 'big', '片'));
    box.appendChild(el('div', 'h', '推荐暂不可用'));
    box.appendChild(el('div', 's', esc(message)));
    var btn = el('button', 'vr-retry', '重试');
    btn.addEventListener('click', function () { retry(); });
    box.appendChild(btn);
    board.appendChild(box);
  }
})();
