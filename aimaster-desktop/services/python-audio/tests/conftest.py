"""
Shared pytest fixtures for AIMASTER Python audio engine tests.

Test audio files are generated on first use via ffmpeg and cached
in /tmp/aimaster-test/ for the duration of the test session.
"""
from __future__ import annotations

import glob
import shutil
import subprocess
import os
import pytest

TEST_DIR = "/tmp/aimaster-test"


def _first_executable(*candidates: str) -> str | None:
    """The first of these paths that exists and can be run."""
    for candidate in candidates:
        for path in (candidate, candidate + ".exe"):
            if os.path.isfile(path) and os.access(path, os.X_OK):
                return path
    return None


def _repo_binary(*parts: str) -> str:
    """A path under the repository, from tests/conftest.py."""
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.normpath(os.path.join(here, "..", "..", "..", *parts))


def _resolve_canonical_ffmpeg_env() -> None:
    """Give canonical analysis an explicit ffmpeg path for the test session.

    Canonical analysis refuses to run off a PATH-resolved bare name, so the
    tests have to name a binary. Resolving one here is not a way around that
    rule — the rule is that the binary must be identified, and these tests then
    assert that its version and sha256 are recorded. Which binary it is does not
    matter to the tests; that it is a known one does.

    A pre-set AIMASTER_FFMPEG (packaged runs, CI pointing at the bundled build)
    always wins.

    PATH is asked second, not only — and that distinction is the whole repair.
    This used to be `shutil.which("ffmpeg")` alone, which found a binary on
    every developer machine and found nothing on a CI runner, because this
    project does not install ffmpeg: it SHIPS one. The first CI run of the
    suite reported 38 tests removing themselves with "canonical extraction
    requires an explicit ffmpeg binary", 30 of them the commercial-reference
    extraction file, after the same check had passed here for as long as the
    suite only ever ran here.

    So the fallbacks are the two binaries the repository actually has: the one
    `scripts/prebuild.cjs` copies into the desktop app's `public/bin`, and the
    one `ffmpeg-static` unpacks into node_modules — which is also the binary
    `python-suite-selftest.ts` names in its second pass.
    """
    if os.environ.get("AIMASTER_FFMPEG"):
        return

    found = shutil.which("ffmpeg")
    if found:
        os.environ["AIMASTER_FFMPEG"] = os.path.abspath(found)
        return

    shipped = _first_executable(
        _repo_binary("apps", "desktop", "public", "bin", "ffmpeg"),
        _repo_binary("node_modules", "ffmpeg-static", "ffmpeg"),
    )
    if shipped:
        os.environ["AIMASTER_FFMPEG"] = shipped


def _resolve_ffprobe_env() -> None:
    """The same, for ffprobe — which is the half that was still missing.

    Fixing ffmpeg turned 30 silent skips into 27 failures, and the failures
    said `ffprobe`: `app/utils/ffmpeg_wrapper.py` resolves it by bare name, so
    the engine probes before it decodes and finds nothing on a runner with no
    ffmpeg installed.  `scripts/prebuild.cjs` copies BOTH binaries into the
    desktop app's public/bin for exactly this reason; `@ffprobe-installer`
    unpacks the other copy.
    """
    if os.environ.get("AIMASTER_FFPROBE"):
        return

    found = shutil.which("ffprobe")
    if found:
        os.environ["AIMASTER_FFPROBE"] = os.path.abspath(found)
        return

    shipped = _first_executable(
        _repo_binary("apps", "desktop", "public", "bin", "ffprobe"),
        *glob.glob(_repo_binary("node_modules", "@ffprobe-installer", "*", "ffprobe")),
    )
    if shipped:
        os.environ["AIMASTER_FFPROBE"] = shipped


# Called at IMPORT, not from a session fixture.
#
# `tests/mastering/test_extract_commercial_reference.py` carries
#
#     pytestmark = pytest.mark.skipif(not os.environ.get("AIMASTER_FFMPEG"), ...)
#
# and that condition is a plain bool, evaluated while the module is being
# imported for collection — long before any fixture, autouse or not, has run.
# As a session fixture this resolution was always too late: all 30 tests in
# that file removed themselves on every machine where nobody had exported the
# variable by hand, and the only trace was a skip count in a release runbook
# ("79 passed, 41 skipped") that made it look normal.  Measured: 30 skipped in
# 0.29 s as the suite ran it, 30 PASSED in 30 s with the variable exported.
_resolve_canonical_ffmpeg_env()
_resolve_ffprobe_env()

