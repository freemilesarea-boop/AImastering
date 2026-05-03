"""
Debug logger / recorder for the mastering pipeline.

Each mastering job creates one DebugRecorder instance.  Stages (analyzer,
ffprobe, filter chain build, ffmpeg pass1/pass2, limiter, ISP, correction
pass, QC) push timestamped entries into it.  At the end of the run the
recorder can:

  · Serialize itself to JSON (for inclusion in result + bundle)
  · Persist a human-readable text log to disk
  · Hand its contents to debug_bundle.export() for zip packaging

Goal — when a user reports "vocal mush / radio quality / over-limiting",
this recorder is the single artifact that lets us reproduce the issue:
input metadata, host environment, full filter chain, ffmpeg stderr, and
per-stage RMS / loudness deltas.

The recorder is intentionally side-effect-free until persist() / to_dict()
is called.  Mastering completes successfully even if logging itself fails
(every public method swallows its own exceptions).
"""
from __future__ import annotations

import json
import os
import tempfile
import time
import uuid
from typing import Any

from app.utils.env_info import collect_env_info, is_debug_mode
from app.utils.logger import log


# ── Storage policy ───────────────────────────────────────────────────────────
# Trim ffmpeg stderr so a single job doesn't carry hundreds of KB of warnings
# back through JSON-RPC.  Full stderr is still written to disk in debug mode.

_STDERR_TAIL_KB = 16        # JSON payload cap per ffmpeg invocation
_STDERR_FULL_KB = 512       # disk cap per invocation in debug mode


def _now() -> float:
    return time.time()


def _trim(text: str, kb: int) -> str:
    if not text:
        return ""
    cap = kb * 1024
    if len(text) <= cap:
        return text
    head = cap // 4
    tail = cap - head - 32
    return text[:head] + f"\n…[truncated {len(text) - cap} bytes]…\n" + text[-tail:]


# ── Recorder ─────────────────────────────────────────────────────────────────

