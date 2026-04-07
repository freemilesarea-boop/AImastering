import sys
from datetime import datetime


def log(level: str, message: str) -> None:
    """Write log lines to stderr only (stdout is reserved for JSON-RPC)."""
    ts = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    line = f"[{ts}] [{level}] {message}\n"
    try:
        stderr_bin = sys.stderr.buffer if hasattr(sys.stderr, 'buffer') else sys.stderr
        if hasattr(stderr_bin, 'write'):
            stderr_bin.write(line.encode('utf-8', errors='replace'))
            stderr_bin.flush()
    except Exception:
        pass  # Never let logging crash the engine
