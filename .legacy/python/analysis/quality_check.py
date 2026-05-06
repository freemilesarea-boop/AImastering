"""
마스터링 결과 자동 품질 검사 모듈 (v3.1)

마스터링 산출물에 대해 다음을 검사한다:
  1. True Peak 가 -1.0 dBTP 초과
  2. short-term LUFS 변동폭 과다 (음압 출렁임 의심)
  3. waveform amplitude drop 감지 (특정 구간 dip)
  4. 클리핑 샘플 검출
  5. crest factor / LRA 가 과도하게 낮음 (과압축)

각 항목은 status: ok | warn | danger 로 분류.
overall 은 가장 심한 항목을 따른다 (ok < warn < danger).

이 모듈은 마스터링이 완료된 직후 자동 호출되며,
ResultPage 의 "품질 체크 리포트" 섹션에 표시된다.
"""
from typing import Dict, Any, List, Optional
from ..pipeline.waveform import detect_amplitude_drop
from ..utils.logger import get_logger

logger = get_logger(__name__)


# 임계값
TP_LIMIT             = -1.0   # dBTP
TP_WARN_MARGIN       = 0.05   # 한도 이내 0.05dB 까지는 OK
SHORT_TERM_VAR_WARN  = 1.0    # LU
SHORT_TERM_VAR_FAIL  = 2.5    # LU
AMPLITUDE_DROP_WARN  = 8.0    # dB
AMPLITUDE_DROP_FAIL  = 12.0   # dB
CLIP_WARN_SAMPLES    = 1
CLIP_FAIL_SAMPLES    = 100
CREST_WARN_DB        = 9.0
CREST_FAIL_DB        = 6.0
LRA_WARN             = 5.0
LRA_FAIL             = 3.0


def run_quality_check(
    output_path: str,
    output_analysis: Dict[str, Any],
    output_metrics: Dict[str, Any],
    target_true_peak: float = TP_LIMIT,
    ffmpeg_path: str = "ffmpeg",
) -> Dict[str, Any]:
    """
    마스터링 결과 품질 검사 실행.

    Returns:
        {
          "overall":  "ok" | "warn" | "danger",
          "summary":  "사람이 읽는 짧은 결론",
          "items":    [QC item, ...]
        }
    """
    items: List[Dict[str, Any]] = []

    items.append(_check_true_peak(output_metrics, target_true_peak))
    items.append(_check_short_term_variation(output_metrics))
    items.append(_check_amplitude_drop(output_path, ffmpeg_path))
    items.append(_check_clipping(output_metrics))
    items.append(_check_over_compression(output_metrics))

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
        summary = "모든 품질 항목 통과 — 발매 준비 완료"
    elif overall == "warn":
        summary = "주의 항목이 있습니다. 청취 후 확인 권장."
    else:
        summary = "위험 항목이 감지되었습니다. 재마스터링을 권장합니다."

    return {
        "overall": overall,
        "summary": summary,
        "items":   items,
    }


# ─────────────────────────────────────────────────────
# 검사 항목
# ─────────────────────────────────────────────────────

def _check_true_peak(metrics: Dict, target: float) -> Optional[Dict]:
    tp = metrics.get("truePeak")
    if tp is None:
        return _item("True Peak", "warn", "값을 측정하지 못했습니다", value=None)
    if tp <= target + TP_WARN_MARGIN:
        return _item("True Peak", "ok", f"{tp:.2f} dBTP (한도 {target:.1f})", value=tp)
    if tp <= target + 0.5:
        return _item("True Peak", "warn",
                     f"{tp:.2f} dBTP — 한도 {target:.1f} 보다 {tp - target:.2f} dB 초과", value=tp)
    return _item("True Peak", "danger",
                 f"{tp:.2f} dBTP — 한도 초과 {tp - target:.2f} dB. 디지털 왜곡 위험.", value=tp)


def _check_short_term_variation(metrics: Dict) -> Optional[Dict]:
    var = metrics.get("shortTermVarLU")
    if var is None:
        return _item("음압 안정성", "warn", "변동성을 측정하지 못했습니다", value=None)
    if var < SHORT_TERM_VAR_WARN:
        return _item("음압 안정성", "ok",
                     f"short-term 변동 ±{var:.1f} LU — 안정적", value=var)
    if var < SHORT_TERM_VAR_FAIL:
        return _item("음압 안정성", "warn",
                     f"short-term 변동 ±{var:.1f} LU — 다소 큼", value=var)
    return _item("음압 안정성", "danger",
                 f"short-term 변동 ±{var:.1f} LU — 출렁임 / 펌핑 의심", value=var)


def _check_amplitude_drop(output_path: str, ffmpeg_path: str) -> Optional[Dict]:
    drop = detect_amplitude_drop(output_path, ffmpeg_path=ffmpeg_path)
    if drop is None:
        return _item("Amplitude Drop", "warn", "측정 실패 (분석 파일 너무 짧음)", value=None)
    if drop < AMPLITUDE_DROP_WARN:
        return _item("Amplitude Drop", "ok",
                     f"전 구간 RMS spread {drop:.1f} dB — 일관됨", value=drop)
    if drop < AMPLITUDE_DROP_FAIL:
        return _item("Amplitude Drop", "warn",
                     f"RMS spread {drop:.1f} dB — 일부 구간 음량 차이 있음", value=drop)
    return _item("Amplitude Drop", "danger",
                 f"RMS spread {drop:.1f} dB — 구간별 큰 음량 차이. 출렁임 가능", value=drop)


def _check_clipping(metrics: Dict) -> Optional[Dict]:
    samples = int(metrics.get("clippingSamples", 0) or 0)
    if samples == 0:
        return _item("클리핑", "ok", "클리핑 없음", value=0)
    if samples < CLIP_FAIL_SAMPLES:
        return _item("클리핑", "warn",
                     f"{samples} 샘플 — 미세 클리핑 발생", value=samples)
    return _item("클리핑", "danger",
                 f"{samples} 샘플 — 디지털 왜곡 위험", value=samples)


def _check_over_compression(metrics: Dict) -> Optional[Dict]:
    crest = metrics.get("crestFactor")
    lra   = metrics.get("lra")
    issues = []
    if crest is not None and crest < CREST_FAIL_DB:
        issues.append(f"crest {crest:.1f} dB")
    if lra is not None and lra < LRA_FAIL:
        issues.append(f"LRA {lra:.1f} LU")
    if issues:
        return _item("과압축", "danger",
                     f"다이나믹 손실 ({', '.join(issues)})",
                     value={"crest": crest, "lra": lra})

    warns = []
    if crest is not None and crest < CREST_WARN_DB:
        warns.append(f"crest {crest:.1f} dB")
    if lra is not None and lra < LRA_WARN:
        warns.append(f"LRA {lra:.1f} LU")
    if warns:
        return _item("과압축", "warn",
                     f"다이나믹 다소 부족 ({', '.join(warns)})",
                     value={"crest": crest, "lra": lra})

    return _item("과압축", "ok",
                 f"crest {crest if crest is not None else '-'} dB / LRA {lra if lra is not None else '-'} LU",
                 value={"crest": crest, "lra": lra})


# ─────────────────────────────────────────────────────
# 헬퍼
# ─────────────────────────────────────────────────────

def _item(name: str, status: str, message: str, value: Any = None) -> Dict:
    return {
        "name":    name,
        "status":  status,        # ok | warn | danger
        "message": message,
        "value":   value,
    }
