"""
Limiter / over-compression QC for the debug-quality system.

The user feedback "리미팅이 많이 된다 / 너무 눌린 느낌" requires a dedicated
detector beyond the existing quality_check.run_quality_check() which only
inspects post-master metrics in isolation.  This module compares input vs.
output and looks specifically for limiter signatures:

  · crest factor reduction
  · LRA reduction ratio
  · true peak attached to ceiling for a high fraction of the file
  · waveform brickwall regions (flat-topped runs)
  · output integrated LUFS exceeding target by too much
  · ISP safety correction was abnormally large

Each check returns ok | warn | danger plus a Korean-readable message.  The
overall verdict is the worst of the children.

Severity policy (matches the user's request):

  crest factor          < 6 dB   → warn
  crest factor          < 4 dB   → danger
  ceiling-attached frac > 0.40   → warn   (40% of windows)
  ceiling-attached frac > 0.65   → danger
  LRA reduction         > 60 %   → warn
  LRA reduction         > 80 %   → danger
  ISP correction        ≤ -2 dB  → warn
  ISP correction        ≤ -4 dB  → danger
  output LUFS overshoot > 1.5 LU → warn
  output LUFS overshoot > 3.0 LU → danger
  brickwall samples ratio > 0.05 → warn
"""
from __future__ import annotations

from typing import Any

from app.utils.logger import log

try:
    import numpy as np
    import soundfile as sf
    HAS_SF = True
except ImportError:
    HAS_SF = False


# ── Thresholds (per spec) ────────────────────────────────────────────────────

_CREST_WARN          = 6.0
_CREST_DANGER        = 4.0
_CEILING_ATTACH_WARN = 0.40
_CEILING_ATTACH_DANG = 0.65
_LRA_REDUCE_WARN     = 0.60
_LRA_REDUCE_DANG     = 0.80
_ISP_WARN            = -2.0
_ISP_DANG            = -4.0
_LUFS_OVERSHOOT_WARN = 1.5
_LUFS_OVERSHOOT_DANG = 3.0
_BRICKWALL_RATIO_WARN = 0.05    # 5% of samples flat-topped

_CEILING_ATTACH_DB   = 0.5      # peak within this distance of ceiling = "attached"
_BRICKWALL_DELTA_FS  = 0.0010   # consecutive samples within this delta = flat


def _item(name: str, status: str, message: str, value: Any = None) -> dict[str, Any]:
    return {"name": name, "status": status, "message": message, "value": value}


def _worst(*statuses: str) -> str:
    rank = {"ok": 0, "warn": 1, "danger": 2}
    return max(statuses, key=lambda s: rank.get(s, 0))


