"""
AIMASTER Python Audio Engine — JSON-RPC dispatcher

Protocol:
  stdin  → one JSON object per line: {"id":"<uuid>","method":"<m>","params":{}}
  stdout → responses:  {"id":"<uuid>","result":{}}
           or errors:  {"id":"<uuid>","error":{"code":<n>,"message":"<korean>"}}
           or progress: {"type":"progress","jobId":"<uuid>","percent":<n>,"stage":"<s>"}
  stderr → developer logs only (READY signal + structured log lines)

Error categories:
  -32700  Parse error (invalid JSON)
  -32601  Method not found
  -32602  Invalid params (missing required key)
  -32000  Application error (user-facing Korean message in .message)
"""
from __future__ import annotations

import io
import json
import sys
import traceback

# ── Windows UTF-8 I/O ─────────────────────────────────────────────────────────
# On Windows the default codec is cp949. Instead of reconfiguring or rewrapping
# sys.stdin/stdout (which can raise TypeError inside PyInstaller bundles), we
# work with the underlying binary buffers directly so encoding is always explicit.

def _get_stdin_binary() -> io.RawIOBase:
    """Return a binary-mode stdin reader."""
    if hasattr(sys.stdin, 'buffer'):
        return sys.stdin.buffer  # type: ignore[return-value]
    # PyInstaller fallback: stdin is already binary
    return sys.stdin  # type: ignore[return-value]

def _get_stdout_binary() -> io.RawIOBase:
    """Return a binary-mode stdout writer."""
    if hasattr(sys.stdout, 'buffer'):
        return sys.stdout.buffer  # type: ignore[return-value]
    return sys.stdout  # type: ignore[return-value]

def _get_stderr_binary() -> io.RawIOBase:
    """Return a binary-mode stderr writer."""
    if hasattr(sys.stderr, 'buffer'):
        return sys.stderr.buffer  # type: ignore[return-value]
    return sys.stderr  # type: ignore[return-value]

_stdin_bin  = _get_stdin_binary()
_stdout_bin = _get_stdout_binary()
_stderr_bin = _get_stderr_binary()

from app.analyzers.analyzer import analyze_file
from app.mastering.mastering import master_file
from app.qc.qc_checker import run_qc
from app.utils.logger import log


# ── I/O helpers ───────────────────────────────────────────────────────────────

def _send(obj: dict) -> None:
    """Write a JSON line to stdout. ensure_ascii=True keeps output pure-ASCII
    so Windows cp949 stdout encoding never causes UnicodeEncodeError."""
    print(json.dumps(obj, ensure_ascii=True), flush=True)


def _send_progress(job_id: str, percent: int, stage: str) -> None:
    _send({"type": "progress", "jobId": job_id, "percent": percent, "stage": stage})


def _send_error(req_id: str, code: int, message: str) -> None:
    _send({"id": req_id, "error": {"code": code, "message": message}})


# ── Handlers ──────────────────────────────────────────────────────────────────

def _handle_analyze(params: dict, _job_id: str) -> dict:
    file_path = params.get("file_path")
    if not file_path:
        raise ValueError("params.file_path is required")
    return analyze_file(file_path)


def _handle_master(params: dict, job_id: str) -> dict:
    for key in ("input_path", "output_path"):
        if not params.get(key):
            raise ValueError(f"params.{key} is required")
    return master_file(params, job_id, _send_progress)


def _handle_qc(params: dict, _job_id: str) -> dict:
    file_path = params.get("file_path")
    if not file_path:
        raise ValueError("params.file_path is required")
    return run_qc(
        file_path,
        float(params.get("target_lufs", -14.0)),
        float(params.get("target_tp",   -1.0)),
    )


HANDLERS = {
    "analyze":  _handle_analyze,
    "master":   _handle_master,
    "qc_check": _handle_qc,
}


# ── Main loop ─────────────────────────────────────────────────────────────────

def main() -> None:
    print("READY", file=sys.stderr, flush=True)
    log("INFO", "AIMASTER Python audio engine started")

    for raw_bytes in _stdin_bin:
        raw_line = raw_bytes.decode('utf-8', errors='replace') if isinstance(raw_bytes, (bytes, bytearray)) else raw_bytes
        raw = raw_line.strip()
        if not raw:
            continue

        req_id = "unknown"
        try:
            req = json.loads(raw)
            req_id = req.get("id", "unknown")
            method = req.get("method", "")
            params = req.get("params") or {}

            if method not in HANDLERS:
                _send_error(req_id, -32601, f"Unknown method: {method}")
                continue

            log("DEBUG", f"→ {method} [{req_id[:8]}]")
            result = HANDLERS[method](params, req_id)
            _send({"id": req_id, "result": result})
            log("DEBUG", f"← {method} [{req_id[:8]}] OK")

        except json.JSONDecodeError as exc:
            log("ERROR", f"JSON parse error: {exc}")
            _send_error(req_id, -32700, "잘못된 JSON 형식입니다.")

        except ValueError as exc:
            # Missing required params
            log("ERROR", f"Invalid params: {exc}")
            _send_error(req_id, -32602, str(exc))

        except RuntimeError as exc:
            # User-facing errors raised by handlers (already Korean)
            log("ERROR", f"RuntimeError [{req_id[:8]}]: {exc}\n{traceback.format_exc()}")
            _send_error(req_id, -32000, str(exc))

        except Exception as exc:
            # Unexpected errors — log full trace, send detailed message
            tb = traceback.format_exc()
            log("ERROR", f"Unexpected error [{req_id[:8]}]: {exc}\n{tb}")
            _send_error(
                req_id, -32000,
                f"{type(exc).__name__}: {exc}",
            )


if __name__ == "__main__":
    main()
