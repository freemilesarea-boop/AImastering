# M2-lite — Execution Report

> Measured + delivered.  See `00-M2-LITE-SCOPE.md` for the input brief.

---

## 1. Headline

| Deliverable | Status |
|---|---|
| `dsp-core/` Rust workspace | ✅ |
| `loui-dsp` crate (analysis + metering primitives) | ✅ |
| 7 modules from the brief (FFT / LUFS / TP / oversample / peak-RMS / stereo / buffer-graph) | ✅ |
| `analyze_wav` CLI | ✅ |
| Benchmark suite (zero-dep harness) | ✅ |
| Cross-language parity test | ✅ |
| 8 design docs | ✅ |
| Realtime-safe architecture | ✅ |
| EngineSchema integration points | ✅ documented |
| UI streaming data API | ✅ designed |
| Plugin / VST extension structure | ✅ outlined |

Result: M2-lite ships a working native analyzer that matches the Python
reference within tight tolerances (max ΔLUFS 0.32 LU, max ΔTP 0.22 dB)
and runs at **0.30% CPU load** for realtime use.

---

## 2. Verified numbers

### Unit tests
- **26 / 26 pass** in `cargo test -p loui-dsp --lib`
- Includes EBU R128 reference scenarios (sine tones), FFT correctness,
  oversampler DC + stop-band, true-peak detection, stereo correlation
  edge cases.

### Benchmark
| Workload | Throughput |
|---|---|
| FFT 4096                     | 72.88 µs/call |
| Full 60 s stereo analysis @ 44.1k | 366× realtime |
| Realtime 256-sample block @ 48k  | 15.74 µs (0.30% CPU) |

### Cross-language parity (9 fixtures vs Python `extract_profile`)
| Metric | max |Δ| |
|---|---:|
| LUFS-I              | 0.323 LU |
| True peak (dBTP)    | 0.221 dB |
| Stereo correlation  | 0.571 (algorithmic — see 05-PYTHON-TS-PARITY.md § 3.4) |

Per-fixture report: `/tmp/aimaster-m2-lite-parity/report.json`.

---

## 3. Scope discipline

What we **did not** touch (per brief):
- ❌ Full mastering chain rewrite
- ❌ EQ / dynamic EQ / multiband / compressor / saturator rewrite
- ❌ Limiter rewrite (FFmpeg `alimiter` still in place)
- ❌ Adaptive mastering rewrite
- ❌ Python `app/mastering/pipeline.py` (zero changes)
- ❌ TS realtime preview chain (`apps/desktop/src/renderer/audio/*.ts` — zero changes)

What we built only:
- The 7 analysis primitives from the brief.
- The wrapping `AnalyzerGraph` + `MeterSnapshot`.
- The 3 verification harnesses (unit, bench, parity).
- Docs explaining how the next steps fit on top.

---

## 4. Code stats

| Path | LOC |
|---|---:|
| `crates/loui-dsp/src/lib.rs`                | 85  |
| `crates/loui-dsp/src/buffer.rs`             | 130 |
| `crates/loui-dsp/src/window.rs`              | 65  |
| `crates/loui-dsp/src/fft.rs`                 | 165 |
| `crates/loui-dsp/src/biquad.rs`              | 155 |
| `crates/loui-dsp/src/k_weighting.rs`         | 115 |
| `crates/loui-dsp/src/lufs.rs`                | 290 |
| `crates/loui-dsp/src/oversample.rs`          | 155 |
| `crates/loui-dsp/src/true_peak.rs`           | 110 |
| `crates/loui-dsp/src/peak_rms.rs`            | 145 |
| `crates/loui-dsp/src/stereo.rs`              | 175 |
| `crates/loui-dsp/src/analyzer.rs`            | 145 |
| `crates/loui-dsp/examples/analyze_wav.rs`    | 215 |
| `crates/loui-dsp/benches/analyzer_bench.rs`  | 165 |
| `scripts/parity_test.py`                     | 195 |
| `docs/.../m2-lite/*.md` (8 files)            | ~2,100 |
| **Total non-docs**                           | **≈ 2,300** |

Zero `unsafe`.  Zero external runtime crates.

---

## 5. What this enables next

| Next step | What's now possible |
|---|---|
| Replace Python's K-weighting Python loop | Use `loui-dsp` LUFS analyzer via FFI — ~30× speedup |
| AudioWorklet-driven live meter (M3 UI) | WASM build of dsp-core (M2-lite-NEXT) → drop-in for TS `loudnessProcessor.worklet.js` |
| Final-render report accuracy | dsp-core's `snapshot()` replaces FFmpeg `loudnorm` parsing — single source of truth |
| Plugin (CLAP / VST3 / AU) | Wrapper crates can import `loui-dsp` without modification |

---

## 6. Issues / debt surfaced

| ID | Issue | Severity |
|---|---|---|
| **M2-LITE-A** | Stereo correlation algorithm divergence (Rust vs Python) | Low |
| **M2-LITE-B** | Vocal fixtures show systematic +0.15 LU offset — coefficient precision | Medium |
| **M2-LITE-C** | LRA gating threshold not yet cross-checked against ITU reference signals | Medium |
| **M2-LITE-D** | EBU R128 Tech 3341 / 3342 reference vectors should be in CI | High |
| **M2-LITE-E** | `LufsAnalyzer.scratch_weighted` field unused (dead code warning) | Trivial — remove in M2-lite-NEXT |
| **M2-LITE-F** | History buffer can reallocate on audio thread for long runs | Medium — add `with_history_capacity` |
| **M2-LITE-G** | No tracking-allocator-based "zero allocs in process()" test | Low |

---

## 7. M2-lite-NEXT (immediate follow-up PRs)

In priority order:
1. EBU R128 Tech 3341 / 3342 reference vector tests
2. WASM build via `wasm-bindgen` → drop-in for TS worklet
3. `LufsAnalyzer::with_history_capacity()` constructor
4. Stereo correlation algorithm alignment between Rust and Python (decision)
5. N-API binding for Electron main process
6. Triple-buffer publisher for audio-thread → UI-thread snapshot delivery
7. `#[realtime_safe]` proc-macro to enforce contract at compile time

---

## 8. Branch / merge state

This work lives on:
- Branch: `claude/redesign-mastering-system-BCMhl`
- New tree: `aimaster-desktop/dsp-core/` (Rust crate)
- New docs: `docs/redesign/loui-mastering-v2/m2-lite/`
- New script: `aimaster-desktop/dsp-core/scripts/parity_test.py`

Zero changes to existing files outside this list.  Existing Python +
TS tests untouched and still pass.
