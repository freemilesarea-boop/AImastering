"""
Time-series RMS / loudness / peak analysis for the debug-quality system.

Splits a file into fixed-length windows (default 0.5 s, with optional 1.0 s)
and produces per-window:

  · RMS (dBFS)
  · short-term loudness proxy (1 s sliding LUFS approximation via K-weighted
    RMS — close enough for spotting sudden drops without pulling in libebur128)
  · sample peak (dBFS)
  · crest factor (dB)

From the time-series we then locate "suspect segments":

  · sudden RMS drop > drop_threshold dB while peak stays attached to ceiling
    → indicates excessive limiter gain reduction (vocal mush / pumping)
  · sustained crest factor < 4 dB
    → brickwall-flat region (radio-quality / over-compressed)
  · sudden RMS drop without ceiling-attached peak
    → mix-level imbalance / dropout

Returns shape:
  {
    "windowSec": 0.5,
    "windows": [{"start", "end", "rmsDb", "peakDb", "crestDb", "stLufs"}, ...],
    "suspectSegments": [
       {"start", "end", "reason", "severity", "details"}, ...
    ],
    "summary": {"rmsP05": ..., "rmsP95": ..., "rmsSpread": ..., "minCrest": ...},
  }

Designed so callers don't need numpy — when it's missing the module returns
an empty result with a "skipped" reason rather than raising.
"""
from __future__ import annotations

import math
from typing import Any

from app.utils.logger import log

try:
    import numpy as np
    import soundfile as sf
    HAS_SF = True
except ImportError:
    HAS_SF = False


# ── Defaults (tuned to the user's symptoms) ──────────────────────────────────

_RMS_DROP_DB_DEFAULT      = 5.0    # dB drop vs. running median
_CREST_FLAT_DB            = 4.0    # crest factor below = brickwall-suspect
_CREST_TIGHT_DB           = 6.0    # crest factor below = warn
_CEILING_ATTACH_DB        = 0.5    # peak within this distance of ceiling = attached
_MIN_SEGMENT_FRAMES       = 2      # don't report 1-window blips
_MERGE_GAP_FRAMES         = 1      # merge segments separated by ≤ N windows


def _db(x: float) -> float:
    if x <= 0:
        return -120.0
    return 20.0 * math.log10(x)


def _running_median(arr: "np.ndarray", w: int) -> "np.ndarray":
    """Simple windowed median for trend detection.  Edges fall back to scalar."""
    n = len(arr)
    if n == 0 or w <= 1:
        return arr.copy()
    out = np.empty(n, dtype=arr.dtype)
    half = w // 2
    for i in range(n):
        lo = max(0, i - half)
        hi = min(n, i + half + 1)
        out[i] = float(np.median(arr[lo:hi]))
    return out


def _merge_runs(flags: "np.ndarray", min_len: int, merge_gap: int) -> list[tuple[int, int]]:
    """
    Convert a boolean array into a list of (start, end_exclusive) runs.
    Adjacent runs separated by ≤ merge_gap zeroes are merged; runs shorter
    than min_len are dropped.
    """
    n = len(flags)
    runs: list[tuple[int, int]] = []
    i = 0
    while i < n:
        if not flags[i]:
            i += 1
            continue
        j = i + 1
        while j < n:
            if flags[j]:
                j += 1
                continue
            # peek across the gap
            k = j
            while k < n and not flags[k] and k - j < merge_gap:
                k += 1
            if k < n and flags[k]:
                j = k
                continue
            break
        runs.append((i, j))
        i = j
    return [r for r in runs if (r[1] - r[0]) >= min_len]


# ── Public API ───────────────────────────────────────────────────────────────

