"""
Stage 3: Adaptive streaming EQ — audible tonal shaping, commercially tasteful.

Design principles:
  - Every band adapts to the measured spectral balance of the input, so
    bass-light tracks get more low boost and dark tracks get more air, while
    already-balanced tracks receive a lighter touch.
  - Minimum effective floors ensure the mastering output is always audibly
    different from the source — not just louder — even on well-balanced mixes.
  - Gains are deliberately larger than a "final mix bus" would use because the
    loudnorm stage that follows applies a gain correction that partially offsets
    absolute level changes.  The spectral shape (the ratio between bands) is
    preserved by EQ and survives loudnorm.  A +3.5 dB boost at 80 Hz produces
    roughly +2.5-3 dB of perceived bass increase in the output.
  - Nothing is boosted beyond 4.5 dB or cut beyond -3.5 dB in a single band
    to avoid unnatural tonal hyping.

Band layout (base, applied to every style):
  1  80 Hz  bell  +2.0 ~ +4.0 dB  primary bass density         (adaptive)
  2 120 Hz  bell  +0.8 ~ +1.6 dB  upper-bass punch supplement  (40% of #1)
  3 250 Hz  bell  -3.0 dB         main mud/boxiness removal     (fixed)
  4 320 Hz  bell  -1.0 dB         secondary nasal cut           (fixed)
  5  10kHz  shelf +2.0 ~ +3.5 dB  air and openness              (adaptive)
  6   8kHz  bell  +0.8 ~ +1.4 dB  presence and clarity          (40% of #5)

Spectral balance thresholds used for adaptation:
  low_to_mid_db (= low_band_rms − mid_band_rms):
    < -20  → very bass-light  → maximum low boost (4.0 dB)
    -20..-13 → moderate       → standard boost    (3.5 dB)
    -13..-6  → adequate       → gentle boost      (2.5 dB)
    > -6   → bass-heavy       → minimum floor     (2.0 dB)

  high_to_mid_db (= high_band_rms − mid_band_rms):
    < -28  → very dark        → maximum air (3.5 dB)
    -28..-20 → moderate dark  → standard    (2.8 dB)
    > -20  → already bright   → minimum     (2.0 dB)
"""
from __future__ import annotations

from dataclasses import dataclass, field


# ── Adaptive helpers ──────────────────────────────────────────────────────────

def _adaptive_low_boost(low_to_mid_db: float) -> float:
    """Return primary 80 Hz bell gain (dB).  Floor 2.0 dB survives loudnorm."""
    if low_to_mid_db < -20.0:
        return 4.0
    if low_to_mid_db < -13.0:
        return 3.5
    if low_to_mid_db < -6.0:
        return 2.5
    return 2.0


def _adaptive_air_boost(high_to_mid_db: float) -> float:
    """Return 10 kHz shelf gain (dB).  Floor 2.0 dB ensures audible openness."""
    if high_to_mid_db < -28.0:
        return 3.5
    if high_to_mid_db < -20.0:
        return 2.8
    return 2.0


# ── EQ move descriptor (used for analysis report) ─────────────────────────────

@dataclass
class EqMove:
    band:     str         # human-readable label
    freq_hz:  int
    gain_db:  float
    filter:   str         # "bell" | "highshelf" | "lowshelf"
    adaptive: bool = False

    def to_dict(self) -> dict:
        sign = f"+{self.gain_db:.1f}" if self.gain_db >= 0 else f"{self.gain_db:.1f}"
        return {
            "band":     self.band,
            "freqHz":   self.freq_hz,
            "gainDb":   round(self.gain_db, 1),
            "gainStr":  sign,
            "filter":   self.filter,
            "adaptive": self.adaptive,
        }


# ── Base EQ builder ───────────────────────────────────────────────────────────

def _build_base_eq(
    low_to_mid_db: float,
    high_to_mid_db: float,
) -> tuple[list[str], list[EqMove]]:
    """
    Returns (ffmpeg_filter_parts, eq_moves).
    """
    low_gain = _adaptive_low_boost(low_to_mid_db)
    air_gain = _adaptive_air_boost(high_to_mid_db)

    # Upper-bass supplement: 40% of primary, min 0.8 dB
    lo_supp = max(0.8, round(low_gain * 0.40, 1))

    filters = [
        f"equalizer=f=80:t=o:w=2.0:g=+{low_gain:.1f}",
        f"equalizer=f=120:t=o:w=1.2:g=+{lo_supp:.1f}",
        "equalizer=f=250:t=o:w=1.2:g=-3.0",
        "equalizer=f=320:t=o:w=0.8:g=-1.0",
        # Air shelf starts at 12kHz to avoid vocal presence range (4-10kHz)
        f"highshelf=f=12000:g=+{air_gain:.1f}",
    ]

    moves = [
        EqMove("Low-end density",        80,    +low_gain, "bell",      adaptive=True),
        EqMove("Upper-bass punch",       120,   +lo_supp,  "bell",      adaptive=True),
        EqMove("Mud removal (main)",     250,   -3.0,      "bell"),
        EqMove("Mud removal (secondary)", 320,  -1.0,      "bell"),
        EqMove("Air shelf",              12000, +air_gain, "highshelf", adaptive=True),
    ]

    return filters, moves


