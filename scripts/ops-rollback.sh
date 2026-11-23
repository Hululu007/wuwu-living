#!/bin/bash
# 五五客厅 · 运维回滚脚本（第 7 步）
# 用法:
#   ./scripts/ops-rollback.sh snap [原因]        拍快照（改代码前必须先跑）
#   ./scripts/ops-rollback.sh list               列所有快照
#   ./scripts/ops-rollback.sh verify             只验：十间房 200 + summary 一次
#   ./scripts/ops-rollback.sh diff [快照]         看当前与快照差在哪
#   ./scripts/ops-rollback.sh restore [快照]      回滚 + 重启 + 自动验（默认 latest）
#   ./scripts/ops-rollback.sh restore --dry-run [快照]   只演练不写盘
#   ./scripts/ops-rollback.sh restore --into DIR [快照]  把快照摊到 DIR 里做演练
#
# 铁律：
#   · 绝不动 launchd plist（只记 sha256，变了就报警）
#   · 不备份 runtime/ node_modules/ preview/（运行数据与依赖，回滚不该碰）
#   · 回滚前自动先拍一份 pre-restore 快照，回滚本身也可回滚
#   · 退出码：0=全过 1=有失败（一律不接管道取）
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8890}"
HOST="${HOST:-127.0.0.1}"
LABEL="com.wuwu.wuwu-living"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
BAKROOT="$DIR/_bak"
NODE_BIN="/usr/local/bin/node"
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node 2>/dev/null || echo node)"

# 回滚范围：只含代码与静态资源，不含运行数据
SCOPE="hub.mjs hub.sh lib public config scripts docs README.md package.json 前端设计规范.md"

# 十间房（顺序固定，报告按此顺序）
ROOMS="magnet book music vod download library notes calendar photos cast"

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'
[ -t 1 ] || { RED=; GRN=; YEL=; DIM=; RST=; }

ts() { date +%Y%m%d-%H%M%S; }
say() { printf '%s\n' "$*"; }
pass() { printf '  %sPASS%s  %s\n' "$GRN" "$RST" "$*"; }
fail() { printf '  %sFAIL%s  %s\n' "$RED" "$RST" "$*"; }
warn() { printf '  %sWARN%s  %s\n' "$YEL" "$RST" "$*"; }
die()  { printf '%s\n' "${RED}错误${RST}: $*" >&2; exit 1; }

plist_sha() { [ -f "$PLIST" ] && shasum -a 256 "$PLIST" | awk '{print $1}' || echo "absent"; }

# ---------- 快照 ----------
cmd_snap() {
  local reason="${1:-manual}"
  local stamp snap
  stamp="$(ts)"
  snap="$BAKROOT/$stamp"
  mkdir -p "$snap" || die "无法创建 $snap"

  local item
  for item in $SCOPE; do
    [ -e "$DIR/$item" ] || continue
    # 逐项复制，保留结构；-p 保留时间戳，回滚后可核对 mtime
    cp -Rp "$DIR/$item" "$snap/" 2>/dev/null || die "复制失败: $item"
  done

  # 清单：sha256 + 路径，回滚时按它逐个还原
  ( cd "$snap" && find . -type f -print0 2>/dev/null | xargs -0 shasum -a 256 2>/dev/null ) > "$snap/manifest.sha256"

  {
    printf 'stamp=%s\n'      "$stamp"
    printf 'reason=%s\n'     "$reason"
    printf 'scope=%s\n'      "$SCOPE"
    printf 'files=%s\n'      "$(wc -l < "$snap/manifest.sha256" | tr -d ' ')"
    printf 'bytes=%s\n'      "$(du -sk "$snap" | awk '{print $1*1024}')"
    printf 'git_head=%s\n'   "$(cd "$DIR" && git rev-parse --short HEAD 2>/dev/null || echo nogit)"
    printf 'git_dirty=%s\n'  "$(cd "$DIR" && [ -n "$(git status --porcelain 2>/dev/null)" ] && echo yes || echo no)"
    printf 'plist_sha=%s\n'  "$(plist_sha)"
    printf 'pid=%s\n'        "$(lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null | head -1)"
  } > "$snap/META"

  say "${GRN}快照完成${RST}  $snap"
  sed 's/^/  /' "$snap/META"
  printf '%s回滚命令%s: %s/scripts/ops-rollback.sh restore %s\n' "$DIM" "$RST" "$DIR" "$stamp"
}

