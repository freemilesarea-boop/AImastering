"""
QC 검사 모듈 — 12항목 전체 검사
발매 전 기술 오류 점검 도구

검사 항목:
  1.  파일 포맷 검사
  2.  샘플레이트 검사
  3.  비트뎁스 검사
  4.  스테레오 여부
  5.  Integrated LUFS 측정
  6.  True Peak 측정
  7.  Loudness Range(LRA) 측정
  8.  클리핑 여부
  9.  시작/끝 무음 구간 검사
  10. DC offset 간이 검사
  11. 좌/우 채널 밸런스 검사
  12. 재인코딩/업샘플링 의심 경고 (휴리스틱)

결과 등급:
  pass    — 정상
  warning — 주의 (자동 보정 가능 또는 경미한 문제)
  fail    — 확인 필요 (발매 전 수동 점검 권고)
"""
from typing import Dict, List, Any
from ..pipeline.analyzer import analyze_file
from ..utils.logger import get_logger

logger = get_logger(__name__)

# ─────────────────────────────────────────────────────
# 플랫폼 기준 (마스터링 타깃)
# ─────────────────────────────────────────────────────
# ※ 아래 수치는 본 제품의 권장 타깃 스펙입니다.
#   각 플랫폼 공식 정책은 변경될 수 있습니다.
PLATFORM_SPECS = [
    {"platform": "YouTube Music", "targetLUFS": -14.0, "targetTP": -1.0, "tolerance": 1.0},
    {"platform": "Spotify",       "targetLUFS": -14.0, "targetTP": -1.0, "tolerance": 1.0},
    {"platform": "Apple Music",   "targetLUFS": -16.0, "targetTP": -1.0, "tolerance": 2.0},
    {"platform": "Tidal",         "targetLUFS": -14.0, "targetTP": -1.0, "tolerance": 1.0},
    {"platform": "Amazon Music HD","targetLUFS": -14.0, "targetTP": -2.0, "tolerance": 1.5},
]

# QC 기준값
LUFS_TARGET      = -14.0
LUFS_TOLERANCE   =  1.0   # ±1.0 LUFS
TP_LIMIT         =  -1.0  # dBTP
LRA_MIN          =   3.0  # LRA < 3 → 과도한 압축 경고
LRA_WARN         =   5.0  # LRA < 5 → 주의
SILENCE_WARN_MS  = 500.0  # 무음 구간 500ms 초과 경고
SILENCE_FAIL_MS  = 2000.0 # 무음 구간 2초 초과 실패
DC_OFFSET_WARN   = 0.005  # 절대값 기준
DC_OFFSET_FAIL   = 0.020
STEREO_WARN_DB   = 3.0    # L/R 밸런스 차이 dB


# ─────────────────────────────────────────────────────
# 메인 QC 실행
# ─────────────────────────────────────────────────────

