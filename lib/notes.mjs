/**
 * 笔记库 —— 把看书划线、视频随手记、下载随想收进一份本地知识库
 *
 * 数据：runtime/notes.json（纯 JSON，重启不丢；读坏当空数据继续跑）
 * 检索：中文按二元组切分、英文按词切分，标题/标签/来源/正文加权打分
 * 导出：GET /api/notes/export?ids=... 或 ?tag=... 或 ?source=... 或 ?q=... 直接下载 .md
 *
 * 任何其它房间都能往这里投笔记，两种来源写法都认：
 *   POST /api/notes/create { title, body, tags, quote,
 *                            sourceKind, sourceLabel, sourceUrl }
 *   POST /api/notes/create { title, body, tags, quote,
 *                            source: { kind, label, url } }
 */
import path from 'node:path';
import { writeJson, readJsonFile } from './json_store.mjs';
import { fileURLToPath } from 'node:url';
import { runtimePath } from './runtime_dir.mjs';

export const meta = { id: 'notes', name: '笔记库', color: '#C0B79C' };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = runtimePath(ROOT, 'notes.json');

const KINDS = {
  book: '看书',
  video: '看片',
  download: '下载',
  music: '听歌',
  photo: '相册',
  manual: '随手记',
};

let cache = null; // { notes: [] }

async function load() {
  if (cache) return cache;
  // 读坏时 readJsonFile 会先把原文备份成 notes.json.corrupt-<时间戳>，
  // 否则接下来的第一次写就会用空表把坏文件覆盖掉（实测会丢光原有笔记）。
  const d = await readJsonFile(DATA_FILE);
  cache = { notes: Array.isArray(d && d.notes) ? d.notes : [] };
  return cache;
}

/**
 * 落盘。旧实现把写入丢进 200ms 的 setTimeout 后立刻返回，于是：
 *   - 接口已经回 200，进程被 kill 时这批改动整批丢失；
 *   - 测试/脚本 await 完 handle() 立刻读盘，读到的还是旧内容。
 * 现在 await save() 就到磁盘（同路径写由 json_store 串行化，不会互相踩 .tmp）。
 */
async function save() {
  if (!cache) return;
  try {
    await writeJson(DATA_FILE, { notes: cache.notes, updatedAt: Date.now() });
  } catch (e) {
    console.error('[notes] 落盘失败:', e && e.message);
  }
}

/* ───────────────────────── 检索 ───────────────────────── */

/** 中文二元组 + 英文数字词，够用且不引依赖 */
function tokens(text) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  const words = s.match(/[a-z0-9]{2,}/g) || [];
  for (const w of words) out.add(w);
  const cjk = s.replace(/[^\u3400-\u9fff\uf900-\ufaff]+/g, ' ');
  for (const seg of cjk.split(' ')) {
    if (!seg) continue;
    if (seg.length === 1) { out.add(seg); continue; }
    for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2));
    if (seg.length <= 8) out.add(seg);
  }
  return [...out];
}

function scoreOf(note, qTokens) {
  if (!qTokens.length) return 0;
  const title = String(note.title || '').toLowerCase();
  const body = String(note.body || '').toLowerCase() + ' ' + String(note.quote || '').toLowerCase();
  const tags = (note.tags || []).join(' ').toLowerCase();
  const src = String((note.source && note.source.label) || '').toLowerCase();
  let score = 0;
  for (const t of qTokens) {
    if (title.includes(t)) score += 6;
    if (tags.includes(t)) score += 4;
    if (src.includes(t)) score += 2;
    if (body.includes(t)) score += 2;
  }
  // 整串命中再加一笔，短查询不至于散掉
  const whole = qTokens.join('');
  if (whole && (title.includes(whole) || body.includes(whole))) score += 8;
  return score;
}

/* ───────────────────────── 工具 ───────────────────────── */

