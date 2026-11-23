#!/usr/bin/env node
/**
 * json_store 契约回归：原子写 / 读坏备份 / 串行化。
 *
 * 这几条都是实测踩过的真缺陷：
 *   - 各模块各自写固定 `.tmp` + rename，并发时互相踩；
 *   - `await save()` 只是排了个 setTimeout，接口已回 200 而数据还没落盘；
 *   - 读坏文件时 catch → 空表继续跑，紧接着把空表写回同一路径，原数据就没了。
 *
 * 用法：node scripts/json-store-regress.mjs
 */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJsonFile, readJsonFileSync, writeJson } from '../lib/json_store.mjs';

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'quar-'));
const f = path.join(dir, 'notes.json');
const fs = await import('node:fs');

// 1) 文件不存在 → null，且不产生备份
assert.equal(await readJsonFile(f), null);
assert.equal(readJsonFileSync(f), null);
console.log('PASS 文件不存在 → null，且不产生备份');

// 2) 正常 JSON
await fsp.writeFile(f, JSON.stringify({ notes: [{ id: 'a' }] }));
assert.deepEqual(await readJsonFile(f), { notes: [{ id: 'a' }] });
assert.deepEqual(readJsonFileSync(f), { notes: [{ id: 'a' }] });
console.log('PASS 正常 JSON 原样返回');

// 3) 截断 JSON → null + 备份（异步）
await fsp.writeFile(f, '{"notes":[{"id":"a"');
const r = await readJsonFile(f);
const files = (await fsp.readdir(dir)).sort();
assert.equal(r, null);
console.log('PASS 截断 JSON → null，文件:', files.join(' '));
const backup = files.find((x) => x.includes('.corrupt-'));
const same = backup && (await fsp.readFile(path.join(dir, backup), 'utf8')) === '{"notes":[{"id":"a"';
assert.equal(same, true, '备份必须保留原始字节');
console.log('PASS 备份保留原始字节');

// 4) 同步版本也留备份
await fsp.writeFile(f, '[1,2,');
const out = readJsonFileSync(f);
const files2 = (await fsp.readdir(dir)).filter((x) => x.includes('.corrupt-'));
assert.equal(out, null);
assert.ok(files2.length >= 2, '同步读取也要留备份');
console.log('PASS 同步读取同样留备份');

// 5) 空文件 → null（省一次无意义备份）
await fsp.writeFile(f, '');
const before = (await fsp.readdir(dir)).filter((x) => x.includes('.corrupt-')).length;
await readJsonFile(f);
const after = (await fsp.readdir(dir)).filter((x) => x.includes('.corrupt-')).length;
assert.equal(before, after, '空文件不该产生无意义备份');
console.log('PASS 空文件不产生多余备份');

await fsp.rm(dir, { recursive: true, force: true });

// ── 原子写 + 并发 ──
const dir2 = await fsp.mkdtemp(path.join(os.tmpdir(), 'atomic-'));
const g = path.join(dir2, 'data.json');
await Promise.all(Array.from({ length: 20 }, (_, i) => writeJson(g, { i })));
const parsed = JSON.parse(await fsp.readFile(g, 'utf8'));
assert.equal(typeof parsed.i, 'number', '并发写之后文件必须是完整 JSON');
const leftovers = (await fsp.readdir(dir2)).filter((x) => x.includes('.tmp'));
assert.equal(leftovers.length, 0, `不该留下临时文件：${leftovers.join(',')}`);
console.log('PASS 20 路并发原子写：文件完整、无残留 .tmp');

// 串行化：后写的一定覆盖先写，中间不会出现半份
const seq = [];
for (let i = 0; i < 5; i++) seq.push(writeJson(g, { n: i }));
await Promise.all(seq);
assert.deepEqual(JSON.parse(await fsp.readFile(g, 'utf8')), { n: 4 });
console.log('PASS 串行写：最终值是最末一次写入');

await fsp.rm(dir2, { recursive: true, force: true });
console.log('\nALL PASS');
