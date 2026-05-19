# 03 — DSP 구조도

## A. 현재 DSP 구조 (As-Is)

### A.1 전체 흐름

```
                    ┌──────────────────────────────────────────────────────┐
                    │  Electron Main (Node.js)                              │
                    │  ┌──────────────────────────────────────────────┐    │
                    │  │  packages/audio-engine (TS bridge)           │    │
                    │  │  - JSON-RPC over stdio                       │    │
                    │  │  - 10 min timeout / method-specific overrides│    │
                    │  └────────────────┬─────────────────────────────┘    │
                    └───────────────────┼──────────────────────────────────┘
                                        │  spawn (python)
                                        ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  Python Service (services/python-audio/app/main.py — JSON-RPC dispatcher)  │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │  Stage 0: 입력 검증                                                  │ │
│  │  ffprobe → codec / SR / channels / duration                          │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                ▼                                           │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │  Stage 1: Pre-Analysis                                               │ │
│  │  • FFmpeg loudnorm pass1   →  LUFS-I / TP / LRA                      │ │
│  │  • soundfile.read (전체)   →  DC offset / RMS / clipping             │ │
│  │  • numpy FFT (3-5kHz, 60-200Hz 에너지비)  →  AI artifact 탐지        │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                ▼                                           │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │  Stage 2: Preprocessing Warnings (수정 안 함)                        │ │
│  │  mono / 비표준 SR / DC offset / pre-clipping                         │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                ▼                                           │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │  Stage 3: Adaptive EQ            (FFmpeg filter chain → tmp.wav)     │ │
│  │  • Low-shelf 60Hz / Mid-shelf / Air 12kHz                            │ │
│  │  • Dynamic EQ (adynamicequalizer) — 선택                             │ │
│  │  • 모드별 (balanced / warm / bright / punch / loud / kpop_loud)      │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                ▼                                           │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │  Stage 4: Bus Compression (Glue)  (FFmpeg → tmp.wav)                 │ │
│  │  • threshold / ratio / attack / release — 모드별                     │ │
│  │  • vocal_protection 강제 클램프 (ratio≤2.0, attack≥25ms)             │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                ▼                                           │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │  Stage 5: Loudness Normalization                                     │ │
│  │  • linear mode → FFmpeg loudnorm pass2 (정확)                        │ │
│  │  • loud / kpop_loud → static volume + alimiter (부정확)              │ │
│  │  • 타겟: -14 LUFS / -1.0 dBTP (기본)                                 │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                ▼                                           │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │  Stage 6: Brickwall Limiter (FFmpeg alimiter)                        │ │
│  │  ceiling -1.0 dBTP, input_gain by limiter_strength                   │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                ▼                                           │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │  Stage 7: ISP Safety (utils/isp_safety.py — 사후 검사)              │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                ▼                                           │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │  Stage 8: Iterative Reference Match (옵션)                           │ │
│  │  • Stage 3-7 까지 최대 3회 재실행                                    │ │
│  │  • 90% 일치 시 종료                                                  │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                ▼                                           │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │  Stage 9: Auto QC                                                    │ │
│  │  TP / short-term variation / amp drop / clipping / over-comp /       │ │
│  │  limiter excess / gain staging                                       │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
│                                ▼                                           │
│  ┌──────────────────────────────────────────────────────────────────────┐ │
│  │  Stage 10: 출력                                                       │ │
│  │  • WAV (24/16 bit, target SR)                                        │ │
│  │  • MP3 320 kbps (preview)                                            │ │
│  │  • Before/After Waveform PNG (FFmpeg showwavespic)                   │ │
│  │  • 결과 JSON (메트릭 + reports + paths)                              │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────┘

                    ┌──────────────────────────────────────────────┐
                    │  병렬 / 미연결: Renderer TS DSP              │
                    │  apps/desktop/src/renderer/audio/ (3,641줄)  │
                    │  - K-weighting biquad                        │
                    │  - LUFS M/S/I + TP (AudioWorklet, 100ms)     │
                    │  - 5초 슬라이스 미리듣기 (TS pipeline)       │
                    │  - AB 비교 (라우드니스 매칭)                 │
                    │  - gainStaging / transientProtection /       │
                    │    vocalEnhancer / limiterChain /            │
                    │    peakLimiter / softClip                    │
                    │  ★ Python 과의 출력 동일성 미검증            │
                    └──────────────────────────────────────────────┘
```

