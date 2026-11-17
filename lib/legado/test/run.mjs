#!/usr/bin/env node
/**
 * Legado 内核一键测试入口。
 *
 * 两部分：
 *  A. 引擎纯函数单测：模板渲染、header 解析、编码别名、JSONPath 子集、取值器；
 *  B. ≥30 个真实书源端到端：搜索 → 详情 → 目录，断言「书名 / 作者 / 章节数」三项。
 *
 * 运行：node lib/legado/test/run.mjs
 * 报告：lib/legado/test/report.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSources, searchSource, bookInfo, chapterList, matchBookUrl } from '../index.mjs';
import { renderUrl, render } from '../template.mjs';
import { parseHeader, decodeBuffer } from '../fetch.mjs';
import { jsonPath } from '../selector.mjs';
import { evaluate } from '../values.mjs';
import { loadDoc } from '../selector.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const REPORT_PATH = path.join(ROOT, 'lib', 'legado', 'test', 'report.json');
const KEYWORD = process.env.TEST_KEYWORD || '凡人修仙传';

/** 同种子历史基线：31/41 为 header 合并回归；37/41 为中间基线；39/41 为上一轮验收基线。 */
const HISTORY = {
  regression: { total: 41, passed: 31, note: 'request() header 合并回归' },
  baseline: { total: 41, passed: 37, fail: ['云中书库', '📖笔趣网', '笔趣网吧', '🌙 番茄酱'] },
  accepted39: { total: 41, passed: 39, fail: ['云中书库', '笔趣网吧'] },
};

/* ─────────────────────  A. 引擎纯函数单测  ───────────────────── */

function runUnitTests() {
  const cases = [];
  const check = (label, actual, expected) =>
    cases.push({ label, pass: actual === expected, actual: String(actual), expected: String(expected) });

  // 模板：关键词 URL 编码、页码、简单表达式、老式占位
  check(
    '模板-key编码',
    renderUrl('/so/{{key}}.html?pageNum={{page}}', { key: '凡人 传', page: 2 }),
    '/so/%E5%87%A1%E4%BA%BA%20%E4%BC%A0.html?pageNum=2'
  );
  check('模板-算术', renderUrl('/search?q={{(page-1)*10}}', { key: 'x', page: 3 }), '/search?q=20');
  check('模板-老式占位', renderUrl('/s/<key>/', { key: 'abc', page: 1 }), '/s/abc/');

  // header：对象 / JSON 字符串 / Python 风格字符串 / cookie 合并
  const h1 = parseHeader('{"User-Agent":"UA"}', '');
  check('header-JSON-UA', h1['User-Agent'], 'UA');
  const h2 = parseHeader("{'User-Agent': 'PY', 'Referer': 'R'}", 'k=v');
  check('header-Python-UA', h2['User-Agent'], 'PY');
  check('header-Cookie合并', h2.Cookie, 'k=v');
  const h3 = parseHeader({ Cookie: 'a=1' }, 'b=2');
  check('header-对象Cookie', h3.Cookie, 'b=2; a=1');

  // 编码别名
  const gb = decodeBuffer(Buffer.from('ÀÏ'), 'text/html', 'gbk');
  check('编码-gbk别名', gb.length > 0, true);

  // JSONPath 子集
  const data = { data: [{ book_name: 'A', author: 'X' }, { book_name: 'B', author: 'Y' }] };
  check('JP-数组取值', JSON.stringify(jsonPath(data, '$.data[*].book_name')), '["A","B"]');
  check('JP-递归取值', JSON.stringify(jsonPath({ ret: { list: [{ id: 1 }, { id: 2 }] } }, '$..id')), '[1,2]');

  // 取值器：CSS 文本 / href
  const $ = loadDoc('<ul><li><a href="/b/1">书</a><span>作者甲</span></li></ul>');
  const ctx = { rootNodes: [$('html').get(0)], json: null, result: '', rt: null };
  const rt = { run: (code, cur) => cur };
  ctx.rt = rt;
  check('取值-CSS文本', evaluate('li a@text', ctx), '书');
  check('取值-CSShref', evaluate('li a@href', ctx), '/b/1');

  // bookUrlPattern 校验
  const src = { bookUrlPattern: 'https?://www\\.x\\.com/\\d+_\\d+/' };
  check('pattern-命中', matchBookUrl(src, 'https://www.x.com/0_747/'), true);
  check('pattern-未命中', matchBookUrl(src, 'https://www.y.com/'), false);

  const passed = cases.filter((c) => c.pass).length;
  return { total: cases.length, passed, passRate: cases.length ? passed / cases.length : 0, cases };
}

