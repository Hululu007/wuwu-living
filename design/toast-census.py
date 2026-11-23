#!/usr/bin/env python3
"""统计 public/*.html 里 toast() 调用：总数 / 单参 / 各 tone 分布。
判据要点（2026-11-22 踩过的三个坑）：
  ① 必须排除注释行，否则注释里写的 toast(...) 会被数成真实调用
     （实测多算了 2 处：五五客厅.html:1189/1202 的修法说明注释）
  ② 必须剥行内 // 注释，否则修法说明里的示例也会被算
  ③ 用括号配平取实参，不能用正则切逗号（实参里含逗号，如 wwDescribeError(e,'客厅')）
用法：python3 design/toast-census.py [--json]
"""
import re, pathlib, sys, json, os
ROOT = pathlib.Path(__file__).resolve().parent.parent

def blank_block_comments(text):
    out=[]; i=0; n=len(text)
    while i<n:
        if text.startswith('/*',i):
            j=text.find('*/',i+2); j=n if j<0 else j+2
            out.append('\n'*text[i:j].count('\n')); i=j; continue
        out.append(text[i]); i+=1
    return ''.join(out)

def strip_line_comment(line):
    # 粗略：忽略引号内的 //（本项目 toast 实参里没有 URL 以外的 //）
    out=[]; q=None; i=0
    while i<len(line):
        c=line[i]
        if q:
            out.append(c)
            if c=='\\': out.append(line[i+1:i+2]); i+=2; continue
            if c==q: q=None
            i+=1; continue
        if c in "'\"`": q=c; out.append(c); i+=1; continue
        if line.startswith('//',i): break
        out.append(c); i+=1
    return ''.join(out)

def calls(src):
    src=blank_block_comments(src)
    res=[]
    for ln,raw in enumerate(src.split('\n'),1):
        line=strip_line_comment(raw)
        for m in re.finditer(r'(?<![\w$.])toast\(', line):
            s=m.end(); d=1; j=s
            while j<len(line) and d>0:
                if line[j]=='(': d+=1
                elif line[j]==')': d-=1
                j+=1
            res.append((ln, line[s:j-1].strip()))
    return res

def tone_of(arg):
    if ',' not in arg: return 'single'
    tail=arg.rsplit(',',1)[1].strip()
    if tail=='true': return 'bool-true'
    if tail=='false': return 'bool-false'
    m=re.match(r"^'(good|ok|err|error|bad|info)'$", tail)
    if m: return m.group(1)
    return 'expr'

# ★ 词表自检：本脚本 tone_of() 里实际用的词表，必须覆盖 toast.js normalize() 的全部字面量。
#   2026-11-22 踩过：normalize 加了 info 分支，本脚本词表没跟上，
#   10 处静态 'info' 被误算成 expr —— 「已归位」看起来像「还没归位」。
#   ★ 注意：必须从本文件**实际使用的那条正则**里取词表，
#     另写一个常量来比对是无效自检（第一版就这么错，负向臂照样绿）。
_self = pathlib.Path(__file__).read_text(encoding='utf-8')
_vocab_m = re.search(r"m=re\.match\(r\"\^'\(([a-z|]+)\)'\$\"", _self)
if not _vocab_m:
    print("❌ 自检失败：找不到 tone_of() 的词表正则，自检本身失效", file=sys.stderr)
    sys.exit(2)
_known = set(_vocab_m.group(1).split('|'))
_norm = (ROOT/'public/assets/toast.js').read_text(encoding='utf-8')
_m = re.search(r'function normalize\(kind\)[\s\S]*?\n  \}', _norm)
if not _m:
    print("❌ 自检失败：toast.js 里找不到 normalize()，判据与实现脱节", file=sys.stderr)
    sys.exit(2)
