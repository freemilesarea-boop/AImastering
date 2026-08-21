#!/usr/bin/env python3
"""
Closed Loop Render Engine P0 - POC Test Script

Validates that DSP recommendations actually improve audio toward targets.

Phase: AI-MASTERING-CLOSED-LOOP-RENDER-P0-1

Output Directory: /Users/theblank/Desktop/Closed-Loop-Render-P0-Output/
"""

import os
import sys
import json
from datetime import datetime
from typing import Dict, List, Any

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.mastering.closed_loop import (
    ClosedLoopEngine,
    create_engine,
    RenderStatus,
)
from app.mastering.decision_engine import DSPDecisionEngine
from app.mastering.closed_loop.parameter_translator import ParameterTranslator
from app.analyzers.canonical_features import extract_canonical_features

# ═══════════════════════════════════════════════════════════════════════════════
# Configuration
# ═══════════════════════════════════════════════════════════════════════════════

OUTPUT_DIR = "/Users/theblank/Desktop/Closed-Loop-Render-P0-Output"
AI_TRACKS_DIR = "/Users/theblank/Desktop/AI 음원"

AI_5_TRACKS = [
    "Bad For Me.wav",
    "Body Language.wav",
    "Can't Behave.wav",
    "Cherry Lips.wav",
    "Coastline.wav",
]


def ensure_output_dir():
    """Ensure output directory exists."""
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    run_dir = os.path.join(OUTPUT_DIR, f"run-{timestamp}")
    os.makedirs(run_dir, exist_ok=True)
    return run_dir


def get_track_paths() -> List[str]:
    """Get paths to AI 5 tracks."""
    paths = []
    for track in AI_5_TRACKS:
        path = os.path.join(AI_TRACKS_DIR, track)
        if os.path.exists(path):
            paths.append(path)
        else:
            print(f"[WARN] Track not found: {path}")
    return paths


# ═══════════════════════════════════════════════════════════════════════════════
# 01. Repository DSP Runtime Audit
# ═══════════════════════════════════════════════════════════════════════════════

def generate_dsp_runtime_audit(run_dir: str) -> Dict:
    """Generate audit of existing DSP processors and their FFmpeg parameters."""
    audit = {
        "timestamp": datetime.now().isoformat(),
        "phase": "AI-MASTERING-CLOSED-LOOP-RENDER-P0-1",
        "purpose": "Audit existing DSP processors for closed-loop rendering",
        "processors": {
            "eq": {
                "file": "app/mastering/eq.py",
                "ffmpeg_filters": [
                    "equalizer (bell EQ)",
                    "highshelf",
                    "lowshelf",
                ],
                "parameter_ranges": {
                    "bell_gains": "-4.0 to +4.0 dB",
                    "frequencies": [80, 120, 250, 400, 1000, 2500, 3500, 5000, 8000, 12000],
                    "q_values": "0.5 to 3.0",
                },
                "style_presets": ["natural", "balanced", "warm", "bright", "punch", "loud", "kpop_loud"],
            },
            "dynamics": {
                "file": "app/mastering/dynamics.py",
                "ffmpeg_filters": ["acompressor"],
                "parameter_ranges": {
                    "threshold": "-22 to -14 dB",
                    "ratio": "1.3 to 2.2",
                    "attack": "15 to 50 ms",
                    "release": "100 to 300 ms",
                    "makeup": "0 to 6 dB",
                },
                "vocal_protection": True,
            },
            "effects": {
                "file": "app/mastering/effects.py",
                "ffmpeg_filters": [
                    "extrastereo",
                    "equalizer (de-esser)",
                    "compand (soft clipper)",
                    "volume",
                ],
                "parameter_ranges": {
                    "saturation": "0 to 1.0",
                    "stereo_width": "0 to 2.5",
                    "de_esser_gain": "-1.5 dB at 6500Hz",
                },
            },
            "pipeline": {
                "file": "app/mastering/pipeline.py",
                "processing_order": [
                    "1. Input Gain",
                    "2. EQ (static + style overlays)",
                    "3. Dynamic EQ",
                    "4. Compressor",
                    "5. Effects (saturation, stereo, de-esser)",
                    "6. Loudnorm (two-pass)",
                    "7. Limiter",
                ],
            },
        },
        "ffmpeg_wrapper": {
            "file": "app/utils/ffmpeg_wrapper.py",
            "functions": [
                "apply_filter_chain()",
                "apply_limiter()",
                "loudnorm_pass1()",
                "loudnorm_pass2()",
                "measure_output()",
            ],
        },
        "closed_loop_integration": {
            "parameter_translation": "Advisory recommendations → FFmpeg filter strings",
            "supported_profiles": [
                "BRIGHTNESS",
                "PRESENCE",
                "LOW_END",
                "WARMTH",
                "LOUDNESS",
                "STEREO_IMAGE",
            ],
        },
    }

    output_path = os.path.join(run_dir, "01_repository_dsp_runtime_audit.json")
    with open(output_path, "w") as f:
        json.dump(audit, f, indent=2)
    print(f"[OK] Generated: {output_path}")
    return audit


