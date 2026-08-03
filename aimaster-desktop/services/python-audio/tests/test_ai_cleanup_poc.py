"""
Unit tests for the AI Cleanup PoC (test-only feature).

Fixtures are SYNTHESIZED with numpy/soundfile — no copyrighted / Suno audio is
added to the repo.  Tests that require actual denoise processing are skipped
when no FFmpeg denoise filter (afftdn/anlmdn) is available in the environment;
the rest (extraction, schema, safety logic, fallback, input-immutability) run
with numpy/soundfile alone.

Run:  pytest tests/test_ai_cleanup_poc.py -v
"""
from __future__ import annotations

import hashlib
import json
import os

import pytest

np = pytest.importorskip("numpy")
sf = pytest.importorskip("soundfile")

from app.mastering import ai_cleanup_poc as poc  # noqa: E402

# ── Environment capability probe ─────────────────────────────────────────────
_PROBE = poc.probe_filters()
_HAS_DENOISE = poc.select_filter(_PROBE, "auto") is not None
requires_ffmpeg = pytest.mark.skipif(
    not _HAS_DENOISE, reason="no FFmpeg denoise filter (afftdn/anlmdn) available"
)

SR = 44100


# ── Fixture synthesis helpers ────────────────────────────────────────────────

def _write(path: str, data, sr: int = SR, subtype: str = "PCM_24") -> str:
    sf.write(path, np.asarray(data, dtype=np.float32), sr, subtype=subtype)
    return path


def _t(n: int, sr: int = SR):
    return np.arange(n) / sr


def _stereo(mono):
    return np.stack([mono, mono], axis=1)


@pytest.fixture
def clean_sine(tmp_path):
    n = SR * 3
    tone = 0.3 * np.sin(2 * np.pi * 440 * _t(n))
    return _write(str(tmp_path / "clean.wav"), _stereo(tone))


@pytest.fixture
def hf_noise(tmp_path):
    n = SR * 3
    rng = np.random.default_rng(1)
    tone = 0.25 * np.sin(2 * np.pi * 440 * _t(n))
    # broadband noise (includes strong HF content the denoiser should reduce)
    noise = 0.05 * rng.standard_normal((n, 2))
    x = _stereo(tone) + noise
    return _write(str(tmp_path / "hfnoise.wav"), x)


@pytest.fixture
def tonal_whistle(tmp_path):
    n = SR * 3
    tone = 0.3 * np.sin(2 * np.pi * 440 * _t(n))
    whistle = 0.02 * np.sin(2 * np.pi * 12000 * _t(n))
    return _write(str(tmp_path / "whistle.wav"), _stereo(tone + whistle))


@pytest.fixture
def stereo_decorrelated(tmp_path):
    n = SR * 3
    rng = np.random.default_rng(2)
    l = 0.2 * np.sin(2 * np.pi * 440 * _t(n)) + 0.03 * rng.standard_normal(n)
    r = 0.2 * np.sin(2 * np.pi * 441 * _t(n)) + 0.03 * rng.standard_normal(n)
    return _write(str(tmp_path / "stereo.wav"), np.stack([l, r], axis=1))


