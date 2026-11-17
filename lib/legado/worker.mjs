/**
 * Worker 入口：在独立线程内执行规则引擎实现，主线程仅收发消息。
 * 同步 curl / vm 沙箱阻塞只影响本 worker，不触碰主线程事件循环。
 */

import { parentPort } from 'node:worker_threads';
import { __core } from './index.mjs';

parentPort.on('message', async ({ id, op, args }) => {
  try {
    const fn = __core[op];
    if (typeof fn !== 'function') {
      parentPort.postMessage({ id, error: `未知引擎方法：${op}` });
      return;
    }
    const res = await fn(...(args || []));
    parentPort.postMessage({ id, res });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.message || error) });
  }
});
