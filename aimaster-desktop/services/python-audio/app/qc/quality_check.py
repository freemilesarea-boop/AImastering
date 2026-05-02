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


# 임계값 (v3.2.0-rc 사용자 피드백 반영 — "겁주는 경고가 아닌 실제 문제만").
# 음악적 다이나믹 / 브레이크 / 드롭 / 인트로아웃트로는 정상이며 false-positive
# 를 만들지 않도록 input 비교 + 모드별 차등 임계 + 종합 판정을 사용한다.
_TP_WARN_MARGIN       = 0.05   # dB

# short-term variation 의 input-relative delta 기반 (사용자 요구):
#   delta <= ST_DELTA_OK   → OK
#   delta <= ST_DELTA_WARN → WARN
#   delta >  ST_DELTA_WARN → DANGER
_ST_DELTA_OK          = 1.5    # LU — input 다이나믹이 어느 정도 보존
_ST_DELTA_WARN        = 3.0    # LU — 마스터링이 출렁임을 추가했지만 회복 가능

# input metric 이 없을 때 fallback (절대값 기준은 매우 관대하게).
_ST_ABS_OK            = 4.0    # LU
_ST_ABS_WARN          = 6.0    # LU

# Amplitude drop 도 input 대비 *증가량* 으로 판정.
_AMP_DELTA_OK         = 2.0    # dB
_AMP_DELTA_WARN       = 5.0    # dB
# input 측정 불가 시 fallback (관대하게).
_AMP_ABS_OK           = 12.0
_AMP_ABS_WARN         = 18.0

_CLIP_FAIL_SAMPLES    = 100


def _lra_thresholds(target_lufs: float) -> tuple[float, float]:
    """
    target LUFS 별 LRA 임계 (warn, fail).  high-LUFS 마스터링 (kpop_loud,
    loud) 은 본질적으로 LRA 를 줄이며 KPOP / EDM 계열에서 LRA 2~5 LU 는
    정상 범위.  v3.2.0-rc 사용자 피드백 반영 — 모든 임계 한 단계 완화.
    """
    if target_lufs > -10.0:   # kpop_loud (-9)
        return 1.0, 0.3
    if target_lufs > -12.0:   # loud (-10)
        return 1.5, 0.5       # (이전 2.5 / 1.0) — LRA 2.0 LU 이상 OK
    if target_lufs > -13.5:   # balanced/bright/punch (-11, -12)
        return 3.0, 1.5       # (이전 4.0 / 2.0)
    return 4.0, 2.0           # natural / warm (-14)  (이전 5.0 / 3.0)


