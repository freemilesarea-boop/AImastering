# M3-P-NEXT-5A — Controlled Panel Refactor

> How the five parameter panels evolved from local-state to
> controlled-or-uncontrolled, and the bridge that lets them work in
> both modes.

---

## 1. Before / after

```
M3-P-NEXT-4 (local-state)
─────────────────────────
export function EqParameterPanel() {
  const [state, setState] = useState(DEFAULTS);
  const update = (k) => (v) => setState((s) => ({...s, [k]: v}));
  return <LouiSliderRow ... onChange={update('lowShelfDb')} />
}

M3-P-NEXT-5A (controlled-or-uncontrolled)
─────────────────────────────────────────
export function EqParameterPanel(props: ControlledPanelProps = {}) {
  const { state, setParam } = usePanelStateBridge(DEFAULTS, props);
  const update = (k) => (v) => setParam(k, v);
  return <LouiSliderRow ... onChange={update('lowShelfDb')} />
}
```

The shape of the panel JSX didn't change.  The state ownership did.

---

## 2. The bridge

`components/product/panels/usePanelStateBridge.ts`:

```ts
export function usePanelStateBridge<TState>(
  defaults: TState,
  props: ControlledPanelProps,
): PanelStateBridge<TState> {
  const [local, setLocal] = useState<TState>(defaults);
  const [localBypass, setLocalBypass] = useState(false);

  const controlled = props.state !== undefined;
  const state: TState = controlled
    ? (props.state as unknown as TState)   // caller owns
    : local;                                // we own
  const bypass = props.bypass ?? localBypass;

  const setParam = (id, value) => {
    props.onParamChange
      ? props.onParamChange(id as string, value)
      : setLocal((prev) => ({ ...prev, [id]: value }));
  };
  // … setBypass, reset same pattern
  return { state, bypass, setParam, setBypass, reset };
}
```

The bridge picks the source of truth per render:

- `props.state !== undefined` → controlled (parent owns)
- Otherwise → uncontrolled (local useState)

Same for `props.bypass`, `props.onParamChange`, `props.onBypassChange`,
`props.onReset`.

---

## 3. ControlledPanelProps

The props shape every panel accepts:

```ts
interface ControlledPanelProps {
  state?:           Record<string, ParameterValue>;
  bypass?:          boolean;
  isModified?:      boolean;                                       // header badge hint
  onParamChange?:   (parameterId: string, value: ParameterValue) => void;
  onBypassChange?:  (bypass: boolean) => void;
  onReset?:         () => void;
}
```

All optional — panels still render with `{}` (uncontrolled mode).

When a parent passes the props, it owns the data flow.  Validation,
clamping, and logging happen in the parent (ProductPage via the
central provider) — the panel just dispatches `onParamChange`.

---

## 4. Two consumption modes

### Mode A: Uncontrolled (M3-P-NEXT-4 stories)

```tsx
// Old slide-over stories still mount panels with no props.
<LouiModuleSlideOver title="EQ" ...>
  <EqParameterPanel />
</LouiModuleSlideOver>
```

The bridge falls back to local `useState`.  Every interaction stays
inside the panel.  No commands are dispatched — there's no provider to
log to.

### Mode B: Controlled (M3-P-NEXT-5A integration)

```tsx
<ModuleParameterStateProvider>
  <ProductLayoutInner …>
    <LouiModuleSlideOver title="EQ" headerActions={<SlideOverActions … />}>
      <EqParameterPanel
        state={moduleState.parameters}
        bypass={api.bypass}
        isModified={api.isModified}
        onParamChange={api.setParam}
        onBypassChange={api.setBypass}
        onReset={api.reset}
      />
    </LouiModuleSlideOver>
  </ProductLayoutInner>
</ModuleParameterStateProvider>
```

Now every onChange:
1. Calls `api.setParam(id, value)` from `useModuleParameters('eq')`
2. The provider validates, clamps, logs a command
3. State mutation flows back to `moduleState.parameters` → panel re-renders

The panel's bridge sees `props.state` defined, uses it directly,
forwards the change through `props.onParamChange`.

---

## 5. ProductPage integration shape

