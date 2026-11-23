#!/bin/bash
# 8811（聆听音乐网页版）存活判据
#
# ============================================================
# 为什么端口/进程/launchd 三样都不可信（2026-11-22 实测）
# ============================================================
# 造了一个「accept 连接但永不回包」的夹具（/tmp/hangtest/hang.mjs, :8899），
# 四条判据同时给出答案：
#   A  lsof 端口在听        → "在听"        ← 假绿
#   C  进程存在 STAT=       → "在"          ← 假绿
#   D  真实请求 2s 超时     → 000 / 2.005s  ← 唯一判对
# 又造了「完全不监听」的死夹具（:8898）：
#   D  真实请求             → 000 / 0.000257s
# ⇒ 判活的唯一依据是真实请求；而且 000 要再分两种：
#      000 + 接近超时  = HUNG   进程在、端口在听，但 accept 后不回包（用户看到"转圈"）
#      000 + 毫秒级    = DEAD   内核 RST，根本没有进程接（用户看到"打不开"）
#   这两种修法完全不同，混在一起会误导。
#
# ── 与 ops-monitor.sh 的分工（别合并）────────────────────────
#   本脚本 = 诊断工具：人手动跑、看细节、六值退出码（含 HUNG/IMPOSTOR）
#   ops-monitor.sh = 监控探针：launchd 定时跑、只报存活、三值退出码
#   合并会让监控背上诊断的复杂度，也让诊断失去细粒度。
#   常驻链路：com.wuwu.wuwu-living-guard → ops-guard.sh → 本脚本 + ops-monitor.sh
# ────────────────────────────────────────────────────────────
#
# 用法:
#   ./scripts/ops-8811.sh              默认 5 次采样，2s 超时
#   ./scripts/ops-8811.sh -n 20 -t 4   20 次，4s 超时（对齐总管基线）
#
# 退出码（取时不要接管道）:
#   0=ALIVE  1=DEGRADED  2=DEAD  3=HUNG（端口在听但不回包）
#   4=判据故障  5=IMPOSTOR（端口有人答 200，但不是 launchd 托管的那个进程）
#
# ★ 为什么必须有 IMPOSTOR（2026-11-22 实测）：
#   起一个假服务占 19999 并返回 200，本脚本原版报 ALIVE 5/5 exit=0。
#   而当天 8811 被测试夹具抢占过 5 次（EADDRINUSE 5 条）——
#   夹具若恰好返回 200，监控会把冒充者报成"健康"。
#   「有人在端口上回答」≠「我们的服务在回答」。
set -u

URL="${URL:-http://127.0.0.1:8811/}"
LABEL="${LABEL:-com.wuwu.lingting.web}"
N=5
T=2

while [ $# -gt 0 ]; do
  case "$1" in
    -n) N="${2:-5}"; shift 2 ;;
    -t) T="${2:-2}"; shift 2 ;;
    -u) URL="${2:-}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 4 ;;
  esac
done

case "$URL" in
  http://*|https://*) : ;;
  *) echo "判据故障：URL 非法 [$URL]" >&2; exit 4 ;;
esac

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'
if [ ! -t 1 ]; then RED=; GRN=; YEL=; DIM=; RST=; fi

echo "${DIM}—— 8811 存活判据  $URL  ${N} 次 × ${T}s ——${RST}"

# launchd 旁证：只打印，不参与判定
ld="$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E '^\s*(state|pid|runs|last exit code)' | tr -s ' ' | tr '\n' ' ')"
[ -n "$ld" ] && echo "${DIM}  launchd 旁证（不参与判定）: ${ld}${RST}"
# 端口旁证：只打印，不参与判定
# 端口从 URL 里取，不能写死 8811：
# 否则把 URL 指向别的端口时，旁证仍会报"8811 在听"，是误导（实测踩过）。
UP_PORT="$(printf '%s' "$URL" | sed -E 's#^https?://[^:/]+:?([0-9]*).*#\1#')"
[ -z "${UP_PORT:-}" ] && UP_PORT=80
if lsof -nP -iTCP:"$UP_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "${DIM}  端口旁证（不参与判定）: $UP_PORT 在听${RST}"
else
  echo "${DIM}  端口旁证（不参与判定）: $UP_PORT 无监听${RST}"
fi

ok=0; hung=0; dead=0; other=0
i=1
while [ "$i" -le "$N" ]; do
  # 只用 curl 的退出码与耗时判形态，不落盘
  out="$(curl -s -o /dev/null -m "$T" -w '%{http_code}|%{time_total}' "$URL" 2>/dev/null)"
  rc=$?
  [ -z "$out" ] && out="000|0"
  code="${out%%|*}"; t="${out##*|}"

  if [ "$code" = "200" ]; then
    ok=$((ok+1))
  elif [ "$code" = "000" ]; then
    # rc=28 是 curl 超时；耗时 >= 超时的 90% 也算超时（防止秒表误差）
    if [ "$rc" = "28" ] || awk "BEGIN{exit !($t >= $T * 0.9)}"; then
      hung=$((hung+1))
    else
      dead=$((dead+1))
    fi
  else
    other=$((other+1))
  fi
  i=$((i+1))
done

echo "${DIM}  形态分布: 200=$ok  挂起=$hung  已死=$dead  其它=$other${RST}"

# ★ 身份核对（IMPOSTOR，第六态）：只在「拿到过 200」时才做。
#   为什么加 ok>0 这个前提（实测踩过）：
#     挂起夹具（accept 但不回包）也会让监听 pid ≠ 托管 pid。
#     若无条件核对，HUNG 会被误报成 IMPOSTOR——把「服务卡住」说成「有人冒充」，
#     方向完全错，修法也完全不同遇先修错人。
#   IMPOSTOR 的严格定义是「有人在这个端口正常回答 200，但不是 we 的服务」。
if [ "$ok" -gt 0 ]; then
  LDPID="$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null \
    | awk -F'= ' '/^[[:space:]]*pid = /{print $2; exit}' | tr -d ' ')"
  LPID="$(lsof -nP -iTCP:"$UP_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
  if [ -n "${LDPID:-}" ] && [ -n "${LPID:-}" ] && [ "$LPID" != "$LDPID" ]; then
    echo "  ${RED}IMPOSTOR${RST} 端口 $UP_PORT 被非托管进程占用（监听 pid=$LPID，launchd 报 pid=$LDPID）"
    echo "  ${DIM}← 「有人在端口上回答」≠「我们的服务在回答」。这次 $ok 个 200 不可信。${RST}"
    exit 5
  fi
fi

# 判定优先级：挂起 > 全通 > 全死 > 部分
if [ "$hung" -gt 0 ] && [ "$ok" -eq 0 ]; then
  echo "  ${RED}HUNG${RST}  $hung/$N 挂起（端口在听、accept 后不回包）← 端口判据会骗人"
  exit 3
elif [ "$hung" -gt 0 ]; then
  echo "  ${YEL}DEGRADED${RST}  $ok/$N 正常，但 $hung/$N 挂起 ← 间歇性"
  exit 1
elif [ "$N" -ge 1 ] && [ "$ok" -eq "$N" ]; then
  echo "  ${GRN}ALIVE${RST}  $N/$N"
  exit 0
elif [ "$ok" -eq 0 ]; then
  echo "  ${RED}DEAD${RST}  0/$N（毫秒级 RST，无进程接）"
  exit 2
else
  echo "  ${YEL}DEGRADED${RST}  $ok/$N"
  exit 1
fi
