"""
Safe-mode parameter overrides for the mastering pipeline.

Three named modes target the three reported failure patterns:

  · "safe"        — vocal-mush / radio-quality fallback.  Disables the
                    Dynamic EQ entirely, weakens the bus compressor,
                    drops limiter input gain, clamps correction gain,
                    and pulls target LUFS toward a conservative -14.0.
  · "vocal_safe"  — vocal mush / sibilance complaints.  Keeps loudness
                    intent but pulls down 2-6 kHz dynamic-EQ cuts,
                    softens the de-esser, lowers compressor ratio, and
                    slows attack so vocal transients survive.
  · "low_limit"   — "너무 눌림" complaint.  Caps limiter input gain,
                    pulls entry gain clamp tighter, and biases target
                    LUFS to -12 ~ -14, preventing brickwalling.

The overrides are *additive* on top of whatever style preset the user
picked (kpop_loud, balanced, etc.).  They are not mutually exclusive —
multiple flags can be combined and the worst clamp wins.

Usage:
    overrides = build_safe_mode_overrides(["vocal_safe", "low_limit"])
    apply_overrides_to_pipeline_args(kwargs, overrides)
"""
from __future__ import annotations

from typing import Any


# ── Mode definitions ─────────────────────────────────────────────────────────

_SAFE_MODES: dict[str, dict[str, Any]] = {
    "safe": {
        "label":              "Safe Mode",
        "description":        "라디오 음질 / 보컬 뭉개짐이 발생하는 사용자를 위한 안정 모드. "
                              "Dynamic EQ 비활성, 컴프 약화, limiter 게인 축소, "
                              "보수적 target LUFS.",
        "dynamic_eq_intensity":      0.0,    # OFF
        "limiter_strength":          "low",
        "compressor_ratio_scale":    0.7,
        "compressor_attack_scale":   1.5,    # 더 느리게
        "saturation_amount":         0.0,
        "static_entry_gain_max":     12.0,
        "correction_gain_clamp":     6.0,    # ±6 dB 한도
        "target_lufs_clamp":         (-16.0, -12.5),
        "limiter_input_gain_clamp":  1.0,
    },
    "vocal_safe": {
        "label":              "Vocal Safe Mode",
        "description":        "보컬 대역 (2~6 kHz) 과도한 dynamic EQ 컷 방지, "
                              "de-esser / compressor 완화로 보컬 보존.",
        "dynamic_eq_intensity":      0.5,    # 절반 강도
        "vocal_band_protection":     True,   # 2-6 kHz 컷 비활성화
        "deesser_disabled":          True,
        "compressor_ratio_scale":    0.85,
        "compressor_attack_scale":   1.3,
        "saturation_amount":         None,   # touch nothing
        "limiter_input_gain_clamp":  2.0,
    },
    "low_limit": {
        "label":              "Low Limiting Mode",
        "description":        "Limiter 강도 축소, entry gain 제한, "
                              "target LUFS -12~-14 보수화.  Brickwall / 과압축 방지.",
        "limiter_strength":          "low",
        "limiter_input_gain_clamp":  1.0,
        "static_entry_gain_max":     8.0,
        "correction_gain_clamp":     4.0,
        "target_lufs_clamp":         (-16.0, -12.0),
    },
}


def list_safe_modes() -> list[dict[str, str]]:
    """Return public mode metadata for UI."""
    return [
        {"key": k, "label": v["label"], "description": v["description"]}
        for k, v in _SAFE_MODES.items()
    ]


def build_safe_mode_overrides(modes: list[str] | None) -> dict[str, Any]:
    """
    Combine multiple mode flags into a single override dict.  When two modes
    set the same key, the more conservative value wins (lower limit / smaller
    intensity / tighter clamp).
    """
    if not modes:
        return {}

    merged: dict[str, Any] = {}
    for m in modes:
        defn = _SAFE_MODES.get(m)
        if not defn:
            continue
        for key, val in defn.items():
            if key in ("label", "description"):
                continue
            existing = merged.get(key)
            if existing is None:
                merged[key] = val
            else:
                merged[key] = _merge_value(key, existing, val)
    if merged:
        merged["_appliedModes"] = [m for m in modes if m in _SAFE_MODES]
    return merged