# ═══════════════════════════════════════════════════════════════════════════════
# 02. Feature Extraction Mapping
# ═══════════════════════════════════════════════════════════════════════════════

def generate_feature_extraction_mapping(run_dir: str) -> Dict:
    """Document mapping between profiles and canonical features."""
    mapping = {
        "timestamp": datetime.now().isoformat(),
        "profile_feature_mapping": {
            "LOUDNESS": {
                "primary_features": ["input_i", "loudness_range_lu"],
                "commercial_targets": {"input_i": -14.0, "loudness_range_lu": 6.0},
            },
            "PEAK_SAFETY": {
                "primary_features": ["input_tp", "clipping_sample_count"],
                "commercial_targets": {"input_tp": -1.0, "clipping_sample_count": 0},
            },
            "DYNAMIC_RANGE": {
                "primary_features": ["crest_factor_db", "dynamic_range_percent"],
                "commercial_targets": {"crest_factor_db": 8.0, "dynamic_range_percent": 15.0},
            },
            "LOW_END": {
                "primary_features": ["bass_ratio", "spectral_centroid_hz"],
                "commercial_targets": {"bass_ratio": 0.28, "spectral_centroid_hz": 2200.0},
            },
            "WARMTH": {
                "primary_features": ["low_mid_ratio", "spectral_tilt_db"],
                "commercial_targets": {"low_mid_ratio": 0.42, "spectral_tilt_db": -8.0},
            },
            "MID_CLARITY": {
                "primary_features": ["mid_ratio", "spectral_flatness"],
                "commercial_targets": {"mid_ratio": 0.38, "spectral_flatness": 0.12},
            },
            "PRESENCE": {
                "primary_features": ["high_mid_ratio"],
                "commercial_targets": {"high_mid_ratio": 0.18},
            },
            "BRIGHTNESS": {
                "primary_features": ["high_ratio", "spectral_rolloff_hz"],
                "commercial_targets": {"high_ratio": 0.08, "spectral_rolloff_hz": 8500.0},
            },
            "STEREO_IMAGE": {
                "primary_features": ["stereo_width", "stereo_correlation"],
                "commercial_targets": {"stereo_width": 0.65, "stereo_correlation": 0.4},
            },
            "TRANSIENT": {
                "primary_features": ["transient_sharpness"],
                "commercial_targets": {"transient_sharpness": 0.6},
            },
            "TEXTURE": {
                "primary_features": ["spectral_flux_mean"],
                "commercial_targets": {"spectral_flux_mean": 0.15},
                "note": "MONITOR_ONLY - no DSP actions",
            },
        },
        "direction_rules": {
            "INCREASE": "Feature value needs to increase toward target",
            "DECREASE": "Feature value needs to decrease toward target",
            "determination": "Based on before_value vs target comparison",
        },
    }

    output_path = os.path.join(run_dir, "02_feature_extraction_mapping.json")
    with open(output_path, "w") as f:
        json.dump(mapping, f, indent=2)
    print(f"[OK] Generated: {output_path}")
    return mapping


