# Mastering Engine — Full Architecture Analysis

**버전**: pre-v3.5 design review
**분석 일자**: 2026-05-04
**대상**: KPOP Loud preset (대표 케이스), 전체 마스터링 체인
**상태**: **분석 only — 코드 수정 없음**

이 문서는 사용자 보고를 받아 마스터링 엔진을 *부분 튜닝*이 아닌 *아키텍처
재설계* 수준으로 점검하기 위해 작성되었습니다. 이후 단계에서 본 분석을
기반으로 코드 수정에 들어갑니다.

---

## 0. 요약 (TL;DR)

세 개의 합성 테스트 신호 (`bass-heavy`, `bass-light`, `realistic`) 를
KPOP Loud chain 에 통과시키며 stage 별 4 band (LOW/MID/HIGH/AIR) 누적
변화량을 측정한 결과:

- **Stage 03 (Dynamic EQ)** 가 단일 stage 로 LOW 를 −9 ~ −10 dB,
  HIGH 를 −7 ~ −8 dB 깎는다 (static-fallback 경로).
- **Stage 10 (Limiter)** 가 모든 band 를 +1.6 ~ +1.8 dB 끌어올린다.
  AIR band 는 가장 적게 차 있어 끌어올림 폭이 가장 크게 보임.
- 결과적으로 final tilt (AIR − LOW) 가 입력에 따라 **+1 dB ~ +10 dB**
  로 광범위하게 흔들림 → "어떤 입력에선 균형, 어떤 입력에선 텔레폰".
- 동일 band 가 평균 **3–4 stage** 에서 중복으로 건드려짐.
- v3.4.7 final tonal guard 는 *최대 ±1.5 dB* 까지 보정하는데,
  fallback 경로의 −10 dB 손실은 보정 한도를 초과한다.

→ **부분 튜닝으로는 한계.  pre-limiter 단계 자체를 재설계해야 한다.**

---

## 1. 전체 체인 구조 덤프 (KPOP Loud, target -9 LUFS, limiter=high)

| # | Stage | Module | 적용 파라미터 (kpop_loud, target -9 LUFS) | 영향 band |
|---|-------|--------|-------------------------------------------|----------|
| 01 | **Base EQ** | `eq.py:_build_base_eq` | `equalizer 80 Hz +adaptive(2.0–4.0)` / `120 Hz +adaptive(0.8–1.6)` / `250 Hz −3.0` / `320 Hz −1.0` / `highshelf 12 kHz +adaptive(2.0–3.5)` | LOW + MID + AIR |
| 02 | **Adaptive Overlay** | `eq.py:build_kpop_loud_overlay` | `90 Hz +0~+0.7 (warmth, adaptive)` / `2500 Hz +1.0~+1.2` / `5500 Hz +0.8~+0.9` / `10000 Hz 0~+0.6 (sheen, adaptive)` | LOW + MID + HIGH |
| 03 | **Dynamic EQ** | `dynamic_eq.py` | 5 bands × adynamicequalizer (real) **or** static equalizer (fallback at 60% reduction)<br>– `boomy_low @ 100 Hz, red 1.2 × adaptive_scale` (cut)<br>– `muddy_lowmid @ 300 Hz, red 1.5 × adaptive_scale` (cut)<br>– `harsh_highmid @ 3800 Hz, red 1.5` (cut)<br>– `sibilance @ 7500 Hz, red 2.0` (cut)<br>– `vocal_presence @ 2500 Hz, red 1.0` (boost) | LOW + MID + HIGH |
| 04 | **Compressor** | `dynamics.py:build_dynamics_filter` | `acompressor threshold=-14 / ratio=2.0 (vocal-protection clamped) / attack=25 ms / release=100 ms / makeup=0.7 dB / knee=5.0` | broadband |
| 05 | **Saturation** | `effects.py:saturation_filter` | `compand` transfer curve, amount=0.25 → minor 짝수 차 고조파 | broadband |
| 06 | **Stereo Width** | `effects.py:stereo_width_filter` | `extrastereo m=1.10` | sides only (mid/side ratio) |
| 07 | **Soft Clipper (pre)** | `effects.py:soft_clipper_filter` | `compand` transfer curve, ceiling=target_tp | broadband |
| 08 | **Entry Gain** | `pipeline.py` static chain | `volume = +6 dB` (clamped, was +24 in pre-v3.4.6) | broadband |
| 09 | **Soft Clipper (post)** | `effects.py:soft_clipper_filter` | (다시) compand transfer curve | broadband |
| 10 | **Limiter** | `ffmpeg_wrapper.py:apply_limiter` | `alimiter level_in=+0.5 dB (clamped) / limit=target_tp − 0.3 / attack=3 / release=60 / asc=0` | broadband |
| 11 | **(post)** Correction Pass | `pipeline.py` | `volume + soft-clip + alimiter` if LUFS off target | broadband |
| 12 | **(post)** ISP Safety | `isp_safety.py` | static down-gain if 4× oversample ISP > ceiling | broadband |
| 13 | **(post)** Final Tonal Guard (v3.4.7) | `pipeline.py:_apply_final_tonal_guard` | corrective EQ (max ±1.5 dB) + alimiter when `lowEnergyRatio` 또는 tilt 가 envelope 밖 | LOW + AIR |

