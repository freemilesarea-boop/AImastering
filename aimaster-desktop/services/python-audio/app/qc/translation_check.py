"""
Translation-aware QC (Phase-C, audit 2026-05).

Runs the master through 4 simulated playback chains and the YouTube
Music normalization, then surfaces warnings when the master fails to
translate.  Wrapped as a single function call so the pipeline can
invoke it as a post-master quality stage and append findings to
`pipelineWarnings` (matches the existing QC pattern).

What we check:

  • PHONE_SPEAKER  — after the BPF + force-mono, the LUFS must not
                      drop more than 8 LU vs the headphones reference.
                      Bigger drop = master has too much energy outside
                      the 300–3500 Hz band that phone listeners can't
                      hear.
  • CAR_DASH      — measure overall loudness change.  If post-EQ
                      LUFS jumps > 5 LU above headphones, the master
                      has too much sub / harsh-mid that the car's
                      resonance amplifies → "boomy in the car".
  • MONO_FOLD     — sum L+R via pan and re-measure.  If the mono LUFS
                      is more than 4 LU below stereo (= comb-filter
                      cancellation), the master has phase issues that
                      collapse mono.
  • YOUTUBE_NORMALIZE — apply YouTube's attenuate-only-to-(-14)
                       policy.  Flag when our post-normalize peak
                       still exceeds -1 dBTP (= we shipped too hot).

Each check returns a tuple (verdict, message) where verdict is
'ok' | 'warn' | 'danger'.

This is non-corrective — the report is informational so users can
decide to re-master in a different mode (e.g., "loud → balanced for
better phone translation").
"""
from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from typing import Any

from app.utils.translation_sim import (
    PHONE_SPEAKER, CAR_DASH, LAPTOP_SPEAKER, HEADPHONES,
    apply_translation, youtube_normalize,
)
from app.utils.ffmpeg_wrapper import measure_output, _FFMPEG_BIN
from app.utils.logger import log


@dataclass
class TranslationFinding:
    profile: str
    verdict: str          # 'ok' | 'warn' | 'danger'
    code:    str          # warning code for pipeline_warnings
    message: str          # human-readable message
    measured_lufs:   float | None = None
    measured_tp_db:  float | None = None


# ── Thresholds ─────────────────────────────────────────────────────────────

# When phone-speaker LUFS drops more than this much vs headphones,
# master is too dependent on bass / air bands the phone can't reproduce.
PHONE_LUFS_DROP_WARN_LU:    float = 8.0
PHONE_LUFS_DROP_DANGER_LU:  float = 12.0

# Car-dash gains too much from the resonance bumps → boomy/harsh in car.
CAR_LUFS_GAIN_WARN_LU:      float = 5.0
CAR_LUFS_GAIN_DANGER_LU:    float = 8.0

# Mono-fold loss = headphones LUFS - mono-summed LUFS.
# Phase issues cause cancellation → big loss.
MONO_FOLD_LOSS_WARN_LU:     float = 3.0
MONO_FOLD_LOSS_DANGER_LU:   float = 6.0

# YouTube post-normalize TP must be safe.
YT_TP_DANGER_DBTP:          float = -0.5


# ── Helpers ────────────────────────────────────────────────────────────────

def _measure_lufs_tp(path: str) -> tuple[float, float]:
    """Return (integratedLufs, truePeakDbtp) for a file."""
    m = measure_output(path, -14.0, -1.0)
    return m["integratedLufs"], m["truePeakDbtp"]


def _force_mono_render(input_path: str) -> str:
    """Sum to mono via ffmpeg pan, then duplicate to stereo so the
    measurement framework still sees a stereo file (fair compare)."""
    fd, out = tempfile.mkstemp(suffix="_mono.wav", prefix="aimaster_xlate_")
    os.close(fd)
    import subprocess
    proc = subprocess.run([
        _FFMPEG_BIN, "-hide_banner", "-y", "-i", input_path,
        "-af", "pan=stereo|c0<c0+c1|c1<c0+c1",
        "-acodec", "pcm_s24le", "-ar", "44100", out,
    ], capture_output=True, text=True, timeout=120)
    if proc.returncode != 0:
        try: os.unlink(out)
        except OSError: pass
        raise RuntimeError(f"mono fold render failed: {proc.stderr[-1000:]}")
    return out


