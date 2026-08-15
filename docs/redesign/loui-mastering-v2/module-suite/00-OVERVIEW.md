# Module Suite — Ozone-class mastering modules

**Status**: implemented, live in both render paths
**Engine**: `dsp-core/crates/loui-dsp` (Rust) → WASM (preview) + node WASM (export)
**UI**: `apps/desktop/src/renderer/pages/StudioPage.tsx`

---

## 1. What changed

The chain used to be five modules — input gain → EQ → dynamics → imager →
limiter → output. It is now twenty, in the order a mastering engineer
actually works:

```
input gain
├── 1  Restoration     de-click → de-hum → de-noise → de-esser
├── 2  Corrective      parametric EQ → spectral stage
│                      (Match EQ · Spectral Shaper · Stabilizer)
├── 3  Tone            vintage EQ → EQ → dynamic EQ
├── 4  Dynamics        multiband → glue comp → vintage comp
│                      → impact → low end focus
├── 5  Character       exciter → tape
└── 6  Output          imager → limiter / maximizer → output gain
```

Every module runs in **both** paths — the WASM worklet for the realtime
preview and the node-target WASM for the offline export render — from one
`ChainConfigWire` object. Preview and export cannot drift apart because
there is one place that decides what a parameter means.

---

## 2. Modules

### Restoration

| Module | What it does | Notes |
|---|---|---|
| **De-click** | Detects impulses against a smoothed local level, repairs by cubic Hermite interpolation across the damaged run | 32-sample lookahead. Ships bypassed — most material has no clicks |
| **De-hum** | Comb of high-Q notches at the mains fundamental + up to 12 harmonics | Adaptive mode scales each notch by how hum-like that partial actually is, so a bass note landing on 120 Hz survives |
| **De-noise** | STFT spectral subtraction with a Wiener mask | Learned profile (mark a noise-only passage) or minimum-statistics auto. Spectral blur + time smoothing suppress musical noise. **+2048 samples latency** |
| **De-esser** | Split-band sibilance control | Applied as a *dynamic high shelf*, not a subtracted band split — see §4 |

### Tone / spectral

| Module | What it does | Notes |
|---|---|---|
| **Match EQ** | Pulls the long-term tonal curve towards a reference on a 32-band log grid | Needs a reference curve; stays off without one |
| **Spectral Shaper** | Per frame, pulls down any bin sitting above its own spectral neighbourhood | Tames resonances that only appear on some notes |
| **Stabilizer** | Pulls the long-term curve towards a target tilt | No reference needed |
| **Vintage EQ** | Passive program EQ | Low boost is a shelf, low attenuation is a *bell* above it — so running both gives the lift with a scooped upper bass instead of cancelling. See §4 |
| **EQ** | Four bands: high-pass, low shelf, bell, air shelf | Edited on a curve, not sliders. Frequency, gain and Q are all parameters. See §5 |
| **Dynamic EQ** | Six bands of level-dependent bell/shelf | Down (cut the loud) and Up (lift the quiet); per-band range clamp |

The three spectral features **share one STFT pass** — one transform and one
frame of latency for all three, instead of four. Their per-bin gains
multiply, so the moves add in dB rather than fighting over one filter.

### §5 — The EQ graph

The EQ and Vintage EQ are edited on a Pro-Q-style graph: drag a node for
frequency and gain, wheel or shift-drag for bandwidth, double-click to flatten
it. Arrow keys move a focused node, so the graph is not mouse-only.

Two things made this more than a drawing:

**Frequency and Q became parameters.** The EQ's bands used to be nailed to
120 Hz / 3 kHz / 12 kHz, which makes two thirds of a drag gesture a no-op.
`EqConfig` now carries `*_hz` and `*_q` per band, defaulting to the old
constants — a config that sets only gains behaves exactly as it did, so saved
presets did not shift.

