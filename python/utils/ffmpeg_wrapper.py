"""
FFmpeg/FFprobe 래퍼
loudnorm 2-pass, 포맷 변환, 메타데이터 추출
"""
import json
import subprocess
import shlex
from typing import Optional, Dict, Any
from .logger import get_logger

logger = get_logger(__name__)


def run_command(cmd: list[str], timeout: int = 120) -> tuple[int, str, str]:
    """셸 명령 실행, (returncode, stdout, stderr) 반환"""
    logger.debug(f"Running: {' '.join(cmd)}")
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout
        )
        return result.returncode, result.stdout, result.stderr
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"Command timed out after {timeout}s: {' '.join(cmd)}")
    except FileNotFoundError as e:
        raise RuntimeError(f"Command not found: {cmd[0]} — {e}")


def ffprobe_info(file_path: str, ffprobe_path: str = 'ffprobe') -> Dict[str, Any]:
    """
    ffprobe로 오디오 파일 메타데이터 추출
    Returns: duration, sample_rate, bit_depth, channels, etc.
    """
    cmd = [
        ffprobe_path,
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_streams',
        '-show_format',
        file_path
    ]
    code, stdout, stderr = run_command(cmd)
    if code != 0:
        raise RuntimeError(f"ffprobe failed: {stderr}")

    data = json.loads(stdout)

    # 오디오 스트림 찾기
    audio_stream = next(
        (s for s in data.get('streams', []) if s.get('codec_type') == 'audio'),
        None
    )
    if not audio_stream:
        raise ValueError("오디오 스트림을 찾을 수 없습니다.")

    fmt = data.get('format', {})

    return {
        'duration':     float(audio_stream.get('duration') or fmt.get('duration', 0)),
        'sample_rate':  int(audio_stream.get('sample_rate', 44100)),
        'channels':     int(audio_stream.get('channels', 2)),
        'bit_depth':    _parse_bit_depth(audio_stream.get('sample_fmt', '')),
        'codec':        audio_stream.get('codec_name', 'unknown'),
        'file_size':    int(fmt.get('size', 0)),
        'bit_rate':     int(fmt.get('bit_rate', 0)),
    }


def loudnorm_pass1(
    file_path: str,
    target_lufs: float = -14.0,
    target_lra: float = 11.0,
    target_tp: float = -1.0,
    ffmpeg_path: str = 'ffmpeg'
) -> Dict[str, float]:
    """
    loudnorm 1-pass: 현재 파일의 라우드니스 측정
    Returns: measured_i, measured_lra, measured_tp, measured_thresh, offset
    """
    filter_str = (
        f"loudnorm=I={target_lufs}:LRA={target_lra}:TP={target_tp}"
        ":print_format=json"
    )
    cmd = [
        ffmpeg_path,
        '-nostdin',
        '-i', file_path,
        '-af', filter_str,
        '-f', 'null',
        '-'
    ]
    code, stdout, stderr = run_command(cmd, timeout=180)

    # loudnorm JSON 출력은 stderr에 포함됨
    json_start = stderr.rfind('{')
    json_end   = stderr.rfind('}') + 1
    if json_start == -1:
        raise RuntimeError(f"loudnorm pass1 JSON not found in stderr.\nstderr: {stderr[-500:]}")

    measurements = json.loads(stderr[json_start:json_end])
    return {
        'measured_i':      float(measurements.get('input_i',      -99)),
        'measured_lra':    float(measurements.get('input_lra',     0)),
        'measured_tp':     float(measurements.get('input_tp',     -99)),
        'measured_thresh': float(measurements.get('input_thresh', -99)),
        'offset':          float(measurements.get('target_offset',  0)),
    }


