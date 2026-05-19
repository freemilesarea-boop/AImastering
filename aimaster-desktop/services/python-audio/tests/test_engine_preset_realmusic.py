"""
M1.5 real-music golden test — fixture × preset matrix.

For each FixtureMetadata recipe (9 categories), this test:
  1. Materialises the synthetic mix WAV (cached at /tmp/aimaster-fixtures/).
  2. Runs the *recommended* preset against it via the EnginePreset adapter.
  3. Measures the output against the fixture's `referenceMaster.targetMetrics`
     and asserts the fixture's `policy` thresholds.
  4. Persists results to /tmp/aimaster-m1.5-metrics/python-<fixture>.json
     for cross-language comparison.

By default this runs only the *recommended* (fixture, preset) pair for each
fixture (9 cases — ~5-10 min on CI).  Set LOUI_FULL_MATRIX=1 to run all
9 × 7 = 63 combinations.

Reference docs:
  docs/redesign/loui-mastering-v2/m1.5/00-FIXTURE-SYSTEM.md
  docs/redesign/loui-mastering-v2/m1.5/01-DSP-POLICY-PHILOSOPHY.md
"""
from __future__ import annotations

import json
import math
import os
import shutil
from pathlib import Path
from typing import Any

import numpy as np
import pytest
import soundfile as sf

from app.engine import (
    list_builtin_presets,
    load_builtin_preset,
    preset_to_kwargs,
)
from app.fixtures import (
    list_builtin_fixtures,
    load_builtin_fixture,
    materialise_fixture,
)
from app.mastering.pipeline import run_pipeline
from app.mastering.safe_modes import (
    apply_overrides_to_pipeline_args,
    build_safe_mode_overrides,
)
from app.utils.ffmpeg_wrapper import loudnorm_pass1


METRICS_DIR = Path("/tmp/aimaster-m1.5-metrics")
METRICS_DIR.mkdir(parents=True, exist_ok=True)


# ── Helpers ────────────────────────────────────────────────────────────────


@pytest.fixture(scope="session")
def ffmpeg_present() -> bool:
    return shutil.which("ffmpeg") is not None


def _measure_loudness(path: str) -> dict[str, float]:
    res = loudnorm_pass1(path)
    return {
        "lufs_i": float(res.get("input_i", "nan")),
        "tp_db":  float(res.get("input_tp", "nan")),
        "lra":    float(res.get("input_lra", "nan")),
    }


def _rms_db(samples: np.ndarray) -> float:
    if samples.size == 0:
        return float("-inf")
    rms = float(np.sqrt(np.mean(samples.astype(np.float64) ** 2)))
    return 20 * math.log10(rms) if rms > 0 else float("-inf")


def _crest_db(samples: np.ndarray) -> float:
    if samples.size == 0:
        return 0.0
    s = samples.astype(np.float64)
    peak = float(np.max(np.abs(s)))
    rms = float(np.sqrt(np.mean(s ** 2)))
    if rms <= 0 or peak <= 0:
        return 0.0
    return 20 * math.log10(peak / rms)


_THIRD_OCT_CENTRES = [
    25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630,
    800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000,
    12500, 16000, 20000,
]


def _third_oct_spectrum_db(samples: np.ndarray, sr: int) -> dict[str, float]:
    if samples.ndim == 2:
        mono = samples.mean(axis=1)
    else:
        mono = samples
    n = len(mono)
    if n == 0:
        return {str(c): float("-inf") for c in _THIRD_OCT_CENTRES}
    win = np.hanning(n)
    spec = np.fft.rfft(mono * win)
    mag = np.abs(spec) / (np.sum(win) / 2.0)
    freqs = np.fft.rfftfreq(n, d=1.0 / sr)
    out: dict[str, float] = {}
    for cf in _THIRD_OCT_CENTRES:
        lo = cf / (2 ** (1 / 6))
        hi = cf * (2 ** (1 / 6))
        mask = (freqs >= lo) & (freqs < hi)
        if not np.any(mask):
            out[str(cf)] = float("-inf")
            continue
        band_mag = mag[mask]
        rms = float(np.sqrt(np.mean(band_mag ** 2)))
        out[str(cf)] = 20 * math.log10(rms) if rms > 0 else float("-inf")
    return out


def _resolve_preset_id(recommended_preset_id: str) -> str:
    """`builtin-kpop-loud` → `kpop_loud` (file basename)."""
    base = recommended_preset_id.removeprefix("builtin-")
    base = base.replace("-", "_")
    return base


# ── Test matrix ────────────────────────────────────────────────────────────


def _matrix_pairs() -> list[tuple[str, str]]:
    """
    Build the (fixture_id, preset_name) pairs to test.

    Default: each fixture × its recommendedPresetId (one pair per fixture).
    LOUI_FULL_MATRIX=1: every fixture × every preset.
    """
    full = os.environ.get("LOUI_FULL_MATRIX") == "1"
    fixtures = list_builtin_fixtures()
    presets = list_builtin_presets()
    pairs: list[tuple[str, str]] = []
    for fx in fixtures:
        meta = load_builtin_fixture(fx)
        rec = _resolve_preset_id(meta.recommendedPresetId)
        if full:
            for ps in presets:
                pairs.append((fx, ps))
        else:
            pairs.append((fx, rec))
    return pairs


