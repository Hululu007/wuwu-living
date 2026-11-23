#!/bin/bash
# 五五客厅 · 项目纪律自检（可执行版）
#
# 2026-11-22 一天里，有三件事让全组互相否定过，没有一件是产品缺陷：
#   ① grep -rln 跑飞 → load 145、78% CPU、25 分钟 → 所有「慢」的测量失真
#   ② 测试夹具抢占 8811 → 5 次 EADDRINUSE → 「8811 反复崩溃」部分是我们自己造的
#   ③ 重启未预告 → 5+ 次 → 多人把正常重启误判为故障
#
# 这个脚本把 ②③ 变成可执行的检查，不再靠人记住。
#
# ── 判据两份实现、常量单一来源（不必同步改，但改实现要两边都跑）─────
#   本脚本:            check_uptime()          （bash，人手动排查用，带 pid/etime 明细）
#   scripts/health-audit.mjs: classifyUptime() （node，体检报告的一部分，判 unverified）
#   窗口时长已抽到 config/ops-thresholds.json 的 restartWindowSec（唯一来源），
#   两侧都读它 —— 改一处即两侧同时生效，不必再手动同步。
#   2026-11-22 16:38 做过同一时刻交叉校验：五端口判定完全一致（数值差 ≤1s 为时间流逝）。
# ────────────────────────────────────────────────────────────
#
# 用法:
#   ./scripts/ops-discipline.sh            全量自检
#   ./scripts/ops-discipline.sh ports      只查端口占用是否干净
#   ./scripts/ops-discipline.sh fixtures   只查 19000+ 夹具是否合规
#   ./scripts/ops-discipline.sh uptime     查端口是否在重启窗口内（数字暂不可采信）
#   ./scripts/ops-discipline.sh logs       查日志落点是否有 /tmp 残留（两份真相）
#   ./scripts/ops-discipline.sh restart    重启前调用（记录预告）
#
# 退出码（取时不要接管道）:
#   0 = 干净   1 = 有告警   2 = 环境不洁（结论不可信）   3 = 判据故障
#   ★ 重启窗口内只提示、不计告警：重启不是缺陷，否则每次重启后 5 分钟内都退 1，
#     人会开始无视这个脚本（告警疲劳）。这与 health-audit 判 unverified 同一语义。
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_PORTS="8811 8890 1122 7788 8317 12010"
FIXTURE_RANGE="19000-19999"
RESTART_LOG="$DIR/docs/ops/restarts.log"
# 滞留观察的跨次状态（记录 pid 的上次 CPU 累计时间与首次观测时刻）
FIXTURE_WATCH="$DIR/docs/ops/.fixture-watch.state"
FIXTURE_STAGNANT_MIN="${FIXTURE_STAGNANT_MIN:-5}"

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'
if [ ! -t 1 ]; then RED=; GRN=; YEL=; DIM=; RST=; fi

FAIL=0; WARN=0; INFO=0

# 每个项目端口的「合法占用者」进程名关键字
owner_of() {
  case "$1" in
    8811)  echo "server.mjs" ;;        # 聆听音乐网页版
    8890)  echo "hub.mjs" ;;           # 五五客厅
    1122)  echo "reader" ;;            # Reader
    7788)  echo "magnet" ;;            # 磁力搜索
    8317)  echo "workbuddy" ;;         # workbuddy 网关
    12010) echo "grok" ;;              # grok 网关
    *)     echo "" ;;
  esac
}

