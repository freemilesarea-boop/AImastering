"""
오디오 분석 모듈
- LUFS, True Peak, LRA, Dynamic Range 측정
- 스펙트럼 분석 (저/중/고역 에너지 비율)
- 클리핑 감지
"""
import os
import json
import numpy as np
from typing import Dict, Any, Optional
from ..utils.ffmpeg_wrapper import ffprobe_info, loudnorm_pass1
from ..utils.audio_io import load_audio, detect_clipping, HAS_SOUNDFILE
from ..utils.logger import get_logger

logger = get_logger(__name__)


def analyze_file(
    file_path: str,
    ffmpeg_path: str = 'ffmpeg',
    ffprobe_path: str = 'ffprobe',
) -> Dict[str, Any]:
    """
    오디오 파일 전체 분석
    Returns: AudioAnalysisResult 형태의 딕셔너리
    """
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"파일 없음: {file_path}")

    logger.info(f"Analyzing: {file_path}")

    # 1. ffprobe로 파일 메타데이터 추출
    probe = ffprobe_info(file_path, ffprobe_path)

    # 2. loudnorm pass1으로 LUFS/LRA/TP 측정
    lm = loudnorm_pass1(file_path, ffmpeg_path=ffmpeg_path)

    # 3. 스펙트럼 분석 + 클리핑 감지 (soundfile 필요)
    spectral = _analyze_spectral_stub()
    clipping_detected, clipping_samples = False, 0

    if HAS_SOUNDFILE:
        try:
            audio, sr = load_audio(file_path)
            clipping_detected, clipping_samples = detect_clipping(audio)
            spectral = _analyze_spectral(audio, sr)
        except Exception as e:
            logger.warning(f"Spectral analysis failed: {e}")

    # 4. Dynamic Range 추정 (LRA 기반)
    dynamic_range = _estimate_dynamic_range(lm['measured_lra'])

    result = {
        'filePath':          file_path,
        'duration':          probe['duration'],
        'sampleRate':        probe['sample_rate'],
        'bitDepth':          probe['bit_depth'],
        'channels':          probe['channels'],
        'fileSize':          probe['file_size'],
        'lufsIntegrated':    lm['measured_i'],
        'lufsShortterm':     lm['measured_i'],      # pass1에서는 short-term 별도 측정 불가
        'lfusMomentary':     lm['measured_i'],
        'truePeak':          lm['measured_tp'],
        'lra':               lm['measured_lra'],
        'dynamicRange':      dynamic_range,
        'spectral':          spectral,
        'clippingDetected':  clipping_detected,
        'clippingSamples':   clipping_samples,
    }

    logger.info(
        f"Analysis done: LUFS={result['lufsIntegrated']:.1f} "
        f"TP={result['truePeak']:.1f} LRA={result['lra']:.1f}"
    )
    return result


def _analyze_spectral(audio: np.ndarray, sample_rate: int) -> Dict[str, float]:
    """스펙트럼 분석: 저/중/고역 에너지 비율"""
    try:
        # 스테레오 → 모노 합산
        mono = np.mean(audio, axis=0) if audio.ndim == 2 else audio

        # FFT
        n_fft = min(4096, len(mono))
        fft = np.abs(np.fft.rfft(mono[:n_fft]))
        freqs = np.fft.rfftfreq(n_fft, d=1.0 / sample_rate)

        # 대역별 에너지
        low_mask  = freqs <= 250
        mid_mask  = (freqs > 250)  & (freqs <= 4000)
        high_mask = freqs > 4000

        total = np.sum(fft ** 2) + 1e-10
        low_energy  = float(np.sum(fft[low_mask]  ** 2) / total)
        mid_energy  = float(np.sum(fft[mid_mask]  ** 2) / total)
        high_energy = float(np.sum(fft[high_mask] ** 2) / total)

        # 스펙트럼 무게 중심
        centroid = float(np.sum(freqs * fft) / (np.sum(fft) + 1e-10))

        return {
            'lowEnergy':  low_energy,
            'midEnergy':  mid_energy,
            'highEnergy': high_energy,
            'centroid':   centroid,
        }
    except Exception as e:
        logger.warning(f"Spectral analysis error: {e}")
        return _analyze_spectral_stub()


def _analyze_spectral_stub() -> Dict[str, float]:
    """스펙트럼 분석 폴백 (soundfile 없을 때)"""
    return {'lowEnergy': 0.33, 'midEnergy': 0.34, 'highEnergy': 0.33, 'centroid': 2000.0}


def _estimate_dynamic_range(lra: float) -> float:
    """
    LRA를 DR 값으로 근사 변환
    LRA 11 ≈ DR12, 정확한 DR 측정은 별도 알고리즘 필요
    """
    return max(6.0, min(20.0, lra * 1.1))
