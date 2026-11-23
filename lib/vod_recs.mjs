/**
 * 视频房推荐首页 · 服务端取数与聚合
 *
 * 只读采集站配置：/Users/wuwu/D盘/项目/请看/config/endpoints.json
 * 对 enabled 的站并发 4 拉 `?ac=videolist&pg=1`（6 秒超时、浏览器 UA），
 * 按 type_name 归到 电影 / 电视剧 / 短剧 / 综艺 四个分区，跨站挑 8 部进精选。
 *
 * 缓存：内存 + runtime/vod.json 落盘，10 分钟有效期。
 * vodRecs() 绝不抛错：取不到就 ok:false + 中文原因。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonSync } from './json_store.mjs';
import { runtimePath } from './runtime_dir.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 采集站配置。允许环境变量覆盖：隔离测试/换工程时不必改源码。
// 旧写法是写死绝对路径，导致任何隔离实例都得先 sed 改源码才能换配置——
// 实测踩过一次：副本改完仍读生产配置，测试结论完全无效。
const ENDPOINTS_FILE = process.env.WW_VOD_ENDPOINTS
  || '/Users/wuwu/D盘/项目/请看/config/endpoints.json';
const CACHE_FILE = runtimePath(ROOT, 'vod.json');
const CACHE_TTL = 10 * 60 * 1000;
// 6000 太宽容：实测 7 个采集站里有 3 个（电影天堂/量子/暴风）整站挂死，
// 每次都耗满 6 秒超时，把整轮从 ~2s 拖到 7.6–9.6s。
// 活站实测最慢 1792ms（非凡资源），2500ms 留 40% 余量足够。
const FETCH_TIMEOUT = 2500;
/* ★ 2026-11-22 补「请求级总预算」（产品管家实测 90s 无上界）。
 * 根因：原来只有**单任务**超时（每次 fetch 2500ms），但一个站要拉 3 页 + N 个类型号，
 * 并发 4 个 worker 轮转 N 个站 —— 死站越多、轮数越多，总耗时没有任何上限。
 * 更糟的是 AbortController 只保证 fetch 的**响应头**阶段可中断，
 * 已建立连接后缓慢吐数据时，r.json() 读 body 不受 signal 约束。
 * 现在：整个请求有一个硬截止时间，到点后：
 *   · 未开始的站直接跳过（标 budget-skipped，不算失败、不触发熔断）
 *   · 进行中的 fetch 由 budgetSignal 强制 abort
 * 效果：无论多少死站，这个接口的响应时间有确定上界。 */
const TOTAL_BUDGET_MS = Number(process.env.WW_VOD_BUDGET_MS || 6000);
// 站点级熔断：连续 2 次失败后 10 分钟内直接跳过，不再白等超时。
const EP_FAIL_LIMIT = 2;          // 整站 0 条（可能是内容变动）：连续 2 次才熔断
const EP_HARD_FAIL_LIMIT = 1;     // 超时/拒连（确定性故障）：1 次即熔断
const EP_COOLDOWN_MS = 10 * 60 * 1000;   // 拒连/整站不可达：确定性故障，长冷却
// ★ 2026-11-22 量化后新增：超时是**概率性抖动**，不该和拒连共用一个 10 分钟冷却。
//   实测代价：ffzy 贡献 39% 条目，一次超时被熔断 10 分钟 → 总条目 683→538（-21%），
//   而它单独测只要 1.4s 就全成功。超时给 90 秒短冷却，下一轮就能回来。
const EP_TIMEOUT_COOLDOWN_MS = 90 * 1000;
const EP_TIMEOUT_FAIL_LIMIT = 2;        // 超时连续 2 次才熔断（拒连仍 1 次）
const epBreaker = new Map(); // ep.id -> { fails, until }
const BREAKER_FILE = runtimePath(ROOT, 'vod-breaker.json');

