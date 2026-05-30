# M3-P-NEXT-5A — Parameter ↔ EngineSchema Mapping

> How UI parameter ids resolve to `EngineSchema` (preset v1) module
> parameter paths.  Source of truth for the M3-P-NEXT-5B dispatcher.

---

## 1. EngineSchema reference

The canonical schema (`@aimaster/shared-types/engine`) defines a chain
of typed modules:

```
source · gain-staging · adaptive-eq · dynamic-eq · multiband-eq ·
bus-comp · transient-protection · vocal-enhancer · saturator ·
stereo-imager · deesser · loudness-norm · soft-clip · limiter ·
isp-safety · dither · sink
```

The product layout exposes 5 user-facing modules (EQ / Dynamics /
Imager / Limiter / Export).  Each maps to one or more EngineSchema
modules in the chain.

---

## 2. EQ — `'eq'` ↔ `adaptive-eq` + `gain-staging`

| UI parameter | UI value space | EngineSchema target | Conversion |
|---|---|---|---|
| `lowCutHz`     | 20..120 Hz       | `adaptive-eq.bands[id='lowCut'].freqHz`     | direct |
| `lowShelfDb`   | -6..+6 dB        | `adaptive-eq.bands[id='lowShelf'].gainDb`   | direct |
| `presenceDb`   | -6..+6 dB        | `adaptive-eq.bands[id='presence'].gainDb`   | direct |
| `airDb`        | -6..+6 dB        | `adaptive-eq.bands[id='air'].gainDb`        | direct |
| `outputGainDb` | -12..+12 dB      | `gain-staging.targetPeakDb`                  | direct |
| `adaptive`     | boolean          | `adaptive-eq.bands[*].adaptive`              | broadcast to every band's `adaptive` flag |

**Band identity** — the four bands are identified by `band.id` strings
(`lowCut`, `lowShelf`, `presence`, `air`).  The dispatcher finds the
band via `bands.find(b => b.id === id)` and writes the field.

**Missing bands** — if an `adaptive-eq` module has no band with the
expected id, the dispatcher creates one with the default filter type
+ Q (documented in `02-PARAMETER-DEFINITIONS.md`).

**Implementation note** — current `adaptive-eq` modules in the preset
JSON may not have all four bands.  M3-P-NEXT-5B will ensure the
default preset shipped by the Python pipeline includes them.

---

## 3. Dynamics — `'dynamics'` ↔ `bus-comp`

| UI parameter | UI value space | EngineSchema target | Conversion |
|---|---|---|---|
| `thresholdDb` | -30..0 dB    | `bus-comp.thresholdDb` | direct |
| `ratio`       | 1..10        | `bus-comp.ratio`       | direct |
| `attackMs`    | 0.1..100 ms  | `bus-comp.attackMs`    | direct |
| `releaseMs`   | 10..1000 ms  | `bus-comp.releaseMs`   | direct |
| `mixPct`      | 0..100 %     | `bus-comp.mixPct`      | direct — **field is pending** (see § 8) |

**Missing fields** — `bus-comp.mixPct` is not in EngineSchema today.
M2-full plans to add it (parallel-mix is a glue-comp staple).  Until
then, the dispatcher ignores `mixPct` writes (logs an `'unsupported'`
adapter entry).

---

## 4. Imager — `'imager'` ↔ `stereo-imager`

| UI parameter | UI value space | EngineSchema target | Conversion |
|---|---|---|---|
| `widthPct`        | 0..200 %  | `stereo-imager.width`            | `engine = ui / 100` (100→1.0, 0→0, 200→2.0) |
| `lowMonoHz`       | 20..400 Hz| `stereo-imager.lowMonoFrequency` | direct — **field is pending** |
| `stereoize`       | boolean   | `stereo-imager.stereoize`        | direct — **field is pending** |
| `bandLowPct`      | 0..200 %  | `stereo-imager.bands[0].width`   | `engine = ui / 100` — **bands field pending** |
| `bandMidLowPct`   | 0..200 %  | `stereo-imager.bands[1].width`   | (same) |
| `bandMidHighPct`  | 0..200 %  | `stereo-imager.bands[2].width`   | (same) |
| `bandHighPct`     | 0..200 %  | `stereo-imager.bands[3].width`   | (same) |

**Width conversion** — UI keeps a percentage view (familiar to mastering
engineers — 100 % = passthrough); engine takes a 0..2.0 multiplier.
The dispatcher applies the divide-by-100 at write time.

**Missing fields** — `lowMonoFrequency`, `stereoize`, `bands[]` are all
pending engine additions tracked in `06-FUTURE-M2-FULL-CHECKLIST.md`.

---

## 5. Limiter — `'limiter'` ↔ `limiter` + `loudness-norm`

| UI parameter | UI value space | EngineSchema target | Conversion |
|---|---|---|---|
| `targetLufs`    | -24..-6 LUFS | `loudness-norm.targetLufs`            | direct — **cross-module write** |
| `ceilingDbtp`   | -3..0 dBTP   | `limiter.ceilingDb`                    | direct |
| `isp`           | boolean      | `limiter.oversample`                   | `true → 4`, `false → 1` |
| `lookaheadMs`   | 0..20 ms     | `limiter.lookAheadMs`                  | direct |
| `character`     | 4-state enum | `limiter.character`                    | direct — **field is pending** |

