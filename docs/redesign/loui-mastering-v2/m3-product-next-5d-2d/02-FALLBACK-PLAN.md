# M3-P-NEXT-5D-2-d — Fallback / Rollback Plan

> How the new transcode export degrades safely, and how to revert it
> entirely if needed.

---

## 1. Design for safe degradation

The whole feature is **additive**:
- `file:save-wav` is untouched — WAV export works exactly as before.
- `file:save-audio` is a new, separate channel.
- Disabling `file:save-audio` (remove the allowlist line) leaves WAV
  export fully functional; non-WAV simply becomes unavailable.

So there is no "broken state" — at worst, the app reverts to WAV-only
export (the 5D-2-c behaviour).

---

## 2. Runtime degradation ladder

| Failure | Behaviour | User sees |
|---|---|---|
| ffmpeg unavailable | `file:save-audio` returns `{ error }` | "Export failed · ffmpeg failed to start" → can pick WAV |
| Unknown encoder    | transcode error                       | "ffmpeg exited …: Unknown encoder" |
| Transcode timeout  | process killed, error                 | "ffmpeg transcode timed out" |
| Bad source         | transcode error                       | error message; source intact |
| Save dialog cancel | `{ savedPath: null }`                 | returns to idle, no file |
| Destination unwritable | copy error                         | error; temp cleaned up |

In every case the SOURCE master WAV is untouched and the user can fall
back to WAV export (`file:save-wav`).

---

## 3. Temp-then-copy guarantee

```
transcode source → {tmp}.{ext}    (source never written)
on success: copy {tmp} → dest; unlink {tmp}
on failure: error; dest never written; {tmp} cleaned in finally
```

A failed transcode can never produce a partial / corrupt destination
file, because the destination is only written after a successful
transcode completes.

---

## 4. WAV fast path

For `format === 'wav'` the renderer routes to `file:save-wav` (not
`file:save-audio`).  Even within `file:save-audio`, a WAV-no-change
request uses `copyFileSync` (no ffmpeg).  So the most common export
never depends on ffmpeg transcoding.

---

## 5. Full revert procedure

If the transcode feature must be removed:

1. **Renderer**: route all exports to `file:save-wav` (drop the
   `exportFormat !== 'wav'` branch in ProductPage's two export
   handlers).  Non-WAV formats become no-ops / disabled.
2. **Preload**: remove `'file:save-audio'` from `INVOKE_CHANNELS`.
3. **Main**: optionally remove the `file:save-audio` handler +
   `audioTranscode.ts` (or leave them dormant — they're never invoked
   once the channel is delisted).

`file:save-wav`, `audio:master`, the Python pipeline, and the preview
loop are all untouched by this revert.

---

## 6. Feature-flag option (future)

If transcode stability becomes a concern in the field, gate the non-WAV
formats behind a runtime flag:

```ts
const TRANSCODE_ENABLED = window.__LOUI_TRANSCODE__ === true
  || import.meta.env?.VITE_LOUI_TRANSCODE === 'true';
// Export panel shows only WAV when disabled.
```

Not implemented in 5D-2-d (the temp-then-copy + typed-error design is
already safe), but the seam is documented for a one-line gate if needed.

---

## 7. Monitoring

`file:save-audio` failures are recorded via `recordFailure('export', …)`
— the same ring buffer the support bundle reads.  So field failures are
diagnosable without new telemetry.

---

## 8. Confidence summary

| Property | Guaranteed by |
|---|---|
| WAV export never regresses        | `file:save-wav` untouched + routing |
| Source never corrupted            | temp-then-copy |
| No partial destination files      | copy only after successful transcode |
| Failures are visible, not silent  | typed `{ error }` + recordFailure |
| One-line disable                  | remove allowlist entry |
| Full revert                       | three small edits, no pipeline touch |

After 5D-2-d, the export workflow is commercial-grade (multi-format,
quality, dither) while remaining as safe to roll back as it was to roll
out.
