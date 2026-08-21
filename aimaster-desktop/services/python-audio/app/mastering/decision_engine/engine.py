"""
DSP Decision Engine P0 - Main Orchestrator

Test-only implementation for advisory DSP recommendations.
NO actual DSP processing, NO production pipeline connection.

Orchestrates:
- Feature delta calculation
- Commercial target comparison
- Conflict detection (via existing Conflict Engine)
- DSP recommendation generation
- Safety clamping
- Output generation
"""

import json
from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List, Optional, Any

from .constants import DecisionState, PROFILE_ORDER
from .target_registry import get_target_registry
from .delta_engine import DeltaEngine, ProfileDelta
from .mapping_registry import get_mapping_registry
from .recommendation_engine import RecommendationEngine, ProfileRecommendation
from .safety_clamp import get_safety_clamp

# Import existing conflict engine from Audio Profile Engine
from app.mastering.audio_profiles.conflict_engine import ConflictEngine, ConflictReport
from app.mastering.audio_profiles.feature_input import FeatureSet


@dataclass
class EngineResult:
    """Complete decision engine result."""
    file_name: str
    timestamp: str
    profile_deltas: Dict[str, ProfileDelta]
    conflict_report: ConflictReport
    recommendations: Dict[str, ProfileRecommendation]
    summary: Dict[str, Any]
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict:
        """Convert to dictionary for serialization."""
        return {
            "file_name": self.file_name,
            "timestamp": self.timestamp,
            "profile_deltas": {
                k: v.to_dict() for k, v in self.profile_deltas.items()
            },
            "conflict_report": {
                "total_rules": self.conflict_report.total_rules,
                "triggered_count": self.conflict_report.triggered_count,
                "block_count": self.conflict_report.block_count,
                "conditional_count": self.conflict_report.conditional_count,
                "warn_count": self.conflict_report.warn_count,
                "blocked_actions": self.conflict_report.blocked_actions,
                "conditional_profiles": self.conflict_report.conditional_profiles,
            },
            "recommendations": {
                k: v.to_dict() for k, v in self.recommendations.items()
            },
            "summary": self.summary,
            "metadata": self.metadata,
        }


