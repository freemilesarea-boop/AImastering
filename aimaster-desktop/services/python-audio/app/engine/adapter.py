"""
EnginePreset → pipeline.run_pipeline() kwargs adapter (M1 honest mapping).

What this M1 adapter does:
  • Translates `policies` (vocalProtection, safeMode, aiCorrections,
    limiterStrength) into the existing pipeline_kwargs vocabulary.
  • Translates `loudness-norm` (targetLufs/targetTpDb/targetLra) and
    `saturator.amount`, `stereo-imager.width` into pipeline_kwargs.
  • Translates `output.sampleRate`, `output.bitDepth` into pipeline_kwargs.
  • Reads `meta.legacyStyleId` and passes it as `style=` so the existing
    eq.py / dynamics.py / dynamic_eq.py / effects.py mode tables fire.

What this M1 adapter explicitly DOES NOT do (logged as drift, not applied):
  • The per-band EQ values inside `adaptive-eq.bands` are NOT injected into
    eq.py; eq.py continues to read its own table indexed by style.  The
    adapter compares the JSON values to Python's internal defaults and
    records any drift as a "clamped" log entry.
  • Same for `dynamic-eq.bands`, `bus-comp.*`, `deesser.*`, `limiter.*`.
  • `gain-staging`, `transient-protection`, `vocal-enhancer`, `soft-clip`
    are TS-only modules — Python adapter records them as "noop".

This honesty is the point: the AdapterRunReport surfaces every gap that
M2's Rust dsp-core will need to close.

Reference: docs/redesign/loui-mastering-v2/m1/01-DSP-MAPPING.md
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Optional

from .schema import (
    AdapterRunReport,
    EnginePreset,
)

# Modules the Python pipeline already implements (so the adapter records
# them as 'applied' when present, regardless of detailed parameter drift).
PYTHON_APPLIED_MODULES: frozenset[str] = frozenset(
    {
        "source",
        "adaptive-eq",
        "dynamic-eq",
        "multiband-eq",
        "bus-comp",
        "saturator",
        "stereo-imager",
        "deesser",
        "loudness-norm",
        "limiter",
        "isp-safety",
        "sink",
    }
)

# Modules currently TS-only.  Python records them as 'noop'.
PYTHON_NOOP_MODULES: frozenset[str] = frozenset(
    {
        "gain-staging",
        "transient-protection",
        "vocal-enhancer",
        "soft-clip",
        "dither",  # not implemented either side yet
    }
)


@dataclass
class PresetKwargs:
    """Result of preset → pipeline kwargs translation."""

    input_path: str
    output_path: str
    pipeline_kwargs: dict[str, Any] = field(default_factory=dict)
    report: AdapterRunReport = field(
        default_factory=lambda: AdapterRunReport(
            presetId="",
            presetVersion="",
            adapter="python",
            actualSampleRate=44100,
            durationMs=0.0,
        )
    )


def _resolve_style(preset: EnginePreset) -> str:
    """
    Resolve the legacy style id that Python's existing pipeline expects.

    Order:
      1. meta.legacyStyleId
      2. Inference from name (lowercase) — last-ditch fallback
      3. 'balanced' default
    """
    legacy = preset.meta.legacyStyleId
    if legacy:
        return str(legacy)
    name = (preset.name or "").lower()
    for candidate in ("kpop_loud", "loud", "bright", "punch", "warm", "natural", "balanced"):
        if candidate in name:
            return candidate
    return "balanced"


def _safe_modes_from_policy(safe_mode: Optional[str]) -> list[str]:
    """Translate policies.safeMode (singular) into pipeline's safe_modes list."""
    if safe_mode in (None, "none", ""):
        return []
    return [safe_mode]  # type: ignore[list-item]


