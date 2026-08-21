"""
Closed Loop Render Engine P0 - Parameter Translator

Translates advisory recommendations to actual FFmpeg filter parameters.

Phase: AI-MASTERING-CLOSED-LOOP-RENDER-P0-1
"""

from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass

from .schema import SelectedRecommendation, TranslatedParameter
from app.mastering.decision_engine.safety_clamp import get_safety_clamp


@dataclass
class TranslationResult:
    """Result of parameter translation."""
    translated: List[TranslatedParameter]
    failed: List[Dict]
    filter_chain: str


class ParameterTranslator:
    """
    Translates DSP recommendations to FFmpeg filter parameters.

    Translation registry maps:
    - Recommendation processor/parameter → FFmpeg filter syntax
    - Unit conversions (dB, ratio, percent, etc.)
    - Safety clamping
    """

    def __init__(self):
        self.safety_clamp = get_safety_clamp()

        # FFmpeg filter templates
        self._filter_templates = {
            # EQ filters
            ("EQ", "high_shelf_gain_db"): self._build_eq_high_shelf,
            ("EQ", "low_shelf_gain_db"): self._build_eq_low_shelf,
            ("EQ", "bell_gain_db"): self._build_eq_bell,
            ("EQ", "low_mid_gain_db"): self._build_eq_bell,
            # Stereo
            ("STEREO", "width"): self._build_stereo_width,
            # Input gain
            ("INPUT_GAIN", "gain_db"): self._build_volume,
            # Limiter
            ("LIMITER", "ceiling_dbtp"): self._build_limiter,
            # Compressor
            ("COMPRESSOR", "ratio"): self._build_compressor,
            ("COMPRESSOR", "threshold_db"): self._build_compressor,
        }

    def translate_recommendations(
        self,
        recommendations: List[SelectedRecommendation],
    ) -> TranslationResult:
        """
        Translate recommendations to FFmpeg filters.

        Args:
            recommendations: List of selected recommendations

        Returns:
            TranslationResult with translated parameters and filter chain
        """
        translated: List[TranslatedParameter] = []
        failed: List[Dict] = []
        filter_parts: List[str] = []

        for rec in recommendations:
            key = (rec.processor, rec.parameter)

            if key not in self._filter_templates:
                failed.append({
                    "recommendation_id": rec.recommendation_id,
                    "processor": rec.processor,
                    "parameter": rec.parameter,
                    "reason": "No translation available",
                })
                continue

            try:
                # Apply safety clamp
                clamped_value, was_clamped, original = self.safety_clamp.clamp(
                    rec.processor, rec.parameter, rec.suggested_value
                )

                # Build filter
                builder = self._filter_templates[key]
                ffmpeg_filter, unit = builder(
                    rec, clamped_value,
                )

                if not ffmpeg_filter:
                    failed.append({
                        "recommendation_id": rec.recommendation_id,
                        "reason": "Empty filter generated",
                    })
                    continue

                param = TranslatedParameter(
                    processor=rec.processor,
                    parameter=rec.parameter,
                    value=clamped_value,
                    unit=unit,
                    ffmpeg_filter=ffmpeg_filter,
                    source_recommendation_id=rec.recommendation_id,
                    was_clamped=was_clamped,
                    original_value=original,
                )

                # Add frequency/Q if present
                if hasattr(rec, 'frequency_hz') and rec.frequency_hz:
                    param.frequency_hz = rec.frequency_hz
                if hasattr(rec, 'q') and rec.q:
                    param.q = rec.q

                translated.append(param)
                rec.translated = param
                filter_parts.append(ffmpeg_filter)

            except Exception as e:
                failed.append({
                    "recommendation_id": rec.recommendation_id,
                    "processor": rec.processor,
                    "parameter": rec.parameter,
                    "reason": f"Translation error: {str(e)}",
                })

        filter_chain = ",".join(filter_parts) if filter_parts else ""

        return TranslationResult(
            translated=translated,
            failed=failed,
            filter_chain=filter_chain,
        )

    def _build_eq_high_shelf(
        self,
        rec: SelectedRecommendation,
        value: float,
    ) -> Tuple[str, str]:
        """Build high shelf EQ filter."""
        # Default frequency if not specified
        freq = getattr(rec, 'frequency_hz', None) or 10000
        return f"highshelf=f={freq}:g={value:+.2f}", "dB"

    def _build_eq_low_shelf(
        self,
        rec: SelectedRecommendation,
        value: float,
    ) -> Tuple[str, str]:
        """Build low shelf EQ filter."""
        freq = getattr(rec, 'frequency_hz', None) or 80
        return f"lowshelf=f={freq}:g={value:+.2f}", "dB"

    def _build_eq_bell(
        self,
        rec: SelectedRecommendation,
        value: float,
    ) -> Tuple[str, str]:
        """Build bell/peaking EQ filter."""
        freq = getattr(rec, 'frequency_hz', None) or 1000
        q = getattr(rec, 'q', None) or 1.0
        return f"equalizer=f={freq}:t=q:w={q:.2f}:g={value:+.2f}", "dB"

    def _build_stereo_width(
        self,
        rec: SelectedRecommendation,
        value: float,
    ) -> Tuple[str, str]:
        """Build stereo width filter."""
        # extrastereo m parameter: 1.0 = passthrough, >1 = wider, <1 = narrower
        if abs(value - 1.0) < 0.01:
            return "", "multiplier"  # Skip if essentially 1.0
        return f"extrastereo=m={value:.3f}:c=0", "multiplier"

    def _build_volume(
        self,
        rec: SelectedRecommendation,
        value: float,
    ) -> Tuple[str, str]:
        """Build volume/gain filter."""
        if abs(value) < 0.01:
            return "", "dB"  # Skip if essentially 0
        return f"volume={value:+.2f}dB", "dB"

    def _build_limiter(
        self,
        rec: SelectedRecommendation,
        value: float,
    ) -> Tuple[str, str]:
        """Build limiter filter."""
        # Convert dBTP to linear for alimiter
        limit_linear = 10.0 ** (value / 20.0)
        return (
            f"alimiter=level_in=1:level_out=1:limit={limit_linear:.6f}"
            f":attack=5.0:release=50.0:asc=1"
        ), "dBTP"

    def _build_compressor(
        self,
        rec: SelectedRecommendation,
        value: float,
    ) -> Tuple[str, str]:
        """Build compressor filter."""
        # This is a simplified compressor; full compressor needs multiple parameters
        # For P0, we apply conservative settings
        if rec.parameter == "threshold_db":
            return (
                f"acompressor=threshold={value:.1f}dB"
                f":ratio=1.5:attack=30:release=150:makeup=0.5dB:knee=8dB"
            ), "dB"
        elif rec.parameter == "ratio":
            return (
                f"acompressor=threshold=-18dB"
                f":ratio={value:.1f}:attack=30:release=150:makeup=0.5dB:knee=8dB"
            ), "ratio"
        return "", ""

    def generate_audit_report(self) -> Dict:
        """Generate translation registry audit report."""
        supported = []
        for (processor, parameter), builder in self._filter_templates.items():
            supported.append({
                "processor": processor,
                "parameter": parameter,
                "builder": builder.__name__,
            })

        return {
            "total_mappings": len(self._filter_templates),
            "supported_translations": supported,
        }
