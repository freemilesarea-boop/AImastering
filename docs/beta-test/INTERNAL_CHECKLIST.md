# 🔍 AIMASTER 베타 테스트 내부 분석 체크리스트

각 베타 테스트 결과 (디버그 번들 또는 result JSON) 를 받았을 때 개발팀이
체크해야 할 항목.  사용자 주관 평가 (USER_CHECKLIST) 와 같이 보면 어떤
측정값이 어떤 청감 문제와 연결되는지 객관화 가능.

---

## 1. Sanity — 마스터링이 정상 종료했는가?

| 항목 | 위치 | 기준 | 상태 |
|------|------|------|:----:|
| `pipelineWarnings` 에 ERROR 레벨 없음 | result | 빈 배열 또는 warning 만 | ☐ |
| `processingTimeSec` 합리적 | result | < 60s (10s 트랙 기준) | ☐ |
| `loudnessAfter.integratedLufs` 측정 성공 | result | not null, > -90 | ☐ |
| 출력 파일 정상 생성 | filesystem | 파일 존재 + 크기 > 0 | ☐ |

## 2. Vocal Protection (v3.3.1) 동작 검증

| 항목 | 위치 | 기준 | 사용자 신호 |
|------|------|------|------------|
| `vocalProtection.enabled` | result | true | — |
| `vocalProtection.active` | result | aggressive 모드면 true 예상 | — |
| `vocalProtection.appliedClamps` | result | kpop_loud 면 ratio + attack 클램프 보여야 | — |
| `vocalProtection.vocalLossDb` | result | < 1.5 dB → ok / 1.5–3 → warn / >3 → danger | "보컬 답답" |
| `vocalProtection.autoFallbackTriggered` | result | true 면 사용자에게 재마스터링 권장 떠야 | "보컬 묻힘" |

**판정**:
- vocalLossDb < 1.5 → 사용자 보컬 평가 "좋음" 예상
- vocalLossDb ≥ 3.0 + 사용자 평가 "보컬 나쁨" → vocal-protection 부족
- vocalLossDb ≥ 3.0 + 사용자 평가 "보컬 좋음" → 측정과 청감 불일치 (조사 필요)

## 3. Gain Staging (v3.3) 검증

| 항목 | 위치 | 기준 | 사용자 신호 |
|------|------|------|------------|
| `gainStaging.stages.compressorMakeupDb` | result | ≤ 1.0 dB | — |
| `gainStaging.stages.preGainDb` | result | ≤ 6.0 dB | — |
| `gainStaging.stages.limiterInputGainDb` | result | ≤ 0.5 dB | — |
| `gainStaging.stages.totalAppliedGainDb` | result | < 15 dB | — |
| `gainStaging.crestFactorDropPct` | result | < 40 % → ok | "라디오 느낌" |
| `gainStaging.lraDropPct` | result | < 50 % → ok | "답답함" |
| `gainStaging.vocalLossDb` | result | < 1.5 → ok | "백그라운드 큼" |
| `gainStaging.backgroundRiseDb` | result | < 1.5 → ok | "백그라운드 큼" |
| `gainStaging.verdict` | result | ok | — |

**판정 매트릭스**:

| crestDrop | LRA drop | bgRise | 사용자 청감 예상 |
|-----------|----------|--------|----------------|
| < 30 % | < 30 % | < 1 dB | "자연스러움" |
| 30–40 % | 30–50 % | 1–3 dB | "약간 압축됨" |
| > 40 % | > 50 % | > 3 dB | "라디오 느낌 + 백그라운드 부각" |

## 4. Limiter / QC

| 항목 | 위치 | 기준 |
|------|------|------|
| `limiterCheck.overall` | result | warn 가능 / danger 면 조사 |
| `limiterCheck.metrics.crestDelta` | result | > -3 dB |
| `limiterCheck.metrics.ceilingAttachedFrac` | result | < 0.40 |
| `limiterCheck.metrics.brickwallSampleRatio` | result | < 0.05 |
| `limiterCheck.recommendations` | result | 비어있어야 정상 |
| `qualityCheck.overall` | result | ok / warn 허용, danger 면 조사 |
| `qualityCheck.items[*].status` | result | 각 항목 ok/warn |

## 5. Suspect Segments (시간대별 의심 구간)

| 항목 | 위치 | 기준 |
|------|------|------|
| `suspectSegments[*]` 길이 | result | ≤ 2 segments / 분 |
| `excessive_limiter_reduction` 발생 | result | 0건 권장 |
| `brickwall_flat` 발생 | result | 0건 권장 |
| `segmentAnalysis.summary.minCrestDb` | result | > 4 dB |
| `segmentAnalysis.summary.ceilingAttachedFrac` | result | < 0.40 |

## 6. Reference Matching (시나리오 C)

