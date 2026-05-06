"""
Iterative reference-matching mastering orchestrator.

Wraps `run_pipeline()` in a measure → refine → re-master loop, capped at
3 iterations.  Each iteration:

  1. Builds an EQ correction from input vs target band profile.
  2. Calls run_pipeline() with that correction injected as `reference_eq_correction`.
  3. Measures the output with `analyze_reference()`.
  4. Computes match scores vs the target.
  5. If overall ≥ accept_threshold OR no axis is improvable → stop.
     Else → refine output_gain and band corrections, loop.

Constraints (enforced unconditionally):
  · Vocal protection clamps stay active (engine guard).
  · Limiter is peak-safety only.
  · Total push tracked + capped (gain_staging report).

Returns a dict layered on top of the last iteration's run_pipeline result:
  {
    ...everything run_pipeline returned for the FINAL iteration...,
    "referenceMatch": {
       "overall": 87.5,
       "lufs": 95, "lra": 80, "truePeak": 100,
       "bands": {"low": 92, "mid": 85, "vocal": 90, "high": 75},
       "stereoWidth": 88,
       "weakestAxis": "band:high",
       "iterations": 2,
       "perIteration": [...short summary per pass...],
    },
    "referenceProfile": {...input reference fingerprint...},
    "targetProfile":    {...what the iterative loop chased...},
    "appliedBandCorrections": [{"band":"low","appliedDb":+1.2}, ...],
  }
"""
from __future__ import annotations

import os
import shutil
import tempfile
import time
from typing import Any, Callable

from app.mastering.pipeline import run_pipeline
from app.mastering.reference_matching import (
    analyze_reference,
    compute_target_profile,
    compute_match_score,
    derive_eq_correction,
    validate_reference,
    compare_input_vs_reference,
    ReferenceProfile,
)
from app.mastering.multiband import build_multiband_eq_chain, BAND_KEYS
from app.utils.logger import log


ProgressCallback = Callable[[str, int, str], None]


def _noop_progress(_a: str, _b: int, _c: str) -> None:
    pass


# ── Iterative early-stop output relocation ─────────────────────────────────
#
# H-33 fix (audit 2026-05): when an iterative job early-stops on iteration
# N (accept_threshold or MIN_IMPROVEMENT), only the WAV at `iter_out` was
# being copied to `output_path`.  The accompanying preview MP3 + waveform
# PNGs lived inside the temp work_dir and were deleted by the `finally`
# `shutil.rmtree(work_dir)` — leaving `last_result["previewPath"]`,
# `["afterWaveformPath"]`, etc., pointing to non-existent files.
#
# This helper copies every side-product the run_pipeline produced and
# patches `last_result` so the returned paths point to files that actually
# exist alongside `output_path`.
_SIDE_PRODUCT_KEYS = (
    "previewPath",
    "beforeWaveformPath",
    "afterWaveformPath",
    "compareWaveformPath",
)

def _relocate_iter_outputs(iter_out: str, output_path: str,
                            last_result: dict[str, Any]) -> None:
    # 1. WAV
    try:
        if iter_out != output_path:
            shutil.copyfile(iter_out, output_path)
    except OSError as exc:
        log("ERROR", f"[iterative] WAV copy failed ({iter_out} → {output_path}): {exc}")
        return

    # 2. Side products — copy each one whose path lives inside iter_out's
    #    base name to the output_path's base name + same suffix.
    iter_root   = os.path.splitext(iter_out)[0]
    output_root = os.path.splitext(output_path)[0]

    for key in _SIDE_PRODUCT_KEYS:
        src = last_result.get(key)
        if not src or not isinstance(src, str):
            continue
        if not os.path.isfile(src):
            log("WARN", f"[iterative] side product missing for {key}: {src}")
            last_result[key] = ""
            continue
        # Compute the suffix relative to iter_root, e.g. "_preview.mp3", "_after.png".
        if src.startswith(iter_root):
            suffix = src[len(iter_root):]
            dst = output_root + suffix
        else:
            # Fallback: keep the basename only.
            dst = os.path.join(os.path.dirname(output_path), os.path.basename(src))
        try:
            shutil.copyfile(src, dst)
            last_result[key] = dst
        except OSError as exc:
            log("WARN", f"[iterative] side-product copy failed ({src} → {dst}): {exc}")
            last_result[key] = ""

    # Also patch outputPath in case the caller reads it.
    last_result["outputPath"] = output_path


