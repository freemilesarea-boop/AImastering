"""
v3.2 마스터링 엔진 QA 하네스.

각 테스트는 run_mastering() 을 직접 호출하고 결과를 dict 로 수집한다.
ffmpeg 로 결과 파일의 short-term LUFS 시계열도 측정해 출렁임 정량 수치 산출.
"""
import os
import sys
import json
import shutil
import math
import re
import subprocess
import time
from typing import Dict, Any, List, Optional, Tuple

# 프로젝트 루트
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, ROOT)

from python.pipeline.mastering import run_mastering
from python.pipeline.master_chain import build_master_chain, get_correction_chain
from python.pipeline.dynamic_eq import build_dynamic_eq_chain
from python.utils.ffmpeg_wrapper import (
    detect_adynamicequalizer_support, run_command, loudnorm_pass1
)
from python.analysis.metrics import compute_metrics
from python.analysis.quality_check import run_quality_check
from python.pipeline.analyzer import analyze_file


def measure_short_term_lu_spread(file_path: str, ffmpeg_path: str = "ffmpeg") -> Optional[float]:
    """
    ffmpeg ebur128 으로 short-term LUFS 시계열을 추출하고 P95-P5 spread 계산.
    실패 시 None.
    """
    log_file = file_path + ".ebur.log"
    cmd = [
        ffmpeg_path, "-nostdin", "-hide_banner", "-i", file_path,
        "-af", "ebur128=peak=true:metadata=1,ametadata=mode=print:file=" + log_file,
        "-f", "null", "-"
    ]
    code, _, stderr = run_command(cmd, timeout=120)
    if code != 0:
        return None
    if not os.path.exists(log_file):
        return None
    st_values: List[float] = []
    with open(log_file) as f:
        for ln in f:
            m = re.search(r"lavfi\.r128\.S=(-?\d+\.?\d*)", ln)
            if m:
                v = float(m.group(1))
                # ebur128 가 측정 윈도우 채우기 전에는 -120 같은 값을 내므로 -70 이하 제외
                if v > -70:
                    st_values.append(v)
    try: os.remove(log_file)
    except OSError: pass
    if len(st_values) < 5:
        return None
    arr = sorted(st_values)
    p5  = arr[max(0, int(len(arr) * 0.05))]
    p95 = arr[min(len(arr) - 1, int(len(arr) * 0.95))]
    return round(p95 - p5, 2)


def master_with_options(
    input_path: str,
    output_path: str,
    options: Dict[str, Any],
    job_id: str = None,
) -> Dict[str, Any]:
    """run_mastering 직접 호출"""
    job_id = job_id or os.path.basename(input_path).replace(".wav", "")
    # waveform 비활성 (테스트 속도)
    opts = {**options, "enableWaveform": False}
    return run_mastering(
        job_id=job_id,
        input_path=input_path,
        output_path=output_path,
        options=opts,
        ffmpeg_path="ffmpeg",
        ffprobe_path="ffprobe",
        temp_dir="/tmp/aim_qa_out",
    )


# ─────────────────────────────────────────────────────
# Test 1: KPOP regression
# ─────────────────────────────────────────────────────
KPOP_OPTIONS = {
    "mode": "kpop_loud",
    "targetLUFS": -10.0,
    "targetTruePeak": -1.0,
    "limiterStrength": "high",
    "outputFormat": "wav",
    "outputBitDepth": 24,
    "outputSampleRate": 44100,
    "outputPath": "",  # 채워질 자리
}


