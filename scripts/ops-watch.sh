#!/bin/bash
# 五五客厅 · 服务存活判据（第 7 步 / 监控）
#
# 为什么不信 launchctl / lsof / ps：
#   2026-11-22 实测 8811 —— launchctl print 报 state=running、pid 在、
#   进程 STAT=R、lsof 有时还有监听，但 20 次真实请求 0/20 命中：
#   前 2 次超时 4s（正在拉起），后 18 次 0.3ms 被内核 RST（服务已死）。
#   ⇒ 这三样只能证明「launchd 以为它在跑」，不能证明「它还能服务」。
#   唯一可信判据 = 连续 N 次真实业务请求的命中率。
#
# 用法:
#   ./scripts/ops-watch.sh <名称> <URL> [-n 采样数] [-m 最少命中] [-l launchd标签] [-t 超时秒]
# 例:
#   ./scripts/ops-watch.sh 客厅   http://127.0.0.1:8890/api/ping
#   ./scripts/ops-watch.sh 音乐房 http://127.0.0.1:8811/ -l com.wuwu.lingting.web
#
# 退出码（互斥，供上层判三态；取退出码时不要接管道）:
#   0 = ALIVE     命中 >= 阈值
#   1 = DEGRADED  有命中但低于阈值
#   2 = DEAD      命中 = 0
#   3 = 判据故障  URL 不可用 / 参数错误（不是服务的问题，别当 DEAD 报）
set -u

NAME="${1:-服务}"
URL="${2:-}"
SAMPLES=20
MIN_OK=18
LBL=""
TIMEOUT=4

if [ -z "$URL" ]; then
  echo "用法: $0 <名称> <URL> [-n N] [-m MIN] [-l LABEL] [-t TIMEOUT]" >&2
  exit 3
fi
# URL 合法性前置校验：坏 URL 会让 curl 每次都以 000 失败，
# 若不当场判「判据故障」，就会把「我参数写错了」误报成「服务死了」。
# 实测过：传 not-a-url 时 3/3 都是 000，旧版会 exit=2(DEAD)。
case "$URL" in
  http://*|https://*) : ;;
  *) echo "判据故障：URL 必须以 http:// 或 https:// 开头，收到 [$URL]" >&2; exit 3 ;;
esac
shift 2
while [ $# -gt 0 ]; do
  case "$1" in
    -n) SAMPLES="${2:-20}"; shift 2 ;;
    -m) MIN_OK="${2:-18}"; MIN_OK_SET=1; shift 2 ;;
    -l) LBL="${2:-}"; shift 2 ;;
    -t) TIMEOUT="${2:-4}"; shift 2 ;;
    *)  echo "未知参数: $1" >&2; exit 3 ;;
  esac
done

# ★ 2026-11-22 修正：MIN_OK 默认 18 是配 -n 20 的，单独传 -n 3 会让阈值仍是 18/3，
# 于是「3 次全过」也被判 DEGRADED。判据没坏，是调用方少给一个参数却拿到红——
# 这类假红与假绿一样有害（会让人去修没坏的东西）。未显式给 -m 时按 95% 跟随 -n。
if [ -z "${MIN_OK_SET:-}" ]; then
  MIN_OK=$(( (SAMPLES * 95 + 99) / 100 ))
  [ "$MIN_OK" -lt 1 ] && MIN_OK=1
fi
if [ "$MIN_OK" -gt "$SAMPLES" ]; then
  echo "判据故障: 最少命中 $MIN_OK 大于采样数 $SAMPLES，任何结果都会判红" >&2
  exit 3
fi

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'
if [ ! -t 1 ]; then RED=; GRN=; YEL=; DIM=; RST=; fi

ok=0
fail_detail=""
i=1
while [ "$i" -le "$SAMPLES" ]; do
  # -o /dev/null：不落盘，避免上一次残留被误当本次结果
  probe="$(curl -s -o /dev/null -m "$TIMEOUT" -w '%{http_code}|%{time_total}' "$URL" 2>/dev/null)"
  [ -z "$probe" ] && probe="000|0"
  code="${probe%%|*}"
  t="${probe##*|}"

  if [ "$code" = "200" ]; then
    ok=$((ok+1))
  else
    # 区分两种 000：极快=内核 RST（进程没了）；慢=超时（进程在但卡住）
    if [ "$code" = "000" ]; then
      if awk "BEGIN{exit !($t < 0.01)}"; then
        fail_detail="$fail_detail RST($t)"
      else
        fail_detail="$fail_detail TIMEOUT($t)"
      fi
    else
      fail_detail="$fail_detail HTTP$code($t)"
    fi
  fi
  i=$((i+1))
done

echo "${DIM}—— $NAME  $URL  ${SAMPLES} 次采样，阈值 $MIN_OK/$SAMPLES ——${RST}"

# launchd 旁证：只打印，不参与判定（它会骗人，见文件头）
if [ -n "$LBL" ]; then
  ld="$(launchctl print "gui/$(id -u)/$LBL" 2>/dev/null | grep -E '^\s*(state|pid|runs|last exit code)' | tr -s ' ' | tr '\n' ' ')"
  [ -n "$ld" ] && echo "${DIM}  launchd 旁证（不参与判定）: ${ld}${RST}"
fi

if [ -n "$fail_detail" ]; then
  echo "${DIM}  失败形态:${fail_detail}${RST}"
fi

if [ "$ok" -ge "$MIN_OK" ]; then
  echo "  ${GRN}ALIVE${RST}  $ok/$SAMPLES"
  exit 0
elif [ "$ok" -eq 0 ]; then
  echo "  ${RED}DEAD${RST}  0/$SAMPLES  ← 完全不可用"
  exit 2
else
  echo "  ${YEL}DEGRADED${RST}  $ok/$SAMPLES  ← 低于阈值，服务不稳定"
  exit 1
fi
