# M2-lite-NEXT — Performance Verification

> Baselines for each binding layer.  Targets per brief:
> - Analyzer CPU < 2 %
> - UI streaming stable 60 fps
> - No GC spikes from bridge layer

---

## 1. Native (loui-dsp, M2-lite baseline)

From `04-BENCHMARK-RESULTS.md` in the M2-lite milestone:

| Workload | Cost | Note |
|---|---:|---|
| FFT 4096                     | 72.88 µs/call | precomputed twiddles, in-place |
| 60 s stereo @ 44.1k full pass | 163.58 ms     | 366× realtime |
| 256-sample block @ 48k       | 15.74 µs/block | **0.30 % CPU** load |

This is the floor.  Bindings add overhead but it must stay below the
target.

---

## 2. WASM binding (this milestone — measured by inspection + benchmark plan)

### 2.1 Per-call boundary cost

wasm-bindgen overhead for the relevant call types:

| Call | Estimated boundary cost (modern V8 + WASM) | Source |
|---|---:|---|
| `analyzer.processStereo(l, r)` — both `Float32Array` views | ~50 ns | wasm-bindgen documented baseline |
| `analyzer.tickSnapshot()` — returns wrapped struct | ~80 ns | object wrapper allocation |
| `snap.momentaryLufs` (single field read) | ~50 ns | virtual call into wasm |

For a 256-sample block at 48 kHz (block period 5.33 ms):
- `processStereo` boundary: 50 ns
- Rust work: 15.74 µs
- **Total**: ~15.8 µs / 5333 µs = **0.30 % CPU** (same as native)

### 2.2 Snapshot read overhead

Reading 10 fields from a snapshot at 60 Hz:
- 10 boundary crosses × 50 ns = 500 ns per snapshot
- × 60 Hz = 30 µs/s = **0.003 % CPU**

Negligible.

### 2.3 Verification status

- ✅ `cargo build --release --target wasm32-unknown-unknown` produces 105 KB binary.
- ⏳ End-to-end browser benchmark deferred — needs `wasm-pack` + browser harness.
  Documented in `01-WASM-BINDING.md` § 6.

---

## 3. N-API binding (this milestone — design baseline)

### 3.1 Per-call boundary cost

napi-rs is a thin wrapper.  Boundary cost:

| Call | Estimated cost | Source |
|---|---:|---|
| `analyzer.processStereo(l, r)` — Float32Array → &[f32] | ~200 ns | one V8-to-native transition + ABI handoff |
| `analyzer.tickSnapshot()` — returns object | ~500 ns | napi-derive constructs JS object |
| Reading a field on the returned object | ~5 ns | V8 hidden class hit |

### 3.2 Per-block CPU

256-sample block at 48 kHz:
- `processStereo` boundary: 200 ns
- Rust work: 15.74 µs
- **Total**: ~16 µs / 5333 µs = **0.30 % CPU** (same as native)

### 3.3 Verification status

- ✅ `cargo check -p loui-dsp-node` clean.
- ⏳ `napi build` + Node tick-loop benchmark deferred — needs `@napi-rs/cli`.
  Documented in `02-N-API-BINDING.md` § 5 + 6.

Example (`examples/tick-loop.js`) self-prints performance numbers when
run; expected output documented in § 6 of that doc.

---

## 4. UI streaming budget (M3 production target)

The full stack (audio thread → UI render) must stay within these bounds:

| Stage | Budget | Current path |
|---|---:|---|
| `processStereo` (audio thread) | ≤ 5 % of block period | 0.30 % ✓ |
| Snapshot generation | ≤ 1 µs | < 1 µs (no allocation) |
| `postMessage` to main | ≤ 100 µs | (current path; SAB ring later) |
| State store update | ≤ 50 µs | Zustand shallow-eq |
| React re-render | ≤ 8 ms | depends on component tree |
| **Total round-trip** | **≤ 16 ms (60 fps)** | feasible |

---

## 5. Memory / GC verification

### 5.1 WASM-side

Per `processStereo` call:
- Rust state: 0 allocations
- WASM heap: 0 allocations
- JS bridge: 0 allocations

Per `tickSnapshot()`:
- WASM heap: 1 small allocation (the `WasmMeterSnapshot` wrapper, ~50 bytes)
- JS heap: 1 object reference (the JS proxy)

At 10 Hz tick rate over 60 minutes: 36,000 wrappers.  V8's young-gen
collector handles this trivially (sweep < 1 ms).

### 5.2 N-API side

Per `processStereo` call:
- Rust state: 0 allocations
- V8 heap: 0 allocations
- napi-rs bridge: 0 allocations (Float32Array borrowed, not copied)

Per `tickSnapshot()`:
- V8 heap: 1 object literal (~100 bytes)

Same conclusion: trivial GC pressure.

### 5.3 Verification status

- ⏳ Tracking-allocator-based verification deferred to M2-LITE-NEXT-NEXT
  (cargo target + test harness work).
- ✅ Code inspection: no `Vec::new` / `Box::new` / `String::new` in any
  `process_planar` / `tick_snapshot` code path.

---

## 6. Backpressure scenarios

### 6.1 Main thread stalls (heavy render)

| Path | Behavior |
|---|---|
| postMessage queue (current) | Queue grows; on recovery, all pending messages process in burst (potential frame drop) |
| SAB ring (M3) | Producer overwrites oldest slot; on recovery, consumer reads only latest |

Worst case (postMessage path): 1-second stall = 10 queued snapshots.
Recovery processes 10 messages × ~100 µs each = 1 ms — single frame
drop, then back to normal.  Acceptable.

### 6.2 Audio thread underrun

Not caused by analyzer (well within budget).  If it happens, root cause
is downstream (mastering chain, OS scheduling).

---

## 7. Target verification at M3 (not yet measured)

Acceptance criteria for M3-bridge-impl PR:

```
[ ] Analyzer CPU (renderer process) ≤ 2 % during continuous 60 s playback
[ ] No frame drops in the meter UI over 60 s
[ ] Heap snapshot before/after 60 s playback: < 5 MB delta
[ ] GC pause histogram: 95th percentile ≤ 1 ms
[ ] postMessage / SAB write rate matches expected cadence
```

These will be measured by a Playwright-driven Electron session in
M3-bridge-impl.

---

## 8. Summary

| Binding | per-call boundary | per-block CPU | per-snapshot CPU | M3-ready? |
|---|---:|---:|---:|---:|
| Native Rust (loui-dsp) | 0 | 0.30 % | < 0.001 % | ✓ |
| WASM (loui-dsp-wasm)   | ~50 ns | 0.30 % | < 0.005 % | ✓ |
| N-API (loui-dsp-node)  | ~200 ns | 0.30 % | < 0.005 % | ✓ |

All three paths are well below the 2 % CPU target and the 16 ms
round-trip budget.  Real measurements at M3-bridge-impl will confirm.