/* ─────────────────────  B. 真实书源端到端  ───────────────────── */

/** 优先种子（已在本机探测可解析）；URL 为书源 bookSourceUrl 前缀。 */
const SEED_URLS = [
  // —— 第一批已端到端通过的聚合站 ——
  'http://www.23uswx.la/', // 顶点小说⑤
  'http://www.yunxs.com/wy-', // 云中书库
  'http://www.77shuku.org#🎃', // 七七读书
  'http://www.biqun.cc', // 笔趣📖
  'http://www.mxjtedu.com#🎃', // 梦想家文学
  'http://www.yinyangdailiren.org#🎃', // 阴阳代理
  'https://www.laidudu.com#🎃', // 来读读破
  'http://www.23uswx.la#🎃', // 顶点小说#2
  'http://www.bqgu.cc', // 笔趣网
  'http://www.xuanyge.org#🎃', // 玄幻阁
  'http://www.cxzz.com#🎃', // 鬼吹灯#3
  'http://23.225.143.232/', // 零点看书
  'https://www.tpyyc.com#🎃', // 笔趣阁#10
  'http://www.weilaitianwang.org#🎃', // 未来天王
  'https://m.ajnnan.com#🎃', // 戊戟武侠
  'https://www.biqusk.com#🎃', // 笔趣阁#26
  'http://www.xuankuge.com#🎃', // 玄幻阁
  'http://www.mxjtedu.com', // 梦想家文学
  // —— 第二批已端到端通过的聚合站 ——
  'https://www.biquwx.la#🎃', // 笔趣阁#51
  'http://www.biquger.com/', // 笔趣阁
  'http://www.rulianshi.org/#pb', // 入殓师灵异录
  'http://www.botaodz.com#🎃', // 快眼看书#3
  'http://wujixiaoshuo.com#🎃', // 无极小说#2
  'http://www.sequge.com', // 色趣阁
  'http://www.biquw.com/#pb1101', // 笔趣网吧
  'http://www.yjxsw.com#🎃', // 永久小说网
  'https://www.sudugu.org', // 速读谷
  'https://www.iyruan.com#🎃', // 亿软网#2
  'http://www.minguoqiren.org/pb', // 民国奇人
  'http://www.xuanhuange.net#🎃', // 玄幻阁网
  'https://ubook.reader.qq.com/?g_f=4000001', // 企鹅阅读
  'http://www.xbotaodz.com#', // 快眼看书
  'http://www.tcmaoxin.cn', // 茂鑫小说
  'http://www.rulianshi.cn', // 入殓师cn
  'http://www.yetianlian.net#🎃', // 何以笙箫默
  // —— 规则类型覆盖样本（JSONPath / @js / legacy，用于暴露未覆盖项） ——
  'bbnnfgh', // QQ阅读 JSONPath
  '番茄小说-hide#HD', // 番茄酱 JSONPath+@js
  'https://b.faloo.com#♤pb', // 飞卢 legacy
  'http://www.yingsx.com#', // 影书（详情字段缺失，回落搜索结果）
  'http://www.xbiquwx.la#🎃', // 笔趣阁#11
  'http://www.ibiquzw.org#🎃', // @get 取值
];

function resolveSource(sources, url) {
  const exact = sources.find((s) => s.url === url);
  if (exact) return exact;
  const base = url.split('#')[0];
  return sources.find((s) => s.url.split('#')[0] === base) || null;
}

function failureClass(record) {
  const text = `${record.error} ${Object.values(record.stages).join(' ')}`;
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EPIPE/.test(text)) return '网络瞬时/站点不可达';
  if (/任务超时/.test(text)) return '外部慢源或重 ajax 规则';
  if (/请求超时/.test(text)) return '站点不可达或响应过慢';
  return '规则/解析缺口';
}

function ruleTags(source) {
  const blob = [source.searchUrl, JSON.stringify(source.rules)].join('\n');
  return {
    jsonPath: /^\$/.test(source.rules.search.bookList || ''),
    js: /@js:|<js>/i.test(blob),
    regex: /##/.test(blob),
  };
}