def _merge_value(key: str, a: Any, b: Any) -> Any:
    """Pick the more conservative of two override values for `key`."""
    if isinstance(a, bool) or isinstance(b, bool):
        return bool(a) or bool(b)
    if key in (
        "dynamic_eq_intensity", "compressor_ratio_scale", "saturation_amount",
        "limiter_input_gain_clamp", "static_entry_gain_max",
        "correction_gain_clamp",
    ):
        if a is None: return b
        if b is None: return a
        return min(float(a), float(b))
    if key == "compressor_attack_scale":
        if a is None: return b
        if b is None: return a
        return max(float(a), float(b))
    if key == "limiter_strength":
        order = {"high": 2, "medium": 1, "low": 0}
        return a if order.get(str(a), 99) < order.get(str(b), 99) else b
    if key == "target_lufs_clamp":
        # Tighter clamp wins (intersection)
        lo_a, hi_a = a
        lo_b, hi_b = b
        return (max(lo_a, lo_b), min(hi_a, hi_b))
    return a


def apply_overrides_to_pipeline_args(kwargs: dict[str, Any], overrides: dict[str, Any]) -> None:
    """
    Mutate `kwargs` (the dict that will be passed to run_pipeline) so it
    reflects the safe-mode overrides.  Never silently downgrades a value
    the user explicitly raised — only the documented clamps apply.
    """
    if not overrides:
        return

    if "dynamic_eq_intensity" in overrides:
        kwargs["dynamic_eq_intensity"] = float(overrides["dynamic_eq_intensity"])

    if "limiter_strength" in overrides:
        order = {"high": 2, "medium": 1, "low": 0}
        cur = str(kwargs.get("limiter_strength", "medium"))
        new = str(overrides["limiter_strength"])
        if order.get(new, 99) < order.get(cur, 99):
            kwargs["limiter_strength"] = new

    if "saturation_amount" in overrides and overrides["saturation_amount"] is not None:
        cur = kwargs.get("saturation_amount")
        new = float(overrides["saturation_amount"])
        if cur is None or new < float(cur):
            kwargs["saturation_amount"] = new

    if "target_lufs_clamp" in overrides:
        lo, hi = overrides["target_lufs_clamp"]
        cur = float(kwargs.get("target_lufs", -14.0))
        kwargs["target_lufs"] = max(float(lo), min(float(hi), cur))

    # Pass through advanced flags so pipeline / build_filter_chain can read them
    kwargs.setdefault("safe_mode_overrides", {})
    for k in (
        "compressor_ratio_scale", "compressor_attack_scale",
        "vocal_band_protection", "deesser_disabled",
        "static_entry_gain_max", "correction_gain_clamp",
        "limiter_input_gain_clamp", "_appliedModes",
    ):
        if k in overrides:
            kwargs["safe_mode_overrides"][k] = overrides[k]


# ── Recommendation logic — driven by QC + segment results ───────────────────

