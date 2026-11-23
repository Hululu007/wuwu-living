#!/usr/bin/env node
/**
 * 书源装载与归一化：Reader 原始 legado 记录 → 引擎统一结构。
 *
 * 字段映射对照：
 *  bookSourceName→name / bookSourceGroup→group / bookSourceUrl→url /
 *  ruleSearch→rules.search / ruleBookInfo→rules.bookInfo /
 *  ruleToc→rules.toc / ruleContent→rules.content。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchText } from './fetch.mjs';
import { writeJsonSync } from '../json_store.mjs';
import { runtimePath } from '../runtime_dir.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FULL_CACHE_PATH = runtimePath(ROOT, 'book-sources-full.json');
const READER_BASE = process.env.READER_BASE || 'http://127.0.0.1:1122';

const SEARCH_FIELDS = ['bookList', 'name', 'author', 'intro', 'kind', 'lastChapter', 'updateTime', 'bookUrl', 'coverUrl', 'wordCount'];
const INFO_FIELDS = ['init', 'name', 'author', 'coverUrl', 'intro', 'kind', 'lastChapter', 'tocUrl', 'wordCount', 'status', 'updateTime'];
const TOC_FIELDS = ['init', 'chapterList', 'chapterName', 'chapterUrl', 'formatJs', 'isVolume', 'isVip', 'isPay', 'updateTime', 'nextTocUrl', 'preUpdateJs'];
const CONTENT_FIELDS = ['title', 'content', 'nextContentUrl', 'webJs', 'sourceRegex', 'replaceRegex', 'imageStyle', 'imageDecode'];

function pick(obj, fields) {
  const out = {};
  if (!obj) return out;
  for (const f of fields) {
    if (obj[f] != null && obj[f] !== '') out[f] = String(obj[f]);
  }
  return out;
}

/** 去掉 URL 尾部锚点，作为相对链接补全基准。 */
export function baseOf(url) {
  return String(url || '').split('#')[0];
}

/**
 * 单条归一化。
 */
export function normalizeOne(raw) {
  const url = raw.bookSourceUrl || '';
  return {
    id: url,
    name: raw.bookSourceName || '',
    url,
    group: raw.bookSourceGroup || '',
    enabled: raw.enabled !== false,
    type: raw.bookSourceType == null ? 0 : raw.bookSourceType,
    charset: raw.charset || '',
    header: raw.header == null ? '' : raw.header,
    cookie: raw.cookie || '',
    bookUrlPattern: raw.bookUrlPattern || '',
    searchUrl: raw.searchUrl || '',
    jsLib: raw.jsLib || '',
    rules: {
      search: pick(raw.ruleSearch, SEARCH_FIELDS),
      bookInfo: pick(raw.ruleBookInfo, INFO_FIELDS),
      toc: pick(raw.ruleToc, TOC_FIELDS),
      content: pick(raw.ruleContent, CONTENT_FIELDS),
    },
  };
}

/** 批量归一化并统计四类规则覆盖。 */
export function normalizeAll(rawData) {
  const sources = (rawData || []).map(normalizeOne);
  const stats = {
    total: sources.length,
    searchable: 0,
    hasBookInfo: 0,
    hasToc: 0,
    hasContent: 0,
    enabled: 0,
  };
  for (const s of sources) {
    if (s.searchUrl || s.rules.search.bookList) stats.searchable++;
    if (Object.keys(s.rules.bookInfo).length) stats.hasBookInfo++;
    if (Object.keys(s.rules.toc).length) stats.hasToc++;
    if (Object.keys(s.rules.content).length) stats.hasContent++;
    if (s.enabled) stats.enabled++;
  }
  return { sources, stats };
}

