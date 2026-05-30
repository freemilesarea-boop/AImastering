# 09 — Rust / C++ 전환 필요 영역 분석

> 모든 코드를 Rust 로 갈 이유는 없다. **명확히 가치가 있는 영역만** 네이티브로 옮긴다.

---

## 1. 의사결정 프레임

각 영역을 다음 기준으로 평가한다:

| 기준 | 가중치 |
|---|---|
| 실시간 처리 필요성 (블록 단위 / 저지연) | 30% |
| 결정성 / 크로스 플랫폼 일치 | 20% |
| 성능 (현재 Python/JS 가 병목인지) | 20% |
| WASM 호환성 (브라우저 배포 가능성) | 15% |
| 유지보수 비용 (생태계 / 인력) | 15% |

점수: 우선순위 1 (즉시 네이티브) / 2 (M2 이후) / 3 (TS 유지 가능)

---

## 2. 영역별 평가

| 영역 | 현재 위치 | 실시간 필요 | 결정성 | 성능 | WASM | 유지보수 | **결론** |
|---|---|---|---|---|---|---|---|
| **모듈 그래프 런타임** | (없음, FFmpeg chain) | ★★★ | ★★★ | ★★★ | ★★★ | 중 | **Rust 우선 1** |
| **EQ (cascaded biquad)** | FFmpeg / TS biquad.ts | ★★★ | ★★★ | ★★ | ★★★ | 중 | **Rust 우선 1** |
| **Dynamic EQ** | FFmpeg adynamicequalizer | ★★★ | ★★ | ★★ | ★★★ | 중 | **Rust 우선 1** |
| **Multiband Compressor** | FFmpeg filter | ★★★ | ★★ | ★★ | ★★★ | 중 | **Rust 우선 1** |
| **Bus Compressor (Glue)** | FFmpeg `acompressor` | ★★★ | ★★ | ★ | ★★★ | 중 | **Rust 우선 1** |
| **Transient Shaper** | TS (transientProtection.ts) | ★★★ | ★★ | ★ | ★★★ | 중 | Rust 2 (TS 도 가능) |
| **Stereo Imager (MS / per-band)** | (부분) | ★★★ | ★★ | ★ | ★★★ | 중 | Rust 2 |
| **Saturator (Tube/Tape)** | TS (softClip.ts) | ★★★ | ★★★ | ★ | ★★★ | 중 | Rust 2 |
| **De-Esser** | (없음) | ★★★ | ★★ | ★ | ★★★ | 중 | Rust 2 |
| **Vocal Enhancer** | TS (vocalEnhancer.ts) | ★★★ | ★★ | ★ | ★★★ | 중 | Rust 2 |
| **True-Peak Limiter (3-stage)** | FFmpeg alimiter + ISP 사후 | ★★★ | ★★★ | ★★ | ★★★ | 중 | **Rust 우선 1** |
| **BS.1770-4 LUFS (K-weight + gating)** | FFmpeg loudnorm / TS loudnessCore.ts | ★★★ | ★★★ | ★★ | ★★★ | 중 | **Rust 우선 1** |
| **True-Peak (4× oversample)** | TS truePeak.ts (부분) | ★★★ | ★★★ | ★★ | ★★★ | 중 | **Rust 우선 1** |
| **Oversampling (4×/8×/16× FIR)** | (없음) | ★★★ | ★★★ | ★★ | ★★★ | 고 | **Rust 우선 1** |
| **Dither (TPDF / Pow-r)** | (없음) | ★ | ★★★ | ★ | ★★★ | 저 | **Rust 우선 1** |
| **Sample-rate converter (libsoxr)** | FFmpeg swr | ★★ | ★★★ | ★★ | ★★ | 중 | **Rust 우선 1** (libsoxr binding) |
| **FFT** | Python numpy / (브라우저 없음) | ★★★ | ★★ | ★ | ★★★ | 저 | **Rust 우선 1** (KissFFT/pffft) |
| **Section detection** | Python (onset + cluster) | ★ | ★ | ★ | ★★★ | 중 | TS 또는 Rust 2 |
| **AI artifact detect** | Python FFT 에너지비 | ★ | ★ | ★ | ★★★ | 중 | TS 또는 Rust 2 |
| **Reference matching (iterative)** | Python iterative.py | ★ | ★★ | ★★ | ★★★ | 중 | Rust 2 (오프라인) |
| **Vocal protection (clamp logic)** | Python | ★ | ★★ | ★ | ★★★ | 저 | TS 유지 (정책 코드) |
| **QC checks (post)** | Python qc/ | ★ | ★ | ★ | ★★★ | 저 | **TS 유지** (메터 결과에서 파생) |
| **AI 추천 엔진 (rule-based)** | Python (부분) | ★ | ★★ | ★ | ★★★ | 중 | TS 유지 (또는 ONNX runtime) |
| **AI 추천 모델 (ONNX)** | (없음) | ★ | ★★ | ★ | ★★ | 고 | ONNX Runtime (별도) |
| **파일 디코더 (WAV/FLAC/MP3/AAC)** | FFmpeg | ★ | ★★ | ★ | ★ | 고 | **TS** (또는 symphonia Rust) 2 |
| **Project file I/O** | TS | ★ | ★★ | ★ | ★★★ | 저 | **TS 유지** |
| **License 검증** | TS | ★ | ★★ | ★ | ★ | 저 | **TS 유지** |
| **UI** | TS / React | ★ | ★ | ★ | ★★★ | 저 | **TS 유지** |

