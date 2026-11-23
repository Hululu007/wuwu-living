#!/usr/bin/env python3
"""tone 词表自检的三条臂：证明 toast-census.py 的自检本身有区分力。

背景（2026-11-22 真实踩坑）：
  `normalize()` 加了 `info` 分支，但 census 的 tone 词表没跟上，
  10 处静态 `'info'` 被误算成 `expr` ——「已归位」看起来像「还没归位」。
  所以自检必须存在，且自检本身必须被证明会红。

三条臂（全部必须符合预期，否则本次普查结果无效）：
  1 正向：真实项目 → 词表与实现同步 → EXIT=0
  2 负向：实现新增一个 census 不认识的 tone（warn）→ EXIT=2 且指名缺 warn
  3 负向：normalize 被掏空（一个 tone 都抽不到）→ EXIT=2

两条硬纪律（都踩过，别再犯）：
  ① 负向臂必须扰动**实现**（public/assets/toast.js），不能改 census 自己的正则
     —— 改判据等于自我污染，实测两次恒绿。
  ② 夹具必须先断言改动成功。改失败时脚本自己也报错退出 2，
     会被当成「预期红」而假绿 —— 所以每个夹具写前 assert、写后 assert。

用法：python3 design/toast-vocab-arms.py
退出码：0 = 三臂全部符合预期；1 = 有臂不符合（普查结果无效）
"""
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Optional, Tuple

DESIGN = Path(__file__).resolve().parent
ROOT = DESIGN.parent
CENSUS = DESIGN / "toast-census.py"

fail = 0


def chk(name: str, actual: int, expect: int) -> None:
    global fail
    if actual == expect:
        print(f"  ✅ {name} exit={actual}")
    else:
        print(f"  ❌ {name} exit={actual}（期望 {expect}）")
        fail = 1


def run_census(cwd: Path, script: Optional[Path] = None) -> Tuple[int, str]:
    """★ 夹具必须跑**夹具里的那份** census。
    跑原版时 __file__ 指向真实项目，ROOT 也就指向真实项目，
    负向臂等于什么都没测到（实测两次恒绿，这是第三次假绿的根因）。"""
    script = script or CENSUS
    r = subprocess.run(
        [sys.executable, str(script)],
        cwd=str(cwd), capture_output=True, text=True,
    )
    # ★ 必须同时返回 stdout：census 的正常输出在 stdout，
    #   只回 stderr 会让「读输出做断言」的臂永远拿不到内容（实测 tone=-1）。
    return r.returncode, ((r.stdout or "") + (r.stderr or "")).strip()


def make_fixture() -> Path:
    """夹具必须保持 <tmp>/design/toast-census.py + <tmp>/public 的层级：
    census 用 __file__ 推仓库根，层级错了它会去找 <tmp>/../public 而崩。"""
    t = Path(tempfile.mkdtemp())
    shutil.copytree(ROOT / "public", t / "public")
    (t / "design").mkdir()
    shutil.copy(CENSUS, t / "design" / CENSUS.name)
    return t


def patch_toast(t: Path, fn) -> None:
    """fn(src) -> new_src；写前写后都断言，改失败直接抛。"""
    p = t / "public" / "assets" / "toast.js"
    assert p.exists(), "夹具缺 toast.js"
    src = p.read_text(encoding="utf-8")
    new = fn(src)
    assert new != src, "夹具未命中：改动没有生效"
    p.write_text(new, encoding="utf-8")
    assert p.read_text(encoding="utf-8") == new, "夹具写入后内容不一致"


print("【tone 词表自检】census 的词表必须覆盖 normalize 的返回值")

# 臂1 正向：真实项目
rc, _ = run_census(ROOT)
chk("正向(词表与实现同步)", rc, 0)

# 臂2 负向：实现新增 warn，census 词表未跟上
t = make_fixture()
try:
    patch_toast(t, lambda s: s.replace(
        "if (kind === 'info') return 'info';",
        "if (kind === 'info') return 'info';\n    if (kind === 'warn') return 'warn';",
        1,
    ))
    rc, err = run_census(t, t / 'design' / CENSUS.name)
    chk("实现新增 warn 必须报红", rc, 2)
    if rc == 2 and "warn" not in err:
        print("  ❌ 报红但没指名缺 warn，判据不精确")
        fail = 1
finally:
    shutil.rmtree(t, ignore_errors=True)

# 臂3 负向：normalize 被掏空，一个 tone 都抽不到
t = make_fixture()
try:
    def gut(s: str) -> str:
        return re.sub(
            r"function normalize\(kind\)[\s\S]*?\n  \}",
            'function normalize(kind){return "";}',
            s, count=1,
        )
    patch_toast(t, gut)
    rc, _ = run_census(t, t / 'design' / CENSUS.name)
    chk("normalize 掏空必须报红", rc, 2)
finally:
    shutil.rmtree(t, ignore_errors=True)

# ── 臂4：嵌套括号里的 'bad' 必须被认成 tone（行内正则口径会漏）────────
# 2026-11-22 三位管家报 3/4/8/11 四个数，根因之一就是 `toast\([^()]*` 遇到
# `toast(wwDescribeError(e,'客厅'), 'bad')` 时在 wwDescribeError( 的左括号处截断。
t = make_fixture()
try:
    # ★ 夹具必须只留被测页：整个 public/ 拷过来会把投屏页的 2 处 CSS 类名混进计数，
    #   数字对不上会被误判成量具错（实测踩过一次）。
    for _f in list((t / "public").glob("*.html")):
        _f.unlink()
    tpl = t / "public" / "_nested.html"
    tpl.write_text(
        "<script>\n"
        "toast(wwDescribeError(e, 'x'), 'bad');\n"
        "toast(d.summary, d.ok ? 'good' : 'bad');\n"
        "const dot = x ? 'live' : 'bad';\n"
        "</script>\n", encoding="utf-8")
    rc, out = run_census(t, t / "design" / CENSUS.name)
    # 期望：tone 2 处（嵌套那行 + 三态那行），CSS 类名 1 处
    import re as _re
    m1 = _re.search(r"'bad' 作 toast tone：(\d+) 处", out)
    m2 = _re.search(r"不可当 tone 改）：(\d+) 处", out)
    got = (int(m1.group(1)) if m1 else -1, int(m2.group(1)) if m2 else -1)
    if got == (2, 1):
        print(f"  ✅ 嵌套括号里的 'bad' 认作 tone（tone=2 / 类名=1）")
    else:
        print(f"  ❌ 嵌套括号统计错：期望 tone=2 类名=1，实际 tone={got[0]} 类名={got[1]}")
        fail = 1
finally:
    shutil.rmtree(t, ignore_errors=True)

sys.exit(fail)
