"""
오디오 파일 I/O 유틸리티
numpy/soundfile 기반 오디오 로드/저장
"""
import os
import numpy as np
from typing import Tuple
from .logger import get_logger

logger = get_logger(__name__)

try:
    import soundfile as sf
    HAS_SOUNDFILE = True
except ImportError:
    HAS_SOUNDFILE = False
    logger.warning("soundfile not available — some features may be limited")


def load_audio(file_path: str, target_sr: int = None) -> Tuple[np.ndarray, int]:
    """
    오디오 파일 로드
    Returns: (audio_data: ndarray[channels, samples], sample_rate)
    """
    if not HAS_SOUNDFILE:
        raise ImportError("soundfile 라이브러리가 필요합니다: pip install soundfile")

    data, sr = sf.read(file_path, always_2d=True, dtype='float32')
    # soundfile: (samples, channels) → transpose to (channels, samples)
    audio = data.T

    logger.debug(f"Loaded: {file_path} | sr={sr} | shape={audio.shape}")
    return audio, sr


def save_audio(audio: np.ndarray, file_path: str, sample_rate: int, bit_depth: int = 24) -> None:
    """
    오디오 파일 저장
    audio: (channels, samples) 또는 (samples,)
    """
    if not HAS_SOUNDFILE:
        raise ImportError("soundfile 라이브러리가 필요합니다")

    fmt_map = {16: 'PCM_16', 24: 'PCM_24', 32: 'PCM_32'}
    subtype = fmt_map.get(bit_depth, 'PCM_24')

    # (channels, samples) → (samples, channels)
    if audio.ndim == 2:
        out = audio.T
    else:
        out = audio

    ext = os.path.splitext(file_path)[1].lower()
    fmt = 'WAV' if ext == '.wav' else 'FLAC' if ext == '.flac' else 'WAV'
    if ext == '.flac':
        subtype = 'PCM_24'  # FLAC은 24-bit 고정

    sf.write(file_path, out, sample_rate, subtype=subtype, format=fmt)
    logger.debug(f"Saved: {file_path} | sr={sample_rate} | {subtype}")


def peak_normalize(audio: np.ndarray, target_db: float = -0.1) -> np.ndarray:
    """피크 정규화"""
    peak = np.max(np.abs(audio))
    if peak <= 0:
        return audio
    target_linear = 10 ** (target_db / 20)
    return audio * (target_linear / peak)


def detect_clipping(audio: np.ndarray, threshold: float = 0.9999) -> Tuple[bool, int]:
    """클리핑 감지. Returns: (is_clipping, num_clipping_samples)"""
    clipping_samples = int(np.sum(np.abs(audio) >= threshold))
    return clipping_samples > 0, clipping_samples


def remove_dc_offset(audio: np.ndarray) -> np.ndarray:
    """DC 오프셋 제거"""
    return audio - np.mean(audio, axis=-1, keepdims=True)
