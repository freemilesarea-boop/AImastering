# SOURCE-PREVIEW-AUDIO — why duration is 0:00 and realtime never attaches

> Symptom: enter ProductPage in source-preview mode (no master yet), the
> `<audio>` shows `0:00 / 0:00`, never fires `loadedmetadata`, so the
> analyzer session is never created and the realtime graph never attaches
> (config pushes 0, passthrough).

## 1. The source-preview URL flow (traced)

```
HomePage "조절하며 듣기" → setFile(path) + setPage('result') (no masteringResult)
ProductPage (source-preview mode, ProductPage.tsx:1136-1147):
  sourcePreviewSrc = sourceAudioPath ? toFileUrl(sourceAudioPath) : ''
  basePreviewSrc   = baselinePreview ? toFileUrl(baselinePreview) : sourcePreviewSrc
  effectiveSrc     = abMode==='before' ? basePreviewSrc : (reRenderedSrc ?? basePreviewSrc)
<audio src={effectiveSrc}>  →  toFileUrl()  →  aimaster-local://<encoded abs path>
  → main: protocol.handle('aimaster-local', …)  →  net.fetch('file://…')
  → loadedmetadata → meterReady=true → WasmAnalyzerProvider attaches session
  → useRealtimeMasteringGraph attaches the worklet node
```

`toFileUrl` (renderer/utils/fileUrl.ts) is fine — it per-segment
`encodeURIComponent`s and keeps a leading slash, round-trip-safe.

## 2. Root cause — the protocol handler dropped Range requests

`main/index.ts` (before):

```ts
protocol.registerSchemesAsPrivileged([
  { scheme: 'aimaster-local', privileges: { bypassCSP: true, supportFetchAPI: true, stream: true } },
]);
protocol.handle('aimaster-local', (request) => {
  const filePath = decodeURIComponent(request.url.slice('aimaster-local://'.length));
  return net.fetch(`file://${filePath}`);
});
```

Two problems for `<audio>` playback of the **original** file (typically a
large WAV):

1. **No `Range` forwarding.** Chromium's media pipeline issues
   `Range: bytes=0-` and expects a `206 Partial Content` response. The
   handler called `net.fetch` *without* forwarding the request's `Range`
   header, so the file came back as a single `200 OK`. For a small
   streaming MP3 (the re-render preview) Chromium tolerates this, but for a
   large WAV it frequently **never reaches `loadedmetadata`** → duration
   `0:00`, and the analyzer/realtime graph never attaches.

2. **Scheme not `standard`.** Without `standard: true`, media Range
   handling and consistent URL parsing aren't guaranteed, and the
   string-slice path decode is brittle for spaces / Korean / Windows
   drive letters.

This is why the re-render preview (small MP3) seemed to play but the
source preview (original WAV) stuck at 0:00.

## 3. Fix

`main/index.ts` (after):

```ts
protocol.registerSchemesAsPrivileged([
  { scheme: 'aimaster-local',
    privileges: { standard: true, secure: true, bypassCSP: true, supportFetchAPI: true, stream: true } },
]);
protocol.handle('aimaster-local', (request) => {
  // robust decode via URL API (spaces / Korean / Windows drive)
  const u = new URL(request.url);
  const absPath = decodeURIComponent(u.host ? `/${u.host}${u.pathname}` : u.pathname);
  const fileUrl = pathToFileURL(absPath).toString();   // correct file:// rebuild
  const range = request.headers.get('Range') ?? request.headers.get('range');
  return net.fetch(fileUrl, range ? { headers: { Range: range } } : undefined);
});
```

- **`Range` forwarded** → `net.fetch('file://…')` returns `206` → Chromium
  loads metadata for large WAVs → `loadedmetadata` fires → session +
  realtime graph attach → config push → process → **active**.
- **`standard: true` + `secure: true`** → reliable media range behaviour
  and consistent URL parsing.
- **`pathToFileURL`** → spaces, Korean, and Windows drive letters round-trip
  correctly.

## 4. Honest diagnostics (no faking)

The `<audio>` element now reports load health via `onError` / `onCanPlay`
/ `onLoadedMetadata`; the realtime debug panel shows `audio src`
(readyState: nothing/metadata/current/future/enough) and a specific
`audio err` (network / decode / unsupported source / file-URL-invalid).
When the source can't load, the realtime status honestly stays `waiting`
and the panel names the reason — never a fake duration / active / metric.

## 5. Format note

`<audio>` decodes WAV (PCM 16/24/32f), MP3, FLAC (Chromium), and AAC. OGG
depends on the platform. The original upload is normally WAV/MP3/FLAC, all
playable. Range support is what was missing, not codec support.
