#!/usr/bin/env node
/**
 * 超时分级与失败降权调度模块（纯内存 + 落盘状态，不依赖 HTTP 服务）。
 *
 * 职责：
 *  1. 分级超时预算：info / toc / content 三档默认 8s / 10s / 8s；已知慢源可按阶段放宽；
 *     单次打开总预算 12s 硬上限（remainingBudget 据此裁剪）。
 *  2. 分阶段健康记录：成功/失败计数、耗时样本（P50）、最近时间，14 天 TTL；
 *     连续失败 ≥3 次进入 24h 降权名单，到期自动恢复；原子写、串行化队列、永不抛异常。
 *  3. 排序：健康分（成功率 0.6 + 速度 0.4）+ P50 + 降权惩罚，返回新数组不改入参。
 *  4. 换源判定：失败/超时立即换；成功但耗时超阶段 P50 的 1.5 倍也换。
 *
 * 落盘文件：runtime/book_open_health.json（与 hub.mjs 现有同名文件兼容读取旧 schema）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimePath } from './runtime_dir.mjs';

/* ───────────────────────── 常量与配置 ───────────────────────── */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEALTH_PATH = runtimePath(ROOT, 'book_open_health.json');

export const STAGES = Object.freeze(['info', 'toc', 'content']);

/** 默认分级超时表（毫秒），对应引擎 opts.timeoutMs。 */
export const DEFAULT_BUDGET = Object.freeze({ info: 8000, toc: 10000, content: 8000 });

/** 单次打开总预算硬上限（毫秒）。任何阶段预算与已消耗耗时之和不得超过它。 */
export const TOTAL_OPEN_BUDGET = 12000;

/** 健康记录 TTL：14 天。 */
export const HEALTH_TTL_MS = 14 * 24 * 3600 * 1000;
/** 降权窗口：连续失败 ≥ FAIL_THRESHOLD 后降权 24h，到期自动恢复。 */
export const DEPRIORITIZE_WINDOW_MS = 24 * 3600 * 1000;
export const FAIL_THRESHOLD = 3;

/** 速度归一化基准：P50 ≤ 1.5s 视为满分速度。 */
const SPEED_BASELINE_MS = 1500;
/** 速度权重 / 成功率权重（健康分公式：0.6·rate + 0.4·speed）。 */
const W_RATE = 0.6;
const W_SPEED = 0.4;
/** 降权源得分惩罚系数（不永久排除，仅排后）。 */
const DEPRIORITIZE_PENALTY = 0.25;
/** 无记录冷启动源的中性得分。 */
const COLD_SCORE = 0.3;
/** 新鲜度：24h 内有记录为 1，否则按 0.6 衰减。 */
const FRESH_WINDOW_MS = 24 * 3600 * 1000;
/** 每阶段保留的成功耗时样本数（用于 P50）。 */
const SAMPLE_LIMIT = 20;

/**
 * 已知慢源分级放宽表（按归一化主机名匹配）。
 * 示例：tpyyc 实测 info 偏慢（avgMs ≈ 1.5s），info 阶段放宽到 10s；
 * 放宽后仍受 TOTAL_OPEN_BUDGET 12s 总硬上限裁剪。
 */
const SLOW_SOURCE_OVERRIDES = Object.freeze({
  'www.tpyyc.com': { info: 10000 },
});

/* ───────────────────────── 内部状态 ───────────────────────── */

let cache = null;
let writeChain = Promise.resolve();
let healthPath = HEALTH_PATH;
/** 时钟注入点：测试可替换为可控时间，生产为 Date.now()。 */
let nowFn = () => Date.now();

/** 测试用：替换落盘路径并清空缓存。 */
export function __setHealthPath(p) {
  healthPath = p || HEALTH_PATH;
  cache = null;
}

/* ───────────────────────── 工具函数（全部不抛异常） ───────────────────────── */

function now() {
  try {
    return nowFn();
  } catch {
    return Date.now();
  }
}

/** 测试用：注入时钟。fn 不传则恢复系统时钟。 */
export function __setClock(fn) {
  nowFn = typeof fn === 'function' ? fn : () => Date.now();
}

/** 测试用：清空内存缓存（不删文件）。 */
export function __reset() {
  cache = null;
}

/** 测试用：等待串行化写队列排空。 */
export function __drain() {
  return writeChain;
}

/**
 * 归一化源标识：去协议、去锚点、去尾斜杠、转小写；保留主机 + 路径。
 * 同一源在 http/https、带不带尾斜杠、带不带 #锚点 之间视为同一记录。
 */
