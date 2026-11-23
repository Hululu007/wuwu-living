/**
 * Worker 线程池：主线程只做消息传递，规则解析 / 同步 curl 全部在 worker 内完成。
 *
 * 约束：
 *  - 并发上限 4；每个槽位同一时刻只跑一个任务，完成后显式还槽；
 *  - 单任务墙钟超时 10s，超时 terminate 该 worker 并重建；
 *  - 队列上限 200，超限返回「引擎繁忙」，不无限堆积；
 *  - 任务与响应用 taskId 严格配对；同一 taskId 二次投递直接忽略；
 *  - worker 崩溃 / 退出时捕获并重建，其上未完成任务按失败返回，不抛回主线程。
 */

import { Worker } from 'node:worker_threads';

// 槽位数直接决定全源搜索的总时长（300 源实测，同一台机器、同一批源）：
//   4 槽 → 204s ｜ 8 槽 → 118s ｜ 12 槽 → 81s ｜ 16 槽 → 60s
// 耗时近似按槽数线性下降，说明瓶颈是外站延迟而非本地 CPU；
// 代价是 RSS：8 槽 236MB、12 槽 347MB、16 槽 453MB。
// 本机 8GB、客厅常驻，取 12 作为默认（81s ≈ README 承诺的 60–90 秒，内存仍宽裕），
// 需要更快可以在启动前用 LEGADO_POOL_SIZE=16 覆盖。
const POOL_SIZE = Number(process.env.LEGADO_POOL_SIZE) > 0 ? Number(process.env.LEGADO_POOL_SIZE) : 12;
// 队列上限放宽到 400：旧值 200 配合高并发会让大半书源一投递就回「引擎繁忙」，
// 实测一轮搜索 busyRetries 高达 9317 次。放宽后同条件下归零。
const QUEUE_LIMIT = 400;
const TASK_TIMEOUT_MS = 10000;

let slots = [];
let queue = [];
let nextTaskId = 1;

/** 创建一个 worker 槽位。 */
function spawnSlot() {
  const worker = new Worker(new URL('./worker.mjs', import.meta.url), { execArgv: [] });
  const slot = {
    worker,
    busy: false,
    dead: false,
    currentId: null,
    tasks: new Map(),
  };

  worker.on('message', (msg) => {
    const id = msg && msg.id;
    const task = slot.tasks.get(id);
    // 同一 taskId 禁止二次投递：旧响应已删槽后直接忽略
    if (!task) return;

    slot.tasks.delete(id);
    if (slot.currentId === id) slot.currentId = null;
    clearTimeout(task.timer);
    // 显式还槽：消息到达后槽位立即释放，不等待后续微任务
    slot.busy = false;

    const settledAt = Date.now();
    task.metrics = {
      queueWaitMs: (task.dispatchedAt || settledAt) - (task.submittedAt || settledAt),
      engineMs: typeof msg.res?.ms === 'number' ? msg.res.ms : settledAt - (task.dispatchedAt || settledAt),
      wallMs: settledAt - (task.submittedAt || settledAt),
    };

    if (msg.error != null) {
      task.reject(new Error(msg.error));
    } else {
      task.resolve(msg.res);
    }
    drainQueue();
  });

  worker.on('error', (err) => {
    if (slot.dead) return;
    slot.dead = true;
    for (const task of slot.tasks.values()) {
      clearTimeout(task.timer);
      task.reject(new Error(`worker 异常：${err.message || err}`));
    }
    slot.tasks.clear();
    slot.currentId = null;
    slot.busy = false;
    replaceSlot(slot);
  });

  worker.on('exit', (code) => {
    if (slot.dead) return;
    slot.dead = true;
    for (const task of slot.tasks.values()) {
      clearTimeout(task.timer);
      task.reject(new Error(`worker 退出（code=${code}）`));
    }
    slot.tasks.clear();
    slot.currentId = null;
    slot.busy = false;
    replaceSlot(slot);
  });

  return slot;
}