# ═══════════════════════════════════════════════════════════════════════════════
# 03. Parameter Translation Schema
# ═══════════════════════════════════════════════════════════════════════════════

def generate_parameter_translation_schema(run_dir: str) -> Dict:
    """Document how advisory recommendations translate to FFmpeg parameters."""
    translator = ParameterTranslator()
    audit = translator.generate_audit_report()

    schema = {
        "timestamp": datetime.now().isoformat(),
        "purpose": "Advisory Recommendation → FFmpeg Filter Translation",
        "supported_translations": audit.get("supported_translations", []),
        "translation_rules": {
            "BRIGHTNESS": {
                "filter": "highshelf",
                "frequency": "8000 Hz",
                "gain_range": "-3.0 to +3.0 dB",
                "direction_rule": "state=RECOMMEND(INCREASE) → positive gain",
                "example": "highshelf=f=8000:g=1.5:t=s",
            },
            "PRESENCE": {
                "filter": "equalizer (bell)",
                "frequency": "3500 Hz",
                "q": 1.5,
                "gain_range": "-3.0 to +3.0 dB",
                "direction_rule": "state=RECOMMEND(INCREASE) → positive gain",
                "example": "equalizer=f=3500:width_type=q:width=1.5:g=1.2",
            },
            "LOW_END": {
                "filter": "equalizer (bell)",
                "frequency": "80 Hz",
                "q": 0.8,
                "gain_range": "-4.0 to +4.0 dB",
                "direction_rule": "state=RECOMMEND(INCREASE) → positive gain",
                "example": "equalizer=f=80:width_type=q:width=0.8:g=2.0",
            },
            "WARMTH": {
                "filter": "equalizer (bell)",
                "frequency": "250 Hz",
                "q": 1.0,
                "gain_range": "-3.0 to +3.0 dB",
                "example": "equalizer=f=250:width_type=q:width=1.0:g=1.0",
            },
            "LOUDNESS": {
                "filter": "volume",
                "gain_range": "-3.0 to +3.0 dB",
                "note": "Initial gain only, loudnorm handles final",
                "example": "volume=1.5dB",
            },
            "STEREO_IMAGE": {
                "filter": "extrastereo",
                "m_range": "0.5 to 2.0",
                "direction_rule": "INCREASE width → m > 1.0",
                "example": "extrastereo=m=1.3",
            },
        },
        "filter_chain_format": "filter1,filter2,filter3,...",
        "safety_constraints": {
            "max_total_gain": "6.0 dB across all EQ bands",
            "stereo_width_max": "2.0 (extrastereo m value)",
            "limiter_ceiling": "-1.0 dBTP",
        },
    }

    output_path = os.path.join(run_dir, "03_parameter_translation_schema.json")
    with open(output_path, "w") as f:
        json.dump(schema, f, indent=2)
    print(f"[OK] Generated: {output_path}")
    return schema


# ═══════════════════════════════════════════════════════════════════════════════
# 04. Movement Validation Specification
# ═══════════════════════════════════════════════════════════════════════════════

def generate_movement_validation_spec(run_dir: str) -> Dict:
    """Document movement validation rules."""
    spec = {
        "timestamp": datetime.now().isoformat(),
        "purpose": "Validate that DSP actually moved features toward targets",
        "validation_flow": [
            "1. Get before_features from original audio",
            "2. Apply DSP recommendation",
            "3. Get after_features from rendered audio",
            "4. Compare distances to commercial target",
            "5. Validate direction is correct",
            "6. Calculate improvement percentage",
        ],
        "validation_results": {
            "PASS": {
                "criteria": [
                    "Direction is correct (moved toward target)",
                    "Improvement >= 5%",
                    "No overshoot beyond target",
                ],
            },
            "WARN": {
                "criteria": [
                    "Direction correct but improvement < 5%",
                    "OR minor overshoot (< 10% past target)",
                ],
            },
            "FAIL": {
                "criteria": [
                    "Wrong direction (moved away from target)",
                    "OR major overshoot (> 20% past target)",
                    "OR no movement at all",
                ],
            },
        },
        "distance_calculation": {
            "formula": "abs(value - target) / abs(target) if target != 0 else abs(value)",
            "improvement": "(before_distance - after_distance) / before_distance * 100",
        },
        "overshoot_detection": {
            "rule": "If before < target and after > target (or vice versa)",
            "overshoot_percent": "abs(after - target) / abs(target - before) * 100",
            "threshold_major": "20%",
        },
    }

    output_path = os.path.join(run_dir, "04_movement_validation_spec.json")
    with open(output_path, "w") as f:
        json.dump(spec, f, indent=2)
    print(f"[OK] Generated: {output_path}")
    return spec


