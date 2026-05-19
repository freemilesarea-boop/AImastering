#!/usr/bin/env python3
"""
M2-lite cross-language parity test.

Runs the Rust `analyze_wav` binary against every materialised fixture in
/tmp/aimaster-fixtures/ and compares its output to the Python extractor
(`app.profiling.extract_profile`).

Both sides should agree within tight tolerances on:
  • LUFS-I, true-peak, LRA  (industry-standard metrics)
  • Sample peak, RMS         (basic statistics)
  • Stereo correlation        (algorithm-independent)

Differences ARE expected for:
  • short-term / momentary LUFS — Python doesn't expose these directly
  • short_term_percentiles      — Python percentiles are over different windows
  • spectral / dynamics metrics — out of scope (Rust dsp-core M2-lite is
    metering-only; spectral profile stays in Python until M2-full)

Usage:
    python3 dsp-core/scripts/parity_test.py [--rust-binary PATH]

Output:
    /tmp/aimaster-m2-lite-parity/report.json
    /tmp/aimaster-m2-lite-parity/<fixture>.rust.json
    /tmp/aimaster-m2-lite-parity/<fixture>.python.json
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

# Repo root resolution (this script lives at dsp-core/scripts/).
REPO_ROOT = Path(__file__).resolve().parent.parent.parent       # aimaster-desktop/
PY_AUDIO  = REPO_ROOT / "services" / "python-audio"
FIXTURES  = Path("/tmp/aimaster-fixtures")
METRICS   = Path("/tmp/aimaster-m2-lite-parity")
METRICS.mkdir(parents=True, exist_ok=True)

# Insert Python service path so we can import the profiler.
sys.path.insert(0, str(PY_AUDIO))


def find_rust_binary() -> Path:
    """Locate target/release/examples/analyze_wav (build it if missing)."""
    target = REPO_ROOT / "dsp-core" / "target" / "release" / "examples" / "analyze_wav"
    if not target.exists():
        print("[parity] building Rust binary...")
        subprocess.run(
            ["cargo", "build", "--release", "--example", "analyze_wav"],
            cwd=REPO_ROOT / "dsp-core",
            check=True,
        )
    return target


def materialise_fixtures():
    """Ensure all M1.5 fixtures exist on disk."""
    try:
        from app.fixtures import list_builtin_fixtures, load_builtin_fixture, materialise_fixture
    except ImportError as e:
        print(f"[parity] cannot import fixtures module: {e}")
        sys.exit(1)
    for name in list_builtin_fixtures():
        meta = load_builtin_fixture(name)
        materialise_fixture(meta)


def rust_analyze(binary: Path, wav: Path) -> dict:
    out = subprocess.check_output([str(binary), str(wav)], text=True)
    return json.loads(out)


def python_analyze(wav: Path) -> dict:
    """Run the Python feature extractor on the same WAV — only the fields
    that overlap with Rust's snapshot are kept."""
    from app.profiling import extract_profile, ExtractionOptions
    p = extract_profile(
        wav,
        profile_id=f"parity-{wav.stem[:16]}",
        options=ExtractionOptions(source_type="fixture", include_source_sha256=False),
    )
    f = p.features
    return {
        "schema": "loui.python.snapshot.v1",
        "path": str(wav),
        "sampleRate": p.provenance.sampleRate,
        "channels": p.provenance.channels,
        "durationSec": p.provenance.durationSec,
        "loudness": {
            "integratedLufs": f.loudness.integratedLufs,
            "truePeakDbtp":   f.loudness.truePeakDbtp,
            "loudnessRange":  f.loudness.loudnessRange,
        },
        "stereo": {
            "correlation": f.stereo.correlationMean,
            "msRatioDb":   f.stereo.msRatioDb,
        },
    }


