# M3 Entry — FFT Streaming + Live Meter Foundation

> Foundation work before M3 UI proper.  Closes the M2-LITE-NEXT-E gap
> (FFT not exposed to bindings) and builds the first generation of
> stream-backed meter components.

---

## 1. Where we are

| Milestone | Status |
|---|---|
| M1 / M1.5 / M1.75 | ✅ schemas + policy + reference profiles |
| M2-lite           | ✅ Rust `loui-dsp` core (analysis + metering) |
| M2-lite-NEXT      | ✅ WASM + N-API bindings, TS streaming types, hook skeleton |
| **M3-entry (this)** | **✅ FFT streaming API + live meter foundation** |
| M3 UI             | next — actual Ozone-style panels wired into pages |
| M2-full           | future — Rust mastering chain |

---

## 2. What M3-entry delivers

| Artefact | Where |
|---|---|
| `SpectrumAnalyzer` (Rust)         | `dsp-core/crates/loui-dsp/src/spectrum.rs` (455 LOC) |
| FFT API on WASM binding           | `dsp-core/crates/loui-dsp-wasm/src/lib.rs` (added) |
| FFT API on N-API binding          | `dsp-core/crates/loui-dsp-node/src/lib.rs` (added) |
| Synthetic `AnalyzerSession` factory | `apps/desktop/src/renderer/audio/analyzer-session-synthetic.ts` |
| `LoudnessMeterPanelV2` component  | `apps/desktop/src/renderer/components/LoudnessMeterPanelV2.tsx` |
| `SpectrumAnalyzerPanel` component | `apps/desktop/src/renderer/components/SpectrumAnalyzerPanel.tsx` |
| 6 design docs                     | `docs/redesign/loui-mastering-v2/m3-entry/` |

The two React components are **parallel** — they do not replace the
existing `LoudnessMeterPanel` and they are not yet wired into any page.
M3 UI work makes that swap.

---

## 3. What M3-entry explicitly does NOT do

| Out-of-scope | Reason |
|---|---|
| **UI redesign** | M3 work; this milestone is the data plumbing |
| **EQ / compressor / saturator rewrite** | M2-full |
| **Mastering chain rewrite** | M2-full |
| **Adaptive mastering rewrite** | M1.75 already covers; M2-full will refine |
| **Preset overhaul** | M3 / future |
| **Wiring V2 panels into pages** | M3 — done as part of the actual UI redesign |
| **AudioWorklet ↔ WASM glue code** | M3 bridge wiring — needs the WASM build artefact |

---

## 4. End-to-end pipeline (now possible)

```
Audio source (file / live)
        │
        ▼
   ┌────────────────────────────┐
   │ AnalyzerSession (interface) │  ← @aimaster/shared-types/streaming
   └────┬───────────────────────┘
        │ implementations:
        │   • SyntheticAnalyzerSessionFactory (dev / smoke)
        │   • WasmAnalyzerSessionFactory      (M3 production)
        │   • NapiAnalyzerSessionFactory      (Electron main export-time)
        ▼
   ┌────────────────────────────┐
   │ useAnalyzerStream React hook │
   └────┬───────────────────────┘
        │ tick / full / fft / stereo streams
        ▼
   ┌────────────────────────────┐
   │ LoudnessMeterPanelV2        │
   │ SpectrumAnalyzerPanel       │
   │ (plus future components)    │
   └────────────────────────────┘
```

The synthetic factory proves this stack works end-to-end **today**.  The
WASM factory (M3) replaces the data source — the rest of the chain is
unchanged.

---

## 5. Performance (measured in this commit)

| Workload | Native Rust | Notes |
|---|---:|---|
| Spectrum FFT 2048 (frame) | 42.88 µs | 128 log bins + smoothing + peak-hold |
| Spectrum FFT 4096 (frame) | 86.31 µs | "" |
| **Spectrum realtime 256-block @ 48k (2048 FFT)** | **10.65 µs** | **0.20 % CPU** |
| Full AnalyzerGraph 60 s stereo @ 48k | 184 ms | 326× realtime |
| 256-block realtime (loudness chain) | 16 µs | 0.30 % CPU |

Combined live realtime (loudness chain + spectrum) = **~0.5 % CPU @ 256-block / 48k**.
Well within the M3 target (analyzer CPU < 3 %, stable 60 fps).

---

## 6. Verification status

### In-repo (passes in this commit)

| Check | Result |
|---|---|
| `cargo test -p loui-dsp --lib` | ✅ **31/31** (was 26 + 5 new spectrum tests) |
| `cargo check --workspace`      | ✅ |
| `cargo build --release --target wasm32-unknown-unknown` | ✅ **136 KB** binary (105 → 136 KB, +31 KB for FFT) |
| `cargo bench --bench analyzer_bench` | ✅ 8 benches incl. 3 new spectrum |
| `pnpm typecheck` shared-types | ✅ |
| `pnpm typecheck` apps/desktop  | ✅ (incl. new V2 components + synthetic factory) |

### Deferred (need external tooling)

| Check | Why deferred | Doc |
|---|---|---|
| `wasm-pack build --target web` | needs `wasm-pack` CLI | `01-FFT-STREAMING.md` § 5 |
| `napi build --release --platform` | needs `@napi-rs/cli` | `01-FFT-STREAMING.md` § 5 |
| Browser end-to-end FPS test | needs browser runtime | `04-LIVE-METER-PANEL.md` § 7 |
| Electron production FPS test | needs Electron runtime + WASM binary | `04-LIVE-METER-PANEL.md` § 7 |

---

## 7. Document map

| Doc | Audience |
|---|---|
| `00-OVERVIEW.md` (this) | M3 leads |
| `01-FFT-STREAMING.md`  | DSP integrators |
| `02-ANALYZER-SESSION.md` | TS / React engineers |
| `03-SPECTRUM-PANEL.md`  | UI engineers |
| `04-LIVE-METER-PANEL.md`| UI engineers |
| `05-PERFORMANCE-RESULTS.md` | performance engineers |

---

## 8. Issues for M3 backlog

| ID | Issue | Severity |
|---|---|---|
| **M3-A** | WASM/N-API FFT returns `Vec<f64>` — Float32Array zero-copy variant is a follow-up | Medium |
| **M3-B** | `SyntheticAnalyzerSessionFactory` is dev-only; production needs real WASM AudioWorklet factory | High (M3 P0) |
| **M3-C** | `binning` field of `FftFrame` is now optional — TS bindings should populate when known | Low |
| **M3-D** | `LoudnessMeterPanelV2` doesn't fall back gracefully on `NaN` integrated LUFS during early playback | Low |
| **M3-E** | `SpectrumAnalyzerPanel` peak-hold trace has no fade-out animation — looks "frozen" if no recent peaks | Low — cosmetic |
| **M3-F** | `LoudnessAnalyzer` (TS) doesn't expose LRA; synthetic factory hardcodes 0 | Low — superseded by WASM factory |

---

## 9. Next commits

In strict order:
1. **M3-bridge-impl**: real `WasmAnalyzerSessionFactory`.  AudioWorklet
   hosting the WASM analyzer, MessagePort streaming.
2. **M3-meter-swap**: swap existing `LoudnessMeterPanel` to V2 behind a
   feature flag.  A/B over a week.  Promote V2, delete V1.
3. **M3-spectrum-page**: drop `SpectrumAnalyzerPanel` into a page.
4. **M3-stereo-scope**: vectorscope component on top of the
   `onStereoFrame` channel.
