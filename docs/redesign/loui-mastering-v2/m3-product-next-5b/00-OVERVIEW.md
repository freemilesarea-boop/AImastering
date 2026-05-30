# M3-P-NEXT-5B — Provider onCommand → Engine Dispatcher (1st connection)

> Route UI parameter commands through a real dispatcher seam — staging
> wired parameters into an EngineSchema patch, with no live DSP write.

---

## 1. What changed

M3-P-NEXT-5A built a central parameter state with a command log but a
**no-op `onCommand` sink**.  M3-P-NEXT-5B replaces that with a typed
**EngineDispatcher** seam:

```
UI change → validate → (ok/clamped) → state mutate → dispatcher.dispatch(cmd) → DispatchResult → log
                       (rejected)    → no state, no dispatch
```

The production dispatcher is `PresetPatchDispatcher`: it translates the
11 `wired` parameters into EngineSchema patch fragments and accumulates
them.  It does NOT touch live DSP — there is no live write path today
(see `WIRED_PARAMETER_AUDIT.md` §2).

| New | Purpose |
|---|---|
| `audio/engine-bridge/engine-dispatcher.ts`  | `EngineDispatcher` interface · `DispatchResult` · `toEngineValue` · `PresetPatchDispatcher` |
| `audio/engine-bridge/mock-engine-dispatcher.ts` | Configurable dispatcher for stories/tests (failure injection, dryRun, history) |
| `audio/engine-bridge/noop-engine-dispatcher.ts` | Default dispatcher — returns `noop` for everything |
| `audio/engine-bridge/describe.ts`            | Single-line dispatch-result formatter |
| `audio/parameters/useModuleParameterState.tsx` (refactor) | `dispatcher` prop · dispatch on accepted commands · `dispatchLog` · `useEngineDispatchLog()` |
| `pages/ProductPage.tsx` (refactor)           | Mounts `PresetPatchDispatcher` in both Override + Production providers |
| 6 stories                                     | Supported / Unsupported / Clamped / Rejected / Failure / DryRun |

---

## 2. What did NOT change

| Untouched | Verification |
|---|---|
| DSP chain (`loui-dsp` Rust core)       | `cargo test -p loui-dsp --lib` → 31/31 |
| Rust EQ/comp/limiter                   | None created (forbidden by brief) |
| Python pipeline / mastering            | None modified |
| Export pipeline / IPC                  | None modified |
| ResultPage (legacy)                    | None modified |
| V2 analyzer panels                     | None modified |
| Audio preview / render path            | None modified |
| EngineSchema (preset v1)               | Read-only consumption |

Reiterated constraints honoured:
> 모든 24개 parameter 강제 연결 금지 — only the 11 wired ones reach the
> dispatcher's translation; the rest report `unsupported`.
> Rust EQ/comp/limiter 신규 구현 금지 — none.
> export pipeline 대규모 변경 금지 — none.

---

## 3. Dispatch dispositions

| Status | When | UI state | Engine effect |
|---|---|---|---|
| `staged`      | wired param, normal mode | mutated | fragment added to preset patch |
| `unsupported` | pending / unavailable param, or bypass | mutated | none (logged) |
| `dry-run`     | dryRun mode                | mutated | computed but not staged |
| `failed`      | dispatcher threw / mock failure | mutated (no rollback) | none |
| `noop`        | noop dispatcher / unhandled kind | mutated | none |
| `applied`     | (reserved — not reachable today) | — | live DSP write (M3-P-NEXT-5C) |

Rejected commands never reach the dispatcher (no entry in the dispatch
log).

---

## 4. Ordering + rollback policy

Per the brief's recommendation ("1차는 rollback 보다 warning + command
result log 우선"):

1. Validate the command.
2. If `rejected` — log command, stop.  No state change, no dispatch.
3. If `ok` / `clamped` — **optimistically** mutate UI state.
4. Dispatch to the engine.
5. Log the `DispatchResult` (including `failed`).
6. On `failed`, the UI state is **kept** — no rollback in this phase.

Rationale: the staged patch is the only downstream consumer today, and
a staging failure is non-destructive.  When live DSP write lands
(M3-P-NEXT-5C), rollback semantics will be revisited (a failed live
write may warrant reverting the UI to the last-applied value).

---

## 5. Verification

| Check | Result |
|---|---|
| `pnpm --filter @aimaster/desktop typecheck`       | clean |
| `pnpm --filter @aimaster/desktop build:renderer`  | succeeds — 418 KB JS / 99 KB WASM (+3 KB dispatcher) |
| `pnpm --filter @aimaster/desktop build-storybook` | **11 components / 70 stories** |
| `cargo test -p loui-dsp --lib`                    | **31/31** |
| Flag OFF — ResultPage renders                     | manual: no flag → legacy path |
| Flag ON — supported param change → dispatcher     | manual + story: `staged` result logged |
| Rejected command → no dispatch                    | story: dispatch log has no entry |
| Unsupported param → UI kept + `unsupported` log   | story |
| Engine failure → `failed` warning, state kept     | story (mock failWhen) |
| Audio / render / export regression                | none — no path touched |

---

## 6. Storybook coverage

`Product / Engine Dispatcher` — 6 stories with a dual log view
(command log + dispatch log side by side):

| Story | Demonstrates |
|---|---|
| `SupportedParameterWrite` | wired params → `staged` (with conversions visible) |
| `UnsupportedParameter`    | pending params + bypass → `unsupported` |
| `ClampedThenDispatched`   | out-of-range → clamp → staged corrected value |
| `RejectedNoDispatch`      | NaN / wrong-type → rejected, dispatcher untouched |
| `EngineFailureWarning`    | mock failWhen(dynamics) → `failed` rows |
| `DryRunMode`              | dryRun dispatcher → `dry-run`, nothing staged |

---

## 7. Next steps

`05-M3-P-NEXT-5C-TASKLIST.md` enumerates the render-consumer work.
Headline:

1. **Patch → EnginePreset builder** — convert staged fragments into a
   valid `EnginePreset` partial.
2. **Offline re-render trigger** — feed the preset to the Python adapter,
   swap the preview file.
3. **Debounced apply** — coalesce rapid knob changes before re-rendering.
4. **Live engine (M2-full)** — once the Rust mastering chain exists,
   `applied` becomes reachable for real-time preview.
