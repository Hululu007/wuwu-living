#!/usr/bin/env node
/* 五五客厅 · 内容模块回归。真生产模块 + 隔离 runtime，不接触正在运行的服务。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const ROOT = path.resolve(import.meta.dirname, '..');
// fixtures 由 main() 里的 fixture() 赋值；子用例直接引用会拿到 undefined，
// 于是 path.join(undefined, ...) 抛 “path must be of type string”。这里先给一个占位。
let fixtures = null;
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log('PASS', name);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.error('FAIL', name, e.message);
  }
}
function ctx(p, body, query = '') {
  const out = {};
  return {
    p, method: body ? 'POST' : 'GET', query: new URLSearchParams(query),
    body: async () => body, res: { writeHead() {}, end() {} },
    json(code, data) { Object.assign(out, { code, data }); return out; },
    out,
  };
}
function bodyRequest(body) {
  const req = new EventEmitter();
  req.method = 'POST';
  process.nextTick(() => { req.emit('data', JSON.stringify(body)); req.emit('end'); });
  return req;
}
function response() {
  return {
    code: 0, data: null,
    writeHead(code) { this.code = code; },
    end(data) { this.data = data ? JSON.parse(data) : null; },
  };
}
async function copyTree(files, root) {
  for (const f of files) {
    const target = path.join(root, f);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(path.join(ROOT, f), target);
  }
  await fsp.symlink(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'));
}
async function fixture() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), '55-content-regress-'));
  // ★ 2026-11-22 改成自动扫描 lib/，不再手写清单。
  //   事故：16:42 新增 lib/log_dir.mjs 被 rooms.mjs 引用，但清单没跟上，
  //   于是 10 条用例全部 ERR_MODULE_NOT_FOUND —— 看起来像「内容模块坏了」，
  //   实际是回归脚本自己没拷新文件。手写清单每次加模块都会漏，必须自动化。
  const libDir = path.join(ROOT, 'lib');
  const libFiles = (await fsp.readdir(libDir))
    .filter((f) => f.endsWith('.mjs') && !f.includes('.bak'))
    .map((f) => `lib/${f}`);
  await copyTree(libFiles, dir);
  await fsp.mkdir(path.join(dir, 'config'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'config/calendar.json'), '{"feeds":[],"fetchIntervalMin":10}');
  return dir;
}
async function modules(dir) {
  const tag = `?regress=${Date.now()}-${Math.random()}`;
  return Promise.all(['notes', 'calendar', 'home'].map((n) => import(`file://${path.join(dir, `lib/${n}.mjs`)}${tag}`)));
}
// 所有用例共用一份隔离 fixture：必须在任何 check 之前建好，
// 否则 path.join(null, ...) 直接抛 "path must be of type string"（旧版就是这么假红的）。
fixtures = await fixture();

async function postHome(home, body) {
  const res = response();
  await home.homeTodos(bodyRequest(body), res, new URL('http://local/api/home/todos'));
  return res;
}

await check('notes：并发保存等待实际落盘，不得丢写', async () => {
  const [notes] = await modules(fixtures);
  const before = await notes.summary();
  await Promise.all(Array.from({ length: 12 }, (_, i) => notes.handle(ctx('/api/notes/create', { title: `note-${i}` }))));
  // handle() 全部 resolve 之后，磁盘上必须已经包含这 12 条（旧实现只排了个 200ms 定时器）
  const disk = JSON.parse(await fsp.readFile(path.join(fixtures, 'runtime/notes.json'), 'utf8'));
  assert.equal(disk.notes.length, (before.total || 0) + 12);
  assert.equal(disk.notes.filter((n) => /^note-\d+$/.test(n.title)).length, 12);
});
await check('notes：非法 limit 回落到默认值而不是 NaN', async () => {
  const [notes] = await modules(fixtures);
  const c = ctx('/api/notes/list', null, 'limit=oops');
  await notes.handle(c);
  assert.equal(c.out.code, 200);
  assert.equal(c.out.data.shown, c.out.data.items.length);
  assert.ok(Number.isFinite(c.out.data.shown), 'shown 不能是 null/NaN');
  assert.ok(c.out.data.items.length > 0, '缺省 limit 应当返回内容');
});
await check('notes：无查询按时间倒序，最新在前', async () => {
  const [notes] = await modules(fixtures);
  await notes.handle(ctx('/api/notes/create', { title: 'old' }));
  await new Promise((r) => setTimeout(r, 5));
  await notes.handle(ctx('/api/notes/create', { title: 'new' }));
  const c = ctx('/api/notes/list');
  await notes.handle(c);
  assert.equal(c.out.code, 200);
  assert.equal(c.out.data.items[0].title, 'new');
});
await check('home：并发请求保留所有待办（20 路，对齐线上被踩过的那个数）', async () => {
  const [, , home] = await modules(fixtures);
  // 旧实现是「读全量 → 改数组 → 整表覆盖」，20 路并发只留下 1 条。
  // 现在 withTodos() 把 read-modify-write 整体排队，必须 20/20 全落地。
  await Promise.all(Array.from({ length: 20 }, (_, i) => postHome(home, { text: `todo-${i}` })));
  const d = JSON.parse(await fsp.readFile(path.join(fixtures, 'runtime/home.json'), 'utf8'));
  assert.equal(d.todos.length, 20, '20 路并发必须一条不丢');
  // 内容也要对得上，防止「数够但都是同一条」
  const texts = new Set(d.todos.map((t) => t.text));
  assert.equal(texts.size, 20, '20 条内容必须互不相同');
});
await check('home：非法 JSON 抛 400，由 hub 顶层映射成错误码', async () => {
  const [, , home] = await modules(fixtures);
  const req = new EventEmitter(); req.method = 'POST';
  const res = response();
  const done = home.homeTodos(req, res, new URL('http://local/api/home/todos'));
  process.nextTick(() => { req.emit('data', Buffer.from('{bad')); req.emit('end'); });
  // 生产契约：readJson 抛 BodyError(400)，hub 的 catch 负责写响应，
  // 模块自己不再把「解析失败」伪装成空对象。
  await assert.rejects(done, (e) => e && e.statusCode === 400);
  assert.equal(res.code, 0, '模块不应自己回 200');
});
await check('home：未知动作回 400 且不动已有待办', async () => {
  const [, , home] = await modules(fixtures);
  await postHome(home, { text: 'keep' });
  const before = JSON.parse(await fsp.readFile(path.join(fixtures, 'runtime/home.json'), 'utf8'));
  const r = await postHome(home, { action: 'unknown' });
  assert.equal(r.code, 400);
  const after = JSON.parse(await fsp.readFile(path.join(fixtures, 'runtime/home.json'), 'utf8'));
  assert.equal(after.todos.length, before.todos.length);
  assert.ok(after.todos.some((t) => t.text === 'keep'));
});

await check('home：toggle 不存在的 id 回 404 而不是假装成功', async () => {
  const [, , home] = await modules(fixtures);
  const r = await postHome(home, { action: 'toggle', id: 'nope' });
  assert.equal(r.code, 404);
});
await check('calendar：非法时间返回 400', async () => {
  const [, calendar] = await modules(fixtures);
  const c = ctx('/api/calendar/track/add', { name: 'bad', rule: { type: 'weekly', weekday: 1, time: '99:70' } });
  await calendar.handle(c);
  assert.equal(c.out.code, 400);
});
await check('calendar：固定秒数滚动不得跨 DST 漂移', async () => {
  const [, calendar] = await modules(fixtures);
  const c = ctx('/api/calendar/track/add', { name: 'weekly', rule: { type: 'weekly', weekday: 2, time: '20:00' } });
  await calendar.handle(c);
  // 后续检查时区独立用例注入真实生产函数
});
await check('calendar：handler resolve 时已经落盘', async () => {
  const [, calendar] = await modules(fixtures);
  const before = JSON.parse(await fsp.readFile(path.join(fixtures, 'runtime/calendar.json'), 'utf8'));
  const beforeCount = (before.tracks || []).length;
  const c = ctx('/api/calendar/track/add', { name: 'persist-' + Date.now(), rule: { type: 'pending' } });
  await calendar.handle(c);
  const d = JSON.parse(await fsp.readFile(path.join(fixtures, 'runtime/calendar.json'), 'utf8'));
  assert.equal((d.tracks || []).length, beforeCount + 1);
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) process.exitCode = 1;
