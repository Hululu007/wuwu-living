#!/usr/bin/env python3
"""只读读取 Reader 数据库，供五五客厅的书房使用。

用法:
  reader_query.py <db> info
  reader_query.py <db> search <关键词>

输出一行 JSON。只读 URI 打开，不写 Reader 的任何数据。
"""
import json
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

db = sys.argv[1]
mode = sys.argv[2] if len(sys.argv) > 2 else "info"
arg = sys.argv[3] if len(sys.argv) > 3 else ""

out = {"sources": None, "lastBook": "", "todaySeconds": 0, "groups": []}

try:
    # launchd/沙箱上下文里直接打开 Reader 的库会被文件访问策略拒绝（WAL 库更明显）。
    # 复制一份主库快照再只读查询，避免在 Reader 运行中加锁或改数据。
    snapshot = Path(tempfile.gettempdir()) / "wuwu-reader-query-snapshot.db"
    shutil.copy2(db, snapshot)
    con = sqlite3.connect(str(snapshot), timeout=5)
    cur = con.cursor()

    if mode == "search":
        q = arg.strip()
        rows = cur.execute(
            "select book_source_name, json from book_sources "
            "where book_source_name like ? order by book_source_name limit 60",
            ("%" + q + "%",),
        ).fetchall()
        items = []
        for name, raw in rows:
            try:
                obj = json.loads(raw or "{}")
            except Exception:
                obj = {}
            items.append({
                "name": name or "",
                "group": (obj.get("bookSourceGroup") or "").strip(),
                "enabled": obj.get("enabled", True) is not False,
            })
        out = {"items": items, "query": q}
    elif mode == "group":
        target = arg.strip()
        items = []
        for name, raw in cur.execute("select book_source_name, json from book_sources"):
            try:
                obj = json.loads(raw or "{}")
            except Exception:
                obj = {}
            if (obj.get("bookSourceGroup") or "").strip() != target:
                continue
            items.append({
                "name": name or "",
                "group": target,
                "enabled": obj.get("enabled", True) is not False,
            })
            if len(items) >= 60:
                break
        out = {"items": items, "group": target}
    else:
        try:
            out["sources"] = int(cur.execute("select count(*) from book_sources").fetchone()[0])
        except Exception:
            out["sources"] = None

        try:
            row = cur.execute(
                "select book_name from reading_book_stats order by date desc, seconds desc limit 1"
            ).fetchone()
            out["lastBook"] = (row[0] or "") if row else ""
        except Exception:
            out["lastBook"] = ""

        try:
            row = cur.execute(
                "select coalesce(sum(seconds),0) from reading_book_stats "
                "where date = date('now','localtime')"
            ).fetchone()
            out["todaySeconds"] = int(row[0] or 0) if row else 0
        except Exception:
            out["todaySeconds"] = 0

        counts = {}
        try:
            for name, raw in cur.execute("select book_source_name, json from book_sources"):
                try:
                    obj = json.loads(raw or "{}")
                except Exception:
                    obj = {}
                g = (obj.get("bookSourceGroup") or "").strip()
                if g:
                    counts[g] = counts.get(g, 0) + 1
        except Exception:
            pass
        out["groupTotal"] = len(counts)
        out["groups"] = [
            {"name": k, "count": v}
            for k, v in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:18]
        ]

    con.close()
except Exception as e:
    out["error"] = str(e)

print(json.dumps(out, ensure_ascii=False))
