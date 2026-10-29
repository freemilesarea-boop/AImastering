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
#
# The LOCK is the other half, and it cost a run to learn.  Xvfb refuses to
# start while /tmp/.X<n>-lock exists — "Server is already active for display
# 98 … If this server is no longer running, remove /tmp/.X98-lock" — and the
# readiness check below used to be `[ -S /tmp/.X11-unix/X$DISP ]`, which a
# LEFTOVER SOCKET FILE satisfies with no server behind it.  So the boot
# reported "display :98", Electron exited with "Missing X server", and the
# run died ninety seconds later as "CDP down", blaming the app for a display
# that was never there.  A check that cannot fail is worse than no check.
# `xdpyinfo` is the real answer to "does this display answer"; it is not
# installed everywhere, and where it is missing a LIVE Xvfb on this display
# must not have its lock removed from under it.  Matching the process by name
# is the fallback, and only in that direction: a name match that is wrong
# here costs a refused boot with Xvfb's own reason printed, not a silent one.
display_is_dead() {
  if command -v xdpyinfo > /dev/null 2>&1; then
    ! xdpyinfo -display ":$DISP" > /dev/null 2>&1
  else
    ! pgrep -f "Xvfb :$DISP " > /dev/null 2>&1
  fi
}
if display_is_dead; then
  # A socket or lock without a server behind it: Xvfb will refuse to start
  # while either is there, so clear them before asking.
  if [ -e "/tmp/.X$DISP-lock" ] || [ -S "/tmp/.X11-unix/X$DISP" ]; then
    echo "display  :$DISP had a stale lock/socket — removing"
    rm -f "/tmp/.X$DISP-lock" "/tmp/.X11-unix/X$DISP"
  fi
  Xvfb ":$DISP" -screen 0 1600x1000x24 > "$WORK/xvfb.log" 2>&1 &
  XVFB_PID=$!
  # Ask the display whether it answers, rather than whether a file exists.
  # Xvfb needs a moment, so poll instead of sleeping a fixed three seconds.
  for _ in $(seq 1 30); do
    kill -0 "$XVFB_PID" 2>/dev/null || break
    if [ -S "/tmp/.X11-unix/X$DISP" ] && ! display_is_dead; then break; fi
    sleep 0.5
  done
  if ! kill -0 "$XVFB_PID" 2>/dev/null; then
    echo "Xvfb for :$DISP exited — it says why:"; tail -5 "$WORK/xvfb.log"; exit 1
  fi
  [ -S "/tmp/.X11-unix/X$DISP" ] || {
    echo "X$DISP socket missing after 15s"; tail -5 "$WORK/xvfb.log"; exit 1; }
  echo "display  :$DISP"
else
  # One is already running — a previous run's, left up on purpose.  Starting a
  # second Xvfb on the same display just makes it refuse, so reuse it and say
  # so rather than failing on a display that works.
  echo "display  :$DISP (reusing the one already running)"
fi
echo "ffmpeg   $FF"
echo "ffprobe  $FP"

node esbuild.main.cjs --dev > "$WORK/esbuild.log" 2>&1 || {
  echo "main bundle FAILED"; tail -5 "$WORK/esbuild.log"; exit 1; }
echo "main     built"

# A vite that is OLDER than the source it serves is the quiet version of the
# CDP hazard below, and it cost three runs to find.  The dev server keeps a
# module graph; after a large edit it can serve a MIXED one, and two copies of
# `dawStore.ts` means the React tree subscribes to one store while this
# harness writes to the other.  What that looks like is not an error: the
# import reported eight tracks, the UI drew seven lanes, the store read one,
# the chrome grew 29 px, and 25 steps failed naming the product.  Same run on
# a fresh vite: 69/69.
#
# So reuse is allowed only when nothing under src/ has been touched since the
# server started.  `etimes` is the process's age in seconds, and `find
# -newermt` asks the question directly.
VITE_PID="$(ps -eo pid,args --no-headers | grep -F 'bin/vite' | grep -v grep \
  | awk '{print $1}' | head -1)"
if [ -n "$VITE_PID" ]; then
  VITE_AGE="$(ps -o etimes= -p "$VITE_PID" 2>/dev/null | tr -d ' ')"
  if [ -n "$VITE_AGE" ] \
    && [ -n "$(find src -type f -newermt "-${VITE_AGE} seconds" -print -quit 2>/dev/null)" ]; then
    echo "vite     ${VITE_AGE}s old and src/ is newer — restarting it"
    kill -9 "$VITE_PID" 2>/dev/null
    for _ in $(seq 1 20); do
      curl -s -m 2 http://localhost:5173 > /dev/null || break
      sleep 0.5
    done
  fi
fi

if ! curl -s -m 2 http://localhost:5173 > /dev/null; then
  npx vite > "$WORK/vite.log" 2>&1 &
  npx wait-on http://localhost:5173 -t 90000 || { echo "vite FAILED"; exit 1; }
fi
echo "vite     up"

# A previous run's Electron still listening on this port is the most dangerous
# thing in this script.  Launching a second one does not take the port from it:
# the newcomer starts, logs, and serves nothing, while the flow connects to the
# OLD app and measures code that is no longer on disk.  That is not a theory —
# it happened here.  A licence step was deliberately broken in the source to
# prove it was load-bearing, the bundle rebuilt below contained the break, and
# the flow reported 26/26 green: the app answering was the one booted four
# minutes earlier.  Poking the same IPC on a freshly booted app moved the trial
# count from 0 to 1 at once.
#
# So: anything already serving CDP here is killed before we build our own
# expectations on it, and if it will not die we stop rather than measure it.
if curl -s -m 2 "http://127.0.0.1:$PORT/json/version" > /dev/null 2>&1; then
  echo "CDP      :$PORT answered BEFORE launch — killing the previous run's Electron"
  # By PID from the port in its own argv.  `pkill -f` would match this script.
  ps -eo pid,args --no-headers | grep -F -- "remote-debugging-port=$PORT" \
    | grep -v grep | awk '{print $1}' | xargs -r kill -9
  for _ in $(seq 1 20); do
    curl -s -m 2 "http://127.0.0.1:$PORT/json/version" > /dev/null 2>&1 || break
    sleep 0.5
  done
  if curl -s -m 2 "http://127.0.0.1:$PORT/json/version" > /dev/null 2>&1; then
    echo "something is STILL serving CDP on $PORT — refusing to measure it"; exit 1
  fi
  echo "CDP      :$PORT is clear"
fi

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