**Cross-module write** — `targetLufs` lives on `loudness-norm`, not
`limiter`.  The product UI bundles both into one "Limiter" panel
because the user thinks of them as one decision (loudness + ceiling).
The dispatcher routes the write to the correct EngineSchema module.

**Character mapping** — when M2-full adds `limiter.character`, the four
UI values map 1:1 to engine values.  Until then, all four UI values
map to today's single Python limiter (an `adapter.log` entry records
the no-op for `transparent` / `aggressive` / `classic`).

---

## 6. Export — `'export'` ↔ render-stage, not DSP

| UI parameter | UI value space | EngineSchema target | Conversion |
|---|---|---|---|
| `format`     | wav/flac/mp3/aiff/ogg | `EnginePresetOutput.format`   | direct |
| `sampleRate` | 44100/48000/88200/96000/192000 | `EnginePresetOutput.sampleRate` | parseInt |
| `bitDepth`   | 16/24/32             | `EnginePresetOutput.bitDepth`    | parseInt |
| `dither`     | none/tpdf/shaped     | `dither.algorithm` (separate engine module) | direct |

**Two-tier routing** — format / sampleRate / bitDepth set
`EnginePreset.output` (the top-level output descriptor).  `dither`
configures the `dither` engine module in the chain (currently no-op).

**Today's IPC** — `file:save-wav(srcPath)` accepts only a source path.
M3-P-NEXT-5B extends it to `file:save-wav(srcPath, descriptor?)` where
descriptor is the four-field shape from `EXPORT_DESCRIPTOR_UPDATE`.

---

## 7. Bypass routing

Each module's bypass flag maps to its primary EngineSchema module's
`bypass` field (which doesn't exist today — also a pending addition):

| Module    | EngineSchema bypass target | Status |
|---|---|---|
| eq        | `adaptive-eq.bypass`        | pending |
| dynamics  | `bus-comp.bypass`           | pending |
| imager    | `stereo-imager.bypass`      | pending |
| limiter   | `limiter.bypass`            | pending (with warning — see § 9) |
| export    | n/a                         | unavailable (export is render-stage) |

When `bypass=true`, the dispatcher will set the per-module bypass flag
in EngineSchema once the field lands.  Until then, bypass is logged
but has no engine effect.

---

## 8. Pending engine fields (M2-full additions)

Eleven fields are referenced in the binding map but don't exist in
EngineSchema today.  M2-full adds them:

| EngineSchema target | Why needed |
|---|---|
| `*.bypass` (5×)                        | Per-module bypass |
| `bus-comp.mixPct`                       | Parallel-mix glue comp |
| `stereo-imager.lowMonoFrequency`        | Low-frequency mono fold-down |
| `stereo-imager.stereoize`               | Synthetic mono → stereo spread |
| `stereo-imager.bands[]`                 | Per-band width array |
| `limiter.character`                     | 4-style limiter taxonomy |

A single PR against `packages/shared-types/src/engine/modules.ts` adds
the eight new fields (4 pending bypasses + 4 functional).  Tracked in
`06-FUTURE-M2-FULL-CHECKLIST.md`.

---

## 9. Decisions made

### Should export parameters live in EngineSchema or separately?

**Decision**: separately.  Export is not a DSP module — it's a
render-stage decision.  The four export parameters write to
`EnginePreset.output` (existing top-level field) and `dither.algorithm`
(separate DSP module).

**Why not bundle export into EngineSchema modules?**  Mixing
render-stage concerns into module parameters would:
- Conflate concerns (dither IS a DSP step; format/SR/depth are not)
- Force every adapter to handle export-stage decisions
- Block format-only changes (file format swap) from being trivial

### Should LimiterParameterPanel's targetLufs surface as a Limiter or Loudness module write?

**Decision**: cross-module write to `loudness-norm`.  Users perceive
"target loudness" and "ceiling" as one knob group — bundling them in
the Limiter panel matches user mental model.  The dispatcher hides
the routing detail.

This is the **first cross-module binding** in the contract.  Future
panels may need similar fan-out (e.g. a "Tone" panel writing across
EQ + Multiband EQ + Saturator).

### Should the `adaptive` toggle broadcast to all EQ bands or set a top-level flag?

**Decision**: broadcast to every band's `adaptive` flag.  EngineSchema
has per-band `adaptive` (not a top-level module flag), so the
dispatcher iterates the bands array.

Future: if EngineSchema gains a top-level `adaptive-eq.adaptive`
field, the dispatcher switches to writing that single field instead.
No UI change.

---

## 10. Migration checklist for M3-P-NEXT-5B

When wire-up starts, work the binding table in this order:

1. **`wired`** parameters first (7 total) — they have working adapter
   paths.  Drop-in writes.
2. **`pending`** parameters — bundle with the M2-full EngineSchema
   additions.  One PR per module.
3. **`unavailable`** parameters — defer until export pipeline rework.

Each write should:
- Receive the `SetModuleParamCommand`
- Re-validate against the EngineSchema field's own constraints
  (defence in depth)
- Apply via `engine.applyParam(moduleId, parameterId, value)`
- Emit an `AdapterAck` event on success (echo back to UI) or
  `AdapterClamp` on adapter-side range adjustment

`07-NEXT-STEPS.md` enumerates the full implementer's punch list.
