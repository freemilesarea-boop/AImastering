"""
Metrics + before/after 비교 (v3.2 P2).

활성 코드는 loudnorm(pass1) 으로 LUFS / TP / LRA 를 측정하고, 추가로 numpy
기반 RMS / sample peak / crest factor 를 계산한다.  short-term 변동성은
1초 비중첩 윈도우 RMS 의 percentile spread (P95 − P5) 로 추정 — 정확한
ITU short-term LUFS 는 아니지만 출렁임 / 펌핑 의심도 지표로 충분.

build_metric_comparison() 은 input/output metrics 를 받아 UI 가 그대로
표시할 수 있는 정렬된 list[dict] 를 반환한다.  각 row 형태:
    {
      "key":     "lufs_integrated",
      "label":   "Integrated LUFS",
      "unit":    "LUFS",
      "before":  -23.4,
      "after":   -10.2,
      "delta":   +13.2,
      "status":  "ok" | "warn" | "danger",
      "hint":    "사람이 읽는 짧은 코멘트",
    }

설계:
  · soundfile 미설치 환경에서도 절대 raise 하지 않는다 — metrics 는
    None 으로 채워지고 UI 가 'measured: false' 로 표시.
  · 모든 값이 None 인 row 는 결과 list 에서 제외.
"""
from __future__ import annotations

import math
from typing import Any

from app.utils.logger import log

try:
    import numpy as np
    import soundfile as sf
    HAS_SF = True
except ImportError:
    HAS_SF = False


# ── helpers ───────────────────────────────────────────────────────────────────

def _safe_float(v: Any) -> float | None:
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if math.isnan(f) or math.isinf(f):
        return None
    return f


def _safe_delta(after: Any, before: Any) -> float | None:
    a = _safe_float(after)
    b = _safe_float(before)
    if a is None or b is None:
        return None
    return round(a - b, 2)


def _lin_to_db(x: float) -> float | None:
    if x <= 0:
        return None
    return round(20.0 * math.log10(x), 2)


def _estimate_short_term_variation(
    mono: "np.ndarray",
    sr: int,
    window_sec: float = 1.0,
) -> tuple[float | None, bool]:
    """
    1초 비중첩 RMS 의 percentile spread (P95 − P5) 를 short-term LUFS 변동의
    proxy 로 반환.  > 2.5 LU 이면 펌핑/출렁임 의심으로 판정.
    """
    if mono is None or mono.size == 0:
        return None, False
    win = int(sr * window_sec)
    if win <= 0 or len(mono) < win * 3:
        return None, False
    n_wins = len(mono) // win
    rms_db: list[float] = []
    for i in range(n_wins):
        seg = mono[i * win:(i + 1) * win]
        r = float(np.sqrt(np.mean(seg ** 2)))
        if r > 0:
            rms_db.append(20.0 * math.log10(r))
    if len(rms_db) < 5:
        return None, False
    arr = np.array(rms_db)
    spread = round(float(np.percentile(arr, 95) - np.percentile(arr, 5)), 2)
    return spread, spread > 2.5


# ── public API ────────────────────────────────────────────────────────────────

