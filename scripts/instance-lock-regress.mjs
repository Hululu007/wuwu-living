#!/usr/bin/env node
/**
 * 实例锁 + runtime 目录回归。
 *
 * 为什么需要这一套：lib/json_store.mjs 的原子写与 per-path 串行只在「单进程」内成立。
 * 两个进程同时写同一份 notes/home/calendar.json 时，各自持有独立 cache，
 * read → modify → write 会互相覆盖（对照实验：2 进程 × 100 次 RMW 只剩约 100 条）。
 * 所以部署上必须保证「同一 runtime/ 只有一个可写实例」，这条约束由
 * lib/instance_lock.mjs（跨进程 O_EXCL 锁）+ lib/runtime_dir.mjs（实验实例换数据目录）共同承担。
 *
 * 本套用例覆盖六个面，任何一条红都意味着上面那条约束漏了：
 *   1. 同进程重复 acquire 幂等（热重载/二次初始化不会自锁）
 *   2. 跨进程第二个持有者被拒，且错误里带真实 holderPid
 *   3. release 只删自己的锁，不误删别人的
 *   4. 死进程残留的 stale lock 自动清理并可重新获取
 *   5. WUWU_RUNTIME_DIR 真的改变数据落点（缺省回退到 <ROOT>/runtime）
 *   6. hub.mjs 真实启动时第二个实例 exit 78，且第一个实例仍健康
 *
 * 用法：node scripts/instance-lock-regress.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { acquireInstanceLock, releaseInstanceLock, InstanceLockError } from '../lib/instance_lock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_MOD = pathToFileURL(path.join(ROOT, 'lib/instance_lock.mjs')).href;
const RUNTIME_DIR_MOD = pathToFileURL(path.join(ROOT, 'lib/runtime_dir.mjs')).href;

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (e) {
    failures.push(name);
    console.error(`FAIL ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

const dirs = [];
async function tmpdir(tag) {
  const d = await fsp.mkdtemp(path.join(os.tmpdir(), `55-${tag}-`));
  dirs.push(d);
  return d;
}

/** 起一个「持有锁然后一直活着」的子进程，返回 {child, lockPath}。 */
async function spawnHolder(lockPath, dir) {
  const script = path.join(dir, 'holder.mjs');
  await fsp.writeFile(script, [
    `import { acquireInstanceLock, installInstanceLockCleanup } from ${JSON.stringify(LOCK_MOD)};`,
    `const file = ${JSON.stringify(lockPath)};`,
    'acquireInstanceLock(file, { label: "holder" });',
    'installInstanceLockCleanup(file);',
    'console.log("LOCKED");',
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'));
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`holder 3s 内没拿到锁：${buf}`)), 3000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('LOCKED')) { clearTimeout(timer); resolve(child.pid); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`holder 提前退出 code=${code} ${buf}`)); });
  });
  return { child, pid: ready };
}

async function stopHolder(child) {
  if (child.exitCode !== null) return;
  const done = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  await done;
}

/** 找一个当前空闲的端口，避免和 launchd 那份 8890 撞。 */
async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// ── 1. 同进程幂等 ──
await test('同进程重复 acquire 幂等，不自锁', async () => {
  const d = await tmpdir('lock-idem');
  const file = path.join(d, '.instance.lock');
  const a = acquireInstanceLock(file, { label: 'idem' });
  const b = acquireInstanceLock(file, { label: 'idem' });
  assert.equal(a, b, '重复 acquire 必须返回同一路径');
  const info = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(info.pid, process.pid, '锁文件里必须是当前进程 pid');
  releaseInstanceLock(file);
  assert.equal(fs.existsSync(file), false, 'release 之后锁文件必须消失');
});

// ── 2. 跨进程第二个持有者被拒 ──
await test('跨进程第二个持有者被拒，并报出真实 holderPid', async () => {
  const d = await tmpdir('lock-cross');
  const file = path.join(d, '.instance.lock');
  const { child, pid } = await spawnHolder(file, d);
  try {
    let err = null;
    try { acquireInstanceLock(file, { label: '五五客厅' }); } catch (e) { err = e; }
    assert.ok(err, '第二个持有者必须失败，否则两个进程会同时写同一份 JSON');
    assert.ok(err instanceof InstanceLockError, `错误类型必须是 InstanceLockError，实际 ${err.name}`);
    assert.equal(err.holderPid, pid, `holderPid 必须是持有者 ${pid}，实际 ${err.holderPid}`);
    assert.match(err.message, /已在运行/, '错误文案要能直接读给用户看');
    // 被拒之后不能把别人的锁删掉
    assert.equal(fs.existsSync(file), true, '拒绝时绝不能清理他人的锁');
  } finally {
    await stopHolder(child);
  }
});

// ── 3. release 只删自己的 ──
await test('release 不误删别人的锁', async () => {
  const d = await tmpdir('lock-foreign');
  const file = path.join(d, '.instance.lock');
  const { child, pid } = await spawnHolder(file, d);
  try {
    // 当前进程从没 acquire 过这个路径 → release 必须是纯 no-op
    releaseInstanceLock(file);
    assert.equal(fs.existsSync(file), true, 'release 不能删掉别的进程持有的锁');
    const info = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(info.pid, pid, '锁内容不应被无关进程改写');
  } finally {
    await stopHolder(child);
  }
});

