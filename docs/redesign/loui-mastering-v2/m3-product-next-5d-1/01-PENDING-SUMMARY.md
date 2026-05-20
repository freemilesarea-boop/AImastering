# M3-P-NEXT-5D-1 — Pending Summary + Multi-Module Tracking

> `summarizePending` — the reactive computation behind every pending UI.

---

## 1. Inputs / output

```ts
summarizePending(
  state: AllModulesParameterState,        // reactive (useAllModuleParameters)
  lastRenderedOverride: Partial<MasteringOptions>,  // {} = base preview
  baseOptions: MasteringOptions,          // the original master baseline
  defs?: AllModulesDefinitions,
): PendingSummary
```

```ts
interface PendingSummary {
  renderablePending: RenderablePendingItem[];   // changed since last render
  unsupportedPending: PendingItem[];             // staged-only
  pendingByModule: Record<ModuleId, 'renderable' | 'staged' | null>;
  renderablePendingCount: number;
  unsupportedPendingCount: number;
  totalPendingCount: number;
  hasUnrenderedChanges: boolean;
  renderOverride: Partial<MasteringOptions>;     // FULL diff-from-base to SEND
  patchHash: string;
}
```

---

## 2. Two comparisons, two outputs

For each renderable parameter the helper computes its current engine
value and compares against two baselines:

| Comparison | Drives |
|---|---|
| current ≠ **base**           | `renderOverride` (what to send — full diff from base) |
| current ≠ **lastRendered**   | `renderablePending` (the badge — changed since the preview) |

`lastRendered` falls back to `base` when a key isn't in
`lastRenderedOverride` (i.e. the preview reflects base for that key).

### Why two

- The render must be **complete** (every changed-from-base value), since
  each render starts from the base master.
- The badge must show only what's **unrendered** (changed since the last
  preview), so the user knows there's something new to hear.

---

## 3. Per-module rollup

```ts
pendingByModule[moduleId] =
  any renderable pending in module ? 'renderable'
  : any staged-only change in module ? 'staged'
  : null;
```

`'renderable'` wins over `'staged'` — if a module has both, the
preview-ready signal dominates (it has something the user can hear).

Drives:
- Module Strip card dot (green glow = renderable, grey = staged)
- Slide-over header tag ("Preview-ready" / "Staged only")

---

## 4. Staged-only classification

A parameter is "staged-only" when it's changed from its default but has
no renderable mapping:

```ts
else if (current !== def.default) {
  unsupportedPending.push({ moduleId, parameterId, enginePath });
}
```

This covers:
- The 7 wired params not in RENDERABLE_MAP (dynamics ×4, eq.adaptive,
  limiter.isp, limiter.lookaheadMs)
- All `pending` / `unavailable` params

These never reach the preview (no MasteringOptions field), so the UI
labels them "staged only" — honest about what the user will/won't hear.

---

## 5. Baselining helper

```ts
initialStateFromBaseOptions(baseOptions): AllModulesParameterState
```

Seeds the four renderable params from the base master so "current ===
base" at load.  Non-renderable params keep canonical defaults (they
don't affect pending-vs-base since the staged-only check compares
against `def.default`, which they equal at load).

Mounted via the production provider's `initialState` prop.

---

## 6. Reactivity

`summarizePending` reads the provider STATE (not the dispatcher's
imperative patch), so it recomputes whenever any parameter changes:

```ts
const { state } = useAllModuleParameters();   // re-renders on any change
const summary = useMemo(
  () => summarizePending(state, lastRenderedOverride, baseOptions),
  [state, lastRenderedOverride, baseOptions],
);
```

`useAllModuleParameters` is a new hook returning the full state + defs.
The `useMemo` keeps the summary stable between unrelated re-renders.

---

## 7. Sharing across consumers

The summary is computed once in `ProductionPreviewProvider` and shared
via `PreviewBridgeContext`:

```
ProductionPreviewProvider (computes summary)
  └─ PreviewBridgeContext.Provider value={{ summary, phase, onUpdate, ... }}
       ├─ ProductLayoutInner
       │    └─ LouiModuleStrip  pendingByModule={summary.pendingByModule}
       │    └─ ModuleSlideOverHost → SlideOverActions (reads bridge)
       └─ PreviewSlotFromBridge (preview strip — reads bridge)
```

Storybook ProductPage stories don't mount the provider → `usePreviewBridge()`
returns `null` → no pending dots, no preview strip.  Clean separation.

---

## 8. Worked example

Master at −9 LUFS / −1 dBTP.  User opens Limiter, sets target −7,
opens Dynamics, sets ratio 4.

```
initialStateFromBaseOptions: limiter.targetLufs = -9 (matches base)
user sets limiter.targetLufs = -7
user sets dynamics.ratio = 4

summarizePending(state, {}, base) →
  renderablePending: [{ limiter.targetLufs, current:-7, rendered:-9 }]
  unsupportedPending: [{ dynamics.ratio }]   (no renderable mapping)
  pendingByModule: { limiter:'renderable', dynamics:'staged', ... }
  renderablePendingCount: 1
  unsupportedPendingCount: 1
  renderOverride: { targetLufs: -7 }
  patchHash: 'targetLufs=-7'
```

UI shows: "1 renderable · 1 staged-only".  Module strip: limiter green
dot, dynamics grey dot.  Update Preview → render with targetLufs −7;
dynamics.ratio stays staged (the user is told it won't be heard yet).
