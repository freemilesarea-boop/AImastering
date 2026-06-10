# Phase 3 진행 보고 — 차별화 (Ozone에 없는 기능)

**작성일**: 2026-06-10
**브랜치**: `claude/dazzling-darwin-eav8na`
**목표**: Ozone이 약하거나 없는 영역에서 우위 — "여기서 이긴다".

---

## ✅ P3-1. AI 생성곡 전용 모드

**커밋**: `feat(ai-music): AI-generated music mode — detect + one-click correct (Phase 3)`

AI 음악(Suno/Udio/Stable Audio) 마스터링 시장이 폭발 중이고 Ozone엔 전용 대응이 없다. 룰기반으로 **AI 특유 아티팩트를 감지 → Phase 2 모듈로 원클릭 보정**.

- **`audio/ai-music.ts`** (순수): `buildAiMusicFeatures(analysis)` + `detectAiMusic(features)`.
  - 감지: 금속성 고중역 / 고역 브리틀·에일리어싱 / 원본 과압축(LRA↓) / 저역 부밍 / 위상·스테레오 이상.
  - 각 아티팩트 → 보정 매핑: 다이내믹EQ DownCut 밴드, 디에서, 트랜지언트 펀치 복원, 이미저 저역 모노. 6종 모듈 보정 번들 반환(다이내믹EQ 6밴드 cap).
- **`audioStore.applyAiMusicCorrection`**: 6종 슬라이스 일괄 세팅.
- **`AiMusicPanel`**(ResultPage): 입력 분석 기반 아티팩트 검출 + 심각도 표시 + 원클릭 '보정 적용'.
- **검증**: ai-music(9) + 패널(3). **vitest 128/128**, 전체 pnpm test 그린(ALL FRESH 포함), typecheck 0.
- ML 불필요 · 기존 aiDetection + Phase 2 모듈 재사용 · 클릭 전엔 무변경(무회귀).

### 정직성/한계
- 감지는 기존 룰기반 aiDetection(6 boolean) + 라우드니스 + (선택) 스펙트럴 밸런스 기반. boolean 임계 의존이라 정밀도 한계 → 향후 스펙트럴 피처 강화(렌더러 WASM 스펙트럼) 가능.
- 보정은 "완화/복원" 위주(원본 과압축은 되돌릴 수 없음 → 추가 압축 회피 + 트랜지언트로 펀치 복원).

---

## ✅ P3-2. AI 음악 감지 스펙트럴 정밀화

**커밋**: `feat(ai-music): precise spectral features from the renderer FFT (Phase 3)`

- **`ai-music-spectral.ts`**(순수): FFT 매그니튜드 스펙트럼 → `bandPowerDb` + **metallicScore**(3–5kHz 집중) · **harshnessScore**(5–9kHz) · **aliasingScore**(Nyquist 근처 비롤오프 에너지) · 틸트. `isUsableSpectrum` 가드.
- `detectAiMusic`이 스코어를 사용(boolean보다 정밀) + 심각도로 보정 range 스케일. `refineWithSpectrum`(live FFT 병합, 무신호 시 no-op).
- `shared-audio-graph.getActiveSpectrumSnapshot()`(active 메인 AnalyserNode dB/bin), `AiMusicPanel`이 라이브 스펙트럼으로 정밀화('스펙트럼 정밀' 배지 + '정밀 재검사' 버튼).
- **검증**: spectral(8 — 합성 metallic/aliased/harsh/natural) + score 규칙 + refine(5). **vitest 140/140**, 전체 그린(ALL FRESH), typecheck 0. 순수·boolean 경로 보존(무회귀).

## ✅ P3-3. 자동 장르 감지 + 아시아 레퍼런스 라이브러리

**커밋**: `feat(genre+ref): auto genre detection + Asian reference library (Phase 3)`