function loadBreaker() {
  try {
    const d = JSON.parse(fs.readFileSync(BREAKER_FILE, 'utf8'));
    const now = Date.now();
    for (const [id, v] of Object.entries(d || {})) {
      if (!v) continue;
      // 两种情况都要恢复：
      //   ① 冷却期内（until > now）→ 直接跳过，不再探；
      //   ② 还没到熔断阈值（fails>0 且 until=0）→ 失败计数必须继承，
      //      否则每次重启都从 fails=0 开始，永远攒不到阈值，熔断形同不存在。
      if (v.until && v.until > now) epBreaker.set(id, v);
      else if (!v.until && (v.fails || 0) > 0) epBreaker.set(id, { fails: v.fails, until: 0 });
    }
  } catch { /* 首次运行没有这个文件：正常 */ }
}
function saveBreaker() {
  try {
    writeJsonSync(BREAKER_FILE, Object.fromEntries(epBreaker));
  } catch { /* 落盘失败不影响内存判定 */ }
}
loadBreaker();
const CONCURRENCY = 4;
const PER_SECTION_CAP = 30;
const FEATURED_COUNT = 8;
const PAGES = [1, 2, 3];
/**
 * 实测类型号映射（各站略有差异，仅在条目归类吻合时采用）：
 * 1/6-12/20 电影片类（动作/喜剧/爱情/科幻/恐怖/剧情/战争/记录片）
 * 2/13-16 连续剧类；3 综艺；4 动漫（不进四个分区）
 */
const T_SECTION = {
  1: 'movie', 6: 'movie', 7: 'movie', 8: 'movie', 9: 'movie',
  10: 'movie', 11: 'movie', 12: 'movie', 20: 'movie',
  2: 'drama', 13: 'drama', 14: 'drama', 15: 'drama', 16: 'drama',
  3: 'variety', 4: null,
};
const T_PROBE = Object.keys(T_SECTION).map(Number);

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const SECTIONS = [
  { key: 'movie', name: '电影' },
  { key: 'drama', name: '电视剧' },
  { key: 'short', name: '短剧' },
  { key: 'variety', name: '综艺' },
];

/* ───────────────────────── 分类 ───────────────────────── */

/** 剧集兜底：只认「全12集」「18集完结」这类总集数 ≤24 的；「更新至第N集」不算 */
function shortDramaFallback(remarks) {
  const s = String(remarks || '');
  const m = s.match(/全\s*(\d+)\s*集/) || s.match(/(\d+)\s*集完结/);
  if (!m) return false;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 && n <= 24;
}

/** 返回 movie / drama / short / variety / null */
function classify(typeName, remarks) {
  const t = String(typeName || '');
  if (/短剧|微短剧/.test(t)) return 'short';
  if (/综艺/.test(t)) return 'variety';
  if (/电影|片/.test(t) && !/动漫|动画片|动漫片/.test(t)) return 'movie';
  if (/剧/.test(t)) {
    if (shortDramaFallback(remarks)) return 'short';
    return 'drama';
  }
  return null;
}

function cleanText(s) {
  return String(s == null ? '' : s)
    .replace(/&nbsp;|\s+/g, ' ')
    .trim();
}

function parseScore(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : '';
}

/** 单条原始记录 → 推荐条目 */
function toItem(v, source) {
  return {
    name: cleanText(v.vod_name || v.vod_sub || ''),
    pic: cleanText(v.vod_pic || ''),
    year: cleanText(v.vod_year || ''),
    remarks: cleanText(v.vod_remarks || ''),
    score: parseScore(v.vod_score || v.vod_douban_score),
    typeName: cleanText(v.type_name || v.vod_class || ''),
    sourceName: source.name,
    sourceId: source.id,
    vodId: String(v.vod_id || ''),
  };
}

/* ───────────────────────── 取数 ───────────────────────── */

