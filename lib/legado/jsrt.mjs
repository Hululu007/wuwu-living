#!/usr/bin/env node
/**
 * @js / <js> 运行时：node:vm 沙箱 + legado java.* / source.* 桥。
 *
 * 桥接分层：
 *  - java.ajax/ajaxAll：同步 HTTP（curl 子进程，6s 超时，失败抛错由脚本 try/catch 兜底）；
 *  - java.get/put：单次解析任务内的会话键值；
 *  - source.getVariable/setVariable：书源级变量（进程内 Map，不跨进程持久化）；
 *  - 编码/加密：base64、hex、md5、digestHex；
 *  - buildRequest/backend：请求描述符最小实现；refreshExplore/toast/log 等为 noop。
 *
 * 已知限制（不假装完整）：
 *  - 同步 ajax 经 curl 子进程，调用期间会阻塞事件循环；单次 6s 超时，脚本内通常仅 1 次；
 *  - 不携带 WebView cookie jar、不做 JS 挑战、不渲染页面；
 *  - AES/DES/HMac/字体解码/浏览器拉起等重型桥未实现，调用返回空或抛可捕获错误。
 */

import vm from 'node:vm';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chainNodes } from './selector.mjs';
import * as cheerio from 'cheerio';

// 纯脚本无网络时毫秒级返回；含同步 ajax 的脚本允许等到 ajax 6s 上限，故 vm 超时放宽到 30s。
const JS_TIMEOUT_MS = 30000;
const AJAX_TIMEOUT_MS = 6000;
const MAX_BUFFER = 16 * 1024 * 1024;

/** 书源级变量存储（进程内，key=bookSourceUrl）。 */
const sourceVarStore = new Map();

/** 书源级会话键值：详情 → 目录 → 正文跨调用保留。 */
const sourceSessionStore = new Map();