def kpop_regression(in_dir: str, out_dir: str) -> List[Dict[str, Any]]:
    samples = ["low_lufs", "wide_dynamic", "bass_heavy", "sibilant", "already_loud"]
    rows = []
    for name in samples:
        in_path  = os.path.join(in_dir,  f"{name}.wav")
        out_path = os.path.join(out_dir, f"{name}_kpop_v3_2.wav")
        opts = {**KPOP_OPTIONS, "outputPath": out_path}
        t0 = time.time()
        try:
            r = master_with_options(in_path, out_path, opts, job_id=f"kpop-{name}")
            elapsed = time.time() - t0
            rep   = r.get("report", {}) or {}
            qc    = r.get("qualityCheck", {}) or {}
            outm  = r.get("outputMetrics", {}) or {}
            inm   = r.get("inputMetrics", {}) or {}
            spread = measure_short_term_lu_spread(out_path)
            rows.append({
                "sample":               name,
                "input_lufs":           inm.get("lufsIntegrated"),
                "output_lufs":          outm.get("lufsIntegrated"),
                "true_peak":            outm.get("truePeak"),
                "rms_db":               outm.get("rmsDb"),
                "crest":                outm.get("crestFactor"),
                "lra":                  outm.get("lra"),
                "short_term_var":       outm.get("shortTermVarLU"),
                "ebur128_st_spread":    spread,
                "clipping_samples":     outm.get("clippingSamples"),
                "pumping_risk":         outm.get("pumpingRisk"),
                "qc_overall":           qc.get("overall"),
                "target_reached":       rep.get("targetReached"),
                "entry_gain_db":        rep.get("entryGainDb"),
                "correction_applied":   rep.get("correctionApplied"),
                "elapsed_s":            round(elapsed, 2),
                "warnings":             rep.get("warnings", []),
            })
        except Exception as e:
            rows.append({"sample": name, "error": f"{type(e).__name__}: {e}"})
    return rows


# ─────────────────────────────────────────────────────
# Test 2: v3.1 vs v3.2 비교
# ─────────────────────────────────────────────────────
def simulate_v31_chain(input_path: str, output_path: str, mode: str = "kpop_loud") -> Dict[str, Any]:
    """
    v3.1 동작 재현: build_master_chain (entry_gain_db=0) + loudnorm pass2 (linear=True).
    v3.2 와 같은 입력에 대해 비교 가능.
    """
    from python.utils.ffmpeg_wrapper import loudnorm_pass2
    from python.pipeline.master_chain import build_master_chain as build_chain
    target_lufs = -10.0
    target_tp   = -1.0

    measurements = loudnorm_pass1(input_path, target_lufs=target_lufs, target_lra=11.0,
                                   target_tp=target_tp, ffmpeg_path="ffmpeg")
    ci = build_chain(mode, target_true_peak=target_tp, limiter_strength="high",
                     entry_gain_db=0.0)  # v3.1 처럼 entry gain 없음
    loudnorm_pass2(
        input_path=input_path, output_path=output_path,
        measurements=measurements, target_lufs=target_lufs, target_lra=11.0,
        target_tp=target_tp, output_format="wav", bit_depth=24, sample_rate=44100,
        ffmpeg_path="ffmpeg", extra_filters=ci["chain"], linear=True,
    )
    return {"chain": ci["chain"]}


def v31_vs_v32_compare(in_dir: str, out_dir: str) -> List[Dict[str, Any]]:
    samples = ["wide_dynamic", "bass_heavy", "sibilant"]
    rows = []
    for name in samples:
        in_path = os.path.join(in_dir, f"{name}.wav")

        # v3.1 시뮬레이션
        v31_out = os.path.join(out_dir, f"{name}_v31.wav")
        try:
            simulate_v31_chain(in_path, v31_out, mode="kpop_loud")
            v31_spread = measure_short_term_lu_spread(v31_out)
            v31_an = analyze_file(v31_out, "ffmpeg", "ffprobe")
            v31_metrics = compute_metrics(v31_out, v31_an)
        except Exception as e:
            v31_spread = None
            v31_metrics = {"error": str(e)}

        # v3.2 (실제 엔진)
        v32_out = os.path.join(out_dir, f"{name}_v32.wav")
        opts = {**KPOP_OPTIONS, "outputPath": v32_out}
        try:
            r = master_with_options(in_path, v32_out, opts, job_id=f"v32-{name}")
            v32_metrics = r.get("outputMetrics", {}) or {}
            v32_spread = measure_short_term_lu_spread(v32_out)
        except Exception as e:
            v32_metrics = {"error": str(e)}
            v32_spread = None

        delta_st = None
        if v31_spread is not None and v32_spread is not None:
            delta_st = round(v32_spread - v31_spread, 2)

        rows.append({
            "sample": name,
            "v31_lufs":       v31_metrics.get("lufsIntegrated"),
            "v32_lufs":       v32_metrics.get("lufsIntegrated"),
            "v31_tp":         v31_metrics.get("truePeak"),
            "v32_tp":         v32_metrics.get("truePeak"),
            "v31_lra":        v31_metrics.get("lra"),
            "v32_lra":        v32_metrics.get("lra"),
            "v31_crest":      v31_metrics.get("crestFactor"),
            "v32_crest":      v32_metrics.get("crestFactor"),
            "v31_st_spread":  v31_spread,
            "v32_st_spread":  v32_spread,
            "delta_st_spread": delta_st,
        })
    return rows


