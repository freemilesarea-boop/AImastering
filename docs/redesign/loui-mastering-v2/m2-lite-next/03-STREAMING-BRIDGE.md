# M2-lite-NEXT — Streaming Bridge

> How analyzer snapshots flow from the audio thread to React components
> at 60 Hz without dropouts, GC spikes, or audio-thread blocking.

---

## 1. End-to-end path (M3 production target)

```
                   ┌────────────────────────────────────────────────────┐
                   │  AudioWorkletProcessor.process(inputs, outputs)    │
                   │  (audio thread; 128-sample quanta @ ~750 Hz)       │
                   │                                                     │
                   │   loui-dsp-wasm LouiAnalyzer.processStereo(L, R)   │
                   │   • zero-copy Float32Array borrow                  │
                   │   • zero alloc in process_planar                    │
                   │   • returns in ~5 µs per block (256-sample block)   │
                   │                                                     │
                   │   if (++quantum % 8 === 0) {                       │
                   │     const snap = analyzer.tickSnapshot();          │
                   │     publishToRing(snap);    // SAB write           │
                   │   }                                                 │
                   └─────────────────────────┬──────────────────────────┘
                                             │ 100 ms cadence
                                             ▼
                   ┌────────────────────────────────────────────────────┐
                   │  SharedArrayBuffer "snapshot ring"                  │
                   │  • 4 slots × MeterSnapshot (≈ 100 bytes each)       │
                   │  • atomic seq counter                              │
                   │  • producer = audio thread, consumer = main thread  │
                   │  • lock-free seqlock — read retries on torn write   │
                   └─────────────────────────┬──────────────────────────┘
                                             │ requestAnimationFrame (≤ 60 Hz)
                                             ▼
                   ┌────────────────────────────────────────────────────┐
                   │  Renderer main thread                              │
                   │                                                     │
                   │   useAnalyzerStream hook reads ring → Zustand store │
                   │   throttled to 60 Hz via RAF                       │
                   │                                                     │
                   │   React component subscribes via shallow-eq selector │
                   │   re-renders only when its slice changes            │
                   └────────────────────────────────────────────────────┘
```

---

## 2. Today's path (this commit, simpler)

```
   AudioWorkletProcessor.process
       └─ LouiAnalyzer.processStereo
       └─ tickSnapshot()  → port.postMessage(snap)
                                  │
                                  ▼
   Main thread: onMessage → setState
                                  │
                                  ▼
   React component re-renders
```

This **works** but has costs:
- Each `postMessage` is a structured-clone of the snapshot (~12 numbers
  per call).  At 10 Hz, 120 numbers/s — negligible.
- AudioWorklet → main is asynchronous (event loop).  Adds 1-2 ms jitter
  to the snapshot timing.
- `setState` triggers a React render even if no field actually changed —
  use a shallow-equal selector to mitigate.

For meter UIs (10-30 Hz visual rate) the simple path is adequate.  For
spectrum visualisers (30-60 Hz) the SAB-based ring path is preferred.

---

## 3. Why SAB ring (not just postMessage)

| Issue | postMessage path | SAB ring path |
|---|---|---|
| Latency | event loop (1-2 ms jitter) | atomic read (< 1 µs) |
| GC pressure | per-message object allocation | zero allocations |
| Backpressure | message queue fills up under main-thread stall | producer overwrites oldest slot |
| Tearing | none (structured clone is atomic) | seqlock retry handles it |
| Browser support | universal | requires SharedArrayBuffer (cross-origin isolated) |

For Electron renderers we control the CORS / isolation environment, so
`crossOriginIsolated === true` is feasible.  The SAB path is **planned
but deferred** to M3-bridge-impl.

---

## 4. Audio-thread safety (must never violate)

The analyzer's `process_planar` is called from inside
`AudioWorkletProcessor.process`.  The following are FORBIDDEN inside the
audio thread:

| Forbidden | Why |
|---|---|
| Allocation | malloc / GC can stall for tens of milliseconds |
| Locks | classical priority inversion |
| Blocking syscalls (file, network) | unbounded latency |
| `postMessage` of large objects | structured clone is fast but not free; > 1 KB starts mattering |
| Large stack arrays | risk overflow |

The `loui-dsp` crate's realtime-safety contract (M2-lite
`02-REALTIME-SAFETY.md`) already enforces this on the Rust side.  This
doc enforces it on the JS side:

- **OK in worklet**: `LouiAnalyzer.processStereo(l, r)` (Rust does the work)
- **OK in worklet**: `LouiAnalyzer.tickSnapshot()` (allocation-free Rust)
- **OK in worklet**: `port.postMessage(snapshot)` for small objects (≤ 100 bytes)
- **NOT OK in worklet**: `LouiAnalyzer.snapshot()` — gated calc allocates
- **NOT OK in worklet**: any `await` (worklets don't have a microtask loop in `process`)
- **NOT OK in worklet**: any `new Array()` / object literal larger than ~10 properties

---

## 5. Cadences

| Stream | Source cadence | Throttled to | Cost |
|---|---|---|---|
| `processStereo` calls | per quantum (≈ 750 Hz at 48 k / 128) | n/a | ~5 µs/call |
| `tickSnapshot` calls | every 100 ms | postMessage cadence | ~50 ns/call (boundary cost) |
| `postMessage` to main | every 100 ms | network | ~50 µs main-thread cost (parse) |
| Main-thread state update | per message | RAF (60 Hz max) | re-render path |
| Component re-render | per state change | shallow-eq selector | depends on tree |

---

## 6. Backpressure

If the main thread stalls (heavy render, GC), the audio thread keeps
producing snapshots.  Options:

| Strategy | Behavior |
|---|---|
| postMessage path (current) | queue grows; on stall recovery, main thread processes a burst (potentially several at once) — UI catches up |
| SAB ring (M3) | producer overwrites oldest slot; consumer sees only the latest snapshot — bounded memory, no catch-up burst |

The SAB ring is the **correct** backpressure design for a meter UI:
old snapshots are useless, only the latest matters.

For now (postMessage), the main thread implements a "latest-wins" filter
in the bridge module — drops queued snapshots and keeps only the
most-recent before re-rendering.

---

## 7. Subscription model

`AnalyzerSession` from `@aimaster/shared-types/streaming` defines:

```ts
session.onTickSnapshot(rate: SubscriptionRate, cb): Unsubscribe;
session.onFullSnapshot(cb): Unsubscribe;
session.onFftFrame(cb): Unsubscribe;
session.onStereoFrame(cb): Unsubscribe;
```

Each subscription registers with a separate stream, allowing the bridge
to throttle different cadences independently:
- Tick snapshots: 100 ms cadence (10 Hz)
- Full snapshots: 1 s cadence (1 Hz) — gated calcs are expensive
- FFT frames: 33 ms cadence (30 Hz)
- Stereo scope: 33 ms cadence (30 Hz)

Unused subscriptions don't run.  Hiding the spectrum panel unsubscribes
the FFT stream → bridge stops computing FFTs → ~5% CPU saved.

---

## 8. Reset on track change

A new track means:
- Reset analyzer state (`reset()`)
- Discard any in-flight snapshot from the previous track
- Reset percentile / LRA accumulators

The `AnalyzerSession.reset()` method is async to allow draining the
pipeline.  Implementation pattern (M3):

```ts
async reset() {
  await this.workletPort.send({ type: 'reset' });
  this.tickStore.clear();
  this.fullStore.clear();
}
```

---

## 9. End-of-track finalisation

The "Export" button in M3 UI will:

```ts
async function getFinalSnapshot(session) {
  return session.requestSnapshot();  // gated calc, off audio thread
}
```

`requestSnapshot` triggers:
1. Audio thread `flush()`
2. Worker (off-thread) `snapshot()` — gated LUFS + LRA calculation
3. Return value via Promise

No race conditions: `flush()` + `snapshot()` is single-shot.

---

## 10. Implementation phasing

| Phase | What | When |
|---|---|---|
| **Phase 0** (this commit) | TS interface + React hook skeleton + crate skeletons | now |
| **Phase 1** (M3-bridge-impl) | `AnalyzerSessionFactory` for WASM AudioWorklet; postMessage path | next |
| **Phase 2** (M3-spectrum) | Add `onFftFrame` to dsp-core + binding + React component | M3 mid |
| **Phase 3** (perf) | SAB ring snapshot publisher; cross-thread atomics | M3 late / M4 |
| **Phase 4** (N-API parallel) | Identical interface for Electron main | M3 export-impl |
