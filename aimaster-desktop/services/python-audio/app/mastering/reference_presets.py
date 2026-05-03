"""
Built-in reference target profiles (v3.4).

Provides genre-curated `TargetProfile` dicts so users can run the iterative
reference-matching mastering WITHOUT supplying an actual reference audio
file.  Each preset is hand-tuned to match the typical spectral / loudness
shape of well-mastered commercial releases in that genre.

Why this matters: the v3.4 reference-matching loop produces excellent
results when fed a good reference, and unpredictable results when fed a
bad one (a quiet demo, a wildly different genre, etc.).  These presets
give users a safe starting point — the iterative loop will chase the
preset's spectral curve and the engine's vocal-protection guards will
keep the lead intact regardless.

Each preset returns the same shape as `compute_target_profile()` so they
plug directly into `run_iterative_mastering(target_profile_override=...)`.

Band conventions (from app/mastering/multiband.py):
    low   :  20 Hz –   200 Hz   (sub + bass body)
    mid   : 200 Hz –  2000 Hz   (instrument body, low vocal)
    vocal : 2000 Hz –  5000 Hz  (lead vocal, snare presence)
    high  : 5000 Hz – 16000 Hz  (cymbals, air, sibilance)

Band energy values are *typical* RMS dBFS measurements pulled from a
representative sample of well-mastered commercial tracks in each genre,
clamped to a safe range.  They are intentionally conservative — the
matching loop targets these as a *direction*, not as a hard requirement.
"""
from __future__ import annotations

from typing import Any


# ── Preset registry ─────────────────────────────────────────────────────────
# Each preset documents:
#   · its target loudness (LUFS)
#   · TP / LRA / 4-band energy / stereo width
#   · A user-facing description and "best for" guidance

REFERENCE_PRESETS: dict[str, dict[str, Any]] = {
    "kpop_modern": {
        "label":       "K-Pop / Modern",
        "description": "현대 K-Pop 표준 — 넓은 스테레오, 강한 베이스, 명료한 보컬",
        "bestFor":     "댄스, 일렉, 트로피컬 K-Pop",
        "targetLufs":     -9.5,
        "targetTruePeak": -1.0,
        "targetLra":      4.0,
        "targetBands":    {"low": -16.0, "mid": -14.0, "vocal": -18.0, "high": -22.0},
        "targetStereoWidth": 0.45,
        "targetCrestDb":  7.0,
        "sourceReferencePath": "preset:kpop_modern",
    },
    "edm_loud": {
        "label":       "EDM / Festival",
        "description": "EDM 페스티벌 사운드 — 매우 큰 라우드니스, 강한 sub-bass",
        "bestFor":     "EDM, House, Big Room, Future Bass",
        "targetLufs":     -8.5,
        "targetTruePeak": -1.0,
        "targetLra":      3.5,
        "targetBands":    {"low": -14.0, "mid": -15.0, "vocal": -19.0, "high": -21.0},
        "targetStereoWidth": 0.50,
        "targetCrestDb":  6.5,
        "sourceReferencePath": "preset:edm_loud",
    },
    "pop_ballad": {
        "label":       "Pop Ballad",
        "description": "발라드/미드템포 팝 — 자연스러운 다이내믹, 따뜻한 보컬",
        "bestFor":     "발라드, R&B, 어쿠스틱 팝",
        "targetLufs":     -12.0,
        "targetTruePeak": -1.0,
        "targetLra":      7.0,
        "targetBands":    {"low": -18.0, "mid": -15.0, "vocal": -16.0, "high": -22.0},
        "targetStereoWidth": 0.35,
        "targetCrestDb":  10.0,
        "sourceReferencePath": "preset:pop_ballad",
    },
    "rock_modern": {
        "label":       "Rock / Alt-Rock",
        "description": "현대 록 — 강한 미드, 빵빵한 드럼, 명료한 보컬",
        "bestFor":     "Alt-Rock, Indie Rock, Pop-Rock",
        "targetLufs":     -10.0,
        "targetTruePeak": -1.0,
        "targetLra":      5.0,
        "targetBands":    {"low": -17.0, "mid": -13.0, "vocal": -16.0, "high": -20.0},
        "targetStereoWidth": 0.40,
        "targetCrestDb":  8.0,
        "sourceReferencePath": "preset:rock_modern",
    },
    "hiphop_punchy": {
        "label":       "Hip-Hop / Trap",
        "description": "힙합/트랩 — 공격적인 808, 펀치 있는 드럼, 정면 보컬",
        "bestFor":     "Hip-Hop, Trap, R&B",
        "targetLufs":     -9.0,
        "targetTruePeak": -1.0,
        "targetLra":      4.5,
        "targetBands":    {"low": -13.0, "mid": -16.0, "vocal": -17.0, "high": -23.0},
        "targetStereoWidth": 0.40,
        "targetCrestDb":  7.5,
        "sourceReferencePath": "preset:hiphop_punchy",
    },
    "acoustic_warm": {
        "label":       "Acoustic / Folk",
        "description": "어쿠스틱/포크 — 자연스러운 다이내믹, 따뜻한 톤",
        "bestFor":     "Singer-Songwriter, 포크, 라이브 어쿠스틱",
        "targetLufs":     -14.0,
        "targetTruePeak": -1.5,
        "targetLra":      9.0,
        "targetBands":    {"low": -20.0, "mid": -14.0, "vocal": -15.0, "high": -21.0},
        "targetStereoWidth": 0.30,
        "targetCrestDb":  12.0,
        "sourceReferencePath": "preset:acoustic_warm",
    },
    "jazz_natural": {
        "label":       "Jazz / Classical",
        "description": "재즈/클래식 — 가장 자연스러운 다이내믹, 보존 우선",
        "bestFor":     "Jazz, 클래식, 어쿠스틱 인스트루먼트",
        "targetLufs":     -16.0,
        "targetTruePeak": -2.0,
        "targetLra":      12.0,
        "targetBands":    {"low": -22.0, "mid": -16.0, "vocal": -18.0, "high": -23.0},
        "targetStereoWidth": 0.30,
        "targetCrestDb":  14.0,
        "sourceReferencePath": "preset:jazz_natural",
    },
    "streaming_safe": {
        "label":       "Streaming Safe (-14 LUFS)",
        "description": "Spotify / Apple Music 안전 마스터 — 모든 장르 호환",
        "bestFor":     "장르 불명, 보수적 마스터링이 필요한 경우",
        "targetLufs":     -14.0,
        "targetTruePeak": -1.0,
        "targetLra":      8.0,
        "targetBands":    {"low": -18.0, "mid": -15.0, "vocal": -17.0, "high": -22.0},
        "targetStereoWidth": 0.35,
        "targetCrestDb":  10.0,
        "sourceReferencePath": "preset:streaming_safe",
    },
}


