"""Canonical analysis preprocessing contract.

Feature values here are statistics over FFT bins that run up to Nyquist, so they
are only comparable between two signals measured at the same sample rate. The
commercial reference is 44.1 kHz and the AI corpus is 48 kHz, and the analyzer
used to measure each at its native rate — which is why a target derived from one
could never be compared against the other. These tests pin the contract that
removes that: one rate, one decoder, one resampler, all recorded.

Only synthetic fixtures are used. No commercial or AI corpus audio is touched.
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent.parent))

import numpy as np

from app.analyzers.canonical_features import (
    CANONICAL_ANALYSIS_SR,
    CANONICAL_SILENCE_POLICY,
    CANONICAL_TRIM_POLICY,
    PREPROCESSING_POLICY_VERSION,
    CanonicalFeatureExtractor,
    _load_canonical_signal,
)
from app.utils.ffmpeg_wrapper import (
    CANONICAL_ARESAMPLE_PARAMS,
    CANONICAL_DITHER_POLICY,
    CanonicalProvenanceError,
    build_canonical_decode_cmd,
    canonical_aresample_filter,
    decode_canonical_pcm_f32le,
    ffmpeg_binary_sha256,
    ffmpeg_version,
    resolve_canonical_ffmpeg,
)


@pytest.fixture
def extractor():
    return CanonicalFeatureExtractor()


def _cmd_str(*args, **kwargs) -> str:
    return " ".join(build_canonical_decode_cmd(*args, **kwargs))


# ══ T1 — 44.1 kHz input takes the decode-only path ═══════════════════════════

def test_t1_44100_command_has_no_resampler():
    """The filter is absent from the graph, not present as a no-op.

    A filter that is not in the graph cannot contribute rounding, dither or a
    cutoff to the measurement.
    """
    cmd = _cmd_str("/x.wav", binary="/opt/ffmpeg", target_sr=None)
    assert "aresample" not in cmd
    assert "-af" not in cmd
    assert "-ar" not in cmd  # -ar would attach an implicit resampler


def test_t1_44100_analysis_is_not_resampled(sine_wav):
    data, analysis_sr, source_sr, resampled = _load_canonical_signal(sine_wav)
    assert source_sr == 44100
    assert analysis_sr == CANONICAL_ANALYSIS_SR == 44100
    assert resampled is False
    assert data.dtype == np.float32


def test_t1_features_report_no_resample(extractor, sine_wav):
    features = extractor.extract(sine_wav)
    assert features.sample_rate == 44100           # source rate
    assert features.analysis_sample_rate == 44100   # analysis rate
    assert features.analysis_resampled is False


# ══ T2 — 48 kHz input is resampled to exactly 44100 ══════════════════════════

def test_t2_48k_command_carries_every_pinned_parameter():
    cmd = _cmd_str("/x.wav", binary="/opt/ffmpeg", target_sr=CANONICAL_ANALYSIS_SR)
    assert "-af" in cmd
    assert "aresample=" in cmd
    assert "osr=44100" in cmd
    for key, value in CANONICAL_ARESAMPLE_PARAMS:
        assert f"{key}={value}" in cmd, f"{key} not pinned in command"


def test_t2_pinned_parameters_are_the_agreed_contract():
    """Every parameter is stated; a default left implicit is unrecorded."""
    assert dict(CANONICAL_ARESAMPLE_PARAMS) == {
        "resampler": "swr",
        "filter_size": "32",
        "phase_shift": "10",
        "linear_interp": "1",
        "exact_rational": "1",
        "filter_type": "kaiser",
        "kaiser_beta": "9",
        "cutoff": "0",
        "dither_method": "0",
        "async": "0",
    }


def test_t2_cutoff_is_auto_pinned_by_binary_not_invented():
    """cutoff stays 0.

    The value auto resolves to is not readable from the binary, so substituting a
    number would silently apply a different filter than auto. What auto means is
    fixed by pinning the binary instead — see the version/sha256 tests below.
    """
    assert dict(CANONICAL_ARESAMPLE_PARAMS)["cutoff"] == "0"
    assert "cutoff=0" in canonical_aresample_filter(44100)


def test_t2_48k_analysis_lands_on_44100(sine_48k_wav):
    data, analysis_sr, source_sr, resampled = _load_canonical_signal(sine_48k_wav)
    assert source_sr == 48000
    assert analysis_sr == 44100
    assert resampled is True

    # Sample count must follow the analysis rate, not the source rate.
    duration = data.shape[0] / analysis_sr
    assert duration == pytest.approx(10.0, abs=0.05)


def test_t2_features_report_resample(extractor, sine_48k_wav):
    features = extractor.extract(sine_48k_wav)
    assert features.sample_rate == 48000            # source is unchanged
    assert features.analysis_sample_rate == 44100    # analysis is canonical
    assert features.analysis_resampled is True
    assert features.duration_sec == pytest.approx(10.0, abs=0.05)


# ══ T3 — channel preservation ════════════════════════════════════════════════

def test_t3_stereo_shape(sine_wav):
    data, _, _, _ = _load_canonical_signal(sine_wav)
    assert data.ndim == 2 and data.shape[1] == 2


def test_t3_mono_shape(sine_mono_wav):
    data, _, _, _ = _load_canonical_signal(sine_mono_wav)
    assert data.ndim == 2 and data.shape[1] == 1


def test_t3_mono_features_keep_existing_semantics(extractor, sine_mono_wav):
    features = extractor.extract(sine_mono_wav)
    assert features.channels == 1
    assert features.stereo_width == 0.0
    assert features.mono_compatibility_score == 1.0


def test_t3_no_channel_count_in_command():
    """No -ac: folding to mono is the analyzer's job, downstream of decode."""
    assert "-ac" not in _cmd_str("/x.wav", binary="/opt/ffmpeg")


