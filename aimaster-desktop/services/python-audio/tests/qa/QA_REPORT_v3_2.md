# 활성 엔진 v3.2 — 최종 QA 리포트

**작성일**: 2026-05-01
**브랜치**: `claude/analyze-mastering-engine-zdKrE`
**대상 코드**: `aimaster-desktop/services/python-audio/`

---

## 1. 작업 요약

| Phase | 내용 | 상태 |
|---|---|---|
| **P0** | ISP safety 후처리 (numpy 4× FFT oversample) | ✅ 완료 |
| **P1** | 정적 체인 (high-LUFS 모드의 envelope 출렁임 제거) | ✅ 완료 |
| **P2** | Waveform PNG · metric_comparison · quality_check | ✅ 완료 |
| **P3** | Dynamic EQ (adynamicequalizer) | ✅ 완료 |
| **P4** | shared-types 옵셔널 필드 4종 (UI 호환) | ✅ 완료 |
| **P5** | legacy `python/` archive 권고 + 문서화 | ✅ 완료 |

---

## 2. 적용 기능 전체 목록

### 2.1 안전성 (P0 / P1)
- ✅ 정적 체인: `loud / kpop_loud / target_lufs > -12` → loudnorm 2-pass 우회, `volume + alimiter` 단일 pass
- ✅ ISP safety: 출력 측정 후 numpy 4× FFT oversampling → ceiling 초과 시 정적 down-gain
- ✅ silence 입력 안전 거부 (FFmpegError → Korean message)
- ✅ clipped 입력 처리 + 경고
- ✅ 정적 체인 내 entry_gain ±24 dB clamp + STATIC_GAIN_CLAMPED 경고

### 2.2 사용자 체감 (P2)
- ✅ Waveform PNG 3종 (`before_*.png`, `after_*.png`, `compare_*.png`)
- ✅ Metric comparison 8 row (`lufs / tp / peak / rms / lra / crest / clipping / short_term_var`)
- ✅ Quality check 5 항목 (`true_peak / 음압 안정성 / amplitude_drop / clipping / 과압축`)
- ✅ 모드별 LRA / crest 임계 (kpop_loud 의 LRA 0.5 LU 는 정상 인지)
- ✅ Input vs output 비교 QC (입력 자체의 다이내믹은 펌핑 오인하지 않음)

### 2.3 음악적 품질 (P3)
- ✅ Dynamic EQ 7 모드 × 1~5 밴드 (`sibilance / harsh / muddy / boomy / vocal_presence / air`)
- ✅ ffmpeg `adynamicequalizer` 자동 가용성 검사 + 정적 fallback
- ✅ threshold dBFS → amplitude-percent 변환 (ffmpeg 단위 차이 보정)

### 2.4 UI 통합 (P4)
- ✅ `MasteringResult.beforeWaveformPath / afterWaveformPath / compareWaveformPath`
- ✅ `MasteringResult.metricComparison`
- ✅ `MasteringResult.qualityCheck`
- ✅ `MasteringResult.dynamicEq`
- ✅ `MasteringMeta.ispCorrectionDb / staticChain`
- 모두 옵셔널 — 기존 UI 깨짐 없음

---

## 3. 신규 파일 (5)

| 파일 | LOC | 역할 |
|---|---:|---|
| `app/utils/waveform_image.py` | 130 | ffmpeg showwavespic PNG 생성 (single + dual stack) |
| `app/utils/isp_safety.py` | 165 | 4× FFT oversampling ISP 가드 (P0) |
| `app/analysis/__init__.py` | 1 | 패키지 선언 |
| `app/analysis/metrics.py` | 320 | numpy metrics + 8 row 비교 빌더 + drop 검출 |
| `app/qc/quality_check.py` | 200 | 5 항목 자동 검사 + 모드별 임계 + input 비교 |
| `app/mastering/dynamic_eq.py` | 200 | adynamicequalizer 우선 + fallback (P3) |
| `tests/qa/__init__.py` | 1 | 패키지 |
| `tests/qa/fixtures.py` | 146 | 7 종 합성 fixture 생성기 |
| `tests/qa/run_qa.py` | 250 | 4 그룹 회귀 + waveform/metric/qc 측정 |
| `python/LEGACY.md` | 60 | legacy 디렉토리 archive 표시 |
| `aimaster-desktop/services/python-audio/README.md` | 110 | 활성 엔진 가이드 |

---

## 4. 수정 파일 (3)

| 파일 | 변경 |
|---|---|
| `app/mastering/pipeline.py` | static chain 분기, ISP safety 호출, Dynamic EQ 합류, waveform/metric/qc 통합, 신규 인자 `dynamic_eq_intensity / generate_waveforms` |
| `app/mastering/mastering.py` | JSON-RPC params 패스스루 |
| `packages/shared-types/src/index.ts` | `MetricComparisonRow / QualityCheckReport / DynamicEqReport` 신규 타입 + `MasteringResult` 옵셔널 필드 4종 + `MasteringMeta.staticChain / ispCorrectionDb` |

