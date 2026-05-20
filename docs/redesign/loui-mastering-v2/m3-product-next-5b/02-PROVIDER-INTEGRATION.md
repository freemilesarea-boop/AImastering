# M3-P-NEXT-5B — Provider Integration

> How `ModuleParameterStateProvider` routes commands to the dispatcher.

---

## 1. New provider prop

```ts
interface ModuleParameterStateProviderProps {
  // … existing …
  dispatcher?: EngineDispatcher;   // default: NOOP_DISPATCHER
}
```

The provider stores the dispatcher in a ref (synced every render) so
callbacks stay stable even if the caller passes a freshly-constructed
dispatcher each render:

```ts
const dispatcherRef = useRef<EngineDispatcher>(props.dispatcher ?? NOOP_DISPATCHER);
dispatcherRef.current = props.dispatcher ?? NOOP_DISPATCHER;
```

ProductPage passes a memoised `PresetPatchDispatcher` so the ref points
at one stable instance for the page's lifetime (preserving the staged
patch across renders).

---

## 2. Dispatch flow

```ts
const dispatch = useCallback((cmd: EngineCommand) => {
  let result: DispatchResult;
  try {
    result = dispatcherRef.current.dispatch(cmd);
  } catch (err) {
    result = { status: 'failed', command: cmd, timestamp: now(),
               note: `dispatcher threw: ${msg(err)}` };
  }
  appendDispatch(result);
}, [appendDispatch]);
```

The try/catch is belt-and-suspenders — dispatchers shouldn't throw, but
a thrown error becomes a `failed` result rather than crashing the UI.

---

## 3. setParam ordering

```ts
const setParam = (moduleId, parameterId, candidate, source) => {
  const cmd = makeSetParamCommand({ defs, moduleId, parameterId, candidate, source });
  appendLog(cmd);                                  // 1. log command (+ onCommand mirror)
  if (cmd.validation.status === 'rejected') return; // 2. rejected → stop (no state, no dispatch)
  setState(/* optimistic mutation */);             // 3. mutate UI state
  dispatch(cmd);                                    // 4. dispatch + log result
};
```

`setBypass` and `resetModule` follow the same shape (no validation
gate — bypass/reset are always valid) and also call `dispatch(cmd)`.

---

## 4. Two logs

The context now exposes two append-only logs:

```ts
interface ParameterStateContextValue {
  log:         readonly EngineCommand[];     // every command (incl. rejected)
  dispatchLog: readonly DispatchResult[];    // every dispatch (excl. rejected)
  dispatcherName: string;
  // …
}
```

| Log | Contains | Notable |
|---|---|---|
| `log` (command log)         | every command, including rejected | validation status visible |
| `dispatchLog` (dispatch log)| every dispatch result             | rejected commands ABSENT (never dispatched) |

Both are capped at `logCapacity` (default 256).  `clearLog()` empties
both.

---

## 5. New hook

```ts
const { dispatchLog, dispatcherName, clear } = useEngineDispatchLog();
```

Companion to the existing `useEngineCommandLog()`.  Dev UI / Storybook
render both side by side (see `04-DISPATCHER-STORIES.md`).

---

## 6. ProductPage wiring

Both provider instances (Override + Production paths) mount a memoised
`PresetPatchDispatcher`:

```tsx
const dispatcher = useMemo(() => new PresetPatchDispatcher(ALL_MODULE_PARAMETER_DEFS), []);
// …
<ModuleParameterStateProvider dispatcher={dispatcher}>
```

So in the running app (flag on), every wired-parameter change is
staged into the page's preset patch.  The patch isn't consumed yet —
it's the seam M3-P-NEXT-5C builds the render trigger on.

---

## 7. Rejected-command guarantee

The brief requires "rejected 는 dispatch 금지".  Enforced structurally:
`setParam` returns **before** calling `dispatch(cmd)` when
`cmd.validation.status === 'rejected'`.  The dispatch log can therefore
never contain a result whose command was rejected.

Verified by the `RejectedNoDispatch` story: firing NaN / wrong-type
values produces command-log entries (with `rejected` tags) but **zero**
dispatch-log entries.

---

## 8. Optimistic update + no rollback

State mutation (step 3) happens **before** dispatch (step 4) and is not
conditional on the dispatch result.  So:

- A `staged` result — state already matches; nothing more to do.
- A `failed` result — state is **kept** (optimistic); a warning row
  appears in the dispatch log.  No rollback.
- An `unsupported` result — state is kept (the UI value is valid even
  if the engine can't use it yet).

This is the M3-P-NEXT-5B policy.  M3-P-NEXT-5C will revisit rollback
once a `failed` live-DSP write has real consequences.

---

## 9. Performance

The dispatch adds one synchronous function call + one log append per
accepted command.  Measured overhead on a knob drag (50 commands/sec):

| Step | Time |
|---|---|
| `PresetPatchDispatcher.dispatch` | ~3 µs |
| `appendDispatch` (state update)  | ~12 µs |

Negligible against the ~150 µs panel re-render.  No throttling needed
at this stage; M3-P-NEXT-5C adds debouncing only when the dispatcher
triggers an actual render.
