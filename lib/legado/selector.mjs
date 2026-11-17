#!/usr/bin/env node
/**
 * 选择器层：CSS / 阅读 2.0 旧式标签链 / JSONPath（常用子集）。
 *
 * 与取值语法（@text 等）解耦：本模块只负责「节点集合 / JSON 值集合」的定位。
 *  - CSS 走 cheerio；
 *  - 旧式 tag.x / class.x / id.x / 裸标签 用 DOM 树遍历补齐；
 *  - JSONPath 支持：.key / ['key'] / [*] / ..递归 / [n] / [?(@.x)] / 比较过滤。
 */

import * as cheerio from 'cheerio';

/* ─────────────────────── 文档装载 ─────────────────────── */

export function loadDoc(html) {
  return cheerio.load(String(html ?? ''), { decodeEntities: false });
}

/* ─────────────────────── 索引 / 切片解析 ─────────────────────── */

/**
 * 解析 token 尾部的定位语法：
 *  .4 / .-4  点号索引；[4] 方括号索引；!0 删除第 n 个；:a:b 切片；%% 后接排除文本。
 */
export function parseIndexToken(token) {
  let clean = token;
  let index = null;
  let removeIndex = null;
  let slice = null;
  let exclude = null;

  const excludeMatch = clean.match(/%%([^%]+)$/);
  if (excludeMatch) {
    exclude = excludeMatch[1];
    clean = clean.slice(0, excludeMatch.index);
  }
  // !n 删除第 n 个
  const bang = clean.match(/!(-?\d+)/);
  if (bang) {
    removeIndex = Number(bang[1]);
    clean = clean.replace(/!(-?\d+)/, '');
  }
  // jQuery 风格 :eq(n) 定位
  const eq = clean.match(/:eq\((-?\d+)\)/i);
  if (eq) {
    index = Number(eq[1]);
    clean = clean.replace(/:eq\((-?\d+)\)/i, '');
  }
  // 旧式切片 :a:b（legacy 规则里可能重复出现，取首段；残余冒号段一并清掉）
  const sliceMatch = clean.match(/:(-?\d+):(-?\d+)/);
  if (sliceMatch) {
    slice = [Number(sliceMatch[1]), Number(sliceMatch[2])];
    clean = clean.replace(/:(-?\d+):(-?\d+)/, '');
  }
  clean = clean.replace(/:[-\d]+/g, '');
  const dotted = clean.match(/^(.*)\.(-?\d+)$/);
  if (dotted && dotted[1] && !dotted[1].endsWith('.')) {
    index = Number(dotted[2]);
    clean = dotted[1];
  }
  const bracket = clean.match(/^(.*)\[(-?\d+)\]$/);
  if (bracket) {
    index = Number(bracket[2]);
    clean = bracket[1];
  }
  return { clean, index, removeIndex, slice, exclude };
}

function pickIndex(list, idx) {
  if (!Array.isArray(list) || list.length === 0 || idx == null) return list || [];
  const real = idx < 0 ? list.length + idx : idx;
  return real >= 0 && real < list.length ? [list[real]] : [];
}

function sliceList(list, [a, b]) {
  const n = list.length;
  const s = a < 0 ? n + a : a;
  const e = b < 0 ? n + b : b;
  return list.slice(Math.max(0, s), Math.max(0, e));
}

/* ─────────────────────── 旧式 DOM 树遍历 ─────────────────────── */

function walkChildren(node, predicate, found) {
  for (const child of node.children || []) {
    if (child.type === 'tag' && predicate(child)) found.push(child);
    walkChildren(child, predicate, found);
  }
}

