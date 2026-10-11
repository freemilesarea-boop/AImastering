#!/bin/bash
# Boot the PACKAGED app for a smoke run — from OUTSIDE the source tree.
#
#   boot-packaged.sh <workdir> [cdp-port] [display-num]
#
# Requires `pnpm dist` to have produced out/linux-unpacked.  Logs land in
# <workdir>.  Leaves the app running; `flow-packaged.mjs` attaches.
#
# WHY IT COPIES THE APP FIRST
#
# `wasmNodeCandidates()` walks UP from the main bundle's directory before it
# tries `process.resourcesPath`.  `out/linux-unpacked` sits inside the
# workspace, so every ancestor walk from a package launched in place finds
# `packages/dsp-wasm/pkg-node` — the DEV copy — and the shipped
# `resources/dsp-wasm-node` is never touched.  That is not a hypothesis: the
# first run of this probe loaded
# `/home/user/.../packages/dsp-wasm/pkg-node/loui_dsp_wasm.cjs`, and a Rust
# panic's stack trace is how it came out.
#
# So the app is copied to a directory with no workspace above it, which is
# what a user's /opt install looks like.  `wasm-resolve-selftest` pins the
# ordering this depends on.
set -u
WORK="${1:?usage: boot-packaged.sh <workdir> [cdp-port] [display]}"
PORT="${2:-9444}"
DISP="${3:-97}"
cd "$(dirname "$0")/../.." || exit 2
SRC="$PWD/out/linux-unpacked"
[ -x "$SRC/@aimasterdesktop" ] || {
  echo "no packaged app at $SRC — run 'pnpm dist' first"; exit 1; }

mkdir -p "$WORK"
INSTALL="$WORK/installed"
rm -rf "$INSTALL"
mkdir -p "$INSTALL"
cp -a "$SRC" "$INSTALL/" || { echo "copy failed"; exit 1; }
APP="$INSTALL/linux-unpacked/@aimasterdesktop"

# Prove the copy really is outside any workspace, rather than assuming it.
# A $WORK under the repo would make the whole run meaningless and look fine.
d="$INSTALL/linux-unpacked/resources/app.asar/dist-electron/main"
while :; do
  if [ -f "$d/packages/dsp-wasm/pkg-node/loui_dsp_wasm.cjs" ]; then
    echo "✗ $d has a workspace above it — the packaged WASM copy would be shadowed."
    echo "  Pick a workdir outside the repo (default /tmp/loui-pkg-smoke)."
    exit 1
  fi
  nd="$(dirname "$d")"; [ "$nd" = "$d" ] && break; d="$nd"
done
echo "install  $APP  (no workspace above it)"

Xvfb ":$DISP" -screen 0 1600x1000x24 > "$WORK/xvfb.log" 2>&1 &
sleep 3
[ -S "/tmp/.X11-unix/X$DISP" ] || { echo "X$DISP socket missing"; exit 1; }
echo "display  :$DISP"

# No AIMASTER_FFMPEG/AIMASTER_FFPROBE here, unlike the dev boot: a packaged
# app resolves both from <resources>/bin itself (resolvePaths()), and
# supplying them would hide it if that stopped working.
DISPLAY=":$DISP" "$APP" --no-sandbox --remote-debugging-port="$PORT" \
  > "$WORK/electron.log" 2>&1 &
echo "pid      $!"
for _ in $(seq 1 90); do
  curl -s -m 2 "http://localhost:$PORT/json/version" > /dev/null && break
  sleep 1
done
curl -s -m 5 "http://localhost:$PORT/json/version" > /dev/null \
  && echo "packaged CDP on $PORT" \
  || { echo "CDP down after 90s — see $WORK/electron.log"; tail -20 "$WORK/electron.log"; exit 1; }
