# M1 — Python ↔ TS DSP 모듈/파라미터 매핑표

> 본 표는 실제 코드 (파일/라인) 를 읽고 작성한 1:1 대응 매트릭스다.
> 이 표가 `EnginePreset` 스키마의 직접 근거가 된다.

---

## 1. 처리 순서 매핑

```
Canonical (Python superset) order            Python current       TS current
──────────────────────────────────────────  ─────────────────────  ──────────────────────
  1. Source (파일/버퍼)                     S0  Input              (AudioBuffer)
  2. PreAnalyze (LUFS, AI detect)           S1  Pre-Analysis       (별도 호출)
  3. Gain Staging  (target peak/rms/lufs)   ★ 없음 (loudnorm 일부) ✅ gainStaging
  4. Adaptive EQ  (5-band shelf+peak)       S3  eq.py              ❌ 미구현
  5. Dynamic EQ   (6-band threshold)        S3.5 dynamic_eq.py     ❌ 미구현
  6. Multiband EQ (참조 매칭용 4-band)      reference_matching     ❌ 미구현
  7. Bus Compressor (Glue)                  S4  dynamics.py        ❌ 미구현
  8. Transient Protection                   ❌ 미구현              ✅ transientProtection
  9. Vocal Enhancer (formant presence)      ❌ 미구현              ✅ vocalEnhance
 10. Saturator                              S4.5 effects.py        ❌ 미구현
 11. Stereo Imager (width)                  S4.5 effects.py        ❌ 미구현
 12. De-Esser                               S4.5 effects.py        ❌ 미구현
 13. Loudness Normalization                 S5  loudnorm 2-pass    ✅ loudnessMaximizer (iterative)
 14. Soft Clip                              ❌                     ✅ softClip
 15. Brickwall Limiter                      S6  alimiter           ✅ peakLimiter
 16. ISP Safety (4× post-check)             S7  isp_safety.py      ❌ (TP 측정만)
 17. Dither (16/24-bit)                     ❌ 미구현              ❌ 미구현
 18. Sink (WAV/MP3)                         S10                    (외부)
```

**Gap 요약:**
- Python 만 구현 (TS 미구현): 4(EQ), 5(DynEQ), 6(MB-EQ), 7(BusComp), 10(Sat), 11(Width), 12(DeEss), 16(ISP)
- TS 만 구현 (Python 미구현): 3(GainStage), 8(Transient), 9(Vocal), 14(SoftClip)
- 양쪽 구현 (단, 알고리즘 다름): 13(Loudness Norm), 15(Limiter)
- 양쪽 미구현 (critical for GA): 17(Dither)

---

## 2. 모드 → 파라미터 매핑

### 2.1 LUFS / TP 타겟

| Mode (Python style) | Python target_lufs | Python target_tp | TS 매핑 mode | TS targetLufs | 차이 |
|---|---|---|---|---|---|
| natural   | -14.0 | -1.0 | CLEAN    | -16   | **+2.0 LU** |
| balanced  | -12.0 | -1.0 | BALANCED | -12   | 0 |
| bright    | -12.0 | -1.0 | BALANCED | -12   | 0 |
| warm      | -14.0 | -1.0 | BALANCED | -12   | **-2.0 LU** |
| loud      | -10.0 | -1.0 | LOUD     | -8    | **-2.0 LU** |
| kpop_loud | -9.0  | -0.8 | LOUD     | -8    | -1.0 LU + TP 차이 |
| punch     | -11.0 | -1.0 | LOUD     | -8    | **-3.0 LU** |

→ **현재 7→3 매핑이 LUFS 측면에서 잘못되어 있음.** 정규 스키마는 7가지를 그대로 보존하고, TS adapter 가 직접 `targetLufs` 를 매핑 (LUFS 만큼은 일치 가능).

### 2.2 Limiter 강도

| Mode | Python `limiter_strength` (LIMITER_STRENGTHS) | TS PeakLimiter 매핑 |
|---|---|---|
| low    | level_in=-1.5 dB, attack=8 ms, release=200 ms | ceilingDb=-1.5, release=200, fastRatio=2, hold=3 |
| medium | level_in=+0.5 dB, attack=5 ms, release=120 ms | ceilingDb=-1.0, release=80,  fastRatio=3, hold=2 |
| high   | level_in=+2.5 dB, attack=3 ms, release=60 ms  | ceilingDb=-1.0, release=40,  fastRatio=4, hold=1 |

