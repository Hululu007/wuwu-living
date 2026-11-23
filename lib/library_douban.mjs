/**
 * 媒体库 · 豆瓣刮削
 *
 * 两个免 key 接口：
 *   suggest  https://movie.douban.com/j/subject_suggest?q=<片名>
 *   abstract https://movie.douban.com/j/subject_abstract?subject_id=<id>
 * 都必须带浏览器 UA 和 Referer；海报图床同样要 Referer，否则 418。
 * 全部 6 秒超时，失败返回 null，绝不编造简介/评分。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const REFERER = 'https://movie.douban.com/';
const TIMEOUT = 6000;

async function fetchWithTimeout(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: REFERER, Accept: 'application/json,image/*' },
      signal: ac.signal,
      cache: 'no-store',
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r;
  } finally {
    clearTimeout(timer);
  }
}

/** suggest：返回原始候选数组，失败抛错由上层兜底 */
export async function suggest(query) {
  const u = new URL('https://movie.douban.com/j/subject_suggest');
  u.searchParams.set('q', query);
  const r = await fetchWithTimeout(u.href);
  const data = await r.json();
  return Array.isArray(data) ? data : [];
}

/** abstract：评分、集数、简介、类型、地区、时长 */
export async function abstract(subjectId) {
  const u = new URL('https://movie.douban.com/j/subject_abstract');
  u.searchParams.set('subject_id', String(subjectId));
  const r = await fetchWithTimeout(u.href);
  const data = await r.json();
  const s = (data && data.subject) || {};
  return {
    id: String(s.id || subjectId),
    title: s.title || '',
    year: s.release_year || '',
    rate: s.rate || '',
    episodesCount: s.episodes_count || '',
    intro: (s.short_comment && s.short_comment.content) || '',
    types: Array.isArray(s.types) ? s.types : [],
    region: s.region || '',
    duration: s.duration || '',
    isTv: !!s.is_tv,
  };
}

/** 候选打分：片名包含 + 年份一致优先 */
function scoreCandidate(c, localTitle, localYear) {
  let score = 0;
  const t = String(c.title || '').toLowerCase();
  const sub = String(c.sub_title || '').toLowerCase();
  const lt = String(localTitle || '').toLowerCase();
  if (t === lt) score += 10;
  if (t.includes(lt) || lt.includes(t)) score += 6;
  if (sub && (sub.includes(lt) || lt.includes(sub))) score += 5;
  if (localYear && String(c.year) === String(localYear)) score += 4;
  // 占位默认图的条目降权
  if (c.img && /movie_default/.test(c.img)) score -= 2;
  return score;
}

/**
 * 用一组查询词找最佳条目。
 * 返回 { id, title, year, subTitle, type, img } 或 null。
 */
export async function matchSubject(queries, localTitle, localYear) {
  for (const q of queries) {
    if (!q) continue;
    let list = [];
    try { list = await suggest(q); } catch { continue; }
    if (!list.length) continue;
    const best = list
      .map((c) => ({ c, s: scoreCandidate(c, localTitle, localYear) }))
      .sort((a, b) => b.s - a.s)[0];
    if (best && best.s > 0) {
      return {
        id: String(best.c.id || ''),
        title: best.c.title || '',
        year: best.c.year || '',
        subTitle: best.c.sub_title || '',
        type: best.c.type || '',
        img: best.c.img || '',
      };
    }
  }
  return null;
}

/** 下载海报到本地缓存目录；成功返回 true */
export async function downloadPoster(imgUrl, subjectId, postersDir) {
  if (!imgUrl || /movie_default/.test(imgUrl)) return false;
  const file = path.join(postersDir, `${subjectId}.jpg`);
  try {
    const r = await fetchWithTimeout(imgUrl);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 200) return false;
    await fsp.mkdir(postersDir, { recursive: true });
    // 读侧是「stat 成功就发这个文件」（library.mjs 的 /library/poster/<id>），
    // 所以直写被中断留下的半截图会被当成本地缓存永久发出，且不会重取。
    // 先写 pid 唯一临时名再 rename：要么没有海报（下次重取），要么是完整海报。
    const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2, 8)}.tmp`;
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** 限并发执行：items 逐个交给 fn，最多 limit 个同时跑 */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) break;
      try { out[i] = await fn(items[i], i); } catch (e) { out[i] = { error: e && e.message }; }
    }
  });
  await Promise.all(workers);
  return out;
}
