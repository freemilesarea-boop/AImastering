#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# AIMASTER Python audio engine setup script
#
# Usage:
#   ./setup-python.sh              (finds a supported python3 itself)
#   PYTHON=python3.11 ./setup-python.sh  (explicit interpreter)
#
# What it does:
#   1. Finds a Python the pinned requirements actually have wheels for
#   2. Creates a virtualenv at services/python-audio/.venv
#   3. Installs requirements (soundfile, numpy)
#   4. Smoke-tests the engine by running main.py briefly
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SERVICE_DIR="$(cd "$(dirname "$0")/services/python-audio" && pwd)"
VENV_DIR="$SERVICE_DIR/.venv"
REQ_FILE="$SERVICE_DIR/requirements.txt"

# The window the PINNED requirements have wheels for.  numpy is pinned to
# 1.26.4 on purpose (see requirements.txt — canonical feature values depend on
# its FFT), and 1.26.4 ships cp39…cp312 and nothing newer.  On a Python outside
# that window pip falls through to building numpy from source, which on a Mac
# without a Fortran toolchain fails after several minutes of output that does
# not say "your Python is too new".
PY_MIN_MINOR=10
PY_MAX_MINOR=12

version_of() {
  "$1" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>/dev/null || true
}

supported() {
  local v major minor
  v="$(version_of "$1")"
  [ -n "$v" ] || return 1
  major="${v%%.*}"
  minor="${v##*.}"
  [ "$major" -eq 3 ] && [ "$minor" -ge "$PY_MIN_MINOR" ] && [ "$minor" -le "$PY_MAX_MINOR" ]
}

echo "→ Checking Python..."

# An explicit PYTHON= is an instruction, not a suggestion: if it does not fit,
# say so rather than quietly using a different interpreter than the one asked
# for.
if [ -n "${PYTHON:-}" ]; then
  if ! command -v "$PYTHON" &>/dev/null; then
    echo "  ERROR: '$PYTHON' not found."
    exit 1
  fi
  if ! supported "$PYTHON"; then
    echo "  ERROR: $PYTHON is $(version_of "$PYTHON"); the pinned requirements need"
    echo "         Python 3.$PY_MIN_MINOR - 3.$PY_MAX_MINOR."
    exit 1
  fi
else
  # Whatever `python3` points at first, then the specific versions.  A machine
  # that has moved on to 3.13+ as its default usually still has an older one.
  PYTHON=""
  for candidate in python3 python3.12 python3.11 python3.10; do
    command -v "$candidate" &>/dev/null || continue
    if supported "$candidate"; then PYTHON="$candidate"; break; fi
  done
  if [ -z "$PYTHON" ]; then
    found="$(version_of python3)"
    echo "  ERROR: no supported Python found."
    [ -n "$found" ] && echo "         'python3' is $found; the pinned requirements need 3.$PY_MIN_MINOR - 3.$PY_MAX_MINOR."
    echo ""
    echo "  On macOS:"
    echo "    brew install python@3.12"
    echo "    PYTHON=python3.12 ./setup-python.sh"
    echo ""
    echo "  On Ubuntu/Debian:"
    echo "    sudo apt install python3.12 python3.12-venv"
    echo "    PYTHON=python3.12 ./setup-python.sh"
    exit 1
  fi
fi

PY_VERSION="$(version_of "$PYTHON")"
echo "  OK: $PYTHON is Python $PY_VERSION"

# ── 2. Create virtualenv ──────────────────────────────────────────────────────
echo "→ Creating virtualenv at ${VENV_DIR}..."
"$PYTHON" -m venv "$VENV_DIR"
echo "  OK"

# ── 3. Install requirements ────────────────────────────────────────────────────
echo "→ Installing Python dependencies..."
"$VENV_DIR/bin/pip" install --quiet --upgrade pip
"$VENV_DIR/bin/pip" install --quiet -r "$REQ_FILE"
echo "  OK: $(cat "$REQ_FILE" | grep -v '^#' | tr '\n' ' ')"

# ── 4. Smoke test ─────────────────────────────────────────────────────────────
echo "→ Smoke-testing Python audio engine..."
# Two things this used to get wrong, both of which made the check decorative:
# it ran from whatever directory the script was invoked in, so `-m app.main`
# could not find the package; and it reached for `timeout`, which is GNU
# coreutils and simply is not on a Mac.  The timeout is Python's own now, and
# the engine is started where its package lives.
ENGINE_OUTPUT=$("$VENV_DIR/bin/python" - "$SERVICE_DIR" <<'SMOKE' 2>&1 || true
import subprocess, sys

def text(*chunks):
    out = []
    for chunk in chunks:
        if not chunk:
            continue
        if isinstance(chunk, bytes):
            chunk = chunk.decode("utf-8", "replace")
        out.append(chunk)
    return "\n".join(out)

def verdict(blob):
    # READY is not the first thing the engine says — it logs which ffmpeg it
    # found first — so look through everything rather than at line one, which
    # is what made this check report a warning on a perfectly good engine.
    if "READY" in blob:
        return "READY"
    lines = [line.strip() for line in blob.splitlines() if line.strip()]
    return lines[-1] if lines else "engine produced no output"

try:
    done = subprocess.run(
        [sys.executable, "-m", "app.main"],
        cwd=sys.argv[1], input="", capture_output=True, text=True, timeout=10,
    )
    print(verdict(text(done.stderr, done.stdout)))
except subprocess.TimeoutExpired as expired:
    print(verdict(text(expired.stderr, expired.stdout)))
except Exception as exc:                                   # noqa: BLE001
    print(f"engine did not start: {exc}")
SMOKE
)
if echo "$ENGINE_OUTPUT" | grep -q "READY"; then
  echo "  OK: engine prints READY"
else
  echo "  WARN: engine did not print READY"
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