### 한 band 가 몇 번 건드려지는가

| Band | 건드리는 stage | 횟수 |
|------|----------------|:---:|
| LOW (20–200 Hz) | 01, 02, 03, 04, 08, 10, 13 | **7** |
| MID (200–4 kHz) | 01, 02, 03, 04, 08, 10 | **6** |
| HIGH (4–12 kHz) | 01, 02, 03, 04, 08, 10 | **6** |
| AIR (12–18 kHz) | 01, 04, 08, 10, 13 | **5** |

→ **모든 band 가 5번 이상 건드려짐.** 사용자 가이드의 "동일 band 는
최대 2번만" 원칙 (#6) 을 정면으로 위반.

---

## 2. Cumulative Band Impact — 측정된 실제 데이터

> 모든 값은 입력 대비 cumulative ΔdB (각 stage 까지 누적 적용 후
> band RMS − 입력 band RMS).
>
> 측정 방식: 동일 chain 을 stage 단위로 분리 ffmpeg 호출 → soundfile
> FFT 로 4 band RMS 측정.  Tool: `docs/scripts/cumulative_chain_analysis.py`.
>
> ⚠️ 이번 측정 환경에서 `adynamicequalizer` 프로브 timeout 으로
> Dynamic EQ 가 **static fallback** (60% reduction, 항상 작동) 으로
> 실행되었음.  Production (적절한 ffmpeg 6.x+) 에선 dynamic 경로가
> 사용되어 LOW/HIGH 손실은 입력 band 가 threshold 이상일 때만 발생.
> **두 경로 모두 같은 아키텍처 결함을 드러내므로 분석은 여전히 유효함.**

### 2A. Bass-heavy 입력 (low=−19, mid=−31, air=−43 dBFS)

| Stage | LOW Δ | MID Δ | HIGH Δ | AIR Δ |
|-------|------:|------:|-------:|------:|
| 00_INPUT | +0.00 | +0.00 | +0.00 | +0.00 |
| 01_BASE_EQ | +1.67 | −0.82 | +0.63 | +1.46 |
| 02_OVERLAY_EQ | +1.40 | −0.53 | +1.13 | +1.57 |
| 03_DYNAMIC_EQ | +0.46 | −0.91 | +0.53 | +1.51 |
| 04_COMPRESSOR | +1.14 | −0.35 | +1.21 | +2.19 |
| 05_SATURATION | (no-op) | | | |
| 06_STEREO | (no-op) | | | |
| 07_SOFTCLIP_PRE | (no-op) | | | |
| 08_ENTRY_GAIN | +7.14 | +5.65 | +7.21 | +8.19 |
| 10_LIMITER | **+8.93** | **+7.27** | **+9.00** | **+9.98** |

**Final tilt (AIR − LOW) = +1.05 dB** ≈ 균형 OK.
**MID 가 1.7 dB 뒤쳐짐** (다른 band 가 +9, MID 만 +7.3)  → 보컬 영역 상대적 손실.

### 2B. Bass-light 입력 (low=−32, mid=−31, air=−44 dBFS)

| Stage | LOW Δ | MID Δ | HIGH Δ | AIR Δ |
|-------|------:|------:|-------:|------:|
| 00_INPUT | +0.00 | +0.00 | +0.00 | +0.00 |
| 01_BASE_EQ | +1.18 | −0.40 | +0.63 | +1.46 |
| 02_OVERLAY_EQ | +1.44 | +0.18 | +1.14 | +1.57 |
| **03_DYNAMIC_EQ** | **−9.09** | **+2.73** | **−6.91** | +0.15 |
| 04_COMPRESSOR | −8.44 | +2.18 | −6.26 | +0.80 |
| 08_ENTRY_GAIN | −2.44 | +8.09 | +0.86 | +6.81 |
| 10_LIMITER | **−0.68** | **+8.26** | **+1.63** | **+8.57** |

