/**
 * 请求体读取 —— hub.mjs 与 lib/<room>.mjs 共用一份实现
 *
 * 旧实现每个模块各抄一份，且有三个真缺陷：
 *   1. `buf += chunk` 把 Buffer 隐式转成字符串：一个汉字跨 chunk 边界时会被切成两个
 *      半个字符（换成 U+FFFD），JSON.parse 之后库里就存进了替换符；
 *   2. 超限直接 `req.destroy()`：客户端拿到的是空回复（curl exit 52），
 *      而不是一个能看懂的 413；
 *   3. 解析失败 `resolve({})`：把「请求写错了」伪装成「请求里没有字段」，
 *      上层只能回一句误导人的「缺少书名或作者」，日志里也查不到真因。
 *
 * 现在的契约：
 *   - 空 body        → readJson 返回 {}（沿用旧语义，POST 无 body 仍可走默认值）
 *   - 非法 JSON      → 抛 BodyError(400)，message 带原始解析错误
 *   - 超过 limit     → 抛 BodyError(413)，剩余字节被丢弃而不是掐断连接
 *   - 读流出错       → 抛 BodyError(400)
 * 上层（hub 顶层 try）把 statusCode 映射成响应码即可。
 */

const DEFAULT_JSON_LIMIT = 2 * 1024 * 1024;

export class BodyError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'BodyError';
    this.statusCode = statusCode;
  }
}

/**
 * 读原始字节。永远 resolve Buffer 或 reject BodyError，不会 resolve 半截数据。
 * @param {import('node:http').IncomingMessage} req
 * @param {{limit?:number}} [opts]
 * @returns {Promise<Buffer>}
 */
export function readRaw(req, opts = {}) {
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : DEFAULT_JSON_LIMIT;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (code, message) => {
      if (settled) return;
      settled = true;
      // 不 destroy：让调用方先把 413/400 写出去，再把没读完的上传数据丢掉。
      // destroy 会让客户端只看到 "Empty reply from server"，看不到错误语义。
      try { req.resume(); } catch { /* 流可能已结束 */ }
      reject(new BodyError(code, message));
    };

    req.on('data', (chunk) => {
      if (settled) return;
      // 正常情况下 chunk 是 Buffer；一旦有人对 req 调过 setEncoding 就会变成字符串，
      // 那时 Buffer.concat 会直接抛 ERR_INVALID_ARG_TYPE。统一归一到 Buffer。
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > limit) return fail(413, `请求体过大（上限 ${limit} 字节）`);
      chunks.push(buf);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('aborted', () => fail(400, '请求被中断'));
    req.on('error', (e) => fail(400, `读取请求体失败：${(e && e.message) || e}`));
  });
}

/**
 * 读 JSON。空 body 返回 {}，与服务端「不传就用默认值」的旧行为保持一致。
 * @param {import('node:http').IncomingMessage} req
 * @param {{limit?:number}} [opts]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readJson(req, opts = {}) {
  const buf = await readRaw(req, { limit: opts.limit || DEFAULT_JSON_LIMIT });
  if (!buf.length) return {};
  const text = buf.toString('utf8');
  if (!text.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new BodyError(400, `请求体不是合法 JSON：${(e && e.message) || e}`);
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new BodyError(400, '请求体必须是 JSON 对象');
  }
  return parsed;
}

/** hub 顶层 catch 用：把 BodyError 映射成 HTTP 码，其它错误仍是 500 */
export function statusOf(err, fallback = 500) {
  const code = Number(err && err.statusCode);
  return Number.isInteger(code) && code >= 400 && code <= 599 ? code : fallback;
}
