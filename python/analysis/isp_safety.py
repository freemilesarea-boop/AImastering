"""
ISP (Inter-Sample Peak) safety post-processor (v3.2)

ffmpeg alimiter 는 oversampling 미지원이라 inter-sample peak 가 ceiling 을 넘는
경우가 있다 (특히 sibilance / 빠른 transient). 이 모듈은:

  1. 마스터 출력을 numpy 로 읽고
  2. FFT 기반 4x sinc oversampling 으로 진짜 inter-sample peak 측정
  3. ceiling 초과 시 정적 down-gain 을 적용해 재저장

특징:
  · envelope 없음 (전체 파일에 동일한 게인) → 출렁임 / 펌핑 0
  · numpy + soundfile 만 사용 (scipy 의존성 추가 없음)
  · 실패 시 None 반환, 호출 측에서 try/except 로 묶어 무시 가능
  · 청크 단위 처리로 메모리 사용 안정

사용:
    apply_isp_safety(file_path, ceiling_db=-1.0, headroom_db=0.1)
"""
from typing import Optional
import numpy as np
import soundfile as sf
from ..utils.logger import get_logger

logger = get_logger(__name__)

ISP_OVERSAMPLE = 4  # ITU BS.1770-4 권고는 ≥ 4x


def measure_inter_sample_peak_db(
    audio: np.ndarray,
    chunk_seconds: float = 1.0,
    sample_rate: int = 44100,
    oversample: int = ISP_OVERSAMPLE,
) -> float:
    """
    FFT 기반 4x sinc oversampling 으로 inter-sample peak 측정 (dBFS).

    audio: (channels, samples) 또는 (samples,)
    """
    if audio.ndim == 1:
        chans = [audio]
    else:
        chans = [audio[i] for i in range(audio.shape[0])]

    chunk_n = max(1024, int(sample_rate * chunk_seconds))
    overall_peak = 0.0

    for ch in chans:
        n = len(ch)
        if n == 0:
            continue
        # 파일이 짧으면 한 번에 처리. 길면 청크 단위.
        if n <= chunk_n * 2:
            up = _fft_upsample(ch, oversample)
            overall_peak = max(overall_peak, float(np.max(np.abs(up))))
        else:
            # 50% overlap 으로 인접 경계의 ISP 도 잡음
            step = chunk_n // 2
            for start in range(0, n, step):
                end = min(start + chunk_n, n)
                seg = ch[start:end]
                if len(seg) < 16:
                    continue
                up = _fft_upsample(seg, oversample)
                p = float(np.max(np.abs(up)))
                if p > overall_peak:
                    overall_peak = p

    if overall_peak <= 0:
        return -120.0
    return 20 * np.log10(overall_peak)


def _fft_upsample(x: np.ndarray, factor: int) -> np.ndarray:
    """rfft 기반 zero-pad sinc upsample. factor=4 → 4x 샘플."""
    n = len(x)
    if n < 8:
        return x
    spec = np.fft.rfft(x)
    new_n = n * factor
    new_spec = np.zeros(new_n // 2 + 1, dtype=complex)
    new_spec[:len(spec)] = spec
    return np.fft.irfft(new_spec, n=new_n) * factor


def apply_isp_safety(
    file_path: str,
    ceiling_db: float = -1.0,
    headroom_db: float = 0.1,
) -> Optional[float]:
    """
    파일을 읽어 inter-sample peak 측정. ceiling - headroom 보다 크면
    정적 down-gain 으로 재저장.

    Returns:
        applied_gain_db (음수 또는 0). 안전 한도 내였으면 0.
        실패 시 None.
    """
    try:
        data, sr = sf.read(file_path, always_2d=True, dtype="float64")
    except Exception as exc:
        logger.warning(f"ISP safety: read 실패 {file_path}: {exc}")
        return None

    if data.size == 0:
        return 0.0

    # soundfile: (samples, channels) → (channels, samples)
    audio = data.T

    isp_db = measure_inter_sample_peak_db(audio, sample_rate=sr)
    safe_ceiling = ceiling_db - headroom_db

    if isp_db <= safe_ceiling + 0.01:
        logger.debug(f"ISP safety: ISP={isp_db:+.2f} dBTP <= {safe_ceiling:+.2f} (no action)")
        return 0.0

    gain_db = safe_ceiling - isp_db
    gain_lin = 10 ** (gain_db / 20)
    logger.info(
        f"ISP safety: ISP={isp_db:+.2f} dBTP > {safe_ceiling:+.2f} → "
        f"applying {gain_db:+.2f} dB"
    )

    data = data * gain_lin

    # subtype 보존
    info = sf.info(file_path)
    try:
        sf.write(file_path, data, sr, subtype=info.subtype, format=info.format)
    except Exception as exc:
        logger.warning(f"ISP safety: write 실패: {exc}")
        return None

    return round(float(gain_db), 3)
