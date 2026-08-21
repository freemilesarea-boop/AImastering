"""
AI Cleanup — PoC helper module (TEST-ONLY, NOT wired into the commercial pipeline).

This module is deliberately isolated:
  · It is NOT imported by `run_pipeline`, `master_file`, any IPC handler,
    any preset, or the renderer.  Nothing in the shipping Export path
    touches it.  It exists solely so `scripts/ai_cleanup_poc.py` (and its
    unit tests) can validate a high-frequency-limited denoise idea on a
    short segment, off to the side.
  · It never modifies the input file.
  · It uses ONLY the already-bundled deps: numpy + soundfile (Python side)
    and the bundled FFmpeg binary (afftdn / anlmdn).  No scipy, no librosa,
    no ML model, no new dependency.

Processing concept (see build_highband_denoise_graph):
    input → acrossover(split=highBandStartHz) → [low band] + [high band]
          → denoise ONLY the high band (afftdn or anlmdn)
          → amix(normalize=0) recombine  → output
    Low/mid content is passed through the phase-coherent low band untouched;
    there is NO plain low-pass / high-cut of the highs.

All heavy numeric helpers degrade gracefully (return None / skip) when
numpy/soundfile are unavailable so the module import never hard-crashes.
"""
from __future__ import annotations

import math
import os
import subprocess
import time
from dataclasses import dataclass, field
from typing import Any, Optional

try:
    import numpy as np
    import soundfile as sf
    _HAS_SF = True
except ImportError:  # pragma: no cover - exercised only on a broken env
    _HAS_SF = False


# ── Constants ────────────────────────────────────────────────────────────────

REPORT_VERSION = 1

#: Default high-band crossover — everything at/above this Hz is denoised.
DEFAULT_HIGH_BAND_START_HZ = 6000.0

#: Linkwitz-Riley crossover order used by acrossover (4th = 24 dB/oct).
_CROSSOVER_ORDER = "4th"

DEFAULT_DURATION_SEC = 15.0
MIN_DURATION_SEC = 5.0
MAX_DURATION_SEC = 30.0

#: arnndn is intentionally never selected for processing (needs a model file).
_USABLE_FILTERS = ("afftdn", "anlmdn")
_PROBED_FILTERS = ("afftdn", "anlmdn", "arnndn")


# ── Strength presets ─────────────────────────────────────────────────────────
# Conservative by design.  `maximumReductionDb` is the DESIGN-INTENT ceiling
# reported to the user (not a hard FFmpeg-enforced limit).  The actual filter
# parameters are only the options this FFmpeg build is known to expose (see the
# probe in scripts/ai_cleanup_poc.py — options are verified, never guessed):
#   afftdn: nr = noise_reduction (0.01..97), nf = noise_floor dB (-80..-20)
#   anlmdn: s  = strength, m = smooth
@dataclass(frozen=True)
class StrengthPreset:
    name: str
    maximum_reduction_db: float
    afftdn: dict[str, float]
    anlmdn: dict[str, float]
    warn: bool = False


STRENGTH_PRESETS: dict[str, StrengthPreset] = {
    "gentle": StrengthPreset(
        name="gentle",
        maximum_reduction_db=4.0,
        afftdn={"nr": 6.0, "nf": -40.0},
        anlmdn={"s": 0.0004, "m": 11.0},
    ),
    "balanced": StrengthPreset(
        name="balanced",
        maximum_reduction_db=7.0,
        afftdn={"nr": 12.0, "nf": -35.0},
        anlmdn={"s": 0.0020, "m": 11.0},
    ),
    "strong": StrengthPreset(
        name="strong",
        maximum_reduction_db=10.0,
        afftdn={"nr": 20.0, "nf": -30.0},
        anlmdn={"s": 0.0060, "m": 13.0},
        warn=True,
    ),
}


def get_strength_preset(strength: str) -> StrengthPreset:
    return STRENGTH_PRESETS.get(strength, STRENGTH_PRESETS["gentle"])


# ── Safety thresholds (conservative initial values; see spec §7) ─────────────

