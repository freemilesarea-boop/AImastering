#!/usr/bin/env python3
"""
AI Cleanup PoC — standalone CLI (TEST-ONLY).

This tool is NOT part of the commercial mastering pipeline.  It does not touch
run_pipeline, MasteringOptions, presets, IPC, the renderer, or the Export path.
It extracts a short segment of an input file, denoises ONLY the high band on a
copy, and writes original/cleaned/difference WAVs + a JSON/TXT report so a human
can A/B and inspect the measurements.  The input file is never modified.

Usage:
    python scripts/ai_cleanup_poc.py \
        --input "/path/to/input.wav" \
        --output-dir "/path/to/output" \
        --start 30 --duration 15 --strength gentle

FFmpeg binary is resolved via $AIMASTER_FFMPEG, else `ffmpeg` on PATH.  If no
usable denoise filter (afftdn/anlmdn) is present, the tool reports it and skips
processing (it does not fail).
"""
from __future__ import annotations

import argparse
import json
import os
import sys

# Make `app...` importable when run directly from the scripts/ directory.
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)  # services/python-audio
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from app.mastering.ai_cleanup_poc import (  # noqa: E402
    DEFAULT_DURATION_SEC,
    MAX_DURATION_SEC,
    MIN_DURATION_SEC,
    render_report_txt,
    run_poc,
)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="ai_cleanup_poc.py",
        description="AI Cleanup PoC — high-band-limited denoise on a short "
                    "segment (test-only, not connected to Export).",
    )
    p.add_argument("--input", required=True, help="input audio file (read-only)")
    p.add_argument("--output-dir", required=True, help="directory for output files")
    p.add_argument("--start", type=float, default=None,
                   help="segment start in seconds (default: 0)")
    p.add_argument("--duration", type=float, default=DEFAULT_DURATION_SEC,
                   help=f"segment length in seconds "
                        f"({MIN_DURATION_SEC:g}-{MAX_DURATION_SEC:g}, default {DEFAULT_DURATION_SEC:g})")
    p.add_argument("--strength", choices=["gentle", "balanced", "strong"],
                   default="gentle", help="denoise strength (default gentle)")
    p.add_argument("--filter", dest="filter_choice",
                   choices=["auto", "afftdn", "anlmdn"], default="auto",
                   help="denoise filter (default auto; arnndn never used)")
    p.add_argument("--dry-run", action="store_true",
                   help="probe + analysis only, no processing")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if not os.path.isfile(args.input):
        print(f"[error] input not found: {args.input}", file=sys.stderr)
        return 2

    duration = args.duration
    if duration < MIN_DURATION_SEC or duration > MAX_DURATION_SEC:
        clamped = max(MIN_DURATION_SEC, min(MAX_DURATION_SEC, duration))
        print(f"[warn] duration {duration}s out of range — clamped to {clamped}s",
              file=sys.stderr)
        duration = clamped

    try:
        report = run_poc(
            input_path=args.input,
            output_dir=args.output_dir,
            start_sec=args.start,
            duration_sec=duration,
            strength=args.strength,
            filter_choice=args.filter_choice,
            dry_run=args.dry_run,
        )
    except Exception as exc:  # non-destructive: report the failure, exit non-zero
        print(f"[error] PoC failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    # Write reports.
    os.makedirs(args.output_dir, exist_ok=True)
    json_path = os.path.join(args.output_dir, "report.json")
    txt_path = os.path.join(args.output_dir, "report.txt")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=True)
    txt = render_report_txt(report)
    with open(txt_path, "w", encoding="utf-8") as f:
        f.write(txt + "\n")

    # Console output: probe JSON + human summary.
    print(json.dumps({"probe": report["probe"]}, indent=2))
    print()
    print(txt)

    if not report["safety"]["passed"]:
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
