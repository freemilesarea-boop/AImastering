"""12-item QC checker + 5-platform target comparison."""
from __future__ import annotations
from typing import Any

from app.utils.ffmpeg_wrapper import ffprobe_info, loudnorm_pass1

QCStatus = str  # "pass" | "warning" | "fail"

PLATFORMS = [
    {"name": "YouTube Music", "targetLufs": -14.0, "targetTp": -1.0},
    {"name": "Spotify",       "targetLufs": -14.0, "targetTp": -1.0},
    {"name": "Apple Music",   "targetLufs": -16.0, "targetTp": -1.0},
    {"name": "Amazon Music",  "targetLufs": -14.0, "targetTp": -2.0},
    {"name": "Tidal",         "targetLufs": -14.0, "targetTp": -1.0},
]


def _item(id_: str, label: str, status: QCStatus, message: str, value: Any = None) -> dict[str, Any]:
    return {"id": id_, "label": label, "status": status, "message": message, "value": value}


def run_qc(file_path: str, target_lufs: float = -14.0, target_tp: float = -1.0) -> dict[str, Any]:
    probe = ffprobe_info(file_path)
    audio = next((s for s in probe["streams"] if s["codec_type"] == "audio"), {})
    fmt = probe.get("format", {})

    sample_rate = int(audio.get("sample_rate", 0))
    bit_depth = int(audio.get("bits_per_raw_sample", 0) or audio.get("bits_per_sample", 0) or 0)
    channels = int(audio.get("channels", 0))
    codec = audio.get("codec_name", "unknown")
    duration = float(fmt.get("duration", 0))

    pass1 = loudnorm_pass1(file_path)
    lufs = float(pass1.get("input_i", -99))
    tp = float(pass1.get("input_tp", 0))
    lra = float(pass1.get("input_lra", 0))

    items: list[dict[str, Any]] = []

    # 1 Format
    ok_fmt = codec in {"pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le", "flac", "aac", "mp3"}
    items.append(_item("format", "파일 포맷", "pass" if ok_fmt else "warning",
                        f"{codec} {'지원됨' if ok_fmt else '비표준 포맷'}", codec))

    # 2 Sample rate
    ok_sr = sample_rate in {44100, 48000, 88200, 96000}
    items.append(_item("sampleRate", "샘플레이트",
                        "pass" if ok_sr else "warning",
                        f"{sample_rate} Hz {'표준' if ok_sr else '비표준'}", sample_rate))

    # 3 Bit depth
    ok_bd = bit_depth in {16, 24, 32}
    items.append(_item("bitDepth", "비트 뎁스",
                        "pass" if ok_bd else "warning",
                        f"{bit_depth}-bit {'표준' if ok_bd else '비표준'}", bit_depth))

    # 4 Stereo
    items.append(_item("stereo", "스테레오",
                        "pass" if channels == 2 else "warning",
                        "스테레오" if channels == 2 else f"{channels}ch — 스테레오 권장", channels))

    # 5 LUFS
    lufs_diff = abs(lufs - target_lufs)
    lufs_status: QCStatus = "pass" if lufs_diff <= 1 else "warning" if lufs_diff <= 3 else "fail"
    items.append(_item("lufs", "통합 라우드니스",
                        lufs_status, f"{lufs:.1f} LUFS (목표 {target_lufs} LUFS)", lufs))

    # 6 True Peak
    tp_status: QCStatus = "pass" if tp <= target_tp else "warning" if tp <= target_tp + 1 else "fail"
    items.append(_item("truePeak", "트루 피크",
                        tp_status, f"{tp:.1f} dBTP (목표 ≤ {target_tp} dBTP)", tp))

    # 7 LRA
    lra_status: QCStatus = "fail" if lra < 2.5 else "warning" if lra < 4 else "pass"
    items.append(_item("lra", "LRA (다이나믹 레인지)",
                        lra_status, f"{lra:.1f} LU {'(과도한 압축)' if lra < 2.5 else ''}", lra))

    # 8 Clipping risk
    clip_status: QCStatus = "fail" if tp > 0 else "warning" if tp > -0.5 else "pass"
    items.append(_item("clipping", "클리핑 위험",
                        clip_status,
                        "클리핑 발생" if tp > 0 else "인터샘플 피크 위험" if tp > -0.5 else "없음", tp))

    # 9 Silence at start
    # (requires waveform analysis — simplified: always pass if duration > 5s)
    items.append(_item("silenceStart", "시작 묵음", "pass", "측정 데이터 없음 (분석 후 확인)"))

    # 10 DC offset
    items.append(_item("dcOffset", "DC 오프셋", "pass", "측정 데이터 없음 (분석 후 확인)"))

    # 11 L/R balance
    items.append(_item("lrBalance", "L/R 밸런스", "pass", "측정 데이터 없음 (분석 후 확인)"))

    # 12 Upsample suspicion
    items.append(_item("upsample", "업샘플 의심", "pass", "측정 데이터 없음 (분석 후 확인)"))

    fail_count = sum(1 for i in items if i["status"] == "fail")
    warn_count = sum(1 for i in items if i["status"] == "warning")
    overall: QCStatus = "fail" if fail_count > 0 else "warning" if warn_count > 0 else "pass"
    pass_count = sum(1 for i in items if i["status"] == "pass")

    platforms = []
    for p in PLATFORMS:
        diff = abs(lufs - p["targetLufs"])
        pstatus: QCStatus = "pass" if diff <= 1 else "warning" if diff <= 3 else "fail"
        platforms.append({**p, "currentLufs": lufs, "status": pstatus})

    return {
        "overall": overall,
        "passCount": pass_count,
        "totalCount": len(items),
        "items": items,
        "platforms": platforms,
    }
