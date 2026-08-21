"""
Feature Input Handler for Audio Profile Engine P0.

Loads pre-computed features from Canonical Analyzer JSON output.
NO raw audio analysis - features must already exist.
"""

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Any, Set


@dataclass
class FeatureSet:
    """Container for a single track's features."""
    file_name: str
    features: Dict[str, Any]
    metadata: Dict[str, Any] = field(default_factory=dict)
    missing_features: List[str] = field(default_factory=list)
    available_features: Set[str] = field(default_factory=set)

    def get(self, feature_name: str, default: Any = None) -> Any:
        """Get feature value, handling nested structures."""
        # Direct lookup
        if feature_name in self.features:
            return self.features[feature_name]

        # Handle band_ratio_* nested in band_ratios dict
        if feature_name.startswith("band_ratio_"):
            band_key = feature_name.replace("band_ratio_", "")
            if "band_ratios" in self.features:
                return self.features["band_ratios"].get(band_key, default)

        # Handle spectral_contrast_band_* nested in spectral_contrast dict
        if feature_name.startswith("spectral_contrast_band_"):
            band_idx = feature_name.replace("spectral_contrast_band_", "")
            if "spectral_contrast" in self.features:
                # Map index to band name
                band_map = {
                    "0": "0-250Hz",
                    "1": "250-500Hz",
                    "2": "500-1000Hz",
                    "3": "1000-2000Hz",
                    "4": "2000-4000Hz",
                    "5": "4000-8000Hz",
                    "6": "8000-16000Hz",
                }
                band_name = band_map.get(band_idx, band_idx)
                return self.features["spectral_contrast"].get(band_name, default)

        # Handle spectral_contrast_mean
        if feature_name == "spectral_contrast_mean":
            if "spectral_contrast" in self.features:
                contrast = self.features["spectral_contrast"]
                if isinstance(contrast, dict):
                    values = [v for v in contrast.values() if isinstance(v, (int, float))]
                    if values:
                        return sum(values) / len(values)

        return default

    def has_feature(self, feature_name: str) -> bool:
        """Check if feature is available."""
        return self.get(feature_name) is not None


@dataclass
class FeatureDataset:
    """Container for multiple tracks' features."""
    name: str  # "commercial" or "ai"
    tracks: List[FeatureSet]
    source_file: str

    def get_track_by_index(self, index: int) -> Optional[FeatureSet]:
        """Get track by index."""
        if 0 <= index < len(self.tracks):
            return self.tracks[index]
        return None

    def get_track_by_name(self, file_name: str) -> Optional[FeatureSet]:
        """Get track by file name."""
        for track in self.tracks:
            if track.file_name == file_name:
                return track
        return None

    def __len__(self) -> int:
        return len(self.tracks)


