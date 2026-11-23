import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 诊断日志的统一落点。
 *
 * ── 为什么要有这个模块（2026-11-22 实测）────────────────────────
 * 原来 6 处日志直接写 '/tmp/wuwu-*.log'，其中两处是**进程级崩溃兜底**
 * （uncaughtException / unhandledRejection）。问题：
 *   1. macOS 会清理 /tmp —— 崩溃证据可能在被查到之前就消失
 *   2. 8811 音乐房当天就栽在这上面：5 条 EADDRINUSE 靠 /tmp 残留才查出来，
 *      如果那文件当时是空的，根因到现在都查不出
 *   3. /tmp 是全局共享的 —— 任何进程（包括测试夹具）都能写到同名文件
 *   4. 无轮转 —— 实测 /tmp/wuwu-book-search.log 已 8.6MB
 *
 * ── 为什么不用 runtime/ ────────────────────────────────────────
 * runtime/ 是**数据目录**（json、书源、实例锁），已在 .gitignore。
 * 把日志塞进去有两个坏处：
 *   · 实验实例会带 WUWU_RUNTIME_DIR 换走整个 runtime ⇒ 日志跟着分叉，
 *     想查"刚才那次崩溃"时不知道该看哪个目录
 *   · 数据备份/迁移时会连日志一起搬，日志本不该被备份
 * 所以日志独立到 ~/Library/Logs/wuwu-living/（与 8811 的 lingting 同构）。
 *
 * ── 可用环境变量覆盖 ──────────────────────────────────────────
 *   WUWU_LOG_DIR=/tmp/xxx   （测试夹具用，避免污染真实日志目录）
 */
function resolveLogDir() {
  const override = process.env.WUWU_LOG_DIR;
  if (override) return path.resolve(override);
  return path.join(os.homedir(), 'Library', 'Logs', 'wuwu-living');
}

export const LOG_DIR = resolveLogDir();

/** 目录不存在时建一次；失败不抛（日志不能反过来把服务搞挂）。 */
function ensureDir() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 取某个日志文件的绝对路径。
 * @param {string} name 例如 'book-search.log'
 */
export function logPath(name) {
  return path.join(LOG_DIR, name);
}

/**
 * 追加一行到指定日志。**任何异常都吞掉**——
 * 这是崩溃兜底路径上的调用，日志写失败绝不能再抛。
 */
export function appendLog(name, line) {
  try {
    ensureDir();
    fs.appendFileSync(logPath(name), line);
  } catch {
    /* 日志失败不影响业务 */
  }
}