---

## 3. 결론: Rust 1차 범위 (`dsp-core`)

**M2 (4주) 에 Rust 로 구현할 1차 모듈:**

1. **Graph runtime** — 노드/엣지 모델, 블록 단위 실행, 결정적 시드
2. **EQ** (cascaded biquad, RBJ cookbook + matched-Z) — 8-band peak/shelf/HP/LP
3. **Bus Compressor (Glue)** — feed-forward 1176/SSL 모델
4. **3-stage Limiter** — soft-knee + brickwall + ISP (4× oversample)
5. **BS.1770-4 LUFS** — M/S/I + LRA + TP (4×)
6. **Dither** — TPDF / Pow-r 1-3
7. **Oversampling** — half-band FIR (4×/8×/16×)
8. **SRC** — libsoxr binding
9. **FFT** — KissFFT 또는 pffft 래핑 (분석용)

**M3 이후 (2차) 모듈:**

- Dynamic EQ
- Multiband Compressor
- Transient Shaper
- Stereo Imager (MS per-band)
- Saturator (Tube/Tape/Soft/Hard)
- De-Esser
- Vocal Enhancer (formant-aware)
- Reference Matching (오프라인 알고리즘)

**TS 에 남겨둘 코드:**

- `engine/orchestrator` (Job 스케줄러 / 프로젝트 / IPC)
- AI 추천 (rule-based; ONNX 모델은 별도 ONNX Runtime)
- QC post-check (메터 결과 파싱)
- License core
- 모든 UI
- 결정 정책 코드 (vocal protection 강도, safe mode 분기 등)

**제거할 코드:**

- FFmpeg `loudnorm`, `acompressor`, `alimiter`, `adynamicequalizer` 의존 (DSP 측은 Rust 로 대체)
- `services/python-audio/app/mastering/` 전체 (알고리즘만 Rust 로 포팅 후 폐기)
- `python/` legacy 트리

---

## 4. Rust 크레이트 구조