class DSPDecisionEngine:
    """
    Main orchestrator for DSP Decision Engine P0.

    Usage:
        engine = DSPDecisionEngine()

        # Evaluate a single track
        result = engine.evaluate_track(features_dict, "track.wav")

        # Get all recommendations
        for profile, rec in result.recommendations.items():
            print(f"{profile}: {rec.state.value}")
    """

    def __init__(self):
        """Initialize the decision engine."""
        self.target_registry = get_target_registry()
        self.delta_engine = DeltaEngine()
        self.mapping_registry = get_mapping_registry()
        self.recommendation_engine = RecommendationEngine()
        self.safety_clamp = get_safety_clamp()
        self.conflict_engine = ConflictEngine()

    def evaluate_track(
        self,
        features: Dict[str, Any],
        file_name: str = "unknown",
        metadata: Optional[Dict] = None,
    ) -> EngineResult:
        """
        Evaluate a single track and generate recommendations.

        Args:
            features: Dictionary of feature values (from Canonical Analyzer)
            file_name: Name of the source file
            metadata: Optional metadata

        Returns:
            Complete EngineResult with all recommendations
        """
        timestamp = datetime.now().isoformat()
        metadata = metadata or {}

        # 1. Calculate profile deltas
        profile_deltas = self.delta_engine.calculate_all_profile_deltas(features)

        # 2. Run conflict detection
        feature_set = FeatureSet(
            file_name=file_name,
            features=features,
            metadata=metadata,
        )
        conflict_report = self.conflict_engine.evaluate_all(feature_set)

        # 3. Generate recommendations (with blocked actions from conflicts)
        recommendations = self.recommendation_engine.generate_all_recommendations(
            features,
            blocked_actions=conflict_report.blocked_actions,
        )

        # 4. Generate summary
        summary = self._generate_summary(
            profile_deltas, conflict_report, recommendations
        )

        return EngineResult(
            file_name=file_name,
            timestamp=timestamp,
            profile_deltas=profile_deltas,
            conflict_report=conflict_report,
            recommendations=recommendations,
            summary=summary,
            metadata=metadata,
        )

    def _generate_summary(
        self,
        profile_deltas: Dict[str, ProfileDelta],
        conflict_report: ConflictReport,
        recommendations: Dict[str, ProfileRecommendation],
    ) -> Dict[str, Any]:
        """Generate summary statistics."""
        state_counts = {}
        for state in DecisionState:
            state_counts[state.value] = 0

        for rec in recommendations.values():
            state_counts[rec.state.value] += 1

        total_recommendations = sum(
            len(rec.recommendations) for rec in recommendations.values()
        )

        clamped_count = sum(
            1 for rec in recommendations.values()
            for r in rec.recommendations if r.clamped
        )

        return {
            "total_profiles": len(PROFILE_ORDER),
            "state_distribution": state_counts,
            "no_action_count": state_counts.get("NO_ACTION", 0),
            "recommend_count": state_counts.get("RECOMMEND", 0),
            "conditional_count": state_counts.get("CONDITIONAL", 0),
            "blocked_count": state_counts.get("BLOCKED", 0),
            "insufficient_data_count": state_counts.get("INSUFFICIENT_DATA", 0),
            "uncalibrated_count": state_counts.get("UNCALIBRATED", 0),
            "total_dsp_recommendations": total_recommendations,
            "clamped_count": clamped_count,
            "conflict_triggered_count": conflict_report.triggered_count,
            "conflict_block_count": conflict_report.block_count,
        }

    def evaluate_tracks(
        self,
        tracks: List[Dict[str, Any]],
    ) -> List[EngineResult]:
        """
        Evaluate multiple tracks.

        Args:
            tracks: List of track dictionaries with 'file' and feature keys

        Returns:
            List of EngineResults
        """
        results = []
        for track in tracks:
            file_name = track.get("file", "unknown")
            result = self.evaluate_track(track, file_name)
            results.append(result)
        return results

    def generate_audit_reports(self) -> Dict[str, Dict]:
        """Generate audit reports for all components."""
        return {
            "targets": self.target_registry.generate_audit_report(),
            "mappings": self.mapping_registry.generate_audit_report(),
            "safety_ranges": self.safety_clamp.generate_audit_report(),
        }

    def check_reproducibility(
        self,
        features: Dict[str, Any],
        file_name: str = "test",
        runs: int = 3,
    ) -> Dict[str, Any]:
        """
        Check reproducibility of results.

        Args:
            features: Feature dictionary
            file_name: File name
            runs: Number of runs to compare

        Returns:
            Reproducibility report
        """
        results = []
        for _ in range(runs):
            result = self.evaluate_track(features, file_name)
            results.append(result)

        # Compare results
        all_match = True
        differences = []

        baseline = results[0]
        for i, result in enumerate(results[1:], 2):
            for profile in PROFILE_ORDER:
                base_rec = baseline.recommendations[profile]
                curr_rec = result.recommendations[profile]

                if base_rec.state != curr_rec.state:
                    all_match = False
                    differences.append({
                        "run": i,
                        "profile": profile,
                        "field": "state",
                        "baseline": base_rec.state.value,
                        "current": curr_rec.state.value,
                    })

                if base_rec.confidence != curr_rec.confidence:
                    all_match = False
                    differences.append({
                        "run": i,
                        "profile": profile,
                        "field": "confidence",
                        "baseline": base_rec.confidence,
                        "current": curr_rec.confidence,
                    })

        return {
            "runs": runs,
            "reproducible": all_match,
            "differences": differences,
        }


def create_engine() -> DSPDecisionEngine:
    """Factory function to create engine instance."""
    return DSPDecisionEngine()
