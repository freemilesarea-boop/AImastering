"""
마스터링 결과 자동 품질 검사 (v3.2 P2).

이 모듈은 마스터링 직후 호출되어 다음 항목을 검사한다:
  1. True Peak 가 한도 초과
  2. short-term LUFS 변동 (음압 출렁임 / 펌핑 의심)
  3. Amplitude drop (구간별 RMS spread 과다)
  4. Clipping 샘플
  5. 과압축 (crest / LRA 가 너무 낮음)

각 항목은 status: ok | warn | danger 로 분류.  overall 은 가장 심한
항목을 따른다 (ok < warn < danger).

기존 qc_checker.py 의 12-item QC 와는 별도로 동작 — qc_checker 는
"파일 자체의 정합성" 을, run_quality_check 는 "마스터링 결과의 음악적
품질" 을 검증한다.  pipeline.py 가 이 함수를 호출한다.
"""
from __future__ import annotations

from typing import Any

from app.analysis.metrics import detect_amplitude_drop
from app.utils.logger import log


# 임계값 (모드 무관)
_TP_WARN_MARGIN       = 0.05   # dB
_SHORT_TERM_WARN      = 1.5    # LU
_SHORT_TERM_FAIL      = 2.5    # LU
_AMPLITUDE_DROP_WARN  = 8.0    # dB
_AMPLITUDE_DROP_FAIL  = 12.0   # dB
_CLIP_FAIL_SAMPLES    = 100


def _lra_thresholds(target_lufs: float) -> tuple[float, float]:
    """
    target LUFS 에 따라 LRA 임계 (warn, fail) 동적 계산.
    high-LUFS 마스터링 (kpop_loud, loud) 은 본질적으로 LRA 를 줄이므로
    natural / streaming 보다 관대해야 한다.
    """
    if target_lufs > -10.0:   # kpop_loud (-9), edm_loud (-8)
        return 1.5, 0.3
    if target_lufs > -12.0:   # loud (-10)
        return 2.5, 1.0
    if target_lufs > -13.5:   # balanced/bright/punch (-11, -12)
        return 4.0, 2.0
    return 5.0, 3.0           # natural / warm (-14)


def _crest_thresholds(target_lufs: float) -> tuple[float, float]:
    """target LUFS 별 crest factor 임계 (warn, fail)."""
    if target_lufs > -10.0:
        return 6.0, 3.5
    if target_lufs > -12.0:
        return 7.5, 5.0
    return 9.0, 6.0


def _item(name: str, status: str, message: str, value: Any = None) -> dict[str, Any]:
    return {
        "name":    name,
        "status":  status,
        "message": message,
        "value":   value,
    }