**Final tilt = +9.25 dB. 텔레폰 사운드 구조적으로 보장.**
**LOW 는 거의 변화 없음 (−0.68), MID 는 +8.26 — 8.94 dB 격차.**
Stage 03 의 −9.09 dB 가 단일 origin.

### 2C. Realistic 샘플 (`/tmp/ab_test/input.wav`)

| Stage | LOW Δ | MID Δ | HIGH Δ | AIR Δ |
|-------|------:|------:|-------:|------:|
| 00_INPUT | +0.00 | +0.00 | +0.00 | +0.00 |
| 01_BASE_EQ | +1.86 | −0.98 | +0.51 | +1.42 |
| 02_OVERLAY_EQ | +1.86 | −0.76 | +1.28 | +1.62 |
| **03_DYNAMIC_EQ** | **−10.10** | −2.19 | **−8.01** | +0.08 |
| 04_COMPRESSOR | −9.42 | −1.93 | −7.33 | +0.76 |
| 08_ENTRY_GAIN | −3.42 | +4.07 | −1.32 | +6.76 |
| 10_LIMITER | **−1.65** | **+5.07** | **+0.60** | **+8.54** |

**Final tilt = +10.19 dB.  심각한 텔레폰 사운드.**

### Per-stage step (가장 큰 영향력 있는 stage 식별)

| Stage | 평균 |Δ| (3 입력) | 평가 |
|-------|:------------------:|-----|
| 01_BASE_EQ | 0.95 dB | 적절 |
| 02_OVERLAY_EQ | 0.36 dB | 매우 작음 |
| **03_DYNAMIC_EQ** | **3.95 dB** (~10 dB on LOW/HIGH) | **critical disruptor** |
| 04_COMPRESSOR | 0.65 dB | 적절 |
| 05–07 SATURATION/STEREO/SOFTCLIP | ~0 dB | 사실상 no-op |
| 08_ENTRY_GAIN | +6.00 dB (broadband) | 의도된 |
| 09_SOFTCLIP_POST | 0.05 dB | 효과 미미 |
| 10_LIMITER | +1.7 dB (broadband) | 정상 |

→ **stage 03 (Dynamic EQ) 가 다른 모든 stage 합친 것보다 큰 tonal 영향.**

---

## 3. 알고리즘 문제 진단

### 문제 #1 — Dynamic EQ 가 *tonal shaping* 을 하고 있다

**위치**: `dynamic_eq.py` — `boomy_low`, `muddy_lowmid`, `harsh_highmid`,
`sibilance` 4 개 cut band.

**원인**:
- 사용자 가이드 #5 ("Dynamic EQ: resonance control ONLY") 위반.
- 현재 dynamic EQ 가 *항상 작동*하는 cut filter 처럼 사용됨 (특히
  static-fallback 시).  실제 dynamic 경로에서도 threshold 가 낮으면
  almost-always-on 동작.
- 결과: stage 03 단독으로 LOW 9 dB / HIGH 8 dB 손실.

**영향**:
- bass-light 입력에서 LOW 가 추가로 -9 dB → 텔레폰 사운드 직접 원인.
- 이미 어두운 입력에서 HIGH 추가 cut → "답답한 사운드".
- vocal_presence boost 와 harsh_highmid cut 이 *같은 영역* (3.8 / 2.5 kHz)
  에서 충돌 → 보컬 톤 일관성 저해.

**해결 방향**:
- Dynamic EQ 를 *resonance suppression* 전용으로 격하.
- threshold 를 훨씬 높여서 (= dB 기준 -8~-10) 평균 신호에서는
  거의 작동 안 하도록.  이상 피크에서만 발동.
- `boomy_low`, `muddy_lowmid` 를 **default OFF** 로 두고, 입력 분석
  결과 "boomy" 가 실제로 검출될 때만 활성화.
- `sibilance` 도 vocal-protection 단계에서 처리하도록 일원화.

### 문제 #2 — 동일 band 가 4–7 stage 에서 중복 처리

**위치**: 전 chain.

