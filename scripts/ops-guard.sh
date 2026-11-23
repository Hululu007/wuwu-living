#!/bin/bash
# 五五客厅 · 常驻监控守护（launchd 每 5 分钟调用）
#
# 职责：跑 ops-monitor.sh，非全过时推送 macOS 通知 + 落告警日志。
#
# 设计要点（都是今天踩过的坑）：
#   1. 判活只认真实 HTTP，不信 launchctl/lsof/pid（它们会假绿）
#   2. 告警要**去重**：同一个故障持续 1 小时不能刷 12 条通知，
#      只在「状态从好变坏」或「连续失败跨过 3 次」时推一次
#   3. 恢复也要报：好回来时推一条，否则用户永远不知道好了没
#   4. 状态文件放 /tmp，不污染项目 runtime/
#
# 用法:
#   ./scripts/ops-guard.sh            正常跑一次（launchd 用这个）
#   ./scripts/ops-guard.sh --force    忽略去重，强制推一条（自检用）
#   ./scripts/ops-guard.sh --status   只看状态文件
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${WW_GUARD_STATE:-/tmp/wuwu-living-guard.state}"    # 上次状态：ok / bad
COUNT="${WW_GUARD_COUNT:-/tmp/wuwu-living-guard.count}"    # 连续失败次数
ALERTLOG="${WW_GUARD_ALERTLOG:-$DIR/docs/ops/alerts.log}"

MODE="${1:-}"

if [ "$MODE" = "--status" ]; then
  echo "状态: $(cat "$STATE" 2>/dev/null || echo '未初始化')"
  echo "连续失败: $(cat "$COUNT" 2>/dev/null || echo 0)"
  echo "告警日志: $ALERTLOG"
  [ -f "$ALERTLOG" ] && tail -10 "$ALERTLOG"
  exit 0
fi

# ── 重启自动记账：不再依赖人记得敲命令 ──
# 为什么必须自动（2026-11-22 实测）：
#   `ops-discipline.sh restart` 只是「记录预告」，写在文档里教人用。
#   今天 8890 重启了两次（16:21:58 / 16:31:35），restarts.log 一条都没有——
#   机制存在但从未被使用过，等于没有。
#   后果是我实测到 11 个入口全 000 时，无法判断「是崩溃还是有人重启」，白查一轮。
# 判据：pid 变了 = 发生过重启。guard 每 5 分钟记一次 pid，变了就补记一条。
# ★ 这是「事后记账」不是「事前预告」，但事后能查清比事前靠人可靠。
PIDFILE="${WW_GUARD_PIDFILE:-/tmp/wuwu-living-guard.pids}"
RESTARTS="${WW_GUARD_RESTARTS:-$DIR/docs/ops/restarts.log}"

# ── 主动停止判据（2026-11-23，运维管家抓到的误报）──────────────────
# 现象：用户在客厅 UI 点「停止」→ hub 记 `spawn music.sh stop (pid N)` 到
# actions.log → 端口没了 → guard 把「用户的主动操作」当「服务挂了」告警。
# 判据：actions.log 里 STOP_WINDOW 秒内存在 `spawn <script> stop` 行
#       ⇒ 该服务是人为停的，guard 不得把它报成故障。
#   · 8811 检查失败 + music.sh 有 stop 记录 → 记 STOPPED(intent)，不算故障
#   · ops-monitor 失败 + 任意 stop 记录 → 告警正文附加「可能是主动停止」
#     （不抑制：入口 8890 挂了永远是真的，没人能从 UI 停 hub）
# 环境变量（测试/隔离用）：
#   WW_ACTIONS_LOG / WW_INTENT_STOP_WINDOW（默认 600 秒）
ACTIONS_LOG="${WW_ACTIONS_LOG:-$HOME/Library/Logs/wuwu-living/actions.log}"
STOP_WINDOW="${WW_INTENT_STOP_WINDOW:-600}"

# 窗口内发生过 stop 的脚本名列表（空输出 = 没有）
recent_stops() {
  [ -f "$ACTIONS_LOG" ] || return 0
  node -e '
    const fs = require("fs");
    const win = Number(process.argv[1]);
    const now = Date.now();
    const hits = new Set();
    for (const l of fs.readFileSync(process.argv[2], "utf8").split("\n")) {
      const m = l.match(/^\[([^\]]+)\] spawn (\S+) stop\b/);
      if (!m) continue;
      const t = Date.parse(m[1]);
      if (!isFinite(t)) continue;
      const age = (now - t) / 1000;
      if (age >= 0 && age <= win) hits.add(m[2]);
    }
    if (hits.size) console.log([...hits].join(" "));
  ' "$STOP_WINDOW" "$ACTIONS_LOG" 2>/dev/null || true
}

