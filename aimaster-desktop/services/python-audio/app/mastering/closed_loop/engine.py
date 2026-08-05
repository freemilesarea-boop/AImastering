"""
Closed Loop Render Engine P0 - Main Orchestrator

Orchestrates the complete closed loop validation:
1. Feature extraction
2. DSP decision
3. Recommendation selection
4. Parameter translation
5. Test render
6. Post-render analysis
7. Movement validation
8. Regression detection
9. Safety validation
10. Accept/reject decision

Phase: AI-MASTERING-CLOSED-LOOP-RENDER-P0-1
"""

import os
from datetime import datetime
from typing import Dict, List, Any, Optional

from .constants import (
    MAX_PASSES,
    MAX_RECOMMENDATIONS_PER_PASS,
    RenderStatus,
    ANALYSIS_ONLY_PROFILES,
)
from .schema import (
    ClosedLoopResult,
    PassResult,
    SelectedRecommendation,
)
from .recommendation_selector import RecommendationSelector, SelectionResult
from .parameter_translator import ParameterTranslator, TranslationResult
from .render_executor import RenderExecutor, RenderResult
from .movement_validator import MovementValidator, MovementValidationResult
from .regression_detector import RegressionDetector, RegressionDetectionResult
from .safety_gate import SafetyGate, SafetyGateResult
from .accept_reject import AcceptRejectEngine, AcceptRejectDecision
from .rollback import RollbackManager

from app.mastering.decision_engine import DSPDecisionEngine
from app.analyzers.canonical_features import extract_canonical_features
from app.utils.logger import log


