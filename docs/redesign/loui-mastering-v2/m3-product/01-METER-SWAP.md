# M3 Product — Meter Swap (V1 ↔ V2)

> The single page change that puts V2 in front of users.

---

## 1. The swap

| Site | Before | After |
|---|---|---|
| `ResultPage` import | `LoudnessMeterPanel` (V1) | `AnalyzerPanelStack` (V1/V2 gate) |
| `ResultPage` render | `<LoudnessMeterPanel mediaElement active targetLufs />` | `<AnalyzerPanelStack mediaElement active targetLufs />` |

`AnalyzerPanelStack` accepts identical props to V1 and decides
internally which path to render.  V1 behaviour is bit-identical when
the flag is off.

---

## 2. Gate decision logic

```tsx
const v2 = isWasmAnalyzerEnabled();
if (!v2) return <LoudnessMeterPanel ... />;        // V1 path
return (
  <WasmAnalyzerProvider mediaElement active>
    <V2PanelStack ... />                            // V2 path
  </WasmAnalyzerProvider>
);
```

Branch decision is at render time on every render — flag changes during
a session take effect on next React state update.  The dev panel
already exploits this for live A/B (`window.__LOUI_WASM_ANALYZER__ = true`
then trigger a state change).

---

## 3. Shared session model

A page might render multiple V2 panels (loudness + spectrum + stereo).
Each panel needs an analyzer.  The browser caps `createMediaElementSource`
to one source per (element, context) pair.

Solution: **one session per page, shared via React context**.

```
<WasmAnalyzerProvider mediaElement active>
   │ owns: AudioContext, WasmAnalyzerSession, MediaElementSource
   │ exposes: session via useContext
   ▼
   <V2PanelStack>
       ├── <LoudnessMeterPanelV2 session />
       ├── <SpectrumAnalyzerPanel session />
       └── <StereoScopePanel session />
```

Each panel subscribes to its own stream (`onTickSnapshot`, `onFftFrame`,
`onStereoFrame`) on the shared session.  The session is created when
`active` flips to true and `mediaElement` is non-null; destroyed when
either condition fails.

---

## 4. Lifecycle

```
component mounts
   │
   ▼
WasmAnalyzerProvider effect:
   • isWasmAnalyzerEnabled() == false → setSession(null); panels render "V1" or "awaiting frames" stub
   • active == false OR mediaElement == null → setSession(null)
   • else:
       ├── factory.create(opts)
       ├── session.start()                  (boots WASM + AudioContext + worklet)
       ├── session.attachMediaElement(el)   (caches MediaElementSource per element)
       └── setSession(session)              (children subscribe)
                                            
on cleanup OR deps change:
   • session.stop() (closes context + frees WASM)
   • setSession(null)
```

The cache of `MediaElementSource` per `HTMLMediaElement` is a WeakMap on
the WasmAnalyzerSession class — survives component unmount/remount as
long as the element is reachable.  Same context though — when the
session is re-created (new ctx), the cache entry is invalidated by the
`src.context !== this.ctx` check in `attachMediaElement`.

---

## 5. V1 path (unchanged behaviour)

When flag is off:
- `AnalyzerPanelStack` renders `<LoudnessMeterPanel>` directly.
- No `WasmAnalyzerProvider`, no V2 components mounted.
- `loudnessProcessor.worklet.js` continues to be loaded by `LoudnessStream`.
- LUFS / TP shown by V1 with V1's own AudioContext.

No regression risk — the V1 imports and call paths are identical to
the pre-M3 codebase.

---

## 6. V2 path

When flag is on:
- `WasmAnalyzerProvider` mounts → creates WASM session → attaches the audio element.
- `<V2PanelStack>` consumes the session.
- Three panels render:
  - LoudnessMeterPanelV2 (Momentary / Short-term / TP / Sample peak / RMS + correlation + M/S)
  - SpectrumAnalyzerPanel (canvas, log-freq FFT, peak-hold)
  - StereoScopePanel (correlation needle + width bar + verdict chip)

The provider's effect cleans up on unmount.  Switching tracks
(audioRef.current changes) triggers a session restart.

---

## 7. Loading / disconnected / fallback states

`LoudnessMeterPanelV2` and the other panels render their "awaiting
frames…" copy when `session === null` (the WASM-flag-on case where the
provider hasn't booted yet, or when audio isn't playing).

```
session === null  → "awaiting frames…"
session != null but no ticks yet → bars at -∞, label "starting…"
ticks flowing      → live updates
```

No error banner today.  Errors logged to console; the page just shows
empty meters.  Surfacing user-visible errors is M3-P-F follow-up.

---

## 8. Why we kept V1 imported instead of deleting

- V1 path is the safe fallback for production rollout.
- The `LoudnessMeterPanel` and `LoudnessStream` imports cost ~10 KB
  bundle weight — acceptable for the rollback insurance.
- When V2 has been default with no rollback for one full release, V1
  can be deleted in M3-P-NEXT-5.

---

## 9. Test plan

The full plan is in `04-ROLLOUT-PLAN.md`.  At commit time:

| Test | Mode | Status |
|---|---|---|
| `cargo test -p loui-dsp --lib`                | both | ✅ |
| `pnpm typecheck`                              | both | ✅ |
| `pnpm build:renderer` (V1 default)            | V1 | ✅ 101 modules, all assets emitted |
| `pnpm build:renderer` with `VITE_LOUI_WASM_ANALYZER=true` | V2 | ⏳ same build artefacts, flag inlined |
| Existing V1 test suite                        | V1 | ⏳ no changes; should pass |
| Browser smoke: ResultPage with V1 default     | V1 | ⏳ manual |
| Browser smoke: ResultPage with `__LOUI_WASM_ANALYZER__ = true` | V2 | ⏳ manual |
