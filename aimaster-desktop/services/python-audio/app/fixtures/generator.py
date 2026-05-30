"""
Deterministic fixture synthesizer.

For each FixtureMetadata with a `synthetic-recipe` source, this module
produces a WAV file by composing numpy-synthesized "track" components.

The output is a 24-bit PCM WAV cached to /tmp/aimaster-fixtures/<id>.wav
(or $LOUI_FIXTURE_CACHE).  Files are NEVER committed.

Design principles:
  - Deterministic — seeded by fixture.id so the same id always produces
    bit-identical output.  Tests can compare against a sha256 lock.
  - Pure numpy / soundfile — no ffmpeg shell-out for synthesis itself
    (ffmpeg is only used downstream by the mastering pipeline).
  - No music-theory pretensions — the goal is *spectral and dynamic
    realism* sufficient to exercise the mastering chain, not "good music."

Reference: docs/redesign/loui-mastering-v2/m1.5/00-FIXTURE-SYSTEM.md
"""
from __future__ import annotations

import hashlib
import math
import os
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import soundfile as sf

from .loader import CACHE_DIR
from .schema import (
    FixtureMetadata,
    FixtureSourceExternalCC0,
    FixtureSourceSyntheticRecipe,
    FixtureSourceUserSupplied,
)


# ── Random source ──────────────────────────────────────────────────────────


def _rng(fixture_id: str, salt: str = "") -> np.random.Generator:
    """Deterministic RNG seeded by fixture id + salt (so kinds don't collide)."""
    h = hashlib.sha256(f"{fixture_id}::{salt}".encode("utf-8")).digest()
    seed = int.from_bytes(h[:8], "big")
    return np.random.default_rng(seed)


# ── Track-kind synthesizers ────────────────────────────────────────────────
#
# Each takes `params` dict + total `duration_sec` + `sr`, returns float32
# stereo (N, 2) in roughly [-1, 1] BEFORE the track gainDb is applied.


def _kick(params: dict[str, Any], dur: float, sr: int, rng: np.random.Generator) -> np.ndarray:
    """Sine burst with sharp envelope at `rateHz` beats/sec."""
    freq_hz = float(params.get("freqHz", 60))
    rate_hz = float(params.get("rateHz", 1.0))
    decay = float(params.get("decay", 0.3))
    n = int(dur * sr)
    t = np.arange(n) / sr
    period = 1.0 / max(0.1, rate_hz)
    phase = t % period
    env = np.exp(-phase / max(0.02, decay))
    sig = (env * np.sin(2 * np.pi * freq_hz * t)).astype(np.float32)
    return np.column_stack([sig, sig])


def _sub_bass(params: dict[str, Any], dur: float, sr: int, rng: np.random.Generator) -> np.ndarray:
    """Long-decay sine following a note pattern, with optional sidechain duck."""
    notes = list(params.get("noteHz") or [55.0])
    note_dur = dur / max(1, len(notes))
    n = int(dur * sr)
    t = np.arange(n) / sr
    note_idx = np.clip((t / note_dur).astype(int), 0, len(notes) - 1)
    freqs = np.array(notes)[note_idx]
    decay = float(params.get("decay", 0.6))
    sig = np.sin(2 * np.pi * freqs * t)
    # Soft per-note attack envelope
    env = np.minimum(1.0, ((t % note_dur) / 0.05)) * np.exp(-((t % note_dur) / max(0.1, decay)))
    sig = (sig * env).astype(np.float32)
    # Sidechain duck — periodic gain modulation @ sidechainHz
    sc = params.get("sidechainHz")
    if sc:
        sc = float(sc)
        duck = 1.0 - 0.7 * np.exp(-((t % (1.0 / sc)) * 25.0))
        sig *= duck.astype(np.float32)
    return np.column_stack([sig, sig])