# ─────────────────────────────────────────────────────
# Test 3: entry_gain_db clamp
# ─────────────────────────────────────────────────────
def entry_gain_clamp(in_dir: str, out_dir: str) -> List[Dict[str, Any]]:
    rows = []
    # case A: silence input + KPOP -10 LUFS  → 비정상 큰 push 요청 → clamp +24 검증 + 경고
    silence_in = os.path.join(in_dir, "silence.wav")
    silence_out = os.path.join(out_dir, "silence_kpop.wav")
    opts = {**KPOP_OPTIONS, "outputPath": silence_out}
    try:
        r = master_with_options(silence_in, silence_out, opts, job_id="clamp-pos")
        rep = r.get("report", {}) or {}
        rows.append({
            "case": "silence → KPOP -10",
            "entry_gain_db":   rep.get("entryGainDb"),
            "warnings":        rep.get("warnings", []),
            "target_reached":  rep.get("targetReached"),
            "expected":        "entry_gain_db == 24.0 (clamped) + clamp 경고 발생",
        })
    except Exception as e:
        rows.append({"case": "silence → KPOP", "error": str(e)})

    # case B: already-loud input + Natural -14 LUFS → 음수 게인 (-3~-5dB 정도 예상)
    loud_in = os.path.join(in_dir, "already_loud.wav")
    loud_out = os.path.join(out_dir, "loud_to_natural.wav")
    natural_opts = {**KPOP_OPTIONS,
                    "mode": "natural", "targetLUFS": -14.0, "limiterStrength": "low",
                    "outputPath": loud_out}
    try:
        r = master_with_options(loud_in, loud_out, natural_opts, job_id="clamp-neg")
        rep = r.get("report", {}) or {}
        rows.append({
            "case": "already_loud → Natural -14",
            "entry_gain_db":   rep.get("entryGainDb"),
            "warnings":        rep.get("warnings", []),
            "target_reached":  rep.get("targetReached"),
            "expected":        "entry_gain_db < 0 (down-leveling)",
        })
    except Exception as e:
        rows.append({"case": "already_loud → Natural", "error": str(e)})

    # case C: 정상 케이스 (low_lufs → KPOP) — clamp 없는 정상 경로 비교용
    norm_in  = os.path.join(in_dir, "low_lufs.wav")
    norm_out = os.path.join(out_dir, "low_to_kpop.wav")
    opts = {**KPOP_OPTIONS, "outputPath": norm_out}
    try:
        r = master_with_options(norm_in, norm_out, opts, job_id="clamp-normal")
        rep = r.get("report", {}) or {}
        rows.append({
            "case": "low_lufs → KPOP -10 (normal)",
            "entry_gain_db":   rep.get("entryGainDb"),
            "warnings":        rep.get("warnings", []),
            "target_reached":  rep.get("targetReached"),
            "expected":        "entry_gain_db ~ 16 dB (clamp 없이 통과)",
        })
    except Exception as e:
        rows.append({"case": "low_lufs → KPOP", "error": str(e)})

    return rows


