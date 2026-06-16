# AImastering — HTTP mastering API (M0).
#
# Thin FastAPI wrapper that REUSES the existing python-audio engine unchanged:
#   analyze_file(path)                      -> Stage-1 analysis dict
#   master_file(params, job_id, progress)   -> writes master WAV + preview MP3
#
# It does NOT modify the engine or the desktop app.  The engine package is
# named `app`; this server is a single module (`server`) to avoid a package
# name clash, and inserts the engine dir on sys.path.
import datetime
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
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
    FastAPI, File, Form, Header, HTTPException, UploadFile, BackgroundTasks, Body,
)
from fastapi.responses import FileResponse, JSONResponse  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware         # noqa: E402

API_KEY = os.environ.get("MASTERING_API_KEY", "")
# CORS: the mobile app runs in a Capacitor WebView (origin https://localhost on
# Android) and sends an X-API-Key header → cross-origin requests are preflighted.
# Without CORS the WebView blocks every call. Auth is header-based (not cookies),
# so a permissive origin is safe; override via CORS_ALLOW_ORIGINS (comma list).
_origins_env = os.environ.get("CORS_ALLOW_ORIGINS", "*").strip()
CORS_ORIGINS = ["*"] if _origins_env in ("", "*") else [o.strip() for o in _origins_env.split(",") if o.strip()]
WORK_ROOT = os.path.join(os.environ.get("WORK_DIR", tempfile.gettempdir()), "aimaster_jobs")
JOB_TTL = int(os.environ.get("JOB_TTL_SECONDS", "3600"))
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "60"))
# Same ffmpeg the engine uses (apt 'ffmpeg' in Docker; AIMASTER_FFMPEG locally).
FFMPEG = os.environ.get("AIMASTER_FFMPEG", "ffmpeg")
# Optional admin alert webhook (Slack/Discord compatible). Unset = disabled.
ERROR_WEBHOOK_URL = os.environ.get("ERROR_WEBHOOK_URL", "").strip()
os.makedirs(WORK_ROOT, exist_ok=True)

_jobs: dict[str, dict] = {}
_lock = threading.Lock()

app = FastAPI(title="AImastering Mastering API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=False,  # auth is via X-API-Key header, not cookies
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition"],
)


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


# ── Error reporting ───────────────────────────────────────────────────────────
def _new_receipt_id() -> str:
    day = datetime.datetime.utcnow().strftime("%Y%m%d")
    # Crockford-ish alphabet (no ambiguous chars) for a short human receipt code.
    suf = "".join(random.choices("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", k=4))
    return f"ERR-{day}-{suf}"


def _redact(text: object, maxlen: int = 500) -> str:
    s = text if isinstance(text, str) else str(text)
    if API_KEY and API_KEY in s:
        s = s.replace(API_KEY, "***")          # never echo the shared key
    return s[:maxlen]


def _safe_file_meta(meta: object) -> dict:
    # Keep only non-identifying numbers/type. Drop any original filename/path.
    if not isinstance(meta, dict):
        return {}
    out: dict = {}
    for k in ("ext", "mime", "sizeBytes", "durationSec"):
        if k in meta and meta[k] is not None:
            v = meta[k]
            out[k] = _redact(v, 40) if isinstance(v, str) else v
    return out


def _post_webhook(rec: dict) -> None:
    # Best-effort admin alert. Payload carries both Slack ("text") and Discord
    # ("content") keys so a single URL of either kind works. Never raises.
    try:
        msg = (f":rotating_light: [error-report] {rec['receipt_id']} "
               f"step={rec['step']} code={rec['error_code']} "
               f"platform={rec['platform']} ver={rec['app_version']}\n"
               f"job={rec['job_id']} file={rec['file_meta']}\n{rec['message'][:300]}")
        data = json.dumps({"text": msg, "content": msg}).encode("utf-8")
        req = urllib.request.Request(
            ERROR_WEBHOOK_URL, data=data,
            headers={"Content-Type": "application/json"}, method="POST",
        )
        urllib.request.urlopen(req, timeout=5).close()
    except Exception:
        pass


# ── Routes ────────────────────────────────────────────────────────────────────
@app.get("/healthz")
def healthz():
    return {"ok": True, "engine_dir": ENGINE_DIR, "jobs": len(_jobs)}


@app.post("/v1/error-reports")
def error_reports(payload: dict = Body(default={}), x_api_key: str | None = Header(default=None)):
    _require_key(x_api_key)
    rid = _new_receipt_id()
    rec = {
        "receipt_id": rid,
        "app_version": _redact(payload.get("app_version", ""), 40),
        "platform": _redact(payload.get("platform", ""), 40),
        "step": _redact(payload.get("step", ""), 40),
        "job_id": _redact(payload.get("job_id", ""), 64),
        "error_code": _redact(payload.get("error_code", ""), 80),
        "message": _redact(payload.get("sanitized_message", payload.get("message", "")), 500),
        "file_meta": _safe_file_meta(payload.get("file_meta")),
        "client_ts": _redact(payload.get("timestamp", ""), 40),
        "server_ts": datetime.datetime.utcnow().isoformat() + "Z",
    }
    # Structured server log (no original file/PII/key).
    print(
        f"[error-report] receipt_id={rec['receipt_id']} step={rec['step']} "
        f"job_id={rec['job_id']} code={rec['error_code']} platform={rec['platform']} "
        f"ver={rec['app_version']} file_meta={rec['file_meta']} msg={rec['message'][:200]!r}",
        flush=True,
    )
    if ERROR_WEBHOOK_URL:
        threading.Thread(target=_post_webhook, args=(rec,), daemon=True).start()
    return {"receipt_id": rid}


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


