#!/bin/bash
# 五五客厅 · 常驻监控（第 7 步）
#
# 为什么要有这个脚本：2026-11-22，8890 从 launchd 注销、全组 7 个人十几分钟零告警。
# 三样东西同时骗人：
#   launchctl print → state=running（服务已注销时也可能读到旧态）
#   lsof 有监听     → 窗口期内有/无交替
#   pid 存在        → 进程在但 accept 后不回包
# 唯一可信判据 = 真实 HTTP 请求。
#
# ── 与 ops-8811.sh 的分工（别合并）──────────────────────────
#   本脚本 = 监控探针：定时跑、只报存活、三值退出码（0 全过 / 1 告警 / 2 故障）
#   ops-8811.sh = 诊断工具：人手动跑、看细节、六值退出码
#     0=ALIVE 1=DEGRADED 2=DEAD 3=HUNG 4=判据故障 5=IMPOSTOR
#   8811 的存活判定在 ops-8811.sh 里做，本脚本只管 8890 客厅三条。
#   常驻链路：com.wuwu.wuwu-living-guard → ops-guard.sh → 两者
# ────────────────────────────────────────────────────────────
#
# 用法:
#   ./scripts/ops-monitor.sh            全量三条检查
#   ./scripts/ops-monitor.sh entry      只查入口存活
#   ./scripts/ops-monitor.sh supervisor 只查托管项存在
#   ./scripts/ops-monitor.sh isolation  只查实验实例隔离
#   ./scripts/ops-monitor.sh --json     机器可读（给 launchd/告警用）
#
# 退出码（取时不要接管道）:
#   0 = 全过   1 = 有告警(WARN)   2 = 有故障(FAIL)   3 = 判据自身故障
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="${LABEL:-com.wuwu.wuwu-living}"
PORT="${PORT:-8890}"
HOST="${HOST:-127.0.0.1}"
URL="http://${HOST}:${PORT}/api/status"
PATTERN="hub.mjs"

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'
if [ ! -t 1 ]; then RED=; GRN=; YEL=; DIM=; RST=; fi

FAIL=0; WARN=0
JSON=""
add_json() { JSON="$JSON${JSON:+,}$1"; }

# ---------- 1. 入口存活 ----------
# 判据：3 次真实请求，必须全 200。任何一次非 200 都记下来。
# 不用「3 次里 2 次通过」的宽松阈值：入口是全站唯一入口，抖动本身就是故障。
check_entry() {
  local ok=0 detail="" i=1
  while [ "$i" -le 3 ]; do
    local probe code t
    probe="$(curl -s -o /dev/null -m 8 -w '%{http_code}|%{time_total}' "$URL" 2>/dev/null)"
    [ -z "$probe" ] && probe="000|0"
    code="${probe%%|*}"; t="${probe##*|}"
    if [ "$code" = "200" ]; then
      ok=$((ok+1))
    else
      if [ "$code" = "000" ]; then
        if awk "BEGIN{exit !($t < 0.01)}"; then detail="$detail RST"; else detail="$detail TIMEOUT(${t}s)"; fi
      else
        detail="$detail HTTP$code"
      fi
    fi
    i=$((i+1))
  done

  if [ "$ok" -eq 3 ]; then
    echo "  ${GRN}PASS${RST}  入口存活        $URL → 3/3 200"
    add_json "{\"check\":\"entry\",\"status\":\"pass\",\"ok\":3,\"total\":3}"
  else
    echo "  ${RED}FAIL${RST}  入口存活        $URL → $ok/3 200  ${DIM}${detail}${RST}"
    add_json "{\"check\":\"entry\",\"status\":\"fail\",\"ok\":$ok,\"total\":3,\"detail\":\"$(echo $detail | tr -d '\n')\"}"
    FAIL=$((FAIL+1))
  fi
}

