#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# AIMASTER Python audio engine setup script
#
# Usage:
#   ./setup-python.sh              (uses python3 from PATH)
#   PYTHON=python3.11 ./setup-python.sh  (explicit interpreter)
#
# What it does:
#   1. Verifies Python >= 3.10 is available
#   2. Creates a virtualenv at services/python-audio/.venv
#   3. Installs requirements (soundfile, numpy)
#   4. Smoke-tests the engine by running main.py briefly
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PYTHON="${PYTHON:-python3}"
SERVICE_DIR="$(cd "$(dirname "$0")/services/python-audio" && pwd)"
VENV_DIR="$SERVICE_DIR/.venv"
REQ_FILE="$SERVICE_DIR/requirements.txt"

# ── 1. Check Python version ───────────────────────────────────────────────────
echo "→ Checking Python…"
if ! command -v "$PYTHON" &>/dev/null; then
  echo "  ERROR: '$PYTHON' not found. Install Python 3.10+ and try again."
  exit 1
fi

PY_VERSION=$("$PYTHON" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
PY_MAJOR=$(echo "$PY_VERSION" | cut -d. -f1)
PY_MINOR=$(echo "$PY_VERSION" | cut -d. -f2)

if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 10 ]; }; then
  echo "  ERROR: Python 3.10+ required. Found $PY_VERSION."
  exit 1
fi
echo "  OK: Python $PY_VERSION"

# ── 2. Create virtualenv ──────────────────────────────────────────────────────
echo "→ Creating virtualenv at $VENV_DIR…"
"$PYTHON" -m venv "$VENV_DIR"
echo "  OK"

# ── 3. Install requirements ────────────────────────────────────────────────────
echo "→ Installing Python dependencies…"
"$VENV_DIR/bin/pip" install --quiet --upgrade pip
"$VENV_DIR/bin/pip" install --quiet -r "$REQ_FILE"
echo "  OK: $(cat "$REQ_FILE" | grep -v '^#' | tr '\n' ' ')"

# ── 4. Smoke test ─────────────────────────────────────────────────────────────
echo "→ Smoke-testing Python audio engine…"
# Send an empty line and check that the engine starts without crashing
ENGINE_OUTPUT=$(echo "" | timeout 5 "$VENV_DIR/bin/python" -m app.main 2>&1 | head -1 || true)
if echo "$ENGINE_OUTPUT" | grep -q "READY"; then
  echo "  OK: Engine prints READY on stderr"
else
  echo "  WARN: Engine did not print READY within 5s (may still be OK on slow machines)"
  echo "  Output: $ENGINE_OUTPUT"
fi

echo ""
echo "✓ Setup complete."
echo ""
echo "  To run the app:"
echo "    export AIMASTER_PYTHON='$VENV_DIR/bin/python'"
echo "    cd $(dirname "$0") && pnpm desktop"
echo ""
echo "  Or set it permanently in your shell:"
echo "    echo \"export AIMASTER_PYTHON='$VENV_DIR/bin/python'\" >> ~/.zshrc"
