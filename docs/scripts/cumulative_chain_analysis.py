#!/usr/bin/env python3
"""
Cumulative chain analyzer (v3.4.7 architecture review).

Renders the kpop_loud filter chain stage-by-stage and measures band energies
at every step.  Produces:

  · Per-stage parameter table (what each stage does + with what values)
  · Cumulative band-impact table (how LOW/MID/HIGH/AIR move at each stage)
  · Redundancy analysis (which bands get touched multiple times)

Usage:
    python3 cumulative_chain_analysis.py <input.wav>
        [--target-lufs -9.0]
        [--out-dir /tmp/chain_analysis]

This is an *analysis tool*, not engine code.  It does not modify any engine
behaviour.  Output is printed to stdout as Markdown tables.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

# Make the engine importable when run from repo root
_HERE = Path(__file__).resolve()
_ENGINE = _HERE.parents[2] / "aimaster-desktop" / "services" / "python-audio"
sys.path.insert(0, str(_ENGINE))

from app.mastering.eq import build_eq_filter_with_report
from app.mastering.dynamic_eq import build_dynamic_eq_chain
from app.mastering.dynamics import build_dynamics_filter, get_comp_params
from app.mastering.effects import (
    saturation_filter, stereo_width_filter, soft_clipper_filter, deesser_filter,
    get_mode_defaults,
)
from app.utils.audio_io import analyze_waveform


# ── Bands of interest ────────────────────────────────────────────────────────
BANDS = {
    "LOW":  (20.0,    200.0),
    "MID":  (200.0,  4000.0),
    "HIGH": (4000.0, 12000.0),
    "AIR":  (12000.0, 18000.0),
}


def measure_bands(wav: str) -> dict[str, float]:
    """Return RMS dBFS in each band."""
    data, sr = sf.read(wav, always_2d=True, dtype="float32")
    mono = data.mean(axis=1).astype(np.float32)
    n = len(mono)
    spec = np.fft.rfft(mono)
    freqs = np.fft.rfftfreq(n, 1.0 / sr)
    out = {}
    for name, (lo, hi) in BANDS.items():
        mask = (freqs >= lo) & (freqs <= hi)
        s = np.zeros_like(spec); s[mask] = spec[mask]
        f = np.fft.irfft(s, n=n)
        rms = float(np.sqrt(np.mean(f ** 2)))
        out[name] = round(20.0 * math.log10(max(rms, 1e-12)), 2)
    return out


def render(in_wav: str, filter_str: str, out_wav: str, sr: int = 44100) -> None:
    """Run input through filter_str and write to out_wav."""
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", in_wav,
           "-af", filter_str, "-ar", str(sr), "-acodec", "pcm_s24le", out_wav]
    subprocess.run(cmd, check=True, capture_output=True)


# ── Stage definitions for kpop_loud ─────────────────────────────────────────

@dataclass
class Stage:
    name:         str
    filter_str:   str        # ffmpeg filter for THIS stage only
    description:  str        # human-readable
    params:       dict       # parameter dump


def build_kpop_loud_stages(input_wav: str, target_tp: float = -1.0) -> list[Stage]:
    """Re-build the exact kpop_loud chain as a list of independent stages."""
    # Need spectral info from input
    wf = analyze_waveform(input_wav)
    if wf is None:
        raise RuntimeError("waveform analysis failed (numpy/soundfile required)")
    low_to_mid = wf.low_to_mid_db
    high_to_mid = wf.high_to_mid_db

    # 1. Base EQ (without overlay) — call build_eq_filter_with_report with
    #    a style that has no overlay (balanced) to extract just the base.
    base_chain, _ = build_eq_filter_with_report(
        "balanced", low_to_mid_db=low_to_mid, high_to_mid_db=high_to_mid,
    )

    # 2. kpop_loud overlay alone — diff between kpop_loud and balanced chains.
    full_eq, _ = build_eq_filter_with_report(
        "kpop_loud", low_to_mid_db=low_to_mid, high_to_mid_db=high_to_mid,
    )
    # The kpop_loud overlay lives at the END of full_eq, after the base.
    # Strip the base prefix to isolate the overlay.
    overlay_chain = full_eq[len(base_chain):].lstrip(",")

    # 3. Dynamic EQ
    dyn_eq = build_dynamic_eq_chain(
        "kpop_loud", intensity=1.0,
        low_to_mid_db=low_to_mid, high_to_mid_db=high_to_mid,
    )
    dyn_chain = dyn_eq.get("chain", "")

    # 4. Compressor (broadband acompressor with vocal-protection clamps)
    comp_params = get_comp_params("kpop_loud")
    comp_chain  = build_dynamics_filter("kpop_loud", input_peak_db=wf.sample_peak_db)

    # 5. Saturation (compand transfer curve)
    eff = get_mode_defaults("kpop_loud")
    sat_chain   = saturation_filter(eff["saturation"]) or "anull"

    # 6. Stereo width (extrastereo)
    stereo_chain = stereo_width_filter(eff["stereo_width"]) or "anull"

    # 7. Soft clipper (only if limiter strength medium/high — we test 'high')
    soft_chain   = soft_clipper_filter(target_tp) or "anull"

    # 8. Entry-gain push (capped at +6 dB; we use +6 as worst-case)
    # Real value depends on pre_lufs vs target_lufs — for analysis we test the cap.
    entry_chain  = "volume=+6.00dB"

    # 9. Soft clipper (same compand, applied after entry gain in static chain)
    soft_post_chain = soft_clipper_filter(target_tp) or "anull"

    # 10. Limiter (alimiter, level_in clamped to +0.5 dB by vocal protection)
    lim_in  = 10.0 ** (0.5 / 20.0)
    lim_out = 10.0 ** ((target_tp - 0.3) / 20.0)
    lim_chain = (f"alimiter=level_in={lim_in:.4f}:level_out=1:limit={lim_out:.6f}"
                 f":attack=3.0:release=60.0:asc=0")

    return [
        Stage("01_BASE_EQ",       base_chain,
              "Base streaming EQ — adaptive low boost + 250/320 mud cut + 12k air shelf",
              {"low_to_mid_db": low_to_mid, "high_to_mid_db": high_to_mid,
               "filter": base_chain}),
        Stage("02_OVERLAY_EQ",    overlay_chain,
              "kpop_loud adaptive overlay — 90 Hz warmth + presence/clarity/sheen",
              {"filter": overlay_chain}),
        Stage("03_DYNAMIC_EQ",    dyn_chain or "anull",
              "5-band dynamic EQ — boomy_low/muddy_lowmid/harsh_highmid/sibilance/vocal_presence",
              {"engine": dyn_eq.get("engine"), "bands": dyn_eq.get("bands"),
               "filter": dyn_chain}),
        Stage("04_COMPRESSOR",    comp_chain,
              "Broadband compressor (vocal-protection clamped: ratio≤2.0, attack≥25 ms)",
              {"params": comp_params, "filter": comp_chain}),
        Stage("05_SATURATION",    sat_chain,
              f"Compand-based saturation, amount={eff['saturation']}",
              {"amount": eff["saturation"], "filter": sat_chain}),
        Stage("06_STEREO_WIDTH",  stereo_chain,
              f"extrastereo m={eff['stereo_width']}",
              {"width": eff["stereo_width"], "filter": stereo_chain}),
        Stage("07_SOFTCLIP_PRE",  soft_chain,
              "Soft clipper (compand) — applied before entry gain (kpop_loud_high)",
              {"filter": soft_chain}),
        Stage("08_ENTRY_GAIN",    entry_chain,
              "Static loudness push (capped at +6 dB by vocal protection)",
              {"filter": entry_chain}),
        Stage("09_SOFTCLIP_POST", soft_post_chain,
              "Soft clipper applied AFTER entry-gain push (post-v3.4 reorder)",
              {"filter": soft_post_chain}),
        Stage("10_LIMITER",       lim_chain,
              "alimiter (vocal-protection clamped: level_in ≤ +0.5 dB)",
              {"level_in_db": 0.5, "ceiling_dbtp": target_tp - 0.3,
               "filter": lim_chain}),
    ]


# ── Cumulative measurement ──────────────────────────────────────────────────

def cumulative_measure(input_wav: str, stages: list[Stage], out_dir: str,
                        sr: int = 44100) -> list[dict]:
    """For each cumulative prefix [0..N], render and measure bands."""
    os.makedirs(out_dir, exist_ok=True)
    rows: list[dict] = []

    # Stage 0 — input
    input_bands = measure_bands(input_wav)
    rows.append({"stage": "00_INPUT", "bands": input_bands,
                 "delta": {k: 0.0 for k in BANDS}, "filter": "(raw)"})

    # Build cumulative chain at each step and render
    cum_filter_parts: list[str] = []
    prev_bands = input_bands
    for st in stages:
        if st.filter_str and st.filter_str != "anull":
            cum_filter_parts.append(st.filter_str)
        if not cum_filter_parts:
            # No-op stage (e.g. saturation=0) — output equals previous
            rows.append({"stage": st.name, "bands": prev_bands,
                         "delta": {k: 0.0 for k in BANDS},
                         "filter": st.filter_str})
            continue
        out_wav = os.path.join(out_dir, f"{st.name}.wav")
        try:
            render(input_wav, ",".join(cum_filter_parts), out_wav, sr=sr)
            cur_bands = measure_bands(out_wav)
        except subprocess.CalledProcessError as exc:
            sys.stderr.write(f"render failed at {st.name}: {exc.stderr.decode()[:300]}\n")
            cur_bands = prev_bands
        delta = {k: round(cur_bands[k] - input_bands[k], 2) for k in BANDS}
        rows.append({"stage": st.name, "bands": cur_bands,
                     "delta": delta, "filter": st.filter_str})
        prev_bands = cur_bands

    return rows


# ── Reporting ───────────────────────────────────────────────────────────────

def print_table(rows: list[dict]) -> None:
    """Print a markdown table of cumulative band deltas (vs raw input)."""
    print()
    print(f"| {'Stage':22} | {'LOW Δ':>8} | {'MID Δ':>8} | {'HIGH Δ':>8} | {'AIR Δ':>8} |")
    print(f"|{'-'*24}|{'-'*10}|{'-'*10}|{'-'*10}|{'-'*10}|")
    for r in rows:
        d = r["delta"]
        print(f"| {r['stage']:22} | {d['LOW']:+8.2f} | {d['MID']:+8.2f} | "
              f"{d['HIGH']:+8.2f} | {d['AIR']:+8.2f} |")
    print()
    print("Per-stage step (Δ from previous stage):")
    print(f"| {'Stage':22} | {'LOW Δ':>8} | {'MID Δ':>8} | {'HIGH Δ':>8} | {'AIR Δ':>8} |")
    print(f"|{'-'*24}|{'-'*10}|{'-'*10}|{'-'*10}|{'-'*10}|")
    prev = rows[0]["delta"]
    for r in rows[1:]:
        step = {k: round(r["delta"][k] - prev[k], 2) for k in BANDS}
        # Mark stages with zero change
        marker = "  "
        if all(abs(v) < 0.01 for v in step.values()):
            marker = "· "
        print(f"| {marker}{r['stage']:20} | {step['LOW']:+8.2f} | {step['MID']:+8.2f} | "
              f"{step['HIGH']:+8.2f} | {step['AIR']:+8.2f} |")
        prev = r["delta"]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("input", help="input wav")
    ap.add_argument("--target-tp", type=float, default=-1.0)
    ap.add_argument("--out-dir", default="/tmp/chain_analysis")
    ap.add_argument("--json", action="store_true", help="emit JSON instead of tables")
    args = ap.parse_args()

    stages = build_kpop_loud_stages(args.input, target_tp=args.target_tp)
    rows = cumulative_measure(args.input, stages, args.out_dir)

    if args.json:
        print(json.dumps({"input": args.input, "stages": rows}, indent=2, default=str))
    else:
        print(f"\n# Cumulative chain analysis — {args.input}\n")
        print(f"Stages renders saved to: {args.out_dir}/\n")
        print_table(rows)


if __name__ == "__main__":
    main()