def run_quality_check(
    output_path: str,
    output_metrics: dict[str, Any],
    *,
    target_true_peak: float = -1.0,
    target_lufs:      float = -14.0,
    input_metrics:    dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    마스터링 결과 품질 검사.

    target_lufs 는 LRA / crest factor 임계를 모드에 맞춰 완화하기 위해 사용.
    input_metrics 가 제공되면 short-term variation 은 입력 대비 *증가량* 으로
    판정 (입력 자체의 다이내믹은 펌핑 아님).

    Returns:
        {
          "overall":  "ok" | "warn" | "danger",
          "summary":  "사람이 읽는 짧은 결론",
          "items":    [{name, status, message, value}, ...]
        }
    """
    items: list[dict[str, Any]] = []

    items.append(_check_true_peak(output_metrics, target_true_peak))
    items.append(_check_short_term(output_metrics, input_metrics))
    items.append(_check_amplitude_drop(output_path))
    items.append(_check_clipping(output_metrics))
    items.append(_check_over_compression(output_metrics, target_lufs, input_metrics))

    items = [i for i in items if i is not None]

    overall = "ok"
    for it in items:
        s = it.get("status", "ok")
        if s == "danger":
            overall = "danger"
            break
        if s == "warn" and overall == "ok":
            overall = "warn"

    if overall == "ok":
        summary = "모든 품질 항목 통과 — 발매 준비 완료."
    elif overall == "warn":
        summary = "일부 항목에서 주의가 필요합니다. 청취 후 확인을 권장합니다."
    else:
        summary = "위험 항목이 감지되었습니다. 모드 / 강도 조정 후 재마스터링을 권장합니다."

    return {
        "overall": overall,
        "summary": summary,
        "items":   items,
    }


# ── 검사 항목 ─────────────────────────────────────────────────────────────────

def _check_true_peak(metrics: dict[str, Any], target: float) -> dict[str, Any]:
    tp = metrics.get("truePeakDbtp")
    if tp is None:
        return _item("True Peak", "warn", "측정 실패", value=None)
    tp = float(tp)
    if tp <= target + _TP_WARN_MARGIN:
        return _item("True Peak", "ok",
                     f"{tp:.2f} dBTP (한도 {target:+.1f})", value=tp)
    if tp <= target + 0.5:
        return _item("True Peak", "warn",
                     f"{tp:.2f} dBTP — 한도 {target:+.1f} 보다 {tp - target:+.2f} dB 초과",
                     value=tp)
    return _item("True Peak", "danger",
                 f"{tp:.2f} dBTP — 한도 초과 {tp - target:+.2f} dB. 디지털 왜곡 위험.",
                 value=tp)


def _check_short_term(
    metrics: dict[str, Any],
    input_metrics: dict[str, Any] | None,
) -> dict[str, Any]:
    var = metrics.get("shortTermVarLU")
    if var is None:
        return _item("음압 안정성", "warn", "변동성을 측정하지 못했습니다", value=None)
    var = float(var)

    # 입력 대비 *증가량* 으로 판정 (입력 자체의 다이내믹은 펌핑 아님)
    in_var = (input_metrics or {}).get("shortTermVarLU")
    if in_var is not None and float(in_var) > 0:
        delta = var - float(in_var)
        # 마스터링이 입력보다 더 출렁이게 만든 경우만 펌핑 의심
        if delta < 0.5:
            return _item("음압 안정성", "ok",
                         f"short-term 변동 {var:.1f} LU "
                         f"(입력 {float(in_var):.1f} 대비 변화 {delta:+.1f}) — 보존됨",
                         value=var)
        if delta < 1.5:
            return _item("음압 안정성", "warn",
                         f"short-term 변동 {var:.1f} LU "
                         f"(입력 대비 +{delta:.1f}) — 마스터링이 다소 출렁임",
                         value=var)
        return _item("음압 안정성", "danger",
                     f"short-term 변동 {var:.1f} LU "
                     f"(입력 대비 +{delta:.1f}) — 펌핑 의심",
                     value=var)

    # 입력 metrics 없으면 절대값 기준
    if var < _SHORT_TERM_WARN:
        return _item("음압 안정성", "ok",
                     f"short-term 변동 {var:.1f} LU — 안정적", value=var)
    if var < _SHORT_TERM_FAIL:
        return _item("음압 안정성", "warn",
                     f"short-term 변동 {var:.1f} LU — 다소 큼", value=var)
    return _item("음압 안정성", "danger",
                 f"short-term 변동 {var:.1f} LU — 출렁임/펌핑 의심", value=var)


def _check_amplitude_drop(output_path: str) -> dict[str, Any]:
    drop = detect_amplitude_drop(output_path)
    if drop is None:
        return _item("Amplitude Drop", "warn", "측정 실패 (파일이 너무 짧거나 무음)", value=None)
    if drop < _AMPLITUDE_DROP_WARN:
        return _item("Amplitude Drop", "ok",
                     f"전 구간 RMS spread {drop:.1f} dB — 일관됨", value=drop)
    if drop < _AMPLITUDE_DROP_FAIL:
        return _item("Amplitude Drop", "warn",
                     f"RMS spread {drop:.1f} dB — 일부 구간 음량 차이 있음", value=drop)
    return _item("Amplitude Drop", "danger",
                 f"RMS spread {drop:.1f} dB — 구간별 큰 음량 차이. 출렁임 가능", value=drop)


def _check_clipping(metrics: dict[str, Any]) -> dict[str, Any]:
    samples = int(metrics.get("clippingSamples", 0) or 0)
    if samples == 0:
        return _item("클리핑", "ok", "클리핑 없음", value=0)
    if samples < _CLIP_FAIL_SAMPLES:
        return _item("클리핑", "warn", f"{samples} 샘플 — 미세 클리핑", value=samples)
    return _item("클리핑", "danger", f"{samples} 샘플 — 디지털 왜곡", value=samples)


def _check_over_compression(
    metrics: dict[str, Any],
    target_lufs: float,
    input_metrics: dict[str, Any] | None = None,
) -> dict[str, Any]:
    crest = metrics.get("crestFactor")
    lra   = metrics.get("lra")
    crest_f = float(crest) if crest is not None else None
    lra_f   = float(lra)   if lra   is not None else None

    # 입력 자체가 이미 stationary (LRA < 2 LU) 면 마스터링이 줄였다고 비난할 수 없다.
    # input 보존 비율 기준으로 판정.
    in_lra_raw = (input_metrics or {}).get("lra")
    in_lra = float(in_lra_raw) if in_lra_raw is not None else None
    if in_lra is not None and in_lra < 2.0:
        # 입력이 이미 다이내믹 거의 없음 → 출력도 그대로면 ok
        if lra_f is not None and (in_lra - lra_f) < 1.0:
            return _item("과압축", "ok",
                         f"입력이 이미 stationary (LRA {in_lra:.1f} LU) — 보존됨",
                         value={"crest": crest_f, "lra": lra_f, "inputLra": in_lra})

    lra_warn,   lra_fail   = _lra_thresholds(target_lufs)
    crest_warn, crest_fail = _crest_thresholds(target_lufs)

    issues: list[str] = []
    if crest_f is not None and crest_f < crest_fail:
        issues.append(f"crest {crest_f:.1f} dB")
    if lra_f is not None and lra_f < lra_fail:
        issues.append(f"LRA {lra_f:.1f} LU")
    if issues:
        return _item("과압축", "danger",
                     f"다이나믹 손실 ({', '.join(issues)})",
                     value={"crest": crest_f, "lra": lra_f})

    warns: list[str] = []
    if crest_f is not None and crest_f < crest_warn:
        warns.append(f"crest {crest_f:.1f} dB")
    if lra_f is not None and lra_f < lra_warn:
        warns.append(f"LRA {lra_f:.1f} LU")
    if warns:
        return _item("과압축", "warn",
                     f"다이나믹 다소 부족 ({', '.join(warns)})",
                     value={"crest": crest_f, "lra": lra_f})

    crest_str = f"{crest_f:.1f}" if crest_f is not None else "-"
    lra_str   = f"{lra_f:.1f}"   if lra_f   is not None else "-"
    return _item("과압축", "ok",
                 f"crest {crest_str} dB / LRA {lra_str} LU",
                 value={"crest": crest_f, "lra": lra_f})
