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

### §10 — Top Rebuild: the AI-vocal artefact

Generative music tools decode audio from a learned representation rather
than recording it, and the top octave is where that shows. Above roughly
9 kHz the detail is reconstructed, and it arrives as a watery, swirling
shimmer on consonants and breath. Vocals get it worst, because that is where
their consonants live. Users describe it as "번들거림" — a sheen the track
cannot shake.

**An exciter cannot fix this**, and understanding why is the whole design.
An exciter ADDS harmonics on top of what is already there, so the swirl is
still underneath — now with a bright layer over it. The only thing that
removes the artefact is removing the band that carries it, and the only way
to do that without ending up dull is to put something back.

So the module:

1. **Splits** at the damage frequency (LR4, so the halves sum back flat).
2. **Fades out** the damaged half by `amount`.
3. **Fades in** a replacement — a healthy midrange band driven into a
   waveshaper, filtered into the target range, and **scaled to the envelope
   the original band had**.

Step 3's last clause decides whether this sounds like a recording or a noise
generator. Harmonics at a fixed level are constant hiss; harmonics that rise
and fall with the original top end read as the same performance with its
detail restored. The test for it measures a progression — 0, then a little,
then more artefact in — rather than against a floor, because a crossover
always passes some body through and a threshold drawn near that leakage
would be testing the filter slope, not the design.

Two arithmetic facts drive the panel. Rectifying doubles a frequency, cubing
triples it, so a 4.5 kHz source lands at 9 kHz and 13.5 kHz — which is what
`Character` balances between, and why the default source is 4.5 kHz rather
than 3 kHz (3 kHz doubled is 6 kHz, below a 9 kHz crossover, where the
filter discards it and half the module is silently inert). The display draws
both landing points and says so in words when one falls below the crossover.

Zero added latency: biquads and envelope followers, no FFT. That matters
here — the STFT modules cost 43 ms and this is meant to be usable while
listening.

**What it cannot do.** On a two-track master the vocal is already mixed in,
so rebuilding the top rebuilds it for cymbals and hats too. Treating the
voice alone needs source separation, which this is not.

### §9 — Space: delay and reverb

Two new DSP modules, placed after the character stage and before the imager
— the imager should widen the finished picture, tails included, not a dry
mix that later grows a tail of its own width.

**Delay** is a per-channel line with the feedback filtered *inside* the
loop. That placement is the whole difference between a tail that decays into
nothing and one that turns into a resonant drone: each repeat is filtered
once more than the last, which is what a real room does. A stereo offset
spreads the two sides, and ping-pong routes each side's repeats into the
other.

**Reverb** is the Schroeder arrangement — eight damped comb filters per
channel for density, four series all-passes to smear what is left of the
echo pattern. Old design, right one here: fixed buffers, no allocation while
running, decay set rather than measured.

Both are shaped for a mastering bus rather than a send:

- **Mix defaults to 0** and the useful range is a few percent. A default
  that made noise would be wrong for every session, and mix 0 also keeps the
  chain bit-transparent — the modules return before touching the samples.
- **The wet path is filtered.** A tail in the bass is mud and in the top is
  hiss, so both carry a low cut and the reverb's combs carry damping.
  Without those, any amount audible enough to help also smears the low end.
- **Pre-delay keeps the transient dry**, so the mix keeps its attack and
  gains its space.
- **Feedback and size are clamped below unity unconditionally.** These are
  user numbers driving feedback loops; at 1.0 the tail is infinite and no
  amount of downstream limiting fixes it. Tests drive both to 1e9 and assert
  the output stays finite and decays.

The displays plot **time**, because that is what these modules work in.
Delay draws each repeat at its arrival and its level, above the line for
left and below for right, so the stereo offset and the feedback decay are
both visible. Reverb draws the tail's envelope after the pre-delay gap,
derived from the same comb feedback the engine computes — and the caption
says it is a shape, not a measured impulse response.

### §8 — Two audiences, one panel

This app is used by mastering engineers and by people taking a course who
have never met the word "ratio". They cannot be split into two builds, so
every control carries three things:

```
Ratio  비율
기준을 넘은 만큼을 얼마로 줄일지입니다. 4:1이면 4 dB 넘어온 것이
1 dB만 넘게 만듭니다.
```

The English term stays first, because it is what every other tool and every
tutorial calls it — a learner who only ever sees "비율" cannot follow
anything else they read. The Korean name sits beside it, and one plain
sentence replaces the English hint rather than joining it: two explanations
of the same control is not twice as clear.

