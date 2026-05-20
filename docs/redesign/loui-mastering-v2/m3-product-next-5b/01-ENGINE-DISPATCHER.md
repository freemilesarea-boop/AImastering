# M3-P-NEXT-5B — Engine Dispatcher Design

> Interface, result type, and the three concrete dispatchers.

---

## 1. Interface

```ts
interface EngineDispatcher {
  readonly name: string;
  dispatch(command: EngineCommand): DispatchResult;   // never throws
  getStagedPatch?(): StagedPatchEntry[];               // optional
  reset?(): void;                                      // optional
}
```

Contract:
- `dispatch` is **total** — it returns a `DispatchResult` for every
  command kind, including ones it doesn't handle (`noop`).
- `dispatch` **never throws** — the provider also guards with a
  try/catch that converts a thrown error into a `failed` result, but a
  well-behaved dispatcher returns `failed` itself.
- `getStagedPatch` / `reset` are optional — only patch-accumulating
  dispatchers implement them.

---

## 2. DispatchResult

```ts
type DispatchStatus =
  | 'applied'      // live DSP write — NOT reachable today
  | 'staged'       // translated into a preset patch fragment
  | 'unsupported'  // no wired binding (pending / unavailable)
  | 'noop'         // dispatcher does nothing
  | 'dry-run'      // computed engine value, applied nothing
  | 'failed';      // engine threw / rejected

interface DispatchResult {
  status: DispatchStatus;
  command: EngineCommand;     // self-contained for log views
  timestamp: number;
  engineModule?: EngineModuleType | null;
  enginePath?: string;
  engineValue?: ParameterValue;   // converted (engine-space) value
  note?: string;
}
```

`engineValue` shows the **converted** value (e.g. width 130 % →
`1.3`), so the log makes the UI→engine mapping visible.

---

## 3. PresetPatchDispatcher — production

The default dispatcher mounted by ProductPage.  Behaviour by command:

| Command | Binding status | Result |
|---|---|---|
| `SET_MODULE_PARAM` | `wired`       | `staged` — fragment added to patch |
| `SET_MODULE_PARAM` | `pending`     | `unsupported` |
| `SET_MODULE_PARAM` | `unavailable` | `unsupported` |
| `SET_MODULE_BYPASS`| any           | `unsupported` (all bypass bindings pending) |
| `RESET_MODULE`     | —             | `staged` — clears that module's fragments |
| other kinds        | —             | `noop` |

In `dryRun` mode, `staged` → `dry-run` and nothing is accumulated.

### Patch accumulation

```ts
private patch = new Map<string, StagedPatchEntry>();
// key = `${moduleType}:${path}`  (so repeated writes overwrite)
```

`getStagedPatch()` returns the current fragment list:

```ts
interface StagedPatchEntry {
  moduleType: EngineModuleType;
  path: string;
  value: ParameterValue;       // engine-space
  sourceModuleId: ModuleId;    // provenance
  sourceParameterId: string;
}
```

This is the artifact the M3-P-NEXT-5C render consumer reads.

---

## 4. Value conversion

`toEngineValue(moduleId, parameterId, value)`:

```ts
// Imager widths: ui % → engine multiplier
imager.widthPct / bandLowPct / … → value / 100

// Limiter ISP toggle → oversample factor
limiter.isp → value ? 4 : 1

// everything else → passthrough
```

The function is exported so the M3-P-NEXT-5C render consumer reuses
the exact same conversion (single source of truth).

---

## 5. NoopEngineDispatcher

```ts
class NoopEngineDispatcher {
  name = 'noop';
  dispatch(command) {
    return { status: 'noop', command, timestamp: now(), note: 'no engine connected' };
  }
}
export const NOOP_DISPATCHER = new NoopEngineDispatcher();
```

The provider falls back to `NOOP_DISPATCHER` when no `dispatcher` prop
is given.  Stateless — safe to share the singleton.

---

## 6. MockEngineDispatcher

Wraps `PresetPatchDispatcher`'s translation but adds test affordances:

```ts
interface MockDispatcherOptions {
  dryRun?: boolean;
  failWhen?: (command: EngineCommand) => boolean;  // force `failed`
  failNote?: string;
}
```

Plus:
- `getHistory()` — every `DispatchResult` recorded
- `countByStatus()` — `{ staged: 4, unsupported: 2, … }`
- `failModule(moduleId)` helper — fail all commands for a module

Used by the Storybook dispatcher stories to exercise every disposition
deterministically.

---

## 7. Why three dispatchers

| Dispatcher | Role |
|---|---|
| `PresetPatchDispatcher` | Production 1st connection — real translation, real patch accumulation, no DSP write |
| `NoopEngineDispatcher`  | Safe default / fallback — useful for stories that only test the state model, not dispatch |
| `MockEngineDispatcher`  | Test + Storybook — failure injection, dryRun, recorded history |

Future (M3-P-NEXT-5C) adds:
- `OfflineRenderDispatcher` — builds a preset, re-invokes the Python
  render, swaps the preview file
- `LiveEngineDispatcher` (M2-full) — writes to the Rust mastering chain
  for real-time preview (`applied` status becomes reachable)

Each new dispatcher implements the same `EngineDispatcher` interface —
the provider and panels need zero changes.

---

## 8. Thread-safety / re-entrancy

Dispatchers run synchronously inside the provider's `setParam` callback.
The `PresetPatchDispatcher` mutates an internal `Map` synchronously —
no async, no races.  A future async dispatcher (offline render) MUST:

- Return immediately with a `staged` / `applied:pending` result
- Resolve the actual render on a later tick
- Push a follow-up result into the dispatch log via a provider callback
  (the provider gains an `onAsyncResult` channel in M3-P-NEXT-5C)

This keeps the synchronous UI path fast.
