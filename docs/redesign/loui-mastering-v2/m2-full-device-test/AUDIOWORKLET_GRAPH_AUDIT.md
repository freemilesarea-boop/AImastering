# M2-full Device Test — AudioWorklet Graph Audit

> The existing analyzer audio graph, and where the realtime mastering
> worklet inserts.

---

## 1. Existing analyzer graph (wasm-analyzer-session.ts)

```
HTMLMediaElement
  → MediaElementAudioSourceNode   (createMediaElementSource, cached per element)
  → AnalyzerTap (AudioWorkletNode 'analyzer-tap')
  → AudioContext.destination       (playback)
```

The tap is a **passthrough** that ALSO copies each 128-sample block to
the main thread (`port.postMessage`, zero-copy transfer) where the WASM
**analyzer** processes it.  Audio is NOT modified — analysis only.

### Lifecycle
- AudioContext created at the requested sample rate (`new AudioContext({ sampleRate })`).
- `audioWorklet.addModule('./analyzer-tap.worklet.js')` (from `public/`).
- `attachMediaElement` → `createMediaElementSource` (once per element per ctx; cached).
- `attach(source)` → `source.connect(tap)`, `tap.connect(destination)`.
- Teardown: `tapNode.disconnect()`, source cached for reuse.

### Sample rate / channels
- Context SR = requested (typically 48 k); browser may coerce.
- Stereo (2ch); the tap forwards L (+R if present).

---

## 2. Why mastering needs a DIFFERENT pattern

The analyzer uses **main-thread WASM** because analysis tolerates
latency (it just reads the signal).  The **mastering chain modifies**
the signal before the destination, so it must run **inline on the audio
thread** — a main-thread round-trip would add latency + glitches.

⇒ The Rust MasteringChain WASM must run **inside** an
`AudioWorkletProcessor` (the audio thread), not on main.

---

## 3. Target graph (realtime preview ON)

```
HTMLMediaElement
  → MediaElementAudioSourceNode
  → LouiMasteringWorklet (AudioWorkletNode 'loui-mastering-chain')   ← processes inline
  → AnalyzerTap ('analyzer-tap')                                     ← analyses the MASTERED signal
  → AudioContext.destination
```

The mastering worklet sits BEFORE the analyzer tap, so the meters /
spectrum reflect the mastered output (what the user hears).  When the
realtime flag is OFF, the mastering node is absent — the graph is
exactly today's analyzer-only graph.

---

## 4. WASM-in-worklet constraint

`AudioWorkletGlobalScope` has no `fetch` / `import` / `import.meta`.
The renderer's WASM build is `wasm-bindgen --target web` (uses those) —
NOT loadable in a worklet.

The worklet needs a **`wasm-bindgen --target no-modules`** build, whose
glue exposes a global init callable inside the worklet.  The main thread:
1. fetches + compiles the `.wasm` → `WebAssembly.Module`
2. passes the module + the no-modules glue source via `processorOptions`
3. the worklet instantiates synchronously (no await on the audio thread)

This second build target is the remaining **build-system step** before
the realtime flag can ship (see ROLLOUT_RECOMMENDATION.md).  Until then
the worklet degrades to a safe passthrough and the app uses the
re-render preview.

---

## 5. Parameter update path

```
UI param change → stateToChainConfig(state) → port.postMessage({ type:'config', config })
  → worklet applies setConfig() between blocks (coefficient recompute only, no alloc)
```

`setConfig` is realtime-safe (no allocation; preserves filter/envelope/
delay state → no clicks).  Rapid knob movement = a stream of cheap
messages; the worklet applies the latest before the next block.

---

## 6. Teardown / lifecycle additions

| Event | Handling |
|---|---|
| Source swap (A/B, re-render) | mastering node persists; `src` change handled by the element |
| Transport seek | `port.postMessage({ type:'reset' })` clears chain state |
| AudioContext suspend/resume | worklet pauses with the context (no special handling) |
| Session teardown | disconnect mastering node + analyzer tap |
| Worklet load failure | catch → skip mastering node → analyzer-only graph (fallback) |

---

## 7. Insertion is additive

Adding the mastering node is a graph edge change gated by the realtime
flag + readiness.  Flag OFF / not ready / load failure → the mastering
node is never created, and the graph is byte-identical to today's
analyzer path.  No regression to playback, analysis, or the re-render
preview.