→ 이 매핑은 TS adapter 가 prefix table 로 구현.

---

## 3. 모듈별 1:1 파라미터 매핑

각 모듈에 대해: **canonical 이름 / 단위 / Python 소스 / TS 소스 / 매핑 노트.**

### 3.1 Adaptive EQ (5-band)

Python 측 (`app/mastering/eq.py:_build_base_eq` line 89-130):

| Band | Type | Freq (Hz) | Q/width | Gain (dB) — `balanced` |
|---|---|---|---|---|
| low_shelf  | octave shelf | 80    | w=2.0 | +2.0..+4.0 (adaptive) |
| lo_supp    | octave peak  | 120   | w=1.2 | +0.8..+1.6 (adaptive) |
| mud_cut    | octave peak  | 250   | w=1.2 | -3.0 (fixed) |
| muddy      | octave peak  | 320   | w=0.8 | -1.0 (fixed) |
| air        | high shelf   | 12000 | —     | +2.0..+3.5 (adaptive) |

추가 mode overlay (pipeline.py `_STYLE_OVERLAYS`): 모드별 +1 band (e.g. loud → +0.6 dB @ 2.5kHz)

TS 측: **없음.**

**Canonical 표현 (`EngineEqModule`):**
```ts
type EngineEqModule = {
  type: 'adaptive-eq';
  bands: EngineEqBand[];          // 5 + overlay
}
type EngineEqBand = {
  id: string;                      // 'low_shelf', 'lo_supp', ...
  filterType: 'low_shelf' | 'high_shelf' | 'peak' | 'high_pass' | 'low_pass';
  freqHz: number;
  q?: number;                      // 또는 widthOctaves
  widthOctaves?: number;
  gainDb: number;
  adaptive?: boolean;              // freq range에서 low_to_mid_db 기반 자동 조정
}
```

### 3.2 Dynamic EQ (6-band)

Python (`app/mastering/dynamic_eq.py` DYNAMIC_EQ_PRESETS):

| Band | freq | q | threshold (dBFS) | reduction (dB) | mode |
|---|---|---|---|---|---|
| sibilance      | 7000 | 1.6 | -20 | 2.0 | cut |
| harsh_highmid  | 3200 | 1.2 | -18 | 1.5 | cut |
| muddy_lowmid   | 280  | 1.0 | -16 | 2.0 | cut |
| boomy_low      | 90   | 1.2 | -16 | 2.5 | cut |
| vocal_presence | 2500 | 1.1 | -22 | 1.0 | boost |
| air_dynamic    | 14000| 1.3 | -22 | 1.0 | boost |

각 밴드의 max reduction 하드캡: **1.5 dB** (line 176).

TS 측: **없음.**

**Canonical:**
```ts
type EngineDynamicEqModule = {
  type: 'dynamic-eq';
  intensity: number;               // 0..2 (0=off, 1=preset, 2=max)
  bands: EngineDynamicEqBand[];
}
type EngineDynamicEqBand = {
  id: string;
  freqHz: number;
  q: number;
  thresholdDb: number;
  reductionDb: number;
  mode: 'cut' | 'boost';
  attackMs?: number;               // default 20
  releaseMs?: number;              // default 200
}
```

### 3.3 Multiband EQ (Reference 매칭용)

Python (`app/mastering/multiband.py`):

| Band | freq (Hz) | Q | band range |
|---|---|---|---|
| low    | 100  | 1.0 | 20–200 |
| mid    | 700  | 1.0 | 200–2000 |
| vocal  | 3000 | 1.2 | 2000–5000 |
| high   | 9000 | 0.9 | 5000–16000 |

Skip threshold: |delta_db| < 0.3 → 적용 안 함 (line 91).
Vocal boost 클램프: +2.0 dB max (vocal protection).

TS 측: **없음.**