```
<ModuleParameterStateProvider>
  ┌──────────────────────────────────────────────────────────┐
  │ <ProductLayoutInner …>                                    │
  │   <LouiTopBar />                                          │
  │   <LouiPresetHeader />                                    │
  │   <LouiAnalyzerCanvas />  <LouiMeterColumn />             │
  │   <LouiModuleStrip onSelect=… />                          │
  │   <LouiStatusBar />                                       │
  │   <ModuleSlideOverHost selected=… onClose=…>              │
  │     <LouiModuleSlideOver                                  │
  │       headerActions={                                     │
  │         <SlideOverActions moduleId=… />  ◀── reads        │
  │       }                                       isModified  │
  │     >                                          / bypass   │
  │       <ControlledPanelHost moduleId=… />  ◀── reads state │
  │     </LouiModuleSlideOver>                     +setParam  │
  │   </ModuleSlideOverHost>                                  │
  │ </ProductLayoutInner>                                     │
  └──────────────────────────────────────────────────────────┘
</ModuleParameterStateProvider>
```

`SlideOverActions` and `ControlledPanelHost` both call
`useModuleParameters(moduleId)`.  The Context guarantees they see the
same slice — Reset clears state, badge updates immediately.

---

## 6. Cross-module reads

`ExportParameterPanel` echoes the limiter's `targetLufs` / `ceilingDbtp`
into its "Normalize Target" section.  In the controlled path:

```tsx
function ControlledPanelHost({ moduleId }: { moduleId: ModuleId }) {
  const api = useModuleParameters(moduleId);
  // …
  const limiterApi = useModuleParameters('limiter');
  const tLufs = limiterApi.get('targetLufs');
  const tTp   = limiterApi.get('ceilingDbtp');
  // …
  case 'export':
    return <ExportParameterPanel … targetLufs={tLufs} targetTp={tTp} />;
}
```

Both hooks subscribe to the same Context.  When LimiterParameterPanel
writes `targetLufs`, ExportParameterPanel re-renders with the new echo
on the next React tick.

---

## 7. SlideOver header actions

`LouiModuleSlideOver` gained one prop — `headerActions: ReactNode` —
slotted to the left of the × button.  ProductPage feeds this with
`<SlideOverActions moduleId={renderedId} />`:

```tsx
function SlideOverActions({ moduleId }: { moduleId: ModuleId }) {
  const { isModified, bypass, setBypass, reset } = useModuleParameters(moduleId);
  return (
    <div style={{ display: 'flex', gap: space['2'] }}>
      {isModified && <Badge>Modified</Badge>}
      <Button onClick={() => setBypass(!bypass)}>{bypass ? 'Bypassed' : 'On'}</Button>
      <Button onClick={() => reset()}>Reset</Button>
    </div>
  );
}
```

These are direct Loui-themed buttons (not `LouiTogglePill` / `LouiButton`
primitives) because the header has tight space and uses 22 px-tall
controls.  Visual conformance is preserved by sourcing colours from
`loui-theme`.

---

## 8. Behaviour matrix

| Scenario | Uncontrolled (no provider) | Controlled (provider) |
|---|---|---|
| Panel renders defaults              | ✓ from local `useState` initial | ✓ from `state.parameters` |
| Slider drag changes value           | local `setState`                | provider `setParam` |
| Out-of-range value entered          | silently capped by `<input>` limits | clamped via validator; logged |
| Reset button (header)               | not visible (no provider)         | ✓ clears module to defaults  |
| Bypass toggle (header)              | not visible (no provider)         | ✓ flips `bypass`             |
| "Modified" badge                    | not visible                        | ✓ when any value ≠ default   |
| Command log                         | n/a                                | populates                    |
| Cross-module echo                   | falls back to props.targetLufs ?? -14 | live from limiter state    |

Both modes coexist because the bridge picks the source of truth per
prop.

---

## 9. Why keep uncontrolled mode at all?

The simplest answer: existing stories.  `M3-P-NEXT-4` shipped 8
slide-over stories that mount panels without a provider.  Forcing
them all into controlled mode would mean wrapping every story with
`<ModuleParameterStateProvider>` for no functional benefit.

The broader answer: panels are now **reusable** outside ProductPage.
Future surfaces (a settings page, a quick-EQ widget) can mount any
panel with `{}` props and get a working UI immediately.  The Provider
is opt-in for "I need cross-panel coordination and audit logging."

This mirrors the React `<select>` / `<input>` controlled/uncontrolled
pattern — same React idiom, applied to a higher-level component.