**원인**:
- Base EQ + Adaptive Overlay 가 모두 LOW(80~120 Hz) 를 boost.
- Base EQ + Dynamic EQ 가 모두 LOW(250~300 Hz) 를 cut.
- Base EQ + Adaptive Overlay 가 모두 air (10k~12k) 를 boost.

**영향**: 누적 효과 예측 불가.  bass-heavy 시 +3 dB 누적 boost 가능,
bass-light 시 −5 dB 누적 cut 가능.

**해결 방향**: stage 별로 *주체* 를 명확히 분리:
- LOW shaping → **Adaptive Base EQ 단독** 주체
- LOW resonance suppression → **Dynamic EQ 단독** 주체 (resonance 검출 시에만)
- HIGH shaping → **Adaptive Base EQ 단독** 주체
- HIGH enhancement (sheen) → **Overlay 단독** 주체

### 문제 #3 — Limiter 가 broadband 으로 noise floor 까지 끌어올린다

**위치**: stage 10 alimiter.

**원인**: limiter 는 본질적으로 broadband — peak 만 누르고 RMS 는 모든
band 가 고르게 상승.  AIR band 가 입력에서 가장 조용하면 limiter
gain (+1.7 dB) 이 가장 두드러져 보임.

**영향**: AIR band 가 입력 -45 dBFS → 출력 -36 dBFS → tilt +9 dB 인플레이션.
이건 limiter 의 정상 동작이지만 사용자 인지에는 "고역 부각".

**해결 방향**:
- pre-limiter 단계에서 AIR 가 너무 차이 안 나게 *적절히 채워둔다*
  (입력이 어두우면 base EQ air shelf 를 더 강하게 — 이미 adaptive 임).
- post-limiter 에서 tilt 가 +4 dB 초과면 high-shelf trim (이미
  v3.4.7 final guard 에 있음, 보정량 ±1.5 dB 한도가 작음).
- 보정 한도를 ±2.5 dB 로 확장하고 더 정밀한 측정 기준 적용.

### 문제 #4 — Entry gain 이 broadband 이라 imbalance 를 보존

**위치**: stage 08 `volume = +6 dB`.

**원인**: 전 band 에 +6 dB 동등 적용.  Pre-stage 에서 발생한 imbalance
가 그대로 limiter 까지 전달됨.

**영향**:
- bass-heavy: stage 04 까지 LOW=+1.14, MID=−0.35, HIGH=+1.21, AIR=+2.19
  → 6 dB push 후 LOW=+7.14, MID=+5.65 (여전히 1.5 dB 격차).
  → limiter 후에도 격차 유지.

**해결 방향**: entry gain 을 broadband 으로 두되, **gain 직전에**
tonal balance pre-correction 을 둠.  즉:
1. Stage 4 (compressor) 까지 정확한 tonal 측정
2. tilt > +2 면 미리 high-shelf trim
3. 그 다음 entry gain
4. 그 다음 limiter

### 문제 #5 — Saturation / Stereo / Soft-clip-pre 가 사실상 no-op

**위치**: stage 05–07.

**원인**: 측정 결과 LOW/MID/HIGH/AIR ΔdB = 0.00.  Saturation 0.25 는
짝수 고조파를 만들지만 RMS 영향이 매우 작음 (peak shaping 만).
Stereo width 는 mid/side ratio 만 변경 — mono mix 측정엔 안 잡힘.

**영향**: 자체로는 문제 아니지만 chain 길이만 늘림.  ffmpeg 호출 비용
(filter graph build) 만 추가됨.

**해결 방향**:
- 효과가 거의 없는 stage 는 skip 하거나 통합.
- saturation 을 compressor "knee" 로 흡수 (acompressor knee 값을 키워서
  암묵적 saturation 효과 얻음).
- stereo width 는 limiter 직전에 단독 stage 로 두는 게 부적절 — sides
  가 limiter 에 의해 다시 좁혀질 수 있음.  post-limiter 로 옮기는 것
  검토.

### 문제 #6 — Soft clipper 가 두 번 작동 (pre + post entry gain)

**위치**: stage 07 + stage 09.

**원인**: 첫 번째 soft clip 은 entry gain 이전, 두 번째는 entry gain
직후.  의도는 이해되지만 *동일 transfer curve* 가 두 번 적용되는데
입력 레벨이 다르므로 효과가 비대칭.

**영향**: pre soft-clip 은 매우 작은 효과 (입력이 −22 dB 수준이라
−3 dB 임계 안 넘음), post soft-clip 만 실제 효과.