# ═══════════════════════════════════════════════════════════════════════════════
# 05. Regression Detection Specification
# ═══════════════════════════════════════════════════════════════════════════════

def generate_regression_detection_spec(run_dir: str) -> Dict:
    """Document collateral regression detection rules."""
    spec = {
        "timestamp": datetime.now().isoformat(),
        "purpose": "Detect collateral damage when fixing one profile",
        "collateral_check_map": {
            "LOUDNESS": ["PEAK_SAFETY", "DYNAMIC_RANGE"],
            "BRIGHTNESS": ["WARMTH", "PRESENCE"],
            "LOW_END": ["MID_CLARITY", "PEAK_SAFETY"],
            "WARMTH": ["BRIGHTNESS", "MID_CLARITY"],
            "PRESENCE": ["BRIGHTNESS", "WARMTH"],
            "STEREO_IMAGE": ["PEAK_SAFETY"],
            "DYNAMIC_RANGE": ["LOUDNESS", "PEAK_SAFETY"],
        },
        "regression_severity": {
            "BLOCKING": {
                "auto_reject": True,
                "conditions": [
                    "True peak exceeds -1.0 dBTP",
                    "Clipping samples > 0",
                    "Stereo correlation < -0.3",
                    "Crest factor drops > 3 dB",
                ],
            },
            "MAJOR": {
                "auto_reject": False,
                "conditions": [
                    "Feature moved 15-25% away from target",
                    "Multiple profiles affected",
                ],
            },
            "MINOR": {
                "auto_reject": False,
                "conditions": [
                    "Feature moved 5-15% away from target",
                    "Single profile affected",
                ],
            },
        },
        "special_checks": {
            "peak_safety": {
                "blocking_threshold": "-0.5 dBTP",
                "warning_threshold": "-0.8 dBTP",
            },
            "stereo_correlation": {
                "blocking_threshold": -0.3,
                "warning_threshold": 0.0,
            },
            "crest_factor": {
                "blocking_drop": "3.0 dB",
                "warning_drop": "1.5 dB",
            },
        },
    }

    output_path = os.path.join(run_dir, "05_regression_detection_spec.json")
    with open(output_path, "w") as f:
        json.dump(spec, f, indent=2)
    print(f"[OK] Generated: {output_path}")
    return spec


# ═══════════════════════════════════════════════════════════════════════════════
# 06. Safety Gate Requirements
# ═══════════════════════════════════════════════════════════════════════════════

def generate_safety_gate_requirements(run_dir: str) -> Dict:
    """Document all safety gate requirements."""
    requirements = {
        "timestamp": datetime.now().isoformat(),
        "purpose": "Ensure no render degrades audio safety",
        "checks": {
            "file_exists": {
                "severity": "critical",
                "requirement": "Output file exists and size > 0",
            },
            "file_decode": {
                "severity": "critical",
                "requirement": "File can be decoded by FFprobe",
            },
            "duration_match": {
                "severity": "critical",
                "requirement": "Duration difference < 50ms",
                "threshold": "50ms",
            },
            "sample_rate": {
                "severity": "warning",
                "requirement": "Sample rate in {44100, 48000, 88200, 96000}",
            },
            "channel_count": {
                "severity": "critical",
                "requirement": "Matches input channel count",
            },
            "true_peak": {
                "severity": "critical",
                "requirement": "True peak <= -1.0 dBTP",
                "threshold": "-1.0 dBTP",
            },
            "clipping": {
                "severity": "critical",
                "requirement": "Clipping samples = 0",
                "threshold": "0 samples",
            },
            "loudness_jump": {
                "severity": "warning",
                "requirement": "Loudness change <= 3 LU",
                "threshold": "3.0 LU",
            },
            "stereo_correlation": {
                "severity": "critical",
                "requirement": "Correlation >= -0.3",
                "threshold": "-0.3",
            },
            "mono_compatibility": {
                "severity": "warning",
                "requirement": "Mono compatibility >= 0.5",
                "threshold": "0.5",
            },
            "not_silent": {
                "severity": "critical",
                "requirement": "RMS > -60 dBFS",
                "threshold": "-60 dBFS",
            },
            "no_nan_inf": {
                "severity": "critical",
                "requirement": "No NaN or Infinity values in features",
            },
        },
        "rejection_rules": {
            "any_critical_failure": "Auto-reject",
            "warning_only": "Accept with warnings",
        },
    }

    output_path = os.path.join(run_dir, "06_safety_gate_requirements.json")
    with open(output_path, "w") as f:
        json.dump(requirements, f, indent=2)
    print(f"[OK] Generated: {output_path}")
    return requirements


