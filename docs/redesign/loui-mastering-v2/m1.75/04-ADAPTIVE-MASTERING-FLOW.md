# M1.75 — Adaptive Mastering Flow

> "**reference 의 특성을 닮게 만들지만, 복제하지는 않는다**" 가 핵심 보장.

---

## 1. 사용자 시점 (UX 흐름)

```
1. 사용자: "이 트랙처럼 들리게 만들고 싶다" → reference 파일 업로드
2. Loui:    Profile extraction 진행 (~2-3초 / 30초 곡)
3. Loui:    Profile + 추천 preset + 추천 overrides 표시
            예: "kpop_loud 추천 (score 0.75). loudness 토대 일치,
                 air 부드럽게, sub 살짝 더 풍성. 적용?"
4. 사용자: "적용" 클릭
5. Loui:    user audio + (preset + overrides) → 마스터링 → 출력
```

UI 측은 M3 에서 본격 구현. 본 문서는 백엔드 흐름.

---

## 2. 백엔드 흐름

```
                       ┌─────────────────────────────┐
                       │  user's raw mix (input)      │
                       └────────────┬─────────────────┘
                                    │
                                    ▼
                       ┌─────────────────────────────┐
                       │ extract_profile(input)      │
                       │ → preMasterProfile          │
                       └────────────┬─────────────────┘
                                    │
                                    │   ┌──────────────────────────┐
                                    │   │  user's reference track  │
                                    │   └────────────┬─────────────┘
                                    │                │
                                    │                ▼
                                    │   ┌──────────────────────────┐
                                    │   │ extract_profile(ref)     │
                                    │   │ → referenceProfile       │
                                    │   └────────────┬─────────────┘
                                    │                │
                                    ▼                ▼
                            ┌─────────────────────────────────┐
                            │ recommend_preset(referenceProfile)│
                            │ → bestPresetId + score + rationale│
                            └─────────────┬───────────────────┘
                                          │
                                          ▼
                            ┌─────────────────────────────────┐
                            │ derive_adaptive_overrides(       │
                            │   pre=preMasterProfile,          │
                            │   ref=referenceProfile,          │
                            │   chosen_preset_id=bestPresetId) │
                            │ → AdaptiveOverrides (clamped)    │
                            └─────────────┬───────────────────┘
                                          │
                                          ▼
                            ┌─────────────────────────────────┐
                            │ load_builtin_preset(bestPresetId)│
                            │ → EnginePreset object           │
                            └─────────────┬───────────────────┘
                                          │
                                          │ apply overrides (M2 helper):
                                          │   preset.loudness_norm.targetLufs += over.targetLufsAdjustDb
                                          │   preset.saturator.amount += over.saturationDelta
                                          │   preset.stereo_imager.width += over.stereoWidthDelta
                                          │   preset.adaptive_eq.bands["air"].gainDb += over.eqAirShelfDeltaDb
                                          │   preset.adaptive_eq.bands["low_shelf"].gainDb += over.eqLowShelfDeltaDb
                                          ▼
                            ┌─────────────────────────────────┐
                            │ preset_to_kwargs(adaptedPreset)  │
                            │ run_pipeline(input → output)     │
                            └─────────────┬───────────────────┘
                                          │
                                          ▼
                            ┌─────────────────────────────────┐
                            │ mastered output (WAV)           │
                            │ + adapterReport (which modules │
                            │   applied/noop, with adaptive  │
                            │   overrides recorded)           │
                            └─────────────────────────────────┘
```

---

## 3. AdaptiveOverrides — 클램프 범위

`recommend.py:AdaptiveOverrides` 에 정의된 hard limits:

| Field | Range | 근거 |
|---|---|---|
| `targetLufsAdjustDb` | ±2 dB | preset 의 목표를 ±2 dB 안에서만 nudge — 더 큰 변화는 "다른 preset 사용" 신호 |
| `saturationDelta` | ±0.10 | preset saturation 의 ±0.1 (0..1 스케일) |
| `stereoWidthDelta` | ±0.10 | width 의 ±0.1 (1.0 baseline) |
| `eqAirShelfDeltaDb` | ±2 dB | air shelf nudge |
| `eqLowShelfDeltaDb` | ±2 dB | low shelf nudge |

