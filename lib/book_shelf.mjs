/**
 * 书房自己的书架：只记录用户主动点「加入书架」的书。
 * Reader 客户端那边的书架由它自己维护，两边互不影响。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimePath } from './runtime_dir.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FILE = runtimePath(ROOT, 'book_shelf.json');

function keyOf(url) {
  return String(url || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
}

export function readShelf() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(data) ? data.filter((b) => b && b.bookUrl) : [];
  } catch {
    return [];
  }
}

function persist(items) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(items.slice(0, 500), null, 2));
  fs.renameSync(tmp, FILE);
}

function clean(v, max = 400) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 主动加入：同一本书重复点只更新元信息，不重复占位。 */
export function addToShelf(input = {}) {
  const bookUrl = clean(input.bookUrl, 600);
  if (!/^https?:\/\//i.test(bookUrl)) throw new Error('缺少有效的书籍地址');
  const items = readShelf();
  const key = keyOf(bookUrl);
  const idx = items.findIndex((b) => keyOf(b.bookUrl) === key);
  const entry = {
    bookUrl,
    origin: clean(input.origin, 600),
    name: clean(input.name) || '未命名',
    author: clean(input.author) || '佚名',
    coverUrl: clean(input.coverUrl, 600),
    originName: clean(input.originName) || 'Reader 书源',
    durChapterIndex: Number.isFinite(input.durChapterIndex) ? input.durChapterIndex : (idx >= 0 ? items[idx].durChapterIndex : null),
    durChapterTitle: clean(input.durChapterTitle) || (idx >= 0 ? items[idx].durChapterTitle : ''),
    totalChapterNum: Number.isFinite(input.totalChapterNum) ? input.totalChapterNum : (idx >= 0 ? items[idx].totalChapterNum : null),
    addedAt: idx >= 0 ? items[idx].addedAt : Date.now(),
    updatedAt: Date.now(),
  };
  if (idx >= 0) items[idx] = entry; else items.unshift(entry);
  persist(items);
  return items;
}

export function removeFromShelf(bookUrl) {
  const key = keyOf(bookUrl);
  if (!key) throw new Error('缺少书籍地址');
  const items = readShelf().filter((b) => keyOf(b.bookUrl) !== key);
  persist(items);
  return items;
}

/** 阅读时更新进度，只对已在书架的书生效；不会把书自动加进书架。 */
export function touchShelfProgress(bookUrl, durChapterIndex, durChapterTitle) {
  const key = keyOf(bookUrl);
  if (!key) return readShelf();
  const items = readShelf();
  const idx = items.findIndex((b) => keyOf(b.bookUrl) === key);
  if (idx < 0) return items;
  if (Number.isFinite(durChapterIndex)) items[idx].durChapterIndex = durChapterIndex;
  if (durChapterTitle) items[idx].durChapterTitle = clean(durChapterTitle);
  items[idx].updatedAt = Date.now();
  persist(items);
  return items;
}