def compute_segment_timeseries(
    file_path: str,
    *,
    window_sec: float = 0.5,
    ceiling_dbtp: float = -1.0,
) -> dict[str, Any]:
    """
    Build the per-window time series + suspect-segment list for a file.
    """
    if not HAS_SF:
        return {
            "windowSec": window_sec,
            "windows": [],
            "suspectSegments": [],
            "summary": None,
            "skipped": "soundfile/numpy not available",
        }

    try:
        data, sr = sf.read(file_path, always_2d=True, dtype="float32")
    except Exception as exc:
        log("WARN", f"[segment] read failed: {exc}")
        return {
            "windowSec": window_sec, "windows": [], "suspectSegments": [],
            "summary": None, "skipped": f"read failed: {exc}",
        }

    if data.size == 0:
        return {
            "windowSec": window_sec, "windows": [], "suspectSegments": [],
            "summary": None, "skipped": "empty file",
        }

    mono = np.mean(data, axis=1) if data.ndim == 2 else data
    win = max(1, int(round(window_sec * sr)))
    n_wins = max(1, len(mono) // win)
    if n_wins < 3:
        return {
            "windowSec": window_sec, "windows": [], "suspectSegments": [],
            "summary": None, "skipped": "too short",
        }

    rms_db   = np.empty(n_wins, dtype=np.float32)
    peak_db  = np.empty(n_wins, dtype=np.float32)
    crest_db = np.empty(n_wins, dtype=np.float32)
    st_lufs  = np.empty(n_wins, dtype=np.float32)

    # Pre-emphasis filter: simple 1-pole high-shelf approximating K-weighting
    # so short-term loudness tracks vocal energy, not just sub-bass.
    pre = mono.copy()
    if len(pre) > 1:
        pre[1:] = pre[1:] - 0.85 * pre[:-1]

    for i in range(n_wins):
        seg     = mono[i * win:(i + 1) * win]
        seg_pre = pre[i * win:(i + 1) * win]
        if seg.size == 0:
            rms_db[i] = peak_db[i] = crest_db[i] = -120.0
            st_lufs[i] = -120.0
            continue
        rms = float(np.sqrt(np.mean(seg ** 2)))
        peak = float(np.max(np.abs(seg)))
        rms_db[i]  = _db(rms)
        peak_db[i] = _db(peak)
        crest_db[i] = peak_db[i] - rms_db[i] if rms > 0 else 0.0
        st_rms = float(np.sqrt(np.mean(seg_pre ** 2)))
        # K-weighted offset: BS.1770 reference is ~ -0.691 dB; tweak to
        # land near loudnorm integrated values for typical music.
        st_lufs[i] = _db(st_rms) - 0.691

    windows = [
        {
            "start":  round(i * window_sec, 3),
            "end":    round((i + 1) * window_sec, 3),
            "rmsDb":  round(float(rms_db[i]), 2),
            "peakDb": round(float(peak_db[i]), 2),
            "crestDb": round(float(crest_db[i]), 2),
            "stLufs": round(float(st_lufs[i]), 2),
        }
        for i in range(n_wins)
    ]

    # ── Suspect segment detection ──
    median_rms = _running_median(rms_db, w=max(5, int(2.0 / window_sec)))
    drop_db    = median_rms - rms_db   # positive = current window is quieter than trend

    flag_drop_with_ceiling   = (drop_db >= _RMS_DROP_DB_DEFAULT) & \
                               (peak_db >= ceiling_dbtp - _CEILING_ATTACH_DB)
    flag_drop_only           = (drop_db >= _RMS_DROP_DB_DEFAULT) & \
                               (peak_db <  ceiling_dbtp - _CEILING_ATTACH_DB)
    flag_brickwall           = crest_db < _CREST_FLAT_DB
    flag_tight_crest         = (crest_db < _CREST_TIGHT_DB) & ~flag_brickwall

    suspects: list[dict[str, Any]] = []

    def _emit(runs: list[tuple[int, int]], reason: str, severity: str, details_fn) -> None:
        for (a, b) in runs:
            details = details_fn(a, b)
            suspects.append({
                "start":   round(a * window_sec, 3),
                "end":     round(b * window_sec, 3),
                "reason":  reason,
                "severity": severity,
                "details": details,
            })

    _emit(
        _merge_runs(flag_drop_with_ceiling, _MIN_SEGMENT_FRAMES, _MERGE_GAP_FRAMES),
        "excessive_limiter_reduction", "warn",
        lambda a, b: (
            f"RMS dropped {float(np.max(drop_db[a:b])):.1f} dB while peak "
            f"stayed within {_CEILING_ATTACH_DB:.1f} dB of ceiling"
        ),
    )
    _emit(
        _merge_runs(flag_drop_only, _MIN_SEGMENT_FRAMES + 1, _MERGE_GAP_FRAMES),
        "sudden_rms_drop", "info",
        lambda a, b: (
            f"RMS dropped {float(np.max(drop_db[a:b])):.1f} dB "
            f"(peak not at ceiling — likely natural mix dynamics)"
        ),
    )
    _emit(
        _merge_runs(flag_brickwall, _MIN_SEGMENT_FRAMES, _MERGE_GAP_FRAMES),
        "brickwall_flat", "warn",
        lambda a, b: (
            f"crest factor min {float(np.min(crest_db[a:b])):.1f} dB — "
            f"waveform is flattened (radio-quality / over-compression suspect)"
        ),
    )
    _emit(
        _merge_runs(flag_tight_crest, _MIN_SEGMENT_FRAMES + 1, _MERGE_GAP_FRAMES),
        "tight_crest", "info",
        lambda a, b: (
            f"crest factor avg {float(np.mean(crest_db[a:b])):.1f} dB "
            f"— sustained tight dynamics"
        ),
    )

    summary = {
        "rmsP05":     round(float(np.percentile(rms_db,  5)),  2),
        "rmsP50":     round(float(np.percentile(rms_db, 50)),  2),
        "rmsP95":     round(float(np.percentile(rms_db, 95)),  2),
        "rmsSpread":  round(float(np.percentile(rms_db, 95) - np.percentile(rms_db, 5)), 2),
        "minCrestDb": round(float(np.min(crest_db)), 2),
        "ceilingAttachedFrac": round(float(np.mean(peak_db >= ceiling_dbtp - _CEILING_ATTACH_DB)), 3),
    }

    return {
        "windowSec":       window_sec,
        "windows":         windows,
        "suspectSegments": suspects,
        "summary":         summary,
    }