/** 链式向下走一个 token。 */
export function chainNodes(nodes, token) {
  if (!nodes || nodes.length === 0 || !token) return nodes || [];
  const { clean, index, removeIndex, slice, exclude } = parseIndexToken(token);
  if (!clean) return nodes;

  let next = [];
  const lower = clean.toLowerCase();

  if (clean === 'children') {
    next = nodes.flatMap((n) => Array.from(n.children || []));
  } else if (clean.startsWith('tag.')) {
    const tag = clean.slice(4).toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const n of nodes) {
      walkChildren(n, (c) => c.name && c.name.toLowerCase() === tag, next);
    }
  } else if (clean.startsWith('class.')) {
    const cls = clean.slice(6).split('.')[0];
    const matchCls = (className) =>
      String(className || '')
        .split(/\s+/)
        .some((c) => c === cls || c.startsWith(cls));
    for (const n of nodes) {
      walkChildren(n, (c) => matchCls(c.attribs?.class), next);
    }
  } else if (clean.startsWith('id.')) {
    const id = clean.slice(3).split('.')[0];
    for (const n of nodes) {
      walkChildren(n, (c) => c.attribs?.id === id, next);
    }
  } else if (/^[a-z0-9]+$/.test(lower) && isKnownTag(lower)) {
    for (const n of nodes) {
      walkChildren(n, (c) => c.name && c.name.toLowerCase() === lower, next);
    }
  } else {
    // 其余按 CSS 选择器交给 cheerio；先匹配根节点本身，再取后代
    try {
      const $ = cheerio.load('');
      const root = nodes.length === 1 ? nodes[0] : nodes;
      const matched = $(root).filter(clean).toArray();
      const children = $(root).find(clean).toArray();
      const seen = new Set(matched.map((n) => n.uniqueID || n));
      next = matched.concat(children.filter((n) => !seen.has(n.uniqueID || n)));
    } catch {
      next = [];
    }
  }

  if (slice) next = sliceList(next, slice);
  next = pickIndex(next, index);
  if (removeIndex != null) {
    const real = removeIndex < 0 ? next.length + removeIndex : removeIndex;
    next = next.filter((_, i) => i !== real);
  }
  if (exclude != null) {
    next = next.filter((node) => !cheerio.load('')(node).text().includes(exclude));
  }
  return next;
}

function isKnownTag(tag) {
  return [
    'a', 'div', 'span', 'p', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'tr', 'td', 'th',
    'table', 'tbody', 'thead', 'h1', 'h2', 'h3', 'h4', 'h5', 'img', 'em', 'b', 'strong',
    'section', 'article', 'header', 'footer', 'nav', 'figure', 'figcaption',
  ].includes(tag);
}

/* ─────────────────────── JSONPath 子集 ─────────────────────── */

