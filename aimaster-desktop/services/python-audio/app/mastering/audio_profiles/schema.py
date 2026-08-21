"""
Output Schema Validator for Audio Profile Engine P0.

Validates output against 06_output_schema.json format.
"""

from typing import Dict, Any, List, Optional, Tuple
from datetime import datetime


class SchemaValidator:
    """
    Validates profile engine output against expected schema.

    Schema requirements:
    - metadata: version, timestamp, input_file, sample_rate, channels
    - features: dict of feature values
    - profiles: array of profile results
    - dsp_plan: processing_order, blocked_profiles, active_conflicts, overall_confidence
    """

    REQUIRED_METADATA_FIELDS = ["version", "timestamp", "input_file"]
    OPTIONAL_METADATA_FIELDS = ["sample_rate", "channels"]

    REQUIRED_PROFILE_FIELDS = ["id", "eligibility", "confidence"]
    ELIGIBILITY_VALUES = ["ELIGIBLE", "CONDITIONAL", "MONITOR_ONLY", "BLOCKED", "N/A"]

    REQUIRED_DSP_PLAN_FIELDS = ["processing_order", "blocked_profiles", "active_conflicts", "overall_confidence"]

    def validate(self, output: Dict) -> Tuple[bool, List[str]]:
        """
        Validate output against schema.

        Args:
            output: Dictionary to validate

        Returns:
            (is_valid, list of error messages)
        """
        errors = []

        # Check top-level structure
        if not isinstance(output, dict):
            return False, ["Output must be a dictionary"]

        required_top_level = ["metadata", "features", "profiles", "dsp_plan"]
        for field in required_top_level:
            if field not in output:
                errors.append(f"Missing required top-level field: {field}")

        if errors:
            return False, errors

        # Validate metadata
        metadata_errors = self._validate_metadata(output.get("metadata", {}))
        errors.extend(metadata_errors)

        # Validate features
        features_errors = self._validate_features(output.get("features", {}))
        errors.extend(features_errors)

        # Validate profiles
        profiles_errors = self._validate_profiles(output.get("profiles", []))
        errors.extend(profiles_errors)

        # Validate dsp_plan
        dsp_plan_errors = self._validate_dsp_plan(output.get("dsp_plan", {}))
        errors.extend(dsp_plan_errors)

        return len(errors) == 0, errors

    def _validate_metadata(self, metadata: Dict) -> List[str]:
        """Validate metadata section."""
        errors = []

        if not isinstance(metadata, dict):
            return ["metadata must be a dictionary"]

        for field in self.REQUIRED_METADATA_FIELDS:
            if field not in metadata:
                errors.append(f"metadata missing required field: {field}")

        # Validate version format
        if "version" in metadata:
            version = metadata["version"]
            if not isinstance(version, str):
                errors.append("metadata.version must be a string")

        # Validate timestamp format
        if "timestamp" in metadata:
            timestamp = metadata["timestamp"]
            if not isinstance(timestamp, str):
                errors.append("metadata.timestamp must be a string")

        return errors

    def _validate_features(self, features: Dict) -> List[str]:
        """Validate features section."""
        errors = []

        if not isinstance(features, dict):
            return ["features must be a dictionary"]

        for key, value in features.items():
            if value is not None and not isinstance(value, (int, float)):
                # Allow nested dicts for band_ratios, spectral_contrast
                if not isinstance(value, dict):
                    errors.append(f"features.{key} must be a number or dict, got {type(value).__name__}")

        return errors

    def _validate_profiles(self, profiles: List) -> List[str]:
        """Validate profiles array."""
        errors = []

        if not isinstance(profiles, list):
            return ["profiles must be an array"]

        for i, profile in enumerate(profiles):
            if not isinstance(profile, dict):
                errors.append(f"profiles[{i}] must be a dictionary")
                continue

            # Check required fields
            for field in self.REQUIRED_PROFILE_FIELDS:
                if field not in profile:
                    errors.append(f"profiles[{i}] missing required field: {field}")

            # Validate eligibility value
            if "eligibility" in profile:
                eligibility = profile["eligibility"]
                if eligibility not in self.ELIGIBILITY_VALUES:
                    errors.append(f"profiles[{i}].eligibility invalid value: {eligibility}")

            # Validate confidence range
            if "confidence" in profile:
                confidence = profile["confidence"]
                if not isinstance(confidence, (int, float)):
                    errors.append(f"profiles[{i}].confidence must be a number")
                elif not (0.0 <= confidence <= 1.0):
                    errors.append(f"profiles[{i}].confidence must be between 0.0 and 1.0")

            # Validate optional fields
            if "primary_values" in profile:
                if not isinstance(profile["primary_values"], dict):
                    errors.append(f"profiles[{i}].primary_values must be a dictionary")

            if "deviation_from_commercial" in profile:
                if not isinstance(profile["deviation_from_commercial"], dict):
                    errors.append(f"profiles[{i}].deviation_from_commercial must be a dictionary")

            if "conflicts" in profile:
                if not isinstance(profile["conflicts"], list):
                    errors.append(f"profiles[{i}].conflicts must be an array")

        return errors

    def _validate_dsp_plan(self, dsp_plan: Dict) -> List[str]:
        """Validate dsp_plan section."""
        errors = []

        if not isinstance(dsp_plan, dict):
            return ["dsp_plan must be a dictionary"]

        for field in self.REQUIRED_DSP_PLAN_FIELDS:
            if field not in dsp_plan:
                errors.append(f"dsp_plan missing required field: {field}")

        # Validate processing_order
        if "processing_order" in dsp_plan:
            if not isinstance(dsp_plan["processing_order"], list):
                errors.append("dsp_plan.processing_order must be an array")

        # Validate blocked_profiles
        if "blocked_profiles" in dsp_plan:
            if not isinstance(dsp_plan["blocked_profiles"], list):
                errors.append("dsp_plan.blocked_profiles must be an array")

        # Validate active_conflicts
        if "active_conflicts" in dsp_plan:
            if not isinstance(dsp_plan["active_conflicts"], list):
                errors.append("dsp_plan.active_conflicts must be an array")

        # Validate overall_confidence
        if "overall_confidence" in dsp_plan:
            confidence = dsp_plan["overall_confidence"]
            if not isinstance(confidence, (int, float)):
                errors.append("dsp_plan.overall_confidence must be a number")
            elif not (0.0 <= confidence <= 1.0):
                errors.append("dsp_plan.overall_confidence must be between 0.0 and 1.0")

        return errors