**이유**: 클램프가 없으면 "이 reference 처럼 들리게" → "이 reference 의 EQ 곡선을 그대로 베끼기" 로 발전 가능.
클램프는 **clone 방지의 마지막 보루** — preset 의 identity 가 우선.

---

## 4. 무엇을 nudge 하는가 (현재 M1.75 규칙)

```python
# Loudness — reference 의 LUFS 쪽으로 ±2 dB
over.targetLufsAdjustDb = clamp(ref.lufsI − preset_anchor.lufsI, -2, +2)

# Tilt — reference 가 밝으면 air↑, low↓ (대칭 nudge)
tilt_delta = ref.tilt − preset_anchor.tilt
over.eqAirShelfDeltaDb = clamp(tilt_delta × 0.8, -2, +2)
over.eqLowShelfDeltaDb = clamp(−tilt_delta × 0.4, -2, +2)

# Sub-bass — reference 가 sub-heavy 면 saturation 줄임
sub_delta = ref.subRatio − preset_anchor.subRatio
over.saturationDelta = clamp(−sub_delta × 0.5, -0.10, +0.10)

# Width — reference 가 넓으면 imager width 살짝 ↑
width_delta = ref.widthIdx − preset_anchor.widthIdx
over.stereoWidthDelta = clamp(width_delta × 0.2, -0.10, +0.10)
```

**무엇을 nudge 하지 않는가** (의도된 보호):
- Bus comp ratio / attack / release — preset 의 identity 핵심
- Limiter strength tier (low/medium/high) — preset 의 강도 정체
- Dynamic EQ 밴드 — 너무 미세하면 fingerprint 같음
- 멀티밴드 EQ — reference matching 의 핵심 (별도 모듈에서 처리 — M2+ ReferenceMatching)

---

## 5. Reference matching 과의 차이

본 시스템 ≠ Python pipeline 의 기존 `reference_matching.py` (4-band multiband):

| | 본 시스템 (M1.75) | 기존 reference_matching (v3.4) |
|---|---|---|
| 목적 | preset + adaptive nudge 추천 | 4-band 직접 EQ 매칭 (iterative) |
| 출력 | recommendation + overrides JSON | 직접 EQ 보정 적용 |
| Clone 위험 | 낮음 (클램프 + 추상화) | 중 (4-band 직접 매칭) |
| 사용 단계 | preset 선택 시점 | 마스터링 stage 8 (post-EQ) |

M2 에서 두 시스템은 통합 — `reference_matching` 의 결과를 본 시스템의 `derive_adaptive_overrides` 로 흡수 + 클램프 적용. (`07-EXECUTION-REPORT.md` § 4 참조).

---

## 6. 실측 — 어쿠스틱 입력 + KPOP reference

```
pre  = extract(acoustic-fingerpick-01)
ref  = extract(kpop-modern-01)
rec  = recommend_preset(ref)         → kpop-loud (0.51 score)
over = derive_adaptive_overrides(pre, ref, chosen='kpop-loud')
       → targetLufsAdjustDb:    -1.25   (kpop LUFS -9 → ref LUFS -10.25 방향)
         eqAirShelfDeltaDb:      0.64
         eqLowShelfDeltaDb:     -0.32
         saturationDelta:       -0.02
         stereoWidthDelta:       0.13   (clamped → +0.10)
```

모두 hard limit 내. notes 에 "nudge, not clone" 명시.

---

## 7. 미구현 (백로그)

| 항목 | 우선순위 | 비고 |
|---|---|---|
| Override → preset 객체 patch 헬퍼 | P0 | `apply_overrides_to_preset(preset, overrides)` 함수 |
| Multi-reference 평균 (3-5곡) | P1 | overrides 도 평균 |
| User override 추적 (사용자가 추천 reject 한 빈도) | P2 | scaling 자동 조정 데이터 |
| Adaptive overrides 가 적용된 후 `AdapterRunReport` 에 명시 | P0 | "overrides applied" 항목 |