The rule for that sentence is **say what moving it does, not what it is**.
"Threshold: the level above which compression starts" is a definition;
"이 레벨보다 커진 소리부터 눌러 줄입니다" is an instruction. Where a number
has an intuitive reading, give it — 4:1 meaning 4 dB in, 1 dB out beats any
adjective.

Translations live in `parameter-glossary.ts`, not on the definitions, so
they can be reviewed together for tone and so a missing one is obvious.
Band-repeated parameters collapse: `band0ThresholdDb` through
`band3ThresholdDb` share one entry, because they are one idea. That takes
203 parameters down to 120 written entries.

Coverage is a test. `test:glossary` fails the build if any parameter or
module lacks an entry, if an entry is orphaned, or if a "plain" sentence is
short enough to be a placeholder. It also asserts that **every module in the
rack draws something** — a module with no display is one a beginner cannot
learn from, so that is checked rather than intended.

### §7 — The restoration displays

De-hum, de-noise, de-essing and tonal matching all work in the frequency
domain, where a row of numbers says nothing: "Frequency 60, Harmonics 8,
Depth 12" does not answer *is it on my hum, and is it eating my bass?* Each
now has a display that does.

| Module | What it draws | Where the data comes from |
|---|---|---|
| **De-hum** | The notch comb, plus a marker per harmonic | Pure function of the parameters — exact, no live data needed |
| **De-noise** | The learned noise floor and the threshold line above it | `denoiseProfileDb()`, folded to 48 log bands |
| **De-esser** | The band it listens to, and a rolling strip of gain reduction | `deessGrDb` |
| **Reference Match** | Your tonal curve against the reference's, with a match % | `tonalCurveDb()` (32 bands) vs the supplied target |
| **Harshness Control** | The operating range and how far a peak must stick out | Parameters only — see below |

Three rules these follow.

**When the engine reports nothing, say so.** A noise profile that has not
been learned is not a flat line at −140 dB, it is an absent measurement, and
the panel says "프로파일 없음". Same for a missing reference curve.

**Do not draw a result and call it a cause.** The Harshness Control display
deliberately does *not* show a spectrum with dips in it. The module works on
per-bin excess inside an FFT frame and the chain does not report that;
drawing the post-chain spectrum would be a picture of the outcome dressed up
as a picture of the mechanism. What is drawn is what is known — the band,
the threshold, the neighbourhood width.

**Read the parameter the way it is stored.** De-hum's mains frequency is an
enum chip (`'50'` / `'60'`), not a number. Reading it with the numeric
accessor returned the fallback and drew a 60 Hz comb for a 50 Hz setting —
convincing, and wrong. `test:restoration-views` measures the real chain at
50 and 60 Hz to hold that down.

The tonal curve is measured *by* the spectral stage, so it stays empty while
that stage is bypassed. The Match panel says that rather than telling the
user to press play, which would not help.

Curves that cross the port are folded to log bands in the worklet, inside
`_postMetrics` — 1025 raw FFT bins ten times a second is twenty times the
traffic for a display no wider than 700 px.

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
# Rust DSP — 225 tests
cd aimaster-desktop/dsp-core && cargo test -p loui-dsp --release

# Rebuild all three WASM targets after any Rust change.
# Requires: rustup target add wasm32-unknown-unknown
#           cargo install wasm-bindgen-cli --version 0.2.127
pnpm --filter @loui/dsp-wasm run build:all

# Desktop — 335 checks, including 55 that push config through the real chain
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

## 8. Presets, and the AI vocal preset

Twenty-three modules and two hundred parameters is the product for an
engineer and a wall for everybody else. A preset is where a beginner
starts, so the preset bar sits **above** the rack on the Studio page
(`LouiStudioPresetBar.tsx`) rather than behind a menu, grouped
AI fixes → Core → Character, and each chip carries its Korean name with a
sentence of what picking it does (`audio/presets/preset-glossary.ts`).

Applying a preset is an ordinary edit. `applyPreset` writes the same
parameter and bypass state a slider writes, so it is heard immediately, it
is undone by moving anything, and it is not a mode. It also **only touches
modules the preset names** — tape, reverb, delay, the vintage compressor
and the multiband are left exactly as the user left them.

### `ai-vocal-texture` — AI 보컬 질감 복구

The one preset written against a specific defect. Vocals from Suno-class
generators carry a wet, glassy, over-smoothed top: the model reconstructs
above roughly 8–10 kHz from a lossy representation, so consonants and
breath come back as a shimmering wash rather than as air. Turning that
band down alone leaves a dull record, because there is nothing underneath
it. The fix is to **replace** it, not attenuate it:

