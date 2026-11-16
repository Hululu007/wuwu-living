#!/usr/bin/env node
/**
 * Legado 书源抓取层：HTTP/HTTPS 请求、header 安全解析、编码解码。
 *
 * 职责边界：
 *  - 只负责「把 URL 变成文本 / JSON」，不解析规则；
 *  - header 支持对象、JSON 字符串、Python 风格单引号字符串三种形态；
 *  - 编码优先级：书源显式 charset > Content-Type 声明 > 严格 UTF-8 试解 > gb18030 兜底；
 *  - 所有函数失败都抛带中文说明的 Error，由上层 index.mjs 兜底成 {ok:false}。
 */

import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 64,
  rejectUnauthorized: false,
});

/* ───────────────────────── header 安全解析 ───────────────────────── */

/**
 * Python 风格字典字符串（{'User-Agent': '...', "Referer": '...'}）的安全解析。
 * 不使用 eval；只接受字符串键值，跳过非法片段。
 */
function parsePythonDict(text) {
  const out = {};
  // 去掉最外层花括号
  const inner = String(text).trim().replace(/^\{/, '').replace(/\}$/, '');
  // 按顶层逗号切分（值内部不含逗号包裹的引号场景有限，先做简单切分再逐对解析）
  const pairs = inner.split(/,\s*(?=['"])/);
  for (const pair of pairs) {
    const m = pair.match(/^\s*['"]([^'"]+)['"]\s*:\s*['"]([\s\S]*)['"]\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/**
 * 解析书源 header：可能是对象、JSON 字符串、Python 风格字符串。
 * @param {object|string|null|undefined} raw
 * @param {string|null} cookie 单独的 cookie 字段，合并到 header.Cookie
 * @returns {Record<string,string>} 已合并默认 UA / 接受语言的最终请求头
 */
export function parseHeader(raw, cookie) {
  const headers = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      if (v != null) headers[k] = String(v);
    }
  } else if (typeof raw === 'string' && raw.trim()) {
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) {
          if (v != null) headers[k] = String(v);
        }
      }
    } catch {
      // JSON 失败再走 Python 风格解析
      parsed = parsePythonDict(raw);
      Object.assign(headers, parsed);
    }
  }

  // cookie 单独字段合并（header 内已存在 Cookie 时，字段值追加在前面）
  if (cookie) {
    const existing = headers.Cookie || headers.cookie || '';
    headers.Cookie = existing ? `${cookie}; ${existing}` : String(cookie);
    delete headers.cookie;
  }

  // 兜底默认头
  headers['User-Agent'] = headers['User-Agent'] || headers['user-agent'] || DEFAULT_UA;
  if (!('Accept-Language' in headers)) headers['Accept-Language'] = 'zh-CN,zh;q=0.9,en;q=0.8,en;q=0.7';
  headers.Accept = headers.Accept || 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8';

  // 键名规范化（小写冲突的合并）
  const normalized = {};
  for (const [k, v] of Object.entries(headers)) {
    normalized[k] = v;
  }
  return normalized;
}

/* ───────────────────────── 编码解码 ───────────────────────── */

/** 归一化字符集别名。 */
function normalizeCharset(charset) {
  const c = String(charset || '').trim().toLowerCase();
  if (!c) return '';
  if (c === 'gbk' || c === 'gb2312' || c === 'gb18030') return 'gb18030';
  if (c === 'utf8') return 'utf-8';
  if (c === 'big5' || c === 'big-5' || c === 'big5hkscs') return 'big5';
  return c;
}

/** 是否为合法可解码的字符集（TextDecoder 不认识的会抛错）。 */
function decoderExists(charset) {
  try {
    new TextDecoder(charset);
    return true;
  } catch {
    return false;
  }
}

/**
 * 严格 UTF-8 试解：fatal 模式下遇到非法字节抛错。
 */
function decodeStrict(buffer) {
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
}

/**
 * 解码响应 buffer。
 * 优先级：显式 charset > Content-Type > 严格 UTF-8 > gb18030 兜底；不允许乱码静默通过。
 */
export function decodeBuffer(buffer, contentType, charsetHint) {
  const explicit = normalizeCharset(charsetHint);
  const fromHeader = normalizeCharset(
    String(contentType || '').match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1]
  );

  // 1) 显式 / Content-Type 指定的非 UTF-8 字符集直接解码
  for (const candidate of [explicit, fromHeader]) {
    if (candidate && candidate !== 'utf-8' && decoderExists(candidate)) {
      try {
        return new TextDecoder(candidate).decode(buffer);
      } catch {
        // 继续走兜底
      }
    }
  }

  // 2) 严格 UTF-8 试解；成功即采用
  try {
    return decodeStrict(buffer);
  } catch {
    // 含非 UTF-8 字节，落到 gb18030
  }

  // 3) gb18030 兜底（中文站覆盖 gbk/gb2312）
  if (decoderExists('gb18030')) {
    return new TextDecoder('gb18030').decode(buffer);
  }
  return new TextDecoder('utf-8').decode(buffer);
}

/* ───────────────────────── 原生请求 ───────────────────────── */

const MAX_BYTES = 12 * 1024 * 1024;

/**
 * 抓取文本。
 * @param {string} url
 * @param {{headers?:object, charset?:string, timeoutMs?:number, method?:string, body?:string, redirects?:number}} opts
 * @returns {Promise<{url:string, status:number, text:string, headers:object}>}
 */
export function fetchText(url, opts = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`URL 解析失败：${url}`));
      return;
    }
    if (!/^https?:$/.test(parsed.protocol)) {
      reject(new Error(`不支持的协议：${parsed.protocol}`));
      return;
    }
    const transport = parsed.protocol === 'https:' ? https : http;
    const headers = {
      Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      Connection: 'keep-alive',
      ...Object.fromEntries(
        Object.entries(opts.headers || {}).filter(([, v]) => v != null && v !== '')
      ),
    };

    const timer = setTimeout(() => req.destroy(new Error(`请求超时（${opts.timeoutMs || 8000}ms）`)), opts.timeoutMs || 8000);

    const req = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: opts.method || 'GET',
        headers,
        agent: parsed.protocol === 'https:' ? httpsAgent : httpAgent,
        rejectUnauthorized: false,
        servername: parsed.hostname,
        family: 4,
      },
      (response) => {
        const status = response.statusCode || 0;
        const location = response.headers.location;
        if ([301, 302, 303, 307, 308].includes(status) && location) {
          response.resume();
          if (redirects >= 6) {
            reject(new Error('重定向次数过多'));
            return;
          }
          let next;
          try {
            next = new URL(location, url).toString();
          } catch {
            reject(new Error(`重定向地址无效：${location}`));
            return;
          }
          const nextOpts = { ...opts };
          if (status === 303) {
            nextOpts.method = 'GET';
            nextOpts.body = undefined;
          }
          clearTimeout(timer);
          fetchText(next, nextOpts, redirects + 1).then(resolve, reject);
          return;
        }

        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            response.destroy(new Error('响应体过大，已截断'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', (err) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        });
        response.on('end', () => {
          clearTimeout(timer);
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

            const text = decodeBuffer(buffer, response.headers['content-type'], opts.charset);
            resolve({ url: response.headers.location || url, status, text, headers: response.headers });
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      }
    );

    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(`网络错误：${String(err)}`));
    });

    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/** 抓取并解析 JSON；解析失败返回 {text, json:null} 供上层按 HTML 回落。 */
export async function fetchJson(url, opts = {}) {
  const res = await fetchText(url, opts);
  let json = null;
  if (res.text) {
    try {
      json = JSON.parse(res.text);
    } catch {
      json = null;
    }
  }
  return { ...res, json };
}
