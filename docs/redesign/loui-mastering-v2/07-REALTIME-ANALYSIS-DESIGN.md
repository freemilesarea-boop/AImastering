# 07 — 실시간 분석 시스템 설계

> 사용자가 들리는 모든 변화는 시각화에 즉시 반영된다.
> 본 문서는 그 시각화/분석 파이프라인을 정의한다.

---

## 1. 요구사항

| # | 요구사항 | 측정 | 비고 |
|---|---|---|---|
| R1 | 실시간 FFT 스펙트럼 | 60 FPS, 4k FFT, ≤16ms latency | 평균/최대/현재 곡선 |
| R2 | 실시간 BS.1770-4 LUFS (M/S/I) | 100ms 업데이트, ±0.1 LU 정확도 | 이미 부분 구현 (worklet) |
| R3 | True-Peak (4× over) | 100ms 업데이트, ±0.2 dB 정확도 | per-channel |
| R4 | LRA (loudness range) | 1s 업데이트 | 누적 |
| R5 | GR 미터 (per-module) | 모듈별 reduction in dB, 60 FPS | 컴프/리미터 |
| R6 | EQ 곡선 실시간 (편집 중) | 입력 변경 후 ≤16ms 반영 | 입력 스펙트럼 오버레이 |
| R7 | 벡터스코프 / Correlation | 60 FPS, 4k 샘플 윈도우 | Stereo 분석 |
| R8 | 위상 스코프 (L/R 상관) | 60 FPS | -1..+1 |
| R9 | 스펙트로그램 | 30 FPS, 1024 hop, 30s 윈도우 | 색상 = dB |
| R10 | 모든 메터의 CPU 합계 | <5% 단일 코어 (Intel i5 8세대 기준) | 측정 의무 |

---

## 2. 데이터 흐름 (Realtime)

```
[Web Audio Source]   (HTMLMediaElement / MediaStream / AudioBufferSource)
        │
        ▼
[AudioContext (sampleRate)]
        │
        ├──▶ [AudioWorkletNode: DSP Runtime]   ← dsp-core WASM 호스트
        │           │
        │           │ (audio out)
        │           ▼
        │     [AudioContext.destination]  ─▶ 스피커
        │
        │ (worklet.port.postMessage 매 100ms)
        ▼
[MainThread Meter Bus (BroadcastChannel or store)]
        │
        ├──▶ <MeterStack>   (LUFS / TP / LRA / Correl / Phase)
        ├──▶ <SpectrumView> (FFT 결과)
        ├──▶ <GRMeter>      (per-module reduction)
        └──▶ <ModuleInspector> (현재 선택 모듈의 라이브 상태)
```

### 2.1 왜 단일 AudioWorklet 인가

- 다수의 AudioWorkletNode 분기 = 데이터 중복 + 컨텍스트 스위치 오버헤드.
- dsp-core WASM 을 단일 worklet 에 호스트 → 그래프 전체를 한 번에 실행하고, 모든 메터 값을 같은 포스팅에 담아 보낸다.
- 메인 스레드는 store 에 patch 하고, 컴포넌트는 selector 로 부분 구독.

### 2.2 100ms 메시지 페이로드 예

```json
{
  "ts": 1736000000000,
  "lufs": { "m": -14.0, "s": -13.8, "i": -14.0 },
  "tp": { "max": -1.0, "l": -1.1, "r": -1.0 },
  "lra": 6.2,
  "spectrum": { "format": "f32", "len": 2048, "buf": "<Float32Array>" },
  "modules": {
    "eq1":     { "outputRmsDb": -16.4 },
    "mbcomp1": { "grDbBands": [-1.2, -2.4, -0.8, -0.1] },
    "lim":     { "grDb": -1.8, "tpHits": 3 }
  },
  "stereo": { "correl": 0.62, "msRatio": 0.78 }
}
```

- 스펙트럼은 transferable `Float32Array` (zero-copy).
- 메인 스레드는 throttle/RAF 로 60 FPS 까지 다운샘플 렌더링.

---

## 3. FFT / 스펙트럼

### 3.1 사양