/** 用新槽位替换死亡槽位。 */
function replaceSlot(deadSlot) {
  const idx = slots.indexOf(deadSlot);
  const fresh = spawnSlot();
  if (idx >= 0) slots[idx] = fresh;
  else slots.push(fresh);
  drainQueue();
}

/** 预热：进程内即预建全部 worker，不等待第一个任务再 spawn。 */
export function ensurePool() {
  if (!slots.length) slots = Array.from({ length: POOL_SIZE }, spawnSlot);
  return slots;
}

/** 队列排空：把排队任务派给空闲槽位。 */
function drainQueue() {
  while (queue.length) {
    const free = slots.find((w) => !w.busy && !w.dead);
    if (!free) break;
    const task = queue.shift();
    dispatchTo(free, task);
  }
}

/** 把任务派给指定槽位。 */
function dispatchTo(slot, task) {
  if (slot.busy || slot.dead) {
    queue.unshift(task);
    return;
  }
  slot.busy = true;
  slot.currentId = task.id;
  slot.tasks.set(task.id, task);
  task.submittedAt = task.submittedAt || Date.now();
  task.dispatchedAt = Date.now();
  task.timer = setTimeout(() => onTimeout(slot, task), TASK_TIMEOUT_MS);
  slot.worker.postMessage({ id: task.id, op: task.op, args: task.args });
}

/** 任务超时：终止并重建该 worker，任务失败返回。 */
function onTimeout(slot, task) {
  if (!slot.tasks.has(task.id)) return;
  slot.tasks.delete(task.id);
  if (slot.currentId === task.id) slot.currentId = null;
  slot.busy = false;
  task.reject(new Error('任务超时（10s），worker 已回收重建'));
  if (!slot.dead) {
    slot.dead = true;
    slot.worker.terminate().catch(() => {});
    replaceSlot(slot);
  }
  drainQueue();
}

/** 池状态（测试 / 自检用）。 */
export function poolStats() {
  return {
    workers: slots.length,
    busy: slots.filter((w) => w.busy).length,
    queue: queue.length,
    dead: slots.filter((w) => w.dead).length,
  };
}

/** 稳态断言：无在跑任务时队列也应为空。 */
export function assertSteadyState() {
  const s = poolStats();
  if (s.busy !== 0 || s.queue !== 0) {
    throw new Error(`池非稳态：busy=${s.busy}, queue=${s.queue}`);
  }
  return s;
}

/** 内部提交：onSettle 可用于挂接耗时打点。 */
function submit(op, args, onSettle) {
  ensurePool();
  return new Promise((resolve, reject) => {
    const hasFree = slots.some((w) => !w.busy && !w.dead);
    if (!hasFree && queue.length >= QUEUE_LIMIT) {
      reject(new Error('引擎繁忙：任务队列已满'));
      return;
    }

    const task = {
      id: nextTaskId++,
      op,
      args,
      resolve,
      reject,
      timer: null,
      submittedAt: Date.now(),
      dispatchedAt: null,
      metrics: null,
    };
    if (onSettle) {
      const rawResolve = task.resolve;
      const rawReject = task.reject;
      task.resolve = (res) => { onSettle(task.metrics); rawResolve(res); };
      task.reject = (err) => { onSettle(task.metrics, err); rawReject(err); };
    }
    const free = slots.find((w) => !w.busy && !w.dead);
    if (free) dispatchTo(free, task);
    else queue.push(task);
  });
}

/**
 * 提交任务到 worker 池。
 * @param {string} op core 方法名
 * @param {Array} args 参数数组
 * @returns {Promise<any>}
 */
export function runInPool(op, args) {
  return submit(op, args);
}

/** 带三段耗时的提交：{ result, metrics:{queueWaitMs,engineMs,wallMs} }。 */
export function runInPoolTimed(op, args) {
  let metrics = null;
  return submit(op, args, (m) => { metrics = m; }).then((result) => ({ result, metrics }));
}

// 池惰性创建：首次提交任务时才 spawn；预热由集成方在 listen 后显式调用 warmup()。
