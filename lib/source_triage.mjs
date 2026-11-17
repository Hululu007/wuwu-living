#!/usr/bin/env node
/**
 * 书房搜书失败归因分类器（纯函数，无网络、无 IO、无新依赖）。
 *
 * 分类口径（与审计脚本、报告一致）：
 *  - answered    引擎成功响应且抽出 ≥1 本书（不算失败）
 *  - rule-miss   站点可连，但规则解析到 0 条 / 页面结构变更 / 解析类错误
 *  - timeout     引擎或站点超时（含 worker 10s 回收）
 *  - anti-bot    403/401/503/429、验证码、风控、Cloudflare、登录拦截页
 *  - dns         DNS 解析失败（ENOTFOUND / EAI_AGAIN / getaddrinfo）
 *  - conn-level  连接层失败（reset/refused/unreachable/aborted/EPIPE），是死源判定的叶子类
 *  - other       其余未覆盖错误
 *  - busy        引擎池繁忙/队列满（属调度抖动，不计入源失败，单独统计）
 *
 * dead-source 不在单条记录上直接判：由 `markDeadSources` 按「同一源跨关键词多次
 * 连接层失败」聚合后覆盖标注，原始叶子类保留在 `leaf` 字段以便追溯。
 */

/* ───────────────────────── 常量 ───────────────────────── */

export const REASONS = Object.freeze([
  'timeout',
  'anti-bot',
  'rule-miss',
  'dns',
  'conn-level',
  'dead-source',
  'other',
  'busy',
]);

export const REASON_LABEL = Object.freeze({
  answered: '成功响应（含空结果另计）',
  'rule-miss': '规则未命中 / 解析 0 条',
  timeout: '引擎或站点超时',
  'anti-bot': '反爬风控 / 拦截状态码',
  dns: 'DNS 解析失败',
  'conn-level': '连接层失败（reset/refused/不可达）',
  'dead-source': '死源（多次连接层失败）',
  other: '其他未分类错误',
  busy: '引擎繁忙（调度抖动，不计失败）',
});

/** 死源判定：本轮跨关键词连续 N 次连接层 / DNS 失败即标记。 */
export const DEAD_THRESHOLD = 2;

/* ───────────────────────── 文本工具 ───────────────────────── */