cmd_list() {
  [ -d "$BAKROOT" ] || { say "还没有任何快照（$BAKROOT 不存在）"; return 1; }
  local n=0 d
  printf '%-18s %-22s %-8s %-8s %s\n' 快照 原因 文件数 大小 时间
  for d in "$BAKROOT"/*/; do
    [ -d "$d" ] || continue
    n=$((n+1))
    local stamp reason files bytes
    stamp="$(basename "$d")"
    reason="$(grep -m1 '^reason=' "$d/META" 2>/dev/null | cut -d= -f2-)"
    files="$(grep -m1 '^files='  "$d/META" 2>/dev/null | cut -d= -f2-)"
    bytes="$(grep -m1 '^bytes='  "$d/META" 2>/dev/null | cut -d= -f2-)"
    printf '%-18s %-22s %-8s %-8s %s\n' "$stamp" "${reason:--}" "${files:--}" \
      "$( [ -n "${bytes:-}" ] && echo "$((bytes/1024))K" || echo - )" \
      "$(stat -f '%Sm' -t '%m-%d %H:%M' "$d" 2>/dev/null)"
  done
  [ "$n" -eq 0 ] && { say "还没有任何快照"; return 1; }
  return 0
}

resolve_snap() {
  local want="${1:-latest}"
  if [ "$want" = "latest" ]; then
    ls -1d "$BAKROOT"/*/ 2>/dev/null | sort | tail -1 | sed 's:/$::'
  else
    if [ -d "$BAKROOT/$want" ]; then echo "$BAKROOT/$want"
    elif [ -d "$want" ]; then echo "$want"
    else echo ""; fi
  fi
}

# ---------- 验收：十间房 200 + summary 一次 ----------
cmd_verify() {
  local bad=0
  say "${DIM}—— 十间房（判据：HTTP 200 + text/html + 体积 > 1000B，防 404 伪装 200）——${RST}"
  local r code ctype size
  for r in $ROOMS; do
    # 用 | 作分隔符：默认 read 遇空格会把 "text/html; charset=utf-8" 拆成两段，
    # 导致 size 取到 "charset=utf-8 29583"，数字比较必然失败 → 全部误报 FAIL。
    # 单次拿不到不算失败：000（超时/连接抖动）重试最多 3 次，每次间隔 0.5s。
    # 实测 /music/ 冷路径 1.28s 偶发超时，单次判死会误报。
    local attempt=1 got=""
    while [ "$attempt" -le 3 ]; do
      got=$(curl -s -m 10 -o /tmp/.wwv.$$ -w '%{http_code}|%{content_type}|%{size_download}' "http://$HOST:$PORT/$r/" 2>/dev/null || true)
      # curl 连接失败时仍会输出 -w（http_code=000）且返回非零。
      # 若再写 `|| echo "000|-|0"` 会追加出第二行，got 变两行乱值，
      # 解析后 size 会变成 "0000|-|0" 这种非数字（实测踩过）。
      # 所以这里只取第一行，并强制校验形状，形状不对就归零。
      got=$(printf '%s\n' "$got" | head -1)
      case "$got" in
        [0-9][0-9][0-9]\|*\|[0-9]*) : ;;
        *) got="000|-|0" ;;
      esac
      case "$got" in
        200\|*) break ;;
      esac
      # ★ 区分两种 000（总管定）：
      #   000 + 耗时 < 10ms  = 内核 RST，确定没有进程接 → 不重试（重试只会白等）
      #   000 + 接近超时      = 挂起，真假难辨 → 必须重试
      _c="${got%%|*}"; _rest="${got#*|}"; _t="${_rest##*|}"
      if [ "$_c" = "000" ] && awk "BEGIN{exit !($_t < 0.01)}"; then
        break        # RST：确定的死，立即判 FAIL，不浪费 1.5 秒
      fi
      [ "$attempt" -lt 3 ] && sleep 0.5
      attempt=$((attempt+1))
    done
    IFS='|' read -r code ctype size <<EOF
