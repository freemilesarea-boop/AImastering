# M3-P-NEXT-5D — Expansion Plan

> Grow the renderable set, add export reuse, and harden the loop.

---

## 1. Expand the renderable set

`MasteringOptions` already supports three more wired parameters.  Adding
them is a one-line-per-parameter change to `RENDERABLE_MAP`:

```ts
const RENDERABLE_MAP = {
  'loudness-norm:targetLufs':  'targetLufs',    // ✓ 5C
  'limiter:ceilingDb':         'targetTp',      // 5D
  'stereo-imager:width':       'stereoWidth',   // 5D
  'gain-staging:targetPeakDb': 'outputGainDb',  // 5D
};
```

After this, four parameters drive the preview re-render.  The other
seven wired params (dynamics ×4, eq.adaptive, limiter.isp,
limiter.lookaheadMs) need `MasteringOptions` fields that don't exist yet
OR a preset-driven render (M2-full).

### Per-parameter conversion check (5D)

| Param | MasteringOptions field | Conversion | Note |
|---|---|---|---|
| `limiter.ceilingDbtp` | `targetTp`     | direct | Python honours TP target |
| `imager.widthPct`     | `stereoWidth`  | `/100` (already in `toEngineValue`) | width 0..200% → 0..2.0 |
| `eq.outputGainDb`     | `outputGainDb` | direct | Python honours output gain |

The `widthPct/100` conversion already happens in the dispatcher's
`toEngineValue`, so the staged fragment is already in engine space
(0..2.0) — the builder maps it straight to `stereoWidth`.

---

## 2. Multi-module pending tracking

5C's `ProductionPreviewControl` subscribes only to the limiter slice
(sufficient for `targetLufs`).  5D needs to react to changes across EQ /
imager / limiter.

Fix: subscribe to all relevant modules, OR expose a provider-level
"staged patch changed" signal:

```ts
// option: provider exposes the staged patch reactively
const { stagedPatch } = useEngineDispatchState();
const build = buildPreviewOverride(stagedPatch);
```

This requires the provider to surface the dispatcher's patch as reactive
state (currently it's read imperatively via `dispatcher.getStagedPatch()`).

---

## 3. Export override reuse

Implement Option A from `05-OVERRIDE-REUSE.md`:

1. ExportParameterPanel shows "N parameters changed since master".
2. "Re-master & Export" → `mergeOptions(base, override)` →
   `audio:master` → `file:save-wav`.
3. "Export As-is" → save the original master WAV.

Reuses `audio:master` (no new pipeline code) + the existing
`buildPreviewOverride`.

---

## 4. Auto-render option

5C requires an explicit "Update Preview" click.  5D adds an optional
auto-render mode:

- Setting: "Auto-update preview" (default off — render has a cost).
- When on: `controller.request()` without `flush()` → debounce 800 ms
  → render after the user stops adjusting.
- Show the rendering state inline so the user knows it's working.

---

## 5. In-flight render cancellation

5C drops stale responses but lets the Python render run to completion.
5D can actually cancel:

```ts
const result = await masterFile(b, src, wav, options, { signal });
```

The bridge already accepts a `signal` (see `getBridge` setup).  Wire an
`AbortController` per request; abort the prior render when a new one
fires.  Saves CPU on rapid changes.

---

## 6. Render result caching

Identical override → identical render.  Cache by the deterministic
`enginePatch` hash:

```ts
const key = JSON.stringify(build.enginePatch);
if (cache.has(key)) return cache.get(key);   // skip the render
```

Because `buildPreviewOverride` sorts fragments deterministically, the
key is stable.  Avoids re-rendering when the user toggles back to a
previously-rendered value.

---

## 7. Vitest suite

Add `engine-preset-builder.test.ts`:
- `buildPreviewOverride` renderable / unsupported partitioning
- determinism (shuffle input → same output)
- `mergeOptions` override precedence
- controller debounce + latest-wins (with a fake-timer mock transport)

And `preview-render-controller.test.ts`:
- debounce coalescing
- stale-response rejection
- cancel marks in-flight stale

---

## 8. Real-time preview (M2-full, beyond 5D)

The offline re-render has inherent latency (seconds).  True real-time
preview needs the Rust mastering chain compiled to WASM, applying DSP to
the playing buffer.  That's M2-full — out of scope for the 5x series.

When it lands, the dispatcher's `applied` status becomes reachable:
parameter changes apply instantly with no re-render, and the
"Update Preview" button disappears for real-time-capable parameters.

---

## 9. Sequencing

| PR | Scope | Risk |
|---|---|---|
| 5D-1 | Expand `RENDERABLE_MAP` (+3 params) + multi-module tracking | Low |
| 5D-2 | Export override reuse (Option A) + export UI                | Med (export UI) |
| 5D-3 | Auto-render setting                                         | Low |
| 5D-4 | In-flight cancellation (AbortController)                    | Low |
| 5D-5 | Render result caching                                       | Low |
| 5D-6 | Vitest suites                                               | Low |

Each ships behind the product-layout flag — no production user impact
until M3-P-NEXT-6 promotes the layout to default.