# ---------- 1b. 房间可用性（不是只看 /api/status） ----------
# ★ 为什么必须有这一条（2026-11-22 实测漏判）：
#   `/api/status` 在房间反代上游挂掉时**仍然返回 200**（它只报告自己的状态）。
#   今天 `/magnet/` 因 7788 死掉返回 502，而 `ops-monitor` 全程 EXIT=0 —— 房间坏了监控不知道。
#   `/api/status` 是「客厅进程活着」，房间 200 才是「用户点得进去」，两者不能互相替代。
check_rooms() {
  local bad=0 total=0 detail=""
  local r code
  for r in magnet book music vod download library notes calendar photos cast; do
    total=$((total+1))
    code="$(curl -s -o /dev/null -m 8 -w '%{http_code}' "http://$HOST:$PORT/$r/" 2>/dev/null)"
    if [ "$code" != "200" ]; then
      bad=$((bad+1))
      detail="$detail $r=$code"
    fi
  done

  if [ "$bad" -eq 0 ]; then
    echo "  ${GRN}PASS${RST}  房间可用性      10 间房全 200"
    add_json "{\"check\":\"rooms\",\"status\":\"pass\",\"ok\":$total,\"total\":$total}"
  else
    echo "  ${RED}FAIL${RST}  房间可用性      $((total-bad))/$total 正常，异常:${detail}"
    add_json "{\"check\":\"rooms\",\"status\":\"fail\",\"bad\":$bad,\"detail\":\"$(echo $detail | tr -d ' ')\"}"
    FAIL=$((FAIL+1))
  fi
}

# ---------- 2. 托管项存在 ----------
# 判据：launchctl print 能查到。今天它整个消失了，没有任何告警。
# 注意：这一条通过 ≠ 服务可用（state=running 会骗人），所以它只做旁证。
#       真正判活是 check_entry；两条都要过。
check_supervisor() {
  local out
  out="$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null)"
  if [ -z "$out" ]; then
    echo "  ${RED}FAIL${RST}  托管项存在      $LABEL → 查不到（服务已从 launchd 注销）"
    add_json "{\"check\":\"supervisor\",\"status\":\"fail\",\"label\":\"$LABEL\"}"
    FAIL=$((FAIL+1))
    return
  fi
  local state pid runs lexit
  state="$(printf '%s\n' "$out" | awk -F'= ' '/^[[:space:]]*state = /{print $2; exit}' | tr -d ' ')"
  pid="$(printf '%s\n' "$out" | awk -F'= ' '/^[[:space:]]*pid = /{print $2; exit}' | tr -d ' ')"
  runs="$(printf '%s\n' "$out" | awk -F'= ' '/^[[:space:]]*runs = /{print $2; exit}' | tr -d ' ')"
  # launchctl 在「从未退出过」时输出的是文本 `(never exited)`，不是数字。
  # 若直接 tr -d ' ' 会压成 `(neverexited)`，被下面的 !=0/!=143 判定当成异常退出码，
  # 于是刚恢复的健康服务被误报 WARN（实测踩过：pid=21920 刚 bootstrap 就报）。
  # 所以只保留纯数字，非数字一律归 0。
  lexit="$(printf '%s\n' "$out" | awk -F'= ' '/last exit code = /{print $2; exit}' | tr -d ' ')"
  case "${lexit:-}" in
    ''|*[!0-9]*) lexit=0 ;;   # (neverexited) / 空 / 任何非纯数字 → 视为 0
  esac

  # 固定指纹：state=running 但 last exit code != 0 且非 143(SIGTERM 正常重启)
  # → launchd 认为在跑，但上一代是异常退出的，必须当作可疑去验
  if [ -n "${lexit:-}" ] && [ "$lexit" != "0" ] && [ "$lexit" != "143" ]; then
    echo "  ${YEL}WARN${RST}  托管项存在      $LABEL state=$state pid=${pid:--} runs=${runs:--} lastExit=$lexit ${DIM}← launchd 报 running 但上代异常退出${RST}"
    add_json "{\"check\":\"supervisor\",\"status\":\"warn\",\"state\":\"$state\",\"pid\":\"${pid:-}\",\"lastExit\":\"$lexit\"}"
    WARN=$((WARN+1))
  else
    echo "  ${GRN}PASS${RST}  托管项存在      $LABEL state=$state pid=${pid:--} runs=${runs:--} lastExit=${lexit:-0}"
    add_json "{\"check\":\"supervisor\",\"status\":\"pass\",\"state\":\"$state\",\"pid\":\"${pid:-}\"}"
  fi
}

