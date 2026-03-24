"""
Integration tests for the full mastering pipeline.

Run:
    cd services/python-audio
    pytest tests/test_pipeline.py -v

These tests call run_pipeline() directly (no IPC overhead).
They require ffmpeg and the .venv to be active.
"""
from __future__ import annotations

import os
import pytest

from app.mastering.pipeline import run_pipeline
from app.utils.ffmpeg_wrapper import FFmpegError


TARGET_LUFS = -14.0
TARGET_TP   = -1.0
LUFS_TOL    = 1.5   # ±1.5 LUFS tolerance (matching pipeline._LUFS_TOLERANCE)


def _output(tmp_path, name: str) -> str:
    return str(tmp_path / name)


# ─────────────────────────────────────────────────────────────────────────────
# Core loudness targets
# ─────────────────────────────────────────────────────────────────────────────

class TestPipelineLoudness:
    def test_balanced_hits_target_lufs(self, sine_wav, tmp_path):
        out = _output(tmp_path, "balanced.wav")
        result = run_pipeline(sine_wav, out, style="balanced")
        lufs = result["loudnessAfter"]["integratedLufs"]
        assert abs(lufs - TARGET_LUFS) <= LUFS_TOL, \
            f"LUFS {lufs} outside tolerance (target {TARGET_LUFS} ± {LUFS_TOL})"

    def test_true_peak_below_limit(self, sine_wav, tmp_path):
        out = _output(tmp_path, "tp_test.wav")
        result = run_pipeline(sine_wav, out, style="balanced")
        tp = result["loudnessAfter"]["truePeakDbtp"]
        assert tp <= TARGET_TP, f"True Peak {tp} dBTP exceeds {TARGET_TP}"

    def test_quiet_file_reaches_target(self, quiet_wav, tmp_path):
        """File at -30 LUFS must be brought up to -14 LUFS."""
        out = _output(tmp_path, "from_quiet.wav")
        result = run_pipeline(quiet_wav, out, style="balanced")
        lufs = result["loudnessAfter"]["integratedLufs"]
        assert abs(lufs - TARGET_LUFS) <= LUFS_TOL, \
            f"Quiet file LUFS {lufs} not normalized to target"


# ─────────────────────────────────────────────────────────────────────────────
# Style presets
# ─────────────────────────────────────────────────────────────────────────────

class TestPipelineStyles:
    @pytest.mark.parametrize("style", ["balanced", "warm", "bright", "punch"])
    def test_all_styles_produce_output(self, pink_noise_wav, tmp_path, style):
        out = _output(tmp_path, f"style_{style}.wav")
        result = run_pipeline(pink_noise_wav, out, style=style)
        assert os.path.exists(out), f"Output file not created for style={style}"
        assert result["loudnessAfter"]["integratedLufs"] > -99.0

    @pytest.mark.parametrize("style", ["balanced", "warm", "bright", "punch"])
    def test_styles_apply_corrections(self, pink_noise_wav, tmp_path, style):
        out = _output(tmp_path, f"corr_{style}.wav")
        result = run_pipeline(pink_noise_wav, out, style=style)
        # Each style should produce at least one applied correction description
        assert len(result["appliedCorrections"]) > 0, \
            f"No corrections applied for style={style}"


# ─────────────────────────────────────────────────────────────────────────────
# Output file properties
# ─────────────────────────────────────────────────────────────────────────────

class TestPipelineOutputFile:
    def test_output_file_exists(self, sine_wav, tmp_path):
        out = _output(tmp_path, "exists.wav")
        run_pipeline(sine_wav, out)
        assert os.path.exists(out)

    def test_output_file_not_empty(self, sine_wav, tmp_path):
        out = _output(tmp_path, "not_empty.wav")
        run_pipeline(sine_wav, out)
        assert os.path.getsize(out) > 1024  # > 1 KB

    def test_preview_mp3_created(self, sine_wav, tmp_path):
        out = _output(tmp_path, "preview_test.wav")
        result = run_pipeline(sine_wav, out)
        preview = result.get("previewPath", "")
        assert preview and os.path.exists(preview), \
            f"MP3 preview not created: {preview}"

    def test_processing_time_recorded(self, sine_wav, tmp_path):
        out = _output(tmp_path, "timing.wav")
        result = run_pipeline(sine_wav, out)
        assert result["processingTimeSec"] > 0


# ─────────────────────────────────────────────────────────────────────────────
# Error cases
# ─────────────────────────────────────────────────────────────────────────────

class TestPipelineErrors:
    def test_missing_input_raises(self, tmp_path):
        out = _output(tmp_path, "err_out.wav")
        with pytest.raises(FFmpegError):
            run_pipeline("/nonexistent/input.wav", out)

    def test_empty_input_raises(self, empty_file, tmp_path):
        out = _output(tmp_path, "err_empty.wav")
        with pytest.raises((FFmpegError, Exception)):
            run_pipeline(empty_file, out)

    def test_fake_wav_raises(self, fake_wav, tmp_path):
        out = _output(tmp_path, "err_fake.wav")
        with pytest.raises(FFmpegError):
            run_pipeline(fake_wav, out)


# ─────────────────────────────────────────────────────────────────────────────
# Result structure
# ─────────────────────────────────────────────────────────────────────────────

class TestPipelineResultShape:
    def test_result_has_required_keys(self, sine_wav, tmp_path):
        out = _output(tmp_path, "shape.wav")
        result = run_pipeline(sine_wav, out)
        required = {
            "outputPath", "previewPath", "appliedCorrections",
            "loudnessBefore", "loudnessAfter", "processingTimeSec",
        }
        assert required.issubset(result.keys())

    def test_loudness_before_has_subkeys(self, sine_wav, tmp_path):
        out = _output(tmp_path, "before.wav")
        result = run_pipeline(sine_wav, out)
        before = result["loudnessBefore"]
        assert "integratedLufs" in before
        assert "truePeakDbtp" in before
        assert "lra" in before

    def test_loudness_after_has_subkeys(self, sine_wav, tmp_path):
        out = _output(tmp_path, "after.wav")
        result = run_pipeline(sine_wav, out)
        after = result["loudnessAfter"]
        assert "integratedLufs" in after
        assert "truePeakDbtp" in after
        assert "lra" in after
