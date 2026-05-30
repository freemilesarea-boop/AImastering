# M2-lite — UI Streaming Data API

> How meter data flows from the audio thread (Rust dsp-core) to the UI.
> Design only — not implemented in M2-lite; the bindings land in
> M2-lite-NEXT once UI consumers exist.

---

## 1. End-to-end picture (M3+ target)

```
  audio file / live input
            │
            ▼
   ┌─────────────────────┐
   │ AudioContext         │   (renderer process)
   │ ├─ AudioWorkletNode  │   loads loui-dsp WASM
   │ │  • hosts AnalyzerGraph │
   │ │  • process(128 quanta) │
   │ │    × ~10 per 100ms tick │
   │ │  • emits MeterSnapshot │
   │ └─ port.postMessage(snap) │
   └────────────┬────────┘
                │ structured-clone every 100 ms
                ▼
   ┌─────────────────────┐
   │ Renderer main thread │
   │ • MeterStore (Zustand)│
   │ • Components subscribe│
   │ • Render at 60 FPS    │
   │   (RAF, decoupled)    │
   └─────────────────────┘
```

For final mastered-render reporting (offline analysis), the path is
different and uses the N-API binding in the Electron main process:

```
   user clicks "Export"
            │
            ▼
   Electron main → import @loui/dsp-core (N-API)
            │
            ▼
   AnalyzerGraph::process_planar(whole file)
   AnalyzerGraph::snapshot()      ← gated calculations OK
            │
            ▼
   IPC → renderer → results page
```

---

## 2. `MeterSnapshot` JSON contract (already defined in M2-lite)

```ts
interface MeterSnapshot {
  schema: 'loui.dsp-core.snapshot.v1';
  crateVersion: string;          // e.g. '0.1.0'
  sampleRate: number;
  channels: number;
  samplesProcessed: number;      // big-int safe (u64 truncated to f64)
  durationSec: number;
  loudness: {
    integratedLufs: number | null;   // null in tick_snapshot
    shortTermLufs: number;
    momentaryLufs: number;
    loudnessRange: number | null;    // null in tick_snapshot
    truePeakDbtp: number;
    gatedBlocks: number;
  };
  peakRms: { samplePeakDb: number; rmsDb: number };
  stereo:  { correlation: number; msRatioDb: number };
}
```

`null` denotes "calculation requires off-audio-thread work — call the
full `snapshot()` from a worker."

---

## 3. Tick rate + throttling

| Source | Tick rate | Rationale |
|---|---:|---|
| AudioWorklet `process()` | ~750 Hz (128 samples @ 48k → 2.67 ms quantum) | Too fast to update UI |
| dsp-core accumulators    | updated every quantum | hot path |
| `tick_snapshot` build   | every quantum (cheap) | hot path |
| `postMessage` to main   | **every 100 ms** | UI refresh rate |
| React state update      | RAF (≤ 60 FPS) | natural throttle |

The 100 ms post-message cadence matches the existing
`apps/desktop/src/renderer/audio/loudnessProcessor.worklet.js` design,
which is already battle-tested.

---

## 4. WASM build (deferred — M2-lite-NEXT)

Build:
```sh
cd aimaster-desktop/dsp-core/crates/loui-dsp
wasm-pack build --release --target web --out-dir ../../packages/dsp-wasm/pkg
```

The wasm-bindgen layer (TODO) wraps:
```rust
#[wasm_bindgen]
pub struct LouiAnalyzer { graph: AnalyzerGraph }

#[wasm_bindgen]
impl LouiAnalyzer {
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: f64, channels: u32) -> LouiAnalyzer { ... }

    #[wasm_bindgen]
    pub fn process(&mut self, ch0: &[f32], ch1: &[f32]) { ... }

    #[wasm_bindgen]
    pub fn tick_snapshot_json(&self) -> String { ... }  // serialise + return
}
```

