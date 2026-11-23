#!/usr/bin/env python3
"""toast 三态「去色测试」量具的自检 —— 证明 toast-contrast.py 有区分力。

背景（2026-11-22）：
  补上 info 后三态只靠 border-color + color，两个属性全是颜色。
  去色后文字两两对比 1.13 / 1.48 / 1.31，边框 info-vs-good 1.08 —— 全部 < 1.5。
  对照 .empty 三态（dashed/solid/dotted + 对齐 + 装饰 + 按钮 四维不同），
  同一产品里「三态怎么区分」不能有两套语言。契约见 交互契约-toast三态非颜色编码-Rev3.md。

四条臂：
  1 现状（只有颜色）        → EXIT=1  去色不可分
  2 契约方案（·/✓/! 三符号） → EXIT=0  去色可分
  3 三态同一符号            → EXIT=1  等于没区分
  4 用真 emoji              → EXIT=1  破坏去色测试

三条硬纪律（都踩过）：
  ① 夹具必须保留原 .toast.info 规则、只**追加** ::before ——
     整段替换会把 info 删掉，量具报「只找到 2 个 tone」退 2，
     那是量具故障，不是判据红（实测误判过一次）。
  ② emoji 判据不能整段禁 U+2600–27BF：✓(U+2713) 在里面，
     而它正是契约要用的符号，整段禁会把正确方案判红。
  ③ 夹具断言写前写后都做，构造失败直接判本臂作废，不能把崩溃当预期红。

用法：python3 design/toast-contrast-arms.py
退出码：0 = 四臂符合预期；1 = 有臂不符合（本次对比度结论无效）
"""
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Optional, Tuple

DESIGN = Path(__file__).resolve().parent
ROOT = DESIGN.parent
GAUGE = DESIGN / "toast-contrast.py"
ANCHOR = "'.toast.err.on{cursor:pointer;pointer-events:auto}' +"

fail = 0


def chk(name: str, actual: int, expect: int) -> None:
    global fail
    if actual == expect:
        print(f"  ✅ {name} exit={actual}")
    else:
        print(f"  ❌ {name} exit={actual}（期望 {expect}）")
        fail = 1


def run(cwd: Path, script: Optional[Path] = None) -> Tuple[int, str]:
    """★ 必须跑夹具自己那份量具：跑原版时 __file__ 指向真实项目，
    负向臂等于什么都没测到（这条在 toast-census 上栽过三次）。"""
    script = script or GAUGE
    r = subprocess.run([sys.executable, str(script)], cwd=str(cwd),
                       capture_output=True, text=True)
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def fixture() -> Path:
    t = Path(tempfile.mkdtemp())
    shutil.copytree(ROOT / "public", t / "public")
    (t / "design").mkdir()
    shutil.copy(GAUGE, t / "design" / GAUGE.name)
    return t


def add_symbols(t: Path, decls: str) -> None:
    p = t / "public" / "assets" / "toast.js"
    assert p.exists(), "夹具缺 toast.js"
    s = p.read_text(encoding="utf-8")
    assert ANCHOR in s, "夹具未命中：找不到锚点（toast.js 结构已变，请更新本脚本）"
    assert ".toast.info{" in s, "夹具缺 info 规则：整段替换会删掉它，必须只追加"
    # ★ 必须先删掉已落地的 ::before 声明再注入，否则「同符号/emoji」两条臂
    #   会被原有符号救活而判绿（实测两条负向臂同时失效）。
    #   用行过滤而不是正则：转义层次太深，正则在这里已经错过一次。
    kept = [ln for ln in s.split("\n") if "::before" not in ln]
    s = "\n".join(kept)
    assert "::before" not in s, "夹具残留原有 ::before 声明"
    new = s.replace(ANCHOR, decls + ANCHOR, 1)
    assert new != s, "夹具写入未生效"
    p.write_text(new, encoding="utf-8")
    assert decls in p.read_text(encoding="utf-8"), "夹具写入后内容不一致"


print("【toast 三态去色测试】量具自检")

# 臂1 现状：前端已落地 ·/✓/! 三符号 → 必须判绿
rc, _ = run(ROOT)
chk("现状(已落地三符号)必须判绿", rc, 0)

# 臂1b 负向：把符号声明全部删掉（退回「只有颜色」）→ 必须判红
t = fixture()
try:
    p = t / "public" / "assets" / "toast.js"
    s0 = p.read_text(encoding="utf-8")
    import re as _re
    s1 = _re.sub(r"'\.toast\.[a-z]+::before\{[^}]*\}' \+\n?", "", s0)
    assert s1 != s0, "夹具未命中：找不到 ::before 声明"
    assert "::before" not in s1, "夹具残留 ::before"
    p.write_text(s1, encoding="utf-8")
    rc, _ = run(t, t / "design" / GAUGE.name)
    chk("删掉符号(只剩颜色)必须判红", rc, 1)
finally:
    shutil.rmtree(t, ignore_errors=True)

# 臂2 契约方案：· / ✓ / !
t = fixture()
try:
    add_symbols(t, "'.toast.info::before{content:\"· \"}' +"
                   "'.toast.good::before{content:\"✓ \"}' +"
                   "'.toast.err::before{content:\"! \"}' +")
    rc, out = run(t, t / "design" / GAUGE.name)
    chk("契约方案(·/✓/!)必须判绿", rc, 0)
    if rc != 0:
        print("     输出尾部：" + out.strip().splitlines()[-1] if out.strip() else "")
finally:
    shutil.rmtree(t, ignore_errors=True)

# 臂3 三态同一符号
t = fixture()
try:
    add_symbols(t, "'.toast.info::before{content:\"· \"}' +"
                   "'.toast.good::before{content:\"· \"}' +"
                   "'.toast.err::before{content:\"· \"}' +")
    rc, _ = run(t, t / "design" / GAUGE.name)
    chk("三态同符号必须判红", rc, 1)
finally:
    shutil.rmtree(t, ignore_errors=True)

# 臂4 用真 emoji
t = fixture()
try:
    add_symbols(t, "'.toast.info::before{content:\"\U0001F534 \"}' +"
                   "'.toast.good::before{content:\"\U0001F7E2 \"}' +"
                   "'.toast.err::before{content:\"\U0001F6A8 \"}' +")
    rc, _ = run(t, t / "design" / GAUGE.name)
    chk("用真 emoji 必须判红", rc, 1)
finally:
    shutil.rmtree(t, ignore_errors=True)

sys.exit(fail)
