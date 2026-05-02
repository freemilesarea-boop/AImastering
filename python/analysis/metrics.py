"""
오디오 metrics 분석 모듈 (v3.1)

전/후 비교용 metrics 를 계산한다. ffmpeg 의 loudnorm 결과(이미 measure 된 값)
를 그대로 활용하고, 추가로 numpy 로 RMS / peak / crest factor / short-term LUFS
변동성을 계산한다.

build_metric_comparison() 은 input_metrics, output_metrics 를 받아
UI 가 그대로 표시할 수 있는 정렬된 list[dict] 를 반환한다.

각 항목은 다음 형태:
    {
      "key":      "lufs_integrated",
      "label":    "Integrated LUFS",
      "unit":     "LUFS",
      "before":   -23.4,
      "after":    -10.2,
      "delta":    +13.2,
      "status":   "ok" | "warn" | "danger",
      "hint":     "사람이 읽는 짧은 코멘트"
    }
"""
from typing import Dict, Any, List, Optional, Tuple
import math
import numpy as np
from ..utils.audio_io import load_audio, HAS_SOUNDFILE
from ..utils.logger import get_logger

logger = get_logger(__name__)


def compute_metrics(
    file_path: str,
    analysis: Dict[str, Any],
) -> Dict[str, Any]:
    """
    파일에서 metrics 추출. analysis 는 analyze_file() 결과를 그대로 받는다.
    파형 기반 metrics(RMS, peak, crest, short-term variation) 는 soundfile
    이 사용 가능할 때만 계산. 실패 시 None.
    """
    out: Dict[str, Any] = {
        "lufsIntegrated": _safe_float(analysis.get("lufsIntegrated")),
        "truePeak":       _safe_float(analysis.get("truePeak")),
        "lra":            _safe_float(analysis.get("lra")),
        "dynamicRange":   _safe_float(analysis.get("dynamicRange")),
        "clippingDetected": bool(analysis.get("clippingDetected", False)),
        "clippingSamples":  int(analysis.get("clippingSamples", 0) or 0),
        "peakDb":         None,
        "rmsDb":          None,
        "crestFactor":    None,
        "shortTermVarLU": None,
        "pumpingRisk":    False,
    }

    if not HAS_SOUNDFILE:
        return out

    try:
        audio, sr = load_audio(file_path)
    except Exception as exc:
        logger.warning(f"metrics: audio load 실패 {file_path}: {exc}")
        return out

    try:
        mono = np.mean(audio, axis=0) if audio.ndim == 2 else audio
        peak = float(np.max(np.abs(mono))) if mono.size else 0.0
        rms_lin = float(np.sqrt(np.mean(mono ** 2))) if mono.size else 0.0
        out["peakDb"] = _lin_to_db(peak)
        out["rmsDb"]  = _lin_to_db(rms_lin)
        if peak > 0 and rms_lin > 0:
            out["crestFactor"] = round(20 * math.log10(peak / rms_lin), 2)
    except Exception as exc:
        logger.warning(f"metrics: peak/rms 계산 실패: {exc}")

    # short-term LUFS 변동성 추정 (1초 윈도우 RMS 표준편차 기반 — 정확한 LUFS는 아니지만 출렁임 지표로 사용)
    try:
        st_var, pumping = _estimate_short_term_variation(mono, sr)
        out["shortTermVarLU"] = st_var
        out["pumpingRisk"]    = pumping
    except Exception as exc:
        logger.warning(f"metrics: short-term 변동성 계산 실패: {exc}")

    return out


