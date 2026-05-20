# M3-P-NEXT-5B — Preview / Offline Render Feasibility Report

> Can wired parameters reflect in the audio preview or an offline
> re-render today?  Findings + the minimal path forward.

---

## 1. Executive summary

| Path | Live reflect today? | Effort to enable | Risk |
|---|---|---|---|
| Audio preview (`<audio>` + pre-rendered file) | **No** | High (needs re-render-on-change) | Med |
| TS realtime chain (`runPreset`)               | **No** | High (run JSON values, not bucket) | High (M2) |
| Rust dsp-core                                  | **N/A** | N/A (analyzer only) | Out of scope |
| Python offline pipeline                        | **Not on-demand** | Med (patch → preset → re-invoke) | Med |

**Decision**: implement staging only (done in M3-P-NEXT-5B).  Defer
live preview reflection to M3-P-NEXT-5C and document the path here.

---

## 2. Audio preview path

### How it works today

ResultPage / ProductPage play `masteringResult.previewPath` — a 320 kbps
MP3 rendered once by the Python pipeline at mastering time.  The
`<audio>` element streams the static file.

### Why it can't reflect param changes

Changing an EQ band in the UI cannot alter a pre-rendered MP3.  To
reflect a change, the app would have to:

1. Build a new preset from the staged patch
2. Re-render the master (Python pipeline)
3. Swap the `<audio src>` to the new file
4. Resume playback at the same position

That's the M3-P-NEXT-5C "offline re-render" feature — feasible but out
of scope for this milestone.

### Live (real-time) alternative

A true real-time preview (apply DSP to the playing buffer) would need a
mastering DSP graph in the browser.  The Rust dsp-core is analyzer-only;
M2-full's Rust mastering chain (compiled to WASM) is the eventual home.
Until then, real-time preview is not possible.

---

## 3. TS realtime chain (`runPreset`)

### Finding

`audio/preset/runPreset.ts` runs the TS mastering chain but **ignores
parameter customisation** — its own comment:

> "the M1 TS chain ignores `mode` parameter customisation here —
> processMasteringWithMode looks up MODE_CONFIGS[mode.mode] directly …
> This is one of the gaps M2's Rust adapter must close (run the JSON
> values, not the bucket)."

So even if we fed `runPreset` a patched preset, it would render the
**bucket** (mode preset), not our per-parameter values.

### Effort to enable

Reworking `processMasteringWithMode` to honour live JSON parameters is a
significant DSP-runtime change (M2 territory).  Explicitly out of scope
("Python pipeline 대규모 변경 금지", "Rust EQ/comp/limiter 신규 구현 금지").

---

## 4. Rust dsp-core

Analyzer only — FFT / LUFS / true-peak / stereo correlation.  No EQ,
compressor, limiter, or imager.  Forcing a mastering write here is
forbidden by the brief and architecturally wrong (dsp-core's contract is
measurement, not processing).

M2-full will add a separate `loui-mastering` Rust crate.  That is where
live param writes eventually land.

---

## 5. Python offline pipeline

### How it works today

The Python pipeline runs once, triggered through the audio IPC handlers
at mastering time.  It produces the master WAV + preview MP3 + analysis
report.

### Re-invocation feasibility

The pipeline CAN be re-invoked with a different preset.  The pieces
exist:

- `EnginePreset` JSON v1 schema (`@aimaster/shared-types/engine`)
- The Python adapter consumes `EnginePreset` (M1 work)
- `runPreset` (TS) + the Python adapter both accept a preset

What's missing for on-demand re-render:

1. A **patch → EnginePreset builder** — merge staged fragments into the
   base preset that produced the current master
2. A **render IPC trigger** callable from the product UI
3. **Debouncing** — coalesce rapid knob turns into one re-render
4. **Preview swap** — replace `<audio src>` + resume position

These are M3-P-NEXT-5C deliverables.  None require DSP/Rust changes —
they orchestrate the existing Python render.

---

## 6. The staged patch — what we built instead

The `PresetPatchDispatcher` accumulates wired-parameter changes as
EngineSchema fragments:

```ts
getStagedPatch(): StagedPatchEntry[]
// e.g.
[
  { moduleType: 'bus-comp',      path: 'thresholdDb', value: -18,  sourceModuleId: 'dynamics', sourceParameterId: 'thresholdDb' },
  { moduleType: 'limiter',       path: 'ceilingDb',   value: -1.5, sourceModuleId: 'limiter',  sourceParameterId: 'ceilingDbtp' },
  { moduleType: 'stereo-imager', path: 'width',       value: 1.3,  sourceModuleId: 'imager',   sourceParameterId: 'widthPct' },
  { moduleType: 'loudness-norm', path: 'targetLufs',  value: -12,  sourceModuleId: 'limiter',  sourceParameterId: 'targetLufs' },
]
```

This is the **exact input** the M3-P-NEXT-5C patch→preset builder will
consume.  By staging now, we make the render trigger a pure
orchestration task later — no re-translation, no re-validation of UI
values.

---

## 7. Recommended M3-P-NEXT-5C minimal path

Lowest-risk way to make ONE parameter audibly reflect:

1. Pick `limiter.targetLufs` (Python honours it natively).
2. Build a preset = base preset + `{ loudness-norm.targetLufs: staged }`.
3. Add an IPC `audio:re-render-preview(preset)` that re-runs the Python
   pipeline and returns a new preview path.
4. Debounce 500 ms after the last change.
5. Swap `<audio src>`, resume at the prior `currentTime`.

Prove the loop with one parameter, then extend to the other 10 wired
ones.  Full plan in `05-M3-P-NEXT-5C-TASKLIST.md`.

---

## 8. Risk register

| Risk | Mitigation |
|---|---|
| Re-render latency (seconds) breaks UX  | Debounce + show "re-rendering…" state; keep last preview playing |
| Concurrent re-renders pile up          | Cancel in-flight render on new change |
| Patch drifts from the base preset      | Always rebuild from the base + full patch, never incremental |
| Python pipeline change breaks V1       | Re-render is a NEW IPC path; V1 mastering untouched |
| Preview swap loses playback position   | Capture `currentTime` before swap, restore after `loadedmetadata` |

All deferred to M3-P-NEXT-5C — this milestone ships only the staging
seam, which carries none of these risks.
