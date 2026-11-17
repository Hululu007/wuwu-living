#!/usr/bin/env node
/**
 * 取值引擎：把单条 legado 规则（CSS 链 / JSONPath / @js / 正则替换 / 模板回灌）
 * 落到当前求值上下文，产出字符串。
 *
 * 求值上下文 ctx（由 index.mjs 组装）：
 *  { $, rootNodes, text, json, baseUrl, source, book, chapter, key, page, cookie, rt, result }
 */

import * as cheerio from 'cheerio';
import { chainNodes, jsonPath, isJsonPath } from './selector.mjs';
import { render } from './template.mjs';

const ACCESSORS = new Set([
  'text', 'html', 'ownText', 'href', 'src', 'textNodes', 'title', 'content',
]);

/** 拆出尾部 <js>...</js> 块。 */
function splitJsBlock(rule) {
  const m = String(rule || '').match(/<js>([\s\S]*?)<\/js>/i);
  if (!m) return { prefix: String(rule || ''), code: '' };
  const before = String(rule).slice(0, m.index);
  const after = String(rule).slice(m.index + m[0].length);
  return { prefix: before + after, code: m[1] || '' };
}

/** 正则替换段：pattern##replacement（全局替换）。 */
function applyRegex(value, suffix) {
  const text = String(value == null ? '' : value);
  if (!suffix) return collapse(text);
  const parts = String(suffix).split('##');
  const pattern = parts[0];
  const replacement = parts[1] == null ? '' : parts[1];
  if (!pattern) return collapse(text);
  try {
    return collapse(text.replace(new RegExp(pattern, 'g'), replacement));
  } catch {
    try {
      return collapse(text.replace(new RegExp(pattern), replacement));
    } catch {
      return collapse(text);
    }
  }
}