**A derived node still writes a real parameter.** The Pultec's attenuation
bell sits a fixed 1.6 octaves above its boost shelf and has no frequency
control of its own. Dragging it sideways moves the shared low frequency —
which is what the hardware does — via the `toParam` inverse in
`eq-graph-model.ts`.

The curve is drawn from the same RBJ coefficients the Rust modules run, and
`test:eq-graph` holds them together: for each case it measures the real WASM
chain's gain at a set of frequencies and fails if the drawn curve disagrees by
more than 0.4 dB (worst observed: 0.06 dB). A curve computed from a different
model than the one processing audio is a lie that looks like a feature.

**The free EQ.** `Parametric EQ` is a band list rather than a fixed layout:
double-click empty graph to add a band, double-click a node to walk
bell → low shelf → high shelf → high-pass → low-pass, alt-click or Delete to
remove it. Sixteen bands, which is `MAX_PARAMETRIC_BANDS` in the engine; the
builder caps there rather than letting the seventeenth vanish silently.

Its bands live outside the parameter state and reach the chain through
`ChainConfigInput.parametricBands`, because the state is a flat map of named
scalars per module and this list has neither fixed length nor fixed names —
the same reason the Match EQ reference curve is passed alongside it.

Pass filters send no gain. The engine ignores gain on high-pass and low-pass
bands, so forwarding a band's leftover gain would draw a boost the audio
never applies.

### §6 — The dynamics panels

The compressors show a transfer curve — input level in, output level out,
with the bend at the threshold — plus a live gain-reduction meter, instead of
a column of numbers. `dynamics-graph-model.ts` mirrors the gain computers in
`{dynamics,multiband,vintage}.rs`, including the multiband's 24 dB range
clamp, which the UI does not expose but the curve has to respect.

Three things this had to get right:

**Parallel mix sums signals, not levels.** The wet and dry paths are the same
signal scaled, so they are perfectly correlated and add in the linear domain.
The first draft blended the dB values and read 3 dB low; the measured test
caught it.

**The live marker is the reduction, inverted.** The chain reports how much it
is reducing but not the level it is reducing. Rather than add a second meter
to the audio thread for something the curve already determines, the reduction
is bisected back through the curve. That marker is also the only part of the
display that shows attack and release: the curve is the steady state, and a
slow attack appears as a marker that lags the music.

**Per-band GR is sampled at metric rate, not per block.** `multibandGrDb()`
returns a fresh array across the WASM boundary, which is an allocation; it is
read inside `_postMetrics`, the one place on the audio thread already limited
to ten calls a second.

A multiband band's curve describes *that band's* gain computer. Near a
crossover the band carries less than the whole signal while its neighbour
carries the rest uncompressed, so the summed output differs from the drawn
curve there — about 1.5 dB at a crossover, under 0.4 dB well inside a band.

The analyser trace behind the EQ curve is the post-chain spectrum, drawn on its
own canvas from an animation frame. It is deliberately not React state: a
spectrum that re-rendered the panel thirty times a second would drag every
curve recomputation with it. It is also faint and filled, because it is a
*level* display (dBFS) sharing a panel with a *gain* display (dB of EQ), and
those are not the same scale.

### Dynamics

| Module | What it does |
|---|---|
| **Multiband Dynamics** | Four Linkwitz-Riley bands, each compressing or expanding, with makeup, parallel mix, solo and mute |
| **Glue Compressor** | The original single-band bus compressor |
| **Vintage Comp** | Vari-mu behaviour — knee that softens as it works harder, program-dependent release, saturation that rides with the gain reduction |
| **Impact** | Multiband transient shaper driven by the gap between a fast and a slow envelope, so sustain is untouched |
| **Low End Focus** | Punchy (separate low transients) / Smooth (even the bottom out) + a low-band-only trim |

### Character

| Module | What it does |
|---|---|
| **Exciter** | Four-band harmonic exciter — Warm / Retro / Tape / Tube / Triode. Each band is level-matched to its dry input, so drive changes colour, not volume |
| **Tape** | Record saturation, head bump, gap loss and wow/flutter at 7.5 / 15 / 30 ips |