# ══ T4 — f32 scale sanity, measured against soundfile ════════════════════════

def test_t4_nominal_scale_is_plus_minus_one(sine_wav):
    """A full-scale-ish sine must land inside +/-1.0, not at 2**23 or 2**31.

    If the scaling convention were wrong the error would be a factor of 256
    (48 dB), which would move every absolute dB feature.
    """
    data, _, _, _ = _load_canonical_signal(sine_wav)
    peak = float(np.max(np.abs(data)))
    assert 0.05 < peak <= 1.0, f"peak {peak} is outside the nominal +/-1.0 range"


def test_t4_scale_matches_soundfile(sine_wav):
    """Compare the new decoder against the one it replaces.

    Reported rather than asserted identical: the two decoders are different
    implementations and were never proven equivalent. The assertion is that they
    agree to a level where no feature could shift meaningfully, and the measured
    difference is printed either way.
    """
    soundfile = pytest.importorskip("soundfile")

    old, old_sr = soundfile.read(sine_wav, always_2d=True, dtype="float32")
    new, new_sr, _, resampled = _load_canonical_signal(sine_wav)
    assert resampled is False, "44.1 kHz fixture must not be resampled"
    assert old_sr == new_sr == 44100

    n = min(old.shape[0], new.shape[0])
    old_peak = float(np.max(np.abs(old[:n])))
    new_peak = float(np.max(np.abs(new[:n])))
    old_rms = float(np.sqrt(np.mean(old[:n] ** 2)))
    new_rms = float(np.sqrt(np.mean(new[:n] ** 2)))

    print(f"\n[T4] frames old={old.shape[0]} new={new.shape[0]}")
    print(f"[T4] peak  old={old_peak:.9f} new={new_peak:.9f} "
          f"delta={abs(new_peak - old_peak):.3e}")
    print(f"[T4] rms   old={old_rms:.9f} new={new_rms:.9f} "
          f"delta={abs(new_rms - old_rms):.3e}")

    assert abs(new_peak - old_peak) < 1e-4, "peak scale differs between decoders"
    assert abs(new_rms - old_rms) < 1e-4, "RMS scale differs between decoders"


# ══ T5 — attached cover art ══════════════════════════════════════════════════

def test_t5_command_selects_audio_stream_explicitly():
    cmd = build_canonical_decode_cmd("/x.flac", binary="/opt/ffmpeg")
    assert "-map" in cmd and "0:a:0" in cmd
    assert "-vn" in cmd


def test_t5_flac_with_cover_decodes_audio_only(flac_with_cover):
    """The commercial reference corpus is 100/100 FLAC with an attached PNG."""
    data, analysis_sr, source_sr, resampled = _load_canonical_signal(flac_with_cover)
    assert source_sr == 44100
    assert analysis_sr == 44100
    assert resampled is False
    assert data.shape[1] == 2
    assert data.shape[0] / analysis_sr == pytest.approx(5.0, abs=0.05)


def test_t5_cover_fixture_really_has_two_streams(flac_with_cover):
    """Guard against the fixture silently losing its cover, which would make
    the test above prove nothing."""
    from app.utils.ffmpeg_wrapper import ffprobe_info

    streams = ffprobe_info(flac_with_cover).get("streams") or []
    kinds = sorted(s.get("codec_type") for s in streams)
    assert kinds == ["audio", "video"], f"fixture streams: {kinds}"


# ══ T6 / T7 — explicit binary required, PATH refused ═════════════════════════