- FFT 크기: 4096 (기본) / 2048 / 8192 / 16384 (옵션)
- Hop: FFT/2
- Window: Hann (Default), Blackman-Harris (옵션)
- Magnitude → dB: 20·log10(|X|) − cal_offset (cal_offset = FS 0 dB 기준)
- 평균 / 최대 / 현재 3 곡선
- 가중치: 없음 (raw) / A-weight (옵션) / K-weight (옵션)

### 3.2 렌더링

- canvas 2D (간단) — 라이브러리 없음
- 좌표계: 로그 X (20Hz..20kHz) / 선형 X / 1/3-oct binning 토글
- Y: -90 ~ +6 dB
- 색: 디자인 토큰 (현재/평균/최대 색 다르게)
- 줌 / 팬: 마우스 휠 / 드래그
- "freeze" 단축키 (F) — 현재 곡선 정지

### 3.3 구현 위치

- WASM 측: `dsp-core::analyze::Fft` (KissFFT 또는 pffft 래핑) — Float32 in/out
- worklet: 입력 블록 누적 (overlap-add 윈도우) → FFT → magnitude → spectrum 버퍼 갱신
- main: canvas 그리기

---

## 4. LUFS / TP / LRA

이미 TS 측에 구현되어 있음 (`apps/desktop/src/renderer/audio/loudnessCore.ts` + worklet). v2 에서는 dsp-core 의 Rust 구현을 정본으로 하고, 같은 알고리즘 / 같은 결과를 보장한다.

### 4.1 알고리즘

- K-weighting filter (2-stage RBJ shelving — ITU-R BS.1770-4 정확 계수)
- 0.4s gating block, 0.1s hop
- Absolute gate -70 LUFS, Relative gate -10 LU
- Integrated = 게이팅 통과 블록의 평균
- TP: 4× polyphase oversample → ABS peak (per channel)
- LRA: 3s gating block, percentile 10% / 95%

### 4.2 검증

- EBU R-128 test vectors (1, 2, 3, 4, 5, 6, 7, 8, 9, 10) 통과
- TP 가 -1 dBTP 이내인지 4× over 결과로 검증
- Cross-check: 외부 도구 (libebur128, ffmpeg loudnorm) 와 ±0.1 LUFS 일치

---

## 5. GR (Gain Reduction) 미터

- 각 컴프/리미터/멀티밴드 컴프 모듈이 매 블록 마다 자신의 `currentGrDb` 를 노출.
- worklet 측 메시지의 `modules.<id>.grDb` (또는 `grDbBands`) 에 담아 전송.
- UI 컴포넌트 `<GRMeter>` 는 0 dB ~ -20 dB 범위로 hold + peak.

### 5.1 멀티밴드 GR

- 4-band 의 경우 4개 막대.
- 색은 디자인 토큰의 GR 그라데이션 (amber → red).

### 5.2 리미터 GR

- ISP (Inter-Sample Peak) 적중 횟수 별도 표시 (`tpHits`).
- 4× over 결과 vs 1× 결과 차이가 시각화 (작은 점선).

---

## 6. 벡터스코프 + Correlation + Phase

### 6.1 벡터스코프

- X = (L − R) / √2 (M-S)
- Y = (L + R) / √2
- 60 FPS 점/선 렌더 (canvas 2D 또는 WebGL — 옵션)
- 4k 샘플 윈도우 (decay)

### 6.2 Correlation

- 슬라이딩 윈도우 (1024 samples)
- ρ = Σ(L·R) / √(Σ L² · Σ R²)
- -1 (역위상) ~ +1 (모노 동일)
- 막대 + 숫자

### 6.3 위상 스코프

- L vs R Lissajous (별도 선택지)
- 또는 Phase difference 시간 곡선

---

## 7. 스펙트로그램

- STFT 1024 FFT / 256 hop (≈ 5.8ms / 1.5ms hop @ 44.1k)
- 30s 슬라이딩 윈도우
- 색상 = dB (-90 ~ 0)
- ImageData 갱신 + canvas
- 한 곡 전체 렌더는 별도 (오프라인 분석)

---

## 8. EQ 곡선 (실시간 편집 시)

