#!/usr/bin/env python3
"""
Closed Loop Calibration P1 - POC Test Script

Runs the complete calibration process on AI tracks.

Phase: AI-MASTERING-CLOSED-LOOP-CALIBRATION-P1-1

Usage:
    python scripts/closed_loop_calibration_p1.py [--max-candidates N] [--quick]
"""

import os
import sys
import json
import argparse
from datetime import datetime

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.mastering.calibration import (
    CalibrationEngine,
    create_calibration_engine,
    CalibrationStatus,
    MappingSourceCandidate,
)
from app.utils.logger import log


def generate_final_report(report, output_dir: str):
    """Generate the final markdown report."""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # Calculate statistics
    total_candidates = report.total_candidates
    rendered = report.rendered_candidates
    passed = report.passed_candidates
    rejected = report.rejected_candidates
    safety_failed = report.safety_failed_candidates

    # Curve statistics
    curves = report.response_curves
    total_curves = len(curves)
    nonlinear_curves = sum(1 for c in curves if c.nonlinear_response)
    unsafe_curves = sum(1 for c in curves if c.unsafe_point is not None)

    # Calibration statistics
    calibrations = report.mapping_calibrations
    total_rules = len(calibrations)
    promotion_candidates = sum(1 for c in calibrations if c.promotion_eligible)
    blocked = sum(1 for c in calibrations if c.source_candidate == MappingSourceCandidate.BLOCKED)

    # NO_ACTION audit
    no_action_audits = report.no_action_audits
    total_audits = len(no_action_audits)
    confirmed_no_action = sum(1 for a in no_action_audits if a.confirmed_no_action)
    possible_false = sum(1 for a in no_action_audits if a.possible_false_no_action)

    markdown = f"""# Closed Loop Calibration P1 Report

**Generated**: {timestamp}
**Phase**: AI-MASTERING-CLOSED-LOOP-CALIBRATION-P1-1

## Summary

| Metric | Value |
|--------|-------|
| Total Candidates | {total_candidates} |
| Rendered | {rendered} |
| Passed | {passed} |
| Rejected | {rejected} |
| Safety Failed | {safety_failed} |

## Dataset

- **Total Tracks**: {report.dataset_summary.get('total_tracks', 0)}
- **Valid Tracks**: {report.dataset_summary.get('valid_tracks', 0)}
- **Excluded Tracks**: {report.dataset_summary.get('excluded_tracks', 0)}

## Response Curves

- **Total Curves Built**: {total_curves}
- **Nonlinear Responses**: {nonlinear_curves}
- **Curves with Unsafe Zone**: {unsafe_curves}

### Curves by Processor

| Processor | Curves | Valid Samples |
|-----------|--------|---------------|
"""

    # Group curves by processor
    by_processor = {}
    for curve in curves:
        if curve.processor not in by_processor:
            by_processor[curve.processor] = {"count": 0, "samples": 0}
        by_processor[curve.processor]["count"] += 1
        by_processor[curve.processor]["samples"] += curve.valid_samples

    for proc, data in sorted(by_processor.items()):
        markdown += f"| {proc} | {data['count']} | {data['samples']} |\n"

    markdown += f"""
## Mapping Calibration

- **Total Rules Evaluated**: {total_rules}
- **Promotion Candidates**: {promotion_candidates}
- **Blocked (Safety Failed)**: {blocked}

### Rules by Status

| Source Candidate | Count |
|------------------|-------|
"""

    # Group by source candidate
    by_source = {}
    for cal in calibrations:
        source = cal.source_candidate.value
        by_source[source] = by_source.get(source, 0) + 1

    for source, count in sorted(by_source.items()):
        markdown += f"| {source} | {count} |\n"

    markdown += f"""
## NO_ACTION Sensitivity Audit

- **Total Audits**: {total_audits}
- **Confirmed NO_ACTION**: {confirmed_no_action}
- **Possible False NO_ACTION**: {possible_false}
- **False Positive Rate**: {possible_false / total_audits * 100 if total_audits > 0 else 0:.1f}%

## Reproducibility

- **Passed**: {report.reproducibility_passed}
- **Details**: {report.reproducibility_details.get('note', 'N/A')}

## Validation

- **Schema Valid**: {report.schema_valid}
- **Runtime Safe**: {report.runtime_safe}
- **Production Affected**: {report.production_affected}

## Output Files

The following files were generated in `{output_dir}/`:

1. `01_calibration_dataset.json` - Dataset summary
2. `02_processor_sweep_registry.json` - Parameter sweep configuration
3. `03_candidate_render_results.json` - Render results for all candidates
4. `04_feature_response_results.json` - Feature response measurements
5. `05_response_curves.json` - Built response curves
6. `06_safety_results.json` - Safety validation results
7. `07_overshoot_results.json` - Overshoot detection results
8. `08_collateral_regression_results.json` - Regression detection results
9. `09_no_action_sensitivity_audit.json` - NO_ACTION audit results
10. `10_mapping_registry_original.json` - Original mapping registry
11. `11_mapping_registry_calibrated_candidate.json` - Calibrated mappings
12. `12_mapping_registry_diff.json` - Diff between original and calibrated
13. `13_calibration_confidence.json` - Confidence scores
14. `14_reproducibility.json` - Reproducibility test results
15. `15_schema_validation.json` - Schema validation results
16. `17_runtime_safety.json` - Runtime safety verification

## Conclusion

This calibration run provides CANDIDATE mappings for review. These are NOT production-ready.

**Next Steps:**
1. Review promotion candidates manually
2. Run listening tests on samples
3. Validate with expanded dataset
4. Promote validated rules to DATA_DERIVED

---

*Phase: AI-MASTERING-CLOSED-LOOP-CALIBRATION-P1-1*
*Generated by: closed_loop_calibration_p1.py*
"""

    # Save report
    report_path = os.path.join(output_dir, "18_CLOSED_LOOP_CALIBRATION_P1_REPORT.md")
    with open(report_path, "w") as f:
        f.write(markdown)

    log("INFO", f"[calibration] Final report saved: {report_path}")
    return report_path


