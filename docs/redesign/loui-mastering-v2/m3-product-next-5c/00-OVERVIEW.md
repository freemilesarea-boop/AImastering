# M3-P-NEXT-5C — Staged Patch → Preview Re-render (first audible reflection)

> The first time a UI parameter change reaches the actual preview audio:
> staged patch → MasteringOptions override → re-render IPC → audio swap.

---

## 1. What changed

M3-P-NEXT-5B staged wired parameters into a patch but never rendered.
M3-P-NEXT-5C closes the loop for **one renderable parameter**
(`limiter.targetLufs`, per the brief):

```
UI change → dispatcher stages patch → "Update Preview" click
   → buildPreviewOverride() → MasteringOptions override
   → PreviewRenderController (debounce + latest-wins)
   → audio:re-render-preview IPC → masterFile (EXISTING Python path)
   → new preview MP3 → audio src swap (position preserved)
```

This is NOT real-time DSP — it's an explicit, user-triggered offline
re-render that reuses the existing mastering pipeline with overridden
options.  No Python code changes.

| New | Purpose |
|---|---|
| `engine-bridge/engine-preset-builder.ts` | `buildPreviewOverride` · `mergeOptions` — staged patch → MasteringOptions override + canonical patch |
| `engine-bridge/preview-render-client.ts` | `PreviewRenderController` (debounce/latest-wins) + `IpcPreviewRenderTransport` |
| `engine-bridge/mock-preview-render-transport.ts` | Mock transport for stories/tests |
| `shared-types` (+types)                  | `PreviewRenderRequest` / `PreviewRenderResponse` IPC contract |
| `main/ipc/audioHandlers.ts` (+handler)   | `audio:re-render-preview` — thin wrapper over `masterFile` |
| `preload/index.ts` (+channel)            | `audio:re-render-preview` allowlisted |
| `components/product/LouiPreviewControl.tsx` | "Update Preview" UI: pending badge · button · state · timestamp |
| `pages/ProductPage.tsx` (refactor)       | `ProductionPreviewControl` wires controller + audio swap |
| 6 stories                                 | NoChanges · PendingChange · RenderingSuccess · RenderFailed · StaleResponseIgnored · RapidDebounced |

---

## 2. What did NOT change

| Untouched | Verification |
|---|---|
| Real-time DSP                           | Not implemented (offline re-render only) |
| Rust EQ/comp/limiter                    | None created |
| Python pipeline                         | Zero changes — `masterFile` reused as-is |
| Export pipeline                         | Untouched (override reuse documented only — `05-OVERRIDE-REUSE.md`) |
| `audio:master` / initial master flow    | Untouched — new channel is separate |
| ResultPage (legacy) / V1                | Untouched |
| DSP chain (`loui-dsp`)                  | `cargo test` 31/31 |

Constraints honoured:
> 실시간 DSP write 구현 금지 · Rust EQ/comp/limiter 신규 구현 금지 ·
> 모든 parameter 강제 연결 금지 (only `targetLufs` renderable) ·
> export pipeline 대규모 변경 금지 (documented only).

---

## 3. Renderable scope

5C renders **exactly one** parameter:

| UI parameter | EngineSchema path | MasteringOptions field |
|---|---|---|
| `limiter.targetLufs` | `loudness-norm.targetLufs` | `targetLufs` |

The other 10 wired parameters stay **staged** (the dispatcher still
accumulates them; `buildPreviewOverride` reports them under
`unsupportedForRender`).  Expanding the renderable set is a one-line
addition to `RENDERABLE_MAP` (M3-P-NEXT-5D) — `MasteringOptions`
already supports `targetTp`, `stereoWidth`, `outputGainDb`.

---

## 4. Safety architecture

| Concern | Mitigation |
|---|---|
| Render cost (seconds)        | Explicit "Update Preview" button — no auto-render |
| Rapid changes spam renders   | Debounce 600 ms + latest-wins |
| Stale responses overwrite    | Monotonic `requestId`; superseded responses ignored |
| Render failure breaks preview| Old preview keeps playing; error state shown; no swap |
| New channel breaks V1        | `audio:re-render-preview` is additive; `audio:master` untouched |
| Position lost on swap        | `currentTime` captured + restored on `loadedmetadata` |

---

## 5. Verification

| Check | Result |
|---|---|
| `pnpm --filter @aimaster/desktop typecheck`       | clean |
| `pnpm --filter @aimaster/desktop build:renderer`  | 425 KB JS / 99 KB WASM |
| `pnpm --filter @aimaster/desktop build` (main)    | esbuild OK (new IPC handler compiles) |
| `pnpm --filter @aimaster/desktop build-storybook` | **12 components / 76 stories** |
| `cargo test -p loui-dsp --lib`                    | **31/31** |
| Flag OFF — ResultPage renders                     | manual: legacy path |
| Flag ON — change targetLufs → patch + pending     | manual + story |
| Update Preview → IPC request                      | story (mock transport) |
| Success → preview swap                            | story |
| Failure → previous preview kept                   | story (RenderFailed) |
| Stale response ignored                            | story (StaleResponseIgnored) |
| Rapid changes → 1 render                          | story (RapidDebounced) |

Note: a live Python render couldn't be exercised in this environment
(no audio engine binary).  The renderer-side loop is fully verified via
the mock transport; the main-process handler reuses the proven
`masterFile` path with overridden options — see `02-IPC-CONTRACT.md`.

---

## 6. Storybook coverage

`Product / Preview Render` — 6 stories driving `LouiPreviewControl`
through a real `PreviewRenderController` + `MockPreviewRenderTransport`:

| Story | Demonstrates |
|---|---|
| `NoChanges`           | 0 pending → button disabled |
| `PendingChange`       | 1 pending → button enabled |
| `RenderingSuccess`    | full loop → "Preview updated" |
| `RenderFailed`        | mock failure → "Render failed", preview kept |
| `StaleResponseIgnored`| two rapid requests → only the 2nd swaps |
| `RapidDebounced`      | three requests in the window → one render |

---

## 7. Next steps

`07-M3-P-NEXT-5D-PLAN.md`:
1. Expand renderable set (`targetTp`, `stereoWidth`, `outputGainDb`) —
   all already in `MasteringOptions`.
2. Optional auto-render (debounced) as a setting.
3. Export override reuse (`05-OVERRIDE-REUSE.md`) — wire the same
   override into the final export.
4. M2-full: real-time preview (Rust mastering chain in WASM) — makes
   the dispatcher's `applied` status reachable.
