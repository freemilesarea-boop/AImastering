"""
ISP (Inter-Sample Peak) safety post-processor.

ffmpeg alimiter is *not* oversampled, so a track that measures sample-peak
inside the ceiling can still over-shoot the ITU BS.1770 inter-sample peak.
This module measures the inter-sample peak via a 4× FFT-based sinc upsample
and applies a static (envelope-free) gain reduction when needed.

Properties:
  · single static gain over the entire file → no pumping/breathing
  · numpy + soundfile only — no scipy dependency
  · chunked processing → bounded memory for long files

Usage:
    apply_isp_safety(file_path, ceiling_dbtp=-1.0, headroom_db=0.1)
"""
from __future__ import annotations

import gc
from typing import Optional

try:
    import numpy as np
    import soundfile as sf
    _AVAILABLE = True
except ImportError:
    _AVAILABLE = False

from app.utils.logger import log

ISP_OVERSAMPLE = 4  # ITU BS.1770-4 recommends ≥ 4×


def _fft_upsample(x, factor: int):
    n = len(x)
    if n < 8:
        return x
    spec = np.fft.rfft(x)
    new_n = n * factor
    new_spec = np.zeros(new_n // 2 + 1, dtype=complex)
    new_spec[:len(spec)] = spec
    return np.fft.irfft(new_spec, n=new_n) * factor


def measure_inter_sample_peak_dbtp(
    audio,
    sample_rate: int,
    chunk_seconds: float = 1.0,
    oversample: int = ISP_OVERSAMPLE,
) -> float:
    """
    audio: shape (channels, samples) or (samples,) — float in [-1, 1]
    Returns inter-sample peak in dBTP (-120 if silent).
    """
    if audio.ndim == 1:
        chans = [audio]
    else:
        chans = [audio[i] for i in range(audio.shape[0])]

    chunk_n = max(1024, int(sample_rate * chunk_seconds))
    overall_peak = 0.0

    for ch in chans:
        n = len(ch)
        if n == 0:
            continue
        if n <= chunk_n * 2:
            up = _fft_upsample(ch, oversample)
            overall_peak = max(overall_peak, float(np.max(np.abs(up))))
        else:
            step = chunk_n // 2
            for start in range(0, n, step):
                end = min(start + chunk_n, n)
                seg = ch[start:end]
                if len(seg) < 16:
                    continue
                up = _fft_upsample(seg, oversample)
                p = float(np.max(np.abs(up)))
                if p > overall_peak:
                    overall_peak = p

    if overall_peak <= 0:
        return -120.0
    return 20 * float(np.log10(overall_peak))


def apply_isp_safety(
    file_path: str,
    ceiling_dbtp: float = -1.0,
    headroom_db: float = 0.1,
) -> Optional[float]:
    """
    Read file, measure ISP, apply static down-gain if exceeded.

    Returns:
      applied gain in dB (negative or 0). 0 means no action needed.
      None on failure (caller should treat as no-op).
    """
    if not _AVAILABLE:
        log("WARN", "[isp_safety] numpy/soundfile unavailable — skip")
        return None

    try:
        # float32 (not float64) halves peak RAM and is lossless for ≤24-bit PCM
        # (float32 mantissa = 24 bits). dBTP measurement is unaffected.
        data, sr = sf.read(file_path, always_2d=True, dtype="float32")
    except Exception as exc:
        log("WARN", f"[isp_safety] read failed {file_path}: {exc}")
        return None

    if data.size == 0:
        return 0.0

    # soundfile gives (samples, channels) → transpose to (channels, samples)
    audio = data.T
    isp_db = measure_inter_sample_peak_dbtp(audio, sample_rate=sr)
    safe_ceiling = ceiling_dbtp - headroom_db
    del audio  # drop the transpose view before any further allocation

    if isp_db <= safe_ceiling + 0.01:
        log("INFO", f"[isp_safety] ISP={isp_db:+.2f} dBTP <= "
                    f"{safe_ceiling:+.2f} (no action)")
        del data
        gc.collect()
        return 0.0

    gain_db = safe_ceiling - isp_db
    gain_lin = 10 ** (gain_db / 20)
    log("INFO", f"[isp_safety] ISP={isp_db:+.2f} dBTP > {safe_ceiling:+.2f} "
                f"→ applying {gain_db:+.2f} dB")

    data *= gain_lin  # in-place: avoid allocating a second full-size array
    info = sf.info(file_path)
    try:
        sf.write(file_path, data, sr, subtype=info.subtype, format=info.format)
    except Exception as exc:
        log("WARN", f"[isp_safety] write failed: {exc}")
        return None
    finally:
        del data
        gc.collect()

    return round(float(gain_db), 3)