# ---------- 2b. 上游托管项（房间能起来的前提） ----------
# ★ 为什么必须有这一条（2026-11-22 实测漏判）：
#   `/magnet/` 返回 502 时，根因是 7788 死了 —— 而 7788 **当时根本不在 launchd 里**，
#   所以它挂了不会自动拉起，房间永久 502。
#   `ops-monitor` 只查客厅自己的托管项（com.wuwu.wuwu-living），上游掉了完全看不见。
#   「房间 200」是当下能进，「上游被托管」是坏了能自己好 —— 两件事。
#
# 判据分两类（不能一刀切判 FAIL）：
#   · 声明了 LABEL 的上游：查 launchctl print，查不到 = WARN（房间仍可能当下可用）
#   · 没有 LABEL 的上游（nohup+pidfile 型）：只记录，判 INFO，不判红
#     因为「不用 launchd」是一种选择，不是缺陷；但它确实意味着挂了不会自动恢复。
check_upstreams() {
  local warn=0 info=0
  # 格式：id|port|launchd标签（空=无托管）
  local list="magnet|7788|com.wuwu.magnet-search
music|8811|com.wuwu.lingting.web
vod|8900|com.wuwu.qingkan.vod"
  local line id port lbl state
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    id="${line%%|*}"; line="${line#*|}"
    port="${line%%|*}"; lbl="${line#*|}"
    # ★ 2026-11-22 修正（后端管家与我都提过）：原实现每上游只探 1 次，
    #   瞬时抖动（GC/连接排队/刚好在重启）会直接把 PASS 变成 WARN，
    #   让人去查一个没坏的托管项。改为：首次失败后间隔 1s 重试，最多 3 次，
    #   任一次 200 即算通过。三次全失败才判「当下不可用」。
    #   注意：重试只影响「当下」这个数字，不影响「托管项是否存在」的判定——
    #   托管丢失是 launchctl 查不到，与请求成败无关。
    local attempt=1
    state="000"
    while [ "$attempt" -le 3 ]; do
      state="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://127.0.0.1:$port/" 2>/dev/null)"
      [ "$state" = "200" ] && break
      state="000"
      [ "$attempt" -lt 3 ] && sleep 1
      attempt=$((attempt+1))
    done
    if [ -z "$lbl" ]; then
      printf '  %s提示%s  %-8s :%s 无 launchd 托管（nohup+pidfile）当下=%s %s
' \
        "$YEL" "$RST" "$id" "$port" "$state" \
        "$([ "$state" = "200" ] && echo '← 能用，但挂了不会自己起来' || echo '← 已不可用且不会自动恢复')"
      info=$((info+1))
    elif launchctl print "gui/$(id -u)/$lbl" >/dev/null 2>&1; then
      printf '  %sPASS%s  %-8s :%s 托管=%s 当下=%s\n' "$GRN" "$RST" "$id" "$port" "$lbl" "$state"
    else
      printf '  %sWARN%s  %-8s :%s 托管项丢失（%s 未加载）当下=%s ← 挂了不会自动拉起\n' \
        "$YEL" "$RST" "$id" "$port" "$lbl" "$state"
      warn=$((warn+1))
    fi
  done <<< "$list"

  if [ "$warn" -gt 0 ]; then
    add_json "{\"check\":\"upstreams\",\"status\":\"warn\",\"warn\":$warn}"
    WARN=$((WARN+1))
  else
    add_json "{\"check\":\"upstreams\",\"status\":\"pass\",\"info\":$info}"
  fi
}

# ---------- 3. 实验实例隔离 ----------
# 判据：任何 PORT != 8890 的 hub.mjs 实例，必须带 WUWU_RUNTIME_DIR。
# 否则它会和正式实例共用 runtime/ 的 json 与 .instance.lock ——
# 今天 8896 那个实例就是这样起来的（虽然它带了 /tmp/ww-bh-rt，属正确做法）。
check_isolation() {
  local found=0 bad=0 lines=""
  local p
  for p in $(pgrep -f "[${PATTERN:0:1}]${PATTERN:1}" 2>/dev/null); do
    found=$((found+1))
    local env port rtd
    env="$(ps eww -o command= -p "$p" 2>/dev/null)"
    port="$(printf '%s' "$env" | tr ' ' '\n' | awk -F= '$1=="PORT"{print $2; exit}')"
    rtd="$(printf '%s' "$env" | tr ' ' '\n' | awk -F= '$1=="WUWU_RUNTIME_DIR"{print $2; exit}')"
    [ -z "${port:-}" ] && port="8890"   # 没设 PORT 时 hub.mjs 默认 8890
    if [ "$port" != "8890" ]; then
      if [ -z "${rtd:-}" ]; then
        bad=$((bad+1))
        lines="$lines\n    ${RED}违规${RST} pid=$p PORT=$port 无 WUWU_RUNTIME_DIR（与正式实例共用 runtime/）"
      else
        lines="$lines\n    ${GRN}正常${RST} pid=$p PORT=$port runtime=$rtd"
      fi
    else
      lines="$lines\n    ${DIM}正式${RST} pid=$p PORT=8890"
    fi
  done

  if [ "$found" -eq 0 ]; then
    echo "  ${YEL}WARN${RST}  实验实例隔离    未找到任何 hub.mjs 进程"
    add_json "{\"check\":\"isolation\",\"status\":\"warn\",\"instances\":0}"
    WARN=$((WARN+1))
  elif [ "$bad" -gt 0 ]; then
    echo "  ${RED}FAIL${RST}  实验实例隔离    $bad 个实例未隔离"
    printf "$lines\n"
    add_json "{\"check\":\"isolation\",\"status\":\"fail\",\"violations\":$bad,\"instances\":$found}"
    FAIL=$((FAIL+1))
  else
    echo "  ${GRN}PASS${RST}  实验实例隔离    $found 个实例全部合规"
    printf "$lines\n"
    add_json "{\"check\":\"isolation\",\"status\":\"pass\",\"instances\":$found}"
  fi
}