@dataclass(frozen=True)
class SafetyThresholds:
    lufs_warn: float = 0.5          # |ΔLUFS| > → warning
    lufs_fail: float = 1.0          # |ΔLUFS| > → fail
    corr_warn: float = 0.10         # |Δcorrelation| > → warning
    corr_fail: float = 0.20         # |Δcorrelation| > → fail
    hf_drop_warn: float = 0.35      # HF energy dropped > 35% → warning
    hf_drop_fail: float = 0.50      # HF energy dropped > 50% → fail
    vocal_drop_warn: float = 0.10   # 2-6 kHz energy dropped > 10% → warning
    vocal_drop_fail: float = 0.20   # 2-6 kHz energy dropped > 20% → fail
    tp_rise_fail_dbtp: float = 0.5  # True peak rose > 0.5 dBTP → fail


DEFAULT_THRESHOLDS = SafetyThresholds()


# ── FFmpeg binary resolution + filter probe ──────────────────────────────────

def resolve_ffmpeg() -> str:
    """Same resolution order as app.utils.ffmpeg_wrapper (env → PATH)."""
    return os.environ.get("AIMASTER_FFMPEG", "ffmpeg")


def probe_filters(ffmpeg_path: Optional[str] = None) -> dict[str, Any]:
    """
    Probe the FFmpeg binary for the denoise filters we care about.

    Never raises: returns a dict with `available=False` + `error` when the
    binary is missing or the probe fails.
    """
    ffmpeg_path = ffmpeg_path or resolve_ffmpeg()
    result: dict[str, Any] = {
        "ffmpegPath": ffmpeg_path,
        "available": False,
        "afftdn": False,
        "anlmdn": False,
        "arnndn": False,
        "selectedFilter": None,
        "error": None,
    }
    try:
        proc = subprocess.run(
            [ffmpeg_path, "-hide_banner", "-filters"],
            capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=20,
        )
    except FileNotFoundError:
        result["error"] = "ffmpeg binary not found"
        return result
    except subprocess.TimeoutExpired:
        result["error"] = "ffmpeg -filters probe timed out"
        return result
    except Exception as exc:  # pragma: no cover - defensive
        result["error"] = f"probe failed: {type(exc).__name__}"
        return result

    if proc.returncode != 0:
        result["error"] = f"ffmpeg -filters exited {proc.returncode}"
        return result

    listing = proc.stdout or ""
    result["available"] = True
    for name in _PROBED_FILTERS:
        # Filter rows look like: " TSC afftdn   A->A  Denoise audio ..."
        # Match the filter name as a standalone token to avoid substrings.
        result[name] = any(
            name in line.split() for line in listing.splitlines()
        )
    return result


def select_filter(probe: dict[str, Any], requested: str = "auto") -> Optional[str]:
    """
    Decide which filter to use.  arnndn is never selected (needs a model).
    Returns the filter name, or None if nothing usable is available.
    """
    if not probe.get("available"):
        return None
    if requested in _USABLE_FILTERS:
        return requested if probe.get(requested) else None
    # auto (or unknown value): prefer afftdn, then anlmdn.
    for name in _USABLE_FILTERS:
        if probe.get(name):
            return name
    return None


# ── FFmpeg filter graph (high-band-limited denoise) ──────────────────────────

def build_highband_denoise_graph(
    filter_name: str,
    params: dict[str, float],
    *,
    high_band_start_hz: float = DEFAULT_HIGH_BAND_START_HZ,
    order: str = _CROSSOVER_ORDER,
) -> str:
    """
    Build a -filter_complex string that denoises ONLY the high band.

    acrossover splits into a low band [0, split] and a high band [split, Nyq]
    with phase-coherent Linkwitz-Riley filters; only the high band is denoised;
    amix(normalize=0) sums the untouched low band back with the cleaned high
    band, reconstructing full bandwidth (no low-pass of the highs).
    """
    split = int(round(high_band_start_hz))
    if filter_name == "afftdn":
        den = f"afftdn=nr={params['nr']}:nf={params['nf']}"
    elif filter_name == "anlmdn":
        den = f"anlmdn=s={params['s']}:m={params['m']}"
    else:
        raise ValueError(f"unsupported filter for PoC: {filter_name!r}")

    return (
        f"[0:a]acrossover=split={split}:order={order}[low][high];"
        f"[high]{den}[hi];"
        f"[low][hi]amix=inputs=2:normalize=0[out]"
    )