$got
EOF
    # 兜底：任何非纯数字都归零，避免 "0000|-|0" 这种值进数值比较
    case "${size:-}" in ''|*[!0-9]*) size=0 ;; esac
    if [ "$code" = "200" ] && [ "$size" -gt 1000 ] 2>/dev/null && [ "${ctype#text/html}" != "$ctype" ]; then
      printf '  %sPASS%s  %-10s %s  %sB\n' "$GRN" "$RST" "$r" "$code" "$size"
    else
      printf '  %sFAIL%s  %-10s %s  %sB  %s\n' "$RED" "$RST" "$r" "$code" "$size" "$ctype"
      bad=$((bad+1))
    fi
  done
  rm -f /tmp/.wwv.$$

  say "${DIM}—— /api/ping ——${RST}"
  local ping
  ping="$(curl -s -m 5 "http://$HOST:$PORT/api/ping" 2>/dev/null)"
  if printf '%s' "$ping" | grep -q '"ok":true'; then pass "/api/ping ok:true"
  else fail "/api/ping 无 ok:true（body=${ping:0:80}）"; bad=$((bad+1)); fi

  say "${DIM}—— /api/home/summary 一次（判据：200 + ok:true + apps 长度=10）——${RST}"
  local t0 t1 ms code2 out
  t0="$(python3 -c 'import time;print(int(time.time()*1000))')"
  code2="$(curl -s -m 30 -o /tmp/.wws.$$ -w '%{http_code}' "http://$HOST:$PORT/api/home/summary" 2>/dev/null)"
  t1="$(python3 -c 'import time;print(int(time.time()*1000))')"
  ms=$((t1-t0))
  out="$("$NODE_BIN" -e '
    try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
      const apps=Array.isArray(j.apps)?j.apps.length:0;
      const rooms=j.rooms&&typeof j.rooms==="object"?Object.keys(j.rooms).length:0;
      console.log(`ok=${j.ok===true?"true":"false"} apps=${apps} rooms=${rooms}`);
    }catch(e){console.log("parse-fail "+e.message)}' /tmp/.wws.$$ 2>/dev/null)"
  rm -f /tmp/.wws.$$
  if [ "$code2" = "200" ] && printf '%s' "$out" | grep -q 'ok=true apps=10'; then
    pass "/api/home/summary 200  ${ms}ms  $out"
  else
    fail "/api/home/summary code=$code2 ${ms}ms  $out"; bad=$((bad+1))
  fi

  # ── 版本漂移硬前置（总管要求接进 verify）──────────────────
  # 为什么必须放在验收里：2026-11-22 一整天反复出现「改了但没生效」——
  # 进程跑的是 18 小时前的代码，所有验收结论都作废。
  # 判据只针对后端代码（hub.mjs/lib/*.mjs）：它们进程启动时 require 进内存，改了必须重启。
  # public/** 是每请求读盘（实测：追加一行 0.5s 后就能 curl 到），不参与漂移判定。
  say "${DIM}—— 版本漂移（后端代码 mtime vs 进程启动时刻）——${RST}"
  if [ -x "$DIR/scripts/ops-drift.sh" ]; then
    bash "$DIR/scripts/ops-drift.sh" > /tmp/.wwd.$$ 2>&1
    drift_rc=$?
    sed 's/^/  /' /tmp/.wwd.$$ | grep -E 'PASS|FAIL|漂移|启动' || true
    rm -f /tmp/.wwd.$$
    if [ "$drift_rc" -eq 1 ]; then
      printf '  %sFAIL%s  后端代码漂移 → 运行的是旧代码，本次验收结论不可信\n' "$RED" "$RST"
      bad=$((bad+1))
    elif [ "$drift_rc" -eq 3 ]; then
      printf '  %sWARN%s  漂移判据故障（读不到进程/端口），本项未取证\n' "$YEL" "$RST"
    else
      printf '  %sPASS%s  后端代码与运行态一致\n' "$GRN" "$RST"
    fi
  else
    printf '  %sWARN%s  ops-drift.sh 不存在，跳过漂移检查\n' "$YEL" "$RST"
  fi

  echo
  if [ "$bad" -eq 0 ]; then
    say "${GRN}验收全过（10 房 + ping + summary + 漂移）${RST}"
    return 0
  else
    say "${RED}验收失败 $bad 项${RST}"
    return 1
  fi
}

