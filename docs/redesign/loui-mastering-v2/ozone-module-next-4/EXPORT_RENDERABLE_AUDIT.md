# OZONE-MODULE-NEXT-4 — Export Renderable Audit

> Exactly what the offline Python engine consumes — the basis for honest
> export-support classification.  Audited against
> `services/python-audio/app/mastering/` + `packages/audio-engine`.

---

## 1. The ONLY fields forwarded to Python

`masterFile` (`packages/audio-engine/src/mastering/index.ts`) sends a fixed
JSON-RPC param set — nothing beyond `MasteringOptions`:

| MasteringOptions field | Python param | Honoured? | How |
|---|---|---|---|
| style | style | ✅ | fixed per-style EQ overlay + bus-comp preset + saturation default |
| targetLufs | target_lufs | ✅ | loudnorm target |
| targetTp | target_tp | ✅ | brickwall limiter ceiling (+ soft-clip ref) |
| sampleRate | sample_rate | ✅ | ffmpeg output format |
| bitDepth | bit_depth | ✅ | ffmpeg output format |
| applyAiCorrections | apply_ai_corrections | ✅ | AI harsh/boomy auto-fix |
| limiterStrength | limiter_strength | ✅ | alimiter input gain / attack / release preset |
| saturationAmount | saturation_amount | ✅ | compand waveshaping intensity |
| stereoWidth | stereo_width | ✅ | extrastereo width |
| outputGainDb | output_gain_db | ✅ | volume node |

## 2. Critical finding — NO per-band / per-knob DSP inputs

The Python engine accepts **none** of these:

- Compressor threshold / ratio / attack / release / makeup / knee
  (style presets only — fixed).
- EQ band frequency / Q / gain (style overlay only — fixed frequencies).
- Limiter **lookahead**, **ISP / inter-sample-peak**, oversampling
  (ffmpeg `alimiter` has none).
- Low-cut / presence / air as continuous user values.

→ The EQ tone, Dynamics, low-mono, and limiter lookahead/ISP knobs the UI
exposes are **preview-only** (the Rust realtime chain processes them; the
export does not).  They CANNOT be promoted to export-exact without adding
real DSP to the Python engine (out of scope, forbidden).

## 3. Export-exact module params (the only ones)

Confirmed against `RENDERABLE_MAP_LOOKUP`:

| Module param | Engine target | MasteringOptions | Status |
|---|---|---|---|
| limiter.targetLufs | loudness-norm:targetLufs | targetLufs | exact |
| limiter.ceilingDbtp | limiter:ceilingDb | targetTp | exact |
| imager.widthPct | stereo-imager:width | stereoWidth | exact |
| eq.outputGainDb | gain-staging:targetPeakDb | outputGainDb | exact |
| export.sampleRate / bitDepth | (render stage) | sampleRate / bitDepth | export-only |

## 4. Honest conclusion

The premise "promote EQ/Dynamics/Limiter detail to export-renderable" is
**not achievable** without new Python DSP.  So this milestone delivers an
honest *classification + UI* layer (exact / export-only / preview-only /
planned) instead of fabricated promotions — and a selftest that fails the
build if any unsupported knob is ever marked export-exact.
