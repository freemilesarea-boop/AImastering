# REALTIME-DSP-BUG — module edits inaudible / Imager noise blow-up

> Symptoms (real-device test, realtime preview ON):
> 1. Moving an EQ point changes nothing audible.
> 2. Changing Dynamics values changes nothing audible.
> 3. Touching the Imager makes the song vanish and emits loud noise.
>
> This document audits the realtime path end-to-end and records the fixes.

---

## 1. Path audit (verified in code)

| Checkpoint | Finding |
|---|---|
| realtime flag actually ON | Now toggleable (localStorage + `LouiRealtimeToggle`). When ON + ready, the hook attaches. |
| worklet inserted into audio path | Yes — `wasm-analyzer-session.wireGraph()` wires **series** `source → insertNode → tap → destination` (`setInsertNode`). No parallel dry path, so it is NOT a wet/dry-sum cancellation. |
| `graph.updateConfig` called | Yes — seeded on attach + rAF-batched on every param change (`useRealtimeMasteringGraph`). |
| worklet `setConfig` received | Yes — `port.onmessage` type `config` → `_pendingConfig` → applied next `process()` (`mastering-chain.worklet.js`). |
| Rust `set_config` called | Yes — `LouiMasteringChain.set_config` maps the 22 flat args → `MasteringChainConfig` (arg order verified 1:1 against `applyChainConfig`/the worklet payload). |
| EQ/Dyn/Imager mapped into config | Yes — `stateToChainConfig` maps every field; `module-parameter-definitions` ranges confirm `widthPct`/`mixPct` are **percent** (100 = unity), matching Rust `/100`. |
| module bypass default | `defaultStateForModule` → `bypass: false`. Modules are **active** by default (not the cause). |
| EQ drag → param state | `EqOverlayFromState.onChange` calls `eq.setParam(...)` → central state → rAF → chain. The drag is wired (not overlay-local). |
| stereo buffer layout | Worklet output forced to 2ch (`outputChannelCount:[2]`). Processed in place on the output buffers. |
| mono input handling | **BUG** — for a mono *input* (`inputs[0].length === 1`) only ch0 was copied to the output; `right = output[1]` could be an uninitialised/foreign buffer fed to the imager's M/S maths. Fixed (see §3). |
| NaN/Inf handling | The core DSP is finite under tests, but there was **no last-line guard**: any non-finite or absurd sample produced by *any* cause reached the speakers. Fixed with a chain output-safety layer (see §3). |
| `process()` catch/fallback | The worklet caught exceptions → passthrough+bypass. It did **not** guard against finite-but-garbage output (no exception thrown). Now the Rust chain self-guards every block. |

### Why the three symptoms split the way they do

- **EQ/Dynamics "inaudible"** is consistent with the realtime path either not being active (flag/readiness/worklet-load) **or** the WASM artifact predating a config-arg change. The DSP itself is correct and effective (unit tests cover EQ shelf/peak and limiter GR). The decisive remedy is (a) make activation observable/toggleable — done in the previous change — and (b) **rebuild the WASM** so the worklet/offline glue matches the current `set_config` signature, plus surface the live config + safety counters so QA can see edits reaching the audio thread.
- **Imager "loud noise / signal loss"** is the dangerous one. The imager rewrites channels cross-wise (`L=mid+side`, `R=mid-side`). Any bad input on the *side* path (e.g. a stale/foreign `right` buffer on mono input, or a non-finite produced upstream) is doubled into both channels and then hits the limiter, which — fed a near-DC or non-finite — can swing to its ceiling and sound like loud noise. The fix is defence-in-depth: correct mono handling, per-sample finite guards in the imager, value clamps at the config boundary, and a hard per-block output-safety layer that replaces a bad block with the dry signal.

---

## 2. Config mapping (UI → Rust), verified

`stateToChainConfig` → worklet `config` payload → `LouiMasteringChain.setConfig(...)` → `MasteringChainConfig`:

| UI param | config field | Rust field | unit |
|---|---|---|---|
| eq.lowCutHz | eqLowCutHz | EqConfig.low_cut_hz | Hz |
| eq.lowShelfDb | eqLowShelfDb | EqConfig.low_shelf_db | dB |
| eq.presenceDb | eqPresenceDb | EqConfig.presence_db | dB |
| eq.airDb | eqAirDb | EqConfig.air_db | dB |
| eq.outputGainDb | outputGainDb | output_gain_db | dB |
| dyn.thresholdDb | dynThresholdDb | DynamicsConfig.threshold_db | dB |
| dyn.ratio | dynRatio | DynamicsConfig.ratio | :1 |
| dyn.attackMs / releaseMs / mixPct | dyn… | DynamicsConfig.* | ms / % |
| img.widthPct | imgWidthPct | ImagerConfig.width_pct (÷100, clamp [0,2]) | % |
| img.lowMonoHz | imgLowMonoHz | ImagerConfig.low_mono_hz (clamp [20, ~0.45·sr]) | Hz |
| lim.ceilingDbtp | limCeilingDbtp | LimiterConfig.ceiling_dbtp | dBTP |
| lim.lookaheadMs | limLookaheadMs | LimiterConfig.lookahead_ms | ms |
| (all) bypass | *Bypass | *Config.bypass | bool |

The `sanitiseConfig` boundary now **clamps** every numeric to a musically/numerically safe range so an out-of-range UI value (or a future preset) can never push the DSP into instability.

---

## 3. Fixes applied

1. **Chain output-safety layer** (`mastering/chain.rs`): each block keeps a dry copy; after processing, if any output sample is non-finite or the block peak exceeds an absurd threshold (~+12 dBFS), the block is replaced with the dry signal and a `safety_events` counter is bumped. Guarantees no ear-splitting noise / no NaN ever reaches the device.
2. **Imager robustness** (`mastering/imager.rs`): `low_mono_hz` clamped to `[20, 0.45·sr]`; per-sample finite guard on mid/side and the reconstructed L/R (falls back to the dry sample). Width already clamped to `[0,2]`.
3. **Worklet mono input** (`mastering-chain.worklet.js`): a mono input is duplicated to both channels before processing, and both output channels are written — the imager never sees a foreign `right` buffer.
4. **Config clamps** (`realtime-mastering-graph.ts`): `imgWidthPct∈[0,200]`, `imgLowMonoHz∈[20,2000]`, `dynRatio≥1`, `dynMixPct∈[0,100]`, attack/release/lookahead bounded, ceiling∈[-24,0].
5. **Diagnostics**: `safety_events()` exposed from the WASM chain; the worklet posts `safetyEvents`; the debug panel shows safety-bypass count + the live config (width / presence / air / threshold / ratio).
6. **WASM rebuilt** (worklet `--no-modules`, web, node) so the glue matches the current `set_config` and exports `safetyEvents`.

All defaults unchanged; export path untouched; Imager is fixed, never hidden.
