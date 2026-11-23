import path from 'node:path';

/**
 * runtime 根目录：默认 <项目>/runtime，可用 WUWU_RUNTIME_DIR 整体换走。
 *
 * 为什么需要它：实例锁（lib/instance_lock.mjs）保证「同一 runtime/ 同时只有一个可写实例」。
 * 如果想在另一个端口跑实验实例，就必须连数据目录一起换，否则两个进程写同一份
 * notes/home/calendar/download/library/photos.json，各自 cache 互相覆盖，锁正是要拦这件事。
 *
 * 正确姿势：
 *   WUWU_RUNTIME_DIR=/tmp/ww-exp-runtime PORT=8891 node hub.mjs
 *
 * 这个模块独立成文件是为了让 worker 线程也能拿到同一个根（worker 只收到 env，收不到 argv）。
 */
export const RUNTIME_DIR = process.env.WUWU_RUNTIME_DIR
  ? path.resolve(process.env.WUWU_RUNTIME_DIR)
  : null; // null = 调用方自己拼 <模块 ROOT>/runtime，保持原行为

/** 给定模块自己的 ROOT，返回该模块应使用的 runtime 根。 */
export function runtimeRoot(moduleRoot) {
  return RUNTIME_DIR || path.join(moduleRoot, 'runtime');
}

/** 直接拿 runtime 下的某个子路径。 */
export function runtimePath(moduleRoot, ...parts) {
  return path.join(runtimeRoot(moduleRoot), ...parts);
}
