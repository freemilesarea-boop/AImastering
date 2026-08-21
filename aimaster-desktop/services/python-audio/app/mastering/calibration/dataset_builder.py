"""
Closed Loop Calibration P1 - Dataset Builder

Builds and validates the calibration dataset.

Phase: AI-MASTERING-CLOSED-LOOP-CALIBRATION-P1-1
"""

import os
from typing import Dict, List, Optional, Any
from dataclasses import dataclass

from .schema import TrackInfo
from app.utils.ffmpeg_wrapper import ffprobe_info, parse_audio_stream
from app.utils.logger import log


@dataclass
class DatasetSummary:
    """Summary of calibration dataset."""
    ai_tracks: List[TrackInfo]
    valid_count: int
    excluded_count: int
    total_duration_sec: float
    characteristics_distribution: Dict[str, int]
    exclusion_reasons: Dict[str, int]


class DatasetBuilder:
    """
    Builds calibration dataset from AI tracks.

    P1 Constraints:
    - AI tracks only (no commercial DSP processing)
    - Minimum 15 tracks recommended
    - Diverse characteristics preferred
    - Exclude invalid/corrupt files
    """

    def __init__(
        self,
        ai_tracks_dir: str = "/Users/theblank/Desktop/AI 음원",
    ):
        self.ai_tracks_dir = ai_tracks_dir

    def build_dataset(self) -> DatasetSummary:
        """
        Build calibration dataset from AI tracks.

        Returns:
            DatasetSummary with all track info
        """
        tracks: List[TrackInfo] = []
        exclusion_reasons: Dict[str, int] = {}

        # Scan AI tracks directory
        if not os.path.isdir(self.ai_tracks_dir):
            log("ERROR", f"AI tracks directory not found: {self.ai_tracks_dir}")
            return DatasetSummary(
                ai_tracks=[],
                valid_count=0,
                excluded_count=0,
                total_duration_sec=0.0,
                characteristics_distribution={},
                exclusion_reasons={"directory_not_found": 1},
            )

        for filename in sorted(os.listdir(self.ai_tracks_dir)):
            if not filename.lower().endswith(('.wav', '.flac', '.mp3', '.aiff')):
                continue

            file_path = os.path.join(self.ai_tracks_dir, filename)
            track_info = self._analyze_track(file_path)
            tracks.append(track_info)

            if not track_info.valid:
                reason = track_info.exclusion_reason or "unknown"
                exclusion_reasons[reason] = exclusion_reasons.get(reason, 0) + 1

        # Calculate statistics
        valid_tracks = [t for t in tracks if t.valid]
        total_duration = sum(t.duration_sec for t in valid_tracks)

        # Build characteristics distribution
        char_dist: Dict[str, int] = {}
        for track in valid_tracks:
            for char_name, char_value in track.characteristics.items():
                if char_value:
                    char_dist[char_name] = char_dist.get(char_name, 0) + 1

        log("INFO", f"[calibration] Dataset: {len(valid_tracks)} valid tracks, "
                    f"{len(tracks) - len(valid_tracks)} excluded")

        return DatasetSummary(
            ai_tracks=tracks,
            valid_count=len(valid_tracks),
            excluded_count=len(tracks) - len(valid_tracks),
            total_duration_sec=total_duration,
            characteristics_distribution=char_dist,
            exclusion_reasons=exclusion_reasons,
        )

    def _analyze_track(self, file_path: str) -> TrackInfo:
        """Analyze a single track for dataset inclusion."""
        file_name = os.path.basename(file_path)

        try:
            # Probe file
            probe = ffprobe_info(file_path)
            if not probe:
                return TrackInfo(
                    file_name=file_name,
                    file_path=file_path,
                    duration_sec=0.0,
                    sample_rate=0,
                    channels=0,
                    valid=False,
                    exclusion_reason="probe_failed",
                )

            # Extract audio info
            audio = parse_audio_stream(probe)
            duration = float(probe.get("format", {}).get("duration", 0))
            sample_rate = int(audio.get("sample_rate", 0))
            channels = int(audio.get("channels", 0))

            # Validation checks
            valid = True
            exclusion_reason = None

            if duration < 30.0:
                valid = False
                exclusion_reason = "too_short"
            elif duration > 600.0:
                valid = False
                exclusion_reason = "too_long"
            elif sample_rate < 44100:
                valid = False
                exclusion_reason = "low_sample_rate"
            elif channels < 2:
                valid = False
                exclusion_reason = "mono_only"

            # Determine characteristics (basic heuristics from filename)
            characteristics = self._infer_characteristics(file_name)

            return TrackInfo(
                file_name=file_name,
                file_path=file_path,
                duration_sec=duration,
                sample_rate=sample_rate,
                channels=channels,
                valid=valid,
                exclusion_reason=exclusion_reason,
                characteristics=characteristics,
            )

        except Exception as e:
            log("ERROR", f"[calibration] Failed to analyze track: {file_path}: {e}")
            return TrackInfo(
                file_name=file_name,
                file_path=file_path,
                duration_sec=0.0,
                sample_rate=0,
                channels=0,
                valid=False,
                exclusion_reason=f"analysis_error: {str(e)}",
            )

    def _infer_characteristics(self, filename: str) -> Dict[str, bool]:
        """Infer track characteristics from filename (basic heuristics)."""
        name_lower = filename.lower()
        return {
            "likely_vocal": any(w in name_lower for w in ["vocal", "singer", "voice"]),
            "likely_instrumental": any(w in name_lower for w in ["instrumental", "inst", "beat"]),
            "likely_ballad": any(w in name_lower for w in ["ballad", "slow", "soft"]),
            "likely_energetic": any(w in name_lower for w in ["fast", "energy", "dance", "club"]),
        }

    def get_valid_track_paths(self, dataset: DatasetSummary) -> List[str]:
        """Get list of valid track paths."""
        return [t.file_path for t in dataset.ai_tracks if t.valid]

    def generate_dataset_report(self, dataset: DatasetSummary) -> Dict:
        """Generate JSON report for dataset."""
        return {
            "total_tracks": len(dataset.ai_tracks),
            "valid_tracks": dataset.valid_count,
            "excluded_tracks": dataset.excluded_count,
            "total_duration_sec": dataset.total_duration_sec,
            "total_duration_min": dataset.total_duration_sec / 60.0,
            "characteristics_distribution": dataset.characteristics_distribution,
            "exclusion_reasons": dataset.exclusion_reasons,
            "tracks": [
                {
                    "file_name": t.file_name,
                    "duration_sec": t.duration_sec,
                    "sample_rate": t.sample_rate,
                    "channels": t.channels,
                    "valid": t.valid,
                    "exclusion_reason": t.exclusion_reason,
                    "characteristics": t.characteristics,
                }
                for t in dataset.ai_tracks
            ],
        }