def _lead_vocal(params: dict[str, Any], dur: float, sr: int, rng: np.random.Generator) -> np.ndarray:
    """Pseudo-vocal: pitched sine + vibrato + formant-band noise overlay."""
    centre = float(params.get("centerHz", 600))
    vib = float(params.get("vibratoHz", 5.0))
    phrase = list(params.get("phraseHz") or [centre])
    note_dur = dur / max(1, len(phrase))
    n = int(dur * sr)
    t = np.arange(n) / sr
    idx = np.clip((t / note_dur).astype(int), 0, len(phrase) - 1)
    f0 = np.array(phrase)[idx]
    vibrato = 1.0 + 0.02 * np.sin(2 * np.pi * vib * t)
    osc = np.sin(2 * np.pi * f0 * vibrato * t)
    # Formant emphasis = noise filtered around centreHz (cheap shaping)
    noise = rng.standard_normal(n).astype(np.float32) * 0.04
    noise *= np.cos(2 * np.pi * centre * t * 0.5)  # rough band emphasis
    # Phrase envelope (attack/release per note)
    env_pos = (t % note_dur) / note_dur
    env = np.where(env_pos < 0.1, env_pos * 10, np.minimum(1.0, (1 - env_pos) * 2.5))
    sig = (osc * 0.7 + noise) * env
    stereo_offset = float(params.get("stereoOffsetMs", 0))
    if stereo_offset:
        off = int(stereo_offset * sr / 1000)
        right = np.roll(sig, off).astype(np.float32)
    else:
        right = sig.astype(np.float32)
    return np.column_stack([sig.astype(np.float32), right])


def _synth_pad(params: dict[str, Any], dur: float, sr: int, rng: np.random.Generator) -> np.ndarray:
    """Sustained chord = sum of sines, optional sidechain duck."""
    chord = list(params.get("chordHz") or [220.0, 277.0, 330.0])
    n = int(dur * sr)
    t = np.arange(n) / sr
    sig = np.zeros(n, dtype=np.float64)
    for f in chord:
        # Slight detune + saw-like overtone series
        sig += np.sin(2 * np.pi * f * t) * 0.6
        sig += np.sin(2 * np.pi * (f * 2.001) * t) * 0.2
        sig += np.sin(2 * np.pi * (f * 3.002) * t) * 0.1
    sig /= max(1, len(chord))
    # Optional LPF (cheap one-pole)
    lpf = params.get("lpfHz")
    if lpf:
        sig = _one_pole_lpf(sig, float(lpf), sr)
    sc = params.get("sidechainHz")
    if sc:
        sc = float(sc)
        duck = 1.0 - 0.5 * np.exp(-((t % (1.0 / sc)) * 25.0))
        sig *= duck
    so_ms = float(params.get("stereoOffsetMs", 0))
    sig32 = sig.astype(np.float32)
    if so_ms:
        off = int(so_ms * sr / 1000)
        right = np.roll(sig32, off)
    else:
        right = sig32
    return np.column_stack([sig32, right])


def _soft_snare(params: dict[str, Any], dur: float, sr: int, rng: np.random.Generator) -> np.ndarray:
    """Bandpass noise burst at `rateHz`."""
    rate = float(params.get("rateHz", 1.0))
    centre = float(params.get("centerHz", 200))
    n = int(dur * sr)
    t = np.arange(n) / sr
    noise = rng.standard_normal(n).astype(np.float32)
    # Cheap bandpass via two cascaded one-poles
    bp = _one_pole_lpf(noise.astype(np.float64), centre * 2.5, sr)
    bp -= _one_pole_lpf(bp, centre * 0.5, sr)
    period = 1.0 / max(0.1, rate)
    env = np.exp(-((t % period) * 35.0))
    sig = (bp * env).astype(np.float32)
    return np.column_stack([sig, sig])


def _hi_hat(params: dict[str, Any], dur: float, sr: int, rng: np.random.Generator) -> np.ndarray:
    """High-passed noise burst pattern."""
    rate = float(params.get("rateHz", 4.0))
    hpf = float(params.get("hpfHz", 6000))
    n = int(dur * sr)
    t = np.arange(n) / sr
    noise = rng.standard_normal(n).astype(np.float64)
    hp = noise - _one_pole_lpf(noise, hpf, sr)
    period = 1.0 / max(0.5, rate)
    env = np.exp(-((t % period) * 70.0))
    sig = (hp * env).astype(np.float32)
    return np.column_stack([sig, sig])


def _air_shimmer(params: dict[str, Any], dur: float, sr: int, rng: np.random.Generator) -> np.ndarray:
    """Slow-tremolo'd high-frequency noise above centreHz."""
    centre = float(params.get("centerHz", 12000))
    n = int(dur * sr)
    t = np.arange(n) / sr
    noise = rng.standard_normal(n).astype(np.float64)
    hp = noise - _one_pole_lpf(noise, centre, sr)
    env = 0.5 + 0.5 * np.sin(2 * np.pi * 0.4 * t)
    sig = (hp * env).astype(np.float32)
    so = int(0.005 * sr)
    return np.column_stack([sig, np.roll(sig, so)])


