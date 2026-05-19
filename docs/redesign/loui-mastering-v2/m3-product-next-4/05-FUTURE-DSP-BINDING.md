# M3-P-NEXT-4 — Future DSP Binding Map

> Every UI parameter on every panel maps to a concrete engine parameter
> that M3-P-NEXT-5 will wire.  This document is the contract.

---

## 1. Binding model

Each row below is a four-tuple:

| UI param | Type | Range | Engine target |
|---|---|---|---|

The "Engine target" column refers to a path in the (future) Loui engine
parameter tree.  Naming is provisional — when M2-full lands the Rust
mastering chain, paths might shift slightly.  This map is the source of
truth for the wire-up commit.

---

## 2. EQ panel bindings

| UI param      | Type    | Range          | Engine target                       |
|---|---|---|---|
| `lowCutHz`    | number  | 20..120 Hz     | `engine.eq.lowCut.frequency`        |
| `lowShelfDb`  | number  | -6..+6 dB      | `engine.eq.lowShelf.gain`           |
| `presenceDb`  | number  | -6..+6 dB      | `engine.eq.presence.gain`           |
| `airDb`       | number  | -6..+6 dB      | `engine.eq.air.gain`                |
| `outputGainDb`| number  | -12..+12 dB    | `engine.outputGain`                 |
| `adaptive`    | boolean | —              | `engine.eq.adaptive`                |

### Additional bands (future)

The current EQ shell exposes 4 user-tunable bands + output gain.  The
production EQ in the Python pipeline has up to 7 bands (Low Cut, Low
Shelf, Low Mid, Mid, Upper Mid, Presence, Air).  The shell only
exposes the 4 most-tuned bands for UI simplicity — the others will
remain adaptive-only (driven by genre profile + reference target).

When M3-P-NEXT-5 wires the binding:
- Map `lowShelfDb` → both `engine.eq.lowShelf` and `engine.eq.lowMid`
  (current pipeline groups them)
- Add a "Show all bands" toggle in the panel to expose the remaining
  bands as an advanced view

---

## 3. Dynamics panel bindings

| UI param       | Type    | Range          | Engine target                       |
|---|---|---|---|
| `thresholdDb`  | number  | -30..0 dB      | `engine.glueComp.threshold`         |
| `ratio`        | number  | 1..10          | `engine.glueComp.ratio`             |
| `attackMs`     | number  | 0.1..100 ms    | `engine.glueComp.attack`            |
| `releaseMs`    | number  | 10..1000 ms    | `engine.glueComp.release`           |
| `mixPct`       | number  | 0..100 %       | `engine.glueComp.mix`               |
| `grDb` (read)  | number  | live           | `engine.glueComp.grDb` (subscribe)  |

### GR meter subscription

The live gain-reduction read currently uses a random walk inside the
panel.  M3-P-NEXT-5 will replace it with a subscription to a
`useEngineParameter('engine.glueComp.grDb', { rate: '30Hz' })` hook —
same pattern used for `useAnalyzerStream` in the V2 meter panels.

### Sidechain (future)

The DSP chain has no sidechain compressor today.  When M2-full adds
one:
- New section in the panel: "Sidechain"
- New params: `sidechainSource` (Self / External), `sidechainHpfHz`, …
- Engine path: `engine.glueComp.sidechain.*`

---

## 4. Imager panel bindings

| UI param       | Type    | Range          | Engine target                       |
|---|---|---|---|
| `widthPct`     | number  | 0..200 %       | `engine.imager.width`               |
| `lowMonoHz`    | number  | 20..400 Hz     | `engine.imager.lowMonoFrequency`    |
| `stereoize`    | boolean | —              | `engine.imager.stereoize`           |
| `bandWidth[i]` | number  | 0..200 %       | `engine.imager.bands[i].width`      |
| `correlation` (read) | number | live    | `engine.stereo.correlation` (subscribe — V2 panel already does this) |

### Per-band frequency boundaries

The 4 bands shown in the panel (Low, Mid-Low, Mid-High, High) are
fixed in the UI: 0..120 Hz, 120..1k, 1k..6k, 6k..20k.  The engine
binding will accept arbitrary band counts + boundaries, but the shell
panel always shows exactly 4 to keep the UI compact.

A future "Advanced" mode could expose the engine's actual band count
+ frequencies — out of scope for M3-P-NEXT-5.

---

## 5. Limiter panel bindings

| UI param       | Type    | Range          | Engine target                       |
|---|---|---|---|
| `targetLufs`   | number  | -24..-6 LUFS   | `engine.limiter.targetLufs` (also drives preset header) |
| `ceilingDbtp`  | number  | -3..0 dBTP     | `engine.limiter.ceiling`            |
| `lookaheadMs`  | number  | 0..20 ms       | `engine.limiter.lookahead`          |
| `character`    | enum    | 4-state        | `engine.limiter.character`          |
| `isp`          | boolean | —              | `engine.limiter.isp`                |
| `grDb` (read)  | number  | live           | `engine.limiter.grDb` (subscribe)   |

### Character mapping

The four characters map to engine presets the Rust limiter will
expose:

```
transparent → engine.limiter.style = 'transparent'
glue        → engine.limiter.style = 'glue'         (default)
aggressive  → engine.limiter.style = 'aggressive'
classic     → engine.limiter.style = 'classic'
```

The Python pipeline today only has one limiter style (akin to "glue").
M2-full's Rust limiter will gain the other three.  Until then, all
four cards write the same engine value — but the UI lets users see
that the choice exists.

---

## 6. Export panel bindings

| UI param       | Type    | Range          | Engine target                       |
|---|---|---|---|
| `format`       | enum    | 5 formats      | `export.format`                     |
| `sampleRate`   | enum    | 5 rates        | `export.sampleRate`                 |
| `bitDepth`     | enum    | 16 / 24 / 32   | `export.bitDepth`                   |
| `dither`       | enum    | 3 modes        | `export.dither`                     |
| Export button  | action  | —              | invokes `file:save-wav` IPC w/ descriptor `{ format, sampleRate, bitDepth, dither, src }` |

### IPC bridge (existing today)

```
window.electronAPI.invoke('file:save-wav', srcPath)
   → returns destPath | null
```

The current IPC accepts a source path only — format / SR / depth are
implied by the source.  Wire-up plan:

1. **Step 1**: Extend the IPC handler signature to accept an optional
   descriptor:
   ```
   file:save-wav(srcPath, descriptor?: ExportDescriptor) → destPath | null
   ```
2. **Step 2**: Add re-encoding paths in the main process for each
   format × sample-rate combination (ffmpeg already handles all of
   them).
3. **Step 3**: ExportParameterPanel constructs `descriptor` from local
   state, passes it through the export button's `onClick`.
4. **Step 4**: Remove the `comingSoon: true` default — show the export
   button in production.

This is the M3-P-NEXT-5 export work.  It's NOT in this milestone.

---

## 7. Live read subscriptions

The Imager / Dynamics / Limiter panels need three live reads when
wired:

| Panel    | Engine signal           | Subscription hook (proposed) |
|---|---|---|
| Dynamics | `engine.glueComp.grDb`  | `useEngineGr('glueComp', '30Hz')` |
| Imager   | `engine.stereo.correlation` | `useAnalyzerStream` (existing) |
| Limiter  | `engine.limiter.grDb`   | `useEngineGr('limiter', '30Hz')` |

The Imager correlation read is already supplied by the analyzer
stream (used by `StereoScopePanel`).  M3-P-NEXT-5 can route the same
session through `useWasmAnalyzerSession` into the Imager panel —
zero new subscription infrastructure.

The two new GR reads require engine-side instrumentation: the
mastering chain needs to emit per-stage gain-reduction snapshots at
30 Hz.  Tracked as **M2-full task** "expose live GR streams".

---

## 8. Write-side conflict resolution

When the user adjusts a UI parameter, the engine receives the write.
What about the reverse — when an adaptive engine changes a parameter
the user has "locked"?

Three policies, decided per parameter:

1. **One-way (UI → engine)** — user edits override engine.  Default
   for: every parameter except those flagged adaptive.
2. **Two-way mirror** — engine updates flow back into UI state.
   Default for: read-only meters (`grDb`, `correlation`).
3. **Adaptive-but-locked** — when `adaptive` is true, the engine
   drives the param; when the user moves the control, `adaptive`
   becomes false automatically.  Default for: EQ bands when
   `adaptive` is the toggle.

These policies will be implemented in `useEngineParameter` — out of
scope for M3-P-NEXT-4 but documented here so M3-P-NEXT-5 has a
contract.

---

## 9. Preset / target awareness

Some UI parameters echo preset values:

- ExportParameterPanel's "Normalize Target" section reads
  `targetLufs` / `targetTp` from the limiter panel's state (via
  ProductPage prop drilling today; will move to a store in
  M3-P-NEXT-5).
- LimiterParameterPanel's `targetLufs` is the same value the
  ProductPage preset header writes when the user picks a streaming
  target chip.

These cross-panel reads use ProductPage as the join point.  Future
refactor: lift parameter state out of panels into a
`useMasteringParameters` Zustand store, with the same engine-binding
contract.  Logged in `07-NEXT-STEPS.md`.

---

## 10. Audit trail (for M3-P-NEXT-5 implementer)

Every `onChange` handler in every panel has a comment block of the
form:

```ts
// TODO(M3-P-NEXT-5 binding):
//   • <UI param> → <engine target>
//   • <UI param> → <engine target>
```

Search the codebase for `TODO(M3-P-NEXT-5 binding)` to enumerate every
wire-up point in O(grep) time.  Counted on this milestone:

```
$ grep -rn "TODO(M3-P-NEXT-5 binding)" apps/desktop/src/renderer/components/product/
EqParameterPanel.tsx:        6 bindings
DynamicsParameterPanel.tsx:  6 bindings
ImagerParameterPanel.tsx:    4 bindings + 1 live read
LimiterParameterPanel.tsx:   6 bindings
ExportParameterPanel.tsx:    5 bindings
LouiKnob.tsx:                generic comment (replace onChange callers)
LouiSliderRow.tsx:           generic comment
─────────────────────────────────────
TOTAL                       27 explicit binding TODOs
```
