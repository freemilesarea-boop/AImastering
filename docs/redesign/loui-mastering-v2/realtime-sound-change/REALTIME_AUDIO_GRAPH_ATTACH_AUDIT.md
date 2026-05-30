# REALTIME-AUDIO-GRAPH-ATTACH — "waiting for audio" with a loaded source

> Symptom: Realtime Preview enabled, `readiness: realtime-ready`,
> `audio src: enough` (the Range fix works — the file loads), but
> `worklet: waiting for audio`, `avg process / block period: 0.000 ms`, and
> module edits are inaudible.

## 1. Graph attach chain (traced)

```
useRealtimeMasteringGraph(session, …)
  attach gate: enabled && readiness.ready && session && session.setInsertNode
  → createRealtimeMasteringGraph().attach()
  → loadMasteringWorklet() → session.setInsertNode(node)
  → wasm-analyzer-session.wireGraph(): source → node → tap → destination
```

The realtime graph **rides on the analyzer session** — it does not own the
`MediaElementSource`; it splices its node in via `session.setInsertNode`.
So *no session ⇒ no attach ⇒ no audio through the worklet ⇒ process()
never runs*.

## 2. Root cause — the session needs a SEPARATE flag

`WasmAnalyzerProvider` (`wasm-analyzer-context.tsx:89-97`) only ever
creates a session when **`isWasmAnalyzerEnabled()`** is true:

```ts
if (!isWasmAnalyzerEnabled()) { setSession(null); return; }
if (!active || !mediaElement)  { setSession(null); return; }
```

`isWasmAnalyzerEnabled()` (`analyzer-factory-resolver.ts`, before) read
only:

```
VITE_LOUI_WASM_ANALYZER (env)  ||  window.__LOUI_WASM_ANALYZER__ (runtime)
```

The **Realtime Preview** toggle sets `__LOUI_REALTIME_PREVIEW__` /
`localStorage['loui.realtimePreview']` — a *different* flag. So a user who
turned Realtime Preview ON, but never set the WASM-analyzer flag, gets:

- `isWasmAnalyzerEnabled() === false` → provider keeps `session = null`
- the realtime hook's attach gate fails on `!session`
- `deriveRealtimeUiStatus` → `hasSession:false` → **`waiting`** forever
- the worklet is never inserted → `process()` never called → `avg process
  0`, `block period 0`

The realtime chain has a **hard dependency** on the WASM analyzer session
that was never wired into the flag logic.

## 3. Fix

1. `isWasmAnalyzerEnabled()` now also returns true when the realtime
   preview is enabled (the realtime graph requires the session), and reads
   a persisted `localStorage['loui.wasmAnalyzer']` override. Precedence:
   `env → window → localStorage → realtime-preview dependency → default OFF`.
   So enabling Realtime Preview now *automatically* enables the analyzer
   session it rides on.
2. The realtime toggle also persists the analyzer flag explicitly (belt &
   suspenders) so a reload brings both up together.
3. Honest process telemetry in the worklet — `processCalls`,
   `audioBlocks` (non-empty input), `nonSilentBlocks` (input has signal) —
   posted every window **regardless of bypass**, so the debug panel can
   distinguish:
   - playing but `process()` not called (graph not attached) — counters 0
   - process called but silent input — `audioBlocks>0`, `nonSilent=0`
   - process called and processing — `avg process > 0`
4. Debug panel shows the graph **route** (`source → master → tap → dest`)
   when attached, plus the process counters, so attach + sample flow are
   visible at a glance.

`active` (heard-live) still requires real processing (metrics samples > 0),
so none of this can show a false "Live".