def run_qc(
    file_path: str,
    ffmpeg_path:  str = "ffmpeg",
    ffprobe_path: str = "ffprobe",
) -> Dict[str, Any]:
    """
    전체 12항목 QC 검사 실행
    Returns: QCResult 형태의 딕셔너리
    """
    logger.info(f"QC check: {file_path}")

    # 파일 전체 분석 수행
    a = analyze_file(file_path, ffmpeg_path, ffprobe_path)

    items: List[Dict[str, Any]] = []

    # ── 1. 파일 포맷 검사 ──────────────────────────────
    items.append(_check_format(a))

    # ── 2. 샘플레이트 검사 ────────────────────────────
    items.append(_check_sample_rate(a))

    # ── 3. 비트뎁스 검사 ──────────────────────────────
    items.append(_check_bit_depth(a))

    # ── 4. 스테레오 여부 ──────────────────────────────
    items.append(_check_stereo(a))

    # ── 5. Integrated LUFS ─────────────────────────────
    items.append(_check_lufs(a))

    # ── 6. True Peak ───────────────────────────────────
    items.append(_check_true_peak(a))

    # ── 7. Loudness Range (LRA) ────────────────────────
    items.append(_check_lra(a))

    # ── 8. 클리핑 여부 ─────────────────────────────────
    items.append(_check_clipping(a))

    # ── 9. 시작/끝 무음 구간 ──────────────────────────
    items.append(_check_silence(a))

    # ── 10. DC Offset ──────────────────────────────────
    items.append(_check_dc_offset(a))

    # ── 11. 좌/우 채널 밸런스 ──────────────────────────
    items.append(_check_stereo_balance(a))

    # ── 12. 재인코딩/업샘플링 의심 ───────────────────
    items.append(_check_upsample(a))

    # ── 플랫폼별 결과 ────────────────────────────────
    platforms = _check_platforms(a)

    # ── 전체 판정 ────────────────────────────────────
    has_fail    = any(i["status"] == "fail"    for i in items)
    has_warning = any(i["status"] == "warning" for i in items)

    if has_fail:
        overall = "fail"
        summary = "확인 필요 항목이 있습니다. 발매 전 점검을 권장합니다."
    elif has_warning:
        overall = "warning"
        summary = "주의 항목이 있습니다. 내용을 확인하세요."
    else:
        overall = "pass"
        summary = "모든 QC 항목 통과. 발매 준비 완료."

    passed_count = sum(1 for i in items if i["status"] == "pass")

    logger.info(f"QC done: {overall} ({passed_count}/{len(items)} pass)")

    return {
        "passed":   overall == "pass",
        "overall":  overall,
        "summary":  summary,
        "passCount":   passed_count,
        "totalCount":  len(items),
        "items":    items,
        "platforms": platforms,
        "analysis": {
            "lufsIntegrated": a["lufsIntegrated"],
            "truePeak":       a["truePeak"],
            "lra":            a["lra"],
            "dynamicRange":   a["dynamicRange"],
        },
        "aiDetection": a.get("aiDetection", {}),
    }


# ─────────────────────────────────────────────────────
# 개별 검사 함수
# ─────────────────────────────────────────────────────

def _check_format(a: Dict) -> Dict:
    codec = a.get("codec", "unknown").lower()
    ext   = a["filePath"].rsplit(".", 1)[-1].lower() if "." in a["filePath"] else ""

    supported = {"wav", "flac", "aiff", "pcm_s16le", "pcm_s24le", "pcm_s32le",
                 "pcm_f32le", "pcm_s16be", "pcm_s24be"}
    is_ok = ext in {"wav", "flac", "aiff"} or any(s in codec for s in {"pcm", "flac"})

    # MP3 입력은 허용하지만 경고
    if ext == "mp3":
        return _item("파일 포맷", "warning", f"MP3 입력 ({codec}). 손실 포맷이므로 WAV 원본 사용 권장.",
                     value=ext.upper())

    if not is_ok:
        return _item("파일 포맷", "fail", f"지원하지 않는 포맷: {ext}/{codec}.", value=f"{ext.upper()}")

    return _item("파일 포맷", "pass", f"{ext.upper()} ({codec})", value=ext.upper())


def _check_sample_rate(a: Dict) -> Dict:
    sr = a["sampleRate"]
    if sr in (44100, 48000, 96000):
        label = f"{sr/1000:.1f} kHz"
        return _item("샘플레이트", "pass", label, value=sr)
    if sr in (22050, 32000):
        return _item("샘플레이트", "warning",
                     f"{sr/1000:.1f} kHz — 권장 44.1 / 48 kHz보다 낮습니다.", value=sr)
    return _item("샘플레이트", "fail",
                 f"비표준 샘플레이트: {sr} Hz. 리샘플링을 권장합니다.", value=sr)