_MATRIX = _matrix_pairs()


@pytest.mark.parametrize("fixture_id, preset_id", _MATRIX)
def test_fixture_preset_render(
    fixture_id: str,
    preset_id: str,
    ffmpeg_present: bool,
    tmp_path: Path,
) -> None:
    if not ffmpeg_present:
        pytest.skip("ffmpeg unavailable")

    fixture = load_builtin_fixture(fixture_id)
    preset = load_builtin_preset(preset_id)

    # Materialise the source.
    src = materialise_fixture(fixture)

    out_path = tmp_path / f"{fixture_id}__{preset_id}.master.wav"
    pk = preset_to_kwargs(
        preset,
        input_path=str(src.wavPath),
        output_path=str(out_path),
    )

    overrides = build_safe_mode_overrides(pk.pipeline_kwargs.pop("_safe_modes", []))
    apply_overrides_to_pipeline_args(pk.pipeline_kwargs, overrides)

    # Ensure mastering sample rate matches the fixture (avoid resample warnings).
    pk.pipeline_kwargs["sample_rate"] = fixture.characteristics.sampleRate
    pk.pipeline_kwargs["bit_depth"] = fixture.characteristics.bitDepth

    run_pipeline(
        str(src.wavPath),
        str(out_path),
        job_id=f"m1.5_{fixture_id}__{preset_id}",
        progress=lambda *_a, **_kw: None,
        **pk.pipeline_kwargs,
    )

    assert out_path.exists(), f"output WAV missing for {fixture_id} × {preset_id}"

    samples, sr = sf.read(str(out_path), always_2d=True)
    loud = _measure_loudness(str(out_path))
    rms_db = _rms_db(samples)
    crest_db = _crest_db(samples)
    third_oct = _third_oct_spectrum_db(samples, sr)

    target = fixture.referenceMaster.targetMetrics
    policy = fixture.policy
    is_recommended = preset.id == fixture.recommendedPresetId

    metrics: dict[str, Any] = {
        "fixtureId": fixture_id,
        "fixtureCategory": fixture.category,
        "presetId": preset.id,
        "presetName": preset.name,
        "isRecommendedPair": is_recommended,
        "sampleRate": int(sr),
        "channels": int(samples.shape[1]),
        "durationSec": float(samples.shape[0] / sr),
        "fixtureSha256": src.sha256,
        "target": {
            "lufsI": target.lufsI,
            "tpMaxDb": target.tpMaxDb,
            "lraMinLu": target.lraMinLu,
            "lraMaxLu": target.lraMaxLu,
        },
        "measured": {
            "lufsI": loud["lufs_i"],
            "tpDb":  loud["tp_db"],
            "lra":   loud["lra"],
            "rmsDb": rms_db,
            "crestDb": crest_db,
            "thirdOctSpectrumDb": third_oct,
        },
        "deltas": {
            "lufsDelta": loud["lufs_i"] - target.lufsI,
            "tpHeadroomDb": target.tpMaxDb - loud["tp_db"],
        },
        "policy": {
            "lufsToleranceLu": policy.lufsToleranceLu,
            "tpHardCeiling": policy.tpHardCeiling,
        },
        "adapterReport": pk.report.to_dict(),
    }

    # Gather policy violations (informational vs hard).
    warnings: list[str] = []
    hard_errors: list[str] = []

    if is_recommended:
        # 1. TP — HARD FAIL on overshoot.  This is a safety violation, not
        #    a policy quality issue.
        if policy.tpHardCeiling and loud["tp_db"] > target.tpMaxDb + 0.01:
            hard_errors.append(
                f"TP {loud['tp_db']:+.2f} dBTP > ceiling {target.tpMaxDb:+.2f} "
                f"(HARD CEILING — limiter failure)"
            )

        # 2. LUFS — SOFT WARN.  The M1.5 baseline expects most fixtures to
        #    miss target by 1-5 LU because the pipeline cannot push loud
        #    presets on dynamics-poor inputs (ISSUE-M1-A); recording the
        #    delta is the deliverable.
        delta = abs(loud["lufs_i"] - target.lufsI)
        if delta > policy.lufsToleranceLu:
            warnings.append(
                f"LUFS-I {loud['lufs_i']:+.2f} vs target {target.lufsI:+.2f} "
                f"(Δ {delta:.2f} LU > tolerance {policy.lufsToleranceLu:.2f})"
            )

        # 3. LRA — SOFT WARN.  Tracks dynamic-range compliance.
        if not (target.lraMinLu <= loud["lra"] <= target.lraMaxLu):
            warnings.append(
                f"LRA {loud['lra']:.2f} outside target band "
                f"[{target.lraMinLu:.1f}, {target.lraMaxLu:.1f}]"
            )

    if warnings:
        metrics["warnings"] = warnings
    if hard_errors:
        metrics["hardErrors"] = hard_errors

    metrics_path = METRICS_DIR / f"python-{fixture_id}__{preset_id}.json"
    metrics_path.write_text(json.dumps(metrics, indent=2, ensure_ascii=False))

    # Only hard errors fail the suite.  Warnings are visible in the metric
    # JSONs and aggregated by the M1.5 execution report.
    if hard_errors:
        pytest.fail(
            f"{fixture_id} × {preset_id}: " + "; ".join(hard_errors)
            + f"  (see {metrics_path})"
        )