| 항목 | 위치 | 기준 |
|------|------|------|
| `referenceMatch.overall` | result | ≥ 75 (B등급 이상 권장) |
| `referenceMatch.perAxis.lufs` | result | ≥ 80 |
| `referenceMatch.perAxis.lra` | result | ≥ 60 |
| `referenceMatch.perAxis.bands.vocal` | result | ≥ 70 |
| `referenceMatch.iterations` | result | 1–3 (수렴 확인) |
| `referenceMatch.stoppedReason` | result | accept_threshold_met 가 가장 좋음 |
| `referenceWarnings[*]` danger | result | 0건 (사용자 reference 적절했음) |

**판정**:
- overall ≥ 90 → "레퍼런스에 매우 가깝게 도달"
- overall 75–90 → "괜찮은 수준 (사용자 만족도 높을 것)"
- overall 50–75 → "weakestAxis 확인 필요"
- overall < 50 → "장르 mismatch 의심 → referenceWarnings 조사"

## 7. Reference Validation (사용자가 reference 잘못 골랐는지)

| 코드 | 의미 | 액션 |
|------|------|------|
| `REFERENCE_TOO_QUIET` | 미마스터링 demo 의심 | 발매곡 권장 안내 |
| `REFERENCE_TOO_LOUD` | 클리핑 / 잘못된 인코딩 | 다른 곡 권장 |
| `REFERENCE_TP_OVER` | ISP risk | 다른 곡 권장 |
| `REFERENCE_BRICKWALL` | 이미 brickwall | 결과도 압축감 있음 안내 |
| `REFERENCE_VERY_DYNAMIC` | mix 단계 의심 | 마스터링된 곡 권장 |
| `REFERENCE_TOO_SHORT` | 측정 부정확 | 30s+ 곡 권장 |
| `GENRE_MISMATCH_DANGER` | 장르 mismatch | preset 사용 권장 |
| `INPUT_FAR_MORE_DYNAMIC` | 입력이 mix 단계 | 입력 정리 후 재시도 |

각 코드별 발생 빈도 추적 → 문서/UI 개선 우선순위 결정.

## 8. Mode Recommendations (자동 추천 트리거)

`modeRecommendations[*]` 에 떠 있는 추천 모드 — 사용자 청감 평가와 대조:

| 추천 코드 | 청감 신호 매칭 |
|----------|----------------|
| `low_limit` | "답답", "라디오 느낌" 사용자 평가에 일치하면 ✓ |
| `vocal_safe` | "보컬 묻힘", "보컬 답답" 일치하면 ✓ |
| `safe` | LRA / crest 손실 클 때 일치하면 ✓ |
| `convert_to_wav` | 입력이 MP3 / VBR 일 때만 발생해야 |

→ 추천이 사용자 불만과 일치 = 추천 시스템 정확.
→ 추천 없는데 사용자 불만 = 자동 감지 강화 필요.
→ 추천 있는데 사용자 만족 = 추천 임계값 너무 민감.

## 9. Debug Bundle 확인 사항

디버그 번들 zip 안에 다음이 있어야:

- ☐ `input.json` — 입력 codec / sampleRate / VBR-CBR
- ☐ `environment.json` — OS / app 버전 / ffmpeg 버전 / dynamicEqEngine
- ☐ `mastering_settings.json` — 사용자 모드 / 파라미터
- ☐ `filter_chain.txt` — 실제 적용된 ffmpeg 필터
- ☐ `metrics_before.json` / `metrics_after.json`
- ☐ `quality_check.json` / `limiter_check.json`
- ☐ `suspect_segments.json`
- ☐ `recommendations.json`
- ☐ `debug.json` — 전체 DebugRecorder

## 10. 환경별 차이 추적

| 환경 변수 | 추적 이유 |
|----------|----------|
| `os.system` | OS 별 결과 차이 (macOS / Windows / Linux) |
| `ffmpeg.version` | ffmpeg 6.x vs 7.x adynamicequalizer mode enum 차이 |
| `ffmpegBundled` | 번들 vs 시스템 ffmpeg 호환성 |
| `dynamicEqEngine` | adynamicequalizer 가용 vs fallback |
| `cpu.model` | 처리 시간 분포 |

---

## 결론 도출 가이드

각 베타 결과를 종합한 후 다음 표 채우기:

| 항목 | 정상 | 경고 | 위험 | 사용자 평가 일치 여부 |
|------|------|------|------|---------------------|
| Vocal Protection 동작 | ☐ | ☐ | ☐ | ☐ 일치 ☐ 불일치 |
| Gain Staging | ☐ | ☐ | ☐ | ☐ 일치 ☐ 불일치 |
| Limiter QC | ☐ | ☐ | ☐ | ☐ 일치 ☐ 불일치 |
| Reference Match (시나리오 C) | ☐ | ☐ | ☐ | ☐ 일치 ☐ 불일치 |
| Mode Recommendations | ☐ | ☐ | ☐ | ☐ 일치 ☐ 불일치 |

### 액션 분류

1. **측정 정상 + 사용자 만족** → 유지
2. **측정 정상 + 사용자 불만** → 측정 임계값 조정 (놓친 지표 발굴)
3. **측정 위험 + 사용자 만족** → 임계값 너무 민감 / 청감 무관 지표
4. **측정 위험 + 사용자 불만** → 엔진 추가 보호 필요 (이번 v3.4.1 패치 같은 변경)
