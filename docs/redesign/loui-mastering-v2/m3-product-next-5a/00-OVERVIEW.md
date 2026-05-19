# M3-P-NEXT-5A — Parameter State Model + Engine Binding Contract

> Freeze the contract between UI parameter shells and the future DSP
> engine — before any real DSP write lands.

---

## 1. What changed

M3-P-NEXT-4 shipped five parameter panel shells with **panel-local
`useState`**.  This was fine for visual review but didn't scale to:

- Cross-module reads (Export panel echoing Limiter target)
- Reset / Bypass / "Modified" indicators
- Engine binding (which panel value writes to which engine param)
- Auditing (what did the user touch and when)

M3-P-NEXT-5A introduces a **central parameter state model** that owns
every UI parameter value, validates every change, dispatches typed
commands, and exposes a read-only command log.  No DSP value is
written — that lands in M3-P-NEXT-5B.

| New | Purpose |
|---|---|
| `audio/parameters/parameter-state.ts`            | Type definitions (ParameterDef, ModuleId, EngineBindingTarget) |
| `audio/parameters/module-parameter-definitions.ts` | Concrete defs for all 5 modules · 24 parameters total |
| `audio/parameters/engine-command.ts`             | Command shapes + validators + constructors |
| `audio/parameters/useModuleParameterState.tsx`   | `<ModuleParameterStateProvider>` + `useModuleParameters(moduleId)` + `useEngineCommandLog()` |
| `components/product/panels/usePanelStateBridge.ts` | Controlled-or-uncontrolled glue for every panel |
| `pages/ProductPage.tsx` (refactor)               | Provider wraps Override + Production paths; SlideOver header shows Modified / Bypass / Reset |
| 7 stories                                          | Default, ModifiedEq, BypassedImager, LoudLimiter, Export24BitWav, CommandLog, InvalidValueClamping |

---

## 2. What did NOT change

The same zero-regression contract as every prior milestone:

| Untouched | Verification |
|---|---|
| DSP chain (`loui-dsp` Rust core)                  | `cargo test -p loui-dsp --lib` → 31/31 |
| Python pipeline / mastering chain                  | None modified |
| Export pipeline / IPC                              | None modified |
| ResultPage (legacy)                                | None modified |
| V2 analyzer panels                                 | None modified |
| WASM analyzer flag / Product layout flag           | Both unchanged |
| EngineSchema (`@aimaster/shared-types/engine`)     | Read-only consumption |
| Preset system (`audio/preset/*`)                   | None modified |

Reiterated explicit constraint from the brief:
> 실제 DSP parameter write 는 아직 하지 않는다.

The provider's `setParam` dispatches a typed `SET_MODULE_PARAM` command,
mutates UI state, and appends to the log.  Nothing downstream consumes
the log — M3-P-NEXT-5B is where the dispatcher routes commands to a
real engine bridge.

---

## 3. Architecture diagram

```
                          ┌──────────────────────────────────────────────┐
  Module Strip card  ──▶  │ ProductPage selectedModule state              │
  click in UI            │                                              │
                          │                                              │
                          │  <ModuleParameterStateProvider>              │
                          │   ├─ state: all-modules snapshot             │
                          │   ├─ log:   EngineCommand[]                  │
                          │   └─ dispatch (setParam / setBypass / reset)│
                          │                                              │
                          │   ↑                                          │
                          │   │   useModuleParameters('eq')              │
                          │   │                                          │
                          │   ▼                                          │
                          │  <LouiModuleSlideOver headerActions=…>       │
                          │   └─ <EqParameterPanel                       │
                          │         state=… onParamChange=…              │
                          │         bypass=… onReset=…  />               │
                          └──────────────────────────────────────────────┘

  Future M3-P-NEXT-5B:
  ┌──────────────────────────────────────┐
  │ <ModuleParameterStateProvider        │
  │   onCommand={engineDispatcher} />    │
  │                                      │
  │   engineDispatcher(cmd):             │
  │     switch (cmd.kind) {              │
  │       case 'SET_MODULE_PARAM':       │
  │         applyToEngine(cmd);  ────────┼──▶ engine.applyParam(...)
  │     }                                │
  └──────────────────────────────────────┘
```

The `onCommand` mirror prop is the wire-up seam — adding it in
M3-P-NEXT-5B requires zero changes to panels or the provider's public
hook surface.

---

## 4. Five modules, 24 parameters

`module-parameter-definitions.ts` enumerates every parameter in the
product layout with full metadata.  Counts:

| Module    | Parameters | Numeric | Boolean | Enum |
|---|---:|---:|---:|---:|
| eq        | 6 | 5 | 1 | 0 |
| dynamics  | 5 | 5 | 0 | 0 |
| imager    | 7 | 6 | 1 | 0 |
| limiter   | 5 | 3 | 1 | 1 |
| export    | 4 | 0 | 0 | 4 |
| **Total** | **27** | **19** | **3** | **5** |

Each parameter carries:
- `id`, `label`, `hint`
- `kind` ∈ {number, boolean, enum}
- type-specific bounds (`min`/`max`/`step`/`default` for number,
  `values` for enum)
- display formatter (number formatters: signed dB, integer, 1-decimal, ratio)
- `automatable: boolean` — UI-automation eligibility
- `binding: EngineBindingTarget` — `{ moduleType, path, status }`

See `02-PARAMETER-DEFINITIONS.md` for the full per-module table.

---

## 5. Commands

The command contract (`engine-command.ts`) enumerates 6 command kinds:

| Kind | Carries | Fired by |
|---|---|---|
| `SET_MODULE_PARAM`        | moduleId · parameterId · value · validation | every UI change |
| `SET_MODULE_BYPASS`       | moduleId · bypass                            | bypass toggle |
| `RESET_MODULE`            | moduleId                                     | reset button |
| `LOAD_PRESET`             | presetId · presetName                        | preset selection (future) |
| `APPLY_REFERENCE_PROFILE` | profileId · profileName                      | reference profile (future) |
| `EXPORT_DESCRIPTOR_UPDATE`| { format, sampleRate, bitDepth, dither }     | export descriptor (future) |

Every command stamps `timestamp` (perf.now) and `source` (user / preset /
reference / reset / system).  `SET_MODULE_PARAM` additionally carries a
`validation` result — see `03-ENGINE-COMMAND-CONTRACT.md`.

---

## 6. Validation

`validateParameterValue(def, candidate)` returns one of:

- `{ status: 'ok',       value }`                       — passed
- `{ status: 'clamped',  from, to, reason }`            — bound-clamped or step-quantised
- `{ status: 'rejected', original, reason }`            — type error / not-finite / unknown enum

The provider applies `ok` and `clamped` commands (state mutates to the
sanitised value) and skips `rejected` ones (state preserved).  Every
result is logged regardless.

---

## 7. Verification

| Check | Result |
|---|---|
| `pnpm --filter @aimaster/desktop typecheck`       | clean |
| `pnpm --filter @aimaster/desktop build:renderer`  | succeeds — 415 KB JS / 99 KB WASM (+14 KB for parameter module) |
| `pnpm --filter @aimaster/desktop build-storybook` | **10 components / 64 stories** indexed |
| `cargo test -p loui-dsp --lib`                    | **31/31** |
| Flag OFF — ResultPage renders                     | manual: no flag → ResultPage path |
| Flag ON — ProductPage renders                     | manual: `__LOUI_PRODUCT_LAYOUT__ = true` |
| Open slide-over → adjust slider                   | command appears in central log |
| Clamping (out-of-range value)                     | `clamped` validation logged, state ends at boundary |
| Reject (wrong type / NaN)                         | `rejected` validation logged, state unchanged |
| Reset button                                      | restores all module params to defaults; log shows RESET_MODULE |
| Bypass toggle                                     | flips bypass flag + SET_MODULE_BYPASS command |
| "Modified" badge                                  | appears when any param differs from default (incl. bypass) |

---

## 8. Storybook coverage

`Product / Parameter State` adds 7 stories:

| Story | What it shows |
|---|---|
| `DefaultParameters`     | EQ at factory defaults, empty log |
| `ModifiedEq`            | EQ with shelves twisted, "Modified" header badge |
| `BypassedImager`        | Imager bypassed, width slider at 40 % |
| `LoudLimiter`           | Limiter pushed to -8.5 LUFS / aggressive character |
| `Export24BitWav`        | Export at 24-bit / 48 kHz / TPDF dither |
| `CommandLog`            | Scripted command sequence + clamping warning row |
| `InvalidValueClamping`  | NaN / out-of-range / wrong-type rejection examples |

---

## 9. Next steps

`07-NEXT-STEPS.md` lays out the M3-P-NEXT-5B engine binding sub-tasks.
The key follow-ups:

1. **M3-P-NEXT-5B** — Replace the no-op log sink with an engine
   dispatcher.  Wire `SET_MODULE_PARAM` → engine.applyParam(...).
2. **Preset bridge** — Convert `EnginePreset` JSON → state snapshot
   on `LOAD_PRESET`.
3. **Reference profile bridge** — Convert profile → state delta on
   `APPLY_REFERENCE_PROFILE`.
4. **Engine read-back** — Subscribe to engine signal reads (GR, TP)
   and merge into state for the "two-way mirror" parameters.