**Canonical:**
```ts
type EngineMultibandEqModule = {
  type: 'multiband-eq';
  bands: EngineMultibandEqBand[];
  skipBelowDb?: number;            // default 0.3
}
type EngineMultibandEqBand = {
  id: 'low' | 'mid' | 'vocal' | 'high';
  centreHz: number;
  q: number;
  rangeHz: [number, number];
  gainDb: number;                  // 참조 매칭으로 채워짐
}
```

### 3.4 Bus Compressor (Glue)

Python (`app/mastering/dynamics.py:_STYLE_COMP`):

| Style | threshold (dB) | ratio | attack (ms) | release (ms) | makeup (dB) | knee (dB) |
|---|---|---|---|---|---|---|
| natural   | -14 | 1.8 | 25 | 130 | 0.0 | 8 |
| balanced  | -15 | 1.9 | 22 | 120 | 0.3 | 8 |
| bright    | -15 | 1.9 | 22 | 120 | 0.3 | 8 |
| loud      | -16 | 2.0 | 18 | 110 | 0.5 | 9 |
| kpop_loud | -16 | 2.0 | 18 | 100 | 0.5 | 9 |
| warm      | -14 | 1.7 | 30 | 150 | 0.2 | 8 |
| punch     | -16 | 2.5 | 12 | 80  | 0.7 | 9 |

(위 값은 `dynamics.py` 의 dict 에서 확인; 정확치는 `02-MISMATCH-REPORT.md` 에서 검증 시 cross-check.)

Vocal protection 강제 클램프 (`vocal_protection.py`):
- ratio ≤ 2.0
- attack ≥ 25 ms
- makeup ≤ 0.7 dB

TS 측: **없음.**

**Canonical:**
```ts
type EngineBusCompModule = {
  type: 'bus-comp';
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  makeupDb: number;
  kneeDb: number;
  vocalProtection?: {              // 이 모듈은 옵션
    maxRatio?: number;             // default 2.0
    minAttackMs?: number;          // default 25
    maxMakeupDb?: number;          // default 0.7
  };
}
```

### 3.5 Effects (Saturator / Width / Deesser)

Python (`app/mastering/effects.py:_MODE_DEFAULTS`):

| Style | saturation (0..1) | stereo_width | deesser |
|---|---|---|---|
| natural   | 0.0 | 1.0 | false |
| balanced  | 0.20 | 1.05 | false |
| bright    | 0.0 | 1.05 | true |
| loud      | 0.0 | 1.10 | false |
| kpop_loud | 0.0 | 1.10 | true |
| warm      | 0.15 | 1.0 | false |
| punch     | 0.30 | 1.05 | false |

Deesser: fixed `equalizer=f=6500:t=o:w=1.5:g=-1.5`.

TS 측: **없음.**

**Canonical (3 separate modules):**
```ts
type EngineSaturatorModule = {
  type: 'saturator';
  amount: number;                  // 0..1
  model?: 'compand-curve';         // 현재 Python 의 compand 곡선
}
type EngineImagerModule = {
  type: 'stereo-imager';
  width: number;                   // 0.5..2.0, 1.0 = passthrough
}
type EngineDeesserModule = {
  type: 'deesser';
  freqHz: number;                  // default 6500
  q: number;                       // default ~1.5
  reductionDb: number;             // default 1.5
}
```

### 3.6 Gain Staging

Python: **없음.** (loudnorm 의 일부로 흡수됨)

TS (`apps/desktop/src/renderer/audio/gainStaging.ts`):

| Field | Default |
|---|---|
| targetPeakDb | -6 |
| targetRmsDb | -18 |
| targetLufs | -18 |
| maxBoostDb | 12 |
| maxAttenuateDb | -∞ |
| measureTruePeak | true |

**Canonical:**
```ts
type EngineGainStagingModule = {
  type: 'gain-staging';
  targetPeakDb?: number;
  targetRmsDb?: number;
  targetLufs?: number;
  maxBoostDb?: number;
  maxAttenuateDb?: number;
  measureTruePeak?: boolean;
}
```

Python adapter 에서: **패스스루** (현재 Python 은 이 기능 없음). 단, 로그 남김. M2 에서 Rust 가 구현.

### 3.7 Transient Protection

Python: **없음.**

TS (`transientProtection.ts`):
- thresholdRatio=1.5, maxReductionDb=1.5, attackMs=1, releaseMs=20, slope=0.6, warmupMs=100, refractoryMs=60

