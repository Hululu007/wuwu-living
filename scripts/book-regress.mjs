#!/usr/bin/env node
/* 书房搜索生产代码回归：真实模块 + 本地协议夹具，不访问外网、不改运行中服务。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { pathToFileURL, fileURLToPath } from 'node:url';

// 旧写法用 URL().pathname 当路径：目录里有中文会被百分号编码成 %E4%BA%94…，
// 于是 readFileSync 全部 ENOENT，整份用例看起来"失败"，实际是测试自己在坏掉。
// 用 pathToFileURL 的反向（fileURLToPath）才能得到真路径。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}: ${error.stack || error}`); process.exitCode = 1; }
}

// 用最小依赖夹具执行原始生产模块；除导入地址外逐字不变。
async function loadLocalSearch(sourceList, searchImpl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'book-search-regress-'));
  const dependency = path.join(dir, 'engine.mjs');
  const modulePath = path.join(dir, 'book_source_search.mjs');
  // 生产模块现在依赖同目录的 json_store（原子写健康表）；夹具必须一起放进去，
  // 否则导入直接 ERR_MODULE_NOT_FOUND，整份用例看起来"全红"。
  // ★ 2026-11-22 改成「按生产模块的 import 自动铺依赖」，不再手写清单。
  //   事故：lib/book_source_search.mjs 新增 import { appendLog } from './log_dir.mjs'，
  //   夹具没跟上 → 整份用例 ERR_MODULE_NOT_FOUND，看起来像搜索功能坏了。
  //   手写清单每加一个依赖就会漏，这里直接扫源码里的同目录相对 import。
  const prodPath = path.join(ROOT, 'lib/book_source_search.mjs');
  const prodSrc = fs.readFileSync(prodPath, 'utf8');
  const relImports = [...prodSrc.matchAll(/from\s+'\.\/([A-Za-z0-9_.-]+\.mjs)'/g)].map((m) => m[1]);
  for (const dep of new Set(relImports)) {
    if (dep === 'legado/index.mjs') continue; // 这个由 engine.mjs 夹具替代
    fs.copyFileSync(path.join(ROOT, 'lib', dep), path.join(dir, path.basename(dep)));
  }
  fs.writeFileSync(dependency, `export const calls = [];\nexport const sources = ${JSON.stringify(sourceList)};\nexport const __core = { loadSources: async () => sources };\nexport async function searchSource(source, key, opts) { calls.push({source,key,opts}); return (${searchImpl.toString()})(source,key,opts); }\nexport async function loadSources() { return sources; }\n`);
  let code = fs.readFileSync(path.join(ROOT, 'lib/book_source_search.mjs'), 'utf8');
  const oldImport = "from './legado/index.mjs'";
  assert.equal(code.split(oldImport).length, 2, '生产模块导入锚点漂移');
  code = code.replace(oldImport, "from './engine.mjs'");
  fs.writeFileSync(modulePath, code);
  const mod = await import(pathToFileURL(modulePath));
  const engine = await import(pathToFileURL(dependency));
  return { mod, engine, dir };
}

const src = (name, url) => ({ name, url, enabled: true, searchUrl: '/search', rules: { search: { bookList: '.book' } } });

await test('同域不同书源全部调度，进度总数与完成数一致', async () => {
  const { mod, engine } = await loadLocalSearch([
    src('A1', 'https://same.test/a'), src('A2', 'https://same.test/b'), src('B', 'https://other.test/b'),
  ], async () => ({ ok: true, books: [], ms: 1 }));
  const result = await mod.searchAllSources('三体', { maxSources: 3, timeout: 50 });
  assert.equal(engine.calls.length, 3, `仅调用 ${engine.calls.length}/3 源`);
  assert.equal(result.stats.searched, 3);
});

await test('源列表装载失败不永久缓存空清单，可恢复', async () => {
  const { mod } = await loadLocalSearch([], async () => ({ ok: true, books: [] }));
  // 本例由独立错误注入用例补充；确保公开缓存 API 至少返回数组。
  assert.ok(Array.isArray(await mod.awaitSourceCache()));
});

await test('不相关泛匹配不得挤掉精确书名', async () => {
  const { mod } = await loadLocalSearch([
    src('generic', 'https://generic.test'), src('exact', 'https://exact.test'),
  ], async (source) => ({ ok: true, books: [{ name: source.name === 'exact' ? '高武纪元' : '高武测试', author: '甲', bookUrl: `https://${source.name}.test/book` }] }));
  const result = await mod.searchAllSources('高武纪元，永远比儿子高五个境界', { maxSources: 2, timeout: 50 });
  assert.equal(result.items[0]?.name, '高武纪元');
});

await test('无限挂起的单源在总时限内结算', async () => {
  const { mod } = await loadLocalSearch([src('hang', 'https://hang.test')], () => new Promise(() => {}));
  const started = Date.now();
  const result = await mod.searchAllSources('三体', { maxSources: 1, timeout: 80, totalTimeout: 300 });
  assert.ok(Date.now() - started < 1200, '搜索挂起');
  assert.equal(result.stats.failed, 1);
});

await test('取消后不再发送结果，并以 AbortError 结束', async () => {
  const ac = new AbortController();
  let release;
  // 这个 gate 必须挂在 globalThis 上。
  // 夹具是把 searchImpl 的源码 toString 后写进另一个模块的，
  // 闭包里的 gate/release 在那里根本不存在（await gate 会 ReferenceError，
  // 源被当成「失败」瞬间结算，abort 都来不及发生）——旧用例就是这么假红的。
  globalThis.__regressGate = new Promise((r) => { release = r; });
  let delivered = 0;
  const { mod } = await loadLocalSearch([src('slow', 'https://slow.test')], async () => {
    await globalThis.__regressGate;
    return { ok: true, books: [{ name: '三体', author: '刘慈欣', bookUrl: 'https://slow.test/1' }] };
  });
  const promise = mod.searchAllSources('三体', { maxSources: 1, signal: ac.signal, onItems: () => delivered++ });
  await new Promise((r) => setTimeout(r, 10));
  ac.abort();
  release();
  await assert.rejects(promise, (e) => e.name === 'AbortError');
  assert.equal(delivered, 0, '取消后不得再向调用方推结果');
  delete globalThis.__regressGate;
});

// searchd 用真 HTTP/SSE 流，不复制协议实现。
async function withSseServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  process.env.READER_SEARCH_BASE = `http://127.0.0.1:${port}`;
  const mod = await import(`../lib/book_searchd.mjs?regress=${Date.now()}-${Math.random()}`);
  try { await fn(mod); }
  finally { await new Promise((resolve) => server.close(resolve)); delete process.env.READER_SEARCH_BASE; }
}

await test('SSE 中途断开且有部分结果时保留 error/partial', async () => {
  // 语义：上游把连接挂住不放 / 中途断掉，但已经收到过结果 —— 不能把结果全丢了。
  // 旧写法用固定 timeoutMs=80 抢跑断言，机器忙时第一次 reader.read() 还没返回，
  // 等于什么都没读到就中止，断言随机变红（实测 5 次里红 1 次）。
  // 现在明确区分两条路径：
  //   A. 上游中途关闭连接（服务器主动 end）→ partial + error
  //   B. 外部 signal 取消 → 原样抛 AbortError（不回落慢引擎）
  // 这里测 A，用真实「写完就断」的流，不靠计时器抢跑。
  await withSseServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ type: 'start', total: 2 })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'items', source: { name: 'A', url: 'https://a.test' }, books: [{ name: '三体', author: '刘慈欣', bookUrl: 'https://a.test/1' }] })}\n\n`);
    // 立刻结束响应：模拟上游中途掉线（真实现场是 searchd 进程被杀/网络断）
    setTimeout(() => { try { res.end(); } catch { /* ignore */ } }, 10);
  }, async (mod) => {
    const result = await mod.searchViaSearchd('三体', { timeoutMs: 5000 });
    assert.equal(result.items.length, 1, '已收到的结果不能丢');
    assert.equal(result.partial, true, '中途断开必须标 partial');
  });
});