# 最近一次 <script> stop 的秒龄；没有输出空并返回 1
stop_age_of() {
  [ -f "$ACTIONS_LOG" ] || return 1
  local age
  age=$(node -e '
    const fs = require("fs");
    const script = process.argv[1];
    const win = Number(process.argv[2]);
    const re = new RegExp("^\\[([^\\]]+)\\] spawn " + script.replace(/[.\\]/g, "\\$&") + " stop\\b");
    const now = Date.now();
    let best = Infinity;
    for (const l of fs.readFileSync(process.argv[3], "utf8").split("\n")) {
      const m = l.match(re);
      if (!m) continue;
      const t = Date.parse(m[1]);
      if (!isFinite(t)) continue;
      const age = (now - t) / 1000;
      if (age >= 0 && age < best) best = age;
    }
    if (best < Infinity && best <= win) console.log(Math.round(best));
  ' "$1" "$STOP_WINDOW" "$ACTIONS_LOG" 2>/dev/null) || return 1
  [ -n "$age" ] || return 1
  echo "$age"
}

record_restarts() {
  mkdir -p "$(dirname "$RESTARTS")" 2>/dev/null
  local cur="" svc port pid old
  for svc_port in "8890:8890" "8811:8811"; do
    svc="${svc_port%%:*}"; port="${svc_port##*:}"
    pid="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1)"
    cur="$cur${svc}=${pid:-none} "
  done
  cur="$(printf '%s' "$cur" | sed 's/ $//')"

  if [ -f "$PIDFILE" ]; then
    old="$(cat "$PIDFILE" 2>/dev/null)"
    if [ "$old" != "$cur" ]; then
      local changed="" ov nv os ns
      for pair in "8890:8890" "8811:8811"; do
        svc="${pair%%:*}"; port="${pair##*:}"
        ov="$(printf '%s' "$old" | tr ' ' '\n' | awk -F= -v k="$svc" '$1==k{print $2}')"
        nv="$(printf '%s' "$cur" | tr ' ' '\n' | awk -F= -v k="$svc" '$1==k{print $2}')"
        if [ "$ov" != "$nv" ]; then
          changed="$changed ${svc}(${ov:-?}→${nv:-?})"
        fi
      done
      # ★ 区分「掉线」与「重启」（2026-11-22 实测误报）：
      #   重启瞬间端口短暂无监听，旧实现一律记 RESTART(auto)，
      #   于是 `8890(68137→none)` 看起来像「重启了一下」，实际是「掉线了、没人接」。
      #   两者对查根因的意义完全不同：前者正常，后者是真故障。
      local kind="RESTART"
      # 三种要分开：掉线（→none）、恢复（none→pid）、重启（pid→pid）
      case "$changed" in
        *"→none"*)  kind="DOWN" ;;
        *"(none→"*) kind="RECOVERED" ;;
      esac
      printf '%s  %s(auto) %s  检测者=ops-guard\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$kind" "$(printf '%s' "$changed" | sed 's/^ //')" >> "$RESTARTS"
      log_alert "${kind}(auto)$changed"
    fi
  fi
  printf '%s\n' "$cur" > "$PIDFILE"
}

notify() {
  local title="$1" body="$2" sound="${3:-Ping}"
  # 测试钩子：WW_GUARD_NOTIFY=0 时跳过真实系统通知（三臂验证用）
  [ "${WW_GUARD_NOTIFY:-1}" = "1" ] || return 0
  # launchd 环境下 osascript 需要显式指定，用绝对路径
  /usr/bin/osascript -e "display notification \"$body\" with title \"$title\" sound name \"$sound\"" >/dev/null 2>&1 || true
}

log_alert() {
  mkdir -p "$(dirname "$ALERTLOG")" 2>/dev/null
  printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$ALERTLOG" 2>/dev/null
}

# 跑监控，取退出码（不接管道）
# 1) 客厅 8890（用户唯一入口，三条检查）
record_restarts

OUT="$(bash "$DIR/scripts/ops-monitor.sh" 2>&1)"
RC=$?

# ── 滞留观察采样（必须挂在 guard 的 5 分钟周期里，否则永远算不出超龄）──
# ★ 为什么需要（2026-11-22 实测）：`ops-discipline.sh fixtures` 的滞留判据
#   靠「跨次记住 CPU 累计时间」算零增长时长，但它只在人手动跑 fixtures 时才采样。
#   没人跑 = 没有样本 = 永远算不出「零增长 5 分钟」。
#   等于「只有被看时才存在」，而这个脚本每 5 分钟就会跑一次，正好是需要的采样频率。
# ★ 只采样，不告警：滞留不是故障（夹具等下一个用例时 CPU 本来就不涨），
#   把它做成告警就会变成告警疲劳。要看的去 `ops-discipline.sh fixtures`。
bash "$DIR/scripts/ops-discipline.sh" fixtures >/dev/null 2>&1 || true