async function getList(url, budgetSignal) {
  // 单任务超时 与 请求总预算 二者任一触发即中止
  if (budgetSignal && budgetSignal.aborted) {
    const e = new Error('总预算已用尽');
    e.name = 'BudgetAbort';
    throw e;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  const onBudget = () => ctrl.abort();
  if (budgetSignal) budgetSignal.addEventListener('abort', onBudget, { once: true });
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    /* ★ 2026-11-22：`r.json()` 读 body **不受 fetch 的 signal 约束**——
     *   上游已建立连接但缓慢吐数据时，abort 只能停「发起新请求」，停不了「正在读 body」。
     *   实测后果：TOTAL_BUDGET_MS=6000 仍然出现 60.004s / 60.006s 撞 curl 上限。
     *   这里用 race 给读 body 也加硬截止：预算到点立刻抛 BudgetAbort。 */
    const j = budgetSignal
      ? await Promise.race([
          r.json(),
          new Promise((_, rej) => {
            const onAbort = () => {
              const b = new Error('总预算已用尽（读 body 阶段）');
              b.name = 'BudgetAbort';
              rej(b);
            };
            if (budgetSignal.aborted) return onAbort();
            budgetSignal.addEventListener('abort', onAbort, { once: true });
          }),
        ])
      : await r.json();
    return Array.isArray(j.list) ? j.list : [];
  } catch (e) {
    /* ★ 2026-11-22 关键区分：中止是我们自己（总预算到点），不是站点故障。
     *   若不在这一层标记，上层 .catch 会把「我们不再等」记成「站点坏了」，
     *   于是健康站也被熔断 —— 实测已发生：7 站全 breakerOpen，视频房 ok:false。 */
    if (budgetSignal && budgetSignal.aborted) {
      const b = new Error('总预算已用尽');
      b.name = 'BudgetAbort';
      throw b;
    }
    /* ★ 2026-11-22：把「为什么失败」变成可读原因。
     *   旧行为只把异常往上抛，上层 .catch 只 +1 计数、不取 message，
     *   于是 source.error 永远是空串 —— 前端拼出「电影天堂（）」空括号，
     *   用户看到条目少了 21% 却没有任何解释。 */
    const code = (e && e.cause && e.cause.code) || '';
    if (e && e.name === 'AbortError') {
      const t = new Error('超时 ' + (FETCH_TIMEOUT / 1000) + 's 无响应');
      t.name = 'FetchTimeout';
      throw t;
    }
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNRESET') {
      const c = new Error('连不上 ' + code);
      c.name = 'FetchRefused';
      throw c;
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (budgetSignal) budgetSignal.removeEventListener('abort', onBudget);
  }
}