# ═══════════════════════════════════════════════════════════════════════════════
# 07. Accept/Reject Logic
# ═══════════════════════════════════════════════════════════════════════════════

def generate_accept_reject_logic(run_dir: str) -> Dict:
    """Document accept/reject decision logic."""
    logic = {
        "timestamp": datetime.now().isoformat(),
        "render_statuses": {
            "ACCEPTED": {
                "conditions": [
                    "All recommendations improved target distance",
                    "No blocking regressions",
                    "Safety gate passed",
                ],
                "action": "Use rendered output, continue to next pass if improvements remain",
            },
            "PARTIALLY_ACCEPTED": {
                "conditions": [
                    "Some recommendations improved",
                    "Some recommendations had no effect or minor issues",
                    "No blocking failures",
                ],
                "action": "Use rendered output, try remaining in next pass",
            },
            "REJECTED": {
                "conditions": [
                    "Safety gate failed",
                    "OR blocking regression detected",
                    "OR all recommendations failed validation",
                ],
                "action": "Rollback to previous state, do not use render",
            },
            "BLOCKED": {
                "conditions": [
                    "Recommendations blocked by conflict rules",
                ],
                "action": "Skip render, no action taken",
            },
            "RENDER_FAILED": {
                "conditions": [
                    "FFmpeg render failed",
                    "OR output file corrupt",
                ],
                "action": "Rollback, report error",
            },
            "NO_ACTION": {
                "conditions": [
                    "No recommendations to apply",
                    "OR all profiles already at target",
                ],
                "action": "Keep original, no processing needed",
            },
        },
        "pass_continuation": {
            "max_passes": 2,
            "continue_on_partial": True,
            "stop_on_accepted": True,
            "stop_on_rejected": True,
        },
        "rollback_rules": {
            "original_never_modified": True,
            "each_pass_creates_candidate": True,
            "rejected_candidates_discarded": True,
            "accepted_candidate_becomes_input_for_next_pass": True,
        },
    }

    output_path = os.path.join(run_dir, "07_accept_reject_logic.json")
    with open(output_path, "w") as f:
        json.dump(logic, f, indent=2)
    print(f"[OK] Generated: {output_path}")
    return logic


# ═══════════════════════════════════════════════════════════════════════════════
# 08-12. Per-Track Results
# ═══════════════════════════════════════════════════════════════════════════════

def process_tracks(engine: ClosedLoopEngine, run_dir: str) -> List[Dict]:
    """Process all AI 5 tracks through closed loop."""
    track_paths = get_track_paths()
    results = []

    for i, path in enumerate(track_paths, start=1):
        track_name = os.path.splitext(os.path.basename(path))[0]
        print(f"\n{'='*60}")
        print(f"[{i}/{len(track_paths)}] Processing: {track_name}")
        print(f"{'='*60}")

        try:
            result = engine.process_track(path, track_name)
            result_dict = result.to_dict()
            results.append(result_dict)

            # Save individual track result
            output_num = 7 + i  # 08, 09, 10, 11, 12
            output_path = os.path.join(
                run_dir,
                f"{output_num:02d}_track_result_{track_name.replace(' ', '_')}.json"
            )
            with open(output_path, "w") as f:
                json.dump(result_dict, f, indent=2)
            print(f"[OK] Generated: {output_path}")

        except Exception as e:
            print(f"[ERROR] Failed to process {track_name}: {e}")
            import traceback
            traceback.print_exc()
            results.append({
                "file_name": track_name,
                "error": str(e),
                "final_status": "RENDER_FAILED",
            })

    return results


