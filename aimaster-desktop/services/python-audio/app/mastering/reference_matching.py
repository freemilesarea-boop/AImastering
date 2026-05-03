"""
Reference-matching analyzer (Ozone-style).

Builds a `ReferenceProfile` from any audio file capturing the dimensions
that the iterative master will try to match:

  · integrated LUFS / true peak / LRA
  · 4-band RMS energies (low / mid / vocal / high)
  · stereo width (mid/side ratio + LR correlation)
  · sample peak / crest factor

`compute_target_profile()` derives the target the iterative loop chases.
Currently it just copies the reference profile, but is structured so a
caller can later override individual axes (e.g. "match spectrum, but keep
target_lufs at -14 for Spotify").

`compute_match_score()` returns a 0–100 percentage per axis + an overall
weighted score, so the iterative loop can decide whether another pass is
worth running.

`derive_eq_correction()` returns a per-band gain delta in dB that
`multiband.build_multiband_eq_chain()` translates into an ffmpeg filter.

All functions degrade gracefully when soundfile / numpy is unavailable
(return None / empty profile).  Loudness is measured via the existing
loudnorm pass-1 wrapper.
"""
from __future__ import annotations

import math
import os
from dataclasses import dataclass, field
from typing import Any

from app.utils.ffmpeg_wrapper import loudnorm_pass1, FFmpegError
from app.utils.logger import log
from app.mastering.multiband import (
    BAND_DEFINITIONS, BAND_KEYS, measure_band_profile,
)

try:
    import numpy as np
    import soundfile as sf
    HAS_SF = True
except ImportError:
    HAS_SF = False


# ── Data model ──────────────────────────────────────────────────────────────

@dataclass
class ReferenceProfile:
    """Full Ozone-style fingerprint of a track."""
    path: str
    durationSec:   float
    integratedLufs: float
    truePeakDbtp:  float
    lra:           float
    samplePeakDb:  float
    rmsDb:         float
    crestDb:       float
    bands:         dict[str, float]    # 4-band RMS in dB (key → dB)
    stereoWidth:   float | None        # 0=mono, 1=natural, >1=wide
    lrCorrelation: float | None        # -1..+1
    available:     bool = True


def _empty_profile(path: str, reason: str) -> ReferenceProfile:
    return ReferenceProfile(
        path=path, durationSec=0.0,
        integratedLufs=-99.0, truePeakDbtp=0.0, lra=0.0,
        samplePeakDb=-120.0, rmsDb=-120.0, crestDb=0.0,
        bands={k: -120.0 for k in BAND_KEYS},
        stereoWidth=None, lrCorrelation=None,
        available=False,
    )


def _stereo_metrics(data: "np.ndarray") -> tuple[float | None, float | None]:
    if data.ndim < 2 or data.shape[1] < 2:
        return None, None
    l = data[:, 0]
    r = data[:, 1]
    # Mid/side energy ratio as a proxy for stereo width.  width ≈ 1.0 for a
    # natural stereo mix; > 1 for very wide; near 0 for almost-mono.
    mid  = 0.5 * (l + r)
    side = 0.5 * (l - r)
    mid_rms  = float(np.sqrt(np.mean(mid ** 2))) + 1e-12
    side_rms = float(np.sqrt(np.mean(side ** 2)))
    width = side_rms / mid_rms
    # Pearson correlation
    corr_mat = np.corrcoef(l, r)
    corr = float(corr_mat[0, 1]) if corr_mat.size >= 4 else None
    return round(float(width), 3), (round(corr, 3) if corr is not None else None)


# ── Public API ──────────────────────────────────────────────────────────────