async function probeSource(source) {
  const record = {
    name: source.name,
    url: source.url,
    group: source.group,
    tags: ruleTags(source),
    searchUrl: source.searchUrl || '',
    hitCount: 0,
    firstBook: null,
    tocCount: 0,
    assertions: { name: false, author: false, tocCount: false },
    ok: false,
    ms: 0,
    error: '',
    stages: { search: '', info: '', toc: '' },
  };
  const t0 = Date.now();
  try {
    const search = await searchSource(source, KEYWORD, { timeoutMs: 8000 });
    record.stages.search = search.error || '';
    if (!search.ok) {
      record.error = search.error || '搜索失败';
      record.ms = Date.now() - t0;
      return record;
    }
    record.hitCount = search.books.length;
    const book = search.books[0];
    record.firstBook = book ? { name: book.name, author: book.author, bookUrl: book.bookUrl } : null;

    if (book) {
      const info = await bookInfo(source, book, { timeoutMs: 8000 });
      record.stages.info = info.error || '';
      // 详情产出的 tocUrl 必须并入目录入参（真实集成链路同样先详情后目录）
      const tocBook = { ...book, ...info };
      const toc = await chapterList(source, tocBook, { timeoutMs: 10000 });
      record.stages.toc = toc.error || '';
      record.tocCount = toc.chapters?.length || 0;

      record.assertions.name = Boolean(info.ok && info.name);
      record.assertions.author = Boolean(info.ok && info.author);
      record.assertions.tocCount = record.tocCount > 0;
      record.ok = record.assertions.name && record.assertions.author && record.assertions.tocCount;
    }
    record.ms = Date.now() - t0;
    return record;
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
    record.ms = Date.now() - t0;
    return record;
  }
}

async function main() {
  const unit = runUnitTests();
  const sources = await loadSources();

  // 组装待测源：种子优先，不足再从可搜池补齐到 ≥30
  const picked = [];
  const used = new Set();
  for (const url of SEED_URLS) {
    const s = resolveSource(sources, url);
    if (s && !used.has(s.url)) {
      picked.push(s);
      used.add(s.url);
    }
  }
  // 种子不足 30 时才从可搜池补齐；种子本身已覆盖四类规则
  for (const s of sources) {
    if (picked.length >= 30) break;
    if (!used.has(s.url) && s.enabled && (s.searchUrl || s.rules.search.bookList)) {
      picked.push(s);
      used.add(s.url);
    }
  }
  void used;

  const results = [];
  for (const source of picked) {
    const r = await probeSource(source);
    if (!r.ok) r.failureClass = failureClass(r);
    results.push(r);
    const mark = r.ok ? 'PASS' : 'FAIL';
    console.log(
      `[${mark}] ${source.name.slice(0, 24)} | 命中 ${r.hitCount} | 目录 ${r.tocCount} | ${r.ms}ms` +
        (r.error ? ` | ${r.error}` : '')
    );
  }

  const passed = results.filter((r) => r.ok).length;
  const byTag = { jsonPath: [], js: [], regex: [] };
  for (const r of results) {
    if (r.tags.jsonPath) byTag.jsonPath.push(r.ok);
    if (r.tags.js) byTag.js.push(r.ok);
    if (r.tags.regex) byTag.regex.push(r.ok);
  }
  const tagSummary = Object.fromEntries(
    Object.entries(byTag).map(([k, arr]) => [k, { total: arr.length, pass: arr.filter(Boolean).length }])
  );

  const currentFail = results.filter((r) => !r.ok).map((r) => r.name);
  const baselineFail = HISTORY.baseline.fail;
  const acceptedFail = HISTORY.accepted39.fail;
  const transitions = {
    fixed: baselineFail.filter((n) => !currentFail.includes(n)),
    recovered: acceptedFail.filter((n) => !currentFail.includes(n)),
    newFail: currentFail.filter((n) => !acceptedFail.includes(n)),
    persistent: acceptedFail.filter((n) => currentFail.includes(n)),
  };

  const report = {
    generatedAt: Date.now(),
    keyword: KEYWORD,
    history: HISTORY,
    engineUnit: unit,
    summary: {
      total: results.length,
      passed,
      passRate: results.length ? passed / results.length : 0,
      tagCoverage: tagSummary,
      transitions,
      newFail: transitions.newFail,
      recovered: transitions.recovered,
    },
    sources: results,
  };

  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 1), 'utf8');

  console.log('\n──────── 汇总 ────────');
  console.log(`引擎纯函数单测：${unit.passed}/${unit.total}（${(unit.passRate * 100).toFixed(1)}%）`);
  console.log(`真实书源端到端：${passed}/${results.length}（${(report.summary.passRate * 100).toFixed(1)}%）`);
  console.log('规则类型覆盖：', JSON.stringify(tagSummary));
  console.log(`报告已写入：${REPORT_PATH}`);
}

main().catch((error) => {
  console.error('测试入口异常：', error);
  process.exit(1);
});
