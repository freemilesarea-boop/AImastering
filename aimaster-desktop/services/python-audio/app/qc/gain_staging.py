"""
Gain-staging QC for the v3.3 architectural fix.

The user-reported symptom — "메인 멜로디가 많이 눌리고 백그라운드는 커져서
밸런스에도 문제가 있는 것 같습니다" — has a measurable signature:

  · vocal / presence band (1.5–5 kHz) RMS drops more than
    background (200–800 Hz, 8–16 kHz) bands → balance shifted away
    from the lead.
  · crest factor drops by > 40 % (transients flattened).
  · LRA drops by > 50 % (compressed onto a single loudness level).
  · The signature usually co-occurs with one of:
        - input vs output band ratios shifted toward background
        - gain-staging report shows entry_gain push > 6 dB

This module computes those metrics on the input vs output WAV files and
returns a structured verdict that the pipeline can:

  · Surface in the QC report (with status ok / warn / danger)
  · Auto-recommend Vocal Safe Mode / Low Limiting Mode
  · Embed in the debug bundle for support tickets

When numpy / soundfile is unavailable the module returns
{"available": False} without raising.
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


# ── Band definitions (Hz) ────────────────────────────────────────────────────

VOCAL_PRESENCE_BAND      = (1500.0, 5000.0)   # main melody / vocal presence
BACKGROUND_LOWMID_BAND   = (200.0,  800.0)    # body / room / pad / bass mid
BACKGROUND_HIGH_BAND     = (8000.0, 16000.0)  # cymbals / room high
LOW_BAND                 = (20.0,   200.0)    # sub / bass body
HIGH_AIR_BAND            = (10000.0, 18000.0) # air

# ── Verdict thresholds ──────────────────────────────────────────────────────
_VOCAL_DROP_WARN_DB = 1.5
_VOCAL_DROP_DANG_DB = 3.0
_BG_RISE_WARN_DB    = 1.5
_BG_RISE_DANG_DB    = 3.0
_CREST_DROP_WARN    = 0.40    # 40% reduction
_CREST_DROP_DANG    = 0.55
_LRA_DROP_WARN      = 0.50
_LRA_DROP_DANG      = 0.70


def _db(linear: float) -> float:
    return 20.0 * math.log10(max(linear, 1e-12))


def _band_rms_db(mono: "np.ndarray", sr: int, lo_hz: float, hi_hz: float) -> float:
    """Return the RMS (dBFS) of `mono` filtered to [lo_hz, hi_hz] via FFT mask."""
    if mono.size == 0:
        return -120.0
    n = len(mono)
    spec = np.fft.rfft(mono)
    freqs = np.fft.rfftfreq(n, 1.0 / sr)
    mask = (freqs >= lo_hz) & (freqs <= hi_hz)
    spec_band = np.zeros_like(spec)
    spec_band[mask] = spec[mask]
    filtered = np.fft.irfft(spec_band, n=n)
    rms = float(np.sqrt(np.mean(filtered ** 2)))
    return _db(rms)


def _measure_bands(file_path: str, max_seconds: float = 60.0) -> dict[str, float] | None:
    if not HAS_SF:
        return None
    try:
        data, sr = sf.read(file_path, always_2d=True, dtype="float32")
    except Exception as exc:
        log("WARN", f"[gain_staging] read failed: {exc}")
        return None
    if data.size == 0:
        return None
    max_samples = int(max_seconds * sr)
    mono = np.mean(data[:max_samples], axis=1).astype(np.float32)
    return {
        "vocalPresence": round(_band_rms_db(mono, sr, *VOCAL_PRESENCE_BAND), 2),
        "backgroundLowMid": round(_band_rms_db(mono, sr, *BACKGROUND_LOWMID_BAND), 2),
        "backgroundHigh":   round(_band_rms_db(mono, sr, *BACKGROUND_HIGH_BAND), 2),
        "low":              round(_band_rms_db(mono, sr, *LOW_BAND), 2),
        "highAir":          round(_band_rms_db(mono, sr, *HIGH_AIR_BAND), 2),
    }


def build_gain_staging_report(
    *,
    input_metrics: dict[str, Any] | None,
    output_metrics: dict[str, Any] | None,
    input_path: str,
    output_path: str,
    pipeline_stages: dict[str, float],
) -> dict[str, Any]:
    """
    Build a single dict capturing every dB added during the mastering job:

        {
          "stages": {
            "compressorMakeupDb":  ...,
            "preGainDb":           ...,   # entry-gain push in static chain
            "limiterInputGainDb":  ...,
            "correctionGainDb":    ...,
            "ispCorrectionDb":     ...,
            "totalAppliedGainDb":  ...,
          },
          "bandsBefore":  {vocalPresence, backgroundLowMid, ...},
          "bandsAfter":   {...},
          "bandDeltaDb":  {vocalPresence, ...},
          "vocalLossDb":         float | None,
          "backgroundRiseDb":    float | None,
          "crestFactorDropPct":  float | None,
          "lraDropPct":          float | None,
          "verdict":             "ok" | "warn" | "danger",
          "issues":              [list of human-readable issue strings],
          "recommendations":     ["vocal_safe", "low_limit", ...],
        }
    """
    bands_before = _measure_bands(input_path) or {}
    bands_after  = _measure_bands(output_path) or {}

    band_delta: dict[str, float] = {}
    for key in bands_before:
        if key in bands_after:
            band_delta[key] = round(bands_after[key] - bands_before[key], 2)

    # ── Vocal presence loss vs background rise ──
    vocal_loss = None
    bg_rise    = None
    if "vocalPresence" in band_delta:
        # Vocal LOSS = how much vocal presence band fell relative to the
        # *average* movement of background bands.  Negative = vocal stayed up.
        bg_movements = [
            band_delta.get("backgroundLowMid"),
            band_delta.get("backgroundHigh"),
        ]
        bg_movements = [b for b in bg_movements if b is not None]
        bg_avg = sum(bg_movements) / len(bg_movements) if bg_movements else 0.0
        vocal_loss = round(bg_avg - band_delta["vocalPresence"], 2)
        bg_rise    = round(bg_avg, 2)

    # ── Crest factor / LRA reductions ──
    in_crest  = (input_metrics or {}).get("crestFactor")
    out_crest = (output_metrics or {}).get("crestFactor")
    crest_drop_pct = None
    if in_crest is not None and out_crest is not None and float(in_crest) > 0.5:
        crest_drop_pct = round(
            max(0.0, (float(in_crest) - float(out_crest)) / float(in_crest)),
            3,
        )

    in_lra  = (input_metrics or {}).get("lra")
    out_lra = (output_metrics or {}).get("lra")
    lra_drop_pct = None
    if in_lra is not None and out_lra is not None and float(in_lra) > 0.5:
        lra_drop_pct = round(
            max(0.0, (float(in_lra) - float(out_lra)) / float(in_lra)),
            3,
        )

    # ── Verdict ──
    issues: list[str] = []
    recs:   list[str] = []
    verdict = "ok"

    def _bump(new: str) -> None:
        nonlocal verdict
        rank = {"ok": 0, "warn": 1, "danger": 2}
        if rank[new] > rank[verdict]:
            verdict = new

    if vocal_loss is not None:
        if vocal_loss >= _VOCAL_DROP_DANG_DB:
            issues.append(
                f"보컬/메인 멜로디 (1.5~5 kHz) 가 배경 대비 {vocal_loss:.1f} dB 더 많이 줄었습니다."
            )
            recs.append("vocal_safe")
            _bump("danger")
        elif vocal_loss >= _VOCAL_DROP_WARN_DB:
            issues.append(
                f"보컬/메인 멜로디가 배경 대비 {vocal_loss:.1f} dB 정도 손실되었습니다."
            )
            recs.append("vocal_safe")
            _bump("warn")

    if bg_rise is not None and bg_rise > 0:
        if bg_rise >= _BG_RISE_DANG_DB:
            issues.append(f"배경 대역이 입력 대비 {bg_rise:.1f} dB 상승 — 노이즈/룸 부각")
            recs.append("low_limit")
            _bump("warn")
        elif bg_rise >= _BG_RISE_WARN_DB:
            issues.append(f"배경 대역이 {bg_rise:.1f} dB 상승")
            _bump("warn")

    if crest_drop_pct is not None:
        if crest_drop_pct >= _CREST_DROP_DANG:
            issues.append(f"crest factor 가 {crest_drop_pct*100:.0f}% 감소 — transient 평탄화")
            recs.append("low_limit")
            _bump("danger")
        elif crest_drop_pct >= _CREST_DROP_WARN:
            issues.append(f"crest factor 가 {crest_drop_pct*100:.0f}% 감소")
            recs.append("low_limit")
            _bump("warn")

    if lra_drop_pct is not None:
        if lra_drop_pct >= _LRA_DROP_DANG:
            issues.append(f"LRA 가 {lra_drop_pct*100:.0f}% 감소 — 다이내믹 손실 큼")
            recs.append("safe")
            _bump("danger")
        elif lra_drop_pct >= _LRA_DROP_WARN:
            issues.append(f"LRA 가 {lra_drop_pct*100:.0f}% 감소")
            recs.append("low_limit")
            _bump("warn")

    # Pre-limiter push warning (if entry_gain > 6 dB or correction > 6 dB)
    pre_push = float(pipeline_stages.get("preGainDb", 0.0))
    if pre_push > 6.0:
        issues.append(f"Limiter 직전 push 가 {pre_push:+.1f} dB — 권장 한도(+6 dB) 초과")
        recs.append("low_limit")
        _bump("warn")
    corr = float(pipeline_stages.get("correctionGainDb", 0.0))
    if abs(corr) > 6.0:
        issues.append(f"보정 패스가 {corr:+.1f} dB 추가 push — 목표 LUFS 가 너무 공격적")
        recs.append("safe")
        _bump("warn")

    # Total applied gain
    total = sum(float(pipeline_stages.get(k, 0.0)) for k in (
        "compressorMakeupDb", "preGainDb", "limiterInputGainDb",
        "correctionGainDb", "ispCorrectionDb",
    ))

    # Deduplicate recs, preserve order
    seen: set[str] = set()
    deduped_recs: list[str] = []
    for r in recs:
        if r not in seen:
            seen.add(r)
            deduped_recs.append(r)

    return {
        "stages": {
            **{k: round(float(v), 2) for k, v in pipeline_stages.items()},
            "totalAppliedGainDb": round(total, 2),
        },
        "bandsBefore":        bands_before,
        "bandsAfter":         bands_after,
        "bandDeltaDb":        band_delta,
        "vocalLossDb":        vocal_loss,
        "backgroundRiseDb":   bg_rise,
        "crestFactorDropPct": crest_drop_pct,
        "lraDropPct":         lra_drop_pct,
        "verdict":            verdict,
        "issues":             issues,
        "recommendations":    deduped_recs,
        "available":          HAS_SF,
    }