def analyze_reference(file_path: str) -> ReferenceProfile:
    """
    Build a `ReferenceProfile` from a file.  Used both for the user-supplied
    reference track and for measuring iterative-master outputs.
    """
    if not os.path.isfile(file_path):
        return _empty_profile(file_path, "file not found")

    # Loudness via loudnorm pass-1 (LUFS / TP / LRA)
    try:
        ln = loudnorm_pass1(file_path)
        lufs = float(ln.get("input_i",   -99.0))
        tp   = float(ln.get("input_tp",    0.0))
        lra  = float(ln.get("input_lra",   0.0))
    except FFmpegError as exc:
        log("WARN", f"[reference] loudnorm pass1 failed: {exc}")
        lufs, tp, lra = -99.0, 0.0, 0.0

    if not HAS_SF:
        # Loudness only — band/stereo unavailable
        return ReferenceProfile(
            path=file_path, durationSec=0.0,
            integratedLufs=round(lufs, 2),
            truePeakDbtp=round(tp, 2),
            lra=round(lra, 2),
            samplePeakDb=-120.0, rmsDb=-120.0, crestDb=0.0,
            bands={k: -120.0 for k in BAND_KEYS},
            stereoWidth=None, lrCorrelation=None,
            available=False,
        )

    try:
        data, sr = sf.read(file_path, always_2d=True, dtype="float32")
    except Exception as exc:
        log("WARN", f"[reference] read failed: {exc}")
        return _empty_profile(file_path, str(exc))

    duration = data.shape[0] / sr
    mono = np.mean(data, axis=1) if data.ndim > 1 else data
    peak = float(np.max(np.abs(mono))) if mono.size else 0.0
    rms  = float(np.sqrt(np.mean(mono ** 2))) if mono.size else 0.0
    peak_db = 20.0 * math.log10(max(peak, 1e-12))
    rms_db  = 20.0 * math.log10(max(rms,  1e-12))
    crest   = peak_db - rms_db if rms > 0 else 0.0

    bands  = measure_band_profile(file_path)
    width, corr = _stereo_metrics(data)

    return ReferenceProfile(
        path=file_path,
        durationSec=round(duration, 3),
        integratedLufs=round(lufs, 2),
        truePeakDbtp=round(tp, 2),
        lra=round(lra, 2),
        samplePeakDb=round(peak_db, 2),
        rmsDb=round(rms_db, 2),
        crestDb=round(crest, 2),
        bands=bands or {k: -120.0 for k in BAND_KEYS},
        stereoWidth=width,
        lrCorrelation=corr,
        available=True,
    )


# ── Target profile derivation ────────────────────────────────────────────────

def compute_target_profile(
    reference: ReferenceProfile,
    *,
    target_lufs_override: float | None = None,
    target_tp_override:   float | None = None,
    target_lra_override:  float | None = None,
) -> dict[str, Any]:
    """
    Build the target profile the iterative master will chase.

    By default we copy the reference but allow per-axis overrides so callers
    can say "match spectrum/dynamics but cap loudness at Spotify's -14 LUFS".

    Returns a dict (not a dataclass) so it round-trips through JSON-RPC.

    Safety clamps:
      · target_tp clamped to [-9.0, -0.3] dBTP — loudnorm rejects values
        outside [-9, 0], and going above -0.3 invites inter-sample peaks.
      · target_lra clamped to [1.0, 30.0] LU.
    """
    if target_tp_override is not None:
        tp = float(target_tp_override)
    else:
        # Reference TP is the natural upper bound, but cap at -1.0 for safety
        # margin.  Lower bound is -8.0 (NOT -9.0) so the pipeline's internal
        # `loudnorm_tp_internal = target_tp - 0.5` stays inside loudnorm's
        # accepted [-9, 0] range.  Going below this also has no audible
        # benefit on a master.
        tp = min(-1.0, max(-8.0, float(reference.truePeakDbtp)))

    if target_lra_override is not None:
        lra = float(target_lra_override)
    else:
        lra = max(1.0, min(30.0, float(reference.lra)))

    return {
        "targetLufs":     target_lufs_override if target_lufs_override is not None else reference.integratedLufs,
        "targetTruePeak": round(tp, 2),
        "targetLra":      round(lra, 2),
        "targetBands":    dict(reference.bands),
        "targetStereoWidth":   reference.stereoWidth,
        "targetCrestDb":  reference.crestDb,
        "sourceReferencePath": reference.path,
    }


# ── Match scoring ───────────────────────────────────────────────────────────

def _axis_score(actual: float | None, target: float | None,
                tolerance_db: float, max_off_db: float) -> float | None:
    """
    Return 0–100 match score for a single axis.
    100 if |actual - target| ≤ tolerance, drops linearly to 0 at max_off_db.
    """
    if actual is None or target is None:
        return None
    if not math.isfinite(actual) or not math.isfinite(target):
        return None
    diff = abs(actual - target)
    if diff <= tolerance_db:
        return 100.0
    if diff >= max_off_db:
        return 0.0
    # Linear interp between tolerance (100) and max_off (0)
    return round(100.0 * (1.0 - (diff - tolerance_db) / (max_off_db - tolerance_db)), 1)