check_ports() {
  echo "${DIM}—— 项目端口占用（非项目进程占用 = 测量环境不洁）——${RST}"
  local p port owner cmd pid bad=0
  for port in $PROJECT_PORTS; do
    pid="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1)"
    if [ -z "$pid" ]; then
      printf '  %s空闲%s  %s\n' "$DIM" "$RST" "$port"
      continue
    fi
    # ★ ps 会把路径里的中文转义成 M-gM^[M^X 这类乱码（实测：8811 的
    #   "聆听音乐网页版/server.mjs" 变成 "M-iM-!M-5...M-gM^IM^H/server.mjs"）。
    #   所以不能拿整条 command 去 grep 中文路径，只能匹配**尾部文件名**——
    #   文件名是 ASCII，转义不影响。
    cmd="$(ps -o command= -p "$pid" 2>/dev/null | cut -c1-160)"
    # ★ 不能只取 $NF：7788 的命令行是 `mx.mjs serve 7788`，$NF 是端口号 "7788"，
    #   取到的是数字而不是文件名（实测踩过，导致 mx.mjs 被显示成 "7788"）。
    #   正确做法：从所有参数里找第一个以 .mjs/.js/.py 结尾的，取它的 basename。
    tail_name="$(printf '%s' "$cmd" | tr ' ' '\n' \
      | grep -E '\.(mjs|js|cjs|py|sh)$' | head -1 | sed 's#.*/##')"
    # 兜底：没有脚本文件名时退回 $NF
    [ -z "${tail_name:-}" ] && tail_name="$(printf '%s' "$cmd" | awk '{print $NF}' | sed 's#.*/##')"
    owner="$(owner_of "$port")"
    if [ -n "$owner" ] && { printf '%s' "$tail_name" | grep -qi "$owner" || printf '%s' "$cmd" | grep -qi "$owner"; }; then
      printf '  %sOK%s    %-6s pid=%-7s %s\n' "$GRN" "$RST" "$port" "$pid" "$tail_name"
    else
      printf '  %s不洁%s  %-6s pid=%-7s %s\n' "$RED" "$RST" "$port" "$pid" "$cmd"
      printf '        %s← 不是预期进程（期望含 "%s"）。这会让所有该端口的测量结论失真。%s\n' "$DIM" "$owner" "$RST"
      bad=$((bad+1))
    fi
  done
  if [ "$bad" -gt 0 ]; then
    echo "  ${RED}FAIL${RST}  $bad 个项目端口被非预期进程占用 → 测量环境不洁，别拿这个窗口的数字下结论"
    FAIL=$((FAIL+1))
  else
    echo "  ${GRN}PASS${RST}  项目端口占用干净"
  fi
}

