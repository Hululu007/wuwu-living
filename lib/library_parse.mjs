/**
 * 媒体库 · 文件名解析
 *
 * 从本地文件名里拆出：片名、年份、季、集。
 * 纯函数，不碰文件系统；解析不出就如实留空，不编造。
 */

/** 常见压制/画质/字幕噪音词，从片名里剥掉 */
const NOISE = [
  '预告片', '预告', '先行版', '花絮', '正片', '高清', '蓝光', '超清', '原盘',
  '1080p', '1080P', '720p', '720P', '4K', '2160p', '2160P', 'HD', 'BD', 'WEB-DL',
  '中英字幕', '中文字幕', '国语', '粤语', '原声', '内嵌字幕', '无字幕',
  'AAC', 'x264', 'x265', 'H264', 'H265', 'HEVC', 'AVC', 'DTS', '杜比',
];

/** 从文件名（去扩展名）里拆年份 */
function parseYear(stem) {
  const m = /(19\d{2}|20\d{2})/.exec(stem);
  return m ? Number(m[1]) : null;
}

/** 拆季集：S01E03 / s1e3 / 第3集 / EP03 / E03 / Season 1 Episode 3 */
function parseSeasonEpisode(stem) {
  let season = null;
  let episode = null;

  let m = /[Ss](\d{1,2})\s*[EePp](\d{1,3})/.exec(stem);
  if (m) { season = Number(m[1]); episode = Number(m[2]); }

  if (!m) {
    m = /Season\s*(\d{1,2})/i.exec(stem);
    if (m) season = Number(m[1]);
  }
  if (!m) {
    m = /Episode\s*(\d{1,3})/i.exec(stem);
    if (m) episode = Number(m[1]);
  }
  if (!m) {
    m = /EP\s*(\d{1,3})/i.exec(stem);
    if (m) episode = Number(m[1]);
  }
  if (!m) {
    m = /第\s*(\d{1,3})\s*集/.exec(stem);
    if (m) episode = Number(m[1]);
  }
  if (!m) {
    m = /[EePp](\d{1,3})/.exec(stem);
    if (m) episode = Number(m[1]);
  }
  // 有集号没季号，默认第一季，保证同剧归到一组
  if (episode != null && season == null) season = 1;
  return { season, episode };
}

/** 剥掉括号、季集、年份、噪音词，得到干净片名 */
function cleanTitle(stem) {
  let s = stem;
  // 去掉方括号/圆括号/花括号整段
  s = s.replace(/[\[\(（][^\[\]（）()]*[\]\)）]/g, ' ');
  // 去季集、年份标记
  s = s.replace(/[Ss]\d{1,2}\s*[EePp]\d{1,3}/gi, ' ');
  s = s.replace(/Season\s*\d{1,2}/gi, ' ');
  s = s.replace(/Episode\s*\d{1,3}/gi, ' ');
  s = s.replace(/第\s*\d{1,3}\s*集/g, ' ');
  s = s.replace(/EP\s*\d{1,3}/gi, ' ');
  s = s.replace(/[EePp]\d{1,3}/g, ' ');
  s = s.replace(/(19|20)\d{2}/g, ' ');
  // 噪音词
  for (const w of NOISE) {
    s = s.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
  }
  // 分隔符归一
  s = s.replace(/[._\[\]()（）{}【】]/g, ' ').replace(/\s+/g, ' ').trim();
  return s;
}

/** 片名里的中文片段与外文片段，分别作为刮削查询词 */
export function queryParts(title) {
  const cjk = (title.match(/[\u3400-\u9fff\uf900-\ufaff]+/g) || []).join('');
  const latin = (title.match(/[A-Za-z0-9][A-Za-z0-9'’\-.& ]*/g) || []).join(' ').trim();
  const out = [];
  if (cjk) out.push(cjk);
  if (latin) out.push(latin);
  if (!out.length) out.push(title);
  return [...new Set(out)].slice(0, 3);
}

/** 分组键：优先中文片名，没有再用外文；小写去空格 + 季（同剧同季归一组） */
function groupKey(title, season) {
  const cjk = (title.match(/[\u3400-\u9fff]+/g) || []).join('');
  const latin = (title.match(/[A-Za-z0-9]+/g) || []).join('').toLowerCase();
  const base = (cjk || latin || title.toLowerCase()).toLowerCase();
  return `${base}__${season ?? 0}`;
}

/** 文件名解析主入口 */
export function parseFileName(filename) {
  const stem = filename.replace(/\.[^.]+$/, '');
  const year = parseYear(stem);
  const { season, episode } = parseSeasonEpisode(stem);
  const title = cleanTitle(stem) || stem;
  return {
    title,
    year,
    season,
    episode,
    queries: queryParts(title),
    key: groupKey(title, season),
    isEpisode: episode != null,
  };
}

/** 字节数 → 可读 */
export function fmtSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/** 秒 → mm:ss / hh:mm:ss */
export function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, '0');
  const rr = String(r).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${rr}` : `${m}:${rr}`;
}
