# M3-bridge-impl — Streaming Performance

> Predicted (from native Rust benchmarks + bridge cost estimates) and
> the manual measurements that should follow when this lands in browser.

---

## 1. Cost breakdown (predicted)

### Audio thread (worklet)

| Stage | Cost / quantum (128 samples @ 48k) |
|---|---:|
| Copy `inputs[0][c]` → `Float32Array` × 2 ch | ~1 µs |
| Allocate two `Float32Array(128)` | ~1 µs (V8 young-gen) |
| `port.postMessage(payload, [buffers])` enqueue | ~5 µs |
| Copy `inputs[0][c]` → `outputs[0][c]` × 2 ch (passthrough) | ~1 µs |
| **Total audio-thread work** | **~8 µs / quantum** = **0.3 % CPU** |

Block period @ 48k / 128 = 2.67 ms → 0.3 % CPU is well under the 5 %
audio-thread budget recommended by Chromium.

### Main thread (per audio-thread message)

| Stage | Cost |
|---|---:|
| `port.onmessage` dispatch | ~2 µs |
| `LouiAnalyzer.processStereo(left, right)` — WASM call | ~20 µs (M3-entry baseline: 16 µs analyzer + 5 µs overhead) |
| `LouiSpectrumAnalyzer.processStereo(left, right)` — WASM call | ~12 µs (M3-entry baseline: 10 µs spectrum + 2 µs overhead) |
| `tryFrame()` (spectrum FFT, every hop) | ~43 µs / hop @ 2048 FFT |
| Snapshot emit (tick @ 60 Hz, fft @ 30 Hz, stereo @ 30 Hz, full @ 1 Hz) | ~5 µs / emit, ~2 emits / quantum on average |
| Subscriber callback dispatch | depends on consumer (UI render) |
| **Total main-thread per-quantum work** | **~40 µs** = **0.4 % CPU** |

### React render

| Stage | Cost / second |
|---|---:|
| `LoudnessMeterPanelV2` @ 30 Hz tick | ~15 ms / s = 1.5 % CPU |
| `SpectrumAnalyzerPanel` (RAF @ 60 Hz, frame ref read) | ~14 ms / s = 1.4 % CPU |
| **Total per visible V2 instance** | **~3 % CPU** |

---

## 2. Aggregate prediction

For a renderer page hosting both V2 panels with a single active analyzer:

| Path | CPU |
|---|---:|
| Audio thread (worklet) | 0.3 % |
| Main thread (WASM + emit) | 0.4 % |
| React render | 3 % |
| **Total** | **~4 %** |

Within the M3 target (`analyzer CPU < 3 %` is the bridge-only budget;
visual rendering is separate).  No frame drops expected.

---

## 3. Memory profile

### Per analyzer instance

| Resource | Size |
|---|---|
| WASM linear memory (LouiAnalyzer + LouiSpectrumAnalyzer) | ~900 KB (pre-allocated, see M2-lite `04-BENCHMARK-RESULTS.md` § 6) |
| Float32Array allocations per quantum (worklet) | 2 × 128 × 4 = 1 KB / quantum = 750 KB / s (recycled in young gen) |
| Snapshot objects per second | ~30 × 50 B (tick) + 30 × 500 B (fft) + 30 × 50 B (stereo) = ~20 KB / s |
| Subscriber callback closures | depends; ≤ 10 typical for V2 panels |

V8 young-gen GC sweeps in < 1 ms.  Worst-case allocation rate
(~800 KB/s) is comfortably within young-gen capacity (typically 16 MB).
No major GC triggered by this path.

### Long-session leak watchpoints

- WASM analyzer history buffer (`block_ms_history`) grows on every
  100-ms block.  At 36 000 blocks (60 min) → 290 KB.  Documented in
  M2-lite `02-REALTIME-SAFETY.md` § 4; current behaviour acceptable
  for typical sessions, but `stop()` + `start()` between tracks reclaims.

- Subscriber array (in WasmAnalyzerSession) only grows when consumers
  forget to call `unsubscribe`.  React `useEffect` cleanup handles this
  correctly via `useAnalyzerStream` hook.

---

## 4. Backpressure scenarios

### Scenario A — main thread stalls 500 ms

- ~187 postMessage queued in worklet's port (750 messages/s × 0.5 s = 375 → conservative 187 max).
- On recovery, main thread processes burst: 187 × ~40 µs = ~7.5 ms.
- One frame skip in the meter UI.  Acceptable.

### Scenario B — main thread stalls 5 s

- Port queue grows to ~3 750 messages.
- 3 750 × 40 µs = 150 ms recovery work — visible frame skip.
- For pathological cases, **M3-bridge-impl-NEXT** adds an explicit max
  queue depth in the worklet that drops oldest if exceeded.

### Scenario C — subscribers don't yield

- All subscribers fire at their cadence.  If the consumer's callback is
  expensive (e.g. complex React render), the callback synchronously
  blocks the analyzer's emit loop.
- Mitigation: `useAnalyzerStream` should batch state updates via
  `requestAnimationFrame` (M3-meter-swap follow-up).

---

## 5. Manual smoke tests (deferred to M3-meter-swap)

When wiring V2 into a real page:

| Test | Expected |
|---|---|
| 10-min track playback with WASM factory active | No memory growth > 50 MB; no frame drops |
| Track switch (stop / start cycle) × 100 | No memory growth; no console errors |
| Devtools "Performance" trace during playback | Audio thread sample < 5 µs / process |
| `Math.random()`-driven analyzer toggle every 5 s | Each toggle clean; no lingering subscriptions |
| CPU profile of `WasmAnalyzerSession` over 60 s | < 3 % main-thread time |

---

## 6. Acceptance criteria for M3-meter-swap

When the swap PR ships:

- [ ] LUFS-I in V2 matches V1 within 0.5 LU on the same audio
- [ ] TP in V2 matches V1 within 0.3 dB
- [ ] No frame drops in `LoudnessMeterPanelV2` over 5 min
- [ ] No memory growth > 100 MB over 30 min
- [ ] No console errors in production build with WASM enabled
- [ ] Existing pages unchanged in V1 mode (default)

These are the M3-meter-swap acceptance gates.  M3-bridge-impl ships
the infrastructure to meet them — verification is the next PR's job.