# ── numpy measurement helpers ────────────────────────────────────────────────

def _db(x: float) -> float:
    return 20.0 * math.log10(max(abs(x), 1e-12))


def _band_power(mono: "np.ndarray", sr: int, f_low: float, f_high: float) -> float:
    """Linear spectral power inside [f_low, f_high] Hz (whole-signal rFFT)."""
    spec = np.fft.rfft(mono)
    freqs = np.fft.rfftfreq(len(mono), 1.0 / sr)
    mask = (freqs >= f_low) & (freqs < f_high)
    return float(np.sum(np.abs(spec[mask]) ** 2))


def _band_rms_db(mono: "np.ndarray", sr: int, f_low: float, f_high: float) -> float:
    """RMS (dBFS) of a brick-wall FFT band — mirrors audio_io._band_rms_db."""
    n = len(mono)
    spec = np.fft.rfft(mono)
    freqs = np.fft.rfftfreq(n, 1.0 / sr)
    mask = (freqs >= f_low) & (freqs < f_high)
    band = np.zeros_like(spec)
    band[mask] = spec[mask]
    filtered = np.fft.irfft(band, n=n)
    return 20.0 * math.log10(max(float(np.sqrt(np.mean(filtered ** 2))), 1e-12))


def measure_wav(path: str, *, loudness: bool = True) -> dict[str, Any]:
    """
    Full numpy + (optional) FFmpeg measurement of a WAV file.

    numpy provides: duration, sr, channels, rms, peak, stereo correlation,
    DC offset, clipping, NaN/Inf, and the band-energy family.
    FFmpeg loudnorm (via ffmpeg_wrapper.measure_output) provides LUFS/TP/LRA;
    those become None when FFmpeg is unavailable or the clip is too short.
    """
    if not _HAS_SF:
        return {"error": "numpy/soundfile unavailable"}

    data, sr = sf.read(path, always_2d=True, dtype="float64")
    n, ch = data.shape
    finite = bool(np.all(np.isfinite(data)))
    mono = data.mean(axis=1) if ch > 1 else data[:, 0]

    peak = float(np.max(np.abs(data))) if n else 0.0
    rms = float(np.sqrt(np.mean(data ** 2))) if n else 0.0
    dc = float(np.mean(data)) if n else 0.0

    stereo_corr: Optional[float] = None
    if ch >= 2 and n > 1:
        l, r = data[:, 0], data[:, 1]
        # Guard against zero-variance channels (silence) → corrcoef would emit
        # a divide-by-zero RuntimeWarning and return NaN.
        if float(np.std(l)) > 1e-12 and float(np.std(r)) > 1e-12:
            c = np.corrcoef(l, r)
            if np.isfinite(c[0, 1]):
                stereo_corr = float(c[0, 1])

    nyq = sr / 2.0
    total_power = _band_power(mono, sr, 0.0, nyq) if n else 0.0
    hf_power = _band_power(mono, sr, 6000.0, nyq) if n else 0.0
    out: dict[str, Any] = {
        "durationSec": round(n / sr, 4) if sr else 0.0,
        "sampleRate": int(sr),
        "channels": int(ch),
        "rmsDb": round(_db(rms), 3),
        "peakDb": round(_db(peak), 3),
        "dcOffset": round(dc, 8),
        "stereoCorrelation": None if stereo_corr is None else round(stereo_corr, 4),
        "hfEnergyRatio": round(hf_power / total_power, 5) if total_power > 0 else 0.0,
        "energy6to10kDb": round(_band_rms_db(mono, sr, 6000.0, min(10000.0, nyq)), 2) if n else -120.0,
        "energy10to16kDb": round(_band_rms_db(mono, sr, 10000.0, min(16000.0, nyq)), 2) if n else -120.0,
        "energy16kToNyqDb": round(_band_rms_db(mono, sr, 16000.0, nyq), 2) if n and nyq > 16000.0 else -120.0,
        "clippingDetected": bool(np.sum(np.abs(data) >= 0.9999) > 0) if n else False,
        "isFinite": finite,
        "integratedLufs": None,
        "truePeakDbtp": None,
        "lra": None,
        # internal (linear) band powers for safety deltas — not serialized raw
        "_hfPower": hf_power,
        "_vocalPower": _band_power(mono, sr, 2000.0, 6000.0) if n else 0.0,
        "_totalPower": total_power,
    }

    if loudness:
        try:
            # loudnorm_pass1 needs ONLY the ffmpeg binary (no ffprobe) and
            # returns integrated LUFS / true peak / LRA measurements.
            from app.utils.ffmpeg_wrapper import loudnorm_pass1
            lm = loudnorm_pass1(path)
            out["integratedLufs"] = round(float(lm.get("input_i")), 3)
            out["truePeakDbtp"] = round(float(lm.get("input_tp")), 3)
            out["lra"] = round(float(lm.get("input_lra")), 3)
        except Exception:
            # non-fatal: FFmpeg missing or clip too short/silent for loudnorm
            pass
    return out