# ═══════════════════════════════════════════════════════════════════════════════
# Reproducibility Test
# ═══════════════════════════════════════════════════════════════════════════════

def run_reproducibility_test(run_dir: str) -> Dict:
    """Run reproducibility test on first track."""
    track_paths = get_track_paths()
    if not track_paths:
        return {"status": "SKIP", "reason": "No tracks found"}

    test_track = track_paths[0]
    track_name = os.path.splitext(os.path.basename(test_track))[0]

    print(f"\n{'='*60}")
    print(f"Reproducibility Test: {track_name}")
    print(f"{'='*60}")

    engine = create_engine(os.path.join(run_dir, "repro_test"))
    repro_result = engine.check_reproducibility(test_track, runs=3)

    return repro_result


# ═══════════════════════════════════════════════════════════════════════════════
# 13. Final Report
# ═══════════════════════════════════════════════════════════════════════════════

def generate_final_report(
    run_dir: str,
    track_results: List[Dict],
    repro_result: Dict,
) -> str:
    """Generate final markdown report."""

    # Calculate summary stats
    total_tracks = len(track_results)
    accepted = sum(1 for r in track_results if r.get("final_status") == "ACCEPTED")
    partial = sum(1 for r in track_results if r.get("final_status") == "PARTIALLY_ACCEPTED")
    rejected = sum(1 for r in track_results if r.get("final_status") == "REJECTED")
    no_action = sum(1 for r in track_results if r.get("final_status") == "NO_ACTION")
    failed = sum(1 for r in track_results if r.get("final_status") == "RENDER_FAILED")

    report = f"""# Closed Loop Render Engine P0 - Validation Report

**Phase:** AI-MASTERING-CLOSED-LOOP-RENDER-P0-1
**Generated:** {datetime.now().isoformat()}
**Output Directory:** {run_dir}

---

## Executive Summary

| Metric | Value |
|--------|-------|
| Total Tracks Processed | {total_tracks} |
| ACCEPTED | {accepted} |
| PARTIALLY_ACCEPTED | {partial} |
| REJECTED | {rejected} |
| NO_ACTION | {no_action} |
| RENDER_FAILED | {failed} |
| Reproducibility | {repro_result.get('status', 'N/A')} |

---

## Track Results

"""

    for result in track_results:
        track_name = result.get("file_name", "Unknown")
        status = result.get("final_status", "UNKNOWN")
        pass_count = result.get("pass_count", 0)

        status_emoji = {
            "ACCEPTED": "✅",
            "PARTIALLY_ACCEPTED": "🟡",
            "REJECTED": "❌",
            "NO_ACTION": "⚪",
            "RENDER_FAILED": "💥",
        }.get(status, "❓")

        report += f"### {track_name}\n\n"
        report += f"- **Status:** {status_emoji} {status}\n"
        report += f"- **Passes:** {pass_count}\n"

        # Add pass details
        passes = result.get("passes", [])
        for p in passes:
            pass_num = p.get("pass_number", "?")
            p_status = p.get("status", "UNKNOWN")
            applied = len(p.get("applied_recommendations", []))
            accepted_recs = len(p.get("accepted_recommendations", []))
            rejected_recs = len(p.get("rejected_recommendations", []))

            report += f"  - Pass {pass_num}: {p_status} ({accepted_recs}/{applied} accepted)\n"

        # Movement summary
        summary = result.get("decision_summary", {})
        if summary:
            report += f"- **Recommendations Applied:** {summary.get('recommendations_applied', 0)}\n"
            report += f"- **Original Modified:** {summary.get('original_modified', False)}\n"

        report += "\n"

    report += f"""---

## Reproducibility Test

| Run | Status | Details |
|-----|--------|---------|
"""

    if repro_result.get("reproducible"):
        report += f"| 1-{repro_result.get('runs', 3)} | ✅ PASS | All runs produced identical results |\n"
    else:
        diffs = repro_result.get("differences", [])
        for diff in diffs[:5]:  # Show first 5 differences
            report += f"| Run {diff.get('run')} | ❌ DIFF | {diff.get('field')}: {diff.get('baseline')} → {diff.get('current')} |\n"

    report += f"""
---

## Safety Gate Summary

All renders validated against:
- True Peak ≤ -1.0 dBTP
- Clipping = 0 samples
- Stereo Correlation ≥ -0.3
- Duration match < 50ms
- No NaN/Infinity values

---

## Files Generated

1. `01_repository_dsp_runtime_audit.json` - DSP processor audit
2. `02_feature_extraction_mapping.json` - Profile-feature mapping
3. `03_parameter_translation_schema.json` - FFmpeg translation rules
4. `04_movement_validation_spec.json` - Movement validation specification
5. `05_regression_detection_spec.json` - Regression detection rules
6. `06_safety_gate_requirements.json` - Safety requirements
7. `07_accept_reject_logic.json` - Accept/reject decision logic
8-12. `08-12_track_result_*.json` - Per-track results
13. `13_CLOSED_LOOP_RENDER_P0_REPORT.md` - This report

---

## Conclusion

The Closed Loop Render Engine P0 has been validated with {total_tracks} tracks.
{accepted + partial} tracks were improved, {rejected} were rejected due to safety/regression issues.

**Test Status:** {"PASS ✅" if accepted + partial > 0 and repro_result.get('reproducible', False) else "NEEDS REVIEW 🟡"}

---

*Generated by Closed Loop Render Engine P0*
*Phase: AI-MASTERING-CLOSED-LOOP-RENDER-P0-1*
"""

    output_path = os.path.join(run_dir, "13_CLOSED_LOOP_RENDER_P0_REPORT.md")
    with open(output_path, "w") as f:
        f.write(report)
    print(f"[OK] Generated: {output_path}")

    return report