# ── Refinement strategy ────────────────────────────────────────────────────

# Stop iterating when overall match score crosses this threshold.
ACCEPT_THRESHOLD: float = 90.0
# Or when the score gain from the previous iteration falls below this.
MIN_IMPROVEMENT:  float = 1.5

# Per-iteration band-correction growth limit so iteration N+1's EQ delta is
# never wildly different from iteration N's (avoids ping-pong).
MAX_DELTA_GROWTH_DB: float = 1.5


def _refine_band_corrections(
    prev_corrections: dict[str, float],
    current_output_profile: ReferenceProfile,
    target: dict[str, Any],
) -> dict[str, float]:
    """
    Build the next iteration's band corrections by adding the residual
    delta (target - actual) to the previous correction, with a growth
    cap so we don't ping-pong.
    """
    target_bands = target.get("targetBands") or {}
    out: dict[str, float] = {}
    for key in BAND_KEYS:
        if key not in current_output_profile.bands or key not in target_bands:
            continue
        residual = float(target_bands[key]) - float(current_output_profile.bands[key])
        prev = float(prev_corrections.get(key, 0.0))
        # Add a damped portion of the residual (60 %) to avoid overshoot
        proposed = prev + 0.6 * residual
        # Limit growth from prev iteration
        proposed = max(prev - MAX_DELTA_GROWTH_DB,
                       min(prev + MAX_DELTA_GROWTH_DB, proposed))
        # Final clamp
        out[key] = round(max(-4.0, min(4.0, proposed)), 2)
    return out


# ── Main orchestrator ──────────────────────────────────────────────────────