### A.2 핵심 문제 재요약

1. **FFmpeg 종속**: 모든 DSP 가 filter chain 문자열 → 정확도/재현성 한계.
2. **2-pass 라우드노름**: 입력을 두 번 스캔. CPU 낭비.
3. **stage 간 디스크 I/O**: 각 stage 마다 tmp.wav 저장 → 읽기. SSD 부담 + 시간.
4. **TS DSP 분리**: 같은 알고리즘이 Python/TS 에 중복 구현되어 있음.

---

## B. 목표 DSP 구조 (To-Be — Loui Mastering v2)

### B.1 핵심 원칙

1. **Single Source of Truth**: 하나의 DSP 코어 (네이티브) 가 실시간/오프라인 모두 담당. WASM 빌드를 통해 브라우저/Electron 에서 그대로 사용.
2. **모듈 그래프**: 고정 파이프라인이 아니라 **유저가 순서 변경 가능한 모듈 그래프** (Ozone 스타일).
3. **실시간 first, offline second**: 실시간 처리가 가능하도록 설계하고, 오프라인은 같은 코어를 "offline mode" (look-ahead 더 큼, 정밀도 ↑) 로 호출.
4. **결정성**: 같은 입력 + 같은 그래프 + 같은 시드 = 같은 출력. 외부 FFmpeg 빌드와 무관.

### B.2 모듈 카탈로그 (사용자 노출)

```
┌─────────────────────────────────────────────────────────────────────┐
│  Loui Mastering — DSP Module Catalog                                 │
├─────────────────────────────────────────────────────────────────────┤
│  Source            │ 입력 파일 / 라이브 입력 (마이크/라우팅)         │
│  ─                  │                                                │
│  Gain Trim          │ Pre-gain + DC offset 제거                     │
│  Equalizer          │ 8-band parametric (peak/shelf/HP/LP), MS 모드 │
│  Dynamic EQ         │ Threshold-driven 4-band, MS 모드              │
│  Multiband Comp     │ 4-band (low/lowmid/highmid/high) + sidechain  │
│  Bus Comp (Glue)    │ Single-band, 1176/SSL 스타일 토글             │
│  Transient Shaper   │ Attack/Sustain (Per-band 옵션)                │
│  Stereo Imager      │ MS width per-band + correlation meter         │
│  Saturator          │ Tube / Tape / Soft / Hard 모델                │
│  De-Esser           │ Dynamic Notch + side EQ                       │
│  Vocal Enhancer     │ Formant-aware presence boost                  │
│  Reference Match    │ Spectral / Dynamic / Stereo 매칭 (옵션)       │
│  Limiter            │ 3-stage (clip + soft + brickwall) + ISP       │
│  Loudness Norm      │ K-weighted BS.1770-4 (실시간 + 단일 패스)     │
│  Dither             │ TPDF / Pow-r 1-3 (16/24 bit 선택)             │
│  ─                  │                                                │
│  Sink               │ WAV / FLAC / MP3 / AAC 출력                   │
├─────────────────────────────────────────────────────────────────────┤
│  Meters (시각화 노드 — 사이드 탭)                                    │
│  • LUFS M/S/I + TP + LRA                                            │
│  • Spectrum (FFT 4k/8k, log/linear, max/min/avg)                    │
│  • Spectrogram                                                       │
│  • GR meter (per-module)                                            │
│  • Vectorscope + Correlation                                         │
│  • Phase Scope                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### B.3 기본 그래프 (Default Master Chain)

```
[Source] → [Gain Trim] → [Equalizer]
                          │
                          ▼
                    [Dynamic EQ]
                          │
                          ▼
                  [Multiband Comp]
                          │
                          ▼
                     [Bus Comp]
                          │
                          ▼
                   [Stereo Imager]
                          │
                          ▼
                    [Saturator]   (선택)
                          │
                          ▼
                    [Limiter (3-stage)]
                          │
                          ▼
                  [Loudness Norm]
                          │
                          ▼
                       [Dither]
                          │
                          ▼
                       [Sink]

