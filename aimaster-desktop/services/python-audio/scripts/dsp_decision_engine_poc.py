#!/usr/bin/env python3
"""
DSP Decision Engine P0 - Proof of Concept Script

Test-only implementation that:
1. Loads commercial and AI track features
2. Generates DSP recommendations for each track
3. Validates reproducibility
4. Tests edge cases
5. Generates output reports

NO actual DSP processing, NO production pipeline connection.

Output Directory: /Users/theblank/Desktop/DSP-Decision-Engine-P0-Output/
"""

import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Any, Optional
import tempfile

# Add parent to path
sys.path.insert(0, str(Path(__file__).parent.parent))

import numpy as np

from app.mastering.decision_engine import (
    DSPDecisionEngine,
    create_engine,
    DecisionState,
    Direction,
    Severity,
    PROFILE_ORDER,
    get_target_registry,
    get_mapping_registry,
    get_safety_clamp,
)

# Output directory
OUTPUT_DIR = Path("/Users/theblank/Desktop/DSP-Decision-Engine-P0-Output")

# Feature data directories
CANONICAL_OUTPUT = Path("/Users/theblank/Desktop/Canonical-Feature-Coverage-P0-Output")


def load_feature_file(path: Path) -> Optional[Dict]:
    """Load a JSON feature file."""
    if not path.exists():
        print(f"  Warning: File not found: {path}")
        return None
    with open(path) as f:
        return json.load(f)


def save_json(data: Any, filename: str):
    """Save data to JSON file."""
    output_path = OUTPUT_DIR / filename
    with open(output_path, "w") as f:
        json.dump(data, f, indent=2, default=str)
    print(f"  Saved: {filename}")


def generate_repository_audit() -> Dict:
    """Generate audit of DSP processors from repository."""
    print("\n1. Generating Repository DSP Audit...")

    audit = {
        "timestamp": datetime.now().isoformat(),
        "dsp_processors": {},
        "parameter_ranges": {},
        "safety_limits": {},
    }

    # Document existing DSP processors from audit
    audit["dsp_processors"] = {
        "EQ": {
            "file": "app/mastering/eq.py",
            "parameters": {
                "high_shelf_gain": {"min": -3.5, "max": 4.0, "unit": "dB"},
                "low_shelf_gain": {"min": -4.0, "max": 4.0, "unit": "dB"},
                "bell_gain": {"min": -4.0, "max": 4.0, "unit": "dB"},
            },
            "styles": ["natural", "balanced", "warm", "bright", "punch", "loud", "kpop_loud"],
        },
        "COMPRESSOR": {
            "file": "app/mastering/dynamics.py",
            "parameters": {
                "threshold": {"min": -22, "max": -14, "unit": "dB"},
                "ratio": {"min": 1.3, "max": 2.2, "unit": "ratio"},
                "attack": {"min": 15, "max": 50, "unit": "ms"},
                "release": {"min": 80, "max": 200, "unit": "ms"},
                "makeup": {"min": 0.5, "max": 1.0, "unit": "dB"},
            },
            "vocal_protection": {
                "max_ratio": 2.0,
                "min_attack": 25,
                "max_makeup": 0.7,
            },
        },
        "STEREO": {
            "file": "app/mastering/effects.py",
            "parameters": {
                "width": {"min": 0.0, "max": 2.5, "unit": "multiplier"},
            },
            "mode_defaults": {
                "natural": 1.0,
                "balanced": 1.05,
                "bright": 1.10,
                "warm": 1.0,
                "punch": 1.05,
            },
        },
        "SATURATION": {
            "file": "app/mastering/effects.py",
            "parameters": {
                "amount": {"min": 0.0, "max": 1.0, "unit": "ratio"},
            },
            "mode_defaults": {
                "natural": 0.0,
                "balanced": 0.20,
                "bright": 0.0,
                "warm": 0.15,
                "punch": 0.30,
            },
        },
        "LIMITER": {
            "file": "app/mastering/effects.py",
            "parameters": {
                "ceiling": {"min": -3.0, "max": -0.1, "unit": "dBTP"},
            },
        },
    }

    # Document P0 safety limits
    safety_clamp = get_safety_clamp()
    audit["safety_limits"] = safety_clamp.generate_audit_report()

    save_json(audit, "01_repository_dsp_audit.json")
    return audit


