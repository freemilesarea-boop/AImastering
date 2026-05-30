# M1.75 — Preset Recommendation Flow

> 본 문서는 `recommend_preset(profile)` 의 알고리즘과 anchor 테이블 결정을 정리한다.

---

## 1. 핵심 가정

> **Reference profile 의 특성** 이 **어떤 preset 의 의도** 와 가장 잘 맞는지를 측정한다.

따라서:
- 입력 profile 은 **마스터링된 reference 트랙** 의 profile 이어야 정확.
- 사용자의 **raw mix** 의 profile 로 호출하면 score 낮음 (의도된 동작 — "이 입력은 아직 마스터링 안 됨" 신호).

---

## 2. Preset anchor 테이블

`recommend.py:PRESET_ANCHORS` — 각 빌트인 preset 의 "post-master target characteristic":

| presetId | LUFS | TP | LRA | crest | comp | tilt | sub | harsh | width |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| builtin-natural    | -14.0 | -1.0 | 11.0 | 12.0 | 0.25 | -3.0 | 0.12 | 1.0 | 1.0 |
| builtin-balanced   | -12.0 | -1.0 |  8.0 | 10.0 | 0.40 | -3.0 | 0.15 | 1.0 | 1.05 |
| builtin-bright     | -12.0 | -1.0 |  8.0 | 10.0 | 0.40 | -2.0 | 0.13 | 0.9 | 1.10 |
| builtin-warm       | -14.0 | -1.0 | 11.0 | 11.0 | 0.30 | -4.0 | 0.16 | 0.7 | 1.0 |
| builtin-loud       | -10.0 | -1.0 |  5.0 |  8.0 | 0.60 | -2.5 | 0.18 | 1.0 | 1.10 |
| builtin-kpop-loud  |  -9.0 | -0.8 |  4.5 |  7.5 | 0.70 | -2.5 | 0.20 | 1.0 | 1.10 |
| builtin-punch      | -11.0 | -1.0 |  6.0 |  9.0 | 0.55 | -3.0 | 0.22 | 1.0 | 1.05 |

근거: `01-DSP-POLICY-PHILOSOPHY.md` 의 §2 / §3 표.
변경 시 같은 표 동시 갱신 (M1.5 의 변경 절차).

---

## 3. 스코어링 알고리즘

```python
def _score_preset(anchors, profile):
    score = Σ wᵢ · 1 / (1 + (|Δᵢ| / scaleᵢ)²) / Σ wᵢ
```

8개 axis × 가중치:

| Axis | Weight | Scale (50%) |
|---|---:|---:|
| LUFS | **3.0** | 3.0 |
| LRA | 2.0 | 3.0 |
| Crest | 1.5 | 3.0 |
| Compression | **2.0** | 0.25 |
| Spectral Tilt | 1.5 | 1.5 |
| Sub Ratio | 1.0 | 0.10 |
| Harshness | 1.0 | 1.5 |
| Width | 1.0 | 0.40 |

**LUFS / Compression 이 가장 무겁다** — preset 의 정체성은 라우드니스 + 다이내믹 처리 강도가 결정.

Score 0..1 해석:

| Score | 결론 |
|---|---|
| ≥ 0.75 | **Strong match** — preset 의도와 reference 일치 |
| 0.55–0.75 | **Plausible** — 후보군 중 가장 가까움 |
| 0.40–0.55 | **Weak** — 가까운 preset 없음, override 적극 사용 권장 |
| < 0.40 | **Mismatch** — reference 가 알려진 카테고리에 속하지 않음, custom preset 권장 |

---

## 4. 출력 구조

```python
PresetRecommendation(
    presetId         = "builtin-kpop-loud",
    score            = 0.75,
    rationale        = {
        "lufsI":           0.88,    # 각 axis 의 similarity 기여도
        "lra":             0.62,
        "crest":           0.71,
        "compression":     0.83,
        "spectralTilt":    0.65,
        "subRatio":        0.55,
        "harshness":       0.80,
        "width":           0.92,
    },
    runnerUp         = "builtin-loud",
    runnerUpScore    = 0.68,
    explanation      = "Strong match — reference profile aligns with preset's intended characteristics.",
)
```

