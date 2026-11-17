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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FULL_CACHE_PATH = path.join(ROOT, 'runtime', 'book-sources-full.json');
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
 * 装载归一化书源。
 * @param {{file?:string, refresh?:boolean, readerBase?:string}} opts
 * @returns {Promise<Array>}
 */
export async function loadSources(opts = {}) {
  const file = opts.file || FULL_CACHE_PATH;
  if (!opts.refresh && fs.existsSync(file)) {
    try {
      const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (cached && Array.isArray(cached.sources)) return cached.sources;
      if (Array.isArray(cached)) return cached;
    } catch {
      // 缓存损坏，重新拉取
    }
  }
  const raw = await fetchRawFromReader();
  const { sources, stats } = normalizeAll(raw);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ generatedAt: Date.now(), stats, sources }, null, 1)
  );
  return sources;
}

/** 仅可搜且启用的源。 */
export function searchableSources(sources) {
  return sources.filter((s) => s.enabled && (s.searchUrl || s.rules.search.bookList));
}