# 2) 音乐房 8811 —— 今天它反复崩溃、端口在听却不回包，一度全组无人发现。
#    判据用 ops-8811.sh（能区分 HUNG 与 DEAD），不并进来就是留了个盲区。
#    注意：8811 挂了不该让客厅判为故障，所以单独记、合并进告警正文即可。
OUT8811="$(bash "$DIR/scripts/ops-8811.sh" -n 10 -t 4 2>&1)"
RC8811=$?
if [ "$RC8811" -ne 0 ]; then
  # 先查是不是用户主动停的（判据：actions.log 有窗口内的 music.sh stop）
  age8811="$(stop_age_of music.sh || true)"
  if [ -n "${age8811:-}" ]; then
    # 主动停止：记一笔（事后可查），不进 FAIL、不抬 rc、不告警
    printf '%s  STOPPED(intent) 8811  music.sh stop 于 %s 秒前（actions.log），guard 不告警\n' \
      "$(date '+%Y-%m-%d %H:%M:%S')" "$age8811" >> "$RESTARTS"
    log_alert "STOPPED(intent)  8811 停止属主动操作（music.sh stop ${age8811}s 前），未告警"
    echo "  SKIP  音乐房8811      主动停止（music.sh stop ${age8811}s 前）——不算故障"
  else
    # 把 8811 的结论行摘出来（ALIVE/HUNG/DEAD/DEGRADED）
    d8811="$(printf '%s\n' "$OUT8811" | grep -E 'HUNG|DEAD|DEGRADED|IMPOSTOR' | head -1 | sed 's/^ *//')"
    [ -z "$d8811" ] && d8811="8811 判据 rc=$RC8811"
    OUT="$OUT
  FAIL  音乐房8811      $d8811"
    # 8811 故障不把整体 rc 抬成 2（客厅才是入口），但至少要让状态变 bad
    [ "$RC" -eq 0 ] && RC=1
  fi
fi

prev="$(cat "$STATE" 2>/dev/null || echo unknown)"
cnt="$(cat "$COUNT" 2>/dev/null || echo 0)"

if [ "$RC" -eq 0 ]; then
  # 恢复正常
  # ★ 只有「上一次明确是 bad」才推恢复通知。
  #   首次运行（prev=unknown）服务本来就正常，不是"恢复"——
  #   否则每次开机/重装状态文件都会推一条假告警（实测踩过）。
  if [ "$prev" = "bad" ]; then
    notify "五五客厅 已恢复" "入口存活 3/3 正常" "Glass"
    log_alert "RECOVERED  入口恢复（上次连续失败 $cnt 次）"
  fi
  echo "ok" > "$STATE"; echo 0 > "$COUNT"
  # ★ 正常时也要留一行痕迹。
  #   否则 launchd 日志为空，无法区分「跑过了没发现问题」和「根本没跑」——
  #   这正是今天 8890 掉线十几分钟无人发现的同类盲区。
  printf '%s  OK  8890=%s  8811=%s\n' "$(date '+%H:%M:%S')" \
    "$(printf '%s\n' "$OUT" | grep -c 'PASS  入口存活')" \
    "$(printf '%s\n' "$OUT8811" 2>/dev/null | grep -cE 'ALIVE')"
  exit 0
fi

# 异常：累计连续失败次数
cnt=$((cnt + 1))
echo "$cnt" > "$COUNT"

# 摘出失败行，作为告警正文
detail="$(printf '%s\n' "$OUT" | grep -E 'FAIL|WARN' | head -3 | sed 's/^ *//' | tr '\n' '；')"
[ -z "$detail" ] && detail="监控返回 $RC"

# 去重策略：
#   第 1 次失败 → 立刻告警（不等到第 3 次，入口挂了要马上知道）
#   之后每 3 次 → 再提醒一次（避免刷屏，又不至于忘了）
should=0
[ "$prev" != "bad" ] && should=1
[ "$cnt" -ge 3 ] && [ $((cnt % 3)) -eq 0 ] && should=1
[ "$MODE" = "--force" ] && should=1

# 告警正文附加「可能是主动停止」注记：窗口内有任意服务的 stop 记录时，
# 房间 502 / 端口不通可能只是人为停的。只注记、不抑制——入口 8890 挂了永远是真的。
stops_note="$(recent_stops)"
if [ -n "$stops_note" ]; then
  detail="$detail；（注：${STOP_WINDOW}s 内有主动停止记录：$stops_note —— 若对应服务是人为停的，这不是故障）"
  log_alert "INTENT-NOTE  告警附注：窗口内有主动停止 $stops_note"
fi

if [ "$should" -eq 1 ]; then
  notify "五五客厅 异常 (连续${cnt}次)" "$detail" "Basso"
  log_alert "ALERT rc=$RC cnt=$cnt  $detail"
fi

echo "bad" > "$STATE"
printf '%s\n' "$OUT"
exit "$RC"