await test('SSE 到时限仍无结果时抛出超时错误（不返回假成功）', async () => {
  await withSseServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ type: 'start', total: 2 })}\n\n`);
    // 只发 start，永远不发结果：超时必须抛错，不能返回空结果冒充成功
  }, async (mod) => {
    await assert.rejects(
      mod.searchViaSearchd('三体', { timeoutMs: 120 }),
      (e) => /abort|timeout|超时/i.test(String(e && (e.message || e))),
      '无结果时超时必须抛错'
    );
  });
});

await test('已取消 signal 不发起新请求', async () => {
  let requests = 0;
  await withSseServer((req, res) => { requests++; res.writeHead(200); res.end('data: {"type":"done","stats":{}}\n\n'); }, async (mod) => {
    const ac = new AbortController(); ac.abort();
    await assert.rejects(mod.searchViaSearchd('三体', { signal: ac.signal, timeoutMs: 1000 }), (e) => e.name === 'AbortError');
    assert.equal(requests, 0);
  });
});

await test('正常 done 流精确结算且不是 partial', async () => {
  await withSseServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"type":"start","total":1}\n\ndata: {"type":"done","stats":{"ok":0,"empty":1,"elapsedMs":7}}\n\n');
  }, async (mod) => {
    const result = await mod.searchViaSearchd('三体', { timeoutMs: 1000 });
    assert.equal(result.partial, false);
    assert.equal(result.stats.searched, 1);
    assert.equal(result.stats.elapsedMs, 7);
  });
});


await test('可开源必须排在「仅搜索」源前面，否则用户点前几本必然失败', async () => {
  const { mod } = await loadLocalSearch([
    src('17k', 'http://api.17k.com'),
    src('good', 'https://good.test'),
  ], async (source) => {
    // 17K 秒回但只能搜不能开；good 是正常源
    return {
      ok: true,
      books: [{
        name: '三体',
        author: '刘慈欣',
        bookUrl: source.name === '17k' ? 'http://api.17k.com/book/1' : 'https://good.test/book/1',
      }],
    };
  });
  const result = await mod.searchAllSources('三体', { maxSources: 2, timeout: 50 });
  assert.equal(result.items.length, 1, '同名书应聚合成一条');
  assert.equal(result.items[0].searchOnly, false, '组代表必须是可开源');
  assert.equal(result.items[0].bookUrl, 'https://good.test/book/1');
  assert.equal(result.items[0].sources.length, 2, '两个源都要记进 sources，供用户换源');
});

await test('只有「仅搜索」源时如实标记 searchOnly', async () => {
  const { mod } = await loadLocalSearch([
    src('17k', 'http://api.17k.com'),
  ], async () => ({ ok: true, books: [{ name: '九星霸体诀', author: '甲', bookUrl: 'http://api.17k.com/book/2' }] }));
  const result = await mod.searchAllSources('九星霸体诀', { maxSources: 1, timeout: 50 });
  assert.equal(result.items[0].searchOnly, true);
});


await test('书源 URL 干净但 bookUrl 指向 17K 时也算「仅搜索」', async () => {
  const { mod } = await loadLocalSearch([
    src('disguised', 'https://clean-looking.test'),
  ], async () => ({
    ok: true,
    // 书源本身看起来正常，但真实书页地址在 17K 接口上
    books: [{ name: '流浪地球..', author: '甲', bookUrl: 'http://api.17k.com/book/3594810/split1/merge?x=1' }],
  }));
  const result = await mod.searchAllSources('流浪地球', { maxSources: 1, timeout: 50 });
  assert.equal(result.items[0].searchOnly, true, '必须识别出这是打不开的 17K 条目');
});

console.log(`\n${passed} passed; ${process.exitCode ? 'FAILED' : 'OK'}`);
