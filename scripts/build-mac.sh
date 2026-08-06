#!/usr/bin/env bash
# =============================================================================
# build-mac.sh — Louver Mastering AI — macOS distribution build
#
# Requirements (run on a Mac):
#   - macOS 12+ (Monterey or later)
#   - Xcode Command Line Tools  (xcode-select --install)
#   - Node.js ≥ 20 + pnpm ≥ 9   (brew install node pnpm)
#   - Python ≥ 3.10              (brew install python@3.11)
#
# Usage:
#   bash scripts/build-mac.sh
#
# Output (HOST arch only — see note in step 0):
#   apps/desktop/out/
#     Louver Mastering AI-<version>-<arch>.dmg      (drag-to-Applications)
#     Louver Mastering AI-<version>-<arch>-mac.zip  (electron-updater delta)
#
# A hard architecture gate (scripts/verify-macos-binary-arch.sh) runs before
# and after packaging and aborts if any bundled binary (engine / ffmpeg /
# ffprobe / main app) is the wrong CPU type — the guard against the v3.6.0
# mixed-arch "bad CPU type in executable" P0.  Builds are unsigned; users
# right-click → Open the first time.
# =============================================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MONOREPO="$ROOT/aimaster-desktop"
DESKTOP="$MONOREPO/apps/desktop"
PYTHON_SVC="$MONOREPO/services/python-audio"
BIN_DIR="$DESKTOP/public/bin"
VENV="$PYTHON_SVC/.venv"

echo "════════════════════════════════════════════════════"
echo "  Louver Mastering AI — macOS Build"
echo "════════════════════════════════════════════════════"
echo ""

# ── 0. Verify we're on a Mac + detect host arch ───────────────────────────────
if [[ "$(uname)" != "Darwin" ]]; then
  echo "✗ This script must run on macOS."
  exit 1
fi

# A single Mac can only produce a correctly-architected package for its OWN
# arch: PyInstaller cannot cross-compile the engine, and ffmpeg-static /
# @ffprobe-installer resolve to the host arch.  Building --x64 --arm64 together
# on one machine shipped an x86_64 shell around arm64 engine/ffmpeg/ffprobe
# (the v3.6.0 P0 "bad CPU type in executable" bug).  So build ONLY the host
# arch here, and rely on CI (macos-13 Intel + macos-14 Apple Silicon) for the
# full x64 + arm64 matrix.
case "$(uname -m)" in
  arm64)         HOST_ARCH="arm64" ;;
  x86_64|amd64)  HOST_ARCH="x64"   ;;
  *) echo "✗ Unsupported host arch: $(uname -m)"; exit 1 ;;
esac
echo "▶ Host arch: $(uname -m) → building macOS package for: $HOST_ARCH only"
echo "  (for the other arch, build on that hardware or use CI — see .github/workflows/build.yml)"

# ── 1. Python venv + dependencies ─────────────────────────────────────────────
echo "▶ Setting up Python environment…"
if [[ ! -d "$VENV" ]]; then
  python3 -m venv "$VENV"
fi
"$VENV/bin/pip" install -q --upgrade pip
"$VENV/bin/pip" install -q -r "$PYTHON_SVC/requirements.txt"
"$VENV/bin/pip" install -q pyinstaller
echo "  ✓ Python dependencies installed"

# ── 2. PyInstaller — build standalone engine ──────────────────────────────────
echo ""
echo "▶ Building Python engine with PyInstaller…"
mkdir -p "$BIN_DIR"
cd "$PYTHON_SVC"
"$VENV/bin/pyinstaller" \
  --clean \
  --noconfirm \
  --onefile \
  --name engine \
  --distpath "$BIN_DIR" \
  --workpath "/tmp/louver-pyinstaller-build" \
  --specpath "/tmp/louver-pyinstaller-spec" \
  --hidden-import soundfile \
  --hidden-import numpy \
  --collect-all soundfile \
  --collect-all numpy \
  --collect-all numpy.fft \
  --exclude-module tkinter \
  --exclude-module pytest \
  --exclude-module matplotlib \
  app/main.py

chmod +x "$BIN_DIR/engine"
echo "  ✓ engine binary: $BIN_DIR/engine"

# ── 3. Node.js dependencies ───────────────────────────────────────────────────
echo ""
echo "▶ Installing Node.js dependencies…"
cd "$MONOREPO"
pnpm install

# ── 4. FFmpeg binaries ────────────────────────────────────────────────────────
echo ""
echo "▶ Copying FFmpeg binaries…"
cd "$DESKTOP"
node scripts/prebuild.cjs

# ── 5. Build Electron app ─────────────────────────────────────────────────────
echo ""
echo "▶ Building Electron app…"
cd "$DESKTOP"
pnpm build

# ── 6. Arch gate (pre-package) ────────────────────────────────────────────────
echo ""
echo "▶ Verifying bundled binaries are $HOST_ARCH before packaging…"
bash "$ROOT/scripts/verify-macos-binary-arch.sh" "$HOST_ARCH" "$BIN_DIR"

# ── 7. Package with electron-builder (host arch only) ─────────────────────────
echo ""
echo "▶ Cleaning previous out/ + dist/…"
rm -rf "$DESKTOP/out" "$DESKTOP/dist"

echo ""
echo "▶ Packaging .dmg + .zip ($HOST_ARCH)…"
cd "$DESKTOP"
pnpm exec electron-builder --mac dmg zip --"$HOST_ARCH" --publish never

# ── 8. Arch gate (post-package) ───────────────────────────────────────────────
echo ""
echo "▶ Verifying the packaged .app is $HOST_ARCH…"
APP="$(find "$DESKTOP/out" -maxdepth 2 -name '*.app' -type d | head -1)"
if [[ -z "$APP" ]]; then
  echo "✗ No .app found under $DESKTOP/out"
  exit 1
fi
bash "$ROOT/scripts/verify-macos-binary-arch.sh" "$HOST_ARCH" \
  "$APP/Contents/Resources/bin" \
  "$APP/Contents/MacOS/Louver Mastering AI"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════"
echo "  Build complete!  ($HOST_ARCH)"
echo "  Output: $DESKTOP/out/"
ls "$DESKTOP/out/"*.dmg "$DESKTOP/out/"*.zip 2>/dev/null && echo "" || true
echo "════════════════════════════════════════════════════"
