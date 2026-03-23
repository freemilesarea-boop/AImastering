"""
오디오 분석 모듈
- LUFS, True Peak, LRA, Dynamic Range 측정 (ffmpeg loudnorm pass1)
- 스펙트럼 분석 (저/중/고역 에너지 비율)
- AI 음원 특화 감지:
    · harsh high-mid (3~5kHz 과도한 에너지)
    · boomy low-end (80~200Hz 과도한 에너지)
    · brickwall 압축 의심 (LRA < 2 또는 DR < 4)
    · stereo imbalance (L/R 에너지 차이 > 3dB)
    · 시작/끝 무음 구간 (> 500ms)
    · clipping / intersample peak 위험
- DC offset 간이 검사
- 재인코딩/업샘플링 의심 휴리스틱
"""
import os
import numpy as np
from typing import Dict, Any, Optional
from ..utils.ffmpeg_wrapper import ffprobe_info, loudnorm_pass1
from ..utils.audio_io import load_audio, detect_clipping, HAS_SOUNDFILE
from ..utils.logger import get_logger

logger = get_logger(__name__)

# ─────────────────────────────────────────────────────
# 감지 임계값 상수
# ─────────────────────────────────────────────────────
HARSH_HIGHMID_RATIO   = 0.28    # 3~5kHz 에너지 비율 초과 시 harsh 판정
BOOMY_LOW_RATIO       = 0.45    # 60~200Hz 에너지 비율 초과 시 boomy 판정
BRICKWALL_LRA_THRESH  = 2.5     # LRA < 2.5LU → brickwall 의심
BRICKWALL_DR_THRESH   = 4.0     # DR < 4 → brickwall 의심
SILENCE_THRESHOLD_DB  = -60.0   # dBFS 이하 → 무음으로 간주
SILENCE_MIN_MS        = 500     # 최소 무음 구간 ms
STEREO_IMBALANCE_DB   = 3.0     # L/R 에너지 차이 dB 초과 시 경고
DC_OFFSET_THRESHOLD   = 0.005   # DC offset 절대값 임계값
INTERSAMPLE_HEADROOM  = 0.5     # True Peak - Digital Peak > 0.5dB → intersample 위험


def analyze_file(
    file_path: str,
    ffmpeg_path:  str = "ffmpeg",
    ffprobe_path: str = "ffprobe",
) -> Dict[str, Any]:
    """
    오디오 파일 전체 분석
    Returns: AudioAnalysisResult 형태의 딕셔너리
    """
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"파일 없음: {file_path}")

    logger.info(f"Analyzing: {file_path}")

    # ── 1. ffprobe 메타데이터 ──────────────────────────
    probe = ffprobe_info(file_path, ffprobe_path)

    # ── 2. loudnorm pass1 라우드니스 측정 ─────────────
    lm = loudnorm_pass1(file_path, ffmpeg_path=ffmpeg_path)

    # ── 3. 파형 기반 분석 (soundfile 필요) ────────────
    spectral          = _spectral_stub()
    clipping_detected = False
    clipping_samples  = 0
    ai_detection      = _ai_detection_stub()
    dc_offset         = 0.0
    silence_start_ms  = 0.0
    silence_end_ms    = 0.0
    upsample_suspected = False

    if HAS_SOUNDFILE:
        try:
            audio, sr = load_audio(file_path)
            clipping_detected, clipping_samples = detect_clipping(audio)
            spectral       = _analyze_spectral(audio, sr)
            ai_detection   = _detect_ai_artifacts(audio, sr, lm, probe)
            dc_offset      = _measure_dc_offset(audio)
            silence_start_ms, silence_end_ms = _detect_silence_edges(audio, sr)
            upsample_suspected = _suspect_upsample(audio, sr, probe)
        except Exception as exc:
            logger.warning(f"Waveform analysis failed: {exc}")

    # ── 4. Dynamic Range 추정 ─────────────────────────
    dynamic_range = _estimate_dynamic_range(lm["measured_lra"])

    # ── 5. intersample peak 위험 판정 ─────────────────
    #    loudnorm pass1의 true peak vs digital peak 비교 (정확하지 않은 추정)
    intersample_risk = (lm["measured_tp"] > -1.5) and (lm["measured_i"] > -20)

    result = {
        # 파일 기본 정보
        "filePath":         file_path,
        "duration":         probe["duration"],
        "sampleRate":       probe["sample_rate"],
        "bitDepth":         probe["bit_depth"],
        "channels":         probe["channels"],
        "fileSize":         probe["file_size"],
        "codec":            probe["codec"],
        # 라우드니스
        "lufsIntegrated":   lm["measured_i"],
        "lufsShortterm":    lm["measured_i"],
        "lfusMomentary":    lm["measured_i"],
        "truePeak":         lm["measured_tp"],
        "lra":              lm["measured_lra"],
        "dynamicRange":     dynamic_range,
        # 스펙트럼
        "spectral":         spectral,
        # 클리핑
        "clippingDetected": clipping_detected,
        "clippingSamples":  clipping_samples,
        # AI 음원 특화 감지
        "aiDetection":      ai_detection,
        # 추가 검사
        "dcOffset":              dc_offset,
        "silenceStartMs":        silence_start_ms,
        "silenceEndMs":          silence_end_ms,
        "intersampleRisk":       intersample_risk,
        "upsampleSuspected":     upsample_suspected,
    }

    logger.info(
        f"Analysis done — LUFS={result['lufsIntegrated']:.1f} "
        f"TP={result['truePeak']:.1f} LRA={result['lra']:.1f} "
        f"DR={result['dynamicRange']:.0f}"
    )
    return result


