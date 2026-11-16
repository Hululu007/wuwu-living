#!/usr/bin/env node
/**
 * 多书源搜索。
 *
 * 只做“搜索页 -> 书籍详情地址”这一段：搜索页由各个书源的 searchUrl 抓取，
 * 用 Legado/Reader 的 ruleSearch 子集解析出书名、作者、bookUrl。拿到的
 * bookUrl 仍然交给 Reader Web 的 getBookInfo / getChapterList / getBookContent，
 * 所以详情、目录、正文的规则和 Reader 桌面端完全一致。
 *
 * 这不是“只搜顶点小说”：启动时从 Reader 的 reader.db 导出全部带搜索规则的
 * 书源（当前约 3,300+ 条），按并发池逐源搜索，任一源有结果就会出现在列表里。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { refreshSourceCache, loadSourceCache, getCacheStats, READER_SEARCH_FACTS } from './reader_api.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_PATH = path.join(ROOT, 'runtime', 'book-sources.json');
const READER_DB = '/Users/wuwu/Library/Application Support/reader/data/reader.db';
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 160 });
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 160,
  rejectUnauthorized: false,
});

let sourceCache = null;
let sourceCacheAt = 0;
let lastStats = null;
const queryCache = new Map();

/* ───────────────────────── 源成功率 / 耗时健康缓存（落盘） ───────────────────────── */
const HEALTH_PATH = path.join(ROOT, 'runtime', 'book_source_health.json');
const HEALTH_TTL_MS = 14 * 24 * 3600 * 1000;
let healthCache = null;

// 无健康缓存时的冷启动兜底：实测响应快、可出结果的站名关键词，命中加分。
const GOOD_NAME_PATTERNS = [
  /顶点小说/, /笔趣阁/, /笔趣小说/, /爱久久/, /UC小说/, /爱下小说/, /青困小说/, /番茄/,
  /飞卢/, /SF轻小说/, /书旗/, /追书/, /少年梦/, /漫客栈/, /得间/, /小米阅读/, /爱优漫/,
];

function loadHealth() {
  if (healthCache) return healthCache;
  healthCache = { updatedAt: 0, sources: {} };
  try {
    if (fs.existsSync(HEALTH_PATH)) {
      const raw = JSON.parse(fs.readFileSync(HEALTH_PATH, 'utf8'));
      const now = Date.now();
      for (const [url, h] of Object.entries(raw.sources || {})) {
        if (h && now - (h.last || 0) < HEALTH_TTL_MS) healthCache.sources[url] = h;
      }
      healthCache.updatedAt = raw.updatedAt || 0;
    }
  } catch {
    healthCache = { updatedAt: 0, sources: {} };
  }
  return healthCache;
}

/** 健康分：成功率 60% + 响应速度 40%，24h 内新鲜度加权；无记录返回 0。 */
function healthScore(h) {
  if (!h) return 0;
  const total = (h.ok || 0) + (h.fail || 0);
  if (!total) return 0;
  const rate = (h.ok || 0) / total;
  const speed = Math.max(0, 1 - ((h.avgMs || 1500) / 1500));
  const fresh = Date.now() - (h.last || 0) < 24 * 3600 * 1000 ? 1 : 0.6;
  return (rate * 0.5 + speed * 0.5) * fresh;
}

function recordHealth(url, ok, ms) {
  const cache = loadHealth();
  const h = cache.sources[url] || { ok: 0, fail: 0, avgMs: 0, last: 0 };
  if (ok) {
    h.ok = (h.ok || 0) + 1;
    h.avgMs = h.avgMs ? Math.round(0.7 * h.avgMs + 0.3 * ms) : Math.round(ms);
  } else {
    h.fail = (h.fail || 0) + 1;
  }
  h.last = Date.now();
  cache.sources[url] = h;
}

function persistHealth() {
  try {
    fs.mkdirSync(path.join(ROOT, 'runtime'), { recursive: true });
    fs.writeFileSync(HEALTH_PATH, JSON.stringify({ updatedAt: Date.now(), sources: loadHealth().sources }));
  } catch {
    /* 落盘失败不影响搜书主流程 */
  }
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.appendFileSync('/tmp/wuwu-book-search.log', line);
  } catch {
    /* ignore */
  }
}

export function ensureSourceCache(force = false) {
  fs.mkdirSync(path.join(ROOT, 'runtime'), { recursive: true });
  // 先同步读磁盘已有缓存（仅本地磁盘读，不拉子进程）；后台异步刷新，主线程不等子进程。
  const sources = loadSourceCache();
  refreshSourceCache(force).catch((e) => {
    log(`refresh source cache skipped: ${e && e.message ? e.message : e}`);
  });
  sourceCache = sources;
  sourceCacheAt = Date.now();
  return sourceCache;
}

export function getSourceStats() {
  const sources = sourceCache || ensureSourceCache();
  let direct = 0;
  for (const source of sources) {
    if (buildSearchRequest(source, '测试', 1)) direct++;
  }
  return {
    total: sources.length,
    direct,
    groups: new Set(sources.map((s) => s.group).filter(Boolean)).size,
    generatedAt: sourceCacheAt,
  };
}

/**
 * 并发池。3,300 个源不可能串行；每个源只允许一次搜索请求。
 */