def _guitar_pluck(params: dict[str, Any], dur: float, sr: int, rng: np.random.Generator) -> np.ndarray:
    """Karplus-Strong-ish: pitched decaying tone per note."""
    phrase = list(params.get("phraseHz") or [110.0])
    decay = float(params.get("decay", 0.5))
    note_dur = dur / max(1, len(phrase))
    n = int(dur * sr)
    t = np.arange(n) / sr
    idx = np.clip((t / note_dur).astype(int), 0, len(phrase) - 1)
    f0 = np.array(phrase)[idx]
    osc = np.sin(2 * np.pi * f0 * t) + 0.3 * np.sin(2 * np.pi * 2 * f0 * t)
    env = np.exp(-((t % note_dur) / max(0.05, decay))) * (1 - np.exp(-((t % note_dur) * 200)))
    sig = (osc * env * 0.4).astype(np.float32)
    return np.column_stack([sig, np.roll(sig, int(0.003 * sr))])


def _guitar_body(params: dict[str, Any], dur: float, sr: int, rng: np.random.Generator) -> np.ndarray:
    centre = float(params.get("centerHz", 140))
    n = int(dur * sr)
    noise = rng.standard_normal(n).astype(np.float64)
    bp = _one_pole_lpf(noise, centre * 2.0, sr) - _one_pole_lpf(noise, centre * 0.5, sr)
    sig = bp.astype(np.float32) * 0.4
    return np.column_stack([sig, sig])


def _vinyl_noise(params: dict[str, Any], dur: float, sr: int, rng: np.random.Generator) -> np.ndarray:
    """Pink-ish noise + occasional clicks."""
    n = int(dur * sr)
    noise = rng.standard_normal(n).astype(np.float64)
    pink = _one_pole_lpf(noise, 3000, sr)
    # Sparse clicks
    n_clicks = int(dur * 4)
    click_times = rng.uniform(0, n, n_clicks).astype(int)
    for ct in click_times:
        if ct + 32 < n:
            pink[ct:ct + 32] += rng.standard_normal(32) * 0.5
    sig = (pink * 0.3).astype(np.float32)
    return np.column_stack([sig, np.roll(sig, int(0.001 * sr))])


def _string_pad(params: dict[str, Any], dur: float, sr: int, rng: np.random.Generator) -> np.ndarray:
    chord = list(params.get("chordHz") or [110.0, 165.0, 220.0])
    hpf = float(params.get("hpfHz", 0))
    n = int(dur * sr)
    t = np.arange(n) / sr
    sig = np.zeros(n, dtype=np.float64)
    for f in chord:
        sig += np.sin(2 * np.pi * f * t) + 0.4 * np.sin(2 * np.pi * 2.001 * f * t)
    sig /= max(1, len(chord))
    if hpf > 0:
        sig = sig - _one_pole_lpf(sig, hpf, sr)
    # Slow attack
    attack_env = np.minimum(1.0, t / 3.0)
    sig = (sig * attack_env * 0.5).astype(np.float32)
    return np.column_stack([sig, np.roll(sig, int(0.004 * sr))])


def _chest_resonance(params: dict[str, Any], dur: float, sr: int, rng: np.random.Generator) -> np.ndarray:
    return _guitar_body(params, dur, sr, rng)


def _vocal_sibilance(params: dict[str, Any], dur: float, sr: int, rng: np.random.Generator) -> np.ndarray:
    """Intermittent sibilance noise at centreHz."""
    centre = float(params.get("centerHz", 7000))
    rate = float(params.get("rateHz", 0.5))
    n = int(dur * sr)
    t = np.arange(n) / sr
    noise = rng.standard_normal(n).astype(np.float64)
    hp = noise - _one_pole_lpf(noise, centre, sr)
    period = 1.0 / max(0.1, rate)
    env = np.exp(-((t % period) * 8.0))
    sig = (hp * env).astype(np.float32)
    return np.column_stack([sig, sig])


