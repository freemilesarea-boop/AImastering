# M3-P-NEXT-5C — Task List

> Make the staged patch audible: offline re-render trigger + preview swap.

---

## 1. Goal

M3-P-NEXT-5B stages wired parameters into a preset patch but doesn't
render.  M3-P-NEXT-5C consumes the patch to produce an updated preview —
the first time a UI knob turn audibly changes the master.

Scope discipline: re-render via the **existing Python pipeline**.  No
DSP rewrite, no Rust mastering chain (that's M2-full).

---

## 2. Deliverables

1. **Patch → EnginePreset builder** (`audio/engine-bridge/patch-to-preset.ts`)
2. **Re-render IPC** (`audio:re-render-preview`)
3. **OfflineRenderDispatcher** (`audio/engine-bridge/offline-render-dispatcher.ts`)
4. **Debounce + cancel** logic
5. **Preview swap** (resume position)
6. **Re-rendering UI state** ("applying…" indicator)
7. Stories + feasibility-closure doc

---

## 3. Patch → EnginePreset builder

```ts
function applyPatchToPreset(
  base: EnginePreset,
  patch: StagedPatchEntry[],
): EnginePreset
```

Algorithm:
1. Deep-clone `base` (the preset that produced the current master)
2. For each fragment, locate the target module in `base.chain.nodes` by
   `moduleType`
3. Write `fragment.value` at `fragment.path` (parse `bands[id].field`
   selectors)
4. Special cases:
   - `adaptive-eq:adaptive` → broadcast to all bands' `adaptive`
   - `loudness-norm:targetLufs` → cross-module (already correct module)
5. Re-validate against `validateEnginePreset` (existing M1 validator)

Tests: round-trip each wired parameter → assert the preset field changed.

---

## 4. Re-render IPC

```ts
// preload
'audio:re-render-preview': (preset: EnginePreset) => Promise<{
  previewPath: string;
  report: AdapterRunReport;
} | { error: string }>
```

Main-process handler:
1. Validate the preset
2. Run the Python adapter (same code path as initial mastering)
3. Write a new preview MP3 to a temp path
4. Return the path

**Safety**: this is a NEW IPC channel.  The initial mastering flow is
untouched — V1 + the first-render path keep working.

---

## 5. OfflineRenderDispatcher

```ts
class OfflineRenderDispatcher implements EngineDispatcher {
  name = 'offline-render';
  constructor(
    defs: AllModulesDefinitions,
    private getBasePreset: () => EnginePreset,
    private onRendered: (previewPath: string) => void,
    private onRenderState: (s: 'idle' | 'rendering' | 'error') => void,
  ) {}

  dispatch(cmd): DispatchResult {
    // 1. stage via PresetPatchDispatcher (reuse)
    // 2. debounce: schedule a re-render 500ms after the last change
    // 3. return { status: 'staged', note: 'queued for re-render' }
  }

  // async, off the dispatch() path:
  private async render() {
    this.onRenderState('rendering');
    const preset = applyPatchToPreset(this.getBasePreset(), this.getStagedPatch());
    const res = await window.electronAPI.invoke('audio:re-render-preview', preset);
    if ('error' in res) { this.onRenderState('error'); return; }
    this.onRendered(res.previewPath);
    this.onRenderState('idle');
  }
}
```

Note: `dispatch()` stays synchronous + returns immediately; the render
runs async.  A follow-up result (`applied` / `failed`) is pushed into
the dispatch log via a new provider `onAsyncResult` channel.

---

## 6. Debounce + cancel

- Debounce 500 ms after the last accepted command
- Cancel any in-flight render when a new change arrives
- Coalesce: one render reflects ALL accumulated patch fragments

```ts
private timer?: ReturnType<typeof setTimeout>;
private inflight?: AbortController;
schedule() {
  clearTimeout(this.timer);
  this.timer = setTimeout(() => this.render(), 500);
}
```

---

## 7. Preview swap

```ts
const t = audioRef.current.currentTime;
audioRef.current.src = newPreviewUrl;
audioRef.current.addEventListener('loadedmetadata', () => {
  audioRef.current!.currentTime = t;
  if (wasPlaying) void audioRef.current!.play();
}, { once: true });
```

Capture position before swap, restore after metadata loads.

---

## 8. Re-rendering UI state

Add a small indicator to the ProductPage transport / status bar:

```
[ ⟳ Re-rendering preview… ]   (during render)
[ ✓ Preview updated ]          (after, fade out)
```

Source the state from the dispatcher's `onRenderState` callback.

---

## 9. Provider async-result channel

Add to `ModuleParameterStateProvider`:

```ts
onAsyncResult?: (result: DispatchResult) => void;
// or a returned dispatcher.subscribe(cb) the provider listens to
```

So async render outcomes (`applied` / `failed`) land in the dispatch log
just like synchronous results.

---

## 10. Rollback revisit

With a real (audible) render, a `failed` render is more consequential.
Decision for 5C:
- Keep UI state (the value the user set is still valid)
- Keep the LAST GOOD preview playing
- Show an error toast + dispatch-log row
- Offer a "retry" affordance

Still no UI-state rollback — the user's intent is preserved; only the
audio reflection lags.

---

## 11. Wire-up order (from the audit)

1. `limiter.targetLufs` (Python honours natively) — prove the loop
2. `limiter.ceilingDbtp`
3. `dynamics.*` (4)
4. `imager.widthPct`
5. `eq.outputGainDb` + `eq.adaptive`
6. `limiter.isp` + `limiter.lookaheadMs`

After all 11 reflect, flip their binding `status` `wired` → keep, and
update the audit doc to mark "live render: yes".

---

## 12. Out of scope for 5C (→ M2-full)

- Real-time (sample-accurate) preview — needs Rust mastering chain in WASM
- The 13 `pending` parameters — need EngineSchema additions
- The 4 `unavailable` export params — need export IPC rework
- Live GR / correlation reads from a mastering engine

5C is strictly "make the 11 wired params audible via offline
re-render."  Real-time + the rest follow M2-full.
