# M3-P-NEXT-5D-1 — Renderable Map Expansion + Multi-Module Pending

> Grow the preview-renderable set from 1 → 4 parameters, and surface
> per-module pending state across ProductPage.

---

## 1. What changed

M3-P-NEXT-5C made ONE parameter (`limiter.targetLufs`) reflect in the
preview re-render.  5D-1 expands to FOUR and adds clear multi-module
pending tracking.

| New renderable | Engine binding | MasteringOptions field | Conversion |
|---|---|---|---|
| `limiter.targetLufs`  | loudness-norm.targetLufs  | `targetLufs`   | direct |
| `limiter.ceilingDbtp` | limiter.ceilingDb         | `targetTp`     | direct |
| `imager.widthPct`     | stereo-imager.width       | `stereoWidth`  | `÷100` (dispatcher) |
| `eq.outputGainDb`     | gain-staging.targetPeakDb | `outputGainDb` | direct |

All four target MasteringOptions fields the Python pipeline already
honours — zero pipeline change.

| Deliverable | Where |
|---|---|
| RENDERABLE_MAP 4-entry expansion          | `engine-bridge/renderable-map.ts` (single source) |
| `buildPreviewOverride` renderableFragments + patchHash | `engine-bridge/engine-preset-builder.ts` |
| Pending summary helper                    | `engine-bridge/pending-summary.ts` |
| `initialStateFromBaseOptions`             | `engine-bridge/pending-summary.ts` |
| `useAllModuleParameters` hook             | `parameters/useModuleParameterState.tsx` |
| Enhanced render payload                   | `shared-types`: patchHash / appliedOverrideKeys / skippedParameterIds / targetSummary |
| Controller hash dedup + onNoop            | `engine-bridge/preview-render-client.ts` |
| Preview bridge context + multi-module UI  | `pages/ProductPage.tsx` |
| Module Strip pending dots                 | `components/product/LouiModuleStrip.tsx` |
| Preview control renderable/staged summary | `components/product/LouiPreviewControl.tsx` |
| Stories                                    | +1 (MixedRenderableAndStaged) = 77 total |

---

## 2. What did NOT change

| Untouched | Verification |
|---|---|
| Real-time DSP                  | Not implemented |
| Rust EQ/comp/limiter           | None created |
| Python pipeline                | Zero changes — same `masterFile` |
| Export pipeline                | Untouched (5D-2 prep documented) |
| `audio:master` / V1 / ResultPage | Untouched |
| DSP chain (`loui-dsp`)         | `cargo test` 31/31 |

Constraints honoured: only 4 wired params renderable (not all 24), no
real-time DSP, no Rust DSP, no Python/export pipeline changes, no V2
default / V1 removal.

---

## 3. Multi-module pending model

`summarizePending(state, lastRenderedOverride, baseOptions)` partitions
every changed parameter into:

- **renderable pending** — wired + renderable, current engine value ≠
  what the preview currently reflects.  The "Update Preview" button
  applies these.
- **staged-only** — changed from default but not renderable (the other
  7 wired params + all pending/unavailable).  Informational.

Output drives three UI surfaces:

| Surface | Field used |
|---|---|
| Preview strip badges        | `renderablePendingCount` / `unsupportedPendingCount` |
| Module Strip card dots      | `pendingByModule[id]` ('renderable' = green glow, 'staged' = grey) |
| Slide-over header tag       | `pendingByModule[id]` → "Preview-ready" / "Staged only" |

---

## 4. Baselining (no false pending)

The provider's state is seeded from the base master options via
`initialStateFromBaseOptions(baseOptions)`:

```
limiter.targetLufs  ← base.targetLufs
limiter.ceilingDbtp ← base.targetTp
imager.widthPct     ← (base.stereoWidth ?? 1.0) × 100
eq.outputGainDb     ← base.outputGainDb ?? 0
```

So "current === base" holds at load → zero pending until the user
changes something.  Without this, a master made at −9 LUFS would show
the −14 default as "pending" immediately.

---

## 5. Full-override semantics

Each preview render is from the BASE master, not incremental.  So the
override must carry EVERY renderable value that differs from base, not
just the delta since the last render:

```
renderOverride = { for each renderable key where current ≠ base : current }
```

Example: user sets targetLufs −10 (render), then width 130%.  The 2nd
render sends `{ targetLufs: -10, stereoWidth: 1.3 }` — keeping the −10,
not reverting to base.  `summarizePending.renderOverride` computes this.

---

## 6. Patch hash + dedup

`hashOverride(override)` produces a deterministic string (sorted keys).
Used for:
- **Dedup** — the controller skips a render whose `patchHash` equals the
  last rendered hash (`onNoop` fires).
- **Stale matching** — responses are matched on `requestId` AND
  (when echoed) `patchHash`.

---

## 7. Verification

| Check | Result |
|---|---|
| `pnpm typecheck`        | clean |
| `pnpm build:renderer`   | 429 KB JS / 99 KB WASM |
| `pnpm build` (main)     | esbuild OK |
| `pnpm build-storybook`  | **12 components / 77 stories** |
| `cargo test -p loui-dsp --lib` | **31/31** |
| targetLufs → targetLufs override | ✓ (RENDERABLE_MAP + summarizePending) |
| ceilingDbtp → targetTp override  | ✓ |
| widthPct → stereoWidth override  | ✓ (÷100) |
| outputGainDb → outputGainDb override | ✓ |
| unsupported param → staged-only  | ✓ (pending summary) |
| render success → pending cleared | ✓ (lastRenderedOverride updated) |
| render failure → pending retained | ✓ (no override update on error) |
| same patch → no-op               | ✓ (controller hash dedup) |

(Live Python render not exercisable in sandbox; renderer loop covered
by mock-transport stories, handler reuses `masterFile`.)

---

## 8. Next

`02-5D-2-EXPORT-PREP.md` lists the export override reuse work (reuse
`summarizePending.renderOverride` + `audio:master` for "Re-master &
Export").
