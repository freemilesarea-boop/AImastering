# REALTIME-SOUND-CHANGE — why "tweak a module, hear nothing" happens

> User report: in ProductPage, pressing play and changing EQ / Dynamics /
> Imager / Limiter / Maximizer does NOT change the sound. The status chip
> reads **"Realtime off — edits apply on Update Preview / Re-master"**.
>
> This is mostly **by design** (realtime is opt-in, OFF by default) plus a
> set of **honesty gaps** in the UI. This document is the diagnosis; the
> companion change set adds a QA toggle, richer debug telemetry, and
> honest "heard now / staged / not in render" labelling.

---

## 1. Realtime graph activation — the exact gate

`useRealtimeMasteringGraph` only attaches the WASM mastering node when ALL
of the following hold (`hooks/useRealtimeMasteringGraph.tsx:86-89`):

```
enabled              // realtime-preview flag is ON
&& readiness.ready   // AudioContext + AudioWorklet + WebAssembly present
&& session           // analyzer session exists
&& typeof session.setInsertNode === 'function'
```

| Question | Answer (verified in code) |
|---|---|
| **Flag name** | `VITE_LOUI_REALTIME_PREVIEW` (build env) / `window.__LOUI_REALTIME_PREVIEW__` (runtime). `audio/realtime-preview-flag.ts` |
| **Default value** | **OFF.** No env, no window flag → `isRealtimePreviewEnabled()` returns `false`. |
| **Runtime override (before this change)** | `window.__LOUI_REALTIME_PREVIEW__ = true` in devtools, then reload. There was **no localStorage persistence and no UI toggle** — so a normal user/QA had no way to turn it on. **This is the primary reason "nothing changes".** |
| **Runtime override (after this change)** | `localStorage['loui.realtimePreview'] = 'true'` + the new **"Enable Realtime Preview"** toggle in the module suite header (persists + reloads). |
| **`useRealtimeMasteringGraph` enabled** | `useMemo(() => isRealtimePreviewEnabled(), [])` — evaluated **once per mount**. Changing the flag at runtime requires a reload (the toggle does this). |
| **Readiness detector** | `detectRealtimeReadiness()` — pure feature detection: `AudioContext`, `AudioWorklet` (via `Ctor.prototype.audioWorklet`), `WebAssembly`. `audio/realtime-readiness.ts:25-53`. In Electron all three are present, so readiness is normally `ready`. |
| **AudioWorklet load** | `loadMasteringWorklet(ctx)` fetches glue + wasm + processor, compiles WASM, registers `mastering-chain` processor, constructs the node. `audio/mastering-worklet-loader.ts`, driven from `realtime-mastering-graph.ts:144-155`. |
| **WASM init** | Inside the worklet ctor: `globalThis.__loui_init_mastering(wasmModule, sampleRate)`. Falls back to passthrough if the glue/module is missing. `public/mastering-chain.worklet.js:57-67`. |
| **Graph attach** | `session.setInsertNode(node)` rewires the analyzer session: `source → mastering node → tap → destination`. `realtime-mastering-graph.ts:174`, `wasm-analyzer-session.ts:237-251`. |
| **`graph.updateConfig` called** | Yes — seeded once on attach (`useRealtimeMasteringGraph.tsx:99`) and on every param change, rAF-batched (`:117-135`). |
| **Worklet `setConfig` received** | `port.onmessage` type `'config'` → stores pending config → applied on next `process()` via `chain.setConfig(...22 params...)`. `mastering-chain.worklet.js:69-100`. |
| **`process()` actually processes** | When ready and not bypassed: `chain.processStereo(left, right)` in place. Otherwise **passthrough** (input copied to output). `mastering-chain.worklet.js:102-159`. |
| **Fallback / passthrough conditions** | (a) flag OFF → hook is a no-op, native playback; (b) readiness not ready → no attach; (c) worklet load throws → `restoreAnalyzerOnly()` + status `failed`; (d) invalid/NaN config → worklet drops to bypass; (e) `setBypassed(true)` → still in graph, audio passes through. |

**Conclusion:** the graph is correctly wired. With the flag OFF (the
default and the state every normal user is in), the hook does nothing and
**no module edit can ever be heard live** — exactly the reported symptom.

---

## 2. What each "apply" path actually honours

Three distinct paths can realise a parameter. They do NOT honour the same
set of parameters — this is the second source of confusion.

| Path | Trigger | Backend | Params honoured |
|---|---|---|---|
| **Realtime preview** | flag ON + playing | WASM `LouiMasteringChain` (worklet) | **ALL 22** chain params (EQ low-cut/shelf/presence/air, dyn threshold/ratio/attack/release/mix, imager width/low-mono, limiter ceiling/lookahead/ISP, gains, bypasses). `realtime-mastering-chain.ts` → worklet. |
| **Update Preview** | "Update Preview" button | Python `audio:re-render-preview` → `masterFile` | **ONLY 4**: `targetLufs`, `targetTp`, `stereoWidth`, `outputGainDb` (`engine-bridge/renderable-map.ts`). EQ tone, dynamics detail, limiter lookahead/ISP, imager low-mono are **NOT** in the Python mapping → they are **staged only**. |
| **Create Revision / Re-master & Export** | "새 버전 만들기" / Re-master | Python `audio:master` (default) **or** Rust `audio:master-rust-experimental` (flag `VITE_LOUI_RUST_OFFLINE_RENDER` ON) | Python: same 4 as above. Rust offline: **ALL 22** (`offline/rust-offline-render-core.ts`). |

So even when realtime is OFF and the user clicks **Update Preview**, only
loudness / true-peak / width / output-gain change in the rendered audio.
A presence boost or a compressor ratio change is **silently dropped** by
the Python render. The UI already counts these as "staged-only" but did
not explain *why* they will never be heard via Update Preview.

---

## 3. The honest model the UI must convey

For any module edit the user must be able to tell, at a glance, which
bucket it is in:

- **Heard now** — realtime preview is ON and active → the WASM chain is
  processing this edit live.
- **Staged (renderable)** — realtime OFF, but the param maps to one of the
  4 Python options → **Update Preview** / Create Revision will make it
  audible.
- **Staged · Realtime-only** — realtime OFF and the param has no Python
  mapping → it will **not** be heard via Update Preview and **not** be in
  a Python export. It needs Realtime preview (to hear) or the Rust
  experimental render (to bake into a file).

---

## 4. Change set (companion to this audit)

1. **QA toggle + persistence** — `realtime-preview-flag.ts` now reads/writes
   `localStorage['loui.realtimePreview']`; a new `LouiRealtimeToggle`
   button (module-suite header) flips it and reloads, surfacing the
   readiness reason when realtime can't run.
2. **Honest status chip** — `LouiRealtimeStatus` distinguishes
   active / starting / unavailable / off, and the OFF copy now says edits
   are *staged* and points to Update Preview / Create Revision.
3. **Per-module badge** — the slide-over header badge is realtime-aware:
   "Heard live" (realtime active) / "Staged" (renderable, realtime off) /
   "Staged · Realtime-only" (no Python mapping).
4. **Update Preview honesty** — the staged-only chip explains those params
   are not in the Python render and names the path that would apply them.
5. **Debug telemetry** — the debug panel adds graph status, config-update
   count, last-config time, and bypass/passthrough so QA can confirm
   `updateConfig` is actually reaching the audio thread.

None of this changes defaults: realtime stays OFF until explicitly enabled,
the export path is unchanged, and no Python-unsupported param is ever
claimed to be in a Python render/export.