@pytest.fixture
def impulse(tmp_path):
    n = SR * 2
    x = np.zeros((n, 2), dtype=np.float32)
    x[::SR // 2] = 0.8  # transient clicks every 0.5 s
    return _write(str(tmp_path / "impulse.wav"), x)


@pytest.fixture
def silence(tmp_path):
    return _write(str(tmp_path / "silence.wav"), np.zeros((SR * 2, 2)))


@pytest.fixture
def very_short(tmp_path):
    n = SR // 5  # 0.2 s
    tone = 0.3 * np.sin(2 * np.pi * 440 * _t(n))
    return _write(str(tmp_path / "short.wav"), _stereo(tone))


def _sha256(path: str) -> str:
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


# ── Probe / selection ────────────────────────────────────────────────────────

def test_probe_returns_schema():
    p = poc.probe_filters()
    for key in ("ffmpegPath", "available", "afftdn", "anlmdn", "arnndn"):
        assert key in p
    assert isinstance(p["afftdn"], bool)


def test_arnndn_never_selected():
    fake = {"available": True, "afftdn": False, "anlmdn": False, "arnndn": True}
    assert poc.select_filter(fake, "auto") is None


def test_select_prefers_afftdn():
    both = {"available": True, "afftdn": True, "anlmdn": True, "arnndn": False}
    assert poc.select_filter(both, "auto") == "afftdn"
    assert poc.select_filter(both, "anlmdn") == "anlmdn"


# ── Strength presets ─────────────────────────────────────────────────────────

def test_strength_monotonic():
    g = poc.get_strength_preset("gentle")
    b = poc.get_strength_preset("balanced")
    s = poc.get_strength_preset("strong")
    assert g.afftdn["nr"] < b.afftdn["nr"] < s.afftdn["nr"]
    assert g.anlmdn["s"] < b.anlmdn["s"] < s.anlmdn["s"]
    assert g.maximum_reduction_db < b.maximum_reduction_db < s.maximum_reduction_db
    assert s.warn is True


def test_graph_builder_no_lowpass():
    g = poc.build_highband_denoise_graph("afftdn", {"nr": 6.0, "nf": -40.0})
    assert "acrossover=split=6000" in g
    assert "amix=inputs=2:normalize=0" in g
    assert "afftdn=" in g
    # the low band must be recombined (not discarded) — no bare low/high-cut
    assert "[low][hi]amix" in g


# ── Extraction ───────────────────────────────────────────────────────────────

def test_extract_preserves_format(clean_sine, tmp_path):
    out = str(tmp_path / "seg.wav")
    seg = poc.extract_segment(clean_sine, out, start_sec=0.5, duration_sec=1.0)
    data, sr = sf.read(out, always_2d=True)
    assert sr == SR
    assert data.shape[1] == 2
    assert abs(data.shape[0] - SR) <= 2  # ~1 second
    assert seg.clamped is False


def test_extract_clamps_when_beyond_eof(clean_sine, tmp_path):
    out = str(tmp_path / "seg.wav")
    seg = poc.extract_segment(clean_sine, out, start_sec=999.0, duration_sec=30.0)
    assert seg.clamped is True
    assert seg.duration_sec <= 3.0 + 0.01
    assert os.path.exists(out)


def test_extract_very_short_ok(very_short, tmp_path):
    out = str(tmp_path / "seg.wav")
    seg = poc.extract_segment(very_short, out, start_sec=0.0, duration_sec=15.0)
    assert seg.duration_sec <= 0.21
    data, sr = sf.read(out, always_2d=True)
    assert data.shape[0] > 0 and sr == SR


# ── Input immutability ───────────────────────────────────────────────────────

@requires_ffmpeg
def test_input_never_modified(hf_noise, tmp_path):
    before = _sha256(hf_noise)
    poc.run_poc(hf_noise, str(tmp_path / "out"), duration_sec=5.0, strength="gentle")
    assert _sha256(hf_noise) == before


def test_input_never_modified_dry_run(hf_noise, tmp_path):
    before = _sha256(hf_noise)
    poc.run_poc(hf_noise, str(tmp_path / "out"), duration_sec=5.0, dry_run=True)
    assert _sha256(hf_noise) == before


def test_output_never_collides_with_input(clean_sine):
    # output-dir == input's dir with the input literally named original.wav
    d = os.path.dirname(clean_sine)
    orig_named = os.path.join(d, "original.wav")
    os.replace(clean_sine, orig_named)
    with pytest.raises(ValueError):
        poc.run_poc(orig_named, d, duration_sec=5.0)


# ── Invalid input / fallback ─────────────────────────────────────────────────

def test_invalid_path_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        poc.run_poc(str(tmp_path / "nope.wav"), str(tmp_path / "out"))


def test_filter_unsupported_fallback(hf_noise, tmp_path):
    # Point at a non-existent ffmpeg → probe unavailable → skip, non-fatal.
    out = str(tmp_path / "out")
    report = poc.run_poc(
        hf_noise, out, duration_sec=5.0,
        ffmpeg_path="/nonexistent/ffmpeg-binary-xyz",
    )
    assert report["probe"]["available"] is False
    assert report["probe"]["selectedFilter"] is None
    assert report["after"] is None
    assert report["skipReason"] is not None
    # original is still produced; cleaned/difference are not
    assert os.path.exists(os.path.join(out, "original.wav"))
    assert not os.path.exists(os.path.join(out, "cleaned.wav"))
    assert report["safety"]["passed"] is True  # non-destructive skip


# ── Report schema ────────────────────────────────────────────────────────────

def test_report_schema_required_fields(hf_noise, tmp_path):
    report = poc.run_poc(hf_noise, str(tmp_path / "out"), duration_sec=5.0, dry_run=True)
    for key in ("version", "input", "probe", "settings", "before", "after",
                "delta", "difference", "safety", "processingTimeMs"):
        assert key in report, f"missing {key}"
    assert report["version"] == poc.REPORT_VERSION
    for key in ("fileName", "startSec", "durationSec", "sampleRate", "channels"):
        assert key in report["input"]
    for key in ("ffmpegPath", "afftdn", "anlmdn", "arnndn", "selectedFilter"):
        assert key in report["probe"]
    # JSON-serializable
    json.dumps(report)


# ── Processing (require ffmpeg) ──────────────────────────────────────────────

@requires_ffmpeg
def test_cleanup_preserves_length_sr_channels(hf_noise, tmp_path):
    out = str(tmp_path / "out")
    report = poc.run_poc(hf_noise, out, duration_sec=5.0, strength="gentle")
    assert report["after"] is not None
    a, b = report["after"], report["before"]
    assert a["sampleRate"] == b["sampleRate"]
    assert a["channels"] == b["channels"]
    assert a["durationSec"] == pytest.approx(b["durationSec"], abs=0.01)
    assert report["difference"]["lengthMatches"] is True


@requires_ffmpeg
def test_cleanup_finite_output(hf_noise, tmp_path):
    out = str(tmp_path / "out")
    report = poc.run_poc(hf_noise, out, duration_sec=5.0, strength="balanced")
    assert report["after"]["isFinite"] is True


@requires_ffmpeg
def test_hf_reduced_on_noise(hf_noise, tmp_path):
    out = str(tmp_path / "out")
    report = poc.run_poc(hf_noise, out, duration_sec=5.0, strength="balanced")
    assert report["after"]["hfEnergyRatio"] <= report["before"]["hfEnergyRatio"]


@requires_ffmpeg
def test_gentle_reduces_less_than_strong(hf_noise, tmp_path):
    rg = poc.run_poc(hf_noise, str(tmp_path / "g"), duration_sec=5.0, strength="gentle")
    rs = poc.run_poc(hf_noise, str(tmp_path / "s"), duration_sec=5.0, strength="strong")
    before = rg["before"]["hfEnergyRatio"]
    drop_gentle = before - rg["after"]["hfEnergyRatio"]
    drop_strong = before - rs["after"]["hfEnergyRatio"]
    assert drop_strong >= drop_gentle - 1e-6


@requires_ffmpeg
def test_difference_alignment(hf_noise, tmp_path):
    out = str(tmp_path / "out")
    poc.run_poc(hf_noise, out, duration_sec=5.0, strength="gentle")
    o, sro = sf.read(os.path.join(out, "original.wav"), always_2d=True)
    d, srd = sf.read(os.path.join(out, "difference.wav"), always_2d=True)
    assert o.shape == d.shape and sro == srd


@requires_ffmpeg
def test_silence_stable(silence, tmp_path):
    out = str(tmp_path / "out")
    report = poc.run_poc(silence, out, duration_sec=2.0, strength="gentle")
    # must not crash; if a cleaned file was produced it must be finite
    if report["after"] is not None:
        assert report["after"]["isFinite"] is True


@requires_ffmpeg
def test_clean_signal_not_over_damaged(clean_sine, tmp_path):
    out = str(tmp_path / "out")
    report = poc.run_poc(clean_sine, out, duration_sec=3.0, strength="gentle")
    # A clean tone should not trip vocal-band or HF failures at gentle strength.
    assert "2-6 kHz vocal-clarity energy dropped" not in " ".join(report["safety"]["failures"])
    assert report["after"]["isFinite"] is True