/** 单站：pg=1..3 多页 + t=1..4 类型探测；同站同名同年去重，有海报优先 */
async function fetchEndpoint(ep, budgetSignal) {
  const br = epBreaker.get(ep.id);
  if (br && br.until && Date.now() < br.until) {
    /* ★ 2026-11-22：文案按 kind 与实际次数生成，不再统一写「连续失败」。
     *   实测不符：拒连时 fails=1 就熔断，文案却写「连续失败」，用户以为站点反复出问题，
     *   实际是它拒了一次连接。而且不带原因、不带剩余时间，前端只能显示一句含糊话。 */
    const left = Math.max(1, Math.round((br.until - Date.now()) / 1000));
    const why = br.kind === 'refused'
      ? '连不上'
      : br.kind === 'timeout'
        ? '多次超时'
        : br.kind === 'unreachable'
          ? '整站不可达'
          : '多次无数据';
    const times = br.kind === 'refused' ? '1 次' : `${br.fails || 2} 次`;
    return {
      source: {
        id: ep.id, name: ep.name, ok: false, count: 0,
        error: `${why}，${times}，暂停 ${left}s 后重试`,
        tValid: [], breakerOpen: true, breakerKind: br.kind || '', retryInMs: left * 1000,
      },
      items: [],
    };
  }
  // ★ 总预算已用尽：直接跳过这一站，**不算失败、不触发熔断**。
  //   理由：预算耗尽是我们自己不再等，不是对方站点有问题；
  //   若把它记成失败，会把好站也熔断掉，越用越少。
  if (budgetSignal && budgetSignal.aborted) {
    return {
      source: { id: ep.id, name: ep.name, ok: false, count: 0, error: '总预算用尽，本轮跳过', tValid: [], budgetSkipped: true },
      items: [],
    };
  }
  const base = `${ep.base}${ep.path}?ac=videolist`;
  const items = [];
  const seen = new Map(); // name|year -> item
  const tValid = [];
  let fatal = '';

  const add = (v) => {
    if (!v || v.vod_id == null) return;
    const sec = classify(v.type_name || v.vod_class, v.vod_remarks);
    if (!sec) return;
    const it = toItem(v, ep);
    if (!it.name) return;
    const key = it.name + '|' + it.year;
    const old = seen.get(key);
    if (old) {
      // 已有条目缺海报而新条目有海报时替换；否则保留先到的
      if (!old.pic && it.pic) {
        const idx = items.findIndex((x) => x.item === old);
        if (idx >= 0) items[idx] = { section: sec, item: it };
        seen.set(key, it);
      }
      return;
    }
    seen.set(key, it);
    items.push({ section: sec, item: it });
  };

  const tasks = [];
  let hardErr = 0;   // 硬失败次数（超时/拒连/HTTP 错）
  let timeoutErr = 0; // 其中「超时」次数（概率性抖动，单独计）
  let refuseErr = 0;  // 其中「拒连/DNS」次数（确定性故障）
  let budgetHit = false; // 总预算中止过：不是站点故障，绝不能计入熔断
  let softErr = 0;   // 软失败（回包但无有效条目）
  let allFailed = true;
  // 首个失败原因：旧代码没记，导致 source.error 恒为空串
  let firstErrMsg = '';
  const noteErr = (e) => {
    if (!e || e.name === 'BudgetAbort') return;
    if (!firstErrMsg) firstErrMsg = e.message || String(e);
    if (e.name === 'FetchTimeout') timeoutErr += 1;
    else if (e.name === 'FetchRefused') refuseErr += 1;
  };

  // 多页抓取
  for (const pg of PAGES) {
    tasks.push(
      getList(`${base}&pg=${pg}`, budgetSignal)
        .then((list) => { allFailed = false; list.forEach(add); })
        .catch((e) => { if (e && e.name === 'BudgetAbort') budgetHit = true; else { hardErr += 1; noteErr(e); } })
    );
  }

  // 类型号探测：仅当该 t 返回的条目归类与目标分区吻合时计入有效 t
  for (const t of T_PROBE) {
    const target = T_SECTION[t];
    tasks.push(
      getList(`${base}&t=${t}`, budgetSignal)
        .then((list) => {
          allFailed = false;
          if (!target) return;
          let kept = 0;
          for (const v of list) {
            if (!v || v.vod_id == null) continue;
            if (classify(v.type_name || v.vod_class, v.vod_remarks) !== target) continue;
            add(v);
            kept++;
          }
          if (kept > 0) tValid.push({ t, section: target, count: kept });
        })
        .catch((e) => { if (e && e.name === 'BudgetAbort') budgetHit = true; else { hardErr += 1; noteErr(e); } })
    );
  }

  try {
    await Promise.all(tasks);
  } catch (e) {
    fatal = e && e.name === 'AbortError' ? '超时 2.5s 无响应' : String(e.message || e);
  }
  // 每个 task 都自带 .catch()，Promise.all 永不 reject ⇒ 上面那段拿不到原因。
  // 真正的原因在各 task 的 catch 里，这里补上。
  if (!fatal && firstErrMsg) fatal = firstErrMsg;

  const ok = items.length > 0;
  // 两类失败分开处理：
  //   hard（超时/拒连）—— 确定性故障，一次就熔断，否则最坏情况 7 站全死要 2×2.5s=5s；
  //   soft（整站 0 条）—— 可能是上游内容变动，连续 2 次才熔断，避免误杀。
  // 硬失败 = **所有**请求都抛错（站点完全不可达）。
  // 不能写成 hardErr > 0：活站也可能某个 pg 失败，那样会把好站误熔断 10 分钟——
  // 实测过一次「7 站全进熔断、首页一条数据都没有」。
  const hardFail = !ok && allFailed;
  const prev = epBreaker.get(ep.id) || { fails: 0, until: 0 };
  /* ★ 2026-11-22：总预算中止 → 直接返回，**完全不写熔断表**。
   *   预算中止是我们主动不再等，不是对方站点坏了。
   *   实测教训：不区分就会把健康站一起熔断，7 站全 breakerOpen，视频房直接 ok:false。 */
  if (budgetHit && !ok) {
    return {
      source: {
        id: ep.id, name: ep.name, ok: false, count: items.length, error: '总预算用尽，本轮跳过，不计失败',
        tValid, budgetSkipped: true, breakerOpen: false,
      },
      items,
    };
  }
  if (ok) {
    if (epBreaker.delete(ep.id)) saveBreaker();
  } else {
    const fails = (prev.fails || 0) + 1;
    /* ★ 2026-11-22：三档失败分开，不再让「超时」和「拒连」共用一条路。
     *   拒连（ECONNREFUSED/DNS）是确定性故障 → 1 次熔断、10 分钟冷却；
     *   超时是概率性抖动（活站 1.4s 能成功，但 7 并发抢带宽时会踩 2.5s 线）
     *     → 连续 2 次才熔断、冷却只 90 秒；
     *   整站 0 条（回包但无内容）→ 2 次、10 分钟。
     *   量化依据：ffzy 一次超时被冻 10 分钟 = 总条目 -21%，用户零提示。 */
    // ★ 2026-11-22：**全部超时**也要算「超时类」，不能因为 allFailed 就归到 unreachable。
    //   实测：ffzy 在 7 并发抢带宽时 7 个请求全踩 2.5s 线 → allFailed=true → 旧逻辑判 unreachable
    //   → 1 次即熔断、10 分钟冷却 → 总条目 683→538（-21%），用户零提示。
    //   而「拒连」是另一回事：ECONNREFUSED 是瞬间返回，不会等满 2.5s。
    //   所以判据用「错误类型」而不是「是否全失败」：有拒连才算确定性故障。
    const isTimeout = !ok && timeoutErr > 0 && refuseErr === 0;
    const isRefused = !ok && refuseErr > 0 && items.length === 0;
    /* ★ 2026-11-22 修「未分类硬失败被当成确定性故障」：
     *   实测对照（同一个站、同一次失败，两个实例）——
     *     干净实例：kind=timeout  fails=1  until=0      → 不熔断，下一轮就重试
     *     生产实例：kind=unreachable fails=1 until=+600s → 直接冻 10 分钟
     *   差别只在于那一轮失败既不是 FetchTimeout 也不是 FetchRefused
     *   （HTTP 5xx / 解析失败 / 其它未知错误），于是落进 hardFail 兜底。
     *   「未知」不等于「确定坏了」—— 未知必须按概率性处理，2 次 / 90 秒，
     *   否则任何一次罕见错误都会让一个健康站消失 10 分钟（就是 -21% 那条）。
     *   确定性待遇只留给两类：拒连（瞬间返回，确定）与整站 0 条（回包但无内容）。 */
    const isUnknown = !ok && hardErr > 0 && !isTimeout && !isRefused;
    let limit, cooldown, kind;
    if (isRefused) { limit = EP_HARD_FAIL_LIMIT; cooldown = EP_COOLDOWN_MS; kind = 'refused'; }
    else if (isTimeout) { limit = EP_TIMEOUT_FAIL_LIMIT; cooldown = EP_TIMEOUT_COOLDOWN_MS; kind = 'timeout'; }
    else if (isUnknown) { limit = EP_TIMEOUT_FAIL_LIMIT; cooldown = EP_TIMEOUT_COOLDOWN_MS; kind = 'timeout'; }
    else { limit = hardFail ? EP_HARD_FAIL_LIMIT : EP_FAIL_LIMIT; cooldown = EP_COOLDOWN_MS; kind = hardFail ? 'unreachable' : 'soft'; }
    epBreaker.set(ep.id, {
      fails,
      until: fails >= limit ? Date.now() + cooldown : 0,
      hard: hardFail,
      kind,
    });
    saveBreaker();
  }
  /* ★ 2026-11-22 修「ok=true 却带 error」的语义矛盾（运维管家 check_semantic 抓到）。
   *   ok   = items.length > 0（有数据就算成功）
   *   fatal= 首个失败原因（部分请求超时也会有值）
   *   两者语义独立，旧代码无条件写 error: fatal ⇒ 响应里同时出现
   *   「成功」与「超时」两个互斥结论（实测：非凡资源 ok=true count=241 err=超时）。
   *   前端 vod-recs.js 只按 ok 分流，error 仅在 !ok 时渲染，所以这不是用户可见缺陷，
   *   但脏字段会污染一切下游判据（运维的语义检查、以后的监控、别人接的客户端）。
   *   规则改成：
   *     · ok=true  → error 必为空串；诊断信息另放 warn，不再冒充错误
   *     · ok=false → error 必为非空（无原因时给兜底），杜绝前端渲染出「电影天堂（）」 */
  const warn = ok && fatal ? fatal : "";
  return {
    source: {
      id: ep.id, name: ep.name, ok, count: items.length,
      error: ok ? "" : (fatal || "本轮没有取到有效条目"),
      warn, tValid,
      breakerOpen: !ok && (epBreaker.get(ep.id) || {}).until > Date.now(),
    },
    items,
  };
}

