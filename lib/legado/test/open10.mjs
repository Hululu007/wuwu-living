#!/usr/bin/env node
/**
 * 10 个不同 host 书源的打开链路测试：搜索 → 详情 → 目录 → 正文首章。
 * 结果写入 lib/legado/test/open10.json；失败项如实保留，不换源。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSources, searchSource, bookInfo, chapterList, chapterContent } from '../index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OUT = path.join(ROOT, 'lib', 'legado', 'test', 'open10.json');
const KEYWORD = process.env.TEST_KEYWORD || '凡人修仙传';

const SEED_URLS = [
  'http://www.23uswx.la/', 'http://www.77shuku.org#🎃', 'http://www.mxjtedu.com#🎃',
  'http://www.yinyangdailiren.org#🎃', 'https://www.laidudu.com#🎃', 'http://www.xuanyge.org#🎃',
  'http://www.cxzz.com#🎃', 'http://23.225.143.232/', 'https://www.tpyyc.com#🎃',
  'https://m.ajnnan.com#🎃', 'https://www.biqusk.com#🎃', 'http://www.xuankuge.com#🎃',
  'https://www.biquwx.la#🎃', 'http://www.biquger.com/', 'http://www.botaodz.com#🎃',
  'http://wujixiaoshuo.com#🎃', 'http://www.yjxsw.com#🎃', 'https://www.iyruan.com#🎃',
  'http://www.minguoqiren.org/pb', 'http://www.xuanhuange.net#🎃',
  'https://ubook.reader.qq.com/?g_f=4000001', 'http://www.xbotaodz.com#',
  'http://www.rulianshi.cn', 'bbnnfgh', 'https://b.faloo.com#♤pb', 'http://www.yingsx.com#',
];

function resolveSource(sources, url) {
  return sources.find((s) => s.url === url) || sources.find((s) => s.url.split('#')[0] === url.split('#')[0]) || null;
}

function hostOf(source) {
  const candidate = /^https?:\/\//.test(source.searchUrl || '') ? source.searchUrl : source.url;
  try {
    return new URL(/^https?:\/\//.test(candidate) ? candidate : `http://${candidate}`).hostname;
  } catch {
    return source.url;
  }
}

async function probe(source) {
  const record = {
    name: source.name, url: source.url, host: hostOf(source),
    stages: { search: {}, info: {}, toc: {}, content: {} },
    overall: false, error: '',
  };
  let book = null;
  let info = null;
  let toc = null;

  const t0 = Date.now();
  const search = await searchSource(source, KEYWORD, { timeoutMs: 8000 });
  record.stages.search = { ok: search.ok, ms: search.ms, error: search.error || '', hitCount: search.books?.length || 0 };
  if (!search.ok || !search.books?.length) {
    record.error = search.error || '搜索无结果';
    record.ms = Date.now() - t0;
    return record;
  }
  book = search.books[0];

  info = await bookInfo(source, book, { timeoutMs: 8000 });
  record.stages.info = { ok: info.ok, ms: info.ms, error: info.error || '', name: info.name || '', author: info.author || '' };
  if (!info.ok || !info.name || !info.author) {
    record.error = info.error || '详情字段缺失';
    record.ms = Date.now() - t0;
    return record;
  }

  const tocBook = { ...book, ...info };
  toc = await chapterList(source, tocBook, { timeoutMs: 10000 });
  record.stages.toc = { ok: toc.ok, ms: toc.ms, error: toc.error || '', chapterCount: toc.chapters?.length || 0 };
  if (!toc.ok || !toc.chapters?.length) {
    record.error = toc.error || '目录为空';
    record.ms = Date.now() - t0;
    return record;
  }

  const chapter = toc.chapters[0];
  const content = await chapterContent(source, tocBook, chapter, { timeoutMs: 8000 });
  record.stages.content = {
    ok: content.ok, ms: content.ms, error: content.error || '',
    chapter: chapter.name, contentLen: content.content?.length || 0,
  };
  record.overall = content.ok && (content.content?.length || 0) > 0;
  record.error = record.overall ? '' : (content.error || '正文为空');
  record.ms = Date.now() - t0;
  return record;
}

async function main() {
  const sources = await loadSources();
  const picked = [];
  const usedHost = new Set();
  for (const url of SEED_URLS) {
    const s = resolveSource(sources, url);
    if (!s) continue;
    const host = hostOf(s);
    if (!usedHost.has(host)) {
      usedHost.add(host);
      picked.push(s);
    }
    if (picked.length >= 10) break;
  }

  const results = [];
  for (const source of picked) {
    const r = await probe(source);
    results.push(r);
    console.log(`[${r.overall ? 'PASS' : 'FAIL'}] ${source.name.slice(0, 20)} | ${r.host} | 目录 ${r.stages.toc.chapterCount || 0} | 正文 ${r.stages.content.contentLen || 0} | ${r.ms}ms`);
  }

  const passed = results.filter((r) => r.overall).length;
  const report = {
    generatedAt: Date.now(), keyword: KEYWORD,
    summary: { total: results.length, passed, passRate: results.length ? passed / results.length : 0 },
    results,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(report, null, 1), 'utf8');
  console.log(`\n10 host 打开链路：${passed}/${results.length}（${(report.summary.passRate * 100).toFixed(1)}%）`);
  console.log(`报告：${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