def compute_metrics(
    file_path: str,
    loudness: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    파일에서 metrics 계산.  loudness 는 이미 측정된 LUFS / TP / LRA dict
    (없으면 모든 numeric 값이 None 으로 들어옴).

    Returns:
        {
          "integratedLufs": float | None,
          "truePeakDbtp":   float | None,
          "lra":            float | None,
          "peakDb":         float | None,   # sample peak
          "rmsDb":          float | None,
          "crestFactor":    float | None,   # peak − rms  (dB)
          "shortTermVarLU": float | None,   # P95 − P5 spread
          "pumpingRisk":    bool,
          "clippingDetected": bool,
          "clippingSamples":  int,
        }
    """
    out: dict[str, Any] = {
        "integratedLufs": None,
        "truePeakDbtp":   None,
        "lra":            None,
        "peakDb":         None,
        "rmsDb":          None,
        "crestFactor":    None,
        "shortTermVarLU": None,
        "pumpingRisk":    False,
        "clippingDetected": False,
        "clippingSamples":  0,
    }
    if loudness:
        # 다양한 호출자가 다양한 키 이름을 쓰므로 둘 다 허용
        out["integratedLufs"] = _safe_float(
            loudness.get("integratedLufs", loudness.get("input_i"))
        )
        out["truePeakDbtp"] = _safe_float(
            loudness.get("truePeakDbtp", loudness.get("input_tp"))
        )
        out["lra"] = _safe_float(
            loudness.get("lra", loudness.get("input_lra"))
        )

    if not HAS_SF:
        return out

    try:
        data, sr = sf.read(file_path, always_2d=True, dtype="float32")
    except Exception as exc:
        log("WARN", f"metrics: soundfile.read 실패 ({file_path}): {exc}")
        return out

    try:
        mono = np.mean(data, axis=1) if data.ndim == 2 else data
        peak = float(np.max(np.abs(mono))) if mono.size else 0.0
        rms_lin = float(np.sqrt(np.mean(mono ** 2))) if mono.size else 0.0
        out["peakDb"] = _lin_to_db(peak)
        out["rmsDb"]  = _lin_to_db(rms_lin)
        if peak > 0 and rms_lin > 0:
            out["crestFactor"] = round(20.0 * math.log10(peak / rms_lin), 2)
    except Exception as exc:
        log("WARN", f"metrics: peak/rms 계산 실패: {exc}")

    try:
        st_var, pumping = _estimate_short_term_variation(mono, sr)
        out["shortTermVarLU"] = st_var
        out["pumpingRisk"]    = pumping
    except Exception as exc:
        log("WARN", f"metrics: short-term 변동 계산 실패: {exc}")

    try:
        # 0.9999 FS 이상 = 클리핑 샘플
        clip_count = int(np.sum(np.abs(data) >= 0.9999))
        out["clippingDetected"] = clip_count > 0
        out["clippingSamples"]  = clip_count
    except Exception as exc:
        log("WARN", f"metrics: clipping 검출 실패: {exc}")

    return out


def detect_amplitude_drop(file_path: str) -> float | None:
    """
    1초 비중첩 RMS 의 percentile spread (dB) 를 amplitude drop 지표로 반환.
    short-term variation 과 같은 측정이지만 quality_check 에서 별도로 부르기
    위해 분리 export.  실패 시 None.
    """
    if not HAS_SF:
        return None
    try:
        data, sr = sf.read(file_path, always_2d=True, dtype="float32")
        mono = np.mean(data, axis=1) if data.ndim == 2 else data
        spread, _ = _estimate_short_term_variation(mono, sr)
        return spread
    except Exception as exc:
        log("WARN", f"amplitude drop 검출 실패: {exc}")
        return None


# ── before/after 비교 ────────────────────────────────────────────────────────

def _row(
    key: str, label: str, unit: str,
    before: Any, after: Any,
    status: str, hint: str = "",
) -> dict[str, Any]:
    return {
        "key":    key,
        "label":  label,
        "unit":   unit,
        "before": before,
        "after":  after,
        "delta":  _safe_delta(after, before),
        "status": status,
        "hint":   hint,
    }


def _status_lufs(after: Any) -> tuple[str, str]:
    a = _safe_float(after)
    if a is None:
        return "warn", "측정 실패"
    if a > -6.0:
        return "danger", "스트리밍 한도 초과"
    if a < -24.0:
        return "warn", "너무 작음 — 추가 게인 필요"
    return "ok", "스트리밍 적정 범위"


def _status_tp(after: Any, target: float) -> tuple[str, str]:
    a = _safe_float(after)
    if a is None:
        return "warn", "측정 실패"
    if a > target + 0.05:
        return "danger", f"한도 ({target:+.1f} dBTP) 초과"
    if a > target - 0.5:
        return "warn", "한도 근접"
    return "ok", "안전 범위"


def _status_peak(after: Any) -> tuple[str, str]:
    a = _safe_float(after)
    if a is None:
        return "warn", "측정 실패"
    if a >= 0.0:
        return "danger", "샘플 클리핑"
    if a >= -0.3:
        return "warn", "0 dBFS 근접"
    return "ok", "여유 충분"


def _status_lra(after: Any) -> tuple[str, str]:
    a = _safe_float(after)
    if a is None:
        return "warn", "측정 실패"
    if a < 3.0:
        return "danger", "다이나믹 레인지 손실"
    if a < 5.0:
        return "warn", "다이나믹 다소 부족"
    return "ok", "다이나믹 충분"


def _status_crest(after: Any) -> tuple[str, str]:
    a = _safe_float(after)
    if a is None:
        return "warn", "측정 실패"
    if a < 6.0:
        return "danger", "과압축 의심"
    if a < 9.0:
        return "warn", "압축 다소 강함"
    return "ok", "안정적"


def _status_st_var(after: Any) -> tuple[str, str]:
    a = _safe_float(after)
    if a is None:
        return "warn", "측정 실패"
    if a > 2.5:
        return "danger", "출렁임 / 펌핑 의심"
    if a > 1.5:
        return "warn", "다소 큰 short-term 변동"
    return "ok", "short-term 안정적"


def build_metric_comparison(
    input_metrics: dict[str, Any],
    output_metrics: dict[str, Any],
    target_true_peak: float,
) -> list[dict[str, Any]]:
    """input/output metrics 를 비교해 UI 표시용 row 리스트 생성."""
    rows: list[dict[str, Any]] = []

    # 1. Integrated LUFS
    s, h = _status_lufs(output_metrics.get("integratedLufs"))
    rows.append(_row(
        "lufs_integrated", "Integrated LUFS", "LUFS",
        input_metrics.get("integratedLufs"),
        output_metrics.get("integratedLufs"),
        s, h,
    ))

    # 2. True Peak
    s, h = _status_tp(output_metrics.get("truePeakDbtp"), target_true_peak)
    rows.append(_row(
        "true_peak", "True Peak", "dBTP",
        input_metrics.get("truePeakDbtp"),
        output_metrics.get("truePeakDbtp"),
        s, h,
    ))

    # 3. Sample peak
    s, h = _status_peak(output_metrics.get("peakDb"))
    rows.append(_row(
        "peak", "Sample Peak", "dBFS",
        input_metrics.get("peakDb"),
        output_metrics.get("peakDb"),
        s, h,
    ))

    # 4. RMS
    rows.append(_row(
        "rms", "RMS", "dBFS",
        input_metrics.get("rmsDb"),
        output_metrics.get("rmsDb"),
        "ok", "참고용 — 음압 인지의 근사 지표",
    ))

    # 5. LRA
    s, h = _status_lra(output_metrics.get("lra"))
    rows.append(_row(
        "lra", "LRA", "LU",
        input_metrics.get("lra"),
        output_metrics.get("lra"),
        s, h,
    ))

    # 6. Crest factor
    s, h = _status_crest(output_metrics.get("crestFactor"))
    rows.append(_row(
        "crest", "Crest Factor", "dB",
        input_metrics.get("crestFactor"),
        output_metrics.get("crestFactor"),
        s, h,
    ))

    # 7. Clipping samples
    in_clip  = int(input_metrics.get("clippingSamples", 0) or 0)
    out_clip = int(output_metrics.get("clippingSamples", 0) or 0)
    if out_clip == 0:
        cs, ch = "ok", "클리핑 없음"
    elif out_clip < 100:
        cs, ch = "warn", f"미세 클리핑 {out_clip} 샘플"
    else:
        cs, ch = "danger", f"클리핑 {out_clip} 샘플 — 디지털 왜곡"
    rows.append({
        "key":    "clipping",
        "label":  "클리핑 샘플",
        "unit":   "samples",
        "before": in_clip,
        "after":  out_clip,
        "delta":  out_clip - in_clip,
        "status": cs,
        "hint":   ch,
    })

    # 8. short-term variation
    if output_metrics.get("shortTermVarLU") is not None:
        s, h = _status_st_var(output_metrics.get("shortTermVarLU"))
        rows.append(_row(
            "short_term_var", "음압 출렁임", "LU",
            input_metrics.get("shortTermVarLU"),
            output_metrics.get("shortTermVarLU"),
            s, h,
        ))

    # 모든 numeric 필드가 None 인 row 는 빼서 리포트 깔끔하게 유지
    cleaned: list[dict[str, Any]] = []
    for r in rows:
        if r.get("before") is None and r.get("after") is None:
            continue
        cleaned.append(r)
    return cleaned
