# M3-P-NEXT-1 — Mock Analyzer Session

> A deterministic `AnalyzerSession` implementation that drives V2 panels
> in Storybook (and future tests) without an AudioContext, audio device,
> or WASM init.

---

## 1. Why a third factory

We already have two factories:
- `WasmAnalyzerSessionFactory` — production; real WASM, real audio
- `SyntheticAnalyzerSessionFactory` — dev; TS LoudnessAnalyzer + synthetic oscillators

Both **process real signal**, just with different paths.  Neither is
right for Storybook:
- WASM requires browser audio APIs that jsdom doesn't have.
- Synthetic runs the TS LUFS analyzer which uses `setInterval` against
  real signal — slow to converge, hard to reach a specific verdict.

The mock session is the third path: **pre-scripted timelines** the
panels can render without any DSP at all.

| Factory | Audio device | WASM | LUFS impl | Cadence | Determinism |
|---|---|---|---|---|---|
| `WasmAnalyzerSessionFactory` | yes | yes | Rust dsp-core | block-driven | hardware-dep |
| `SyntheticAnalyzerSessionFactory` | no | no | TS LoudnessAnalyzer | 50 ms tick | inputs-dep |
| **`MockAnalyzerSession` (this)** | **no** | **no** | **scripted** | **50 ms tick** | **fully deterministic** |

---

## 2. Timeline data model

A `MockPreset` is a named loop of keyframes:

```ts
interface MockPreset {
  id: MockPresetId;
  label: string;
  description: string;
  loopSec: number;                 // total loop length
  keyframes: MockKeyframe[];       // sorted by `t`, ends at loopSec
}

interface MockKeyframe {
  t: number;                       // wall clock seconds since start
  momentaryLufs: number;
  shortTermLufs: number;
  integratedLufs: number;
  loudnessRange: number;
  truePeakDbtp: number;
  samplePeakDb: number;
  rmsDb: number;
  correlation: number;
  msRatioDb: number;
  spectrumDb?: number[];           // 30 bins, 1/3-oct
  label?: string;                  // human label for the moment
}
```

At runtime the session interpolates between adjacent keyframes via
linear blend.  This produces smooth animation (60-ms intervals at 30 Hz
tick rate) that visualises a "performance" rather than a snapshot.

---

## 3. The 7 + 1 built-in presets

| Preset id | What it shows | Verdict |
|---|---|---|
| `idle`            | Silence floor — no playback | (none) |
| `spotify-loud`    | -14 LUFS streaming-target master, gentle pumping verse → chorus → verse | Stereo Balanced |
| `warm-acoustic`   | Sparse acoustic — high LRA (12+ LU), warm tilt, mono-safe correlation | Mono Safe |
| `ai-harsh`        | AI defect pattern — 3-5 kHz peak, sub rumble, brickwall dynamics | Wide |
| `broken-phase`    | Phase-flipped channel — correlation -0.35, M/S negative | Phase Risk |
| `clipping-risk`   | TP at -0.2 dBTP, on the edge of the ceiling | Stereo Balanced (red TP) |
| `mono-safe`       | L ≈ R, correlation 0.98, M/S very high | Mono Safe |
| `loading`         | NaN snapshots — the panel's "loading…" path | (loading) |

Plus `disconnected` (no session at all) — exercised by passing `session={null}` to V2 panels.

---

## 4. Spectrum shapes per preset

Three reusable spectrum shapes the keyframes pull from:

| Shape | Use | Spectral character |
|---|---|---|
| `STREAMING_TARGET_SPECTRUM` | spotify-loud, broken-phase, clipping-risk, mono-safe | gentle high-shelf, modest sub boost, scooped mids |
| `HARSH_SPECTRUM`            | ai-harsh                                            | 3-5 kHz peak (+8 dB), sub rumble (+6 dB), narrow LRA |
| `ACOUSTIC_SPECTRUM`         | warm-acoustic                                       | warm-tilted, gentle highs, narrow stereo width |

Default (when a keyframe omits `spectrumDb`): pink-noise rolloff.

---

## 5. Cadences

Mirrors the production session's emit pattern:

| Stream | Cadence |
|---|---|
| Tick snapshots | rate-driven per subscriber (60/30/10 Hz) |
| Full snapshots | 1 Hz (gated calculation) |
| FFT frames | 30 Hz |
| Stereo frames | 30 Hz |

Driven by a single `setInterval` at the session's `stepMs` (default 50 ms).

---

## 6. Public API

```ts
// Factory-style (for stories driven via meta.args).
const factory = mockFactory('spotify-loud');

// Direct construction (when a story wants to call setPreset() live).
const session = createMockSession({
  sampleRate: 48_000,
  channels: 2,
  preset: 'spotify-loud',
});
await session.start();
session.setPreset('ai-harsh');   // live timeline swap
```

`MockAnalyzerSession.setPreset(presetIdOrPreset)` and
`MockAnalyzerSession.activePreset()` let stories build live-toggle
toolbars (M3-W-C follow-up).

---

## 7. Test coverage

Stories implicitly cover the mock session — every story renders a panel
that subscribes to the session and exercises its emit cadence.

Future unit-test ideas (not in this commit):
- `setPreset()` mid-loop resets the timeline correctly
- `stop()` clears the interval (no leaks)
- Interpolation handles NaN values correctly (loading preset)
- Spectrum array length stays at 30 across all keyframes

---

## 8. Limitations

| Limitation | Workaround |
|---|---|
| Not a behavioural model — won't tell you if your code reacts correctly to a stream of real LUFS values | Use the synthetic or WASM factory for behaviour tests |
| Timeline loops forever — doesn't simulate "track ended" | Use `session.stop()` from your component test |
| FFT magnitude is identical frame-to-frame within a keyframe span | Acceptable for visual review; not for DSP regression |
| Stereo `widthIndex` is a heuristic of `1 - correlation*0.5` | Real value comes from MS energy ratio (Rust `StereoMeter::width_index`) |