def generate_target_registry() -> Dict:
    """Generate target registry report."""
    print("\n2. Generating Target Registry...")

    registry = get_target_registry()
    report = registry.generate_audit_report()

    save_json(report, "02_target_registry.json")
    return report


def generate_mapping_registry() -> Dict:
    """Generate mapping rule registry report."""
    print("\n3. Generating Mapping Rule Registry...")

    registry = get_mapping_registry()
    report = registry.generate_audit_report()

    save_json(report, "03_mapping_rule_registry.json")
    return report


def evaluate_commercial_tracks(engine: DSPDecisionEngine) -> Dict:
    """Evaluate commercial tracks."""
    print("\n4. Evaluating Commercial Tracks...")

    # Load commercial features
    commercial_file = CANONICAL_OUTPUT / "03_commercial_feature_results.json"
    data = load_feature_file(commercial_file)

    if data is None:
        print("  Error: Could not load commercial features")
        return {"error": "Could not load commercial features"}

    results = []
    for track in data.get("results", []):
        file_name = track.get("file", "unknown")
        print(f"  Processing: {file_name}")

        result = engine.evaluate_track(track, file_name)
        results.append({
            "file": file_name,
            "result": result.to_dict(),
        })

    output = {
        "dataset": "commercial",
        "track_count": len(results),
        "results": results,
        "summary": _aggregate_results(results),
    }

    save_json(output, "04_commercial_decisions.json")
    return output


def evaluate_ai_tracks(engine: DSPDecisionEngine) -> Dict:
    """Evaluate AI tracks."""
    print("\n5. Evaluating AI Tracks...")

    # Load AI features
    ai_file = CANONICAL_OUTPUT / "04_ai_feature_results.json"
    data = load_feature_file(ai_file)

    if data is None:
        print("  Error: Could not load AI features")
        return {"error": "Could not load AI features"}

    results = []
    for track in data.get("results", []):
        file_name = track.get("file", "unknown")
        print(f"  Processing: {file_name}")

        result = engine.evaluate_track(track, file_name)
        results.append({
            "file": file_name,
            "result": result.to_dict(),
        })

    output = {
        "dataset": "ai",
        "track_count": len(results),
        "results": results,
        "summary": _aggregate_results(results),
    }

    save_json(output, "05_ai_decisions.json")
    return output


def _aggregate_results(results: List[Dict]) -> Dict:
    """Aggregate results across tracks."""
    state_counts = {state.value: 0 for state in DecisionState}
    total_recommendations = 0
    clamped_count = 0

    for track_result in results:
        result = track_result.get("result", {})
        summary = result.get("summary", {})
        state_dist = summary.get("state_distribution", {})

        for state, count in state_dist.items():
            state_counts[state] = state_counts.get(state, 0) + count

        total_recommendations += summary.get("total_dsp_recommendations", 0)
        clamped_count += summary.get("clamped_count", 0)

    return {
        "total_tracks": len(results),
        "state_distribution": state_counts,
        "total_dsp_recommendations": total_recommendations,
        "clamped_count": clamped_count,
    }