def _soft_piano(params: dict[str, Any], dur: float, sr: int, rng: np.random.Generator) -> np.ndarray:
    """Repeated decaying notes from a phrase list."""
    return _guitar_pluck(params, dur, sr, rng)


_KIND_HANDLERS = {
    "kick":            _kick,
    "sub-bass":        _sub_bass,
    "lead-vocal":      _lead_vocal,
    "synth-pad":       _synth_pad,
    "soft-snare":      _soft_snare,
    "hi-hat":          _hi_hat,
    "air-shimmer":     _air_shimmer,
    "guitar-pluck":    _guitar_pluck,
    "guitar-body":     _guitar_body,
    "vinyl-noise":     _vinyl_noise,
    "string-pad":      _string_pad,
    "chest-resonance": _chest_resonance,
    "vocal-sibilance": _vocal_sibilance,
    "soft-piano":      _soft_piano,
    "lead-synth":      _lead_vocal,  # alias — similar synthesis
}


# ── DSP helpers ────────────────────────────────────────────────────────────


def _one_pole_lpf(x: np.ndarray, cutoff_hz: float, sr: int) -> np.ndarray:
    """
    Apply a first-order LPF *magnitude response* via FFT.

    Equivalent magnitude to a one-pole RC LPF (|H(f)| = 1 / √(1 + (f/fc)²))
    but evaluated in the frequency domain — O(N log N), pure numpy, no loop.
    The phase is zero (not the same as a one-pole's lag), which is fine for
    fixture spectral shaping.
    """
    n = x.shape[0]
    if n == 0:
        return x
    X = np.fft.rfft(x.astype(np.float64))
    freqs = np.fft.rfftfreq(n, d=1.0 / sr)
    mag = 1.0 / np.sqrt(1.0 + (freqs / max(1.0, cutoff_hz)) ** 2)
    return np.fft.irfft(X * mag, n)


def _apply_db(arr: np.ndarray, db: float) -> np.ndarray:
    if db == 0:
        return arr
    return arr * (10 ** (db / 20.0))


def _biquad_peaking(
    x: np.ndarray, sr: int, freq_hz: float, q: float, gain_db: float
) -> np.ndarray:
    """
    Apply a peaking EQ *magnitude response* via FFT.

    Uses a log-frequency Gaussian bump that approximates the RBJ peaking-EQ
    magnitude near the centre frequency (within ~0.5 dB across the audible
    bandwidth — sufficient for fixture shaping).  Pure numpy, no loop.
    """
    n = x.shape[0]
    if n == 0:
        return x
    X = np.fft.rfft(x.astype(np.float64))
    freqs = np.fft.rfftfreq(n, d=1.0 / sr)
    # Avoid log(0) at DC bin.
    eps = 1e-6
    log_f  = np.log2(np.maximum(freqs, eps) / max(eps, freq_hz))
    bandwidth_oct = 1.0 / max(0.1, q)            # octaves
    sigma = bandwidth_oct / 2.355                # ≈ FWHM → σ
    bump_db = gain_db * np.exp(-(log_f ** 2) / (2 * sigma ** 2))
    mag = 10 ** (bump_db / 20.0)
    return np.fft.irfft(X * mag, n)


def _packed_compressor(
    x: np.ndarray, threshold_db: float, ratio: float, makeup_db: float
) -> np.ndarray:
    """Vectorized memory-less static compressor (no envelope smoothing)."""
    if ratio <= 1.0:
        return x * (10 ** (makeup_db / 20))
    thr_lin = 10 ** (threshold_db / 20)
    a = np.abs(x) + 1e-12
    # over ≥ 1 above threshold, =1 below
    over = np.maximum(a / thr_lin, 1.0)
    # Reduction exponent: |y|/|x| = over^(-(1 - 1/ratio))
    gain = over ** -(1.0 - 1.0 / ratio)
    return x * gain * (10 ** (makeup_db / 20))


# ── Recipe builders ────────────────────────────────────────────────────────


