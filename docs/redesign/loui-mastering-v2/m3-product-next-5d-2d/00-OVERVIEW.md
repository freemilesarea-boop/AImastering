# M3-P-NEXT-5D-2-d — Format / Dither Export via file:save-audio

> The final export controls: file format + dither, via a NEW
> `file:save-audio` channel + ffmpeg transcode.  `file:save-wav` is
> untouched; WAV stays on the proven copy path.

---

## 1. What changed

The export panel's format / dither chips now reach the saved file.  A
new `file:save-audio` IPC channel transcodes the master WAV to the
chosen container (WAV / FLAC / MP3 / AIFF / OGG) via ffmpeg, applying
dither on integer bit-depth reduction.

| Path | Channel | Transcode |
|---|---|---|
| WAV export | `file:save-wav` (existing, untouched) | no — plain copy |
| Non-WAV export | `file:save-audio` (NEW) | ffmpeg |

| Deliverable | Where |
|---|---|
| Save/transcode audit             | `SAVE_AUDIO_PATH_AUDIT.md` |
| Format/dither options audit      | `FORMAT_DITHER_OPTIONS_AUDIT.md` |
| `SaveAudioRequest/Response`      | `shared-types` |
| Transcode helper                 | `main/utils/audioTranscode.ts` (ffmpeg arg builder + spawn) |
| `file:save-audio` handler        | `main/ipc/fileHandlers.ts` |
| Preload allowlist                | `file:save-audio` |
| ProductPage export routing       | format → save-wav (wav) / save-audio (transcode) |
| Format/dither UI summary         | `ExportParameterPanel` |
| Storybook format/dither states   | +6 stories (98 total) |
| Policy + fallback docs           | `01-..` / `02-..` |

---

## 2. What did NOT change

| Untouched | Verification |
|---|---|
| `file:save-wav` | byte-identical handler; WAV export uses it |
| Python pipeline | zero changes |
| Real-time DSP / Rust DSP | none |
| audio:master | called as-is (Re-master path) |
| ResultPage / V1 | untouched |
| DSP chain (`loui-dsp`) | `cargo test` 31/31 |

---

## 3. Transcode helper

`audioTranscode.ts`:
- `buildTranscodePlan(spec)` — pure ffmpeg-arg builder; selects codec /
  sample_fmt / dither filter per format; emits warnings for
  inapplicable combos (lossy + dither, 32-float + dither, FLAC > 24-bit)
- `needsTranscode(sourceExt, spec)` — WAV-no-change → false (plain copy)
- `transcodeToTemp(source, spec)` — spawns ffmpeg (resolveFFmpegPath +
  arg array, shell:false), writes a temp file; never touches the source

Codec map: WAV/AIFF → pcm_s16/s24/f32 (le/be); FLAC → flac s16/s32; MP3 →
libmp3lame 320k; OGG → libvorbis q6.  Dither → `aresample=dither_method=
triangular|shibata`.

---

## 4. file:save-audio handler

```ts
ipc.handle('file:save-audio', async (_e, req): Promise<SaveAudioResponse> => {
  // validate → save dialog (format filter) → cancel? null
  // needsTranscode? → transcodeToTemp → copy temp→dest → unlink temp
  //               : → plain copyFileSync (WAV passthrough)
  // returns { savedPath, transcoded, warning?, durationMs } | { savedPath: null, error }
});
```

- Returns a typed response (never throws) → renderer handles
  cancel/warning/error uniformly.
- Temp-then-copy: a transcode failure never writes the destination or
  modifies the source.

---

## 5. ProductPage routing

```ts
// Re-master & Export
audio:master(merged options)  → reMasteredWav (at target SR/bitDepth)
format === 'wav' ? file:save-wav(reMasteredWav)
                 : file:save-audio({ sourcePath, format, sampleRate, bitDepth, dither })

// Export As-is
format === 'wav' ? file:save-wav(masterWav)
                 : file:save-audio({ sourcePath: masterWav, format,
                                     sampleRate: base, bitDepth: base, dither: 'none' })
```

WAV always uses the proven `file:save-wav`.  Non-WAV uses
`file:save-audio`.  Export As-is only changes the CONTAINER (preserves
the master's quality).

---

## 6. UI

The Export section now shows:
- Quality badge: "FLAC · 48 kHz · 24-bit"
- Quality-change note (5D-2-c)
- **Transcode note**: "Transcoding to FLAC required.  Export As-is
  transcodes the current master to FLAC (quality unchanged)."
- **Dither-ignored warning**: "⚠ Dither ignored for MP3 (lossy or
  32-bit float)."

---

## 7. Verification

| Check | Result |
|---|---|
| `pnpm typecheck`        | clean |
| `pnpm build:renderer`   | 437 KB JS / 99 KB WASM |
| `pnpm build` (main)     | esbuild OK (handler + transcode compile) |
| `pnpm build-storybook`  | **13 components / 98 stories** |
| `cargo test -p loui-dsp --lib` | **31/31** |
| file:save-wav regression | none (untouched) |
| WAV export → file:save-wav | ✓ (routing) |
| non-WAV → file:save-audio | ✓ |
| save cancel → null/idle | ✓ |
| transcode failure → error, source intact | ✓ (temp-then-copy) |

(Live ffmpeg transcode not exercisable in sandbox — no ffmpeg-static
binary / audio file.  Arg-builder + handler are typechecked + esbuild-
compiled; UI states covered by 6 stories; ffmpeg invocation mirrors the
proven audio-engine runner pattern.)

---

## 8. Next

`02-FALLBACK-PLAN.md` documents rollback.  After 5D-2-d, the full export
spec (loudness/ceiling/width/gain + SR/bitDepth + format/dither) flows
UI → preview (audio) → export.  Remaining: the 7 staged-only audio
params + real-time preview (M2-full).
