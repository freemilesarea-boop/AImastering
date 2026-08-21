"""
Audio Profile Engine P0 - Main Orchestrator

Test-only implementation that coordinates:
- Feature input loading
- Profile evaluation
- Confidence calculation
- Conflict detection
- Eligibility resolution
- Output generation

NO DSP processing, NO production pipeline connection.
"""

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Any

from .constants import PROFILE_ORDER
from .feature_input import FeatureInputLoader, FeatureSet, FeatureDataset
from .threshold_registry import get_registry, ThresholdRegistry
from .profile_evaluator import ProfileEvaluator, ProfileResult
from .confidence import ConfidenceCalculator, ConfidenceResult
from .conflict_engine import ConflictEngine, ConflictReport
from .eligibility import EligibilityResolver, EligibilityResult, GlobalReadiness
from .schema import SchemaValidator, build_output


@dataclass
class EngineResult:
    """Complete engine evaluation result."""
    file_name: str
    profile_results: Dict[str, ProfileResult]
    confidence_results: Dict[str, ConfidenceResult]
    eligibility_results: Dict[str, EligibilityResult]
    conflict_report: ConflictReport
    global_readiness: GlobalReadiness
    output: Dict
    schema_valid: bool
    schema_errors: List[str]


class AudioProfileEngine:
    """
    Main orchestrator for Audio Profile Engine P0.

    Usage:
        engine = AudioProfileEngine()

        # From pre-computed feature JSON
        result = engine.evaluate_track(features_dict, "track.wav")

        # From Canonical Analyzer dataset
        dataset = engine.load_dataset("path/to/05_commercial_features.json", "commercial")
        results = engine.evaluate_dataset(dataset)
    """

    def __init__(self, validate_schema: bool = True):
        """
        Initialize the engine.

        Args:
            validate_schema: Whether to validate output against schema
        """
        self.loader = FeatureInputLoader()
        self.registry = get_registry()
        self.evaluator = ProfileEvaluator(self.registry)
        self.confidence_calc = ConfidenceCalculator()
        self.conflict_engine = ConflictEngine()
        self.eligibility_resolver = EligibilityResolver()
        self.schema_validator = SchemaValidator()
        self.validate_schema = validate_schema

    def evaluate_track(
        self,
        features: Dict,
        file_name: str = "unknown",
        metadata: Optional[Dict] = None
    ) -> EngineResult:
        """
        Evaluate a single track from feature dictionary.

        Args:
            features: Dictionary of feature values
            file_name: Name of the source file
            metadata: Optional metadata

        Returns:
            Complete EngineResult
        """
        # Load features into FeatureSet
        feature_set = self.loader.load_single_track(features, file_name, metadata)

        return self._evaluate_feature_set(feature_set, metadata)

    def evaluate_feature_set(self, feature_set: FeatureSet) -> EngineResult:
        """
        Evaluate a FeatureSet directly.

        Args:
            feature_set: FeatureSet to evaluate

        Returns:
            Complete EngineResult
        """
        return self._evaluate_feature_set(feature_set, feature_set.metadata)

    def _evaluate_feature_set(
        self,
        feature_set: FeatureSet,
        metadata: Optional[Dict] = None
    ) -> EngineResult:
        """Internal evaluation logic."""
        # 1. Evaluate all profiles
        profile_results = self.evaluator.evaluate_all_profiles(feature_set)

        # 2. Evaluate conflicts
        conflict_report = self.conflict_engine.evaluate_all(feature_set)

        # 3. Calculate confidence for each profile
        confidence_results = {}
        for profile_id, profile_result in profile_results.items():
            confidence_results[profile_id] = self.confidence_calc.calculate(profile_result)

        # 4. Resolve eligibility for each profile
        eligibility_results = {}
        for profile_id in PROFILE_ORDER:
            profile_result = profile_results[profile_id]
            confidence_result = confidence_results[profile_id]
            eligibility_results[profile_id] = self.eligibility_resolver.resolve_profile(
                profile_result, confidence_result, conflict_report
            )

        # 5. Determine global readiness
        global_readiness = self.eligibility_resolver.resolve_global_readiness(
            profile_results, eligibility_results, conflict_report
        )

        # 6. Build output
        output = build_output(
            file_name=feature_set.file_name,
            features=feature_set.features,
            profile_results=profile_results,
            confidence_results=confidence_results,
            eligibility_results=eligibility_results,
            conflict_report=conflict_report,
            global_readiness=global_readiness,
            metadata=metadata,
        )

        # 7. Validate schema
        schema_valid = True
        schema_errors = []
        if self.validate_schema:
            schema_valid, schema_errors = self.schema_validator.validate(output)

        return EngineResult(
            file_name=feature_set.file_name,
            profile_results=profile_results,
            confidence_results=confidence_results,
            eligibility_results=eligibility_results,
            conflict_report=conflict_report,
            global_readiness=global_readiness,
            output=output,
            schema_valid=schema_valid,
            schema_errors=schema_errors,
        )

    def load_dataset(self, json_path: str, dataset_name: str) -> FeatureDataset:
        """
        Load a dataset from Canonical Analyzer JSON.

        Args:
            json_path: Path to features JSON file
            dataset_name: Name for the dataset

        Returns:
            FeatureDataset
        """
        return self.loader.load_dataset(json_path, dataset_name)

    def evaluate_dataset(
        self,
        dataset: FeatureDataset,
        track_indices: Optional[List[int]] = None
    ) -> List[EngineResult]:
        """
        Evaluate multiple tracks from a dataset.

        Args:
            dataset: FeatureDataset to evaluate
            track_indices: Optional list of track indices to evaluate.
                          If None, evaluates all tracks.

        Returns:
            List of EngineResult for each track
        """
        results = []

        if track_indices is None:
            tracks = dataset.tracks
        else:
            tracks = [dataset.tracks[i] for i in track_indices if i < len(dataset.tracks)]

        for feature_set in tracks:
            result = self.evaluate_feature_set(feature_set)
            results.append(result)

        return results

    def generate_design_audit(self) -> Dict:
        """
        Generate design input audit report.

        Returns:
            Audit report dictionary
        """
        return {
            "profiles": {
                "total": len(PROFILE_ORDER),
                "list": PROFILE_ORDER,
                "definitions_present": all(
                    profile_id in self.evaluator.PROFILE_FEATURES
                    for profile_id in PROFILE_ORDER
                ),
            },
            "features": {
                "total_mapped": len(self.loader.ALL_EXPECTED_FEATURES),
                "required_by_profile": {
                    profile_id: self.loader.REQUIRED_FEATURES.get(profile_id, [])
                    for profile_id in PROFILE_ORDER
                },
            },
            "conflict_rules": {
                "total": len(self.conflict_engine._rules),
                "by_severity": {
                    "WARN": sum(1 for r in self.conflict_engine._rules
                               if r["severity"].value == "WARN"),
                    "CONDITIONAL": sum(1 for r in self.conflict_engine._rules
                                      if r["severity"].value == "CONDITIONAL"),
                    "BLOCK": sum(1 for r in self.conflict_engine._rules
                                if r["severity"].value == "BLOCK"),
                },
            },
            "eligibility_states": ["ELIGIBLE", "CONDITIONAL", "MONITOR_ONLY", "BLOCKED", "N/A"],
        }

    def generate_threshold_audit(self) -> Dict:
        """
        Generate threshold source audit report.

        Returns:
            Threshold audit report
        """
        return self.registry.generate_audit_report()


def create_engine() -> AudioProfileEngine:
    """Factory function to create engine instance."""
    return AudioProfileEngine()
