# M3-P-NEXT-5D-2-c — sampleRate / bitDepth Export Override

> Wire the Export panel's sample-rate + bit-depth into the Re-master &
> Export override.  Export-only; never touches the preview.

---

## 1. What changed

The export quality chips (sampleRate / bitDepth) were UI shells.  5D-2-c
makes them apply on **Re-master & Export** by merging them into the
`MasteringOptions` override.  They do NOT affect the preview (the
preview is always a 320 kbps MP3) and are NOT applied by Export As-is.

| Param | Preview | Re-master & Export | Export As-is |
|---|---|---|---|
| sampleRate | ✗ | ✓ | ✗ (keeps current file) |
| bitDepth   | ✗ | ✓ | ✗ |

| Deliverable | Where |
|---|---|
| Export quality audit                | `EXPORT_QUALITY_OPTIONS_AUDIT.md` |
| `exportField` binding flag          | `parameter-state.ts` + sampleRate/bitDepth defs |
| `buildExportOverride` quality merge | `engine-bridge/pending-summary.ts` |
| Base-seed export quality            | `initialStateFromBaseOptions` |
| Quality summary UI                  | `ExportParameterPanel` (badge + note) |
| Storybook quality states            | `ExportParameterPanel.stories.tsx` (+4 = 15) |
| Preview/export separation doc       | `01-OPTION-SEPARATION.md` |
| 5D-2-d format/dither prep           | `02-5D-2-D-PREP.md` |

---

## 2. What did NOT change

| Untouched | Verification |
|---|---|
| format / dither implementation | not done (5D-2-d / M2-full) |
| `file:save-wav`                | unchanged |
| Python pipeline                | zero changes (honours sampleRate/bitDepth already) |
| Preview render                 | quality never affects it |
| Real-time DSP / Rust DSP       | none |
| ResultPage / V1                | untouched |
| DSP chain (`loui-dsp`)         | `cargo test` 31/31 |

---

## 3. The exportField mechanism

`EngineBindingTarget` gains an optional `exportField`:

```ts
binding: {
  moduleType: null,            // no DSP module
  path: 'export.sampleRate',
  status: 'unavailable',       // unchanged — not a DSP binding
  exportField: 'sampleRate',   // NEW — maps to MasteringOptions.sampleRate
}
```

`status` stays `unavailable` (these aren't DSP-module params).  The new
`exportField` marks them export-renderable.  This cleanly separates
"preview-renderable" (RENDERABLE_MAP) from "export-renderable"
(exportField), as the brief requested.

---

## 4. buildExportOverride expansion

```ts
buildExportOverride(summary, exportState, baseOptions)
```

- Starts from `summary.renderOverride` (the 4 audio params)
- For each export def with an `exportField`:
  - validate the value against the enum `values`
  - `Number()` it
  - if it differs from `baseOptions[field]` → add to override + `qualityAppliedKeys`
  - if invalid → `skippedParameterIds`
- export-quality params are excluded from the staged-only list (they're
  handled here, not "skipped")

`patchHash` covers the full override (audio + quality), deterministic.

---

## 5. Baselining

`initialStateFromBaseOptions` now also seeds export.sampleRate /
export.bitDepth from `base.sampleRate` / `base.bitDepth` (when they
match an enum option).  So the panel shows the master's actual quality
at load → no false "changed" until the user picks a different value.

---

## 6. UI

The Export section gains:
- A **Quality badge** — "48 kHz · 24-bit" (accent when changed from base)
- A **change note** when quality differs:
  > Export quality change (44.1 kHz · 16-bit) will apply on Re-master &
  > Export.  Export As-is keeps the current file format.

A quality-only change enables Re-master & Export (there's something to
apply) but does NOT trigger the audio "unpreviewed changes" warning
(quality doesn't change the audio content).

---

## 7. Verification

| Check | Result |
|---|---|
| `pnpm typecheck`        | clean |
| `pnpm build:renderer`   | 436 KB JS / 99 KB WASM |
| `pnpm build` (main)     | esbuild OK |
| `pnpm build-storybook`  | **13 components / 92 stories** |
| `cargo test -p loui-dsp --lib` | **31/31** |
| sampleRate change → MasteringOptions.sampleRate | ✓ |
| bitDepth change → MasteringOptions.bitDepth     | ✓ |
| Export As-is ignores quality override           | ✓ (saves existing WAV) |
| Re-master & Export applies quality override      | ✓ (mergeOptions) |
| invalid value → skipped                         | ✓ (enum validation) |
| file:save-wav / Python untouched                | ✓ |

---

## 8. Next

`02-5D-2-D-PREP.md` — format + dither.  These need the `file:save-wav`
save path to encode/convert, so they carry more risk and are gated
last.