class FeatureInputLoader:
    """
    Loads feature data from Canonical Analyzer JSON output.

    Expected JSON structure:
    {
        "metadata": [
            {"file": "track.wav", ...},
            ...
        ],
        "features": [
            {"crest_factor_db": 10.5, "spectral_centroid": 3000, ...},
            ...
        ]
    }
    """

    # Required features for each profile (primary features)
    REQUIRED_FEATURES: Dict[str, List[str]] = {
        "LOUDNESS": ["input_i", "rms_db"],
        "PEAK_SAFETY": ["input_tp", "peak_db"],
        "DYNAMIC_RANGE": ["crest_factor_db", "input_lra"],
        "BRIGHTNESS": ["spectral_centroid"],
        "PRESENCE": ["band_ratio_2-4kHz", "spectral_contrast_band_4"],
        "WARMTH": ["band_ratio_250-500Hz", "band_ratio_500-1000Hz"],
        "LOW_END": ["band_ratio_20-60Hz", "band_ratio_60-120Hz"],
        "MID_CLARITY": ["band_ratio_1-2kHz", "band_ratio_6-8kHz"],
        "STEREO_IMAGE": ["stereo_width", "stereo_correlation"],
        "TRANSIENT": ["spectral_flux_normalized_mean", "onset_density"],
        "TEXTURE": ["spectral_contrast_mean", "spectral_flatness"],
    }

    # All features used by any profile
    ALL_EXPECTED_FEATURES: Set[str] = {
        # Loudness/Dynamics
        "input_i", "input_tp", "input_lra", "rms_db", "peak_db",
        "crest_factor_db", "rms_std", "crest_factor_variance",
        "compression_density", "envelope_smoothness",
        # Spectral
        "spectral_centroid", "spectral_flatness", "spectral_rolloff",
        "hf_ratio", "hf_ratio_variance",
        # Band ratios
        "band_ratio_20-60Hz", "band_ratio_60-120Hz", "band_ratio_120-250Hz",
        "band_ratio_250-500Hz", "band_ratio_500-1000Hz", "band_ratio_1-2kHz",
        "band_ratio_2-4kHz", "band_ratio_4-6kHz", "band_ratio_6-8kHz",
        "band_ratio_8-10kHz", "band_ratio_10-12kHz", "band_ratio_12-16kHz",
        # Spectral contrast bands
        "spectral_contrast_band_0", "spectral_contrast_band_1",
        "spectral_contrast_band_2", "spectral_contrast_band_3",
        "spectral_contrast_band_4", "spectral_contrast_band_5",
        "spectral_contrast_mean",
        # Stereo
        "stereo_width", "stereo_correlation", "ms_ratio_db", "lr_balance_db",
        # Envelope/Transient
        "envelope_std_normalized", "envelope_range_normalized",
        "spectral_flux_normalized_mean", "spectral_flux_normalized_std",
        "onset_density",
        # Texture
        "spectral_flatness_temporal_std", "broadband_flatness",
    }

    def __init__(self):
        pass

    def load_dataset(self, json_path: str, dataset_name: str) -> FeatureDataset:
        """
        Load a full dataset from Canonical Analyzer JSON.

        Args:
            json_path: Path to features JSON file
            dataset_name: Name for the dataset (e.g., "commercial", "ai")

        Returns:
            FeatureDataset containing all tracks
        """
        path = Path(json_path)
        if not path.exists():
            raise FileNotFoundError(f"Feature file not found: {json_path}")

        with open(path) as f:
            data = json.load(f)

        metadata_list = data.get("metadata", [])
        features_list = data.get("features", [])

        if len(metadata_list) != len(features_list):
            raise ValueError(
                f"Metadata ({len(metadata_list)}) and features ({len(features_list)}) "
                "count mismatch"
            )

        tracks = []
        for i, (meta, feat) in enumerate(zip(metadata_list, features_list)):
            file_name = meta.get("file", feat.get("file", f"track_{i}"))
            feature_set = self._create_feature_set(file_name, feat, meta)
            tracks.append(feature_set)

        return FeatureDataset(
            name=dataset_name,
            tracks=tracks,
            source_file=str(path)
        )

    def load_single_track(self, features_json: Dict, file_name: str = "unknown",
                          metadata: Optional[Dict] = None) -> FeatureSet:
        """
        Load a single track's features from a dictionary.

        Args:
            features_json: Dictionary of feature values
            file_name: Name of the source file
            metadata: Optional metadata dictionary

        Returns:
            FeatureSet for the track
        """
        return self._create_feature_set(file_name, features_json, metadata or {})

    def _create_feature_set(self, file_name: str, features: Dict,
                            metadata: Dict) -> FeatureSet:
        """Create a FeatureSet with missing feature detection."""
        feature_set = FeatureSet(
            file_name=file_name,
            features=features,
            metadata=metadata,
        )

        # Check for missing features
        for feature in self.ALL_EXPECTED_FEATURES:
            if feature_set.has_feature(feature):
                feature_set.available_features.add(feature)
            else:
                feature_set.missing_features.append(feature)

        return feature_set

    def get_missing_primary_features(self, feature_set: FeatureSet,
                                     profile: str) -> List[str]:
        """Get list of missing primary features for a profile."""
        required = self.REQUIRED_FEATURES.get(profile, [])
        return [f for f in required if not feature_set.has_feature(f)]

    def validate_for_profile(self, feature_set: FeatureSet,
                             profile: str) -> Dict[str, Any]:
        """
        Validate feature set has required features for a profile.

        Returns:
            {
                "valid": bool,
                "missing_primary": [...],
                "available_primary": [...],
                "coverage": float (0-1)
            }
        """
        required = self.REQUIRED_FEATURES.get(profile, [])
        missing = [f for f in required if not feature_set.has_feature(f)]
        available = [f for f in required if feature_set.has_feature(f)]

        coverage = len(available) / len(required) if required else 0.0

        return {
            "valid": len(missing) == 0,
            "missing_primary": missing,
            "available_primary": available,
            "coverage": coverage,
        }
