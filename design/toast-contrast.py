#!/usr/bin/env python3
"""toast 三态「去色可分」量具。

判据来源：design/交互契约-toast三态非颜色编码-Rev3.md 第四节
  ① 去色可分：三态文字两两对比度 ≥ 1.5，或前置符号存在且三者不同
  ② 缩小可分：前置符号是字形（不是细节），缩到 50% 仍可分
  ③ 不依赖 emoji：content 里不含 U+1F300–U+1FAFF

为什么需要它（2026-11-22 实测）：
  info 补上后三态只靠 border-color + color，两个属性全是颜色。
  去色后文字两两对比 1.13 / 1.48 / 1.31，边框 info-vs-good 只有 1.08 —— 全部 < 1.5。
  只调亮度救不回来（最好的一对 1.31），颜色维度已用尽。
  对照：.empty 三态当初就是按 dashed/solid/dotted + 对齐 + 装饰 + 按钮 四维设计的，
  同一产品里「三态怎么区分」不能有两套语言。

用法：python3 design/toast-contrast.py [--json]
退出码：0 = 三态去色可分；1 = 不可分（契约未达标）；2 = 量具自身故障
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOAST = ROOT / "public/assets/toast.js"
CSS = ROOT / "public/assets/room.css"


def lin(c: float) -> float:
    c = c / 255
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4


def rel_lum(rgb):
    r, g, b = (lin(x) for x in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b) -> float:
    la, lb = rel_lum(a), rel_lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def over(fg, alpha: float, bg):
    """半透明前景合成到背景上（边框是半透明的，必须先合成再比）"""
    return tuple(round(fg[i] * alpha + bg[i] * (1 - alpha)) for i in range(3))


def parse_rgba(s: str):
    m = re.match(r"rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)", s.strip())
    if not m:
        return None
    r, g, b = int(m.group(1)), int(m.group(2)), int(m.group(3))
    a = float(m.group(4)) if m.group(4) else 1.0
    return (r, g, b), a


def parse_hex(s: str):
    s = s.strip()
    m = re.match(r"#([0-9a-fA-F]{6})", s)
    if not m:
        return None
    h = m.group(1)
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def _css_unescape(raw: str):
    """CSS content 里的 \\2713 是转义码位，不是字面反斜杠。
    ★ 不解码会把 '\\2713' 与 '\\00B7' 当成两个不同字符串 —— 符号判据形同虚设，
      而实际渲染出来可能是同一个字形（实测前端已用转义写法落地）。
    解 JS 字符串里的双反斜杠后再解 CSS 十六进制转义。"""
    if raw is None:
        return None
    t = raw.replace("\\\\", "\\")          # JS 源码里的 \\ 实际是 CSS 的 \
    t = re.sub(r"\\([0-9a-fA-F]{1,6})\s?", lambda m: chr(int(m.group(1), 16)), t)
    return t.strip()


def color_of(css_text: str, prop: str):
    # ★ 必须用 (?<![\w-]) 前缀锁：否则查 "color" 会先命中 "border-color"，
    #   导致 text 与 border 取到同一个值（实测过，量具自己把三态判成完全同色）。
    m = re.search(rf"(?<![\w-]){prop}\s*:\s*(rgba?\([^)]*\)|#[0-9a-fA-F]{{3,8}})", css_text)
    if not m:
        return None
    val = m.group(1)
    return parse_hex(val) if val.startswith("#") else parse_rgba(val)


def main() -> int:
    for f in (TOAST, CSS):
        if not f.exists():
            print(f"❌ 量具故障：缺 {f}", file=sys.stderr)
            return 2

    toast_src = TOAST.read_text(encoding="utf-8")
    css_src = CSS.read_text(encoding="utf-8")

    # 注入的样式块（toast.js 的 ensureStyle 里那串）
    rules = dict(re.findall(r"\.toast\.([a-z]+)\{([^}]*)\}", toast_src))
    if not rules:
        print("❌ 量具故障：toast.js 里找不到 .toast.<tone> 规则", file=sys.stderr)
        return 2

    # 背景与继承文字色
    bg_m = re.search(r"\.toast\{[^}]*background\s*:\s*rgba?\(([^)]*)\)", css_src)
    if bg_m:
        parts = [float(x) for x in bg_m.group(1).split(",")]
        bg = (int(parts[0]), int(parts[1]), int(parts[2]))
    else:
        bg = (14, 17, 14)
    ink_m = re.search(r"--ink\s*:\s*(#[0-9a-fA-F]{6})", css_src)
    ink = parse_hex(ink_m.group(1)) if ink_m else (239, 233, 221)

    tones = {}
    for name, body in rules.items():
        txt = color_of(body, "color")
        bd = color_of(body, "border-color")
        text_rgb = txt[0] if isinstance(txt, tuple) and len(txt) == 2 else (txt or ink)
        if isinstance(txt, tuple) and len(txt) == 2:
            text_rgb = over(txt[0], txt[1], bg)
        if bd:
            border_rgb = over(bd[0], bd[1], bg) if len(bd) == 2 else bd[0]
        else:
            border_rgb = None
        # 前置符号（::before content）
        sym_m = re.search(rf'\.toast\.{name}[^{{]*::before\s*\{{[^}}]*content\s*:\s*"([^"]*)"', toast_src)
        tones[name] = {
            "text": text_rgb,
            "border": border_rgb,
            "border_style": (re.search(r"border-style\s*:\s*([a-z]+)", body) or [None, None])[1],
            "symbol": _css_unescape(sym_m.group(1)) if sym_m else None,
        }

    if len(tones) < 3:
        print(f"❌ 量具故障：只找到 {len(tones)} 个 tone（{sorted(tones)}），至少需要 info/good/err", file=sys.stderr)
        return 2

    names = sorted(tones)
    text_pairs, border_pairs = [], []
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            a, b = names[i], names[j]
            text_pairs.append((a, b, round(contrast(tones[a]["text"], tones[b]["text"]), 2)))
            if tones[a]["border"] and tones[b]["border"]:
                border_pairs.append((a, b, round(contrast(tones[a]["border"], tones[b]["border"]), 2)))

    THRESH = 1.5
    symbols = [tones[n]["symbol"] for n in names]
    symbols_ok = all(s for s in symbols) and len(set(symbols)) == len(symbols)
    # ★ 必须同时覆盖两类：真 emoji（U+1F300–1FAFF）与常被当成「符号」的
    #   emoji 变体选择符 / 杂项符号（U+2600–27BF、U+FE0F）。只查前者会漏判
    #   （实测 ⚠️/✅ 这类带 FE0F 的写法会跑过去）。
    # 判据精确到「会破坏去色测试的字符」：
    #   ① 真 emoji（U+1F300–1FAFF）
    #   ② 变体选择符 U+FE0F（强制 emoji 呈现，会让纯字形变色）
    #   ③ emoji 修饰符 U+1F3FB–1F3FF
    # ★ 不能把 U+2600–27BF 整段当 emoji：✓(U+2713) 也在里面，
    #   而它正是契约要用的纯字形符号 —— 整段禁会把正确方案判红（实测过）。
    _EMOJI = re.compile(r"[\U0001F300-\U0001FAFF\U0001F3FB-\U0001F3FF\uFE0F]")
    emoji_bad = [n for n in names if tones[n]["symbol"] and _EMOJI.search(tones[n]["symbol"])]
    text_ok = all(c >= THRESH for _, _, c in text_pairs)

    result = {
        "tones": {n: {"text": tones[n]["text"], "border": tones[n]["border"],
                      "symbol": tones[n]["symbol"], "borderStyle": tones[n]["border_style"]} for n in names},
        "textPairs": text_pairs,
        "borderPairs": border_pairs,
        "threshold": THRESH,
        "textOk": text_ok,
        "symbolsOk": symbols_ok,
        "emojiFree": not emoji_bad,
    }

    if "--json" in sys.argv:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print("toast 三态 · 去色测试")
        for n in names:
            t = tones[n]
            print(f"  {n:5s} text={t['text']} border={t['border']} style={t['border_style'] or '-':7s} symbol={t['symbol'] or '（无）'}")
        print(f"\n文字两两对比（阈值 {THRESH}）：")
        for a, b, c in text_pairs:
            print(f"  {a:5s} vs {b:5s}: {c:.2f}  {'✅' if c >= THRESH else '❌'}")
        print(f"\n边框两两对比：")
        for a, b, c in border_pairs:
            print(f"  {a:5s} vs {b:5s}: {c:.2f}  {'✅' if c >= THRESH else '❌'}")
        print(f"\n前置符号三者互不相同：{'✅' if symbols_ok else '❌ ' + str(symbols)}")
        print(f"不含 emoji：{'✅' if not emoji_bad else '❌ ' + str(emoji_bad)}")

    # 判据①：文字够分 或 符号三者不同（二者取其一即「去色可分」）
    ok = (text_ok or symbols_ok) and not emoji_bad
    if not ok:
        print("\n❌ 三态去色后不可分：文字对比不足且没有互不相同的前置符号", file=sys.stderr)
        print("   契约见 design/交互契约-toast三态非颜色编码-Rev3.md 第三节", file=sys.stderr)
        return 1
    print("\n✅ 三态去色可分")
    return 0


if __name__ == "__main__":
    sys.exit(main())