# ── Public API ────────────────────────────────────────────────────────────

def run_translation_check(
    output_path: str,
    *,
    target_lufs: float = -12.0,
) -> dict[str, Any]:
    """Run all translation checks against `output_path`.  Returns a
    dict with `findings` (per-profile structured TranslationFinding
    objects) and a top-level `verdict` ('ok'/'warn'/'danger').

    Cleans up its own temp files on the way out.
    """
    findings: list[TranslationFinding] = []
    tmp_files: list[str] = []
    try:
        # Reference (headphones) — what the listener hears on a flat chain.
        try:
            ref_path = apply_translation(output_path, HEADPHONES)
            tmp_files.append(ref_path)
            ref_lufs, _ref_tp = _measure_lufs_tp(ref_path)
        except Exception as exc:
            log("WARN", f"[translation] headphones reference failed: {exc}")
            return {"verdict": "ok", "findings": [], "skipped": True,
                    "reason": str(exc)}

        # PHONE_SPEAKER — measure LUFS drop vs reference.
        try:
            ph_path = apply_translation(output_path, PHONE_SPEAKER)
            tmp_files.append(ph_path)
            ph_lufs, ph_tp = _measure_lufs_tp(ph_path)
            drop = ref_lufs - ph_lufs
            if drop >= PHONE_LUFS_DROP_DANGER_LU:
                findings.append(TranslationFinding(
                    profile="phone_speaker", verdict="danger",
                    code="PHONE_TRANSLATION_DANGER",
                    message=(f"전화기 스피커에서 {drop:.1f} LU 손실 — "
                             f"마스터의 에너지가 300–3500 Hz 밖에 너무 많습니다. "
                             f"베이스/에어 의존도가 높아 모바일 청취 시 약하게 들립니다."),
                    measured_lufs=ph_lufs, measured_tp_db=ph_tp,
                ))
            elif drop >= PHONE_LUFS_DROP_WARN_LU:
                findings.append(TranslationFinding(
                    profile="phone_speaker", verdict="warn",
                    code="PHONE_TRANSLATION_WARN",
                    message=(f"전화기 스피커에서 {drop:.1f} LU 손실 — "
                             f"전화기/BT 모노 청취 시 임팩트가 줄어들 수 있습니다."),
                    measured_lufs=ph_lufs, measured_tp_db=ph_tp,
                ))
            else:
                findings.append(TranslationFinding(
                    profile="phone_speaker", verdict="ok",
                    code="PHONE_TRANSLATION_OK",
                    message=f"전화기 스피커 통과 ({drop:.1f} LU 손실)",
                    measured_lufs=ph_lufs, measured_tp_db=ph_tp,
                ))
        except Exception as exc:
            log("WARN", f"[translation] phone profile failed: {exc}")

        # CAR_DASH — gain check.
        try:
            ca_path = apply_translation(output_path, CAR_DASH)
            tmp_files.append(ca_path)
            ca_lufs, ca_tp = _measure_lufs_tp(ca_path)
            gain = ca_lufs - ref_lufs
            if gain >= CAR_LUFS_GAIN_DANGER_LU:
                findings.append(TranslationFinding(
                    profile="car_dash", verdict="danger",
                    code="CAR_TRANSLATION_DANGER",
                    message=(f"자동차 시뮬에서 {gain:+.1f} LU 부스트 — "
                             f"서브 / 3.5 kHz 영역이 너무 강해 자동차에서 boomy / 거칠게 들립니다."),
                    measured_lufs=ca_lufs, measured_tp_db=ca_tp,
                ))
            elif gain >= CAR_LUFS_GAIN_WARN_LU:
                findings.append(TranslationFinding(
                    profile="car_dash", verdict="warn",
                    code="CAR_TRANSLATION_WARN",
                    message=(f"자동차 시뮬에서 {gain:+.1f} LU 부스트 — "
                             f"저역 / 미드 hump 가 강조됩니다."),
                    measured_lufs=ca_lufs, measured_tp_db=ca_tp,
                ))
            else:
                findings.append(TranslationFinding(
                    profile="car_dash", verdict="ok",
                    code="CAR_TRANSLATION_OK",
                    message=f"자동차 통과 ({gain:+.1f} LU)",
                    measured_lufs=ca_lufs, measured_tp_db=ca_tp,
                ))
        except Exception as exc:
            log("WARN", f"[translation] car profile failed: {exc}")

        # MONO_FOLD — phase compatibility check.
        try:
            mono_path = _force_mono_render(output_path)
            tmp_files.append(mono_path)
            mono_lufs, _mono_tp = _measure_lufs_tp(mono_path)
            loss = ref_lufs - mono_lufs
            if loss >= MONO_FOLD_LOSS_DANGER_LU:
                findings.append(TranslationFinding(
                    profile="mono_fold", verdict="danger",
                    code="MONO_FOLD_DANGER",
                    message=(f"모노 폴드 시 {loss:.1f} LU 손실 — "
                             f"위상 문제로 모노 재생 (BT 스피커, AM 라디오, 식당) "
                             f"에서 강한 cancellation 발생."),
                    measured_lufs=mono_lufs,
                ))
            elif loss >= MONO_FOLD_LOSS_WARN_LU:
                findings.append(TranslationFinding(
                    profile="mono_fold", verdict="warn",
                    code="MONO_FOLD_WARN",
                    message=(f"모노 폴드 시 {loss:.1f} LU 손실 — "
                             f"side 신호의 일부가 cancel 됩니다."),
                    measured_lufs=mono_lufs,
                ))
            else:
                findings.append(TranslationFinding(
                    profile="mono_fold", verdict="ok",
                    code="MONO_FOLD_OK",
                    message=f"모노 호환성 통과 ({loss:+.1f} LU 손실)",
                    measured_lufs=mono_lufs,
                ))
        except Exception as exc:
            log("WARN", f"[translation] mono fold failed: {exc}")

        # YOUTUBE_NORMALIZE — TP safety after attenuation.
        try:
            yt_path = youtube_normalize(output_path)
            tmp_files.append(yt_path)
            yt_lufs, yt_tp = _measure_lufs_tp(yt_path)
            if yt_tp >= YT_TP_DANGER_DBTP:
                findings.append(TranslationFinding(
                    profile="youtube_normalize", verdict="danger",
                    code="YT_TP_OVER_BUDGET",
                    message=(f"YouTube Music normalize 후에도 TP {yt_tp:+.2f} dBTP — "
                             f"안전 마진 부족.  marker peaks가 여전히 -1 dBTP를 초과합니다."),
                    measured_lufs=yt_lufs, measured_tp_db=yt_tp,
                ))
            else:
                findings.append(TranslationFinding(
                    profile="youtube_normalize", verdict="ok",
                    code="YT_NORMALIZE_OK",
                    message=(f"YouTube Music normalize OK "
                             f"(post-normalize TP={yt_tp:+.2f} dBTP)"),
                    measured_lufs=yt_lufs, measured_tp_db=yt_tp,
                ))
        except Exception as exc:
            log("WARN", f"[translation] youtube_normalize failed: {exc}")

    finally:
        for p in tmp_files:
            try: os.unlink(p)
            except OSError: pass

    # Aggregate verdict.
    has_danger = any(f.verdict == "danger" for f in findings)
    has_warn   = any(f.verdict == "warn"   for f in findings)
    overall    = "danger" if has_danger else ("warn" if has_warn else "ok")

    return {
        "verdict": overall,
        "findings": [f.__dict__ for f in findings],
        "skipped": False,
    }
