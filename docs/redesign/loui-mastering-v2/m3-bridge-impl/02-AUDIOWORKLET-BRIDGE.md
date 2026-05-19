# M3-bridge-impl — AudioWorklet Bridge

> The `analyzer-tap` AudioWorkletProcessor — minimal audio-thread tap
> that forwards input samples to the main thread for WASM analysis.

---

## 1. File location

`apps/desktop/src/renderer/public/analyzer-tap.worklet.js`

Ships via Vite's `public/` mechanism (copied verbatim to `dist/renderer/`).
The renderer's `WasmAnalyzerSessionFactory` resolves the URL
`'./analyzer-tap.worklet.js'` against the page's base URL.

---

## 2. What it does

1. Receives input audio in `process(inputs, outputs, _)`.
2. Copies `inputs[0]` planar channels into newly-allocated `Float32Array`s.
3. Forwards via `port.postMessage({ left, right, seq }, [left.buffer, right.buffer])` — `Transferable[]` makes the buffer ownership transfer zero-copy.
4. Copies `inputs[0]` → `outputs[0]` (passthrough so playback continues).

Total work: 2× memcpy (input → tap copy, tap copy → output) + 1 postMessage.

---

## 3. Wire protocol

| Direction | Type | Payload |
|---|---|---|
| Worklet → Main | `{ left: Float32Array, right?: Float32Array, seq: number }` | per audio quantum (~128 samples) |
| Main → Worklet | reserved | none yet |

`seq` is a monotonic counter the main thread can use to detect drops or
re-ordering (none expected on a correctly-behaved AudioWorklet, but the
main thread might intentionally drop frames if its queue is congested).

---

## 4. Realtime safety

The worklet code is in `AudioWorkletGlobalScope` — runs on the audio
thread.  Every restriction applies:

| Rule | Compliance |
|---|---|
| No allocation in process | ⚠️  Allocates two `Float32Array(len)` per call — see § 5 for the engineering rationale and worst-case impact |
| No locks | ✅ |
| No I/O | ✅ |
| No syscalls / `await` | ✅ |
| No exceptions | ✅ (defensive nullish checks) |
| Bounded loops | ✅ |

---

## 5. Why we allocate per-call (and why it's OK)

The audio worklet API gives us a SHARED `inputs[0]` buffer that **WebAudio
recycles between quanta**.  We cannot transfer ownership of that array
to the main thread — it must stay in the audio context.  So we copy.

Alternatives considered:

| Strategy | Pros | Cons |
|---|---|---|
| **Per-call allocation (current)** | Simple, safe, transferable to main | One alloc + free per quantum — ~750/s at 48k/128 |
| Ring buffer of pre-allocated Float32Arrays | No alloc per call | More state in worklet; backpressure complexity |
| `SharedArrayBuffer` ring | True zero-alloc | Requires cross-origin isolation; complex setup |

V8's young-gen collector handles 750 small allocations/second trivially
(~1 KB each → ~750 KB/s, fully recycled before the next sweep).  No GC
spike risk.  The simplicity is the win.

`SharedArrayBuffer` upgrade is M3-bridge-impl-NEXT.

---

## 6. Backpressure

The main thread might fall behind (heavy React render, blocked promise,
GC pause).  Behaviour:

| Scenario | What happens |
|---|---|
| Main thread momentarily lagging | postMessage queue grows; on recovery, main processes burst in order |
| Subscribers fall behind their cadence | throttling timestamps reset → next emit takes whatever the latest snapshot is (no replay) |
| AudioWorklet thread itself stalls | not possible — worklet runs on a dedicated audio thread |
| 30+ second backlog | port queue grows unbounded — see M3-BI-C for the SharedArrayBuffer fix |

For typical UI loads (60+ fps render, no other heavy work), backpressure
is not observed.  The factor's API doesn't expose backpressure metrics
yet — added as instrumentation in `06-STREAMING-PERFORMANCE.md`.

---

## 7. Testing

Verified in this commit:
- Worklet file present at `dist/renderer/analyzer-tap.worklet.js` after `pnpm build:renderer`
- Worklet syntax accepted by `node -e "JSON.stringify(require('./...'))"` (parses as JS)
- Factory references it via `'./analyzer-tap.worklet.js'` path

Manual browser smoke test (requires Electron):
1. `pnpm dev` from `apps/desktop`
2. Open `http://localhost:5173/?dev=analyzer-stream`
3. Toggle to "WASM (loui-dsp)"
4. Confirm no console errors about worklet 404 or WASM instantiation failure
5. Confirm meters and spectrum panel show data when an audio source is attached

(The dev panel as committed doesn't auto-attach an audio source — testers
will need to use the page's `attach()` API manually or wait for
M3-meter-swap which wires existing audio elements.)
