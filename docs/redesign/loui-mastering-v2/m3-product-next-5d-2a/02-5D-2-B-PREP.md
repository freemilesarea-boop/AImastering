# M3-P-NEXT-5D-2-b — "Export As-is" Toggle (Preparation)

> Let the user save the ORIGINAL master WAV unchanged, alongside the
> Re-master & Export path.

---

## 1. Goal

5D-2-a added "Re-master & Export" (apply current overrides, re-render,
save).  Some users want the opposite: save the master exactly as it was
first rendered, ignoring any UI tweaks.

"Export As-is" = the CURRENT behaviour of the TopBar Export button
(`file:save-wav(masteringResult.outputPath)`) — but surfaced explicitly
in the Export panel next to "Re-master & Export".

---

## 2. The two actions

| Action | Override | Render | Saves |
|---|---|---|---|
| Re-master & Export | `summary.renderOverride` | yes (`audio:master`) | fresh WAV |
| Export As-is       | none                     | no                   | original `masteringResult.outputPath` |

Both end in `file:save-wav` → save dialog.

---

## 3. UI sketch

```
┌─ Export ───────────────────────────────────┐
│  Format / Sample Rate / Bit Depth / Dither  │
│  ─── Re-master & Export ────────────────────│
│  [Apply 3 changes]                          │
│  [ Re-master & Export ]                      │
│  ─── Or ────────────────────────────────────│
│  [ Export As-is ]  (original master, no      │
│                     changes applied)         │
└──────────────────────────────────────────────┘
```

When there are NO changes, "Re-master & Export" is disabled and
"Export As-is" is the natural choice (they produce the same file).

---

## 4. Implementation (small)

`ExportParameterPanel` gains an `onExportAsIs?: () => void` prop.  The
bridge wires it to:

```ts
const onExportAsIs = useCallback(async () => {
  const outputPath = masteringResult?.outputPath;
  if (!outputPath) return;
  await window.electronAPI.invoke('file:save-wav', outputPath);
}, [masteringResult]);
```

This is literally the existing TopBar Export behaviour, moved into the
panel.  No new IPC, no render.

---

## 5. Decision: keep TopBar Export?

Options:
1. Keep TopBar Export = "Export As-is" (quick access), panel has both.
2. Remove TopBar Export, make the panel the single export surface.

Recommendation: **keep TopBar Export as a quick "Export As-is"** for the
common case, with the panel offering both for power users.  Less
disruption.

---

## 6. Edge cases

| Case | Re-master & Export | Export As-is |
|---|---|---|
| No changes        | disabled            | enabled (= original) |
| Changes present   | enabled             | enabled (ignores changes) |
| Export in progress| disabled            | disabled (avoid concurrent) |
| No masteringResult| disabled            | disabled |

---

## 7. Sequencing within 5D-2-b

| PR | Scope | Risk |
|---|---|---|
| 5D-2-b-1 | `onExportAsIs` prop + panel button | Low |
| 5D-2-b-2 | Disable logic (mutual exclusion during export) | Low |
| 5D-2-b-3 | Decide TopBar Export fate | Low (UX) |

All low-risk — "Export As-is" reuses the existing copy-to-dialog flow
with zero new code paths.

---

## 8. Beyond 5D-2-b

| Item | Milestone |
|---|---|
| Wire format / SR / bit-depth into the export override | 5D-2-c |
| format / dither via `file:save-wav` extension          | 5D-2-d (save-path change) |
| Remaining 7 wired params renderable                     | M2-full |
| Real-time preview                                       | M2-full |

After 5D-2-b, the export surface offers both "apply my changes" and
"give me the original" — the complete commercial export workflow for
the four renderable parameters.
