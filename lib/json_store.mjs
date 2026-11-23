/**
 * JSON 落盘 —— 原子写 + 单文件串行化
 *
 * 各房间原来各自抄一份 save()，有三个真缺陷：
 *   1. `await save()` 立刻返回，真正写盘在 200ms 后的 setTimeout 里：
 *      handler 已经回了 200，测试/脚本读盘读到的还是旧内容，进程被 kill 时也会丢；
 *   2. 「读 → 改 → 写」没有互斥：20 个并发的 /api/home/todos add 各自读到同一份空数组，
 *      最后一个写入覆盖前面的，20 条只剩 1 条（实测复现）；
 *   3. 同一文件的多次写共用固定 `.tmp`，并发时互相踩，可能 rename 出半份文件。
 *
 * 这里的契约：
 *   - writeJson(file, data)：写 `.tmp.<随机>` → fsync → rename，原子且不共享临时名；
 *   - createStore(file, opts)：给一份内存状态 + 串行化的 mutate()，
 *     mutate 里的读改写天然排队，不会丢更新；
 *   - store.flush()：等到此刻为止排队的所有写都落盘（进程退出/测试用）。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** 每个文件一条写链，避免同一路径的并发写互相踩临时文件 */
const chains = new Map();

function chainOf(file) {
  const key = path.resolve(file);
  let tail = chains.get(key);
  if (!tail) {
    tail = Promise.resolve();
    chains.set(key, tail);
  }
  return { key, tail };
}


/**
 * 读坏文件时先留证据再降级。
 *
 * 所有房间的 load() 都是 catch → 用空表继续跑，接着下一次变更就把空表写回同一个路径。
 * 实测（scripts/data-robustness-audit.mjs 场景 B）：把 notes.json 截断后重启，
 * 页面照常打开、notes 变成 0 条，原数据被静默覆盖、没有任何回滚点。
 * 这里在降级前把坏文件原样复制一份 `<file>.corrupt-<时间戳>`，
 * 让「页面还能用」和「数据救得回来」同时成立。
 *
 * @param {string} file
 * @returns {Promise<string|null>} 备份路径；没东西可备份时返回 null
 */
export async function quarantineCorrupt(file) {
  const abs = path.resolve(file);
  try {
    const raw = await fsp.readFile(abs);
    if (!raw.length) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = `${abs}.corrupt-${stamp}`;
    await fsp.writeFile(dest, raw);
    console.error(`[json_store] ${path.basename(abs)} 解析失败，原文已备份到 ${path.basename(dest)}`);
    return dest;
  } catch {
    return null;
  }
}

/**
 * 读 JSON 文件；读坏/不存在时返回 null，并在读坏时留一份备份。
 * @param {string} file
 * @param {{quarantine?:boolean}} [opts]
 */
export async function readJsonFile(file, opts = {}) {
  const abs = path.resolve(file);
  let raw;
  try {
    raw = await fsp.readFile(abs, 'utf8');
  } catch {
    return null; // 文件还不存在：正常首次启动
  }
  try {
    return JSON.parse(raw);
  } catch {
    if (opts.quarantine !== false) await quarantineCorrupt(abs);
    return null;
  }
}

/**
 * 同步版读 JSON（给启动期/同步调用点用），语义与 readJsonFile 一致。
 * @param {string} file
 * @param {{quarantine?:boolean}} [opts]
 */
export function readJsonFileSync(file, opts = {}) {
  const abs = path.resolve(file);
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    if (opts.quarantine !== false) {
      try {
        if (raw.length) {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          fs.writeFileSync(`${abs}.corrupt-${stamp}`, raw);
          console.error(`[json_store] ${path.basename(abs)} 解析失败，原文已备份`);
        }
      } catch { /* 备份失败不阻断启动 */ }
    }
    return null;
  }
}

/**
 * 原子写 JSON。返回的 Promise 在数据真正 rename 完成后才 resolve。
 * @param {string} file
 * @param {unknown} data
 * @param {{indent?:number}} [opts]
 */
