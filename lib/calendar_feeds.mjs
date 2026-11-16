/**
 * 追更日历 · RSS/Atom 抓取与解析辅助
 *
 * 只用项目里已装的 cheerio（xmlMode）解析；不引别的依赖。
 * 抓不到、解析不出时一律抛带原因的错，交给主模块如实记在源上。
 */
import * as cheerio from 'cheerio';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export { UA };

/** 去掉 HTML 标签与多余空白，留纯文本摘要 */
export function stripHtml(s) {
  if (s == null) return '';
  const text = String(s);
  if (!text.includes('<')) return text.replace(/\s+/g, ' ').trim();
  try {
    const $ = cheerio.load('<root>' + text + '</root>', { xmlMode: true });
    return $.text().replace(/\s+/g, ' ').trim();
  } catch {
    return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

function parseDate(s) {
  const t = Date.parse(String(s || '').trim());
  return Number.isFinite(t) ? t : 0;
}

function text($, el, sel) {
  return $(el).find(sel).first().text().trim();
}

/** 解析 RSS 2.0 或 Atom，返回 { title, items: [{id,title,link,date,dateText,summary}] } */
export function parseFeed(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const channel = $('channel').first();
  const isRss = channel.length > 0;
  const title = isRss
    ? channel.find('> title').first().text().trim()
    : $('feed > title').first().text().trim();

  const items = [];

  if (isRss) {
    channel.find('> item').each((_, el) => {
      const e = $(el);
      const link = text($, e, '> link');
      const dateText = text($, e, '> pubDate') || text($, e, '> date') || text($, e, 'pubDate');
      const guid = text($, e, '> guid') || link;
      const desc = (e.find('> description').html() || e.find('description').text() || '');
      items.push({
        id: guid || link || title + Math.random(),
        title: stripHtml(e.find('> title').first().text()),
        link,
        date: parseDate(dateText),
        dateText: dateText.trim(),
        summary: stripHtml(desc).slice(0, 260),
      });
    });
  } else {
    $('entry').each((_, el) => {
      const e = $(el);
      let link = '';
      e.find('link').each((_, l) => {
        const rel = $(l).attr('rel') || 'alternate';
        const href = $(l).attr('href') || '';
        if (rel === 'alternate' && href && !link) link = href;
      });
      if (!link) link = e.find('link').first().attr('href') || '';
      const dateText = text($, e, '> updated') || text($, e, '> published') || text($, e, 'published');
      const content = e.find('> summary').html() || e.find('> content').html() || '';
      const id = text($, e, '> id') || link;
      items.push({
        id: id || link,
        title: stripHtml(e.find('> title').first().text()),
        link,
        date: parseDate(dateText),
        dateText: dateText.trim(),
        summary: stripHtml(content).slice(0, 260),
      });
    });
  }

  return { title, items };
}

/** 抓取一个源；超时 / 非 200 / 非 XML / 被风控 都抛错 */
export async function fetchFeed(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: {
        'user-agent': UA,
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const body = await r.text();
    if (!body || !body.includes('<')) throw new Error('返回内容不是 XML 文档');
    const head = body.slice(0, 3000);
    if (!/<rss[\s>]|<feed[\s>]|<channel[\s>]|<entry[\s>]/i.test(head) &&
        /waf|安全检测|verification|challenge|拦截|检测环境/i.test(head)) {
      throw new Error('被站点风控拦截，返回的不是 RSS');
    }
    const parsed = parseFeed(body);
    if (!parsed.items.length) throw new Error('解析不到任何条目');
    return parsed;
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('请求超时（12 秒）');
    throw e instanceof Error ? e : new Error(String(e));
  } finally {
    clearTimeout(timer);
  }
}