# ── Style overlays ────────────────────────────────────────────────────────────
# Applied on top of base EQ.  Gains produce clearly different characters but
# avoid anything that sounds like a DJ EQ or over-processing.

@dataclass
class StyleOverlay:
    filters: list[str]
    moves: list[EqMove]


_STYLE_OVERLAYS: dict[str, StyleOverlay] = {

    # ─── Natural ──────────────────────────────────────────────────────────
    # 가장 약한 개입. AI 원음을 거의 그대로 보존.
    "natural": StyleOverlay(
        filters=[
            "equalizer=f=120:t=o:w=1.5:g=+0.5",   # mild low-mid body
        ],
        moves=[
            EqMove("Subtle low-mid (natural)", 120, +0.5, "bell"),
        ],
    ),

    # Balanced: base EQ only — transparent streaming master
    "balanced": StyleOverlay(filters=[], moves=[]),

    # Warm: vintage character — body in low-mids, smooth upper-mids, softer top
    "warm": StyleOverlay(
        filters=[
            "equalizer=f=200:t=o:w=1.2:g=+1.5",    # low-mid body
            "equalizer=f=3500:t=o:w=1.5:g=-2.0",   # smooth upper-mid edge
            "highshelf=f=8000:g=-2.0",              # partial air rolloff
        ],
        moves=[
            EqMove("Low-mid body (warm)",     200,   +1.5, "bell"),
            EqMove("Upper-mid smooth (warm)", 3500,  -2.0, "bell"),
            EqMove("Top-end rolloff (warm)",  8000,  -2.0, "highshelf"),
        ],
    ),

    # ─── Bright (v3 fix) ─────────────────────────────────────────────────
    # 기존 +1.5 dB definition + 14kHz +1.5 dB 가 컴프/리미터 단에서 transient 를
    # 누르는 현상이 있어 다음과 같이 완화하고 sheen 영역(8kHz)을 추가함.
    #   - 5 kHz definition 1.5 → 1.0
    #   - 14 kHz extended air 1.5 → 1.2
    #   - 8 kHz sheen +0.8 신규
    # 또한 dynamics.py / pipeline.py 에서 bright 모드는 ratio 와 attack 을 완화하고
    # de-esser/saturation 을 비활성화한다.
    "bright": StyleOverlay(
        filters=[
            "equalizer=f=5000:t=o:w=1.0:g=+1.0",   # 정의감 (vocal body 위)
            "equalizer=f=8000:t=o:w=1.2:g=+0.8",   # sheen
            "equalizer=f=14000:t=o:w=1.5:g=+1.2",  # extended air
        ],
        moves=[
            EqMove("Definition (bright)",     5000,  +1.0, "bell"),
            EqMove("Sheen (bright)",          8000,  +0.8, "bell"),
            EqMove("Extended air (bright)",   14000, +1.2, "bell"),
        ],
    ),

    # Punch: club/EDM — sub weight, tighter mid, transient snap
    "punch": StyleOverlay(
        filters=[
            "equalizer=f=60:t=o:w=0.9:g=+2.5",     # sub-kick weight
            "equalizer=f=350:t=o:w=1.0:g=-2.5",    # tight mid mud cut
            "equalizer=f=2500:t=o:w=1.0:g=+1.5",   # snare/attack snap
        ],
        moves=[
            EqMove("Sub-kick weight (punch)",   60,   +2.5, "bell"),
            EqMove("Mid tightness (punch)",     350,  -2.5, "bell"),
            EqMove("Attack snap (punch)",       2500, +1.5, "bell"),
        ],
    ),

    # ─── Loud ─────────────────────────────────────────────────────────────
    # 음압 강화 — saturation/limiter 적극 사용. EQ 는 mid/high clarity 약간 보강.
    "loud": StyleOverlay(
        filters=[
            "equalizer=f=100:t=o:w=1.0:g=+1.0",    # low body
            "equalizer=f=2500:t=o:w=1.0:g=+0.8",   # presence
            "equalizer=f=4500:t=o:w=1.0:g=+0.8",   # clarity
        ],
        moves=[
            EqMove("Low body (loud)",         100,  +1.0, "bell"),
            EqMove("Presence (loud)",         2500, +0.8, "bell"),
            EqMove("Clarity (loud)",          4500, +0.8, "bell"),
        ],
    ),

    # ─── KPOP Loud (v3.4.6 — telephone-sound fix) ─────────────────────────
    # 기존 overlay 의 누적 문제:
    #   · 80 Hz −1.5 dB (overlay) + 100 Hz −2.5 dB (dynamic boomy_low) +
    #     250 Hz −3 dB (base) + 300 Hz −2 dB (dynamic muddy_lowmid)
    #     → 저역 ~5 dB 손실 = "전화기 소리"
    #   · 2.5k +1.5 + 5.5k +1.2 + 10k +1.0 + 12k +adaptive(~2)
    #     → 고역 +5 dB 누적 부스트 → 더욱 텔레폰화
    #
    # 수정 방침:
    #   1. 80 Hz CUT 제거 → 대신 90 Hz +1 dB 따뜻함 보존 bell
    #   2. high boosts 대폭 축소: 2.5k +1.5 → +1.0 / 5.5k +1.2 → +0.8 /
    #      10k +1.0 → +0.5 (총 +2.3 dB, 가이드 기준 +2.5 dB 이하)
    #   3. dynamic_eq.py / effects.py 에서 동시에 저역/고역 제어 완화
    #   4. pipeline 에 telephone-sound guard 추가
    "kpop_loud": StyleOverlay(
        filters=[
            "equalizer=f=90:t=q:w=0.7:g=+1.0",     # low warmth (저역 보존)
            "equalizer=f=2500:t=o:w=1.1:g=+1.0",   # vocal presence (was +1.5)
            "equalizer=f=5500:t=o:w=1.0:g=+0.8",   # vocal clarity  (was +1.2)
            "equalizer=f=10000:t=o:w=1.2:g=+0.5",  # sheen          (was +1.0)
        ],
        moves=[
            EqMove("Low warmth (kpop)",        90,   +1.0, "bell"),
            EqMove("Vocal presence (kpop)",    2500, +1.0, "bell"),
            EqMove("Vocal clarity (kpop)",     5500, +0.8, "bell"),
            EqMove("Sheen (kpop)",             10000,+0.5, "bell"),
        ],
    ),
}

