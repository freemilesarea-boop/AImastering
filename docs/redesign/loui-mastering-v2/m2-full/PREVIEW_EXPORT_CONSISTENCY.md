# M2-full-G — Preview / Export Consistency Policy

> The realtime Rust preview and the Python offline export are different
> engines.  This is the contract for how close they must be + how
> divergence is surfaced.

---

## 1. Two engines, one source of truth

| | Realtime preview | Final export |
|---|---|---|
| Engine | Rust MasteringChain (WASM) | Python offline pipeline |
| Latency | low (per-block, live) | seconds (offline render) |
| Quality | approximation | high-quality |
| Params honoured | all 13 audio params (flag-gated) | targetLufs/targetTp/width/gain (+SR/bitDepth/format) |
| Source of truth | the SAME EnginePreset / parameter state |

Both read the SAME parameter values.  Only the processing engine
differs.  The preview is explicitly a **low-latency approximation** — it
is NOT expected to be sample-identical to the export.

---

## 2. What MUST match

| Property | Requirement |
|---|---|
| Parameter mapping | identical ids → identical semantic meaning |
| Loudness target direction | both move toward the chosen target LUFS |
| Ceiling | both keep true-peak under the chosen ceiling |
| Width | both apply the same width direction |
| Tone direction | EQ moves the same way (preview-only params: preview reflects, export doesn't yet) |

---

## 3. What MAY differ (bounded)

| Property | Acceptable divergence | Why |
|---|---|---|
| Exact sample values | not identical | different algorithms |
| Limiter character | preview = safe limiter; export = Python limiter | preview is a glue/safe limiter |
| EQ curve | preview = fixed-band biquads; export = adaptive Python EQ | preview is "gentle tone shaping" |
| Dynamics | preview = single-band; export = Python dynamics | preview is lightweight |
| LUFS (integrated) | within ~1.5 LU | metering + algorithm differences |

---

## 4. Divergence warning

When A/B comparing (M3-O-NEXT-7) or after a re-render, if the measured
preview loudness diverges from the export target by more than the
tolerance, the UI should warn:

> Preview is an approximation — the exported file may differ slightly.

(Surfaced via the existing preview-strip / A/B LU-match readout; a hard
warning threshold is a follow-up.)

---

## 5. Parity metrics (fixture-based)

To validate parity, run the SAME EnginePreset through both engines on a
fixture set and compare:

| Metric | Tolerance |
|---|---|
| Integrated LUFS | ≤ 1.5 LU |
| True peak | ≤ 0.5 dB |
| Spectral tilt (low/mid/high) | ≤ 2 dB |
| Stereo width index | ≤ 0.1 |

The cross-language equivalence harness
(`apps/desktop/scripts/dsp-equivalence-compare.ts`) is the home for this
comparison.  Extending it to diff Rust-preview vs Python-export is a
follow-up (needs the realtime chain runnable headless — the WASM is
node-loadable via @loui/dsp-wasm).

Not run in this milestone (no audio fixtures + engine in the sandbox);
the contract + tolerances are fixed here so the harness has targets.

---

## 6. Consistency guarantees in code

| Guarantee | Mechanism |
|---|---|
| Same parameter ids | `stateToChainConfig` + `buildExportOverride` read the same state |
| Same defaults | both derive from `module-parameter-definitions.ts` |
| Preview ≠ export is expected | documented; A/B + LU-match surface loudness gaps |
| Export is authoritative for delivery | export always = Python offline render |

---

## 7. Policy summary

1. **Preview = approximation, Export = authoritative.**
2. Both consume the same EnginePreset / parameter state.
3. Bounded divergence is expected + documented.
4. Excessive divergence → warning (loudness via LU-match today).
5. A parameter is only "export-renderable" when BOTH engines honour it
   (see STAGED_ONLY_PARAMETER_AUDIT.md).
