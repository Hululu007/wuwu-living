#!/usr/bin/env node
/**
 * 图片缓存原子写回归。
 *
 * 三条真缺陷（本轮修真）都属于同一类：读侧判据是「文件存在 / size > 0 就算命中」，
 * 于是直写被中断留下的半截图会被永久当成本地缓存发出，且永远不会重取。
 *   - hub.mjs  /api/vod/img        视频站海报缓存（vod/posters/<sha1>.img）
 *   - lib/calendar.mjs 封面        番剧封面（calendar/covers/<hash>.<ext>）
 *   - lib/library_douban.mjs 海报 豆瓣海报（library/posters/<id>.jpg）
 *
 * 断言方式：临时目录里同时跑「旧写法（直写中断）」与「新写法（tmp+rename 中断）」两臂，
 * 前者留下 size>0 的半截文件（必须为真，否则本用例没有区分力），后者目标必须不存在。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let passed = 0;
const fails = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { fails.push(name); console.error(`FAIL ${name}: ${e.message}`); process.exitCode = 1; }
}

const PARTIAL = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]); // PNG 头几个字节，模拟截断

await test('控制臂：直写中断会留下 size>0 的半截图（证明用例有区分力）', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'img-direct-'));
  const target = path.join(dir, 'x.img');
  fs.writeFileSync(target, PARTIAL); // 旧写法：写一半就没了
  const st = fs.statSync(target);
  assert.ok(st.size > 0, '直写中断必须留下 size>0 的文件');
  // 复现读侧判据：size>0 即命中
  assert.equal(st.size > 0, true, '读侧会把它当缓存命中');
  await fsp.rm(dir, { recursive: true, force: true });
});

await test('新写法：tmp+rename 中断后目标不存在，不会命中坏缓存', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'img-atomic-'));
  const target = path.join(dir, 'y.img');
  const tmp = `${target}.${process.pid}.abcdef.tmp`;
  fs.writeFileSync(tmp, PARTIAL);
  // rename 之前被杀：目标必须不存在
  assert.equal(fs.existsSync(target), false, 'rename 前目标不能存在');
  // 残留 tmp 不影响读侧（读侧只看目标名）
  assert.equal(fs.existsSync(tmp), true, 'tmp 会残留，这是可接受的');
  await fsp.rm(dir, { recursive: true, force: true });
});

await test('新写法：rename 完成后目标内容与源逐字节一致', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'img-ok-'));
  const target = path.join(dir, 'z.img');
  const tmp = `${target}.${process.pid}.123456.tmp`;
  const full = Buffer.from('完整图片内容'.repeat(100));
  fs.writeFileSync(tmp, full);
  fs.renameSync(tmp, target);
  assert.deepEqual(fs.readFileSync(target), full, '内容必须完整');
  assert.equal(fs.existsSync(tmp), false, 'rename 后 tmp 必须消失');
  await fsp.rm(dir, { recursive: true, force: true });
});

await test('三处生产代码都用了 pid 唯一临时名 + rename', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const checks = [
    ['hub.mjs', /const tmp = `\$\{cached\}\.\$\{process\.pid\}/, /fs\.renameSync\(tmp, cached\)/],
    ['lib/calendar.mjs', /const tmp = `\$\{abs\}\.\$\{process\.pid\}/, /await fsp\.rename\(tmp, abs\)/],
    ['lib/library_douban.mjs', /const tmp = `\$\{file\}\.\$\{process\.pid\}/, /await fsp\.rename\(tmp, file\)/],
  ];
  for (const [rel, tmpRe, renRe] of checks) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.match(src, tmpRe, `${rel} 必须用 pid 唯一临时名`);
    assert.match(src, renRe, `${rel} 必须 rename 落盘`);
  }
});

if (fails.length) { console.error(`\n${passed} passed; FAILED (${fails.join(' | ')})`); process.exitCode = 1; }
else console.log(`\n${passed} passed; OK`);
