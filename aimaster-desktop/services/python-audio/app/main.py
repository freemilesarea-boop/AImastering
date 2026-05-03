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
from app.mastering.mastering import master_file, master_with_reference
from app.mastering.reference_matching import (
    analyze_reference, compute_target_profile, validate_reference,
    compare_input_vs_reference,
)
from app.mastering.reference_presets import (
    list_reference_presets, get_reference_preset, recommend_preset_for_input,
)
from app.mastering.safe_modes import list_safe_modes
from app.qc.qc_checker import run_qc
from app.utils.debug_bundle import export_debug_bundle
from app.utils.env_info import collect_env_info
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


def _handle_master_with_reference(params: dict, job_id: str) -> dict:
    for key in ("input_path", "output_path"):
        if not params.get(key):
            raise ValueError(f"params.{key} is required")

    # Accept `reference_preset` as a built-in alternative to a reference file.
    # The preset is expanded into a full target_profile dict before delegating.
    preset_key = params.get("reference_preset")
    if preset_key and not params.get("target_profile"):
        preset_target = get_reference_preset(preset_key)
        if preset_target is None:
            raise ValueError(
                f"Unknown reference_preset: {preset_key!r}. "
                f"Use list_reference_presets to see available keys."
            )
        params = dict(params)  # don't mutate caller's dict
        params["target_profile"] = preset_target

    if not params.get("reference_path") and not params.get("target_profile"):
        raise ValueError(
            "params.reference_path, params.target_profile, "
            "or params.reference_preset is required"
        )
    return master_with_reference(params, job_id, _send_progress)


def _handle_analyze_reference(params: dict, _job_id: str) -> dict:
    """Analyze a reference track without mastering — used by the UI to
    preview a reference's profile before kicking off iterative mastering.

    Optionally accepts an `input_path` so the UI can show a compatibility
    check (e.g. "이 reference 는 입력 곡과 잘 안 맞습니다") in real time.
    """
    file_path  = params.get("file_path")
    input_path = params.get("input_path")
    if not file_path:
        raise ValueError("params.file_path is required")
    profile = analyze_reference(file_path)
    target  = compute_target_profile(profile)
    warnings = validate_reference(profile)
    if input_path:
        from app.mastering.reference_matching import analyze_reference as _ar
        in_profile = _ar(input_path)
        warnings.extend(compare_input_vs_reference(in_profile, profile))
    return {
        "profile": {
            "path":           profile.path,
            "durationSec":    profile.durationSec,
            "integratedLufs": profile.integratedLufs,
            "truePeakDbtp":   profile.truePeakDbtp,
            "lra":            profile.lra,
            "samplePeakDb":   profile.samplePeakDb,
            "rmsDb":          profile.rmsDb,
            "crestDb":        profile.crestDb,
            "bands":          profile.bands,
            "stereoWidth":    profile.stereoWidth,
            "lrCorrelation":  profile.lrCorrelation,
            "available":      profile.available,
        },
        "targetProfile": target,
        "warnings":      warnings,
    }


def _handle_list_reference_presets(_params: dict, _job_id: str) -> dict:
    """Return all built-in reference presets (no audio analysis required)."""
    return {"presets": list_reference_presets()}


def _handle_recommend_reference_preset(params: dict, _job_id: str) -> dict:
    """
    Auto-recommend a preset for a given input file.  Used by the UI to
    show "이 곡엔 ___ 프리셋이 어울려요" when no reference is selected.
    """
    file_path = params.get("file_path")
    if not file_path:
        raise ValueError("params.file_path is required")
    profile = analyze_reference(file_path)
    if not profile.available:
        return {"recommendation": None, "reason": "input file unanalyzable"}
    rec = recommend_preset_for_input(profile)
    return {"recommendation": rec, "inputProfile": {
        "integratedLufs": profile.integratedLufs,
        "lra":            profile.lra,
        "crestDb":        profile.crestDb,
        "bands":          profile.bands,
    }}


def _handle_qc(params: dict, _job_id: str) -> dict:
    file_path = params.get("file_path")
    if not file_path:
        raise ValueError("params.file_path is required")
    return run_qc(
        file_path,
        float(params.get("target_lufs", -14.0)),
        float(params.get("target_tp",   -1.0)),
    )


def _handle_env_info(_params: dict, _job_id: str) -> dict:
    """Return host / runtime info — used by the UI's debug panel."""
    return {
        "environment": collect_env_info(),
        "safeModes":   list_safe_modes(),
    }


def _handle_export_debug_bundle(params: dict, _job_id: str) -> dict:
    """
    Export a debug bundle zip from a previous mastering result.

    Expected params:
      output_path             — where to write the .zip
      debug_summary           — value of result.debugSummary (recorder summary)
      mastering_result        — full result dict (used for inputFileInfo, etc.)
      include_audio           — bool (default False)
      user_consent_audio      — bool (default False) — must be true to bundle audio
    """
    output_zip = params.get("output_path")
    if not output_zip:
        raise ValueError("params.output_path is required")
    summary = params.get("debug_summary") or {}
    full    = params.get("mastering_result") or {}

    # Build a recorder-equivalent dict from the result (for callers who only
    # have the JSON-RPC response, not the in-process recorder).
    recorder_dict = {
        "jobId":             summary.get("jobId") or full.get("jobId") or "unknown",
        "environment":       (summary.get("environment") or {}) or collect_env_info(),
        "input":             full.get("inputFileInfo") or {},
        "masteringSettings": full.get("analysisReport", {}).get("mastering") or {},
        "filterChain":       summary.get("filterChain") or {},
        "stages":            summary.get("stages") or [],
        "events":            (summary.get("warnings") or []) + (summary.get("errors") or []),
        "ffmpegInvocations": [],
        "metricsBefore":     full.get("metricComparison") and {} or {},
        "metricsAfter":      {},
        "limiterQc":         full.get("limiterCheck") or {},
        "suspectSegments":   full.get("suspectSegments") or [],
        "recommendations":   full.get("modeRecommendations") or [],
        "outputPath":        full.get("outputPath", ""),
        "artifactDir":       summary.get("artifactDir"),
    }
    return export_debug_bundle(
        recorder_dict,
        output_zip,
        quality_check         = full.get("qualityCheck"),
        limiter_check         = full.get("limiterCheck"),
        waveform_after_path   = full.get("afterWaveformPath", ""),
        waveform_before_path  = full.get("beforeWaveformPath", ""),
        include_audio         = bool(params.get("include_audio", False)),
        user_consent_audio    = bool(params.get("user_consent_audio", False)),
    )


HANDLERS = {
    "analyze":                   _handle_analyze,
    "master":                    _handle_master,
    "master_with_reference":     _handle_master_with_reference,
    "analyze_reference":         _handle_analyze_reference,
    "list_reference_presets":    _handle_list_reference_presets,
    "recommend_reference_preset": _handle_recommend_reference_preset,
    "qc_check":                  _handle_qc,
    "env_info":                  _handle_env_info,
    "export_debug_bundle":       _handle_export_debug_bundle,
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
