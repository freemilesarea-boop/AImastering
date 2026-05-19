# M3-P-NEXT-5A — Future M2-Full Binding Checklist

> The punch list for M3-P-NEXT-5B / M2-full when the engine bridge wire-up
> begins.

---

## 1. EngineSchema additions

Eleven new fields need landing in
`packages/shared-types/src/engine/modules.ts`:

### Per-module bypass (5×)

```diff
 interface EngineAdaptiveEqModule  { type, id, bands,        +bypass?: boolean; }
 interface EngineBusCompModule     { type, id, threshold,    +bypass?: boolean; }
 interface EngineStereoImagerModule{ type, id, width,        +bypass?: boolean; }
 interface EngineLimiterModule     { type, id, ceilingDb,    +bypass?: boolean; }
 interface EngineDitherModule      { type, id, bitDepth,     +bypass?: boolean; }
```

### Functional additions (6×)

```diff
 interface EngineBusCompModule {
   ...
+  /** Parallel-mix percentage 0..100. */
+  mixPct?: number;
 }
 interface EngineStereoImagerModule {
   ...
+  lowMonoFrequency?: number;
+  stereoize?: boolean;
+  bands?: { width: number }[];        // 4-element array, low → high
 }
 interface EngineLimiterModule {
   ...
+  character?: 'transparent' | 'glue' | 'aggressive' | 'classic';
 }
```

After these land, every `pending` binding in `02-PARAMETER-DEFINITIONS.md`
can flip to `wired`.

---

## 2. Bridge implementation tasks (M3-P-NEXT-5B)

### A. Provider command sink

Wire `onCommand` on `ModuleParameterStateProvider`:

```ts
<ModuleParameterStateProvider onCommand={dispatcher}>
```

Where `dispatcher: (cmd: EngineCommand) => void` is a new module
`audio/engine-bridge/dispatcher.ts`.

### B. Dispatcher routing

For each `SET_MODULE_PARAM` command:

1. Look up `def = findParameterDef(defs, moduleId, parameterId)`
2. Apply conversion (see `04-PARAMETER-SCHEMA-MAPPING.md`):
   - `widthPct / 100` → engine value (Imager)
   - `isp` boolean → `oversample: 4 | 1` (Limiter)
   - `targetLufs` → route to `loudness-norm.targetLufs` (cross-module)
3. Find the EngineSchema module in the current preset chain
4. Call `engine.applyParam(moduleType, path, value)`

For `RESET_MODULE` — batch write all defaults via
`engine.applyBatch(moduleType, defaultsObject)`.

For `SET_MODULE_BYPASS` — `engine.setBypass(moduleType, bypass)`.

### C. Engine read-back

Live signal reads (GR meters, correlation):

```ts
useEngineSignal('dynamics.grDb', '30Hz')      // → number
useEngineSignal('limiter.grDb', '30Hz')        // → number
useEngineSignal('imager.correlation', '30Hz')  // → number
```

These replace the mock random-walks inside the panels.  Bridge into
the existing `useAnalyzerStream` / `WasmAnalyzerProvider` infra.

### D. Adapter ack channel

When the adapter clamps a value beyond what the UI validator did
(e.g. Python pipeline rejecting a `releaseMs < 20` even though UI
allows 10):

```ts
provider.onAdapterAck({
  moduleId: 'dynamics',
  parameterId: 'releaseMs',
  applied: 25,                     // adapter-clamped value
  requested: 10,                   // command value
  reason: 'adapter-min',
});
```

State updates to the adapter-clamped value; log gains an `AdapterAck`
entry showing the second clamp.

---

## 3. Preset bridge

`LOAD_PRESET` command currently does nothing in this milestone.
M3-P-NEXT-5B adds:

```ts
function loadPreset(preset: EnginePreset, source: CommandSource = 'preset') {
  // 1. Reset every module to defaults
  for (const id of MODULE_IDS) reset(id, source);
  // 2. For each EngineSchema module in the chain, find the matching UI
  //    parameters and dispatch SET_MODULE_PARAM with source='preset'.
  for (const node of preset.chain.nodes) {
    switch (node.type) {
      case 'adaptive-eq':    applyAdaptiveEqPreset(node);    break;
      case 'bus-comp':       applyBusCompPreset(node);       break;
      case 'stereo-imager':  applyImagerPreset(node);        break;
      case 'limiter':        applyLimiterPreset(node);       break;
      case 'loudness-norm':  applyLoudnessPreset(node);      break;
    }
  }
}
```

Each helper inverts the conversion table — engine value → UI value —
and dispatches the right `SET_MODULE_PARAM` commands.

---

## 4. Reference profile bridge