class DebugRecorder:
    """Per-job structured debug recorder.  Thread-unsafe (one job = one recorder)."""

    def __init__(self, job_id: str = "", debug_mode: bool | None = None) -> None:
        self.job_id = job_id or uuid.uuid4().hex[:12]
        self.debug_mode = is_debug_mode() if debug_mode is None else bool(debug_mode)
        self.t_start: float = _now()
        self.events: list[dict[str, Any]] = []
        self.ffmpeg_invocations: list[dict[str, Any]] = []
        self.filter_chain: dict[str, Any] = {}
        self.input_info: dict[str, Any] = {}
        self.environment: dict[str, Any] = collect_env_info()
        self.mastering_settings: dict[str, Any] = {}
        self.stages: list[dict[str, Any]] = []
        self.suspect_segments: list[dict[str, Any]] = []
        self.limiter_qc: dict[str, Any] = {}
        self.metrics_before: dict[str, Any] = {}
        self.metrics_after: dict[str, Any] = {}
        self.recommendations: list[dict[str, Any]] = []
        self.output_path: str = ""
        # Working dir for persisted artifacts (created lazily)
        self._artifact_dir: str | None = None

    # ── Helpers (all wrapped to never raise) ────────────────────────────

    def _safe(self, fn, *args, **kwargs) -> None:
        try:
            fn(*args, **kwargs)
        except Exception as exc:
            log("WARN", f"[debug_logger] ignored error in {fn.__name__}: {exc}")

    def event(self, level: str, message: str, **fields: Any) -> None:
        self._safe(self._event_unchecked, level, message, fields)

    def _event_unchecked(self, level: str, message: str, fields: dict[str, Any]) -> None:
        entry = {
            "t":      round(_now() - self.t_start, 3),
            "level":  level,
            "msg":    message,
        }
        if fields:
            entry["data"] = fields
        self.events.append(entry)

    def stage(self, name: str, **fields: Any) -> None:
        self._safe(self._stage_unchecked, name, fields)

    def _stage_unchecked(self, name: str, fields: dict[str, Any]) -> None:
        self.stages.append({
            "t":    round(_now() - self.t_start, 3),
            "name": name,
            "data": fields,
        })

    def set_input_info(self, info: dict[str, Any]) -> None:
        self._safe(self._set_input_unchecked, info)

    def _set_input_unchecked(self, info: dict[str, Any]) -> None:
        self.input_info = dict(info)

    def set_filter_chain(self, **fields: Any) -> None:
        self._safe(self._set_filter_unchecked, fields)

    def _set_filter_unchecked(self, fields: dict[str, Any]) -> None:
        self.filter_chain.update(fields)

    def set_mastering_settings(self, settings: dict[str, Any]) -> None:
        self._safe(self._set_settings_unchecked, settings)

    def _set_settings_unchecked(self, settings: dict[str, Any]) -> None:
        self.mastering_settings = dict(settings)

    def record_ffmpeg(
        self,
        kind: str,
        cmd: list[str] | None = None,
        filter_str: str = "",
        stderr: str = "",
        ok: bool = True,
        duration_sec: float | None = None,
    ) -> None:
        self._safe(
            self._record_ffmpeg_unchecked,
            kind, cmd, filter_str, stderr, ok, duration_sec,
        )

    def _record_ffmpeg_unchecked(
        self, kind: str, cmd: list[str] | None, filter_str: str,
        stderr: str, ok: bool, duration_sec: float | None,
    ) -> None:
        entry = {
            "t":          round(_now() - self.t_start, 3),
            "kind":       kind,
            "ok":         ok,
            "filter":     filter_str,
            "stderrTail": _trim(stderr, _STDERR_TAIL_KB),
        }
        if cmd:
            entry["cmd"] = list(cmd)
        if duration_sec is not None:
            entry["durationSec"] = round(duration_sec, 3)
        self.ffmpeg_invocations.append(entry)
        # Persist full stderr to disk in debug mode for offline inspection
        if self.debug_mode and stderr:
            self._safe(self._persist_stderr, kind, stderr)

    def _persist_stderr(self, kind: str, stderr: str) -> None:
        d = self._ensure_artifact_dir()
        idx = len(self.ffmpeg_invocations)
        path = os.path.join(d, f"ffmpeg_{idx:02d}_{kind}.stderr.log")
        with open(path, "w", encoding="utf-8", errors="replace") as f:
            f.write(_trim(stderr, _STDERR_FULL_KB))

    def add_suspect_segment(
        self,
        start: float, end: float, reason: str,
        severity: str = "warn", details: str = "",
        **extra: Any,
    ) -> None:
        self._safe(self._add_segment_unchecked, start, end, reason, severity, details, extra)

    def _add_segment_unchecked(
        self, start: float, end: float, reason: str,
        severity: str, details: str, extra: dict[str, Any],
    ) -> None:
        seg: dict[str, Any] = {
            "start":    round(float(start), 3),
            "end":      round(float(end),   3),
            "reason":   reason,
            "severity": severity,
            "details":  details,
        }
        if extra:
            seg.update(extra)
        self.suspect_segments.append(seg)

    def set_limiter_qc(self, qc: dict[str, Any]) -> None:
        self._safe(self._set_limiter_qc_unchecked, qc)

    def _set_limiter_qc_unchecked(self, qc: dict[str, Any]) -> None:
        self.limiter_qc = dict(qc)

    def set_metrics(self, before: dict[str, Any], after: dict[str, Any]) -> None:
        self._safe(self._set_metrics_unchecked, before, after)

    def _set_metrics_unchecked(self, before: dict[str, Any], after: dict[str, Any]) -> None:
        self.metrics_before = dict(before or {})
        self.metrics_after  = dict(after or {})

    def add_recommendation(self, mode: str, reason: str, severity: str = "info") -> None:
        self._safe(self._add_rec_unchecked, mode, reason, severity)

    def _add_rec_unchecked(self, mode: str, reason: str, severity: str) -> None:
        self.recommendations.append({
            "mode":     mode,
            "reason":   reason,
            "severity": severity,
        })

    # ── Artifact dir management ──────────────────────────────────────────

    def _ensure_artifact_dir(self) -> str:
        if self._artifact_dir and os.path.isdir(self._artifact_dir):
            return self._artifact_dir
        try:
            base = os.environ.get("AIMASTER_DEBUG_DIR") or os.path.join(
                tempfile.gettempdir(), "aimaster_debug"
            )
            os.makedirs(base, exist_ok=True)
            d = os.path.join(base, f"job_{self.job_id}")
            os.makedirs(d, exist_ok=True)
            self._artifact_dir = d
            return d
        except Exception:
            # Fall back to plain temp dir
            d = tempfile.mkdtemp(prefix="aimaster_dbg_")
            self._artifact_dir = d
            return d

    def artifact_dir(self) -> str | None:
        """Return the current artifact dir (or None if never created)."""
        return self._artifact_dir

    # ── Serialization ────────────────────────────────────────────────────

    def to_dict(self) -> dict[str, Any]:
        return {
            "jobId":           self.job_id,
            "debugMode":       self.debug_mode,
            "elapsedSec":      round(_now() - self.t_start, 3),
            "environment":     self.environment,
            "input":           self.input_info,
            "masteringSettings": self.mastering_settings,
            "filterChain":     self.filter_chain,
            "stages":          self.stages,
            "events":          self.events,
            "ffmpegInvocations": self.ffmpeg_invocations,
            "metricsBefore":   self.metrics_before,
            "metricsAfter":    self.metrics_after,
            "limiterQc":       self.limiter_qc,
            "suspectSegments": self.suspect_segments,
            "recommendations": self.recommendations,
            "outputPath":      self.output_path,
            "artifactDir":     self._artifact_dir,
        }

    def persist(self) -> str | None:
        """Write debug.json into the artifact dir.  Returns the path or None."""
        try:
            d = self._ensure_artifact_dir()
            path = os.path.join(d, "debug.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump(self.to_dict(), f, ensure_ascii=False, indent=2, default=str)
            return path
        except Exception as exc:
            log("WARN", f"[debug_logger] persist failed: {exc}")
            return None

    # Compact summary embedded in the JSON-RPC response — keeps payload small.
    def to_summary(self) -> dict[str, Any]:
        return {
            "jobId":           self.job_id,
            "debugMode":       self.debug_mode,
            "elapsedSec":      round(_now() - self.t_start, 3),
            "ffmpegInvocations": len(self.ffmpeg_invocations),
            "stages":          [s.get("name") for s in self.stages],
            "warnings":        [e for e in self.events if e.get("level") == "WARN"],
            "errors":          [e for e in self.events if e.get("level") == "ERROR"],
            "filterChain":     self.filter_chain,
            "limiterQc":       self.limiter_qc,
            "suspectSegments": self.suspect_segments,
            "recommendations": self.recommendations,
            "artifactDir":     self._artifact_dir,
        }
