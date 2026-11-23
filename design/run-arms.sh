#!/usr/bin/env bash
# 设计审计器 · 自检（证明量具有区分力，不是证明产品合格）
# 用法：bash design/run-arms.sh
# 退出码：0 = 全部臂符合预期；1 = 有臂不符合（本次审计结果无效）
set -u
cd "$(dirname "$0")" || exit 9
fail=0
chk() { # $1=名称 $2=实际 $3=期望
  if [ "$2" -eq "$3" ]; then echo "  ✅ $1 exit=$2"; else echo "  ❌ $1 exit=$2（期望 $3）"; fail=1; fi
}

echo "【基础三臂】"
node design-audit.mjs --root _arms/good >/dev/null 2>&1; chk "正向(合规夹具)" $? 0
node design-audit.mjs --root _arms/bad  >/dev/null 2>&1; chk "负向(违规夹具)" $? 1
node design-audit.mjs --root /tmp/__no_such_root__ >/dev/null 2>&1; chk "故障(目录缺失)" $? 2

echo "【S3 超量态专项三向】同一处截断，只改提示与展开机制"
node design-audit.mjs --root _arms/ov-nocopy   >/dev/null 2>&1; chk "无「还有N」文案" $? 1
node design-audit.mjs --root _arms/ov-noexpand >/dev/null 2>&1; chk "有文案但无展开" $? 1
node design-audit.mjs --root _arms/ov-ok       >/dev/null 2>&1; chk "有文案且能展开" $? 0


echo "【V5 全站字号专项】夹具内 9px 必须被抓到"
node design-audit.mjs --root _arms/v5bad >/dev/null 2>&1; chk "小字号 9px 残留" $? 1

echo "【toast 三态去色测试】现状必须判红，契约方案必须判绿"
# 补上 info 后三态只靠颜色，去色后文字两两对比 1.13/1.48/1.31、边框 1.08，全部 <1.5。
# 对照 .empty 三态（四维不同）—— 同一产品不能有两套「三态怎么区分」的语言。
python3 toast-contrast-arms.py; chk "去色测试四臂" $? 0

echo "【S8 回看入口专项】只认真正消费接口的脚本，且 8 间房缺一即红"
node design-audit.mjs --root _arms/s8-selfref >/dev/null 2>&1; chk "定义方不得算调用方" $? 1
node design-audit.mjs --root _arms/s8-partial >/dev/null 2>&1; chk "缺一间房必须红" $? 1

echo "【V1 裸色值专项】与 token 同值的裸 hex 必须被抓到"
node design-audit.mjs --root _arms/v1bad >/dev/null 2>&1; chk "同值裸 hex 残留" $? 1

echo "【S7 语义色同源专项】旧色残留必须被抓到（含页面内联，不只是 assets/*.js）"
node design-audit.mjs --root _arms/s7bad >/dev/null 2>&1; chk "共享JS 旧色残留" $? 1
node design-audit.mjs --root _arms/s7page >/dev/null 2>&1; chk "页面内联旧色 226,60,48" $? 1

echo "【tone 词表自检】census 的词表必须覆盖 normalize 的返回值"
# 背景：normalize 加了 info 分支而 census 词表没跟上，10 处静态 'info' 被误算成 expr，
#       「已归位」看起来像「还没归位」。三臂写在独立脚本里（含夹具断言），
#       因为它需要「夹具跑夹具自己那份 census」这种细节，bash 里拼 heredoc 太脆。
python3 toast-vocab-arms.py; chk "词表自检三臂" $? 0

echo "【S8 回看通道专项】常驻但不记录必须被抓到"
node design-audit.mjs --root _arms/s8bad >/dev/null 2>&1; chk "常驻但无记录/入口" $? 1
node design-audit.mjs --root _arms/s8ok  >/dev/null 2>&1; chk "有记录+接口+入口" $? 0
# ★ 2026-11-22 补三条：S8 第一版只匹配 HTML 字面词，把下面三种「看着有、实际没有」
#   全放过去了（掏空面板 14B、只留一句 <!-- 消息记录 -->、删掉记录容器）。
#   不补这三臂，S8 的绿灯就是假的。
node design-audit.mjs --root _arms/s8gutted  >/dev/null 2>&1; chk "面板掏空(14B)仍须报红" $? 1
node design-audit.mjs --root _arms/s8comment >/dev/null 2>&1; chk "只留注释无脚本仍须报红" $? 1
node design-audit.mjs --root _arms/s8nostore >/dev/null 2>&1; chk "无记录容器仍须报红" $? 1

echo
if [ $fail -eq 0 ]; then echo "全部臂符合预期 → 量具有区分力"; else echo "有臂不符合 → 本次审计结果无效"; fi
exit $fail