def cmp_axes(rust: dict, py: dict) -> dict:
    """Compute per-axis deltas for fields present in both snapshots."""
    rl = rust["loudness"]
    pl = py["loudness"]
    rs = rust["stereo"]
    ps = py["stereo"]

    def delta(a, b):
        if a is None or b is None:
            return None
        if not (-1e9 < a < 1e9 and -1e9 < b < 1e9):
            return None
        return a - b

    return {
        "lufsI":       {"rust": rl["integratedLufs"], "python": pl["integratedLufs"],
                         "delta": delta(rl["integratedLufs"], pl["integratedLufs"])},
        "truePeakDbtp":{"rust": rl["truePeakDbtp"],   "python": pl["truePeakDbtp"],
                         "delta": delta(rl["truePeakDbtp"],   pl["truePeakDbtp"])},
        "lra":         {"rust": rl["loudnessRange"],  "python": pl["loudnessRange"],
                         "delta": delta(rl["loudnessRange"],  pl["loudnessRange"])},
        "correlation": {"rust": rs["correlation"],    "python": ps["correlation"],
                         "delta": delta(rs["correlation"],    ps["correlation"])},
        "msRatioDb":   {"rust": rs["msRatioDb"],      "python": ps["msRatioDb"],
                         "delta": delta(rs["msRatioDb"],      ps["msRatioDb"])},
    }


def fmt(v):
    if v is None:
        return "n/a"
    if not isinstance(v, (int, float)):
        return str(v)
    if v != v:  # NaN
        return "nan"
    return f"{v:+.3f}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rust-binary", type=Path, default=None,
                    help="path to analyze_wav (auto-builds if missing)")
    args = ap.parse_args()

    binary = args.rust_binary or find_rust_binary()
    materialise_fixtures()

    wavs = sorted(FIXTURES.glob("*.wav"))
    if not wavs:
        print("[parity] no fixtures found — run pytest first to generate them")
        sys.exit(1)

    print(f"\nM2-lite parity test — {len(wavs)} fixtures")
    print(f"  rust:   {binary}")
    print(f"  python: app.profiling.extract_profile (services/python-audio)")
    print(f"  output: {METRICS}/\n")

    print("─" * 110)
    print(f'{"fixture":<28} | {"lufs R":>9}  {"lufs P":>9}  {"Δ":>7} | '
          f'{"tp R":>8}  {"tp P":>8}  {"Δ":>6} | {"lra R":>6}  {"lra P":>6}  {"Δ":>6} | '
          f'{"corr R":>7}  {"corr P":>7}')
    print("─" * 110)

    per_fixture = []
    max_lufs_delta = 0.0
    max_tp_delta = 0.0
    max_corr_delta = 0.0

    for wav in wavs:
        rust = rust_analyze(binary, wav)
        py = python_analyze(wav)
        (METRICS / f"{wav.stem}.rust.json").write_text(json.dumps(rust, indent=2))
        (METRICS / f"{wav.stem}.python.json").write_text(json.dumps(py, indent=2))
        cmp = cmp_axes(rust, py)
        per_fixture.append({"fixture": wav.stem, "axes": cmp})

        def absd(name):
            v = cmp[name]["delta"]
            return abs(v) if v is not None else 0.0
        max_lufs_delta = max(max_lufs_delta, absd("lufsI"))
        max_tp_delta   = max(max_tp_delta,   absd("truePeakDbtp"))
        max_corr_delta = max(max_corr_delta, absd("correlation"))

        rl, pl = rust["loudness"], py["loudness"]
        rs, ps = rust["stereo"],   py["stereo"]
        print(f"{wav.stem:<28} | "
              f"{fmt(rl['integratedLufs']):>9}  {fmt(pl['integratedLufs']):>9}  "
              f"{fmt(cmp['lufsI']['delta']):>7} | "
              f"{fmt(rl['truePeakDbtp']):>8}  {fmt(pl['truePeakDbtp']):>8}  "
              f"{fmt(cmp['truePeakDbtp']['delta']):>6} | "
              f"{fmt(rl['loudnessRange']):>6}  {fmt(pl['loudnessRange']):>6}  "
              f"{fmt(cmp['lra']['delta']):>6} | "
              f"{fmt(rs['correlation']):>7}  {fmt(ps['correlation']):>7}")

    print("─" * 110)
    report = {
        "schema": "loui.m2-lite.parity-report.v1",
        "aggregate": {
            "maxLufsDelta":         max_lufs_delta,
            "maxTpDelta":           max_tp_delta,
            "maxCorrelationDelta":  max_corr_delta,
        },
        "perFixture": per_fixture,
    }
    (METRICS / "report.json").write_text(json.dumps(report, indent=2))
    print(f"\nReport: {METRICS}/report.json")
    print(f"Aggregate: max |Δ LUFS| = {max_lufs_delta:.3f}, "
          f"max |Δ TP| = {max_tp_delta:.3f}, "
          f"max |Δ correlation| = {max_corr_delta:.4f}")


if __name__ == "__main__":
    main()
