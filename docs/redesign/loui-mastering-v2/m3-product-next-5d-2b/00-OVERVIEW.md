# M3-P-NEXT-5D-2-b — Export As-is / Re-master & Export split

> Two clear export paths: save the current master unchanged (fast), or
> re-master with the latest parameter changes (slower).

---

## 1. What changed

5D-2-a added "Re-master & Export".  5D-2-b adds the complementary
"Export As-is" and presents both as a clear two-path choice in the
Export panel.

| Action | Source WAV | Re-render? | Speed |
|---|---|---|---|
| **Export As-is**       | `masteringResult.outputPath` (existing) | no  | fast |
| **Re-master & Export** | fresh `audio:master(override)` output   | yes | slower |

Both end in `file:save-wav(wavPath)` → save dialog.  No new IPC, no
Python change, no `file:save-wav` change.

| Deliverable | Where |
|---|---|
| Export As-is audit              | `EXPORT_AS_IS_AUDIT.md` |
| `onExportAsIs` handler + state  | `ProductPage` `ProductionPreviewProvider` |
| Two-path Export panel UI        | `ExportParameterPanel` (`ReMasterExportSection`) |
| Separate status / loading       | `exportAsIsPhase` vs `exportPhase` |
| Storybook export-as-is states   | `ExportParameterPanel.stories.tsx` (+4 = 11) |
| Consistency copy doc            | `01-CONSISTENCY-COPY.md` |
| 5D-2-c prep                     | `02-5D-2-C-PREP.md` |

---

## 2. What did NOT change

| Untouched | Verification |
|---|---|
| `file:save-wav` behaviour | called identically by both paths |
| `audio:master`            | called as-is (Re-master path only) |
| Python pipeline           | zero changes |
| Export format / dither    | not implemented (5D-2-c/d) |
| Real-time DSP             | not implemented |
| Rust EQ/comp/limiter      | none created |
| ResultPage / V1           | untouched (existing export path intact) |
| DSP chain (`loui-dsp`)    | `cargo test` 31/31 |

---

## 3. Two-path UI

```
┌─ Export ────────────────────────────────────┐
│  [Changes 2 renderable]  [Skip 1 staged-only]│
│  Applies: targetLufs, targetTp               │
│  ⚠ You have unrendered changes.  Export       │
│    As-is will not include them; Re-master &   │
│    Export applies the latest changes first.   │
│  ┌────────────────┬─────────────────────────┐│
│  │ Export As-is   │ Re-master & Export      ││
│  └────────────────┴─────────────────────────┘│
│  ✓ Saved (as-is) → …  /  ✗ … failed           │
│  Export As-is saves the current rendered      │
│  master.  Re-master & Export applies the      │
│  latest parameter changes first (slower).     │
└───────────────────────────────────────────────┘
```

### Button priority

- **No changes** → Export As-is is PRIMARY (accent), Re-master disabled.
- **Changes present** → Re-master & Export is PRIMARY, Export As-is
  secondary (still available, ignores changes + warns).

### Mutual exclusion

While either export runs (`exporting`), BOTH buttons are disabled —
no concurrent renders / saves.

---

## 4. Separate state per path

The bridge tracks two independent phase machines:

| Path | State |
|---|---|
| Export As-is       | `exportAsIsPhase` / `exportAsIsError` / `lastExportAsIsPath` |
| Re-master & Export | `exportPhase` / `exportError` / `lastExportPath` |

So a failure / success in one path never clobbers the other's status
line.

---

## 5. Export As-is flow

```ts
onExportAsIs:
  if (!masterOutputPath) → error "no master to export"
  setExportAsIsPhase('exporting')
  saved = await invoke('file:save-wav', masterOutputPath)
  saved ? done(saved) : idle   // null = user cancelled
  catch → error
```

Reuses the EXACT existing `file:save-wav` copy-to-dialog flow (the same
the TopBar Export button used).  No re-render.

---

## 6. Disable / cancel handling

| Condition | Export As-is | Re-master & Export |
|---|---|---|
| No `masterOutputPath` | disabled ("No master yet") | disabled |
| No changes            | enabled (primary)          | disabled ("No changes") |
| Either exporting      | disabled                   | disabled |
| Save cancelled        | → idle, no file            | → idle, no file |
| Save / master fails   | → error, prior state kept  | → error, prior state kept |

---

## 7. Verification

| Check | Result |
|---|---|
| `pnpm typecheck`        | clean |
| `pnpm build:renderer`   | 434 KB JS / 99 KB WASM |
| `pnpm build` (main)     | esbuild OK |
| `pnpm build-storybook`  | **13 components / 88 stories** |
| `cargo test -p loui-dsp --lib` | **31/31** |
| Export As-is → file:save-wav(outputPath) | ✓ |
| Re-master & Export → audio:master → file:save-wav | ✓ |
| No outputPath → Export As-is disabled    | ✓ |
| Save cancel → idle                       | ✓ |
| ResultPage export regression             | none |

(Live save dialog / Python not exercisable in sandbox; UI states covered
by 11 export stories; both paths reuse proven channels.)

---

## 8. Next

`02-5D-2-C-PREP.md` — wire the Export panel's sampleRate / bitDepth
chips into the export override (both already MasteringOptions fields).
