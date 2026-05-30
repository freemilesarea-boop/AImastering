# M3-P-NEXT-5D-2-d — Format / Dither Options Audit

> The export panel's format + dither params, and the honest policy for
> applying them via ffmpeg.

---

## 1. Export panel parameters

| id | values | default |
|---|---|---|
| `format` | wav / flac / mp3 / aiff / ogg | wav |
| `dither` | none / tpdf / shaped | tpdf |

(Confirmed from module-parameter-definitions.ts.)

---

## 2. Format → ffmpeg codec

| format | ffmpeg codec | bitDepth applies? | dither applies? |
|---|---|---|---|
| wav  | pcm_s16le / pcm_s24le / pcm_f32le | yes (16/24/32) | yes (on 16/24 reduction) |
| aiff | pcm_s16be / pcm_s24be / pcm_f32be | yes | yes |
| flac | flac (-sample_fmt s16 / s32)      | yes (16/24; 32→24) | yes |
| mp3  | libmp3lame -b:a 320k              | **no** (lossy) | **no** |
| ogg  | libvorbis -q:a 6                  | **no** (lossy) | **no** |

ffmpeg-static includes libmp3lame + libvorbis + flac, so all five
encode.  Transcode failure (missing codec / bad input) → error, source
preserved.

---

## 3. Dither — honest policy

ffmpeg applies dither during integer bit-depth reduction via
`-af aresample=dither_method=X`.  This is REAL, tested ffmpeg
functionality — not a fake implementation.

| UI value | ffmpeg dither_method | When meaningful |
|---|---|---|
| none    | (no filter)   | — |
| tpdf    | triangular    | reducing to 16/24-bit integer PCM |
| shaped  | shibata       | reducing to 16/24-bit integer PCM (noise-shaped) |

Dither is **ignored with a warning** when:
- format is lossy (mp3 / ogg) — no quantisation step we control
- bitDepth is 32-bit float — no quantisation
- no bit-depth reduction occurs (source already at target depth)

Per the brief ("잘 모르면 가짜 dither 구현하지 말 것"): we only claim
dither when ffmpeg actually applies it (integer PCM reduction).  shaped
maps to ffmpeg's `shibata` (a real noise-shaping curve); if a future
ffmpeg lacks it, the transcode error surfaces honestly.

---

## 4. bitDepth × format interaction

| format | 16 | 24 | 32 |
|---|---|---|---|
| wav / aiff | pcm_s16 | pcm_s24 | pcm_f32 (float) |
| flac       | s16 | s32 (24-bit data) | s32 (capped, 24-bit; warn "FLAC max 24-bit") |
| mp3 / ogg  | n/a | n/a | n/a (lossy — bitDepth ignored + warn) |

---

## 5. Responsibility split (with 5D-2-c)

| Stage | Applies |
|---|---|
| Master (audio:master, 5D-2-c) | targetLufs / targetTp / stereoWidth / outputGain + sampleRate + bitDepth |
| Save (file:save-audio, 5D-2-d) | FORMAT container + dither (on bit reduction) |

For Re-master & Export: the WAV is already at target SR/bitDepth (5D-2-c),
so save-audio mainly does the format conversion.  dither at save acts
only if save-audio further reduces depth (rare — usually a no-op, warned
as "no reduction").

For Export As-is: the source is the original master WAV.  save-audio
transcodes it to the chosen FORMAT, keeping the source SR/bitDepth (As-is
never changes quality).  dither applies only if the format change forces
a depth reduction (e.g. 24-bit master → 16-bit FLAC).

---

## 6. Lossy + dither/bitDepth UI

When the user picks MP3 / OGG, the panel:
- greys out / labels bitDepth + dither as "not applicable"
- shows "Dither ignored for MP3/OGG"
- shows "Lossy — bit depth not applicable"

This is surfaced as a `warning` field in the SaveAudioResponse + a
pre-emptive note in the export panel.

---

## 7. Decision summary

| Question | Decision |
|---|---|
| Implement format transcode?      | Yes — ffmpeg, all 5 formats |
| Implement dither?                | Yes — ffmpeg aresample (triangular/shibata), honest warnings |
| Touch Python pipeline?           | No |
| Touch file:save-wav?             | No |
| WAV fast path?                   | Yes — copy, no ffmpeg |
| Unsupported combos?              | Surfaced as warnings, never silent |
