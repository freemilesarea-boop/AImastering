#!/bin/bash
# Boot the app for a smoke run: Xvfb, main bundle, vite, Electron with CDP.
#
#   boot.sh <workdir> [cdp-port] [display-num]
#
# Logs land in <workdir>. Leaves everything running; `flow.mjs` attaches.
set -u
WORK="${1:?usage: boot.sh <workdir> [cdp-port] [display]}"
PORT="${2:-9333}"
DISP="${3:-98}"
mkdir -p "$WORK"
cd "$(dirname "$0")/../.." || exit 2

# ffmpeg AND ffprobe. The first smoke run set only AIMASTER_FFMPEG and
# `audio:analyze` — the flow's first real step — failed with "'ffprobe'을
# 찾을 수 없습니다": the analyser probes before it decodes, and nothing in a
# dev checkout guarantees either binary is on PATH. `ffmpeg-static` ships
# only ffmpeg, so ffprobe comes from the installer package beside it.
FF="$(node -p "require('ffmpeg-static')" 2>/dev/null)"
[ -x "$FF" ] || { echo "no ffmpeg-static — pnpm install first"; exit 1; }
FP="$(node -p "require('@ffprobe-installer/ffprobe').path" 2>/dev/null)"
[ -x "$FP" ] || FP="$(ls ../../node_modules/@ffprobe-installer/*/ffprobe 2>/dev/null | head -1)"
[ -x "$FP" ] || { echo "no ffprobe binary found — analysis will fail"; exit 1; }

# Unconditional, with a distinct display per run: a stale Xvfb that pgrep
# can see but whose socket is gone makes Electron exit with "Missing X
# server", and checking for one by name is how that happens.
Xvfb ":$DISP" -screen 0 1600x1000x24 > "$WORK/xvfb.log" 2>&1 &
sleep 3
[ -S "/tmp/.X11-unix/X$DISP" ] || { echo "X$DISP socket missing"; exit 1; }
echo "display  :$DISP"
echo "ffmpeg   $FF"
echo "ffprobe  $FP"

node esbuild.main.cjs --dev > "$WORK/esbuild.log" 2>&1 || {
  echo "main bundle FAILED"; tail -5 "$WORK/esbuild.log"; exit 1; }
echo "main     built"

if ! curl -s -m 2 http://localhost:5173 > /dev/null; then
  npx vite > "$WORK/vite.log" 2>&1 &
  npx wait-on http://localhost:5173 -t 90000 || { echo "vite FAILED"; exit 1; }
fi
echo "vite     up"

DISPLAY=":$DISP" AIMASTER_FFMPEG="$FF" AIMASTER_FFPROBE="$FP" \
  npx electron --no-sandbox --remote-debugging-port="$PORT" \
  dist-electron/main/index.js > "$WORK/electron.log" 2>&1 &
# Poll rather than sleep for a fixed time.  A flat `sleep 22` reported
# "CDP down" on a run where Electron was simply still starting — the
# socket came up a few seconds later, and the only thing wrong was the
# wait.  Booting is slower on a cold page cache, so the budget is 90s.
for _ in $(seq 1 90); do
  curl -s -m 2 "http://localhost:$PORT/json/version" > /dev/null && break
  sleep 1
done
curl -s -m 5 "http://localhost:$PORT/json/version" > /dev/null \
  && echo "electron CDP on $PORT" \
  || { echo "CDP down after 90s — see $WORK/electron.log"; exit 1; }
