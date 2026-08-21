"""
AI Cleanup v2 - Test-only spectral processing module.

This module is NOT connected to the commercial pipeline.
It exists solely for validating the spectral core on isolated segments.

NOT imported by: run_pipeline, master_file, IPC handlers, presets, renderer, Export.
"""

__version__ = "0.1.0"
__all__ = [
    "SpectralContext",
    "SpectralMask",
    "Smoothing",
    "Protection",
    "Reconstruction",
    "Blend",
    "PeakControl",
    "SafetyGate",
    "Processor",
]