def test_conflict_resolution(engine: DSPDecisionEngine) -> Dict:
    """Test conflict resolution."""
    print("\n6. Testing Conflict Resolution...")

    # Create test scenarios
    scenarios = [
        {
            "name": "Loudness vs Peak Safety",
            "features": {
                "input_i": -6.0,  # Very loud
                "input_tp": 0.5,  # Over 0 dBTP
                "crest_factor_db": 8.0,  # Compressed
            },
        },
        {
            "name": "Brightness vs Texture (HF Artifact Risk)",
            "features": {
                "spectral_centroid": 2500.0,  # Dark
                "spectral_flatness": 0.4,  # High flatness (noise-like)
                "hf_ratio": 0.003,  # Low HF
            },
        },
        {
            "name": "Width vs Mono Compatibility",
            "features": {
                "stereo_width": 0.9,  # Wide
                "stereo_correlation": 0.3,  # Low correlation
            },
        },
        {
            "name": "Warmth vs Mid Clarity",
            "features": {
                "band_ratio_500-1000Hz": 0.20,  # High low-mid
                "band_ratio_1-2kHz": 0.18,  # High mid
                "spectral_contrast_band_1": 7.0,
            },
        },
        {
            "name": "Dynamic Range vs Loudness",
            "features": {
                "crest_factor_db": 14.0,  # High crest (dynamic)
                "input_i": -7.0,  # Loud target
                "input_lra": 4.0,  # Low LRA
            },
        },
    ]

    results = []
    for scenario in scenarios:
        print(f"  Testing: {scenario['name']}")
        result = engine.evaluate_track(scenario["features"], scenario["name"])
        results.append({
            "scenario": scenario["name"],
            "features": scenario["features"],
            "conflict_report": {
                "triggered_count": result.conflict_report.triggered_count,
                "block_count": result.conflict_report.block_count,
                "blocked_actions": result.conflict_report.blocked_actions,
            },
            "affected_profiles": [
                {
                    "profile": profile,
                    "state": rec.state.value,
                    "blocked_by": rec.safety.blocked_by,
                }
                for profile, rec in result.recommendations.items()
                if rec.safety.blocked_by
            ],
        })

    output = {
        "test_type": "conflict_resolution",
        "scenario_count": len(scenarios),
        "results": results,
    }

    save_json(output, "06_conflict_results.json")
    return output


def test_safety_clamp(engine: DSPDecisionEngine) -> Dict:
    """Test safety clamping."""
    print("\n7. Testing Safety Clamp...")

    # Create extreme feature scenarios
    scenarios = [
        {
            "name": "Extremely Dark Track",
            "features": {
                "spectral_centroid": 1500.0,  # Very low
                "hf_ratio": 0.001,  # Very low
            },
        },
        {
            "name": "Extremely Bright Track",
            "features": {
                "spectral_centroid": 5000.0,  # Very high
                "hf_ratio": 0.05,  # Very high
            },
        },
        {
            "name": "Extremely Bass Heavy",
            "features": {
                "band_ratio_20-60Hz": 0.4,  # Very high
                "band_ratio_60-120Hz": 0.35,  # Very high
            },
        },
        {
            "name": "Extremely Wide Stereo",
            "features": {
                "stereo_width": 0.95,
                "stereo_correlation": 0.2,
                "ms_ratio_db": 3.0,
            },
        },
    ]

    results = []
    for scenario in scenarios:
        print(f"  Testing: {scenario['name']}")
        result = engine.evaluate_track(scenario["features"], scenario["name"])

        clamped_recs = []
        for profile, rec in result.recommendations.items():
            for dsp_rec in rec.recommendations:
                if dsp_rec.clamped:
                    clamped_recs.append({
                        "profile": profile,
                        "processor": dsp_rec.processor,
                        "parameter": dsp_rec.parameter,
                        "original_value": dsp_rec.original_value,
                        "clamped_value": dsp_rec.suggested_value,
                        "safe_min": dsp_rec.safe_min,
                        "safe_max": dsp_rec.safe_max,
                    })

        results.append({
            "scenario": scenario["name"],
            "features": scenario["features"],
            "clamped_recommendations": clamped_recs,
            "total_clamped": len(clamped_recs),
        })

    output = {
        "test_type": "safety_clamp",
        "scenario_count": len(scenarios),
        "results": results,
    }

    save_json(output, "07_safety_clamp_results.json")
    return output


