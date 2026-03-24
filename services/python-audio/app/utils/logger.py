import sys
from datetime import datetime


def log(level: str, message: str) -> None:
    """Write log lines to stderr only (stdout is reserved for JSON-RPC)."""
    ts = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    print(f"[{ts}] [{level}] {message}", file=sys.stderr, flush=True)