def recommend_modes(
    quality_check: dict[str, Any] | None,
    limiter_check: dict[str, Any] | None,
    suspect_segments: list[dict[str, Any]] | None,
    input_info: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    """
    Build a prioritized list of mode recommendations for the UI.

    Each recommendation:
      {
        "mode":      "safe" | "vocal_safe" | "low_limit" | "convert_to_wav",
        "reason":    short human-readable reason (Korean),
        "severity":  "info" | "warn" | "danger",
        "evidence":  [list of QC/segment item names that triggered this],
      }
    """
    recs: dict[str, dict[str, Any]] = {}

    def _bump(mode: str, severity: str, reason: str, evidence: str) -> None:
        rank = {"info": 0, "warn": 1, "danger": 2}
        existing = recs.get(mode)
        if existing is None:
            recs[mode] = {
                "mode":     mode,
                "reason":   reason,
                "severity": severity,
                "evidence": [evidence],
            }
            return
        existing["evidence"].append(evidence)
        if rank.get(severity, 0) > rank.get(existing["severity"], 0):
            existing["severity"] = severity
            existing["reason"]   = reason

    lim = (limiter_check or {})
    lim_recs = lim.get("recommendations") or []
    lim_metrics = lim.get("metrics") or {}

    if "low_limiting_mode" in lim_recs or "low_limit" in lim_recs:
        _bump("low_limit", "warn",
              "Limiter 압축이 과해 답답한 느낌이 감지됩니다. 강도를 낮추거나 target LUFS 를 보수화하세요.",
              "limiter_check.low_limiting_mode")
    if "safe_mode" in lim_recs or "safe" in lim_recs:
        _bump("safe", "warn",
              "출력이 목표 LUFS 를 크게 넘었습니다. Safe Mode 로 보수적 마스터링을 권장합니다.",
              "limiter_check.safe_mode")
    if "vocal_safe_mode" in lim_recs or "vocal_safe" in lim_recs:
        _bump("vocal_safe", "warn",
              "파형이 brickwall 형태로 평탄화되었습니다. 보컬 보호 모드로 다시 시도하세요.",
              "limiter_check.vocal_safe_mode")

    # crest factor danger / LRA crash → safe mode is strongest signal
    if (lim.get("overall") == "danger"):
        _bump("safe", "danger",
              "다이내믹 손실이 심각합니다. Safe Mode 로 다시 마스터링하세요.",
              "limiter_check.overall=danger")

    # Suspect segments
    suspects = suspect_segments or []
    n_excess = sum(1 for s in suspects if s.get("reason") == "excessive_limiter_reduction")
    n_brick  = sum(1 for s in suspects if s.get("reason") == "brickwall_flat")
    if n_excess >= 1:
        _bump("low_limit", "warn",
              f"{n_excess}개 구간에서 limiter 가 과도하게 음량을 끌어내렸습니다.",
              f"segments.excessive_limiter_reduction×{n_excess}")
    if n_brick >= 1:
        _bump("vocal_safe", "warn",
              f"{n_brick}개 구간이 brickwall 평탄화되었습니다.",
              f"segments.brickwall_flat×{n_brick}")

    # Input format hint
    info = input_info or {}
    codec = str(info.get("codec", "")).lower()
    if codec in ("mp3", "aac", "opus", "wma"):
        _bump("convert_to_wav", "info",
              f"입력이 {codec.upper()} 입니다. WAV 로 변환 후 재시도하면 음질이 개선될 수 있습니다.",
              f"input.codec={codec}")
    if info.get("vbrCbr") in ("VBR", "VBR-suspected"):
        _bump("convert_to_wav", "info",
              "VBR 입력은 디코딩 시점마다 미세한 차이가 생길 수 있습니다. WAV 로 변환을 권장합니다.",
              f"input.vbrCbr={info.get('vbrCbr')}")

    qc = (quality_check or {})
    for item in qc.get("items", []):
        name   = item.get("name", "")
        status = item.get("status", "")
        if status == "danger" and "True Peak" in name:
            _bump("low_limit", "warn",
                  "True peak 가 한도를 초과했습니다. target LUFS 를 더 낮추세요.",
                  f"qc.{name}")
        if status == "danger" and "과압축" in name:
            _bump("safe", "danger",
                  "과압축이 감지되었습니다. Safe Mode 를 권장합니다.",
                  f"qc.{name}")

    # Order: danger > warn > info, then by mode priority
    mode_order = {"safe": 0, "vocal_safe": 1, "low_limit": 2, "convert_to_wav": 3}
    sev_rank   = {"danger": 0, "warn": 1, "info": 2}
    return sorted(
        recs.values(),
        key=lambda r: (sev_rank.get(r["severity"], 9), mode_order.get(r["mode"], 9)),
    )
