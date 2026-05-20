# M3-REVISION-WORKFLOW — Result-State Audit (before)

> Where mastering results lived, and the re-render/export paths the
> revision workflow reuses.

---

## 1. Result storage (before)

| Item | Where |
|---|---|
| Queue items | `audioStore.queue: QueueItem[]` — each `{ id, filePath, fileName, status, analysis?, masteringResult?, … }` |
| Single result | `audioStore.masteringResult: MasteringResult \| null` (set by `handleViewResult` → ProductPage) |
| outputPath / previewPath / metrics | inside `masteringResult` (`outputPath`, `previewPath`, `loudnessAfter.{integratedLufs,truePeakDbtp,lra}`) |
| Edit options | `audioStore.options: MasteringOptions` (single, mutated by sliders/presets) |
| Parameter edits | `ModuleParameterStateProvider` (parameter state, ProductPage) |

**Problem:** exactly ONE `masteringResult` per source.  Re-tweaking + re-
rendering overwrote it; keeping the old version meant clearing the queue
and re-adding the file.

## 2. Re-render / export channels (reused as-is)

| Action | IPC | Returns |
|---|---|---|
| Quick preview | `audio:re-render-preview` | preview MP3 + loudness (no WAV) |
| Full master | `audio:master(src, '', options)` | **`{ outputPath, previewPath, loudnessAfter }`** — a complete revision |
| Save WAV | `file:save-wav(path)` | saved path (copy) |
| Save format | `file:save-audio(req)` | saved path (transcode) |

`audio:master` is the revision primitive — it already produces the full
(output, preview, metrics) triple.  "새 버전 만들기" and "Re-master &
Export" both call it; no DSP / Python change.

## 3. A/B compare (before)

- A (before) = `masteringResult.previewPath` (original master).
- B (after) = `previewSrcOverride` (latest quick re-render).
- Loudness compensation trims the louder side via `reRenderedLufs` vs `baseLufs`.

## 4. Clear / new file

- `clearQueue` / `reset` wiped everything.  No version history.

## 5. What the workflow adds

- `revisionGroup` in the store (one source → many `MasteringRevision`).
- First master migrates to **Revision 1** (seed effect in ProductPage).
- "새 버전 만들기" → `audio:master` with current edit options → append revision.
- Active revision drives preview source + Export As-is target + A/B "B".
- A/B: A = Revision 1 (baseline), B = active revision.
- "이 설정으로 편집" restores a revision's options (+ preset) for further edits.