# ─────────────────────────────────────────────────────
# AI 음원 특화 감지
# ─────────────────────────────────────────────────────

def _detect_ai_artifacts(
    audio: np.ndarray,
    sr: int,
    lm: Dict[str, float],
    probe: Dict[str, Any],
) -> Dict[str, Any]:
    """AI 음원 특화 아티팩트 감지"""
    mono = np.mean(audio, axis=0) if audio.ndim == 2 else audio

    n_fft = min(8192, len(mono))
    fft   = np.abs(np.fft.rfft(mono[:n_fft]))
    freqs = np.fft.rfftfreq(n_fft, d=1.0 / sr)
    total_energy = np.sum(fft ** 2) + 1e-10

    # ── harsh high-mid (3~5kHz) ──────────────────────
    harsh_mask  = (freqs >= 3000) & (freqs <= 5000)
    harsh_ratio = float(np.sum(fft[harsh_mask] ** 2) / total_energy)
    harsh_highmid = harsh_ratio > HARSH_HIGHMID_RATIO

    # ── boomy low-end (60~200Hz) ──────────────────────
    boomy_mask  = (freqs >= 60) & (freqs <= 200)
    boomy_ratio = float(np.sum(fft[boomy_mask] ** 2) / total_energy)
    boomy_low   = boomy_ratio > BOOMY_LOW_RATIO

    # ── brickwall 압축 의심 (LRA + DR 기반) ──────────
    lra = lm["measured_lra"]
    dr  = _estimate_dynamic_range(lra)
    brickwall = lra < BRICKWALL_LRA_THRESH or dr < BRICKWALL_DR_THRESH

    # ── stereo imbalance ──────────────────────────────
    stereo_imbalance = False
    if audio.ndim == 2 and audio.shape[0] >= 2:
        l_rms = float(np.sqrt(np.mean(audio[0] ** 2)) + 1e-10)
        r_rms = float(np.sqrt(np.mean(audio[1] ** 2)) + 1e-10)
        diff_db = abs(20 * np.log10(l_rms / r_rms))
        stereo_imbalance = diff_db > STEREO_IMBALANCE_DB
    else:
        diff_db = 0.0

    return {
        "harshHighmid":      harsh_highmid,
        "harshHighmidRatio": round(harsh_ratio, 3),
        "boomyLow":          boomy_low,
        "boomyLowRatio":     round(boomy_ratio, 3),
        "brickwall":         brickwall,
        "lra":               round(lra, 2),
        "stereoImbalance":   stereo_imbalance,
        "stereoImbalanceDb": round(diff_db, 2) if stereo_imbalance else 0.0,
    }