# ---------- 6. 数据语义一致性（HTTP 200 不等于数据自洽） ----------
# ★ 为什么必须有（2026-11-22 实测，运维判据的盲区）：
#   `/api/vod/recs` 返回 200，房间检查 PASS，但其中一条 source 是
#       { ok: true, count: 241, error: "超时 2.5s 无响应" }
#   —— 前端会同时显示「成功 241 条」和「超时」。ok 与 error 是两个独立变量：
#   ok = items.length > 0（有数据就算成功），fatal 记首个错误（部分请求超时也有值），
#   两个一起输出就自相矛盾。
#   check_rooms 只判 HTTP 200，**这类矛盾永远是绿的**。
#   所以「200」只能证明「服务在应答」，不能证明「应答说得通」。
check_semantic() {
  local body out n bad silent
  body="$(curl -s -m 20 "http://$HOST:$PORT/api/vod/recs" 2>/dev/null)"
  if [ -z "$body" ]; then
    printf '  %s提示%s  vod/recs 取不到响应，跳过语义检查（不判红）\n' "$DIM" "$RST"
    add_json '{"check":"semantic","status":"skip"}'
    return
  fi
  out="$(printf '%s' "$body" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try{
    const j=JSON.parse(s); const src=j.sources||[];
    const bad=src.filter(x=>x.ok===true && x.error);
    const weird=src.filter(x=>x.ok===false && !x.error);
    console.log("TOTAL "+src.length);
    console.log("CONTRADICT "+bad.length);
    bad.forEach(x=>console.log("BAD "+x.name+" ok=true err="+JSON.stringify(x.error)));
    console.log("SILENT "+weird.length);
    weird.forEach(x=>console.log("W "+x.name));
  }catch(e){console.log("PARSE_ERR "+e.message);}
})' 2>/dev/null)"
  if printf '%s' "$out" | grep -q "PARSE_ERR"; then
    printf '  %s提示%s  vod/recs 返回无法解析，跳过语义检查\n' "$DIM" "$RST"
    add_json '{"check":"semantic","status":"skip"}'
    return
  fi
  n="$(printf '%s\n' "$out" | awk '/^TOTAL /{print $2}')"
  bad="$(printf '%s\n' "$out" | awk '/^CONTRADICT /{print $2}')"
  silent="$(printf '%s\n' "$out" | awk '/^SILENT /{print $2}')"
  # ★ 分级判据（2026-11-22 核过前端后的定级）：
  #   前端 vod-recs.js:276-280 只按 ok 分流，`error` 仅在 !ok 时用于脚注。
  #   ⇒ ok=true 却带 error 的站，它的 error **永远不会被渲染**，用户看不见。
  #     这是「数据脏」不是「用户可见缺陷」→ WARN，不判 FAIL。
  #   ⇒ 但 ok=false 且 error 为空，前端会渲染成「电影天堂（）」空括号 → 用户可见 → FAIL。
  #   区分这两者是必要的：把前者判红会让 guard 因一个看不见的脏字段反复告警（告警疲劳），
  #   把后者判绿则用户真的会看到空括号。
  if [ "${silent:-0}" -gt 0 ]; then
    printf '%s\n' "$out" | awk -v r="$RED" -v z="$RST" '/^W /{print "  " r "FAIL" z "  失败但无文案  " substr($0,3)}'
    printf '        %s← ok=false 却无 error：前端会渲染成「站点（）」空括号，用户可见%s\n' "$DIM" "$RST"
    add_json "{\"check\":\"semantic\",\"status\":\"fail\",\"contradict\":${bad:-0},\"silent\":${silent:-0}}"
    FAIL=$((FAIL+1))
  elif [ "${bad:-0}" -gt 0 ]; then
    printf '%s\n' "$out" | awk -v y="$YEL" -v z="$RST" '/^BAD /{print "  " y "WARN" z "  脏字段（前端不渲染）  " substr($0,5)}'
    printf '        %s← ok=true 却带 error；前端只按 ok 分流，这个 error 不会显示，属数据脏而非用户可见缺陷%s\n' "$DIM" "$RST"
    add_json "{\"check\":\"semantic\",\"status\":\"warn\",\"contradict\":${bad:-0},\"silent\":0}"
    WARN=$((WARN+1))
  else
    printf '  %sPASS%s  数据语义一致    %s 个来源，无 ok/error 矛盾\n' "$GRN" "$RST" "${n:-0}"
    add_json "{\"check\":\"semantic\",\"status\":\"pass\",\"sources\":${n:-0}}"
  fi
}

