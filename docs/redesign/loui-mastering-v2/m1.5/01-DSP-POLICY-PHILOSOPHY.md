# M1.5 — DSP 정책 / 타겟 철학

> "balanced / loud / punch / warm" 가 실제로 **어떤 사운드** 를 의미하는지 정량화한다.
> 본 문서는 본 리포에서 "좋은 사운드" 의 객관적 정의이며, 모든 fixture 의 target metrics 와 모든 preset 의 정책 필드의 근거가 된다.

---

## 1. 원칙

| # | 원칙 | 의미 |
|---|---|---|
| 1 | **"좋은 사운드" 는 청취가 아니라 측정** | 회귀/리뷰는 숫자 위에서만 한다 (LUFS / TP / LRA / spectrum). 청취는 검증의 마지막 단계. |
| 2 | **장르별 타겟** | 모든 곡을 같은 LUFS 로 미는 것은 미신. K-Pop loud 와 jazz acoustic 의 "정답" 은 다르다. |
| 3 | **플랫폼 미들웨어를 인정** | Spotify/YouTube/Apple 의 라우드니스 정규화가 마스터링 결과를 후처리한다. 마스터링은 정규화 후 결과까지 고려. |
| 4 | **True-Peak 는 절대선** | 0 dBFS 절대 금지. ITU R BS.1770-4 4× oversample 측정 기준 ceiling 이내. |
| 5 | **LRA 하한이 있다** | 너무 빡빡한 LRA = 다이내믹 죽임. 장르별 최저선 강제. |
| 6 | **보컬은 보호된다** | vocal protection 정책이 모든 다이내믹 처리에 우선. |

---

## 2. 프리셋 철학 (목적 / 비목적)

### 2.1 `natural` — "원본 보존, 방송용"

| 항목 | 값 |
|---|---|
| 의도 | AI 원음 / 라이브 녹음 / 클래식 / 재즈 — 최소 가공. 라우드니스만 정렬. |
| LUFS 타겟 | **−14 LUFS** (Spotify / Apple Music 표준) |
| TP ceiling | −1.0 dBTP |
| LRA 목표 | **8–14 LU** (다이내믹 보존) |
| EQ 철학 | 최소. low-shelf 약 +2 dB / muddiness cut 약 −1 dB. air shelf 약 +2 dB. |
| 컴프 철학 | 글루만. ratio ≤ 1.5, attack ≥ 30 ms. transient 손실 0.5 dB 이하. |
| Saturator | 0 (off). |
| Stereo width | 1.0 (원본). |
| 비목적 | 라우드니스 푸시 / 톤 변형. Loud 가 필요하면 다른 프리셋. |

### 2.2 `balanced` — "범용 스트리밍 발매"

| 항목 | 값 |
|---|---|
| 의도 | Pop / Rock / 가벼운 EDM / 일반 발매. 모든 플랫폼에서 "좋게" 들리는 안전대. |
| LUFS 타겟 | **−12 LUFS** (Spotify 가 −2 dB 깎고 재생, 그래도 음압 OK) |
| TP ceiling | −1.0 dBTP |
| LRA 목표 | **5–10 LU** |
| EQ 철학 | 보통. 사용자 입력의 톤 균형 유지하며 미세 보정. |
| 컴프 철학 | 약~중. ratio 1.6, attack 40 ms. peak GR 2~3 dB. |
| Saturator | 0.2 — 짝수 차 고조파로 글루감. |
| Stereo width | 1.05 — 살짝 넓힘. |
| 비목적 | 너무 라우드 / 너무 클린. |

### 2.3 `bright` — "고역 클래리티, 보컬 선명"

| 항목 | 값 |
|---|---|
| 의도 | Pop / 보컬 중심 곡. air 와 presence 강조. |
| LUFS 타겟 | **−12 LUFS** |
| TP ceiling | −1.0 dBTP |
| LRA 목표 | **5–10 LU** |
| EQ 철학 | air shelf +3.5 dB (12 kHz↑). dynamic sibilance −2.5 dB 자동 대응. |
| 컴프 철학 | balanced 와 동일 ratio, 더 빠른 attack 35 ms. |
| Saturator | 0 — 고역 자극 피함. |
| Deesser | 자동 (air dynamic). |
| Stereo width | 1.10. |
| 비목적 | 어두운 곡을 억지로 밝게 만들기 (사용자 EQ 미세 조정이 필요). |

### 2.4 `warm` — "따뜻한, vintage"

