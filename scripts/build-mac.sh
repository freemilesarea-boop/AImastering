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
#     Louver Mastering AI-<version>-arm64.dmg   (Apple Silicon)
#     Louver Mastering AI-<version>-x64.dmg     (Intel Mac)
# =============================================================================

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP="$ROOT/apps/desktop"
PYTHON_SVC="$ROOT/services/python-audio"
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

# ── 3. FFmpeg binaries ────────────────────────────────────────────────────────
echo ""
echo "▶ Copying FFmpeg binaries…"
cd "$DESKTOP"
node scripts/prebuild.cjs

# ── 4. Node.js dependencies ───────────────────────────────────────────────────
echo ""
echo "▶ Installing Node.js dependencies…"
cd "$ROOT"
pnpm install --frozen-lockfile

# ── 5. Build Electron app ─────────────────────────────────────────────────────
echo ""
echo "▶ Building Electron app…"
cd "$DESKTOP"
pnpm build

# ── 6. Package with electron-builder ─────────────────────────────────────────
echo ""
echo "▶ Packaging DMG (arm64 + x64)…"
pnpm exec electron-builder --mac

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════"
echo "  Build complete!"
echo "  Output: $DESKTOP/out/"
ls "$DESKTOP/out/"*.dmg 2>/dev/null && echo "" || true
echo "════════════════════════════════════════════════════"