# ★ 必须抽 normalize 里**所有**小写字面量，不能再限定词表——
#   限定词表等于自检只在已知集合内打转，新增 tone 永远抓不到（负向臂两次恒绿的根因）。
# 只抽 normalize **返回**的字面量（那才是真正的 tone 输出值）；
# 抽全部字面量会误报（实测在 normalize 里加一句 void 'debug' 就报红）。
_impl = set(re.findall(r"return\s+'([a-z]{2,8})'", _m.group(0)))
if not _impl:
    print("❌ 自检失败：normalize() 里抽不到任何 tone 返回值，实现已丢失 tone 映射", file=sys.stderr)
    sys.exit(2)
_missing = _impl - _known
if _missing:
    print(f"❌ 词表不同步：normalize 支持 {sorted(_impl)}，本脚本词表 {sorted(_known)} 缺 {sorted(_missing)}", file=sys.stderr)
    sys.exit(2)

rows=[]; stat={}
for f in sorted((ROOT/'public').glob('*.html')):
    for ln,arg in calls(f.read_text(encoding='utf-8',errors='ignore')):
        t=tone_of(arg); stat[t]=stat.get(t,0)+1
        rows.append({'file':f.name,'line':ln,'tone':t,'arg':arg})

# ── 'bad' 专项：必须区分「toast 实参里的 'bad'」与「CSS 类名」 ──────────
# 2026-11-22 三位管家报过 3/4/8/11 四个数，全部真实，只是量的不是同一个东西：
#   投屏页 11 处 'bad' 里只有一部分是 toast tone，另 2 处是 CSS 类名
#   （.dot.bad 未连接红点 / .ar .r.bad 操作结果红字）—— 当 tone 去改会弄坏红点红字。
# ★ 判据必须是「'bad' 落在某个 toast(...) 的实参里」，不能用 tone=='bad'：
#   三态 `toast(x, ok ? 'good' : 'bad')` 的 tone 是 expr，但它确实是 tone 用法
#   （实测按 tone=='bad' 筛会把它两边都漏掉，tone 少算 1 处）。
def _bad_in_toast_args(line):
    for m in re.finditer(r'(?<![\w$.])toast\(', line):
        st = m.end(); d = 1; j = st
        while j < len(line) and d > 0:
            if line[j] == '(': d += 1
            elif line[j] == ')': d -= 1
            j += 1
        if "'bad'" in line[st:j-1]:
            return True
    return False

bad_tone = []
bad_other = []
for f in sorted((ROOT/'public').glob('*.html')):
    src = blank_block_comments(f.read_text(encoding='utf-8', errors='ignore'))
    for ln, raw in enumerate(src.split('\n'), 1):
        line = strip_line_comment(raw)
        if "'bad'" not in line:
            continue
        if _bad_in_toast_args(line):
            kind = 'tone(字面量)' if re.search(r",\s*'bad'\s*\)", line) else 'tone(三态?:)'
            bad_tone.append({'file': f.name, 'line': ln, 'kind': kind})
        else:
            bad_other.append({'file': f.name, 'line': ln, 'text': line.strip()[:80]})

out={'total':len(rows),'byTone':stat,'singleArg':[r for r in rows if r['tone']=='single'],
     'badAsTone':len(bad_tone),'badNotTone':bad_other}
if '--json' in sys.argv:
    print(json.dumps(out,ensure_ascii=False,indent=2))
else:
    print(f"toast 调用总数 {out['total']}")
    for k,v in sorted(stat.items(),key=lambda x:-x[1]): print(f"  {k:12s} {v}")
    print(f"\n'bad' 作 toast tone：{len(bad_tone)} 处")
    if bad_other:
        print(f"'bad' 但不是 tone（CSS 类名等，不可当 tone 改）：{len(bad_other)} 处")
        for r in bad_other:
            print(f"  {r['file']}:{r['line']}  {r['text']}")
    print(f"\n单参（无 tone，视觉与成功相同）{len(out['singleArg'])} 处：")
    for r in out['singleArg']: print(f"  {r['file']}:{r['line']}  {r['arg'][:66]}")
sys.exit(0 if not out['singleArg'] else 1)