def _preconvert_stereo_pcm(src: str, dst: str, sample_rate: int) -> None:
    """Decode any input (incl. 6ch/EAC3) to 44.1k (or target) stereo 24-bit PCM
    once, so the engine's many downstream passes skip per-pass recompression and
    non-standard layouts are downmixed early. Server-side only (no engine change)."""
    cmd = [
        FFMPEG, "-hide_banner", "-loglevel", "error", "-y",
        "-i", src, "-ac", "2", "-ar", str(sample_rate),
        "-c:a", "pcm_s24le", dst,
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def _run_master(job_id: str, in_path: str, out_path: str, opts: dict) -> None:
    # Per-stage timing for profiling: record wall-clock at each progress change.
    prof: dict[str, float] = {}
    state = {"last_stage": "start", "last_t": time.time()}

    def progress(jid: str, percent: int, stage: str) -> None:
        now = time.time()
        prof[state["last_stage"]] = prof.get(state["last_stage"], 0.0) + (now - state["last_t"])
        state["last_stage"], state["last_t"] = stage, now
        with _lock:
            j = _jobs.get(job_id)
            if j:
                j["status"] = "processing"
                j["percent"] = int(percent)
                j["stage"] = str(stage)

    t0 = time.time()
    # mode: "fast" (default for the test app) trims work; "quality" = full engine.
    mode = str(opts.get("mode", "quality")).lower()
    fast = mode == "fast" or bool(opts.get("fast", False))
    sample_rate = int(opts.get("sample_rate", opts.get("sampleRate", 44100)))
    engine_in = in_path
    pre_dt = 0.0

    try:
        with _lock:
            _jobs[job_id]["status"] = "processing"

        # Fast mode: normalize/downmix the input to stereo PCM up front.
        if fast:
            pcm_path = os.path.join(os.path.dirname(out_path), "preconv.wav")
            t_pre = time.time()
            try:
                _preconvert_stereo_pcm(in_path, pcm_path, sample_rate)
                engine_in = pcm_path
            except Exception as exc:  # fall back to the original input
                print(f"[profile] job={job_id} preconvert_failed err={exc!r}", flush=True)
            pre_dt = time.time() - t_pre

        # generate_waveforms is always off — the API never returns waveform PNGs,
        # so generating them is wasted work. AI corrections stay ON in both modes:
        # profiling showed disabling them yields no speedup (the costly "correction
        # pass" is loudness-target correction, not AI), so turning them off would
        # only reduce quality. Fast mode's lever is the up-front preconvert above.
        params = {
            "input_path": engine_in,
            "output_path": out_path,
            "style": opts.get("style", "balanced"),
            "target_lufs": opts.get("target_lufs", opts.get("targetLufs", -14.0)),
            "target_tp": opts.get("target_tp", opts.get("targetTp", -1.0)),
            "lra": opts.get("lra", 11.0),
            "sample_rate": sample_rate,
            "bit_depth": opts.get("bit_depth", opts.get("bitDepth", 24)),
            "apply_ai_corrections": opts.get(
                "apply_ai_corrections", opts.get("applyAiCorrections", True)
            ),
            "ai_detections": opts.get("ai_detections", opts.get("aiDetections", {})),
            "generate_waveforms": False,
            # Fast mode (mobile): skip the passes the app doesn't need — preview
            # MP3 (generated lazily by the engine), the loudness correction pass,
            # and all post-master analysis/QC. Quality mode keeps full behavior.
            "skip_preview": fast,
            "skip_correction": fast,
            "skip_post_analysis": fast,
        }
        result = master_file(params, job_id, progress)
        # close out the final stage's timing
        prof[state["last_stage"]] = prof.get(state["last_stage"], 0.0) + (time.time() - state["last_t"])
        total = time.time() - t0

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
        stages = {k: round(v, 1) for k, v in prof.items() if v >= 0.05}
        print(
            f"[profile] job={job_id} mode={'fast' if fast else 'quality'} "
            f"total={total:.1f}s preconvert={pre_dt:.1f}s stages={stages}",
            flush=True,
        )
    except Exception as e:
        with _lock:
            _jobs[job_id].update(status="error", stage="error", error=str(e))
        print(f"[profile] job={job_id} mode={'fast' if fast else 'quality'} FAILED err={e!r}", flush=True)
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