/** 截断错误文案到 n 字，保留用于报告与落盘。 */
export function sliceErr(text, n = 120) {
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

export function hostOf(url) {
  try {
    return new URL(String(url || '')).hostname.toLowerCase();
  } catch {
    return String(url || '').toLowerCase();
  }
}

/** 书名 + 作者归一化，用于差集去重。 */
export function bookIdentity(name, author) {
  return `${String(name || '').trim().toLowerCase()}|${String(author || '').replace(/\s+/g, '').toLowerCase()}`;
}

/* ───────────────────────── 错误特征正则 ───────────────────────── */

const DNS_RE = /ENOTFOUND|EAI_AGAIN|EAI_NONAME|getaddrinfo|name or service not known|域名解析/i;
const ANTI_BOT_RE =
  /\b403\b|\b401\b|\b503\b|\b429\b|验证码|滑块|人机验证|安全验证|风控|拦截|forbidden|captcha|cloudflare|access denied|访问被拒绝|unauthorized|请登录|登录后访问|Blocked/i;
const TIMEOUT_RE =
  /请求超时|超时（|timeout|timed out|ETIMEDOUT|任务超时|AbortError|timed-out|deadline/i;
const CONN_RE =
  /ECONNRESET|ECONNREFUSED|ECONNABORTED|EHOSTUNREACH|ENETUNREACH|EHOSTDOWN|EPIPE|socket hang up|connection refused|connection reset|connection aborted|网络错误|unreachable|broke pipe/i;
const RULE_RE = /规则|解析|HTML|JSON|书源|书单|地址为空|缺少|不是可解析|init/i;
const BUSY_RE = /繁忙|队列已满|queue (full|limit)|busy/i;

/* ───────────────────────── 单条分类 ───────────────────────── */

/**
 * 叶子分类（不含 dead-source，死源由聚合层覆盖）。
 * @param {{ok:boolean, books?:Array|number, error?:string, ms?:number}} res
 * @returns {{reason:string, leaf:string, detail:string}}
 */
export function classifyLeaf(res) {
  const ok = !!(res && res.ok);
  const books = Array.isArray(res && res.books) ? res.books.length : Number(res && res.books) || 0;
  const error = String((res && res.error) || '');

  if (ok) {
    return books > 0
      ? { reason: 'answered', leaf: 'answered', detail: `抽出 ${books} 条` }
      : { reason: 'rule-miss', leaf: 'rule-miss', detail: '站点可连但规则匹配 0 条' };
  }

  if (BUSY_RE.test(error)) return { reason: 'busy', leaf: 'busy', detail: '引擎池繁忙/队列满' };
  if (DNS_RE.test(error)) return { reason: 'dns', leaf: 'dns', detail: 'DNS 解析失败' };
  if (ANTI_BOT_RE.test(error)) return { reason: 'anti-bot', leaf: 'anti-bot', detail: '风控/拦截特征' };
  if (TIMEOUT_RE.test(error)) return { reason: 'timeout', leaf: 'timeout', detail: '请求或任务超时' };
  if (CONN_RE.test(error)) return { reason: 'conn-level', leaf: 'conn-level', detail: '连接层失败' };
  if (RULE_RE.test(error)) return { reason: 'rule-miss', leaf: 'rule-miss', detail: '解析/规则类错误' };
  return { reason: 'other', leaf: 'other', detail: '未覆盖错误' };
}

/** 连接层失败集合（含 DNS），供死源聚合判定。 */
export function isConnectionLike(error) {
  return DNS_RE.test(String(error || '')) || CONN_RE.test(String(error || ''));
}

/* ───────────────────────── 死源聚合 ───────────────────────── */

/**
 * 按源聚合跨关键词尝试结果，判定死源。
 * @param {Array<{source:string, host:string, reason:string, leaf:string, error:string, keyword:string, ms:number}>} records
 * @returns {{dead:Set<string>, bySource:Map<string, {url,host,attempts,connFails,consecutiveFails,reasons:Map<string,number>,dead,lastError}>}}
 */
export function markDeadSources(records, threshold = DEAD_THRESHOLD) {
  const bySource = new Map();
  for (const rec of records) {
    const url = String(rec.source || '');
    if (!url) continue;
    let entry = bySource.get(url);
    if (!entry) {
      entry = {
        url,
        host: rec.host || hostOf(url),
        attempts: 0,
        connFails: 0,
        ok: 0,
        reasons: new Map(),
        lastError: '',
        lastMs: 0,
      };
      bySource.set(url, entry);
    }
    entry.attempts += 1;
    const reason = rec.reason || rec.leaf || 'other';
    entry.reasons.set(reason, (entry.reasons.get(reason) || 0) + 1);
    if (reason === 'answered') entry.ok += 1;
    if (isConnectionLike(rec.error) || reason === 'conn-level' || reason === 'dns') entry.connFails += 1;
    if (rec.error) entry.lastError = String(rec.error);
    if (Number.isFinite(rec.ms)) entry.lastMs = rec.ms;
  }

  const dead = new Set();
  for (const [url, entry] of bySource) {
    // 死源：本轮 ≥threshold 次尝试全部为连接层/DNS 失败，且没有任何一次成功。
    entry.dead = entry.attempts >= threshold && entry.connFails >= threshold && entry.ok === 0;
    if (entry.dead) dead.add(url);
  }
  return { dead, bySource };
}

/** 把死源标注回记录：死源记录 reason 覆盖为 dead-source，保留 leaf。 */
export function applyDeadMarker(records, dead) {
  for (const rec of records) {
    if (dead.has(String(rec.source || '')) && rec.reason !== 'answered' && rec.reason !== 'busy') {
      rec.leaf = rec.reason;
      rec.reason = 'dead-source';
    }
  }
  return records;
}

/* ───────────────────────── 汇总 ───────────────────────── */

/**
 * 分类汇总。
 * @param {Array<{reason:string, error:string, ms:number, host:string, source:string, name:string}>} entries
 * @param {{denominator?:number, includeBusy?:boolean}} opts
 */
export function summarize(entries, opts = {}) {
  const denominator = Number(opts.denominator) || entries.length;
  const counts = Object.fromEntries(REASONS.map((r) => [r, 0]));
  const samples = Object.fromEntries(REASONS.map((r) => [r, []]));
  let answered = 0;
  for (const e of entries) {
    const reason = e.reason || 'other';
    if (reason === 'answered') answered += 1;
    if (!counts[reason]) counts[reason] = 0;
    counts[reason] += 1;
    if (samples[reason] && samples[reason].length < 3) {
      samples[reason].push({
        source: e.name || e.source,
        host: e.host || hostOf(e.source || ''),
        error: sliceErr(e.error || '', 120),
        ms: e.ms,
      });
    }
  }
  const out = {};
  for (const r of Object.keys(counts)) {
    out[r] = {
      count: counts[r],
      pct: denominator > 0 ? Math.round((counts[r] / denominator) * 10000) / 100 : 0,
      samples: samples[r],
    };
  }
  return {
    denominator,
    answered,
    failed: denominator - answered - (counts.busy || 0),
    counts: out,
  };
}