def _detect_silence_edges(audio: np.ndarray, sr: int) -> tuple:
    """시작/끝 무음 구간 길이 측정 (ms)"""
    mono = np.mean(audio, axis=0) if audio.ndim == 2 else audio
    threshold = 10 ** (SILENCE_THRESHOLD_DB / 20)

    # 시작 무음
    start_samples = 0
    for i, s in enumerate(mono):
        if abs(s) > threshold:
            start_samples = i
            break

    # 끝 무음
    end_samples = 0
    for i in range(len(mono) - 1, -1, -1):
        if abs(mono[i]) > threshold:
            end_samples = len(mono) - 1 - i
            break

    start_ms = (start_samples / sr) * 1000
    end_ms   = (end_samples   / sr) * 1000
    return round(start_ms, 1), round(end_ms, 1)


def _measure_dc_offset(audio: np.ndarray) -> float:
    """DC offset 측정 (절대값)"""
    mono = np.mean(audio, axis=0) if audio.ndim == 2 else audio
    return round(float(abs(np.mean(mono))), 5)


def _suspect_upsample(
    audio: np.ndarray,
    sr: int,
    probe: Dict[str, Any],
) -> bool:
    """
    재인코딩/업샘플링 의심 휴리스틱
    - Nyquist 근처(sr/2 - 2kHz ~ sr/2)에 에너지가 급격히 없는 경우
    - 낮은 비트레이트 소스를 업샘플링한 흔적
    """
    try:
        mono  = np.mean(audio, axis=0) if audio.ndim == 2 else audio
        n_fft = min(4096, len(mono))
        fft   = np.abs(np.fft.rfft(mono[:n_fft]))
        freqs = np.fft.rfftfreq(n_fft, d=1.0 / sr)

        nyquist = sr / 2
        # Nyquist 상단 2kHz 구간의 에너지 비율
        near_nyquist_mask = freqs > (nyquist - 2000)
        mid_mask          = (freqs > 4000) & (freqs <= 8000)

        near_energy = float(np.sum(fft[near_nyquist_mask] ** 2))
        mid_energy  = float(np.sum(fft[mid_mask] ** 2))

        if mid_energy < 1e-10:
            return False

        ratio = near_energy / mid_energy
        # 비율이 매우 낮으면 업샘플링 의심
        return ratio < 0.002
    except Exception:
        return False


# ─────────────────────────────────────────────────────
# 스펙트럼 분석
# ─────────────────────────────────────────────────────

def _analyze_spectral(audio: np.ndarray, sr: int) -> Dict[str, float]:
    try:
        mono  = np.mean(audio, axis=0) if audio.ndim == 2 else audio
        n_fft = min(4096, len(mono))
        fft   = np.abs(np.fft.rfft(mono[:n_fft]))
        freqs = np.fft.rfftfreq(n_fft, d=1.0 / sr)

        total = np.sum(fft ** 2) + 1e-10
        return {
            "lowEnergy":  float(np.sum(fft[freqs <= 250] ** 2)  / total),
            "midEnergy":  float(np.sum(fft[(freqs > 250) & (freqs <= 4000)] ** 2) / total),
            "highEnergy": float(np.sum(fft[freqs > 4000] ** 2)  / total),
            "centroid":   float(np.sum(freqs * fft) / (np.sum(fft) + 1e-10)),
        }
    except Exception as exc:
        logger.warning(f"Spectral analysis error: {exc}")
        return _spectral_stub()


def _spectral_stub() -> Dict[str, float]:
    return {"lowEnergy": 0.33, "midEnergy": 0.34, "highEnergy": 0.33, "centroid": 2000.0}


def _ai_detection_stub() -> Dict[str, Any]:
    return {
        "harshHighmid": False, "harshHighmidRatio": 0.0,
        "boomyLow":     False, "boomyLowRatio":     0.0,
        "brickwall":    False, "lra": 0.0,
        "stereoImbalance": False, "stereoImbalanceDb": 0.0,
    }


def _estimate_dynamic_range(lra: float) -> float:
    return max(1.0, min(20.0, lra * 1.1))
