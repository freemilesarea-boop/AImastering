# M3-P-NEXT-5D-2-a — Export Path Audit

> The existing master → export flow, before reusing the preview override.

---

## 1. Where export buttons connect

| Entry point | Handler | Effect |
|---|---|---|
| ResultPage `SaveButtons` (WAV)  | `file:save-wav(masteringResult.outputPath)` | save-dialog → copy temp WAV |
| ResultPage `SaveButtons` (MP3)  | `file:save-wav(masteringResult.previewPath)` | save-dialog → copy temp MP3 |
| ProductPage TopBar `Export`     | `file:save-wav(masteringResult.outputPath)` | save-dialog → copy temp WAV |
| ExportParameterPanel (slide-over)| none (UI shell, "coming soon")              | — |

**Key finding**: every export entry today just COPIES an already-rendered
temp file to a user location.  None re-renders.  So UI parameter changes
don't reach the exported file.

---

## 2. The master call (initial render)

`MasteringPage` invokes:

```ts
const result = await window.electronAPI.invoke(
  'audio:master',
  selectedFile,          // source audio path
  '',                    // outputPath ignored — main generates temp paths
  {
    style, targetLufs, targetTp, sampleRate, bitDepth, applyAiCorrections,
  } as MasteringOptions,
) as MasteringResult;
setMasteringResult(result);
```

`MasteringResult` includes:
- `outputPath` — temp WAV (the master)
- `previewPath` — temp MP3 (the preview)
- `loudnessAfter`, `analysisReport`, etc.

So `audio:master` ALREADY accepts a full `MasteringOptions` and produces
both a WAV + MP3.  This is the channel the preview re-render (5C) reuses
via `audio:re-render-preview`, and the channel "Re-master & Export" will
reuse directly.

---

## 3. The save handler

`file:save-wav(srcPath)`:

```ts
ipc.handle('file:save-wav', async (_e, srcPath) => {
  const isWav = path.extname(srcPath) === '.wav';
  const result = await dialog.showSaveDialog(win, {
    defaultPath: path.basename(srcPath),
    filters: isWav ? [WAV] : [MP3],
  });
  if (result.canceled) return null;
  fs.copyFileSync(srcPath, result.filePath);
  return result.filePath;
});
```

- Shows a native save dialog (WAV or MP3 filter by extension)
- Copies the temp file to the chosen path
- Returns the saved path, or `null` if cancelled
- Throws on copy failure (recorded as an `export` failure)

No format conversion, no re-render — pure file copy.

---

## 4. MasteringOptions → final file

The Python pipeline applies the full `MasteringOptions` (style /
targetLufs / targetTp / sampleRate / bitDepth / applyAiCorrections, plus
the v3 extras stereoWidth / outputGainDb / limiterStrength /
saturationAmount) when it renders.  So the final WAV already reflects
whatever options were passed to `audio:master`.

This means: to make an exported file reflect the user's parameter
changes, we just need to call `audio:master` again with the merged
override options — exactly the preview re-render does, but we keep the
WAV instead of the MP3.

---

## 5. Preview MP3 vs final WAV

| | Preview | Final export |
|---|---|---|
| Format | MP3 320 kbps | WAV (or MP3 via save dialog) |
| Source | `result.previewPath` | `result.outputPath` |
| Purpose | fast listening | delivery file |
| Render | `audio:re-render-preview` (5C) | `audio:master` (re-master & export) |

Both come from the SAME `masterFile` render — the preview is just the
MP3 sibling of the WAV.  So re-mastering for export produces a WAV whose
audio matches the re-rendered preview MP3 (same options → same DSP).

---

## 6. Filename / location policy

- Temp files: `{tmpdir}/{sanitized_basename}_master{_style}{_LUFS}.wav`
  (+ numeric suffix on collision).  See `resolveOutputPath`.
- User save location: chosen via the native save dialog; default name =
  the temp file's basename.
- No change needed — "Re-master & Export" produces a new temp WAV
  (fresh `resolveOutputPath`) then hands it to the same save dialog.

---

## 7. Reuse plan (Option A — chosen)

```
Re-master & Export:
  1. override = summarizePending(state, lastRendered, base).renderOverride
  2. options  = mergeOptions(base, override)
  3. result   = await invoke('audio:master', sourceAudioPath, '', options)   ← EXISTING
  4. saved    = await invoke('file:save-wav', result.outputPath)              ← EXISTING
```

- Zero new IPC channels
- Zero Python pipeline change
- Zero save-path rewrite
- The override is the SAME structure the preview uses (`renderOverride`),
  so preview and export stay consistent by construction.

Option B (new `audio:re-master-export` channel) was rejected — it would
duplicate `audio:master`'s logic for no benefit.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Re-master latency           | reuse `audio:progress` events; show "exporting…" |
| Export ≠ preview            | both derive from `summary.renderOverride` |
| Failure leaves no file      | `file:save-wav` returns null/throws — keep prior state, show error |
| Concurrent master + preview | `audio:master` + `audio:re-render-preview` share the Python bridge; serialise via the existing bridge queue (single process) |
| Staged-only params lost     | shown as "not applied to export" in the UI — honest |

No regression risk to `audio:master` (we call it as-is) or `file:save-wav`.