def loudnorm_pass2(
    input_path: str,
    output_path: str,
    measurements: Dict[str, float],
    target_lufs: float = -14.0,
    target_lra: float = 11.0,
    target_tp: float = -1.0,
    output_format: str = 'wav',
    bit_depth: int = 24,
    sample_rate: int = 44100,
    ffmpeg_path: str = 'ffmpeg',
    extra_filters: Optional[str] = None,
    linear: bool = True,
) -> None:
    """
    loudnorm 2-pass: 실제 라우드니스 정규화 적용 및 출력

    linear=True  : 측정값 기반 정확한 1차 게인 적용 (기본).
                   타깃이 ≤ -12 LUFS 같은 일반 케이스에 적합.
    linear=False : dynamic 모드. 강한 압축으로 큰 LUFS 도약을 만들 때 사용
                   (예: -8 LUFS 같은 EDM/KPOP 라우드 타깃).
    """
    # 비트 뎁스 → 샘플 포맷 매핑
    pcm_codec = {16: 'pcm_s16le', 24: 'pcm_s24le', 32: 'pcm_s32le'}.get(bit_depth, 'pcm_s24le')

    linear_str = 'true' if linear else 'false'
    # loudnorm 필터 (측정값 주입)
    loudnorm_filter = (
        f"loudnorm=I={target_lufs}:LRA={target_lra}:TP={target_tp}"
        f":measured_I={measurements['measured_i']}"
        f":measured_LRA={measurements['measured_lra']}"
        f":measured_TP={measurements['measured_tp']}"
        f":measured_thresh={measurements['measured_thresh']}"
        f":offset={measurements['offset']}"
        f":linear={linear_str}:print_format=summary"
    )

    # 추가 필터 체인 (EQ, 컴프레서 등) 앞에 붙임
    af_chain = loudnorm_filter
    if extra_filters:
        af_chain = f"{extra_filters},{loudnorm_filter}"

    # 출력 코덱 설정
    if output_format == 'wav':
        codec_args = ['-c:a', pcm_codec]
    elif output_format == 'flac':
        codec_args = ['-c:a', 'flac']
    elif output_format == 'mp3':
        codec_args = ['-c:a', 'libmp3lame', '-b:a', '320k']
    else:
        codec_args = ['-c:a', pcm_codec]

    cmd = [
        ffmpeg_path,
        '-nostdin',
        '-y',                     # 덮어쓰기 허용
        '-i', input_path,
        '-af', af_chain,
        '-ar', str(sample_rate),
        *codec_args,
        output_path
    ]

    code, stdout, stderr = run_command(cmd, timeout=300)
    if code != 0:
        raise RuntimeError(f"loudnorm pass2 failed (code={code}):\n{stderr[-500:]}")

    logger.info(f"loudnorm pass2 complete: {output_path}")


def measure_true_peak(file_path: str, ffmpeg_path: str = 'ffmpeg') -> float:
    """True Peak 측정 (dBTP)"""
    cmd = [
        ffmpeg_path,
        '-nostdin',
        '-i', file_path,
        '-af', 'atrue_peak',
        '-f', 'null', '-'
    ]
    code, stdout, stderr = run_command(cmd)

    # "Max_TP: X.X dBTP" 파싱
    for line in stderr.split('\n'):
        if 'max_tp' in line.lower() or 'true peak' in line.lower():
            parts = line.split()
            for p in parts:
                try:
                    return float(p)
                except ValueError:
                    continue

    # 폴백: loudnorm pass1으로 측정
    measurements = loudnorm_pass1(file_path, ffmpeg_path=ffmpeg_path)
    return measurements['measured_tp']


def _parse_bit_depth(sample_fmt: str) -> int:
    """sample_fmt 문자열에서 비트 뎁스 파싱"""
    fmt_map = {
        's16': 16, 's16le': 16, 's16be': 16,
        's24': 24, 's24le': 24, 's24be': 24,
        's32': 32, 's32le': 32, 's32be': 32,
        'flt': 32, 'fltp': 32,
        'dbl': 64, 'dblp': 64,
    }
    return fmt_map.get(sample_fmt.lower(), 24)
