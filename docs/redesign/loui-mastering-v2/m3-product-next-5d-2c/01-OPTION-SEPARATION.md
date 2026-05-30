# M3-P-NEXT-5D-2-c — Preview / Export Option Separation

> Three tiers of parameter: preview-renderable, export-renderable, and
> staged-only.  Where each shows up and why.

---

## 1. The three tiers

| Tier | Examples | Preview | Re-master Export | Export As-is | Marker |
|---|---|---|---|---|---|
| Preview-renderable | targetLufs, targetTp, stereoWidth, outputGainDb | ✓ | ✓ | ✗ | `RENDERABLE_MAP` |
| Export-renderable  | sampleRate, bitDepth | ✗ | ✓ | ✗ | `binding.exportField` |
| Staged-only        | ratio, attack, eq.adaptive, isp, format, dither | ✗ | ✗ | ✗ | neither |

---

## 2. Why sampleRate/bitDepth aren't preview-renderable

The preview is always a 320 kbps MP3.  Its sample-rate / bit-depth are
fixed by the MP3 encoder, independent of the user's export choice.  So
changing the export bit-depth from 24 → 16 doesn't change what the
preview SOUNDS like — there's nothing to re-render for the preview.

They only matter for the EXPORTED WAV, which is why they're
export-renderable but not preview-renderable.

---

## 3. Two distinct override hashes

| Override | Contains | Hash |
|---|---|---|
| `summary.renderOverride`     | audio params only | `summary.patchHash` |
| `exportOverride.optionsOverride` | audio + quality | `exportOverride.patchHash` |

The preview uses the AUDIO hash; export uses the FULL hash.  This is why
a quality-only change:
- does NOT mark the preview as stale (`hasUnpreviewedChanges` is false)
- DOES enable Re-master & Export (`exportOverride.hasOverride` is true)

---

## 4. Where each tier appears in the UI

| Surface | Preview-renderable | Export-renderable | Staged-only |
|---|---|---|---|
| Preview strip badge   | "N renderable" | (not counted) | "M staged-only" |
| Module Strip dot      | green (renderable) | — (export module shows quality separately) | grey (staged) |
| Slide-over header tag | "Preview-ready" | — | "Staged only" |
| Export panel "Apply" badge | counted | counted | excluded |
| Export panel "Quality" badge | — | shown ("48 kHz · 24-bit") | — |

Note: sampleRate/bitDepth live on the export module.  In the preview
strip's staged-only count they're EXCLUDED by `buildExportOverride`
(they're export-handled, not skipped) — but `summarizePending` (which
drives the preview strip) still classifies a CHANGED export-quality
param as staged-only.  This is a minor cosmetic over-count in the
preview strip that the export panel clarifies.  Documented as a known
nuance; cleaning it fully would require teaching `summarizePending`
about `exportField` (deferred — low value).

---

## 5. Consistency guarantees

| Guarantee | Mechanism |
|---|---|
| Preview audio == Re-master audio | both use `summary.renderOverride` |
| Re-master quality == export panel selection | `exportOverride` reads export state |
| Export As-is never changes quality | saves the existing WAV, no override |
| Quality change ⇒ Re-master enabled | `exportOverride.hasOverride` |
| Quality change ⇏ preview stale | quality not in `summary.patchHash` |

---

## 6. Decision: keep preview-strip over-count?

The preview strip may count a changed sampleRate/bitDepth as
"staged-only".  Options:
1. Leave it — the export panel clarifies; low confusion.
2. Teach `summarizePending` about `exportField` to exclude them from
   the preview staged-only count.

Decision: **leave it (option 1)** for 5D-2-c.  The over-count is a
single number in the preview strip; the export panel is where quality
decisions happen and it's unambiguous there.  Revisit if user testing
flags it.

---

## 7. Future tiers

When M2-full adds the remaining MasteringOptions fields:
- 7 currently staged-only audio params (dynamics ×4, eq.adaptive,
  limiter.isp, limiter.lookaheadMs) become preview+export renderable
- format / dither become export-renderable (5D-2-d) via the save-path
  extension

The three-tier model scales: a param's tier is determined by its
presence in `RENDERABLE_MAP` (preview) and/or `exportField` (export).
