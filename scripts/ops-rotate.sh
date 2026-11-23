#!/bin/bash
# 通用日志按日切分（copytruncate，不 mv）
#
# ── 为什么必须 copytruncate 而不是 mv（实测）──────────────────────
#   进程以 fd 持有日志文件。mv 走后它仍写**旧 inode**，新文件永远 0 字节。
#   实测：`: > out.log` 截断后服务照常工作、后续写入正常追加 ⇒ 截断安全。
#
# ── 为什么不删历史证据 ────────────────────────────────────────────
#   只匹配「名字-8位日期.log」这种切分产物，且显式排除 evidence-*。
#   2026-11-22 踩过：旧的 `-name 'err-2*.log'` 会吃掉 evidence/historical，
#   14 天后静默删除当天唯一的崩溃证据。用 -regex 精确锁死 8 位日期。
#
# ── 用法 ─────────────────────────────────────────────────────────
#   ./ops-rotate.sh <日志目录> [--dry-run] [--keep N] [--prefixes a,b,c]
#
#   例：
#     ./ops-rotate.sh ~/Library/Logs/lingting
#     ./ops-rotate.sh ~/Library/Logs/wuwu-living --prefixes stdout,stderr,guard,actions
#
#   不给 --prefixes 时，自动扫描目录下所有 *.log（排除已带日期的归档）。
set -u

DIR="${1:-}"
[ -z "$DIR" ] && { echo "用法: $0 <日志目录> [--dry-run] [--keep N] [--prefixes a,b,c]" >&2; exit 64; }
shift

TODAY="$(date +%Y%m%d)"
KEEP_DAYS=14
DRY=0
PREFIXES=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --keep)    KEEP_DAYS="${2:-14}"; shift 2 ;;
    --prefixes) PREFIXES="${2:-}"; shift 2 ;;
    *) echo "未知参数: $1" >&2; exit 64 ;;
  esac
done

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'
if [ ! -t 1 ]; then RED=; GRN=; YEL=; DIM=; RST=; fi

# ★ 未展开的 ~ 会变成字面量「~/...」这种目录名，find 找不到但不报错，
#   结果看着"无需切分"，实际是路径错。必须显式识别并提示（实测踩过）。
case "$DIR" in
  "~"|"~/"*)
    echo "${RED}判据故障${RST}: 路径里的 ~ 未展开（收到 [$DIR]）" >&2
    echo "  原因：~ 只在命令行首由 shell 展开；放进变量/引号里就变字面量。" >&2
    echo "  改法：用绝对路径，如 $0 \"\$HOME/Library/Logs/wuwu-living\"" >&2
    exit 3 ;;
esac

[ -d "$DIR" ] || { echo "${RED}错误${RST}: 目录不存在 $DIR" >&2; exit 3; }

# 决定要切分哪些前缀
if [ -n "$PREFIXES" ]; then
  LIST="$(printf '%s' "$PREFIXES" | tr ',' ' ')"
else
  # 自动：目录下所有 *.log，但排除已是归档格式（name-YYYYMMDD.log）的
  LIST=""
  for f in "$DIR"/*.log; do
    [ -f "$f" ] || continue
    b="$(basename "$f" .log)"
    case "$b" in
      *-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) continue ;;  # 已是归档
      evidence-*) continue ;;                                   # 人工抢救的证据，绝不切
      *-historical) continue ;;                                 # 同上（-historical 结尾）
    esac
    LIST="$LIST $b"
  done
fi

moved=0
for name in $LIST; do
  src="$DIR/$name.log"
  [ -f "$src" ] || continue
  sz="$(wc -c < "$src" 2>/dev/null | tr -d ' ')"
  [ "${sz:-0}" -eq 0 ] && continue

  dst="$DIR/$name-$TODAY.log"
  if [ "$DRY" = "1" ]; then
    echo "${DIM}会归档${RST} $name.log ($sz 字节) → $(basename "$dst")"
    moved=$((moved+1))
    continue
  fi
  # copytruncate：追加后截断，保住 inode
  if cat "$src" >> "$dst" 2>/dev/null; then
    : > "$src"
    echo "${GRN}已归档${RST} $name.log ($sz 字节) → $(basename "$dst")"
    moved=$((moved+1))
  else
    echo "${RED}归档失败${RST}: $src" >&2
  fi
done

if [ "$DRY" = "1" ]; then
  echo "${DIM}（dry-run，未改动任何文件）${RST}"
  [ "$moved" -eq 0 ] && echo "${DIM}无需切分（日志为空或不存在）${RST}"
  exit 0
fi

# 清理过期归档：只删「名字-8位日期.log」，显式排除 evidence-*
# ★ 为什么用 -name 而不是 -regex（macOS 实测）：
#   BSD find 的 -regex 是 emacs 方言，`[^-]+` 这种写法**匹配不到任何东西**，
#   而 `\{8\}` 也不生效。实测：`-regex ".*/[^-]+-[0-9]\{8\}\.log"` 命中 0 个文件，
#   结果过期归档永远不清理（看着"安全"，实际是失效）。
#   `-name "*-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].log"` 是 glob，
#   行为确定、无方言问题。这是「判据看着对但实际不工作」的又一个实例。
prune() {
  find "$DIR" -maxdepth 1 -type f \
    -name '*-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].log' \
    ! -name 'evidence-*' \
    ! -name '*-historical.log' \
    -mtime +"$KEEP_DAYS" -print -delete 2>/dev/null | wc -l | tr -d ' '
}
old="$(prune)"
[ "${old:-0}" -gt 0 ] && echo "${DIM}清理过期归档 $old 个（超过 ${KEEP_DAYS} 天）${RST}"

if [ "$moved" -eq 0 ]; then
  echo "${DIM}无需切分（当前日志为空）${RST}"
else
  echo "${GRN}切分完成${RST}: $moved 个文件 → $TODAY"
fi
echo "${DIM}当前目录:${RST}"
ls -la "$DIR" 2>/dev/null | tail -8
exit 0
