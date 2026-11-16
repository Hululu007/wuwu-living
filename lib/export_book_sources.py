#!/usr/bin/env python3
"""Export searchable Reader book sources into a compact JSON cache.

The Reader desktop database is read-only here; the actual crawling is done by
the local Node search engine.  Only sources that have both a search URL and a
search-list rule are exported, because those are the ones that can actually
produce results without opening a browser.
"""
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time

DB = "/Users/wuwu/Library/Application Support/reader/data/reader.db"
OUT = "/Users/wuwu/D盘/项目/五五客厅/runtime/book-sources.json"


def main():
    db_path = sys.argv[1] if len(sys.argv) > 1 else DB
    out_path = sys.argv[2] if len(sys.argv) > 2 else OUT
    if not os.path.exists(db_path):
        raise SystemExit(f"reader.db not found: {db_path}")

    # 直接 sqlite3.connect 在这个沙箱里会被 LaunchServices 的文件访问策略挡住；
    # 先复制一份快照再只读打开。Reader 当前没有 -wal/-shm 旁文件，复制主库即可。
    snapshot = os.path.join(tempfile.gettempdir(), "wuwu-reader-sources-snapshot.db")
    try:
        shutil.copy2(db_path, snapshot)
        con = sqlite3.connect(snapshot)
    except Exception:
        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    rows = con.execute(
        "select book_source_name, book_source_url, json from book_sources"
    ).fetchall()

    sources = []
    for name, url, raw in rows:
        try:
            d = json.loads(raw)
        except Exception:
            continue
        if not d.get("enabled", True) or not d.get("enabledSearch", True):
            continue
        search_url = (d.get("searchUrl") or "").strip()
        rules = d.get("ruleSearch") or {}
        book_list = (rules.get("bookList") or "").strip()
        if not search_url or not book_list:
            continue

        header = d.get("header")
        if isinstance(header, str):
            try:
                header = json.loads(header) if header.strip() else {}
            except Exception:
                header = {}
        if not isinstance(header, dict):
            header = {}

        sources.append({
            "name": name or url or "未命名书源",
            "url": (url or "").strip(),
            "group": d.get("bookSourceGroup") or "",
            "searchUrl": search_url,
            "bookUrlPattern": d.get("bookUrlPattern") or "",
            "header": header,
            "charset": (d.get("charset") or "").strip(),
            "rules": {
                "bookList": book_list,
                "name": rules.get("name") or "",
                "author": rules.get("author") or "",
                "bookUrl": rules.get("bookUrl") or "",
                "coverUrl": rules.get("coverUrl") or "",
                "intro": rules.get("intro") or "",
                "kind": rules.get("kind") or "",
                "lastChapter": rules.get("lastChapter") or "",
                "wordCount": rules.get("wordCount") or "",
                "status": rules.get("status") or "",
            },
        })

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({
            "generatedAt": int(time.time()),
            "count": len(sources),
            "sources": sources,
        }, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, out_path)
    print(f"exported {len(sources)} sources -> {out_path}")


if __name__ == "__main__":
    main()