JS / TS host:
```ts
import init, { LouiAnalyzer } from '@loui/dsp-wasm';

await init();
const analyzer = new LouiAnalyzer(48_000, 2);

// In AudioWorkletProcessor.process(inputs, outputs):
analyzer.process(inputs[0][0], inputs[0][1]);
// Throttled every ~100 ms:
const snap = JSON.parse(analyzer.tick_snapshot_json());
this.port.postMessage(snap);
```

---

## 5. N-API build (deferred — M2-lite-NEXT)

Build:
```sh
cd aimaster-desktop/dsp-core/crates/loui-dsp
napi-rs build --release --platform --target x86_64-apple-darwin
```

Node / Electron main:
```ts
import { LouiAnalyzer } from '@loui/dsp-native';

const analyzer = new LouiAnalyzer(48_000, 2);
analyzer.processPlanar(leftFloat32, rightFloat32);
const final = JSON.parse(analyzer.snapshotJson());   // off-thread OK
```

---

## 6. Backward-compat: keep AudioWorklet path

Until WASM build lands (M2-lite-NEXT) the existing
`loudnessProcessor.worklet.js` continues to work.  Migration plan:

1. **M2-lite (this commit)**: Rust analyzer runs offline only via
   `analyze_wav` CLI.
2. **M2-lite-NEXT**: WASM build + AudioWorklet host wrapper.  TS
   `loudnessProcessor.worklet.js` retains its current TS implementation
   in parallel.
3. **M3**: UI integration tested A/B (TS vs Rust analyzer).  When
   Rust is verified, deprecate TS.
4. **M3.1**: Remove TS analyzer code from renderer.

Each step is independently shippable — no big-bang switch.

---

## 7. Snapshot subscription model (M3+ UI)

The UI store subscribes to slices of the snapshot for performance:

```ts
// MeterStore (Zustand selector)
const lufsI = useMeter((s) => s.loudness.integratedLufs);
const tp    = useMeter((s) => s.loudness.truePeakDbtp);
const corr  = useMeter((s) => s.stereo.correlation);

// Each component re-renders only when its slice changes.
```

The Worklet → main bridge feeds whole snapshots; the store decomposes
them into atomic slices via shallow-equality selectors.

---

## 8. UI components that consume this stream (M3 sketch)

| Component | Slice |
|---|---|
| `<LufsMeter>` | `loudness.{momentaryLufs, shortTermLufs, integratedLufs, loudnessRange}` |
| `<TruePeakBar>` | `loudness.truePeakDbtp` |
| `<PeakRmsHistogram>` | `peakRms.*` |
| `<StereoVectorScope>` | `stereo.*` |
| `<SpectrumAnalyzer>` | (requires FFT-bin stream, separate channel — M2-lite-NEXT) |

The spectrum visualiser is the one component NOT covered by the
`MeterSnapshot` shape because per-bin magnitudes are too large to ship
every 100 ms (≈ 4 KB).  Spec design:
- Worklet runs FFT internally, but only emits the **binned 1/3-oct** or
  **64-bucket linear** vector — small enough to bundle into the snapshot.
- Or: separate `SpectrumSnapshot` message on a different cadence (e.g.
  30 Hz instead of 10 Hz).

→ Tracked as M2-lite-NEXT design task.

---

## 9. Error handling

| Error class | Behaviour |
|---|---|
| Sample rate mismatch | AudioWorklet sample rate may differ from analyzer's; M3 wrapper resamples or recreates analyzer |
| Channel count change | Recreate the analyzer (rare, on track-switch) |
| FFI panic | wasm-bindgen / napi-rs catch panics and surface as JS errors; Rust side `#![forbid(unsafe_code)]` minimises panic surface |
| Tick throttle delay | postMessage delays > 100 ms may bunch — UI store uses `requestAnimationFrame` to smooth |

---

## 10. Out-of-scope (M3+ later)

| Item | Reason |
|---|---|
| MIDI / OSC out (meters → controllers) | Different transport, separate design |
| Multi-track UIs (multiple analyzers) | M3+ batch mode |
| Time-aligned meter recording for offline playback | Could enable replay of mastering session, but storage-heavy |
| Cross-fade smoothing on snapshot UI | Decorator on the React side, not on dsp-core |
