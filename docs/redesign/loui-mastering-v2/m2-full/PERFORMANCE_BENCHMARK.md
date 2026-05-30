# M2-full — Performance / Benchmark Report

> CPU + realtime-safety characteristics of the Rust mastering chain.

---

## 1. Realtime-safety (by construction)

Every module satisfies the dsp-core realtime contract:

| Module | Allocation in process? | Locks? | Bounded loops? |
|---|---|---|---|
| Gain      | none | none | yes (block length) |
| EQ        | none (biquads pre-built) | none | yes |
| Dynamics  | none (envelope is scalar state) | none | yes |
| Imager    | none (one biquad on Side) | none | yes |
| Limiter   | none (delay lines pre-allocated for MAX_LOOKAHEAD) | none | yes (lookahead window) |
| Chain     | none | none | yes |

The limiter pre-allocates its delay + peak-ring for the maximum
lookahead (20 ms) in the constructor; `set_config` only changes the
active window length — never reallocates.

`#![forbid(unsafe_code)]` holds across the new modules.

---

## 2. Per-sample cost (analytic)

| Module | Ops/sample (approx) |
|---|---|
| Gain | 2 mul |
| EQ | 5 biquads × 2 ch = ~10 biquads (5 mul + 4 add each) |
| Dynamics | 1 log, 1 exp, a few mul/add (stereo-linked) |
| Imager | 1 biquad (Side) + M/S encode/decode |
| Limiter | lookahead-window max scan (≤ ~96 samples @ 2 ms / 48 k) + smoothing |

The limiter's window scan is the dominant cost.  At a 2.5 ms lookahead /
48 kHz that's ~120 samples scanned per output sample — O(lookahead).  A
follow-up optimisation (monotonic-deque sliding max) reduces this to
O(1); documented but not needed for the preview budget.

---

## 3. CPU budget target

| Component | Target |
|---|---|
| Analyzer (FFT + meters) | existing |
| + Mastering preview chain | analyzer + chain combined < 10% of one core |
| Audio glitches | none (block-based, realtime-safe) |
| Allocation | zero in the audio path |

The chain is block-based and allocation-free, so it cannot cause GC
pauses or audio-thread blocking.  The limiter window scan is the only
super-linear cost; with a 1-2 ms lookahead it's well within budget.

---

## 4. Measurement plan (device test — not run in sandbox)

The sandbox has no audio device, so live CPU wasn't measured.  When
device-testing the realtime flag:

1. Build with `VITE_LOUI_REALTIME_PREVIEW=true`.
2. Play a track; open DevTools → Performance.
3. Measure the AudioWorklet callback time per block; confirm:
   - chain process < ~30% of the block period (headroom for jitter)
   - analyzer + chain combined < 10% of one core
   - no `audioprocess` overruns / no audible clicks
4. Stress: rapid parameter changes (knob drag) — confirm
   `set_config` doesn't allocate / glitch (it doesn't — coefficient
   recompute only).

A `cargo bench` harness (criterion) for `process_stereo_block` is a
follow-up; the unit tests already validate correctness + no-NaN under
config churn.

---

## 5. Bundle / artifact size

| Artifact | Before | After | Δ |
|---|---|---|---|
| `loui_dsp_wasm_bg.wasm` | 99 KB | 139 KB | +40 KB (mastering chain) |
| renderer JS | ~444 KB | ~444 KB | +~0.4 KB (flag + mapping) |

The +40 KB WASM is the mastering chain code (5 modules + chain + binding).
Loaded once; no per-frame cost.

---

## 6. Verdict

- Realtime-safe by construction (no alloc / locks / unbounded loops).
- Block-based → no audio-thread blocking.
- Limiter window scan is the only super-linear cost; fine at 1-2 ms
  lookahead, O(1) optimisation documented for later.
- Live CPU measurement deferred to device testing (flag OFF by default
  until then).