- **`ai-music-spectral`**: `spectralBandsDb`(7대역) + `tonalTilt`(mid 기준 상대 dB) — 두 기능 공유 피처.
- **`genre-detect.ts`**: 라우드니스 + 톤 틸트 센트로이드 룰분류 → top 장르 + 신뢰도 + 후보3 + 추천 `MasteringStyle` + 타겟 LUFS/LRA. 스펙트럼 없으면 라우드니스만으로 동작.
- **`reference-library.ts`**: 저작권 안전 아시아 fingerprint 10종(숫자 톤/라우드니스만 · 오디오·곡명 없음) KR/JP/ASIA×장르. `matchReferences`(최근접 랭킹 + region/genre 필터).
- **`GenreReferencePanel`**(ResultPage): 추정 장르·후보 표시 + 원클릭 '추천 모드 적용'(style+타겟 LUFS) + 가까운 레퍼런스 행 + per-ref '타겟 적용'. 라이브 FFT로 정밀화.
- **검증**: genre(5)+reference(4, 저작권안전 형태 포함)+패널(3). **vitest 152/152**, 전체 그린(ALL FRESH), typecheck 0. 순수·적용 전 무변경.

## ✅ P3-4. 스템 리밸런스 (근사 즉시 · Demucs/ONNX 정밀 추후)

**커밋**: `feat(rebalance): two-tier stem rebalance — live M/S approximation + ONNX-local skeleton (Phase 3)`

iZotope "Master Rebalance"를 대체하는 **2-티어** 스템 컨트롤. 백엔드(ONNX 로컬)는 사용자 결정.

- **근사 티어(지금 동작, ML 불필요)** — `rebalance-config.ts`(순수) + `rebalance-chain.ts`(WebAudio M/S):
  - `M=½(L+R), S=½(L−R)` → 미드 버스에 보컬 피킹(~1.6kHz)·베이스 로우셸프(120Hz), 사이드 폭 `sidePct/100`. unity(보컬0·베이스0·폭100%)에서 정확 패스스루 → idle 시 무착색(graph에서 splice-out).
  - `shared-audio-graph` rerouteBus에 `rebalance` 스테이지 prepend(rebalance→multiband→saturation→imagerMS) + `setRebalanceConfig`. `audioStore` rebalance 슬라이스 + ResultPage 네이티브 프리뷰 effect.
- **정밀 티어(opt-in, export, 추후)** — 백엔드-무관 `StemSeparator` 인터페이스 + `OnnxStemSeparator` 스켈레톤(`main/offline/stem-separation.ts`, 모델 없으면 `getStemSeparator()`→null → 근사로 graceful fallback). 순수 `remixStems`(0dB 합 = 원본 재구성, per-stem dB).
- **`StemRebalancePanel`**(ResultPage): 근사 슬라이더(보컬/베이스/공간, 라이브) + 정밀 per-stem 게인(`PRECISE_AVAILABLE=false`로 gate, "모델 필요" 배지).
- **설계 문서**: `docs/STEM_SEPARATION_PLAN.md` — ONNX 로컬(onnxruntime-node optionalDep · HT-Demucs ONNX · 다운로드-온-퍼스트유즈 · WOLA 윈도 추론) 아키텍처/체크리스트.
- **검증**: rebalance-config(7 — remix 가산성/sanitize/unity)+rebalance-chain(5 — M/S 매핑·정밀 비활성·dispose)+패널(3). **vitest 167/167**, typecheck 0(renderer+main). 적용 전 무변경(무회귀).

### 정직성/한계
- 근사 티어는 진짜 스템 분리가 아님(M/S 근사). 진짜 4스템 분리는 정밀 티어(ONNX Demucs)이며 모델 번들/다운로드·런타임 검증은 출시 전 청취 QA에서 확정(헤드리스 불가).
- 스켈레톤은 native 의존성 미포함 — import-safe, `isReady()`는 항상 false.

## 🟡 남은 Phase 3 후보

| 항목 | 우선순위 | 비고 |
|------|:--------:|------|
| 스템 분리 정밀 티어 마무리(ONNX Demucs 런타임/모델) | P0 | 설계·스켈레톤 완료 → 모델 export·다운로드·WOLA 추론·번들 남음 |
| 섹션별 마스터링 / 멀티-보컬 / 마스터링 이력 | P2 | |