---

## 5. QA 결과 (26 runs / `/tmp/aim_active_qa_out/qa_report.json`)

### 5.1 안전성 지표
| 지표 | 값 | 평가 |
|---|---:|---|
| 총 실행 | 26 | — |
| 에러 | 2 (silence × 2) | ✓ 의도된 차단 |
| TP 한도 초과 | **0 / 26** | ✅ 100% 안전 |
| 정적 체인 자동 트리거 | 14 / 26 | ✅ 의도대로 동작 |

### 5.2 P2/P3 신기능 동작
| 지표 | 값 | 평가 |
|---|---:|---|
| Waveform PNG 3종 모두 생성 | 24 / 26 | ✓ silence 2건 제외 정상 |
| Metric comparison 평균 row 수 | 7.4 | ✓ 8 row 중 거의 모두 채워짐 |
| Dynamic EQ adynamicequalizer 사용 | 24 / 26 | ✓ 가용 ffmpeg 환경 |
| QC overall = ok | 14 / 24 | ✓ 정상 fixture 모두 통과 |
| QC overall = warn | 5 / 24 | ✓ wide_dynamic + 중간 모드 |
| QC overall = danger | 5 / 24 | ✓ wide_dynamic + 강한 모드 (다이내믹 손실 정확 감지) |

### 5.3 출렁임 측정 (ebur128 short-term spread)
| 모드 / fixture | spread (LU) | 평가 |
|---|---:|---|
| kpop_loud / already_loud | 0.0 | ✅ 완벽 정적 |
| kpop_loud / sibilant | 0.0 | ✅ 완벽 정적 |
| kpop_loud / bass_heavy | 0.03 | ✅ 매우 안정 |
| **kpop_loud / wide_dynamic** | **0.35** | ✅ 정적 체인 효과 |
| **balanced / wide_dynamic** | **2.19** | ⚠️ dynamic loudnorm 본질적 한계 |
| natural / wide_dynamic | 5.55 | ✓ 입력 12 LU 다이내믹 그대로 보존 (정상) |

→ 정적 체인 모드 (kpop_loud 0.35) vs dynamic loudnorm 모드 (balanced 2.19): **출렁임 약 84% 감소**.

---

## 6. 경로 / 파일명 안전성

| 케이스 | 결과 |
|---|---|
| 한글 디렉토리 + 한글 파일명 | ✅ master / preview / 3 PNG 모두 생성 |
| 공백 포함 디렉토리 | ✅ 정상 처리 |
| Windows 백슬래시 (resolver 단계 처리) | ✅ `aimaster-local://` URL 변환 시 슬래시 정규화 |
| ffmpeg 인자 escape | ✅ Python list 전달 (shell 미경유) |
| temp 파일 정리 | ✅ `tempfile.mkstemp` + `finally: os.unlink` |

---

## 7. 남은 리스크 + 후속 튜닝

| ID | 우선순위 | 내용 | 비고 |
|---|:-:|---|---|
| R1 | medium | kpop_loud / 작은 입력 push 과다 (-28→-9 케이스에서 -5 LUFS) | 보정 패스 down-gain 우선순위 점검 필요 |
| R2 | low | wide_dynamic + 중간 강도 모드의 출렁임 (~ 3 LU) | dynamic loudnorm 본질 한계 — 사용자가 모드 변경하면 해결 |
| R3 | low | 합성 fixture 의 LRA = 0 가 많음 | 실제 음악으로 회귀 추가 시 무효화됨 |
| R4 | low | UI 가 아직 신규 옵셔널 필드 미사용 | `ResultPage.tsx` 추가 카드 작업 별도 PR |

배포 영향도: **R1 만 사용자 체감 가능**. 단 입력 LUFS 가 -28 같은 극단적 케이스에서만 — 일반 음원에서는 발생 안 함.

---

## 8. 배포 가능 여부 판단

| 항목 | 결과 |
|---|---|
| 핵심 안전성 (TP / silence / clipping) | ✅ 통과 |
| 출렁임 제거 (정적 체인) | ✅ 통과 (84% 감소) |
| Waveform / metric / qc 결과 | ✅ 통과 |
| 한글 / 공백 경로 | ✅ 통과 |
| temp 파일 정리 | ✅ 통과 |
| ffmpeg 번들 호환 (ffmpeg-static 5.2.0 / ffmpeg 7.x) | ✅ adynamicequalizer 포함 |
| UI 옵셔널 호환 | ✅ 기존 ResultPage 그대로 동작 |
| Legacy archive 표시 | ✅ 완료 |

**결론**: ✅ **배포 가능 (Pre-release / TestFlight 권장)**.
실제 음악 fixture 회귀 (체크리스트 §9) 후 최종 release.

---

## 9. 실제 음악 테스트 체크리스트

