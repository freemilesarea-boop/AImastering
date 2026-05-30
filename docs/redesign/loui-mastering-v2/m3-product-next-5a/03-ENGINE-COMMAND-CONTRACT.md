# M3-P-NEXT-5A — Engine Command Contract

> The typed command stream every UI parameter change flows through.

---

## 1. Why an explicit command type

A naïve approach would mutate UI state directly and broadcast a
"changed" event.  That works locally but breaks the moment we need:

- **Replay** — re-applying user actions on a different state snapshot
- **Audit** — answering "what did the user touch in the last 5 seconds"
- **Diff** — telling adapters _only_ what changed since the last apply
- **Validation echo** — surfacing adapter-side clamps back to UI
- **Cross-process bridges** — sending the same change to renderer +
  main process / Rust / Python with one source of truth

An explicit command type — `EngineCommand` — gives all five.

---

## 2. Kind enumeration

```ts
type CommandKind =
  | 'SET_MODULE_PARAM'
  | 'SET_MODULE_BYPASS'
  | 'RESET_MODULE'
  | 'LOAD_PRESET'
  | 'APPLY_REFERENCE_PROFILE'
  | 'EXPORT_DESCRIPTOR_UPDATE';
```

| Kind | When fired | Bridge target (M3-P-NEXT-5B) |
|---|---|---|
| `SET_MODULE_PARAM`        | Every UI parameter change                        | `engine.applyParam(moduleId, parameterId, value)` |
| `SET_MODULE_BYPASS`       | Bypass toggle on a module                        | `engine.setBypass(moduleId, bypass)` |
| `RESET_MODULE`            | Reset button on a module                         | `engine.applyParams(moduleId, defaults)` (batch) |
| `LOAD_PRESET`             | Preset Header selection                           | `engine.loadPreset(EnginePreset)` |
| `APPLY_REFERENCE_PROFILE` | Reference profile applied                         | `engine.applyReferenceProfile(Profile)` |
| `EXPORT_DESCRIPTOR_UPDATE`| Export format / SR / depth / dither changed       | `file:save-wav` IPC with the descriptor |

Only the first three are emitted in this milestone.  The other three
are reserved — `LOAD_PRESET` and `APPLY_REFERENCE_PROFILE` will fire
from the existing Preset Header / Reference Profile system in
M3-P-NEXT-5B.  `EXPORT_DESCRIPTOR_UPDATE` will be emitted by
ExportParameterPanel once the format/SR/depth/dither chips become
real.

---

## 3. Common fields

Every command carries:

```ts
interface BaseCommand {
  kind: CommandKind;
  timestamp: number;        // performance.now()
  source: CommandSource;
}

type CommandSource =
  | 'user'                  // UI interaction
  | 'preset'                // ripple from LOAD_PRESET
  | 'reference'             // ripple from APPLY_REFERENCE_PROFILE
  | 'reset'                 // RESET_MODULE
  | 'system';               // automated / test
```

`source` matters for cross-checks: e.g. when the engine bridge is
hooked up, only `'user'` commands need to be debounced for write
throttling.  `'preset'` commands are inherently batched.

---

## 4. SET_MODULE_PARAM shape

```ts
interface SetModuleParamCommand extends BaseCommand {
  kind: 'SET_MODULE_PARAM';
  moduleId: ModuleId;
  parameterId: string;
  value: ParameterValue;       // the value that actually entered state
  validation: ValidationResult;
}

type ValidationResult =
  | { status: 'ok';       value: ParameterValue }
  | { status: 'clamped';  from: ParameterValue; to: ParameterValue; reason: string }
  | { status: 'rejected'; original: ParameterValue; reason: string };
```

`validation` carries the **original** candidate plus the disposition:

| Disposition | `value` field | State mutated? | UI feedback |
|---|---|---|---|
| `ok`       | candidate                       | ✓ | none |
| `clamped`  | clamped corrected value         | ✓ | warning log row |
| `rejected` | parameter's default             | ✗ | warning log row, state unchanged |

The provider uses `cmd.value` (the sanitised value) when mutating
state — so even on a clamp, state and command agree on the final
value.

---

## 5. Validation rules per kind

### Numeric
- `typeof !== 'number' || !isFinite` → `rejected` (`'not-finite-number'`)
- `step > 0` quantises to grid (`round(v/step) * step`)
- `< min` or `> max` clamps to bound (`reason: 'out-of-range'`)
- quantisation alone (`!= candidate, == clamped`) is `'step-quantised'`

### Boolean
- `typeof !== 'boolean'` → `rejected` (`'not-boolean'`)

### Enum
- `typeof !== 'string'` → `rejected` (`'not-string'`)
- not in `values` → `rejected` (`'not-in-enum [a, b, c]'`)

The validator is **pure** — no side effects, no exceptions.  It is
safe to call from the engine bridge for adapter-side validation too.

---

## 6. Command constructors

Use the typed factories instead of building literals:

```ts
makeSetParamCommand({ defs, moduleId, parameterId, candidate, source? });
makeSetBypassCommand({ moduleId, bypass, source? });
makeResetModuleCommand({ moduleId, source? });
makeLoadPresetCommand({ presetId, presetName?, source? });
makeApplyReferenceCommand({ profileId, profileName?, source? });
makeExportDescriptorCommand({ descriptor, source? });
```

Each:
- Stamps `timestamp` via `performance.now()` (or `Date.now()` fallback
  in non-DOM environments)
- Defaults `source` to a sensible per-kind value (`'user'` for SET,
  `'reset'` for RESET, etc.)
- Runs validation for `SET_MODULE_PARAM` and embeds the result

---

## 7. Log structure

```ts
const { log, clear } = useEngineCommandLog();
//  log:   readonly EngineCommand[]    // append-only; oldest first
//  clear: () => void                  // empty the log
```

The provider caps the log at `logCapacity` (default 256).  When
appended, older entries roll off the start.

```ts
describeCommand(cmd: EngineCommand): string
```

Renders a single-line log entry.  Examples:

```
[12345] user · SET eq.lowShelfDb = 3.5
[12387] user · SET eq.airDb = 8 (clamped from 12)
[12450] user · SET limiter.ceilingDbtp (rejected: not-finite-number)
[12520] user · BYPASS imager = true
[12601] reset · RESET imager
[14001] preset · LOAD_PRESET streaming-loud
```

---

## 8. Future bridge integration (M3-P-NEXT-5B)

The provider has one prop reserved for the engine bridge:

```ts
<ModuleParameterStateProvider onCommand={engineDispatcher}>
  ...
</ModuleParameterStateProvider>
```

`engineDispatcher` receives every command and decides whether to:
- Apply it to the engine immediately
- Batch it with sibling commands
- Echo it back as a state correction (adapter-side clamp)

The provider's UI mutation logic is **always immediate** — the engine
bridge runs independently of the state update.  This decouples UI
responsiveness from DSP write latency.

---

## 9. Test-friendliness

The validator is decoupled from the provider — unit tests can verify
clamping / rejection without mounting React.  Sample test (future):

```ts
test('lowShelfDb clamps to bounds', () => {
  const def = ALL_MODULE_PARAMETER_DEFS.eq.parameters.find((p) => p.id === 'lowShelfDb')!;
  expect(validateParameterValue(def, 20)).toEqual({
    status: 'clamped',
    from: 20,
    to: 6,
    reason: 'out-of-range',
  });
});
```

No tests are added in this milestone; the Storybook `CommandLog` and
`InvalidValueClamping` stories serve as visual regression coverage
until M3-P-NEXT-5B adds a vitest suite.
