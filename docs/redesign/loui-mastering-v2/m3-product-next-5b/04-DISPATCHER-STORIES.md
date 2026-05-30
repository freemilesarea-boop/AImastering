# M3-P-NEXT-5B — Dispatcher Stories & Status UI

> Storybook coverage for the dispatcher seam and the dual-log view.

---

## 1. Story location

`Product / Engine Dispatcher` — six stories, each driven by a scenario
arg + a `MockEngineDispatcher`.

The story host mounts:

```
<ModuleParameterStateProvider dispatcher={mockDispatcher}>
  <ScenarioButtons />   ← "Fire scenario" + "Reset all"
  <DualLog />           ← command log | dispatch log
</ModuleParameterStateProvider>
```

---

## 2. Dual-log view

Two side-by-side panels:

| Panel | Source | Colour cues |
|---|---|---|
| Command Log    | `useEngineCommandLog()`   | warn colour for clamped/rejected |
| Dispatch Log   | `useEngineDispatchLog()`  | green=staged · grey=unsupported · blue=dry-run · red=failed |

Each row uses the single-line formatters:
- `describeCommand(cmd)` for the command log
- `describeDispatchResult(result)` for the dispatch log

The dispatch panel header shows the active dispatcher name
(`mock`, `mock (dry-run)`, …) and the entry count.

---

## 3. The six stories

### SupportedParameterWrite

Fires wired-parameter changes:
```
dynamics.thresholdDb = -18    → staged → bus-comp.thresholdDb = -18
limiter.ceilingDbtp  = -1.5   → staged → limiter.ceilingDb = -1.5
imager.widthPct      = 130    → staged → stereo-imager.width = 1.3   (÷100)
limiter.isp          = false  → staged → limiter.oversample = 1      (bool→1)
```
Verifies conversions are visible in the dispatch log.

### UnsupportedParameter

Fires pending-parameter changes:
```
eq.lowShelfDb     = 2.5         → unsupported (binding pending)
limiter.character = aggressive  → unsupported (binding pending)
eq.bypass         = true        → unsupported (bypass binding pending)
```
UI state still mutates; dispatch log shows `unsupported` rows.

### ClampedThenDispatched

Fires out-of-range wired values:
```
limiter.ceilingDbtp = 5    → command: clamped to 0    → dispatch: staged limiter.ceilingDb = 0
dynamics.thresholdDb = -99 → command: clamped to -30  → dispatch: staged bus-comp.thresholdDb = -30
```
Shows that the staged value is the **corrected** (clamped) one.

### RejectedNoDispatch

Fires invalid values:
```
limiter.ceilingDbtp = NaN        → command: rejected → NO dispatch entry
limiter.character   = 'nuclear'  → command: rejected → NO dispatch entry
```
Verifies the dispatch log stays empty for rejected commands.

### EngineFailureWarning

Mock dispatcher configured with `failWhen: failModule('dynamics')`:
```
dynamics.ratio = 4   → command: ok → dispatch: failed ("dynamics stage offline")
```
UI state still updates (no rollback); dispatch log shows a red `failed`
row.

### DryRunMode

Mock dispatcher with `dryRun: true`:
```
dynamics.attackMs   = 25  → dispatch: dry-run (computed bus-comp.attackMs = 25, not staged)
limiter.lookaheadMs = 5   → dispatch: dry-run
```
`getStagedPatch()` stays empty — nothing accumulates in dry-run.

---

## 4. Status UI in the slide-over (ProductPage)

The ProductPage slide-over header already shows the per-module
"Modified" badge, bypass toggle, and Reset button (from M3-P-NEXT-5A).
M3-P-NEXT-5B does **not** add a dispatch-status indicator to the
production slide-over — the dispatch log is a dev/Storybook surface,
gated behind future `__LOUI_DEBUG_LOG__` (see M3-P-NEXT-5A
`07-NEXT-STEPS.md`).

Rationale: end users don't need to see "staged into preset patch" — it's
an engineering concept.  Once M3-P-NEXT-5C makes changes audible, the
relevant user feedback is "re-rendering…" / "applied", not the raw
dispatch status.

---

## 5. Reading the logs together

The two logs tell a complete story per change:

```
Command Log                              Dispatch Log
─────────────────────────────────       ──────────────────────────────────────────
[t] user · SET limiter.ceilingDbtp = 0     [t] ⊕ STAGED limiter.ceilingDb = 0
    (clamped from 5)                            (staged · ui clamp already applied)
```

- Command log = "what the UI requested + how validation treated it"
- Dispatch log = "what the engine seam did with the accepted value"

A clamped command shows the correction in BOTH logs (validation clamp
in the command, the corrected value staged in the dispatch).

---

## 6. Total Storybook footprint after this milestone

| Category | Components | Stories |
|---|---:|---:|
| Audio Panels        | 4 | 31 |
| Design System       | 1 | 2  |
| Product             | 6 | 37 |
| **Total**           | **11** | **70** |

The `Product / Engine Dispatcher` category adds the 6 dispatcher
stories on top of M3-P-NEXT-5A's `Product / Parameter State` (7).