def test_t6_explicit_binary_resolves(monkeypatch):
    import shutil

    real = shutil.which("ffmpeg")
    if not real:
        pytest.skip("ffmpeg not available")
    monkeypatch.setenv("AIMASTER_FFMPEG", os.path.abspath(real))
    assert resolve_canonical_ffmpeg() == os.path.abspath(real)


def test_t7_unset_env_is_refused(monkeypatch):
    monkeypatch.delenv("AIMASTER_FFMPEG", raising=False)
    with pytest.raises(CanonicalProvenanceError, match="not set"):
        resolve_canonical_ffmpeg()


def test_t7_bare_name_is_refused(monkeypatch):
    """'ffmpeg' would work. It is refused because afterwards nobody could say
    which binary ran."""
    monkeypatch.setenv("AIMASTER_FFMPEG", "ffmpeg")
    with pytest.raises(CanonicalProvenanceError, match="bare name"):
        resolve_canonical_ffmpeg()


def test_t7_missing_file_is_refused(monkeypatch, tmp_path):
    monkeypatch.setenv("AIMASTER_FFMPEG", str(tmp_path / "nope" / "ffmpeg"))
    with pytest.raises(CanonicalProvenanceError, match="not a file"):
        resolve_canonical_ffmpeg()


def test_t7_non_executable_is_refused(monkeypatch, tmp_path):
    fake = tmp_path / "ffmpeg"
    fake.write_text("#!/bin/sh\n")
    fake.chmod(0o644)
    monkeypatch.setenv("AIMASTER_FFMPEG", str(fake))
    with pytest.raises(CanonicalProvenanceError, match="not executable"):
        resolve_canonical_ffmpeg()


def test_t7_analysis_fails_closed_without_provenance(monkeypatch, extractor, sine_wav):
    """No silent fall back to a native-rate measurement."""
    monkeypatch.delenv("AIMASTER_FFMPEG", raising=False)
    with pytest.raises(CanonicalProvenanceError):
        extractor.extract(sine_wav)


# ══ T8 — provenance values match the real binary ════════════════════════════

def test_t8_version_and_sha256_match_the_binary():
    binary = resolve_canonical_ffmpeg()

    version = ffmpeg_version(binary)
    assert version and version[0].isdigit(), f"unexpected version: {version!r}"

    digest = ffmpeg_binary_sha256(binary)
    assert len(digest) == 64 and all(c in "0123456789abcdef" for c in digest)

    expected = subprocess.run(
        ["shasum", "-a", "256", binary], capture_output=True, text=True
    )
    if expected.returncode == 0:
        assert digest == expected.stdout.split()[0]

    reported = subprocess.run(
        [binary, "-hide_banner", "-version"], capture_output=True, text=True
    )
    assert version in reported.stdout.splitlines()[0]


def test_t8_sha256_refuses_a_path_resolved_name():
    with pytest.raises(CanonicalProvenanceError, match="PATH-resolved"):
        ffmpeg_binary_sha256("ffmpeg")


def test_t8_policy_constants_are_recordable():
    assert PREPROCESSING_POLICY_VERSION == "1.0.0"
    assert CANONICAL_ANALYSIS_SR == 44100
    assert CANONICAL_DITHER_POLICY == "none"
    assert CANONICAL_TRIM_POLICY == "none"
    assert CANONICAL_SILENCE_POLICY == "none"


# ══ T11 — loudness path unchanged ═══════════════════════════════════════════

def test_t11_loudness_still_measured_from_the_original_file(monkeypatch, extractor, sine_wav):
    """LUFS/TP/LRA must keep coming from ffmpeg against the source path, not
    from the resampled analysis array."""
    import app.utils.ffmpeg_wrapper as fw

    seen: list[str] = []
    real = fw.loudnorm_pass1

    def spy(file_path, *args, **kwargs):
        seen.append(file_path)
        return real(file_path, *args, **kwargs)

    monkeypatch.setattr(fw, "loudnorm_pass1", spy)
    features = extractor.extract(sine_wav)

    assert seen == [sine_wav], f"loudness read from {seen} instead of the source"
    assert features.integrated_lufs is not None
    assert features.true_peak_dbtp is not None


def test_t11_loudness_uses_source_path_even_when_resampled(monkeypatch, extractor, sine_48k_wav):
    import app.utils.ffmpeg_wrapper as fw

    seen: list[str] = []
    real = fw.loudnorm_pass1

    def spy(file_path, *args, **kwargs):
        seen.append(file_path)
        return real(file_path, *args, **kwargs)

    monkeypatch.setattr(fw, "loudnorm_pass1", spy)
    extractor.extract(sine_48k_wav)
    assert seen == [sine_48k_wav]


# ══ T12 — determinism ═══════════════════════════════════════════════════════

