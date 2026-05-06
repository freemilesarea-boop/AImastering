"""
QA fixture 생성기 — 5종 테스트용 합성 오디오 + 엣지 케이스 입력 생성.

각 fixture 는 30초, 44.1kHz, stereo, 24-bit WAV.
실제 음원이 아니라 의도된 특성을 가진 합성 신호 — QA 의 결정성/재현성 보장.
"""
import os
import math
import numpy as np
import soundfile as sf

SR = 44100
DURATION = 30.0


def _t(n_samples: int) -> np.ndarray:
    return np.arange(n_samples) / SR


def _save(path: str, audio: np.ndarray, sr: int = SR) -> str:
    """audio: (channels, samples) 또는 (samples,)"""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    if audio.ndim == 2:
        out = audio.T
    else:
        out = np.stack([audio, audio], axis=-1)
    sf.write(path, out, sr, subtype="PCM_24")
    return path


def _normalize_peak(audio: np.ndarray, target_db: float = -1.0) -> np.ndarray:
    peak = float(np.max(np.abs(audio)))
    if peak <= 0:
        return audio
    target = 10 ** (target_db / 20)
    return audio * (target / peak)


def _scale_to_lufs_proxy(audio: np.ndarray, target_db: float) -> np.ndarray:
    """RMS dB 기준으로 대략 LUFS 비슷하게 스케일 (정확한 LUFS 는 아니지만 fixture 생성 의도용으론 충분)."""
    rms = float(np.sqrt(np.mean(audio ** 2)))
    if rms <= 0:
        return audio
    cur_db = 20 * math.log10(rms)
    delta = target_db - cur_db
    return audio * (10 ** (delta / 20))


# ─────────────────────────────────────────────────────
# Fixture 1: 낮은 LUFS 원본 (-26 LUFS proxy, 어쿠스틱)
# ─────────────────────────────────────────────────────
def fixture_low_lufs(out_path: str) -> str:
    n = int(SR * DURATION)
    t = _t(n)
    # 저음 + 보컬 + 코드 + 약한 reverb tail
    fund = 220.0
    voice = 0.35 * np.sin(2 * np.pi * fund * t) * (1 + 0.1 * np.sin(2*np.pi*5*t))
    chord = 0.15 * (np.sin(2*np.pi*330*t) + np.sin(2*np.pi*440*t))
    bass  = 0.20 * np.sin(2 * np.pi * 80 * t)
    air   = 0.05 * np.random.RandomState(1).randn(n)
    sig = voice + chord + bass + air
    sig = _scale_to_lufs_proxy(sig, target_db=-30.0)  # very quiet → loudnorm 측정 시 약 -26 LUFS
    sig_l = sig
    sig_r = sig * 0.97 + 0.03 * np.roll(sig, 50)
    audio = np.stack([sig_l, sig_r], axis=0)
    return _save(out_path, audio)


# ─────────────────────────────────────────────────────
# Fixture 2: 다이내믹이 큰 발라드 — Verse(quiet) → Chorus(loud) → Verse
# ─────────────────────────────────────────────────────
def fixture_wide_dynamic(out_path: str) -> str:
    n = int(SR * DURATION)
    t = _t(n)
    sig = 0.4 * np.sin(2*np.pi*220*t) + 0.2 * np.sin(2*np.pi*440*t) + 0.05 * np.random.RandomState(2).randn(n)
    # Envelope: 0~10s quiet (gain 0.25), 10~20s loud (gain 1.0), 20~30s quiet (gain 0.3)
    env = np.ones(n)
    env[:int(SR*10)] = 0.25
    env[int(SR*10):int(SR*20)] = 1.0
    env[int(SR*20):] = 0.30
    # smooth transitions (cosine ramp 0.5s)
    ramp = int(SR * 0.5)
    for boundary in (int(SR*10), int(SR*20)):
        s, e = boundary - ramp//2, boundary + ramp//2
        cos = (1 - np.cos(np.linspace(0, math.pi, e - s))) / 2
        env[s:e] = env[s] * (1 - cos) + env[e] * cos
    sig = sig * env
    sig = _normalize_peak(sig, target_db=-3.0)
    audio = np.stack([sig, sig * 0.95], axis=0)
    return _save(out_path, audio)