# ── AI artifact corrections ───────────────────────────────────────────────────

_AI_CORRECTIONS: dict[str, tuple[str, EqMove]] = {
    "harshHighMid": (
        "equalizer=f=4000:t=o:w=2.0:g=-3.0",
        EqMove("Harsh high-mid fix (AI)", 4000, -3.0, "bell"),
    ),
    "boomyLowEnd": (
        "equalizer=f=120:t=o:w=1.0:g=-4.0",
        EqMove("Boomy low-end fix (AI)", 120, -4.0, "bell"),
    ),
}


# ── Public API ────────────────────────────────────────────────────────────────

def build_eq_filter(
    style: str,
    *,
    low_to_mid_db: float = -15.0,
    high_to_mid_db: float = -22.0,
    ai_detections: dict[str, bool] | None = None,
    apply_ai_corrections: bool = True,
) -> str:
    """Return comma-separated FFmpeg filter string (Stage 3)."""
    filter_str, _ = build_eq_filter_with_report(
        style,
        low_to_mid_db=low_to_mid_db,
        high_to_mid_db=high_to_mid_db,
        ai_detections=ai_detections,
        apply_ai_corrections=apply_ai_corrections,
    )
    return filter_str


def build_eq_filter_with_report(
    style: str,
    *,
    low_to_mid_db: float = -15.0,
    high_to_mid_db: float = -22.0,
    ai_detections: dict[str, bool] | None = None,
    apply_ai_corrections: bool = True,
) -> tuple[str, list[dict]]:
    """
    Returns (ffmpeg_filter_str, list_of_eq_move_dicts).

    The eq_move_dicts describe every band applied, including whether each
    was adaptive and what frequency/gain was used — for the analysis report.
    """
    filter_parts: list[str] = []
    all_moves:    list[EqMove] = []

    # 1. AI corrections
    if apply_ai_corrections and ai_detections:
        for key, (filt, move) in _AI_CORRECTIONS.items():
            if ai_detections.get(key):
                filter_parts.append(filt)
                all_moves.append(move)

    # 2. Base EQ
    base_filters, base_moves = _build_base_eq(low_to_mid_db, high_to_mid_db)
    filter_parts.extend(base_filters)
    all_moves.extend(base_moves)

    # 3. Style overlay
    overlay = _STYLE_OVERLAYS.get(style, _STYLE_OVERLAYS["balanced"])
    filter_parts.extend(overlay.filters)
    all_moves.extend(overlay.moves)

    return ",".join(p for p in filter_parts if p), [m.to_dict() for m in all_moves]