export function normalizeId(sourceId) {
  let id = String(sourceId == null ? '' : sourceId).trim();
  if (!id) return '';
  id = id.split('#')[0];
  id = id.replace(/^[a-z]+:\/\//i, '');
  id = id.replace(/\/+$/, '');
  return id.toLowerCase();
}

/** 从候选对象提取源标识，兼容 id / sourceId / url / bookSourceUrl / origin 字段。 */
function idOf(candidate) {
  if (!candidate) return '';
  return normalizeId(
    candidate.sourceId ?? candidate.bookSourceUrl ?? candidate.url ?? candidate.id ?? candidate.origin ?? ''
  );
}

function hostOf(sourceId) {
  const id = normalizeId(sourceId);
  const slash = id.indexOf('/');
  return slash === -1 ? id : id.slice(0, slash);
}

function isStage(stage) {
  return STAGES.includes(stage);
}

function median(samples) {
  const n = Array.isArray(samples) ? samples.filter((x) => typeof x === 'number' && x >= 0) : [];
  if (!n.length) return 0;
  const s = [...n].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function mean(samples) {
  const n = Array.isArray(samples) ? samples.filter((x) => typeof x === 'number' && x >= 0) : [];
  if (!n.length) return 0;
  return Math.round(n.reduce((a, b) => a + b, 0) / n.length);
}

/* ───────────────────────── 落盘：读取 / 原子写 / 串行队列 ───────────────────────── */

function loadCache() {
  if (cache) return cache;
  cache = { updatedAt: 0, sources: {} };
  try {
    if (fs.existsSync(healthPath)) {
      const raw = JSON.parse(fs.readFileSync(healthPath, 'utf8'));
      if (raw && raw.sources && typeof raw.sources === 'object') cache.sources = raw.sources;
    }
  } catch {
    cache = { updatedAt: 0, sources: {} };
  }
  pruneExpired(cache, now());
  return cache;
}

/** 14 天 TTL 清理：过期源整体删除；源内过期阶段一并删除。返回是否有清理。 */
function pruneExpired(c, ts) {
  let pruned = false;
  if (!c || !c.sources) return pruned;
  for (const [id, h] of Object.entries(c.sources)) {
    if (!h || typeof h !== 'object') {
      delete c.sources[id];
      pruned = true;
      continue;
    }
    if (h.stages && typeof h.stages === 'object') {
      for (const [stage, s] of Object.entries(h.stages)) {
        if (s && typeof s === 'object' && ts - (s.last || 0) > HEALTH_TTL_MS) {
          delete h.stages[stage];
          pruned = true;
        }
      }
    }
    const stagesLeft = h.stages ? Object.keys(h.stages).length : 0;
    if (stagesLeft === 0 || ts - (h.last || 0) > HEALTH_TTL_MS) {
      delete c.sources[id];
      pruned = true;
    }
  }
  return pruned;
}

/** 原子写：先写 .tmp 再 rename；同一文件的写操作经 promise 队列串行化。 */
function persist() {
  const run = async () => {
    try {
      const c = loadCache();
      c.updatedAt = now();
      fs.mkdirSync(path.dirname(healthPath), { recursive: true });
      const tmp = `${healthPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(c));
      fs.renameSync(tmp, healthPath);
    } catch {
      /* 落盘失败不影响主流程 */
    }
  };
  // 串行化：上一笔写（或其失败）结束后再写下一笔，避免并发 read-modify-write 互相覆盖。
  writeChain = writeChain.then(run, run);
  return writeChain;
}

/* ───────────────────────── 超时分级预算 ───────────────────────── */

/**
 * 某源某阶段的分级预算（毫秒）：默认表 × 慢源放宽，不做上限裁剪；
 * 总硬上限由 remainingBudget 在调度现场结合已耗时间裁剪。
 */
export function stageBudget(sourceId, stage) {
  const base = DEFAULT_BUDGET[stage];
  if (!isStage(stage) || typeof base !== 'number') return DEFAULT_BUDGET.info;
  const host = hostOf(sourceId);
  const override = SLOW_SOURCE_OVERRIDES[host] || {};
  return Number.isFinite(override[stage]) ? override[stage] : base;
}

/**
 * 返回某源完整分级超时表 { info, toc, content, total }。
 * total 固定为 12000 硬上限；各阶段值来自默认表 + 慢源阶段放宽。
 */
export function budgetsFor(sourceId) {
  return Object.freeze({
    info: stageBudget(sourceId, 'info'),
    toc: stageBudget(sourceId, 'toc'),
    content: stageBudget(sourceId, 'content'),
    total: TOTAL_OPEN_BUDGET,
  });
}

/**
 * 调度现场可用预算：min(阶段预算, 总预算 - 已耗时间)；结果不小于 1ms。
 * @param {number} elapsedMs 本次打开已消耗毫秒
 * @param {string} sourceId 源标识
 * @param {string} stage 阶段
 */
export function remainingBudget(elapsedMs, sourceId, stage) {
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const left = TOTAL_OPEN_BUDGET - elapsed;
  return Math.max(1, Math.min(stageBudget(sourceId, stage), left));
}

/* ───────────────────────── 健康记录与降权 ───────────────────────── */

function ensureSource(c, id) {
  if (!c.sources[id]) c.sources[id] = { stages: {}, consecutiveFails: 0, deprioritized: false, deprioritizedAt: 0, last: 0 };
  const h = c.sources[id];
  if (!h.stages || typeof h.stages !== 'object') h.stages = {};
  if (!Number.isFinite(h.consecutiveFails)) h.consecutiveFails = 0;
  return h;
}

function ensureStage(h, stage) {
  if (!h.stages[stage]) h.stages[stage] = { ok: 0, fail: 0, avgMs: 0, p50: 0, samples: [], last: 0 };
  const s = h.stages[stage];
  if (!Array.isArray(s.samples)) s.samples = [];
  return s;
}

/** 降权是否仍在 24h 窗口内（过期自动视为已恢复）。 */
function deprioritizedActive(h, ts) {
  return !!(h && h.deprioritized && Number.isFinite(h.deprioritizedAt) && ts - h.deprioritizedAt < DEPRIORITIZE_WINDOW_MS);
}

/**
 * 记录某源某阶段结果。
 * @param {string} sourceId
 * @param {'info'|'toc'|'content'} stage
 * @param {{ok:boolean, ms:number, error?:string}} result
 * @returns {{recorded:boolean, deprioritized:boolean, consecutiveFails:number, p50:number}}
 *   永不抛异常；入参非法时 recorded=false。
 */
export function recordOutcome(sourceId, stage, result) {
  const failReturn = { recorded: false, deprioritized: false, consecutiveFails: 0, p50: 0 };
  try {
    const id = normalizeId(sourceId);
    if (!id || !isStage(stage)) return failReturn;
    const ok = !!(result && result.ok);
    const ms = Number(result && result.ms);
    const ts = now();

    const c = loadCache();
    const h = ensureSource(c, id);
    const s = ensureStage(h, stage);

    if (ok) {
      s.ok += 1;
      if (Number.isFinite(ms) && ms >= 0) {
        s.samples.push(Math.round(ms));
        if (s.samples.length > SAMPLE_LIMIT) s.samples.shift();
      }
      s.avgMs = mean(s.samples);
      s.p50 = median(s.samples);
      h.consecutiveFails = 0;
      // 上一轮降权若已过期，随成功一并恢复；未过期则保持，直到窗口结束。
      if (h.deprioritized && !deprioritizedActive(h, ts)) {
        h.deprioritized = false;
        h.deprioritizedAt = 0;
      }
    } else {
      s.fail += 1;
      h.consecutiveFails += 1;
      if (h.consecutiveFails >= FAIL_THRESHOLD) {
        h.deprioritized = true;
        h.deprioritizedAt = ts;
      }
    }
    s.last = ts;
    h.last = ts;

    persist();
    return {
      recorded: true,
      deprioritized: deprioritizedActive(h, ts),
      consecutiveFails: h.consecutiveFails,
      p50: s.p50,
    };
  } catch {
    return failReturn;
  }
}

/** 读取某源健康快照（不修改入参；降权过期自动视为未降权）。 */
export function getHealth(sourceId) {
  try {
    const id = normalizeId(sourceId);
    const c = loadCache();
    const h = c.sources[id];
    if (!h) return null;
    const ts = now();
    const stages = {};
    for (const stage of STAGES) {
      const s = h.stages && h.stages[stage];
      if (s) stages[stage] = { ...s, samples: [...(s.samples || [])] };
    }
    return {
      sourceId: id,
      stages,
      consecutiveFails: h.consecutiveFails || 0,
      deprioritized: deprioritizedActive(h, ts),
      deprioritizedAt: h.deprioritizedAt || 0,
      last: h.last || 0,
    };
  } catch {
    return null;
  }
}

/** 某源某阶段 P50（无样本返回 0）。 */
export function stageP50(sourceId, stage) {
  try {
    const h = getHealth(sourceId);
    return h && h.stages[stage] ? h.stages[stage].p50 : 0;
  } catch {
    return 0;
  }
}

/* ───────────────────────── 健康分与排序 ───────────────────────── */

/**
 * 单源健康分（0–1，降权源乘惩罚系数）。
 *
 * 公式（跨已有阶段聚合）：
 *  rate  = Σok / (Σok + Σfail)                     成功率，空记录为 0
 *  p50   = 各阶段 P50 的最大值（最短板）
 *  speed = clamp(1 - p50 / 1500, 0, 1)             1.5s 为速度满分线
 *  fresh = 1（last < 24h）否则 0.6
 *  score = (0.6·rate + 0.4·speed) · fresh
 *  降权源：score × 0.25；无记录冷启动源：score = 0.3（中性，不优不劣）。
 */
export function sourceScore(sourceId) {
  try {
    const h = getHealth(sourceId);
    if (!h) return COLD_SCORE;

    let ok = 0;
    let fail = 0;
    let worstP50 = 0;
    for (const stage of STAGES) {
      const s = h.stages[stage];
      if (!s) continue;
      ok += s.ok || 0;
      fail += s.fail || 0;
      if ((s.p50 || 0) > worstP50) worstP50 = s.p50 || 0;
    }
    const total = ok + fail;
    if (total === 0) return COLD_SCORE;

    const rate = ok / total;
    const speed = Math.max(0, Math.min(1, 1 - worstP50 / SPEED_BASELINE_MS));
    const fresh = now() - (h.last || 0) < FRESH_WINDOW_MS ? 1 : 0.6;
    let score = (W_RATE * rate + W_SPEED * speed) * fresh;
    if (h.deprioritized) score *= DEPRIORITIZE_PENALTY;
    return Math.round(score * 10000) / 10000;
  } catch {
    return COLD_SCORE;
  }
}

/**
 * 按健康分排序候选源，返回新数组（不修改入参）。
 * 排序键：score 降序 → 最差阶段 P50 升序 → 名称字典序。
 * @param {Array<{sourceId?|url?|bookSourceUrl?|id?:string, name?:string}>} candidates
 * @returns {Array} 与入参同构的新数组，每项附加 `_score`、`_p50`、`_deprioritized` 内部字段。
 */
export function rankSources(candidates) {
  try {
    if (!Array.isArray(candidates)) return [];
    return candidates
      .map((candidate) => {
        const id = idOf(candidate);
        const h = id ? getHealth(id) : null;
        let worstP50 = 0;
        if (h) {
          for (const stage of STAGES) {
            const p = h.stages[stage]?.p50 || 0;
            if (p > worstP50) worstP50 = p;
          }
        }
        return {
          candidate,
          id,
          score: id ? sourceScore(id) : COLD_SCORE,
          p50: worstP50,
          deprioritized: !!(h && h.deprioritized),
        };
      })
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.p50 !== b.p50) return a.p50 - b.p50;
        const na = String(a.candidate?.name || '');
        const nb = String(b.candidate?.name || '');
        return na.localeCompare(nb, 'zh-Hans-CN');
      })
      .map(({ candidate, score, p50, deprioritized }) => ({
        ...candidate,
        _score: score,
        _p50: p50,
        _deprioritized: deprioritized,
      }));
  } catch {
    return Array.isArray(candidates) ? [...candidates] : [];
  }
}

/* ───────────────────────── 换源判定 ───────────────────────── */

/**
 * 是否应立即换源。
 * 规则：
 *  - 失败（ok=false）或显式超时（timeout=true）→ true；
 *  - 成功但存在阶段 P50 基线、且 ms > 1.5 × P50 → true；
 *  - 无基线的成功慢调用不换（避免冷启动误伤）。
 * @param {string} stage
 * @param {{ok:boolean, ms:number, error?:string, timeout?:boolean, sourceId?:string}} result
 * @returns {boolean} 永不抛异常。
 */
export function shouldSwitch(stage, result) {
  try {
    if (!result) return true;
    if (result.timeout === true) return true;
    if (!result.ok) return true;
    if (!isStage(stage)) return false;
    const ms = Number(result.ms);
    if (!Number.isFinite(ms)) return false;
    const baseline = stageP50(result.sourceId, stage);
    if (baseline <= 0) return false; // 冷启动无基线，不换
    return ms > baseline * 1.5;
  } catch {
    return false;
  }
}

/**
 * 带源标识的换源判定（推荐调度现场使用）。
 * @param {string} sourceId
 * @param {string} stage
 * @param {{ok:boolean, ms:number, error?:string, timeout?:boolean}} result
 */
export function shouldSwitchFor(sourceId, stage, result) {
  return shouldSwitch(stage, { ...(result || {}), sourceId });
}

export default {
  STAGES,
  DEFAULT_BUDGET,
  TOTAL_OPEN_BUDGET,
  budgetsFor,
  stageBudget,
  remainingBudget,
  recordOutcome,
  getHealth,
  stageP50,
  sourceScore,
  rankSources,
  shouldSwitch,
  shouldSwitchFor,
  normalizeId,
};