| 항목 | 값 |
|---|---|
| 의도 | 보컬 ballad / acoustic / 록 발라드. 고역 자극 완화. |
| LUFS 타겟 | **−14 LUFS** |
| TP ceiling | −1.0 dBTP |
| LRA 목표 | **8–12 LU** |
| EQ 철학 | mud cut 약화. air shelf +2 dB 만. low-shelf 약 +2 dB. |
| 컴프 철학 | 느린 attack 45 ms / 느린 release 200 ms. "breathe" 감각. |
| Saturator | 0.15 — 살짝 따뜻함. |
| Deesser | enabled (자극 완화). |
| Stereo width | 1.0. |
| 비목적 | 라우드 / 펀치. |

### 2.5 `loud` — "스트리밍-loud"

| 항목 | 값 |
|---|---|
| 의도 | 현대 pop / rock / 일부 EDM. 스트리밍 정규화 후에도 음압 우위. |
| LUFS 타겟 | **−10 LUFS** (Spotify −4 dB 깎아도 −14 LUFS 재생, 평균 발매 수준) |
| TP ceiling | −1.0 dBTP |
| LRA 목표 | **3–7 LU** (다이내믹 일부 희생) |
| EQ 철학 | low-shelf +3 dB, presence +0.6 dB @ 2.5 kHz, air +3 dB. |
| 컴프 철학 | ratio 2.0, attack 18 ms — glue + 음압 받침. |
| Saturator | 0 — knee 9 dB 의 컴프가 saturation 흡수 (v3.5 변경). |
| Stereo width | 1.10. |
| Loudness algo | **static** (loudnorm 우회) — 다이내믹 안정성 ↓ 라우드니스 정확도 ↓ 그러나 단일 패스 (빠름). |
| **알려진 한계** | 다이내믹이 거의 없는 입력 (사인 / drone) 에서 라우드니스 푸시 약함 — `ISSUE-M1-A` 참고. M2 에서 단일 패스 알고리즘 도입 시 해결. |
| 비목적 | natural / ballad 같은 다이내믹 우선 장르. |

### 2.6 `kpop_loud` — "K-Pop modern loud"

| 항목 | 값 |
|---|---|
| 의도 | K-Pop 발매 표준. 강한 sub + vocal-forward + glassy air. |
| LUFS 타겟 | **−9 LUFS** |
| TP ceiling | **−0.8 dBTP** (한국/일본 스트리밍 차트 평균 마스터 기준치) |
| LRA 목표 | **3–6 LU** |
| EQ 철학 | low-shelf +3 dB / presence +0.8 dB / air +3.5 dB. |
| 컴프 철학 | ratio 2.2 (vocal protection 으로 effective 2.0 클램프) / attack 15 ms / makeup 0.7 dB. |
| Saturator | 0 — kpop_loud 도 knee 흡수 (v3.5). |
| Stereo width | 1.10. |
| Loudness algo | static. |
| 비목적 | EDM / hip-hop (장르 다름). 마스터 후 mono fold-down 위험 있는 stereo width 회피. |

### 2.7 `punch` — "타격감, 저역 밀도" (legacy)

| 항목 | 값 |
|---|---|
| 의도 | Hip-Hop legacy / Punk / Garage. 808 / 킥 강조. |
| LUFS 타겟 | **−11 LUFS** |
| TP ceiling | −1.0 dBTP |
| LRA 목표 | **4–8 LU** |
| EQ 철학 | low-shelf +3 dB / sub-bass 보존 / boomy cut 2.5 dB dynamic. |
| 컴프 철학 | ratio 2.0 / attack 20 ms / makeup 0.8 dB. 가장 강한 글루. |
| Saturator | **0.30** — 짝수 차 고조파로 sub-bass 정의. |
| Stereo width | 1.05. |
| 비목적 | ballad / acoustic. |

---

## 3. 카테고리별 fixture 타겟

각 fixture 카테고리의 "good master" 정의 (산업 평균 + Loui 정책 합의):

| Category | LUFS-I | TP max | LRA min/max | Crest | Notes |
|---|---:|---:|---:|---:|---|
| `kpop`            | **−9.0**  | −0.8 | 3 / 6  | ≥ 7 | recommended preset: `kpop_loud` |
| `lofi`            | **−16.0** | −1.0 | 6 / 12 | ≥ 9 | recommended preset: `natural` or `warm` |
| `edm`             | **−8.0**  | −0.5 | 3 / 6  | ≥ 6 | recommended preset: `loud` (M2: `edm`) |
| `hiphop`          | **−10.0** | −1.0 | 4 / 8  | ≥ 7 | recommended preset: `punch` |
| `ballad`          | **−14.0** | −1.0 | 8 / 14 | ≥ 10 | recommended preset: `warm` |
| `acoustic`        | **−16.0** | −1.0 | 10 / 14| ≥ 12 | recommended preset: `natural` |
| `female-vocal`    | **−14.0** | −1.0 | 6 / 10 | ≥ 9 | recommended preset: `bright` |
| `male-vocal`      | **−14.0** | −1.0 | 6 / 10 | ≥ 9 | recommended preset: `balanced` |
| `ai-harsh-mix`    | **−14.0** | −1.0 | 6 / 11 | ≥ 8 | recommended preset: `balanced` (목적: 마스터링이 harsh 입력을 "구해주는가") |
| `broadcast-speech`| **−23.0** | −1.0 | 5 / 12 | ≥ 10 | EBU R128 표준, recommended preset: TBD (M2 의 broadcast 프리셋) |
| `reference-tone`  | (informational only) | | | | sanity test, no policy |