def run_iterative_mastering(
    input_path: str,
    output_path: str,
    *,
    reference_path: str | None = None,
    target_profile_override: dict[str, Any] | None = None,
    target_lufs_override: float | None = None,
    max_iterations: int = 3,
    accept_threshold: float = ACCEPT_THRESHOLD,
    job_id: str = "ref_master",
    progress: ProgressCallback = _noop_progress,
    **pipeline_kwargs: Any,
) -> dict[str, Any]:
    """
    Run the iterative reference-matching loop.

    Either `reference_path` OR `target_profile_override` must be provided.
    `target_lufs_override` lets the caller cap loudness at a streaming-safe
    value while still matching the reference's spectrum / dynamics.
    """
    if not reference_path and not target_profile_override:
        raise ValueError(
            "iterative mastering requires reference_path or target_profile_override"
        )

    # ── 1. Analyze reference + build target ──
    progress(job_id, 2, "레퍼런스 분석 중")
    if reference_path:
        log("INFO", f"[iterative] analyzing reference: {reference_path}")
        ref_profile = analyze_reference(reference_path)
        target = compute_target_profile(
            ref_profile, target_lufs_override=target_lufs_override,
        )
    else:
        # Caller provided a raw target dict directly
        ref_profile = ReferenceProfile(
            path="(override)", durationSec=0.0,
            integratedLufs=float(target_profile_override.get("targetLufs", -14.0)),
            truePeakDbtp=float(target_profile_override.get("targetTruePeak", -1.0)),
            lra=float(target_profile_override.get("targetLra", 8.0)),
            samplePeakDb=-3.0, rmsDb=-18.0, crestDb=12.0,
            bands=dict(target_profile_override.get("targetBands") or {}),
            stereoWidth=target_profile_override.get("targetStereoWidth"),
            lrCorrelation=None, available=True,
        )
        target = dict(target_profile_override)
        if target_lufs_override is not None:
            target["targetLufs"] = target_lufs_override

    # ── 2. Analyze input (used for initial EQ correction derivation) ──
    progress(job_id, 8, "입력 파일 분석 중")
    input_profile = analyze_reference(input_path)

    # ── 2.5. Validate reference + compare input/reference compatibility ──
    # These warnings catch the "user picked a bad reference" case BEFORE
    # the iterative loop wastes time on it.
    reference_warnings: list[dict[str, str]] = []
    if reference_path:
        reference_warnings = validate_reference(ref_profile)
        compat_warnings   = compare_input_vs_reference(input_profile, ref_profile)
        reference_warnings.extend(compat_warnings)
        for w in reference_warnings:
            log("WARN" if w["severity"] in ("warn", "danger") else "INFO",
                f"[iterative] reference: [{w['code']}] {w['userMessage']}")

    # Initial band corrections derived from input vs target
    band_corrections = derive_eq_correction(input_profile, target)
    log("INFO", f"[iterative] initial band corrections: {band_corrections}")

    # ── 3. Iterate ──
    iterations: list[dict[str, Any]] = []
    last_score: float | None = None
    last_result: dict[str, Any] = {}

    # Working file for intermediate outputs (only the FINAL one becomes output_path)
    work_dir = tempfile.mkdtemp(prefix="aimaster_iter_")

    try:
        for i in range(1, max_iterations + 1):
            t0 = time.time()
            iter_pct_base = 10 + int((i - 1) * 80 / max_iterations)
            progress(job_id, iter_pct_base, f"마스터링 패스 {i}/{max_iterations}")

            iter_out = (output_path if i == max_iterations
                        else os.path.join(work_dir, f"iter_{i}.wav"))

            # Build the multi-band EQ correction filter for this iteration
            iter_protection_log: list[dict] = []
            mb_filter, mb_applied = build_multiband_eq_chain(
                band_corrections, protection_log=iter_protection_log,
            )
            log("INFO", f"[iterative] iter {i}: mb filter={mb_filter or '(empty)'}")

            # Inject reference EQ correction + target_lufs into pipeline call
            kwargs = dict(pipeline_kwargs)
            if "target_lufs" not in kwargs:
                kwargs["target_lufs"] = float(target.get("targetLufs", -14.0))
            if "target_tp" not in kwargs:
                kwargs["target_tp"]   = float(target.get("targetTruePeak", -1.0))
            kwargs["reference_eq_correction"] = mb_filter
            kwargs["reference_eq_applied"]    = mb_applied

            try:
                result = run_pipeline(
                    input_path, iter_out,
                    job_id=f"{job_id}_iter{i}",
                    progress=lambda *_: None,   # suppress nested progress
                    **kwargs,
                )
            except Exception as exc:
                log("ERROR", f"[iterative] iter {i} failed: {exc}")
                if i == 1:
                    raise
                # If a subsequent iteration fails, keep the previous output
                break

            # Measure output
            out_profile = analyze_reference(iter_out)
            scores = compute_match_score(out_profile, target)
            elapsed = round(time.time() - t0, 2)

            iterations.append({
                "iteration":        i,
                "elapsedSec":       elapsed,
                "bandCorrectionsDb": dict(band_corrections),
                "appliedBands":     mb_applied,
                "outputLufs":       out_profile.integratedLufs,
                "outputTruePeak":   out_profile.truePeakDbtp,
                "outputLra":        out_profile.lra,
                "outputBands":      dict(out_profile.bands),
                "scoreOverall":     scores.get("overall"),
                "scorePerAxis":     scores,
                "vocalProtectionClamps": iter_protection_log + (
                    (result.get("vocalProtection") or {}).get("appliedClamps", [])
                ),
            })
            last_result = result
            log("INFO", f"[iterative] iter {i} score={scores.get('overall'):.1f} "
                        f"(weakest={scores.get('weakestAxis')}, elapsed={elapsed}s)")

            # Stop conditions
            if scores.get("overall", 0) >= accept_threshold:
                log("INFO", f"[iterative] accepted at iter {i} "
                            f"(score {scores['overall']} ≥ {accept_threshold})")
                # Make sure final output (WAV + side products) is at output_path
                if iter_out != output_path:
                    _relocate_iter_outputs(iter_out, output_path, last_result)
                break
            if last_score is not None:
                improvement = scores.get("overall", 0) - last_score
                if improvement < MIN_IMPROVEMENT:
                    log("INFO", f"[iterative] stopping — improvement "
                                f"{improvement:+.1f} < {MIN_IMPROVEMENT}")
                    if iter_out != output_path:
                        _relocate_iter_outputs(iter_out, output_path, last_result)
                    break
            last_score = scores.get("overall", 0)

            # Refine band corrections for next pass
            band_corrections = _refine_band_corrections(
                band_corrections, out_profile, target,
            )

        else:
            # Loop completed all iterations — output_path is iter_max already
            pass

    finally:
        # Clean up work dir (output_path lives outside it)
        try:
            shutil.rmtree(work_dir, ignore_errors=True)
        except OSError:
            pass

    progress(job_id, 100, "완료")

    # ── 4. Build the merged result ──
    final_iter = iterations[-1] if iterations else {}
    out: dict[str, Any] = dict(last_result)
    out["referenceMatch"] = {
        "overall":       final_iter.get("scoreOverall"),
        "perAxis":       final_iter.get("scorePerAxis"),
        "weakestAxis":   (final_iter.get("scorePerAxis") or {}).get("weakestAxis"),
        "iterations":    len(iterations),
        "maxIterations": max_iterations,
        "perIteration": [
            {
                "iteration":  it["iteration"],
                "scoreOverall": it.get("scoreOverall"),
                "outputLufs": it.get("outputLufs"),
                "outputLra":  it.get("outputLra"),
                "elapsedSec": it.get("elapsedSec"),
            }
            for it in iterations
        ],
        "acceptThreshold": accept_threshold,
        "stoppedReason":  _stopped_reason(iterations, accept_threshold),
    }
    out["referenceProfile"] = {
        "path":            ref_profile.path,
        "integratedLufs":  ref_profile.integratedLufs,
        "truePeakDbtp":    ref_profile.truePeakDbtp,
        "lra":             ref_profile.lra,
        "samplePeakDb":    ref_profile.samplePeakDb,
        "rmsDb":           ref_profile.rmsDb,
        "crestDb":         ref_profile.crestDb,
        "bands":           ref_profile.bands,
        "stereoWidth":     ref_profile.stereoWidth,
        "lrCorrelation":   ref_profile.lrCorrelation,
        "available":       ref_profile.available,
    }
    out["targetProfile"] = target
    out["appliedBandCorrections"] = final_iter.get("appliedBands", [])

    # ── 4.5. Reference-quality guidance — surface to the UI ──
    out["referenceWarnings"] = reference_warnings
    # Also fold danger/warn-level reference issues into the standard
    # pipelineWarnings list so existing UI banners pick them up.
    if reference_warnings:
        existing = list(out.get("pipelineWarnings") or [])
        for w in reference_warnings:
            if w["severity"] in ("warn", "danger"):
                existing.append({
                    "code":  w["code"],
                    "level": "error" if w["severity"] == "danger" else "warning",
                    "userMessage": w["userMessage"],
                })
        out["pipelineWarnings"] = existing

    # Recommendations specific to the iterative loop
    recs = list(out.get("modeRecommendations") or [])
    weakest = (final_iter.get("scorePerAxis") or {}).get("weakestAxis")
    overall = final_iter.get("scoreOverall") or 0
    if overall < 70:
        recs.insert(0, {
            "mode":     "lower_target_lufs",
            "reason":   f"레퍼런스 매칭 점수 {overall:.0f}점 — target LUFS 를 더 낮추거나 다른 모드를 시도해보세요.",
            "severity": "warn",
            "evidence": [f"iterativeMatch.overall={overall}"],
        })
    elif weakest and weakest.startswith("band:"):
        bk = weakest.split(":", 1)[1]
        recs.insert(0, {
            "mode":     "manual_eq",
            "reason":   f"{bk} 대역이 레퍼런스와 가장 큰 차이 ({final_iter['scorePerAxis']['bands'].get(bk):.0f}점) — 수동 EQ 미세 조정 권장.",
            "severity": "info",
            "evidence": [f"iterativeMatch.weakest={weakest}"],
        })
    out["modeRecommendations"] = recs

    return out


def _stopped_reason(iterations: list[dict[str, Any]], threshold: float) -> str:
    if not iterations:
        return "no_iterations"
    last = iterations[-1]
    if last.get("scoreOverall", 0) >= threshold:
        return "accept_threshold_met"
    if len(iterations) > 1:
        prev = iterations[-2].get("scoreOverall") or 0
        cur  = last.get("scoreOverall") or 0
        if (cur - prev) < MIN_IMPROVEMENT:
            return "no_significant_improvement"
    return "max_iterations_reached"
