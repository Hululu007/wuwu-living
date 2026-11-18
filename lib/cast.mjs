/**
 * 投屏 —— 把手机画面投到 Mac（scrcpy 后端）
 *
 * 后端不是重新实现一套参数，而是直接调用已经移植好的 ~/D盘/bin/scrcpy-mac/投屏：
 * 那份脚本里已经踩平了 Windows .bat 的三个坑（--window-aspect-ratio 不存在 /
 * crop 的 height=0 / 分辨率与序列号写死），这里只管"什么时候起、起哪个预设、怎么停"。
 *
 * 接口：
 *   GET  /api/cast/state     平台、工具链、设备列表、当前会话、预设
 *   GET  /api/cast/devices   只查设备（页面轮询用，轻）
 *   POST /api/cast/start     { preset, serial, extra }  起投屏
 *   POST /api/cast/stop      停投屏（只杀自己起的那个，不误伤手动开的 scrcpy）
 *   POST /api/cast/record    { serial }  录一份到 ~/Movies/
 *   GET  /api/cast/log?lines=120         投屏日志尾巴
 *   GET  /api/cast/presets   预设清单
 *
 * 进程：scrcpy 是 GUI 程序，必须 detached + 日志重定向到 runtime/cast.log；
 * pid 落盘 runtime/cast.json，客厅重启后还能认回自己起的那一个。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const meta = { id: 'cast', name: '投屏', color: '#E0A46E' };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = path.join(ROOT, 'runtime', 'cast.json');
const LOG_FILE = path.join(ROOT, 'runtime', 'cast.log');

const HOME = os.homedir();

/** 房间配置：config/cast.json。缺字段就用默认，读坏也不影响投屏 */
function readConfig() {
  const defaults = { preset: 'default', scrcpyDir: '', adb: '', extraArgs: '', recordDir: '~/Movies' };
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'config', 'cast.json'), 'utf8');
    return Object.assign(defaults, JSON.parse(raw) || {});
  } catch {
    return defaults;
  }
}
const CFG = readConfig();
const expandHome = (p) => (p && p.startsWith('~') ? path.join(HOME, p.slice(1)) : p);
const SCRCPY_DIR = expandHome(CFG.scrcpyDir) || path.join(HOME, 'D盘', 'bin', 'scrcpy-5.0.1');
const CAST_BIN = path.join(HOME, 'D盘', 'bin', 'scrcpy-mac', '投屏');
const SCRCPY = path.join(SCRCPY_DIR, 'scrcpy');
const ADB_CANDIDATES = [expandHome(CFG.adb), '/usr/local/bin/adb', path.join(SCRCPY_DIR, 'adb'), '/opt/homebrew/bin/adb'].filter(Boolean);

/** 预设：与 `投屏 list` 保持同一份口径；label 是给人看的，arg 是传给脚本的 */
export const PRESETS = [
  { arg: 'default', label: '默认', desc: '1920 / 20M / 60fps / 息屏', color: '#E0A46E' },
  { arg: 'full', label: '全屏', desc: '1920 / 30M / 60fps / 全屏', color: '#D99A5E' },
  { arg: 'pro', label: 'Pro', desc: '全屏 + 息屏 + 触摸点 + 常亮', color: '#CE8F52' },
  { arg: 'crop169', label: '16:9', desc: '裁中间带 + 拉伸铺满', color: '#C08446' },
  { arg: '铺满', label: '铺满', desc: '拉伸铺满不留黑边', color: '#B2793B' },
  { arg: '视频', label: '视频', desc: '16:9 铺满、不带声音', color: '#A66E30' },
];

let adbPath = null;
function findAdb() {
  if (adbPath && fs.existsSync(adbPath)) return adbPath;
  adbPath = ADB_CANDIDATES.find((p) => fs.existsSync(p)) || null;
  return adbPath;
}

/** 跑一条命令，永不抛错 */
function run(cmd, args, timeout = 12000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : (err ? -1 : 0),
        out: String(stdout || ''),
        err: String(stderr || (err && err.message) || ''),
      });
    });
  });
}

/* ───────────────────────── 状态 ───────────────────────── */