function collapse(v) {
  return String(v == null ? '' : v).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

/* ─────────────────────── 同步 HTTP（curl 子进程） ─────────────────────── */

/**
 * 解析请求描述符：url 字符串，或 `url,{method,body,headers,timeout}`，或对象。
 */
function parseRequest(input, opts) {
  let url = '';
  let method = 'GET';
  let body = null;
  let headers = {};
  let timeout = AJAX_TIMEOUT_MS;

  if (input && typeof input === 'object') {
    url = input.url || '';
    method = (input.method || 'GET').toUpperCase();
    body = input.body != null ? (typeof input.body === 'string' ? input.body : JSON.stringify(input.body)) : null;
    headers = input.headers || {};
    timeout = input.timeout || timeout;
  } else {
    const raw = String(input || '');
    const comma = raw.indexOf(',{');
    if (comma >= 0) {
      url = raw.slice(0, comma);
      try {
        const extra = JSON.parse(raw.slice(comma + 1));
        method = (extra.method || 'GET').toUpperCase();
        body = extra.body != null ? (typeof extra.body === 'string' ? extra.body : JSON.stringify(extra.body)) : null;
        headers = extra.headers || {};
        timeout = extra.timeout || timeout;
      } catch {
        // 描述符非法时按纯 URL 处理
      }
    } else {
      url = raw;
    }
  }

  if (opts && typeof opts === 'object') {
    if (opts.method) method = String(opts.method).toUpperCase();
    if (opts.body != null) body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    if (opts.headers) headers = { ...headers, ...opts.headers };
    if (opts.timeout) timeout = Number(opts.timeout);
  }

  return { url, method, body, headers, timeout };
}

/** 同步发起一次 HTTP，返回响应文本；失败抛错。 */
function syncHttp(input, opts) {
  const req = parseRequest(input, opts);
  if (!/^https?:\/\//i.test(req.url)) throw new Error(`ajax 地址非法：${req.url}`);

  const timeoutSec = Math.max(1, Math.round(Math.min(req.timeout || AJAX_TIMEOUT_MS, AJAX_TIMEOUT_MS) / 1000));
  const args = [
    '-sS',
    '-L',
    '--compressed',
    '-m',
    String(timeoutSec),
    '-A',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  ];
  for (const [k, v] of Object.entries(req.headers || {})) {
    if (v != null) args.push('-H', `${k}: ${v}`);
  }
  if (req.method !== 'GET') {
    args.push('-X', req.method);
    if (req.body != null) args.push('--data-binary', req.body);
  }
  args.push(req.url);

  const out = execFileSync('curl', args, {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    timeout: Math.min(Number(req.timeout) || AJAX_TIMEOUT_MS, AJAX_TIMEOUT_MS),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out || '';
}

/* ─────────────────────── 编码 / 加密辅助 ─────────────────────── */

function md5Hex(str) {
  return crypto.createHash('md5').update(String(str)).digest('hex');
}

/* ─────────────────────── 节点代理 ─────────────────────── */

function nodeProxy(node) {
  if (!node) return null;
  const $ = cheerio.load('');
  return {
    text: collapse($(node).text()),
    href: $(node).attr('href') || '',
    src: $(node).attr('src') || $(node).attr('data-src') || '',
    get html() {
      return $(node).html() || '';
    },
  };
}

/**
 * 创建一次解析任务对应的 js 运行时。
 * @param {object} ctx 求值上下文
 * @param {(rule:string, nodes:any[])=>string} selectorEval 选择器求值回调
 */
/** 按书源缓存的 js 运行时（同一源的目录/正文条目复用同一上下文，避免逐章创建 vm 上下文）。 */
const rtCache = new Map();

export function createRuntime(ctx, selectorEval) {
  const sourceUrl = ctx.source?.url || '';
  const evalRef = { fn: selectorEval };
  let session = sourceSessionStore.get(sourceUrl);
  if (!session) {
    session = new Map();
    sourceSessionStore.set(sourceUrl, session);
  }

  const cached = rtCache.get(sourceUrl);
  if (cached) {
    evalRef.fn = selectorEval;
    cached.update(ctx);
    return cached;
  }

  const getVar = () => sourceVarStore.get(sourceUrl) || '';
  const setVar = (v) => {
    sourceVarStore.set(sourceUrl, v == null ? '' : String(v));
  };

  const sourceBridge = {
    getVariable: getVar,
    setVariable: setVar,
    getKey: () => sourceUrl,
    get url() {
      return sourceUrl;
    },
    get bookSourceUrl() {
      return sourceUrl;
    },
    get header() {
      return ctx.source?.header || '';
    },
    get loginUrl() {
      return ctx.source?.loginUrl || '';
    },
    get bookSourceComment() {
      return ctx.source?.group || '';
    },
    put: (k, v) => session.set(String(k), v),
    get: (k) => session.get(String(k)),
  };

  const javaBridge = {
    /* ── HTTP ── */
    ajax: (urlOrReq, opts) => syncHttp(urlOrReq, opts),
    ajaxAll: (urls) => (Array.isArray(urls) ? urls.map((u) => syncHttp(u)) : []),
    post: (url, body, headers) => syncHttp(url, { method: 'POST', body, headers }),

    /* ── 会话 / 变量 ── */
    get: (k) => session.get(String(k)),
    put: (k, v) => session.set(String(k), v),
    getCookie: (name) => {
      if (ctx.cookie && typeof ctx.cookie === 'object' && ctx.cookie[name] != null) return ctx.cookie[name];
      return '';
    },

    /* ── 取值桥 ── */
    getString: (rule, node) => {
      try {
        return evalRef.fn(String(rule || ''), node || ctx.rootNodes) || '';
      } catch {
        return '';
      }
    },
    getElement: (rule, node) => {
      try {
        const nodes = chainNodes(node || ctx.rootNodes || [], String(rule || ''));
        return nodeProxy(nodes[0]);
      } catch {
        return null;
      }
    },
    getElements: (rule, node) => {
      try {
        const nodes = chainNodes(node || ctx.rootNodes || [], String(rule || ''));
        return nodes.map((n) => nodeProxy(n));
      } catch {
        return [];
      }
    },
    getStringList: (rule, node) => {
      try {
        const nodes = chainNodes(node || ctx.rootNodes || [], String(rule || ''));
        return nodes.map((n) => nodeProxy(n)?.text || '').filter(Boolean);
      } catch {
        return [];
      }
    },

    /* ── base64 / hex ── */
    base64Encode: (str) => Buffer.from(String(str ?? ''), 'utf-8').toString('base64'),
    base64Decode: (str) => {
      try {
        return Buffer.from(String(str ?? ''), 'base64').toString('utf-8');
      } catch {
        return '';
      }
    },
    base64DecodeToByteArray: (str) => Array.from(Buffer.from(String(str ?? ''), 'base64')),
    base64Decoder: (str) => javaBridge.base64Decode(str),
    hexDecodeToString: (hex) => {
      const raw = String(hex ?? '').replace(/\s/g, '');
      // 纯数字 ID 源未编码，原样透传，避免二次解码成乱码
      if (/^\d+$/.test(raw)) return raw;
      try {
        const buf = Buffer.from(raw, 'hex');
        // 非可打印/含 NUL 时按 base64 兜底（部分源把 base64 误当 hex 调用）
        if (buf.length && !buf.includes(0) && /^[\x20-\x7e一-鿿]+$/.test(buf.toString('utf-8'))) {
          return buf.toString('utf-8');
        }
      } catch {
        // 落到 base64 兜底
      }
      try {
        return Buffer.from(raw, 'base64').toString('utf-8');
      } catch {
        return '';
      }
    },
    hexEncodeToString: (str) => Buffer.from(String(str ?? ''), 'utf-8').toString('hex'),
    hexDecodeToByteArray: (hex) => Array.from(Buffer.from(String(hex ?? '').replace(/\s/g, ''), 'hex')),

    /* ── 摘要 ── */
    md5Encode: (str) => md5Hex(str),
    md5Encode16: (str) => md5Hex(str).slice(8, 24),
    digestHex: (algo, str) => {
      try {
        return crypto.createHash(String(algo).toLowerCase()).update(String(str ?? '')).digest('hex');
      } catch {
        return '';
      }
    },

    /* ── 编码 / 时间 ── */
    encodeURI: (str) => encodeURIComponent(String(str ?? '')),
    decodeURI: (str) => {
      try {
        return decodeURIComponent(String(str ?? ''));
      } catch {
        return '';
      }
    },
    timeFormat: (time, pattern) => {
      const d = new Date(Number(time) || Date.now());
      if (Number.isNaN(d.getTime())) return '';
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    },
    timeFormatUTC: (time) => {
      const d = new Date(Number(time) || Date.now());
      if (Number.isNaN(d.getTime())) return '';
      return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
    },
    toNumChapter: (name) => {
      const m = String(name || '').match(/\d+/);
      return m ? Number(m[0]) : 0;
    },
    lang: () => 'zh',
    t2s: (str) => String(str ?? ''),

    /* ── 日志 / 界面（noop） ── */
    log: () => {},
    toast: () => {},
    longToast: () => {},
    refreshExplore: () => {},
    refreshTocUrl: () => {},
    refreshBookUrl: () => {},
    refreshBookInfo: () => {},
    startBrowser: () => {},
    startBrowserAwait: () => {},
    openUrl: () => {},
    showPhoto: () => {},
    createSymmetricCrypto: () => null,
    createAsymmetricCrypto: () => null,
    aesBase64DecodeToString: () => '',
    desEncodeToBase64String: () => '',
    HMacHex: () => '',
    HMacBase64: () => '',
    randomUUID: () => crypto.randomUUID(),
    getWebViewUA: () => javaBridge.getString ? '' : '',
  };

  const sandbox = {
    key: ctx.key || '',
    page: ctx.page || 1,
    book: ctx.book || {},
    chapter: ctx.chapter || {},
    source: sourceBridge,
    cookie: ctx.cookie || {},
    baseUrl: ctx.baseUrl || '',
    result: ctx.result != null ? ctx.result : '',
    java: javaBridge,
    log: () => {},
    toast: () => {},
    // 全局请求描述符构造器：返回 {url,method,headers,body}
    buildRequest: (arg, opts) => {
      if (arg && typeof arg === 'object') return arg;
      const req = parseRequest(arg, opts);
      return { url: req.url, method: req.method, headers: req.headers, body: req.body };
    },
    backend: '',
    src: sourceUrl,
  };

  const context = vm.createContext(sandbox);

  // 载入书源 jsLib（只定义函数/常量，异常不阻断主流程）
  if (ctx.source && typeof ctx.source.jsLib === 'string' && ctx.source.jsLib.trim()) {
    try {
      vm.runInContext(ctx.source.jsLib, context, { timeout: JS_TIMEOUT_MS, displayErrors: false });
    } catch {
      // jsLib 载入失败忽略
    }
  }

  /**
   * 执行脚本。
   * @param {string} code
   * @param {string|undefined} currentResult
   * @returns {string}
   */
  function run(code, currentResult) {
    if (!code || !code.trim()) return currentResult == null ? '' : String(currentResult);
    sandbox.result = currentResult == null ? '' : currentResult;
    // js 字符串内的 {{...}} 模板先求值，避免残留为字面量导致分支走错。
    const prepared = String(code).replace(/\{\{([\s\S]*?)\}\}/g, (_m, expr) => {
      try {
        const v = evalRef.fn(expr.trim(), ctx.rootNodes);
        return v == null ? '' : String(v);
      } catch {
        return '';
      }
    });
  // 复用上下文时，顶层 let/const 会在第二次执行时重复声明；降级为 var 以允许重复执行。
    const body = prepared
      .replace(/\blet\s+/g, 'var ')
      .replace(/\bconst\s+/g, 'var ');
    try {
      // 直接在上下文执行，取完成值（V8/Rhino 均返回末条表达式结果，含 if/else 分支）
      const out = vm.runInContext(body, context, { timeout: JS_TIMEOUT_MS, displayErrors: false });
      if (out !== undefined && out !== null) return out;
      return sandbox.result ?? '';
    } catch {
      return sandbox.result ?? '';
    }
  }

  function update(c) {
    sandbox.key = c.key || '';
    sandbox.page = c.page || 1;
    sandbox.book = c.book || {};
    sandbox.chapter = c.chapter || {};
    sandbox.cookie = c.cookie || {};
    sandbox.baseUrl = c.baseUrl || '';
    sandbox.result = c.result != null ? c.result : '';
  }

  const rt = { run, sandbox, update };
  rtCache.set(sourceUrl, rt);
  return rt;
}
