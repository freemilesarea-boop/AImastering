"""
Waveform 이미지 생성 모듈 (v3.1)

ffmpeg `showwavespic` 필터를 사용해 PNG 를 생성한다.
matplotlib 의존성을 추가하지 않고 ffmpeg 만으로 처리해 패키징 부담 최소화.

설계 원칙:
  · 실패 시 WaveformGenerationError 발생. 호출 측에서 try/except 로 감싸서
    waveform 실패가 전체 마스터링 실패로 이어지지 않게 처리.
  · Windows / macOS 양쪽에서 path 안전 (ffmpeg 인자에 raw 경로 그대로 전달).
"""
import os
from typing import Optional
from ..utils.ffmpeg_wrapper import run_command
from ..utils.logger import get_logger

logger = get_logger(__name__)


class WaveformGenerationError(RuntimeError):
    """waveform 이미지 생성 중 발생한 오류"""


def generate_waveform_png(
    input_audio: str,
    image_path: str,
    width: int = 1600,
    height: int = 280,
    color: str = "#a78bfa",
    background: str = "#0f172a",
    ffmpeg_path: str = "ffmpeg",
) -> str:
    """
    단일 트랙 waveform PNG 생성.

    showwavespic 의 colors 인자에 16진 색상을 직접 전달.
    배경은 별도 검정 RGBA 로 합성하기 어려우므로 ffmpeg 의 split + drawbox 로 합성.
    """
    if not os.path.exists(input_audio):
        raise WaveformGenerationError(f"입력 파일 없음: {input_audio}")

    os.makedirs(os.path.dirname(os.path.abspath(image_path)), exist_ok=True)

    # ffmpeg 색상 표기는 # 가 필요 없음. 0xRRGGBB 형식 또는 이름 형식 모두 가능.
    color_arg = color.lstrip("#")
    bg_arg    = background.lstrip("#")

    # 배경색을 입히기 위해 -filter_complex 로 검정 배경 + waveform 오버레이
    filter_complex = (
        f"[0:a]aformat=channel_layouts=mono,"
        f"showwavespic=s={width}x{height}:colors=0x{color_arg}[wave];"
        f"color=c=0x{bg_arg}:s={width}x{height}[bg];"
        f"[bg][wave]overlay=format=auto,format=rgba"
    )

    cmd = [
        ffmpeg_path,
        "-nostdin", "-y",
        "-i", input_audio,
        "-filter_complex", filter_complex,
        "-frames:v", "1",
        image_path,
    ]
    code, _stdout, stderr = run_command(cmd, timeout=60)
    if code != 0 or not os.path.exists(image_path):
        raise WaveformGenerationError(
            f"showwavespic 실패 (code={code}): {stderr[-300:]}"
        )
    logger.debug(f"waveform PNG 생성: {image_path}")
    return image_path


def generate_waveform_dual_png(
    input_path: str,
    output_path_audio: str,
    image_path: str,
    width: int = 1600,
    height: int = 280,
    before_color: str = "#9ca3af",
    after_color:  str = "#a78bfa",
    background: str = "#0f172a",
    ffmpeg_path: str = "ffmpeg",
) -> str:
    """
    Before / After waveform 을 위/아래로 stack 한 단일 PNG 생성.
    같은 너비 기준으로 시각적 비교가 가능하도록 동일 길이 정렬.
    """
    for p in (input_path, output_path_audio):
        if not os.path.exists(p):
            raise WaveformGenerationError(f"입력 파일 없음: {p}")
    os.makedirs(os.path.dirname(os.path.abspath(image_path)), exist_ok=True)

    half = max(80, height // 2)
    before_arg = before_color.lstrip("#")
    after_arg  = after_color.lstrip("#")
    bg_arg     = background.lstrip("#")

    # 두 파일을 입력으로 받아 각각 waveform 만들고 vstack 으로 합침
    filter_complex = (
        f"[0:a]aformat=channel_layouts=mono,"
        f"showwavespic=s={width}x{half}:colors=0x{before_arg}[wbefore];"
        f"[1:a]aformat=channel_layouts=mono,"
        f"showwavespic=s={width}x{half}:colors=0x{after_arg}[wafter];"
        f"color=c=0x{bg_arg}:s={width}x{height}[bg];"
        f"[wbefore][wafter]vstack=inputs=2[stacked];"
        f"[bg][stacked]overlay=format=auto,format=rgba"
    )
    cmd = [
        ffmpeg_path,
        "-nostdin", "-y",
        "-i", input_path,
        "-i", output_path_audio,
        "-filter_complex", filter_complex,
        "-frames:v", "1",
        image_path,
    ]
    code, _stdout, stderr = run_command(cmd, timeout=90)
    if code != 0 or not os.path.exists(image_path):
        raise WaveformGenerationError(
            f"dual waveform 실패 (code={code}): {stderr[-300:]}"
        )
    logger.debug(f"dual waveform PNG 생성: {image_path}")
    return image_path


def detect_amplitude_drop(
    file_path: str,
    threshold_db: float = 6.0,
    ffmpeg_path: str = "ffmpeg",
) -> Optional[float]:
    """
    waveform 기반 amplitude drop 감지.

    1초 윈도우 RMS 의 P95 - P5 를 측정해 drop 정도를 dB 로 반환.
    이 함수는 quality_check 에서 호출되며, 실패 시 None.
    """
    try:
        import numpy as np
        from ..utils.audio_io import load_audio, HAS_SOUNDFILE
        if not HAS_SOUNDFILE:
            return None
        audio, sr = load_audio(file_path)
        mono = np.mean(audio, axis=0) if audio.ndim == 2 else audio
        win = int(sr * 1.0)
        if len(mono) < win * 3:
            return None
        n = len(mono) // win
        rms = []
        for i in range(n):
            seg = mono[i * win:(i + 1) * win]
            r = float(np.sqrt(np.mean(seg ** 2)))
            if r > 0:
                rms.append(20 * np.log10(r))
        if len(rms) < 5:
            return None
        arr = np.array(rms)
        spread = float(np.percentile(arr, 95) - np.percentile(arr, 5))
        return round(spread, 2)
    except Exception as exc:
        logger.warning(f"amplitude drop 감지 실패: {exc}")
        return None
