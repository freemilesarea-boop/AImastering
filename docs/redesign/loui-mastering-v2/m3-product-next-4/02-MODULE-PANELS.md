# M3-P-NEXT-4 — Module Panel Specifications

> Per-panel parameter list + UI state model.  Each panel is a UI shell —
> nothing here writes a DSP value.

---

## 1. EqParameterPanel

```
┌────────────────────────────────────────────┐
│ EQ                                    ✕     │
│ Adaptive 7-band                            │
├────────────────────────────────────────────┤
│  ─── EQ Curve ────────────── [Adaptive] ── │
│  ╭──────────────────────────╮              │
│  │   ↗  ───  ↗      ↗──     │              │
│  ╰──────────────────────────╯              │
│  ─── Bands ────────────────────────────── │
│  Low Cut     ████████░░░░░░    32 Hz       │
│  Low Shelf   ██████░░░░░░░░    +1.2 dB     │
│  Presence    ███████░░░░░░░    +1.4 dB     │
│  Air         ████████░░░░░░    +2.0 dB     │
│  ─── Output ───────────────────────────── │
│  Output Gain ░░░░░░██░░░░░░     0.0 dB     │
│  Adaptive    [ ● Adaptive ]               │
└────────────────────────────────────────────┘
```

### State model

```ts
interface EqState {
  lowCutHz:     number;  // 20..120
  lowShelfDb:   number;  // -6..+6
  presenceDb:   number;  // -6..+6
  airDb:        number;  // -6..+6
  outputGainDb: number;  // -12..+12
  adaptive:     boolean;
}
```

### Curve preview

Polyline through 8 anchor points reflecting band gains.  The X axis is
log-frequency (20 Hz → 20 kHz).  The Y axis maps -12..+12 dB to a 48
pixel span centred at 0 dB.

The preview is decorative — it does NOT show the live EQ response.
Real curve rendering lands in M3-P-NEXT-5 when the engine bridge
exposes the computed transfer function.

---

## 2. DynamicsParameterPanel

```
┌────────────────────────────────────────────┐
│ Dynamics                              ✕     │
│ Glue Comp                                  │
├────────────────────────────────────────────┤
│  ─── Gain Reduction ──────────────────────│
│  ███████████████░░░░░░░░░      −4.2 dB     │
│  ─── Compressor ──────────────────────────│
│    ╭─╮        ╭─╮        ╭─╮       ╭─╮    │
│    │ │  ◌     │ │  ◌     │ │  ◌    │ │  ◌ │
│    ╰─╯        ╰─╯        ╰─╯       ╰─╯    │
│   −14 dB    2.0 :1     10 ms     120 ms   │
│   Threshold  Ratio     Attack    Release  │
│  ─── Parallel ────────────────────────────│
│  Mix         ████████████████   100 %      │
└────────────────────────────────────────────┘
```

### State model

```ts
interface DynState {
  thresholdDb: number;  // -30..0
  ratio:       number;  // 1..10
  attackMs:    number;  // 0.1..100
  releaseMs:   number;  // 10..1000
  mixPct:      number;  // 0..100
}
```

### Mock GR meter

The gain-reduction meter on this panel is **animated by a random walk**
seeded from the current `threshold + ratio` settings:

```
target = clamp((|threshold| / 24) * (ratio / 4), 0, 1)
new    = clamp(prev * 0.6 + target * 0.4 + drift, 0, 1)
```

This gives a "live" feel without any audio.  100 ms tick rate
(`setInterval`).  Replaced with engine output in M3-P-NEXT-5.

---

## 3. ImagerParameterPanel

```
┌────────────────────────────────────────────┐
│ Imager                                ✕     │
│ Stereo width · Mono fold-down              │
├────────────────────────────────────────────┤
│  ─── Correlation ──────────────  [+0.78] ─│
│  ◀──────────────────●────────────▶  Stable │
│  ─── Stereo ──────────────────────────────│
│  Width      ████████░░░░░░░░░   100 %     │
│  Low Mono   ████░░░░░░░░░░░░░   120 Hz    │
│  Stereoize  [ ◌ Off ]                     │
│  ─── Width by Band ───────────────────────│
│  ┌────┬────┬────┬────┐                    │
│  │██░░│████│████│███░│  ← 4 vertical bars │
│  │40% │100%│110%│90% │                    │
│  │Low │Mid-│Mid-│High│                    │
│  │    │Low │High│    │                    │
│  └────┴────┴────┴────┘                    │
└────────────────────────────────────────────┘
```

### State model

```ts
interface ImgState {
  widthPct:  number;            // 0..200
  lowMonoHz: number;            // 20..400
  stereoize: boolean;
  bandWidth: [number, number, number, number]; // 4 bands × 0..200
}
```

### Correlation badge / mirror meter

Live mock — correlation drifts within ± 0.08 of a base value driven by
the width slider.  When `correlation < 0.2`, the readout switches to
`'Phase risk — fold-down may cancel'` and the status colour changes to
amber/red.