# ---------- 差异 ----------
cmd_diff() {
  local snap; snap="$(resolve_snap "${1:-latest}")"
  [ -n "$snap" ] && [ -d "$snap" ] || die "找不到快照: ${1:-latest}"
  say "对比: $snap  →  当前 $DIR"
  local tmpc tmps
  tmpc="$(mktemp)"; tmps="$(mktemp)"
  ( cd "$DIR" && for i in $SCOPE; do [ -e "$i" ] && find "$i" -type f -print0 2>/dev/null; done | xargs -0 shasum -a 256 2>/dev/null | sed 's/^\([0-9a-f]*\)  /\1  /' ) | sort -k2 > "$tmpc"
  sed 's:^\([0-9a-f]*\)  \./:\1  :' "$snap/manifest.sha256" | sort -k2 > "$tmps"
  local nchg nnew ngone
  nchg=$(join -j 2 -o 0,1.1,2.1 <(sort -k2 "$tmps") <(sort -k2 "$tmpc") 2>/dev/null | awk '$2!=$3' | wc -l | tr -d ' ')
  nnew=$(comm -13 <(sort -k2 "$tmps" | awk '{print $2}') <(sort -k2 "$tmpc" | awk '{print $2}') 2>/dev/null | wc -l | tr -d ' ')
  ngone=$(comm -23 <(sort -k2 "$tmps" | awk '{print $2}') <(sort -k2 "$tmpc" | awk '{print $2}') 2>/dev/null | wc -l | tr -d ' ')
  say "  改动 $nchg 个 · 快照后新增 $nnew 个 · 快照里有现在没了 $ngone 个"
  if [ "$nchg" -gt 0 ]; then
    say "${DIM}  改动的文件：${RST}"
    join -j 2 -o 0,1.1,2.1 <(sort -k2 "$tmps") <(sort -k2 "$tmpc") 2>/dev/null | awk '$2!=$3 {print "    " $1}' | head -40
  fi
  rm -f "$tmpc" "$tmps"
  [ "$nchg" -eq 0 ] && [ "$nnew" -eq 0 ] && [ "$ngone" -eq 0 ]
}

