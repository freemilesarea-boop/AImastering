#!/usr/bin/env python3
"""
AI Cleanup v2 PoC — standalone CLI (TEST-ONLY).

This tool is NOT part of the commercial mastering pipeline.  It does not touch
run_pipeline, MasteringOptions, presets, IPC, the renderer, or the Export path.

Usage:
    python scripts/ai_cleanup_v2_poc.py \
        --input "/path/to/input.wav" \
        --output-dir "/path/to/output" \
        --start 45 --duration 15 \
        --strength gentle --wet auto \
        --reconstruction on --retry on
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Optional

# Make `app...` importable when run directly from the scripts/ directory.
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)  # services/python-audio
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

import numpy as np
import soundfile as sf

from app.mastering.ai_cleanup_v2.processor import Processor, ProcessorConfig, ProcessingResult
from app.mastering.ai_cleanup_v2.blend import get_default_wet_ratio


# ============================================================================
# Constants
# ============================================================================

DEFAULT_DURATION_SEC = 15.0
MIN_DURATION_SEC = 5.0
MAX_DURATION_SEC = 30.0

REPORT_VERSION = 2


# ============================================================================
# Segment Extraction
# ============================================================================

def extract_segment(
    input_path: str,
    start_sec: float,
    duration_sec: float,
) -> tuple:
    """
    Extract a segment from input file.

    Returns: (audio, sample_rate, info_dict)
    """
    info = sf.info(input_path)
    sr = int(info.samplerate)
    total_frames = int(info.frames)
    total_dur = total_frames / sr

    # Clamp start/duration
    clamped = False
    start = max(0.0, float(start_sec))
    if start >= total_dur:
        start = 0.0
        clamped = True

    avail = total_dur - start
    dur = float(duration_sec)
    if dur > avail:
        dur = avail
        clamped = True

    start_frame = int(round(start * sr))
    num_frames = min(int(round(dur * sr)), total_frames - start_frame)

    audio, _ = sf.read(
        input_path,
        start=start_frame,
        frames=num_frames,
        always_2d=True,
        dtype="float64",
    )

    return audio, sr, {
        "fileName": os.path.basename(input_path),
        "startSec": round(start, 3),
        "durationSec": round(num_frames / sr, 3),
        "sampleRate": sr,
        "channels": audio.shape[1],
        "clamped": clamped,
    }


# ============================================================================
# Report Generation
# ============================================================================

def build_report(
    result: ProcessingResult,
    input_info: dict,
    config: ProcessorConfig,
    processing_time_ms: int,
) -> dict:
    """Build comprehensive JSON report."""

    def serialize_safety(sr):
        return {
            "passed": sr.passed,
            "failures": [
                {
                    "code": f.code,
                    "message": f.message,
                    "category": f.category,
                    "retryable": f.retryable,
                    "value": f.value,
                    "threshold": f.threshold,
                }
                for f in sr.failures
            ],
            "warnings": sr.warnings,
            "can_retry": sr.can_retry,
        }

    def serialize_retry_history(rh):
        return {
            "attempts": [
                {
                    "attempt": a.attempt,
                    "wet_ratio": a.wet_ratio,
                    "reconstruction_enabled": a.reconstruction_enabled,
                    "passed": a.safety_result.passed,
                    "failures": len(a.safety_result.failures),
                }
                for a in rh.attempts
            ],
            "final_attempt": rh.final_attempt,
            "final_wet_ratio": rh.final_wet_ratio,
            "bypassed": rh.bypassed,
            "success": rh.success,
        }

    return {
        "version": REPORT_VERSION,
        "input": input_info,
        "settings": {
            "strength": config.strength,
            "wet_ratio": config.get_wet_ratio(),
            "reconstruction_enabled": config.reconstruction_enabled,
            "retry_enabled": config.retry_enabled,
        },
        "before": result.original_metrics,
        "after": result.processed_metrics,
        "delta": {
            "rms_db": round(
                result.processed_metrics.get("rms_db", 0) -
                result.original_metrics.get("rms_db", 0), 4
            ),
            "peak_db": round(
                result.processed_metrics.get("peak_db", 0) -
                result.original_metrics.get("peak_db", 0), 4
            ),
            "true_peak_dbtp": round(
                (result.processed_metrics.get("true_peak_dbtp", 0) or 0) -
                (result.original_metrics.get("true_peak_dbtp", 0) or 0), 4
            ) if result.original_metrics.get("true_peak_dbtp") else None,
            "stereo_correlation": round(
                (result.processed_metrics.get("stereo_correlation", 0) or 0) -
                (result.original_metrics.get("stereo_correlation", 0) or 0), 4
            ) if result.original_metrics.get("stereo_correlation") else None,
        },
        "difference": result.difference_metrics,
        "blend": {
            "wet_ratio": result.blend_result.wet_ratio,
            "dry_rms_db": round(result.blend_result.dry_rms_db, 3),
            "wet_rms_db_original": round(result.blend_result.wet_rms_db_original, 3),
            "wet_rms_db_matched": round(result.blend_result.wet_rms_db_matched, 3),
            "gain_applied_db": round(result.blend_result.gain_applied_db, 3),
        },
        "peak_control": {
            "original_peak_dbtp": round(result.peak_control_result.original_peak_dbtp, 3),
            "processed_peak_dbtp": round(result.peak_control_result.processed_peak_dbtp, 3),
            "corrected_peak_dbtp": round(result.peak_control_result.corrected_peak_dbtp, 3),
            "gain_applied_db": round(result.peak_control_result.gain_applied_db, 3),
            "clipping_introduced": result.peak_control_result.clipping_introduced,
            "measurement_method": result.peak_control_result.measurement_method,
        },
        "mask": result.mask_result.stats,
        "smoothing": result.smoothing_stats,
        "protection": result.protection_result.stats,
        "reconstruction": (
            result.reconstruction_result.stats
            if result.reconstruction_result else {"enabled": False}
        ),
        "safety": serialize_safety(result.safety_result),
        "retry": serialize_retry_history(result.retry_history),
        "bypassed": result.bypassed,
        "bypass_reason": result.bypass_reason,
        "processingTimeMs": processing_time_ms,
    }


def render_report_txt(report: dict) -> str:
    """Generate human-readable report."""
    lines = []
    lines.append("AI Cleanup v2 PoC — Report")
    lines.append("=" * 50)

    i = report["input"]
    lines.append(f"Input       : {i['fileName']}")
    lines.append(f"Segment     : start={i['startSec']}s  dur={i['durationSec']}s  "
                 f"{i['sampleRate']}Hz  {i['channels']}ch"
                 + ("  (clamped)" if i.get("clamped") else ""))

    s = report["settings"]
    lines.append(f"Strength    : {s['strength']}")
    lines.append(f"Wet Ratio   : {s['wet_ratio']:.0%}")
    lines.append(f"Reconstruct : {s['reconstruction_enabled']}")
    lines.append(f"Retry       : {s['retry_enabled']}")

    lines.append("")
    lines.append("Measurements (before -> after):")

    b = report.get("before") or {}
    a = report.get("after") or {}
    d = report.get("delta") or {}

    def row(label, key, unit=""):
        bv = b.get(key)
        av = a.get(key)
        dv = d.get(key)
        fb = "n/a" if bv is None else f"{bv:.3f}{unit}"
        fa = "n/a" if av is None else f"{av:.3f}{unit}"
        fd = "" if dv is None else f"  [{dv:+.4f}]"
        return f"  {label:<22}: {fb} -> {fa}{fd}"

    lines.append(row("RMS dB", "rms_db"))
    lines.append(row("Peak dB", "peak_db"))
    lines.append(row("True Peak dBTP", "true_peak_dbtp"))
    lines.append(row("Stereo Correlation", "stereo_correlation"))

    lines.append("")
    diff = report.get("difference") or {}
    lines.append(f"Difference  : RMS={diff.get('rms_db', 'n/a')} dB  "
                 f"Peak={diff.get('peak_db', 'n/a')} dB")

    lines.append("")
    blend = report.get("blend") or {}
    lines.append(f"Blend       : wet={blend.get('wet_ratio', 0):.0%}  "
                 f"RMS match gain={blend.get('gain_applied_db', 0):.2f} dB")

    pc = report.get("peak_control") or {}
    lines.append(f"Peak Ctrl   : {pc.get('processed_peak_dbtp', 0):.2f} -> "
                 f"{pc.get('corrected_peak_dbtp', 0):.2f} dBTP  "
                 f"(gain={pc.get('gain_applied_db', 0):.2f} dB)")

    lines.append("")
    sf_ = report.get("safety") or {}
    status = "PASS" if sf_.get("passed") else "FAIL"
    lines.append(f"Safety      : {status}")
    for f in sf_.get("failures", []):
        lines.append(f"  [FAIL] {f['code']}: {f['message']}")
    for w in sf_.get("warnings", []):
        lines.append(f"  [warn] {w}")

    retry = report.get("retry") or {}
    if retry.get("attempts"):
        lines.append("")
        lines.append(f"Retry       : {len(retry['attempts'])} attempts, "
                     f"final wet={retry.get('final_wet_ratio', 0):.0%}")
        for att in retry.get("attempts", []):
            status = "PASS" if att["passed"] else f"FAIL ({att['failures']})"
            lines.append(f"  Attempt {att['attempt']}: wet={att['wet_ratio']:.0%} "
                         f"recon={att['reconstruction_enabled']} -> {status}")

    if report.get("bypassed"):
        lines.append("")
        lines.append(f"BYPASSED    : {report.get('bypass_reason', 'unknown')}")

    lines.append("")
    lines.append(f"Processing  : {report.get('processingTimeMs', 0)} ms")

    lines.append("")
    lines.append("NOTE: PoC only. Not connected to run_pipeline / Export / UI.")

    return "\n".join(lines)


# ============================================================================
# CLI
# ============================================================================

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="ai_cleanup_v2_poc.py",
        description="AI Cleanup v2 PoC — spectral denoise (test-only)",
    )
    p.add_argument("--input", required=True, help="Input audio file (read-only)")
    p.add_argument("--output-dir", required=True, help="Directory for output files")
    p.add_argument("--start", type=float, default=0.0,
                   help="Segment start in seconds (default: 0)")
    p.add_argument("--duration", type=float, default=DEFAULT_DURATION_SEC,
                   help=f"Segment length ({MIN_DURATION_SEC}-{MAX_DURATION_SEC}s, "
                        f"default {DEFAULT_DURATION_SEC})")
    p.add_argument("--strength", choices=["gentle", "balanced"],
                   default="gentle", help="Denoise strength (default: gentle)")
    p.add_argument("--wet", default="auto",
                   help="Wet ratio: 'auto' or 0.0-1.0 (default: auto)")
    p.add_argument("--reconstruction", choices=["on", "off"],
                   default="on", help="Enable reconstruction (default: on)")
    p.add_argument("--retry", choices=["on", "off"],
                   default="on", help="Enable adaptive retry (default: on)")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    # Validate input
    if not os.path.isfile(args.input):
        print(f"[error] Input not found: {args.input}", file=sys.stderr)
        return 2

    # Parse wet ratio
    if args.wet == "auto":
        wet_ratio = None
    else:
        try:
            wet_ratio = float(args.wet)
            if not 0.0 <= wet_ratio <= 1.0:
                raise ValueError()
        except ValueError:
            print(f"[error] Invalid wet ratio: {args.wet}", file=sys.stderr)
            return 2

    # Clamp duration
    duration = args.duration
    if duration < MIN_DURATION_SEC or duration > MAX_DURATION_SEC:
        clamped = max(MIN_DURATION_SEC, min(MAX_DURATION_SEC, duration))
        print(f"[warn] Duration {duration}s clamped to {clamped}s", file=sys.stderr)
        duration = clamped

    # Create output directory
    os.makedirs(args.output_dir, exist_ok=True)

    t0 = time.time()

    # Extract segment
    print(f"[info] Extracting segment from {args.input}...")
    audio, sr, input_info = extract_segment(args.input, args.start, duration)
    print(f"[info] Segment: {input_info['durationSec']}s @ {sr}Hz, {audio.shape[1]}ch")

    # Configure processor
    config = ProcessorConfig(
        strength=args.strength,
        wet_ratio=wet_ratio,
        reconstruction_enabled=(args.reconstruction == "on"),
        retry_enabled=(args.retry == "on"),
    )

    print(f"[info] Processing with strength={args.strength}, "
          f"wet={config.get_wet_ratio():.0%}, "
          f"reconstruction={config.reconstruction_enabled}, "
          f"retry={config.retry_enabled}...")

    # Process
    processor = Processor(config)
    result = processor.process(audio, sr, temp_dir=args.output_dir)

    processing_time_ms = int((time.time() - t0) * 1000)

    # Write output files
    original_path = os.path.join(args.output_dir, "original.wav")
    wet_path = os.path.join(args.output_dir, "processed_wet.wav")
    cleaned_path = os.path.join(args.output_dir, "cleaned.wav")
    diff_raw_path = os.path.join(args.output_dir, "difference_raw.wav")
    diff_norm_path = os.path.join(args.output_dir, "difference_normalized.wav")

    sf.write(original_path, result.original.astype(np.float32), sr)
    sf.write(wet_path, result.processed_wet.astype(np.float32), sr)
    sf.write(cleaned_path, result.cleaned.astype(np.float32), sr)

    # Difference signals
    diff = result.cleaned - result.original
    sf.write(diff_raw_path, diff.astype(np.float32), sr)

    # Normalized difference for audibility
    diff_peak = np.max(np.abs(diff))
    if diff_peak > 1e-9:
        target_peak = 0.5  # -6 dBFS
        norm_gain = target_peak / diff_peak
        norm_gain_db = 20 * np.log10(norm_gain)
    else:
        norm_gain = 1.0
        norm_gain_db = 0.0
    diff_normalized = np.clip(diff * norm_gain, -1.0, 1.0)
    sf.write(diff_norm_path, diff_normalized.astype(np.float32), sr)

    # Build and write report
    report = build_report(result, input_info, config, processing_time_ms)
    report["outputs"] = {
        "original": os.path.basename(original_path),
        "processed_wet": os.path.basename(wet_path),
        "cleaned": os.path.basename(cleaned_path),
        "difference_raw": os.path.basename(diff_raw_path),
        "difference_normalized": os.path.basename(diff_norm_path),
        "difference_norm_gain_db": round(norm_gain_db, 3),
    }

    json_path = os.path.join(args.output_dir, "report.json")
    txt_path = os.path.join(args.output_dir, "report.txt")

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=True)

    txt_report = render_report_txt(report)
    with open(txt_path, "w", encoding="utf-8") as f:
        f.write(txt_report + "\n")

    # Console output
    print()
    print(txt_report)
    print()
    print(f"[info] Output written to: {args.output_dir}")

    # Exit code
    if result.bypassed:
        return 4  # Bypassed
    elif not result.safety_result.passed:
        return 3  # Safety fail
    else:
        return 0  # Success


if __name__ == "__main__":
    raise SystemExit(main())
