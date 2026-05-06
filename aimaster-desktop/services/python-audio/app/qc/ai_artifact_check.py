"""
AI-generated music artifact detector (Phase-D, audit 2026-05).

AI music generators (Suno, Udio, Riffusion, MusicGen, etc.) leave
distinctive footprints that traditional production rarely produces:

  • PHASE ANOMALY    — overly-decorrelated stereo (correlation < -0.1
                        across long durations is unphysical for live
                        recordings; AI models often output L/R that
                        sounds wide but has phase issues)

  • METALLIC RING    — sharp 4–7 kHz peaks above the surrounding
                        spectrum (vocoder / neural-vocoder ringing
                        from the AI's spectrogram→audio inversion)

  • SUB-RUMBLE       — anomalous 20–40 Hz energy from incorrect
                        DC handling in the AI's neural net (often
                        sounds like a low hum)

This is NON-CORRECTIVE — surfaces findings as warnings so the user
can decide whether to mask them via mastering EQ or re-generate
the source.  Hard-clamping AI artifacts at the master stage usually
makes them worse (they sit in narrow bands the EQ can't isolate
without affecting real content).
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


# ── Thresholds ─────────────────────────────────────────────────────────────

# Stereo correlation: AI-decorrelated tracks often have negative correlation
# (L = -R inversion) which collapses to silence on mono fold.
PHASE_ANOMALY_WARN:    float = -0.15   # below this → phase inversion suspect
PHASE_ANOMALY_DANGER:  float = -0.40

# Metallic ring: 4-7 kHz peak energy minus surrounding (2-4 kHz + 7-12 kHz).
# Real vocals + cymbals can naturally have +3-4 dB; +6 dB+ is suspicious.
METALLIC_WARN_DB:      float = 6.0
METALLIC_DANGER_DB:    float = 9.0

# Sub-rumble: 20-40 Hz energy minus 60-120 Hz energy.  Real bass content
# has the kick fundamental in 60-120 — sub-rumble being LOUDER than
# kick is unphysical for music masters.
SUB_RUMBLE_WARN_DB:    float = -3.0    # 20-40 Hz at -3 dB below 60-120
SUB_RUMBLE_DANGER_DB:  float = +3.0    # 20-40 Hz LOUDER than kick range


# ── Helpers ────────────────────────────────────────────────────────────────

def _band_rms_db(samples: "np.ndarray", sr: int,
                 lo_hz: float, hi_hz: float) -> float:
    if len(samples) == 0:
        return -200.0
    spec  = np.fft.rfft(samples.astype(np.float64))
    freqs = np.fft.rfftfreq(len(samples), 1.0 / sr)
    mask  = (freqs >= lo_hz) & (freqs < hi_hz)
    if not np.any(mask):
        return -200.0
    energy = float(np.sum(np.abs(spec[mask]) ** 2)) / len(samples)
    if energy <= 0:
        return -200.0
    return 10.0 * math.log10(energy)


def _stereo_correlation(data: "np.ndarray") -> float | None:
    """Pearson correlation between L and R channels.  Returns None on
    failure (mono input, all zeros)."""
    if data.shape[1] < 2:
        return 1.0
    l, r = data[:, 0], data[:, 1]
    if np.std(l) == 0 or np.std(r) == 0:
        return 1.0
    cc = np.corrcoef(l, r)[0, 1]
    if not np.isfinite(cc):
        return None
    return float(cc)


# ── Public API ─────────────────────────────────────────────────────────────

def run_ai_artifact_check(file_path: str) -> dict[str, Any]:
    """Analyze `file_path` for the three AI artifact signatures.

    Returns:
      {
        "verdict":  "ok" | "warn" | "danger",
        "findings": [ { "code", "level", "userMessage" }, ... ],
        "metrics":  { "stereoCorrelation", "metallicExcessDb",
                       "subRumbleExcessDb" },
        "skipped":  bool,
      }
    """
    if not HAS_NP:
        return {"verdict": "ok", "findings": [], "skipped": True,
                "reason": "numpy/soundfile unavailable"}

    try:
        data, sr = sf.read(file_path, always_2d=True)
    except Exception as exc:
        log("WARN", f"[ai_artifact] read failed: {exc}")
        return {"verdict": "ok", "findings": [], "skipped": True,
                "reason": str(exc)}

    if data.size == 0:
        return {"verdict": "ok", "findings": [], "skipped": True,
                "reason": "empty"}

    # Mid for spectral measurements.
    if data.shape[1] >= 2:
        mid = (data[:, 0] + data[:, 1]) * 0.5
    else:
        mid = data[:, 0]

    # ── Spectral measurements ──
    metallic_band_db   = _band_rms_db(mid, sr, 4000, 7000)
    surround_low_db    = _band_rms_db(mid, sr, 2000, 4000)
    surround_high_db   = _band_rms_db(mid, sr, 7000, 12000)
    surround_mean_db   = (surround_low_db + surround_high_db) / 2.0
    metallic_excess_db = metallic_band_db - surround_mean_db

    sub_db        = _band_rms_db(mid, sr, 20, 40)
    kick_band_db  = _band_rms_db(mid, sr, 60, 120)
    sub_excess_db = sub_db - kick_band_db

    correlation = _stereo_correlation(data)

    findings: list[dict[str, Any]] = []

    # ── Phase anomaly ──
    if correlation is not None and correlation <= PHASE_ANOMALY_DANGER:
        findings.append({
            "code":  "AI_PHASE_DANGER",
            "level": "error",
            "userMessage": (f"L/R 상관관계 {correlation:+.2f} — "
                            f"위상 반전이 의심됩니다 (AI 생성 트랙의 인위적 wide stereo).  "
                            f"모노 폴드 시 cancellation 발생.  원본 stem을 mid-summed "
                            f"버전으로 재생성 권장."),
        })
    elif correlation is not None and correlation <= PHASE_ANOMALY_WARN:
        findings.append({
            "code":  "AI_PHASE_WARN",
            "level": "warning",
            "userMessage": (f"L/R 상관관계 {correlation:+.2f} — "
                            f"비정상적으로 wide 한 stereo image (AI 디코더 부산물).  "
                            f"모노 호환성에 주의가 필요합니다."),
        })

    # ── Metallic ring ──
    if metallic_excess_db >= METALLIC_DANGER_DB:
        findings.append({
            "code":  "AI_METALLIC_DANGER",
            "level": "error",
            "userMessage": (f"4–7 kHz 가 주변보다 {metallic_excess_db:.1f} dB 강조됨 — "
                            f"AI vocoder ringing 의심.  보컬에서 'metallic' / "
                            f"'autotune-like' 사운드가 들릴 수 있습니다.  "
                            f"5.5 kHz peak EQ -3 dB 또는 de-esser 강화 권장."),
        })
    elif metallic_excess_db >= METALLIC_WARN_DB:
        findings.append({
            "code":  "AI_METALLIC_WARN",
            "level": "warning",
            "userMessage": (f"4–7 kHz 가 주변보다 {metallic_excess_db:.1f} dB 강조됨 — "
                            f"vocoder 또는 spectrogram 변환 부산물 가능성."),
        })

    # ── Sub-rumble ──
    if sub_excess_db >= SUB_RUMBLE_DANGER_DB:
        findings.append({
            "code":  "AI_SUB_RUMBLE_DANGER",
            "level": "error",
            "userMessage": (f"20–40 Hz 가 60–120 Hz (kick) 보다 {sub_excess_db:+.1f} dB "
                            f"강합니다 — AI 모델의 DC 처리 오류로 발생하는 sub rumble.  "
                            f"30 Hz 이하 highpass 권장."),
        })
    elif sub_excess_db >= SUB_RUMBLE_WARN_DB:
        findings.append({
            "code":  "AI_SUB_RUMBLE_WARN",
            "level": "warning",
            "userMessage": (f"20–40 Hz 가 kick 대역 대비 {sub_excess_db:+.1f} dB — "
                            f"비정상적 sub rumble 가능성."),
        })

    has_danger = any(f["level"] == "error"   for f in findings)
    has_warn   = any(f["level"] == "warning" for f in findings)
    overall    = "danger" if has_danger else ("warn" if has_warn else "ok")

    return {
        "verdict": overall,
        "findings": findings,
        "skipped":  False,
        "metrics": {
            "stereoCorrelation":  round(correlation, 4) if correlation is not None else None,
            "metallicExcessDb":   round(metallic_excess_db, 2),
            "subRumbleExcessDb":  round(sub_excess_db, 2),
            "metallicBandDb":     round(metallic_band_db, 2),
            "surroundMeanDb":     round(surround_mean_db, 2),
            "subBandDb":          round(sub_db, 2),
            "kickBandDb":         round(kick_band_db, 2),
        },
    }
