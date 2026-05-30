# M3-P-NEXT-5C — Preview Re-render IPC Contract

> `audio:re-render-preview` — renderer ⇄ main ⇄ Python (reused pipeline).

---

## 1. Channel

```
'audio:re-render-preview'   (invoke — request/response)
```

Allowlisted in `preload/index.ts` `INVOKE_CHANNELS`.  The channel is
always registered; only the product-layout flag gates the renderer
caller, so a flag-off app never invokes it.

---

## 2. Request

```ts
interface PreviewRenderRequest {
  requestId: number;          // monotonic — latest-wins / stale rejection
  sourceAudioPath: string;    // ORIGINAL input file (not the preview)
  options: MasteringOptions;  // base merged with the override
  changedKeys: string[];      // which option keys changed (informational)
}
```

`options` is the FULL merged options (base + override), because the
Python pipeline needs complete options, not a delta.

`sourceAudioPath` is the original source audio (`audioStore.selectedFile`),
NOT the current preview MP3 — we re-master from source, not from a
lossy preview.

---

## 3. Response

```ts
type PreviewRenderResponse = PreviewRenderSuccess | PreviewRenderFailure;

interface PreviewRenderSuccess {
  requestId: number;
  ok: true;
  previewPath: string;        // fresh preview MP3
  metrics?: { integratedLufs?: number; truePeakDbtp?: number };
  durationMs: number;
}

interface PreviewRenderFailure {
  requestId: number;
  ok: false;
  error: string;
}
```

The handler **returns** a typed response rather than throwing — so the
renderer's latest-wins controller handles success / failure uniformly.
`requestId` is echoed back for stale-response matching.

---

## 4. Main handler

`audio:re-render-preview` in `audioHandlers.ts` is a **thin wrapper over
the existing `masterFile`** — the same function `audio:master` calls:

```ts
ipc.handle('audio:re-render-preview', async (_e, request): Promise<PreviewRenderResponse> => {
  const { requestId, sourceAudioPath, options } = request;
  if (!sourceAudioPath || !options)
    return { requestId, ok: false, error: 'invalid request payload' };
  const t0 = Date.now();
  try {
    assertTmpWritable();
    const b = getBridge();
    const wavTempPath = resolveOutputPath(sourceAudioPath, '.wav', { style: options.style, targetLufs: options.targetLufs });
    const mp3Fallback = internalTempPath('_preview.mp3');
    const result = await masterFile(b, sourceAudioPath, wavTempPath, options, {});
    return {
      requestId, ok: true,
      previewPath: result.previewPath || mp3Fallback,
      metrics: { /* from result.loudnessAfter */ },
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return { requestId, ok: false, error: (err as Error).message };
  }
});
```

### Why this is safe

- **No Python change** — `masterFile` is the proven mastering function.
  We invoke it with overridden `options`; Python honours `targetLufs`
  natively (it already did in the initial master).
- **No `audio:master` change** — separate channel, separate handler.
- **Reuses temp-path + write-check helpers** — same disk-safety as the
  initial master.
- **Always returns** — no uncaught throw can crash the renderer's
  controller.

---

## 5. Data flow

```
ProductionPreviewControl (renderer)
  buildPreviewOverride(stagedPatch) → { targetLufs: -10 }
  mergeOptions(baseOptions, override) → full MasteringOptions
  controller.request({ requestId, sourceAudioPath, options, changedKeys })
        │  (debounce 600ms, latest-wins)
        ▼
  IpcPreviewRenderTransport.render(request)
        │  window.electronAPI.invoke('audio:re-render-preview', request)
        ▼  [main process]
  audio:re-render-preview handler
        │  masterFile(bridge, sourceAudioPath, wavTemp, options)  ← EXISTING Python
        ▼
  { ok: true, previewPath, metrics, durationMs }
        │  (response — requestId checked for staleness)
        ▼  [renderer]
  controller.onSuccess(previewPath)
        │
        ▼
  ProductPageProduction.onPreviewRendered(previewPath)
        audio.src = toFileUrl(previewPath)  (position preserved)
```

---

## 6. Cancellation / staleness

The IPC itself isn't cancellable mid-render (the Python process runs to
completion).  Staleness is handled **renderer-side**:

- Each request carries a monotonic `requestId`.
- The controller tracks `latestRequestId`.
- When a response arrives, if `response.requestId !== latestRequestId`,
  it's dropped (a newer request superseded it).

So a slow render whose result arrives after a newer request fired is
silently discarded — the user always sees the latest-requested preview.

A future optimisation (5D): pass an `AbortSignal` to `masterFile` to
actually cancel in-flight Python renders (the bridge already supports
`signal` — see `getBridge` setup).

---

## 7. Error taxonomy

| Failure | `error` string | UI |
|---|---|---|
| Invalid payload          | `'invalid request payload'`     | button stays, no swap |
| Temp not writable        | (assertTmpWritable throw msg)   | error state |
| Python bridge failure    | `masterFile` error message      | error state, prev preview kept |
| electronAPI unavailable  | `'electronAPI unavailable'`     | error state |

All surface as `phase: 'error'` in the controller → "Render failed"
in `LouiPreviewControl`.  The previous preview keeps playing.

---

## 8. Verification limits

This environment has no Python audio engine binary, so a live
`audio:re-render-preview` round-trip wasn't executed.  Confidence rests
on:

1. The handler reuses `masterFile` — the exact, proven function the
   initial master uses (only the trigger differs).
2. The renderer loop (build → request → debounce → latest-wins →
   success/failure → swap) is fully exercised by the
   `Product / Preview Render` stories with a mock transport.
3. `tsc` validates the request/response types end-to-end (shared-types
   → renderer client → main handler).
4. `esbuild` compiles the main handler clean.