def test_t12_decoded_array_is_byte_identical_across_runs(sine_wav):
    first = _load_canonical_signal(sine_wav)[0].tobytes()
    for _ in range(2):
        assert _load_canonical_signal(sine_wav)[0].tobytes() == first


def test_t12_resampled_array_is_byte_identical_across_runs(sine_48k_wav):
    first = _load_canonical_signal(sine_48k_wav)[0].tobytes()
    for _ in range(2):
        assert _load_canonical_signal(sine_48k_wav)[0].tobytes() == first


def test_t12_features_are_identical_across_runs(extractor, sine_48k_wav):
    runs = [extractor.extract(sine_48k_wav).to_dict() for _ in range(3)]
    assert runs[0] == runs[1] == runs[2]


# ══ T13 — fail-closed conditions ════════════════════════════════════════════

def test_t13_missing_audio_stream_fails(tmp_path, flac_with_cover):
    """A video-only file has no audio stream to analyse."""
    from app.utils.ffmpeg_wrapper import ffprobe_info

    video_only = tmp_path / "cover_only.mkv"
    subprocess.run(
        ["ffmpeg", "-y", "-i", flac_with_cover, "-map", "0:v", "-c", "copy",
         str(video_only)],
        check=True, capture_output=True,
    )
    if any(s.get("codec_type") == "audio" for s in (ffprobe_info(str(video_only)).get("streams") or [])):
        pytest.skip("could not build an audio-free fixture")

    with pytest.raises(CanonicalProvenanceError, match="no audio stream"):
        _load_canonical_signal(str(video_only))


def test_t13_ffmpeg_nonzero_exit_fails(sine_wav):
    with pytest.raises(CanonicalProvenanceError, match="decode failed"):
        decode_canonical_pcm_f32le(
            sine_wav, channels=2, binary=resolve_canonical_ffmpeg(),
            target_sr=-1,  # invalid osr → ffmpeg rejects the filter
        )


def test_t13_invalid_channel_count_fails(sine_wav):
    with pytest.raises(CanonicalProvenanceError, match="invalid channel count"):
        decode_canonical_pcm_f32le(
            sine_wav, channels=0, binary=resolve_canonical_ffmpeg()
        )


def test_t13_malformed_byte_length_fails(monkeypatch, sine_wav):
    """A stream whose length is not a whole number of frames must not be
    reshaped into a plausible-looking array."""
    import app.utils.ffmpeg_wrapper as fw

    real_run = subprocess.run

    class Truncated:
        returncode = 0
        stderr = b""

        def __init__(self, stdout):
            self.stdout = stdout

    def fake_run(cmd, *args, **kwargs):
        result = real_run(cmd, *args, **kwargs)
        return Truncated((result.stdout or b"")[:-1])  # drop one byte

    monkeypatch.setattr(fw.subprocess, "run", fake_run)
    with pytest.raises(CanonicalProvenanceError, match="malformed f32le"):
        decode_canonical_pcm_f32le(
            sine_wav, channels=2, binary=resolve_canonical_ffmpeg()
        )


def test_t13_empty_output_fails(monkeypatch, sine_wav):
    import app.utils.ffmpeg_wrapper as fw

    class Empty:
        returncode = 0
        stdout = b""
        stderr = b""

    monkeypatch.setattr(fw.subprocess, "run", lambda *a, **k: Empty())
    with pytest.raises(CanonicalProvenanceError, match="no audio"):
        decode_canonical_pcm_f32le(
            sine_wav, channels=2, binary=resolve_canonical_ffmpeg()
        )


def test_t13_binary_not_found_fails(sine_wav, tmp_path):
    ghost = tmp_path / "ghost-ffmpeg"
    with pytest.raises(CanonicalProvenanceError, match="not found"):
        decode_canonical_pcm_f32le(sine_wav, channels=2, binary=str(ghost))


def test_t13_no_silent_native_rate_fallback(monkeypatch, extractor, sine_48k_wav):
    """The failure mode this whole contract exists to prevent: a 48 kHz file
    quietly measured at 48 kHz because canonicalisation did not work."""
    import app.utils.ffmpeg_wrapper as fw

    def boom(*args, **kwargs):
        raise CanonicalProvenanceError("resample unavailable")

    monkeypatch.setattr(fw, "decode_canonical_pcm_f32le", boom)
    with pytest.raises(CanonicalProvenanceError):
        extractor.extract(sine_48k_wav)


# ══ trim / silence policy ═══════════════════════════════════════════════════

def test_no_trim_or_silence_filter_in_command():
    for target in (None, CANONICAL_ANALYSIS_SR):
        cmd = _cmd_str("/x.wav", binary="/opt/ffmpeg", target_sr=target)
        assert "atrim" not in cmd
        assert "silenceremove" not in cmd
        assert "-ss" not in cmd
        assert "-t " not in cmd