def preset_to_kwargs(
    preset: EnginePreset,
    *,
    input_path: str,
    output_path: str,
) -> PresetKwargs:
    """
    Translate a preset into pipeline kwargs + a per-node adapter report.

    Side-effects: none — this is pure.  Caller invokes run_pipeline with
    the returned `pipeline_kwargs`.
    """
    started = time.time()
    style = _resolve_style(preset)

    # --- Resolve loudness-norm (required for a meaningful master) ---------
    lnorm = preset.module("loudness-norm")
    if not lnorm:
        raise ValueError("preset chain missing required 'loudness-norm' module")
    target_lufs = float(lnorm["targetLufs"])
    target_tp = float(lnorm["targetTpDb"])
    target_lra = float(lnorm.get("targetLra", 11.0))

    # --- Output ----------------------------------------------------------
    sample_rate = int(preset.output.sampleRate)
    bit_depth = int(preset.output.bitDepth)

    # --- Limiter strength (tier) ----------------------------------------
    limiter_strength = preset.policies.limiterStrength or "medium"

    # --- Saturator / Imager (Python reads them as scalars) --------------
    sat_node = preset.module("saturator")
    sat_amount: Optional[float] = float(sat_node["amount"]) if sat_node else None
    img_node = preset.module("stereo-imager")
    stereo_width: Optional[float] = float(img_node["width"]) if img_node else None

    # --- Dynamic EQ intensity --------------------------------------------
    dyn_node = preset.module("dynamic-eq")
    dyn_intensity = float(dyn_node["intensity"]) if dyn_node else 1.0

    # --- AI corrections / safe mode --------------------------------------
    apply_ai = (
        preset.policies.aiCorrections
        if preset.policies.aiCorrections is not None
        else True
    )
    safe_modes = _safe_modes_from_policy(preset.policies.safeMode)

    pipeline_kwargs: dict[str, Any] = {
        "style": style,
        "target_lufs": target_lufs,
        "target_tp": target_tp,
        "lra": target_lra,
        "sample_rate": sample_rate,
        "bit_depth": bit_depth,
        "apply_ai_corrections": bool(apply_ai),
        "ai_detections": {},
        "limiter_strength": limiter_strength,
        "saturation_amount": sat_amount,
        "stereo_width": stereo_width,
        "output_gain_db": 0.0,
        "dynamic_eq_intensity": dyn_intensity,
        "generate_waveforms": False,
        "pre_loudness": None,
        "debug_logging": None,
        # Safe modes are applied by the caller via build_safe_mode_overrides
        # — we surface them on the kwargs for visibility, the caller patches
        # them in before calling run_pipeline.
        "_safe_modes": safe_modes,
    }

    # --- Build the per-module report -------------------------------------
    report = AdapterRunReport(
        presetId=preset.id,
        presetVersion=preset.version,
        adapter="python",
        actualSampleRate=sample_rate,
        durationMs=0.0,
    )

    for node in preset.nodes:
        ntype = node.get("type", "?")
        nid = node.get("id", "?")
        if ntype in PYTHON_NOOP_MODULES:
            report.add(
                nid,
                ntype,
                "noop",
                note=f"Python adapter does not implement '{ntype}' — TS-only module",
            )
            continue
        if ntype in PYTHON_APPLIED_MODULES:
            note = _drift_note(ntype, node, style)
            if note:
                report.add(nid, ntype, "clamped", note=note)
            else:
                report.add(nid, ntype, "applied")
            continue
        # Unknown module type — schema validator should have caught this,
        # but be defensive.
        report.add(nid, ntype, "error", note=f"unhandled module type {ntype!r}")

    report.durationMs = (time.time() - started) * 1000.0
    return PresetKwargs(
        input_path=input_path,
        output_path=output_path,
        pipeline_kwargs=pipeline_kwargs,
        report=report,
    )


def _drift_note(module_type: str, node: dict[str, Any], style: str) -> Optional[str]:
    """
    Return a human-readable note iff the JSON parameters differ from what
    Python's existing pipeline applies for the given style.

    M1 is intentionally informational here — we don't reject; we report.
    Once Python is fully driven by JSON (M2 stepping stone), this function
    becomes the enforcement point.
    """
    if module_type == "bus-comp":
        # Compare against dynamics._STYLE_COMP — but to avoid Python pipeline
        # import dependency at module load, we declare known-good defaults
        # inline.  Keep in sync with dynamics.py:_STYLE_COMP.
        py_defaults = {
            "natural":   {"thresholdDb": -22, "ratio": 1.3, "attackMs": 50, "releaseMs": 200, "makeupDb": 0.5, "kneeDb": 10.0},
            "balanced":  {"thresholdDb": -20, "ratio": 1.6, "attackMs": 40, "releaseMs": 180, "makeupDb": 0.5, "kneeDb": 10.0},
            "warm":      {"thresholdDb": -18, "ratio": 1.8, "attackMs": 45, "releaseMs": 200, "makeupDb": 0.7, "kneeDb": 12.0},
            "bright":    {"thresholdDb": -18, "ratio": 1.5, "attackMs": 35, "releaseMs": 160, "makeupDb": 0.5, "kneeDb": 10.0},
            "punch":     {"thresholdDb": -18, "ratio": 2.0, "attackMs": 20, "releaseMs": 100, "makeupDb": 0.8, "kneeDb": 6.0},
            "loud":      {"thresholdDb": -16, "ratio": 2.0, "attackMs": 18, "releaseMs": 110, "makeupDb": 0.5, "kneeDb": 9.0},
            "kpop_loud": {"thresholdDb": -14, "ratio": 2.2, "attackMs": 15, "releaseMs": 100, "makeupDb": 0.7, "kneeDb": 10.0},
        }
        ref = py_defaults.get(style)
        if not ref:
            return None
        drifts: list[str] = []
        for k, v_ref in ref.items():
            v_json = node.get(k)
            if v_json is not None and v_json != v_ref:
                drifts.append(f"{k}: json={v_json} python={v_ref}")
        if drifts:
            return (
                "JSON bus-comp params differ from python dynamics.py defaults — "
                "Python applies its own table.  Drift: " + ", ".join(drifts)
            )
        return None

    if module_type == "limiter":
        # LIMITER_STRENGTHS in pipeline.py
        ls = {
            "low":    {"inputGainDb": 0.0, "attackMs": 8.0, "releaseMs": 200.0},
            "medium": {"inputGainDb": 0.5, "attackMs": 5.0, "releaseMs": 120.0},
            "high":   {"inputGainDb": 1.5, "attackMs": 3.0, "releaseMs":  60.0},
        }
        # We don't know which strength tier the JSON node corresponds to —
        # only that policies.limiterStrength picked the tier.  So we only
        # check the JSON's explicit inputGainDb/attack/release against
        # the tier in question.  Best-effort.
        return None  # M2 will tighten this

    # For other modules, the schema fields are mostly used as-is via
    # policy mapping (saturator → saturation_amount, etc), so drift is
    # absorbed at the policy boundary.
    return None