# ---------- 7. 书房状态语义一致性（/api/book/info） ----------
# ★ 后端管家请我定判据，依据是实测的字段语义（不是猜字段名）：
#   正常态：  ok=true  dbOk=true   sources=7538   stale=false
#   失败态：  ok=false dbOk=false  sources=null   stale=true
#   pending：ok=true  dbOk=???     sources=null   stale=true
#
# 三组互斥语义：
#   ① stale=false 时 sources 不能是 null
#      （stale 的含义是「这份数据是旧的、可能不新」，若数据本身为空，
#        那不是「旧」而是「没有」，前端会把 null 画成「0 条书源」——正是 11-22 修过的那条）
#   ② stale=true 时不允许同时 ok=true 且 dbOk=true 且 sources 有值
#      （数据可信却说不可信，属自相矛盾；反向才成立：不可信 → 必须说 stale）
#   ③ dbOk=false 必须配 stale=true
#      （查询失败的数据不可信，标了失败却报新鲜，等于把「没取到」当「取到了」）
#
# ★ 另有一条契约完整性检查（实测发现的真缺陷，2026-11-22）：
#   正常返回有 dbOk 字段，但「失败兜底」与「pending 兜底」两个 return 块**都没有 dbOk**。
#   消费方读 dbOk 会拿到 undefined —— 与 dbOk=false 不等价（undefined 是「没说」，
#   false 是「说了不可信」）。字段缺失比字段为假更容易被静默忽略。
check_semantic_book() {
  local body out bad=0
  body="$(curl -s -m 15 "http://$HOST:$PORT/api/book/info" 2>/dev/null)"
  if [ -z "$body" ]; then
    printf '  %s提示%s  book/info 取不到响应，跳过（不判红）\n' "$DIM" "$RST"
    add_json '{"check":"semanticBook","status":"skip"}'
    return
  fi
  out="$(printf '%s' "$body" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  let j; try{ j=JSON.parse(s); }catch(e){ console.log("PARSE_ERR"); return; }
  const hasDbOk = Object.prototype.hasOwnProperty.call(j,"dbOk");
  const stale = j.stale;
  const sources = j.sources;
  const okv = j.ok;
  console.log("HAS_DBOK "+hasDbOk);
  console.log("STALE "+stale+" SOURCES "+sources+" OK "+okv+" DBOK "+j.dbOk);
  // ① stale=false 但 sources=null
  if (stale === false && sources === null) console.log("V1 stale=false 但 sources=null（把「没有」说成「旧」）");
  /* ★ 2026-11-22 改判（后端管家拆了契约，V2 必须跟着改）：
   *   旧 V2「stale=true 且 dbOk=true 且 sources>0」会**永久误报**：
   *   TTL 刚过期 1 秒时必然出现 stale=true + dbOk=true + sources=7538，
   *   这是正常 SWR 形态（旧值仍可信），不是缺陷。
   *   根因在契约：`stale` 同时承担了「旧」和「不可信」两个含义。
   *   后端已拆成 stale（旧但可信）/ untrusted（查询失败、不可信）两个字段，
   *   且两个前端消费方本来就把 stale 读成「刷新中…」——它的既定语义就是「旧值可信」。
   *   ⇒ 判据必须查 untrusted，不能查 stale。 */
  // ② untrusted=true 却报新鲜：不可信的数据说成新鲜，才是矛盾
  if (j.untrusted === true && stale !== true)
    console.log("V2 untrusted=true 却 stale=false（不可信的数据报成新鲜）");
  // ③ dbOk=false 但 untrusted 未置位
  if (j.dbOk === false && j.untrusted !== true)
    console.log("V3 dbOk=false 却 untrusted 未置位（失败当可信）");
  // ④ dbOk 字段缺失
  if (!hasDbOk) console.log("V4 响应缺 dbOk 字段（消费方读到 undefined，与 false 不等价）");
  // ⑤ 不可信却带着具体条数：最危险的一种（数字会被人当真）
  if (j.untrusted === true && sources !== null)
    console.log("V5 untrusted=true 但 sources 有值（不可信数据仍给出具体条数）");
  // ⑥ 契约完整性：untrusted 必须存在
  if (!Object.prototype.hasOwnProperty.call(j, "untrusted"))
    console.log("V6 响应缺 untrusted 字段（与 V4 缺 dbOk 同类）");
})' 2>/dev/null)"
  if printf '%s' "$out" | grep -q "PARSE_ERR"; then
    printf '  %s提示%s  book/info 返回无法解析，跳过\n' "$DIM" "$RST"
    add_json '{"check":"semanticBook","status":"skip"}'
    return
  fi
  bad="$(printf '%s\n' "$out" | grep -c '^V[0-9] ')"
  if [ "${bad:-0}" -gt 0 ]; then
    printf '%s\n' "$out" | awk -v r="$RED" -v z="$RST" '/^V[0-9] /{print "  " r "FAIL" z "  书房语义矛盾  " substr($0,4)}'
    printf '        %s← %s%s\n' "$DIM" "$(printf '%s\n' "$out" | awk '/^STALE /{print $0}')" "$RST"
    add_json "{\"check\":\"semanticBook\",\"status\":\"fail\",\"violations\":${bad:-0}}"
    FAIL=$((FAIL+1))
  else
    printf '  %sPASS%s  书房语义一致    %s\n' "$GRN" "$RST" "$(printf '%s\n' "$out" | awk '/^STALE /{print $0}')"
    add_json '{"check":"semanticBook","status":"pass"}'
  fi
}

