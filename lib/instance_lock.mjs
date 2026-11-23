import fs from 'node:fs';
import path from 'node:path';

/**
 * 单实例互斥锁（跨进程，不是仅进程内 queue）。
 *
 * runtime/*.json 的 per-path Promise 链与原子写只能保证：
 *   - 单进程内不撕裂；
 *   - 单文件不会被写半截。
 * 它们挡不住「两个 Node 进程同时启动，各自持有自己的 cache」：
 * A 读全量 → B 读全量 → A 写回 → B 写回，A 的改动就被 B 覆盖。
 * 实测（data-robustness-audit 的 worker 对照）：2 进程各 100 次 RMW，最终只剩约 100 条。
 *
 * 这里用 `wx`（O_EXCL | O_CREAT）创建 lock 文件——同一时刻只有一个进程能创建成功，
 * 这是 POSIX 提供的原子操作，不需要额外依赖。文件里记 pid 便于排查。
 *
 * 误报防护：崩溃后残留的 lock 文件会让下次启动被拒绝，所以拿到 EEXIST 时
 * 先读 pid 并 `process.kill(pid, 0)` 探活；进程不在就清掉 stale lock 重试一次。
 */

const HELD = new Map(); // file → fd

export class InstanceLockError extends Error {
  constructor(message, holderPid) {
    super(message);
    this.name = 'InstanceLockError';
    this.holderPid = holderPid;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = 进程在，只是不属于当前用户，同样算活着
    return e && e.code === 'EPERM';
  }
}

export function acquireInstanceLock(file, { label = '服务' } = {}) {
  const abs = path.resolve(file);
  if (HELD.has(abs)) return abs; // 幂等：同进程重复 acquire 不会自相残杀

  fs.mkdirSync(path.dirname(abs), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(abs, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), label }));
      HELD.set(abs, fd);
      return abs;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;

      let holderPid = 0;
      try { holderPid = Number(JSON.parse(fs.readFileSync(abs, 'utf8')).pid) || 0; } catch { /* 半截 lock 按 stale 处理 */ }

      if (holderPid === process.pid) {
        // 同进程已持有（例如热重载再进一次）：直接认，不自锁
        return abs;
      }
      if (pidAlive(holderPid)) {
        throw new InstanceLockError(
          `${label} 已在运行（pid=${holderPid}，锁文件 ${abs}）。` +
          ' 同一 runtime/ 同时只能有一个可写实例；要换端口做实验，请同时指定独立 RUNTIME_DIR，否则会互相覆盖数据。',
          holderPid
        );
      }

      // stale：锁还在但进程已死，清掉再试一次
      try { fs.rmSync(abs, { force: true }); } catch { /* ignore */ }
    }
  }
  throw new InstanceLockError(`${label} 实例锁被占用且无法清理：${abs}`, 0);
}

export function releaseInstanceLock(file) {
  const abs = path.resolve(file);
  const fd = HELD.get(abs);
  if (fd === undefined) return;
  HELD.delete(abs);
  try { fs.closeSync(fd); } catch { /* ignore */ }
  try {
    const pid = Number(JSON.parse(fs.readFileSync(abs, 'utf8')).pid);
    if (pid === process.pid) fs.rmSync(abs, { force: true });
  } catch { /* 文件已不在也没事 */ }
}

/** 进程退出时释放；只注册一次，避免重复 listener。 */
export function installInstanceLockCleanup(file) {
  const abs = path.resolve(file);
  const release = () => releaseInstanceLock(abs);
  process.once('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(sig, () => {
      release();
      process.exit(128 + (sig === 'SIGINT' ? 2 : sig === 'SIGTERM' ? 15 : 1));
    });
  }
}
