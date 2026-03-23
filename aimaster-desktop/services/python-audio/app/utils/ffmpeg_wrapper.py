import json
import re
import subprocess
from typing import Any


def ffprobe_info(file_path: str) -> dict[str, Any]:
    cmd = [
        "ffprobe", "-v", "quiet", "-print_format", "json",
        "-show_streams", "-show_format", file_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


def loudnorm_pass1(file_path: str, target_lufs: float = -14.0, target_tp: float = -1.0) -> dict[str, str]:
    filter_str = f"loudnorm=I={target_lufs}:TP={target_tp}:LRA=11:print_format=json"
    cmd = ["ffmpeg", "-i", file_path, "-af", filter_str, "-f", "null", "-"]
    result = subprocess.run(cmd, capture_output=True, text=True)
    stderr = result.stderr

    # Extract JSON block from stderr
    match = re.search(r"\{[^{}]+\}", stderr, re.DOTALL)
    if not match:
        raise RuntimeError("loudnorm pass1: could not parse JSON from ffmpeg stderr")
    return json.loads(match.group())


def loudnorm_pass2(
    input_path: str,
    output_path: str,
    pass1: dict[str, str],
    target_lufs: float = -14.0,
    target_tp: float = -1.0,
    sample_rate: int = 44100,
    bit_depth: int = 24,
    extra_filters: str = "",
) -> None:
    loudnorm = (
        f"loudnorm=I={target_lufs}:TP={target_tp}:LRA=11:linear=true"
        f":measured_I={pass1['input_i']}"
        f":measured_LRA={pass1['input_lra']}"
        f":measured_TP={pass1['input_tp']}"
        f":measured_thresh={pass1['input_thresh']}"
        f":offset={pass1['target_offset']}"
        f":print_format=none"
    )
    af = f"{extra_filters},{loudnorm}" if extra_filters else loudnorm
    codec = "pcm_s16le" if bit_depth == 16 else "pcm_s24le"
    cmd = [
        "ffmpeg", "-y", "-i", input_path,
        "-af", af,
        "-ar", str(sample_rate),
        "-acodec", codec,
        output_path,
    ]
    subprocess.run(cmd, check=True, capture_output=True)
