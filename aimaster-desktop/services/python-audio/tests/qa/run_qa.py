"""
활성 코드 QA 하네스.

활성 코드 (`aimaster-desktop/services/python-audio/`) 의 마스터링 엔진을
다양한 시나리오 + 모드 조합으로 자동 회귀 검증한다.

Test groups:
  1. 모든 7 모드 × wide_dynamic — 기본 회귀
  2. high-LUFS 모드 (loud, kpop_loud) × 5 시나리오 — 정적 체인 검증
  3. low-LUFS 모드 (natural, balanced) × 5 시나리오 — loudnorm 2-pass 검증
  4. silence + clipped — 가드 동작
  5. ebur128 short-term spread 측정 (음압 출렁임 검출)

Outputs:
  - /tmp/aim_active_qa_out/<mode>_<sample>.wav
  - /tmp/aim_active_qa_out/qa_report.json
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
from typing import Any

# Project root (= aimaster-desktop/services/python-audio/) on path
_HERE = os.path.dirname(os.path.abspath(__file__))
_PROJ_ROOT = os.path.dirname(os.path.dirname(_HERE))
sys.path.insert(0, _PROJ_ROOT)

from tests.qa.fixtures import generate_all  # noqa: E402
from app.mastering.pipeline import run_pipeline  # noqa: E402

FIXTURES_DIR = "/tmp/aim_active_qa_fixtures"
OUT_DIR      = "/tmp/aim_active_qa_out"
os.makedirs(OUT_DIR, exist_ok=True)


# 모드별 (target_lufs, target_tp, limiter_strength) — shared-types MASTERING_MODES
# 와 일치시켜야 한다.
MODES = {
    "natural":   {"target_lufs": -14.0, "target_tp": -1.0, "limiter": "low"},
    "balanced":  {"target_lufs": -12.0, "target_tp": -1.0, "limiter": "medium"},
    "bright":    {"target_lufs": -12.0, "target_tp": -1.0, "limiter": "medium"},
    "loud":      {"target_lufs": -10.0, "target_tp": -1.0, "limiter": "high"},
    "kpop_loud": {"target_lufs": -9.0,  "target_tp": -0.8, "limiter": "high"},
    "warm":      {"target_lufs": -14.0, "target_tp": -1.0, "limiter": "low"},
    "punch":     {"target_lufs": -11.0, "target_tp": -1.0, "limiter": "high"},
}


def _ebur128_short_term_spread(file_path: str) -> dict[str, float]:
    """
    ffmpeg ebur128 metadata=1 으로 momentary loudness 시계열 추출 →
    P95 - P5 = 출렁임 정도 (LU spread).
    1.0 LU 이하 = 안정, 2.5 LU 이상 = 펌핑 의심.
    """
    # ebur128 frame metadata 는 ametadata=mode=print 로 stdout 에 직접 출력시킨다
    try:
        proc = subprocess.run(
            ["ffmpeg", "-hide_banner", "-nostats", "-i", file_path,
             "-af", "ebur128=metadata=1:peak=true,ametadata=mode=print:key=lavfi.r128.M:file=-",
             "-f", "null", "-"],
            capture_output=True, text=True, timeout=120,
        )
    except Exception as exc:
        return {"error": str(exc), "spread": -1.0}

    text = (proc.stderr or "") + (proc.stdout or "")
    # ffmpeg ebur128 metadata=1 출력 형식 (frame 단위):
    #   "lavfi.r128.M=-23.45" 또는 "[Parsed_ebur128 ... ]   M: -23.4 S: -22.9 ..."
    m_vals = re.findall(r"\bM:\s*(-?\d+\.\d+)", text)
    if not m_vals:
        m_vals = re.findall(r"lavfi\.r128\.M=(-?\d+\.\d+)", text)
    if len(m_vals) < 5:
        return {"spread": -1.0, "n_samples": len(m_vals)}

    arr = sorted(float(v) for v in m_vals if float(v) > -70)
    if not arr:
        return {"spread": -1.0, "n_samples": 0}
    n = len(arr)
    p5  = arr[max(0, int(n * 0.05))]
    p95 = arr[min(n - 1, int(n * 0.95))]
    return {"spread": round(p95 - p5, 2), "p5": p5, "p95": p95, "n_samples": n}


def _master(sample_name: str, sample_path: str, mode: str, ai_corrections: bool = False) -> dict[str, Any]:
    cfg = MODES[mode]
    out_path = os.path.join(OUT_DIR, f"{mode}_{sample_name}.wav")

    t0 = time.time()
    try:
        result = run_pipeline(
            sample_path,
            out_path,
            style=mode,
            target_lufs=cfg["target_lufs"],
            target_tp=cfg["target_tp"],
            sample_rate=44100,
            bit_depth=24,
            apply_ai_corrections=ai_corrections,
            limiter_strength=cfg["limiter"],
        )
    except Exception as exc:
        return {
            "sample": sample_name, "mode": mode, "error": f"{type(exc).__name__}: {exc}",
            "elapsed_s": round(time.time() - t0, 2),
        }

    after = result["loudnessAfter"]
    spread = _ebur128_short_term_spread(out_path)
    meta = (result.get("analysisReport") or {}).get("mastering", {})

    return {
        "sample":            sample_name,
        "mode":              mode,
        "target_lufs":       cfg["target_lufs"],
        "out_lufs":          after.get("integratedLufs"),
        "out_tp":            after.get("truePeakDbtp"),
        "out_lra":           after.get("lra"),
        "tp_within_ceiling": (after.get("truePeakDbtp", 0) - cfg["target_tp"]) <= 0.05,
        "lufs_delta":        round(cfg["target_lufs"] - after.get("integratedLufs", -99), 2),
        "static_chain":      meta.get("staticChain", False),
        "isp_correction_db": meta.get("ispCorrectionDb", 0.0),
        "correction_applied": meta.get("correctionApplied", False),
        "applied_corrections": result.get("appliedCorrections", []),
        "warnings_count":    len(result.get("pipelineWarnings") or []),
        "ebur128_spread":    spread.get("spread"),
        "elapsed_s":         round(time.time() - t0, 2),
    }


def main():
    print("=== Generating fixtures ===")
    fx = generate_all(FIXTURES_DIR)
    for name, path in fx.items():
        print(f"  {name:14s} {path}  ({os.path.getsize(path):,} bytes)")

    report: dict[str, Any] = {"groups": {}}

    # ── Group 1: all modes × wide_dynamic ──────────────────────────────
    print("\n=== Group 1: all 7 modes × wide_dynamic ===")
    g1 = []
    for mode in MODES:
        r = _master("wide_dynamic", fx["wide_dynamic"], mode)
        print(f"  {mode:11s} → out_lufs={r.get('out_lufs')}, "
              f"tp={r.get('out_tp')}, static={r.get('static_chain')}, "
              f"spread={r.get('ebur128_spread')}, isp={r.get('isp_correction_db')}")
        g1.append(r)
    report["groups"]["all_modes_wide_dynamic"] = g1

    # ── Group 2: high-LUFS modes × 5 scenarios (정적 체인 회귀) ────────
    print("\n=== Group 2: high-LUFS modes (loud, kpop_loud) × 5 scenarios ===")
    g2 = []
    for mode in ("loud", "kpop_loud"):
        for sample in ("low_lufs", "wide_dynamic", "bass_heavy", "sibilant", "already_loud"):
            r = _master(sample, fx[sample], mode)
            print(f"  {mode:10s} / {sample:14s} → "
                  f"lufs={r.get('out_lufs')}, tp={r.get('out_tp')}, "
                  f"static={r.get('static_chain')}, spread={r.get('ebur128_spread')}")
            g2.append(r)
    report["groups"]["high_lufs_5_scenarios"] = g2

    # ── Group 3: low-LUFS modes × 5 scenarios (loudnorm 2-pass 회귀) ───
    print("\n=== Group 3: low-LUFS modes (natural) × 5 scenarios ===")
    g3 = []
    for mode in ("natural",):
        for sample in ("low_lufs", "wide_dynamic", "bass_heavy", "sibilant", "already_loud"):
            r = _master(sample, fx[sample], mode)
            print(f"  {mode:10s} / {sample:14s} → "
                  f"lufs={r.get('out_lufs')}, tp={r.get('out_tp')}, "
                  f"static={r.get('static_chain')}, spread={r.get('ebur128_spread')}")
            g3.append(r)
    report["groups"]["low_lufs_5_scenarios"] = g3

    # ── Group 4: silence + clipped (edge cases) ───────────────────────
    print("\n=== Group 4: edge cases (silence, clipped) ===")
    g4 = []
    for sample in ("silence", "clipped"):
        for mode in ("kpop_loud", "natural"):
            r = _master(sample, fx[sample], mode)
            print(f"  {mode:10s} / {sample:14s} → "
                  f"lufs={r.get('out_lufs')}, tp={r.get('out_tp')}, "
                  f"warnings={r.get('warnings_count')}, error={r.get('error', '-')}")
            g4.append(r)
    report["groups"]["edge_cases"] = g4

    out_json = os.path.join(OUT_DIR, "qa_report.json")
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    print(f"\nQA report → {out_json}")

    # 요약
    print("\n=== Summary ===")
    all_results = g1 + g2 + g3 + g4
    tp_failures = [r for r in all_results if not r.get("error") and not r.get("tp_within_ceiling")]
    pumping = [r for r in all_results if isinstance(r.get("ebur128_spread"), (int, float)) and r["ebur128_spread"] > 2.5]
    static_chain_used = [r for r in all_results if r.get("static_chain")]
    errors = [r for r in all_results if r.get("error")]
    print(f"  total runs        : {len(all_results)}")
    print(f"  errors            : {len(errors)}")
    print(f"  TP failures (>ceiling): {len(tp_failures)}")
    print(f"  pumping suspects (>2.5 LU): {len(pumping)}")
    print(f"  static chain used  : {len(static_chain_used)}")


if __name__ == "__main__":
    main()