This is intentionally a UI proof — real correlation comes from the
StereoScopePanel's analyzer stream and isn't surfaced inside this
shell.  Wire-up in M3-P-NEXT-5.

---

## 4. LimiterParameterPanel

```
┌────────────────────────────────────────────┐
│ Limiter                               ✕     │
│ True-peak guard                            │
├────────────────────────────────────────────┤
│  ─── Targets ──────────────── [−1.0 dBTP] │
│  Target LUFS         ██████░░░░   −14.0    │
│  TP Ceiling          ██████████   −1.0     │
│  True-Peak           [ ● ISP ]             │
│  ─── Behaviour ───────────────────────────│
│  Lookahead           █░░░░░░░░░    2.5 ms  │
│  Character                                  │
│   ┌──────────────┬──────────────┐          │
│   │ Transparent  │ Glue         │  ← 2×2   │
│   │ Aggressive   │ Classic      │          │
│   └──────────────┴──────────────┘          │
│  ─── Gain Reduction ──────────────────────│
│  ████████████░░░░░░░░░       −2.4 dB       │
└────────────────────────────────────────────┘
```

### State model

```ts
interface LimState {
  targetLufs:   number;          // -24..-6
  ceilingDbtp:  number;          // -3..0
  lookaheadMs:  number;          // 0..20
  character:    'transparent' | 'glue' | 'aggressive' | 'classic';
  isp:          boolean;
}
```

### Character cards

Four square buttons in a 2×2 grid.  Active card has the accent border
+ accent-tinted background.  Each card shows a one-line description
under the title — copywriting hint for the user about audible
character difference.

---

## 5. ExportParameterPanel

```
┌────────────────────────────────────────────┐
│ Export                                ✕     │
│ Format · Sample rate · Dither              │
├────────────────────────────────────────────┤
│  ─── Format ───────────────────────────── │
│  [WAV]  [FLAC]  [MP3]  [AIFF]  [OGG]      │  ← chip row, single-select
│  ─── Sample Rate ──────────────────────── │
│  [44.1k]  [48k Default]  [88.2k]  [96k]  [192k] │
│  ─── Bit Depth ───────────────────────── │
│  [16-bit]  [24-bit Default]  [32-bit Float] │
│  ─── Dither ───────────────────  [ ● On ] │
│  [None]  [TPDF]  [Shaped]                  │
│  ⚠ Dither has no effect at 32-bit float    │
│  ─── Normalize Target ─────── [from limiter] │
│  [LUFS  −14.0]   [Ceiling  −1.0 dBTP]      │
│  ✦ Format selection is a UI shell …        │
└────────────────────────────────────────────┘
```

### State model

```ts
interface ExportState {
  format:     'wav' | 'flac' | 'mp3' | 'aiff' | 'ogg';
  sampleRate: 44100 | 48000 | 88200 | 96000 | 192000;
  bitDepth:   16 | 24 | 32;
  dither:     'none' | 'tpdf' | 'shaped';
  comingSoon: boolean;
}
```

### Behaviour rules

- Bit depth `32` ⇒ dither shows a warning ("no audible effect at 32-bit float")
- `comingSoon` flag (default `true`) hides the export button and shows
  the editorial notice instead.  Flipping it to `false` in code reveals
  the export CTA that will be wired in M3-P-NEXT-5.
- The Normalize Target section is **read-only echo** of the limiter's
  current settings — passed in via the `targetLufs` / `targetTp`
  props.

---

## 6. Cross-panel rules

### Shared section card pattern

Every panel uses `LouiSectionCard` for top-level groups.  Sections
have:
- 12-char uppercase label (`text.muted`, 0.16 em letter-spacing)
- Optional right-side trailing element (badge / pill)
- 1 px hairline divider
- `space.4` inner padding, `space.3` gap between rows

### Live mock cadence

Panels that surface "live" indicators (Dynamics GR, Imager correlation,
Limiter GR) all run a `setInterval` at 90-120 ms.  This is purely
visual — the values aren't routed anywhere.  Each panel cleans up its
interval on unmount.

### Number formatting

| Type | Formatter |
|---|---|
| Integer Hz (Low Cut, Low Mono) | `v.toFixed(0)` |
| Sign-aware dB (gains)          | `v >= 0 ? '+' + v.toFixed(1) : v.toFixed(1)` |
| LUFS / dBTP                    | `v.toFixed(1)` |
| Times (ms)                     | `v.toFixed(1)` for sub-100, `v.toFixed(0)` for ≥ 100 |
| Ratios                         | `v.toFixed(1)` |
| Percentages                    | `v.toFixed(0)` |

All numbers render in `LouiKnob` / `LouiSliderRow` with `tabular-nums`
on so the digit columns don't shift width.

### Disabled states

Every primitive accepts a `disabled` prop that:
- Drops opacity to 0.45
- Sets `cursor: not-allowed`
- Sets `aria-disabled="true"`
- Returns early from `onChange` invocations

No panel sets `disabled` programmatically in this milestone — they all
expose an editable shell.  Disabled stories in Storybook deliberately
construct disabled primitives for visual reference.