def _build_multitrack_mix(meta: FixtureMetadata) -> np.ndarray:
    """Sum N synthesized tracks with per-track gainDb, return stereo float32."""
    if not isinstance(meta.source, FixtureSourceSyntheticRecipe):
        raise TypeError("expected synthetic-recipe source")
    params = meta.source.params
    dur = meta.characteristics.durationSec
    sr = meta.characteristics.sampleRate
    tracks: list[np.ndarray] = []
    for i, track_params in enumerate(params.get("tracks") or []):
        kind = track_params.get("kind")
        if kind not in _KIND_HANDLERS:
            raise ValueError(f"unknown track kind: {kind!r}")
        rng = _rng(meta.id, f"{kind}/{i}")
        sig = _KIND_HANDLERS[kind](track_params, dur, sr, rng)
        gain_db = float(track_params.get("gainDb", -18))
        tracks.append(_apply_db(sig, gain_db))
    if not tracks:
        raise ValueError("multitrack-mix recipe must include ≥1 track")

    # Pad / truncate to same length (handles minor rounding differences).
    min_n = min(t.shape[0] for t in tracks)
    mix = np.zeros((min_n, 2), dtype=np.float32)
    for t in tracks:
        mix += t[:min_n]

    # Mix headroom trim.
    mix = _apply_db(mix, float(params.get("preMasterTrimDb", -6.0)))

    so = float(params.get("stereoOffsetMs", 0))
    if so:
        off = int(so * sr / 1000)
        mix[:, 0] = np.roll(mix[:, 0], off)

    return np.clip(mix, -0.999, 0.999).astype(np.float32)


def _build_ai_harsh(meta: FixtureMetadata) -> np.ndarray:
    """Synthesize the intentionally-harsh AI defect pattern."""
    if not isinstance(meta.source, FixtureSourceSyntheticRecipe):
        raise TypeError("expected synthetic-recipe source")
    params = meta.source.params
    dur = meta.characteristics.durationSec
    sr = meta.characteristics.sampleRate
    n = int(dur * sr)
    t = np.arange(n) / sr

    # Base mix — pop-like content: pseudo-vocal + bass + drums.
    rng = _rng(meta.id, "base")
    base_left = (
        np.sin(2 * np.pi * 440 * t) * 0.4              # vocal
        + np.sin(2 * np.pi * 110 * t) * 0.3            # bass
        + np.exp(-((t % 0.5) * 8)) * np.sin(2 * np.pi * 60 * t) * 0.4  # kick
    )
    base_right = base_left.copy()

    # Phasey stereo — delay left channel a few ms and notch one band on right.
    ps = params.get("phaseyStereo") or {}
    ldelay_ms = float(ps.get("leftDelayMs", 8.0))
    base_left = np.roll(base_left, int(ldelay_ms * sr / 1000))

    # Apply harsh peak EQ.
    hp = params.get("harshPeak") or {}
    base_left = _biquad_peaking(
        base_left, sr,
        float(hp.get("centerHz", 3500)),
        float(hp.get("q", 0.8)),
        float(hp.get("gainDb", 8.0)),
    )
    base_right = _biquad_peaking(
        base_right, sr,
        float(hp.get("centerHz", 3500)),
        float(hp.get("q", 0.8)),
        float(hp.get("gainDb", 8.0)),
    )

    # Apply sub rumble.
    sub = params.get("subRumble") or {}
    base_left += _biquad_peaking(
        rng.standard_normal(n).astype(np.float64) * 0.05,
        sr,
        float(sub.get("centerHz", 40)),
        float(sub.get("q", 0.5)),
        float(sub.get("gainDb", 6.0)),
    )
    base_right += _biquad_peaking(
        rng.standard_normal(n).astype(np.float64) * 0.05,
        sr,
        float(sub.get("centerHz", 40)),
        float(sub.get("q", 0.5)),
        float(sub.get("gainDb", 6.0)),
    )

    # Pre-packed dynamics — apply a heavy compressor (like an over-cooked mix).
    cp = params.get("prePackedDynamics") or {}
    base_left = _packed_compressor(
        base_left,
        float(cp.get("thresholdDb", -12)),
        float(cp.get("compressorRatio", 8.0)),
        float(cp.get("makeupDb", 6)),
    )
    base_right = _packed_compressor(
        base_right,
        float(cp.get("thresholdDb", -12)),
        float(cp.get("compressorRatio", 8.0)),
        float(cp.get("makeupDb", 6)),
    )

    # Hard-clip near 0 dBFS for the brickwall feel.
    clip_db = float(params.get("clippingDb", -0.2))
    clip_lin = 10 ** (clip_db / 20)
    base_left = np.clip(base_left, -clip_lin, clip_lin)
    base_right = np.clip(base_right, -clip_lin, clip_lin)

    mix = np.column_stack([base_left, base_right]).astype(np.float32)
    return mix