def list_reference_presets() -> list[dict[str, Any]]:
    """
    Return public preset metadata for the UI dropdown.
    Each entry: { key, label, description, bestFor, targetLufs }.
    """
    return [
        {
            "key":         k,
            "label":       v["label"],
            "description": v["description"],
            "bestFor":     v["bestFor"],
            "targetLufs":  v["targetLufs"],
            "targetLra":   v["targetLra"],
        }
        for k, v in REFERENCE_PRESETS.items()
    ]


def get_reference_preset(key: str) -> dict[str, Any] | None:
    """Return a full TargetProfile dict for the given preset key, or None."""
    preset = REFERENCE_PRESETS.get(key)
    if not preset:
        return None
    # Strip the UI-only keys to leave a pure TargetProfile shape
    return {
        "targetLufs":          preset["targetLufs"],
        "targetTruePeak":      preset["targetTruePeak"],
        "targetLra":           preset["targetLra"],
        "targetBands":         dict(preset["targetBands"]),
        "targetStereoWidth":   preset["targetStereoWidth"],
        "targetCrestDb":       preset["targetCrestDb"],
        "sourceReferencePath": preset["sourceReferencePath"],
    }


# ── Auto-recommend a preset based on input profile ──────────────────────────

def recommend_preset_for_input(input_profile: Any) -> dict[str, Any] | None:
    """
    Best-effort suggestion of a preset based on the input file's existing
    spectral / loudness shape.  Heuristic — definitely not a substitute for
    user choice — but good enough to show "이 곡은 ___ 프리셋이 어울려요".

    Decision tree:
      · LRA > 10 LU + crest > 12 dB → acoustic_warm or jazz_natural
      · LRA 5-10  + crest 8-12      → pop_ballad
      · LRA < 5   + low band heavy  → hiphop_punchy or kpop_modern
      · LRA < 5   + mid band heavy  → rock_modern
      · default                     → streaming_safe (always-applicable)
    """
    try:
        lra   = float(input_profile.lra)
        crest = float(input_profile.crestDb)
        bands = input_profile.bands or {}
    except (AttributeError, TypeError, ValueError):
        return _wrap_with_reason("streaming_safe",
                                  "입력 분석 정보가 부족합니다 — 보수적 기본값 추천")

    # Very dynamic, transient-rich → acoustic / jazz family
    if lra > 10.0 and crest > 12.0:
        return _wrap_with_reason(
            "jazz_natural" if lra > 13 else "acoustic_warm",
            f"LRA {lra:.1f} LU + crest {crest:.1f} dB — 자연스러운 다이내믹",
        )

    # Mid-dynamic ballad/pop
    if 5.0 <= lra <= 10.0 and 8.0 <= crest <= 12.5:
        return _wrap_with_reason(
            "pop_ballad",
            f"LRA {lra:.1f} LU — 발라드 / 미드템포 팝 적합",
        )

    # Low-dynamic loud styles — pick by spectrum
    if lra < 5.0:
        low  = float(bands.get("low",  -30))
        mid  = float(bands.get("mid",  -30))
        # Bass-heavy → hip-hop / k-pop
        if low > mid:
            return _wrap_with_reason(
                "hiphop_punchy" if (low - mid) > 2 else "kpop_modern",
                f"low band 우세 ({low:.1f} dB) — 힙합/K-Pop 적합",
            )
        # Mid-heavy → rock
        if mid > low + 1:
            return _wrap_with_reason(
                "rock_modern",
                f"mid band 우세 ({mid:.1f} dB) — 록 적합",
            )

    return _wrap_with_reason(
        "streaming_safe",
        f"입력 분석 결과 (LRA {lra:.1f}, crest {crest:.1f}) — 보수적 기본값 추천",
    )


def _wrap_with_reason(preset_key: str, reason: str) -> dict[str, Any]:
    """Bundle a preset key + a Korean reason for the UI tooltip."""
    preset = REFERENCE_PRESETS.get(preset_key)
    if preset is None:
        return {"key": "streaming_safe", "reason": "default", "preset": REFERENCE_PRESETS["streaming_safe"]}
    return {
        "key":    preset_key,
        "label":  preset["label"],
        "reason": reason,
        "targetLufs": preset["targetLufs"],
    }
