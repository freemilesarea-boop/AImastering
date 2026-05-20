# M3-P-NEXT-5D-2-b — Export As-is Audit

> Where the original master WAV lives, and how to save it unchanged.

---

## 1. outputPath storage

`MasteringResult` (shared-types):

```ts
interface MasteringResult {
  outputPath: string;    // temp WAV — the master
  previewPath: string;   // temp MP3 — the preview
  // …
}
```

Stored in `audioStore.masteringResult` after the initial
`audio:master` call (MasteringPage).  `outputPath` is the rendered
master WAV; `previewPath` is its MP3 sibling.

---

## 2. outputPath vs previewPath

| | outputPath | previewPath |
|---|---|---|
| Format | WAV | MP3 320 kbps |
| Role   | delivery master | fast-listen preview |
| Used by| Export (save WAV) | `<audio>` playback |

"Export As-is" saves `outputPath` (the WAV) — the delivery file the user
expects.

---

## 3. Access in ProductPage

`ProductPageProduction` already reads `masteringResult`:

```ts
const masteringResult = useAudioStore((s) => s.masteringResult);
// masteringResult?.outputPath  ← the master WAV
```

So `outputPath` is available with no new plumbing.  It just needs to
reach the Export panel — passed down through the preview bridge
(`ProductionPreviewProvider`).

---

## 4. Existing "Export As-is" behaviour

The TopBar Export button ALREADY does Export As-is:

```ts
// ProductPage onExport (TopBar)
const onExport = useCallback(async () => {
  if (!masteringResult?.outputPath) return;
  await window.electronAPI?.invoke('file:save-wav', masteringResult.outputPath);
}, [masteringResult]);
```

5D-2-b surfaces this same action explicitly in the Export panel with
proper state (idle/exporting/done/error) and disable-on-no-output.

---

## 5. file:save-wav behaviour (unchanged)

```ts
file:save-wav(srcPath) → save dialog → fs.copyFileSync → savedPath | null
```

- WAV/MP3 filter by extension
- Returns `null` on cancel
- Throws on copy failure

No change to this handler — both Export As-is and Re-master & Export use
it identically.

---

## 6. The two paths

| Action | Source WAV | Re-render? | Speed |
|---|---|---|---|
| Export As-is       | `masteringResult.outputPath` (existing) | no  | fast |
| Re-master & Export | fresh `audio:master(override)` output   | yes | slower |

Both end in `file:save-wav(wavPath)`.

---

## 7. Plumbing plan

1. Pass `masterOutputPath` (= `masteringResult.outputPath`) into
   `ProductionPreviewProvider`.
2. Add `onExportAsIs` + `exportAsIsPhase` state to the bridge.
3. Extend `ReMasterExportInfo` with an `asIs` sub-object.
4. Render both buttons in the Export panel with separate states.

Zero new IPC, zero Python change, zero `file:save-wav` change.

---

## 8. Edge cases

| Case | Export As-is | Re-master & Export |
|---|---|---|
| No `outputPath`         | disabled | disabled |
| No changes              | enabled (= original) | disabled ("No changes") |
| Changes present         | enabled (ignores changes + warns) | enabled |
| Either in progress      | both disabled (avoid concurrent) | both disabled |
| Save cancelled          | idle, no file | idle, no file |