# What `ffmpeg_bin()` hands out, fixed now, while the resolvers' answer is
# still in the environment and before any test can take it away.
_FFMPEG_FOR_FIXTURES = os.environ.get("AIMASTER_FFMPEG", "ffmpeg")


def _ffmpeg_available() -> bool:
    try:
        result = subprocess.run(
            [ffmpeg_bin(), "-version"], capture_output=True, timeout=5
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def ffmpeg_bin() -> str:
    """The ffmpeg the tests should SPAWN, as opposed to the one they measure.

    `_resolve_canonical_ffmpeg_env()` above answers "which binary does the
    engine analyse with".  This answers "which binary do the tests run to make
    a fixture", and they are the same question with one answer — but the
    fixture-generating calls were spelling it `"ffmpeg"`, a bare name resolved
    against PATH.  On a CI runner there is no ffmpeg on PATH (this project
    ships one rather than installing one), so those calls raised
    `FileNotFoundError: 'ffmpeg'` the moment the skips above stopped hiding
    them: 27 failures where there had been 30 silent skips.

    Captured at import, NOT read from the environment on each call — and that
    is load-bearing.  `test_extraction_refuses_to_start_without_ffmpeg_provenance`
    does `monkeypatch.delenv("AIMASTER_FFMPEG")` and asserts the extraction
    refuses to start; reading the variable here made its CORPUS FIXTURE fail
    to generate first, with `FileNotFoundError: 'ffmpeg'`, so the test died
    before reaching the refusal it was written for.  Which binary the engine
    analyses with is a thing a test may take away.  Which binary generates a
    fixture is not.

    Falls back to the bare name so a machine with ffmpeg on PATH and no
    checkout of the desktop app still works.
    """
    return _FFMPEG_FOR_FIXTURES


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
        ffmpeg_bin(), "-y", "-f", "lavfi",
        "-i", "sine=frequency=440:duration=10",
        "-ar", "44100", "-acodec", "pcm_s24le", "-ac", "2",
    ])


@pytest.fixture(scope="session")
def quiet_wav(ffmpeg_available):
    """Quiet file ≈ -30 LUFS."""
    if not ffmpeg_available:
        pytest.skip("ffmpeg not available")
    return _gen("quiet_-30lufs.wav", [
        ffmpeg_bin(), "-y", "-f", "lavfi",
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
        ffmpeg_bin(), "-y", "-f", "lavfi",
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
        ffmpeg_bin(), "-y", "-f", "lavfi",
        "-i", "sine=frequency=440:duration=10",
        "-ar", "48000", "-acodec", "pcm_s24le", "-ac", "2",
    ])


@pytest.fixture(scope="session")
def sine_mono_wav(ffmpeg_available):
    """5-second 440 Hz MONO WAV at 44.1 kHz — channel preservation."""
    if not ffmpeg_available:
        pytest.skip("ffmpeg not available")
    return _gen("sine_440hz_5s_mono.wav", [
        ffmpeg_bin(), "-y", "-f", "lavfi",
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
        ffmpeg_bin(), "-y", "-f", "lavfi",
        "-i", "color=c=blue:s=64x64:d=1", "-frames:v", "1",
    ])
    audio = _gen("cover_audio_src.wav", [
        ffmpeg_bin(), "-y", "-f", "lavfi",
        "-i", "sine=frequency=440:duration=5",
        "-ar", "44100", "-acodec", "pcm_s24le", "-ac", "2",
    ])
    path = os.path.join(TEST_DIR, "with_cover_44k.flac")
    if not os.path.exists(path):
        subprocess.run([
            ffmpeg_bin(), "-y", "-i", audio, "-i", cover,
            "-map", "0:a", "-map", "1:v",
            "-c:a", "flac", "-c:v", "copy",
            "-disposition:v:0", "attached_pic",
            path,
        ], check=True, capture_output=True)
    return path