# ── Public API ─────────────────────────────────────────────────────────────


@dataclass
class FixtureMaterialisationResult:
    """Result of bringing a fixture's WAV into existence."""

    metadata: FixtureMetadata
    wavPath: Path
    sha256: str
    cached: bool      # True if WAV pre-existed in cache (no synth ran)


def _file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _resolve_synthetic(meta: FixtureMetadata) -> np.ndarray:
    src = meta.source
    if not isinstance(src, FixtureSourceSyntheticRecipe):
        raise TypeError("not a synthetic-recipe fixture")
    recipe = src.recipe
    if recipe == "multitrack-mix":
        return _build_multitrack_mix(meta)
    if recipe == "ai-harsh-mix":
        return _build_ai_harsh(meta)
    raise ValueError(f"unknown synthetic recipe: {recipe!r}")


def _resolve_external(meta: FixtureMetadata, cache_path: Path) -> None:
    src = meta.source
    if not isinstance(src, FixtureSourceExternalCC0):
        raise TypeError("not an external-cc0 fixture")
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    urllib.request.urlretrieve(src.url, cache_path)  # noqa: S310 — URL in trusted metadata
    sha = _file_sha256(cache_path)
    if sha != src.sha256:
        cache_path.unlink(missing_ok=True)
        raise ValueError(
            f"sha256 mismatch for fixture {meta.id}: expected {src.sha256}, got {sha}"
        )


def _resolve_user_supplied(meta: FixtureMetadata) -> Path:
    src = meta.source
    if not isinstance(src, FixtureSourceUserSupplied):
        raise TypeError("not a user-supplied fixture")
    root = os.environ.get("LOUI_FIXTURE_DIR")
    if not root:
        raise EnvironmentError(
            f"fixture {meta.id} requires LOUI_FIXTURE_DIR env var pointing to a directory "
            f"containing {src.relativePath}"
        )
    p = Path(root) / src.relativePath
    if not p.exists():
        raise FileNotFoundError(f"user-supplied fixture not found: {p}")
    return p


def materialise_fixture(
    meta: FixtureMetadata,
    *,
    cache_dir: Path | None = None,
) -> FixtureMaterialisationResult:
    """
    Bring `meta`'s WAV into existence on disk and return its path.

    Synthetic recipes are cached to {cache_dir or CACHE_DIR}/{id}.wav.
    Re-synthesis is suppressed when the cache already exists (deterministic
    output guarantees this is safe).
    """
    cache_dir = cache_dir or CACHE_DIR
    cache_dir.mkdir(parents=True, exist_ok=True)
    wav_path = cache_dir / f"{meta.id}.wav"

    src = meta.source

    if isinstance(src, FixtureSourceUserSupplied):
        p = _resolve_user_supplied(meta)
        return FixtureMaterialisationResult(
            metadata=meta, wavPath=p, sha256=_file_sha256(p), cached=True
        )

    if wav_path.exists():
        return FixtureMaterialisationResult(
            metadata=meta, wavPath=wav_path,
            sha256=_file_sha256(wav_path), cached=True,
        )

    if isinstance(src, FixtureSourceSyntheticRecipe):
        mix = _resolve_synthetic(meta)
        sf.write(
            str(wav_path),
            mix,
            meta.characteristics.sampleRate,
            subtype="PCM_24",
        )
    elif isinstance(src, FixtureSourceExternalCC0):
        _resolve_external(meta, wav_path)
    else:
        raise TypeError(f"unsupported source type: {type(src).__name__}")

    return FixtureMaterialisationResult(
        metadata=meta, wavPath=wav_path,
        sha256=_file_sha256(wav_path), cached=False,
    )


def materialise_all_builtin() -> list[FixtureMaterialisationResult]:
    """Materialise every recipe in this package — useful for test prep."""
    from .loader import list_builtin_fixtures, load_builtin_fixture
    out: list[FixtureMaterialisationResult] = []
    for name in list_builtin_fixtures():
        meta = load_builtin_fixture(name)
        out.append(materialise_fixture(meta))
    return out


def _iter_tracks(params: dict[str, Any]) -> Iterable[dict[str, Any]]:
    """Helper for tests — yields each track param dict."""
    return iter(params.get("tracks") or [])
