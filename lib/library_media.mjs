/**
 * 媒体库 · 本地文件扫描与探测
 *
 * 只读用户目录：只做 readdir/stat/spawn ffprobe，绝不写、移、删原始文件。
 * 目录遍历用异步 API；ffprobe 限并发，超时即放弃该文件的时长/分辨率。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const DEFAULT_EXTS = ['.mp4', '.mkv', '.mov', '.avi', '.m4v', '.ts', '.webm', '.flv', '.rmvb'];

/** ~ 展开成用户主目录 */
export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** 异步递归收集视频文件；深度封顶，跳过隐藏目录 */
export async function walkVideos(root, exts, maxDepth) {
  const out = [];
  const rootAbs = expandHome(root);
  let st;
  try { st = await fsp.stat(rootAbs); } catch { return out; }
  if (!st.isDirectory()) return out;

  async function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(abs, depth + 1);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (exts.includes(ext)) out.push(abs);
      }
    }
  }
  await walk(rootAbs, 0);
  return out;
}

/** ffprobe 取时长/宽高；失败返回空对象，不影响页面 */
export function probe(absPath, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration:stream=width,height',
        '-of', 'json',
        absPath,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { resolve({}); return; }

    let buf = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve({}); }, timeoutMs);
    child.stdout.on('data', (c) => { buf += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', () => { clearTimeout(timer); resolve({}); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const d = JSON.parse(buf);
        const dur = Number(d.format && d.format.duration);
        const stream = (d.streams || []).find((s) => s.width && s.height) || {};
        resolve({
          duration: Number.isFinite(dur) ? dur : null,
          width: stream.width || null,
          height: stream.height || null,
        });
      } catch { resolve({}); }
    });
  });
}

/** 取文件大小/修改时间；失败返回空 */
export async function statInfo(absPath) {
  try {
    const st = await fsp.stat(absPath);
    return { size: st.size, mtime: st.mtimeMs };
  } catch {
    return { size: 0, mtime: 0 };
  }
}

export { DEFAULT_EXTS };
