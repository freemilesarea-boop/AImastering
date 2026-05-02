"""
Waveform 이미지 생성 (v3.2 P2).

ffmpeg 의 showwavespic 필터 만으로 PNG 를 생성한다 — matplotlib 의존성을
추가하지 않아 PyInstaller 패키징 부담 없음.

설계 원칙:
  · 실패는 WaveformImageError 로 격리.  pipeline.py 가 try/except 로 감싸서
    waveform 생성 실패가 마스터링 자체 실패로 번지지 않게 한다.
  · 색상 인자에 "#" 가 들어와도 ffmpeg 표기로 변환 (0xRRGGBB).
  · before/after dual stack PNG 는 두 입력의 길이가 달라도 생성 가능하지만,
    UI 의 "비교" 의미를 살리려면 길이 차이가 0.5s 이상이면 경고만 노출.

stdout 에 sample-peak 시각화: showwavespic 의 default 모드는 평균 레벨 기반
이라 limiter 후 같은 신호도 살짝 부풀어 보일 수 있으므로 split_channels=0,
draw=full, scale=lin 을 명시해 일관된 기준으로 그린다.
"""
from __future__ import annotations

import os

from app.utils.ffmpeg_wrapper import _FFMPEG_BIN, _run, FFmpegError
from app.utils.logger import log


class WaveformImageError(RuntimeError):
    """waveform 이미지 생성 중 발생한 오류."""


def _hex_to_ffmpeg(color: str) -> str:
    return color.lstrip("#")


def generate_waveform_png(
    input_audio: str,
    image_path: str,
    *,
    width: int = 1600,
    height: int = 280,
    color: str = "#a78bfa",
    background: str = "#0f172a",
) -> str:
    """단일 트랙 waveform PNG 생성.  반환: image_path."""
    if not os.path.exists(input_audio):
        raise WaveformImageError(f"입력 파일 없음: {input_audio}")

    out_dir = os.path.dirname(os.path.abspath(image_path)) or "."
    os.makedirs(out_dir, exist_ok=True)

    color_arg = _hex_to_ffmpeg(color)
    bg_arg    = _hex_to_ffmpeg(background)

    filter_complex = (
        f"[0:a]aformat=channel_layouts=mono,"
        f"showwavespic=s={width}x{height}:colors=0x{color_arg}"
        f":draw=full:scale=lin[wave];"
        f"color=c=0x{bg_arg}:s={width}x{height}[bg];"
        f"[bg][wave]overlay=format=auto,format=rgba"
    )
    try:
        _run([
            _FFMPEG_BIN, "-hide_banner", "-nostdin", "-y",
            "-i", input_audio,
            "-filter_complex", filter_complex,
            "-frames:v", "1",
            image_path,
        ], timeout=60)
    except FFmpegError as exc:
        raise WaveformImageError(
            f"waveform PNG 생성 실패: {exc.user_msg}"
        ) from exc

    if not os.path.exists(image_path):
        raise WaveformImageError("waveform PNG 가 생성되지 않았습니다.")
    log("DEBUG", f"waveform PNG 생성: {image_path}")
    return image_path


def generate_waveform_dual_png(
    before_audio: str,
    after_audio: str,
    image_path: str,
    *,
    width: int = 1600,
    height: int = 320,
    before_color: str = "#9ca3af",
    after_color:  str = "#a78bfa",
    background:   str = "#0f172a",
) -> str:
    """Before/After 를 위/아래로 stack 한 비교 PNG 생성."""
    for p in (before_audio, after_audio):
        if not os.path.exists(p):
            raise WaveformImageError(f"입력 파일 없음: {p}")

    out_dir = os.path.dirname(os.path.abspath(image_path)) or "."
    os.makedirs(out_dir, exist_ok=True)

    half = max(80, height // 2)
    before_arg = _hex_to_ffmpeg(before_color)
    after_arg  = _hex_to_ffmpeg(after_color)
    bg_arg     = _hex_to_ffmpeg(background)

    filter_complex = (
        f"[0:a]aformat=channel_layouts=mono,"
        f"showwavespic=s={width}x{half}:colors=0x{before_arg}"
        f":draw=full:scale=lin[wbefore];"
        f"[1:a]aformat=channel_layouts=mono,"
        f"showwavespic=s={width}x{half}:colors=0x{after_arg}"
        f":draw=full:scale=lin[wafter];"
        f"color=c=0x{bg_arg}:s={width}x{height}[bg];"
        f"[wbefore][wafter]vstack=inputs=2[stacked];"
        f"[bg][stacked]overlay=format=auto,format=rgba"
    )

    try:
        _run([
            _FFMPEG_BIN, "-hide_banner", "-nostdin", "-y",
            "-i", before_audio,
            "-i", after_audio,
            "-filter_complex", filter_complex,
            "-frames:v", "1",
            image_path,
        ], timeout=90)
    except FFmpegError as exc:
        raise WaveformImageError(
            f"dual waveform PNG 생성 실패: {exc.user_msg}"
        ) from exc

    if not os.path.exists(image_path):
        raise WaveformImageError("dual waveform PNG 가 생성되지 않았습니다.")
    log("DEBUG", f"dual waveform PNG 생성: {image_path}")
    return image_path
