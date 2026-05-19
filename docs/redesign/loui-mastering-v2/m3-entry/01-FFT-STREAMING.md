# M3-entry — FFT Streaming API

> The Rust `SpectrumAnalyzer` and its WASM / N-API bindings.

---

## 1. Rust API (`loui-dsp::spectrum::SpectrumAnalyzer`)

Construction:
```rust
use loui_dsp::spectrum::{SpectrumAnalyzer, SpectrumBinning, SpectrumOptions};

let analyzer = SpectrumAnalyzer::new(48_000.0, SpectrumOptions {
    fft_size: 2048,
    hop_size: Some(1024),       // 50 % overlap; None = default (fft_size / 2)
    binning: SpectrumBinning::Log { bins: 128, min_hz: 20.0, max_hz: 20_000.0 },
    smoothing: 0.5,             // exp-MA coefficient (0..1, larger = slower)
    peak_hold_decay_db: 1.5,    // dB per FFT frame
});
```

Streaming:
```rust
// Push planar audio (channels mixed to mono internally).
analyzer.process_planar(&[&left, &right]);

// Try to compute an FFT frame (consumes one hop's worth of samples).
if analyzer.try_frame() {
    let mag = analyzer.magnitude_db();      // smoothed dB per output bin
    let peak = analyzer.peak_hold_db();     // peak-hold dB per output bin
    let centres = analyzer.bin_centres();    // Hz per output bin (fixed)
    // render…
}
```

All methods are **zero-allocation in the hot path**.  Internal scratch
buffers (FFT in/out + magnitude) are pre-allocated in `::new`.

---

## 2. Configurable parameters

| Parameter | Range / valid values | Default | Effect |
|---|---|---|---|
| `fft_size`           | 1024 / 2048 / 4096 / 8192 | 2048 | Frequency resolution + analysis latency |
| `hop_size`           | ≥ 1 (typically fft_size/2 or fft_size/4) | fft_size / 2 | Time resolution / frame rate |
| `binning`            | `ThirdOctave` / `Log` / `Linear` | Log 128 bins 20-20k | Output bin layout |
| `smoothing`          | 0.0..0.999 | 0.5 | Per-bin EMA frame-to-frame mix |
| `peak_hold_decay_db` | ≥ 0 (dB/frame) | 1.5 | How fast peak-hold falls |

### 2.1 FFT size guidance

| FFT size | @ 48 kHz | Frequency resolution | Per-frame cost |
|---|---|---|---:|
| 1024  | 21.3 ms | 46.9 Hz/bin | ~21 µs |
| 2048  | 42.7 ms | 23.4 Hz/bin | ~43 µs |
| 4096  | 85.3 ms | 11.7 Hz/bin | ~86 µs |
| 8192  | 170.6 ms | 5.86 Hz/bin | ~190 µs |

For Ozone-style live spectrum: **2048 at 50 % overlap** is the standard
choice — 43 ms latency, 23 Hz/bin resolution (≈ 1/3-oct equivalent at
low frequencies).

### 2.2 Binning options

- `ThirdOctave` — ANSI S1.11 centres (30 bins, 25 Hz .. 20 kHz).  Matches
  the M1.75 ReferenceProfile spectrum schema → direct interop.
- `Log` — log-spaced between user min/max.  Standard for spectrum
  visualisers (low-freq detail).
- `Linear` — linear bins.  Useful for spectrogram heatmaps.

Bin count hard-capped at **256** to keep postMessage payloads bounded
and prevent fingerprint-resolution misuse.

### 2.3 Smoothing policy

Per-bin **exponential moving average** in dB:
```
smoothed[i] = coef * smoothed[i] + (1 - coef) * new[i]
```

- `coef = 0.0` → no smoothing (newest frame wins).
- `coef = 0.5` → 50 % mix (default; ~70 ms time constant at 30 Hz frame rate).
- `coef = 0.9` → slow / "molten" look.

### 2.4 Peak-hold policy

Per-bin peak with linear decay:
```
peak[i] = max(smoothed[i], peak[i] - decay_db)
```

Default 1.5 dB/frame → ~30 frames for full reset (~1 s at 30 fps).
Set to 0 to disable decay (true infinity peak hold).

---

## 3. JS surface — WASM (`@loui/dsp-wasm`)

After `wasm-pack build --target web`:

```ts
import init, {
  LouiSpectrumAnalyzer,
  WasmSpectrumOptions,
} from '@loui/dsp-wasm';

await init();

const opts = new WasmSpectrumOptions()
  .setFftSize(2048)
  .setSmoothing(0.5)
  .useLog(128, 20, 20_000);

const sa = new LouiSpectrumAnalyzer(48_000, opts);

// In the audio thread (AudioWorkletProcessor.process):
sa.processStereo(left, right);
if (sa.tryFrame()) {
  // Vec<f32> over wasm-bindgen — copied to JS heap.  For a 128-bin
  // analyzer at 30 fps that's 30 × 128 × 4 = 15 KB/s.  Trivial.
  const mag = sa.magnitudeDb;
  const peak = sa.peakHoldDb;
  // bin centres are fixed for analyzer lifetime — cache on first read:
  const centres = sa.binCentresHz;
  // render…
}
```

---

## 4. JS surface — N-API (`@loui/dsp-node`)

After `napi build --release --platform`:

```js
const dsp = require('./loui-dsp-node.linux-x64-gnu.node');

const sa = new dsp.LouiSpectrumAnalyzer(48_000, {
  fftSize: 2048,
  hopSize: 1024,
  binning: { kind: 'log', bins: 128, minHz: 20, maxHz: 20_000 },
  smoothing: 0.5,
  peakHoldDecayDb: 1.5,
});

sa.processStereo(left, right);
const frame = sa.tryFrame();
if (frame) {
  // frame.binCentresHz  : number[]    (length = 128)
  // frame.magnitudeDb   : number[]
  // frame.peakHoldDb    : number[]
  // frame.samplesProcessed
  // frame.sampleRate
  // frame.fftSize
}
```

(N-API arrays use `Vec<f64>` — see `M3-A` follow-up for Float32Array
zero-copy.)

---

## 5. Build

Both bindings build with the existing M2-lite-NEXT instructions —
nothing new at this step:

```sh
# WASM
cd aimaster-desktop/dsp-core/crates/loui-dsp-wasm
wasm-pack build --release --target web --out-dir pkg

# N-API
cd aimaster-desktop/dsp-core/crates/loui-dsp-node
napi build --release --platform
```

---

## 6. Verification

| Check | Status |
|---|---|
| `cargo test -p loui-dsp --lib spectrum` | ✅ 5/5 pass |
| `cargo bench --bench analyzer_bench` | ✅ FFT 2048: 42.88 µs/frame |
| Realtime 256-block @ 48k (2048 FFT) | ✅ 10.65 µs/block = 0.20 % CPU |
| `cargo check -p loui-dsp-wasm --target wasm32-unknown-unknown` | ✅ |
| `cargo check -p loui-dsp-node` | ✅ |
| WASM release binary size | 136 KB (+31 KB vs M2-lite-NEXT baseline) |

---

## 7. Issues surfaced

| ID | Issue | Severity |
|---|---|---|
| M3-A | N-API returns `Vec<f64>` (napi-rs Vec<f32> unsupported as object field) — Float32Array variant deferred | Medium |
| M3-C | `binning` field of `FftFrame` TS type — should be populated by bindings when known | Low |

These don't block M3 UI work; tracked for M3-followup.
