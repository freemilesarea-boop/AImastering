# M2-lite — Scope

> M2-lite **is not** a full Rust rewrite.  It builds the minimum native
> analysis core that unblocks realtime UI + future plugin work, leaving
> the existing Python mastering chain intact.

---

## 1. Rationale

M1 / M1.5 / M1.75 established schema + policy + reference profile.  Two
performance / architecture bottlenecks remain:

1. **FFmpeg spawn cost** — every mastering job spawns FFmpeg 7~9 times,
   each ~500 ms latency.  Realtime preview is impossible.
2. **Python analyzer cost** — `extract_profile` ≈ 2 s per fixture.
   Realtime spectral meters need ≤ 16 ms.

A full Rust rewrite would solve both but takes 6+ months.  M2-lite
attacks the **measurement / metering layer only** so:
- The renderer gets a fast native analyzer for live meters.
- The mastering chain stays in Python (no behavioural risk yet).
- The Rust crate is the foundation for future EQ / dynamics / limiter
  modules in M2-full.

---

## 2. What M2-lite delivers

A Rust workspace at `aimaster-desktop/dsp-core/` with one crate `loui-dsp`
implementing **seven primitives** plus an analyzer-graph composition:

| Module | File | Purpose |
|---|---|---|
| **FFT** | `fft.rs` | Cooley-Tukey radix-2, in-place, zero-alloc process |
| **LUFS** | `lufs.rs` | EBU R128 — momentary / short-term / integrated / LRA |
| **True-Peak** | `true_peak.rs` | 4× oversampled, per-channel + max |
| **Oversampler** | `oversample.rs` | 4× polyphase windowed-sinc, > 50 dB stop-band |
| **Peak/RMS** | `peak_rms.rs` | Sliding-window per-channel + bus |
| **Stereo correlation** | `stereo.rs` | Pearson + MS ratio + width index |
| **Audio buffer graph** | `buffer.rs`, `analyzer.rs` | AudioBuffer + AnalyzerGraph composition |

Plus:
- K-weighting cascade (`k_weighting.rs`)
- Biquad + RBJ cookbook (`biquad.rs`)
- Window functions (`window.rs`)
- `analyze_wav` CLI (`examples/analyze_wav.rs`)
- Hand-rolled benchmark harness (`benches/analyzer_bench.rs`)
- Cross-language parity script (`scripts/parity_test.py`)

---

## 3. What M2-lite explicitly does NOT do

| Out-of-scope | Reason |
|---|---|
| **EQ / Dynamic EQ / Multiband** | Rewriting these would replace the entire chain — deferred to M2-full |
| **Bus / Multiband compressor** | Same |
| **Saturator** | Same |
| **Limiter** | Same — keep FFmpeg `alimiter` until full chain rewrite |
| **Adaptive mastering** | Stays in Python (M1.75) — orchestrator only |
| **FFI / N-API / WASM bindings** | Deferred to "M2-lite-NEXT" PR — out-of-scope for this commit |
| **Mid/Side encode/decode for processing** | Analysis only, no processing path |
| **Real audio thread integration** | API designed for it, but integration is M3 UI work |

---

## 4. Architectural decisions

### 4.1 Zero external runtime dependencies

The `loui-dsp` `Cargo.toml` has `[dependencies]` empty.  Every algorithm is
hand-written in pure Rust.  This:
- Guarantees an audited supply chain.
- Eliminates "vendor a giant numpy alternative" debt.
- Makes the WASM build straightforward (no native shims to port).

### 4.2 No `unsafe` code

`#![forbid(unsafe_code)]` at the crate root.  Bounds-checked indexing is
explicitly chosen over raw-pointer perf wins — measurements (§ 4 of the
benchmark report) show 366× realtime is already comfortable for any UI.

### 4.3 Realtime-safe API contract

All processors:
- **Pre-allocate** state in `::new(...)`.
- **No allocation** in `process` / `process_planar` / `tick_snapshot`.
- **No locks** (everything is `&mut self`).
- **No I/O** — file/network are caller responsibility.
- **Bounded** — every loop has a compile-time or constructor-time bound.

