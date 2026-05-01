"""
활성 코드 QA 용 합성 fixture 생성기.

legacy `tests/qa/fixtures.py` 의 활성 코드 버전. 결정적 numpy 신호 +
soundfile 로 24-bit WAV 출력. 5 가지 시나리오:

  - low_lufs       : 매우 작은 입력 (-28 LUFS) — 큰 push 필요
  - wide_dynamic   : verse-chorus-verse 다이내믹 큰 발라드
  - bass_heavy     : 60~150 Hz 강조 + kick pattern
  - sibilant       : 5~8 kHz 치찰음 burst (트랜지언트 큼)
  - already_loud   : 이미 마스터링된 brickwall 입력 (-2 LUFS)
  - silence        : -100 dB 거의 무음
  - clipped        : 사전 클리핑된 입력
"""
from __future__ import annotations

import os
from typing import Callable

import numpy as np
import soundfile as sf

SR = 44100
DUR = 30.0  # seconds
N = int(SR * DUR)


def _t():
    return np.arange(N) / SR


def _stereo(mono: np.ndarray) -> np.ndarray:
    return np.stack([mono, mono], axis=1).astype("float32")


def _save(path: str, data: np.ndarray, sr: int = SR):
    if data.ndim == 1:
        data = _stereo(data)
    sf.write(path, data, sr, subtype="PCM_24")


def _normalize_to_peak(x: np.ndarray, peak_lin: float = 0.95) -> np.ndarray:
    p = float(np.max(np.abs(x))) or 1.0
    return x * (peak_lin / p)


def make_low_lufs(path: str):
    """-28 LUFS 정도의 작은 신호 — 큰 push 필요."""
    np.random.seed(7)
    t = _t()
    pad = 0.04 * np.sin(2 * np.pi * 220 * t)
    bass = 0.04 * np.sin(2 * np.pi * 80 * t) * (1 + 0.5 * np.sin(2 * np.pi * 2 * t))
    sig = (pad + bass).astype("float32")
    sig = _normalize_to_peak(sig, 0.05)  # 매우 작게
    _save(path, sig)


def make_wide_dynamic(path: str):
    """Verse-Chorus-Verse 큰 다이내믹 (LRA > 10 LU)."""
    np.random.seed(11)
    t = _t()
    base = 0.3 * np.sin(2 * np.pi * 180 * t)
    chorus_env = np.where((t > 8) & (t < 18), 1.0, 0.18)
    chorus_env = np.minimum(chorus_env, 1.0)
    sig = base * chorus_env + 0.05 * np.random.randn(N)
    _save(path, _normalize_to_peak(sig.astype("float32"), 0.85))


def make_bass_heavy(path: str):
    """60~150 Hz 강조 + 4-on-the-floor kick pattern."""
    np.random.seed(13)
    t = _t()
    sub = 0.5 * np.sin(2 * np.pi * 60 * t)
    body = 0.3 * np.sin(2 * np.pi * 110 * t)
    # kick pulse — 0.5s 간격
    kick = np.zeros(N, dtype="float32")
    for i in range(0, N, SR // 2):
        env = np.exp(-np.arange(min(SR // 8, N - i)) / (SR / 80))
        kick[i:i + len(env)] += 0.6 * env * np.sin(
            2 * np.pi * 70 * np.arange(len(env)) / SR
        )
    sig = (sub + body + kick).astype("float32")
    _save(path, _normalize_to_peak(sig, 0.92))


def make_sibilant(path: str):
    """5~8 kHz 치찰음 burst — 빠른 transient 가 alimiter ISP 한계 시험."""
    np.random.seed(17)
    t = _t()
    tone = 0.25 * np.sin(2 * np.pi * 220 * t)
    burst_env = np.where(np.sin(2 * np.pi * 5 * t) > 0.93, 1.0, 0.0)
    sib = 0.55 * burst_env * np.sin(2 * np.pi * 6500 * t)
    sig = (tone + sib).astype("float32")
    _save(path, _normalize_to_peak(sig, 0.88))


def make_already_loud(path: str):
    """이미 brickwall 마스터링된 듯한 입력 (-2 LUFS, LRA ≈ 0)."""
    np.random.seed(19)
    t = _t()
    base = 0.95 * np.sign(np.sin(2 * np.pi * 200 * t))  # square-ish
    sig = base * 0.97 + 0.02 * np.random.randn(N)
    sig = np.clip(sig, -0.99, 0.99).astype("float32")
    _save(path, sig)


def make_silence(path: str):
    """-100 dB 거의 무음 — silence 가드 검증."""
    np.random.seed(23)
    sig = (1e-5 * np.random.randn(N)).astype("float32")
    _save(path, sig)


def make_clipped(path: str):
    """사전 클리핑 입력 — 입력 클리핑 경고 트리거."""
    np.random.seed(29)
    t = _t()
    sig = 1.5 * np.sin(2 * np.pi * 250 * t)
    sig = np.clip(sig, -0.99, 0.99).astype("float32")
    _save(path, sig)


FIXTURE_BUILDERS: dict[str, Callable[[str], None]] = {
    "low_lufs":     make_low_lufs,
    "wide_dynamic": make_wide_dynamic,
    "bass_heavy":   make_bass_heavy,
    "sibilant":     make_sibilant,
    "already_loud": make_already_loud,
    "silence":      make_silence,
    "clipped":      make_clipped,
}


def generate_all(out_dir: str) -> dict[str, str]:
    """모든 fixture 를 out_dir 에 생성. 이미 존재하면 재사용."""
    os.makedirs(out_dir, exist_ok=True)
    paths: dict[str, str] = {}
    for name, builder in FIXTURE_BUILDERS.items():
        path = os.path.join(out_dir, f"{name}.wav")
        if not os.path.exists(path):
            builder(path)
        paths[name] = path
    return paths


if __name__ == "__main__":
    import sys
    out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/aim_active_qa_fixtures"
    paths = generate_all(out)
    for name, path in paths.items():
        size = os.path.getsize(path)
        print(f"  {name:14s} {path}  ({size:>9,} bytes)")
