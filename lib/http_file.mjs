/**
 * 文件响应 —— 支持 Range 的静态/媒体文件直出
 *
 * 旧实现放在 lib/rooms.mjs 的 ctx.file 里，有三个真缺陷：
 *   1. 后缀区间 `bytes=-N`（「最后 N 字节」）被当成 `start = 0`，
 *      于是 `<video>` 探测尾部元数据时拿到的是文件头，播放器会判成损坏；
 *   2. 非法 Range（`items=0-5`、`bytes=abc`）被**忽略**并回 200 整文件，
 *      RFC 9110 要求这种不满足的 Range 应当回 416；
 *   3. HEAD 请求照样 createReadStream 并 pipe，白白读整文件且可能写坏响应。
 *
 * 注意 `bytes=0-` 这类合法请求仍然走 206 + 全量，与旧行为一致。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * 解析单区间 Range。
 * @param {string|undefined} header
 * @param {number} total 文件总字节
 * @returns {{ok:true,start:number,end:number}|{ok:false,reason:'unsatisfiable'|'ignore'}}
 */
export function parseRange(header, total) {
  if (!header) return { ok: false, reason: 'ignore' };
  const raw = String(header).trim();
  const m = /^bytes=(\d*)-(\d*)$/i.exec(raw);
  if (!m) return { ok: false, reason: 'unsatisfiable' };
  const [, rawStart, rawEnd] = m;
  if (!rawStart && !rawEnd) return { ok: false, reason: 'unsatisfiable' };

  let start;
  let end;
  if (!rawStart) {
    // bytes=-N：最后 N 字节
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return { ok: false, reason: 'unsatisfiable' };
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : total - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { ok: false, reason: 'unsatisfiable' };
    if (end >= total) end = total - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { ok: false, reason: 'unsatisfiable' };
  if (total <= 0 || start >= total || end < start || start < 0) return { ok: false, reason: 'unsatisfiable' };
  return { ok: true, start, end };
}

/**
 * 把文件写到响应上；失败时（还没发头）回一个 JSON 错误。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} absPath
 * @param {{mimeOf:(p:string)=>string, sendJson:(res:object,code:number,obj:object)=>unknown, cacheControl?:string, headers?:object}} opts
 */
export async function sendFile(req, res, absPath, opts) {
  const { mimeOf, sendJson } = opts;
  let st;
  try {
    st = await fsp.stat(absPath);
  } catch {
    return sendJson(res, 404, { ok: false, message: '文件不见了' });
  }
  if (!st.isFile()) return sendJson(res, 404, { ok: false, message: '文件不见了' });

  const total = st.size;
  const type = mimeOf(absPath);
  const cache = opts.cacheControl
    || (absPath.includes(`${path.sep}runtime${path.sep}`) ? 'private, max-age=86400' : 'no-store');
  const extra = opts.headers || {};
  const range = parseRange(req.headers.range, total);

  if (range.ok === false && range.reason === 'unsatisfiable') {
    res.setHeader?.('content-range', `bytes */${total}`);
    return sendJson(res, 416, { ok: false, message: '范围不合法' });
  }

  const head = req.method === 'HEAD';
  const base = Object.assign({
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': cache,
  }, extra);

  if (range.ok) {
    const { start, end } = range;
    res.writeHead(206, Object.assign({}, base, {
      'content-range': `bytes ${start}-${end}/${total}`,
      'content-length': end - start + 1,
    }));
    if (head) return res.end();
    const stream = fs.createReadStream(absPath, { start, end });
    stream.on('error', () => { try { res.destroy(); } catch { /* already closed */ } });
    return stream.pipe(res);
  }

  res.writeHead(200, Object.assign({}, base, { 'content-length': total }));
  if (head) return res.end();
  const stream = fs.createReadStream(absPath);
  stream.on('error', () => { try { res.destroy(); } catch { /* already closed */ } });
  return stream.pipe(res);
}
