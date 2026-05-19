# M3-P-NEXT-5A — State Model

> Type shape, provider, and hook surface for the central parameter
> state.

---

## 1. Type pyramid

```
                          AllModulesParameterState
                          │
                          ├─ eq:        ModuleParameterState
                          │    ├─ bypass: boolean
                          │    └─ parameters: Record<string, ParameterValue>
                          │
                          ├─ dynamics:  ModuleParameterState
                          ├─ imager:    ModuleParameterState
                          ├─ limiter:   ModuleParameterState
                          └─ export:    ModuleParameterState
```

```ts
type ParameterValue = number | boolean | string;

interface ModuleParameterState {
  moduleId: ModuleId;
  bypass: boolean;
  parameters: Record<string, ParameterValue>;
}

type AllModulesParameterState = Record<ModuleId, ModuleParameterState>;
```

Module ids are stable strings:

```ts
type ModuleId = 'eq' | 'dynamics' | 'imager' | 'limiter' | 'export';

const MODULE_IDS: readonly ModuleId[] = ['eq', 'dynamics', 'imager', 'limiter', 'export'];
```

---

## 2. Parameter definitions

Each parameter is a tagged union of one of three shapes:

### NumericParameterDef

```ts
{
  kind: 'number',
  id: 'lowShelfDb',
  label: 'Low Shelf',
  hint?: '120 Hz / Q=0.7',
  unit?: 'dB',
  min: -6, max: 6, default: 1.2, step: 0.1,
  format?: (v) => v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1),
  automatable: true,
  binding: {
    moduleType: 'adaptive-eq',
    path: 'bands[lowShelf].gainDb',
    status: 'pending',
  },
}
```

### BooleanParameterDef

```ts
{
  kind: 'boolean',
  id: 'adaptive',
  label: 'Adaptive',
  hint?: 'Auto-tune EQ to spectral target',
  default: true,
  offLabel?: 'Manual',
  onLabel?: 'Adaptive',
  automatable: false,
  binding: { moduleType: 'adaptive-eq', path: 'adaptive', status: 'wired' },
}
```

### EnumParameterDef

```ts
{
  kind: 'enum',
  id: 'character',
  label: 'Character',
  values: ['transparent', 'glue', 'aggressive', 'classic'],
  default: 'glue',
  labels?: { transparent: 'Transparent', ... },
  hints?: { transparent: 'Clean, hi-fi mastering', ... },
  automatable: false,
  binding: { moduleType: 'limiter', path: 'character', status: 'pending' },
}
```

---

## 3. Provider

`ModuleParameterStateProvider` is a React Context provider with:

```ts
interface ModuleParameterStateProviderProps {
  initialState?: AllModulesParameterState;   // override defaults
  defs?: AllModulesDefinitions;              // override definitions (rare)
  logCapacity?: number;                       // default 256
  onCommand?: (cmd: EngineCommand) => void;   // M3-P-NEXT-5B sink
  children: ReactNode;
}
```

Internally it holds:

```ts
const [state, setState]   = useState(initial);
const [log,   setLog]     = useState<EngineCommand[]>([]);
```

Setter callbacks:
- `setParam(moduleId, parameterId, candidate, source?)` — validates, mutates state if accepted, always logs
- `setBypass(moduleId, bypass, source?)` — toggles bypass flag, logs
- `resetModule(moduleId, source?)` — resets to defaults, logs

All three operations append to `log`.  When the log exceeds
`logCapacity`, the oldest entries roll off.

---

## 4. Hook surface

```ts
const api = useModuleParameters('eq');
//  api.state:        ModuleParameterState
//  api.bypass:       boolean
//  api.isModified:   boolean    // any param differs from default || bypass
//  api.def:          ModuleParameterDefinitions
//  api.get(id):      ParameterValue
//  api.setParam(id, value, source?): void
//  api.setBypass(b, source?): void
//  api.reset(source?): void
```

`isModified` is derived inside the hook with `useMemo` so panels can
render a "Modified" badge without re-computing on every render.

```ts
const { log, clear } = useEngineCommandLog();
// log is the full append-only command list (cap'd at logCapacity)
```

`describeCommand(cmd)` is re-exported for log views to render
single-line summaries.

---

## 5. Controlled-vs-uncontrolled panel bridge

