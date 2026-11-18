/**
 * 投屏 —— 把手机画面投到 Mac（scrcpy 后端）
 *
 * 后端不是重新实现一套参数，而是直接调用已经移植好的 ~/D盘/bin/scrcpy-mac/投屏：
 * 那份脚本里已经踩平了 Windows .bat 的三个坑（--window-aspect-ratio 不存在 /
 * crop 的 height=0 / 分辨率与序列号写死），这里只管"什么时候起、起哪个预设、怎么停"。
 *
 * 接口：
 *   GET  /api/cast/state            工具链、设备、会话、预设、质量档
 *   GET  /api/cast/devices          只查设备（轻，带缓存）
 *   POST /api/cast/start            { preset, serial, extra, profile, alwaysOnTop, noAudio, title }
 *   POST /api/cast/stop             停投屏（只杀自己起的那个）
 *   POST /api/cast/record           { serial }  录一份到 ~/Movies/
 *   GET  /api/cast/log?lines=      日志尾巴
 *   GET  /api/cast/presets          预设清单 + 质量档
 *   POST /api/cast/key              { key }  遥控：返回/主页/多任务/锁屏/亮屏/音量/静音/播放
 *   POST /api/cast/shot             { serial }  截一张图，落到 runtime/cast/shots/
 *   GET  /api/cast/shots?limit=     最近截图列表
 *   GET  /api/cast/shot?name=       取图
 *   GET  /api/cast/doctor           体检：工具链 / 设备授权 / 日志可写
 *   POST /api/cast/reconnect        adb 掉线时重连
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
const SHOT_DIR = path.join(ROOT, 'runtime', 'cast', 'shots');
const LOG_MAX = 2 * 1024 * 1024; // 超过就裁到 512KB，别让日志无限长大
const LOG_KEEP = 512 * 1024;

const HOME = os.homedir();

/** 房间配置：config/cast.json。缺字段就用默认，读坏也不影响投屏 */
function readConfig() {
  const defaults = {
    preset: 'default', scrcpyDir: '', adb: '', extraArgs: '', recordDir: '~/Movies',
    profile: 'std', alwaysOnTop: false, noAudio: false,
  };
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
const SCRCPY_SERVER = path.join(SCRCPY_DIR, 'scrcpy-server');
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

/** 质量档：追加到 scrcpy 的 -b / --max-fps。默认走预设自己的值，选了才覆盖 */
export const PROFILES = [
  { arg: 'smooth', label: '流畅', desc: '8M / 30fps · 弱网、老机器', bitrate: '8M', fps: 30 },
  { arg: 'std', label: '标准', desc: '20M / 60fps · 日常', bitrate: '20M', fps: 60 },
  { arg: 'hd', label: '高清', desc: '40M / 60fps · 大屏细看', bitrate: '40M', fps: 60 },
];

/** 遥控键位：全部走 `adb shell input keyevent` */
const KEYS = {
  back: { code: 4, label: '返回' },
  home: { code: 3, label: '主页' },
  recents: { code: 187, label: '多任务' },
  power: { code: 26, label: '电源' },
  wake: { code: 224, label: '亮屏' },
  sleep: { code: 223, label: '息屏' },
  volup: { code: 24, label: '音量+' },
  voldown: { code: 25, label: '音量-' },
  mute: { code: 164, label: '静音' },
  play: { code: 126, label: '播放' },
  pause: { code: 127, label: '暂停' },
};

let adbPath = null;
function findAdb() {
  if (adbPath && fs.existsSync(adbPath)) return adbPath;
  adbPath = ADB_CANDIDATES.find((p) => fs.existsSync(p)) || null;
  return adbPath;
}

/** 跑一条命令，永不抛错 */
function run(cmd, args, timeout = 12000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : (err ? -1 : 0),
        out: String(stdout || ''),
        err: String(stderr || (err && err.message) || ''),
      });
    });
  });
}

/**
 * 把页面传来的额外参数切开 —— 要认引号，否则 --window-title "我的手机"
 * 会被空格拆成两段，scrcpy 直接解析失败。
 */