| Module | Setting | Why |
|---|---|---|
| Top Rebuild | amount 70% | discards the reconstructed top and synthesises a new one from the clean 4.5 kHz voice below it |
| Spectral Shaper | 60%, 4.5 dB, 8–16 kHz | catches whatever artefact survives the crossover |
| De-esser | range 5 dB | the resynthesised top makes sibilants honest again, and honest sibilants need controlling |
| Imager | high band 78% | AI tops are wide and phasey; narrowing only the top keeps the image |
| Impact | band 2 +18% | restores the transient bite that the smoothing removed |

Loudness is deliberately untouched — the preset repairs a texture, it does
not decide how loud the record is.

Measured by `scripts/vocal-preset-selftest.ts`, pushing audio through the
real WASM chain:

- **−21.3 dB at 12 kHz** — the artefact band is genuinely gone.
- **−1.3 dB at 4.5 kHz** — the voice it was generated from survives.

The same script also holds every preset honest: each preset's parameters
must exist on the module it names, and each preset must have a Korean name
and a plain sentence. Both are exhaustive, so a new preset without a
translation fails the build rather than shipping as an unlabelled chip.

---

## 9. Per-song settings and the batch

The app was multi-file at both ends and single-file in the middle. The queue
took twenty songs, `audio:master` rendered them one by one, and
`file:batch-save-wav` wrote them all to a folder — but the two places a user
actually shapes the sound were not on that path:

- `StudioPage` held its parameter state in a page-local `useState`. Pressing
  **Back** discarded it.
- The only channel that accepts a full suite config,
  `audio:master-rust-experimental`, was registered in the main process and
  allowlisted in the preload with **zero renderer callers**. Every export
  went through `audio:master`, which takes five scalar options and knows
  nothing about the rack — so a Studio-tuned song rendered to something that
  did not sound like its preview.

`audio/session/` closes both gaps.

### `song-settings.ts` — the work, kept

Stored per **absolute source path**, not per queue item id: queue ids are
fresh UUIDs on every import, so keying by them would lose the work the moment
a file was removed and re-added, which is exactly what someone does when they
are unhappy with a render. Each entry carries the full all-modules state, the
free parametric bands, master bypass, and the preset it started from.
`localStorage`, so it survives a restart. A corrupt store reads as empty
rather than throwing.

### The layering rule

The last step picks **one** album preset for the whole queue — that is what a
batch is for, and a per-song loudness choice is twenty chances for one track
to sit 3 LU below the rest. That preset and the per-song work will disagree,
and `layerAlbumPreset` settles it:

> **A module the song actually changed is never overwritten. Everything else
> takes the album preset.**

"Actually changed" is measured against the module defaults, by value — the
state is rebuilt on every edit, so a reference check would report the whole
rack as changed. The function returns a `LayerReport` (`applied` / `kept`) as
well as the state, and `LouiAlbumPresetBar` says the count out loud, because
a rule the user cannot see is a rule they will not trust.

Repair presets (`ai-special`) are deliberately excluded from the album bar:
they answer a defect in one recording, so applying one to a whole queue would
treat every song as if it had that defect.

### `render-song.ts` — the caller that was missing

Layers the song's settings with the album preset, builds the same
`ChainConfigWire` the preview plays, and sends it on
`audio:master-rust-experimental`. A song with no saved settings falls through
to `audio:master` unchanged, so nothing regresses for someone who never opens
the Studio. Monitor settings are never included — A/B and delta are listening
aids, and baking one into an export ships a level-matched bypass as the
master.

### The workflow

1. Drop up to 20 songs on **Home**.
2. **스튜디오** on any row → shape it → **이 곡 설정 저장**. The row's button
   turns green with a ✓.
3. Pick one **최종 마스터링** preset for the queue.
4. **마스터링 시작** → each song renders through its own saved settings with
   the album preset filling in the rest → **전체 WAV 저장**.

Covered by `scripts/song-settings-selftest.ts` (30 checks), including that
the studio path reaches the suite-config channel and the classic path does
not, that a saved module appears in the config actually sent, and that no
monitor block leaks into an export.

---

## 10. Loudness — why the volume controls did nothing

Reported symptom: moving the limiter and the loudness controls in the Studio
did not audibly change how loud the preview was. It was true, for two
independent reasons, and neither would have failed any test that existed.

**`limiter.targetLufs` was read by nobody.** `chain-config.ts` never looked
at it. The panel drew it, the state stored it, and it stopped there. Its
`binding` metadata even said `status: 'wired'` — that field is
documentation, not wiring, and nothing checks the claim.