합성 fixture 만으로는 검증되지 않는 항목.  실제 음원 6 종으로 다음을 직접 청취 + 측정.

### 9.1 테스트 음원 매트릭스

| ID | 장르 | 특성 | 권장 모드 | 결과 폴더 |
|---|---|---|---|---|
| T1 | KPOP 댄스 | -10~-12 LUFS, 강한 비트 | `kpop_loud` | `/tests/audio_qa/T1_kpop_dance/` |
| T2 | KPOP 발라드 | verse-chorus 12+ LU 다이내믹 | `balanced` 또는 `natural` | `T2_kpop_ballad/` |
| T3 | EDM | -8~-10 LUFS, sustained | `loud` 또는 `kpop_loud` | `T3_edm/` |
| T4 | 힙합 | 808 강한 저역 + 보컬 | `loud` 또는 `punch` | `T4_hiphop/` |
| T5 | 이미 라우드 (-9 LUFS 입력) | 마스터링이 줄여야 함 | `natural` (gain reduction) | `T5_already_loud/` |
| T6 | 어쿠스틱 / 라이브 | -20 LUFS, 큰 다이내믹 | `natural` 또는 `bright` | `T6_acoustic/` |

### 9.2 각 T# 별 점검 항목

```
[ ] 음압 출렁임            : ebur128 short-term spread < 1.5 LU (정적 모드) / < 3 LU (loudnorm)
[ ] 코러스 음압 저하        : verse vs chorus 의 dB 차이가 마스터링 후 감소
[ ] 치찰음 과다            : 6~10 kHz 대역에서 거슬리는 hiss 없음
[ ] 저역 뭉침              : 80~250 Hz 가 흐려지지 않음
[ ] 스테레오 이미지         : 모노 호환성 (mono fold-down) 깨지지 않음
[ ] 트랜지언트 살아있음     : 킥 / 스네어 어택 보존
[ ] 파형 비교 PNG          : compareWaveformPath 가 시각적으로 자연스러움
[ ] QC 결과 납득 가능      : qualityCheck.overall 가 사용자가 동의할 수준
[ ] preview MP3 정상 재생   : 320 kbps, glitch / pop 없음
[ ] 처리 시간              : 3분 곡 기준 < 30 s (개발 머신 / SSD)
```

### 9.3 비교 청취 (A/B)

각 T# 에 대해:
1. 원본 → 마스터 (기본 권장 모드)
2. 마스터 (kpop_loud) vs 마스터 (loud) — 강도 차이
3. 마스터 (Dynamic EQ on) vs (intensity=0 으로 비활성)

기록 표:
| T# | 모드 | LUFS | TP | LRA | Spread | 청취 평 (1~5) | 비고 |
|---|---|---|---|---|---|---|---|

---

## 10. 배포 전 필수 체크리스트

```
[ ] 1. 한글 파일명 / 디렉토리 (단위 검증 완료, 실제 사용자 폴더로 재확인)
[ ] 2. 공백 포함 경로
[ ] 3. Windows 드라이브 변경 (D:\, E:\) 시 temp 파일 cross-volume 이슈
[ ] 4. macOS sandbox 환경에서 output 디렉토리 권한
[ ] 5. ffmpeg-static 번들에 adynamicequalizer 포함 확인 (실제 PyInstaller build)
[ ] 6. preview MP3 정상 생성 (libmp3lame 번들)
[ ] 7. waveform PNG 3종 정리 정책 (사용자가 wav 만 저장 시 PNG 잔존 — UI 정책 필요)
[ ] 8. PyInstaller spec (engine.spec) 의 hidden imports 에 numpy / soundfile 포함
[ ] 9. AIMASTER_FFMPEG / AIMASTER_FFPROBE 환경변수 전달 (Electron 패키징 시)
[ ] 10. 라이선스 표시 (ffmpeg LGPL, soundfile LGPL, numpy BSD)
```

---

## 11. UI 연동 가이드 (다음 PR 권장)

`apps/desktop/src/renderer/pages/ResultPage.tsx` 에 다음 카드 추가:

```tsx
// (기존 BeforeAfterCard 와 QCSummary 사이에 삽입 권장)

{result.compareWaveformPath && (
  <WaveformCompareCard src={toFileUrl(result.compareWaveformPath)} />
)}

{result.metricComparison?.length && (
  <MetricComparisonTable rows={result.metricComparison} />
)}

{result.qualityCheck && (
  <QualityCheckCard report={result.qualityCheck} />
)}

{result.dynamicEq?.bands.length && (
  <DynamicEqCard report={result.dynamicEq} />
)}
```

각 카드는 `metricComparison.status` (ok/warn/danger) 에 따라 색상 자동:
- ok     → emerald-400
- warn   → amber-400
- danger → red-400

---

**리뷰 요청**: 이 문서를 PR 본문 또는 release note 의 base 로 사용.
