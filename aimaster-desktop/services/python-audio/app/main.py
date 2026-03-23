"""
AIMASTER Python Audio Engine
JSON-RPC over stdin/stdout. Progress events written to stdout as:
  {"type":"progress","jobId":"<id>","percent":<n>,"stage":"<s>"}
READY signal written to stderr on startup.
"""
import sys
import json
import traceback

sys.stdout.reconfigure(line_buffering=True)  # type: ignore[attr-defined]

from app.analyzers.analyzer import analyze_file
from app.mastering.mastering import master_file
from app.qc.qc_checker import run_qc
from app.utils.logger import log


def send(obj: dict) -> None:
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def send_progress(job_id: str, percent: int, stage: str) -> None:
    send({"type": "progress", "jobId": job_id, "percent": percent, "stage": stage})


HANDLERS = {
    "analyze":  lambda params, _jid: analyze_file(params["file_path"]),
    "master":   lambda params, jid:  master_file(params, jid, send_progress),
    "qc_check": lambda params, _jid: run_qc(
        params["file_path"],
        params.get("target_lufs", -14),
        params.get("target_tp", -1.0),
    ),
}


def main() -> None:
    print("READY", file=sys.stderr, flush=True)
    log("INFO", "Python audio engine started")

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
            req_id = req["id"]
            method = req["method"]
            params = req.get("params", {})

            if method not in HANDLERS:
                send({"id": req_id, "error": {"code": -32601, "message": f"Unknown method: {method}"}})
                continue

            result = HANDLERS[method](params, req_id)
            send({"id": req_id, "result": result})

        except Exception as exc:
            log("ERROR", f"Handler error: {exc}\n{traceback.format_exc()}")
            try:
                send({"id": req.get("id", "unknown"), "error": {"code": -32000, "message": str(exc)}})
            except Exception:
                pass


if __name__ == "__main__":
    main()
