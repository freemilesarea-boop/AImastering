#!/usr/bin/env bash
set -euo pipefail

PYTHON_MIN="3.10"
VENV_DIR="services/python-audio/.venv"

cd "$(git rev-parse --show-toplevel)"

# Check python version
PYTHON=$(command -v python3 || command -v python)
PY_VERSION=$("$PYTHON" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
if python3 -c "import sys; exit(0 if sys.version_info >= (3,10) else 1)"; then
  echo "✓ Python $PY_VERSION"
else
  echo "✗ Python $PYTHON_MIN+ required (found $PY_VERSION)" && exit 1
fi

# Create venv
if [ ! -d "$VENV_DIR" ]; then
  "$PYTHON" -m venv "$VENV_DIR"
  echo "✓ Created venv at $VENV_DIR"
fi

# Install deps
"$VENV_DIR/bin/pip" install --upgrade pip -q
"$VENV_DIR/bin/pip" install -r services/python-audio/requirements.txt -q
echo "✓ Python dependencies installed"

echo ""
echo "Run the engine manually:"
echo "  PYTHONPATH=services/python-audio $VENV_DIR/bin/python -m app.main"