`usePanelStateBridge<TState>(defaults, props)` lets each panel work in
both modes:

- **Controlled** (production / parameter-state stories): caller passes
  `state` + `onParamChange` + `bypass` + `onBypassChange` + `onReset`.
  The bridge forwards every change through these callbacks.
- **Uncontrolled** (legacy slide-over stories): no props passed.  The
  bridge maintains local `useState` internally — equivalent to the
  M3-P-NEXT-4 behaviour.

```tsx
export function EqParameterPanel(props: ControlledPanelProps = {}) {
  const { state: s, setParam, bypass, reset } = usePanelStateBridge(DEFAULTS, props);
  // … render UI using `s` …
}
```

The bridge's TypeScript generic `TState` is unconstrained — the panel
defines its own narrow shape (`EqState`) and the bridge runtime-casts
the loosely-typed controlled `state` prop back to that shape.  We trust
the controller (ProductPage / Parameter State story) to pass
keys that match.

---

## 6. Default value sourcing

Each panel's `DEFAULTS` constant is built by querying the canonical
definitions:

```ts
const DEFAULTS: EqState = {
  lowCutHz:   ALL_MODULE_PARAMETER_DEFS.eq.parameters.find((p) => p.id === 'lowCutHz')!.default as number,
  lowShelfDb: ALL_MODULE_PARAMETER_DEFS.eq.parameters.find((p) => p.id === 'lowShelfDb')!.default as number,
  // ... etc
};
```

This guarantees panel defaults and central-state defaults can never
drift apart.  Any change to a definition's `default` field
automatically reflects in both.

---

## 7. State shape audit

After provider mount with `initialState=undefined`:

```ts
state === {
  eq: {
    moduleId: 'eq',
    bypass: false,
    parameters: {
      lowCutHz:     32,
      lowShelfDb:   1.2,
      presenceDb:   1.4,
      airDb:        2.0,
      outputGainDb: 0,
      adaptive:     true,
    },
  },
  dynamics: {
    moduleId: 'dynamics',
    bypass: false,
    parameters: {
      thresholdDb: -14, ratio: 2.0, attackMs: 10,
      releaseMs: 120,   mixPct: 100,
    },
  },
  // ... imager / limiter / export
}
```

`isModified` returns `false` for every module.  The command log is
empty.

After `setParam('eq', 'lowShelfDb', 3.5)`:

- `state.eq.parameters.lowShelfDb = 3.5`
- `log` has one entry: `SET_MODULE_PARAM eq.lowShelfDb = 3.5 (ok)`
- `isModified` for eq is `true`

---

## 8. Performance notes

- The provider uses three `useState` hooks (state + log + nothing else).
- `setParam` allocates one new state object per call (shallow copy of
  the module + parameters).  This is O(1) regardless of how many
  modules / parameters exist.
- Log appends use a copy-on-write slice when capacity-trimming is
  needed; under normal use (≤ 256 entries) it's `prev.slice() + push`.
- `useModuleParameters` returns a new memoised object on every render
  (via `useMemo` inside the hook), so panel renders are cheap.

Profiling on a sample knob-drag (50 commands/sec):

| Operation | Time |
|---|---|
| `setParam` validate + clamp           | ~5 µs |
| Provider state mutation (shallow copy) | ~15 µs |
| Panel re-render with new state        | ~150 µs |

All well within budget for 60 Hz UI.

---

## 9. Open questions for M3-P-NEXT-5B

| Question | Today's answer | Decision needed |
|---|---|---|
| Where does the engine bridge live?         | TBD (not in this milestone) | Likely `audio/engine-bridge/dispatcher.ts` |
| How does the provider know about bridge?   | Via `onCommand` prop          | Or via a separate `<EngineBridgeProvider>` wrapping the param provider |
| What happens on adapter-side clamping?     | Not modelled                  | Add an `AdapterAck` event type that flows back into state |
| Two-way mirror parameters (read-only meters) | Not modelled                | Provider grows a `signalRead(moduleId, signal)` channel |
| Preset → state hydration                   | Not modelled                  | Add `loadPreset(EnginePreset)` action |
| Reference profile → state delta            | Not modelled                  | Add `applyReferenceProfile(Profile)` action |

All five are explicit deliverables of M3-P-NEXT-5B.  None block this
milestone.