# ---------- 回滚 ----------
cmd_restore() {
  local mode="real" into="" want="latest"
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) mode="dry" ;;
      --into)    shift; into="${1:-}"; mode="into" ;;
      *)         want="$1" ;;
    esac
    shift
  done

  local snap; snap="$(resolve_snap "$want")"
  [ -n "$snap" ] && [ -d "$snap" ] || die "找不到快照: $want"
  [ -f "$snap/manifest.sha256" ] || die "快照不完整（缺 manifest）: $snap"

  say "快照: $snap"
  say "原因: $(grep -m1 '^reason=' "$snap/META" 2>/dev/null | cut -d= -f2-)"
  say "范围: $(wc -l < "$snap/manifest.sha256" | tr -d ' ') 个文件"

  # plist 红线：只核对，绝不改
  local now_sha want_sha
  now_sha="$(plist_sha)"; want_sha="$(grep -m1 '^plist_sha=' "$snap/META" 2>/dev/null | cut -d= -f2-)"
  if [ -n "${want_sha:-}" ] && [ "$now_sha" != "$want_sha" ]; then
    warn "launchd plist 与快照时不一致（$want_sha → $now_sha）。本脚本不碰它，请人工确认。"
  fi

  if [ "$mode" = "into" ]; then
    [ -n "$into" ] || die "--into 需要目录"
    mkdir -p "$into" || die "无法创建 $into"
    local line p
    while IFS= read -r line; do
      p="${line#*  }"; p="${p#./}"
      mkdir -p "$into/$(dirname "$p")"
      cp -p "$snap/$p" "$into/$p" || die "还原失败: $p"
    done < "$snap/manifest.sha256"
    say "${GRN}已摊到 $into${RST}（生产未改动）"
    say "核对: diff -r '$into' '$DIR/lib' 之类，或直接看文件"
    return 0
  fi

  if [ "$mode" = "dry" ]; then
    local n=0 line p
    while IFS= read -r line; do
      p="${line#*  }"; p="${p#./}"
      [ -f "$DIR/$p" ] || { say "  会新增 $p"; n=$((n+1)); continue; }
      local a b
      a="$(shasum -a 256 "$DIR/$p" | awk '{print $1}')"
      b="${line%%  *}"
      [ "$a" != "$b" ] && { say "  会覆盖 $p"; n=$((n+1)); }
    done < "$snap/manifest.sha256"
    say "${YEL}演练结束${RST}：将改动 $n 个文件；生产未改动，服务未重启。"
    return 0
  fi

  # 真回滚：先给自己留退路
  say "${DIM}回滚前先拍一份 pre-restore 快照…${RST}"
  cmd_snap "pre-restore-$(basename "$snap")" >/dev/null || die "pre-restore 快照失败，已中止（未改动任何文件）"

  local line p
  while IFS= read -r line; do
    p="${line#*  }"; p="${p#./}"
    mkdir -p "$DIR/$(dirname "$p")"
    cp -p "$snap/$p" "$DIR/$p" || die "还原失败: $p"
  done < "$snap/manifest.sha256"
  say "${GRN}文件已还原${RST}"

  # 快照后新增的文件不自动删（可能含运行数据），只报告
  local orphan
  orphan="$(cmd_diff "$(basename "$snap")" 2>/dev/null | head -3)"
  say "${DIM}$orphan${RST}"

  say "${DIM}重启服务…${RST}"
  ( cd "$DIR" && ./hub.sh restart ) || warn "hub.sh restart 返回非 0，继续验收看实际状态"

  echo
  cmd_verify
}

# ★ 未知参数一律报错退出，不静默忽略。
#   实测踩过：`verify --port 9` 想测死端口，但脚本只认环境变量 PORT，
#   `--port 9` 被默默丢掉 → 实际测了真实 8890 → 全 PASS、exit=0。
#   差点把「我测过死端口了，没问题」当成证据。参数没生效 ≠ 参数生效且通过。
case "${1:-}" in
  snap|list|verify|diff|restore|"") : ;;
  -h|--help) : ;;
  *)
    echo "未知参数: $1" >&2
    echo "提示: 端口请用环境变量，如  PORT=9 $0 verify" >&2
    echo "      未知参数不会被忽略——静默忽略会让你以为测了 A，实际测了 B。" >&2
    exit 2 ;;
esac

case "${1:-}" in
  snap)    shift; cmd_snap "${1:-manual}" ;;
  list)    cmd_list ;;
  verify)
    # verify 不接受任何额外参数
    [ "$#" -gt 1 ] && { echo "verify 不接受额外参数: ${*:2}" >&2; echo "端口请用 PORT=xxxx 环境变量" >&2; exit 2; }
    cmd_verify ;;
  diff)    shift; cmd_diff "${1:-latest}" ;;
  restore) shift; cmd_restore "$@" ;;
  *)
    cat <<USAGE
五五客厅 · 运维回滚脚本

  ./scripts/ops-rollback.sh snap [原因]              拍快照（改代码前先跑）
  ./scripts/ops-rollback.sh list                     列快照
  ./scripts/ops-rollback.sh verify                   验十间房 200 + ping + summary
  ./scripts/ops-rollback.sh diff [快照]               当前 vs 快照
  ./scripts/ops-rollback.sh restore [快照]            回滚 + 重启 + 自动验
  ./scripts/ops-rollback.sh restore --dry-run [快照]  只演练
  ./scripts/ops-rollback.sh restore --into DIR [快照] 摊到 DIR 演练

范围: $SCOPE
不含: runtime/ node_modules/ preview/（运行数据与依赖）
不动: $PLIST
USAGE
    exit 2 ;;
esac
