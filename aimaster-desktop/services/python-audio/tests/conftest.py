"""
Shared pytest fixtures for AIMASTER Python audio engine tests.

Test audio files are generated on first use via ffmpeg and cached
in /tmp/aimaster-test/ for the duration of the test session.
"""
from __future__ import annotations

import shutil
import subprocess
import os
import pytest

TEST_DIR = "/tmp/aimaster-test"


@pytest.fixture(scope="session", autouse=True)
def canonical_ffmpeg_env() -> None:
    """Give canonical analysis an explicit ffmpeg path for the test session.

    Canonical analysis refuses to run off a PATH-resolved bare name, so the
    tests have to name a binary. Resolving one here is not a way around that
    rule — the rule is that the binary must be identified, and these tests then
    assert that its version and sha256 are recorded. Which binary it is does not
    matter to the tests; that it is a known one does.

    A pre-set AIMASTER_FFMPEG (packaged runs, CI pointing at the bundled build)
    always wins.
    """
    if os.environ.get("AIMASTER_FFMPEG"):
        return
    found = shutil.which("ffmpeg")
    if found:
        os.environ["AIMASTER_FFMPEG"] = os.path.abspath(found)


def _ffmpeg_available() -> bool:
    try:
        result = subprocess.run(
            ["ffmpeg", "-version"], capture_output=True, timeout=5
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def _gen(name: str, args: list[str]) -> str:
    """Generate a test audio file if not already present."""
    path = os.path.join(TEST_DIR, name)
    if not os.path.exists(path):
        os.makedirs(TEST_DIR, exist_ok=True)
        subprocess.run(args + [path], check=True, capture_output=True)
    return path


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture(scope="session")
def ffmpeg_available() -> bool:
    return _ffmpeg_available()


@pytest.fixture(scope="session")
def sine_wav(ffmpeg_available):
    """10-second 440 Hz stereo WAV, 44.1 kHz, 24-bit."""
    if not ffmpeg_available:
        pytest.skip("ffmpeg not available")
    return _gen("sine_440hz_10s.wav", [
        "ffmpeg", "-y", "-f", "lavfi",
        "-i", "sine=frequency=440:duration=10",
        "-ar", "44100", "-acodec", "pcm_s24le", "-ac", "2",
    ])


@pytest.fixture(scope="session")
def quiet_wav(ffmpeg_available):
    """Quiet file ≈ -30 LUFS."""
    if not ffmpeg_available:
        pytest.skip("ffmpeg not available")
    return _gen("quiet_-30lufs.wav", [
        "ffmpeg", "-y", "-f", "lavfi",
        "-i", "sine=frequency=440:duration=10",
        "-ar", "44100", "-acodec", "pcm_s24le", "-ac", "2",
        "-af", "volume=-15dB",
    ])


@pytest.fixture(scope="session")
def pink_noise_wav(ffmpeg_available):
    """30-second pink noise, 44.1 kHz, 24-bit."""
    if not ffmpeg_available:
        pytest.skip("ffmpeg not available")
    return _gen("pink_noise_30s.wav", [
        "ffmpeg", "-y", "-f", "lavfi",
        "-i", "anoisesrc=color=pink:duration=30",
        "-ar", "44100", "-acodec", "pcm_s24le", "-ac", "2",
    ])


@pytest.fixture(scope="session")
def empty_file(tmp_path_factory):
    """0-byte file with .wav extension."""
    p = tmp_path_factory.mktemp("bad") / "empty.wav"
    p.touch()
    return str(p)


@pytest.fixture(scope="session")
def fake_wav(tmp_path_factory):
    """Text content with .wav extension."""
    p = tmp_path_factory.mktemp("bad") / "fake.wav"
    p.write_text("this is not audio data")
    return str(p)


@pytest.fixture(scope="session")
def sine_48k_wav(ffmpeg_available):
    """10-second 440 Hz stereo WAV at 48 kHz — exercises the resample path."""
    if not ffmpeg_available:
        pytest.skip("ffmpeg not available")
    return _gen("sine_440hz_10s_48k.wav", [
        "ffmpeg", "-y", "-f", "lavfi",
        "-i", "sine=frequency=440:duration=10",
        "-ar", "48000", "-acodec", "pcm_s24le", "-ac", "2",
    ])


@pytest.fixture(scope="session")
def sine_mono_wav(ffmpeg_available):
    """5-second 440 Hz MONO WAV at 44.1 kHz — channel preservation."""
    if not ffmpeg_available:
        pytest.skip("ffmpeg not available")
    return _gen("sine_440hz_5s_mono.wav", [
        "ffmpeg", "-y", "-f", "lavfi",
        "-i", "sine=frequency=440:duration=5",
        "-ar", "44100", "-acodec", "pcm_s24le", "-ac", "1",
    ])


@pytest.fixture(scope="session")
def flac_with_cover(ffmpeg_available):
    """44.1 kHz FLAC carrying an attached picture.

    Mirrors the commercial reference corpus, where all 100 tracks ship with an
    attached PNG cover, so the audio-stream selection is exercised rather than
    assumed.
    """
    if not ffmpeg_available:
        pytest.skip("ffmpeg not available")
    cover = _gen("cover_source.png", [
        "ffmpeg", "-y", "-f", "lavfi",
        "-i", "color=c=blue:s=64x64:d=1", "-frames:v", "1",
    ])
    audio = _gen("cover_audio_src.wav", [
        "ffmpeg", "-y", "-f", "lavfi",
        "-i", "sine=frequency=440:duration=5",
        "-ar", "44100", "-acodec", "pcm_s24le", "-ac", "2",
    ])
    path = os.path.join(TEST_DIR, "with_cover_44k.flac")
    if not os.path.exists(path):
        subprocess.run([
            "ffmpeg", "-y", "-i", audio, "-i", cover,
            "-map", "0:a", "-map", "1:v",
            "-c:a", "flac", "-c:v", "copy",
            "-disposition:v:0", "attached_pic",
            path,
        ], check=True, capture_output=True)
    return path
