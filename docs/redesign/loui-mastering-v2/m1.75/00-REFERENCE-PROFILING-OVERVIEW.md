# M1.75 — Reference Profiling System (Overview)

> 본 단계는 **"좋아하는 사운드를 분석 가능한 구조로 확장"** 한다.
> 특정 상용 마스터를 "복제" 하지 않고, **특성 (characteristic)** 만 추출해
> Loui 의 preset recommendation / adaptive mastering 에 활용한다.

---

## 1. 가장 중요한 원칙 (M1.75 의 4가지 NOT)

| 금지 | 이유 |
|---|---|
| **Reference cloning 금지** | 출력이 reference 의 sample-level 사본이면 저작권 위반 + 사용자가 자기 곡 정체성을 잃음 |
| **Audio fingerprint 저장 금지** | 식별 가능한 hash 는 ID 데이터베이스 매칭에 악용 가능 |
| **Time-series / spectrogram 저장 금지** | 시간축 정보가 있으면 재구성 / 매칭 가능 |
| **Identifying metadata (artist/title/album/lyrics/isrc/mbid) 저장 금지** | 권리 관계 부착 효과 — 사실(facts) 가 아니라 식별자가 됨 |

이 4가지는 **schema 레벨에서 강제** — validator 가 거부.
상세 근거: `06-REFERENCE-SAFE-LEGAL-GUIDELINE.md`.

---

## 2. 시스템 흐름

```
┌──────────────────────────────────────────────────────────────────┐
│  사용자가 reference track WAV/MP3 를 시스템에 제공                │
└────────────────────────┬─────────────────────────────────────────┘
                         ▼
            ┌───────────────────────────────┐
            │  app.profiling.extract_profile │
            │  (audio → ReferenceProfile)    │
            │                                │
            │  1. WAV 디코딩 (메모리)         │
            │  2. LUFS / TP / LRA (ffmpeg)   │
            │  3. K-weighted block LUFS      │
            │     → P10/P50/P90 percentile   │
            │  4. Crest factor (scalar)      │
            │  5. Transient density          │
            │     → events/min (scalar)      │
            │  6. 1/3-oct spectrum           │
            │     (time-averaged, 30 bins)   │
            │  7. Spectral tilt, sub/lowmid/ │
            │     vocal/air ratio, harshness │
            │  8. Stereo: correlation, MS,   │
            │     width index                │
            │  9. SHA-256 of feature dict    │
            │     (NOT audio)                │
            │ 10. WAV buffer DELETED         │
            └───────────────┬───────────────┘
                            │
                            ▼
                ┌───────────────────────────┐
                │  ReferenceProfile (v1)    │
                │  - aggregate stats only   │
                │  - schema-validated       │
                │  - safe to share          │
                └────────┬──────────────────┘
                         │
                         ├──────────────────┬──────────────────────┐
                         ▼                  ▼                      ▼
        ┌────────────────────────┐ ┌──────────────────┐ ┌────────────────────┐
        │ compare_profiles(A, B) │ │ recommend_preset │ │ derive_adaptive_   │
        │ → ProfileComparison    │ │ (profile)        │ │ overrides(pre,ref) │
        │  • per-axis deltas     │ │ → best preset    │ │ → clamped EQ/sat   │
        │  • spectrum diff       │ │   + score        │ │   nudges (±2 dB    │
        │  • similarity 0..1     │ │   + rationale    │ │   max)             │
        │  • categorical labels  │ │   + runner-up    │ │                    │
        └────────────────────────┘ └──────────────────┘ └────────────────────┘
                                              │
                                              ▼
                              ┌─────────────────────────────────┐
                              │ Adaptive Mastering Flow         │
                              │ (apply preset + overrides       │
                              │ to user audio)                  │
                              │                                 │
                              │ 04-ADAPTIVE-MASTERING-FLOW.md   │
                              └─────────────────────────────────┘
```

---

## 3. M1.75 산출물