function splitArgs(text) {
  const out = [];
  let cur = '';
  let quote = '';
  for (const ch of String(text || '')) {
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) { out.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/* ───────────────────────── 日志 ───────────────────────── */

async function rotateLog() {
  try {
    const st = await fsp.stat(LOG_FILE);
    if (st.size <= LOG_MAX) return;
    const raw = await fsp.readFile(LOG_FILE);
    const tail = raw.subarray(Math.max(0, raw.length - LOG_KEEP));
    await fsp.writeFile(LOG_FILE, Buffer.concat([Buffer.from('# 更早的日志已裁掉\n'), tail]));
  } catch {}
}

/**
 * 日志尾巴。
 * filter=important 时把 scrcpy 的 INFO 常规行滤掉，只留分隔线、警告、错误
 * ——否则一屏 INFO 会把真正失败的那一行冲走。
 */
async function tailLog(lines = 120, filter = '') {
  try {
    const raw = await fsp.readFile(LOG_FILE, 'utf8');
    let rows = raw.split(/\r?\n/).filter(Boolean);
    if (filter === 'important') {
      rows = rows.filter((l) => {
        if (l.startsWith('===')) return true;
        if (/ERROR|WARN|Exception|Error type|Failed|error:|failed|拒绝|失败|不存在|不能/i.test(l)) return true;
        return !/^\s*INFO:/i.test(l);
      });
    }
    return rows.slice(-Math.max(1, Math.min(lines, 400)));
  } catch {
    return [];
  }
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

/* ─────────────────── scrcpy 选项校验 ─────────────────── */

let _helpCache = null;

async function scrcpyHelp() {
  if (_helpCache) return _helpCache;
  if (!fs.existsSync(SCRCPY)) {
    _helpCache = { ok: false, text: '' };
    return _helpCache;
  }
  const r = await run(SCRCPY, ['--help'], 9000);
  const text = `${r.out}\n${r.err}`;
  _helpCache = { ok: text.trim().length > 0, text };
  return _helpCache;
}

/**
 * 把要追加的参数里所有 `--opt` 拿到 `scrcpy --help` 里核一遍。
 * 有些版本静默忽略不认识的选项，有些直接退出——提前拦比事后猜日志省事。
 */
async function checkArgOptions(argv) {
  const list = Array.isArray(argv) ? argv : splitArgs(String(argv || ''));
  const names = [...new Set(list.filter((a) => a.startsWith('--')).map((a) => a.split('=')[0]))];
  if (!names.length) return { ok: true, names, missing: [] };
  const h = await scrcpyHelp();
  if (!h.ok || !h.text) return { ok: true, names, missing: [], unchecked: true };
  const missing = names.filter((n) => !h.text.includes(n));
  return { ok: missing.length === 0, names, missing };
}

/** 记录最近一次失败：页面能一直看到原因，不用蹲日志 */
async function noteError(message, detail) {
  const cur = await readState();
  await writeState(Object.assign({}, cur, {
    lastError: { message: String(message || ''), detail: String(detail || '').slice(-1200), at: Date.now() },
  }));
}

async function clearError() {
  const cur = await readState();
  if (!cur.lastError) return;
  delete cur.lastError;
  await writeState(cur);
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

/** 读进程命令行，确认这个 pid 真的是我们的窗口（防 pid 复用误杀）。1 秒缓存 */
const cmdCache = new Map(); // pid -> { at, cmd }
async function cmdlineOf(pid) {
  const hit = cmdCache.get(pid);
  if (hit && Date.now() - hit.at < 1000) return hit.cmd;
  const r = await run('/bin/ps', ['-p', String(pid), '-o', 'command=']);
  const cmd = r.ok ? r.out.trim() : '';
  cmdCache.set(pid, { at: Date.now(), cmd });
  return cmd;
}

/* ───────────────────────── 设备 ───────────────────────── */

let devCache = { at: 0, data: null };
async function listDevices(force = false) {
  if (!force && devCache.data && Date.now() - devCache.at < 1500) return devCache.data;
  const adb = findAdb();
  if (!adb) {
    const d = { adb: null, devices: [], error: '找不到 adb' };
    devCache = { at: Date.now(), data: d };
    return d;
  }
  const r = await run(adb, ['devices', '-l']);
  if (!r.ok) {
    const d = { adb, devices: [], error: r.err.trim() || 'adb 执行失败' };
    devCache = { at: Date.now(), data: d };
    return d;
  }
  const devices = [];
  for (const line of r.out.split(/\r?\n/)) {
    if (!line.trim() || /^List of devices/.test(line)) continue;
    const serial = line.split(/\s+/)[0];
    const state = (line.match(/\b(device|unauthorized|offline|recovery|sideload)\b/) || [])[1] || 'unknown';
    const model = (line.match(/\bmodel:([^\s]+)/) || [])[1] || '';
    const product = (line.match(/\bproduct:([^\s]+)/) || [])[1] || '';
    devices.push({ serial, state, model, product });
  }
  const d = { adb, devices, error: null };
  devCache = { at: Date.now(), data: d };
  return d;
}

/** 在有设备时补齐型号与系统版本（页面用）。带 10 秒缓存 */
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

/** 有可用设备就返回它的 serial，没有返回 null */
async function firstUsableSerial(explicit) {
  const d = await listDevices();
  const usable = d.devices.filter((x) => x.state === 'device');
  if (!usable.length) return { serial: null, list: d };
  const target = explicit || usable[0].serial;
  if (!usable.some((x) => x.serial === target)) return { serial: null, list: d, missing: target };
  return { serial: target, list: d };
}

/* ───────────────────────── 会话 ───────────────────────── */

async function sessionState() {
  const st = await readState();
  if (!st.pid) return { running: false };
  if (!alive(st.pid)) {
    await writeState({});
    return { running: false, lastPreset: st.preset || null, endedAt: st.startedAt || null };
  }
  const cmd = await cmdlineOf(st.pid);
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
    profile: st.profile || null,
    cmd,
  };
}

/* ───────────────────────── 启动 / 停止 ───────────────────────── */

async function startCast(opts = {}) {
  const chosen = opts.preset || CFG.preset || 'default';
  if (!(PRESETS.some((p) => p.arg === chosen) || chosen === '录')) {
    return { ok: false, message: `未知预设 ${chosen}` };
  }

  const cur = await sessionState();
  if (cur.running) return { ok: false, message: '已经在投屏了，先停掉再换预设', session: cur };

  if (!fs.existsSync(CAST_BIN)) return { ok: false, message: `找不到投屏脚本：${CAST_BIN}` };
  if (!fs.existsSync(SCRCPY)) return { ok: false, message: `找不到 scrcpy：${SCRCPY}` };

  const picked = await firstUsableSerial(opts.serial);
  if (!picked.serial) {
    const d = picked.list;
    if (!d.adb) return { ok: false, message: '找不到 adb（也没在 scrcpy 包里找到）' };
    if (!d.devices.length) return { ok: false, message: '没有设备。插 USB → 手机上点「允许 USB 调试」' };
    if (picked.missing) return { ok: false, message: `设备 ${picked.missing} 不在可用列表里` };
    const first = d.devices[0];
    return { ok: false, message: `设备 ${first.serial} 状态是 ${first.state}，请在手机上确认授权` };
  }
  const target = picked.serial;

  // 组装追加参数：配置打底 → 质量档 → 开关 → 页面输入
  const extra = [];
  extra.push(...splitArgs(CFG.extraArgs));
  const prof = PROFILES.find((p) => p.arg === (opts.profile || CFG.profile));
  if (prof) extra.push('-b', prof.bitrate, '--max-fps', String(prof.fps));
  if (opts.alwaysOnTop ?? CFG.alwaysOnTop) extra.push('--always-on-top');
  if (opts.noAudio ?? CFG.noAudio) extra.push('--no-audio');
  if (opts.title) extra.push('--window-title', String(opts.title));
  extra.push(...splitArgs(opts.extra));

  // 用户填/配置里的这些选项，先确认这个 scrcpy 认不认，别等它秒退再翻日志
  const optc = await checkArgOptions(extra);
  if (!optc.ok) {
    const msg = `这个 scrcpy 版本不支持：${optc.missing.join(' ')}`;
    await noteError(msg, '把输入的额外参数里这几个去掉再试。');
    return { ok: false, message: msg };
  }

  try {
    await fsp.mkdir(path.dirname(LOG_FILE), { recursive: true });
    await rotateLog();
    const fd = fs.openSync(LOG_FILE, 'a');
    fs.writeSync(fd, `\n=== ${new Date().toISOString()} start ${chosen} ${target} ===\n`);
    const child = spawn('/bin/bash', [CAST_BIN, chosen, ...extra], {
      cwd: path.dirname(CAST_BIN),
      detached: true,
      stdio: ['ignore', fd, fd],
      env: Object.assign({}, process.env, {
        MELD_DEVICE: target,
        SCRCPY_SERVER_PATH: SCRCPY_SERVER,
      }),
    });
    child.unref();
    fs.closeSync(fd);

    const st = {
      pid: child.pid,
      preset: chosen,
      serial: target,
      profile: prof ? prof.arg : null,
      extra: extra.join(' '),
      startedAt: Date.now(),
    };
    await writeState(st);

    // 关键：scrcpy 可能因为参数/服务端版本/授权问题秒退。
    // 等一小会儿再看，退了就把日志尾巴一起带回去，别让页面报「已启动」却什么都没有。
    await new Promise((r) => setTimeout(r, 900));
    if (!alive(child.pid)) {
      await writeState({});
      const tail = (await tailLog(12)).join('\n');
      const msg = '窗口没能起来（进程已退出）';
      await noteError(msg, tail);
      return { ok: false, message: msg, detail: tail, session: null };
    }
    await clearError();
    return { ok: true, message: `已启动「${chosen}」→ ${target}`, session: st };
  } catch (e) {
    await noteError('启动失败', String(e && e.message || e));
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
  const picked = await firstUsableSerial(serial);
  if (!picked.serial) return { ok: false, message: '没有可用设备' };

  const stamp = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = `scrcpy-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-` +
    `${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.mp4`;
  const out = path.join(expandHome(CFG.recordDir) || path.join(HOME, 'Movies'), name);

  try {
    await fsp.mkdir(path.dirname(LOG_FILE), { recursive: true });
    await rotateLog();
    const fd = fs.openSync(LOG_FILE, 'a');
    fs.writeSync(fd, `\n=== ${new Date().toISOString()} record ${picked.serial} ===\n`);
    const child = spawn('/bin/bash', [CAST_BIN, '录', out], {
      cwd: path.dirname(CAST_BIN),
      detached: true,
      stdio: ['ignore', fd, fd],
      env: Object.assign({}, process.env, {
        MELD_DEVICE: picked.serial,
        SCRCPY_SERVER_PATH: SCRCPY_SERVER,
      }),
    });
    child.unref();
    fs.closeSync(fd);
    await writeState({ pid: child.pid, preset: 'pro', serial: picked.serial, record: out, startedAt: Date.now() });

    await new Promise((r) => setTimeout(r, 900));
    if (!alive(child.pid)) {
      await writeState({});
      return { ok: false, message: '录制没能起来', detail: (await tailLog(12)).join('\n') };
    }
    return { ok: true, message: `录制中 → ${out}`, file: out };
  } catch (e) {
    return { ok: false, message: `录制启动失败：${e && e.message}` };
  }
}

/* ───────────────────────── 遥控 ───────────────────────── */

async function sendKey(key, serial) {
  const k = KEYS[key];
  if (!k) return { ok: false, message: `不认识的键：${key}` };
  const picked = await firstUsableSerial(serial);
  if (!picked.serial) return { ok: false, message: '没有可用设备' };
  const adb = findAdb();
  const r = await run(adb, ['-s', picked.serial, 'shell', 'input', 'keyevent', String(k.code)], 10000);
  return r.ok
    ? { ok: true, message: `已发送 ${k.label}` }
    : { ok: false, message: `${k.label} 发送失败：${r.err.trim() || '未知错误'}` };
}

/** 旋转：关掉自动旋转再设角度，不然会被系统改回去 */
async function rotateScreen(deg, serial) {
  const picked = await firstUsableSerial(serial);
  if (!picked.serial) return { ok: false, message: '没有可用设备' };
  const adb = findAdb();
  const idx = { 0: 0, 90: 1, 180: 2, 270: 3 }[Number(deg)] ?? 0;
  await run(adb, ['-s', picked.serial, 'shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0']);
  const r = await run(adb, ['-s', picked.serial, 'shell', 'settings', 'put', 'system', 'user_rotation', String(idx)]);
  return r.ok ? { ok: true, message: `已转到 ${deg}°` } : { ok: false, message: '旋转失败' };
}

/* ───────────────────────── 音量 ───────────────────────── */

/**
 * 媒体音量（stream 3）。
 * 优先用 `cmd media_session volume`（Android 10+ 都有），
 * 取不到就退回 settings 里的 volume_music_speaker/sys。
 */
async function getVolume(serial) {
  const picked = await firstUsableSerial(serial);
  if (!picked.serial) return { ok: false, message: '没有可用设备' };
  const adb = findAdb();
  const target = picked.serial;

  const m = await run(adb, ['-s', target, 'shell', 'cmd', 'media_session', 'volume', '--stream', '3', '--get']);
  const mv = (m.out.match(/-?\d+/) || []);
  if (m.ok && mv.length) {
    const max = await run(adb, ['-s', target, 'shell', 'cmd', 'media_session', 'volume', '--stream', '3', '--get-max']);
    const mx = (max.out.match(/(\d+)/) || []);
    return { ok: true, stream: 3, value: Number(mv[0]), max: mx[1] ? Number(mx[1]) : null, source: 'media_session' };
  }
  for (const key of ['volume_music_speaker', 'volume_music_sys']) {
    const s = await run(adb, ['-s', target, 'shell', 'settings', 'get', 'system', key]);
    const v = (s.out.match(/\d+/) || []);
    if (s.ok && v.length) return { ok: true, stream: 3, value: Number(v[0]), max: null, source: key };
  }
  return { ok: false, message: '读不到媒体音量' };
}

async function setVolume(value, serial) {
  const v = Math.max(0, Math.min(Number(value) || 0, 100));
  const picked = await firstUsableSerial(serial);
  if (!picked.serial) return { ok: false, message: '没有可用设备' };
  const adb = findAdb();
  const r = await run(adb, ['-s', picked.serial, 'shell', 'cmd', 'media_session', 'volume', '--stream', '3', '--set', String(v)]);
  if (r.ok) return { ok: true, message: `音量已设为 ${v}`, value: v };
  // 老系统退回键事件（每档 ±1，不精确但能用）
  return { ok: false, message: '这个系统不支持直接设音量，用遥控条的 ± 吧' };
}

/* ───────────────────────── 截图 ───────────────────────── */

async function takeShot({ serial = '' } = {}) {
  const picked = await firstUsableSerial(serial);
  if (!picked.serial) return { ok: false, message: '没有可用设备' };
  const adb = findAdb();
  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date();
  const name = `cast-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;
  const out = path.join(SHOT_DIR, name);

  try {
    await fsp.mkdir(SHOT_DIR, { recursive: true });
    // 直接落盘：screencap 的 PNG 可能好几 MB，不能走 execFile 的字符串返回
    const ok = await new Promise((resolve) => {
      const child = spawn(adb, ['-s', picked.serial, 'exec-out', 'screencap', '-p'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const chunks = [];
      let err = '';
      child.stdout.on('data', (c) => chunks.push(c));
      child.stderr.on('data', (c) => { err += String(c); });
      child.on('error', () => resolve(false));
      child.on('close', async (code) => {
        if (code !== 0 || !chunks.length) return resolve(false);
        const buf = Buffer.concat(chunks);
        // Windows 换行污染的老问题：PNG 头必须正好是 0x89504E47
        if (!(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)) {
          const fixed = Buffer.from(buf.toString('binary').replace(/\r\n/g, '\n'), 'binary');
          try { await fsp.writeFile(out, fixed); return resolve(true); } catch { return resolve(false); }
        }
        try { await fsp.writeFile(out, buf); resolve(true); } catch { resolve(false); }
      });
      setTimeout(() => { try { child.kill('KILL'); } catch {} resolve(false); }, 12000);
    });
    if (!ok) return { ok: false, message: '截图失败（screencap 没返回图）' };
    const st = await fsp.stat(out);
    return { ok: true, message: `已截图 ${name}`, name, bytes: st.size, url: `/api/cast/shot?name=${encodeURIComponent(name)}` };
  } catch (e) {
    return { ok: false, message: `截图失败：${e && e.message}` };
  }
}

async function listShots(limit = 12) {
  try {
    const files = await fsp.readdir(SHOT_DIR);
    const pngs = files.filter((f) => /\.png$/i.test(f)).sort().reverse().slice(0, Math.max(1, Math.min(limit, 60)));
    const out = [];
    for (const name of pngs) {
      let size = 0;
      try { size = (await fsp.stat(path.join(SHOT_DIR, name))).size; } catch {}
      out.push({ name, bytes: size, url: `/api/cast/shot?name=${encodeURIComponent(name)}` });
    }
    return out;
  } catch {
    return [];
  }
}

/* ───────────────────────── 体检 ───────────────────────── */

async function doctor() {
  const d = await listDevices(true);
  const checks = [];
  checks.push({
    name: 'adb',
    ok: !!d.adb,
    detail: d.adb || '没找到（scrcpy 包里也没有）',
  });
  checks.push({
    name: 'scrcpy',
    ok: fs.existsSync(SCRCPY),
    detail: SCRCPY,
  });
  checks.push({
    name: 'scrcpy-server',
    ok: fs.existsSync(SCRCPY_SERVER),
    detail: SCRCPY_SERVER,
  });
  checks.push({
    name: '投屏脚本',
    ok: fs.existsSync(CAST_BIN),
    detail: CAST_BIN,
  });
  const usable = d.devices.filter((x) => x.state === 'device');
  checks.push({
    name: '设备',
    ok: usable.length > 0,
    detail: usable.length
      ? usable.map((x) => `${x.model || x.serial}（${x.serial}）`).join('、')
      : (d.devices.length ? '检测到但未授权：' + d.devices.map((x) => `${x.serial} ${x.state}`).join('、') : '一个都没有'),
  });

  // 这一版 scrcpy 到底支不支持我们这些选项
  const h = await scrcpyHelp();
  if (h.ok && h.text) {
    const probe = ['--no-audio', '--always-on-top', '--turn-screen-off', '--max-fps', '--window-title', '--render-fit'];
    const missing = probe.filter((n) => !h.text.includes(n));
    checks.push({
      name: '选项支持',
      ok: missing.length === 0,
      detail: missing.length ? '不支持：' + missing.join(' ') : '关键选项都在',
    });
  } else {
    checks.push({ name: '选项支持', ok: true, detail: '拿不到 --help，跳过' });
  }
  // 真写一次，别只看目录存在
  let logOk = false;
  let logDetail = path.dirname(LOG_FILE);
  try {
    await fsp.mkdir(path.dirname(LOG_FILE), { recursive: true });
    const probe = path.join(path.dirname(LOG_FILE), '.cast-write-probe');
    await fsp.writeFile(probe, 'ok');
    await fsp.unlink(probe);
    logOk = true;
    logDetail = 'runtime/ 可写';
  } catch (e) {
    logDetail = '写不进去：' + (e && e.message);
  }
  checks.push({ name: '日志可写', ok: logOk, detail: logDetail });
  const bad = checks.filter((c) => !c.ok);
  return {
    ok: bad.length === 0,
    checks,
    summary: bad.length ? `有 ${bad.length} 项不对：${bad.map((b) => b.name).join('、')}` : '都齐了，插上手机就能投',
  };
}

/* ───────────────────────── 路由 ───────────────────────── */

const okJson = (ctx, obj, code = 200) => ctx.json(code, Object.assign({ ok: true }, obj));
const errJson = (ctx, message, code = 400, extra) => ctx.json(code, Object.assign({ ok: false, message }, extra || {}));

async function handleState(ctx) {
  const [d, s, raw] = await Promise.all([listDevices(), sessionState(), readState()]);
  const detail = d.devices.find((x) => x.state === 'device');
  const info = detail ? await deviceDetail(detail.serial) : null;
  return {
    platform: process.platform,
    toolchain: {
      castScript: fs.existsSync(CAST_BIN),
      scrcpy: fs.existsSync(SCRCPY),
      server: fs.existsSync(SCRCPY_SERVER),
      adb: d.adb,
    },
    devices: d.devices,
    device: info ? Object.assign({ serial: detail.serial }, info) : null,
    error: d.error,
    session: s,
    lastError: raw.lastError || null,
    presets: PRESETS,
    profiles: PROFILES,
    keys: Object.keys(KEYS).map((k) => ({ key: k, label: KEYS[k].label })),
    config: { preset: CFG.preset, profile: CFG.profile, alwaysOnTop: CFG.alwaysOnTop, noAudio: CFG.noAudio },
  };
}

export async function handle(ctx) {
  const p = ctx.p;

  if (p === '/api/cast/state') {
    okJson(ctx, await handleState(ctx));
    return true;
  }

  if (p === '/api/cast/devices') {
    const d = await listDevices();
    okJson(ctx, { devices: d.devices, error: d.error, adb: d.adb });
    return true;
  }

  if (p === '/api/cast/presets') {
    okJson(ctx, { presets: PRESETS, profiles: PROFILES });
    return true;
  }

  if (p === '/api/cast/log') {
    okJson(ctx, {
      lines: await tailLog(
        Number(ctx.query.get('lines') || 120),
        String(ctx.query.get('filter') || ''),
      ),
    });
    return true;
  }

  if (p === '/api/cast/start' && ctx.method === 'POST') {
    const b = await ctx.body();
    const r = await startCast({
      preset: b.preset,
      serial: b.serial,
      extra: b.extra,
      profile: b.profile,
      alwaysOnTop: b.alwaysOnTop,
      noAudio: b.noAudio,
      title: b.title,
    });
    ctx.json(r.ok ? 200 : 409, r);
    return true;
  }

  if (p === '/api/cast/stop' && ctx.method === 'POST') {
    okJson(ctx, await stopCast());
    return true;
  }

  if (p === '/api/cast/record' && ctx.method === 'POST') {
    const b = await ctx.body();
    const r = await recordCast({ serial: b.serial });
    ctx.json(r.ok ? 200 : 409, r);
    return true;
  }

  if (p === '/api/cast/key' && ctx.method === 'POST') {
    const b = await ctx.body();
    const r = await sendKey(b.key, b.serial);
    ctx.json(r.ok ? 200 : 409, r);
    return true;
  }

  if (p === '/api/cast/rotate' && ctx.method === 'POST') {
    const b = await ctx.body();
    const r = await rotateScreen(b.deg, b.serial);
    ctx.json(r.ok ? 200 : 409, r);
    return true;
  }

  if (p === '/api/cast/shot' && ctx.method === 'POST') {
    const b = await ctx.body();
    const r = await takeShot({ serial: b.serial });
    ctx.json(r.ok ? 200 : 409, r);
    return true;
  }

  if (p === '/api/cast/shot' && ctx.method === 'GET') {
    const name = String(ctx.query.get('name') || '');
    if (!/^cast-[\w.-]+\.png$/.test(name)) {
      errJson(ctx, '文件名不合法', 400);
      return true;
    }
    const abs = path.join(SHOT_DIR, name);
    if (!fs.existsSync(abs)) {
      errJson(ctx, '截图不见了', 404);
      return true;
    }
    await ctx.file(abs);
    return true;
  }

  if (p === '/api/cast/shots') {
    okJson(ctx, { shots: await listShots(Number(ctx.query.get('limit') || 12)) });
    return true;
  }

  if (p === '/api/cast/doctor') {
    okJson(ctx, await doctor());
    return true;
  }

  if (p === '/api/cast/volume' && ctx.method === 'GET') {
    const r = await getVolume(String(ctx.query.get('serial') || ''));
    ctx.json(r.ok ? 200 : 409, r);
    return true;
  }

  if (p === '/api/cast/volume' && ctx.method === 'POST') {
    const b = await ctx.body();
    const r = await setVolume(b.value, b.serial);
    ctx.json(r.ok ? 200 : 409, r);
    return true;
  }

  if (p === '/api/cast/reconnect' && ctx.method === 'POST') {
    const adb = findAdb();
    if (!adb) { errJson(ctx, '找不到 adb'); return true; }
    await run(adb, ['kill-server']);
    await new Promise((r) => setTimeout(r, 400));
    const r = await run(adb, ['start-server']);
    devCache = { at: 0, data: null };
    const d = await listDevices(true);
    okJson(ctx, {
      message: d.devices.length ? `已重连，发现 ${d.devices.length} 台` : '已重启 adb，但还没发现设备',
      devices: d.devices,
      detail: r.err.trim() || null,
    });
    return true;
  }

  // 房间下的页面子路径
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
  // 启动时清掉死掉会话的残留状态，否则首页会显示一直在投屏
  const st = await readState();
  if (st.pid && !alive(st.pid)) await writeState({});
  try { await fsp.mkdir(SHOT_DIR, { recursive: true }); } catch {}
  await rotateLog();
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
      line: s.running ? `投屏中 · ${s.preset || '默认'}` : (usable ? `已连接 ${usable} 台` : '未连接'),
      tone: s.running ? 'busy' : (usable ? 'ready' : 'idle'),
    };
  } catch {
    return { connected: 0, running: false, line: '读不到状态', tone: 'idle' };
  }
}