# ─────────────────────────────────────────────────────
# Test 4: 품질 체크 트리거
# ─────────────────────────────────────────────────────
def quality_check_triggers(in_dir: str, out_dir: str) -> List[Dict[str, Any]]:
    """
    각 시나리오에서 quality_check 가 어떤 항목을 어떤 status 로 분류하는지 확인.
    각 시나리오의 '예상 trigger' 와 실제 결과를 비교.
    """
    rows = []

    cases = [
        # (이름, 입력, 옵션, 예상되는 위험 신호 키워드)
        ("clipped_input",        "clipped",       KPOP_OPTIONS, ["클리핑"]),
        ("wide_dynamic_kpop",    "wide_dynamic",  KPOP_OPTIONS, ["음압 안정성", "Amplitude Drop"]),
        ("already_loud_kpop",    "already_loud",  KPOP_OPTIONS, ["과압축"]),
        ("low_lufs_kpop",        "low_lufs",      KPOP_OPTIONS, []),  # 모두 OK 기대
    ]

    for case_name, fixture, base_opts, expected_warns in cases:
        in_path = os.path.join(in_dir, f"{fixture}.wav")
        out_path = os.path.join(out_dir, f"qc_{case_name}.wav")
        opts = {**base_opts, "outputPath": out_path}
        try:
            r = master_with_options(in_path, out_path, opts, job_id=f"qc-{case_name}")
            qc = r.get("qualityCheck", {}) or {}
            items = qc.get("items", [])
            triggered_non_ok = [it for it in items if it.get("status") in ("warn", "danger")]
            rows.append({
                "case":              case_name,
                "qc_overall":        qc.get("overall"),
                "qc_items_total":    len(items),
                "warn_or_danger":    [
                    {"name": it["name"], "status": it["status"], "message": it["message"][:80]}
                    for it in triggered_non_ok
                ],
                "expected_keywords": expected_warns,
            })
        except Exception as e:
            rows.append({"case": case_name, "error": str(e)})
    return rows


# ─────────────────────────────────────────────────────
# Test 5: Dynamic EQ — adynamicequalizer + fallback
# ─────────────────────────────────────────────────────
def dynamic_eq_paths(in_dir: str, out_dir: str) -> List[Dict[str, Any]]:
    rows = []
    in_path = os.path.join(in_dir, "sibilant.wav")
    adyn_supported = detect_adynamicequalizer_support("ffmpeg")

    for use_adyn in (True, False):
        if use_adyn and not adyn_supported:
            rows.append({"path": "adynamicequalizer", "skipped": "ffmpeg 빌드 미지원"})
            continue

        out_path = os.path.join(out_dir, f"dyn_{'adyn' if use_adyn else 'fallback'}.wav")
        # 강제 fallback 을 위해 chain 을 직접 빌드 + apply_chain_static 로 적용
        ci = build_master_chain(
            "kpop_loud", target_true_peak=-1.0, limiter_strength="high",
            entry_gain_db=10.0, enable_dynamic_eq=True,
            ffmpeg_supports_adynamic_eq=use_adyn,
        )
        from python.utils.ffmpeg_wrapper import apply_chain_static
        try:
            apply_chain_static(in_path, out_path, ci["chain"],
                               output_format="wav", bit_depth=24, sample_rate=44100,
                               ffmpeg_path="ffmpeg")
            ok = os.path.exists(out_path) and os.path.getsize(out_path) > 1024
            spread = measure_short_term_lu_spread(out_path) if ok else None
            rows.append({
                "path":       "adynamicequalizer" if use_adyn else "fallback",
                "success":    ok,
                "stages":     ci["stages"],
                "dyn_eq":     ci["dynamic_eq"],
                "st_spread":  spread,
            })
        except Exception as e:
            rows.append({
                "path":    "adynamicequalizer" if use_adyn else "fallback",
                "success": False,
                "error":   str(e),
            })

    return rows


