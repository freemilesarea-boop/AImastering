"""
Vocal-intelligence QC — analysis-only (Phase-C, audit 2026-05).

Ports the renderer-side `vocalEnhancer.ts` detection logic to Python
so the pipeline can surface vocal-presence warnings WITHOUT touching
the audio.  The corrective EQ that the renderer's enhanceVocal()
applies is intentionally NOT ported — the Python pipeline uses
adaptive EQ + dynamic EQ for shaping; another corrective pass would
risk double-correction.

What we detect:

  • CENTRALITY    — Mid (L+R)/2 RMS in 1.5–5 kHz vs Side (L-R)/2 RMS
                     in the same band.  Higher mid/side ratio = more
                     centered = more likely vocal.

  • PRESENCE      — vocal-band RMS in mid vs surrounding bands
                     (low-mid 200–1000 Hz, high 5–12 kHz).  If vocal
                     band sits ≥ 3 dB BELOW the average of the
                     surrounding bands, the vocal is "buried".

  • HARSHNESS     — 2.5–5 kHz mid RMS vs 1.0–2.5 kHz mid RMS.  If the
                     upper-vocal band exceeds the lower-vocal band by
                     ≥ 4 dB, sibilance / presence is too aggressive.

These thresholds match `vocalEnhancer.ts` so renderer + pipeline
diagnose consistently.

Returns a dict with `verdict` ('ok'/'warn'/'danger'), `findings`
(human-readable warnings), and `metrics` (raw measurements for
debugging).
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

try:
    import numpy as np
    import soundfile as sf
    HAS_NP = True
except ImportError:    # pragma: no cover
    HAS_NP = False

from app.utils.logger import log


# ── Thresholds (mirror vocalEnhancer.ts) ────────────────────────────────────

VOCAL_BAND_LO_HZ:    float = 1500.0
VOCAL_BAND_HI_HZ:    float = 5000.0
LOW_MID_LO_HZ:       float = 200.0
LOW_MID_HI_HZ:       float = 1000.0
HIGH_LO_HZ:          float = 5000.0
HIGH_HI_HZ:          float = 12000.0
HARSH_LO_HZ:         float = 2500.0
HARSH_HI_HZ:         float = 5000.0
LOWER_VOCAL_LO_HZ:   float = 1000.0
LOWER_VOCAL_HI_HZ:   float = 2500.0

# Centrality: mid band vs side band in vocal range, in dB.
CENTRALITY_OK_DB:     float = 6.0    # ≥6 dB → likely centered vocal
CENTRALITY_WARN_DB:   float = 3.0    # 3–6 dB → uncertain

# Buried: surrounding-band average minus vocal-band, in dB.
BURIED_WARN_GAP_DB:   float = 3.0
BURIED_DANGER_GAP_DB: float = 6.0

# Harshness: 2.5–5 kHz minus 1.0–2.5 kHz, in dB.
HARSH_WARN_DB:        float = 4.0
HARSH_DANGER_DB:      float = 7.0

# Below this absolute centrality the analysis bypasses (instrumentals,
# wide tracks).  Matches renderer's vocal-score bypass threshold.
INSTRUMENTAL_CENTRALITY_DB: float = 1.0


# ── Helpers ────────────────────────────────────────────────────────────────

def _band_rms_db(samples: np.ndarray, sr: int,
                 lo_hz: float, hi_hz: float) -> float:
    """RMS in dBFS within a frequency band, computed via FFT.  `samples`
    is a 1-D mono array."""
    n = len(samples)
    if n == 0:
        return -200.0
    spec  = np.fft.rfft(samples.astype(np.float64))
    freqs = np.fft.rfftfreq(n, 1.0 / sr)
    mask  = (freqs >= lo_hz) & (freqs < hi_hz)
    if not np.any(mask):
        return -200.0
    energy = float(np.sum(np.abs(spec[mask]) ** 2)) / n
    if energy <= 0:
        return -200.0
    return 10.0 * math.log10(energy)


# ── Public API ────────────────────────────────────────────────────────────

def run_vocal_intelligence(output_path: str) -> dict[str, Any]:
    """Analyze `output_path` for vocal-presence anomalies.  Returns:

        {
          "verdict":   "ok" | "warn" | "danger",
          "findings":  [ { "code", "level", "userMessage" }, ... ],
          "metrics":   { "centralityDb", "buriedGapDb", "harshExcessDb",
                         "vocalBandDb", "lowMidDb", "highDb",
                         "lowerVocalDb", "harshBandDb" },
        }

    No-op when soundfile is unavailable (returns verdict='ok' + skipped=True)."""
    if not HAS_NP:
        return {"verdict": "ok", "findings": [], "skipped": True,
                "reason": "numpy/soundfile unavailable"}

    try:
        data, sr = sf.read(output_path, always_2d=True)
    except Exception as exc:
        log("WARN", f"[vocal_intel] read failed: {exc}")
        return {"verdict": "ok", "findings": [], "skipped": True,
                "reason": str(exc)}

    if data.size == 0:
        return {"verdict": "ok", "findings": [], "skipped": True,
                "reason": "empty"}

    # Build mid + side mono signals.
    if data.shape[1] >= 2:
        mid  = (data[:, 0] + data[:, 1]) * 0.5
        side = (data[:, 0] - data[:, 1]) * 0.5
    else:
        # Mono — centrality is undefined (treat as max).
        mid = data[:, 0]
        side = np.zeros_like(mid)

    # Per-band RMS measurements.
    vocal_db        = _band_rms_db(mid,  sr, VOCAL_BAND_LO_HZ, VOCAL_BAND_HI_HZ)
    side_vocal_db   = _band_rms_db(side, sr, VOCAL_BAND_LO_HZ, VOCAL_BAND_HI_HZ)
    low_mid_db      = _band_rms_db(mid,  sr, LOW_MID_LO_HZ,    LOW_MID_HI_HZ)
    high_db         = _band_rms_db(mid,  sr, HIGH_LO_HZ,       HIGH_HI_HZ)
    harsh_db        = _band_rms_db(mid,  sr, HARSH_LO_HZ,      HARSH_HI_HZ)
    lower_vocal_db  = _band_rms_db(mid,  sr, LOWER_VOCAL_LO_HZ, LOWER_VOCAL_HI_HZ)

    centrality_db = vocal_db - side_vocal_db if data.shape[1] >= 2 else 60.0
    buried_gap_db = (low_mid_db + high_db) / 2.0 - vocal_db
    harsh_excess_db = harsh_db - lower_vocal_db

    findings: list[dict[str, Any]] = []

    # If the track isn't centered enough to be a vocal mix, skip.
    if centrality_db < INSTRUMENTAL_CENTRALITY_DB:
        return {
            "verdict": "ok", "findings": [], "skipped": True,
            "reason": (f"insufficient centrality ({centrality_db:.1f} dB < "
                       f"{INSTRUMENTAL_CENTRALITY_DB:.1f}) — likely instrumental"),
            "metrics": {
                "centralityDb":   round(centrality_db, 2),
                "buriedGapDb":    round(buried_gap_db, 2),
                "harshExcessDb":  round(harsh_excess_db, 2),
                "vocalBandDb":    round(vocal_db, 2),
                "lowMidDb":       round(low_mid_db, 2),
                "highDb":         round(high_db, 2),
                "lowerVocalDb":   round(lower_vocal_db, 2),
                "harshBandDb":    round(harsh_db, 2),
            },
        }

    # Buried vocal — vocal band sits below surrounding bands.
    if buried_gap_db >= BURIED_DANGER_GAP_DB:
        findings.append({
            "code":  "VOCAL_BURIED_DANGER",
            "level": "error",
            "userMessage": (f"보컬 대역이 주변 대역보다 {buried_gap_db:.1f} dB 약합니다 "
                            f"(보컬 {vocal_db:.1f} dBFS / 주변 평균 "
                            f"{(low_mid_db + high_db) / 2:.1f} dBFS).  "
                            f"마스터링 결과 보컬이 묻혀 들립니다 — "
                            f"vocal_safe 모드로 재마스터링 권장."),
        })
    elif buried_gap_db >= BURIED_WARN_GAP_DB:
        findings.append({
            "code":  "VOCAL_BURIED_WARN",
            "level": "warning",
            "userMessage": (f"보컬 대역이 주변 대역보다 {buried_gap_db:.1f} dB 약합니다.  "
                            f"보컬 명료도가 줄어들 수 있습니다."),
        })

    # Harshness — 2.5-5 kHz way louder than 1-2.5 kHz.
    if harsh_excess_db >= HARSH_DANGER_DB:
        findings.append({
            "code":  "VOCAL_HARSH_DANGER",
            "level": "error",
            "userMessage": (f"2.5–5 kHz 가 1–2.5 kHz 보다 {harsh_excess_db:.1f} dB 강합니다 "
                            f"— 보컬이 거칠고 sibilant 합니다.  "
                            f"de-esser 강화 또는 vocal_safe 모드 권장."),
        })
    elif harsh_excess_db >= HARSH_WARN_DB:
        findings.append({
            "code":  "VOCAL_HARSH_WARN",
            "level": "warning",
            "userMessage": (f"2.5–5 kHz 가 약간 강조됨 ({harsh_excess_db:.1f} dB) — "
                            f"고출력 시 거친 느낌이 들 수 있습니다."),
        })

    has_danger = any(f["level"] == "error"   for f in findings)
    has_warn   = any(f["level"] == "warning" for f in findings)
    overall    = "danger" if has_danger else ("warn" if has_warn else "ok")

    return {
        "verdict": overall,
        "findings": findings,
        "skipped": False,
        "metrics": {
            "centralityDb":   round(centrality_db, 2),
            "buriedGapDb":    round(buried_gap_db, 2),
            "harshExcessDb":  round(harsh_excess_db, 2),
            "vocalBandDb":    round(vocal_db, 2),
            "lowMidDb":       round(low_mid_db, 2),
            "highDb":         round(high_db, 2),
            "lowerVocalDb":   round(lower_vocal_db, 2),
            "harshBandDb":    round(harsh_db, 2),
        },
    }
