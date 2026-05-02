# ⚠️ LEGACY — DO NOT MODIFY

이 디렉토리 (`/python/`) 는 **legacy 마스터링 엔진** 입니다.
v3.2 부터 **활성 코드는 `aimaster-desktop/services/python-audio/`** 에 있습니다.

## 이 디렉토리의 운명

| 상태 | 설명 |
|---|---|
| 🚫 신규 기능 추가 금지 | 모든 신기능은 `aimaster-desktop/services/python-audio/` 에 |
| 🚫 버그 수정 금지 | 버그는 활성 엔진에서만 수정 |
| 📚 참조 가능 | 알고리즘 / 임계값 참조용으로 읽는 것은 OK |
| 🗄 archive 후보 | 향후 안정화 후 별도 브랜치로 archive 예정 |

## 활성 엔진 ↔ Legacy 대응표

| 기능 | Legacy (이 디렉토리) | 활성 코드 |
|---|---|---|
| 진입점 | `python/main.py` | `aimaster-desktop/services/python-audio/app/main.py` |
| 분석 | `python/pipeline/analyzer.py` | `aimaster-desktop/services/python-audio/app/analyzers/analyzer.py` |
| 마스터링 파이프라인 | `python/pipeline/mastering.py` + `master_chain.py` | `aimaster-desktop/services/python-audio/app/mastering/pipeline.py` |
| EQ | `python/pipeline/eq.py` | `aimaster-desktop/services/python-audio/app/mastering/eq.py` |
| Dynamic EQ | `python/pipeline/dynamic_eq.py` | `aimaster-desktop/services/python-audio/app/mastering/dynamic_eq.py` |
| Waveform PNG | `python/pipeline/waveform.py` | `aimaster-desktop/services/python-audio/app/utils/waveform_image.py` |
| Metrics | `python/analysis/metrics.py` | `aimaster-desktop/services/python-audio/app/analysis/metrics.py` |
| QC 자동 검사 | `python/analysis/quality_check.py` | `aimaster-desktop/services/python-audio/app/qc/quality_check.py` |
| QC 12-item | `python/analysis/qc_checker.py` | `aimaster-desktop/services/python-audio/app/qc/qc_checker.py` |
| ISP safety | `python/analysis/isp_safety.py` | `aimaster-desktop/services/python-audio/app/utils/isp_safety.py` |
| FFmpeg wrapper | `python/utils/ffmpeg_wrapper.py` | `aimaster-desktop/services/python-audio/app/utils/ffmpeg_wrapper.py` |
| Audio I/O | `python/utils/audio_io.py` | `aimaster-desktop/services/python-audio/app/utils/audio_io.py` |

## 활성 엔진 신기능 (v3.2)

활성 엔진은 legacy 대비 다음을 보강:

- **정적 체인 (Static Chain)** — high-LUFS 모드 (loud, kpop_loud) 의 short-term envelope 출렁임 제거
- **ISP safety** — numpy 4× FFT oversampling 으로 alimiter 가 잡지 못하는 ISP 추가 차단
- **모드별 QC 임계** — kpop_loud 의 LRA 0.5 LU 는 정상으로 인지
- **input 비교 QC** — 입력 자체의 다이내믹은 펌핑으로 오인하지 않음
- **adynamicequalizer 자동 가용성 검사** — fallback 경로 보장
- **자동 회귀 QA 하네스** — 26 케이스 자동 회귀 (`tests/qa/`)

## 마이그레이션이 필요한 경우

레거시 사용처가 남아 있다면 활성 엔진으로 호출 변경:

```diff
- python python/main.py
+ python -m app.main      # 또는 PyInstaller 번들 binary
+ # cwd: aimaster-desktop/services/python-audio/
```

JSON-RPC 프로토콜은 동일하므로 호출 측 변경은 cwd / binary path 만 바꾸면 충분.
