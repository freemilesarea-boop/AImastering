# M1.75 — Profile Comparison Metrics

> 본 문서는 `compare_profiles(A, B)` 의 metric 정의와 weighting 결정을 정리한다.
> 코드: `app/profiling/compare.py`.

---

## 1. 입력 → 출력

```
입력:  profile_A (source — user's pre-master), profile_B (target — reference)
출력:  ProfileComparison {
         axes: { name → AxisDelta },
         spectrumDeltaDb: { bin → (target − source) },
         overallSimilarity01: 0..1,
         labels: { loudness, dynamics, tone, stereo }
       }
```

---

## 2. Per-axis delta

각 axis (총 15개) 는:

```
delta         = target − source                  # signed
similarity01  = 1 / (1 + (|delta| / scale)²)    # 0..1
```

`scale` = "50% similarity 가 나오는 거리" — axis 별 정의된 상수.

| Axis | Unit | Scale (50%) | 근거 |
|---|---|---:|---|
| `lufsI`             | LUFS    | 4.0   | 4 LU 차이 = 절반의 유사도 |
| `tpDb`              | dB      | 3.0   | 마진성 — peak control 차이 |
| `lra`               | LU      | 3.0   | dynamic-range 단위 |
| `crestDb`           | dB      | 3.0   | crest 변동 |
| `transientDensity`  | ev/min  | 60.0  | onset 밀도 차이 |
| `compressionScore`  | score   | 0.25  | 0..1 범위 → 4분의1 |
| `spectralTilt`      | dB/oct  | 1.5   | 톤 기울기 1.5 dB/oct = 노이즈 영역 |
| `subEnergy`         | ratio   | 0.10  | 10% ratio swing |
| `lowMidBalance`     | dB      | 3.0   | 톤 균형 |
| `vocalRegionEnergy` | dB      | 3.0   | 보컬 강조 차이 |
| `airBandEnergy`     | dB      | 3.0   | 에어 차이 |
| `harshnessIndex`    | index   | 1.5   | 1.5 만큼이면 명백한 difference |
| `correlationMean`   | corr    | 0.30  | 코릴레이션 |
| `msRatioDb`         | dB      | 4.0   | MS 에너지 비 |
| `stereoWidthIndex`  | index   | 0.40  | 종합 width |

**원칙**: scale 은 "이 정도 차이면 청취자가 알아챌 수 있는 수준" 의 근사. 데이터 기반 (사용자 청취 테스트) 으로 향후 재조정 — `data-driven scaling` 백로그 (P3).

---

## 3. Spectrum delta

```
for cf in 1/3-oct centres:
  spectrum_delta[cf] = target.spectrum_db[cf] − source.spectrum_db[cf]
```

per-bin signed dB. 30 bin 만큼만 — 단순 dictionary.

추후 derived metric (M2+):
- `spectrum_rms_delta_db` = RMS of all bin deltas
- `spectrum_max_delta_db` = max(|delta|)
- `spectrum_smoothness_match` = correlation between two spectra (shape similarity)

---

## 4. 종합 유사도 (overall similarity)

```
overall = Σ wᵢ · similarity01ᵢ / Σ wᵢ
```

| Axis | Weight | 근거 |
|---|---:|---|
| lufsI | **1.5** | 라우드니스 = 가장 청취 직결 |
| tpDb | 0.5 | TP 는 마진 / 안전 영역 — 청취 영향 적음 |
| lra | 1.0 | 다이내믹 인지 |
| crestDb | 1.0 | 위 보충 |
| compressionScore | 1.0 | LRA 와 부분 중복이지만 perceptual 종합 |
| transientDensity | 0.3 | 보조 |
| spectralTilt | **1.2** | 톤의 큰 줄기 |
| subEnergy | 0.8 | 저역 균형 |
| lowMidBalance | 0.8 | |
| vocalRegionEnergy | 0.8 | |
| airBandEnergy | 0.8 | |
| harshnessIndex | 0.8 | |
| correlationMean | 0.5 | |
| msRatioDb | 0.5 | |
| stereoWidthIndex | 0.7 | |

**해석 가이드**:

| Overall | 의미 |
|---|---|
| ≥ 0.85 | 매우 유사 — 두 프로파일이 같은 character class |
| 0.65–0.85 | 같은 family (e.g. 둘 다 loud streaming master) |
| 0.45–0.65 | 같은 장르 그룹 안 |
| < 0.45 | 다른 character |

---

## 5. Categorical labels

각 axis 그룹에서 사용자-친화 label 추출:

```python
loudness_label = "louder" / "quieter" / "matched"  if |Δ LUFS| > 1.5
dynamics_label = "more-compressed" / "more-dynamic" / "matched"  if |Δ compression| > 0.15
tone_label     = "brighter" / "darker" / "matched"  if |Δ tilt| > 0.7 dB/oct
stereo_label   = "wider" / "narrower" / "matched"  if |Δ width| > 0.3
```

threshold 는 "perceptual just-noticeable difference" 근사. 사용자가 카드 UI 에서 보는 한 줄 텍스트의 직접 소스 (M3+ UI).

---

## 6. 보호 / 안전 (sanity 테스트)

`test_reference_profiling.py` 의 보호:

1. **self-similarity = 1.0** — 같은 profile 끼리 비교하면 모든 axis 의 similarity 가 1.
2. **acoustic vs ai-harsh** — 명백히 다른 두 fixture 의 overall < 0.85.
3. **labels 가 명확한 사례 검증** — `loudness == "louder"` 확인.

---

## 7. 미구현 / 후속 개선

| 항목 | 우선순위 | 비고 |
|---|---|---|
| User-tunable weights | P3 | UI 에서 사용자가 "loudness 우선" / "tone 우선" 선택 |
| Perceptual scaling (psychoacoustic) | P3 | scale 을 데이터 기반으로 학습 |
| Multi-reference 평균 | P2 | 사용자가 3-5 곡 reference 묶음 → 평균 profile |
| 시계열 변환 거부 검출 | P2 | profile-as-input 이 mid-fingerprint 처럼 들어오는지 가드 |