/** 判断规则是否为 JSONPath（$ 开头）。 */
export function isJsonPath(rule) {
  return /^\$[\[\.]/.test(String(rule || '').trim());
}

function readAt(obj, pathTokens) {
  let current = [obj];
  for (const tok of pathTokens) {
    const next = [];
    for (const item of current) {
      if (tok.type === 'key') {
        if (item && typeof item === 'object' && tok.value in item) next.push(item[tok.value]);
      } else if (tok.type === 'wild') {
        if (Array.isArray(item)) next.push(...item);
        else if (item && typeof item === 'object') next.push(...Object.values(item));
      } else if (tok.type === 'index') {
        if (Array.isArray(item)) {
          const real = tok.value < 0 ? item.length + tok.value : tok.value;
          if (real >= 0 && real < item.length) next.push(item[real]);
        }
      } else if (tok.type === 'filter') {
        if (Array.isArray(item)) {
          for (const el of item) if (filterMatch(el, tok.expr)) next.push(el);
        } else if (item && typeof item === 'object' && filterMatch(item, tok.expr)) {
          next.push(item);
        }
      }
    }
    current = next;
  }
  return current;
}

function getByDottedPath(obj, expr) {
  const first = expr.split(/[.[]/)[0];
  return obj && typeof obj === 'object' && first in obj ? obj[first] : undefined;
}

function evalFilterAt(el, expr) {
  // @.key 取值
  const m = expr.match(/^@\.([\w$-]+)$/);
  if (m) return el != null && typeof el === 'object' && !!el[m[1]];
  // @.key 比较 'v' / n
  const cmp = expr.match(/^@\.([\w$-]+)\s*(==|!=|>=|<=|>|<)\s*['"]?([^'"]+)['"]?$/);
  if (cmp && el != null && typeof el === 'object') {
    const [, k, op, raw] = cmp;
    const left = el[k];
    let right = raw;
    const ln = Number(left);
    const rn = Number(raw);
    const numeric = !Number.isNaN(ln) && !Number.isNaN(rn);
    if (numeric) {
      switch (op) {
        case '==': return ln === rn;
        case '!=': return ln !== rn;
        case '>': return ln > rn;
        case '>=': return ln >= rn;
        case '<': return ln < rn;
        case '<=': return ln <= rn;
      }
    }
    switch (op) {
      case '==': return String(left) === String(right);
      case '!=': return String(left) !== String(right);
    }
  }
  return false;
}

function filterMatch(item, expr) {
  return evalFilterAt(item, expr);
}

/**
 * 极简 JSONPath 解析求值，返回所有命中值（可能嵌套数组，调用方按需 flat）。
 */
export function jsonPath(root, expression) {
  let rest = String(expression || '').trim().replace(/^\$/, '');
  const tokens = [];
  while (rest) {
    // 递归 ..key
    if (rest.startsWith('..')) {
      rest = rest.slice(2);
      const key = rest.match(/^['"]?([\w$-]+)['"]?/);
      if (key) {
        tokens.push({ type: 'recursive', value: key[1] });
        rest = rest.slice(key[0].length);
      }
      continue;
    }
    if (rest.startsWith('.')) rest = rest.slice(1);
    const key = rest.match(/^['"]?([\w$-]+)['"]?/);
    if (rest.startsWith('*')) {
      tokens.push({ type: 'wild' });
      rest = rest.slice(1);
      continue;
    }
    if (key && !rest.startsWith('[')) {
      tokens.push({ type: 'key', value: key[1] });
      rest = rest.slice(key[0].length);
      continue;
    }
    const bracket = rest.match(/^\[([^\]]*)\]/);
    if (bracket) {
      const inner = bracket[1];
      if (inner === '*') tokens.push({ type: 'wild' });
      else if (/^-?\d+$/.test(inner.trim())) tokens.push({ type: 'index', value: Number(inner.trim()) });
      else if (inner.startsWith('?(')) tokens.push({ type: 'filter', expr: inner.slice(2, -1) });
      rest = rest.slice(bracket[0].length);
      continue;
    }
    break;
  }

  let current = [root];
  for (const tok of tokens) {
    const next = [];
    for (const item of current) {
      if (tok.type === 'key') {
        if (item && typeof item === 'object' && tok.value in item) next.push(item[tok.value]);
      } else if (tok.type === 'wild') {
        if (Array.isArray(item)) next.push(...item);
        else if (item && typeof item === 'object') next.push(...Object.values(item));
      } else if (tok.type === 'index') {
        if (Array.isArray(item)) {
          const real = tok.value < 0 ? item.length + tok.value : tok.value;
          if (real >= 0 && real < item.length) next.push(item[real]);
        }
      } else if (tok.type === 'filter') {
        if (Array.isArray(item)) for (const el of item) if (filterMatch(el, tok.expr)) next.push(el);
        else if (item && typeof item === 'object' && filterMatch(item, tok.expr)) next.push(item);
      } else if (tok.type === 'recursive') {
        const queue = [item];
        while (queue.length) {
          const cur = queue.shift();
          if (cur && typeof cur === 'object') {
            if (tok.value in cur) next.push(cur[tok.value]);
            if (Array.isArray(cur)) queue.push(...cur);
            else queue.push(...Object.values(cur));
          }
        }
      }
    }
    current = next;
  }
  return current;
}

/** 保留旧引用，避免外部模块拼写漂移。 */
export { readAt, getByDottedPath };