```
dsp-core/
├── Cargo.toml                          ─ workspace
└── crates/
    ├── loui-dsp/                       ─ DSP 코어
    │   ├── src/
    │   │   ├── lib.rs                  ─ Module trait, Graph 등
    │   │   ├── graph/                  ─ 그래프 런타임
    │   │   ├── modules/
    │   │   │   ├── eq.rs
    │   │   │   ├── dynamic_eq.rs
    │   │   │   ├── multiband.rs
    │   │   │   ├── glue_comp.rs
    │   │   │   ├── transient.rs
    │   │   │   ├── imager.rs
    │   │   │   ├── saturator.rs
    │   │   │   ├── deesser.rs
    │   │   │   ├── vocal_enhancer.rs
    │   │   │   ├── limiter.rs
    │   │   │   ├── loudness_norm.rs
    │   │   │   ├── dither.rs
    │   │   │   ├── source.rs
    │   │   │   └── sink.rs
    │   │   ├── meters/
    │   │   │   ├── lufs.rs             ─ BS.1770-4
    │   │   │   ├── true_peak.rs
    │   │   │   ├── spectrum.rs         ─ FFT
    │   │   │   ├── correlation.rs
    │   │   │   └── grm.rs              ─ Gain reduction
    │   │   ├── dsp_primitives/
    │   │   │   ├── biquad.rs
    │   │   │   ├── k_weight.rs
    │   │   │   ├── oversample.rs
    │   │   │   ├── window.rs
    │   │   │   ├── envelope.rs         ─ peak/RMS detector
    │   │   │   └── crossover.rs        ─ LR4
    │   │   ├── analyze/
    │   │   │   ├── section.rs          ─ verse/chorus
    │   │   │   ├── artifact.rs
    │   │   │   └── features.rs
    │   │   └── runtime/
    │   │       ├── realtime.rs         ─ 블록 처리, 콜백
    │   │       └── offline.rs          ─ 전체 입력 처리
    │   └── tests/                       ─ DSP unit + golden
    ├── loui-dsp-ffi/                   ─ C-ABI + N-API
    │   ├── src/lib.rs
    │   └── build.rs
    └── loui-dsp-wasm/                  ─ wasm-bindgen
        ├── src/lib.rs
        └── Cargo.toml
```

---

## 5. 의존 라이브러리

| 라이브러리 | 용도 | 라이센스 |
|---|---|---|
| `kissfft` 또는 `pffft` | FFT | BSD |
| `libsoxr` | SRC (FFI binding) | LGPL — 동적 링크만 |
| `napi-rs` | Node.js N-API | MIT |
| `wasm-bindgen` | WASM 인터페이스 | MIT/Apache |
| `dasp` (선택) | DSP 기본 traits | MIT |
| `realfft` | RealFFT (KissFFT 대안) | MIT/Apache |

> **LGPL 회피**: libsoxr 은 LGPL 이므로 동적 링크 (배포 시 LGPL 공지 + 사용자 교체 가능). 라이센스 거부감이 크면 사내 polyphase SRC 구현으로 대체.

---

## 6. ABI / 바인딩

### 6.1 N-API (Node.js)

```ts
// @loui/dsp-core (TS 측 facade)
export interface DspCore {
  createRuntime(graph: GraphSpec, sampleRate: number, blockSize: number): Runtime;
  renderOffline(graph: GraphSpec, audio: Float32Array, opts: RenderOpts): Float32Array;
  versionInfo(): { dspCore: string; commit: string };
}
```

내부적으로 `napi-rs` 로 빌드된 `loui-dsp.node` 를 require.

### 6.2 WASM (Web/Renderer)

```ts
// 같은 API 표면을 WASM 으로
const wasmModule = await import('@loui/dsp-core/wasm');
const core = await wasmModule.init();
const runtime = core.createRuntime(graph, sr, blockSize);
```

같은 결과를 N-API 빌드와 WASM 빌드가 보장해야 함 (golden tests 가 둘 다 통과해야 함).

---

## 7. 결정성 / 크로스 플랫폼

### 7.1 부동소수 비결정성 원천

| 원천 | 대응 |
|---|---|
| FMA 명령 (x86 vs ARM 다름) | `target-feature=-fma` 또는 의도적 사용 (양쪽 동일) |
| 컴파일러 최적화 차이 | Cargo profile 고정, optnone for critical paths |
| denormal 처리 (FTZ/DAZ) | 명시적 set_flush_to_zero |
| 라이브러리 (BLAS 등) | 외부 라이브러리 피하기 |
| 멀티스레딩 | 그래프는 단일 스레드, parallelism 은 명시적/결정적 |

### 7.2 검증

- macOS arm64 / x64, Windows x64, Linux x64 의 빌드가 같은 golden 입력에 같은 SHA256 출력.
- CI matrix 에 4개 플랫폼.
- 차이 발생 시 빌드 차단.

