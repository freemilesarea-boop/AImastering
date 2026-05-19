# M2-lite — API surface + EngineSchema integration

> Defines how `loui-dsp` connects to the existing M1 / M1.5 / M1.75 schemas.

---

## 1. Public Rust API surface (M2-lite v0.1)

```rust
// crate root (lib.rs)
pub const VERSION: &str;
pub struct MeterSnapshot { /* ... */ }

// Re-exports
pub use analyzer::{AnalyzerGraph, AnalyzerOptions};
pub use buffer::{AudioBuffer, AudioBlockRef, AudioBlockMut};
```

**Construction (off the audio thread):**
```rust
let opts = AnalyzerOptions {
    sample_rate: 48_000.0,
    channels: 2,
    peak_rms_window_sec: 1.0,
    stereo_window_sec: 1.0,
};
let mut graph = AnalyzerGraph::new(opts);
```

**Processing (audio thread safe):**
```rust
// Planar channel slices.  No allocation.
graph.process_planar(&[left, right]);

// Cheap snapshot for live meters (≤ 16 ms target).
let tick = graph.tick_snapshot();
```

**Finalisation (off the audio thread):**
```rust
graph.flush();                    // close pending partial block
let final_snap = graph.snapshot(); // includes integrated LUFS + LRA
```

---

## 2. `MeterSnapshot` ↔ `ReferenceProfile.features` field mapping

`MeterSnapshot` field names are deliberately chosen to mirror the
M1.75 `ReferenceProfileFeatures` shape (`packages/shared-types/src/profile/profile.ts`):

| `MeterSnapshot`           | `ReferenceProfile.features.…`               |
|---|---|
| `integrated_lufs`         | `loudness.integratedLufs`                   |
| `short_term_lufs`         | (no direct field — input to percentile aggr.) |
| `momentary_lufs`          | (input to percentile aggr.)                  |
| `loudness_range`          | `loudness.loudnessRange`                    |
| `true_peak_dbtp`          | `loudness.truePeakDbtp`                     |
| `sample_peak_db`          | (informational — not in profile schema)     |
| `rms_db`                  | (informational)                              |
| `correlation`             | `stereo.correlationMean`                    |
| `ms_ratio_db`             | `stereo.msRatioDb`                          |
| `gated_blocks`            | (informational)                              |
| `samples_processed`       | (informational; `provenance.durationSec` derives from this) |

→ Conversion from snapshot to partial profile = direct field copy + a
small Python adapter that fills in the percentile fields (which need the
historical block series; M2-full will expose this).

---

## 3. `AnalyzerOptions` and `EnginePreset`

The M1 `EnginePreset.output` block carries `sampleRate / bitDepth / format`.
A future `M2-full` adapter materialises `AnalyzerOptions` from the preset:

```rust
fn options_from_preset(preset: &EnginePreset, channels: usize) -> AnalyzerOptions {
    AnalyzerOptions {
        sample_rate: preset.output.sample_rate as f64,
        channels,
        peak_rms_window_sec: 1.0,
        stereo_window_sec: 1.0,
    }
}
```

M2-lite ships the type compatibility but does **not** yet ship the adapter
function — caller writes it.  When the renderer adopts dsp-core
(M3 UI integration), this function moves into the engine-api crate.

---

## 4. JSON contract (`loui.dsp-core.snapshot.v1`)

The `analyze_wav` example serialises a snapshot to JSON with this schema:

```jsonc
{
  "schema": "loui.dsp-core.snapshot.v1",
  "crateVersion": "0.1.0",
  "path": "...",
  "sampleRate": 44100,
  "channels": 2,
  "durationSec": 25.0,
  "samplesProcessed": 1102500,
  "loudness": {
    "integratedLufs": -18.028,
    "shortTermLufs": -18.843,
    "momentaryLufs": -25.903,
    "loudnessRange":   3.110,
    "truePeakDbtp":   -7.402,
    "gatedBlocks":   247
  },
  "peakRms": {
    "samplePeakDb": -7.463,
    "rmsDb":        -23.046
  },
  "stereo": {
    "correlation":  0.188,
    "msRatioDb":    1.654
  }
}
```

`-Infinity` is serialised as `-1e308` (JSON-safe sentinel — readers should
detect via threshold).

---

## 5. FFI boundary plan (deferred to M2-lite-NEXT)

When the dsp-core is wired into Electron and the web renderer, the
boundary will look like this:

```
                  ┌─────────────────────────────────────┐
                  │  apps/desktop renderer / web        │
                  │  • AudioWorklet hosts dsp-core      │
                  │  • Posts MeterSnapshot every 100 ms │
                  └────────────┬────────────────────────┘
                               │ postMessage (MeterSnapshot JSON)
                               │
                  ┌────────────▼────────────────────────┐
                  │  apps/desktop renderer main thread  │
                  │  • Updates React UI                 │
                  └────────────┬────────────────────────┘
                               │
                  ┌────────────▼────────────────────────┐
                  │  Electron preload / IPC             │
                  │  • Forwards to main if needed       │
                  └─────────────────────────────────────┘

                  N-API (native) build:
                  ┌─────────────────────────────────────┐
                  │  Electron main process              │
                  │  • Imports @loui/dsp-core (N-API)   │
                  │  • For file-render analyzer pass    │
                  └─────────────────────────────────────┘

                  WASM build:
                  ┌─────────────────────────────────────┐
                  │  AudioWorklet in renderer / web     │
                  │  • Imports @loui/dsp-core/wasm      │
                  │  • Realtime meter feed              │
                  └─────────────────────────────────────┘
```

Both bindings expose the same `AnalyzerGraph` API.  The build infrastructure
(via `napi-rs` + `wasm-bindgen`) is deferred but the API surface is frozen
now so the bindings drop in without churn.

---

## 6. ABI stability promise (semver guarantees)

M2-lite v0.1.0 → v0.x.y:
- `MeterSnapshot` field additions OK (minor bump).
- Field renames or semantic changes = major bump.
- `AnalyzerOptions` field additions = minor bump (with default fallback).

M2-lite v0.x.y → v1.0.0:
- Full mastering modules added under separate types.
- Existing analysis API guaranteed source-compatible.

---

## 7. Version coupling

| Crate / package | Version | Pinned in |
|---|---|---|
| `loui-dsp` | 0.1.0 | `dsp-core/crates/loui-dsp/Cargo.toml` |
| Snapshot schema | `loui.dsp-core.snapshot.v1` | embedded in JSON, validated by parity script |
| `@aimaster/shared-types/profile` | 1.0.0 | `reference-profile.schema.json` |

A change to one **always** requires reviewing the other two.