class ClosedLoopEngine:
    """
    Main orchestrator for closed loop DSP validation.

    P0 Constraints:
    - NO production pipeline connection
    - Test-only renders to output directory
    - Maximum 3 recommendations per pass
    - Maximum 2 passes
    - Auto-reject on safety failure
    - Auto-reject on blocking regression
    """

    def __init__(
        self,
        output_dir: str = "/Users/theblank/Desktop/Closed-Loop-Render-P0-Output",
        sample_rate: int = 44100,
        bit_depth: int = 24,
    ):
        """
        Initialize the closed loop engine.

        Args:
            output_dir: Directory for all test outputs
            sample_rate: Output sample rate
            bit_depth: Output bit depth
        """
        self.output_dir = output_dir
        self.sample_rate = sample_rate
        self.bit_depth = bit_depth

        os.makedirs(output_dir, exist_ok=True)

        # Initialize components
        self.decision_engine = DSPDecisionEngine()
        self.selector = RecommendationSelector()
        self.translator = ParameterTranslator()
        self.movement_validator = MovementValidator()
        self.regression_detector = RegressionDetector()
        self.safety_gate = SafetyGate()
        self.accept_reject = AcceptRejectEngine()

    def process_track(
        self,
        input_path: str,
        track_name: Optional[str] = None,
    ) -> ClosedLoopResult:
        """
        Process a single track through the closed loop.

        Args:
            input_path: Path to input audio file
            track_name: Optional name for the track

        Returns:
            ClosedLoopResult with all validation details
        """
        timestamp = datetime.now().isoformat()
        track_name = track_name or os.path.splitext(os.path.basename(input_path))[0]

        log("INFO", f"[closed-loop] Processing: {track_name}")

        # Create track-specific output directory
        track_dir = os.path.join(self.output_dir, track_name)
        os.makedirs(track_dir, exist_ok=True)

        # Initialize components for this track
        render_executor = RenderExecutor(
            track_dir,
            sample_rate=self.sample_rate,
            bit_depth=self.bit_depth,
        )
        rollback_manager = RollbackManager(track_dir)
        rollback_manager.register_track(track_name, input_path)

        # ═══════════════════════════════════════════════════════════════════
        # Step 1: Extract original features
        # ═══════════════════════════════════════════════════════════════════
        log("INFO", f"[closed-loop] Extracting original features...")
        try:
            original_features = extract_canonical_features(input_path)
            original_dict = original_features.to_dict()
        except Exception as e:
            log("ERROR", f"[closed-loop] Feature extraction failed: {e}")
            return self._make_failed_result(
                track_name, timestamp, input_path,
                f"Feature extraction failed: {e}"
            )

        # ═══════════════════════════════════════════════════════════════════
        # Step 2: Get DSP decision
        # ═══════════════════════════════════════════════════════════════════
        log("INFO", f"[closed-loop] Running DSP decision engine...")
        try:
            decision_result = self.decision_engine.evaluate_track(
                original_dict, track_name,
            )
            decision_dict = decision_result.to_dict()
        except Exception as e:
            log("ERROR", f"[closed-loop] Decision engine failed: {e}")
            return self._make_failed_result(
                track_name, timestamp, input_path,
                f"Decision engine failed: {e}"
            )

        # Check for blocked actions
        blocked_actions = decision_result.conflict_report.blocked_actions

        # ═══════════════════════════════════════════════════════════════════
        # Step 3: Multi-pass processing
        # ═══════════════════════════════════════════════════════════════════
        passes: List[PassResult] = []
        applied_recommendation_ids: List[str] = []
        current_input_path = input_path
        current_features = original_dict
        final_status = RenderStatus.NO_ACTION
        final_features = original_dict

        for pass_num in range(1, MAX_PASSES + 1):
            log("INFO", f"[closed-loop] Pass {pass_num}...")

            # ─── Select recommendations ───
            selection = self.selector.select_recommendations(
                decision_dict,
                blocked_actions=blocked_actions,
                already_applied=applied_recommendation_ids,
                max_per_pass=MAX_RECOMMENDATIONS_PER_PASS,
            )

            if len(selection.selected) == 0:
                log("INFO", f"[closed-loop] No recommendations to apply in pass {pass_num}")
                if pass_num == 1:
                    final_status = RenderStatus.NO_ACTION
                break

            log("INFO", f"[closed-loop] Selected {len(selection.selected)} recommendations")

            # ─── Translate parameters ───
            translation = self.translator.translate_recommendations(
                selection.selected,
            )

            if not translation.filter_chain:
                log("WARN", f"[closed-loop] No filter chain generated")
                continue

            log("INFO", f"[closed-loop] Filter chain: {translation.filter_chain[:100]}...")

            # ─── Render ───
            candidate_name = f"{track_name}_pass{pass_num}_candidate"
            render_result = render_executor.render(
                current_input_path,
                translation.filter_chain,
                candidate_name,
            )

            if not render_result.success:
                log("ERROR", f"[closed-loop] Render failed: {render_result.error_message}")
                pass_result = PassResult(
                    pass_number=pass_num,
                    applied_recommendations=selection.selected,
                    filter_chain=translation.filter_chain,
                    candidate_path="",
                    before_features=current_features,
                    after_features={},
                    movement_results=[],
                    regression_results=[],
                    safety_result=SafetyGateResult(
                        passed=False,
                        checks=[],
                        critical_failures=1,
                        warning_count=0,
                        failure_codes=["RENDER_FAILED"],
                    ),
                    status=RenderStatus.RENDER_FAILED,
                    accepted_recommendations=[],
                    rejected_recommendations=[r.recommendation_id for r in selection.selected],
                    notes=render_result.error_message,
                )
                passes.append(pass_result)
                final_status = RenderStatus.RENDER_FAILED
                break

            rollback_manager.record_candidate(track_name, pass_num, render_result.output_path)

            # ─── Post-render feature extraction ───
            log("INFO", f"[closed-loop] Extracting post-render features...")
            try:
                after_features_obj = extract_canonical_features(render_result.output_path)
                after_features = after_features_obj.to_dict()
            except Exception as e:
                log("ERROR", f"[closed-loop] Post-render feature extraction failed: {e}")
                rollback_manager.reject_candidate(track_name, pass_num, render_result.output_path)
                final_status = RenderStatus.RENDER_FAILED
                break

            # ─── Movement validation ───
            movement_result = self.movement_validator.validate_movement(
                selection.selected,
                current_features,
                after_features,
            )
            log("INFO", f"[closed-loop] Movement: {movement_result.improvement_count} improved, "
                       f"{movement_result.regression_count} regressed")

            # ─── Regression detection ───
            regression_result = self.regression_detector.detect_regression(
                selection.selected,
                current_features,
                after_features,
            )
            log("INFO", f"[closed-loop] Regression: {len(regression_result.blocking_profiles)} blocking")

            # ─── Safety gate ───
            safety_result = self.safety_gate.validate(
                render_result.output_path,
                current_features,
                after_features,
                expected_duration_sec=render_result.duration_sec,
                expected_channels=render_result.channels,
            )
            log("INFO", f"[closed-loop] Safety: {'PASS' if safety_result.passed else 'FAIL'}")

            # ─── Accept/Reject decision ───
            accept_decision = self.accept_reject.decide(
                selection.selected,
                movement_result.results,
                regression_result.results,
                safety_result,
            )
            log("INFO", f"[closed-loop] Decision: {accept_decision.status.value}")

            # ─── Record pass result ───
            pass_result = PassResult(
                pass_number=pass_num,
                applied_recommendations=selection.selected,
                filter_chain=translation.filter_chain,
                candidate_path=render_result.output_path,
                before_features=current_features,
                after_features=after_features,
                movement_results=movement_result.results,
                regression_results=regression_result.results,
                safety_result=safety_result,
                status=accept_decision.status,
                accepted_recommendations=accept_decision.accepted_recommendation_ids,
                rejected_recommendations=accept_decision.rejected_recommendation_ids,
                notes=accept_decision.reason,
            )
            passes.append(pass_result)

            # ─── Handle accept/reject ───
            if accept_decision.status == RenderStatus.ACCEPTED:
                rollback_manager.accept_candidate(track_name, pass_num, render_result.output_path)
                applied_recommendation_ids.extend(accept_decision.accepted_recommendation_ids)
                current_input_path = render_result.output_path
                current_features = after_features
                final_features = after_features
                final_status = RenderStatus.ACCEPTED

            elif accept_decision.status == RenderStatus.PARTIALLY_ACCEPTED:
                rollback_manager.accept_candidate(track_name, pass_num, render_result.output_path)
                applied_recommendation_ids.extend(accept_decision.accepted_recommendation_ids)
                current_input_path = render_result.output_path
                current_features = after_features
                final_features = after_features
                final_status = RenderStatus.PARTIALLY_ACCEPTED

            elif accept_decision.status == RenderStatus.REJECTED:
                rollback_manager.reject_candidate(track_name, pass_num, render_result.output_path)
                final_status = RenderStatus.REJECTED
                break

            # Check if should continue
            should_continue, reason = self.accept_reject.should_continue_to_next_pass(
                accept_decision, pass_num, MAX_PASSES,
            )
            if not should_continue:
                log("INFO", f"[closed-loop] Stopping: {reason}")
                break

        # ═══════════════════════════════════════════════════════════════════
        # Step 4: Finalize
        # ═══════════════════════════════════════════════════════════════════
        final_path = rollback_manager.finalize(track_name, f"{track_name}_final")

        # Create level-matched previews
        level_matched = {}
        if final_path != input_path and os.path.exists(final_path):
            level_matched = render_executor.create_level_matched_preview(
                input_path, final_path,
            )

        # Build decision summary
        decision_summary = {
            "total_passes": len(passes),
            "final_status": final_status.value,
            "recommendations_applied": len(applied_recommendation_ids),
            "original_modified": final_path != input_path,
            "rollback_summary": rollback_manager.get_rollback_summary(track_name),
        }

        return ClosedLoopResult(
            file_name=track_name,
            timestamp=timestamp,
            original_path=input_path,
            final_path=final_path,
            final_status=final_status,
            pass_count=len(passes),
            passes=passes,
            decision_summary=decision_summary,
            original_features=original_dict,
            final_features=final_features,
            level_matched_paths=level_matched,
        )

    def _make_failed_result(
        self,
        track_name: str,
        timestamp: str,
        input_path: str,
        error_message: str,
    ) -> ClosedLoopResult:
        """Create a failed result."""
        return ClosedLoopResult(
            file_name=track_name,
            timestamp=timestamp,
            original_path=input_path,
            final_path=input_path,
            final_status=RenderStatus.RENDER_FAILED,
            pass_count=0,
            passes=[],
            decision_summary={"error": error_message},
            original_features={},
            final_features={},
            level_matched_paths={},
            metadata={"error": error_message},
        )

    def process_tracks(
        self,
        input_paths: List[str],
    ) -> List[ClosedLoopResult]:
        """
        Process multiple tracks.

        Args:
            input_paths: List of input audio file paths

        Returns:
            List of ClosedLoopResults
        """
        results = []
        for path in input_paths:
            result = self.process_track(path)
            results.append(result)
        return results

    def check_reproducibility(
        self,
        input_path: str,
        runs: int = 3,
    ) -> Dict[str, Any]:
        """
        Check reproducibility of processing.

        Args:
            input_path: Path to input audio file
            runs: Number of runs to compare

        Returns:
            Reproducibility report
        """
        results = []
        for i in range(runs):
            result = self.process_track(input_path, f"repro_run_{i+1}")
            results.append(result)

        # Compare results
        all_match = True
        differences = []

        baseline = results[0]
        for i, result in enumerate(results[1:], 2):
            if result.final_status != baseline.final_status:
                all_match = False
                differences.append({
                    "run": i,
                    "field": "final_status",
                    "baseline": baseline.final_status.value,
                    "current": result.final_status.value,
                })

            if result.pass_count != baseline.pass_count:
                all_match = False
                differences.append({
                    "run": i,
                    "field": "pass_count",
                    "baseline": baseline.pass_count,
                    "current": result.pass_count,
                })

        return {
            "runs": runs,
            "reproducible": all_match,
            "differences": differences,
            "status": "PASS" if all_match else "FAIL",
        }

    def generate_audit_reports(self) -> Dict[str, Dict]:
        """Generate audit reports for all components."""
        return {
            "decision_engine": self.decision_engine.generate_audit_reports(),
            "translation": self.translator.generate_audit_report(),
        }


def create_engine(
    output_dir: str = "/Users/theblank/Desktop/Closed-Loop-Render-P0-Output",
) -> ClosedLoopEngine:
    """Factory function to create engine instance."""
    return ClosedLoopEngine(output_dir=output_dir)