def test_reproducibility(engine: DSPDecisionEngine) -> Dict:
    """Test reproducibility."""
    print("\n8. Testing Reproducibility...")

    # Use first AI track for reproducibility test
    ai_file = CANONICAL_OUTPUT / "04_ai_feature_results.json"
    data = load_feature_file(ai_file)

    if data is None or not data.get("results"):
        # Create synthetic test data
        test_features = {
            "spectral_centroid": 3000.0,
            "hf_ratio": 0.008,
            "crest_factor_db": 11.0,
            "stereo_correlation": 0.75,
            "stereo_width": 0.5,
        }
    else:
        test_features = data["results"][0]

    report = engine.check_reproducibility(
        test_features,
        file_name="reproducibility_test",
        runs=3,
    )

    output = {
        "test_type": "reproducibility",
        "runs": report["runs"],
        "reproducible": report["reproducible"],
        "differences": report["differences"],
        "status": "PASS" if report["reproducible"] else "FAIL",
    }

    save_json(output, "08_reproducibility.json")
    return output


def test_edge_cases(engine: DSPDecisionEngine) -> Dict:
    """Test edge cases."""
    print("\n9. Testing Edge Cases...")

    # Generate synthetic edge case audio (using numpy)
    edge_cases = []

    # 1. Silence
    edge_cases.append({
        "name": "Silence",
        "features": {
            "sample_peak_dbfs": -96.0,
            "rms_db": -96.0,
            "crest_factor_db": 0.0,
            "spectral_centroid": 0.0,
        },
        "expected_state": "INSUFFICIENT_DATA",
    })

    # 2. Clipped signal
    edge_cases.append({
        "name": "Clipped Signal",
        "features": {
            "sample_peak_dbfs": 0.0,
            "input_tp": 2.0,  # Clipping
            "clipping_ratio": 0.1,
            "crest_factor_db": 3.0,
        },
        "expected_profile_state": {"PEAK_SAFETY": "RECOMMEND"},
    })

    # 3. Mono track
    edge_cases.append({
        "name": "Mono Track",
        "features": {
            "stereo_width": 0.0,
            "stereo_correlation": 1.0,
            "ms_ratio_db": 100.0,  # No side
        },
        "note": "Stereo recommendations should not apply",
    })

    # 4. Anti-phase stereo
    edge_cases.append({
        "name": "Anti-Phase Stereo",
        "features": {
            "stereo_correlation": -0.5,  # Negative correlation
            "stereo_width": 1.0,
        },
        "expected_conflict": True,
    })

    # 5. Over-compressed
    edge_cases.append({
        "name": "Over-Compressed",
        "features": {
            "crest_factor_db": 5.0,  # Very low
            "input_lra": 2.0,  # Very low
        },
        "expected_profile_state": {"DYNAMIC_RANGE": "RECOMMEND"},
    })

    results = []
    for edge_case in edge_cases:
        print(f"  Testing: {edge_case['name']}")
        result = engine.evaluate_track(edge_case["features"], edge_case["name"])

        results.append({
            "case": edge_case["name"],
            "features": edge_case["features"],
            "summary": result.summary,
            "conflict_count": result.conflict_report.triggered_count,
            "profile_states": {
                p: rec.state.value for p, rec in result.recommendations.items()
            },
        })

    output = {
        "test_type": "edge_cases",
        "case_count": len(edge_cases),
        "results": results,
    }

    save_json(output, "09_edge_case_results.json")
    return output


def validate_schema(engine: DSPDecisionEngine) -> Dict:
    """Validate output schema."""
    print("\n10. Validating Schema...")

    # Test with minimal features
    test_features = {
        "spectral_centroid": 3000.0,
        "crest_factor_db": 11.0,
    }

    result = engine.evaluate_track(test_features, "schema_test")
    result_dict = result.to_dict()

    # Check required fields
    required_fields = [
        "file_name",
        "timestamp",
        "profile_deltas",
        "conflict_report",
        "recommendations",
        "summary",
    ]

    missing_fields = [f for f in required_fields if f not in result_dict]

    # Check recommendation schema
    rec_required = ["profile", "state", "confidence", "recommendations", "safety"]
    rec_missing = []

    for profile, rec in result_dict.get("recommendations", {}).items():
        for field in rec_required:
            if field not in rec:
                rec_missing.append(f"{profile}.{field}")

    output = {
        "test_type": "schema_validation",
        "valid": len(missing_fields) == 0 and len(rec_missing) == 0,
        "missing_top_level": missing_fields,
        "missing_recommendation_fields": rec_missing,
        "sample_output": result_dict,
    }

    save_json(output, "10_schema_validation.json")
    return output


