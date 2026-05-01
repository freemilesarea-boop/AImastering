"""
마스터링 리포트 생성기 (v3.2)

run_mastering 의 결과를 UI 가 그대로 표시할 수 있도록
일관된 스키마로 정리한다.

v3.1 → v3.2 추가/변경:
  · entryGainDb         : 체인 시작부 정적 loudness match 게인 (loudnorm 대체)
  · loudnormUsed        : 항상 False (v3.2: pass1 측정 전용, pass2 미사용)
  · useLinearLoudnorm   : 호환성 유지 — loudnormUsed 와 동의어 (false)
"""
from typing import Dict, Any, List, Optional


def build_mastering_report(
    *,
    mode: str,
    target_lufs: float,
    target_tp: float,
    target_lra: float,
    limiter_strength: str,
    before_lufs: float,
    after_lufs: float,
    before_tp: float,
    after_tp: float,
    applied_gain_db: float,
    limiter_reduction_db: float,
    correction_applied: bool,
    correction_gain_db: float,
    target_reached: bool,
    warnings: List[str],
    stages: List[str],
    dynamic_eq_mode: str,
    adynamic_eq_supported: bool,
    metric_comparison: List[Dict[str, Any]],
    quality_check: Dict[str, Any],
    entry_gain_db: float = 0.0,
    loudnorm_used: bool = False,
) -> Dict[str, Any]:
    lufs_delta = round(target_lufs - after_lufs, 2)
    tp_over    = round(max(0.0, after_tp - target_tp), 2)

    return {
        "mode":                  mode,
        "targetLUFS":            target_lufs,
        "targetTruePeak":        target_tp,
        "targetLRA":             target_lra,
        "limiterStrength":       limiter_strength,
        "beforeLUFS":            round(before_lufs, 2),
        "afterLUFS":             round(after_lufs,  2),
        "beforeTruePeak":        round(before_tp,   2),
        "afterTruePeak":         round(after_tp,    2),
        "appliedGainDb":         round(applied_gain_db,      2),
        "limiterReductionDb":    round(limiter_reduction_db, 2),
        "correctionApplied":     correction_applied,
        "correctionGainDb":      round(correction_gain_db, 2) if correction_applied else 0.0,
        "lufsDelta":             lufs_delta,
        "truePeakOverDb":        tp_over,
        "targetReached":         bool(target_reached),
        "warnings":              list(warnings or []),
        # v3.1
        "processingChain":       list(stages or []),
        "dynamicEqMode":         dynamic_eq_mode,
        "adynamicEqSupported":   bool(adynamic_eq_supported),
        "metricComparison":      list(metric_comparison or []),
        "qualityCheck":          dict(quality_check or {}),
        # v3.2 — fully static chain
        "entryGainDb":           round(float(entry_gain_db), 2),
        "loudnormUsed":          bool(loudnorm_used),
        # 호환성: useLinearLoudnorm 는 v3.1 UI 가 사용. v3.2 는 loudnorm 미사용이므로 False.
        "useLinearLoudnorm":     bool(loudnorm_used),
    }