**해결 방향**:
- pre soft-clip 제거.  post soft-clip 단독으로 운영 → chain 단순화.

### 문제 #7 — Final tonal guard 가 한도가 너무 낮음

**위치**: stage 13 `_build_tonal_correction_chain`.

**원인**: 보정량이 max ±1.5 dB.  그러나 측정 데이터에서 tilt 가
+9~+10 dB 까지 나오므로 ±1.5 dB 보정으로는 ~10 % 만 회복 가능.

**영향**: bass-light / realistic 케이스 모두 보정 후에도 여전히
"warn" 또는 "danger" verdict 발생 (v3.4.7 smoke test 결과 확인됨).

**해결 방향**:
- 보정 한도 ±2.5 dB 로 확장 (최대 ±3 dB 까지 case-by-case).
- 단일 corrective pass 가 아닌 *2-band targeted* (low + high 동시 보정).
- 더 중요한 건 *pre-limiter 단계 자체를 잘 만들어서* final guard 가
  큰 보정을 안 하도록 하는 것.

### 문제 #8 — vocal_presence boost 와 harsh_highmid cut 충돌

**위치**: stage 03 dynamic_eq presets.

**원인**: 같은 영역(2.5–3.8 kHz) 에서 한 쪽은 +1 dB boost, 다른 쪽은
−1.5 dB cut.  threshold 차이로 시간적으로 alternating 발생 → 보컬
톤이 펌핑.

**영향**: 측정상 미세하지만 청감으로 나타날 수 있음.

**해결 방향**: 둘 중 하나만 선택.  v3.5 권장: **harsh_highmid 제거**,
vocal_presence 만 유지.  harsh-mid 톤은 base EQ 의 250 Hz mud cut 으로
이미 정리되고 있음.

### 문제 #9 — Static fallback 이 dynamic 보다 더 공격적

**위치**: `dynamic_eq.py:_fallback_band` — `static_gain = -reduction * 0.6`.

**원인**: dynamic EQ 가 **항상 작동**하는 static EQ 60 % 로 변환됨.
Dynamic 은 threshold 이상일 때만 작동하는데 static 은 항상 작동.
LOW 가 boomy_low (−1.5 dB × 0.6 = −0.9 dB) + muddy_lowmid (−1.5 × 0.6
= −0.9 dB) = **항상 −1.8 dB 손실**.

bass-light 입력에선 측정상 −9 dB 까지 손실 (입력 LOW 가 -32 dB,
filter Q 가 좁아서 spectral leakage + EQ 보정).

**해결 방향**: static fallback 의 strength 를 60 % → 25 % 로 낮춤.
또는 fallback 을 **완전 비활성화** (dynamic 없으면 dynamic EQ 자체가
no-op).

### 문제 #10 — Pre-limiter tonal balance 를 측정하지 않음

**위치**: pipeline.py.

**원인**: 현재 tonal balance 측정은 *post-limiter* (gain_staging.py
가 input vs final output 비교).  limiter 직전 band 측정값이 없음.

**영향**: limiter 가 imbalance 를 *왜곡* 시키는지, *유지* 시키는지,
*개선* 시키는지 확인 불가.  결과 분석만 가능, 원인 추적 어려움.

**해결 방향**: pre-limiter 임시 WAV 시점에 band 측정 포인트 추가.
DebugRecorder 의 `events` 에 stage 별 band snapshot 기록.

---

## 4. 새 아키텍처 — "Target-based Mastering"

### 4A. 목표 정의

```
TARGET_LOW_ENERGY_RATIO    = (0.85,  1.15)      ideal
                              [0.75,  1.30]      acceptable
TARGET_HIGH_LOW_TILT_DB    = (−2.0, +2.0)       ideal
                              [−4.0, +4.0]      acceptable
TARGET_LUFS                =  −9.0  (kpop_loud) / −14 (streaming)
TARGET_TRUE_PEAK           =  −1.0  dBTP
```