`APPLY_REFERENCE_PROFILE` works similarly but applies a **delta** on
top of current state rather than a full reset.  Driven by the existing
reference-profile system in `audio/preset/`.

The delta payload comes from M1.75's profile schema:

```ts
interface ReferenceProfileDelta {
  eq: { lowShelfDb?: number; presenceDb?: number; airDb?: number };
  dynamics: { thresholdDb?: number; ratio?: number };
  // …
}
```

The dispatcher walks the delta and emits one
`SET_MODULE_PARAM` per non-undefined field with `source='reference'`.

---

## 5. Export descriptor wire-up

`EXPORT_DESCRIPTOR_UPDATE` currently only logs.  Wire-up:

1. ExportParameterPanel adds an "Export" button (replacing the "coming
   soon" notice) once `EnginePresetOutput` schema supports all 5
   formats.
2. Button click → emit `EXPORT_DESCRIPTOR_UPDATE` + invoke
   `file:save-wav(srcPath, descriptor)` with the descriptor payload.
3. Main process gains format/SR/depth/dither handling via ffmpeg.

This is the most user-visible upgrade — it unlocks the format chips
that currently show "UI shell only".

---

## 6. Two-way mirror parameters

Currently every parameter is one-way (UI → engine).  Some need
two-way:

| Parameter | Engine read | Why |
|---|---|---|
| Limiter `targetLufs`   | adaptive loudness-norm passes adjust it | Display the iterated final value |
| Limiter `ceilingDbtp`  | ISP-safety can clamp ceiling under headroom | Show the adapter-corrected value |
| Imager `correlation` (read-only) | live | Already wired via analyzer-stream |
| Dynamics `grDb` (read-only)      | live | New engine read needed |
| Limiter `grDb` (read-only)       | live | New engine read needed |

Two-way semantics live in M3-P-NEXT-5B's `useEngineParameter` helper
(see `04-…-INTERACTION-NOTES.md` from M3-P-NEXT-4 for prior thinking).

---

## 7. Test harness

When the engine bridge lands, add:

### Unit tests (vitest)

- `validateParameterValue` covers every kind / boundary case
- Command constructors stamp source + timestamp
- `describeCommand` formats every kind
- `useModuleParameters` reset / setParam / setBypass flow
- Provider command sink fires `onCommand` for every dispatch

### Integration tests (Playwright + Storybook)

- Open EQ slide-over → drag slider → verify command appears in log
- Out-of-range value → clamp warning row in log
- Reset → all params back to default, badge removed
- Bypass → flag set, header pill colour-shifts

### Engine equivalence

The cross-language equivalence harness
(`scripts/dsp-equivalence-compare.ts`) already validates preset →
audio output parity.  Extend it to:

1. Apply a sequence of `SET_MODULE_PARAM` commands
2. Render the resulting preset through both Python + TS adapters
3. Diff the outputs

This catches dispatcher routing bugs (writing to the wrong path)
before they ship.

---

## 8. Migration order

The wire-up doesn't happen in one PR.  Recommended sequence:

| PR | Scope | Risk |
|---|---|---|
| 1 | M2-full EngineSchema additions (11 fields)            | Low — additive only |
| 2 | `audio/engine-bridge/dispatcher.ts` + provider hook   | Med — touches every module |
| 3 | `wired` parameters first — 7 fields                   | Low — known-good paths |
| 4 | `pending` parameters after EngineSchema update         | Med — new code paths |
| 5 | Live signal reads (GR / correlation)                   | Low — additive |
| 6 | Preset bridge (`LOAD_PRESET`)                          | Med — touches existing preset flow |
| 7 | Reference profile bridge                               | Med |
| 8 | Export descriptor IPC                                   | High — main process change |
| 9 | Test harness + equivalence                              | Low |

Each PR can ship behind the existing product-layout flag — no
production user sees changes until M3-P-NEXT-6 promotes the layout to
default.

---

## 9. Open questions for the implementer

| Question | Recommendation |
|---|---|
| Where does the dispatcher live in the repo? | `apps/desktop/src/renderer/audio/engine-bridge/` (new dir) |
| How is the dispatcher injected into the provider? | `<ModuleParameterStateProvider onCommand={dispatcher}>` — single prop, no `<EngineBridgeProvider>` wrapper |
| Should the dispatcher throttle writes? | Yes — debounce 16 ms per (moduleId, parameterId) |
| Should command log get a UI in production? | Yes, but gated behind `__LOUI_DEBUG_LOG__ === true` |
| Adapter ack errors — surface to user or ignore? | Surface as a Toast for `rejected`; ignore for `clamped` |

All five are decisions for M3-P-NEXT-5B.  None block this milestone.