def _public_measure(m: dict[str, Any]) -> dict[str, Any]:
    """Strip internal `_`-prefixed keys before serialization."""
    return {k: v for k, v in m.items() if not k.startswith("_")}


def compute_delta(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    keys = ["integratedLufs", "truePeakDbtp", "lra", "rmsDb", "peakDb",
            "stereoCorrelation", "hfEnergyRatio"]
    delta: dict[str, Any] = {}
    for k in keys:
        b, a = before.get(k), after.get(k)
        if isinstance(b, (int, float)) and isinstance(a, (int, float)):
            delta[k] = round(a - b, 4)
        else:
            delta[k] = None
    return delta


# ── Difference signal ────────────────────────────────────────────────────────

@dataclass
class DifferenceResult:
    rms_db: float
    normalization_gain_db: float
    length_matches: bool


def make_difference(
    original_wav: str,
    cleaned_wav: str,
    diff_wav: str,
    *,
    normalize_peak_dbfs: float = -1.0,
    subtype: Optional[str] = None,
) -> DifferenceResult:
    """
    Write (cleaned - original) as a sample-aligned difference signal.

    Lengths are truncated to the common minimum (and the mismatch is flagged);
    the raw difference RMS and any audibility-normalization gain are returned
    so the report records both.  Original file is never touched.
    """
    a, sra = sf.read(original_wav, always_2d=True, dtype="float64")
    b, srb = sf.read(cleaned_wav, always_2d=True, dtype="float64")
    length_matches = (a.shape[0] == b.shape[0]) and (sra == srb) and (a.shape[1] == b.shape[1])

    n = min(a.shape[0], b.shape[0])
    ch = min(a.shape[1], b.shape[1])
    diff = b[:n, :ch] - a[:n, :ch]

    raw_rms = float(np.sqrt(np.mean(diff ** 2))) if diff.size else 0.0
    raw_rms_db = _db(raw_rms)

    gain_db = 0.0
    peak = float(np.max(np.abs(diff))) if diff.size else 0.0
    if peak > 1e-9:
        target_lin = 10.0 ** (normalize_peak_dbfs / 20.0)
        gain = target_lin / peak
        # Only ever boost quiet difference signals to be audible; never above 0 dBFS.
        if gain > 1.0:
            gain_db = 20.0 * math.log10(gain)
            diff = diff * gain
    diff = np.clip(diff, -1.0, 1.0)

    sf.write(diff_wav, diff.astype(np.float32), sra,
             subtype=subtype or "PCM_24")
    return DifferenceResult(
        rms_db=round(raw_rms_db, 3),
        normalization_gain_db=round(gain_db, 3),
        length_matches=length_matches,
    )


# ── Safety evaluation ────────────────────────────────────────────────────────

@dataclass
class SafetyResult:
    passed: bool
    warnings: list[str] = field(default_factory=list)
    failures: list[str] = field(default_factory=list)


def evaluate_safety(
    before: dict[str, Any],
    after: dict[str, Any],
    diff: Optional[DifferenceResult],
    *,
    strength: str = "gentle",
    thresholds: SafetyThresholds = DEFAULT_THRESHOLDS,
) -> SafetyResult:
    """Conservative Critical-Fail / Warning gate (see spec §7)."""
    warnings: list[str] = []
    failures: list[str] = []

    # ── Critical structural checks ────────────────────────────────────────
    if "error" in after or after.get("durationSec", 0) <= 0:
        failures.append("output missing or empty")
        return SafetyResult(False, warnings, failures)
    if not after.get("isFinite", False):
        failures.append("output contains NaN/Inf")
    if after.get("sampleRate") != before.get("sampleRate"):
        failures.append("sample rate changed")
    if after.get("channels") != before.get("channels"):
        failures.append("channel count changed")
    if diff is not None and not diff.length_matches:
        failures.append("output length differs from original")
    if after.get("peakDb", -120.0) <= -90.0:
        failures.append("output is silent")
    if after.get("clippingDetected") and not before.get("clippingDetected"):
        failures.append("clipping introduced by processing")

    # ── LUFS drift ────────────────────────────────────────────────────────
    b_lufs, a_lufs = before.get("integratedLufs"), after.get("integratedLufs")
    if isinstance(b_lufs, (int, float)) and isinstance(a_lufs, (int, float)):
        d = abs(a_lufs - b_lufs)
        if d > thresholds.lufs_fail:
            failures.append(f"LUFS change {d:.2f} LU exceeds {thresholds.lufs_fail} LU")
        elif d > thresholds.lufs_warn:
            warnings.append(f"LUFS change {d:.2f} LU exceeds {thresholds.lufs_warn} LU")

    # ── True peak rise ────────────────────────────────────────────────────
    b_tp, a_tp = before.get("truePeakDbtp"), after.get("truePeakDbtp")
    if isinstance(b_tp, (int, float)) and isinstance(a_tp, (int, float)):
        if (a_tp - b_tp) > thresholds.tp_rise_fail_dbtp:
            failures.append(f"true peak rose {a_tp - b_tp:.2f} dBTP")

    # ── Stereo correlation ────────────────────────────────────────────────
    b_c, a_c = before.get("stereoCorrelation"), after.get("stereoCorrelation")
    if isinstance(b_c, (int, float)) and isinstance(a_c, (int, float)):
        d = abs(a_c - b_c)
        if d > thresholds.corr_fail:
            failures.append(f"stereo correlation changed {d:.3f}")
        elif d > thresholds.corr_warn:
            warnings.append(f"stereo correlation changed {d:.3f}")

    # A band must hold a meaningful share of total energy before a relative
    # drop is assessable — otherwise dividing by a near-empty band (e.g. a pure
    # tone with no content in that band) yields meaningless percentages.
    total_before = before.get("_totalPower", 0.0)
    _MIN_BAND_SHARE = 0.005  # 0.5% of total power

    # ── HF energy drop (linear power) ─────────────────────────────────────
    b_hf, a_hf = before.get("_hfPower", 0.0), after.get("_hfPower", 0.0)
    if b_hf > 0 and total_before > 0 and (b_hf / total_before) >= _MIN_BAND_SHARE:
        drop = (b_hf - a_hf) / b_hf
        if drop > thresholds.hf_drop_fail:
            failures.append(f"HF energy dropped {drop * 100:.0f}%")
        elif drop > thresholds.hf_drop_warn:
            warnings.append(f"HF energy dropped {drop * 100:.0f}%")

    # ── Vocal-clarity band (2-6 kHz) drop ─────────────────────────────────
    b_v, a_v = before.get("_vocalPower", 0.0), after.get("_vocalPower", 0.0)
    if b_v > 0 and total_before > 0 and (b_v / total_before) >= _MIN_BAND_SHARE:
        drop = (b_v - a_v) / b_v
        if drop > thresholds.vocal_drop_fail:
            failures.append(f"2-6 kHz vocal-clarity energy dropped {drop * 100:.0f}%")
        elif drop > thresholds.vocal_drop_warn:
            warnings.append(f"2-6 kHz vocal-clarity energy dropped {drop * 100:.0f}%")

    # ── Advisory warnings ─────────────────────────────────────────────────
    if strength == "strong":
        warnings.append("strong mode is test-only and may audibly degrade material")

    return SafetyResult(passed=len(failures) == 0, warnings=warnings, failures=failures)


# ── Segment extraction (numpy/soundfile — no FFmpeg, exact sample alignment) ─

_PCM_SUBTYPES = {"PCM_16", "PCM_24", "PCM_32", "PCM_U8", "FLOAT", "DOUBLE"}


@dataclass
class SegmentInfo:
    start_sec: float
    duration_sec: float
    sample_rate: int
    channels: int
    subtype: str
    clamped: bool


def extract_segment(
    input_path: str,
    out_path: str,
    *,
    start_sec: float = 0.0,
    duration_sec: float = DEFAULT_DURATION_SEC,
) -> SegmentInfo:
    """
    Copy a [start, start+duration] slice of the input to `out_path` as PCM WAV,
    preserving sample rate, channel count, and (best-effort) bit depth.

    The input is opened read-only and never modified.  Start/duration are
    clamped to the file so we never read past the end; if the requested window
    falls outside the file we fall back to the start.
    """
    info = sf.info(input_path)
    sr = int(info.samplerate)
    total_frames = int(info.frames)
    channels = int(info.channels)
    subtype = info.subtype if info.subtype in _PCM_SUBTYPES else "PCM_24"
    total_dur = total_frames / sr if sr else 0.0

    clamped = False
    start = max(0.0, float(start_sec))
    if start >= total_dur:
        start, clamped = 0.0, True

    avail = total_dur - start
    dur = float(duration_sec)
    if dur <= 0 or dur > avail:
        dur, clamped = avail, True

    start_frame = int(round(start * sr))
    num_frames = max(1, int(round(dur * sr)))
    num_frames = min(num_frames, total_frames - start_frame)

    data, _ = sf.read(
        input_path, start=start_frame, frames=num_frames,
        always_2d=True, dtype="float64",
    )
    sf.write(out_path, data.astype(np.float32), sr, subtype=subtype)
    return SegmentInfo(
        start_sec=round(start, 3),
        duration_sec=round(num_frames / sr, 3),
        sample_rate=sr,
        channels=channels,
        subtype=subtype,
        clamped=clamped,
    )


def _codec_for_subtype(subtype: str) -> str:
    return "pcm_s16le" if subtype == "PCM_16" else "pcm_s24le"


def run_highband_denoise(
    ffmpeg_path: str,
    input_wav: str,
    output_wav: str,
    graph: str,
    *,
    sample_rate: int,
    subtype: str,
) -> tuple[bool, str]:
    """
    Run the high-band-limited denoise filter graph.  Non-fatal: returns
    (ok, error_message).  Never raises.
    """
    codec = _codec_for_subtype(subtype)
    try:
        proc = subprocess.run(
            [ffmpeg_path, "-hide_banner", "-y", "-i", input_wav,
             "-filter_complex", graph, "-map", "[out]",
             "-ar", str(sample_rate), "-acodec", codec, output_wav],
            capture_output=True, text=True, encoding="utf-8",
            errors="replace", timeout=120,
        )
    except FileNotFoundError:
        return False, "ffmpeg binary not found"
    except subprocess.TimeoutExpired:
        return False, "denoise pass timed out"
    except Exception as exc:  # pragma: no cover - defensive
        return False, f"{type(exc).__name__}"
    if proc.returncode != 0:
        tail = (proc.stderr or "")[-300:]
        return False, f"ffmpeg exited {proc.returncode}: {tail.strip()}"
    return True, ""


# ── Orchestrator ─────────────────────────────────────────────────────────────

def run_poc(
    input_path: str,
    output_dir: str,
    *,
    start_sec: Optional[float] = None,
    duration_sec: float = DEFAULT_DURATION_SEC,
    strength: str = "gentle",
    filter_choice: str = "auto",
    dry_run: bool = False,
    ffmpeg_path: Optional[str] = None,
) -> dict[str, Any]:
    """
    Full PoC run.  Returns the report dict (also written to report.json/txt).
    Guarantees:
      · input file is never modified or overwritten
      · every failure is non-fatal and captured in the report
    """
    t0 = time.time()
    if not _HAS_SF:
        raise RuntimeError("numpy/soundfile unavailable — cannot run PoC")

    if not os.path.isfile(input_path):
        raise FileNotFoundError(f"input not found: {input_path}")

    os.makedirs(output_dir, exist_ok=True)
    original_wav = os.path.join(output_dir, "original.wav")
    cleaned_wav = os.path.join(output_dir, "cleaned.wav")
    difference_wav = os.path.join(output_dir, "difference.wav")

    in_abs = os.path.abspath(input_path)
    for guard in (original_wav, cleaned_wav, difference_wav):
        if os.path.abspath(guard) == in_abs:
            raise ValueError("output path collides with input — refusing to overwrite input")

    ffmpeg = ffmpeg_path or resolve_ffmpeg()
    probe = probe_filters(ffmpeg)
    selected = select_filter(probe, filter_choice)
    probe["selectedFilter"] = selected

    if start_sec is None:
        start_sec = 0.0
    duration_sec = max(MIN_DURATION_SEC, min(MAX_DURATION_SEC, float(duration_sec)))

    seg = extract_segment(
        input_path, original_wav,
        start_sec=start_sec, duration_sec=duration_sec,
    )

    before = measure_wav(original_wav)
    after: Optional[dict[str, Any]] = None
    diff: Optional[DifferenceResult] = None
    skip_reason: Optional[str] = None
    preset = get_strength_preset(strength)
    params = preset.afftdn if selected == "afftdn" else preset.anlmdn if selected == "anlmdn" else {}
    graph = ""

    if dry_run:
        skip_reason = "dry-run: probe + analysis only, no processing"
    elif selected is None:
        skip_reason = probe.get("error") or "no usable denoise filter (afftdn/anlmdn) available"
    else:
        graph = build_highband_denoise_graph(
            selected, params, high_band_start_hz=DEFAULT_HIGH_BAND_START_HZ,
        )
        ok, err = run_highband_denoise(
            ffmpeg, original_wav, cleaned_wav, graph,
            sample_rate=seg.sample_rate, subtype=seg.subtype,
        )
        if not ok:
            skip_reason = f"denoise skipped: {err}"
            if os.path.exists(cleaned_wav):
                try:
                    os.remove(cleaned_wav)
                except OSError:
                    pass
        else:
            after = measure_wav(cleaned_wav)
            try:
                diff = make_difference(
                    original_wav, cleaned_wav, difference_wav, subtype=seg.subtype,
                )
            except Exception as exc:
                skip_reason = f"difference generation failed: {type(exc).__name__}"

    if after is not None:
        safety = evaluate_safety(before, after, diff, strength=strength)
    else:
        safety = SafetyResult(passed=True, warnings=[], failures=[])
        if skip_reason:
            safety.warnings.append(skip_reason)

    delta = compute_delta(before, after) if after else {}

    report: dict[str, Any] = {
        "version": REPORT_VERSION,
        "input": {
            "fileName": os.path.basename(input_path),
            "startSec": seg.start_sec,
            "durationSec": seg.duration_sec,
            "sampleRate": seg.sample_rate,
            "channels": seg.channels,
            "clamped": seg.clamped,
        },
        "probe": {
            "ffmpegPath": probe.get("ffmpegPath"),
            "available": probe.get("available", False),
            "afftdn": probe.get("afftdn", False),
            "anlmdn": probe.get("anlmdn", False),
            "arnndn": probe.get("arnndn", False),
            "selectedFilter": selected,
            "error": probe.get("error"),
        },
        "settings": {
            "strength": strength,
            "highBandStartHz": DEFAULT_HIGH_BAND_START_HZ,
            "maximumReductionDb": preset.maximum_reduction_db,
            "filterParams": params,
            "filterGraph": graph,
            "dryRun": dry_run,
        },
        "before": _public_measure(before),
        "after": _public_measure(after) if after else None,
        "delta": delta,
        "difference": {
            "rmsDb": diff.rms_db if diff else None,
            "normalizationGainDb": diff.normalization_gain_db if diff else None,
            "lengthMatches": diff.length_matches if diff else None,
        },
        "safety": {
            "passed": safety.passed,
            "warnings": safety.warnings,
            "failures": safety.failures,
        },
        "skipReason": skip_reason,
        "outputs": {
            "original": os.path.basename(original_wav) if os.path.exists(original_wav) else None,
            "cleaned": os.path.basename(cleaned_wav) if os.path.exists(cleaned_wav) else None,
            "difference": os.path.basename(difference_wav) if os.path.exists(difference_wav) else None,
        },
        "processingTimeMs": int((time.time() - t0) * 1000),
    }
    return report


def render_report_txt(report: dict[str, Any]) -> str:
    """Human-readable summary of a report dict."""
    lines: list[str] = []
    p = report["probe"]
    i = report["input"]
    s = report["settings"]
    lines.append("AI Cleanup PoC — Report")
    lines.append("=" * 40)
    lines.append(f"Input       : {i['fileName']}")
    lines.append(f"Segment     : start={i['startSec']}s  dur={i['durationSec']}s  "
                 f"{i['sampleRate']}Hz  {i['channels']}ch"
                 + ("  (clamped)" if i.get("clamped") else ""))
    lines.append(f"FFmpeg      : {p['ffmpegPath']}  (available={p['available']})")
    lines.append(f"Filters     : afftdn={p['afftdn']}  anlmdn={p['anlmdn']}  "
                 f"arnndn={p['arnndn']} (never used)")
    lines.append(f"Selected    : {p['selectedFilter']}")
    lines.append(f"Strength    : {s['strength']}  (max intended reduction "
                 f"{s['maximumReductionDb']} dB, high band >= {s['highBandStartHz']} Hz)")
    if report.get("skipReason"):
        lines.append(f"Skip        : {report['skipReason']}")
    b = report.get("before") or {}
    a = report.get("after")
    d = report.get("delta") or {}
    lines.append("")
    lines.append("Measurement (before -> after [delta]):")

    def row(label: str, key: str, unit: str = "") -> str:
        bv = b.get(key)
        av = a.get(key) if a else None
        dv = d.get(key)
        fb = "n/a" if bv is None else f"{bv}{unit}"
        fa = "n/a" if av is None else f"{av}{unit}"
        fd = "" if dv is None else f"  [{dv:+}]"
        return f"  {label:<22}: {fb} -> {fa}{fd}"

    lines.append(row("Integrated LUFS", "integratedLufs"))
    lines.append(row("True Peak dBTP", "truePeakDbtp"))
    lines.append(row("LRA", "lra"))
    lines.append(row("RMS dB", "rmsDb"))
    lines.append(row("Peak dB", "peakDb"))
    lines.append(row("Stereo correlation", "stereoCorrelation"))
    lines.append(row("HF energy ratio", "hfEnergyRatio"))
    diff = report.get("difference") or {}
    lines.append("")
    lines.append(f"Difference  : rms={diff.get('rmsDb')} dB, "
                 f"normGain={diff.get('normalizationGainDb')} dB, "
                 f"lengthMatches={diff.get('lengthMatches')}")
    sf_ = report["safety"]
    lines.append("")
    lines.append(f"Safety      : {'PASS' if sf_['passed'] else 'FAIL'}")
    for w in sf_["warnings"]:
        lines.append(f"  [warn] {w}")
    for f in sf_["failures"]:
        lines.append(f"  [FAIL] {f}")
    lines.append("")
    lines.append(f"Processing  : {report['processingTimeMs']} ms")
    lines.append("")
    lines.append("NOTE: PoC only. Not connected to run_pipeline / Export / UI. "
                 "Audio quality was NOT human-verified.")
    return "\n".join(lines)
