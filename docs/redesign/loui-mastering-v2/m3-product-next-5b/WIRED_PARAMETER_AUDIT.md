# M3-P-NEXT-5B — Wired Parameter Audit

> Precise inventory of every `wired` binding, with real connectability
> assessment per execution path.

---

## 0. Count correction

The M3-P-NEXT-5A summary tables stated "wired: 7".  That was a
**documentation error** — the actual `module-parameter-definitions.ts`
declares **11 wired parameter bindings**.  Verified:

```
$ grep -c "status: 'wired'"      module-parameter-definitions.ts   → 11
$ grep -c "status: 'pending'"    module-parameter-definitions.ts   → 17  (13 params + 4 bypass)
$ grep -c "status: 'unavailable'" module-parameter-definitions.ts  →  4  (3 export params + 1 export bypass)
```

Totals: 27 parameters + 5 module-bypass bindings = 32 bindings.
This audit supersedes the 5A "7 wired" figure.  The 5A docs will be
corrected when those statuses flip during wire-up.

---

## 1. The 11 wired parameters

| # | UI id | module | EngineSchema target | UI→engine conversion | Write today? | Preview reflect? | Offline reflect? |
|--:|---|---|---|---|---|---|---|
| 1 | `outputGainDb` | eq       | `gain-staging.targetPeakDb`   | direct        | staged | ✗ | patch-only |
| 2 | `adaptive`     | eq       | `adaptive-eq.bands[*].adaptive` | broadcast    | staged | ✗ | patch-only |
| 3 | `thresholdDb`  | dynamics | `bus-comp.thresholdDb`        | direct        | staged | ✗ | patch-only |
| 4 | `ratio`        | dynamics | `bus-comp.ratio`              | direct        | staged | ✗ | patch-only |
| 5 | `attackMs`     | dynamics | `bus-comp.attackMs`           | direct        | staged | ✗ | patch-only |
| 6 | `releaseMs`    | dynamics | `bus-comp.releaseMs`          | direct        | staged | ✗ | patch-only |
| 7 | `widthPct`     | imager   | `stereo-imager.width`         | `ui / 100`    | staged | ✗ | patch-only |
| 8 | `targetLufs`   | limiter  | `loudness-norm.targetLufs`    | direct (cross-module) | staged | ✗ | patch-only |
| 9 | `ceilingDbtp`  | limiter  | `limiter.ceilingDb`           | direct        | staged | ✗ | patch-only |
|10 | `isp`          | limiter  | `limiter.oversample`          | `bool→4|1`    | staged | ✗ | patch-only |
|11 | `lookaheadMs`  | limiter  | `limiter.lookAheadMs`         | direct        | staged | ✗ | patch-only |

Legend:
- **Write today** — `staged`: the dispatcher translates the value into
  an EngineSchema patch fragment and accumulates it.  NOT applied to
  live DSP.
- **Preview reflect** — whether changing the value re-renders the audio
  preview.  ✗ for all (preview is a pre-rendered file — see §3).
- **Offline reflect** — `patch-only`: the staged patch CAN drive a
  future offline re-render but no render is triggered in this milestone.

---

## 2. Why "staged" and not "applied"

There is **no live DSP write path** in the app today:

1. **Audio preview** is a pre-rendered MP3 (`masteringResult.previewPath`).
   The HTML `<audio>` element plays a static file.  Twisting an EQ knob
   cannot change it without re-rendering the whole master.

2. **TS realtime chain** (`audio/preset/runPreset.ts`) consumes a
   *bucketed* mode config, not live JSON parameter values.  Its own
   header documents this:
   > "the M1 TS chain ignores `mode` parameter customisation here —
   > processMasteringWithMode looks up MODE_CONFIGS[mode.mode] directly …
   > This is one of the gaps M2's Rust adapter must close (run the JSON
   > values, not the bucket)."

