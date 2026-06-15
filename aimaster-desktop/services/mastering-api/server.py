# AImastering — HTTP mastering API (M0).
#
# Thin FastAPI wrapper that REUSES the existing python-audio engine unchanged:
#   analyze_file(path)                      -> Stage-1 analysis dict
#   master_file(params, job_id, progress)   -> writes master WAV + preview MP3
#
# It does NOT modify the engine or the desktop app.  The engine package is
# named `app`; this server is a single module (`server`) to avoid a package
# name clash, and inserts the engine dir on sys.path.
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import uuid

# ── Locate + import the existing engine (no engine code changes) ──────────────
ENGINE_DIR = os.environ.get(
    "ENGINE_DIR",
    os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "python-audio")),
)
if ENGINE_DIR not in sys.path:
    sys.path.insert(0, ENGINE_DIR)

from app.analyzers.analyzer import analyze_file          # noqa: E402
from app.mastering.mastering import master_file          # noqa: E402

from fastapi import (                                     # noqa: E402
    FastAPI, File, Form, Header, HTTPException, UploadFile, BackgroundTasks,
)
from fastapi.responses import FileResponse, JSONResponse  # noqa: E402

API_KEY = os.environ.get("MASTERING_API_KEY", "")
WORK_ROOT = os.path.join(os.environ.get("WORK_DIR", tempfile.gettempdir()), "aimaster_jobs")
JOB_TTL = int(os.environ.get("JOB_TTL_SECONDS", "3600"))
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "60"))
os.makedirs(WORK_ROOT, exist_ok=True)

_jobs: dict[str, dict] = {}
_lock = threading.Lock()

app = FastAPI(title="AImastering Mastering API", version="0.1.0")


# ── Helpers ───────────────────────────────────────────────────────────────────
def _require_key(x_api_key: str | None) -> None:
    # Auth enforced only when a key is configured (unset = open, for local dev).
    if API_KEY and x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="invalid_api_key")


def _save_upload(upload: UploadFile, dest_dir: str) -> str:
    os.makedirs(dest_dir, exist_ok=True)
    name = os.path.basename(upload.filename or "input")
    ext = os.path.splitext(name)[1].lower() or ".wav"
    in_path = os.path.join(dest_dir, "input" + ext)
    size = 0
    limit = MAX_UPLOAD_MB * 1024 * 1024
    with open(in_path, "wb") as f:
        while True:
            chunk = upload.file.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > limit:
                f.close()
                raise HTTPException(status_code=413, detail=f"file too large (>{MAX_UPLOAD_MB}MB)")
            f.write(chunk)
    return in_path


def _rm(path: str | None) -> None:
    if not path:
        return
    try:
        if os.path.isdir(path):
            shutil.rmtree(path, ignore_errors=True)
        elif os.path.exists(path):
            os.remove(path)
    except Exception:
        pass


def _cleanup_loop() -> None:
    while True:
        time.sleep(300)
        now = time.time()
        with _lock:
            stale = [jid for jid, j in _jobs.items() if now - j.get("created", now) > JOB_TTL]
            for jid in stale:
                _rm(_jobs[jid].get("dir"))
                _jobs.pop(jid, None)


threading.Thread(target=_cleanup_loop, daemon=True).start()


# ── Routes ────────────────────────────────────────────────────────────────────
@app.get("/healthz")
def healthz():
    return {"ok": True, "engine_dir": ENGINE_DIR, "jobs": len(_jobs)}


@app.post("/v1/analyze")
async def analyze(audio: UploadFile = File(...), x_api_key: str | None = Header(default=None)):
    _require_key(x_api_key)
    job_dir = os.path.join(WORK_ROOT, "an_" + uuid.uuid4().hex)
    in_path = _save_upload(audio, job_dir)
    try:
        return JSONResponse(analyze_file(in_path))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"analyze_failed: {e}")
    finally:
        _rm(job_dir)