---

## 8. 빌드 / CI

| 단계 | 도구 | 산출물 |
|---|---|---|
| Rust 컴파일 | cargo + cross | per-platform .so / .dylib / .dll |
| N-API 패키징 | napi-rs cli | @loui/dsp-core 의 node prebuilds |
| WASM 빌드 | wasm-pack | @loui/dsp-core/wasm |
| 골든 회귀 | cargo test + 입력 셋 | pass/fail |
| 크로스 플랫폼 | GitHub Actions matrix (mac arm64, mac x64, win x64, linux x64) | 4종 prebuilds |
| 통합 | Turborepo 가 prebuilds 를 desktop 빌드에 포함 | electron-builder 가 픽업 |

prebuilds 는 GitHub Releases 에 attach → npm pkg 에서 postinstall 로 다운로드.

---

## 9. 단계적 도입 전략

**M2 (4주):**
- Rust workspace 셋업
- 5개 핵심 모듈 + 미터 + 디더
- N-API + WASM 빌드
- 골든 회귀 셋 10곡
- 결과: TS UI 가 dsp-core 를 호출해 실시간 미리듣기 + 오프라인 렌더 가능

**M3-M4 (5~14주):**
- 2차 모듈 점진 추가
- 매 모듈 추가 시 골든 회귀 +5곡
- 기존 FFmpeg filter chain 제거 (engine/orchestrator 에서)

**M5 이후:**
- Python 서비스 완전 폐기 (`services/python-audio/` archive 후 삭제)
- Python 미설치 사용자도 동작 (시스템 의존성 1개 ↓)

---

## 10. C++ 대안

Rust 가 선호되지만, 특정 영역에서 C++ 가 더 합리적인 경우:

- 기존 C/C++ DSP 코드 도입 (예: JUCE 의 dsp 모듈 일부, libsoxr, KissFFT 자체)
- VST3 SDK 통합 (장래 v3 의 VST 빌드)
- BSD-licensed 음악 처리 라이브러리 재사용

→ C++ 라이브러리는 `dsp-core/external/` 에 vendor 한 후 Rust FFI 로 호출. 메인 DSP 코드 = Rust, 외부 의존성 = 작은 C/C++.

---

## 11. 비용 추정

| 항목 | 소요 |
|---|---|
| Rust 셋업 + 그래프 런타임 | 1.5주 |
| 5개 핵심 모듈 (EQ / Comp / Limiter / LUFS / Dither) | 2주 |
| 골든 회귀 인프라 | 0.5주 |
| 2차 모듈 (8개) | 4~5주 |
| 결정성 / 크로스 플랫폼 인프라 | 1주 |
| WASM 빌드 / 통합 | 1주 |
| **합계** | **10~11주** (M2 4주 + M3/M4 6~7주 분산) |

---

## 12. 위험 / 완화

| 위험 | 영향 | 완화 |
|---|---|---|
| Rust 인력 확보 | 중 | 1~2명 풀타임 + 기존 TS DSP 알고리즘이 우수한 참조 구현 |
| WASM 성능 부족 | 낮 | 데스크톱은 N-API, 웹은 옵션. 웹에서 풀 마스터링 안 됨도 허용 |
| ABI 호환 깨짐 | 중 | dsp-core SemVer 엄격, engine 와 함께 버저닝 |
| LGPL (libsoxr) | 낮 | 동적 링크 또는 사내 SRC |
| 골든 회귀 유지보수 | 중 | DSP 변경 시 매번 골든 업데이트 정책 / 코드오너 리뷰 강제 |

---

## 13. 정리

- **Rust 로 가야 하는 것**: DSP, 메터링, 오버샘플링, 디더, 그래프 런타임 → 결정성 + 성능 + WASM
- **TS 로 남겨야 하는 것**: UI, 오케스트레이션, 라이선스, 정책, AI 추천 (모델 자체는 ONNX runtime)
- **버릴 것**: FFmpeg 의 DSP 의존 (디코딩 외), Python DSP 코드
- **점진적 전환**: M2 ~ M4 (10~11주) 에 걸쳐 5+8 모듈을 Rust 로
