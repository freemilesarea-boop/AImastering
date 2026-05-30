# M2-full-NEXT-2 — Product Audio Graph Audit

> How ProductPage builds its preview audio graph today, and where the
> realtime mastering node is inserted.

---

## 1. Players + refs

| Element | Where | Notes |
|---|---|---|
| `<audio ref={audioRef}>` | `ProductPage.tsx:989` (hidden) | single preview element; `src = effectiveSrc` |
| `audioRef` | `ProductPage.tsx:874` | `useRef<HTMLAudioElement>` |
| `effectiveSrc` | `ProductPage.tsx:903` | `abMode==='before' ? basePreviewSrc : (reRenderedSrc ?? basePreviewSrc)` — REAL source swap |

The element is hidden and driven via React state (play/seek/time).

---

## 2. Analyzer session wiring

| Step | Where |
|---|---|
| Provider mount | `ProductPage.tsx:1007` `<WasmAnalyzerProvider mediaElement={meterReady ? audioRef.current : null} active={playing}>` |
| Session create + start | `wasm-analyzer-context.tsx:97-102` |
| `attachMediaElement` | `wasm-analyzer-context.tsx:109` |
| Graph build | `wasm-analyzer-session.ts` `attach()` → `source → tap → destination` |
| MediaElementSource | `wasm-analyzer-session.ts` `createMediaElementSource`, cached in a **static WeakMap** keyed by element |
| Destination | `tap.connect(ctx.destination)` |

The provider owns the AudioContext + the MediaElementSource.  Consumers
read the session via `useWasmAnalyzerSession()`.

---

## 3. The one-source constraint (critical)

`createMediaElementSource` can be called **once per (element, context)**.
The analyzer already creates + caches it.  Therefore the realtime
mastering node **must not** create its own source or its own context — it
must reuse the analyzer's.  Any second `createMediaElementSource` on the
same element throws `InvalidStateError`.

**Consequence:** the mastering node is spliced INTO the analyzer's graph,
sharing its AudioContext + source.  The analyzer session owns the splice
via a new `setInsertNode(node | null)` method.

---

## 4. Source-swap behaviour

| Event | Handler | Graph effect |
|---|---|---|
| Re-render → new preview | `onPreviewRendered` (`ProductPage.tsx:930`) sets `previewSrcOverride`, `abMode='after'` | only `<audio src>` changes; **same element**, graph intact |
| A/B toggle | `onABToggle` (`ProductPage.tsx:938`) sets `abMode` | only `src` changes; graph intact |
| Loudness compensation | volume trim only (`ProductPage.tsx:945`) | no graph change |
| Play/pause | `active` prop → provider effect | session created on play, stopped on pause → **session identity changes** |

**Key insight:** src swaps keep the same element + same MediaElementSource,
so no re-wiring is needed.  But play/pause recreates the session (provider
useEffect dep on `active`), so the realtime graph must re-attach when the
session identity changes — handled by `useRealtimeMasteringGraph`'s effect
keyed on `[session]`.

---

## 5. New insertion point

```
BEFORE (analyzer-only, flag OFF — unchanged):
  element → MediaElementSource → analyzer-tap → destination

AFTER (flag ON + ready):
  element → MediaElementSource → mastering-worklet → analyzer-tap → destination
```

The mastering node is inserted **before** the tap so the meters reflect
the realtime-mastered signal the user hears.  Implemented by
`WasmAnalyzerSession.wireGraph()`:

- `insertNode == null` → `source → tap → destination` (identical to before)
- `insertNode != null` → `source → insertNode → tap → destination`

`wireGraph()` fully tears down + rebuilds edges, so it is safe to call
repeatedly (no duplicate connections).

---

## 6. Integration components

| Concern | Where (new) |
|---|---|
| Graph manager | `audio/realtime-mastering-graph.ts` (`createRealtimeMasteringGraph`) |
| React lifecycle + param bridge | `hooks/useRealtimeMasteringGraph.tsx` |
| ProductPage wiring | `ProductPage.tsx` `ProductPageProductionInner` (hook + debug overlay) |
| Analyzer splice API | `wasm-analyzer-session.ts` `setInsertNode` + `wireGraph` |

The hook reads `useAllModuleParameters()` (state) → `stateToChainConfig`
→ `graph.updateConfig` (rAF-batched).  Flag OFF → the hook is inert and
nothing in the analyzer graph changes.