def build_output(
    file_name: str,
    features: Dict,
    profile_results: Dict,
    confidence_results: Dict,
    eligibility_results: Dict,
    conflict_report: "ConflictReport",
    global_readiness: "GlobalReadiness",
    metadata: Optional[Dict] = None
) -> Dict:
    """
    Build schema-compliant output dictionary.

    Args:
        file_name: Input file name
        features: Raw feature dictionary
        profile_results: Dict of ProfileResult
        confidence_results: Dict of ConfidenceResult
        eligibility_results: Dict of EligibilityResult
        conflict_report: ConflictReport
        global_readiness: GlobalReadiness
        metadata: Optional additional metadata

    Returns:
        Schema-compliant output dictionary
    """
    from .constants import PROFILE_ORDER

    output = {
        "metadata": {
            "version": "0.1.0-poc",
            "timestamp": datetime.now().isoformat(),
            "input_file": file_name,
            **(metadata or {}),
        },
        "features": _flatten_features(features),
        "profiles": [],
        "dsp_plan": {
            "processing_order": [],
            "blocked_profiles": [],
            "active_conflicts": [],
            "overall_confidence": 0.0,
        },
        "global_readiness": {
            "readiness": global_readiness.readiness,
            "loudness_readiness": global_readiness.loudness_readiness,
            "peak_safety": global_readiness.peak_safety,
            "tonal_balance_readiness": global_readiness.tonal_balance_readiness,
            "dynamic_processing_risk": global_readiness.dynamic_processing_risk,
            "texture_stability": global_readiness.texture_stability,
            "stereo_safety": global_readiness.stereo_safety,
            "critical_issues": global_readiness.critical_issues,
            "warnings": global_readiness.warnings,
        },
    }

    # Build profiles array
    confidence_values = []
    for profile_id in PROFILE_ORDER:
        profile_result = profile_results.get(profile_id)
        confidence_result = confidence_results.get(profile_id)
        eligibility_result = eligibility_results.get(profile_id)

        if not profile_result or not confidence_result or not eligibility_result:
            continue

        profile_entry = {
            "id": profile_id,
            "display_name": profile_result.profile_id,
            "eligibility": eligibility_result.eligibility.value,
            "confidence": confidence_result.confidence,
            "confidence_grade": confidence_result.grade.value,
            "state": profile_result.state.value,
            "severity": profile_result.severity.value if profile_result.severity else None,
            "primary_values": profile_result.primary_values,
            "supporting_values": profile_result.supporting_values,
            "protection_values": profile_result.protection_values,
            "deviation_from_commercial": profile_result.deviation_from_commercial,
            "evidence": profile_result.evidence,
            "missing_features": profile_result.missing_features,
            "threshold_source": profile_result.threshold_source,
            "warnings": profile_result.warnings,
            "allowed_actions": eligibility_result.allowed_actions,
            "blocked_actions": eligibility_result.blocked_actions,
            "conflicts": [],
            "confidence_components": {
                "reproducibility": confidence_result.components.reproducibility,
                "gain_invariance": confidence_result.components.gain_invariance,
                "sample_rate_robustness": confidence_result.components.sample_rate_robustness,
                "metric_validation": confidence_result.components.metric_validation,
                "feature_agreement": confidence_result.components.feature_agreement,
                "data_completeness": confidence_result.components.data_completeness,
            },
        }

        # Add conflicts for this profile
        for conflict in conflict_report.results:
            if conflict.triggered and profile_id in conflict.involved_profiles:
                profile_entry["conflicts"].append({
                    "rule_id": conflict.rule_id,
                    "severity": conflict.severity.value,
                    "message": conflict.message,
                })

        output["profiles"].append(profile_entry)
        confidence_values.append(confidence_result.confidence)

        # Update DSP plan
        if eligibility_result.eligibility.value in ["ELIGIBLE", "CONDITIONAL"]:
            output["dsp_plan"]["processing_order"].append(profile_id)
        if eligibility_result.eligibility.value == "BLOCKED":
            output["dsp_plan"]["blocked_profiles"].append(profile_id)

    # Add active conflicts to DSP plan
    for conflict in conflict_report.results:
        if conflict.triggered:
            output["dsp_plan"]["active_conflicts"].append(conflict.rule_id)

    # Calculate overall confidence
    if confidence_values:
        output["dsp_plan"]["overall_confidence"] = round(
            sum(confidence_values) / len(confidence_values), 3
        )

    return output


def _flatten_features(features: Dict) -> Dict:
    """Flatten nested features for output, excluding non-numeric fields."""
    result = {}
    # Fields to exclude from output
    exclude_fields = {"file", "file_name", "dataset", "source"}

    for key, value in features.items():
        if key in exclude_fields:
            continue
        if isinstance(value, dict):
            # Flatten nested dicts (band_ratios, spectral_contrast)
            for sub_key, sub_value in value.items():
                flat_key = f"{key}_{sub_key}" if not key.endswith("_") else f"{key}{sub_key}"
                if isinstance(sub_value, (int, float)) or sub_value is None:
                    result[flat_key] = sub_value
        elif isinstance(value, (int, float)) or value is None:
            result[key] = value

    return result
