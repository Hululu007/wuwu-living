#!/usr/bin/env node
/**
 * Legado 模板渲染：搜索 URL / 字段模板里的 {{...}} 占位与简单表达式。
 *
 * 支持：
 *  - {{key}}（URL 编码，UTF-8）、{{page}} 等变量直接替换；
 *  - {{page-1}}、{{(page-1)*10}} 这类简单算术/比较表达式（vm 沙箱，50ms 超时）；
 *  - 嵌套 {{}}：里层先算，外层再拼接；
 *  - 老式占位 <key>；
 *  - 字段模板里的 {{@@规则}} 不在本模块处理，由 values.mjs 回灌规则引擎。
 */

import vm from 'node:vm';

/** 表达式沙箱执行；只暴露白名单变量，异常返回空字符串。 */
function evalExpression(expr, scope) {
  const clean = String(expr).trim();
  if (!clean) return '';
  const sandbox = { ...scope };
  try {
    const out = vm.runInNewContext(`"use strict"; (${clean})`, sandbox, {
      timeout: 50,
      displayErrors: false,
    });
    if (out == null) return '';
    return out;
  } catch {
    return '';
  }
}

/** 找到最内层（不含嵌套花括号）的一段 {{...}}。 */
function innermostBraces(text) {
  const open = text.lastIndexOf('{{');
  if (open < 0) return null;
  const close = text.indexOf('}}', open + 2);
  if (close < 0) return null;
  return { start: open, end: close + 2, inner: text.slice(open + 2, close) };
}

/**
 * 渲染模板字符串。
 * @param {string} str 原始模板
 * @param {object} ctx 变量上下文 { key, page, book, source, result, ... }
 * @param {{encode?:boolean}} opts encode=true 时 key 走 URL 编码（搜索 URL 用）
 * @returns {string}
 */
export function render(str, ctx = {}, opts = {}) {
  if (str == null) return '';
  let text = String(str);
  const scope = {
    key: ctx.key || '',
    page: ctx.page || 1,
    pageMinus1: (ctx.page || 1) - 1,
    book: ctx.book || {},
    source: ctx.source || {},
    result: ctx.result != null ? ctx.result : '',
    cookie: ctx.cookie || '',
    baseUrl: ctx.baseUrl || '',
    $: ctx.$ || ctx.json || {},
    json: ctx.json || null,
  };

  // 嵌套循环：先算最内层
  for (let guard = 0; guard < 20; guard++) {
    const hit = innermostBraces(text);
    if (!hit) break;
    const inner = hit.inner;

    // @@ 前缀留给规则引擎，这里保留原样
    if (inner.trim().startsWith('@@')) {
      // 跳过该层，避免死循环（外层不再包含它的内层）
      const after = text.slice(0, hit.start) + inner + text.slice(hit.end);
      text = after;
      continue;
    }

    let value;
    const trimmed = inner.trim();
    if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
      // 纯变量名：直接取作用域
      value = scope[trimmed] ?? ctx[trimmed] ?? '';
      if (typeof value === 'object' && value != null) value = JSON.stringify(value);
    } else {
      value = evalExpression(inner, scope);
    }

    let rendered = value == null ? '' : String(value);
    if (opts.encode && trimmed === 'key') rendered = encodeURIComponent(rendered);
    text = text.slice(0, hit.start) + rendered + text.slice(hit.end);
  }

  // 老式 <key> 占位
  if (opts.encode) {
    text = text.replace(/<key>/g, () => encodeURIComponent(scope.key));
  } else {
    text = text.replace(/<key>/g, scope.key);
  }
  return text;
}

/** 搜索 URL 专用：key 强制 URL 编码。 */
export function renderUrl(str, ctx = {}) {
  return render(str, ctx, { encode: true });
}
