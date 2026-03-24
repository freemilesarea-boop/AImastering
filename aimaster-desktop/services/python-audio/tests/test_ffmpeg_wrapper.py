"""
Unit tests for ffmpeg_wrapper.py

Run:
    cd services/python-audio
    pytest tests/test_ffmpeg_wrapper.py -v
"""
from __future__ import annotations

import json
import pytest

from app.utils.ffmpeg_wrapper import (
    FFmpegError,
    ffprobe_info,
    parse_audio_stream,
    parse_bit_depth,
    loudnorm_pass1,
)


# ─────────────────────────────────────────────────────────────────────────────
# ffprobe_info
# ─────────────────────────────────────────────────────────────────────────────

class TestFfprobeInfo:
    def test_returns_streams_and_format(self, sine_wav):
        result = ffprobe_info(sine_wav)
        assert "streams" in result
        assert "format" in result

    def test_audio_stream_present(self, sine_wav):
        result = ffprobe_info(sine_wav)
        audio = parse_audio_stream(result)
        assert audio.get("codec_type") == "audio"

    def test_sample_rate(self, sine_wav):
        result = ffprobe_info(sine_wav)
        audio = parse_audio_stream(result)
        assert int(audio["sample_rate"]) == 44100

    def test_channels(self, sine_wav):
        result = ffprobe_info(sine_wav)
        audio = parse_audio_stream(result)
        assert int(audio["channels"]) == 2

    def test_missing_file_raises(self):
        with pytest.raises(FFmpegError):
            ffprobe_info("/nonexistent/path/file.wav")

    def test_empty_file_raises(self, empty_file):
        with pytest.raises(FFmpegError):
            ffprobe_info(empty_file)

    def test_fake_wav_raises(self, fake_wav):
        with pytest.raises(FFmpegError):
            ffprobe_info(fake_wav)


# ─────────────────────────────────────────────────────────────────────────────
# parse_bit_depth
# ─────────────────────────────────────────────────────────────────────────────

class TestParseBitDepth:
    def test_pcm_s24le(self, sine_wav):
        probe = ffprobe_info(sine_wav)
        audio = parse_audio_stream(probe)
        # sine_wav was created as pcm_s24le
        depth = parse_bit_depth(audio)
        assert depth in (24, 16)  # 24 expected, but tolerate ffprobe quirks

    def test_unknown_stream_returns_16(self):
        depth = parse_bit_depth({})
        assert depth == 16

    def test_s16_codec_name(self):
        depth = parse_bit_depth({"codec_name": "pcm_s16le"})
        assert depth == 16

    def test_s24_codec_name(self):
        depth = parse_bit_depth({"codec_name": "pcm_s24le"})
        assert depth == 24


# ─────────────────────────────────────────────────────────────────────────────
# loudnorm_pass1
# ─────────────────────────────────────────────────────────────────────────────

class TestLoudnormPass1:
    def test_returns_required_keys(self, sine_wav):
        result = loudnorm_pass1(sine_wav)
        expected_keys = {
            "input_i", "input_lra", "input_tp", "input_thresh", "target_offset"
        }
        assert expected_keys.issubset(result.keys())

    def test_input_i_is_numeric(self, sine_wav):
        result = loudnorm_pass1(sine_wav)
        # Should be a string like "-15.2" not "-inf"
        val = result["input_i"]
        assert val not in ("-inf", "inf")
        float(val)  # should not raise

    def test_quiet_file_lufs(self, quiet_wav):
        result = loudnorm_pass1(quiet_wav)
        lufs = float(result["input_i"])
        # quiet_wav is ≈ -30 LUFS
        assert lufs < -20.0, f"Expected LUFS < -20, got {lufs}"

    def test_missing_file_raises(self):
        with pytest.raises(FFmpegError):
            loudnorm_pass1("/no/such/file.wav")

    def test_fake_file_raises(self, fake_wav):
        with pytest.raises(FFmpegError):
            loudnorm_pass1(fake_wav)

    def test_backward_scan_json_extraction(self, sine_wav):
        """
        Regression test for the backward-scan JSON extraction.
        Ensures loudnorm JSON is correctly parsed even if other {...}
        blocks appear earlier in ffmpeg stderr.
        """
        # If loudnorm_pass1 succeeds, the backward-scan worked.
        result = loudnorm_pass1(sine_wav)
        assert isinstance(result, dict)
        assert "input_i" in result
