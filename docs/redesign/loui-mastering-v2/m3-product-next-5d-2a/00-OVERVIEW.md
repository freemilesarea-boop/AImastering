# M3-P-NEXT-5D-2-a — Re-master & Export

> Reuse the preview render override for the final export.  Option A —
> the existing `audio:master` + `file:save-wav` channels, no new IPC.

---

## 1. What changed

The preview could re-render with overridden targetLufs / targetTp /
stereoWidth / outputGainDb (5C + 5D-1), but the EXPORT still saved the
original master WAV.  5D-2-a adds "Re-master & Export": the same override
that drives the preview now drives a fresh master render that gets saved.

```
Re-master & Export:
  override = buildExportOverride(summary).optionsOverride   // = summary.renderOverride
  options  = mergeOptions(baseOptions, override)
  result   = await invoke('audio:master', sourceAudioPath, '', options)   ← EXISTING
  saved    = await invoke('file:save-wav', result.outputPath)             ← EXISTING
```

| Deliverable | Where |
|---|---|
| Export path audit                  | `EXPORT_PATH_AUDIT.md` |
| `buildExportOverride()`            | `engine-bridge/pending-summary.ts` (reuses `summary.renderOverride`) |
| Re-master & Export UI              | `ExportParameterPanel` → `ReMasterExportSection` |
| Bridge export wiring               | `ProductPage` `ProductionPreviewProvider` (`onReMasterExport`) |
| Export override summary            | applied / staged-only / unpreviewed badges |
| Storybook export states            | `ExportParameterPanel.stories.tsx` (7 stories) |
| Preview/export consistency policy  | `01-CONSISTENCY-POLICY.md` |
| 5D-2-b "Export As-is" prep         | `02-5D-2-B-PREP.md` |

---

## 2. What did NOT change

| Untouched | Verification |
|---|---|
| `audio:master` channel        | called as-is with merged options |
| `file:save-wav` channel       | called as-is |
| Python pipeline               | zero changes |
| Save/export path              | no rewrite — reuse the copy-to-dialog flow |
| Real-time DSP                 | not implemented |
| Rust EQ/comp/limiter          | none created |
| ResultPage / V1               | untouched |
| DSP chain (`loui-dsp`)        | `cargo test` 31/31 |

Constraints honoured: no Python pipeline change, no save-path rewrite,
no real-time DSP, no Rust DSP, no V2 default / V1 removal.

---

## 3. Consistency by construction

Both preview and export derive from the SAME `summary.renderOverride`:

| Path | Override source |
|---|---|
| Preview (`onUpdate`)        | `summary.renderOverride` |
| Export (`onReMasterExport`) | `buildExportOverride(summary).optionsOverride` = `summary.renderOverride` |

So "what you preview is what you export" holds structurally — there's no
parallel export-override that could drift.

---

## 4. UI — Re-master & Export section

Rendered inside the Export module slide-over panel:

```
┌─ Re-master & Export ───────────────────────┐
│  [Apply 3 changes]  [Skip 2 staged-only]    │
│  Applies: targetLufs, targetTp, stereoWidth │
│  2 staged-only changes not applied …        │
│  ⚠ This export includes changes not          │
│    previewed yet.                            │
│  [ Re-master & Export ]                      │
│  Re-renders the master with your changes …   │
└──────────────────────────────────────────────┘
```

States:
- **No changes** → button disabled, "No changes to export"
- **Changes, previewed** → enabled, "Re-master & Export"
- **Changes, unpreviewed** → enabled + amber warning
- **Staged-only present** → "N staged-only not applied" note
- **Exporting** → button disabled, "Re-mastering…"
- **Done** → "✓ Exported → {path}"
- **Error** → "✗ Export failed · {message}"

---

## 5. Failure safety

- Save dialog cancelled → phase returns to `idle`, no file written, prior
  state intact.
- `audio:master` throws → phase `error`, message shown, no file written.
- `file:save-wav` throws → phase `error`, the master temp WAV exists but
  isn't saved; the preview + UI state are untouched.

No path can leave the user with a broken preview or lost work.

---

## 6. Staged-only handling

The 7 non-renderable wired params (dynamics ×4, eq.adaptive, limiter.isp,
limiter.lookaheadMs) + all pending/unavailable params are reported as
`skippedParameterIds`.  The export UI labels them "not applied to this
export (no render mapping yet)" — honest about what the exported file
will/won't contain.

When those params become renderable (M2-full adds the MasteringOptions
fields), they automatically join `appliedKeys` via the shared
`RENDERABLE_MAP`.

---

## 7. Verification

| Check | Result |
|---|---|
| `pnpm typecheck`        | clean |
| `pnpm build:renderer`   | 432 KB JS / 99 KB WASM |
| `pnpm build` (main)     | esbuild OK |
| `pnpm build-storybook`  | **13 components / 84 stories** |
| `cargo test -p loui-dsp --lib` | **31/31** |
| 4 overrides merged into MasteringOptions | ✓ (mergeOptions) |
| staged-only → export skipped             | ✓ (skippedParameterIds) |
| export failure → prior state kept        | ✓ (phase error, no swap) |
| `audio:master` regression                | none (called as-is) |

(Live Python re-master not exercisable in sandbox; UI states covered by
stories, the flow reuses the proven `audio:master` + `file:save-wav`.)

---

## 8. Next

`02-5D-2-B-PREP.md` — "Export As-is" toggle (save the original master
WAV unchanged) for users who don't want a re-master.