# ─────────────────────────────────────────────────────
# Test 6: 경로 / 파일명 안전성
# ─────────────────────────────────────────────────────
def path_safety(in_dir: str, out_dir: str) -> List[Dict[str, Any]]:
    rows = []
    src = os.path.join(in_dir, "low_lufs.wav")

    cases = [
        ("ascii",         "track_001.wav"),
        ("with_space",    "my track.wav"),
        ("hangul",        "한국어 곡명.wav"),
        ("special_chars", "track [v3.2] - test (#1).wav"),
        ("very_long",     "a" * 120 + ".wav"),
    ]

    for case_name, filename in cases:
        case_dir = os.path.join(out_dir, "path_safety", case_name)
        os.makedirs(case_dir, exist_ok=True)
        # 입력도 같은 case 디렉토리로 복사 (한글/공백 포함된 입력 경로 시뮬레이션)
        in_copy = os.path.join(case_dir, filename)
        try:
            shutil.copy(src, in_copy)
        except Exception as e:
            rows.append({"case": case_name, "stage": "copy", "error": str(e)})
            continue

        out_name = "out_" + filename
        out_path = os.path.join(case_dir, out_name)
        opts = {**KPOP_OPTIONS, "outputPath": out_path}
        try:
            r = master_with_options(in_copy, out_path, opts, job_id=f"path-{case_name}")
            rep = r.get("report", {}) or {}
            preview = r.get("previewPath")
            rows.append({
                "case":            case_name,
                "filename":        filename,
                "filename_len":    len(filename),
                "input_exists":    os.path.exists(in_copy),
                "output_exists":   os.path.exists(out_path),
                "preview_exists":  bool(preview) and os.path.exists(preview),
                "target_reached":  rep.get("targetReached"),
                "warnings_count":  len(rep.get("warnings", [])),
            })
        except Exception as e:
            rows.append({
                "case":     case_name,
                "filename": filename,
                "error":    f"{type(e).__name__}: {e}",
            })
    return rows


# ─────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────
def main():
    in_dir  = "/tmp/aim_qa_in"
    out_dir = "/tmp/aim_qa_out"
    os.makedirs(out_dir, exist_ok=True)

    report: Dict[str, Any] = {
        "ffmpeg_version":         subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True).stdout.split("\n")[0],
        "adynamic_eq_supported":  detect_adynamicequalizer_support("ffmpeg"),
    }

    print("\n=== Test 1: KPOP regression ===")
    report["test1_kpop_regression"] = kpop_regression(in_dir, out_dir)
    for r in report["test1_kpop_regression"]:
        print(f"  {r}")

    print("\n=== Test 2: v3.1 vs v3.2 ===")
    report["test2_v31_vs_v32"] = v31_vs_v32_compare(in_dir, out_dir)
    for r in report["test2_v31_vs_v32"]:
        print(f"  {r}")

    print("\n=== Test 3: entry_gain_db clamp ===")
    report["test3_entry_gain_clamp"] = entry_gain_clamp(in_dir, out_dir)
    for r in report["test3_entry_gain_clamp"]:
        print(f"  {r}")

    print("\n=== Test 4: quality check triggers ===")
    report["test4_quality_check"] = quality_check_triggers(in_dir, out_dir)
    for r in report["test4_quality_check"]:
        print(f"  {r}")

    print("\n=== Test 5: dynamic EQ paths ===")
    report["test5_dynamic_eq"] = dynamic_eq_paths(in_dir, out_dir)
    for r in report["test5_dynamic_eq"]:
        print(f"  {r}")

    print("\n=== Test 6: path safety ===")
    report["test6_path_safety"] = path_safety(in_dir, out_dir)
    for r in report["test6_path_safety"]:
        print(f"  {r}")

    out_json = os.path.join(out_dir, "qa_report.json")
    with open(out_json, "w") as f:
        json.dump(report, f, indent=2, ensure_ascii=False, default=str)
    print(f"\nQA report written: {out_json}")
    return report


if __name__ == "__main__":
    main()