// ── 4. stale lock 自愈 ──
await test('死进程残留的 stale lock 自动清理并可重新获取', async () => {
  const d = await tmpdir('lock-stale');
  const file = path.join(d, '.instance.lock');
  // 拿一个确定已死的 pid：起个 node 立刻退出，用它的 pid
  const dead = spawn(process.execPath, ['-e', '']);
  await new Promise((r) => dead.once('exit', r));
  const deadPid = dead.pid;
  await fsp.writeFile(file, JSON.stringify({ pid: deadPid, at: new Date(0).toISOString(), label: 'crashed' }));

  const got = acquireInstanceLock(file, { label: 'stale' });
  assert.equal(got, path.resolve(file));
  const info = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(info.pid, process.pid, 'stale 锁必须被当前进程接管');
  releaseInstanceLock(file);
});

// ── 5. runtime 目录可换 ──
await test('WUWU_RUNTIME_DIR 改写数据落点，缺省回退 <ROOT>/runtime', async () => {
  const probe = async (env) => {
    const script = `import { runtimePath, runtimeRoot } from ${JSON.stringify(RUNTIME_DIR_MOD)};`
      + `console.log(JSON.stringify({ root: runtimeRoot('/proj'), file: runtimePath('/proj', 'notes.json') }));`;
    const out = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let s = '';
      child.stdout.on('data', (d) => { s += d.toString(); });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve(s) : reject(new Error(`probe exit ${code} ${s}`))));
    });
    return JSON.parse(out);
  };

  const plain = await probe({ WUWU_RUNTIME_DIR: '' });
  assert.equal(plain.root, path.join('/proj', 'runtime'), '缺省必须是 <ROOT>/runtime，不能变成别处');
  assert.equal(plain.file, path.join('/proj', 'runtime', 'notes.json'));

  const custom = await probe({ WUWU_RUNTIME_DIR: '/tmp/ww-exp' });
  assert.equal(custom.root, '/tmp/ww-exp', '设了 WUWU_RUNTIME_DIR 就必须整体换走');
  assert.equal(custom.file, '/tmp/ww-exp/notes.json', '子路径要跟着换，不能只有根变了');
});

// ── 6. hub.mjs 真实启动：第二个实例 exit 78，第一个仍健康 ──
await test('hub.mjs 第二个实例 exit 78，第一个实例仍能正常应答', async () => {
  const d = await tmpdir('hub-dup');
  const runtime = path.join(d, 'runtime');
  const port1 = await freePort();
  const port2 = await freePort();

  const first = spawn(process.execPath, [path.join(ROOT, 'hub.mjs')], {
    cwd: ROOT,
    env: { ...process.env, WUWU_RUNTIME_DIR: runtime, PORT: String(port1), BIND: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let firstOut = '';
  first.stdout.on('data', (d) => { firstOut += d.toString(); });
  first.stderr.on('data', (d) => { firstOut += d.toString(); });

  try {
    // 等第一个实例 bind 成功（最多 8s）
    const booted = await (async () => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (firstOut.includes('bind ok')) return true;
        if (first.exitCode !== null) return false;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    })();
    assert.ok(booted, `第一个实例没起来：${firstOut.slice(-400)}`);

    // 第二个实例：同一 runtime、不同端口 → 必须被锁拦下
    const second = spawn(process.execPath, [path.join(ROOT, 'hub.mjs')], {
      cwd: ROOT,
      env: { ...process.env, WUWU_RUNTIME_DIR: runtime, PORT: String(port2), BIND: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let secondErr = '';
    second.stdout.on('data', (d) => { secondErr += d.toString(); });
    second.stderr.on('data', (d) => { secondErr += d.toString(); });
    const code = await new Promise((resolve) => {
      const timer = setTimeout(() => { second.kill('SIGKILL'); resolve('timeout'); }, 8000);
      second.on('exit', (c) => { clearTimeout(timer); resolve(c); });
    });
    assert.equal(code, 78, `第二个实例必须以 78 退出（EX_CONFIG），实际 ${code}：${secondErr.slice(-300)}`);
    assert.match(secondErr, /已在运行/, '要告诉用户是「已在运行」，不是一段栈');

    // 第一个实例没被影响
    const res = await fetch(`http://127.0.0.1:${port1}/api/ping`, { signal: AbortSignal.timeout(4000) });
    assert.equal(res.status, 200, '第一个实例必须仍健康');
    const body = await res.json();
    assert.equal(body.ok, true);

    // 锁文件仍在，且 pid 属于第一个实例
    const info = JSON.parse(await fsp.readFile(path.join(runtime, '.instance.lock'), 'utf8'));
    assert.equal(info.pid, first.pid, '锁必须由第一个实例持有');
  } finally {
    await stopHolder(first);
  }
});

for (const d of dirs) await fsp.rm(d, { recursive: true, force: true });

if (failures.length) {
  console.error(`\n${passed} passed; FAILED (${failures.join(' | ')})`);
  process.exitCode = 1;
} else {
  console.log(`\n${passed} passed; OK`);
}
