"""
Environment information collector for debug logging.

Used by the debug bundle / verbose logging system to capture host details
that may correlate with the "vocal-mush / radio-quality / over-limiting"
problems reported by a subset of users.  All probes are best-effort and
never raise — missing info simply becomes None.
"""
from __future__ import annotations

import os
import platform
import re
import subprocess
import sys
from typing import Any

from app.utils.logger import log


_CACHE: dict[str, Any] | None = None


def _waveform_support() -> dict[str, Any]:
    """Can this engine read a waveform, and if not, why not.

    Every number the app shows that is not a loudness figure comes from
    numpy + soundfile: the band levels, the stereo width, the crest factor,
    the duration.  When they cannot be imported, `app/utils/audio_io.py`
    falls back and the engine KEEPS ANSWERING — `analyze_reference` returns
    `available: false` with every band at -120 dB and the app reports a
    damaged file.  Measured: a PyInstaller spec that excluded `distutils`
    dropped the cffi graph, and one that pruned setuptools took `secrets`
    with it, which `numpy.random`'s compiled bit_generator imports from
    inside the extension where no static analysis can see it.  Both built
    cleanly, both started, both reached READY, both answered every request.
    Nothing in the app could tell.

    So the engine says it here, and a packaging run can refuse a build that
    can only run ffmpeg (scripts/app-smoke/flow-packaged.mjs).
    """
    from app.utils.audio_io import HAS_SF, WAVEFORM_UNAVAILABLE_REASON

    def _version(module_name: str) -> str | None:
        try:
            import importlib
            return str(getattr(importlib.import_module(module_name), "__version__", "")) or None
        except Exception:
            return None

    return {
        "available":  bool(HAS_SF),
        "numpy":      _version("numpy") if HAS_SF else None,
        "soundfile":  _version("soundfile") if HAS_SF else None,
        "reason":     WAVEFORM_UNAVAILABLE_REASON,
    }


def _safe_run(cmd: list[str], timeout: float = 5.0) -> str:
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=timeout,
        )
        return (proc.stdout or "") + (proc.stderr or "")
    except Exception as exc:
        log("DEBUG", f"env_info: {' '.join(cmd[:2])} failed: {exc}")
        return ""


def _ffmpeg_version() -> dict[str, Any]:
    from app.utils.ffmpeg_wrapper import _FFMPEG_BIN
    text = _safe_run([_FFMPEG_BIN, "-hide_banner", "-version"])
    out: dict[str, Any] = {
        "binary": _FFMPEG_BIN,
        "raw": text.split("\n", 1)[0] if text else "",
        "version": None,
        "configuration": None,
    }
    if not text:
        return out
    m = re.search(r"ffmpeg version (\S+)", text)
    if m:
        out["version"] = m.group(1)
    m = re.search(r"configuration:\s*(.+)", text)
    if m:
        out["configuration"] = m.group(1).strip()
    return out


def _is_bundled_ffmpeg() -> bool:
    """
    Bundled ffmpeg = path provided by Electron via AIMASTER_FFMPEG env var.
    System ffmpeg = falls back to plain 'ffmpeg' on PATH.
    """
    env_path = os.environ.get("AIMASTER_FFMPEG", "")
    if not env_path or env_path == "ffmpeg":
        return False
    return os.path.isabs(env_path) or os.path.sep in env_path


def _cpu_info() -> dict[str, Any]:
    info: dict[str, Any] = {
        "processor": platform.processor() or platform.machine(),
        "machine": platform.machine(),
        "logicalCores": os.cpu_count(),
    }
    sysname = platform.system()
    try:
        if sysname == "Linux":
            with open("/proc/cpuinfo", "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    if line.lower().startswith("model name"):
                        info["model"] = line.split(":", 1)[1].strip()
                        break
        elif sysname == "Darwin":
            text = _safe_run(["sysctl", "-n", "machdep.cpu.brand_string"])
            if text.strip():
                info["model"] = text.strip()
        elif sysname == "Windows":
            info["model"] = platform.processor()
    except Exception as exc:
        log("DEBUG", f"env_info: cpu probe failed: {exc}")
    return info


def _adynamic_eq_engine() -> str:
    try:
        from app.mastering.dynamic_eq import has_adynamic_equalizer
        return "adynamicequalizer" if has_adynamic_equalizer() else "fallback"
    except Exception as exc:
        log("DEBUG", f"env_info: dynamic_eq probe failed: {exc}")
        return "unknown"


def _app_version() -> str | None:
    """
    App version is supplied by Electron via AIMASTER_APP_VERSION; fall back
    to package.json on disk if running under dev.
    """
    v = os.environ.get("AIMASTER_APP_VERSION")
    if v:
        return v
    here = os.path.dirname(os.path.abspath(__file__))
    for up in range(1, 7):
        candidate = os.path.join(here, *([".."] * up), "package.json")
        candidate = os.path.normpath(candidate)
        if os.path.isfile(candidate):
            try:
                import json
                with open(candidate, "r", encoding="utf-8") as f:
                    pkg = json.load(f)
                ver = pkg.get("version")
                if isinstance(ver, str):
                    return ver
            except Exception:
                pass
    return None


def collect_env_info(use_cache: bool = True) -> dict[str, Any]:
    """Return a dict of host / runtime info.  Cached after first call."""
    global _CACHE
    if use_cache and _CACHE is not None:
        return _CACHE

    info: dict[str, Any] = {
        "os": {
            "system":  platform.system(),
            "release": platform.release(),
            "version": platform.version(),
            "platform": platform.platform(),
        },
        "architecture": platform.machine(),
        "python": {
            "version":  platform.python_version(),
            "implementation": platform.python_implementation(),
            "executable": sys.executable,
        },
        "appVersion":      _app_version(),
        "ffmpeg":          _ffmpeg_version(),
        "ffmpegBundled":   _is_bundled_ffmpeg(),
        "ffprobeBinary":   os.environ.get("AIMASTER_FFPROBE", "ffprobe"),
        "cpu":             _cpu_info(),
        "waveform":        _waveform_support(),
        "dynamicEqEngine": _adynamic_eq_engine(),
        "env": {
            "AIMASTER_DEBUG":  os.environ.get("AIMASTER_DEBUG"),
            "AIMASTER_FFMPEG": os.environ.get("AIMASTER_FFMPEG"),
            "AIMASTER_FFPROBE": os.environ.get("AIMASTER_FFPROBE"),
            "AIMASTER_APP_VERSION": os.environ.get("AIMASTER_APP_VERSION"),
        },
    }

    _CACHE = info
    return info


def is_debug_mode() -> bool:
    """Debug mode controls whether full ffmpeg stderr / debug bundles are persisted."""
    val = os.environ.get("AIMASTER_DEBUG", "").strip().lower()
    return val in ("1", "true", "yes", "on")
