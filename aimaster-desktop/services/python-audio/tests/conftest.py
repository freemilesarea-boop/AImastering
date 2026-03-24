"""
Shared pytest fixtures for AIMASTER Python audio engine tests.

Test audio files are generated on first use via ffmpeg and cached
in /tmp/aimaster-test/ for the duration of the test session.
"""
from __future__ import annotations

import subprocess
import os
import pytest

TEST_DIR = "/tmp/aimaster-test"


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
