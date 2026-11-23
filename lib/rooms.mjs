/**
 * 房间注册表 —— 新房子的统一入口
 *
 * 每间新房是一个 lib/<id>.mjs 模块，自己管自己的路由、数据和页面。
 * 这个文件只做三件事：
 *   1. 声明所有房间（id、名字、主色、页面文件）
 *   2. 把 /<id>/ 的页面请求和 /api/<id>/... 的接口请求分发给对应模块
 *   3. 汇总每间房的小结（summary），给首页概览用；任一模块出错都不许拖垮客厅
 *
 * 模块契约（四间新房都必须遵守）：
 *   export const meta = { id, name, color }
 *   export async function handle(ctx) -> bool     // 返回 true 表示已处理
 *   export async function summary() -> object     // 首页用的小结，禁止抛错
 *   export async function init() -> void          // 可选，启动时准备数据
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { injectEmbedFlag } from './embed_flag.mjs';
import { appendLog } from './log_dir.mjs';
import { readJson, readRaw } from './http_body.mjs';
import { sendFile } from './http_file.mjs';
import { runtimePath } from './runtime_dir.mjs';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(LIB_DIR, '..');

/** 房间清单：主色都是原来四间房没用过的颜色 */
export const ROOM_LIST = [
  { id: 'download', name: '下载中心', color: '#5FADA8', page: '下载中心.html' },
  { id: 'library', name: '媒体库', color: '#9CAC69', page: '媒体库.html' },
  { id: 'notes', name: '笔记库', color: '#C0B79C', page: '笔记库.html' },
  { id: 'calendar', name: '追更日历', color: '#C489A9', page: '追更日历.html' },
  { id: 'photos', name: '相册', color: '#7FB4C4', page: '相册.html' },
  { id: 'cast', name: '投屏', color: '#E0A46E', page: '投屏.html' },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};
export const mimeOf = (p) => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';

const loaded = new Map(); // id -> module
const missing = new Map(); // id -> error message

/* ───────────────────────── 通用响应工具 ───────────────────────── */

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, body, type = 'text/plain; charset=utf-8', code = 200, extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(code, Object.assign({
    'content-type': type,
    'cache-control': 'no-store',
    'content-length': buf.length,
  }, extra));
  res.end(buf);
}

function readJsonBody(req, limit = 2 * 1024 * 1024) {
  return readJson(req, { limit });
}

function readRawBody(req, limit = 64 * 1024 * 1024) {
  return readRaw(req, { limit });
}

/** 给每个房间的上下文对象 —— 新房只需要会用 ctx，不必再碰 hub.mjs */
function makeCtx(req, res, url, id) {
  return {
    id,
    req,
    res,
    url,
    p: url.pathname,
    // HEAD 在语义上等同 GET（只是不要响应体，Node 对 HEAD 请求本身就不会发 body）。
    // 旧写法把 method 原样透传，所有 `ctx.method === 'GET'` 的文件/媒体路由
    // 对 HEAD 一律回 404 —— 播放器与探测工具（curl -I、部分 CDN 预检）
    // 拿到的不是元信息而是"没有这个页面"。
    method: req.method === 'HEAD' ? 'GET' : (req.method || 'GET'),
    head: req.method === 'HEAD',
    query: url.searchParams,
    ROOT,
    log: (msg) => {
      try { appendLog('rooms.log', `[${new Date().toISOString()}] ${id}: ${msg}\n`); } catch {}
    },
    json: (code, obj) => sendJson(res, code, obj),
    text: (body, type, code, extra) => sendText(res, body, type, code, extra),
    html: (body, code = 200) => sendText(res, body, MIME['.html'], code),
    body: () => readJsonBody(req),
    raw: (limit) => readRawBody(req, limit),
    /** 发送项目内文件；支持 Range，视频拖动进度需要 */
    file: async (absPath, extra = {}) => {
      await sendFile(req, res, absPath, { mimeOf, sendJson, headers: extra });
      return true;
    },
    /** runtime/ 下的数据文件绝对路径 */
    runtime: (name) => runtimePath(ROOT, name),
    /** 确保目录存在（同步创建，只用于启动期与写文件前，开销极小） */
    ensureDir: (dir) => { try { fs.mkdirSync(dir, { recursive: true }); } catch {} return dir; },
  };
}