# ---------- 8. 跨端点字段一致性（同一份数据两个端点字段集必须对得上） ----------
# ★ 为什么必须有（2026-11-22 实测）：`book` 这份数据被两个端点各透一次：
#     /api/book/info      → 18 键，含 stale / untrusted / dbOk
#     /api/status 的 book → 只有 pending / stale / ageMs，**untrusted 与 dbOk 都没透出**
#   前端首页（五五客厅.html:902）消费的是 /api/status 那一份，它的三态逻辑是：
#     pending → 「获取中…」   stale → 「刷新中…」   都不是 → 落到真实值（null 会变 '0'）
#   ⇒ 一旦 dbOk=false 但 TTL 未过期，info 侧是 untrusted=true/stale=false/sources=null，
#     status 侧 untrusted 丢失、stale=false ⇒ 首页 blank=null ⇒ 显示「0 条书源」。
#     这是「把没取到伪装成 0」的第三种假空，和 sources/groupTotal 那两条同源。
#
#   判据只查「info 有的语义字段，status 是否也透出」——不比较值（两边取值时机可不同），
#   只比较**字段存在性**。字段缺失比字段为假更容易被静默忽略。
check_xendpoint() {
  local info status out
  info="$(curl -s -m 15 "http://$HOST:$PORT/api/book/info" 2>/dev/null)"
  status="$(curl -s -m 15 "http://$HOST:$PORT/api/status" 2>/dev/null)"
  if [ -z "$info" ] || [ -z "$status" ]; then
    printf '  %s提示%s  取不到响应，跳过跨端点检查（不判红）\n' "$DIM" "$RST"
    add_json '{"check":"xendpoint","status":"skip"}'
    return
  fi
  out="$(printf '%s\n---SPLIT---\n%s' "$info" "$status" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const parts=s.split("\n---SPLIT---\n");
  let a,b;
  try{ a=JSON.parse(parts[0]); b=JSON.parse(parts[1]); }catch(e){ console.log("PARSE_ERR"); return; }
  const bk=(b.apps||[]).find(x=>x.id==="book");
  if(!bk){ console.log("NO_BOOK"); return; }
  // info 侧的语义字段，status 侧必须也有
  const must=["stale","untrusted","dbOk","pending"];
  const missing=must.filter(k=>Object.prototype.hasOwnProperty.call(a,k) && !Object.prototype.hasOwnProperty.call(bk,k));
  console.log("MISSING "+(missing.length?missing.join(","):"-"));
  if(missing.length) console.log("D "+missing.join(","));
})' 2>/dev/null)"
  if printf '%s' "$out" | grep -q "PARSE_ERR"; then
    printf '  %s提示%s  返回无法解析，跳过\n' "$DIM" "$RST"
    add_json '{"check":"xendpoint","status":"skip"}'
    return
  fi
  if printf '%s' "$out" | grep -q "NO_BOOK"; then
    printf '  %s提示%s  /api/status 无 book 项，跳过\n' "$DIM" "$RST"
    add_json '{"check":"xendpoint","status":"skip"}'
    return
  fi
  local missing
  missing="$(printf '%s\n' "$out" | awk '/^MISSING /{print $2}')"
  if [ "$missing" != "-" ] && [ -n "$missing" ]; then
    printf '  %sWARN%s  跨端点字段不一致  /api/book/info 有但 /api/status 的 book 缺: %s\n' \
      "$YEL" "$RST" "$missing"
    printf '        %s← 首页消费的是 status 那一份；缺 untrusted 会让「没取到」显示成「0 条书源」%s\n' "$DIM" "$RST"
    add_json "{\"check\":\"xendpoint\",\"status\":\"warn\",\"missing\":\"$missing\"}"
    WARN=$((WARN+1))
  else
    printf '  %sPASS%s  跨端点字段一致    info 的语义字段 status 全部透出\n' "$GRN" "$RST"
    add_json '{"check":"xendpoint","status":"pass"}'
  fi
}

