"""
Section-aware analyzer (Phase-D, audit 2026-05).

Input: the per-window time series from `compute_segment_timeseries`.
Output: a list of sections with start/end/label and aggregate metrics
(mean LUFS, mean crest factor, peak LUFS).

This is a HEURISTIC analyzer — not full music-information-retrieval
boundary detection.  We use:

  • per-window short-term LUFS energy (already computed)
  • simple median-filter smoothing to remove brief spikes
  • class threshold relative to the per-track median LUFS
  • run-length grouping with min-section-length = 2 seconds

Section labels:
  • "high"  — energy ≥ median + 2 LU (likely chorus / drop / climax)
  • "mid"   — within ±2 LU of median (verse / bridge / sustained)
  • "low"   — energy < median - 2 LU (intro / outro / breakdown)

Plus aggregate insights:
  • dynamicRangeLu — peak section LUFS minus quietest section LUFS
  • highSectionCount / midSectionCount / lowSectionCount
  • alternationScore — 0…1, how often the track alternates between
                       energy classes (1.0 = high/low/high/low pattern;
                       0.0 = constant density throughout).

Used by `mode_suggester` to recommend mastering mode based on the
song's structure (e.g., constant-density tracks fit Loud mode; very
dynamic tracks should use Natural).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, asdict
from typing import Any


@dataclass
class Section:
    start_sec:  float
    end_sec:    float
    label:      str           # 'high' | 'mid' | 'low'
    mean_lufs:  float
    peak_lufs:  float
    mean_crest_db: float
    window_count:  int


def _smooth_median(values: list[float], width: int = 5) -> list[float]:
    """O(n·w) median filter on a value list.  Width is forced odd."""
    if width < 3:
        return list(values)
    if width % 2 == 0:
        width += 1
    half = width // 2
    n = len(values)
    out = [0.0] * n
    for i in range(n):
        lo = max(0, i - half)
        hi = min(n, i + half + 1)
        slice_ = sorted(values[lo:hi])
        out[i] = slice_[len(slice_) // 2]
    return out


def _classify(value: float, median: float, hi_thr: float, lo_thr: float) -> str:
    """Map smoothed LUFS to a class label."""
    if value >= median + hi_thr:
        return "high"
    if value <= median + lo_thr:
        return "low"
    return "mid"


def analyze_sections(
    segment_report: dict[str, Any] | None,
    *,
    high_threshold_lu: float = 2.0,
    low_threshold_lu:  float = -2.0,
    smooth_window:     int = 5,
    min_section_sec:   float = 2.0,
) -> dict[str, Any]:
    """Build a section list from `compute_segment_timeseries` output.

    Returns:
      {
        "sections":       [Section.__dict__, ...],
        "summary": {
          "windowSec":           float,
          "totalWindows":        int,
          "medianLufs":          float,
          "dynamicRangeLu":      float,
          "alternationScore":    float (0–1),
          "highSectionCount":    int,
          "midSectionCount":     int,
          "lowSectionCount":     int,
        },
        "skipped": bool, "reason": str?,
      }
    """
    if not segment_report:
        return {"skipped": True, "reason": "no segment_report",
                "sections": [], "summary": None}
    if segment_report.get("skipped"):
        return {"skipped": True, "reason": str(segment_report.get("skipped")),
                "sections": [], "summary": None}

    windows: list[dict[str, Any]] = segment_report.get("windows", []) or []
    if len(windows) < 4:
        return {"skipped": True, "reason": "too few windows",
                "sections": [], "summary": None}

    window_sec  = float(segment_report.get("windowSec") or 0.5)
    lufs_values = [float(w.get("stLufs", -90.0)) for w in windows]
    crest_values = [float(w.get("crestDb", 0.0)) for w in windows]

    # Smooth so brief spikes don't fragment sections.
    lufs_smooth = _smooth_median(lufs_values, width=smooth_window)

    # Compute median over the gated subset (drop -90 dBFS silence).
    valid = [v for v in lufs_smooth if v > -80.0]
    if len(valid) < 4:
        return {"skipped": True, "reason": "all-silent windows",
                "sections": [], "summary": None}
    valid_sorted = sorted(valid)
    median_lufs  = valid_sorted[len(valid_sorted) // 2]

    # Classify every window.
    labels = [_classify(v, median_lufs, high_threshold_lu, low_threshold_lu)
              for v in lufs_smooth]

    # Run-length encode.
    raw_runs: list[tuple[str, int, int]] = []
    if labels:
        cur_label = labels[0]
        cur_start = 0
        for i, lbl in enumerate(labels[1:], start=1):
            if lbl != cur_label:
                raw_runs.append((cur_label, cur_start, i - 1))
                cur_label, cur_start = lbl, i
        raw_runs.append((cur_label, cur_start, len(labels) - 1))

    # Drop runs shorter than min_section_sec — merge them into the
    # neighboring run with the same label preference (left-bias).
    min_windows = max(1, int(round(min_section_sec / window_sec)))
    merged: list[tuple[str, int, int]] = []
    for label, lo, hi in raw_runs:
        length = hi - lo + 1
        if length >= min_windows or not merged:
            merged.append((label, lo, hi))
        else:
            # Absorb into previous run (extends right boundary).
            prev_label, prev_lo, _prev_hi = merged[-1]
            merged[-1] = (prev_label, prev_lo, hi)

    sections: list[Section] = []
    for label, lo, hi in merged:
        section_lufs  = lufs_values[lo:hi + 1]
        section_crest = crest_values[lo:hi + 1]
        valid_sec_lufs = [v for v in section_lufs if v > -80.0]
        mean_l = sum(valid_sec_lufs) / len(valid_sec_lufs) if valid_sec_lufs else -90.0
        peak_l = max(section_lufs) if section_lufs else -90.0
        mean_c = sum(section_crest) / len(section_crest) if section_crest else 0.0
        sections.append(Section(
            start_sec     = round(lo * window_sec, 3),
            end_sec       = round((hi + 1) * window_sec, 3),
            label         = label,
            mean_lufs     = round(mean_l, 2),
            peak_lufs     = round(peak_l, 2),
            mean_crest_db = round(mean_c, 2),
            window_count  = hi - lo + 1,
        ))

    high_n = sum(1 for s in sections if s.label == "high")
    mid_n  = sum(1 for s in sections if s.label == "mid")
    low_n  = sum(1 for s in sections if s.label == "low")

    # Alternation score — counts label changes vs total transitions
    # possible.  1.0 = every adjacent pair differs (max alternation).
    transitions = sum(1 for i in range(1, len(sections))
                      if sections[i].label != sections[i - 1].label)
    alternation = (transitions / max(1, len(sections) - 1)) if sections else 0.0

    # Dynamic range: peak section mean LUFS minus quietest section mean LUFS.
    means = [s.mean_lufs for s in sections if s.mean_lufs > -80.0]
    dr_lu = (max(means) - min(means)) if len(means) >= 2 else 0.0

    summary = {
        "windowSec":         round(window_sec, 3),
        "totalWindows":      len(windows),
        "medianLufs":        round(median_lufs, 2),
        "dynamicRangeLu":    round(float(dr_lu), 2),
        "alternationScore":  round(float(alternation), 3),
        "highSectionCount":  high_n,
        "midSectionCount":   mid_n,
        "lowSectionCount":   low_n,
    }

    return {
        "skipped": False,
        "sections": [asdict(s) for s in sections],
        "summary":  summary,
    }


def suggest_mode_from_sections(
    section_report: dict[str, Any] | None,
    *,
    current_style: str = "balanced",
) -> dict[str, Any]:
    """Recommend a mastering mode based on the section structure.

    Heuristics (all conservative — only suggest if evidence is strong):

      • dynamicRangeLu ≥ 10 AND ≥ 2 high sections → song has explicit
        contrast → Natural / Balanced preserves the movement.  Loud
        modes would flatten it.

      • alternationScore ≥ 0.6 AND highSectionCount ≥ 2 → typical
        verse/chorus song → Balanced is a safe default.

      • alternationScore ≤ 0.2 AND dynamicRangeLu ≤ 4 → constant density
        (drone / EDM build-up / single-section piece) → Loud / KPOP_Loud
        appropriate; users gain nothing from preserving non-existent
        contrast.

    Returns:
      {
        "suggestedMode": str | None,
        "confidence":    'low' | 'medium' | 'high',
        "reason":        str (Korean),
        "currentMode":   str,
        "wouldChange":   bool,
      }
    """
    if not section_report or section_report.get("skipped"):
        return {"suggestedMode": None, "confidence": "low",
                "reason": "section analysis 미수행",
                "currentMode": current_style, "wouldChange": False}

    summary = section_report.get("summary") or {}
    dr  = float(summary.get("dynamicRangeLu", 0.0))
    alt = float(summary.get("alternationScore", 0.0))
    high_n = int(summary.get("highSectionCount", 0))

    # Very dynamic — suggest Natural to preserve contrast.
    if dr >= 10.0 and high_n >= 2:
        return {
            "suggestedMode": "natural",
            "confidence":   "high" if dr >= 14.0 else "medium",
            "reason":       (f"섹션 간 LUFS 차이 {dr:.1f} LU + chorus {high_n}개 — "
                             f"다이내믹 컨트라스트가 큰 곡입니다.  "
                             f"Natural 모드로 곡의 움직임을 보존하세요."),
            "currentMode":   current_style,
            "wouldChange":   current_style not in ("natural",),
        }

    # Constant density — Loud / KPOP_Loud is fine.
    if alt <= 0.2 and dr <= 4.0:
        suggested = "loud" if current_style not in ("loud", "kpop_loud") else current_style
        return {
            "suggestedMode": suggested,
            "confidence":    "medium",
            "reason":        (f"섹션 다양성 낮음 (변화 비율 {alt:.2f}, "
                              f"LUFS 변화 {dr:.1f} LU) — 일정한 에너지의 곡입니다.  "
                              f"Loud 모드로 음압을 끌어올려도 손실이 적습니다."),
            "currentMode":   current_style,
            "wouldChange":   current_style != suggested,
        }

    # Typical verse/chorus structure — Balanced is the safe bet.
    if alt >= 0.6 and high_n >= 2:
        return {
            "suggestedMode": "balanced",
            "confidence":    "medium",
            "reason":        (f"verse/chorus 패턴 (변화 비율 {alt:.2f}, "
                              f"chorus {high_n}개) — Balanced 모드 권장."),
            "currentMode":   current_style,
            "wouldChange":   current_style != "balanced",
        }

    # Otherwise no opinion.
    return {
        "suggestedMode": None,
        "confidence":   "low",
        "reason":       (f"섹션 패턴 분석으로는 명확한 권장 모드 없음 "
                         f"(LUFS 변화 {dr:.1f} LU, 변화 비율 {alt:.2f})."),
        "currentMode":   current_style,
        "wouldChange":   False,
    }