3. **Rust dsp-core** is analyzer-only (FFT / LUFS / TP / stereo).  It
   has NO mastering chain — forcing a DSP write here is explicitly
   out of scope (and forbidden by the brief).

4. **Python offline pipeline** runs once at mastering time via the audio
   IPC handlers.  It is not re-invokable on-demand from the product UI
   without a render trigger (M3-P-NEXT-5C work).

So the safe, honest 1st connection is **staging** — convert wired
parameters into an `EngineSchema` patch and accumulate it.  The patch
is the artifact a future render consumer (M3-P-NEXT-5C / M2-full) uses.

---

## 3. Per-path connectability

| Path | Live param write? | Verdict |
|---|---|---|
| Audio preview (`<audio>` + pre-rendered file) | No — static file       | Cannot reflect param changes without re-render |
| TS realtime chain (`runPreset`)               | No — bucket config only | Would need "run JSON values" rework (M2) |
| Rust dsp-core                                  | N/A — analyzer only     | Out of scope (no mastering DSP) |
| Python offline pipeline                        | Yes, at render time      | Patch → preset → re-invoke render = M3-P-NEXT-5C |

**Conclusion**: zero parameters are live-applicable today.  All 11
wired parameters are connected as far as **staging into a preset
patch**.  This is the maximum safe connection without DSP/pipeline
rework.

---

## 4. Cross-module write (parameter #8)

`limiter.targetLufs` is the only cross-module binding — it routes to the
**`loudness-norm`** EngineSchema module, not `limiter`.  The product UI
bundles loudness target + ceiling into one "Limiter" panel because users
think of them as one decision.  The dispatcher's binding lookup handles
the routing transparently (the binding's `moduleType` is `loudness-norm`).

---

## 5. Broadcast write (parameter #2)

`eq.adaptive` broadcasts to **every** `adaptive-eq` band's `adaptive`
flag.  The current PresetPatchDispatcher stages it as a single fragment
keyed `adaptive-eq:adaptive` — the M3-P-NEXT-5C patch consumer fans it
out to all bands.  This keeps the staged patch compact.

---

## 6. Value conversions in effect

Three of the 11 wired parameters need conversion (in
`engine-bridge/engine-dispatcher.ts` `toEngineValue`):

| Parameter | UI space | Engine space | Formula |
|---|---|---|---|
| `widthPct` | 0..200 % | 0..2.0 multiplier | `ui / 100` |
| `isp`      | boolean  | oversample factor | `true → 4`, `false → 1` |
| `adaptive` | boolean  | per-band flag     | broadcast (patch consumer fans out) |

The remaining 8 are direct passthroughs.

---

## 7. Validation before staging

The dispatcher only ever sees `ok` / `clamped` commands — the provider
skips dispatch for `rejected` ones.  So every staged value is already
in-range and step-aligned.  The dispatcher does NOT re-validate (the
provider's validator is authoritative); it only converts + stages.

When M3-P-NEXT-5C wires a real render, the render consumer SHOULD
re-validate against EngineSchema's own field constraints (defence in
depth) — see `05-M3-P-NEXT-5C-TASKLIST.md`.

---

## 8. Recommended wire-up order (M3-P-NEXT-5C)

Stage the live render in this order (lowest risk first):

1. **`limiter.ceilingDbtp` + `limiter.targetLufs`** — these are the most
   audible, most-tested mastering parameters; the Python pipeline
   already honours target LUFS + TP ceiling.
2. **`dynamics.*` (4 params)** — bus-comp params map 1:1 to the Python
   glue compressor.
3. **`imager.widthPct`** — stereo width is a single multiplier.
4. **`eq.outputGainDb` + `eq.adaptive`** — gain-staging + adaptive flag.
5. **`limiter.isp` + `limiter.lookaheadMs`** — oversample + lookahead;
   verify the Python limiter exposes these.

Each step: stage patch → build EnginePreset → re-invoke offline render →
swap the preview file.  See the task list doc.