/** 读一份房间自己的配置（config/<id>.json），缺字段就用默认值 */
export function roomConfig(id, defaults = {}) {
  const file = path.join(ROOT, 'config', `${id}.json`);
  let disk = {};
  try { disk = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch {}
  return Object.assign({}, defaults, disk);
}

/* ───────────────────────── 加载 ───────────────────────── */

export async function loadRooms(opts = {}) {
  const initTimeoutMs = Number(opts.initTimeoutMs || 8000);
  for (const room of ROOM_LIST) {
    const modPath = path.join(LIB_DIR, `${room.id}.mjs`);
    if (!fs.existsSync(modPath)) {
      missing.set(room.id, `缺模块 lib/${room.id}.mjs`);
      continue;
    }
    try {
      let bootTimer;
      const timeout = new Promise((_, reject) => {
        bootTimer = setTimeout(() => reject(new Error(`房间初始化超时（${initTimeoutMs}ms）`)), initTimeoutMs);
      });
      const roomBoot = Promise.resolve().then(async () => {
        const mod = await import(pathToFileURL(modPath).href);
        if (typeof mod.init === 'function') {
          await mod.init();
        }
        return mod;
      });
      try {
        const mod = await Promise.race([roomBoot, timeout]);
        clearTimeout(bootTimer);
        loaded.set(room.id, mod);
        missing.delete(room.id);
      } catch (e) {
        clearTimeout(bootTimer);
        throw e;
      }
    } catch (e) {
      missing.set(room.id, `模块加载/初始化失败: ${e && e.message}`);
      console.error(`[rooms] 加载 ${room.id} 失败:`, e && (e.stack || e.message));
    }
  }
  const ok = [...loaded.keys()];
  console.log(`[rooms] 已挂载 ${ok.length}/${ROOM_LIST.length}: ${ok.join(' ')}`);
  return { ok, missing: [...missing.keys()] };
}

export const roomsReady = () => [...loaded.keys()];
export const roomsMissing = () => [...missing.entries()];

/* ───────────────────────── 分发 ───────────────────────── */

const byId = (id) => ROOM_LIST.find((r) => r.id === id);

/** 静态资源：/assets/room.css 之类，只认 public/assets/ 白名单目录 */
async function serveAsset(ctx) {
  const rel = ctx.p.slice('/assets/'.length);
  if (!rel || rel.includes('..')) return ctx.json(404, { ok: false, message: '没有这个资源' });
  const abs = path.join(ROOT, 'public', 'assets', rel);
  if (!abs.startsWith(path.join(ROOT, 'public', 'assets'))) return ctx.json(404, { ok: false });
  if (!fs.existsSync(abs)) return ctx.json(404, { ok: false, message: '没有这个资源' });
  // ★ 2026-11-22 修：/assets/ 原先走 sendFile 的默认分支 `cache-control: no-store`，
  //   每个页面访问都要重新下载全部共享样式（实测 room.css 13892B + legacy-shell.css 8910B）。
  //   sendFile 支持用 headers 覆盖默认头（http_file.mjs:80-84，extra 在 Object.assign 之后），
  //   所以这里直接给强缓存 + 弱 ETag：
  //   · 同一 mtime+size 的文件浏览器不再回源（命中本地缓存）
  //   · 改了文件 mtime 就变，ETag 随之变化，浏览器会重新取 ⇒ 不会"改了看不到"
  //   不用 immutable / 长 max-age 的原因：这些是共享样式，改一次要全站生效，60 秒是安全窗口。
  let etag = null;
  try {
    const st = fs.statSync(abs);
    etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    // 带 If-None-Match 且命中 ⇒ 直接 304，连 body 都不用发
    const inm = ctx.req && ctx.req.headers ? ctx.req.headers['if-none-match'] : undefined;
    if (inm && etag && inm === etag) {
      ctx.res.writeHead(304, { etag, 'cache-control': 'public, max-age=60', 'content-length': '0' });
      ctx.res.end();
      return true;
    }
  } catch {}
  const hdrs = { 'cache-control': 'public, max-age=60' };
  if (etag) hdrs.etag = etag;
  await ctx.file(abs, hdrs);
  return true;
}

/**
 * 房间路由总入口。返回 true 表示已经处理完，hub 不用再管。
 *   /<id>          -> 308 到 /<id>/
 *   /<id>/         -> 房间页面
 *   /api/<id>/...  -> 房间模块自己处理
 *   /assets/...    -> 共享样式与图片
 */
export async function roomRoutes(req, res, url) {
  const ctx = makeCtx(req, res, url, 'hub');
  const p = url.pathname;

  if (p.startsWith('/assets/')) return serveAsset(ctx);

  // 房间 id：页面是 /<id>/...，接口是 /api/<id>/...
  const isApi = p.startsWith('/api/');
  const seg = isApi ? (p.split('/')[2] || '') : (p.split('/')[1] || '');
  const room = byId(seg);
  if (!room) return false;

  const prefix = '/' + room.id;
  const apiPrefix = '/api/' + room.id + '/';

  if (isApi) {
    const mod = loaded.get(room.id);
    if (!mod) {
      return ctx.json(503, { ok: false, message: `《${room.name}》还没装好：${missing.get(room.id) || '未加载'}` });
    }
    ctx.id = room.id;
    const handled = await mod.handle(makeCtx(req, res, url, room.id));
    if (handled === true) return true;
    if (handled === false) return ctx.json(404, { ok: false, message: '这个接口不存在' });
    return true;
  }

  // 页面
  if (p === prefix) {
    res.writeHead(308, { location: prefix + '/' + url.search }).end();
    return true;
  }
  if (p === prefix + '/' || p === prefix + '/index.html') {
    const page = path.join(ROOT, 'public', room.page);
    if (!fs.existsSync(page)) {
      return ctx.json(503, {
        ok: false,
        message: `《${room.name}》这间房还没装好（public/${room.page} 不存在）`,
      });
    }
    const html = await fsp.readFile(page, 'utf8');
    // 全客厅统一双态规则：嵌入态（舞台 iframe）隐藏页面内 .ww-home，独立态保留；
    // 五间新房走同一个注入函数，不逐页打补丁
    return ctx.html(injectEmbedFlag(html)), true;
  }

  // 房间下面的其它子路径，交给模块（比如 /library/poster/xxx.jpg 也走模块）
  if (p.startsWith(prefix + '/')) {
    const mod = loaded.get(room.id);
    if (!mod) return ctx.json(503, { ok: false, message: missing.get(room.id) || '这间房还没装好' });
    let r;
    try {
      r = await mod.handle(makeCtx(req, res, url, room.id));
    } catch (e) {
      // 模块抛错时，如果它已经发过头，就不能再补一个响应，否则客户端会收到半截
      if (res.headersSent || res.writableEnded) {
        try { res.destroy(); } catch {}
        return true;
      }
      throw e;
    }
    if (r === false) return false;
    // true 或 undefined（模块已经自己回过）都算已处理
    return true;
  }

  return false;
}

/* ───────────────────────── 汇总（首页用） ───────────────────────── */

export async function roomSummaries() {
  const out = {};
  for (const room of ROOM_LIST) {
    const mod = loaded.get(room.id);
    const base = { id: room.id, name: room.name, color: room.color, path: `/${room.id}/`, ready: !!mod };
    if (mod) {
      let s = null;
      try { s = await mod.summary(); } catch (e) {
        s = null;
        console.error(`[rooms] ${room.id} summary 失败:`, e && e.message);
      }
      out[room.id] = Object.assign(base, { ready: true }, s || {});
    } else {
      out[room.id] = Object.assign(base, { ready: false, message: missing.get(room.id) || '未装好' });
    }
  }
  return out;
}
