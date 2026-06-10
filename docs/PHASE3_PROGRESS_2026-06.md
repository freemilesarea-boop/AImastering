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

## 🟡 남은 Phase 3 후보

| 항목 | 우선순위 | 비고 |
|------|:--------:|------|
| AI 음악 감지 스펙트럴 피처 강화 | P1 후속 | 렌더러 WASM 스펙트럼으로 metallic/aliasing 정밀화 |
| 스템 분리 (Demucs) → Master Rebalance 대체 | P0(차별화 최대) | 거대 ML 모델·런타임·번들 결정 필요(사용자 결정) |
| 자동 장르 감지 (룰→경량 CNN) | P1 | |
| 한국/아시아 레퍼런스 라이브러리(fingerprint) | P1 | 큐레이션 동반 |
| 섹션별 마스터링 / 멀티-보컬 / 마스터링 이력 | P2 | |
