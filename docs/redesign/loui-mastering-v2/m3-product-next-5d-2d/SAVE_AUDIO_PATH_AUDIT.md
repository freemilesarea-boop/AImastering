# M3-P-NEXT-5D-2-d — Save / Transcode Path Audit

> The existing save path + ffmpeg infrastructure, before adding
> `file:save-audio`.

---

## 1. file:save-wav (UNCHANGED)

`apps/desktop/src/main/ipc/fileHandlers.ts`:

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

Pure file copy + save dialog.  **This handler is NOT modified in
5D-2-d.**  `file:save-audio` is a separate, additive channel.

---

## 2. ffmpeg infrastructure (audio-engine)

`@aimaster/audio-engine` exports the resolver + runner:

```ts
import {
  resolveFFmpegPath,    // (opts) → ffmpeg binary path
  resolveFFprobePath,
  checkFFmpeg,          // availability + version
} from '@aimaster/audio-engine';
```

- `resolveFFmpegPath(opts)` resolution order: bundled → env
  (`AIMASTER_FFMPEG`) → well-known dirs → PATH.
- The runner (`ffmpeg/runner.ts`) uses `spawn(bin, argsArray, { shell:false })`
  — safe with Unicode / spaces.  We mirror this pattern for transcoding.
- `ffmpeg-static` (devDep) provides a full ffmpeg build with
  libmp3lame + libvorbis + flac + pcm — so WAV / MP3 / FLAC / AIFF / OGG
  are all encodable.

---

## 3. ffmpeg availability

App startup runs `checkFFmpeg()` → `{ available, ffprobeAvailable,
path, version }`.  Exposed via `system:ffmpeg-status`.  `file:save-audio`
re-resolves the path per call (same resolver) and returns an error if
ffmpeg is unavailable — never crashes.

---

## 4. IPC allowlist

`preload/index.ts` `INVOKE_CHANNELS` gates every channel.  Adding
`file:save-audio` requires one line there + the main-process handler.

---

## 5. What 5D-2-d adds

| Component | File | Role |
|---|---|---|
| Transcode helper | `main/utils/audioTranscode.ts` | build ffmpeg args + spawn → temp file |
| Save handler     | `fileHandlers.ts` `file:save-audio` | dialog → copy (wav) or transcode → dest |
| IPC types        | `shared-types` SaveAudioRequest/Response | contract |
| Preload          | `preload/index.ts` | allowlist `file:save-audio` |
| Renderer client  | `engine-bridge` save-audio helper | invoke + result |
| ProductPage      | export handlers | choose save-wav (wav) vs save-audio (transcode) |

---

## 6. Safety: temp-then-copy

```
1. dialog → dest (cancel → { savedPath: null })
2. transcode source → {tmpdir}/aimaster_export_{uuid}.{ext}
3. on success: copyFileSync(temp, dest); unlink(temp)
4. on failure: error; dest never written; source untouched
```

The source WAV (the master) is never modified.  A transcode failure
leaves the user's existing files intact.

---

## 7. WAV fast path

`file:save-audio` with `format === 'wav'` AND no transcode params
(no SR/bitDepth/dither change) → falls back to a plain `copyFileSync`
(identical to `file:save-wav`).  So the common WAV case never invokes
ffmpeg.

The renderer goes further: for `format === 'wav'` it can call the
existing `file:save-wav` directly (the proven path), reserving
`file:save-audio` for transcode cases.  See `ProductPage` export
routing.

---

## 8. Rollback plan

| Failure | Fallback |
|---|---|
| ffmpeg unavailable        | `file:save-audio` returns error; UI shows "transcode unavailable — export as WAV" |
| transcode fails           | error; user can retry or pick WAV |
| `file:save-audio` broken  | renderer falls back to `file:save-wav` for WAV; non-WAV disabled |
| Need full revert          | remove the `file:save-audio` allowlist line + handler; `file:save-wav` path is untouched and keeps working |

The entire feature is additive — disabling it restores the exact 5D-2-c
behaviour (WAV-only export).
