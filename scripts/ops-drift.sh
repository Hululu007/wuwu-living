#!/bin/bash
# 五五客厅 · 版本漂移检测（验收硬前置）
#
# 为什么要有这个：2026-11-22 一整天，全组反复出现「改了但没生效」——
#   进程 pid=72117 启动于 11-21 21:13，而 hub.mjs 已改到 11-22 15:17，
#   运行的是 18 小时前的代码。当时所有性能验收结论都作废。
#
# 关键区分（这是本脚本存在的意义）：
#   · 后端代码（hub.mjs / lib/*.mjs）在进程启动时 require 进内存 → 改了必须重启
#   · 静态资源（public/**）每次请求读盘 → 改了立即生效，不需要重启
#   实测证据：往 room.css 末尾追加一行，0.5 秒后 curl 就能读到 → 确认每请求读盘。
#   所以「mtime 晚于进程启动」不能一律报漂移，否则静态资源会产生大量假警报。
#
# 用法:
#   ./scripts/ops-drift.sh          检测
#   ./scripts/ops-drift.sh --json   机器可读
#
# 退出码（取时不要接管道）:
#   0 = 一致（无后端漂移）   1 = 有后端漂移，需重启   3 = 判据故障
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8890}"
LABEL="${LABEL:-com.wuwu.wuwu-living}"

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'
if [ ! -t 1 ]; then RED=; GRN=; YEL=; DIM=; RST=; fi

# 取监听进程
pid="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
if [ -z "$pid" ]; then
  echo "${RED}判据故障${RST}: $PORT 无监听进程，无法比对漂移" >&2
  exit 3
fi

# 进程启动时刻 → epoch（macOS date -j -f 解析 ps lstart）
lstart="$(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//;s/ *$//')"
if [ -z "$lstart" ]; then
  echo "${RED}判据故障${RST}: 读不到 pid=$pid 的启动时刻" >&2
  exit 3
fi
start_epoch="$(date -j -f "%a %b %d %T %Y" "$lstart" +%s 2>/dev/null)"
if [ -z "$start_epoch" ]; then
  echo "${RED}判据故障${RST}: 无法解析启动时刻 [$lstart]" >&2
  exit 3
fi

echo "${DIM}—— 版本漂移检测  $PORT  pid=$pid ——${RST}"
echo "${DIM}  进程启动: $lstart${RST}"

drift=0; drift_list=""
# 后端代码：进程启动时加载进内存，mtime 晚于启动 = 漂移
for f in "$DIR/hub.mjs" "$DIR"/lib/*.mjs "$DIR/package.json"; do
  [ -f "$f" ] || continue
  m="$(stat -f '%m' "$f" 2>/dev/null)"
  [ -z "$m" ] && continue
  if [ "$m" -gt "$start_epoch" ]; then
    rel="${f#$DIR/}"
    drift=$((drift+1))
    drift_list="$drift_list $rel"
  fi
done

# 静态资源：每次请求读盘，只统计不报错（避免假警报）
static_newer=0
for f in "$DIR"/public/*.html "$DIR"/public/assets/*; do
  [ -f "$f" ] || continue
  m="$(stat -f '%m' "$f" 2>/dev/null)"
  [ -z "$m" ] && continue
  [ "$m" -gt "$start_epoch" ] && static_newer=$((static_newer+1))
done

if [ "$drift" -eq 0 ]; then
  echo "  ${GRN}PASS${RST}  后端代码一致    无 lib/hub 漂移（静态资源 $static_newer 个较新，每请求读盘、无需重启）"
else
  echo "  ${RED}FAIL${RST}  后端代码漂移    $drift 个文件晚于进程启动 → 运行的是旧代码，需重启"
  for x in $drift_list; do
    echo "          ${DIM}$x  $(stat -f '%Sm' -t '%m-%d %H:%M:%S' "$DIR/$x" 2>/dev/null)${RST}"
  done
fi

# launchd 旁证：只打印
ld="$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E '^\s*(runs|last exit code)' | tr -s ' ' | tr '\n' ' ')"
[ -n "$ld" ] && echo "${DIM}  launchd 旁证: $ld${RST}"

[ "$drift" -gt 0 ] && exit 1
exit 0