def compute_match_score(
    output: ReferenceProfile,
    target: dict[str, Any],
) -> dict[str, Any]:
    """
    Score how close the output is to the target profile per axis + overall.

    Weights:
      · LUFS    × 1.5   (most audible)
      · LRA     × 1.0
      · 4 bands × 1.0 each
      · stereo  × 0.5
    """
    scores: dict[str, Any] = {}

    scores["lufs"] = _axis_score(output.integratedLufs, target.get("targetLufs"),
                                  tolerance_db=0.5, max_off_db=4.0)
    scores["lra"]  = _axis_score(output.lra,            target.get("targetLra"),
                                  tolerance_db=1.0, max_off_db=6.0)
    scores["truePeak"] = _axis_score(output.truePeakDbtp, target.get("targetTruePeak"),
                                      tolerance_db=0.3, max_off_db=2.0)

    # Per-band scores
    target_bands = target.get("targetBands") or {}
    band_scores: dict[str, float | None] = {}
    for key in BAND_KEYS:
        band_scores[key] = _axis_score(
            output.bands.get(key), target_bands.get(key),
            tolerance_db=1.0, max_off_db=6.0,
        )
    scores["bands"] = band_scores

    # Stereo width
    if output.stereoWidth is not None and target.get("targetStereoWidth") is not None:
        diff = abs(output.stereoWidth - float(target["targetStereoWidth"]))
        if diff <= 0.05:
            scores["stereoWidth"] = 100.0
        elif diff >= 0.50:
            scores["stereoWidth"] = 0.0
        else:
            scores["stereoWidth"] = round(100.0 * (1.0 - (diff - 0.05) / 0.45), 1)
    else:
        scores["stereoWidth"] = None

    # Overall — weighted average of available scores
    weights = {
        "lufs":     1.5,
        "lra":      1.0,
        "truePeak": 0.7,
    }
    weighted_sum = 0.0
    weight_total = 0.0
    for k, w in weights.items():
        s = scores.get(k)
        if s is not None:
            weighted_sum += s * w
            weight_total += w
    for k, s in band_scores.items():
        if s is not None:
            weighted_sum += s * 1.0
            weight_total += 1.0
    if scores["stereoWidth"] is not None:
        weighted_sum += scores["stereoWidth"] * 0.5
        weight_total += 0.5

    overall = round(weighted_sum / weight_total, 1) if weight_total > 0 else 0.0
    scores["overall"] = overall

    # Identify weakest axis (for refinement hint)
    candidates: list[tuple[str, float]] = []
    for k in ("lufs", "lra", "truePeak"):
        if scores.get(k) is not None:
            candidates.append((k, scores[k]))
    for bk, bs in band_scores.items():
        if bs is not None:
            candidates.append((f"band:{bk}", bs))
    weakest = min(candidates, key=lambda x: x[1])[0] if candidates else None
    scores["weakestAxis"] = weakest

    return scores


# ── EQ correction derivation ────────────────────────────────────────────────

def derive_eq_correction(
    input_profile: ReferenceProfile,
    target: dict[str, Any],
    *,
    max_band_correction_db: float = 4.0,
) -> dict[str, float]:
    """
    Compute per-band gain delta (dB) needed to push input toward the target.

    Each delta = target_band_dB - input_band_dB, clamped to ±max_band_correction_db.
    We never recommend a vocal-band BOOST greater than +2 dB (vocal protection).
    """
    target_bands = target.get("targetBands") or {}
    out: dict[str, float] = {}
    for key in BAND_KEYS:
        if key not in target_bands or key not in input_profile.bands:
            continue
        delta = float(target_bands[key]) - float(input_profile.bands[key])
        # clamp
        max_pos = max_band_correction_db
        max_neg = -max_band_correction_db
        # Vocal band: never boost more than +2 dB to avoid harshness/sibilance
        if key == "vocal":
            max_pos = min(max_pos, 2.0)
        delta = max(max_neg, min(max_pos, delta))
        out[key] = round(delta, 2)
    return out
