"""
Vocal protection — engine-level clamps that keep the lead vocal from being
mush'd into the background, regardless of which mode the user picked.

These limits are applied UNCONDITIONALLY in the active engine — they are not
a user-selectable mode.  The point is "loudness 보다 보컬 명료도 우선" —
vocal clarity wins over loudness, even on kpop_loud.

Clamps:
  · Vocal band (1.5–5 kHz) dynamic-EQ cut ≤ 2.5 dB (hard clamp at 3 dB)
  · Compressor: ratio ≤ 2.0, attack ≥ 25 ms, makeup ≤ 0.7 dB
  · Entry gain (pre-limiter loudness push) ≤ +6 dB
  · Limiter level_in ≤ +0.5 dB (limiter is peak-safety only, not a loudness device)

The pipeline records every clamp it actually applied into a `vocalProtection`
report so the UI can show "보컬 보호 모드 적용됨" and explain WHY.

Usage:
    from app.utils.vocal_protection import VOCAL_PROTECTION as VP

    if reduction_db > VP.MAX_VOCAL_BAND_CUT_DB:
        reduction_db = VP.MAX_VOCAL_BAND_CUT_DB
        protection_log.append(...)
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


# ── Constants ────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class _VocalProtectionConfig:
    # Vocal band definition (Hz)
    BAND_LOW_HZ: float  = 1500.0
    BAND_HIGH_HZ: float = 5000.0

    # Dynamic EQ cut limit — anything past this is clamped automatically.
    MAX_VOCAL_BAND_CUT_DB: float = 2.5
    HARD_CLAMP_VOCAL_BAND_CUT_DB: float = 3.0

    # Compressor caps
    MAX_RATIO:      float = 2.0
    MIN_ATTACK_MS:  float = 25.0
    MAX_MAKEUP_DB:  float = 0.7

    # Entry gain (static-chain pre-limiter loudness match)
    MAX_ENTRY_GAIN_DB: float = 6.0

    # Limiter input gain (peak-safety only)
    MAX_LIMITER_INPUT_GAIN_DB: float = 0.5

    # Detection thresholds for vocal loss (post-master)
    VOCAL_LOSS_WARN_DB:   float = 1.5
    VOCAL_LOSS_DANGER_DB: float = 3.0


VOCAL_PROTECTION = _VocalProtectionConfig()


# ── Reporter (mutable, per-job) ──────────────────────────────────────────────

@dataclass
class VocalProtectionReport:
    """
    Records every clamp the engine actually had to apply.
    Empty `appliedClamps` means the input mode was already vocal-safe.
    """
    enabled: bool = True
    appliedClamps: list[dict[str, Any]] = field(default_factory=list)
    vocalLossDb: float | None = None
    vocalLossSeverity: str = "ok"   # "ok" | "warn" | "danger"
    autoFallbackTriggered: bool = False
    autoFallbackReason: str = ""

    def record_clamp(self, where: str, original: Any, clamped: Any, reason: str) -> None:
        self.appliedClamps.append({
            "where":    where,
            "original": original,
            "clamped":  clamped,
            "reason":   reason,
        })

    def to_dict(self) -> dict[str, Any]:
        return {
            "enabled":               self.enabled,
            "active":                len(self.appliedClamps) > 0,
            "appliedClamps":         list(self.appliedClamps),
            "vocalLossDb":           self.vocalLossDb,
            "vocalLossSeverity":     self.vocalLossSeverity,
            "autoFallbackTriggered": self.autoFallbackTriggered,
            "autoFallbackReason":    self.autoFallbackReason,
            "userMessage":           self.user_message(),
            "config": {
                "vocalBandHz":           [VOCAL_PROTECTION.BAND_LOW_HZ, VOCAL_PROTECTION.BAND_HIGH_HZ],
                "maxVocalBandCutDb":     VOCAL_PROTECTION.MAX_VOCAL_BAND_CUT_DB,
                "maxRatio":              VOCAL_PROTECTION.MAX_RATIO,
                "minAttackMs":           VOCAL_PROTECTION.MIN_ATTACK_MS,
                "maxMakeupDb":           VOCAL_PROTECTION.MAX_MAKEUP_DB,
                "maxEntryGainDb":        VOCAL_PROTECTION.MAX_ENTRY_GAIN_DB,
                "maxLimiterInputGainDb": VOCAL_PROTECTION.MAX_LIMITER_INPUT_GAIN_DB,
            },
        }

    def user_message(self) -> str:
        if not self.appliedClamps and self.vocalLossSeverity == "ok":
            return "보컬 보호 모드: 항상 활성 (이번에는 추가 보정 불필요)"
        if self.autoFallbackTriggered:
            return (
                "보컬 보호 모드 적용됨: 보컬 손실이 감지되어 일부 설정을 자동으로 "
                "보수화했습니다. 보컬이 배경에 묻히지 않도록 dynamic EQ / 컴프 / "
                "limiter 가 더 약하게 작동했습니다."
            )
        if self.appliedClamps:
            return (
                "보컬 보호 모드 적용됨: 메인 멜로디 보존을 위해 일부 설정이 "
                "엔진에 의해 자동 제한되었습니다."
            )
        if self.vocalLossSeverity != "ok":
            return "보컬 손실이 감지되었습니다. Vocal Safe Mode 로 재마스터링을 권장합니다."
        return "보컬 보호 모드: 항상 활성"


# ── Helper clamp functions ──────────────────────────────────────────────────

def clamp_vocal_band_cut(freq_hz: float, reduction_db: float, mode: str) -> float:
    """Clamp dynamic-EQ cut amount when band centre falls in the vocal range."""
    if mode != "cut":
        return reduction_db
    lo = VOCAL_PROTECTION.BAND_LOW_HZ
    hi = VOCAL_PROTECTION.BAND_HIGH_HZ
    if not (lo <= freq_hz <= hi):
        return reduction_db
    return min(reduction_db, VOCAL_PROTECTION.MAX_VOCAL_BAND_CUT_DB)


def clamp_compressor_params(params: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """
    Return (clamped_params, list_of_applied_clamps).
    Caller is responsible for surfacing the clamps via VocalProtectionReport.
    """
    out = dict(params)
    clamps: list[dict[str, Any]] = []
    if float(out.get("ratio", 1.0)) > VOCAL_PROTECTION.MAX_RATIO:
        clamps.append({
            "where":    "compressor.ratio",
            "original": out["ratio"],
            "clamped":  VOCAL_PROTECTION.MAX_RATIO,
            "reason":   "vocal protection: ratio > 2.0 crushes vocal transients",
        })
        out["ratio"] = VOCAL_PROTECTION.MAX_RATIO
    if float(out.get("attack", 100.0)) < VOCAL_PROTECTION.MIN_ATTACK_MS:
        clamps.append({
            "where":    "compressor.attack",
            "original": out["attack"],
            "clamped":  VOCAL_PROTECTION.MIN_ATTACK_MS,
            "reason":   "vocal protection: attack < 25 ms eats vocal transients",
        })
        out["attack"] = VOCAL_PROTECTION.MIN_ATTACK_MS
    if float(out.get("makeup", 0.0)) > VOCAL_PROTECTION.MAX_MAKEUP_DB:
        clamps.append({
            "where":    "compressor.makeup",
            "original": out["makeup"],
            "clamped":  VOCAL_PROTECTION.MAX_MAKEUP_DB,
            "reason":   "vocal protection: makeup > 0.7 dB compounds with entry-gain push",
        })
        out["makeup"] = VOCAL_PROTECTION.MAX_MAKEUP_DB
    return out, clamps


def clamp_entry_gain_db(entry_gain_db: float) -> tuple[float, dict[str, Any] | None]:
    if entry_gain_db <= VOCAL_PROTECTION.MAX_ENTRY_GAIN_DB:
        return entry_gain_db, None
    return VOCAL_PROTECTION.MAX_ENTRY_GAIN_DB, {
        "where":    "static_chain.entry_gain",
        "original": round(entry_gain_db, 2),
        "clamped":  VOCAL_PROTECTION.MAX_ENTRY_GAIN_DB,
        "reason":   "vocal protection: entry gain > +6 dB collapses crest factor",
    }


def clamp_limiter_input_gain_db(level_in_db: float) -> tuple[float, dict[str, Any] | None]:
    if level_in_db <= VOCAL_PROTECTION.MAX_LIMITER_INPUT_GAIN_DB:
        return level_in_db, None
    return VOCAL_PROTECTION.MAX_LIMITER_INPUT_GAIN_DB, {
        "where":    "limiter.level_in_db",
        "original": round(level_in_db, 2),
        "clamped":  VOCAL_PROTECTION.MAX_LIMITER_INPUT_GAIN_DB,
        "reason":   "vocal protection: limiter is peak-safety only, not a loudness device",
    }


def classify_vocal_loss(loss_db: float | None) -> str:
    """Return severity from a vocal-loss reading (output - input vocal-band RMS)."""
    if loss_db is None:
        return "ok"
    if loss_db >= VOCAL_PROTECTION.VOCAL_LOSS_DANGER_DB:
        return "danger"
    if loss_db >= VOCAL_PROTECTION.VOCAL_LOSS_WARN_DB:
        return "warn"
    return "ok"