/** 并发 4 分批拉取；跨站同名同年去重，无海报条目排在尾部 */
async function fetchAll(endpoints) {
  const started = Date.now();
  /* ★ 2026-11-22 请求级总预算：到点后强制中止所有在途 fetch，并跳过未开始的站。
   * 这是「90s 无上界」的修法 —— 单任务超时管不住「站多 × 轮数多」的叠加。 */
  const budgetCtrl = new AbortController();
  const budgetTimer = setTimeout(() => budgetCtrl.abort(), TOTAL_BUDGET_MS);
  const sources = [];
  const buckets = { movie: [], drama: [], short: [], variety: [] };
  const all = [];

  let idx = 0;
  async function worker() {
    while (idx < endpoints.length) {
      const ep = endpoints[idx++];
      if (budgetCtrl.signal.aborted) {
        // 预算已尽：剩余站全部标记跳过（不触发熔断）
        sources.push({ id: ep.id, name: ep.name, ok: false, count: 0, error: '总预算用尽，本轮跳过', tValid: [], budgetSkipped: true });
        continue;
      }
      const { source, items } = await fetchEndpoint(ep, budgetCtrl.signal);
      sources.push(source);
      for (const { section, item } of items) {
        buckets[section].push(item);
        all.push({ section, item });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, endpoints.length) }, worker));
  clearTimeout(budgetTimer);

  // 跨站去重：同名同年只留一条，有海报优先，其次评分/年份
  const dedup = (list) => {
    const seen = new Map();
    for (const it of list) {
      const key = it.name + '|' + it.year;
      const old = seen.get(key);
      if (!old) {
        seen.set(key, it);
      } else if ((!old.pic && it.pic) || (old.pic === it.pic && (it.score || 0) > (old.score || 0))) {
        seen.set(key, it);
      }
    }
    return [...seen.values()];
  };

  // 排序：有海报优先、有评分优先、年份新优先
  const rank = (a, b) => {
    const ay = Number(a.year) || 0;
    const by = Number(b.year) || 0;
    const ap = a.pic ? 1 : 0;
    const bp = b.pic ? 1 : 0;
    if (bp !== ap) return bp - ap;
    if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
    return by - ay;
  };

  for (const sec of Object.keys(buckets)) {
    buckets[sec] = dedup(buckets[sec]).sort(rank);
  }

  const sections = SECTIONS.map((s) => ({
    key: s.key,
    name: s.name,
    count: buckets[s.key].length,
    items: buckets[s.key].slice(0, PER_SECTION_CAP),
  }));

  // 精选：跨区挑 8 部，优先有海报/评分/较新；分区尽量均衡
  const featured = [];
  const usedNames = new Set();
  const bySec = {};
  for (const { section, item } of all) {
    if (!item.pic) continue;
    (bySec[section] = bySec[section] || []).push(item);
  }
  for (const sec of Object.keys(bySec)) bySec[sec].sort(rank);
  const secKeys = Object.keys(bySec).sort((x, y) => bySec[y].length - bySec[x].length);
  let round = 0;
  while (featured.length < FEATURED_COUNT && secKeys.length) {
    let progressed = false;
    for (const k of secKeys) {
      const it = bySec[k][round];
      if (it && !usedNames.has(it.name)) {
        usedNames.add(it.name);
        featured.push(it);
        progressed = true;
        if (featured.length >= FEATURED_COUNT) break;
      }
    }
    round++;
    if (!progressed) break;
  }

  return { sections, featured, sources, elapsedMs: Date.now() - started };
}