### Output

| Module | What it does |
|---|---|
| **Imager** | Global width, low-mono fold, plus per-band widths over a 4-band crossover |
| **Limiter / Maximizer** | True-peak-safe ceiling with lookahead, plus `drive` and five characters (Clean / Transparent / Punchy / Smooth / Aggressive) that set release and soft-clip depth |
| **Dither** | TPDF or 2nd-order noise-shaped dither on bit-depth reduction, with auto-blanking. See §4 |

### Monitoring (not processing)

| Mode | You hear |
|---|---|
| **Processed** | The chain output — the normal case |
| **Bypass** | The dry input, delay- and loudness-aligned to the wet |
| **Delta** | Wet − dry: only what the chain changed |

Plus **level matching**, which brings one path to the other's K-weighted
loudness before you hear either. See §4.

---

## 3. Design rules the suite holds to

**Neutral means neutral.** Every module short-circuits to an exact
pass-through when its settings do nothing. Splitting and re-summing a
crossover is magnitude-flat but not bit-exact, so a neutral multiband
module skips the crossover entirely. `neutral_chain_is_bit_transparent`
enforces this; a default chain costs no CPU and no latency.

**Latency is stated, never hidden.** The STFT modules cost a frame each.
`MasteringChain::latency_samples()` reports only what is engaged, and the
rack footer shows it in milliseconds.

**The ceiling is unconditional.** Whatever the maximizer's drive and
character, the final clamp runs. No setting can produce output above the
ceiling.

**A bad config is rejected whole.** `setConfigJson` either applies the
entire config or leaves the chain untouched — the audio thread never sees a
half-applied state.

**Status claims are backed.** `MODULE_STATUS_POLICY.md` still governs the
registry: `live` means it processes in preview *and* export. Since both
paths run the same Rust chain, implemented modules are genuinely live.

---

## 4. Two things worth knowing

**The de-esser is a shelf, not a subtraction.** The obvious split-band
design — filter out the high band, scale it, add it back — combs badly.
Around the corner frequency the filtered copy is far enough out of phase
that most of the intended attenuation cancels: asking for 12 dB of ducking
produced about 1 dB. A dynamic high shelf has none of that. At 0 dB
reduction the RBJ shelf coefficients collapse to exact unity, so it is
bit-transparent when idle, and above the corner the cut is exactly what the
meter reports.

**The Pultec low section needed a bell, not an opposing shelf.** Two
opposing shelves at the same corner cancel below it, which is precisely the
thing the hardware is famous for *not* doing. Modelling the attenuation as
a bell an octave and a half above the boost reproduces the measured curve:
a lift at the very bottom with a scooped upper bass.

**Dither engages only on a real reduction, and only once.** Two things
here are easy to get wrong and both are load-bearing:

*It must not turn itself on.* The engine renders a 24-bit master, so only a
target below 24 bits is a reduction worth dithering. Emitting the stage at
24-bit or 32-bit float would break the chain's bit-transparency and add
noise nobody asked for — for a step that is irreversible once the file is
written. `MASTER_NATIVE_BIT_DEPTH` is what that rule is checked against.

*It must not happen twice.* The file writer (`audioTranscode.ts`) can also
dither, via ffmpeg. If the engine already dithered, ffmpeg dithering again
leaves two uncorrelated noise floors and the benefit of neither. The render
result carries `dithered`, `SaveAudioRequest` carries
`sourceAlreadyDithered`, and the transcode plan drops its own dither when
that is set.

The module quantises even at mode `none`, deliberately: that is the only
way to hear what dither is buying you before committing to a file.

The noise shaper is a 2nd-order highpass (`(1 - z⁻¹)²`), not a
psychoacoustic curve — stable and exactly what it says. Its sign is the
thing to watch: reversed, the NTF becomes a lowpass and the module piles
noise *into* the midrange. That is precisely how the first implementation
was wrong, and `shaping_moves_noise_upward` is what caught it.

