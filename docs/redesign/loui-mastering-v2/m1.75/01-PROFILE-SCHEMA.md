# M1.75 — ReferenceProfile JSON Schema (v1) Reference

> 정본 schema 파일: `packages/shared-types/src/profile/reference-profile.schema.json`
> Schema URL: `https://schemas.loui.studio/reference-profile/v1`

---

## 1. 구조 한눈에

```jsonc
{
  "$schema": "https://schemas.loui.studio/reference-profile/v1",
  "id": "ref-pop-modern-01",          // slug
  "version": "1.0.0",
  "provenance": {
    "sourceType": "user-supplied" | "fixture" | "builtin" | "streaming-snapshot",
    "createdAt": "2026-05-19T...",
    "durationSec": 180.0,
    "sampleRate": 44100,
    "channels": 2,
    "extractorVersion": "1.0.0",
    "sourceFileSha256": "abc...",     // OPTIONAL cache key only, may be null
    "userLabel": "client A reference"  // OPTIONAL — user-attached, free-form
    // ★ artist / title / album / lyrics / isrc / mbid → 절대 금지
  },
  "features": {
    "loudness":  { ... },
    "dynamics":  { ... },
    "tonal":     { ... },
    "stereo":    { ... }
  },
  "featureFingerprint": "sha256...",   // SHA-256 of FEATURES dict (not audio)
}
```

---

## 2. `provenance`

| 필드 | 타입 | 필수 | 설명 |
|---|---|---|---|
| `sourceType` | enum | ✓ | user-supplied / fixture / builtin / streaming-snapshot |
| `createdAt` | ISO date | ✓ | 추출 시각 |
| `durationSec` | number > 0 | ✓ | 분석된 신호 길이 |
| `sampleRate` | 44100/48000/88200/96000 | ✓ | |
| `channels` | 1..8 | ✓ | |
| `extractorVersion` | string | ✓ | 추출기 semver |
| `sourceFileSha256` | hex64 \| null | optional | **캐시 키 전용**. fingerprint 아님. 공유 시 권장 strip |
| `userLabel` | ≤256 chars | optional | 사용자 책임 자유 텍스트 |

**금지된 키** (validator 가 거부): `artist`, `title`, `album`, `lyrics`, `isrc`, `mbid`.

---

## 3. `features.loudness`

```jsonc
"loudness": {
  "integratedLufs":  -10.2,   // [-90, 6]
  "truePeakDbtp":     -1.1,   // [-90, 6]
  "loudnessRange":     5.4,   // [0, 40]
  "shortTermPercentiles": { "p10": -14.5, "p50": -11.2, "p90":  -9.0 },
  "momentaryPercentiles": { "p10": -16.1, "p50": -12.4, "p90":  -8.5 }
}
```

| 필드 | 의미 | 산출 방법 |
|---|---|---|
| `integratedLufs` | ITU R.128 평균 | FFmpeg `loudnorm` pass-1 |
| `truePeakDbtp` | 4× oversample TP | FFmpeg `loudnorm` pass-1 |
| `loudnessRange` | EBU R128 LRA | FFmpeg `loudnorm` pass-1 |
| `shortTermPercentiles` | 3s 블록 LUFS 의 분포 | K-weighted RMS / 3s 블록 → `numpy.percentile` |
| `momentaryPercentiles` | 400ms 블록 LUFS 분포 | 같은 알고리즘, 400ms 윈도우 |

**Percentile 만 저장 — 원본 배열은 절대 저장하지 않음.**

---

## 4. `features.dynamics`

```jsonc
"dynamics": {
  "crestDb":               12.3,   // [0, 40]
  "transientDensityPerMin": 84.5,  // ≥ 0
  "compressionScore":       0.42   // [0, 1]
}
```

| 필드 | 의미 | 산출 방법 |
|---|---|---|
| `crestDb` | 피크 vs RMS | `20·log10(peak/rms)` |
| `transientDensityPerMin` | 전체 시간의 onset 개수 / 분 | 미분 envelope + 6× median threshold + 30ms binning |
| `compressionScore` | 0=다이내믹, 1=brickwall | 0.55·(1−LRA/14) + 0.30·(1−(crest−4)/12) + 0.15·spread |