check_fixtures() {
  echo "${DIM}—— 测试夹具（必须在 $FIXTURE_RANGE，且带 WUWU_RUNTIME_DIR）——${RST}"
  local found=0 bad=0 p port rtd cmd ports rtdir active=""
  # ★ 为什么改成「按端口反查」而不是「按名字匹配」（2026-11-22 实测）：
  #   原实现 pgrep 后 grep -qiE "hang|fixture|fake|probe-|test-server"，
  #   我起了一个叫 x.mjs 的夹具监听 19500，它报「PASS 未发现测试夹具（干净）」——
  #   夹具改个名字就查不到，这是假绿。而「谁在监听 19000-19999」是客观事实，与名字无关。
  # ★ 排除规则：只把「监听 19000-19999 且没有 WUWU_RUNTIME_DIR」判为不合规；
  #   本机当前该段监听数为 0，不存在误伤正常开发服务的问题（若将来有，白名单加在这里）。
  # ★ 2026-11-22 修正（一次真实的假红）：原实现把「19000-19999 有监听且无
  #   WUWU_RUNTIME_DIR」一律判不合规。实测有成员用 Chrome 远程调试端口 19844
  #   做真浏览器探针，被报成「夹具不合规」，让整轮 ops-discipline 退 2。
  #   浏览器/调试工具的调试端口不是夹具，它没有共享运行时状态可污染。
  #   排除规则只针对「确知不是夹具」的进程名，不做宽泛白名单。
  local NOT_FIXTURE_RE='Google Chrome|Chromium|Microsoft Edge|Safari|firefox|playwright|chromedriver'
  for p in $(lsof -nP -iTCP:19000-19999 -sTCP:LISTEN -t 2>/dev/null | sort -u); do
    cmd="$(ps -o command= -p "$p" 2>/dev/null)"
    if printf '%s' "$cmd" | grep -qE "$NOT_FIXTURE_RE"; then
      printf '  %s跳过%s  pid=%-7s 端口=%-10s 浏览器/调试工具调试端口，非夹具\n' \
        "$DIM" "$RST" "$p" "$(lsof -nP -a -p "$p" -iTCP:19000-19999 -sTCP:LISTEN 2>/dev/null | awk 'NR>1{split($9,a,":"); print a[length(a)]}' | sort -u | tr '\n' ',' | sed 's/,$//')"
      continue
    fi
    found=$((found+1))
    env="$(ps eww -o command= -p "$p" 2>/dev/null)"
    rtd="$(printf '%s' "$env" | tr ' ' '\n' | awk -F= '$1=="WUWU_RUNTIME_DIR"{print $2; exit}')"
    ports="$(lsof -nP -a -p "$p" -iTCP:19000-19999 -sTCP:LISTEN 2>/dev/null | awk 'NR>1{split($9,a,":"); print a[length(a)]}' | sort -u | tr '\n' ',' | sed 's/,$//')"
    # ★ 2026-11-22 修正（一次真实的假红）：原实现把所有「无 WUWU_RUNTIME_DIR」
    #   一律判 FAIL。实测 3 个 node srv.mjs 里，2 个 PPID=1（父进程已死、被 init
    #   收编 = 真正的遗弃夹具），1 个父进程仍在（= 别人正在跑的测试）。
    #   别人跑测试时整轮 ops-discipline 就退 2，等于「有人在干活」被判成「环境脏」，
    #   会逼所有人不敢跑测试。区分办法：PPID=1 是遗弃，必须清；PPID 存活是活跃，
    #   只提示不判红（它跑完自己会退）。
    local ppid_now
    ppid_now="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')"
    # ★ 竞态守卫（2026-11-22 实测）：lsof 列出 pid 后、读 ps 之前进程可能已退出，
    #   此时 ppid_now 为空、ports 为空，会被误判成「PPID=1 的遗弃夹具」并计入 FAIL。
    #   连跑三次遗弃数 2/2/3 就是它造成的（多出一个 pid=端口=无 的幽灵）。
    #   进程已经不在了就不是夹具问题，直接跳过，也不计入 found。
    if [ -z "${ppid_now:-}" ]; then
      found=$((found-1))
      printf '  %s已退%s  pid=%-7s 扫描时已退出（竞态），不计入\n' "$DIM" "$RST" "$p"
      continue
    fi
    # ★ 2026-11-22 第二次修正（上一版留下的盲区）：
    #   上一版把「PPID=1」的判断嵌在「无 runtime」分支里，于是**带 runtime 的遗弃夹具
    #   被判 OK**。实测 pid=10356 ./hub-fixture-t6.mjs 有 WUWU_RUNTIME_DIR=/tmp/ww-t6、
    #   PPID=1、已存活 29 分钟、CPU 13s（早跑完了），判据却报 `OK`。
    #   runtime 目录只说明「它声明了隔离」，不说明「还有人会来收它」——
    #   有 runtime 的遗弃夹具同样占端口、同样污染 19000 段。
    #   所以 PPID=1 的判定必须提到 runtime 检查之前，与 runtime 无关。
    if [ "${ppid_now:-1}" = "1" ]; then
      # ★ 2026-11-22 第三次修正（差点误杀一个正在跑的测试）：
      #   pid=76778 node hub.mjs 端口 19079 PPID=1、runtime=/tmp/ww-vod79，
      #   按「PPID=1 就是遗弃」本应判红；但它有一条 ESTABLISHED 到 :8900 ——
      #   它正在跑 vod 冷路径测试，几分钟后自己退了。
      #   父进程死 ≠ 进程没用：nohup/后台化 + shell 退出都会让 PPID=1，
      #   而真正在干活的实例仍在读写、仍有连接。
      #   所以 PPID=1 只算「没人回收」，必须再有「确实不动」的证据才判遗弃。
      # ★ 2026-11-22 第四次修正（判据抖动）：连接数是瞬时量，同一条连接在
      #   短连接场景下会被下一次采样漏掉。实测同一个 pid=88526 连跑 5 次，
      #   判定在「遗弃 / 在跑」之间反复跳（遗弃[] / 在跑[88526] / 遗弃[88526 ...]）。
      #   判据自己抖动比判错更糟——人会对它失去信任。
      #   修法：两次采样（间隔 1s）任一次见到活动就算在跑；只有两次都静默才判遗弃。
      local est_cnt recent_w est2
      _live_probe() {
        local q="$1" e w r="$2"
        e="$(lsof -nP -a -p "$q" -iTCP -sTCP:ESTABLISHED 2>/dev/null | awk 'NR>1' | wc -l | tr -d ' ')"
        w=0
        if [ -n "$r" ] && [ -d "$r" ]; then
          w="$(find "$r" -newermt '-120 seconds' -type f 2>/dev/null | wc -l | tr -d ' ')"
        fi
        echo "$e $w"
      }
      read -r est_cnt recent_w <<< "$(_live_probe "$p" "${rtd:-}")"
      if [ "${est_cnt:-0}" -eq 0 ] && [ "${recent_w:-0}" -eq 0 ]; then
        sleep 1
        read -r est2 recent_w <<< "$(_live_probe "$p" "${rtd:-}")"
        est_cnt="${est2:-0}"
      fi
      if [ "${est_cnt:-0}" -gt 0 ] || [ "${recent_w:-0}" -gt 0 ]; then
        printf '  %s在跑%s  pid=%-7s 端口=%-10s PPID=1 但仍有活动（连接 %s 条 / 近 2 分钟写入 %s 个文件）  %s\n' \
          "$YEL" "$RST" "$p" "${ports:-无}" "$est_cnt" "$recent_w" "$(printf '%s' "$cmd" | cut -c1-40)"
        printf '        %s← 父进程已死但仍在工作（典型：nohup 后台任务）。不判红；跑完应自行退出%s\n' "$DIM" "$RST"
        active="$active $p"
      else
        printf '  %s遗弃%s  pid=%-7s 端口=%-10s PPID=1（父进程已死）无连接无写入 runtime=%s  %s\n' \
          "$RED" "$RST" "$p" "${ports:-无}" "${rtd:-无}" "$(printf '%s' "$cmd" | cut -c1-40)"
        printf '        %s← 没人会回收它，也没在干活，必须手动清%s\n' "$DIM" "$RST"
        bad=$((bad+1))
      fi
      continue
    fi
    # 走到这里的都是「没死」的夹具：有主、PPID 存活。记下它们供后面的滞留判据用。
    active="$active $p"
    if [ -z "${rtd:-}" ]; then
      printf '  %s活跃%s  pid=%-7s 端口=%-10s 无 runtime 但 PPID=%s（有人在跑）  %s\n' \
        "$YEL" "$RST" "$p" "${ports:-无}" "${ppid_now:-?}" "$(printf '%s' "$cmd" | cut -c1-45)"
      printf '        %s← 有主，不判红；跑完应自行退出。若长期不退再查%s\n' "$DIM" "$RST"
    else
      rtdir="$rtd"
      case "$rtdir" in
        /tmp/*|/var/folders/*) : ;;
        *) printf '  %s警告%s  pid=%-7s 端口=%-10s runtime 不在临时目录: %s\n' \
             "$YEL" "$RST" "$p" "${ports:-无}" "$rtdir"
           bad=$((bad+1)); continue ;;
      esac
      printf '  %sOK%s    pid=%-7s 端口=%-10s runtime=%s\n' "$GRN" "$RST" "$p" "${ports:-无}" "$rtd"
    fi
  done

  # 补充：命令行明显是夹具却占了项目端口的（这条仍按名字，只作为兜底提醒，不参与 FAIL）
  local hijack
  for p in $(pgrep -f "node" 2>/dev/null); do
    cmd="$(ps -o command= -p "$p" 2>/dev/null)"
    printf '%s' "$cmd" | grep -qiE "hang|fixture|/fx|fake|probe-|test-server" || continue
    ports="$(lsof -nP -a -p "$p" -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1{split($9,a,":"); print a[length(a)]}' | tr '\n' ',' | sed 's/,$//')"
    case ",$ports," in
      *",1122,"*|*",7788,"*|*",8317,"*|*",8811,"*|*",8890,"*|*",12010,"*)
        printf '  %s违规%s  pid=%-7s 端口=%-10s 夹具抢占了项目端口  %s\n' \
          "$RED" "$RST" "$p" "$ports" "$(printf '%s' "$cmd" | cut -c1-60)"
        bad=$((bad+1)) ;;
    esac
  done

  # ---------- 滞留观察（活跃但 CPU 零增长） ----------
  # ★ 为什么需要（2026-11-22 实测）：pid=50832 node hub.mjs 端口 19077 只跑了 90 秒，
  #   父进程刚死、PPID 变 1 之前，判据判它「活跃（有主）」——但观察 30 秒发现
  #   CPU 0:10.44 → 0:10.44 零增长、runtime 零写入，其实已经是死残留。
  #   只靠 PPID 会漏掉这段「父进程刚死、还没到明显遗弃」的窗口。
  #
  # ★ 但它只报「观察」，绝不计入 FAIL：夹具跑完一个用例后等下一个用例时，
  #   CPU 本来就不增长。若判红，正常跑测试的人会被反复警告 ——
  #   与脚本头部「重启不是缺陷，否则告警疲劳」同一条理由。
  #   判据是「零增长」+「超龄」两条同时成立，且需要跨次采样（单次看不出来）。
  if [ -n "$active" ]; then
    local now_s prev_line pid_k prev_cpu first_s cur_cpu cur_s
    now_s="$(date +%s)"
    local newstate="" flag=0
    for pid_k in $active; do
      cur_cpu="$(ps -o time= -p "$pid_k" 2>/dev/null | tr -d ' ')"
      [ -z "$cur_cpu" ] && continue
      cur_s="$(awk -F'[:.]' '{ if (NF==3) print $1*3600+$2*60+$3; else print $1*60+$2 }' <<< "$cur_cpu" 2>/dev/null)"
      [ -z "$cur_s" ] && continue
      prev_line="$(grep "^$pid_k " "$FIXTURE_WATCH" 2>/dev/null | head -1)"
      if [ -n "$prev_line" ]; then
        prev_cpu="$(printf '%s' "$prev_line" | awk '{print $2}')"
        first_s="$(printf '%s' "$prev_line" | awk '{print $3}')"
      else
        prev_cpu=""; first_s="$now_s"
      fi
      if [ -n "$prev_cpu" ] && [ "$cur_s" = "$prev_cpu" ]; then
        local age=$(( (now_s - first_s) / 60 ))
        if [ "$age" -ge "$FIXTURE_STAGNANT_MIN" ]; then
          local pk
          pk="$(lsof -nP -a -p "$pid_k" -iTCP:19000-19999 -sTCP:LISTEN 2>/dev/null | awk 'NR>1{split($9,a,":"); print a[length(a)]}' | sort -u | tr '\n' ',' | sed 's/,$//')"
          printf '  %s观察%s  pid=%-7s 端口=%-10s CPU 已 %s 分钟零增长（累计 %s）\n' \
            "$DIM" "$RST" "$pid_k" "${pk:-无}" "$age" "$cur_cpu"
          printf '        %s← 可能已跑完只是没退；有主不判红，但若继续不动就该问一句%s\n' "$DIM" "$RST"
          flag=$((flag+1))
        fi
      fi
      # CPU 变了就重置首次观测时刻，避免「曾经涨过又停」被累计成超龄
      if [ -n "$prev_cpu" ] && [ "$cur_s" != "$prev_cpu" ]; then
        first_s="$now_s"
      fi
      newstate="$newstate$pid_k $cur_s $first_s"$'\n'
    done
    # 只保留仍在活跃列表里的 pid，其余清掉（进程退了就不该留状态）
    printf '%s' "$newstate" > "$FIXTURE_WATCH" 2>/dev/null || true
    if [ "$flag" -gt 0 ]; then INFO=$((INFO+flag)); fi
  else
    : > "$FIXTURE_WATCH" 2>/dev/null || true
  fi

  if [ "$found" -eq 0 ] && [ "$bad" -eq 0 ]; then
    echo "  ${GRN}PASS${RST}  未发现测试夹具（$FIXTURE_RANGE 无监听）"
  elif [ "$bad" -gt 0 ]; then
    echo "  ${RED}FAIL${RST}  $bad 个夹具不合规"
    FAIL=$((FAIL+1))
  else
    echo "  ${GRN}PASS${RST}  $found 个夹具全部合规"
  fi
}

# ── 重启窗口：采样前必须知道「这个窗口刚被重启过」 ──
# 为什么加（2026-11-22 已造成三次误判）：
#   运维管家复核基线时 api/status 出现 2/20 超 500ms，追下去发现那两次正好落在
#   8890 重启窗口（pid 31353 → 38430，16:22:04）。冷启动首个请求要建连接、读配置、
#   填缓存，把它算进稳态基线，会把「刚重启」误判成「接口变慢」。
# ★ macOS 的 ps 没有 etimes（Linux 才有），只能读 etime 自己换算。
# ★ 窗口期不是「不洁」，只是「数字不可采信」——所以算 WARN，不算 FAIL。
# 阈值从共享配置读，不在脚本里写死（2026-11-22：300s 曾在两处各写一遍）
THRESH="$DIR/config/ops-thresholds.json"
_thresh() {
  [ -f "$THRESH" ] || return 1
  python3 -c "import json,sys;print(json.load(open('$THRESH')).get('$1',''))" 2>/dev/null
}
UPTIME_WINDOW="${UPTIME_WINDOW:-$(_thresh restartWindowSec)}"
[ -z "$UPTIME_WINDOW" ] && UPTIME_WINDOW=300

parse_etime() {
  # "05:12"(分:秒) / "01:02:03"(时:分:秒) / "3-01:02:03"(天-时:分:秒) → 秒
  printf '%s' "$1" | awk -F'[-:]' '{
    if (NF==4) print $1*86400 + $2*3600 + $3*60 + $4;
    else if (NF==3) print $1*3600 + $2*60 + $3;
    else if (NF==2) print $1*60 + $2;
    else print "";
  }'
}

check_uptime() {
  echo "${DIM}—— 重启窗口（窗口期内的性能数字不可采信，但不是故障）——${RST}"
  local port pid et up hot=0
  for port in 8811 8890 7788 8317 12010; do
    pid="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1)"
    [ -z "$pid" ] && continue
    et="$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ')"
    up="$(parse_etime "$et")"
    if [ -z "$up" ]; then
      printf '  %s警告%s  %-6s pid=%-7s 运行时长读不到（etime="%s"）\n' "$YEL" "$RST" "$port" "$pid" "$et"
      WARN=$((WARN+1)); continue
    fi
    # 窗口内只记 INFO，不计 WARN：重启不是缺陷，也不该让每次重启后 5 分钟
    # 内 `all` 都退 1（那会变成告警疲劳，人就开始无视这个脚本）。
    # 与 health-audit 对同一事实判 unverified 保持同一语义。
    if [ "$up" -lt "$UPTIME_WINDOW" ]; then
      printf '  %s窗口内%s %-6s pid=%-7s 仅启动 %ss（< %ss）→ 现在采样会把冷启动算成变慢\n' \
        "$YEL" "$RST" "$port" "$pid" "$up" "$UPTIME_WINDOW"
      hot=$((hot+1)); INFO=$((INFO+1))
    else
      printf '  %sOK%s    %-6s pid=%-7s 已运行 %ss\n' "$GRN" "$RST" "$port" "$pid" "$up"
    fi
  done
  if [ "$hot" -gt 0 ]; then
    echo "  ${YEL}提示${RST}  $hot 个端口在 ${UPTIME_WINDOW}s 重启窗口内，等窗口过后再采基线（不计告警）"
  else
    echo "  ${GRN}PASS${RST}  无端口处于重启窗口"
  fi
}

# ── 日志落点：同一条日志不许有两份真相 ──
# 为什么加（2026-11-22 亲历）：
#   把 8811 日志从 /tmp 迁到 ~/Library/Logs 之后，/tmp 那两份旧文件还留着。
#   于是同一件事有两个文件：查根因时看到哪份取决于你 ls 了哪个目录，
#   而 /tmp 那份是死的（8811 的 fd 已不指向它），它的 mtime 永远停在迁移那一刻——
#   很容易被当成「日志没在写」的假证据（当天就有人这样误判过一次）。
# 判据：持久目录存在，且 /tmp 下没有同名的 lting 日志。
#   /tmp 残留 → WARN（不是不洁，是容易误导；但也绝不该长期留着）
check_log_place() {
  echo "${DIM}—— 日志落点（同一日志不许有两份真相）——${RST}"
  local dir="$HOME/Library/Logs/lingting" stale=0 f
  if [ ! -d "$dir" ]; then
    printf '  %sFAIL%s  持久日志目录不存在: %s\n' "$RED" "$RST" "$dir"
    FAIL=$((FAIL+1)); return
  fi
  printf '  %sOK%s    持久目录: %s\n' "$GRN" "$RST" "$dir"
  for f in /tmp/lting.log /tmp/lting.err.log /tmp/lting.out.log; do
    [ -f "$f" ] || continue
    printf '  %s警告%s  /tmp 残留死文件: %s（%s 字节，mtime %s）\n' \
      "$YEL" "$RST" "$f" "$(wc -c < "$f" | tr -d ' ')" "$(date -r "$f" '+%m-%d %H:%M')"
    printf '        %s← 服务已不再写它；留着会让「日志没在写」看起来像真的%s\n' "$DIM" "$RST"
    stale=$((stale+1))
  done
  if [ "$stale" -gt 0 ]; then
    echo "  ${YEL}提示${RST}  $stale 份 /tmp 残留，确认内容已归档后应删除"
    WARN=$((WARN+1))
  else
    printf '  %sPASS%s  /tmp 无 lting 日志残留\n' "$GRN" "$RST"
  fi
}

do_restart() {
  # 重启前调用：记录预告，让「谁在什么时候重启了什么」有账可查
  local svc="${1:-8890}"
  local secs="${2:-5}"
  local stamp; stamp="$(date '+%Y-%m-%d %H:%M:%S')"
  mkdir -p "$(dirname "$RESTART_LOG")"
  printf '%s  RESTART 服务=%s 预计中断=%ss 操作人=%s\n' "$stamp" "$svc" "$secs" "${USER:-wuwu}" >> "$RESTART_LOG"
  echo "${YEL}已记录重启预告${RST}: $svc 预计中断 ${secs}s"
  echo "${DIM}  日志: $RESTART_LOG${RST}"
  echo "${DIM}  ★ 群里也要说一句，否则别人会把你的重启误判成故障${RST}"
  echo "${DIM}    今天已有 5+ 次误判（fetch failed / ERR_CONNECTION_REFUSED / 整站 000）${RST}"
  # ★ 2026-11-22：回归正在跑时重启会把测试弄脏（实测两次假红：
  #   toast-behavior 报 library「window.toast 未加载」、整轮 fetch failed，
  #   而稳定后单跑 8/8 全过）。这里只提示、不阻断——重启有时是必要的。
  local lockfile="$DIR/runtime/regress.lock"
  if [ -f "$lockfile" ]; then
    echo "${RED}⚠ 检测到回归正在运行${RST}: $(cat "$lockfile" 2>/dev/null | tr -d '\n')"
    echo "${DIM}  现在重启会让回归结果失真。若必须重启，建议先等它跑完，"
    echo "  或事后重跑受影响的套件（toast-behavior / loading-state 依赖真实服务）。${RST}"
  fi
}

case "${1:-all}" in
  ports)    check_ports ;;
  fixtures) check_fixtures ;;
  uptime)   check_uptime ;;
  logs)     check_log_place ;;
  restart)  shift; do_restart "${1:-8890}" "${2:-5}" ;;
  all)
    echo "${DIM}五五客厅 · 纪律自检  $(date '+%m-%d %H:%M:%S')${RST}"
    check_ports
    echo
    check_fixtures
    echo
    check_uptime
    echo
    check_log_place
    echo
    if [ "$FAIL" -gt 0 ]; then
      echo "${RED}结论: 环境不洁 —— 此窗口的测量结论不可信${RST}"
    elif [ "$WARN" -gt 0 ]; then
      echo "${YEL}结论: $WARN 项告警${RST}"
    elif [ "$INFO" -gt 0 ]; then
      echo "${GRN}结论: 环境干净${RST}${DIM}（$INFO 个端口在重启窗口内：数字暂不可采信，不是故障）${RST}"
    else
      echo "${GRN}结论: 环境干净，可以采信测量${RST}"
    fi ;;
  *) echo "用法: $0 [all|ports|fixtures|uptime|logs|restart [服务] [秒数]]" >&2; exit 3 ;;
esac

[ "$FAIL" -gt 0 ] && exit 2
[ "$WARN" -gt 0 ] && exit 1
exit 0