async function readState() {
  try {
    return JSON.parse(await fsp.readFile(STATE_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

async function writeState(obj) {
  try {
    await fsp.mkdir(path.dirname(STATE_FILE), { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(obj, null, 2));
    await fsp.rename(tmp, STATE_FILE);
  } catch {}
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM'; // 活着但不归我们杀
  }
}

/** 读进程命令行，确认这个 pid 真的是我们的窗口（防 pid 复用误杀） */
async function cmdlineOf(pid) {
  const r = await run('/bin/ps', ['-p', String(pid), '-o', 'command=']);
  return r.ok ? r.out.trim() : '';
}

/* ───────────────────────── 设备 ───────────────────────── */

async function listDevices() {
  const adb = findAdb();
  if (!adb) return { adb: null, devices: [], error: '找不到 adb' };
  const r = await run(adb, ['devices', '-l']);
  if (!r.ok) return { adb, devices: [], error: r.err.trim() || 'adb 执行失败' };
  const devices = [];
  for (const line of r.out.split(/\r?\n/)) {
    if (!line.trim() || /^List of devices/.test(line)) continue;
    const serial = line.split(/\s+/)[0];
    const state = (line.match(/\b(device|unauthorized|offline|recovery|sideload)\b/) || [])[1] || 'unknown';
    const model = (line.match(/\bmodel:([^\s]+)/) || [])[1] || '';
    const product = (line.match(/\bproduct:([^\s]+)/) || [])[1] || '';
    devices.push({ serial, state, model, product });
  }
  return { adb, devices, error: null };
}

/** 在有设备时补齐型号与系统版本（轻查询，页面用）
 *  带 10 秒缓存：页面 3 秒轮询一次，不必每次都跑 4 条 adb shell。 */
const detailCache = new Map(); // serial -> { at, data }
async function deviceDetail(serial) {
  const adb = findAdb();
  if (!adb || !serial) return null;
  const hit = detailCache.get(serial);
  if (hit && Date.now() - hit.at < 10000) return hit.data;
  const [model, rel, sdk, size] = await Promise.all([
    run(adb, ['-s', serial, 'shell', 'getprop', 'ro.product.model']),
    run(adb, ['-s', serial, 'shell', 'getprop', 'ro.build.version.release']),
    run(adb, ['-s', serial, 'shell', 'getprop', 'ro.build.version.sdk']),
    run(adb, ['-s', serial, 'shell', 'wm', 'size']),
  ]);
  const sizeText = (size.out.match(/(\d+)\s*x\s*(\d+)/) || []);
  const data = {
    model: model.out.trim() || null,
    android: rel.out.trim() || null,
    sdk: Number(sdk.out.trim()) || null,
    width: Number(sizeText[1]) || null,
    height: Number(sizeText[2]) || null,
  };
  detailCache.set(serial, { at: Date.now(), data });
  return data;
}

/* ───────────────────────── 会话 ───────────────────────── */

async function sessionState() {
  const st = await readState();
  if (!st.pid) return { running: false };
  if (!alive(st.pid)) {
    // 进程没了，把残留状态清掉，避免页面显示"正在投屏"
    await writeState({});
    return { running: false, lastPreset: st.preset || null, endedAt: st.startedAt || null };
  }
  const cmd = await cmdlineOf(st.pid);
  // pid 被复用成别的进程时不算我们的
  if (!/scrcpy|投屏/.test(cmd)) {
    await writeState({});
    return { running: false, lastPreset: st.preset || null };
  }
  return {
    running: true,
    pid: st.pid,
    preset: st.preset || null,
    serial: st.serial || null,
    startedAt: st.startedAt || null,
    record: st.record || null,
    cmd,
  };
}

/* ───────────────────────── 日志 ───────────────────────── */

async function tailLog(lines = 120) {
  try {
    const raw = await fsp.readFile(LOG_FILE, 'utf8');
    const arr = raw.split(/\r?\n/).filter(Boolean);
    return arr.slice(-Math.max(1, Math.min(lines, 400)));
  } catch {
    return [];
  }
}

/* ───────────────────────── 动作 ───────────────────────── */

async function startCast({ preset = '', serial = '', extra = '' } = {}) {
  const chosen = preset || CFG.preset || 'default';
  const valid = PRESETS.some((p) => p.arg === chosen) || chosen === '录';
  if (!valid) return { ok: false, message: `未知预设 ${chosen}` };

  const cur = await sessionState();
  if (cur.running) return { ok: false, message: '已经在投屏了，先停掉再换预设', session: cur };

  if (!fs.existsSync(CAST_BIN)) {
    return { ok: false, message: `找不到投屏脚本：${CAST_BIN}` };
  }
  if (!fs.existsSync(SCRCPY)) {
    return { ok: false, message: `找不到 scrcpy：${SCRCPY}` };
  }
  const d = await listDevices();
  if (!d.adb) return { ok: false, message: '找不到 adb（也没在 scrcpy 包里找到）' };
  if (!d.devices.length) return { ok: false, message: '没有设备。插 USB → 手机上点「允许 USB 调试」' };
  const usable = d.devices.filter((x) => x.state === 'device');
  if (!usable.length) {
    const first = d.devices[0];
    return { ok: false, message: `设备 ${first.serial} 状态是 ${first.state}，请在手机上确认授权` };
  }
  const target = serial || usable[0].serial;
  if (!usable.some((x) => x.serial === target)) {
    return { ok: false, message: `设备 ${target} 不在可用列表里` };
  }

  // 追加参数：配置里的 extraArgs 打底，页面传的追加在后
  const extraArgs = [String(CFG.extraArgs || '').trim(), String(extra || '').trim()]
    .filter(Boolean).join(' ');
  const args = [CAST_BIN, chosen];
  if (extraArgs) args.push(...extraArgs.split(/\s+/).filter(Boolean));

  try {
    await fsp.mkdir(path.dirname(LOG_FILE), { recursive: true });
    const fd = fs.openSync(LOG_FILE, 'a');
    fs.writeSync(fd, `\n=== ${new Date().toISOString()} start ${chosen} ${target} ${extraArgs} ===\n`);
    const child = spawn('/bin/bash', args, {
      cwd: path.join(HOME, 'D盘', 'bin', 'scrcpy-mac'),
      detached: true,
      stdio: ['ignore', fd, fd],
      env: Object.assign({}, process.env, {
        MELD_DEVICE: target,
        // 后端没有终端，别让 scrcpy 去读 tty
        SCRCPY_SERVER_PATH: path.join(SCRCPY_DIR, 'scrcpy-server'),
      }),
    });
    child.unref();
    fs.closeSync(fd);

    const st = {
      pid: child.pid,
      preset: chosen,
      serial: target,
      extra: extraArgs,
      startedAt: Date.now(),
    };
    await writeState(st);
    return { ok: true, message: `已启动「${chosen}」→ ${target}`, session: st };
  } catch (e) {
    return { ok: false, message: `启动失败：${e && e.message}` };
  }
}

async function stopCast() {
  const st = await readState();
  if (!st.pid) return { ok: true, message: '本来就没在投屏' };
  if (!alive(st.pid)) {
    await writeState({});
    return { ok: true, message: '进程已经退了' };
  }
  const cmd = await cmdlineOf(st.pid);
  if (!/scrcpy|投屏/.test(cmd)) {
    await writeState({});
    return { ok: true, message: 'pid 已经不是我们的进程了，不动它' };
  }
  // detached 起的是独立进程组，按组杀才能连带 scrcpy 的 children
  try {
    process.kill(-st.pid, 'TERM');
  } catch {
    try { process.kill(st.pid, 'TERM'); } catch {}
  }
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (!alive(st.pid)) break;
  }
  if (alive(st.pid)) {
    try { process.kill(-st.pid, 'KILL'); } catch { try { process.kill(st.pid, 'KILL'); } catch {} }
  }
  await writeState({});
  return { ok: true, message: '已停止投屏' };
}

async function recordCast({ serial = '' } = {}) {
  const st = await readState();
  if (st.pid && alive(st.pid)) return { ok: false, message: '正在投屏，先停掉再录' };
  const d = await listDevices();
  if (!d.adb) return { ok: false, message: '找不到 adb' };
  const usable = d.devices.filter((x) => x.state === 'device');
  if (!usable.length) return { ok: false, message: '没有可用设备' };
  const target = serial || usable[0].serial;

  const stamp = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = `scrcpy-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-` +
    `${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.mp4`;
  const out = path.join(expandHome(CFG.recordDir) || path.join(HOME, 'Movies'), name);

  try {
    await fsp.mkdir(path.dirname(LOG_FILE), { recursive: true });
    const fd = fs.openSync(LOG_FILE, 'a');
    fs.writeSync(fd, `\n=== ${new Date().toISOString()} record ${target} ===\n`);
    const child = spawn('/bin/bash', [CAST_BIN, '录', out], {
      cwd: path.join(HOME, 'D盘', 'bin', 'scrcpy-mac'),
      detached: true,
      stdio: ['ignore', fd, fd],
      env: Object.assign({}, process.env, {
        MELD_DEVICE: target,
        SCRCPY_SERVER_PATH: path.join(SCRCPY_DIR, 'scrcpy-server'),
      }),
    });
    child.unref();
    fs.closeSync(fd);
    await writeState({ pid: child.pid, preset: 'pro', serial: target, record: out, startedAt: Date.now() });
    return { ok: true, message: `录制中 → ${out}`, file: out };
  } catch (e) {
    return { ok: false, message: `录制启动失败：${e && e.message}` };
  }
}

/* ───────────────────────── 路由 ───────────────────────── */

const okJson = (ctx, obj, code = 200) => ctx.json(code, Object.assign({ ok: true }, obj));
const errJson = (ctx, message, code = 400) => ctx.json(code, { ok: false, message });

async function handleState(ctx) {
  const [d, s] = await Promise.all([listDevices(), sessionState()]);
  const detail = d.devices.find((x) => x.state === 'device');
  const info = detail ? await deviceDetail(detail.serial) : null;
  return okJson(ctx, {
    platform: process.platform,
    toolchain: {
      castScript: fs.existsSync(CAST_BIN),
      scrcpy: fs.existsSync(SCRCPY),
      adb: d.adb,
    },
    devices: d.devices,
    device: info ? Object.assign({ serial: detail.serial }, info) : null,
    error: d.error,
    session: s,
    presets: PRESETS,
  });
}

export async function handle(ctx) {
  const p = ctx.p;

  if (p === '/api/cast/state') {
    await handleState(ctx);
    return true;
  }

  if (p === '/api/cast/devices') {
    const d = await listDevices();
    okJson(ctx, { devices: d.devices, error: d.error, adb: d.adb });
    return true;
  }

  if (p === '/api/cast/presets') {
    okJson(ctx, { presets: PRESETS });
    return true;
  }

  if (p === '/api/cast/log') {
    const lines = Number(ctx.query.get('lines') || 120);
    okJson(ctx, { lines: await tailLog(lines) });
    return true;
  }

  if (p === '/api/cast/start' && ctx.method === 'POST') {
    const b = await ctx.body();
    const r = await startCast({ preset: b.preset, serial: b.serial, extra: b.extra });
    ctx.json(r.ok ? 200 : 409, r);
    return true;
  }

  if (p === '/api/cast/stop' && ctx.method === 'POST') {
    const r = await stopCast();
    okJson(ctx, r);
    return true;
  }

  if (p === '/api/cast/record' && ctx.method === 'POST') {
    const b = await ctx.body();
    const r = await recordCast({ serial: b.serial });
    ctx.json(r.ok ? 200 : 409, r);
    return true;
  }

  // 房间下的其它页面子路径（比如 /cast/xxx）交给静态文件
  if (!p.startsWith('/api/')) {
    const rel = p.slice('/cast/'.length);
    if (rel && !rel.includes('..')) {
      const abs = path.join(ROOT, 'public', '投屏', rel);
      if (fs.existsSync(abs)) {
        await ctx.file(abs);
        return true;
      }
    }
  }

  return false;
}

export async function init() {
  // 启动时把死掉会话的残留状态清掉，否则首页会显示一直在投屏
  const st = await readState();
  if (st.pid && !alive(st.pid)) await writeState({});
}

export async function summary() {
  try {
    const d = await listDevices();
    const s = await sessionState();
    const usable = d.devices.filter((x) => x.state === 'device').length;
    return {
      connected: usable,
      running: !!s.running,
      preset: s.preset || null,
      // 首页那一格显示一句人话
      line: s.running ? `投屏中 · ${s.preset || '默认'}` : (usable ? `已连接 ${usable} 台` : '未连接'),
      tone: s.running ? 'busy' : (usable ? 'ready' : 'idle'),
    };
  } catch {
    return { connected: 0, running: false, line: '读不到状态', tone: 'idle' };
  }
}