# ─────────────────────────────────────────────────────
# Fixture 3: 베이스가 강한 곡 (저역 60~200Hz 에너지 과잉)
# ─────────────────────────────────────────────────────
def fixture_bass_heavy(out_path: str) -> str:
    n = int(SR * DURATION)
    t = _t(n)
    sub  = 0.6 * np.sin(2*np.pi*60*t)
    bass = 0.5 * np.sin(2*np.pi*100*t) + 0.4 * np.sin(2*np.pi*150*t)
    mid  = 0.15 * np.sin(2*np.pi*1000*t)
    high = 0.05 * np.sin(2*np.pi*8000*t)
    kick_pattern = np.zeros(n)
    period = int(SR * 0.5)  # 120 BPM
    for i in range(0, n, period):
        attack = int(SR * 0.005)
        decay  = int(SR * 0.15)
        env_k = np.zeros(decay + attack)
        env_k[:attack] = np.linspace(0, 1, attack)
        env_k[attack:] = np.exp(-np.linspace(0, 5, decay))
        kick = 0.7 * np.sin(2*np.pi*55*np.arange(len(env_k))/SR) * env_k
        end = min(i + len(kick), n)
        kick_pattern[i:end] += kick[:end - i]
    sig = sub + bass + mid + high + kick_pattern
    sig = _normalize_peak(sig, target_db=-2.0)
    audio = np.stack([sig, sig * 0.98], axis=0)
    return _save(out_path, audio)


# ─────────────────────────────────────────────────────
# Fixture 4: 보컬 치찰음 강함 (5~8kHz 강조)
# ─────────────────────────────────────────────────────
def fixture_sibilant(out_path: str) -> str:
    n = int(SR * DURATION)
    t = _t(n)
    fund = 0.35 * np.sin(2*np.pi*250*t)
    formant1 = 0.18 * np.sin(2*np.pi*800*t)
    formant2 = 0.12 * np.sin(2*np.pi*1500*t)
    # 치찰음 (5.5~8 kHz, 주기적 burst)
    rng = np.random.RandomState(4)
    sibilance = 0.0 * t
    period = int(SR * 0.4)
    burst_len = int(SR * 0.15)
    for i in range(0, n, period):
        end = min(i + burst_len, n)
        noise = rng.randn(end - i)
        # bandlimit ~5~8 kHz with simple FIR-like trick (high-pass via diff)
        noise_hp = np.diff(noise, prepend=0)
        sibilance[i:end] = 0.5 * noise_hp
    sig = fund + formant1 + formant2 + sibilance
    sig = _normalize_peak(sig, target_db=-3.0)
    audio = np.stack([sig, sig * 0.96], axis=0)
    return _save(out_path, audio)


# ─────────────────────────────────────────────────────
# Fixture 5: 이미 음압 높은 곡 (-9 LUFS proxy, brickwall)
# ─────────────────────────────────────────────────────
def fixture_already_loud(out_path: str) -> str:
    n = int(SR * DURATION)
    t = _t(n)
    sig = 0.5 * np.sin(2*np.pi*220*t) + 0.4 * np.sin(2*np.pi*440*t) + 0.3 * np.sin(2*np.pi*880*t)
    sig += 0.1 * np.random.RandomState(5).randn(n)
    # soft clip to make it look "already mastered"
    sig = np.tanh(sig * 1.8) * 0.95
    sig = _normalize_peak(sig, target_db=-1.0)
    audio = np.stack([sig, sig * 0.99], axis=0)
    return _save(out_path, audio)


# ─────────────────────────────────────────────────────
# Edge case fixtures
# ─────────────────────────────────────────────────────
def fixture_silence(out_path: str) -> str:
    """거의 무음 — entry_gain clamp 트리거용"""
    n = int(SR * 5.0)
    sig = 1e-5 * np.random.RandomState(6).randn(n)  # -100 dB 수준
    audio = np.stack([sig, sig], axis=0)
    return _save(out_path, audio)


def fixture_clipped(out_path: str) -> str:
    """이미 클리핑된 입력"""
    n = int(SR * 10.0)
    t = _t(n)
    sig = 1.5 * np.sin(2*np.pi*440*t)  # clip 발생
    sig = np.clip(sig, -1.0, 1.0)
    audio = np.stack([sig, sig], axis=0)
    return _save(out_path, audio)


# ─────────────────────────────────────────────────────
# 일괄 생성
# ─────────────────────────────────────────────────────
FIXTURES = {
    "low_lufs":      fixture_low_lufs,
    "wide_dynamic":  fixture_wide_dynamic,
    "bass_heavy":    fixture_bass_heavy,
    "sibilant":      fixture_sibilant,
    "already_loud":  fixture_already_loud,
    "silence":       fixture_silence,
    "clipped":       fixture_clipped,
}


def generate_all(out_dir: str) -> dict:
    paths = {}
    for name, builder in FIXTURES.items():
        paths[name] = builder(os.path.join(out_dir, f"{name}.wav"))
    return paths


if __name__ == "__main__":
    import sys
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "/tmp/aim_qa_in"
    paths = generate_all(out_dir)
    for n, p in paths.items():
        print(f"{n}: {p}")