위 수치는 본 리포의 정본이며, fixture metadata JSON 의 `referenceMaster.targetMetrics` 와 일치.

---

## 4. 허용 오차 정책

각 fixture metadata 의 `policy` 블록은 다음을 명시:

| 정책 | 의미 | 기본값 |
|---|---|---|
| `lufsToleranceLu` | 측정 LUFS-I 가 target ± 이 값 이내여야 통과 | **0.5 LU** |
| `tpHardCeiling` | TP 가 target.tpMaxDb 를 초과하면 즉시 실패 (FAIL FAST) | true |
| `spectrumRmsDeltaMaxDb` | 측정 스펙트럼이 target spectrum 의 RMS 거리 이내 | **2.0 dB** (target 있을 때만) |
| `spectrumMaxDeltaMaxDb` | 단일 1/3-oct band 의 최대 |Δ| | **6.0 dB** |

이 정책은 fixture 가 자기 자신을 정의하므로 fixture-by-fixture 로 강화/완화 가능.

예: `ai-harsh-mix` fixture 는 `spectrumMaxDeltaMaxDb: 9.0` 로 완화 — 입력이 harsh 라 처리 후 스펙트럼이 크게 변하므로.

---

## 5. Vocal Protection 정책 우선순위

본 리포의 모든 프리셋에서 vocal protection 은 다음 처리에 **우선** 한다:

1. Bus compressor: ratio ≤ 2.0, attack ≥ 25 ms, makeup ≤ 0.7 dB (vocal-range 1.5–5 kHz 보호)
2. Dynamic EQ: vocal-band cut 최대 2.5 dB 미만
3. Multiband EQ: vocal-band boost 최대 +2.0 dB
4. Pre-limiter entry gain: 6 dB 미만 (vocal_protection.MAX_ENTRY_GAIN_DB)
5. Limiter input gain: +0.5 dB 미만 (vocal_protection.MAX_LIMITER_INPUT_GAIN_DB)

`policies.vocalProtection: 'strict'` 일 때 위 모두 강제.
`'safe'` 는 일부 완화 (specific to mode).
`'off'` 는 무시 (사용자 명시 옵트아웃).

본 정책은 `services/python-audio/app/utils/vocal_protection.py:_VocalProtectionConfig` 에 캡슐화되어 있으며, **변경 시 SemVer 메이저 bump 의무.**

---

## 6. AI-harsh-mix fixture 의 특별한 의도

AI 음악 생성 (Suno / Udio / 자체 모델 등) 출력은 다음 결함을 자주 가진다:

- **3–5 kHz 의 harshness 피크** (vocal sibilance 처럼)
- **60–200 Hz 의 boom / 모드 unbalance**
- **stereo 위상 이슈** (모노 fold-down 시 손실)
- **clipping / brickwall 됨** (이미 마스터링된 것처럼)
- **다이내믹 부족** (LRA < 3)

`ai-harsh-mix` fixture 는 위 문제들을 **인위적으로 합성** 한다. 마스터링 파이프라인이 이런 입력을:

- harsh 피크를 **dynamic EQ 로 누르고**
- boom 을 **multiband 로 정리하고**
- TP 가 0 dB 안 넘게 **limiter 로 제어**

해주는지 검증한다. **AI 마스터링 프로덕트의 마지노선** 이다.

---

## 7. 본 정책의 변경 절차

본 문서의 수치 (§ 3 의 LUFS / TP / LRA 표) 는 EnginePreset / FixtureMetadata 의 정본이다.
변경하려면:

1. 본 문서 PR 작성 (수치 근거 명시 — 산업 데이터 / 사용자 피드백 / 회귀 분석)
2. 영향 받는 fixture metadata JSON 의 `referenceMaster.targetMetrics` 동시 갱신
3. 영향 받는 preset JSON 의 `loudness-norm.targetLufs` 등 동시 갱신
4. 골든 테스트 baseline 재측정 (`pytest tests/test_engine_preset_realmusic.py` 통과)
5. 코드오너 리뷰 (DSP 책임자 + 제품 책임자 + 코드오너)
