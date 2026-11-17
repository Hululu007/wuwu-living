#!/usr/bin/env node
/**
 * 金标准对照器命令行入口。
 *
 * 用法：
 *   node scripts/diff-reader.mjs --base http://127.0.0.1:8890 --books 10
 *   node scripts/diff-reader.mjs --base http://127.0.0.1:8890 --keyword 诡秘之主 --books 6
 *
 * 选项：
 *   --base <url>       客厅实例地址（默认 http://127.0.0.1:8890）
 *   --reader <url>     Reader 实例地址（默认 http://127.0.0.1:1122）
 *   --books <n>        对照书本数（默认 10）
 *   --keyword <词>     单一搜书关键词（默认轮询「流浪地球/诡秘之主/剑来」）
 *   --report <path>    结构化报告路径（默认 runtime/reader-diff-report.json）
 *   --log <path>       追加日志路径（默认 runtime/reader-diff.log）
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDiff } from '../lib/reader_diff.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgv(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

const args = parseArgv(process.argv);

const opts = {
  hallBase: args.base || 'http://127.0.0.1:8890',
  readerBase: args.reader || 'http://127.0.0.1:1122',
  books: Number(args.books || 10),
  keyword: args.keyword || undefined,
};
if (args.report) opts.reportPath = path.resolve(ROOT, args.report);
if (args.log) opts.logPath = path.resolve(ROOT, args.log);

async function main() {
  const report = await runDiff(opts);
  const s = report.summary;

  console.log('=== 金标准对照结果 ===');
  console.log(`客厅实例: ${report.params.hallBase}  Reader 实例: ${report.params.readerBase}`);
  console.log(`对照书本数: ${s.total}`);
  console.log(`Reader 侧可取到: ${s.readerOk} 本；客厅侧可取到: ${s.hallOk} 本`);
  console.log(`书名一致: ${s.namePass}；作者一致: ${s.authorPass}；目录条数一致: ${s.tocPass}；正文重合≥90%: ${s.contentPass}`);
  console.log(`平均耗时: Reader ${s.avgReaderMs}ms / 客厅 ${s.avgHallMs}ms`);
  console.log(`差异/失败项合计: ${s.diffCount}`);

  if (report.diffs.length) {
    console.log('\n=== 差异清单 ===');
    for (const d of report.diffs) {
      console.log(`[${d.status}] ${d.field} | ${d.sourceName} | ${d.bookUrl} | ${d.reason}`);
    }
  }

  console.log('\n=== Reader 接口确认状态 ===');
  for (const f of report.readerEndpointFacts) {
    console.log(`${f.confirmed ? '已确认' : '未确认'} ${f.method} ${f.path} | 参数: ${f.params} | 信封: ${f.envelope}`);
  }

  console.log(`\n报告: ${opts.reportPath || path.join(ROOT, 'runtime', 'reader-diff-report.json')}`);
  console.log(`日志: ${opts.logPath || path.join(ROOT, 'runtime', 'reader-diff.log')}`);
}

main().catch((e) => {
  console.error('对照器运行失败：', (e && e.stack) || e);
  process.exit(1);
});