/** 正则编译；非法或空返回 null。 */
function compilePattern(pattern) {
  if (!pattern) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/** 按 bookUrlPattern 校验 URL。 */
export function matchBookUrl(source, url) {
  if (!source) return false;
  const regex = compilePattern(source.bookUrlPattern);
  if (!regex) return false;
  return regex.test(String(url || ''));
}

/**
 * 从 Reader 拉全量原始书源（60s 超时）。
 */
export async function fetchRawFromReader() {
  const res = await fetchText(`${READER_BASE}/reader3/getBookSources`, { timeoutMs: 60000 });
  let payload;
  try {
    payload = JSON.parse(res.text);
  } catch {
    throw new Error('Reader 书源响应不是合法 JSON');
  }
  if (!payload || payload.isSuccess === false) {
    throw new Error(payload?.errorMsg || 'Reader 返回失败');
  }
  return payload.data || [];
}

/**
 * 离线原始书源候选路径。
 *
 * 为什么需要（2026-11-23）：`runtime/book-sources-full.json` 不存在时，
 * loadSources 只能向 Reader（:1122）要数据；Reader 没在跑就整条链路失败，
 * sourceCache 归零 —— 搜书回落本地引擎时 0 源，任务 61ms 就报「搜完了，0 本」，
 * 把「引擎不可用」伪装成「没有这本书」。
 * 现在按优先级找一个本地原始书源 JSON（同口径 legado 记录），自愈重建缓存。
 */
const RAW_FALLBACK_PATHS = process.env.WW_SOURCE_RAW_DISABLE === '1' ? [] : [
  process.env.LEGADO_RAW_FALLBACK,
  runtimePath(ROOT, 'book-sources-raw.json'),
  // 同机兄弟项目：reader-search 自带同一批 7,538 条书源
  path.join(ROOT, '..', 'reader-search', 'book-sources.json'),
].filter(Boolean);

/** 读本地原始书源；返回 { raw, file, normalized } 或 null。 */
function readRawFallback() {
  for (const file of RAW_FALLBACK_PATHS) {
    try {
      if (!file || !fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const raw = Array.isArray(parsed) ? parsed
        : Array.isArray(parsed?.data) ? parsed.data
          : Array.isArray(parsed?.sources) ? parsed.sources
            : null;
      if (!raw || !raw.length) continue;
      // 已经是归一化结构（有 name/url/rules）就直接用，别再过一遍 normalizeOne。
      const normalized = !!(raw[0] && raw[0].url && raw[0].name && raw[0].rules);
      return { raw, file, normalized };
    } catch {
      // 单个候选坏了就换下一个，不影响启动
    }
  }
  return null;
}

/**
 * 装载归一化书源。
 * @param {{file?:string, refresh?:boolean, readerBase?:string}} opts
 * @returns {Promise<Array>}
 */
export async function loadSources(opts = {}) {
  const file = opts.file || FULL_CACHE_PATH;
  if (!opts.refresh && fs.existsSync(file)) {
    try {
      const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
      const arr = cached && Array.isArray(cached.sources) ? cached.sources
        : Array.isArray(cached) ? cached : null;
      // 空缓存等于没有：旧写法会把 [] 当有效缓存直接返回，永远不再重建。
      if (arr && arr.length) return arr;
    } catch {
      // 缓存损坏，重新拉取
    }
  }
  let raw;
  let origin = 'reader';
  let normalizedInput = false;
  try {
    raw = await fetchRawFromReader();
  } catch (error) {
    const fallback = readRawFallback();
    if (!fallback) throw error;
    raw = fallback.raw;
    origin = `local:${path.basename(fallback.file)}`;
    normalizedInput = fallback.normalized;
  }
  let sources;
  let stats;
  if (normalizedInput) {
    sources = raw;
    stats = {
      total: sources.length,
      enabled: sources.filter((s) => s.enabled !== false).length,
      searchable: sources.filter((s) => s.searchUrl || s.rules?.search?.bookList).length,
      hasBookInfo: sources.filter((s) => Object.keys(s.rules?.bookInfo || {}).length).length,
      hasToc: sources.filter((s) => Object.keys(s.rules?.toc || {}).length).length,
      hasContent: sources.filter((s) => Object.keys(s.rules?.content || {}).length).length,
    };
  } else {
    ({ sources, stats } = normalizeAll(raw));
  }
  stats.origin = origin;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 旧写法直接 writeFileSync 目标文件：写一半被杀 → 文件半截 → 下次 JSON.parse 失败，
  // 又得整轮重拉 3370 个源。改成 json_store 的临时名 + rename，中断也不毁缓存。
  writeJsonSync(file, { generatedAt: Date.now(), stats, sources });
  return sources;
}

/** 仅可搜且启用的源。 */
export function searchableSources(sources) {
  return sources.filter((s) => s.enabled && (s.searchUrl || s.rules.search.bookList));
}