/* ───────────────────────── 缓存 ───────────────────────── */

let memory = { t: 0, data: null };

function readFileCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const stat = fs.statSync(CACHE_FILE);
    if (Date.now() - stat.mtimeMs > CACHE_TTL) return null;
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeFileCache(data) {
  try {
    // 旧写法直接覆盖目标文件：进程在写入中途被杀会留下半截 JSON，
    // 下次启动 readFileCache 解析失败 → 整份推荐缓存作废。
    // writeJson 用独立临时名 + rename 原子替换，并且同步等落盘。
    writeJsonSync(CACHE_FILE, { savedAt: Date.now(), ...data });
  } catch {
    /* 落盘失败不影响内存缓存 */
  }
}

function loadEndpoints() {
  const raw = JSON.parse(fs.readFileSync(ENDPOINTS_FILE, 'utf8'));
  return (raw.endpoints || []).filter((e) => e.enabled);
}

/* ───────────────────────── 对外接口 ───────────────────────── */

/**
 * 取推荐首页数据。绝不抛错。
 * @returns {Promise<{ok:boolean, updatedAt:string, sections:Array, featured:Array,
 *   sources:Array, message?:string}>}
 */
/* ★ 2026-11-22：在途去重（single-flight）。
 *   没有它时，3 个并发冷请求会各跑一份全量采集 —— 实测一次真实失败被记成 f3，
 *   而 EP_HARD_FAIL_LIMIT=1，于是**健康站也会被并发重试打死**。
 *   前端超时后连点重试正好制造这个场景，越点越糟。
 *   写法照抄 hub.mjs 的 probe.inflight：后来者复用同一个 Promise，不新发请求。 */
