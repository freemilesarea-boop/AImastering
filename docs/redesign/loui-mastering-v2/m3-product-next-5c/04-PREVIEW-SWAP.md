# M3-P-NEXT-5C — Audio Preview Swap

> Replacing the playing preview with a freshly-rendered file, without
> losing position or breaking the analyzer.

---

## 1. The swap

When a render succeeds, `ProductPageProduction.onPreviewRendered`
swaps the `<audio>` source:

```ts
const onPreviewRendered = useCallback((newPreviewPath: string) => {
  const a = audioRef.current;
  const wasPlaying = a ? !a.paused : false;
  const t = a ? a.currentTime : 0;
  setPreviewSrcOverride(toFileUrl(newPreviewPath));   // React-controlled src
  if (!a) return;
  const restore = () => {
    try { a.currentTime = t; } catch {}
    if (wasPlaying) void a.play();
    a.removeEventListener('loadedmetadata', restore);
  };
  a.addEventListener('loadedmetadata', restore);
}, []);
```

Steps:
1. Capture current `currentTime` + play/pause state.
2. Set `previewSrcOverride` state → React updates `<audio src>`.
3. On `loadedmetadata` (new file ready): restore position, resume if was
   playing, detach the one-shot listener.

---

## 2. React-controlled source

The audio element's `src` is state-driven, not imperative:

```tsx
const basePreviewSrc = masteringResult?.previewPath ? toFileUrl(...) : '';
const previewSrc = previewSrcOverride ?? basePreviewSrc;
// …
<audio src={previewSrc || undefined} … />
```

`previewSrcOverride` starts `null` (preview = the original master).
After a re-render it points at the new file.  Using state (not
imperative `a.src = …`) avoids React clobbering the src on the next
render.

---

## 3. Position preservation

The new preview is a re-master of the SAME source, so its duration is
(near-)identical to the previous preview.  Restoring `currentTime`
keeps the listener at the same musical position across the swap.

`try/catch` guards the assignment — if the new file's duration is
fractionally shorter, setting `currentTime` past the end would throw;
we swallow it and start from wherever the browser clamps.

---

## 4. Analyzer reconnection

The V2 analyzer (when the WASM flag is on) attaches to the audio element
via `WasmAnalyzerProvider` → `attachMediaElement`.  The provider keys
its session on the element + `active` (playing) state, NOT on the `src`.

So swapping `src` does NOT tear down the analyzer session — the same
`MediaElementAudioSourceNode` keeps feeding the analyzer from the new
audio buffer.  No reconnection needed.

> Caveat: if a future change recreates the `<audio>` element on swap
> (rather than just changing its `src`), the analyzer WOULD need
> reattachment.  We deliberately keep the same element + change `src`
> to avoid that.

---

## 5. Failure handling

On a render failure, `onPreviewRendered` is **never called** — the
controller's `onError` fires instead, setting the error state.  The
`previewSrcOverride` stays at its last value, so:

- If a prior render succeeded → that preview keeps playing.
- If no render has succeeded → the original master preview keeps
  playing.

The user never ends up with a broken / silent player due to a failed
render.

---

## 6. Edge cases

| Case | Behaviour |
|---|---|
| Swap while paused           | New src loads; stays paused at restored position |
| Swap while playing          | New src loads; resumes playing at restored position |
| Swap mid-buffering          | `loadedmetadata` fires when ready; restore then |
| New file fails to load      | `<audio onError>` fires (existing handler logs); old buffer may persist |
| Rapid successful swaps      | Controller's latest-wins ensures only the final render swaps |

---

## 7. Why not gapless / crossfade

A gapless or crossfaded swap would need two audio elements + Web Audio
scheduling.  For an explicit "Update Preview" action (user expects a
brief reload), the simple single-element swap is adequate and avoids
doubling the analyzer attach complexity.

Gapless swap is a 5D+ polish item if user testing shows the reload is
jarring.

---

## 8. State surfaced to the user

`LouiPreviewControl` reflects the swap lifecycle:

| Controller phase | UI text |
|---|---|
| `pending`   | "Pending changes — update to hear them" |
| `rendering` | "Re-rendering preview…" (animated dot) |
| `updated`   | "Preview updated · HH:MM:SS" |
| `error`     | "Render failed · {message}" |

The "updated" timestamp gives the user confidence the swap happened
even if the audible difference is subtle.