### 8.1 흐름

1. 사용자가 EQ band 핸들을 끌면 store 의 `graph.nodes.eq1.params.bands[i]` 변경.
2. dsp-core 의 EQ 모듈이 새 계수 적용 → 다음 블록부터 출력 변화.
3. 동시에 **계수 기반 frequency response curve** 계산 (DSP 없이 수식만) → UI 캔버스에 즉시 (≤16ms) 표시.
4. SpectrumView 위에 EQ 곡선 오버레이.

### 8.2 frequency response 계산

```ts
function biquadResponse(b0, b1, b2, a1, a2, freqs, fs): Float32Array {
  // H(e^jω) = (b0 + b1 e^-jω + b2 e^-2jω) / (1 + a1 e^-jω + a2 e^-2jω)
  // 1024 점 응답, dB
}
function eqCurve(bands, fs, freqs): Float32Array {
  // 각 band 의 biquad 응답을 합산 (dB)
}
```

수식 계산은 main thread 에서 충분히 빠름 (1024 점 × 8 band = ~0.1ms).

---

## 9. 성능 / 메모리 예산

| 항목 | 예산 (단일 코어 i5 8세대) |
|---|---|
| 단일 AudioWorklet 처리 (전체 그래프 + 메터링) | < 30% (스튜디오 모드, 4× over) |
| Main thread 렌더 (60 FPS) | < 15% |
| 전체 메인 프로세스 CPU | < 50% (재생 + 시각화) |
| WASM heap | < 64 MB |
| Main thread heap | < 256 MB |
| 임시 오디오 버퍼 (60s @ 48k 스테레오 float32) | ≈ 23 MB |

CI 에서 `tests/perf/` 가 노트북 (CI runner) 에서 측정하여 회귀 추적.

---

## 10. 오프라인 분석 (실시간 외)

같은 dsp-core 가 오프라인 모드로 호출되어:

- 곡 전체 LUFS-I / TP / LRA
- 곡 전체 평균 스펙트럼 (1/3 oct bin)
- 섹션 감지 (verse/chorus/bridge) — onset / spectral flux + 클러스터링
- 다이내믹 프로파일 (per-section LRA, crest factor)
- AI 아티팩트 감지 (3-5kHz / 60-200Hz 에너지비 + 기타 지표)
- 보컬 강도 곡선

→ AI 추천 엔진 입력으로 사용.

---

## 11. 외부 입력 / 라이브 분석 (옵션)

마이크 또는 시스템 오디오 라우팅을 입력으로 받아 분석만 (마스터링 미적용) 하는 "Live Analyzer" 모드:
- 음악 스튜디오에서 다른 DAW 의 출력을 라우팅해 LUFS/TP/스펙트럼 모니터.
- v2.1 부터 도입 가능. v2.0 은 파일 입력에 집중.

---

## 12. 안전장치

| 위험 | 완화 |
|---|---|
| Web Audio 가 백그라운드 탭에서 throttle | `KeepAwake` (Electron `powerSaveBlocker`) 또는 audio 스레드 분리 |
| AudioContext sampleRate 불일치 (48k 환경에서 44.1k 파일) | 입력 측 SRC 적용 (dsp-core 의 polyphase resampler) |
| User 가 매우 큰 파일 (1h+) 재생 | 디코딩을 스트리밍 (decoders 패키지) — 풀버퍼 금지 |
| 메터 콜백 폭주 (메인 스레드 lag) | worklet 측에서 100ms 미만은 합산해 한 번에 전송 |
| FFT 라이브러리 비결정성 | KissFFT 단일 결정적 빌드 사용 |

---

## 13. 검증 / 회귀

- **EBU R-128 vector pass** — Integrated LUFS 모든 테스트 ±0.1 LUFS
- **TP 4× over** — 알려진 테스트 신호 (sin 999.9 Hz, ISP 신호) 에서 ±0.2 dB
- **CPU budget** — 1분 곡 재생 + 모든 메터 ON 시 50% 코어 이내
- **Visual snapshot** — Spectrum / GR / EQ canvas 가 회귀 발생 시 픽셀 diff 검출
