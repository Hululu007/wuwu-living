#!/usr/bin/env node
/**
 * Reader 桌面端（reader-desktop / reader-web，127.0.0.1:1122）只读接口封装。
 *
 * 勘查结论（2026-11-16，二进制 97MB Mach-O universal + 内嵌前端 JS 实测）：
 *  - 1122 的 axum 路由表只注册了书架 / 目录 / 书源管理 / 统计等命令；
 *    实测可返回 JSON 的路由以 /reader3/getBookSources 为代表。
 *  - 真正的“多源搜书”是 Tauri WebView IPC 命令：
 *      search_book_multi_sse        多源并发搜书（SSE 增量推送）
 *      search_book_source_sse       单源搜书（SSE）
 *      get_available_book_source_sse 可用源探测（SSE）
 *      cancel_book_search          取消任务
 *    这些命令只存在于 Tauri 运行时内部，外部 HTTP 无法调起；1122 没有把它们
 *    映射成 GET/POST 路由。
 *  - 本模块所有调用都是异步（fetch + AbortController 超时），不阻塞 Node 主线程；
 *    任何失败都返回带中文说明的兜底结构，不抛未捕获异常。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { runtimePath } from './runtime_dir.mjs';
import { appendLog } from './log_dir.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const READER_BASE = (process.env.READER_BASE || 'http://127.0.0.1:1122').replace(/\/+$/, '');
const READER_DB = process.env.READER_DB || '/Users/wuwu/Library/Application Support/reader/data/reader.db';
const EXPORT_SCRIPT = path.join(ROOT, 'lib', 'export_book_sources.py');
const CACHE_PATH = runtimePath(ROOT, 'book-sources.json');

/** 勘查锁定的命令与参数事实（供书房侧标注口径，不用于伪造结果）。 */
export const READER_SEARCH_FACTS = Object.freeze({
  httpRouteFound: false,
  healthPath: '/api/health',
  // 实测 1122 上确实返回 application/json 的命令（其余路径回落静态 HTML 兜底）。
  reader3JsonRoutes: ['/reader3/getBookSources', '/reader3/getBookSource'],
  tauriCommands: Object.freeze({
    multiSearchSse: 'search_book_multi_sse',
    sourceSearchSse: 'search_book_source_sse',
    availableSourceSse: 'get_available_book_source_sse',
    cancel: 'cancel_book_search',
  }),
  params: Object.freeze([
    'key',
    'taskId',
    'bookSourceGroup?',
    'bookSourceUrl?',
    'concurrentCount?',
    'searchSize?',
    'lastIndex?',
  ]),
  note:
    'Reader 桌面端搜书走 Tauri IPC（search_book_multi_sse 等），1122 未对外暴露 HTTP 搜书路由；' +
    '书房无法经同源 HTTP 委托给客户端，只能复用其书源规则在本地多源检索。',
});

export function readerBase() {
  return READER_BASE;
}

export function readerDbPath() {
  return READER_DB;
}

function logReader(message) {
  try {
    appendLog('reader-api.log', `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    /* ignore */
  }
}

/** 通用带超时的 JSON GET。返回 { status, ok, contentType, text, data }。 */
async function getJson(pathname, ms = 4000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(READER_BASE + pathname, {
      signal: ac.signal,
      headers: { accept: 'application/json' },
      cache: 'no-store',
    });
    const text = await r.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return {
      status: r.status,
      ok: r.ok,
      contentType: r.headers.get('content-type') || '',
      text,
      data,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 健康探测。失败给明确中文原因，绝不抛异常。 */
export async function probeReaderHealth(ms = 1500) {
  try {
    const r = await getJson(READER_SEARCH_FACTS.healthPath, ms);
    const ok = !!(r.data && r.data.ok === true);
    return { ok, running: ok, status: r.status, app: (r.data && r.data.app) || '', base: READER_BASE };
  } catch (e) {
    return {
      ok: false,
      running: false,
      status: 0,
      base: READER_BASE,
      error: `Reader Web 服务不可达：${e && e.message ? e.message : e}`,
    };
  }
}

/**
 * 探测候选 HTTP 路由是否真正返回 JSON（而非静态 HTML 兜底）。
 * 返回 { json, status, contentType, found, sample }。
 */
export async function probeRoute(pathname, method = 'GET', ms = 4000) {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    const init = { method, headers: { accept: 'application/json' }, signal: ac.signal, cache: 'no-store' };
    const r = await fetch(READER_BASE + pathname, init);
    const text = await r.text();
    const ct = r.headers.get('content-type') || '';
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    const json = /json/i.test(ct) || data != null;
    return {
      json,
      status: r.status,
      contentType: ct,
      found: json && r.ok,
      sample: text.slice(0, 240),
    };
  } catch (e) {
    return {
      json: false,
      status: 0,
      contentType: '',
      found: false,
      sample: '',
      error: String((e && e.message) || e),
    };
  }
}

/**
 * 拉取 Reader 全部书源清单（/reader3/getBookSources）。
 * 响应可能很大（数万条），解析失败返回 []，并在 error 里说明。
 */
export async function fetchReaderSources(ms = 20000) {
  try {
    const r = await getJson('/reader3/getBookSources', ms);
    const data = r.data;
    const list = data && Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : [];
    return { ok: r.ok, status: r.status, sources: list, count: list.length };
  } catch (e) {
    return { ok: false, status: 0, sources: [], count: 0, error: String((e && e.message) || e) };
  }
}

let sourceCache = null;
let sourceCacheAt = 0;
let refreshPromise = null;

/**
 * 异步刷新本地书源缓存（execFile 异步子进程 + 超时，不在主线程同步等子进程）。
 * 失败只记录日志并保留旧缓存，不抛异常。
 */
export function refreshSourceCache(force = false) {
  if (refreshPromise) return refreshPromise;
  refreshPromise = new Promise((resolve) => {
    let stale = true;
    try {
      if (fs.existsSync(CACHE_PATH)) {
        const stat = fs.statSync(CACHE_PATH);
        stale = force || Date.now() - stat.mtimeMs > 6 * 60 * 60 * 1000;
      }
    } catch {
      stale = true;
    }
    if (!stale && sourceCache) {
      refreshPromise = null;
      return resolve(sourceCache);
    }
    execFile(
      '/usr/bin/python3',
      [EXPORT_SCRIPT, READER_DB, CACHE_PATH],
      { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        try {
          if (err) {
            logReader(`export sources failed: ${stderr || err.message || err}`);
          } else if (stdout) {
            logReader(String(stdout).trim());
          }
          try {
            const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
            sourceCache = raw.sources || [];
            sourceCacheAt = Date.now();
          } catch (e2) {
            logReader(`reload source cache failed: ${e2 && e2.message}`);
          }
        } finally {
          refreshPromise = null;
          resolve(sourceCache || []);
        }
      }
    );
  });
  return refreshPromise;
}

/** 同步读取磁盘上已有的书源缓存（仅本地磁盘读，不拉起子进程；缺失返回 []）。 */
export function loadSourceCache() {
  if (sourceCache) return sourceCache;
  try {
    if (fs.existsSync(CACHE_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
      sourceCache = raw.sources || [];
      sourceCacheAt = Date.now();
    }
  } catch {
    sourceCache = [];
  }
  return sourceCache || [];
}

export function getCacheStats() {
  const sources = sourceCache || loadSourceCache();
  return { total: sources.length, generatedAt: sourceCacheAt };
}