def _check_bit_depth(a: Dict) -> Dict:
    bd = a["bitDepth"]
    if bd in (24, 32):
        return _item("비트뎁스", "pass", f"{bd}-bit", value=bd)
    if bd == 16:
        return _item("비트뎁스", "warning",
                     "16-bit — 마스터링 작업 전에는 24-bit 이상 권장.", value=bd)
    return _item("비트뎁스", "warning", f"{bd}-bit (비표준)", value=bd)


def _check_stereo(a: Dict) -> Dict:
    ch = a["channels"]
    if ch == 2:
        return _item("스테레오", "pass", "스테레오 (2ch)", value=ch)
    if ch == 1:
        return _item("스테레오", "warning", "모노 — 스테레오 마스터 권장.", value=ch)
    return _item("스테레오", "warning", f"{ch}채널 — 2채널(스테레오) 기준으로 처리됩니다.", value=ch)


def _check_lufs(a: Dict) -> Dict:
    lufs = a["lufsIntegrated"]
    diff = lufs - LUFS_TARGET
    label = f"{lufs:.1f} LUFS (타깃 {LUFS_TARGET})"

    if abs(diff) <= LUFS_TOLERANCE:
        return _item("Integrated LUFS", "pass", label, value=lufs)
    if abs(diff) <= LUFS_TOLERANCE * 3:
        direction = "높음" if diff > 0 else "낮음"
        return _item("Integrated LUFS", "warning",
                     f"{label} — {direction} ({diff:+.1f} LUFS). 자동 보정 적용됩니다.", value=lufs)
    return _item("Integrated LUFS", "fail",
                 f"{label} — 타깃과 {abs(diff):.1f} LUFS 차이. 마스터링 권장.", value=lufs)


def _check_true_peak(a: Dict) -> Dict:
    tp = a["truePeak"]
    label = f"{tp:.1f} dBTP (한계 {TP_LIMIT})"

    if tp <= TP_LIMIT:
        return _item("True Peak", "pass", label, value=tp)
    if tp <= TP_LIMIT + 0.5:
        return _item("True Peak", "warning",
                     f"{label} — 한계를 {tp - TP_LIMIT:.1f} dB 초과. 리미터 처리 권장.", value=tp)
    return _item("True Peak", "fail",
                 f"{label} — 한계를 {tp - TP_LIMIT:.1f} dB 초과. 디지털 왜곡 위험.", value=tp)


def _check_lra(a: Dict) -> Dict:
    lra = a["lra"]
    if lra >= LRA_WARN:
        return _item("Loudness Range (LRA)", "pass", f"{lra:.1f} LU", value=lra)
    if lra >= LRA_MIN:
        return _item("Loudness Range (LRA)", "warning",
                     f"{lra:.1f} LU — 다이나믹이 다소 부족합니다 (권장 ≥ {LRA_WARN} LU).", value=lra)
    return _item("Loudness Range (LRA)", "fail",
                 f"{lra:.1f} LU — 과도한 압축(brickwall) 의심. 다이나믹이 거의 없습니다.", value=lra)


def _check_clipping(a: Dict) -> Dict:
    detected = a["clippingDetected"]
    samples  = a["clippingSamples"]
    ir       = a.get("intersampleRisk", False)

    if not detected and not ir:
        return _item("클리핑", "pass", "클리핑 없음", value=0)
    if detected:
        extra = " + intersample peak 위험" if ir else ""
        status = "fail" if samples > 100 else "warning"
        return _item("클리핑", status,
                     f"디지털 클리핑 감지: {samples}샘플{extra}. 리미터 처리 필요.", value=samples)
    # intersample only
    return _item("클리핑", "warning",
                 "Intersample peak 위험 — 일부 DAC/앰프에서 왜곡 발생 가능.", value=0)