★ 그래프는 직렬 기본이지만, "Reference Match" 모듈은 사이드체인으로 EQ/Comp 의 파라미터를 자동 조정.
★ Vocal Track 별도 입력 시 De-Esser/Vocal Enhancer 가 vocal bus 에만 적용 (서브그래프).
```

### B.4 실시간 / 오프라인 모드 차이

| 특성 | Real-time mode | Offline mode |
|---|---|---|
| Look-ahead | 5~20 ms (limiter) | 50~200 ms |
| Block size | 128~512 sample | 8192~32768 sample |
| Limiter | True-peak 4× oversample | True-peak 8~16× oversample |
| LUFS | 단일 패스 streaming | 단일 패스 + post 검증 |
| EQ | Cascaded biquad (직접형 II) | 미니멈 페이즈 IIR + linear-phase 옵션 |
| Iterative ref match | 비활성 | 활성 (max 3회) |
| 결과 동일성 | "근사" (UI 미리듣기 용) | "공칭" (배포 출력) |

**핵심**: real-time 과 offline 의 출력은 **±0.1 LUFS / ±0.2 dBTP 이내** 로 보장 (사용자가 들은 것과 최종이 같음).

### B.5 데이터 표현 변경

| | 현재 | v2 |
|---|---|---|
| 샘플 포맷 | float64 (Python 메모리), int16/24 (디스크) | **float32** 통일 (DSP), float64 (분석 누산기) |
| 채널 | interleaved (FFmpeg), planar (numpy) | **planar float32** (DSP 일관) |
| 블록 크기 | 파일 전체 / FFmpeg 자체 chunk | **고정 블록** (audio thread block, default 256) |
| 메모리 모델 | 풀버퍼 in/out | **링버퍼 + look-ahead 버퍼** (스트리밍) |

---

## C. DSP 신뢰성 (Determinism / Validation)

v2 부터 도입:

1. **DSP regression suite**: 골든 입력 셋 (10곡) × 모든 기본 그래프 → SHA256 + LUFS/TP/스펙트럼 비교. CI 에서 임계치 초과 시 실패.
2. **A/B 검증**: Loui 출력 vs (선택) Matchering / Bakuage 출력 — 정성/정량 비교 표.
3. **Cross-platform**: macOS arm64 / x64, Windows x64, Linux x64 가 같은 SHA256 출력 보장. 부동소수 비결정성 (FMA / 컴파일러) 통제.
4. **샘플레이트 sweep**: 22.05k / 44.1k / 48k / 88.2k / 96k 입력에서 동일한 마스터 품질.

---

## D. 외부 라이브러리 / 표준 의존

| 영역 | 현재 | v2 |
|---|---|---|
| 라우드니스 | FFmpeg `loudnorm` | **사내 BS.1770-4 K-weighting** (이미 TS 측 `loudnessCore.ts` 존재) |
| Resampling | FFmpeg `swr` | **libsoxr** (Best quality) 또는 사내 polyphase |
| FFT | numpy | **KissFFT** / **pffft** (C) |
| EQ 계수 | FFmpeg filter | **사내 cookbook (RBJ)** + matched-Z |
| Limiter | FFmpeg `alimiter` | **사내 3-stage** (이미 TS 측 `limiterChain.ts` 존재) |
| Dither | (없음) | **TPDF + Pow-r** |
| Oversampling | (없음) | **Half-band FIR (4×/8×/16×)** |

→ 9번 문서 (`09-RUST-CPP-MIGRATION-PLAN.md`) 에서 어느 영역을 네이티브로 옮길지 상세화.
