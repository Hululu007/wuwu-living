#!/usr/bin/env bash
# 投屏真机自检：插上手机后跑这一条，六步全过才算真的能用。
# 用法：bash tools/真机自检.sh [序列号]
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

SERIAL="${1:-}"
BASE="http://127.0.0.1:8890"
ADB="$(command -v adb || echo "$HOME/D盘/bin/scrcpy-5.0.1/adb")"
PASS=0; FAIL=0; SKIP=0

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m✕\033[0m %s\n' "$*"; }
skip() { SKIP=$((SKIP+1)); printf '  \033[33m-\033[0m %s\n' "$*"; }

# 服务在不在
say "0. 客厅服务"
if curl -sf --max-time 5 "$BASE/api/cast/state" >/dev/null; then ok "8890 在听"
else bad "8890 没响应，先跑 ./hub.sh start"; exit 1; fi

# 设备
say "1. 设备"
DEV="$("$ADB" devices | awk 'NR>1 && $2=="device"{print $1}')"
if [ -z "$DEV" ]; then bad "没有已授权设备（adb devices 为空）"; exit 1; fi
SERIAL="${SERIAL:-$(echo "$DEV" | head -1)}"
if echo "$DEV" | grep -qx "$SERIAL"; then ok "已连接 $SERIAL"; else bad "$SERIAL 不在可用列表"; exit 1; fi

MODEL="$("$ADB" -s "$SERIAL" shell getprop ro.product.model 2>/dev/null | tr -d '\r')"
REL="$("$ADB" -s "$SERIAL" shell getprop ro.build.version.release 2>/dev/null | tr -d '\r')"
SDK="$("$ADB" -s "$SERIAL" shell getprop ro.build.version.sdk 2>/dev/null | tr -d '\r')"
SIZE="$("$ADB" -s "$SERIAL" shell wm size 2>/dev/null | tr -d '\r' | awk -F': ' '{print $2}')"
ok "$MODEL / Android $REL (API $SDK) / $SIZE"

say "2. 体检（后端自己的一遍）"
DOC="$(curl -sf --max-time 12 "$BASE/api/cast/doctor" || echo '')"
if [ -n "$DOC" ]; then
  echo "$DOC" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for c in d.get('checks',[]):
    print(('  \033[32m✓\033[0m ' if c['ok'] else '  \033[31m✕\033[0m ')+c['name']+' — '+c['detail'][:80])
" 2>/dev/null
  echo "$DOC" | grep -q '"ok":true' && ok "全部通过" || bad "有项目没通过（看上面）"
else bad "体检接口取不到"; fi

say "3. 截图链路（我自己验证出图，不是只看接口 200）"
SHOT="$(curl -sf --max-time 25 -X POST "$BASE/api/cast/shot" -H 'content-type: application/json' -d "{\"serial\":\"$SERIAL\"}" || echo '')"
[ -n "$SHOT" ] && echo "  $SHOT" | head -c 200 && echo
NAME="$(echo "$SHOT" | python3 -c "import json,sys;print(json.load(sys.stdin).get('name',''))" 2>/dev/null)"
if [ -n "$NAME" ] && [ -f "runtime/cast/shots/$NAME" ]; then
  W="$(python3 -c "
import struct
p='runtime/cast/shots/$NAME'
d=open(p,'rb').read(33)
print(struct.unpack('>II', d[16:24])[0])" 2>/dev/null)"
  ok "出图 $NAME（宽 ${W}px，$(du -h "runtime/cast/shots/$NAME" | cut -f1)）"
  SHOT_OK=1
else bad "截图没落地"; SHOT_OK=0; fi

say "4. 音量链路"
VOL="$(curl -sf --max-time 10 "$BASE/api/cast/volume?serial=$SERIAL" || echo '')"
echo "  $VOL" | head -c 160; echo
if echo "$VOL" | grep -q '"ok":true'; then
  ok "读到媒体音量 $(echo "$VOL" | python3 -c "import json,sys;print(json.load(sys.stdin).get('value'))" 2>/dev/null)"
  if [ "${VOL_SET:-0}" = "1" ]; then
    R="$(curl -sf --max-time 10 -X POST "$BASE/api/cast/volume" -H 'content-type: application/json' -d "{\"value\":30,\"serial\":\"$SERIAL\"}" || echo '')"
    echo "$R" | grep -q '"ok":true' && ok "设音量 30 成功" || bad "设音量失败：$R"
  fi
else bad "读不到音量（该机型可能不支持 media_session）"; fi

say "5. 遥控链路（发一次返回键，验 keyevent 能进去）"
K="$(curl -sf --max-time 10 -X POST "$BASE/api/cast/key" -H 'content-type: application/json' -d "{\"key\":\"back\",\"serial\":\"$SERIAL\"}" || echo '')"
echo "  $K" | head -c 160; echo
echo "$K" | grep -q '"ok":true' && ok "返回键已送达" || bad "返回键没送达"

say "6. 真起一次窗口（默认预设，起来就停）"
S="$(curl -sf --max-time 20 -X POST "$BASE/api/cast/start" -H 'content-type: application/json' -d "{\"preset\":\"default\",\"serial\":\"$SERIAL\"}" || echo '')"
echo "  $S" | head -c 240; echo
if echo "$S" | grep -q '"ok":true'; then
  ok "scrcpy 起来了"
  sleep 3
  ST="$(curl -sf --max-time 8 "$BASE/api/cast/state" || echo '')"
  echo "$ST" | grep -q '"running":true' && ok "3 秒后仍在运行（没秒退）" || bad "进程已退，看日志"
  curl -sf --max-time 10 -X POST "$BASE/api/cast/stop" -H 'content-type: application/json' -d '{}' >/dev/null && ok "已停"
else
  bad "起不来：$(echo "$S" | python3 -c "import json,sys;print(json.load(sys.stdin).get('message',''))" 2>/dev/null)"
  echo "  日志尾巴："
  curl -sf --max-time 8 "$BASE/api/cast/log?lines=10&filter=important" \
    | python3 -c "import json,sys;[print('   ',l) for l in json.load(sys.stdin).get('lines',[])]" 2>/dev/null
fi

say "结果"
printf '  %d 通过 / %d 失败 / %d 跳过\n' "$PASS" "$FAIL" "$SKIP"
[ "$FAIL" -eq 0 ] && printf '  \033[32m全部通过\033[0m\n' || printf '  \033[31m有失败项，按上面提示查\033[0m\n'
exit "$FAIL"