# ═══════════════════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    """Main entry point."""
    print("=" * 70)
    print("Closed Loop Render Engine P0 - Validation")
    print("Phase: AI-MASTERING-CLOSED-LOOP-RENDER-P0-1")
    print("=" * 70)

    # Create output directory
    run_dir = ensure_output_dir()
    print(f"\nOutput directory: {run_dir}\n")

    # Generate specification documents (01-07)
    print("\n--- Generating Specification Documents ---\n")
    generate_dsp_runtime_audit(run_dir)
    generate_feature_extraction_mapping(run_dir)
    generate_parameter_translation_schema(run_dir)
    generate_movement_validation_spec(run_dir)
    generate_regression_detection_spec(run_dir)
    generate_safety_gate_requirements(run_dir)
    generate_accept_reject_logic(run_dir)

    # Create engine and process tracks (08-12)
    print("\n--- Processing AI 5 Tracks ---\n")
    engine = create_engine(run_dir)
    track_results = process_tracks(engine, run_dir)

    # Reproducibility test
    print("\n--- Running Reproducibility Test ---\n")
    repro_result = run_reproducibility_test(run_dir)
    print(f"Reproducibility: {repro_result.get('status', 'UNKNOWN')}")

    # Generate final report (13)
    print("\n--- Generating Final Report ---\n")
    report = generate_final_report(run_dir, track_results, repro_result)

    # Summary
    print("\n" + "=" * 70)
    print("VALIDATION COMPLETE")
    print("=" * 70)
    print(f"\nOutput directory: {run_dir}")
    print(f"Tracks processed: {len(track_results)}")
    print(f"Reproducibility: {repro_result.get('status', 'UNKNOWN')}")

    # Print track summary
    for result in track_results:
        track_name = result.get("file_name", "Unknown")
        status = result.get("final_status", "UNKNOWN")
        print(f"  - {track_name}: {status}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
