# M2-lite — Audio buffer + graph foundation

> The `AudioBuffer` / `AudioBlockRef` types and the `AnalyzerGraph`
> composition pattern are the foundations the future full-chain Rust DSP
> will build on.

---

## 1. Buffer types

```rust
pub struct AudioBuffer {          // owned, planar f32
    sample_rate: u32,
    channels: usize,
    frames: usize,
    data: Vec<f32>,               // length = channels * frames
}

pub struct AudioBlockRef<'a> {    // borrowed read-only view
    sample_rate: u32,
    channels: usize,
    frames: usize,
    data: &'a [f32],
}

pub struct AudioBlockMut<'a> {    // borrowed mutable view
    ...
}
```

### 1.1 Why planar?

Two contenders:
- **Interleaved**: `[L0, R0, L1, R1, ...]` — easier for file I/O, friendly to vectorisation when the per-frame work spans channels.
- **Planar**: `[[L0, L1, ...], [R0, R1, ...]]` — friendly for per-channel processing (independent FIR delay lines, etc.) and easy bounds-checked single-channel borrows.

Most M2-lite analyzers process one channel at a time (FIR oversampler,
biquad K-weighting, peak/RMS per channel).  Planar wins.

When interleaved access matters (per-frame K-weighting sum in LUFS), the
loop reads one sample from each channel — no slower than interleaved
since memory accesses are sequential within each channel.

### 1.2 Why `MAX_CHANNELS = 8`?

Stereo today.  5.1 surround is the realistic upper bound for music
mastering.  7.1 is supported with margin.  Anything larger (atmos, etc.)
is a M3+ scope decision.

`MAX_CHANNELS` sizes some `[T; MAX_CHANNELS]` stack arrays in hot loops
to avoid heap allocation.  Raising the constant is a minor SemVer bump
(zero behavioural impact on existing channel counts).

### 1.3 Lifetime model

`AudioBlockRef<'a>` borrows externally-owned data.  No allocation, copy-free.

`AudioBuffer` owns its planar `Vec<f32>` and can hand out either:
- An immutable view via `as_ref() → AudioBlockRef<'_>`.
- A mutable per-channel slice via `channel_mut(ch) → &mut [f32]`.

This mirrors the way Web Audio's `AudioBuffer` exposes per-channel arrays
— the boundary type (when the renderer integrates via WASM) maps directly.

---

## 2. `AnalyzerGraph` composition pattern

`AnalyzerGraph` owns one instance of each meter and dispatches a single
`process_planar` call to all of them:

```rust
pub fn process_planar(&mut self, channels: &[&[f32]]) {
    self.lufs.process_planar(channels);
    self.true_peak.process_planar(channels);
    self.peak_rms.process_planar(channels);
    self.stereo.process_planar(channels);
    self.samples_processed += channels[0].len() as u64;
}
```

### 2.1 Why a struct, not a trait-object graph?

Two options were considered:

| Option | Pros | Cons |
|---|---|---|
| `Vec<Box<dyn DspNode>>` | Pluggable, runtime-composable | Dynamic dispatch overhead, allocation, harder optimisation |
| Concrete struct (chosen) | Inlinable, zero dispatch cost, type-safe | Composition is hard-coded |

M2-lite has 4 analyzer types — the concrete struct is simpler.  M2-full
will introduce `dyn DspNode` for user-composable graphs (EQ → Comp →
Limiter ordering) but the analyzer struct stays flat.

### 2.2 Order of operations

Order doesn't matter for the four current meters (they don't modify
audio, they observe).  When M2-full introduces audio-modifying nodes
(EQ, comp, limiter), the graph will be a DAG with explicit edges and
topological order.

### 2.3 Per-meter reset

`reset()` zeros all internal state.  Call when seeking, switching tracks,
or after a configuration change.

---

## 3. Future graph foundation

When M2-full adds audio-modifying nodes, the graph will look like:

```
        ┌────────┐
        │ source │
        └────┬───┘
             │ audio
        ┌────▼─────────┐         ┌───────────┐
        │ EQ           ├────────►│ AnalyzerGraph
        └────┬─────────┘         │ (sidechain  │
             │                   │  observer)  │
        ┌────▼─────────┐         └───────────┘
        │ Bus Comp     │
        └────┬─────────┘
             │
        ┌────▼─────────┐
        │ Limiter      │
        └────┬─────────┘
             │
        ┌────▼─────────┐
        │ Dither       │
        └────┬─────────┘
             │
        ┌────▼─────────┐
        │ sink         │
        └──────────────┘
```

The AnalyzerGraph stays as a side-chain "observer" that watches the
output without modifying it — same role it plays in M2-lite, just one
node in the larger pipeline.

---

## 4. Buffer ownership transitions

Hand-off pattern for M3+:

```
[file decoder] ──► AudioBuffer (owned)
                       │
                       ▼ as_ref()
                   AudioBlockRef
                       │
                       ▼ process()
                   AnalyzerGraph::process(block)
                       │
                       ▼ tick_snapshot()
                   MeterSnapshot (copy)
                       │
                       ▼ postMessage
                   UI thread
```

For audio-thread use (M3):

```
[AudioWorklet processBuffer]
       │
       │ &[Float32Array] → &[&[f32]]
       ▼
   AnalyzerGraph::process_planar(channels)
       │
       │ every 100 ms
       ▼ tick_snapshot()
   triple-buffer publish (M2-lite-NEXT)
       │
       ▼ UI thread reads
```

---

## 5. Why the bundled K-weighting / oversampler

`k_weighting.rs` and `oversample.rs` are sub-modules of `loui-dsp` — they
have no public consumers besides `lufs.rs` and `true_peak.rs` today.

This keeps them in the same review surface as the analyzers that use
them.  If a future module needs them (e.g. M2-full's limiter would want
the 4× oversampler), they're already public via `pub mod`.

If they outgrow the crate, factor into `loui-dsp-filters` as a sibling
crate — `cargo workspace add` is a single edit.

---

## 6. Future extension: arbitrary FIR oversampling factors

The `Oversampler4x` is fixed at 4×.  When M2-full needs 2× (for cheap
inflation) or 8× / 16× (for higher-end limiter ISP), generic-parameterise:

```rust
pub struct Oversampler<const L: usize> { /* ... */ }

pub type Oversampler2x = Oversampler<2>;
pub type Oversampler4x = Oversampler<4>;
pub type Oversampler8x = Oversampler<8>;
```

The const-generic version compiles to identical optimised code for each
factor.  Deferred until a second factor is actually needed.