def main():
    parser = argparse.ArgumentParser(
        description="Run Closed Loop Calibration P1"
    )
    parser.add_argument(
        "--max-candidates",
        type=int,
        default=None,
        help="Maximum number of candidates to process (for testing)",
    )
    parser.add_argument(
        "--quick",
        action="store_true",
        help="Quick mode: process only 20 candidates",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default="/Users/theblank/Desktop/Closed-Loop-Calibration-P1-Output",
        help="Output directory for reports",
    )
    parser.add_argument(
        "--tracks-dir",
        type=str,
        default="/Users/theblank/Desktop/AI 음원",
        help="Directory containing AI tracks",
    )

    args = parser.parse_args()

    # Set max candidates
    max_candidates = args.max_candidates
    if args.quick and max_candidates is None:
        max_candidates = 20

    print("=" * 70)
    print("CLOSED LOOP CALIBRATION P1")
    print("Phase: AI-MASTERING-CLOSED-LOOP-CALIBRATION-P1-1")
    print("=" * 70)
    print()
    print(f"Output Directory: {args.output_dir}")
    print(f"Tracks Directory: {args.tracks_dir}")
    print(f"Max Candidates: {max_candidates or 'All'}")
    print()

    # Create engine
    engine = CalibrationEngine(
        output_dir=args.output_dir,
        ai_tracks_dir=args.tracks_dir,
        max_candidates=max_candidates,
    )

    # Run calibration
    print("Starting calibration...")
    print()

    try:
        report = engine.run_calibration()
    except Exception as e:
        log("ERROR", f"[calibration] Calibration failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

    # Generate final report
    report_path = generate_final_report(report, args.output_dir)

    # Print summary
    print()
    print("=" * 70)
    print("CALIBRATION COMPLETE")
    print("=" * 70)
    print()
    print(f"Total Candidates: {report.total_candidates}")
    print(f"Rendered: {report.rendered_candidates}")
    print(f"Passed: {report.passed_candidates}")
    print(f"Rejected: {report.rejected_candidates}")
    print(f"Safety Failed: {report.safety_failed_candidates}")
    print()
    print(f"Response Curves Built: {len(report.response_curves)}")
    print(f"Mapping Rules Evaluated: {len(report.mapping_calibrations)}")
    print(f"Promotion Candidates: {sum(1 for c in report.mapping_calibrations if c.promotion_eligible)}")
    print()
    print(f"NO_ACTION Audits: {len(report.no_action_audits)}")
    print()
    print(f"Reproducibility: {'PASS' if report.reproducibility_passed else 'FAIL'}")
    print(f"Schema Valid: {report.schema_valid}")
    print(f"Runtime Safe: {report.runtime_safe}")
    print(f"Production Affected: {report.production_affected}")
    print()
    print(f"Final Report: {report_path}")
    print()

    # Check for required conditions
    if report.production_affected:
        print("ERROR: Production was affected! This should not happen.")
        sys.exit(1)

    if not report.runtime_safe:
        print("ERROR: Runtime safety check failed!")
        sys.exit(1)

    print("All safety checks passed.")
    print()


if __name__ == "__main__":
    main()
