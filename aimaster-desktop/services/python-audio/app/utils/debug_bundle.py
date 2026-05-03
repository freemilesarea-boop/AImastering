"""
Debug bundle exporter.

Packages the artifacts produced by a mastering job into a single zip the
user can attach to a customer-support ticket.  By default the bundle
contains only metadata + log files — never the original audio or the
mastered output, since those raise privacy / copyright concerns.  The
caller can opt in to including audio with `include_audio=True` after
obtaining explicit consent.

Bundle layout:
    aimaster-debug-<jobId>-<timestamp>.zip
    ├── input.json                  (input file metadata)
    ├── mastering_settings.json     (params + safe-mode overrides)
    ├── filter_chain.txt            (full ffmpeg filter chain text)
    ├── ffmpeg_stderr/              (one log per invocation; debug-mode only)
    ├── metrics_before.json
    ├── metrics_after.json
    ├── quality_check.json
    ├── limiter_check.json
    ├── suspect_segments.json
    ├── waveform_after.png          (if available)
    ├── debug.json                  (everything from DebugRecorder)
    └── README.txt                  (what to send / what's missing)

When `include_audio=True` is set, original + mastered files are added
under audio/.  We refuse to include them when the bundle path is on a
network share (basic mistake-prevention).
"""
from __future__ import annotations

import json
import os
import shutil
import time
import zipfile
from typing import Any


_README_TEMPLATE = """\
AIMASTER 디버그 번들
========================
생성 시각: {ts}
Job ID:     {job_id}
앱 버전:    {app_version}

이 번들은 마스터링 결과의 음질 문제 (보컬 뭉개짐 / 라디오 음질 / 과도한
리미팅) 를 디버깅하기 위해 생성되었습니다.

포함 파일:
  - input.json                : 입력 파일 메타데이터 (개인정보 없음)
  - mastering_settings.json   : 사용한 모드 / 파라미터 / safe-mode 설정
  - filter_chain.txt          : 실제 적용된 ffmpeg 필터 체인
  - ffmpeg_stderr/*.log       : 단계별 ffmpeg stderr (debug 모드에서만)
  - metrics_before.json       : 입력 측정값 (LUFS / TP / RMS / crest)
  - metrics_after.json        : 출력 측정값
  - quality_check.json        : 자동 품질 검사 결과
  - limiter_check.json        : 리미터 과다 적용 검사 결과
  - suspect_segments.json     : 시간대별 의심 구간
  - waveform_after.png        : 출력 파형 이미지 (있으면)
  - debug.json                : 전체 DebugRecorder 출력 (정합성 보장)

기본적으로 원본 / 결과 오디오 파일은 개인정보·저작권 문제로 포함하지
않습니다.  필요하시면 고객지원에 직접 첨부하거나 include_audio=True
옵션으로 다시 생성해주세요.

문제가 재현되었을 때 이 zip 한 개만 첨부하시면 됩니다.
"""


def _copy_if_exists(src: str, dst: str) -> bool:
    try:
        if src and os.path.isfile(src):
            shutil.copyfile(src, dst)
            return True
    except OSError:
        pass
    return False


def _write_json(path: str, obj: Any) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2, default=str)


def export_debug_bundle(
    recorder_dict: dict[str, Any],
    output_zip_path: str,
    *,
    quality_check: dict[str, Any] | None = None,
    limiter_check: dict[str, Any] | None = None,
    waveform_after_path: str = "",
    waveform_before_path: str = "",
    include_audio: bool = False,
    user_consent_audio: bool = False,
) -> dict[str, Any]:
    """
    Build a zip bundle from a recorder dict.  Returns:
      {
        "path": output_zip_path,
        "sizeBytes": ...,
        "includedAudio": bool,
        "files": [list of internal paths],
      }
    """
    job_id = str(recorder_dict.get("jobId", "unknown"))
    ts = time.strftime("%Y%m%dT%H%M%S")
    artifact_dir = recorder_dict.get("artifactDir") or ""
    files_added: list[str] = []

    os.makedirs(os.path.dirname(os.path.abspath(output_zip_path)) or ".", exist_ok=True)

    with zipfile.ZipFile(output_zip_path, "w", zipfile.ZIP_DEFLATED) as zf:

        def _add_str(name: str, text: str) -> None:
            zf.writestr(name, text)
            files_added.append(name)

        def _add_json(name: str, obj: Any) -> None:
            _add_str(name, json.dumps(obj, ensure_ascii=False, indent=2, default=str))

        # ── Manifest ──
        env = recorder_dict.get("environment") or {}
        app_version = env.get("appVersion") or "(unknown)"
        _add_str("README.txt", _README_TEMPLATE.format(
            ts=ts, job_id=job_id, app_version=app_version,
        ))

        # ── Input + settings ──
        _add_json("input.json", recorder_dict.get("input") or {})
        _add_json("environment.json", env)
        _add_json("mastering_settings.json", recorder_dict.get("masteringSettings") or {})

        # ── Filter chain (text + json) ──
        chain = recorder_dict.get("filterChain") or {}
        chain_text = chain.get("full") or chain.get("preFilter") or ""
        _add_str("filter_chain.txt", chain_text)
        _add_json("filter_chain.json", chain)

        # ── Metrics ──
        _add_json("metrics_before.json", recorder_dict.get("metricsBefore") or {})
        _add_json("metrics_after.json",  recorder_dict.get("metricsAfter")  or {})

        # ── QC reports (passed in directly so we don't depend on recorder shape) ──
        if quality_check is not None:
            _add_json("quality_check.json", quality_check)
        if limiter_check is not None:
            _add_json("limiter_check.json", limiter_check)
        _add_json("suspect_segments.json", recorder_dict.get("suspectSegments") or [])
        _add_json("recommendations.json", recorder_dict.get("recommendations") or [])

        # ── Stages / events / ffmpeg invocations + persisted stderr files ──
        _add_json("debug.json", recorder_dict)
        if artifact_dir and os.path.isdir(artifact_dir):
            for fname in sorted(os.listdir(artifact_dir)):
                if fname.endswith(".stderr.log"):
                    src = os.path.join(artifact_dir, fname)
                    arc = f"ffmpeg_stderr/{fname}"
                    try:
                        zf.write(src, arc)
                        files_added.append(arc)
                    except OSError:
                        pass

        # ── Waveform PNGs ──
        if waveform_after_path and os.path.isfile(waveform_after_path):
            zf.write(waveform_after_path, "waveform_after.png")
            files_added.append("waveform_after.png")
        if waveform_before_path and os.path.isfile(waveform_before_path):
            zf.write(waveform_before_path, "waveform_before.png")
            files_added.append("waveform_before.png")

        # ── Audio (opt-in only, with explicit consent flag) ──
        included_audio = False
        if include_audio and user_consent_audio:
            input_info = recorder_dict.get("input") or {}
            in_path = input_info.get("path")
            out_path = recorder_dict.get("outputPath")
            for path, arc in (
                (in_path,  "audio/input"),
                (out_path, "audio/output"),
            ):
                if path and os.path.isfile(path):
                    ext = os.path.splitext(path)[1] or ".bin"
                    arcname = arc + ext
                    try:
                        zf.write(path, arcname)
                        files_added.append(arcname)
                        included_audio = True
                    except OSError:
                        pass

    return {
        "path":          output_zip_path,
        "sizeBytes":     os.path.getsize(output_zip_path),
        "includedAudio": included_audio,
        "files":         files_added,
    }
