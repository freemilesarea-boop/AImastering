"""
Closed Loop Calibration P1 - Main Engine

Orchestrates the complete calibration process.

Phase: AI-MASTERING-CLOSED-LOOP-CALIBRATION-P1-1
"""

import os
import json
from datetime import datetime
from typing import Dict, List, Optional, Any

from .constants import CalibrationStatus, REPRODUCIBILITY_RUNS
from .schema import (
    CalibrationReport,
    CandidateResult,
    SweepCandidate,
    ResponseCurve,
    MappingCalibrationResult,
    NoActionAuditResult,
)
from .dataset_builder import DatasetBuilder, DatasetSummary
from .sweep_registry import SweepRegistry
from .candidate_runner import CandidateRunner
from .curve_builder import CurveBuilder
from .mapping_calibrator import MappingCalibrator
from .no_action_auditor import NoActionAuditor
from .confidence import ConfidenceCalculator, CalibrationConfidence
from .output_validator import build_validation_report
from .runtime_validator import build_runtime_safety_report
from .reproducibility import check_reproducibility
from app.mastering.decision_engine.mapping_registry import get_mapping_registry
from app.utils.logger import log


class CalibrationEngine:
    """
    Main orchestrator for closed-loop calibration.

    Workflow:
    1. Build calibration dataset
    2. Generate parameter sweep candidates
    3. Run candidate renders
    4. Analyze feature responses
    5. Build response curves
    6. Calibrate mapping rules
    7. Audit NO_ACTION sensitivity
    8. Generate reports
    """

    def __init__(
        self,
        output_dir: str = "/Users/theblank/Desktop/Closed-Loop-Calibration-P1-Output",
        ai_tracks_dir: str = "/Users/theblank/Desktop/AI 음원",
        max_candidates: Optional[int] = None,
    ):
        self.output_dir = output_dir
        self.ai_tracks_dir = ai_tracks_dir
        self.max_candidates = max_candidates

        os.makedirs(output_dir, exist_ok=True)

        # Initialize components
        self.dataset_builder = DatasetBuilder(ai_tracks_dir)
        self.sweep_registry = SweepRegistry()
        self.curve_builder = CurveBuilder()
        self.mapping_calibrator = MappingCalibrator()
        self.no_action_auditor = NoActionAuditor()
        self.confidence_calculator = ConfidenceCalculator()

    def run_calibration(self) -> CalibrationReport:
        """
        Run complete calibration process.

        Returns:
            CalibrationReport with all results
        """
        timestamp = datetime.now().isoformat()
        log("INFO", f"[calibration] Starting calibration at {timestamp}")

        # ═══════════════════════════════════════════════════════════════════
        # Step 1: Build Dataset
        # ═══════════════════════════════════════════════════════════════════
        log("INFO", "[calibration] Step 1: Building dataset...")
        dataset = self.dataset_builder.build_dataset()
        track_paths = self.dataset_builder.get_valid_track_paths(dataset)

        if not track_paths:
            log("ERROR", "[calibration] No valid tracks found")
            return CalibrationReport(
                timestamp=timestamp,
                dataset_summary={"error": "No valid tracks"},
            )

        log("INFO", f"[calibration] Dataset: {len(track_paths)} valid tracks")

        # Save dataset report
        dataset_report = self.dataset_builder.generate_dataset_report(dataset)
        self._save_json("01_calibration_dataset.json", dataset_report)

        # ═══════════════════════════════════════════════════════════════════
        # Step 2: Generate Sweep Candidates
        # ═══════════════════════════════════════════════════════════════════
        log("INFO", "[calibration] Step 2: Generating sweep candidates...")
        candidates = self.sweep_registry.generate_candidates(track_paths)

        # Save sweep registry
        sweep_report = self.sweep_registry.generate_registry_report()
        self._save_json("02_processor_sweep_registry.json", sweep_report)

        log("INFO", f"[calibration] Generated {len(candidates)} candidates")

        # ═══════════════════════════════════════════════════════════════════
        # Step 3: Run Candidates
        # ═══════════════════════════════════════════════════════════════════
        log("INFO", "[calibration] Step 3: Running candidates...")
        runner = CandidateRunner(
            output_dir=os.path.join(self.output_dir, "renders"),
        )

        results = runner.run_candidates(candidates, max_candidates=self.max_candidates)

        # Save candidate results
        results_report = {
            "total_candidates": len(results),
            "passed": sum(1 for r in results if r.status == CalibrationStatus.PASSED),
            "rejected": sum(1 for r in results if r.status == CalibrationStatus.REJECTED),
            "safety_failed": sum(1 for r in results if r.status == CalibrationStatus.SAFETY_FAILED),
            "render_failed": sum(1 for r in results if r.status == CalibrationStatus.RENDER_FAILED),
            "results": [r.to_dict() for r in results],
        }
        self._save_json("03_candidate_render_results.json", results_report)

        # ═══════════════════════════════════════════════════════════════════
        # Step 4: Build Response Curves
        # ═══════════════════════════════════════════════════════════════════
        log("INFO", "[calibration] Step 4: Building response curves...")
        curves = self.curve_builder.build_curves(results)

        # Save response curves
        curves_report = self.curve_builder.generate_curves_report(curves)
        self._save_json("05_response_curves.json", curves_report)

        # ═══════════════════════════════════════════════════════════════════
        # Step 5: Calibrate Mappings
        # ═══════════════════════════════════════════════════════════════════
        log("INFO", "[calibration] Step 5: Calibrating mappings...")
        # Candidate results are passed alongside the curves: regression needs the
        # before/after features of individual renders, which curve aggregation
        # has already averaged away.
        calibrations = self.mapping_calibrator.calibrate_mappings(curves, results)

        # Save original and calibrated registries
        original_registry = get_mapping_registry().generate_audit_report()
        self._save_json("10_mapping_registry_original.json", original_registry)

        calibrated_report = {
            "calibrations": [
                {
                    "rule_id": c.rule_id,
                    "profile": c.profile,
                    "processor": c.processor,
                    "parameter": c.parameter,
                    "existing_range": c.existing_range,
                    "calibrated_range": c.calibrated_range,
                    "change_type": c.change_type.value,
                    "source_candidate": c.source_candidate.value,
                    "valid_tracks": c.valid_tracks,
                    "direction_correctness": c.direction_correctness,
                    "safety_pass_rate": c.safety_pass_rate,
                    "overshoot_rate": c.overshoot_rate,
                    "regression_rate": c.regression_rate,
                    "regression_measured": c.regression_measured,
                    "r1_rate": c.r1_rate,
                    "r3_rate": c.r3_rate,
                    "r2_violation_count": c.r2_violation_count,
                    "confidence_score": c.confidence_score,
                    "promotion_eligible": c.promotion_eligible,
                    "notes": c.notes,
                }
                for c in calibrations
            ],
        }
        self._save_json("11_mapping_registry_calibrated_candidate.json", calibrated_report)

        # Save diff
        diff_report = self.mapping_calibrator.generate_mapping_diff(calibrations)
        self._save_json("12_mapping_registry_diff.json", diff_report)

        # ═══════════════════════════════════════════════════════════════════
        # Step 6: NO_ACTION Audit
        # ═══════════════════════════════════════════════════════════════════
        log("INFO", "[calibration] Step 6: Running NO_ACTION audit...")
        no_action_audits = self.no_action_auditor.audit_tracks(track_paths)
        no_action_report = self.no_action_auditor.generate_audit_report(no_action_audits)
        self._save_json("09_no_action_sensitivity_audit.json", no_action_report)

        # ═══════════════════════════════════════════════════════════════════
        # Step 7: Calculate Confidence
        # ═══════════════════════════════════════════════════════════════════
        log("INFO", "[calibration] Step 7: Calculating confidence...")
        confidence = self.confidence_calculator.calculate_overall_confidence(
            curves, calibrations,
        )
        confidence_report = self.confidence_calculator.generate_confidence_report(confidence)
        self._save_json("13_calibration_confidence.json", confidence_report)

        # ═══════════════════════════════════════════════════════════════════
        # Step 8: Safety and Validation Reports
        # ═══════════════════════════════════════════════════════════════════
        log("INFO", "[calibration] Step 8: Generating safety reports...")

        # Safety results
        safety_report = self._generate_safety_report(results)
        self._save_json("06_safety_results.json", safety_report)

        # Overshoot results
        overshoot_report = self._generate_overshoot_report(results)
        self._save_json("07_overshoot_results.json", overshoot_report)

        # Collateral regression
        regression_report = self._generate_regression_report(results)
        self._save_json("08_collateral_regression_results.json", regression_report)

        # Feature response (summary)
        feature_report = self._generate_feature_response_report(results)
        self._save_json("04_feature_response_results.json", feature_report)

        # Runtime safety (computed from git diff + static import graph)
        runtime_safety = build_runtime_safety_report()
        self._save_json("17_runtime_safety.json", runtime_safety)

        # ═══════════════════════════════════════════════════════════════════
        # Step 9: Reproducibility Test
        # ═══════════════════════════════════════════════════════════════════
        log("INFO", "[calibration] Step 9: Running reproducibility test...")
        repro_result = self._run_reproducibility_test(candidates)
        self._save_json("14_reproducibility.json", repro_result)

        # Schema validation (reads the emitted artifacts, mutates nothing)
        schema_validation = build_validation_report(self.output_dir)
        self._save_json("15_schema_validation.json", schema_validation)

        # Build final report
        report = CalibrationReport(
            timestamp=timestamp,
            dataset_summary={
                "total_tracks": len(dataset.ai_tracks),
                "valid_tracks": dataset.valid_count,
                "excluded_tracks": dataset.excluded_count,
            },
            total_candidates=len(candidates),
            rendered_candidates=sum(1 for r in results if r.render_success),
            passed_candidates=sum(1 for r in results if r.status == CalibrationStatus.PASSED),
            rejected_candidates=sum(1 for r in results if r.status == CalibrationStatus.REJECTED),
            safety_failed_candidates=sum(1 for r in results if r.status == CalibrationStatus.SAFETY_FAILED),
            response_curves=curves,
            mapping_calibrations=calibrations,
            no_action_audits=no_action_audits,
            reproducibility_passed=repro_result.get("passed", False),
            reproducibility_details=repro_result,
            schema_valid=schema_validation["valid"],
            runtime_safe=runtime_safety["runtime_safe"],
            production_affected=runtime_safety["production_affected"],
        )

        log("INFO", "[calibration] Calibration complete")
        return report

    def _save_json(self, filename: str, data: Dict):
        """Save JSON report."""
        path = os.path.join(self.output_dir, filename)
        with open(path, "w") as f:
            json.dump(data, f, indent=2, default=str)
        log("INFO", f"[calibration] Saved: {path}")

    def _generate_safety_report(self, results: List[CandidateResult]) -> Dict:
        """Generate safety results report."""
        failures: Dict[str, int] = {}
        for result in results:
            for failure in result.safety_failures:
                failures[failure] = failures.get(failure, 0) + 1

        return {
            "total_candidates": len(results),
            "safety_passed": sum(1 for r in results if r.safety_passed),
            "safety_failed": sum(1 for r in results if not r.safety_passed and r.render_success),
            "failure_breakdown": failures,
        }

    def _generate_overshoot_report(self, results: List[CandidateResult]) -> Dict:
        """Generate overshoot report."""
        overshoot_candidates = [r for r in results if r.overshoot]
        return {
            "total_overshoot": len(overshoot_candidates),
            "overshoot_rate": len(overshoot_candidates) / len(results) if results else 0.0,
            "candidates": [r.candidate.candidate_id for r in overshoot_candidates],
        }

    def _generate_regression_report(self, results: List[CandidateResult]) -> Dict:
        """Generate collateral regression report."""
        regression_candidates = [r for r in results if r.regression_detected]
        return {
            "total_regression": len(regression_candidates),
            "regression_rate": len(regression_candidates) / len(results) if results else 0.0,
            "candidates": [r.candidate.candidate_id for r in regression_candidates],
        }

    def _generate_feature_response_report(self, results: List[CandidateResult]) -> Dict:
        """Generate feature response summary."""
        responses_by_feature: Dict[str, List[float]] = {}

        for result in results:
            if result.status != CalibrationStatus.PASSED:
                continue
            for resp in result.primary_responses:
                if resp.feature not in responses_by_feature:
                    responses_by_feature[resp.feature] = []
                responses_by_feature[resp.feature].append(resp.response_per_unit)

        summary = {}
        for feature, values in responses_by_feature.items():
            if values:
                import statistics
                summary[feature] = {
                    "mean_response_per_unit": statistics.mean(values),
                    "median_response_per_unit": statistics.median(values),
                    "std": statistics.stdev(values) if len(values) > 1 else 0.0,
                    "sample_count": len(values),
                }

        return {
            "feature_summary": summary,
            "total_valid_responses": sum(len(v) for v in responses_by_feature.values()),
        }

    def _run_reproducibility_test(self, candidates: List[SweepCandidate]) -> Dict:
        """Prove determinism by re-rendering sampled candidates and comparing.

        Renders go to a temporary directory; the archived renders under
        output_dir are read for comparison only and never overwritten.
        """
        return check_reproducibility(
            candidates,
            runs=REPRODUCIBILITY_RUNS,
            archived_renders_dir=os.path.join(self.output_dir, "renders"),
        )


def create_calibration_engine(
    output_dir: str = "/Users/theblank/Desktop/Closed-Loop-Calibration-P1-Output",
    max_candidates: Optional[int] = None,
) -> CalibrationEngine:
    """Factory function to create calibration engine."""
    return CalibrationEngine(output_dir=output_dir, max_candidates=max_candidates)