def build_metric_comparison(
    input_metrics: Dict[str, Any],
    output_metrics: Dict[str, Any],
    target_true_peak: float,
) -> List[Dict[str, Any]]:
    """
    input/output metrics 를 비교해 UI 표시용 항목 리스트 생성.
    값이 없으면 항목을 skip. 모든 값이 null 안전.
    """
    rows: List[Dict[str, Any]] = []

    # Integrated LUFS
    rows.append(_build_row(
        key="lufs_integrated", label="Integrated LUFS", unit="LUFS",
        before=input_metrics.get("lufsIntegrated"),
        after=output_metrics.get("lufsIntegrated"),
        higher_is_louder=True,
        status_fn=_status_for_lufs,
    ))
    # True Peak
    rows.append(_build_row(
        key="true_peak", label="True Peak", unit="dBTP",
        before=input_metrics.get("truePeak"),
        after=output_metrics.get("truePeak"),
        status_fn=lambda b, a: _status_for_tp(a, target_true_peak),
    ))
    # Peak (digital sample peak)
    rows.append(_build_row(
        key="peak", label="Peak", unit="dBFS",
        before=input_metrics.get("peakDb"),
        after=output_metrics.get("peakDb"),
        status_fn=lambda b, a: _status_for_peak(a),
    ))
    # RMS
    rows.append(_build_row(
        key="rms", label="RMS", unit="dBFS",
        before=input_metrics.get("rmsDb"),
        after=output_metrics.get("rmsDb"),
        status_fn=lambda b, a: "ok",
    ))
    # LRA
    rows.append(_build_row(
        key="lra", label="LRA", unit="LU",
        before=input_metrics.get("lra"),
        after=output_metrics.get("lra"),
        status_fn=lambda b, a: _status_for_lra(a),
    ))
    # Crest factor (Dynamic Range proxy)
    rows.append(_build_row(
        key="crest", label="Crest Factor", unit="dB",
        before=input_metrics.get("crestFactor"),
        after=output_metrics.get("crestFactor"),
        status_fn=lambda b, a: _status_for_crest(a),
    ))
    # Clipping
    in_clip  = input_metrics.get("clippingSamples", 0) or 0
    out_clip = output_metrics.get("clippingSamples", 0) or 0
    rows.append({
        "key":    "clipping",
        "label":  "클리핑 샘플",
        "unit":   "samples",
        "before": in_clip,
        "after":  out_clip,
        "delta":  out_clip - in_clip,
        "status": "danger" if out_clip > 100 else ("warn" if out_clip > 0 else "ok"),
        "hint":   "0 = 클리핑 없음" if out_clip == 0 else f"{out_clip} 샘플 발생",
    })
    # 음압 출렁임 가능성 (short-term variation)
    st_after = output_metrics.get("shortTermVarLU")
    if st_after is not None:
        if st_after > 2.0:
            stat, hint = "danger", "short-term LUFS 변동 큼 — 펌핑/출렁임 의심"
        elif st_after > 1.0:
            stat, hint = "warn", "다소 큰 short-term 변동"
        else:
            stat, hint = "ok", "short-term 변동 안정적"
        rows.append({
            "key":    "short_term_var",
            "label":  "음압 출렁임",
            "unit":   "LU",
            "before": input_metrics.get("shortTermVarLU"),
            "after":  st_after,
            "delta":  _safe_delta(st_after, input_metrics.get("shortTermVarLU")),
            "status": stat,
            "hint":   hint,
        })
    # 과압축 위험 (LRA + crest 조합)
    lra_after   = output_metrics.get("lra")
    crest_after = output_metrics.get("crestFactor")
    if lra_after is not None or crest_after is not None:
        risk = (
            (lra_after is not None and lra_after < 3.0) or
            (crest_after is not None and crest_after < 6.0)
        )
        rows.append({
            "key":    "over_compression",
            "label":  "과압축 위험",
            "unit":   "",
            "before": None,
            "after":  "위험" if risk else "정상",
            "delta":  None,
            "status": "danger" if risk else "ok",
            "hint":   "LRA/Crest 가 너무 낮으면 다이나믹 손실. 모드 강도 낮춤 권장." if risk
                     else "다이나믹 충분",
        })

    return [r for r in rows if r is not None]


# ─────────────────────────────────────────────────────
# 내부 헬퍼
# ─────────────────────────────────────────────────────

def _build_row(
    key: str, label: str, unit: str,
    before: Optional[float], after: Optional[float],
    status_fn,
    higher_is_louder: bool = False,
) -> Dict[str, Any]:
    delta = _safe_delta(after, before)
    if before is None and after is None:
        return None  # type: ignore
    status = status_fn(before, after)
    return {
        "key":    key,
        "label":  label,
        "unit":   unit,
        "before": before,
        "after":  after,
        "delta":  delta,
        "status": status,
        "hint":   "",
    }


def _safe_float(v) -> Optional[float]:
    try:
        if v is None:
            return None
        f = float(v)
        if math.isnan(f) or math.isinf(f):
            return None
        return f
    except (TypeError, ValueError):
        return None


def _safe_delta(after, before) -> Optional[float]:
    if after is None or before is None:
        return None
    try:
        return round(float(after) - float(before), 2)
    except (TypeError, ValueError):
        return None


def _lin_to_db(x: float) -> Optional[float]:
    if x <= 0:
        return None
    return round(20 * math.log10(x), 2)


def _estimate_short_term_variation(
    mono: np.ndarray,
    sr: int,
    window_sec: float = 1.0,
) -> Tuple[Optional[float], bool]:
    """
    1초 윈도우 RMS 의 표준편차(dB) 를 short-term LUFS 변동의 proxy 로 사용.
    pumping 의심: 변동폭(P95 - P5) > 2.5 LU.
    """
    if mono is None or mono.size == 0:
        return None, False
    win = int(sr * window_sec)
    if win <= 0 or len(mono) < win * 3:
        return None, False
    # 비중첩 윈도우
    n_wins = len(mono) // win
    rms_db = []
    for i in range(n_wins):
        seg = mono[i * win:(i + 1) * win]
        r = float(np.sqrt(np.mean(seg ** 2)))
        if r > 0:
            rms_db.append(20 * math.log10(r))
    if len(rms_db) < 5:
        return None, False
    arr = np.array(rms_db)
    # 양 끝 무음 5% 제거
    p5  = float(np.percentile(arr, 5))
    p95 = float(np.percentile(arr, 95))
    spread = round(p95 - p5, 2)
    pumping = spread > 2.5
    return spread, pumping


# ── 상태 판정 함수 ────────────────────────────────────

def _status_for_lufs(before, after) -> str:
    if after is None:
        return "warn"
    if after > -6.0:   return "danger"   # 너무 큼
    if after < -24.0:  return "warn"     # 너무 작음
    return "ok"


def _status_for_tp(after, target) -> str:
    if after is None:
        return "warn"
    if after > target + 0.05:
        return "danger"
    if after > target - 0.5:
        return "warn"
    return "ok"


def _status_for_peak(after) -> str:
    if after is None:
        return "warn"
    if after >= 0.0:
        return "danger"
    if after >= -0.3:
        return "warn"
    return "ok"


def _status_for_lra(after) -> str:
    if after is None:
        return "warn"
    if after < 3.0:  return "danger"
    if after < 5.0:  return "warn"
    return "ok"


def _status_for_crest(after) -> str:
    if after is None:
        return "warn"
    if after < 6.0:   return "danger"
    if after < 9.0:   return "warn"
    return "ok"