The only "audio-thread-unsafe" function is `snapshot()` on the analyzer
graph, which builds gated-block series for integrated LUFS / LRA (these
require allocation).  For audio-thread use, call `tick_snapshot()` —
no allocation, only momentary/short-term metrics.

### 4.4 Module composition via AnalyzerGraph

`AnalyzerGraph` owns one instance of each meter.  `process_planar(channels)`
fans the input out to all meters.  This:
- Keeps cache locality (the same audio buffer goes through several passes
  but each is sequential per-frame).
- Lets the caller choose which meters to instantiate (M2-full will
  parameterise this).
- Mirrors the future `dsp-core` graph runtime that will host the full
  mastering modules.

---

## 5. Layered approach (M2-lite vs M2-full)

```
M2-lite (this commit):
┌─────────────────────────────────────────────────────────────────┐
│  loui-dsp 0.1                                                    │
│    • Analysis / metering primitives (this scope)                 │
└──────────────────────┬──────────────────────────────────────────┘
                       │ calls (Python via subprocess for now)
                       │
M2-full (future):
┌──────────────────────▼──────────────────────────────────────────┐
│  loui-dsp 1.0                                                    │
│    • + EQ, Dynamic EQ, Bus Comp, Multiband, Saturator           │
│    • + Limiter, ISP safety, Dither                               │
│    • + Graph runtime (consume EnginePreset directly)            │
└──────────────────────┬──────────────────────────────────────────┘
                       │ in-process FFI (N-API + WASM)
                       │
┌──────────────────────▼──────────────────────────────────────────┐
│  Python mastering chain  ←─ deprecated, kept for fallback        │
└─────────────────────────────────────────────────────────────────┘
```

---

## 6. Verification status (M2-lite kickoff)

| Verification | Result |
|---|---|
| Crate builds clean | ✅ `cargo check -p loui-dsp` |
| Unit tests | ✅ **26/26 pass** in 0.74 s |
| EBU R128 -23 dBFS sine (mono) → -23 LUFS-I | ✅ ±0.5 LU |
| EBU R128 -23 dBFS sine stereo → -20 LUFS-I (channel sum) | ✅ ±0.5 LU |
| Silence → -Infinity LUFS | ✅ |
| FFT cosine spike at correct bin | ✅ |
| Oversampler DC pass-band ≈ 1.0 | ✅ ±0.05 |
| Oversampler stop-band > 50 dB | ✅ |
| TP detects ISP above sample peak | ✅ |
| Stereo correlation: mono → 1.0, antiphase → -1.0 | ✅ |
| **Cross-language parity vs Python** | ✅ max ΔLUFS 0.32, max ΔTP 0.22 dB (9 fixtures) |

See `04-BENCHMARK-RESULTS.md` and `05-PYTHON-TS-PARITY.md`.

---

## 7. Done-when checklist

- [x] dsp-core crate created with module skeleton
- [x] All 7 primitives implemented + unit-tested
- [x] AnalyzerGraph composition
- [x] CLI tool (`analyze_wav`) for parity validation
- [x] Benchmark suite (hand-rolled, no `criterion` dep)
- [x] Python parity script + report
- [x] EngineSchema integration points documented (see `01-API-AND-SCHEMA-INTEGRATION.md`)
- [x] UI streaming data API designed (see `06-UI-STREAMING-API.md`)
- [x] Plugin / VST extension structure outlined (see `07-PLUGIN-VST-FUTURE.md`)

---

## 8. M2-lite-NEXT (immediate follow-up, deferred from this commit)

| Item | Rationale for deferral |
|---|---|
| `napi-rs` binding | M3 UI needs to start using this; defer until UI consumer exists |
| `wasm-bindgen` binding | Same — defer until renderer side has a consumer |
| Lock-free triple-buffer snapshot publisher | Needed for actual audio-thread integration; pending UI |
| SIMD intrinsics (where safe) | Optimise after baseline; current 366× realtime is already excessive |
| `realtime_contract.rs` proc-macro | Quality-of-life enforcement; not blocking |
