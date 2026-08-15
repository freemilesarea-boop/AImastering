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
| **Dynamic EQ** | Six bands of level-dependent bell/shelf | Down (cut the loud) and Up (lift the quiet); per-band range clamp |

The three spectral features **share one STFT pass** — one transform and one
frame of latency for all three, instead of four. Their per-bin gains
multiply, so the moves add in dB rather than fighting over one filter.

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

Both were caught by tests that measured the audio rather than checking the
code ran.

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
# Rust DSP — 151 tests
cd aimaster-desktop/dsp-core && cargo test -p loui-dsp --release

# Rebuild all three WASM targets after any Rust change.
# Requires: rustup target add wasm32-unknown-unknown
#           cargo install wasm-bindgen-cli --version 0.2.127
pnpm --filter @loui/dsp-wasm run build:all

# Desktop — 122 checks, including 29 that push config through the real chain
pnpm --filter @aimaster/desktop test
```

The WASM artefacts under `packages/dsp-wasm/pkg*` are committed, so a Rust
change that is not followed by `build:all` ships a stale engine. The
module-suite self-test loads the node artefact directly and fails loudly
when it is missing, rather than skipping.

---

## 7. Not implemented

Honest list, so the registry stays trustworthy:

- **Master Rebalance** — needs source separation (a trained model), not DSP.
  Not started.
- **Bass Control** as a distinct module — covered today by Low End Focus and
  the multiband low band.
- **Dither** — `export` still exposes the algorithm choice with no
  implementation behind it; unchanged by this work.
- **Denoise auto profile on stationary material** — minimum statistics
  cannot distinguish a sustained tone from sustained noise. Use a learned
  profile there; the auto tracker is for material with gaps.
