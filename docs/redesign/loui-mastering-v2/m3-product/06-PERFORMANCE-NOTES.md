# M3 Product — Performance Notes

> Combined CPU / memory budget when V2 is mounted, plus watchpoints
> for the manual smoke test phase.

---

## 1. Per-component CPU (predicted)

From M2-lite + M2-lite-NEXT + M3-entry benchmarks:

| Component | CPU @ 48 kHz / 256-block playback |
|---|---:|
| AudioWorklet tap (memcpy + postMessage) | 0.3% audio-thread |
| WASM LouiAnalyzer.processStereo + tickSnapshot | 0.3% main-thread |
| WASM LouiSpectrumAnalyzer.processStereo + tryFrame | 0.2% main-thread |
| LoudnessMeterPanelV2 React render @ 30 Hz | ~0.5% main-thread |
| SpectrumAnalyzerPanel RAF + canvas @ 60 fps | ~0.9% main-thread |
| StereoScopePanel React render @ 30 Hz | ~0.6% main-thread |
| **Combined V2 stack** | **~2.8% CPU** |

Within the M3 target ("analyzer CPU < 3%").  Comparable to V1 + nothing
else (V1 worklet ~0.5% + V1 panel render ~0.5% = 1%).  V2 adds spectrum
+ stereo at ~1.8% incremental cost.

---

## 2. Memory profile

### Per WASM session instance

| Resource | Size | Owner |
|---|---|---|
| WASM linear memory (LouiAnalyzer + LouiSpectrumAnalyzer state) | ~900 KB | session lifecycle |
| Audio worklet ScopedArray pool | ~10 KB | worklet lifetime |
| Subscriber arrays | < 1 KB per session | session lifecycle |
| MediaElementSource node | ~1 KB | persisted in WeakMap |

### Per-quantum (recurring)

| Resource | Size | Lifetime |
|---|---|---|
| Float32Array(128) × 2 (worklet → main) | ~1 KB | transferred to main, recycled by GC |
| `JsMeterSnapshot` object literal | ~100 bytes | per tick (every 33 ms at 30 Hz) |
| FFT frame `Vec<f32>` × 3 (centres + mag + peak) | ~1.5 KB | per FFT frame (30 Hz) |
| Stereo scope frame object | ~100 bytes | per stereo frame (30 Hz) |

Total recurring allocation: **~50 KB/s**.  V8 young-gen handles this
in < 1 ms sweeps.  No major GC triggered.

---

## 3. CPU watchpoints during smoke test

When testers run the Phase 1 manual smoke (see 04-ROLLOUT-PLAN.md § 7),
they should compare these metrics V1 vs V2:

| Metric | V1 baseline | V2 budget | Tooling |
|---|---|---|---|
| Main-thread frame rate during playback | 60 fps | ≥ 55 fps | Chromium devtools Performance tab |
| 5-minute peak heap | ~50 MB | ≤ 100 MB | Chromium Memory tab |
| Audio-thread CPU | ~1% | ≤ 2% | Performance tab → "Frames" |
| GC pause histogram (99th pct) | ≤ 30 ms | ≤ 50 ms | Performance tab → "GC Events" |
| First meter update latency (after play) | ≤ 200 ms | ≤ 500 ms | manual stopwatch |
| Track-change leak (heap delta after 20 cycles) | ≤ 5 MB | ≤ 20 MB | Memory tab snapshots |

---

## 4. Backpressure scenarios

### 4.1 Heavy main-thread work blocks the postMessage loop

Symptom: meters freeze briefly; on recovery, a burst of stale messages
processes in order → visible jitter.

Today: postMessage queue grows unbounded.  No explicit cap.
Mitigation: M3-bridge-impl-NEXT adds SharedArrayBuffer ring with
fixed-size slot count.

For now: keep the renderer's other work lean.

### 4.2 Spectrum canvas off-screen but still rendering

Symptom: ~9 ms/s of wasted RAF work when ResultPage scrolled past
the spectrum panel.

Today: spectrum always renders.
Mitigation: `IntersectionObserver` → cancel RAF when off-screen.
Tracked as M3-P-NEXT polish.

### 4.3 Multiple V2 panel instances on different elements

Today: each `AnalyzerPanelStack` mounts its own WasmAnalyzerProvider →
own session → own worklet → own WASM heap (~900 KB each).

For ResultPage there's only one audio element, so this is fine.  If
future pages mount multiple panel stacks (e.g. batch comparison view),
each gets its own session.  RAM scales linearly.

---

## 5. CPU budget for the FUTURE Ozone-style layout

If the layout proposal in `05-PRODUCT-LAYOUT.md` is implemented,
adding an editable EQ curve overlay adds:
- Per drag-update: re-emit EQ coefficient curve (calc only, no audio)
- Per frame: render EQ overlay on the spectrum canvas (~50 µs)

Net: ~0.3% additional CPU.  Total V2 stack remains < 4% even with
interactive EQ.

---

## 6. Out-of-bounds CPU triggers (should never happen)

Things that would push V2 over 5% CPU and warrant investigation:

| Trigger | Likely cause | Investigation |
|---|---|---|
| `processStereo` > 100 µs/call | WASM heap pressure / blocked main thread | Check console for "session not initialised" warnings |
| Spectrum canvas drops to 30 fps | DPR mismatch or canvas re-create loop | Add `console.log('canvas resize')` in ResizeObserver |
| GC pauses > 100 ms | Hot-path allocation regression | Allocator stack trace via Chromium |
| `tickSnapshot` skips ticks | session disposed mid-call | Check React effect cleanup; session reference held in closure |

---

## 7. Reference numbers (from prior milestones)

For comparison, prior measured budgets:

| Milestone | Measurement | Result |
|---|---|---|
| M2-lite     | Native FFT 4096 | 72.88 µs |
| M2-lite     | 60s @ 44.1k stereo full pass | 366× realtime |
| M2-lite     | 256-block realtime @ 48k (LUFS + TP + peak + stereo) | 16 µs (0.30% CPU) |
| M3-entry    | Spectrum 2048 FFT + binning + smoothing + peak-hold | 42.88 µs/frame |
| M3-entry    | Spectrum 256-block realtime @ 48k | 10.65 µs (0.20% CPU) |
| M3-bridge   | Round-trip postMessage cost (estimated) | ~50 µs/quantum |
| **M3-product** | **Full V2 stack (predicted)** | **~2.8% renderer CPU** |

Actual M3-product measurements pending manual smoke (Phase 1 of
rollout plan).
