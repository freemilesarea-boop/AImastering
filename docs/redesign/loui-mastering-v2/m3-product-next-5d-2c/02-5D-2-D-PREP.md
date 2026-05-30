# M3-P-NEXT-5D-2-d — Format / Dither (Preparation)

> The last export controls — file format + dither.  Higher risk: they
> need the save path to encode/convert, not just copy.

---

## 1. Why these are different

sampleRate / bitDepth (5D-2-c) are `MasteringOptions` fields the Python
pipeline already honours — re-mastering with them Just Works.

format / dither are NOT MasteringOptions fields:
- **format** (wav/flac/mp3/aiff/ogg) — changes the OUTPUT CONTAINER.
  The current `file:save-wav` copies a temp file as-is; it doesn't
  transcode.  Producing FLAC/AIFF/OGG needs an encode step.
- **dither** — applies at bit-depth reduction.  EngineSchema has a
  `dither` module but no adapter implements it (status `pending`).

---

## 2. Format — two implementation options

### Option A — ffmpeg transcode in the save handler

`file:save-wav` (or a new `file:save-audio`) gains a format param:

```ts
file:save-audio(srcWavPath, { format, sampleRate, bitDepth }) → savedPath
```

The main process runs ffmpeg (already bundled — `@ffmpeg-installer`) to
transcode the temp WAV to the chosen format at save time.

Pros: no Python change; ffmpeg already present.
Cons: touches the save path (the brief gated this carefully).

### Option B — Python renders the chosen format

Pass `format` through `MasteringOptions` (new field) → the Python
pipeline writes the chosen format directly.

Pros: single render produces the final format.
Cons: Python pipeline change (the brief discourages large changes).

**Recommendation**: Option A (ffmpeg transcode at save) — keeps Python
untouched, isolates the change to a new save handler.

---

## 3. Dither — needs the engine

Dither applies during bit-depth reduction (e.g. 32→16).  Correct dither
requires the render stage to know the target bit-depth + dither mode.
Two paths:
- ffmpeg's `aresample` with `dither_method` (if Option A transcode)
- the EngineSchema `dither` module (M2-full)

For 5D-2-d, if Option A is taken, ffmpeg's dither covers the common
cases (TPDF / shaped) without engine work.

---

## 4. The exportField pattern extends cleanly

format / dither would get `exportField` markers like sampleRate/bitDepth,
but their MasteringOptions targets don't exist yet.  So 5D-2-d also:
1. Adds `format` (+ optional `dither`) to a new export descriptor type
   (not MasteringOptions — a render-stage descriptor).
2. Extends `buildExportOverride` to emit that descriptor.
3. Wires the descriptor into the new `file:save-audio` handler.

---

## 5. Risk register

| Item | Risk | Mitigation |
|---|---|---|
| New save handler (`file:save-audio`) | Med | keep `file:save-wav` intact; add alongside |
| ffmpeg transcode failures | Med | fall back to WAV + warn |
| Dither correctness | Med | use ffmpeg's tested dither; document limitations |
| format affects file extension / dialog filters | Low | derive filters from format |
| Python pipeline | None (Option A) | no change |

---

## 6. Sequencing

| PR | Scope | Risk |
|---|---|---|
| 5D-2-d-1 | `file:save-audio` handler (ffmpeg transcode WAV→format) | Med |
| 5D-2-d-2 | format `exportField` + descriptor + override emit | Low |
| 5D-2-d-3 | dither via ffmpeg dither_method | Med |
| 5D-2-d-4 | Export panel format/dither wiring + confirm line | Low |

5D-2-d is the FIRST export work that touches the save path — gate it
carefully, keep `file:save-wav` as the proven fallback.

---

## 7. After 5D-2-d

The full export workflow:
- loudness / ceiling / width / output gain (audio) — 5C / 5D-1
- sample-rate / bit-depth (quality) — 5D-2-c
- format / dither (container) — 5D-2-d

…all flow UI → preview (audio only) → export, with Export As-is for the
unchanged master.  The remaining 7 audio params + real-time preview are
M2-full.
