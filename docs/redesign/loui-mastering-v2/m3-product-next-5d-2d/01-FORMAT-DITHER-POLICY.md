# M3-P-NEXT-5D-2-d — Format / Dither Policy

> The exact rules for how each format + dither combination is handled.

---

## 1. Format support matrix

| format | encoder (ffmpeg) | bitDepth | dither | notes |
|---|---|---|---|---|
| wav  | pcm_s16le / pcm_s24le / pcm_f32le | 16/24/32 | yes (16/24) | default container |
| aiff | pcm_s16be / pcm_s24be / pcm_f32be | 16/24/32 | yes (16/24) | big-endian |
| flac | flac (-sample_fmt s16/s32)        | 16/24 (32→24) | yes (≤24) | lossless; max 24-bit |
| mp3  | libmp3lame -b:a 320k              | n/a | n/a | lossy |
| ogg  | libvorbis -q:a 6                  | n/a | n/a | lossy |

All five are encodable by ffmpeg-static.  A missing-encoder error (rare)
surfaces as a transcode failure with the source intact.

---

## 2. Dither rules (honest)

ffmpeg applies dither during integer bit-depth reduction via
`aresample=dither_method=X`.  This is real, tested functionality.

| UI dither | ffmpeg method | applied when |
|---|---|---|
| none    | (none)     | never |
| tpdf    | triangular | reducing to 16/24-bit integer PCM |
| shaped  | shibata    | reducing to 16/24-bit integer PCM (noise-shaped) |

**Dither is ignored (with a warning) when:**
- format is lossy (mp3 / ogg)
- bitDepth is 32-bit float
- no bit-depth reduction occurs

We never fake dither.  `shaped` → ffmpeg's `shibata` (a genuine
noise-shaping curve).  If a build lacks it, the transcode fails honestly
rather than silently doing nothing.

---

## 3. Quality vs format responsibility

| Stage | Applies |
|---|---|
| Master (audio:master) | loudness/ceiling/width/gain + sampleRate + bitDepth |
| Save (file:save-audio) | format container + dither (on reduction) |

- **Re-master & Export**: WAV already at target SR/bitDepth → save-audio
  changes the container.  dither acts only if save-audio further reduces
  depth (usually a no-op, warned).
- **Export As-is**: source is the master WAV → save-audio changes the
  container only, preserving SR/bitDepth (dither none).

---

## 4. Lossy + quality UI

When MP3 / OGG is selected:
- bitDepth + dither are labelled "not applicable"
- the panel shows "⚠ Dither ignored for MP3/OGG"
- the Quality badge omits bit depth ("MP3 · 48 kHz")

---

## 5. FLAC bit-depth cap

FLAC is integer, max 24-bit.  Selecting 32-bit float + FLAC:
- exports at 24-bit
- warning "FLAC max is 24-bit; exported at 24-bit"

---

## 6. AIFF / OGG support note

Both are standard ffmpeg formats (pcm_*be for AIFF, libvorbis for OGG).
ffmpeg-static includes them.  They're enabled; a transcode failure (e.g.
an unusual build) is handled like any other — error + source intact.

---

## 7. Validation chain

1. **UI** — only enum values selectable (format / dither / SR / bitDepth)
2. **Renderer** — routes WAV → save-wav, else save-audio with the spec
3. **Handler** — validates format filter exists; `needsTranscode` gates
   the ffmpeg path
4. **buildTranscodePlan** — applies format-specific applicability +
   emits warnings
5. **ffmpeg** — the ultimate validator; failure → typed error response

---

## 8. What we deliberately do NOT do

- No custom DSP dither (we use ffmpeg's)
- No format-specific metadata embedding (tags) — future
- No multi-file / batch transcode — future
- No real-time format preview — the preview is always MP3
- No Python pipeline involvement in format/dither
