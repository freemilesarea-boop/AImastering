# loui-dsp — Loui Mastering DSP core (M2-lite)

Native (Rust) analysis + metering primitives for the Loui Mastering
pipeline.

**Scope**: analyzer / metering layer only.  Mastering chain stays in
Python through M2-lite.  See `docs/redesign/loui-mastering-v2/m2-lite/`
for the full design.

## Modules

| Module | Purpose |
|---|---|
| `fft`         | Cooley-Tukey radix-2 in-place FFT |
| `window`      | Pre-computed Hann window |
| `biquad`      | Direct-form-II biquad + RBJ cookbook factories |
| `k_weighting` | ITU-R BS.1770-4 K-weighting cascade |
| `lufs`        | EBU R128 LUFS (momentary / short-term / integrated / LRA) |
| `oversample`  | 4× polyphase windowed-sinc oversampler |
| `true_peak`   | 4× oversampled true-peak detector |
| `peak_rms`    | Sliding-window peak + RMS |
| `stereo`      | Pearson correlation + MS ratio + width index |
| `buffer`      | `AudioBuffer` (owned) + `AudioBlockRef`/`Mut` (borrowed) |
| `analyzer`    | `AnalyzerGraph` composition of all of the above |

## Quick start

```rust
use loui_dsp::{AnalyzerGraph, AnalyzerOptions};

let opts = AnalyzerOptions {
    sample_rate: 48_000.0,
    channels: 2,
    peak_rms_window_sec: 1.0,
    stereo_window_sec: 1.0,
};
let mut graph = AnalyzerGraph::new(opts);

// Process planar audio blocks (no allocation).
graph.process_planar(&[left_channel, right_channel]);

// Cheap snapshot for live meters (audio-thread safe).
let tick = graph.tick_snapshot();
println!("Momentary LUFS: {}", tick.momentary_lufs);

// Full snapshot at end of file (allocates — call off audio thread).
graph.flush();
let final_snap = graph.snapshot();
println!("Integrated LUFS: {}", final_snap.integrated_lufs);
```

## Build / test / bench

```sh
# All from this directory (aimaster-desktop/dsp-core/):

cargo check -p loui-dsp                                  # type-check
cargo test  -p loui-dsp                                  # 26 unit tests
cargo build --release --example analyze_wav              # CLI
./target/release/examples/analyze_wav path/to/file.wav   # → JSON snapshot
cargo bench --bench analyzer_bench                       # ≈ 30 s
```

Cross-language parity vs Python `extract_profile`:
```sh
python3 scripts/parity_test.py
# → /tmp/aimaster-m2-lite-parity/report.json
```

## Realtime-safety contract

All processors:
- Pre-allocate state in `::new(...)`.
- Zero allocation in `process` / `process_planar` / `tick_snapshot`.
- No locks, no I/O, no `unsafe` (`#![forbid(unsafe_code)]`).
- Bounded loops.

`snapshot()` (full, with integrated LUFS + LRA) allocates briefly —
call it off the audio thread.  `tick_snapshot()` is allocation-free.

See `docs/redesign/loui-mastering-v2/m2-lite/02-REALTIME-SAFETY.md`.

## Dependencies

**None** at runtime.  All algorithms are hand-written in pure Rust.

## License

MIT OR Apache-2.0 (matches the rest of the workspace).