def _check_silence(a: Dict) -> Dict:
    s_start = a.get("silenceStartMs", 0.0)
    s_end   = a.get("silenceEndMs",   0.0)
    max_silence = max(s_start, s_end)

    if max_silence < SILENCE_WARN_MS:
        return _item("무음 구간", "pass",
                     f"시작 {s_start:.0f}ms / 끝 {s_end:.0f}ms", value=max_silence)
    if max_silence < SILENCE_FAIL_MS:
        return _item("무음 구간", "warning",
                     f"시작 {s_start:.0f}ms / 끝 {s_end:.0f}ms — 무음 구간이 있습니다.", value=max_silence)
    return _item("무음 구간", "fail",
                 f"시작 {s_start:.0f}ms / 끝 {s_end:.0f}ms — 긴 무음이 발생합니다. 트리밍 권장.", value=max_silence)


def _check_dc_offset(a: Dict) -> Dict:
    dc = a.get("dcOffset", 0.0)
    if dc < DC_OFFSET_WARN:
        return _item("DC Offset", "pass", f"{dc:.5f} (정상)", value=dc)
    if dc < DC_OFFSET_FAIL:
        return _item("DC Offset", "warning",
                     f"DC Offset {dc:.5f} — 미미한 수준이나 주의.", value=dc)
    return _item("DC Offset", "fail",
                 f"DC Offset {dc:.5f} — 높음. 하이패스 처리 권장.", value=dc)


def _check_stereo_balance(a: Dict) -> Dict:
    ai = a.get("aiDetection", {})
    imbalance    = ai.get("stereoImbalance", False)
    imbalance_db = ai.get("stereoImbalanceDb", 0.0)
    channels     = a["channels"]

    if channels < 2:
        return _item("스테레오 밸런스", "warning", "모노 파일 — 해당 없음.", value=0.0)
    if not imbalance:
        return _item("스테레오 밸런스", "pass",
                     f"좌/우 균형 정상 (차이 {imbalance_db:.1f} dB)", value=imbalance_db)
    return _item("스테레오 밸런스", "warning",
                 f"좌/우 에너지 차이 {imbalance_db:.1f} dB (권장 < {STEREO_WARN_DB} dB). "
                 "AI 생성 음원에서 자주 나타납니다.", value=imbalance_db)


def _check_upsample(a: Dict) -> Dict:
    suspected = a.get("upsampleSuspected", False)
    if not suspected:
        return _item("업샘플링 의심", "pass", "업샘플링 징후 없음", value=False)
    return _item("업샘플링 의심", "warning",
                 "고주파 에너지 패턴이 MP3/저품질 소스를 업샘플링한 것으로 의심됩니다. "
                 "원본 파일을 확인하세요.", value=True)


# ─────────────────────────────────────────────────────
# 플랫폼별 검사
# ─────────────────────────────────────────────────────

def _check_platforms(a: Dict) -> List[Dict]:
    measured_lufs = a["lufsIntegrated"]
    measured_tp   = a["truePeak"]
    results = []

    for spec in PLATFORM_SPECS:
        issues = []
        lufs_diff = measured_lufs - spec["targetLUFS"]

        if abs(lufs_diff) > spec["tolerance"]:
            d = "높음" if lufs_diff > 0 else "낮음"
            issues.append(f"LUFS {d}: {measured_lufs:.1f} (기준 {spec['targetLUFS']} ±{spec['tolerance']})")

        if measured_tp > spec["targetTP"]:
            issues.append(f"True Peak 초과: {measured_tp:.1f} dBTP (한계 {spec['targetTP']})")

        results.append({
            "platform":     spec["platform"],
            "targetLUFS":   spec["targetLUFS"],
            "targetTP":     spec["targetTP"],
            "measuredLUFS": measured_lufs,
            "measuredTP":   measured_tp,
            "passed":       len(issues) == 0,
            "issues":       issues,
        })

    return results


# ─────────────────────────────────────────────────────
# 헬퍼
# ─────────────────────────────────────────────────────

def _item(name: str, status: str, message: str, value: Any = None) -> Dict:
    """QC 항목 딕셔너리 생성"""
    return {
        "name":    name,
        "status":  status,   # pass | warning | fail
        "message": message,
        "value":   value,
    }