MODE="${1:-all}"
case "$MODE" in
  --json)
    # 只跑不改，输出一行 JSON
    check_entry >/dev/null; check_rooms >/dev/null; check_supervisor >/dev/null; check_upstreams >/dev/null; check_isolation >/dev/null; check_semantic >/dev/null; check_semantic_book >/dev/null; check_xendpoint >/dev/null
    echo "[$JSON]"
    [ "$FAIL" -gt 0 ] && exit 2
    [ "$WARN" -gt 0 ] && exit 1
    exit 0 ;;
  entry)      echo "${DIM}五五客厅 · 入口存活${RST}"; check_entry ;;
  rooms)      echo "${DIM}五五客厅 · 房间可用性${RST}"; check_rooms ;;
  upstreams)  echo "${DIM}五五客厅 · 上游托管项${RST}"; check_upstreams ;;
  supervisor) echo "${DIM}五五客厅 · 托管项${RST}";   check_supervisor ;;
  isolation)  echo "${DIM}五五客厅 · 实例隔离${RST}"; check_isolation ;;
  semantic)   echo "${DIM}五五客厅 · 数据语义一致性${RST}"; check_semantic ;;
  semantic-book) echo "${DIM}五五客厅 · 书房语义一致性${RST}"; check_semantic_book ;;
  xendpoint)  echo "${DIM}五五客厅 · 跨端点字段一致性${RST}"; check_xendpoint ;;
  all)
    echo "${DIM}五五客厅 · 常驻监控  $(date '+%m-%d %H:%M:%S')${RST}"
    check_entry
    check_rooms
    check_supervisor
    check_upstreams
    check_isolation
    check_semantic
    check_semantic_book
    check_xendpoint
    echo
    if [ "$FAIL" -gt 0 ]; then
      echo "${RED}结论: $FAIL 项故障${RST}"
    elif [ "$WARN" -gt 0 ]; then
      echo "${YEL}结论: $WARN 项告警，无故障${RST}"
    else
      # 不要写死"三条"：检查项会随需求增加，写死会让结论与内容不符（2026-11-22 已发生过）
      echo "${GRN}结论: 全部检查通过${RST}"
    fi ;;
  *) echo "用法: $0 [all|entry|rooms|supervisor|upstreams|isolation|semantic|semantic-book|xendpoint|--json]" >&2; exit 3 ;;
esac

[ "$FAIL" -gt 0 ] && exit 2
[ "$WARN" -gt 0 ] && exit 1
exit 0
