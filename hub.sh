#!/bin/bash
# 五五客厅 · 启停脚本
# 用法: ./hub.sh start|stop|restart|status|log|open|install|uninstall
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8890}"
HOST="${HOST:-127.0.0.1}"
URL="http://${HOST}:${PORT}/"
LOG="/tmp/wuwu-living.log"
ERRLOG="/tmp/wuwu-living.err.log"
PIDFILE="/tmp/wuwu-living.pid"
LABEL="com.wuwu.wuwu-living"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
UID_NUM="$(id -u)"

NODE_BIN="/usr/local/bin/node"
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node 2>/dev/null || true)"

health() {
  curl -sf --max-time 2 "http://${HOST}:${PORT}/api/ping" >/dev/null 2>&1
}

loaded() {
  launchctl print "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1
}

wait_health() {
  for _ in $(seq 1 40); do
    health && return 0
    sleep 0.25
  done
  return 1
}

write_plist() {
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${DIR}/hub.mjs</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>${PORT}</string>
    <key>HOST</key>
    <string>${HOST}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Standard</string>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${LOG}</string>
  <key>StandardErrorPath</key>
  <string>${ERRLOG}</string>
</dict>
</plist>
PLISTEOF
}

install_agent() {
  # 先收掉手动起的实例，避免和 launchd 抢 8890
  stop >/dev/null 2>&1 || true
  write_plist
  launchctl bootout "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/${UID_NUM}" "$PLIST" 2>/dev/null || true
  if wait_health; then
    echo "已注册开机自启并启动（launchd: ${LABEL}）  →  $URL"
  else
    echo "已注册 ${LABEL}，但服务还没起来；试 ./hub.sh restart，日志在 $ERRLOG"
    return 1
  fi
}

start() {
  if health; then echo "已在运行  →  $URL"; return 0; fi

  if [ -f "$PLIST" ]; then
    if ! loaded; then
      launchctl bootstrap "gui/${UID_NUM}" "$PLIST" 2>/dev/null || true
    fi
    launchctl kickstart -k "gui/${UID_NUM}/${LABEL}" 2>/dev/null || true
  else
    [ -x "$NODE_BIN" ] || { echo "未找到 node"; exit 1; }
    cd "$DIR" || exit 1
    PORT="$PORT" HOST="$HOST" nohup "$NODE_BIN" hub.mjs >>"$LOG" 2>&1 &
    echo $! >"$PIDFILE"
  fi

  if wait_health; then
    echo "已启动  →  $URL"
    [ -f "$PLIST" ] && echo "由 launchd 托管，掉线会自动拉起"
  else
    echo "启动失败，最后 20 行日志："
    tail -n 20 "$LOG" 2>/dev/null
    tail -n 20 "$ERRLOG" 2>/dev/null
    return 1
  fi
}

stop() {
  local did=0
  if loaded; then launchctl bootout "gui/${UID_NUM}/${LABEL}" 2>/dev/null && did=1; fi
  if [ -f "$PIDFILE" ]; then
    local pid; pid="$(cat "$PIDFILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null && did=1; fi
    rm -f "$PIDFILE"
  fi
  [ "$did" = 1 ] && echo "已停止" || echo "未在运行"
}

status() {
  if health; then
    local summary
    summary=$(curl -s --max-time 3 "http://${HOST}:${PORT}/api/status" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for a in d['apps']:
    if a.get('id') == 'book':
        s = '本地引擎'
    else:
        s='在线' if a.get('running') else ('未打开' if a.get('kind')=='app' else '离线')
    print('  %-6s %s' % (a['name'], s))
" 2>/dev/null)
    if loaded; then echo "运行中（launchd 托管）  →  $URL"; else echo "运行中  →  $URL"; fi
    [ -n "$summary" ] && echo "$summary"
    return 0
  fi
  if loaded; then echo "launchd 已加载，但服务没响应；试 ./hub.sh restart"; return 1; fi
  echo "未在运行"
  return 1
}

case "${1:-start}" in
  start)     start ;;
  stop)      stop ;;
  restart)   stop; sleep 0.6; start ;;
  status)    status ;;
  log)       tail -n 80 -f "$LOG" "$ERRLOG" ;;
  open)      health || start; command -v open >/dev/null && open "$URL" || echo "$URL" ;;
  install)   install_agent ;;
  uninstall) stop; rm -f "$PLIST" "$PIDFILE"; echo "已取消开机自启" ;;
  *) echo "用法: $0 start|stop|restart|status|log|open|install|uninstall" ;;
esac