def _measure_ceiling_attached_fraction(
    file_path: str,
    ceiling_dbtp: float,
    window_ms: float = 50.0,
) -> tuple[float | None, float | None]:
    """
    Returns (fraction of windows whose peak is within ceiling_attach_db of
    the ceiling, brickwall-flat sample ratio).  Both are None if numpy/sf
    is unavailable.
    """
    if not HAS_SF:
        return None, None
    try:
        data, sr = sf.read(file_path, always_2d=True, dtype="float32")
    except Exception as exc:
        log("WARN", f"[limiter_check] read failed: {exc}")
        return None, None

    if data.size == 0:
        return None, None

    mono = np.mean(data, axis=1) if data.ndim == 2 else data
    if mono.size < sr:
        return None, None

    win = max(1, int(round(window_ms / 1000.0 * sr)))
    n = (len(mono) // win) * win
    if n == 0:
        return None, None

    reshaped = mono[:n].reshape(-1, win)
    peaks = np.max(np.abs(reshaped), axis=1)
    # Convert to dBFS (≈ dBTP for sample-domain detector — close enough).
    eps = 1e-12
    peaks_db = 20.0 * np.log10(np.maximum(peaks, eps))

    attach_thresh = ceiling_dbtp - _CEILING_ATTACH_DB
    attached_frac = float(np.mean(peaks_db >= attach_thresh))

    # Brickwall: count samples whose abs() is at the global peak within
    # _BRICKWALL_DELTA_FS, i.e. the limiter pinned them to a flat ceiling.
    abs_mono = np.abs(mono)
    global_peak = float(np.max(abs_mono)) if abs_mono.size else 0.0
    if global_peak <= 0:
        brick_ratio = 0.0
    else:
        brick_ratio = float(np.mean(abs_mono >= global_peak - _BRICKWALL_DELTA_FS))

    return round(attached_frac, 3), round(brick_ratio, 4)


# ── Public API ───────────────────────────────────────────────────────────────

def run_limiter_check(
    output_path: str,
    *,
    target_lufs: float,
    target_tp: float,
    input_metrics: dict[str, Any] | None,
    output_metrics: dict[str, Any],
    isp_correction_db: float = 0.0,
    limiter_strength: str = "medium",
) -> dict[str, Any]:
    """
    Run all limiter / over-compression checks.  Returns:

      {
        "overall": "ok" | "warn" | "danger",
        "items":   [{name, status, message, value}, ...],
        "metrics": {
          "crestDelta": ...,
          "lraReductionRatio": ...,
          "ceilingAttachedFrac": ...,
          "brickwallSampleRatio": ...,
          "lufsOvershoot": ...,
          "ispCorrectionDb": ...,
        },
        "recommendations": ["low_limiting_mode", "safe_mode", ...]
      }
    """
    items: list[dict[str, Any]] = []
    metrics: dict[str, Any] = {}
    recs: list[str] = []

    in_metrics = input_metrics or {}

    # ── 1. Crest factor ───────────────────────────────────────────────
    out_crest = output_metrics.get("crestFactor")
    in_crest  = in_metrics.get("crestFactor")
    if out_crest is None:
        items.append(_item("Crest Factor", "warn", "측정 실패", None))
    else:
        c = float(out_crest)
        delta = round(c - float(in_crest), 2) if in_crest is not None else None
        metrics["crestDelta"] = delta
        if c < _CREST_DANGER:
            items.append(_item("Crest Factor", "danger",
                               f"{c:.1f} dB — 4 dB 미만, brickwall 의심", value=c))
            recs.append("low_limiting_mode")
        elif c < _CREST_WARN:
            items.append(_item("Crest Factor", "warn",
                               f"{c:.1f} dB — 6 dB 미만, 압축 다소 과다", value=c))
            recs.append("low_limiting_mode")
        else:
            items.append(_item("Crest Factor", "ok",
                               f"{c:.1f} dB — 정상", value=c))

    # ── 2. LRA reduction ──────────────────────────────────────────────
    in_lra  = in_metrics.get("lra")
    out_lra = output_metrics.get("lra")
    if in_lra is not None and out_lra is not None and float(in_lra) > 0.5:
        ratio = max(0.0, (float(in_lra) - float(out_lra)) / float(in_lra))
        metrics["lraReductionRatio"] = round(ratio, 3)
        if ratio >= _LRA_REDUCE_DANG:
            items.append(_item("LRA 감소", "danger",
                               f"LRA {float(in_lra):.1f} → {float(out_lra):.1f} LU "
                               f"({ratio*100:.0f}% 감소) — 다이내믹 손실 큼", value=ratio))
            recs.append("low_limiting_mode")
        elif ratio >= _LRA_REDUCE_WARN:
            items.append(_item("LRA 감소", "warn",
                               f"LRA {float(in_lra):.1f} → {float(out_lra):.1f} LU "
                               f"({ratio*100:.0f}% 감소) — 다소 큰 감소", value=ratio))
            recs.append("low_limiting_mode")
        else:
            items.append(_item("LRA 감소", "ok",
                               f"LRA {float(in_lra):.1f} → {float(out_lra):.1f} LU "
                               f"({ratio*100:.0f}% 감소) — 보존됨", value=ratio))
    else:
        items.append(_item("LRA 감소", "ok", "입력 LRA 정보 없음 — 비교 생략", value=None))

    # ── 3. Ceiling-attached fraction + brickwall sample ratio ────────
    attached, brick = _measure_ceiling_attached_fraction(output_path, target_tp)
    if attached is not None:
        metrics["ceilingAttachedFrac"] = attached
        if attached >= _CEILING_ATTACH_DANG:
            items.append(_item("Ceiling 부착", "danger",
                               f"{attached*100:.0f}% 의 구간이 한도 근처에 붙음 — "
                               f"전구간 limiter 압박", value=attached))
            recs.append("low_limiting_mode")
        elif attached >= _CEILING_ATTACH_WARN:
            items.append(_item("Ceiling 부착", "warn",
                               f"{attached*100:.0f}% 의 구간이 한도 근처에 붙음 — "
                               f"limiter 부담 큼", value=attached))
            recs.append("low_limiting_mode")
        else:
            items.append(_item("Ceiling 부착", "ok",
                               f"{attached*100:.0f}% — 정상 범위", value=attached))
    if brick is not None:
        metrics["brickwallSampleRatio"] = brick
        if brick >= _BRICKWALL_RATIO_WARN:
            items.append(_item("Brickwall 평탄화", "warn",
                               f"{brick*100:.2f}% 샘플이 동일 피크에 평탄화됨 — "
                               f"파형이 brickwall 처럼 잘림", value=brick))
            recs.append("vocal_safe_mode")
        else:
            items.append(_item("Brickwall 평탄화", "ok",
                               f"{brick*100:.2f}% — 정상", value=brick))

    # ── 4. LUFS overshoot vs target ───────────────────────────────────
    out_lufs = output_metrics.get("integratedLufs")
    if out_lufs is not None:
        overshoot = round(float(out_lufs) - float(target_lufs), 2)
        metrics["lufsOvershoot"] = overshoot
        if overshoot >= _LUFS_OVERSHOOT_DANG:
            items.append(_item("출력 LUFS", "danger",
                               f"목표 {target_lufs:+.1f} 보다 {overshoot:+.1f} LU 큼 — "
                               f"과도한 푸시", value=overshoot))
            recs.append("safe_mode")
        elif overshoot >= _LUFS_OVERSHOOT_WARN:
            items.append(_item("출력 LUFS", "warn",
                               f"목표 {target_lufs:+.1f} 보다 {overshoot:+.1f} LU 큼", value=overshoot))
            recs.append("safe_mode")
        else:
            items.append(_item("출력 LUFS", "ok",
                               f"{float(out_lufs):.1f} LUFS — 목표 근접", value=float(out_lufs)))

    # ── 5. ISP safety correction ──────────────────────────────────────
    metrics["ispCorrectionDb"] = round(float(isp_correction_db), 3)
    if isp_correction_db <= _ISP_DANG:
        items.append(_item("ISP 보정", "danger",
                           f"{isp_correction_db:+.2f} dB — true peak 을 강하게 끌어내림",
                           value=isp_correction_db))
        recs.append("low_limiting_mode")
    elif isp_correction_db <= _ISP_WARN:
        items.append(_item("ISP 보정", "warn",
                           f"{isp_correction_db:+.2f} dB — true peak 보정 큼",
                           value=isp_correction_db))
        recs.append("low_limiting_mode")
    else:
        items.append(_item("ISP 보정", "ok",
                           f"{isp_correction_db:+.2f} dB — 정상", value=isp_correction_db))

    # Strong limiter strength is a soft hint in itself
    if limiter_strength == "high":
        items.append(_item("Limiter 강도", "warn",
                           "limiter strength=high — 일부 사용자에서 보컬 뭉개짐 보고됨",
                           value=limiter_strength))
        recs.append("low_limiting_mode")

    # ── Roll up ───────────────────────────────────────────────────────
    overall = "ok"
    for it in items:
        overall = _worst(overall, it.get("status", "ok"))

    # Deduplicate recommendation list (preserve order)
    seen: set[str] = set()
    deduped: list[str] = []
    for r in recs:
        if r not in seen:
            seen.add(r)
            deduped.append(r)

    return {
        "overall":         overall,
        "items":           items,
        "metrics":         metrics,
        "recommendations": deduped,
    }