export function writeJson(file, data, opts = {}) {
  const abs = path.resolve(file);
  const indent = opts.indent === undefined ? 2 : opts.indent;
  const { key, tail } = chainOf(abs);
  const next = tail
    .catch(() => {})
    .then(async () => {
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      const tmp = `${abs}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
      const body = JSON.stringify(data, null, indent);
      let fh;
      try {
        fh = await fsp.open(tmp, 'w');
        await fh.writeFile(body, 'utf8');
        // 先落盘再 rename，避免断电后 rename 出来的是空文件
        await fh.sync().catch(() => {});
      } finally {
        if (fh) await fh.close().catch(() => {});
      }
      try {
        await fsp.rename(tmp, abs);
      } catch (e) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw e;
      }
    });
  chains.set(key, next.catch(() => {}));
  return next;
}

/**
 * 同步版原子写（给没有 await 上下文的调用点用，比如启动期的健康表/缓存）。
 * 仍然走「独立临时名 → fsync → rename」，不会留下半截目标文件。
 * @param {string} file
 * @param {unknown} data
 * @param {{indent?:number}} [opts]
 */
export function writeJsonSync(file, data, opts = {}) {
  const abs = path.resolve(file);
  const indent = opts.indent === undefined ? 2 : opts.indent;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
  const body = JSON.stringify(data, null, indent);
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, body, 'utf8');
    try { fs.fsyncSync(fd); } catch { /* 某些文件系统不支持 */ }
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
  try {
    fs.renameSync(tmp, abs);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
  return abs;
}

/**
 * 建一个有内存状态、写盘串行化的 store。
 *
 * @template T
 * @param {string} file
 * @param {{defaults:()=>T, parse?:(raw:any)=>T, serialize?:(state:T)=>unknown, debounceMs?:number, label?:string}} opts
 */
export function createStore(file, opts) {
  const abs = path.resolve(file);
  const label = opts.label || path.basename(abs);
  const debounceMs = Number.isFinite(opts.debounceMs) ? Number(opts.debounceMs) : 0;
  const parse = opts.parse || ((raw) => raw);
  const serialize = opts.serialize || ((state) => state);

  /** @type {T|null} */
  let state = null;
  let loadPromise = null;
  let queue = Promise.resolve();
  let timer = null;
  let dirty = false;

  async function load() {
    if (state) return state;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      try {
        const raw = JSON.parse(await fsp.readFile(abs, 'utf8'));
        state = parse(raw);
      } catch {
        // 文件不存在 / 读坏：当空数据继续跑，但记住真实原因以便排查
        state = opts.defaults();
      }
      return state;
    })();
    return loadPromise;
  }

  function snapshot() {
    // 序列化时就地取快照，避免延时写期间状态被继续改动而写出中间态
    return JSON.parse(JSON.stringify(serialize(state)));
  }

  async function flushNow() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!dirty || !state) return;
    dirty = false;
    const payload = snapshot();
    await writeJson(abs, payload);
  }

  function schedule() {
    if (debounceMs <= 0) return;
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void flushNow().catch((e) => console.error(`[${label}] 落盘失败:`, e && e.message));
    }, debounceMs);
    timer.unref?.();
  }

  return {
    file: abs,
    get state() { return state; },
    async read() { return load(); },
    /**
     * 串行化的读改写：fn 里的改动按调用顺序生效，返回 fn 的返回值。
     * 返回的 Promise 在数据落盘后 resolve（debounceMs=0 时立即写）。
     */
    async mutate(fn) {
      await load();
      const run = queue.then(async () => {
        const out = await fn(state);
        if (debounceMs > 0) {
          schedule();
          // 延时写也保证「await mutate 之后能读到」：这里直接落一次
          await flushNow();
        } else {
          await writeJson(abs, snapshot());
        }
        return out;
      });
      queue = run.catch(() => {});
      return run;
    },
    /** 只读快照（深拷贝），给 summary/列表用，避免外部改到内部状态 */
    async view() {
      await load();
      return JSON.parse(JSON.stringify(state));
    },
    async flush() {
      await queue.catch(() => {});
      await flushNow();
    },
  };
}
