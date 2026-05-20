# M3-P-NEXT-5C — Preview / Export Override Reuse Design

> The same override structure that drives the preview re-render should
> drive the final export — designed here, NOT implemented (per the brief:
> "export pipeline 직접 변경은 최소화 / 위험하면 문서화만").

---

## 1. The shared structure

The preview render and the final export both need the same answer:
"what options/parameters did the user change vs the base master?"

`buildPreviewOverride(stagedPatch)` already produces both forms:

```ts
interface PreviewBuildResult {
  optionsOverride: Partial<MasteringOptions>;   // for MasteringOptions-based render
  enginePatch: StagedPatchEntry[];              // canonical EngineSchema fragments
  // …
}
```

- **Preview** uses `optionsOverride` (the renderable subset today).
- **Export** can use the SAME `optionsOverride` (when re-mastering for
  export via the existing pipeline) OR `enginePatch` (when M2-full's
  preset-driven export lands).

The key design decision: **one builder, two consumers**.  No separate
"export override" code path.

---

## 2. How export works today

The final export is the WAV produced at master time
(`masteringResult.outputPath`), saved via `file:save-wav`.  Changing a
parameter in the product UI does NOT currently affect the exported WAV —
the WAV was rendered before the user touched anything.

So today there's a gap: the user can re-render the PREVIEW with a new
targetLufs, but the EXPORT still reflects the original master.

---

## 3. The reuse plan (M3-P-NEXT-5D / 5E)

Two options, both reusing the override:

### Option A — re-master on export (simplest)

When the user exports AND there are pending overrides:

```
1. buildPreviewOverride(stagedPatch) → optionsOverride
2. mergeOptions(baseOptions, optionsOverride) → exportOptions
3. audio:master(sourceAudioPath, _, exportOptions)   ← EXISTING channel
4. file:save-wav(result.outputPath)
```

This reuses `audio:master` (not even the new re-render channel) — zero
new pipeline code.  The only new logic is "merge overrides before
export".

### Option B — promote the last preview render (fastest)

If the preview was already re-rendered with the current overrides, its
WAV (the re-render also produces a WAV via `masterFile`) can be promoted
to the export:

```
1. The re-render handler already calls masterFile → produces a WAV
2. Track the WAV path alongside the preview path
3. On export, save THAT WAV instead of the original master's
```

This avoids a second render but requires the re-render handler to retain
+ return the WAV path (currently it returns only the preview MP3).

---

## 4. Recommended approach

**Option A** for M3-P-NEXT-5D — it's the safest:
- Reuses `audio:master` (proven, untouched)
- No state to track between preview + export
- The override merge is the only new code (already built —
  `buildPreviewOverride` + `mergeOptions`)

**Option B** as a 5E optimisation once render caching matters.

---

## 5. Consistency guarantee

Because preview and export both derive from the same
`buildPreviewOverride(stagedPatch)`, "what you preview is what you
export" holds by construction — provided both use the same renderable
set.

When the renderable set expands (5D adds `targetTp`, `stereoWidth`,
`outputGainDb`), both preview and export pick up the new parameters
simultaneously, because they read the same `RENDERABLE_MAP`.

---

## 6. What NOT to do

- **Don't** build a parallel "export override" structure — it would
  drift from the preview override.
- **Don't** modify the Python export logic — re-master via the existing
  `audio:master` with merged options.
- **Don't** auto-export on parameter change — export is an explicit,
  expensive user action.

---

## 7. Export UI sketch (5D)

The ExportParameterPanel (currently a UI shell) gains:

```
┌─ Export ──────────────────────────────────┐
│  Format / Sample Rate / Bit Depth / Dither │
│  ─────────────────────────────────────────│
│  ⚠ 1 parameter changed since master        │
│    (targetLufs −14 → −10)                   │
│  [ Re-master & Export ]   [ Export As-is ] │
└────────────────────────────────────────────┘
```

- "Re-master & Export" → Option A flow
- "Export As-is" → save the original master WAV (current behaviour)

This makes the override reuse explicit + user-controlled.

---

## 8. Status

| Item | Status |
|---|---|
| Shared override structure (`buildPreviewOverride`) | ✓ built (5C) |
| Preview render uses it                              | ✓ built (5C) |
| Export reuses it                                    | designed (this doc) — NOT implemented |
| Export UI for pending changes                       | designed — 5D |

Per the brief, export application is documented only.  The structure is
in place so 5D can wire it with minimal risk.