**rationale 의 사용** (M3+ UI):
- 가장 낮은 axis 의 similarity 를 표시 → "lra 가 가장 다름. 이 reference 는 더 다이내믹."
- 사용자가 axis 별 weight 조정 가능 — "loudness 보다 tone 우선" 옵션.

---

## 5. 실측 (M1.75 빌트인 fixture 9종)

```
fixture (raw)              | recommended preset    | score | match expected?
─────────────────────────────────────────────────────────────────────────
acoustic-fingerpick-01     | natural               | 0.31  | ✓ (expected natural)
ai-harsh-mix-01            | kpop-loud             | 0.42  | ✗ (expected balanced)
ballad-piano-01            | punch                 | 0.60  | ✗ (expected warm)
edm-festival-01            | natural               | 0.62  | ✗ (expected loud)
female-vocal-01            | kpop-loud             | 0.66  | ✗ (expected bright)
hiphop-trap-01             | warm                  | 0.45  | ✗ (expected punch)
kpop-modern-01             | kpop-loud             | 0.51  | ✓ (expected kpop-loud)
lofi-chill-01              | kpop-loud             | 0.33  | ✗ (expected natural)
male-vocal-01              | punch                 | 0.55  | ✗ (expected balanced)
```

→ raw fixture 입력 → 2/9 expected 매칭, 평균 score 0.49.

**해석**: raw fixture 는 사실상 reference 가 아니므로 매칭이 부정확. 의도된 결과.

```
fixture mastered (postPreset) | recommended preset | score
──────────────────────────────────────────────────────────
kpop-modern-01 .master         | loud               | 0.75
acoustic-fingerpick-01 .master | natural            | 0.55  ✓
edm-festival-01 .master        | punch              | 0.74
```

마스터된 출력에서: 3/3 score ≥ 0.55, 1/3 expected 정확 매칭, 2/3 adjacent (loud↔kpop-loud, punch↔loud — preset 가족 안).

**M2 의 작업**: anchor 값을 사용자 피드백 / 실제 산업 데이터로 재교정.

---

## 6. UI 표시 (M3+)

```
┌──────────────────────────────────────────────────┐
│  Reference: client-A-track-02.wav  [analyze]       │
├──────────────────────────────────────────────────┤
│  Recommended preset:                              │
│    ▶ K-Pop Modern Loud      ★★★★☆ (0.75)          │
│      "Strong match — loudness + air align."       │
│                                                   │
│  Runner-up:                                       │
│    ▶ Modern Loud            ★★★☆☆ (0.68)          │
│                                                   │
│  Why this preset:                                 │
│    LUFS:      ████████░░  88% match               │
│    LRA:       ██████░░░░  62% match               │
│    Tilt:      ██████░░░░  65% match               │
│    Width:     █████████░  92% match               │
│                                                   │
│  Adjustments suggested:                            │
│    • Target LUFS: -9.0 → -10.25  (−1.25 dB)       │
│    • Air shelf:   +0.64 dB                         │
│                                                   │
│  [Apply]  [Show all presets]  [Customize]         │
└──────────────────────────────────────────────────┘
```

M3 에서 본 데이터를 React 카드 UI 로.

---

## 7. 미구현 (백로그)

| 항목 | 우선순위 | 비고 |
|---|---|---|
| Anchor 테이블의 자동 동기화 (PRESET_ANCHORS ↔ DSP-POLICY-PHILOSOPHY) | P1 | 한 곳 변경 시 다른 곳도 잡히는 보호 |
| User-tunable weight | P2 | UI 토글 |
| Fallback: weak match (< 0.4) 시 "build custom preset" 제안 | P2 | M3 UI |
| Anchor 데이터 기반 재교정 (commercial reference 분석 batch) | P3 | 데이터 큐레이션 |