| # | 산출물 | 위치 |
|---|---|---|
| 1 | **reference-profile.schema.json** | `packages/shared-types/src/profile/reference-profile.schema.json` |
| 2 | TS 타입 정의 + validator | `packages/shared-types/src/profile/` |
| 3 | Python schema + validator | `services/python-audio/app/profiling/{schema,validate}.py` |
| 4 | Feature extractor | `services/python-audio/app/profiling/extract.py` |
| 5 | Comparison metric | `services/python-audio/app/profiling/compare.py` |
| 6 | Preset recommender + adaptive overrides | `services/python-audio/app/profiling/recommend.py` |
| 7 | 17개 단위 + 통합 테스트 | `tests/test_reference_profiling.py` |
| 8 | **Feature extraction design** | `02-FEATURE-EXTRACTION-DESIGN.md` |
| 9 | **Comparison metric design** | `03-COMPARISON-METRICS.md` |
| 10 | **Adaptive mastering flow** | `04-ADAPTIVE-MASTERING-FLOW.md` |
| 11 | **Preset recommendation flow** | `05-PRESET-RECOMMENDATION-FLOW.md` |
| 12 | **Reference-safe legal guideline** | `06-REFERENCE-SAFE-LEGAL-GUIDELINE.md` |
| 13 | M1.75 execution report (실측 + 결론) | `07-EXECUTION-REPORT.md` |

---

## 4. 추출되는 feature (필수 11종)

`reference-profile.schema.json` 의 `features` 객체:

| Category | Feature | 단위 | 의미 |
|---|---|---|---|
| loudness | `integratedLufs` | LUFS | ITU R.128 평균 라우드니스 |
| loudness | `truePeakDbtp` | dBTP | 4× oversample TP |
| loudness | `loudnessRange` | LU | EBU R128 LRA |
| loudness | `shortTermPercentiles.p10/p50/p90` | LUFS | 3s 윈도우 분포 (시간축 X) |
| loudness | `momentaryPercentiles.p10/p50/p90` | LUFS | 400ms 윈도우 분포 (시간축 X) |
| dynamics | `crestDb` | dB | peak − rms |
| dynamics | `transientDensityPerMin` | events/min | onset rate scalar |
| dynamics | `compressionScore` | 0..1 | LRA + crest + spread 종합 |
| tonal | `thirdOctSpectrumDb` | dB/bin | **1/3-oct 30 bins, 시간 평균** |
| tonal | `spectralTiltDbPerOct` | dB/oct | log-mag vs log-freq 회귀 기울기 |
| tonal | `subEnergyRatio` | [0,1] | 20–100 Hz / total |
| tonal | `lowMidBalanceDb` | dB | 100–500 Hz 상대 |
| tonal | `vocalRegionEnergyDb` | dB | 1–4 kHz 상대 |
| tonal | `airBandEnergyDb` | dB | 10 kHz+ 상대 |
| tonal | `harshnessIndex` | 0..20 | 2–5 kHz peak / 이웃 비율 |
| stereo | `correlationMean` | -1..+1 | L/R Pearson 평균 |
| stereo | `msRatioDb` | dB | M/S 에너지 비 |
| stereo | `stereoWidthIndex` | 0..4 | 종합 width 지표 |

모두 **aggregate scalar** — 시간축 데이터 없음, phase 정보 없음.

---

## 5. 정량 검증 (실측)

`pytest tests/test_reference_profiling.py` — **17/17 통과** (≤ 40초).

- 9개 fixture 모두 schema-valid profile 생성 (extract 시간 평균 ~2초 / 파일)
- Self-compare similarity > 0.99 (sanity)
- Different-genre compare similarity < 0.85 (acoustic vs ai-harsh)
- Validator 가 forbidden field (artist/title/lyrics) 거부
- Validator 가 > 64 spectrum bin 거부 (1/3-oct cap)
- Validator 가 large array (time-series) 거부
- Adaptive overrides 모두 ±2 dB / ±0.1 ratio 범위 내 클램프 검증

상세 → `07-EXECUTION-REPORT.md`.

---

## 6. 다음 단계 (M2 진입 전 검토 항목)

- `01-DSP-POLICY-PHILOSOPHY.md` 의 preset anchor 와 본 모듈의 `PRESET_ANCHORS` 동기화 자동화 (현재는 hand-maintained)
- TS 측 동일 extractor (WASM dsp-core 가 들어오면 — M2)
- 사용자 UI 에서 reference 업로드 → profile 표시 (M3)
- Reference profile marketplace (사용자가 자신의 profile 을 공유 — schema 자체가 safe-share 보장)
