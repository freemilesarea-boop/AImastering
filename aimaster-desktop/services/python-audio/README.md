# aimaster — Python 오디오 엔진 (활성)

> **이것이 v3.2 의 활성 마스터링 엔진입니다.**
> 루트 `/python/` 디렉토리는 legacy 이며 신규 변경 금지 — 자세한 내용은 `/python/LEGACY.md`.

Node ↔ Python JSON-RPC over stdin/stdout 으로 통신하는 마스터링 / 분석 엔진.

## 모듈 구조

```
app/
├── main.py                  # JSON-RPC dispatcher (analyze / master / qc_check)
├── analyzers/
│   └── analyzer.py          # 입력 분석 (LUFS, TP, LRA, AI 휴리스틱)
├── mastering/
│   ├── pipeline.py          # 6 stage 파이프라인 (정적 체인 분기 포함)
│   ├── eq.py                # 적응형 EQ + 모드 오버레이
│   ├── dynamic_eq.py        # adynamicequalizer 우선, 정적 fallback (v3.2 P3)
│   ├── dynamics.py          # bus 컴프레서
│   ├── effects.py           # 새튜레이션, stereo width, soft clipper, deesser
│   └── mastering.py         # JSON-RPC adapter
├── analysis/
│   └── metrics.py           # numpy 기반 metrics + before/after 비교 (v3.2 P2)
├── qc/
│   ├── qc_checker.py        # 12-item 파일 정합성 검사
│   └── quality_check.py     # 5 항목 마스터링 결과 자동 검사 (v3.2 P2)
└── utils/
    ├── ffmpeg_wrapper.py    # ffmpeg / ffprobe 호출 + Korean error UX
    ├── audio_io.py          # soundfile/numpy waveform stats + spectral balance
    ├── waveform_image.py    # showwavespic 기반 PNG 생성 (v3.2 P2)
    ├── isp_safety.py        # numpy 4× FFT oversampling ISP 가드 (v3.2 P0)
    └── logger.py            # stderr 구조화 로그
```

## v3.2 주요 변경

| ID | 내용 | 파일 |
|---|---|---|
| P0 | ISP safety 후처리 (alimiter 미커버 ISP 차단) | `app/utils/isp_safety.py`, `pipeline.py` |
| P1 | 정적 체인 (loud / kpop_loud / target_lufs > -12) | `app/mastering/pipeline.py` |
| P2 | Waveform PNG (before / after / compare) | `app/utils/waveform_image.py` |
| P2 | Metric comparison (8 row, 모드별 status) | `app/analysis/metrics.py` |
| P2 | 자동 품질 검사 (5 항목, 모드별 임계, 입력 비교) | `app/qc/quality_check.py` |
| P3 | Dynamic EQ (adynamicequalizer 우선) | `app/mastering/dynamic_eq.py` |
| P4 | shared-types 옵셔널 필드 4종 (UI 호환 안전) | `packages/shared-types/src/index.ts` |
| QA | 26 케이스 자동 회귀 하네스 | `tests/qa/run_qa.py`, `tests/qa/fixtures.py` |

## JSON-RPC 메서드

| Method | Purpose | Required params |
|---|---|---|
| `analyze`  | 입력 분석                         | `file_path` |
| `master`   | 마스터링 + waveform + qc + 비교   | `input_path`, `output_path` |
| `qc_check` | 12-item 파일 정합성 검사          | `file_path` |

### `master` params (v3.2 신규 키)

| Key | Default | 설명 |
|---|---|---|
| `dynamic_eq_intensity` | 1.0 | 0~2 — Dynamic EQ 강도 스케일 |
| `generate_waveforms`   | true | waveform PNG 생성 여부 |

## 결과 dict 의 신규 필드 (v3.2)

```jsonc
{
  "outputPath":  "/tmp/master.wav",
  "previewPath": "/tmp/master_preview.mp3",

  // v3.2 P2 — UI 가 직접 렌더링
  "beforeWaveformPath":  "/tmp/master_before.png",
  "afterWaveformPath":   "/tmp/master_after.png",
  "compareWaveformPath": "/tmp/master_compare.png",

  // v3.2 P2 — 8 row before/after 비교
  "metricComparison": [
    {"key": "lufs_integrated", "before": -23.4, "after": -10.2,
     "delta": 13.2, "status": "ok", "hint": "..."},
    ...
  ],

  // v3.2 P2 — 5 항목 자동 검사
  "qualityCheck": {
    "overall": "ok" | "warn" | "danger",
    "summary": "...",
    "items":   [{"name": "True Peak", "status": "ok", ...}]
  },

  // v3.2 P3 — 적용 Dynamic EQ
  "dynamicEq": {
    "preset": "kpop_loud",
    "engine": "adynamicequalizer" | "fallback" | "none",
    "bands":  [{"freq": 100, "reduction": 2.5, ...}]
  }
}
```

## QA 회귀 실행

```bash
cd aimaster-desktop/services/python-audio
python3 tests/qa/run_qa.py
# 산출물: /tmp/aim_active_qa_out/qa_report.json
```

마지막 회귀 (2026-05-01):
- **TP 실패 0/26** ✓
- **정적 체인 자동 트리거 14/26** ✓
- **Waveform PNG 24/26** ✓ (silence 2건 마스터링 자체 거부)
- **Dynamic EQ adynamicequalizer 24/26** ✓
- **QC ok 14 / warn 5 / danger 5** ✓ (wide_dynamic 입력 + 강한 모드만 danger)

## 주의 사항

- **legacy `/python/` 수정 금지**.  버그 수정 / 신기능 모두 이 디렉토리에서.
- shared-types 의 v3.2 옵셔널 필드는 **모두 옵셔널** — UI 가 사용하지 않아도 깨지지 않음.
- `adynamicequalizer` 미가용 빌드는 자동으로 정적 EQ fallback (60% 강도).
- ISP safety 의 `numpy` 미설치 환경은 자동 스킵 — 마스터링 자체는 진행.