async function runPool(items, limit, worker, onProgress) {
  let cursor = 0;
  let done = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        await worker(items[index], index);
      } catch (error) {
        log(`worker failed ${items[index]?.name}: ${error.message}`);
      }
      done++;
      if (onProgress && (done % 50 === 0 || done === items.length)) onProgress(done, items.length);
    }
  });
  await Promise.all(runners);
}

function decodeBody(buffer, contentType, charsetHint) {
  let charset = String(charsetHint || '').trim().toLowerCase();
  if (!charset) {
    const match = String(contentType || '').match(/charset\s*=\s*["']?([^;"'\s]+)/i);
    if (match) charset = match[1].toLowerCase();
  }
  if (!charset) charset = 'utf-8';
  if (charset === 'gb2312' || charset === 'gbk') charset = 'gb18030';
  if (charset === 'utf8') charset = 'utf-8';
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

/**
 * 原生 HTTP 抓取。Node 的 fetch 在部分书源站点会拒绝自签名证书，这里统一
 * 用 http/https + rejectUnauthorized:false；同时支持 GBK / Big5 解码。
 */
function fetchText(url, options = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }
    if (!/^http(s)?:$/.test(parsed.protocol)) {
      reject(new Error(`unsupported protocol ${parsed.protocol}`));
      return;
    }
    const transport = parsed.protocol === 'https:' ? https : http;
    const headers = {
      'User-Agent': DEFAULT_UA,
      Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
      'Accept-Encoding': 'gzip, deflate, br',
      Connection: 'keep-alive',
      ...Object.fromEntries(
        Object.entries(options.headers || {}).filter(([, value]) => value != null && value !== '')
      ),
    };
    const request = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: options.method || 'GET',
        headers,
        agent: parsed.protocol === 'https:' ? httpsAgent : httpAgent,
        rejectUnauthorized: false,
        servername: parsed.hostname,
        family: 4,
        timeout: options.timeout || 6000,
      },
      (response) => {
        const status = response.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
          response.resume();
          if (redirects >= 5) {
            reject(new Error(`too many redirects: ${status}`));
            return;
          }
          let next;
          try {
            next = new URL(response.headers.location, url).toString();
          } catch (error) {
            reject(error);
            return;
          }
          const nextOptions = { ...options };
          if (status === 303) {
            nextOptions.method = 'GET';
            nextOptions.body = '';
          }
          fetchText(next, nextOptions, redirects + 1).then(resolve, reject);
          return;
        }
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 8 * 1024 * 1024) {
            response.destroy(new Error('response too large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            let buffer = Buffer.concat(chunks);
            const encoding = String(response.headers['content-encoding'] || '').toLowerCase();
            if (encoding === 'gzip') buffer = zlib.gunzipSync(buffer);
            else if (encoding === 'deflate') {
              try {
                buffer = zlib.inflateSync(buffer);
              } catch {
                buffer = zlib.inflateRawSync(buffer);
              }
            } else if (encoding === 'br') buffer = zlib.brotliDecompressSync(buffer);
            resolve({
              url: response.url || url,
              status,
              body: decodeBody(buffer, response.headers['content-type'], options.charset),
              headers: response.headers,
            });
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

/* ─────────────────────────── Legado 规则子集 ─────────────────────────── */

function splitAlternatives(rule) {
  if (!rule) return [];
  return String(rule)
    .split('||')
    .map((part) => part.trim())
    .filter(Boolean);
}

function applyRegex(value, rule) {
  let text = String(value == null ? '' : value);
  if (!rule) return text;
  const jsAt = text.indexOf('<js>');
  if (jsAt >= 0) text = text.slice(0, jsAt);
  const parts = String(rule).split('##');
  if (parts.length >= 2) {
    const pattern = parts[0];
    const replacement = parts[1] == null ? '' : parts[1];
    if (pattern) {
      try {
        text = text.replace(new RegExp(pattern, 'g'), replacement);
      } catch {
        try {
          text = text.replace(new RegExp(pattern), replacement);
        } catch {
          /* keep raw */
        }
      }
    }
  }
  return collapseText(text);
}

function collapseText(value) {
  return String(value == null ? '' : value)
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function valueText(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return collapseText(value);
  }
  if (Array.isArray(value)) return value.map(valueText).filter(Boolean).join(' / ');
  return '';
}

function isUsableBookUrl(url) {
  const u = String(url || '');
  if (!u) return false;
  if (/<js>|%3Cjs%3E|%7B%7B|{{|}}|@js:|\$\{/i.test(u)) return false;
  if (/\/api\/|get-album-list|\/book\/app\/book|\/voddetail/i.test(u)) return false;
  return true;
}

function isJunkItem(item) {
  const author = String(item.author || '');
  const name = String(item.name || '');
  const url = String(item.bookUrl || '');
  const source = String(item.originName || '');
  if (/\[object Object\]/.test(author + ' ' + name)) return true;
  if (/^(最后更新|内容简介|作者：|作者:)/.test(author)) return true;
  if (/\/voddetail|\/api\/|get-album-list|\/book\/app\/book/.test(url)) return true;
  if (/影视|漫画|听书|音乐|听|国漫/.test(source)) return true;
  if (!isUsableBookUrl(url)) return true;
  if (/最后更新：|内容简介：/.test(author)) return true;
  return false;
}

function parseIndexToken(token) {
  let clean = token;
  let removeIndex = null;
  let slice = null;
  const bang = clean.match(/!(-?\d+)$/);
  if (bang) {
    removeIndex = Number(bang[1]);
    clean = clean.slice(0, bang.index);
  }
  const sliceMatch = clean.match(/:(-?\d+):(-?\d+)$/);
  if (sliceMatch) {
    slice = [Number(sliceMatch[1]), Number(sliceMatch[2])];
    clean = clean.slice(0, sliceMatch.index);
  }
  let index = null;
  const dotted = clean.match(/^(.*)\.(-?\d+)$/);
  if (dotted && dotted[1] && !dotted[1].endsWith('.')) {
    index = Number(dotted[2]);
    clean = dotted[1];
  }
  const bracket = clean.match(/^(.*)\[(-?\d+)\]$/);
  if (bracket) {
    index = Number(bracket[2]);
    clean = bracket[1];
  }
  return { clean, index, removeIndex, slice };
}

function applyIndex(nodes, index) {
  if (!Array.isArray(nodes) || !nodes.length || index == null) return nodes;
  const real = index < 0 ? nodes.length + index : index;
  return real >= 0 && real < nodes.length ? [nodes[real]] : [];
}

function applySlice(nodes, slice) {
  if (!Array.isArray(nodes) || !slice) return nodes;
  const [start, end] = slice;
  const normalize = (n) => (n < 0 ? nodes.length + n : n);
  return nodes.slice(normalize(start), normalize(end));
}

function stepNodes(nodes, token) {
  if (!nodes || !nodes.length || !token) return nodes || [];
  const parsed = parseIndexToken(token);
  let { clean, index, removeIndex, slice } = parsed;
  if (!clean) return nodes;

  let next = [];
  if (clean === 'children') {
    next = nodes.flatMap((node) => Array.from(node.children || []));
  } else if (clean.startsWith('tag.')) {
    const tag = clean.slice(4);
    next = nodes.flatMap((node) => {
      const found = [];
      const walk = (current) => {
        for (const child of current.children || []) {
          if (child.type === 'tag' && child.name && child.name.toLowerCase() === tag.toLowerCase()) {
            found.push(child);
          }
          walk(child);
        }
      };
      walk(node);
      return found;
    });
  } else if (clean.startsWith('class.')) {
    const cls = clean.slice(6).split('.')[0];
    next = nodes.flatMap((node) => {
      const found = [];
      const walk = (current) => {
        for (const child of current.children || []) {
          if (
            child.type === 'tag' &&
            Array.isArray(child.attribs?.class ? child.attribs.class.split(/\s+/) : []) &&
            (child.attribs?.class || '').split(/\s+/).includes(cls)
          ) {
            found.push(child);
          }
          walk(child);
        }
      };
      walk(node);
      return found;
    });
  } else if (clean.startsWith('id.')) {
    const id = clean.slice(3).split('.')[0];
    next = nodes.flatMap((node) => {
      const found = [];
      const walk = (current) => {
        for (const child of current.children || []) {
          if (child.type === 'tag' && child.attribs?.id === id) found.push(child);
          walk(child);
        }
      };
      walk(node);
      return found;
    });
  } else if (clean === 'tbody' || clean === 'tr' || clean === 'td' || clean === 'a' || clean === 'li' || clean === 'ul' || clean === 'dl' || clean === 'div' || clean === 'span' || clean === 'p' || clean === 'h1' || clean === 'h2' || clean === 'h3' || clean === 'h4' || clean === 'img' || clean === 'dd' || clean === 'dt') {
    next = nodes.flatMap((node) => {
      const found = [];
      const walk = (current) => {
        for (const child of current.children || []) {
          if (child.type === 'tag' && child.name && child.name.toLowerCase() === clean.toLowerCase()) found.push(child);
          walk(child);
        }
      };
      walk(node);
      return found;
    });
  } else {
    const $ = cheerio.load('');
    // 用 cheerio 的 CSS 选择器处理 .foo / #foo / "tbody tr" / "ul li"。
    const root = nodes.length === 1 ? nodes[0] : nodes;
    next = $(root).find(clean).toArray();
    if (!next.length && nodes.length > 1) {
      for (const node of nodes) {
        const part = cheerio.load('').root();
        void part;
      }
    }
  }

  next = applyIndex(next, index);
  next = applySlice(next, slice);
  if (removeIndex != null) {
    const real = removeIndex < 0 ? next.length + removeIndex : removeIndex;
    next = next.filter((_, i) => i !== real);
  }
  return next;
}

function extractNodes(nodes, accessor) {
  if (!nodes || !nodes.length) return '';
  const values = nodes.map((node) => {
    const $ = cheerio.load('');
    switch (accessor) {
      case 'text':
        return $(node).text();
      case 'ownText':
        return $(node)
          .contents()
          .filter((_, child) => child.type === 'text')
          .text();
      case 'href':
        return $(node).attr('href') || '';
      case 'src':
        return $(node).attr('src') || $(node).attr('data-src') || '';
      case 'html':
      case 'content':
        return $(node).html() || '';
      case 'title':
        return $(node).attr('title') || '';
      default:
        return $(node).text();
    }
  });
  return values.map(collapseText).filter(Boolean)[0] || '';
}

function queryRule(rootNodes, rule) {
  if (!rule) return '';
  const alternatives = splitAlternatives(rule);
  for (const rawAlt of alternatives) {
    const hashAt = rawAlt.indexOf('##');
    const alt = hashAt >= 0 ? rawAlt.slice(0, hashAt).trim() : rawAlt.trim();
    const regexPart = hashAt >= 0 ? rawAlt.slice(hashAt + 2) : '';
    let nodes = rootNodes;
    let result = '';
    const tokens = alt.split('@');
    for (const token of tokens) {
      const trimmed = token.trim();
      if (!trimmed) continue;
      if (['text', 'ownText', 'href', 'src', 'html', 'content', 'title'].includes(trimmed)) {
        result = extractNodes(nodes, trimmed);
        nodes = null;
        break;
      }
      nodes = stepNodes(nodes, trimmed);
      if (!nodes.length) break;
    }
    if (result) return applyRegex(result, regexPart);
    if (nodes && nodes.length) {
      const raw = extractNodes(nodes, 'text');
      return applyRegex(raw, regexPart);
    }
  }
  return '';
}


function safeQuery(nodes, rule) {
  try {
    return queryRule(nodes, rule);
  } catch {
    return '';
  }
}

function queryNodes(rootNodes, rule) {
  if (!rule) return [];
  const alternatives = splitAlternatives(rule);
  for (const alt of alternatives) {
    let nodes = rootNodes;
    for (const token of alt.split('@')) {
      const trimmed = token.trim();
      if (!trimmed || ['text', 'ownText', 'href', 'src', 'html', 'content', 'title'].includes(trimmed)) break;
      nodes = stepNodes(nodes, trimmed);
      if (!nodes.length) break;
    }
    if (nodes.length) return nodes;
  }
  return [];
}

/* ─────────────────────────── JSON 规则 ─────────────────────────── */

function jsonTokens(expression) {
  const tokens = [];
  let rest = String(expression || '').trim().replace(/^\$/, '');
  while (rest) {
    const bracket = rest.match(/^\.?([A-Za-z0-9_\-\u4e00-\u9fa5]+)/);
    if (bracket) {
      tokens.push({ type: 'key', value: bracket[1] });
      rest = rest.slice(bracket[0].length);
      continue;
    }
    const wildcard = rest.match(/^\[\*\]/);
    if (wildcard) {
      tokens.push({ type: 'wild' });
      rest = rest.slice(3);
      continue;
    }
    const index = rest.match(/^\[(-?\d+)\]$/);
    if (index) {
      tokens.push({ type: 'index', value: Number(index[1]) });
      rest = rest.slice(index[0].length);
      continue;
    }
    break;
  }
  return tokens;
}

function jsonValues(value, tokens) {
  let current = [value];
  for (const token of tokens) {
    const next = [];
    for (const item of current) {
      if (token.type === 'key') {
        if (item && typeof item === 'object' && token.value in item) next.push(item[token.value]);
      } else if (token.type === 'wild') {
        if (Array.isArray(item)) next.push(...item);
        else if (item && typeof item === 'object') next.push(...Object.values(item));
      } else if (token.type === 'index') {
        if (Array.isArray(item)) {
          const real = token.value < 0 ? item.length + token.value : token.value;
          if (real >= 0 && real < item.length) next.push(item[real]);
        }
      }
    }
    current = next;
  }
  return current;
}

function jsonPath(root, expression) {
  const values = jsonValues(root, jsonTokens(expression));
  return values.length ? values[0] : '';
}

function jsonPathList(root, expression) {
  return jsonValues(root, jsonTokens(expression)).flatMap((value) => {
    if (Array.isArray(value)) return value;
    return value == null ? [] : [value];
  });
}

/* ─────────────────────────── 搜索页解析 ─────────────────────────── */

function absoluteUrl(href, base) {
  const raw = String(href || '').trim();
  if (!raw || /^(javascript|mailto|tel):/i.test(raw) || raw === '#') return '';
  let value = raw;
  if (value.startsWith('//')) value = 'https:' + value;
  if (/^http(s)?:\/\//i.test(value)) return value;
  try {
    return new URL(value, base || 'http://127.0.0.1/').toString();
  } catch {
    return '';
  }
}

function cleanAuthor(value, name) {
  let author = collapseText(value)
    .replace(/^(作者|播音|分类|类型)[：:]\s*/, '')
    .replace(/^\s*作者\s*/, '');
  if (!author) return '';
  if (name && author.includes(name)) author = author.replace(name, '');
  author = author.replace(/^[\[【（(]\s*/, '').replace(/^[^\w\u4e00-\u9fa5]+/, '');
  author = author.split(/\s+(?:类型|状态|总点击|月点击|周点击|总推荐|月推荐|周推荐|最新章节)/)[0];
  if (author.includes('/')) {
    const parts = author.split('/').map((part) => part.trim()).filter(Boolean);
    if (parts.length) author = parts[parts.length - 1];
  }
  author = author.replace(/[（(].*$/, '').replace(/[）)]/g, '').trim();
  return author.slice(0, 60);
}

function cleanName(value) {
  return collapseText(value)
    .replace(/[（(][^）)]*(?:免费|全文|最新章节|笔趣阁|小说)[^）)]*[）)]/g, '')
    .replace(/[（(].*$/g, '')
    .trim();
}

function parseHtmlResults($, root, source, baseUrl, key) {
  const rules = source.rules || {};
  const items = [];
  const nodes = queryNodes([root], rules.bookList);
  for (const node of nodes.slice(0, 30)) {
    let name = safeQuery([node], rules.name);
    let author = safeQuery([node], rules.author);
    let bookUrl = safeQuery([node], rules.bookUrl);
    if (!bookUrl) {
      const link = stepNodes([node], 'tag.a');
      if (link.length) bookUrl = extractNodes(link, 'href');
    }
    name = cleanName(name);
    author = cleanAuthor(author, name);
    if (!name || !bookUrl) continue;
    const abs = absoluteUrl(bookUrl, baseUrl || source.url);
    if (!abs || abs === baseUrl) continue;
    items.push({
      name,
      author,
      bookUrl: abs,
      coverUrl: absoluteUrl(safeQuery([node], rules.coverUrl), baseUrl || source.url),
      intro: collapseText(safeQuery([node], rules.intro)).slice(0, 240),
      latestChapter: collapseText(safeQuery([node], rules.lastChapter)),
      wordCount: collapseText(safeQuery([node], rules.wordCount)),
      kind: collapseText(safeQuery([node], rules.kind)),
      status: collapseText(safeQuery([node], rules.status)),
      origin: source.url,
      originName: source.name,
      source: source.name,
      bookSourceUrl: source.url,
      bookSourceName: source.name,
      fallback: false,
    });
    if (items.length >= 10) break;
  }
  return items;
}

function parseJsonResults(source, text, key) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const rules = source.rules || {};
  if (!String(rules.bookList || '').trim().startsWith('$')) return [];
  const objects = jsonPathList(json, rules.bookList);
  const items = [];
  for (const object of objects.slice(0, 30)) {
    if (!object || typeof object !== 'object') continue;
    let name = valueText(jsonPath(object, rules.name));
    let author = cleanAuthor(valueText(jsonPath(object, rules.author)), name);
    let bookUrl = valueText(jsonPath(object, rules.bookUrl));
    if (String(rules.bookUrl || '').includes('{{')) {
      bookUrl = String(rules.bookUrl).replace(/{{\s*\$.([^}]+)\s*}}/g, (_, expr) => String(jsonPath(object, '$.' + expr) || ''));
    }
    name = cleanName(name);
    if (!name || !bookUrl) continue;
    const abs = absoluteUrl(bookUrl, source.url);
    if (!abs) continue;
    items.push({
      name,
      author,
      bookUrl: abs,
      coverUrl: absoluteUrl(valueText(jsonPath(object, rules.coverUrl)), source.url),
      intro: valueText(jsonPath(object, rules.intro)).slice(0, 240),
      latestChapter: valueText(jsonPath(object, rules.latestChapter)),
      wordCount: valueText(jsonPath(object, rules.wordCount)),
      kind: valueText(jsonPath(object, rules.kind)),
      status: valueText(jsonPath(object, rules.status)),
      origin: source.url,
      originName: source.name,
      source: source.name,
      bookSourceUrl: source.url,
      bookSourceName: source.name,
      fallback: false,
    });
    if (items.length >= 10) break;
  }
  return items;
}

function fallbackResults($, source, baseUrl, key) {
  const pattern = String(source.bookUrlPattern || '').trim();
  let regex = null;
  if (pattern) {
    try {
      regex = new RegExp(pattern, 'i');
    } catch {
      regex = null;
    }
  }
  const items = [];
  const seen = new Set();
  $('a[href]').each((_, anchor) => {
    if (items.length >= 4) return;
    const href = $(anchor).attr('href') || '';
    const abs = absoluteUrl(href, baseUrl || source.url);
    if (!abs || /^javascript:/i.test(abs)) return;
    const text = cleanName($(anchor).text());
    if (!text || text.length < 2 || text.length > 60) return;
    if (/首页|上一页|下一页|登录|注册|书架|排行榜|全部|更多|分类|目录|最新章节|阅读/.test(text)) return;
    if (regex && !regex.test(abs)) return;
    if (!regex) {
      const needle = String(key || '').trim();
      if (needle && !text.includes(needle) && !abs.includes(encodeURIComponent(needle))) return;
    }
    if (seen.has(abs)) return;
    seen.add(abs);
    items.push({
      name: text,
      author: '',
      bookUrl: abs,
      coverUrl: '',
      intro: '',
      latestChapter: '',
      wordCount: '',
      kind: '',
      status: '',
      origin: source.url,
      originName: source.name,
      source: source.name,
      bookSourceUrl: source.url,
      bookSourceName: source.name,
      fallback: true,
    });
  });
  return items;
}

function parseSearchPage(source, text, baseUrl, key) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const jsonResults = parseJsonResults(source, trimmed, key);
    if (jsonResults.length) return jsonResults;
  }
  const $ = cheerio.load(trimmed);
  const rules = source.rules || {};
  if (String(rules.bookList || '').trim().startsWith('$')) return [];
  const root = $.root()[0];
  let items = [];
  try {
    items = parseHtmlResults($, root, source, baseUrl, key);
  } catch (error) {
    log(`parse ${source.name} failed: ${error.message}`);
  }
  if (!items.length) {
    try {
      items = fallbackResults($, source, baseUrl, key);
    } catch (error) {
      log(`fallback ${source.name} failed: ${error.message}`);
    }
  }
  return items;
}

/* ─────────────────────────── 搜索 URL ─────────────────────────── */

function normalizeHeaders(header) {
  const out = {};
  if (!header) return out;
  if (typeof header === 'string') {
    try {
      header = JSON.parse(header);
    } catch {
      return out;
    }
  }
  if (Array.isArray(header)) {
    for (const item of header) {
      if (item && item.name) out[item.name] = item.value;
    }
  } else if (typeof header === 'object') {
    for (const [key, value] of Object.entries(header)) {
      if (value != null && value !== '') out[key] = String(value);
    }
  }
  return out;
}

function buildSearchRequest(source, key, page = 1) {
  let raw = String(source.searchUrl || '').trim();
  if (!raw) return null;
  if (raw.startsWith('@js:')) return null;
  let options = {};
  const optionMatch = raw.match(/,\s*(\{[\s\S]*\})\s*$/);
  if (optionMatch) {
    const maybe = optionMatch[1];
    try {
      options = JSON.parse(maybe);
      raw = raw.slice(0, optionMatch.index).trim();
    } catch {
      options = {};
    }
  }
  let url = raw
    .replace(/\{\{key\}\}/g, encodeURIComponent(String(key || '').trim()))
    .replace(/\{\{page\}\}/g, String(page || 1));
  if (/\{\{/.test(url)) return null;
  if (!/^http(s)?:\/\//i.test(url)) {
    try {
      url = new URL(url, String(source.url || '').replace(/#.*$/, '')).toString();
    } catch {
      return null;
    }
  }
  let body = options.body || '';
  if (body) {
    body = String(body)
      .replace(/\{\{key\}\}/g, encodeURIComponent(String(key || '').trim()))
      .replace(/\{\{page\}\}/g, String(page || 1));
  }
  const headers = {
    ...normalizeHeaders(source.header),
    ...normalizeHeaders(options.headers),
  };
  if (!Object.keys(headers).some((h) => h.toLowerCase() === 'user-agent')) {
    headers['User-Agent'] = DEFAULT_UA;
  }
  if (!Object.keys(headers).some((h) => h.toLowerCase() === 'referer')) {
    headers.Referer = String(source.url || '').replace(/#.*$/, '');
  }
  if (body && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  return {
    url,
    method: String(options.method || (body ? 'POST' : 'GET')).toUpperCase(),
    headers,
    body,
    charset: options.charset || source.charset || '',
    timeout: options.timeout || 6000,
  };
}

function sourcePriority(source) {
  let score = 0;
  const group = String(source.group || '');
  if (group.includes('搜索链接规则为空')) score -= 20;
  if (group.includes('已检')) score -= 10;
  if (source.bookUrlPattern) score += 8;
  if (/^https:/i.test(source.url)) score += 2;
  if (source.name.includes('🎃')) score -= 3;
  if (source.rules?.bookList?.includes('class.grid')) score += 3;
  if (source.rules?.bookUrl) score += 3;
  return score;
}

/** 解析章节/更新时间，返回 epoch ms；无法解析返回 0（排序中视为中性）。 */
function bookTimeEpoch(item) {
  for (const field of ['updateTime', 'latestChapter', 'wordCount']) {
    const raw = String(item[field] || '').trim();
    if (!raw) continue;
    const m = raw.match(/(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/);
    if (m) {
      const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
      if (Number.isFinite(t)) return t;
    }
    const d = Date.parse(raw);
    if (Number.isFinite(d)) return d;
  }
  return 0;
}

/**
 * 排序口径（与 Reader 客户端检索优先级对齐）：
 * 书名完全匹配 > 别名/近似 > 作者匹配 > 最新章节时间新；书源可信度、非兜底作为附加分。
 */
function relevance(item, key) {
  const name = String(item.name || '');
  const author = String(item.author || '');
  const needle = String(key || '').trim();
  let score = 0;
  if (needle && name === needle) score += 100;            // 书名完全匹配
  if (needle && name.includes(needle)) score += 50;       // 别名/近似包含
  if (needle && author.includes(needle)) score += 20;     // 作者匹配
  const time = bookTimeEpoch(item);
  if (time > 0) score += Math.min(15, Math.round(time / 1e12)); // 最新章节时间新（兜底小分）
  if (!item.fallback) score += 10;
  if (!item.author) score -= 6;
  if (/影视|漫画|听书/.test(String(item.originName || ''))) score -= 30;
  if (/\/voddetail|\/api\/|get-album-list/.test(String(item.bookUrl || ''))) score -= 40;
  if (author.split(',').length >= 3) score -= 15;
  if (/最后更新|内容简介|作者：/.test(author)) score -= 30;
  score += Math.min(40, (Number(item.sourceCount) || 1) * 0.6);
  if (item.originName && !/🎃/.test(item.originName)) score += 2;
  return score;
}

/**
 * 搜全部书源。返回 items + 统计；任一本失败都不影响其它源。
 */

function sourceConfidence(item) {
  let score = 0;
  const name = String(item.originName || '');
  if (!item.fallback) score += 50;
  if (/顶点/.test(name)) score += 28;
  if (/笔趣阁|书吧|文学|读书|小说/.test(name)) score += 12;
  if (/影视|漫画|听书|音乐|听|国漫/.test(name)) score -= 15;
  if (/🎃/.test(name)) score -= 5;
  if (!isUsableBookUrl(item.bookUrl)) score -= 60;
  else score += 15;
  return score;
}

function groupResults(items, key) {
  const groups = new Map();
  for (const item of items) {
    const identity = `${collapseText(item.name).toLowerCase()}|${collapseText(item.author).toLowerCase()}`;
    let group = groups.get(identity);
    if (!group) {
      group = {
        ...item,
        _score: sourceConfidence(item),
        sources: item.originName
          ? [{ name: item.originName, url: item.bookSourceUrl, bookUrl: item.bookUrl, fallback: !!item.fallback }]
          : [],
      };
      groups.set(identity, group);
      continue;
    }
    if (item.originName && !group.sources.some((source) => source.name === item.originName && source.bookUrl === item.bookUrl)) {
      group.sources.push({ name: item.originName, url: item.bookSourceUrl, bookUrl: item.bookUrl, fallback: !!item.fallback });
    }
    const score = sourceConfidence(item);
    const usable = isUsableBookUrl(item.bookUrl);
    if ((!isUsableBookUrl(group.bookUrl) && usable) || score > group._score) {
      group._score = score;
      group.bookUrl = item.bookUrl;
      group.origin = item.origin;
      group.originName = item.originName;
      group.bookSourceUrl = item.bookSourceUrl;
      group.bookSourceName = item.bookSourceName;
      group.coverUrl = item.coverUrl || group.coverUrl;
      group.latestChapter = item.latestChapter || group.latestChapter;
      group.intro = item.intro || group.intro;
      group.fallback = item.fallback;
    }
  }
  return Array.from(groups.values()).map((group) => {
    const { _score, ...clean } = group;
    return {
      ...clean,
      sourceCount: group.sources.length,
    sourceLabel: group.sources.length > 1
      ? `${group.originName || group.sources[0]?.name || '书源'} 等 ${group.sources.length} 个源`
      : (group.originName || group.sources[0]?.name || '书源'),
    };
  });
}

export async function searchAllSources(query, options = {}) {
  const key = String(query || '').trim();
  if (!key) return { items: [], stats: { total: 0, searched: 0, withResults: 0, elapsedMs: 0 } };
  const cacheKey = `${key}::${options.limit || 300}`;
  const cached = queryCache.get(cacheKey);
  if (!options.force && !options.maxSources && cached && Date.now() - cached.at < 10 * 60 * 1000) {
    return cached.value;
  }

  const allSources = ensureSourceCache();
  const health = loadHealth();
  const sources = allSources
    .filter((source) => source.enabled !== false)
    .filter((source) => source.url && source.searchUrl && source.rules?.bookList)
    .sort((a, b) => {
      const hs = healthScore(health.sources[a.url]) - healthScore(health.sources[b.url]);
      if (hs !== 0) return hs;
      const sp = sourcePriority(b) - sourcePriority(a);
      if (sp !== 0) return sp;
      const ga = GOOD_NAME_PATTERNS.some((p) => p.test(a.name || '')) ? 1 : 0;
      const gb = GOOD_NAME_PATTERNS.some((p) => p.test(b.name || '')) ? 1 : 0;
      return gb - ga || String(a.name).localeCompare(String(b.name), 'zh');
    });

  const started = Date.now();
  const items = [];
  const stats = {
    total: sources.length,
    searched: 0,
    answered: 0,
    withResults: 0,
    failed: 0,
    empty: 0,
    skipped: 0,
    elapsedMs: 0,
  };
  const concurrency = Math.max(1, Math.min(Number(options.concurrency) || 120, 160));
  const perSourceTimeout = Number(options.timeout) || 4500;
  const maxTotal = Number(options.limit) || 300;
  const maxSources = Math.max(0, Number(options.maxSources) || 0);
  const limitedSources = maxSources ? sources.slice(0, maxSources) : sources;

  // 三波调度：
  // 三波都是每源独立计时、先完成先推 onItems，不用全局统一超时：
  // 波0 极快波 10 个快源 1200ms；波1 中速波 30 个 3000ms；波2 其余慢源放宽到 10s，后台补齐。
  const WAVE0_N = Math.min(10, limitedSources.length);
  const WAVE1_N = Math.min(30, Math.max(0, limitedSources.length - WAVE0_N));
  const wave0 = limitedSources.slice(0, WAVE0_N);
  const wave1 = limitedSources.slice(WAVE0_N, WAVE0_N + WAVE1_N);
  const wave2 = limitedSources.slice(WAVE0_N + WAVE1_N);
  const seenUrls = new Set();

  log(`search "${key}" across ${limitedSources.length} sources (fast ${wave0.length}, mid ${wave1.length}, slow ${wave2.length})`);

  const runWave = async (list, waveConcurrency, timeoutMs) => {
    await runPool(
      list,
      waveConcurrency,
      async (source) => {
      const request = buildSearchRequest(source, key, 1);
      if (!request) {
        stats.skipped++;
        return;
      }
      const t0 = Date.now();
      try {
        const response = await fetchText(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          charset: request.charset,
          timeout: timeoutMs,
        });
        stats.answered++;
        recordHealth(source.url, true, Date.now() - t0);
        if (response.status >= 400) {
          stats.failed++;
          return;
        }
        const found = parseSearchPage(source, response.body, response.url || request.url, key);
        if (!found.length) {
          stats.empty++;
          return;
        }
        stats.withResults++;
        const added = [];
        for (const item of found) {
          if (!item.bookUrl || seenUrls.has(item.bookUrl) || isJunkItem(item)) continue;
          seenUrls.add(item.bookUrl);
          items.push(item);
          added.push(item);
        }
        // 边搜边出：某个源一有命中就立刻把新条目吐给调用方（页面据此增量追加）
        if (added.length && typeof options.onItems === 'function') {
          try { options.onItems(added, { done: stats.searched, total: limitedSources.length, hits: items.length }); } catch { /* ignore */ }
        }
      } catch (error) {
        stats.failed++;
        recordHealth(source.url, false, Date.now() - t0);
        if (stats.failed % 100 === 0) log(`search failures ${stats.failed}: ${source.name} ${error.message}`);
      } finally {
        stats.searched++;
      }
    },
    (done, total) => {
      if (done % 300 === 0) log(`progress ${done}/${total}, hits ${items.length}`);
      if (typeof options.onProgress === 'function') {
        try {
          options.onProgress({
            done,
            total,
            hits: items.length,
            sourcesWithResults: stats.withResults,
            answered: stats.answered,
            failed: stats.failed,
            skipped: stats.skipped,
          });
        } catch { /* ignore callback errors */ }
      }
    }
  );
  };

  await runWave(wave0, Math.min(10, wave0.length), 1200);
  await runWave(wave1, Math.min(24, wave1.length), 3000);
  await runWave(wave2, Math.min(60, wave2.length), Math.max(perSourceTimeout, 10000));
  persistHealth();

  stats.elapsedMs = Date.now() - started;
  items.sort((a, b) => relevance(b, key) - relevance(a, key) || String(a.name).localeCompare(String(b.name), 'zh'));
  const grouped = groupResults(items, key);
  grouped.sort((a, b) => relevance(b, key) - relevance(a, key) || String(a.name).localeCompare(String(b.name), 'zh'));
  const finalItems = grouped.slice(0, maxTotal);
  stats.returned = finalItems.length;
  stats.unique = items.length;
  stats.books = grouped.length;
  stats.sourceNames = new Set(items.map((item) => item.originName).filter(Boolean)).size;
  lastStats = stats;
  const value = { items: finalItems, stats };
  if (!options.maxSources) {
    queryCache.set(cacheKey, { at: Date.now(), value });
    if (queryCache.size > 20) queryCache.delete(queryCache.keys().next().value);
  }
  log(`search "${key}" done: ${stats.withResults}/${stats.searched} sources with results, ${items.length} books -> ${grouped.length} groups, ${stats.elapsedMs}ms`);
  if (typeof options.onProgress === 'function') {
    try {
      options.onProgress({
        done: stats.searched,
        total: sources.length,
        hits: items.length,
        sourcesWithResults: stats.withResults,
        answered: stats.answered,
        failed: stats.failed,
        skipped: stats.skipped,
        finished: true,
      });
    } catch { /* ignore */ }
  }
  return value;
}

export function groupKeyOf(item) {
  return `${collapseText(item.name).toLowerCase()}|${collapseText(item.author).toLowerCase()}`;
}

export function groupBooks(items, key = '') {
  return groupResults(items, key);
}

export function getLastSearchStats() {
  return lastStats;
}

export function debugSelector(html, rule) {
  const $ = cheerio.load(html);
  const root = $.root()[0];
  const nodes = queryNodes([root], rule);
  return {
    count: nodes.length,
    samples: nodes.slice(0, 3).map((node) => ({
      name: node.name,
      class: node.attribs?.class || '',
      id: node.attribs?.id || '',
      text: collapseText($(node).text()).slice(0, 80),
    })),
  };
}

export function debugFields(html, sourceName) {
  const source = (sourceCache || ensureSourceCache()).find((item) => item.name === sourceName);
  if (!source) return { error: 'source not found' };
  const $ = cheerio.load(html);
  const root = $.root()[0];
  const nodes = queryNodes([root], source.rules.bookList);
  return {
    rule: source.rules.bookList,
    count: nodes.length,
    rows: nodes.slice(0, 3).map((node) => ({
      text: collapseText($(node).text()).slice(0, 100),
      name: queryRule([node], source.rules.name),
      author: queryRule([node], source.rules.author),
      bookUrl: queryRule([node], source.rules.bookUrl),
      href: extractNodes(stepNodes([node], 'tag.a'), 'href'),
    })),
  };
}

/** 调试单个书源：返回请求、HTTP 状态、页面片段和解析结果。 */
export async function debugSearchSource(nameOrUrl, key) {
  const sources = ensureSourceCache();
  const source = sources.find(
    (item) => item.name === nameOrUrl || item.url === nameOrUrl || item.name.includes(nameOrUrl)
  );
  if (!source) return { error: `source not found: ${nameOrUrl}` };
  const request = buildSearchRequest(source, key, 1);
  if (!request) return { source, error: 'no request' };
  const response = await fetchText(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    charset: request.charset,
    timeout: 8000,
  });
  const items = parseSearchPage(source, response.body, response.url || request.url, key);
  return {
    source,
    request,
    status: response.status,
    bodyLength: response.body.length,
    bodyStart: response.body.slice(0, 1200),
    items,
  };
}