**Compression score 는 derived metric** — 다른 fields 로부터 계산. M2 의 dsp-core 가 같은 공식을 그대로 사용.

---

## 5. `features.tonal`

```jsonc
"tonal": {
  "thirdOctSpectrumDb": {
    "25": -42.1, "31.5": -38.4, "40": -34.0, ..., "20000": -36.2
  },                                              // ≤ 64 bins
  "spectralTiltDbPerOct":  -2.8,                  // [-12, 12]
  "subEnergyRatio":         0.18,                 // [0, 1]
  "lowMidBalanceDb":       -3.4,                  // [-60, 12]
  "vocalRegionEnergyDb":   -1.2,                  // [-60, 12]
  "airBandEnergyDb":       -8.7,                  // [-60, 12]
  "harshnessIndex":         1.4                   // [0, 20]
}
```

| 필드 | 의미 | 산출 방법 |
|---|---|---|
| `thirdOctSpectrumDb` | 1/3-oct 시간평균 magnitude | Welch-style 1초 윈도우 → FFT → 30 ANSI 센터 → 평균 → dB |
| `spectralTiltDbPerOct` | 슬로프 (negative = darker) | polyfit(log2(freq), dB) |
| `subEnergyRatio` | [20-100] Hz / total band linear power | sum(power) / total |
| `lowMidBalanceDb` | [100-500] Hz vs total | bandSumDb − totalDb |
| `vocalRegionEnergyDb` | [1000-4000] Hz vs total | 같음 |
| `airBandEnergyDb` | [10000+] Hz vs total | 같음 |
| `harshnessIndex` | 2-5kHz / 이웃 평균 비 | linear power ratio, clamp [0, 20] |

**Spectrum bin 개수 hard cap 64** (실제 30) — validator 가 강제. 더 미세한 해상도는 fingerprinting 위험 영역.

---

## 6. `features.stereo`

```jsonc
"stereo": {
  "correlationMean":  0.78,    // [-1, +1]
  "msRatioDb":        8.1,     // [-60, 30]
  "stereoWidthIndex": 1.20     // [0, 4]
}
```

| 필드 | 의미 | 산출 방법 |
|---|---|---|
| `correlationMean` | L/R Pearson correlation 평균 | 1초 블록별 corr → numpy mean |
| `msRatioDb` | Mid/Side 에너지 비 | `10·log10(P_M / P_S)` |
| `stereoWidthIndex` | 종합 width (0=mono, 1=normal, >1=wide) | `clamp(2·P_S/(P_M+P_S) · 2, 0, 4)` |

---

## 7. `featureFingerprint`

```jsonc
"featureFingerprint": "ce4d6f...a91b"  // SHA-256, 64 hex chars
```

- **`features` 객체** 의 canonical JSON (sorted keys) 의 SHA-256.
- **오디오 fingerprint 아님** — feature 정의가 바뀌면 값도 바뀌어 캐시 invalidation 신호.
- 같은 audio 로 다시 extract 해도 features 값이 같으면 fingerprint 도 같음 (대수학적 결정성).
- 공유 안전 (audio 식별 불가).

---

## 8. 변경 정책

| 변경 | 버전 | 영향 |
|---|---|---|
| 신규 feature 필드 추가 | minor bump (`1.1.0`) | 옛 profile 유효 (필드 누락) |
| 기존 feature 의미 변경 | **major bump** (`2.0.0`) | migration 함수 의무 |
| 새 `sourceType` enum 값 | minor | 옛 profile 유효 |
| forbidden 키 목록 추가 | minor | 일부 옛 profile 거부 가능 (의도된 강화) |
| Spectrum bin cap 변경 (64 → 다른 값) | **major** | 정의가 달라짐 |

변경 시 동시 갱신 필수:
1. `packages/shared-types/src/profile/profile.ts`
2. `packages/shared-types/src/profile/validate.ts`
3. `packages/shared-types/src/profile/reference-profile.schema.json`
4. `services/python-audio/app/profiling/schema.py`
5. `services/python-audio/app/profiling/validate.py`
6. 본 문서 + `02-FEATURE-EXTRACTION-DESIGN.md`