def _crest_thresholds(target_lufs: float) -> tuple[float, float]:
    """target LUFS 별 crest factor 임계 (warn, fail) — 이전보다 관대."""
    if target_lufs > -10.0:
        return 5.0, 3.0       # (이전 6.0 / 3.5)
    if target_lufs > -12.0:
        return 6.5, 4.0       # (이전 7.5 / 5.0)
    return 8.0, 5.0           # (이전 9.0 / 6.0)


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
    input_path:       str | None = None,
) -> dict[str, Any]:
    """
    마스터링 결과 품질 검사 (v3.2.0-rc 사용자 피드백 반영).

    설계 원칙:
      · 음악적 다이나믹 / 브레이크 / 드롭 / 인트로아웃트로는 정상.
      · output 이 input 대비 *추가로* 출렁이거나 음량이 떨어진 경우만
        실제 문제로 판정.
      · 단일 metric (LRA 만 낮음 등) 으로 danger 처리하지 않음 — clipping,
        TP, crest 등 종합.
      · 메시지는 "겁주는 경고" 가 아닌 "전문가 보조 분석" 톤.

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
    items.append(_check_amplitude_drop(output_path, input_path))
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

    # 메시지 톤 완화 — 사용자가 "망했다" 고 느끼지 않도록.
    if overall == "ok":
        summary = "모든 품질 항목 정상 — 발매 준비 완료."
    elif overall == "warn":
        summary = (
            "참고할 만한 분석 항목이 있습니다. "
            "음악 장르와 의도에 따라 정상일 수 있습니다."
        )
    else:
        summary = (
            "실제 클리핑 / 피크 초과 / 비정상적 음압 변화가 감지되어 "
            "재마스터링을 권장합니다."
        )

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
    """
    short-term LUFS 변동 (출렁임 / 펌핑 의심도) 검사.

    핵심: 입력 자체의 다이나믹은 음악적 의도이므로 펌핑이 아님.
    *output 이 input 보다 추가로 출렁이게 된 경우* 만 문제로 본다.
    임계값은 사용자 피드백 반영:
        delta <= 1.5 LU → OK   (input 다이나믹 충실히 보존)
        delta <= 3.0 LU → WARN (마스터링이 추가 출렁임 도입)
        delta >  3.0 LU → DANGER (실제 펌핑 의심)
    """
    var = metrics.get("shortTermVarLU")
    if var is None:
        return _item("음압 안정성", "ok",
                     "측정 데이터 부족 — 참고 항목에서 제외", value=None)
    var = float(var)

    in_var = (input_metrics or {}).get("shortTermVarLU")
    if in_var is not None and float(in_var) > 0:
        in_var_f = float(in_var)
        delta = var - in_var_f
        if delta <= _ST_DELTA_OK:
            # input 변동이 큰 곡 (브레이크다운 / 인트로아웃트로 등) 도 여기로
            # 떨어짐 — output 이 그 변동을 그대로 보존했다면 문제 없음.
            return _item("음압 안정성", "ok",
                         f"output {var:.1f} LU / input {in_var_f:.1f} LU "
                         f"(차이 {delta:+.1f}) — 입력 다이나믹 보존",
                         value=var)
        if delta <= _ST_DELTA_WARN:
            return _item("음압 안정성", "warn",
                         f"output {var:.1f} LU / input {in_var_f:.1f} LU "
                         f"(차이 +{delta:.1f}) — 마스터링이 다소 출렁임을 추가",
                         value=var)
        return _item("음압 안정성", "danger",
                     f"output {var:.1f} LU / input {in_var_f:.1f} LU "
                     f"(차이 +{delta:.1f}) — 펌핑 의심",
                     value=var)

    # input metrics 없을 때 fallback (관대한 절대값).  "확정" 이 아니므로
    # 메시지를 정보 톤으로.
    if var <= _ST_ABS_OK:
        return _item("음압 안정성", "ok",
                     f"short-term 변동 {var:.1f} LU — 안정적", value=var)
    if var <= _ST_ABS_WARN:
        return _item("음압 안정성", "warn",
                     f"short-term 변동 {var:.1f} LU — 곡 전개 변화일 수 있음 "
                     f"(입력 비교 데이터 없음)", value=var)
    return _item("음압 안정성", "danger",
                 f"short-term 변동 {var:.1f} LU — 출렁임 의심 "
                 f"(입력 비교 데이터 없음)", value=var)


def _check_amplitude_drop(
    output_path: str,
    input_path: str | None = None,
) -> dict[str, Any]:
    """
    전 구간 RMS spread (1초 윈도우 percentile) 기반 amplitude drop 검사.
    input_path 가 주어지면 input 의 같은 spread 와 비교해 *추가* 변화량으로
    판정 — 음악적 인트로 / 아웃트로 / 브레이크다운은 input 에도 같은 drop
    이 있으므로 OK 로 떨어진다.
    """
    drop = detect_amplitude_drop(output_path)
    if drop is None:
        return _item("Amplitude Drop", "ok",
                     "측정 데이터 부족 — 참고 항목에서 제외", value=None)

    in_drop: float | None = None
    if input_path:
        try:
            in_drop = detect_amplitude_drop(input_path)
        except Exception as exc:
            log("WARN", f"Amplitude Drop 입력 측정 실패: {exc}")

    if in_drop is not None and in_drop > 0:
        delta = drop - in_drop
        if delta <= _AMP_DELTA_OK:
            return _item("Amplitude Drop", "ok",
                         f"output spread {drop:.1f} dB / input {in_drop:.1f} dB "
                         f"(차이 {delta:+.1f}) — 곡 전개 보존",
                         value=drop)
        if delta <= _AMP_DELTA_WARN:
            return _item("Amplitude Drop", "warn",
                         f"output {drop:.1f} dB / input {in_drop:.1f} dB "
                         f"(차이 +{delta:.1f}) — 일부 구간 음량 차이 추가됨",
                         value=drop)
        return _item("Amplitude Drop", "danger",
                     f"output {drop:.1f} dB / input {in_drop:.1f} dB "
                     f"(차이 +{delta:.1f}) — 비정상적 음량 변화",
                     value=drop)

    # input 측정 불가 시 — 절대값 기준은 매우 관대하게.
    if drop <= _AMP_ABS_OK:
        return _item("Amplitude Drop", "ok",
                     f"전 구간 RMS spread {drop:.1f} dB — 일관됨", value=drop)
    if drop <= _AMP_ABS_WARN:
        return _item("Amplitude Drop", "warn",
                     f"RMS spread {drop:.1f} dB — 곡 전개 변화일 수 있음 "
                     f"(입력 비교 데이터 없음)", value=drop)
    return _item("Amplitude Drop", "danger",
                 f"RMS spread {drop:.1f} dB — 비정상적 음량 변화 의심 "
                 f"(입력 비교 데이터 없음)", value=drop)


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
    """
    과압축 검사 — LRA 와 crest factor 를 *함께* 본다.

    핵심 (사용자 피드백): LRA 만 낮다고 danger 처리하지 않는다.  KPOP /
    EDM / Loud 는 본질적으로 LRA 가 낮음.  실제 과압축은 crest factor 도
    같이 무너진 경우.  또한 입력이 이미 다이나믹이 적은 경우 (LRA 보존)
    는 OK.
    """
    crest = metrics.get("crestFactor")
    lra   = metrics.get("lra")
    crest_f = float(crest) if crest is not None else None
    lra_f   = float(lra)   if lra   is not None else None

    in_lra_raw = (input_metrics or {}).get("lra")
    in_lra = float(in_lra_raw) if in_lra_raw is not None else None

    # (a) 입력이 이미 stationary 였다면 (LRA < 2.5) output 도 비슷하면 OK.
    if in_lra is not None and in_lra < 2.5:
        if lra_f is None or (in_lra - lra_f) < 1.5:
            return _item("과압축", "ok",
                         f"입력이 이미 stationary (LRA {in_lra:.1f} LU) — 보존됨",
                         value={"crest": crest_f, "lra": lra_f, "inputLra": in_lra})

    # (b) input 대비 LRA 가 크게 줄지 않았으면 OK (마스터링이 의도적으로
    #     깎은 것이 아님).
    if in_lra is not None and lra_f is not None:
        lra_loss = in_lra - lra_f
        if lra_loss < 1.0:
            return _item("과압축", "ok",
                         f"LRA 보존 (input {in_lra:.1f} → output {lra_f:.1f} LU, "
                         f"손실 {lra_loss:.1f} LU)",
                         value={"crest": crest_f, "lra": lra_f, "inputLra": in_lra})

    lra_warn,   lra_fail   = _lra_thresholds(target_lufs)
    crest_warn, crest_fail = _crest_thresholds(target_lufs)

    # (c) DANGER 는 LRA 와 crest 가 *동시에* fail level 일 때만.  단일 metric
    #     fail 은 warn 으로 강등 (장르 특성일 가능성).
    lra_fail_hit   = lra_f   is not None and lra_f   < lra_fail
    crest_fail_hit = crest_f is not None and crest_f < crest_fail
    if lra_fail_hit and crest_fail_hit:
        return _item("과압축", "danger",
                     f"다이나믹 손실 (crest {crest_f:.1f} dB, LRA {lra_f:.1f} LU)",
                     value={"crest": crest_f, "lra": lra_f})

    # (d) WARN 은 한 metric 이라도 warn level 이면.  메시지는 "장르 특성일
    #     수 있음" 톤.
    warns: list[str] = []
    if crest_f is not None and crest_f < crest_warn:
        warns.append(f"crest {crest_f:.1f} dB")
    if lra_f is not None and lra_f < lra_warn:
        warns.append(f"LRA {lra_f:.1f} LU")
    if warns:
        return _item("과압축", "warn",
                     f"{', '.join(warns)} — 고음압 장르 (KPOP/EDM/Loud) 에서는 "
                     f"정상 범위일 수 있음",
                     value={"crest": crest_f, "lra": lra_f})

    crest_str = f"{crest_f:.1f}" if crest_f is not None else "-"
    lra_str   = f"{lra_f:.1f}"   if lra_f   is not None else "-"
    return _item("과압축", "ok",
                 f"crest {crest_str} dB / LRA {lra_str} LU — 정상 범위",
                 value={"crest": crest_f, "lra": lra_f})