@app.post("/v1/master")
async def master(
    background: BackgroundTasks,
    audio: UploadFile = File(...),
    options: str = Form(default="{}"),
    x_api_key: str | None = Header(default=None),
):
    _require_key(x_api_key)
    try:
        opts = json.loads(options or "{}")
    except Exception:
        raise HTTPException(status_code=400, detail="options must be JSON")

    job_id = uuid.uuid4().hex
    job_dir = os.path.join(WORK_ROOT, job_id)
    in_path = _save_upload(audio, job_dir)
    out_path = os.path.join(job_dir, "master.wav")

    with _lock:
        _jobs[job_id] = {
            "status": "queued", "percent": 0, "stage": "queued",
            "created": time.time(), "dir": job_dir,
        }
    background.add_task(_run_master, job_id, in_path, out_path, opts)
    return {"job_id": job_id}


def _run_master(job_id: str, in_path: str, out_path: str, opts: dict) -> None:
    def progress(jid: str, percent: int, stage: str) -> None:
        with _lock:
            j = _jobs.get(job_id)
            if j:
                j["status"] = "processing"
                j["percent"] = int(percent)
                j["stage"] = str(stage)

    try:
        with _lock:
            _jobs[job_id]["status"] = "processing"
        # Mirror the desktop audio:master params (camel + snake accepted).
        params = {
            "input_path": in_path,
            "output_path": out_path,
            "style": opts.get("style", "balanced"),
            "target_lufs": opts.get("target_lufs", opts.get("targetLufs", -14.0)),
            "target_tp": opts.get("target_tp", opts.get("targetTp", -1.0)),
            "lra": opts.get("lra", 11.0),
            "sample_rate": opts.get("sample_rate", opts.get("sampleRate", 44100)),
            "bit_depth": opts.get("bit_depth", opts.get("bitDepth", 24)),
            "apply_ai_corrections": opts.get(
                "apply_ai_corrections", opts.get("applyAiCorrections", True)
            ),
            "ai_detections": opts.get("ai_detections", opts.get("aiDetections", {})),
        }
        result = master_file(params, job_id, progress)
        master_path = result.get("outputPath") or out_path
        preview_path = result.get("previewPath")
        with _lock:
            j = _jobs[job_id]
            j.update(
                status="done", percent=100, stage="done",
                master=master_path, preview=preview_path,
                loudnessAfter=result.get("loudnessAfter"),
                processingTimeSec=result.get("processingTimeSec"),
            )
    except Exception as e:
        with _lock:
            _jobs[job_id].update(status="error", stage="error", error=str(e))
    finally:
        _rm(in_path)  # source no longer needed; outputs kept until TTL


@app.get("/v1/jobs/{job_id}")
def job_status(job_id: str, x_api_key: str | None = Header(default=None)):
    _require_key(x_api_key)
    with _lock:
        j = _jobs.get(job_id)
        if not j:
            raise HTTPException(status_code=404, detail="job_not_found")
        out = {"status": j["status"], "percent": j.get("percent", 0), "stage": j.get("stage", "")}
        if j.get("error"):
            out["error"] = j["error"]
        if j["status"] == "done":
            out["loudnessAfter"] = j.get("loudnessAfter")
            out["processingTimeSec"] = j.get("processingTimeSec")
        return out


@app.get("/v1/jobs/{job_id}/download")
def download(job_id: str, file: str = "master", x_api_key: str | None = Header(default=None)):
    _require_key(x_api_key)
    with _lock:
        j = _jobs.get(job_id)
    if not j:
        raise HTTPException(status_code=404, detail="job_not_found")
    if j.get("status") != "done":
        raise HTTPException(status_code=409, detail="not_ready")
    path = j.get("master") if file == "master" else j.get("preview")
    if not path or not os.path.exists(path):
        raise HTTPException(status_code=404, detail="file_missing")
    media = "audio/wav" if file == "master" else "audio/mpeg"
    return FileResponse(path, media_type=media, filename=os.path.basename(path))
