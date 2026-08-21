"""
Closed Loop Render Engine P0 - Render Executor

Executes DSP renders using FFmpeg filter chains.

Phase: AI-MASTERING-CLOSED-LOOP-RENDER-P0-1
"""

import os
import tempfile
from typing import Dict, List, Optional, Any
from dataclasses import dataclass

from app.utils.ffmpeg_wrapper import (
    apply_filter_chain,
    ffprobe_info,
    parse_audio_stream,
    FFmpegError,
)
from app.utils.logger import log


@dataclass
class RenderResult:
    """Result of a render operation."""
    success: bool
    output_path: str
    filter_chain: str
    duration_sec: float
    sample_rate: int
    channels: int
    error_message: str = ""


class RenderExecutor:
    """
    Executes DSP renders via FFmpeg.

    P0 Safety:
    - All outputs go to test-only directory
    - Original file is NEVER modified
    - Validates output file after render
    """

    def __init__(
        self,
        output_dir: str,
        sample_rate: int = 44100,
        bit_depth: int = 24,
    ):
        """
        Initialize render executor.

        Args:
            output_dir: Directory for test outputs
            sample_rate: Output sample rate
            bit_depth: Output bit depth (16 or 24)
        """
        self.output_dir = output_dir
        self.sample_rate = sample_rate
        self.bit_depth = bit_depth

        os.makedirs(output_dir, exist_ok=True)

    def render(
        self,
        input_path: str,
        filter_chain: str,
        output_name: str,
    ) -> RenderResult:
        """
        Render audio through filter chain.

        Args:
            input_path: Path to input audio file
            filter_chain: Comma-separated FFmpeg filter chain
            output_name: Name for output file (without extension)

        Returns:
            RenderResult with success status and output path
        """
        if not os.path.exists(input_path):
            return RenderResult(
                success=False,
                output_path="",
                filter_chain=filter_chain,
                duration_sec=0,
                sample_rate=0,
                channels=0,
                error_message=f"Input file not found: {input_path}",
            )

        output_path = os.path.join(self.output_dir, f"{output_name}.wav")

        try:
            # Validate input
            probe = ffprobe_info(input_path)
            audio = parse_audio_stream(probe)
            input_duration = float(
                probe.get("format", {}).get("duration") or
                audio.get("duration") or 0.0
            )
            input_channels = int(audio.get("channels", 2))

            # Apply filter chain
            if filter_chain:
                apply_filter_chain(
                    input_path,
                    output_path,
                    filter_chain,
                    sample_rate=self.sample_rate,
                    bit_depth=self.bit_depth,
                )
            else:
                # No filters - just copy with format conversion
                apply_filter_chain(
                    input_path,
                    output_path,
                    "anull",  # Passthrough filter
                    sample_rate=self.sample_rate,
                    bit_depth=self.bit_depth,
                )

            # Validate output
            if not os.path.exists(output_path):
                return RenderResult(
                    success=False,
                    output_path="",
                    filter_chain=filter_chain,
                    duration_sec=0,
                    sample_rate=0,
                    channels=0,
                    error_message="Output file not created",
                )

            # Check output
            out_probe = ffprobe_info(output_path)
            out_audio = parse_audio_stream(out_probe)
            out_duration = float(
                out_probe.get("format", {}).get("duration") or
                out_audio.get("duration") or 0.0
            )
            out_sr = int(out_audio.get("sample_rate", self.sample_rate))
            out_ch = int(out_audio.get("channels", input_channels))

            # Check duration match (within 50ms tolerance)
            duration_diff_ms = abs(input_duration - out_duration) * 1000
            if duration_diff_ms > 50:
                log("WARN", f"Duration mismatch: {duration_diff_ms:.1f}ms")

            return RenderResult(
                success=True,
                output_path=output_path,
                filter_chain=filter_chain,
                duration_sec=out_duration,
                sample_rate=out_sr,
                channels=out_ch,
            )

        except FFmpegError as e:
            log("ERROR", f"Render failed: {e.user_msg}")
            return RenderResult(
                success=False,
                output_path="",
                filter_chain=filter_chain,
                duration_sec=0,
                sample_rate=0,
                channels=0,
                error_message=e.user_msg,
            )

        except Exception as e:
            log("ERROR", f"Unexpected render error: {e}")
            return RenderResult(
                success=False,
                output_path="",
                filter_chain=filter_chain,
                duration_sec=0,
                sample_rate=0,
                channels=0,
                error_message=str(e),
            )

    def create_level_matched_preview(
        self,
        original_path: str,
        candidate_path: str,
        target_lufs: float = -18.0,
    ) -> Dict[str, str]:
        """
        Create level-matched previews for A/B comparison.

        Both files are normalized to the same loudness to prevent
        the louder-is-better illusion.

        Args:
            original_path: Path to original audio
            candidate_path: Path to candidate audio
            target_lufs: Target loudness for both files

        Returns:
            Dict with paths: {"original": ..., "candidate": ...}
        """
        from app.utils.ffmpeg_wrapper import loudnorm_pass1, loudnorm_pass2

        result = {}

        for name, path in [("original", original_path), ("candidate", candidate_path)]:
            if not os.path.exists(path):
                continue

            try:
                # Measure
                pass1 = loudnorm_pass1(path, target_lufs, target_tp=-1.5)

                # Normalize
                base = os.path.splitext(os.path.basename(path))[0]
                out_path = os.path.join(
                    self.output_dir,
                    f"{base}_level_matched.wav"
                )
                loudnorm_pass2(
                    path, out_path, pass1,
                    target_lufs=target_lufs,
                    target_tp=-1.5,
                    sample_rate=self.sample_rate,
                    bit_depth=self.bit_depth,
                    linear=True,
                )
                result[name] = out_path

            except Exception as e:
                log("WARN", f"Level match failed for {name}: {e}")

        return result