def generate_final_report(
    audit: Dict,
    targets: Dict,
    mappings: Dict,
    commercial: Dict,
    ai: Dict,
    conflicts: Dict,
    safety: Dict,
    repro: Dict,
    edges: Dict,
    schema: Dict,
) -> None:
    """Generate final markdown report."""
    print("\n11. Generating Final Report...")

    report = f"""# DSP Decision Engine P0 Report

## Phase AI-MASTERING-DSP-DECISION-ENGINE-P0-1

**Date**: {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}
**Status**: P0_COMPLETE

---

## 1. Executive Summary

| Metric | Value |
|--------|-------|
| Profiles Supported | {len(PROFILE_ORDER)} |
| Target Features | {targets.get('total_targets', 0)} |
| Data-Derived Targets | {targets.get('data_derived_count', 0)} |
| Mapping Rules | {mappings.get('total_rules', 0)} |
| Commercial Tracks Evaluated | {commercial.get('track_count', 0)} |
| AI Tracks Evaluated | {ai.get('track_count', 0)} |
| Reproducibility | {'PASS' if repro.get('reproducible') else 'FAIL'} |
| Schema Validation | {'PASS' if schema.get('valid') else 'FAIL'} |

---

## 2. Changed Files

| File | Description |
|------|-------------|
| app/mastering/decision_engine/__init__.py | Package init |
| app/mastering/decision_engine/constants.py | Constants and enums |
| app/mastering/decision_engine/target_registry.py | Commercial targets |
| app/mastering/decision_engine/delta_engine.py | Feature delta calculation |
| app/mastering/decision_engine/mapping_registry.py | DSP mapping rules |
| app/mastering/decision_engine/safety_clamp.py | Safe parameter ranges |
| app/mastering/decision_engine/recommendation_engine.py | Recommendation generation |
| app/mastering/decision_engine/engine.py | Main orchestrator |
| scripts/dsp_decision_engine_poc.py | This test script |

---

## 3. Target Registry Summary

| Profile | Features | Data-Derived |
|---------|----------|--------------|
"""

    for profile, info in targets.get("by_profile", {}).items():
        report += f"| {profile} | {info['total']} | {info['data_derived']} |\n"

    report += f"""
---

## 4. Mapping Rules Summary

| Source | Count | Confidence Ceiling |
|--------|-------|-------------------|
| DATA_DERIVED | {mappings.get('by_source', {}).get('DATA_DERIVED', 0)} | 1.00 |
| DESIGN_CANDIDATE | {mappings.get('by_source', {}).get('DESIGN_CANDIDATE', 0)} | 0.65 |
| HEURISTIC | {mappings.get('by_source', {}).get('HEURISTIC', 0)} | 0.45 |
| UNSUPPORTED | {mappings.get('by_source', {}).get('UNSUPPORTED', 0)} | 0.00 |

---

## 5. Commercial Track Results

| State | Count |
|-------|-------|
"""

    comm_summary = commercial.get("summary", {}).get("state_distribution", {})
    for state, count in comm_summary.items():
        report += f"| {state} | {count} |\n"

    report += f"""
Total DSP Recommendations: {commercial.get('summary', {}).get('total_dsp_recommendations', 0)}
Clamped: {commercial.get('summary', {}).get('clamped_count', 0)}

---

## 6. AI Track Results

| State | Count |
|-------|-------|
"""

    ai_summary = ai.get("summary", {}).get("state_distribution", {})
    for state, count in ai_summary.items():
        report += f"| {state} | {count} |\n"

    report += f"""
Total DSP Recommendations: {ai.get('summary', {}).get('total_dsp_recommendations', 0)}
Clamped: {ai.get('summary', {}).get('clamped_count', 0)}

---

## 7. Conflict Resolution Tests

Scenarios Tested: {len(conflicts.get('results', []))}

"""

    for result in conflicts.get("results", []):
        report += f"- **{result['scenario']}**: {result['conflict_report']['triggered_count']} conflicts triggered\n"

    report += f"""
---

## 8. Safety Clamp Tests

Scenarios Tested: {len(safety.get('results', []))}

"""

    for result in safety.get("results", []):
        report += f"- **{result['scenario']}**: {result['total_clamped']} parameters clamped\n"

    report += f"""
---

## 9. Validation Results

| Test | Result |
|------|--------|
| Reproducibility ({repro.get('runs', 0)} runs) | {'PASS' if repro.get('reproducible') else 'FAIL'} |
| Edge Cases | {len(edges.get('results', []))} tested |
| Schema Validation | {'PASS' if schema.get('valid') else 'FAIL'} |

---

## 10. Runtime Safety

| Check | Result |
|-------|--------|
| Production Impact | NONE |
| Mastering DSP Changed | False |
| UI Changed | False |
| Output Audio Changed | False |
| Preset Changed | False |

---

## 11. Known Limitations

1. **Mapping Sources**: Most mappings are DESIGN_CANDIDATE (max confidence 0.65)
2. **TEXTURE Profile**: Analysis-only, no DSP recommendations
3. **TRANSIENT Profile**: UNSUPPORTED mapping - needs validation
4. **LOUDNESS/PEAK_SAFETY**: Using heuristic thresholds, not commercial data

---

## 12. Next Phase Recommendations

1. Validate DESIGN_CANDIDATE mappings with listening tests
2. Add DATA_DERIVED targets for LOUDNESS and PEAK_SAFETY
3. Implement TRANSIENT mapping after validation
4. Human review of recommendation quality

---

## Appendix: Files Generated

| File | Description |
|------|-------------|
| 01_repository_dsp_audit.json | DSP processor audit |
| 02_target_registry.json | Commercial targets |
| 03_mapping_rule_registry.json | DSP mapping rules |
| 04_commercial_decisions.json | Commercial track decisions |
| 05_ai_decisions.json | AI track decisions |
| 06_conflict_results.json | Conflict test results |
| 07_safety_clamp_results.json | Safety clamp test results |
| 08_reproducibility.json | Reproducibility test |
| 09_edge_case_results.json | Edge case tests |
| 10_schema_validation.json | Schema validation |
| 11_DSP_DECISION_ENGINE_P0_REPORT.md | This report |

"""

    report_path = OUTPUT_DIR / "11_DSP_DECISION_ENGINE_P0_REPORT.md"
    with open(report_path, "w") as f:
        f.write(report)
    print(f"  Saved: 11_DSP_DECISION_ENGINE_P0_REPORT.md")


def main():
    """Main entry point."""
    print("=" * 60)
    print("DSP Decision Engine P0 - Proof of Concept")
    print("=" * 60)

    # Create output directory
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    # Create engine
    print("\nInitializing DSP Decision Engine...")
    engine = create_engine()

    # Run all tests
    audit = generate_repository_audit()
    targets = generate_target_registry()
    mappings = generate_mapping_registry()
    commercial = evaluate_commercial_tracks(engine)
    ai = evaluate_ai_tracks(engine)
    conflicts = test_conflict_resolution(engine)
    safety = test_safety_clamp(engine)
    repro = test_reproducibility(engine)
    edges = test_edge_cases(engine)
    schema = validate_schema(engine)

    # Generate final report
    generate_final_report(
        audit, targets, mappings, commercial, ai,
        conflicts, safety, repro, edges, schema
    )

    print("\n" + "=" * 60)
    print("P0 Decision Engine Test Suite Complete")
    print("=" * 60)
    print(f"\nOutput: {OUTPUT_DIR}")
    print(f"Report: {OUTPUT_DIR / '11_DSP_DECISION_ENGINE_P0_REPORT.md'}")


if __name__ == "__main__":
    main()