**`limiter.driveDb` had no parameter definition at all.** The config builder
read it (`num(lim, 'driveDb', 0)`) and the Rust limiter used it as the
maximizer input, but no definition existed, so it read its default of `0`
forever. The one control that makes a master louder was unreachable from the
UI.

Meanwhile the **offline render did honour the target** — it measures the
rendered output and re-renders with the input gain adjusted, a two-pass
solve. So the preview was raw chain output while the export was normalised,
routinely 6–10 dB apart with the preview the quiet one. Every judgement made
while listening was made at the wrong level.

### `loudness.rs` — the loop

A new stage does in one pass what the offline does in two: measure the
loudness of the chain's **output**, adjust the gain at its **input**.
Because it measures after the chain and corrects before it, it settles on
exactly the fixed point the offline two-pass solves algebraically — they
agree by construction, not by being tuned to match. Correcting at the input
is also what keeps it safe: the limiter is inside the loop, so it still sees
everything the gain pushes at it.

It must not become a compressor, so: K-weighted measurement over a 600 ms
window, a multi-second gain constant, and a BS.1770 absolute gate so a
fade-out is not answered by winding the gain into the noise floor. Two bugs
were caught by its own tests — gating on the *smoothed* figure let silence
read as quiet-but-present music (gain drifted 4.2 → 8.5 dB across two
seconds of nothing; it now gates on the block's own level), and a non-finite
target survived `clamp` (`f64::NAN.clamp(a, b)` is `NAN`) all the way into
the audio.

A slow loop alone took **20 seconds** to settle, which is far too long after
pressing play, so it acquires at 150 ms for the first 1.2 s and then hands
over to the slow constant. Measured: a source 20 dB quieter than another
lands within 0.87 dB of it after 6 s, 0.01 dB after 20 s.

### New controls

| Control | 한국어 | What it does |
|---|---|---|
| Auto Gain | 자동 음량 맞춤 | Runs the loop. Off leaves level alone. |
| Target LUFS | 목표 음량 | Where the loop aims. |
| Max Boost | 최대 증폭 한도 | Most the loop may add (default +12 dB). |
| Drive | 밀어넣기 | Manual push into the limiter — the maximizer. |

### Two consequences worth knowing

**The ceiling now has to survive the output trim.** `output_gain` runs after
the limiter, so a positive trim walked straight past the ceiling the limiter
had just enforced — the limiter's own contract says the output can never
exceed it, and it could. Invisible while the chain ran quiet; +3 dB of trim
peaked at **+1.70 dBFS** once the loop started delivering material that
reaches the ceiling at all. There is now a clamp at the ceiling after the
trim.

**With Auto Gain on, lowering the ceiling does not make the master quieter.**
The loop targets loudness, so a lower ceiling means the limiter takes more
away, which means the loop pushes more in. The master gets *more limited*,
not quieter. That is what a maximizer does and it is the opposite of what
most people expect the first time they see it, so there is a test asserting
it — the next person to read the numbers should not "fix" it.

### Export

The loop is switched **off** for the offline render, and the two-pass does
the job instead. The offline path is not under the realtime constraint: it
measures the whole file and applies one constant gain, where a converging
loop would leave the intro at a different level from the rest. Both aim at
the same number — `renderSong` takes the export's `targetLufs` from the same
layered state the chain config was built from — so the file lands where the
preview sounded. The mechanism differs; the result does not.

Covered by `scripts/loudness-controls-selftest.ts` (19 checks, all measured
through the real WASM chain) and 11 Rust tests in `loudness.rs`.

---

## 11. Reference Match, and the compressors

Three things reported from the Studio, all real.

### The compressors were named after the maths

"Multiband Dynamics" tells an engineer what it is and tells everyone else
nothing — and the Korean glossary already said 멀티밴드 컴프레서, so the two
halves of the same label disagreed. Renamed: **Multiband Compressor**,
**Glue Compressor**, **Vintage Compressor**. `Dynamic EQ` keeps its name; it
is an EQ.

### A compressor doing nothing looked like a broken one

Every multiband band ships at ratio **1:1**, threshold **0 dB** — a straight
wire. That default is right: modules must be bit-transparent until asked, and
`chain-config` does not even emit the stage until a band has something to do.
But it means switching the module on changes nothing, with all four graphs
reading `off` and the ratio that explains why several screens further down.

Rather than change the default — silently moving parameters when somebody
flips a toggle is how a session ends up sounding different for reasons nobody
can point at — the panel now **says** it is inert, in words, and offers
`compressorStartingPoint()` behind a button. Gentle values (2:1, thresholds
stepping down with frequency because there is less energy up there): enough
to hear it working so it can be adjusted, not a decision made on the user's
behalf.

### Match EQ had no way to load a reference

`matchTargetCurveDb` is a field on `ChainConfigInput` that **no caller ever
set**. The module drew an empty graph, said "no reference", and could not be
switched on — the feature was reachable only by writing 32 numbers by hand.
There was no picker, no drop target, nothing.

`main/offline/reference-curve.ts` measures one. It decodes the reference and
runs it through the **same spectral stage** Match EQ uses, in `analysisOnly`
mode so it measures without processing, then reads the long-term curve off
the chain. Using the engine's own measurement rather than an FFT written
alongside it is the point: the curve has to live on the engine's 32-band log
grid with the engine's weighting, or the match is computed against a slightly
different picture of the same audio and the error shows up as a tilt nobody
can trace.

Ninety seconds from the middle of the track, skipping the first twenty —
intros are the least representative part of a record, and a tonal reference
taken from one describes a section rather than the mix. Bands the analysis
never observed come back as `-Infinity` and are filled from their nearest
measured neighbour before normalising, since one would otherwise poison the
mean and every other band with it.

Two consequences worth stating:

- **Choosing a reference un-bypasses Match EQ.** The module ships bypassed
  because matching to nothing is a no-op that still costs an STFT frame of
  latency — but picking a reference *is* the request to match, so leaving it
  bypassed would mean loading a file and hearing nothing.
- **The curve is saved with the song, not the path.** The reference file may
  have moved by the time a batch runs, and a saved song that silently stopped
  matching would be worse than one that matches a file the user no longer
  has. `renderSong` passes the stored curve, so the export matches what the
  preview did.

---

## 12. Recommended defaults — the beginner's button

Every module ships neutral, which is right and useless to somebody who has
never mastered anything: twenty-four panels of numbers that all do nothing,
with no indication of which way is normal. `recommended-defaults.ts` answers
"what would somebody who does this for a living put here?" for every module,
with the reason in Korean, reachable two ways — a button on each panel, and
one that sets the whole rack.

### Where the numbers come from, and where they don't

Each entry declares a `basis`, because the difference is not cosmetic:

- **`spec`** — published, checkable delivery requirements. The −1.0 dBTP
  ceiling and 24-bit/48 kHz export are in what Spotify, Apple Music and
  YouTube publish. Not opinions.
- **`practice`** — how contemporary commercial pop is normally mastered:
  loudness around −9 to −10 LUFS, bass mono below ~120 Hz, 1–2 dB of bus
  compression, a brighter top than the source. Documented and taught, still
  a judgement call.
- **`ai-repair`** — aimed at generative-audio defects specifically: the
  reconstructed top octave, smoothed transients, over-wide phasey stereo,
  sibilance.

**These are not measurements of chart records.** Nothing here analysed the
Billboard 100 — that audio is not available to this program, and a number
presented as measured when it was not is the most damaging kind of wrong,
because it is exactly the claim a user cannot check. The honest route to
"sound like the records I admire" is already built: load them as **Match EQ
references**, which measures their real tonal balance on the engine's own
grid. This table is the sensible default for everyone who has not done that.

### Half the recommendations are "leave it off"

Reverb, delay, tape, the vintage EQ and the vintage compressor are all
recommended **off**, and the panel says so with the reason. A beginner who
does not hear that will switch everything on and wonder why it sounds worse —
master-bus reverb and a third stacked compressor are the two most common ways
to ruin a master. The `off` flag is marked, tested, and shown.

### What the test found

`recommended-defaults-selftest.ts` (25 checks) holds every value to its own
parameter's range, checks the chain engages, renders across 33 dB of input
level for finiteness and ceiling safety, and asserts idempotence. It also
caught an unrelated live bug: **`activeModuleIds` never checked
`topRebuild`, `parametricEq`, `delay` or `reverb`** — four modules could
process audio while the rack reported them idle and the "N active" count was
wrong by up to four. Fixed, with a test that every emittable module is
reachable from that function.

---

## 13. Not implemented

Honest list, so the registry stays trustworthy:

- **Master Rebalance** — needs source separation (a trained model), not DSP.
  Not started.
- **Bass Control** as a distinct module — covered today by Low End Focus and
  the multiband low band.
- **Denoise auto profile on stationary material** — minimum statistics
  cannot distinguish a sustained tone from sustained noise. Use a learned
  profile there; the auto tracker is for material with gaps.