**Canonical:**
```ts
type EngineTransientProtectionModule = {
  type: 'transient-protection';
  thresholdRatio?: number;
  maxReductionDb?: number;
  attackMs?: number;
  releaseMs?: number;
  slope?: number;
  warmupMs?: number;
  refractoryMs?: number;
}
```

Python adapter 에서: **패스스루** (구현되면 좋겠지만 M1 범위 아님).

### 3.8 Vocal Enhancer

Python: **없음** (단, vocal_protection.py 가 vocal "보호" 만 함, 강화 안 함).

TS (`vocalEnhancer.ts`):
- scoreThreshold=0.40, maxCorrectionDb=2.5, forceEnable=false

**Canonical:**
```ts
type EngineVocalEnhancerModule = {
  type: 'vocal-enhancer';
  scoreThreshold?: number;
  maxCorrectionDb?: number;
  forceEnable?: boolean;
}
```

Python adapter: **패스스루.**

### 3.9 Loudness Normalization

Python (`ffmpeg_wrapper.py:268-435`):
- `loudnorm=I=<targetLufs>:TP=<targetTp>:LRA=<lra>:linear=<true|false>:measured_I=...:offset=...`
- linear 모드 (정확): `target_lufs ≤ -12` 일 때
- static 모드 (빠름): `target_lufs > -12` 또는 style ∈ {loud, kpop_loud}

TS (`loudnessMaximizer.ts`):
- damping=0.85, maxIters=4, toleranceLu=0.3
- Iterative: 측정 → gain 추가 → soft clip + peak limit → 측정 → 반복

**둘은 알고리즘이 본질적으로 다르다.** Canonical 표현은 "**원하는 결과**" (target LUFS / TP / LRA) 만 기술하고, **알고리즘 자체는 모듈 vendor 가 결정** 한다 (Python = loudnorm, TS = maximizer, M2 Rust = single-pass K-weighted).

**Canonical:**
```ts
type EngineLoudnessNormModule = {
  type: 'loudness-norm';
  targetLufs: number;
  targetTpDb: number;
  targetLra?: number;
  algorithm?: 'linear' | 'static' | 'iterative' | 'auto';  // auto = 구현체 결정
  toleranceLu?: number;            // iterative 전용
  maxIters?: number;
}
```

### 3.10 Brickwall Limiter

Python (`ffmpeg_wrapper.py:apply_limiter` + LIMITER_STRENGTHS):
- alimiter (FFmpeg): level_in, level_out=1, limit, attack_ms, release_ms, asc=1
- 강도별 level_in/attack/release (위 2.2 표)

TS (`peakLimiter.ts`):
- ceilingDb=-1.5 (default, mode 별 override), lookAheadMs=5, releaseMs=80, fastRatio=3, holdMs=2
- 4× polyphase oversample 로 TP 측정, look-ahead

**Canonical:**
```ts
type EngineLimiterModule = {
  type: 'limiter';
  ceilingDb: number;
  lookAheadMs?: number;            // default 5
  attackMs?: number;               // FFmpeg alimiter 호환
  releaseMs?: number;
  inputGainDb?: number;            // 강도별
  // 추가 (TS 만):
  fastReleaseMs?: number;
  fastRatio?: number;
  holdMs?: number;
  oversample?: 1 | 2 | 4 | 8 | 16;
}
```

### 3.11 Soft Clip

Python: **없음.**

TS (`softClip.ts`):
- thresholdDb=-3, driveDb=0
- Cubic soft-clip near threshold

**Canonical:**
```ts
type EngineSoftClipModule = {
  type: 'soft-clip';
  thresholdDb?: number;            // default -3
  driveDb?: number;                // default 0
  model?: 'cubic' | 'tanh' | 'compand-curve';
}
```

### 3.12 ISP Safety

Python (`utils/isp_safety.py:apply_isp_safety`):
- 4× FFT 오버샘플 측정 → ceiling 초과 시 정적 감쇠 (headroom 0.1 dB)

TS: **TP 측정만** (4× polyphase), 적용 안 함.

