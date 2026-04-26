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
# Output:
#   apps/desktop/out/
#     Louver Mastering AI-<version>-arm64-mac.zip   (Apple Silicon)
#     Louver Mastering AI-<version>-mac.zip         (Intel Mac)
#
# DMG packaging is intentionally disabled on this branch (hdiutil attach has
# been failing on CI macOS runners).  zip ships an unsigned .app archive
# directly; users right-click → Open the first time.
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

# ── 0. Verify we're on a Mac ──────────────────────────────────────────────────
if [[ "$(uname)" != "Darwin" ]]; then
  echo "✗ This script must run on macOS."
  exit 1
fi

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

# ── 6. Package with electron-builder ─────────────────────────────────────────
echo ""
echo "▶ Cleaning previous out/…"
# NOTE: do NOT delete dist/ here.  electron-builder.yml's `files: dist/**/*`
# glob means dist/ is the *input* to packaging; wiping it makes app.asar
# omit the main + preload entry points and packaging fails with
# "Application entry file dist/main/index.js does not exist".
rm -rf "$DESKTOP/out"

echo ""
echo "▶ Packaging .zip (arm64 + x64)…"
pnpm exec electron-builder --mac zip --x64 --arm64 --publish never

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════"
echo "  Build complete!"
echo "  Output: $DESKTOP/out/"
ls "$DESKTOP/out/"*.zip 2>/dev/null && echo "" || true
echo "════════════════════════════════════════════════════"