function collapse(v) {
  return String(v == null ? '' : v)
    .replace(/ /g, ' ')
    .replace(/[ \t　]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/** 节点按取值器提取文本。 */
function extractNodes(nodes, accessor) {
  if (!nodes || nodes.length === 0) return '';
  const out = [];
  for (const node of nodes) {
    const $ = cheerio.load('');
    switch (accessor) {
      case 'html':
        out.push($(node).html() || '');
        break;
      case 'ownText':
        out.push(
          $(node)
            .contents()
            .filter((_, c) => c.type === 'text')
            .text()
        );
        break;
      case 'textNodes':
        out.push(
          $(node)
            .contents()
            .filter((_, c) => c.type === 'text')
            .text()
        );
        break;
      case 'href':
        out.push($(node).attr('href') || '');
        break;
      case 'src':
        out.push($(node).attr('src') || $(node).attr('data-src') || '');
        break;
      case 'title':
        out.push($(node).attr('title') || '');
        break;
      case 'content':
        out.push($(node).attr('content') || '');
        break;
      case 'value':
        out.push($(node).attr('value') || '');
        break;
      case 'textNodes':
        break;
      default:
        // 非已知取值器一律按属性取（data-original / data-src / 任意 attr）
        if (!['text', 'html', 'ownText'].includes(accessor)) {
          out.push($(node).attr(accessor) || '');
        } else {
          out.push($(node).text() || '');
        }
    }
  }
  const joined = accessor === 'html' || accessor === 'content' ? out.join('') : out.map(collapse).filter(Boolean).join(' ');
  return accessor === 'html' || accessor === 'content' ? joined : collapse(joined);
}

/** JSONPath 命中值转标量字符串；纯字符串数组按段落拼接。 */
function scalarFromJson(values) {
  if (values == null) return '';
  if (Array.isArray(values)) {
    if (values.length && values.every((v) => v == null || typeof v !== 'object')) {
      return values.map((v) => collapse(v)).filter(Boolean).join('\n');
    }
    for (const v of values) {
      const s = scalarFromJson(v);
      if (s) return s;
    }
    return '';
  }
  if (typeof values === 'object') return '';
  return collapse(values);
}

/** 模板回灌：先算 {{@@规则}}，再替换普通 {{变量}}。 */
function renderEmbedded(value, ctx) {
  let text = String(value == null ? '' : value);
  if (!text) return '';

  text = text.replace(/\{\{\s*@@([\s\S]+?)\}\}/g, (_, inner) => {
    try {
      const v = evaluate(String(inner).trim(), ctx);
      return v == null ? '' : String(v);
    } catch {
      return '';
    }
  });

  // 内嵌 JSONPath：{{$.rows}} / {{$.serialID}}
  text = text.replace(/\{\{\s*(\$[\s\S]+?)\}\}/g, (_, inner) => {
    try {
      return scalarFromJson(jsonPath(ctx.json, String(inner).trim()));
    } catch {
      return '';
    }
  });

  if (/\{\{[^}]+\}\}/.test(text)) {
    text = render(text, {
      key: ctx.key,
      page: ctx.page,
      book: ctx.book,
      source: ctx.source,
      result: ctx.result,
      baseUrl: ctx.baseUrl,
    });
  }
  return collapse(text);
}

/** 抽离尾部 @js: 脚本（可位于选择器/换行之后）。 */
function extractTrailingJs(rule) {
  const m = String(rule || '').match(/@js:([\s\S]*)$/);
  if (!m) return { code: '', rest: String(rule || '') };
  return { code: m[1], rest: rule.slice(0, m.index) };
}

/**
 * 解析单条选择器备选（不含 || 与脚本）。
 */
function evaluateSelectorAlt(selectorPart, ctx) {
  let part = selectorPart.trim();
  if (!part) return ctx.result != null ? String(ctx.result) : '';

  // ## 正则替换段（在选择器尾部）
  let regexSuffix = '';
  const hashIdx = part.indexOf('##');
  if (hashIdx >= 0) {
    regexSuffix = part.slice(hashIdx + 2);
    part = part.slice(0, hashIdx);
  }

  let value = '';
  if (isJsonPath(part)) {
    value = scalarFromJson(jsonPath(ctx.json, part));
  } else if (
    /^[A-Za-z_$][\w$]*$/.test(part) &&
    ctx.json && typeof ctx.json === 'object' && !Array.isArray(ctx.json) &&
    ctx.json.type !== 'tag'
  ) {
    value = ctx.json[part] == null ? '' : String(ctx.json[part]);
  } else {
    const tokens = part.split('@').map((t) => t.trim()).filter(Boolean);
    let accessor = 'text';
    while (tokens.length && ACCESSORS.has(tokens[tokens.length - 1])) {
      accessor = tokens.pop();
    }
    let nodes = ctx.rootNodes || [];
    for (const token of tokens) nodes = chainNodes(nodes, token);
    value = extractNodes(nodes, accessor);
  }

  if (regexSuffix) value = applyRegex(value, regexSuffix);
  return value;
}

/**
 * 对外主入口：规则可含 || 多备选，从左到右兜底；尾部 @js / <js> 脚本只执行一次。
 */
export function evaluate(rule, ctx) {
  if (rule == null || rule === '') return '';
  try {
    const { prefix, code: jsBlock } = splitJsBlock(rule);
    const { code: atJs, rest } = extractTrailingJs(prefix);

    // 多行请求描述符 `url,{...}` 整体作为模板，不按换行拆分
    let templateLine = '';
    const selectorLines = [];
    if (/^https?:\/\/[^,]+,\s*\{/.test(rest.trim())) {
      templateLine = rest.trim();
    } else {
      const lines = rest.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      for (const line of lines) {
        if (/\{\{/.test(line) && !isJsonPath(line) && !line.startsWith('@')) {
          templateLine = templateLine || line;
        } else {
          selectorLines.push(line);
        }
      }
    }

    const alternatives = selectorLines.join('||').split('||').map((s) => s.trim()).filter(Boolean);
    let value = '';
    for (const alt of alternatives) {
      const v = evaluateSelectorAlt(alt, ctx);
      if (v && v.trim()) {
        value = v;
        break;
      }
    }

    const finalCode = atJs || jsBlock;
    if (finalCode && finalCode.trim()) {
      value = ctx.rt.run(finalCode, value);
    }

    if (templateLine) {
      value = render(templateLine, {
        key: ctx.key,
        page: ctx.page,
        book: ctx.book,
        source: ctx.source,
        result: value,
        baseUrl: ctx.baseUrl,
        $: ctx.json,
        json: ctx.json,
      });
    }

    return renderEmbedded(value, ctx);
  } catch {
    return '';
  }
}

/** 取规则对应的节点集合（书列表 / 目录列表用）。 */
export function queryNodes(ctx, rule) {
  if (!rule) return [];
  try {
    if (isJsonPath(rule)) {
      return jsonPath(ctx.json, rule).flatMap((v) => (Array.isArray(v) ? v : v == null ? [] : [v]));
    }
    const tokens = String(rule).split('@').map((t) => t.trim()).filter(Boolean);
    let nodes = ctx.rootNodes || [];
    for (const token of tokens) nodes = chainNodes(nodes, token);
    return nodes;
  } catch {
    return [];
  }
}

/** 相对 URL 补全。 */
export function resolveUrl(href, baseUrl) {
  const raw = String(href || '').trim();
  if (!raw || /^(javascript:|mailto:|tel:|#)/i.test(raw) || raw === '#') return '';
  let value = raw;
  if (value.startsWith('//')) value = 'https:' + value;
  if (/^https?:\/\//i.test(value)) return value;
  try {
    return new URL(value, baseUrl || 'http://127.0.0.1/').toString();
  } catch {
    return '';
  }
}

/** 作者字段清洗：去掉「作者：」前缀与常见尾部噪声。 */
export function cleanAuthor(value, bookName) {
  let author = collapse(value)
    .replace(/^(作者|播音|主播|分类|类型)\s*[：:]\s*/, '')
    .replace(/^\s*作者\s*/, '')
    .trim();
  if (!author) return '';
  if (bookName && author.includes(bookName)) author = author.replace(bookName, '');
  author = author.replace(/^[【\[（(]\s*/, '').replace(/[）\】\)]\s*$/, '');
  author = author.split(/\s+(?:类型|状态|总点击|月点击|周点击|总推荐|最新章节)/)[0];
  return author.slice(0, 60);
}

export { collapse, scalarFromJson };