let inflight = null;

export async function vodRecs() {
  const now = Date.now();

  // 1) 内存缓存
  if (memory.data && now - memory.t < CACHE_TTL) {
    return memory.data;
  }

  // 1.5) 在途去重：已有请求在跑就复用它，不重复采集
  if (inflight) return inflight;

  // 2) 文件缓存（重启后仍有数据，避免冷启动直接打采集站）
  const fc = readFileCache();
  if (fc && Array.isArray(fc.sections)) {
    const data = { ...fc, ok: true, updatedAt: new Date(fc.savedAt || now).toISOString() };
    memory = { t: now, data };
    return data;
  }

  let endpoints = [];
  try {
    endpoints = loadEndpoints();
  } catch (e) {
    return {
      ok: false,
      message: '采集站配置读取失败：' + (e.message || e),
      updatedAt: new Date().toISOString(),
      sections: SECTIONS.map((s) => ({ key: s.key, name: s.name, count: 0, items: [] })),
      featured: [],
      sources: [],
    };
  }

  if (!endpoints.length) {
    return {
      ok: false,
      message: '配置里没有启用的采集站',
      updatedAt: new Date().toISOString(),
      sections: SECTIONS.map((s) => ({ key: s.key, name: s.name, count: 0, items: [] })),
      featured: [],
      sources: [],
    };
  }

  // 真正的采集包成 single-flight：并发进来只有一个在跑，其余复用它的结果。
  const task = (async () => {
    let gathered;
    try {
      gathered = await fetchAll(endpoints);
    } catch (e) {
      return {
        ok: false,
        message: '推荐数据拉取异常：' + (e.message || e),
        updatedAt: new Date().toISOString(),
        sections: SECTIONS.map((s) => ({ key: s.key, name: s.name, count: 0, items: [] })),
        featured: [],
        sources: [],
      };
    }

    const okSources = gathered.sources.filter((s) => s.ok).length;
    const total = gathered.sections.reduce((n, s) => n + s.count, 0);
    const ok = okSources > 0 && total > 0;

    const data = {
      ok,
      message: ok
        ? ''
        : okSources === 0
          ? '所有采集站暂时不可用，请稍后重试'
          : '暂时没有拉到可分类的影片',
      updatedAt: new Date().toISOString(),
      sections: gathered.sections,
      featured: gathered.featured,
      sources: gathered.sources,
      elapsedMs: gathered.elapsedMs,
    };

    /* ★ 2026-11-22：空结果**不落盘、不写内存缓存**。
     *   实测：一轮 6 站全被预算跳过 → 0 条目 → 旧代码把它当正常结果缓存 10 分钟，
     *   用户接下来 10 分钟都看到「所有采集站暂时不可用」，而实际下一轮就能成功。
     *   空结果的正确处置是「立刻可重试」，不是「冻结」。
     *   内存里只留一个短 TTL（10s）的失败标记，避免同秒内被反复打爆。 */
    if (data.ok) {
      memory = { t: Date.now(), data };
      writeFileCache(data);
    } else {
      memory = { t: Date.now() - (CACHE_TTL - 10 * 1000), data }; // 10s 后即可重试
      // 不写文件缓存：保持上一次成功的数据在盘上（若有），比写 0 条目更有用
    }
    return data;
  })().finally(() => {
    // 只清「自己这一次」，避免把后来者的 inflight 误清
    if (inflight === task) inflight = null;
  });

  inflight = task;
  return task;
}

/** 启动预热（可选）：后台跑一次，不阻塞启动 */
export function initVodRecs() {
  vodRecs().catch(() => {});
}