**Canonical:**
```ts
type EngineIspSafetyModule = {
  type: 'isp-safety';
  ceilingDbtp: number;             // default -1.0
  headroomDb?: number;             // default 0.1
  oversample?: 4 | 8 | 16;         // default 4
}
```

### 3.13 Dither

양쪽 모두 **미구현.** 그러나 canonical 스키마에는 노드 정의 (M2 에서 채움).

**Canonical:**
```ts
type EngineDitherModule = {
  type: 'dither';
  bitDepth: 16 | 24;
  algorithm?: 'tpdf' | 'rectangular' | 'pow-r-1' | 'pow-r-2' | 'pow-r-3' | 'none';
}
```

M1 단계: bitDepth=24 일 때 dither 노드는 noop. bitDepth=16 일 때 Python adapter 는 경고 + noop, TS adapter 도 동일. M2 에서 두 사이드 모두 구현.

---

## 4. 모듈 미구현 행렬 (압축)

| Module               | Python | TS  | 매핑 비고 |
|----------------------|--------|-----|---|
| source               | -      | -   | I/O 보조 |
| gain-staging         | ❌     | ✅  | Python noop |
| adaptive-eq          | ✅     | ❌  | TS noop |
| dynamic-eq           | ✅     | ❌  | TS noop |
| multiband-eq         | ✅     | ❌  | TS noop |
| bus-comp             | ✅     | ❌  | TS noop |
| transient-protection | ❌     | ✅  | Python noop |
| vocal-enhancer       | ❌     | ✅  | Python noop |
| saturator            | ✅     | ❌  | TS noop |
| stereo-imager        | ✅     | ❌  | TS noop |
| deesser              | ✅     | ❌  | TS noop |
| loudness-norm        | ✅     | ✅  | 알고리즘 상이 (loudnorm vs maximizer) |
| soft-clip            | ❌     | ✅  | Python noop |
| limiter              | ✅     | ✅  | alimiter vs peakLimiter |
| isp-safety           | ✅     | ❌  | TS noop (단, 측정은 있음) |
| dither               | ❌     | ❌  | M2 우선과제 |
| sink                 | -      | -   | I/O 보조 |

"noop" = adapter 가 모듈을 건너뛰며, 처리 로그에 기록.

---

## 5. 결정 정책 (보호 가드)

`EnginePreset` 의 일부지만 "DSP 모듈" 이 아닌 정책성 필드들:

| 필드 | 종류 | 출처 |
|---|---|---|
| `policies.vocalProtection` | 적용 강도 (off / safe / strict) | Python `vocal_protection.py` |
| `policies.safeMode` | safe / vocal_safe / low_limit | Python `safe_modes.py` |
| `policies.aiCorrections` | bool — Python AI detection 적용 여부 | Python pipeline `apply_ai_corrections` |

```ts
type EnginePresetPolicies = {
  vocalProtection?: 'off' | 'safe' | 'strict';
  safeMode?: 'none' | 'safe' | 'vocal_safe' | 'low_limit';
  aiCorrections?: boolean;
}
```

---

## 6. 출력 사양

```ts
type EnginePresetOutput = {
  sampleRate: 44100 | 48000 | 88200 | 96000;
  bitDepth: 16 | 24 | 32;
  format: 'wav' | 'flac' | 'mp3' | 'aac';
  mp3Bitrate?: number;             // mp3 일 때
};
```

---

## 7. 최종 EnginePreset 형태

```ts
type EnginePreset = {
  $schema: 'https://schemas.loui.studio/engine-preset/v1';
  id: string;                      // ULID or slug
  name: string;
  version: string;                 // semver of THIS preset
  compatibility: {
    engineApiMin: string;          // semver of @aimaster/shared-types engine
  };
  meta: {
    author?: string;
    createdAt?: string;            // ISO date
    tags?: string[];
    genre?: string;
    description?: string;
    legacyStyleId?: MasteringStyle; // v3 'natural'/'balanced'/... 와 매핑
  };
  policies: EnginePresetPolicies;
  output: EnginePresetOutput;
  chain: {
    nodes: EngineModule[];         // 위에서 정의한 union
  };
};
```

`EngineModule` = 모든 모듈 type 의 union.

다음 파일 `aimaster-desktop/packages/shared-types/src/engine/` 에 이 모든 타입이 들어간다.