const uid = () => 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function normalizeTags(t) {
  if (!t) return [];
  const arr = Array.isArray(t) ? t : String(t).split(/[,，#\s]+/);
  return [...new Set(arr.map((x) => String(x).trim().replace(/^#/, '')).filter(Boolean))].slice(0, 8);
}

function excerpt(note, n = 90) {
  const t = String(note.body || note.quote || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function normalizeSource(b, fallbackKind) {
  const flatKind = b.sourceKind && KINDS[b.sourceKind] ? b.sourceKind : '';
  const nested = (b.source && typeof b.source === 'object') ? b.source : null;
  const kind = KINDS[flatKind] ? flatKind : (nested && KINDS[nested.kind] ? nested.kind : fallbackKind || 'manual');
  const label = String((nested && nested.label) || b.sourceLabel || KINDS[kind] || '随手记').slice(0, 80);
  const url = String((nested && nested.url) || b.sourceUrl || '').slice(0, 500);
  return { kind, label, url };
}

function publicNote(n) {
  return {
    id: n.id,
    title: n.title,
    body: n.body || '',
    quote: n.quote || '',
    tags: n.tags || [],
    source: n.source || { kind: 'manual', label: '随手记', url: '' },
    kindName: KINDS[(n.source && n.source.kind) || 'manual'] || '随手记',
    excerpt: excerpt(n),
    chars: String(n.body || n.quote || '').length,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    pinned: !!n.pinned,
  };
}

/** 置顶优先，其次更新时间倒序 */
const sortByTime = (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0);

/* ───────────────────────── 路由 ───────────────────────── */

const json = (ctx, code, obj) => ctx.json(code, obj);

export async function handle(ctx) {
  const st = await load();
  const p = ctx.p;

  if (p === '/api/notes/list' && ctx.method === 'GET') {
    const q = (ctx.query.get('q') || '').trim();
    const kind = (ctx.query.get('source') || '').trim();
    const tag = (ctx.query.get('tag') || '').trim();
    const sort = (ctx.query.get('sort') || '').trim(); // rel | time
    // 旧写法 Math.min(NaN, 500) = NaN，会让 shown 变 null、items 变空
    const rawLimit = Number(ctx.query.get('limit'));
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : 200;

    let list = st.notes.slice();
    if (kind) list = list.filter((n) => (n.source && n.source.kind) === kind);
    if (tag) list = list.filter((n) => (n.tags || []).includes(tag));

    const useRel = q && sort !== 'time';
    let scored = list;
    if (q) {
      const qt = tokens(q);
      scored = list
        .map((n) => ({ n, s: scoreOf(n, qt) }))
        .filter((x) => x.s > 0);
      if (useRel) {
        scored = scored.sort((a, b) => b.s - a.s || (b.n.updatedAt || 0) - (a.n.updatedAt || 0));
      } else {
        scored = scored.sort((a, b) => sortByTime(a.n, b.n));
      }
      scored = scored.map((x) => x.n);
    } else {
      scored = list.sort(sortByTime);
    }

    const tagCount = new Map();
    for (const n of st.notes) for (const t of n.tags || []) tagCount.set(t, (tagCount.get(t) || 0) + 1);

    return json(ctx, 200, {
      ok: true,
      total: st.notes.length,
      shown: Math.min(scored.length, limit),
      items: scored.slice(0, limit).map(publicNote),
      tags: [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([name, count]) => ({ name, count })),
      kinds: Object.entries(KINDS).map(([k, v]) => ({
        kind: k,
        name: v,
        count: st.notes.filter((n) => (n.source && n.source.kind) === k).length,
      })),
      query: q,
      sort: useRel ? 'rel' : 'time',
    });
  }

  if (p === '/api/notes/create' && ctx.method === 'POST') {
    const b = await ctx.body();
    const text = String(b.body || b.quote || '').trim();
    if (!text && !String(b.title || '').trim()) {
      return json(ctx, 400, { ok: false, message: '写点什么再存吧' });
    }
    const now = Date.now();
    const note = {
      id: uid(),
      title: String(b.title || '').trim().slice(0, 120) || excerpt({ body: text }, 24),
      body: String(b.body || '').slice(0, 20000),
      quote: String(b.quote || '').slice(0, 4000),
      tags: normalizeTags(b.tags),
      source: normalizeSource(b, 'manual'),
      createdAt: now,
      updatedAt: now,
    };
    st.notes.unshift(note);
    await save();
    return json(ctx, 200, { ok: true, note: publicNote(note) });
  }

  if (p === '/api/notes/update' && ctx.method === 'POST') {
    const b = await ctx.body();
    const note = st.notes.find((n) => n.id === b.id);
    if (!note) return json(ctx, 404, { ok: false, message: '没有这条笔记' });
    if (b.title != null) note.title = String(b.title).slice(0, 120);
    if (b.body != null) note.body = String(b.body).slice(0, 20000);
    if (b.quote != null) note.quote = String(b.quote).slice(0, 4000);
    if (b.tags != null) note.tags = normalizeTags(b.tags);
    if (b.pinned != null) note.pinned = !!b.pinned;
    if (b.sourceKind != null || b.sourceLabel != null || b.sourceUrl != null || (b.source && typeof b.source === 'object')) {
      note.source = normalizeSource(b, (note.source && note.source.kind) || 'manual');
    }
    note.updatedAt = Date.now();
    await save();
    return json(ctx, 200, { ok: true, note: publicNote(note) });
  }

  if (p === '/api/notes/delete' && ctx.method === 'POST') {
    const b = await ctx.body();
    const before = st.notes.length;
    st.notes = st.notes.filter((n) => n.id !== b.id);
    await save();
    return json(ctx, 200, { ok: true, removed: before - st.notes.length });
  }

  if (p === '/api/notes/tag/rename' && ctx.method === 'POST') {
    const b = await ctx.body();
    const from = String(b.from || '').trim().replace(/^#/, '');
    const to = String(b.to || '').trim().replace(/^#/, '');
    if (!from) return json(ctx, 400, { ok: false, message: '旧标签名不能为空' });
    if (!to) return json(ctx, 400, { ok: false, message: '新标签名不能为空' });
    if (from === to) return json(ctx, 200, { ok: true, affected: 0, message: '两个标签一样' });

    let affected = 0;
    for (const n of st.notes) {
      if (!(n.tags || []).includes(from)) continue;
      const next = [];
      for (const t of n.tags) {
        const v = t === from ? to : t;
        if (!next.includes(v)) next.push(v);
      }
      n.tags = next.slice(0, 8);
      affected += 1;
    }
    await save();
    return json(ctx, 200, { ok: true, affected, from, to });
  }

  if (p === '/api/notes/stats' && ctx.method === 'GET') {
    const chars = st.notes.reduce((s, n) => s + String(n.body || n.quote || '').length, 0);
    const tags = new Set();
    for (const n of st.notes) for (const t of n.tags || []) tags.add(t);
    const today = new Date();
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    return json(ctx, 200, {
      ok: true,
      total: st.notes.length,
      today: st.notes.filter((n) => (n.createdAt || 0) >= todayStart).length,
      chars,
      tags: tags.size,
      kinds: KINDS,
    });
  }

  if (p === '/api/notes/export') {
    const ids = (ctx.query.get('ids') || '').split(',').filter(Boolean);
    const tag = (ctx.query.get('tag') || '').trim();
    const kind = (ctx.query.get('source') || '').trim();
    const q = (ctx.query.get('q') || '').trim();
    let list = st.notes.slice().sort(sortByTime);
    if (ids.length) list = list.filter((n) => ids.includes(n.id));
    if (kind) list = list.filter((n) => (n.source && n.source.kind) === kind);
    if (tag) list = list.filter((n) => (n.tags || []).includes(tag));
    if (q) {
      const qt = tokens(q);
      list = list.filter((n) => scoreOf(n, qt) > 0);
    }
    if (!list.length) return json(ctx, 404, { ok: false, message: '没有可导出的笔记' });

    const scope = ids.length === 1 ? '单条'
      : (tag ? `标签-${tag}` : (kind ? `来源-${KINDS[kind] || kind}` : (q ? `检索-${q}` : '全部')));
    const date = new Date().toISOString().slice(0, 10);

    const lines = [`# 五五笔记 · ${scope} · 导出于 ${new Date().toLocaleString('zh-CN')}`, ''];
    if (tag) lines.push(`> 标签：${tag}`, '');
    if (kind) lines.push(`> 来源：${KINDS[kind] || kind}`, '');
    if (q) lines.push(`> 检索：${q}`, '');
    for (const n of list) {
      lines.push(`## ${n.title || '未命名'}`);
      const meta = [];
      meta.push(`来源：${(n.source && n.source.label) || '随手记'}`);
      if (n.source && n.source.url) meta.push(`链接：${n.source.url}`);
      meta.push(new Date(n.createdAt || Date.now()).toLocaleString('zh-CN'));
      lines.push(`*${meta.join(' · ')}*`, '');
      if (n.quote) lines.push(...String(n.quote).split('\n').map((l) => '> ' + l), '');
      if (n.body) lines.push(String(n.body), '');
      if ((n.tags || []).length) lines.push((n.tags || []).map((t) => '`#' + t + '`').join(' '), '');
      lines.push('---', '');
    }
    const md = lines.join('\n');
    const name = `五五笔记-${scope}-${date}.md`.replace(/[\\/:*?"<>|\s]+/g, '_');
    const body = Buffer.from(md, 'utf8');
    ctx.res.writeHead(200, {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    ctx.res.end(body);
    return undefined;
  }

  return false;
}

/** 首页/仪表盘用的小结 */
export async function summary() {
  const st = await load();
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  return {
    ready: true,
    path: '/notes/',
    total: st.notes.length,
    today: st.notes.filter((n) => (n.createdAt || 0) >= todayStart).length,
    latest: st.notes
      .slice()
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 3)
      .map((n) => ({ id: n.id, title: n.title, label: (n.source && n.source.label) || '随手记', at: n.createdAt })),
  };
}

export async function init() {
  await load();
}
