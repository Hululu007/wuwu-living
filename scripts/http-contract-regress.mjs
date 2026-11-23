#!/usr/bin/env node
/**
 * HTTP 契约回归：Range / HEAD / 请求体错误语义。
 *
 * 这三块是实测踩过的真缺陷，改成脚本免得下次再靠临时探针：
 *   1. `bytes=-N`（尾部区间）曾被当成 `start=0`，播放器探测 mp4 尾部元数据时拿到文件头；
 *   2. 非法 Range（`items=0-5`）曾被忽略并回 200 整文件，RFC 9110 要求 416；
 *   3. HEAD 曾被所有 `ctx.method === 'GET'` 路由当 404，探测工具拿不到元信息；
 *   4. 请求体超限曾直接 destroy 连接（客户端只看到 Empty reply），
 *      非法 JSON 曾被 resolve({}) 伪装成"没传字段"。
 *
 * 用法：node scripts/http-contract-regress.mjs
 * 不接触运行中的服务：自己起一个临时 HTTP server，直接调生产模块。
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendFile, parseRange } from '../lib/http_file.mjs';
import { readJson, readRaw } from '../lib/http_body.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BODY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const TOTAL = Buffer.byteLength(BODY);
let pass = 0;
let fail = 0;

function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.error(`FAIL ${name} ${detail}`); }
}

const mimeOf = () => 'text/plain; charset=utf-8';
const sendJson = (res, code, obj) => {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) });
  res.end(b);
};

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ww-http-contract-'));
const file = path.join(dir, 'fixture.txt');
await fsp.writeFile(file, BODY);

const server = http.createServer(async (req, res) => {
  if (req.url === '/file') return sendFile(req, res, file, { mimeOf, sendJson });
  if (req.url === '/echo-json') {
    try {
      const body = await readJson(req, { limit: 4096 });
      return sendJson(res, 200, { ok: true, body });
    } catch (e) {
      return sendJson(res, e.statusCode || 500, { ok: false, message: e.message });
    }
  }
  if (req.url === '/echo-json-big') {
    try {
      const body = await readJson(req, { limit: 4 * 1024 * 1024 });
      return sendJson(res, 200, { ok: true, body });
    } catch (e) {
      return sendJson(res, e.statusCode || 500, { ok: false, message: e.message });
    }
  }
  if (req.url === '/echo-raw') {
    try {
      const buf = await readRaw(req, { limit: 4096 });
      return sendJson(res, 200, { ok: true, bytes: buf.length });
    } catch (e) {
      return sendJson(res, e.statusCode || 500, { ok: false, message: e.message });
    }
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const call = (opts) => new Promise((resolve) => {
  const req = http.request({ port, path: '/file', ...opts }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
  });
  req.on('error', (e) => resolve({ status: 0, headers: {}, body: String(e.message) }));
  req.end();
});
const post = (p, payload) => new Promise((resolve) => {
  const req = http.request({ port, path: p, method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
  });
  req.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
  req.end(payload);
});

// ── Range ──
{
  const r = await call({ headers: { range: 'bytes=-5' } });
  check('尾部区间 bytes=-5 取最后 5 字节',
    r.status === 206 && r.body === BODY.slice(-5) && r.headers['content-range'] === `bytes ${TOTAL - 5}-${TOTAL - 1}/${TOTAL}`,
    `status=${r.status} cr=${r.headers['content-range']} body=${JSON.stringify(r.body)}`);
}
{
  const r = await call({ headers: { range: 'bytes=0-3' } });
  check('前缀区间 bytes=0-3', r.status === 206 && r.body === 'ABCD', `status=${r.status} body=${JSON.stringify(r.body)}`);
}
{
  const r = await call({ headers: { range: 'bytes=30-' } });
  check('开放区间 bytes=30-', r.status === 206 && r.body === BODY.slice(30), `body=${JSON.stringify(r.body)}`);
}
{
  const r = await call({ headers: { range: 'bytes=30-999' } });
  check('越界结束位被夹到末尾', r.status === 206 && r.body === BODY.slice(30), `cr=${r.headers['content-range']}`);
}
{
  const r = await call({ headers: { range: `bytes=-${TOTAL + 50}` } });
  check('尾部长度大于文件时返回整份', r.status === 206 && r.body === BODY, `cr=${r.headers['content-range']}`);
}
for (const bad of ['bytes=-0', 'items=0-5', 'bytes=abc-def', `bytes=${TOTAL + 5}-`, 'bytes=20-10']) {
  const r = await call({ headers: { range: bad } });
  check(`非法 Range ${bad} → 416`, r.status === 416 && r.headers['content-range'] === `bytes */${TOTAL}`, `status=${r.status} cr=${r.headers['content-range']}`);
}
{
  const r = await call({});
  check('无 Range → 200 整文件', r.status === 200 && r.body === BODY && r.headers['content-length'] === String(TOTAL));
}
{
  const r = await call({ method: 'HEAD' });
  check('HEAD → 200 且无响应体、保留 content-length',
    r.status === 200 && r.body === '' && r.headers['content-length'] === String(TOTAL),
    `status=${r.status} len=${r.headers['content-length']} body=${r.body.length}`);
}
{
  const r = await call({ method: 'HEAD', headers: { range: 'bytes=0-9' } });
  check('HEAD + Range → 206 且无响应体', r.status === 206 && r.body === '' && r.headers['content-length'] === '10');
}

// ── 请求体 ──
{
  const r = await post('/echo-json', JSON.stringify({ q: '三体' }));
  check('合法 JSON 正常解析', r.status === 200 && JSON.parse(r.body).body.q === '三体', r.body);
}
{
  const r = await post('/echo-json', '');
  check('空 body → {}（沿用旧语义）', r.status === 200 && JSON.parse(r.body).body && Object.keys(JSON.parse(r.body).body).length === 0, r.body);
}
{
  const r = await post('/echo-json', '{"q":"三体",,,');
  const j = JSON.parse(r.body);
  check('非法 JSON → 400 且带解析原因', r.status === 400 && /JSON/.test(j.message), r.status + ' ' + r.body);
}
{
  const r = await post('/echo-json', JSON.stringify({ x: 'y'.repeat(8000) }));
  check('超过 limit → 413（不是掐连接）', r.status === 413, r.status + ' ' + r.body.slice(0, 80));
}
{
  // 汉字跨 chunk 边界：旧实现 `buf += chunk` 会在边界把一个汉字切成两半（变成 U+FFFD）。
  // 必须让 body 明显大于一个 TCP 分片，这里用 ~200KB 的中文，且 limit 放宽到 4MB。
  const expect = '中文书名测试'.repeat(5000);
  const r = await post('/echo-json-big', JSON.stringify({ q: expect }));
  const echoed = (JSON.parse(r.body).body || {}).q;
  check('跨块汉字不被截断成 U+FFFD',
    r.status === 200 && echoed === expect && !String(echoed).includes('\uFFFD'),
    `status=${r.status} len=${echoed && echoed.length}/${expect.length}`);
}
{
  const r = await post('/echo-raw', Buffer.alloc(6000, 0x61));
  check('raw 超限 → 413', r.status === 413, r.status + ' ' + r.body.slice(0, 60));
}

// ── parseRange 纯函数边界 ──
check('parseRange 拒绝空区间', parseRange('bytes=-', 10).ok === false);
check('parseRange 允许开放起点', parseRange('bytes=0-', 10).ok === true);

await new Promise((r) => server.close(r));
await fsp.rm(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
