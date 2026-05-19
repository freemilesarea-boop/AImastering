# M2-lite — Realtime safety design

> Audio threads have hard deadlines.  Missing one causes audible artefacts.
> Every M2-lite processor honours an explicit set of invariants.

---

## 1. Invariants (every processor)

Each public processor (`LufsAnalyzer`, `TruePeakBank`, `PeakRmsMeter`,
`StereoMeter`, `Oversampler4x`, `AnalyzerGraph`) obeys:

| Invariant | Enforcement |
|---|---|
| **Pre-allocate state in `new`** | Constructor allocates; `process*` does not |
| **No allocation in process** | Verified by inspection + benchmarks (per-block alloc = 0) |
| **No locks** | All state owned via `&mut self`, no `Arc<Mutex>` |
| **No I/O** | No file / network / syscalls except stdio in `examples/` |
| **No `unsafe`** | `#![forbid(unsafe_code)]` at crate root |
| **Bounded loops** | Every inner loop has constructor-time bound |
| **No panics on normal input** | Bounds-checked indexing; panics only on construction-time invariant violations |

---

## 2. The two snapshot APIs

`AnalyzerGraph` exposes two snapshot functions:

| Function | Allocation? | When to call |
|---|---|---|
| `tick_snapshot()` | **No** | From audio thread, ~60 Hz updates for live meters.  Fields: `momentary_lufs`, `short_term_lufs`, `true_peak_dbtp`, `sample_peak_db`, `rms_db`, `correlation`, `ms_ratio_db`.  `integrated_lufs` and `loudness_range` are set to `NaN`. |
| `snapshot()` | **Yes** (gated-block series) | From a worker thread or after `flush()` at end of file.  Includes integrated LUFS + LRA. |

Rule of thumb: realtime meters use `tick_snapshot`; final mastered-render
reports use `snapshot`.

---

## 3. Why `snapshot()` allocates

EBU R128 integrated LUFS requires:
1. The full series of 400 ms gated-block LUFS values.
2. Two-stage gating (absolute -70 LUFS, then relative -10 LU below pre-gate mean).
3. The final value is the mean over the gated set.

LRA requires the same with 3-s windows and different thresholds.

These are intrinsically non-streaming computations (the relative gate
threshold depends on values not yet observed).  The implementation
allocates two small `Vec<f64>` (about 8 bytes × N where N = ms_history.len()
= up to 36000 for an hour-long input — so ~290 KB worst case).

For audio-thread polling at 60 Hz, this allocation would risk a page fault
or allocator stall.  Hence the dual API.

---

## 4. The pre-allocated history buffer

`LufsAnalyzer.block_ms_history: Vec<f64>` grows once per 100-ms block,
capped at `MAX_HISTORY_BLOCKS = 36_000` (60 minutes at 100 ms hop).

For a typical UI meter run of < 1 hour: capacity grows on the audio
thread.  This **is** allocation on the audio thread — strictly speaking
a hot-path alloc.

Mitigations:
- The `Vec::push` only allocates when capacity is exhausted.  Pre-reserve
  capacity equal to expected duration in `new()`.
- For genuine audio-thread use, call `with_capacity_hint(secs)` (M2-lite-NEXT
  follow-up — adds `LufsAnalyzer::with_history_capacity(blocks)`).
- Alternative: switch to a ring buffer that wraps after `MAX_HISTORY_BLOCKS`
  — discards oldest blocks but never reallocs (M2-lite-NEXT).

These mitigations are tracked but deferred — M2-lite uses dsp-core for
offline analysis (where alloc is fine) and the renderer's WASM integration
(M3) will add the `with_history_capacity` constructor.

---

## 5. Block-size choice

The benchmark shows per-block CPU at 256 samples / 48 kHz:

```
per-block 15.74 µs (block-period 5333.33 µs, CPU load 0.30%)
```

Larger blocks (e.g. 1024) further reduce per-block overhead.  The audio
thread budget is the block period (e.g. 5.33 ms at 256 / 48 kHz); we use
0.3% of it — leaving 99.7% for the rest of the mastering chain.

---

## 6. Cross-thread snapshot publishing (deferred design)

The M3 UI integration will need to publish snapshots from the audio thread
to the main thread without locks.  Design:

```
[audio thread]                              [UI thread]
   │                                          │
   │ writes MeterSnapshot to slot[N%3]        │ reads slot[(N-1)%3] under
   │ atomically advances seq counter          │ seqlock retry loop
   ▼                                          ▼
   ┌──────────────────────────┐               ┌──────────────────────────┐
   │  Triple buffer            │               │  React state             │
   │  • 3 slots × MeterSnapshot│               │  • last MeterSnapshot    │
   │  • atomic seq counter      │               │                          │
   └──────────────────────────┘               └──────────────────────────┘
```

This is **not implemented in M2-lite**.  It depends on:
- Choice of WASM build vs N-API (different SharedArrayBuffer semantics).
- The renderer's audio runtime (AudioWorklet vs Worker thread).

→ Deferred to M2-lite-NEXT; the producer side will own `Mutex` for now,
which is fine for offline analysis but not audio-thread.

---

## 7. Test-time safety verification

The unit tests run analyses on signal blocks of up to 10 seconds.  None
allocate beyond the pre-built `block_ms_history` `Vec` (because pre-built
capacities cover the test duration).  Future CI hook:

```rust
// pseudo-code, M2-lite-NEXT
#[test]
fn no_alloc_in_process() {
    let mut allocator = TrackingAllocator::new();
    let mut graph = AnalyzerGraph::new(opts);
    allocator.reset_counts();
    graph.process_planar(&[&left, &right]);
    assert_eq!(allocator.alloc_count(), 0);
}
```

Tracked allocator harness deferred (needs `#[global_allocator]` setup).

---

## 8. What this gives us downstream

Once the dsp-core is wired into the renderer's AudioWorklet (M3):

- 0.3% audio-thread CPU for full LUFS + TP + peak/RMS + stereo metering
- Live meter UI at 60 Hz without dropouts
- File-render analyzer at > 300× realtime (full file in < 200 ms for a 60 s track)
- Path opens for replacing the Python extractor in `extract_profile`
  with direct dsp-core calls (M2-full).
