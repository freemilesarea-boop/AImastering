"""
Closed Loop Render Engine P0 - Safety Gate

Validates all renders pass safety requirements before acceptance.

Phase: AI-MASTERING-CLOSED-LOOP-RENDER-P0-1
"""

import os
import math
from typing import Dict, List, Any, Optional
from dataclasses import dataclass

from .constants import (
    SAFETY_TRUE_PEAK_MAX_DBTP,
    SAFETY_CLIPPING_MAX_SAMPLES,
    SAFETY_LOUDNESS_JUMP_MAX_LU,
    SAFETY_CORRELATION_MIN,
    SAFETY_DURATION_DIFF_MAX_MS,
    SAFETY_MONO_COMPATIBILITY_MIN,
)
from .schema import SafetyCheckResult, SafetyGateResult
from app.utils.ffmpeg_wrapper import ffprobe_info, parse_audio_stream


class SafetyGate:
    """
    Validates all safety requirements for rendered audio.

    Checks:
    - Output file exists and decodes
    - Duration matches input
    - Sample rate valid
    - Channel count valid
    - No NaN/Infinity values
    - Not silent
    - True peak ceiling
    - No clipping
    - Loudness within range
    - Stereo correlation safe
    - Mono compatibility
    """

    def validate(
        self,
        output_path: str,
        before_features: Dict[str, Any],
        after_features: Dict[str, Any],
        expected_duration_sec: float,
        expected_channels: int = 2,
    ) -> SafetyGateResult:
        """
        Run all safety checks.

        Args:
            output_path: Path to rendered output file
            before_features: Features before processing
            after_features: Features after processing
            expected_duration_sec: Expected duration in seconds
            expected_channels: Expected channel count

        Returns:
            SafetyGateResult with all check results
        """
        checks: List[SafetyCheckResult] = []
        failure_codes: List[str] = []

        # 1. File existence
        checks.append(self._check_file_exists(output_path))

        # 2. File decode/probe
        probe_result = self._check_file_decode(output_path)
        checks.append(probe_result)

        if not probe_result.passed:
            # Can't continue without valid file
            return SafetyGateResult(
                passed=False,
                checks=checks,
                critical_failures=1,
                warning_count=0,
                failure_codes=["FILE_DECODE_FAILED"],
            )

        # Get file info
        probe = ffprobe_info(output_path)
        audio = parse_audio_stream(probe)
        duration = float(probe.get("format", {}).get("duration") or 0.0)
        channels = int(audio.get("channels", 2))
        sample_rate = int(audio.get("sample_rate", 44100))

        # 3. Duration match
        checks.append(self._check_duration(
            duration, expected_duration_sec,
        ))

        # 4. Sample rate valid
        checks.append(self._check_sample_rate(sample_rate))

        # 5. Channel count
        checks.append(self._check_channels(channels, expected_channels))

        # 6. True peak
        checks.append(self._check_true_peak(after_features))

        # 7. Clipping
        checks.append(self._check_clipping(after_features))

        # 8. Loudness jump
        checks.append(self._check_loudness_jump(before_features, after_features))

        # 9. Stereo correlation
        if expected_channels >= 2:
            checks.append(self._check_correlation(after_features))

        # 10. Mono compatibility
        if expected_channels >= 2:
            checks.append(self._check_mono_compatibility(after_features))

        # 11. Silent check
        checks.append(self._check_not_silent(after_features))

        # 12. NaN/Infinity check
        checks.append(self._check_nan_inf(after_features))

        # Count failures
        critical_failures = sum(
            1 for c in checks
            if not c.passed and c.severity == "critical"
        )
        warning_count = sum(
            1 for c in checks
            if not c.passed and c.severity == "warning"
        )

        for c in checks:
            if not c.passed and c.severity == "critical":
                failure_codes.append(c.check_name.upper())

        passed = critical_failures == 0

        return SafetyGateResult(
            passed=passed,
            checks=checks,
            critical_failures=critical_failures,
            warning_count=warning_count,
            failure_codes=failure_codes,
        )

    def _check_file_exists(self, path: str) -> SafetyCheckResult:
        """Check if output file exists."""
        exists = os.path.exists(path) and os.path.getsize(path) > 0
        return SafetyCheckResult(
            check_name="file_exists",
            passed=exists,
            measured_value=1.0 if exists else 0.0,
            threshold=1.0,
            unit="bool",
            severity="critical",
            message="Output file exists" if exists else "Output file missing or empty",
        )

    def _check_file_decode(self, path: str) -> SafetyCheckResult:
        """Check if file can be decoded."""
        try:
            probe = ffprobe_info(path)
            audio = parse_audio_stream(probe)
            sr = int(audio.get("sample_rate", 0))
            return SafetyCheckResult(
                check_name="file_decode",
                passed=sr > 0,
                measured_value=float(sr),
                threshold=0,
                unit="Hz",
                severity="critical",
                message="File decodes successfully" if sr > 0 else "File decode failed",
            )
        except Exception as e:
            return SafetyCheckResult(
                check_name="file_decode",
                passed=False,
                measured_value=0.0,
                threshold=0,
                unit="",
                severity="critical",
                message=f"Decode error: {str(e)}",
            )

    def _check_duration(
        self,
        actual: float,
        expected: float,
    ) -> SafetyCheckResult:
        """Check duration matches expected."""
        diff_ms = abs(actual - expected) * 1000
        passed = diff_ms <= SAFETY_DURATION_DIFF_MAX_MS
        return SafetyCheckResult(
            check_name="duration_match",
            passed=passed,
            measured_value=diff_ms,
            threshold=SAFETY_DURATION_DIFF_MAX_MS,
            unit="ms",
            severity="critical" if diff_ms > 100 else "warning",
            message=f"Duration diff: {diff_ms:.1f}ms",
        )

    def _check_sample_rate(self, sr: int) -> SafetyCheckResult:
        """Check sample rate is valid."""
        valid_rates = {44100, 48000, 88200, 96000}
        passed = sr in valid_rates
        return SafetyCheckResult(
            check_name="sample_rate",
            passed=passed,
            measured_value=float(sr),
            threshold=44100,
            unit="Hz",
            severity="warning",
            message=f"Sample rate: {sr}Hz",
        )

    def _check_channels(
        self,
        actual: int,
        expected: int,
    ) -> SafetyCheckResult:
        """Check channel count."""
        passed = actual == expected
        return SafetyCheckResult(
            check_name="channel_count",
            passed=passed,
            measured_value=float(actual),
            threshold=float(expected),
            unit="channels",
            severity="critical",
            message=f"Channels: {actual} (expected {expected})",
        )

    def _check_true_peak(
        self,
        features: Dict[str, Any],
    ) -> SafetyCheckResult:
        """Check true peak is below ceiling."""
        tp = features.get("input_tp")
        if tp is None:
            tp = features.get("sample_peak_dbfs", 0.0)

        tp = float(tp) if tp is not None else 0.0
        passed = tp <= SAFETY_TRUE_PEAK_MAX_DBTP
        return SafetyCheckResult(
            check_name="true_peak",
            passed=passed,
            measured_value=tp,
            threshold=SAFETY_TRUE_PEAK_MAX_DBTP,
            unit="dBTP",
            severity="critical",
            message=f"True peak: {tp:.2f} dBTP",
        )

    def _check_clipping(
        self,
        features: Dict[str, Any],
    ) -> SafetyCheckResult:
        """Check no clipping samples."""
        clipping = int(features.get("clipping_sample_count", 0))
        passed = clipping <= SAFETY_CLIPPING_MAX_SAMPLES
        return SafetyCheckResult(
            check_name="clipping",
            passed=passed,
            measured_value=float(clipping),
            threshold=float(SAFETY_CLIPPING_MAX_SAMPLES),
            unit="samples",
            severity="critical" if clipping > 100 else "warning",
            message=f"Clipping samples: {clipping}",
        )

    def _check_loudness_jump(
        self,
        before: Dict[str, Any],
        after: Dict[str, Any],
    ) -> SafetyCheckResult:
        """Check loudness didn't jump unexpectedly."""
        before_lufs = float(before.get("input_i", -14.0) or -14.0)
        after_lufs = float(after.get("input_i", -14.0) or -14.0)
        jump = abs(after_lufs - before_lufs)
        passed = jump <= SAFETY_LOUDNESS_JUMP_MAX_LU
        return SafetyCheckResult(
            check_name="loudness_jump",
            passed=passed,
            measured_value=jump,
            threshold=SAFETY_LOUDNESS_JUMP_MAX_LU,
            unit="LU",
            severity="warning",
            message=f"Loudness change: {after_lufs - before_lufs:+.1f} LU",
        )

    def _check_correlation(
        self,
        features: Dict[str, Any],
    ) -> SafetyCheckResult:
        """Check stereo correlation is safe."""
        corr = float(features.get("stereo_correlation", 1.0) or 1.0)
        passed = corr >= SAFETY_CORRELATION_MIN
        severity = "critical" if corr < -0.5 else "warning" if corr < 0 else "info"
        return SafetyCheckResult(
            check_name="stereo_correlation",
            passed=passed,
            measured_value=corr,
            threshold=SAFETY_CORRELATION_MIN,
            unit="",
            severity=severity,
            message=f"Correlation: {corr:.3f}" + (" NEGATIVE!" if corr < 0 else ""),
        )

    def _check_mono_compatibility(
        self,
        features: Dict[str, Any],
    ) -> SafetyCheckResult:
        """Check mono compatibility."""
        mc = float(features.get("mono_compatibility_score", 1.0) or 1.0)
        passed = mc >= SAFETY_MONO_COMPATIBILITY_MIN
        return SafetyCheckResult(
            check_name="mono_compatibility",
            passed=passed,
            measured_value=mc,
            threshold=SAFETY_MONO_COMPATIBILITY_MIN,
            unit="",
            severity="warning",
            message=f"Mono compatibility: {mc:.3f}",
        )

    def _check_not_silent(
        self,
        features: Dict[str, Any],
    ) -> SafetyCheckResult:
        """Check output is not silent."""
        rms = float(features.get("rms_db", -60.0) or -60.0)
        lufs = float(features.get("input_i", -60.0) or -60.0)
        is_silent = rms < -60 and lufs < -60
        return SafetyCheckResult(
            check_name="not_silent",
            passed=not is_silent,
            measured_value=rms,
            threshold=-60.0,
            unit="dBFS",
            severity="critical",
            message="Output not silent" if not is_silent else "OUTPUT IS SILENT",
        )

    def _check_nan_inf(
        self,
        features: Dict[str, Any],
    ) -> SafetyCheckResult:
        """Check no NaN or Infinity values in features."""
        nan_count = 0
        for key, value in features.items():
            if value is not None:
                try:
                    f = float(value)
                    if math.isnan(f) or math.isinf(f):
                        nan_count += 1
                except (TypeError, ValueError):
                    pass

        passed = nan_count == 0
        return SafetyCheckResult(
            check_name="no_nan_inf",
            passed=passed,
            measured_value=float(nan_count),
            threshold=0.0,
            unit="count",
            severity="critical" if nan_count > 0 else "info",
            message=f"NaN/Inf values: {nan_count}",
        )