Pre-stage 정의값 (사용자 가이드 #4 그대로).

### 4B. 새 stage 흐름 (제안)

```
┌─────────────────────────────────────────────────────────────────────┐
│  Phase A — Analysis (no audio rendering)                            │
│    1. 입력 분석 (waveform / spectral / loudness)                    │
│    2. target profile 산출 (style preset + adaptive)                 │
│    3. delta budget 계산 (각 band 가 얼마나 이동해야 하는지)         │
└────────────────────────────────────────┬────────────────────────────┘
                                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Phase B — Tonal Shaping (단 1번의 ffmpeg pass, no compression)     │
│    Stage T1: Adaptive corrective EQ                                 │
│      · 모든 base EQ + overlay 를 합쳐 *하나의* EQ 결정              │
│      · 입력별 deltas 기준 단일 결정값 (중복 없음)                   │
│      · LOW/MID/HIGH/AIR 각각 1개의 EQ move 만 허용                  │
└────────────────────────────────────────┬────────────────────────────┘
                                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Phase C — Resonance Control (optional, threshold-driven)           │
│    Stage T2: Dynamic EQ for *peak suppression only*                 │
│      · threshold 가 매우 높음 (-8 ~ -10 dB)                         │
│      · 이상 피크에서만 발동                                         │
│      · default reduction 0.5–1.0 dB (was 1.5–2.5)                   │
│      · static fallback 없음 (dynamic 미가용 시 stage 자체 skip)     │
└────────────────────────────────────────┬────────────────────────────┘
                                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Phase D — Glue Compression (broadband, gentle)                     │
│    Stage T3: Broadband compressor (vocal-protected)                 │
│      · ratio ≤ 2.0 / attack ≥ 25 / makeup ≤ 0.7 dB (이미 적용)      │
│      · Saturation 을 knee 로 흡수 (knee 8.0 → 12.0)                 │
│        → 별도 saturation stage 제거                                 │
└────────────────────────────────────────┬────────────────────────────┘
                                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Phase E — Pre-limiter Tonal Pre-correction (NEW)                   │
│    Stage T4: Measure post-comp band balance                         │
│      · Render → temp WAV → measure 4 bands                          │
│      · Compute tilt vs target                                       │
│      · If tilt > +2: apply high-shelf trim BEFORE entry gain        │
│      · If tilt < −2: apply high-shelf lift BEFORE entry gain        │
│      · Max ±2.0 dB single-shelf correction                          │
└────────────────────────────────────────┬────────────────────────────┘
                                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Phase F — Loudness Match (broadband)                               │
│    Stage T5: Entry gain (clamped ±6 dB)                             │
│    Stage T6: Soft clipper (single instance, post-gain)              │
│    Stage T7: Limiter (peak safety only, level_in ≤ +0.5 dB)         │
│    Stage T8: Stereo width (POST-limiter — sides not compressed)     │
└────────────────────────────────────────┬────────────────────────────┘
                                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Phase G — Final Verification + Auto-correction                     │
│    Stage T9:  Measure output                                        │
│    Stage T10: Correction pass (LUFS off-target only)                │
│    Stage T11: ISP safety                                            │
│    Stage T12: Final tonal guard (corrective EQ, ±2.5 dB max)        │
└─────────────────────────────────────────────────────────────────────┘
```

### 4C. Stage 역할 재정의 (사용자 가이드 #5 적용)

| Stage | 역할 (단일 책임) | 금지 사항 |
|-------|------------------|-----------|
| T1 Adaptive Corrective EQ | tonal shaping (입력 → 목표) | resonance 처리 / dynamic 처리 |
| T2 Dynamic EQ | resonance/peak suppression only | tonal shaping (낮은 threshold 금지) |
| T3 Compressor | glue (peak/RMS 균일화) | tonal shaping / loudness push |
| T4 Pre-limiter Pre-correction | tilt 사전 평탄화 | gain 만 변경 (no compression) |
| T5 Entry Gain | loudness match (broadband) | tonal change 절대 금지 |
| T6 Soft Clip | peak rounding | RMS change 거의 없음 |
| T7 Limiter | peak ceiling safety | tone shaping 절대 금지 |
| T8 Stereo Width | sides processing | center/mono 변화 금지 |
| T9–T12 | verification + last-mile correction | over-correction (loop 금지) |

### 4D. 중복 제거 규칙 (사용자 가이드 #6)

| Band | 주체 stage | 보조 stage (미세 조정) | 금지 |
|------|-----------|----------------------|------|
| LOW (20–200 Hz) | **T1 (Base EQ adaptive)** | T12 (final guard ±1 dB) | T2 (boomy_low 항상 작동) |
| MID (200–4 kHz) | **T1 (Base EQ adaptive)** | — | T2 (harsh_highmid) |
| HIGH (4–12 kHz) | **T1 (Base EQ + adaptive overlay)** | T4 pre-correction shelf | duplicate boost |
| AIR (12–18 kHz) | **T1 (high shelf adaptive)** | T12 (final guard ±1 dB) | post-limiter 큰 변화 |

### 4E. 강화된 Final Tonal Guard (사용자 가이드 #7)

| 조건 | 보정 (max amount) | 한도 |
|------|-------------------|------|
| `lowEnergyRatio < 0.75` | 90 Hz warmth bell `+0.5 ~ +2.0 dB` | 1회만, 루프 금지 |
| `lowEnergyRatio > 1.30` | 100 Hz shelf trim `−0.5 ~ −1.5 dB` | 1회만 |
| `highLowTiltDb > +4` | 10 kHz high-shelf `−0.5 ~ −2.5 dB` | 1회만 |
| `highLowTiltDb < −4` | 8 kHz high-shelf `+0.5 ~ +1.5 dB` | 1회만 |
| **2개 동시 발동** | warmth + high-shelf 동시 적용 | 단일 ffmpeg pass |
| **3개 이상 동시** | 보정 포기 + warning escalate | 사용자에게 mode 변경 권장 |

---

## 5. 디버그 리포트 (사용자 가이드 #8)

새 아키텍처에서 결과 dict 에 추가될 필드:

```json
{
  "tonalAnalysis": {
    "stagesTable": [
      {
        "stage": "T1_ADAPTIVE_EQ",
        "bandsBefore": {"LOW": -22.0, ...},
        "bandsAfter":  {"LOW": -19.5, ...},
        "deltaDb":     {"LOW":  +2.5, ...},
        "filterApplied": "equalizer=...",
        "appliedGainDb": 2.5
      },
      ...
    ],
    "cumulativeBandTable": [...],
    "appliedCorrections": [
      "Adaptive EQ low +2.0 dB",
      "Pre-limiter shelf trim -1.0 dB",
      "Final guard warmth +0.5 dB"
    ],
    "warningCodes": ["TELEPHONE_SOUND", "TONAL_GUARD_APPLIED"],
    "finalTonalMetrics": {
      "lowEnergyRatio": 0.92,
      "highLowTiltDb": +1.5,
      "verdict": "ok"
    }
  }
}
```

### 콘솔 로그 (요약)

```
[chain][kpop_loud] Stage T1: LOW +2.5 / MID -0.8 / HIGH +0.6 / AIR +1.5
[chain][kpop_loud] Stage T2: (no resonance peaks) — skip
[chain][kpop_loud] Stage T3: LOW +0.7 / MID +0.3 / HIGH +0.7 / AIR +0.7
[chain][kpop_loud] Stage T4: tilt +1.2 dB → no pre-correction needed
[chain][kpop_loud] Stage T5: +6.0 dB broadband
[chain][kpop_loud] Stage T7: limiter pulled +1.8 dB broadband
[chain][kpop_loud] Final: LOW +11.0 / MID +9.6 / HIGH +11.1 / AIR +12.0
[chain][kpop_loud] tilt = +1.0 dB / lowEnergyRatio = 1.05 / verdict = ok
```

---

## 6. 테스트 매트릭스 (사용자 가이드 #9)

| 입력 종류 | 검증 항목 | 합격 기준 |
|-----------|----------|----------|
| 저역 강한 트랙 | LOW 과다 방지 | `lowEnergyRatio < 1.30` |
| 저역 약한 트랙 | 텔레폰 사운드 방지 | `lowEnergyRatio > 0.75` 또는 final guard 작동 |
| 이미 밝은 트랙 | HIGH 과다 방지 | `highLowTiltDb < +4 dB` |
| 어두운 트랙 | 답답함 방지 | `highLowTiltDb > −4 dB` |
| 모노 입력 | stereo 처리 안전 | 출력 stereo correlation > 0.9 |
| 미마스터링 demo | over-push 방지 | LRA 손실 < 70 % |
| 모든 입력 공통 | LUFS 도달 | `|output_lufs − target| < 1.5 dB` |
| 모든 입력 공통 | TP 안전 | `output_tp ≤ target_tp + 0.1` |

---

## 7. 결론 — Before vs After 구조 비교

### Before (v3.4.7 현재)

```
Input → BaseEQ → Overlay → DynEQ → Comp → Sat → Stereo
      → SoftClipPre → Volume(+6) → SoftClipPost → Limiter
      → Correction → ISP → Final Guard
```

- 13 stage, LOW band 7 stage 에서 건드림
- 측정상 final tilt 입력별 +1 ~ +10 dB 흔들림
- Dynamic EQ 가 단일 stage 로 LOW −10 dB

### After (v3.5 제안)

```
Input → [Phase A: analyze] → [Phase B: T1 single corrective EQ]
      → [Phase C: T2 resonance only (often skip)]
      → [Phase D: T3 glue comp w/ saturation absorbed]
      → [Phase E: T4 measure → pre-correction shelf]
      → [Phase F: T5 volume → T6 soft-clip → T7 limiter → T8 stereo]
      → [Phase G: T9 measure → T10/T11/T12 corrections]
```

- 8 active processing stage (+ 4 verification)
- 동일 band 최대 2 stage
- pre-limiter 측정 포인트 2개 (T4 직전, T7 직후)
- final tilt 목표: ±2 dB 이내 (모든 입력)

### 영향 추정 (재구현 후)

| 메트릭 | v3.4.7 (측정) | v3.5 목표 |
|--------|--------------:|----------:|
| stage 개수 | 13 | 8 active |
| LOW band touch 수 | 7 | 2 |
| final tilt 분산 (3 입력) | +1 ~ +10 dB | ±2 dB 이내 |
| Dynamic EQ 영향 | −10 dB (worst) | ±1 dB 이내 |
| 텔레폰 사운드 가능성 | 입력에 따라 발생 | 구조적으로 방지 |

---

## 8. 진행 상황 (2026-05-04 기준)

### ✅ Phase 1 완료 — commit b9b824e

1. ✓ Dynamic EQ fallback 60 → 25, 단일-band ±1.5 dB cap
2. ✓ `range` ffmpeg unit 버그 수정 (linear factor)
3. ✓ Saturation → compressor knee 흡수
4. ✓ Pre soft-clip 정리 (single instance)
5. ✓ Final tonal guard ±1.5 → ±2.5 dB
6. ✓ alimiter `level=disabled` + `asc=0` 버그 수정

### ✅ Phase 2 완료 — commit (current)

1. ✓ **T1 Adaptive Corrective EQ** — `build_kpop_loud_corrective_eq()`
   base EQ + overlay 를 단일 spectrum-driven 함수로 통합 (5 EQ moves max)
2. ✓ **Pre-limiter 4-band measurement** — LOW/MID/HIGH/AIR 각각 분리 추적
3. ✓ **Pre-correction shelf 정밀화** — 고정 multiplier → math 기반 target
   convergence (`gain_for_band_change()` 로 effectiveness 보정)
4. ✓ **Tonal budget 시스템** — `app/mastering/tonal_budget.py` —
   per-stage 허용 변화량 + target spec
5. ✓ **Final guard 1-pass 수렴** — low + high 동시 해 (math)

### 측정 결과 — Phase 1 → Phase 2 비교

| 입력 | 메트릭 | v3.4.7 | Phase 1 | **Phase 2** |
|------|-------|------:|--------:|------------:|
| bass-heavy | lowEnergyRatio | 0.70 | 1.183 | **0.942** ✓ |
| bass-heavy | tilt | +1.05 | +3.79 | **+1.46** ✓ |
| bass-light | lowEnergyRatio | 0.853 | 1.225 | **1.138** ✓ |
| bass-light | tilt | +9.25 | +3.23 | **+1.98** ✓ |
| realistic  | lowEnergyRatio | 0.815 | 1.172 | **1.081** ✓ |
| realistic  | tilt | +10.19 | +3.58 | **+1.60** ✓ |

**Phase 2 결과: 모든 입력에서 ratio 및 tilt 가 IDEAL 범위 내에 들어옴.**
- ratio: target 0.85–1.15 → 모든 입력 0.94–1.14 ✓
- tilt: target ±2 dB → 모든 입력 ±1.5–2.0 dB ✓

### Phase 3 (큰 변경, 추후 진행 시)
- Stereo width → post-limiter 재배치
- Multi-band parallel processing (acrossover)
- Real-time spectrum monitoring

---

## Appendix — 측정 도구

`docs/scripts/cumulative_chain_analysis.py` — 현재 chain 을 stage 단위
로 분리해 ffmpeg 호출하고 4 band RMS 측정.  본 분석의 모든 수치는 이
도구로 재현 가능.

```
python3 docs/scripts/cumulative_chain_analysis.py <input.wav>
```

출력: stage 별 cumulative band ΔdB 표 + per-stage step ΔdB 표.