**A/B without level matching compares makeup gain, not processing.** At
matched programme material, listeners prefer the louder version nearly
every time — regardless of whether it is better. A mastering chain almost
always raises level, so an unmatched A/B button systematically flatters
whatever you just did. The monitor therefore measures both paths with
K-weighting (BS.1770) and matches them, and it puts the gain it applied on
screen: an A/B that silently moved the level by 4 dB is exactly as
misleading as one that did not match at all.

The other half is alignment. The spectral modules delay the signal by
thousands of samples, so the dry path is held in a delay line and read back
at exactly `latency_samples()`. Without that, Delta is mostly timing error
and A/B is a phasey smear. `delta_of_a_transparent_chain_is_silence` is the
test that pins it — one sample of misalignment and it fails.

Monitoring is deliberately **not** part of the module parameter state. It
must not be saved into a preset and must never reach an export, so keeping
it out of the state means `buildChainConfig({ state })` cannot emit it
unless a caller explicitly asks. That is a structural guarantee rather than
a convention.

All of these were caught by tests that measured the audio rather than
checking the code ran.

---

## 5. Where things live

| Concern | Path |
|---|---|
| DSP modules | `dsp-core/crates/loui-dsp/src/mastering/` |
| STFT / crossover infrastructure | `dsp-core/crates/loui-dsp/src/{stft,crossover}.rs` |
| Chain assembly + order | `dsp-core/crates/loui-dsp/src/mastering/chain.rs` |
| WASM binding (`setConfigJson`, metering) | `dsp-core/crates/loui-dsp-wasm/src/lib.rs` |
| Parameter definitions | `apps/desktop/src/renderer/audio/parameters/suite-parameter-definitions.ts` |
| State → config bridge | `apps/desktop/src/renderer/audio/chain-config.ts` |
| Module registry / statuses | `apps/desktop/src/renderer/audio/modules/loui-module-suite.ts` |
| Rack UI | `apps/desktop/src/renderer/components/product/LouiModuleRack.tsx` |
| Generic panel | `apps/desktop/src/renderer/components/product/panels/ModuleParameterPanel.tsx` |
| Studio page | `apps/desktop/src/renderer/pages/StudioPage.tsx` |

---

## 6. Building and testing

```bash
# Rust DSP — 183 tests
cd aimaster-desktop/dsp-core && cargo test -p loui-dsp --release

# Rebuild all three WASM targets after any Rust change.
# Requires: rustup target add wasm32-unknown-unknown
#           cargo install wasm-bindgen-cli --version 0.2.127
pnpm --filter @loui/dsp-wasm run build:all

# Desktop — 148 checks, including 55 that push config through the real chain
pnpm --filter @aimaster/desktop test
```

The WASM artefacts under `packages/dsp-wasm/pkg*` are committed, so a Rust
change that is not followed by `build:all` ships a stale engine. The
module-suite self-test loads the node artefact directly and fails loudly
when it is missing, rather than skipping.

---

## 7. Known limitation — live monitoring

The A/B and Delta modes work on the **rendered output** today: set a mode,
render, and you get a level-matched bypass or a delta bounce you can listen
to.

They are not yet audible in a live preview, because the realtime preview is
disabled at the flag level (`isRealtimePreviewEnabled()` returns `false`
unconditionally after a worklet mount bug crashed the renderer). Re-enabling
it is what turns this from a bounce-and-compare workflow into a monitoring
button, and the engine side is already in place.

---

## 8. Not implemented

Honest list, so the registry stays trustworthy:

- **Master Rebalance** — needs source separation (a trained model), not DSP.
  Not started.
- **Bass Control** as a distinct module — covered today by Low End Focus and
  the multiband low band.
- **Denoise auto profile on stationary material** — minimum statistics
  cannot distinguish a sustained tone from sustained noise. Use a learned
  profile there; the auto tracker is for material with gaps.
