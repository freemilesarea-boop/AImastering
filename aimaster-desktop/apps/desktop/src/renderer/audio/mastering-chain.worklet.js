// mastering-chain.worklet.js — realtime mastering preview (M2-full).
//
// PROTOTYPE (device-test gated).  Unlike the analyzer tap (which copies
// audio to the main thread for *analysis*), the mastering chain must
// PROCESS the signal inline before it reaches the destination — so the
// Rust MasteringChain WASM runs INSIDE this AudioWorkletProcessor (the
// audio thread), with no main-thread round-trip.
//
// WASM loading
// ────────────────────────────────────────────────────────────────────
//   AudioWorkletGlobalScope has no `fetch`/`import`.  The main thread
//   passes the compiled WASM module + the no-modules wasm-bindgen glue
//   source via `processorOptions`:
//     { wasmModule: WebAssembly.Module, sampleRate, glue: string }
//   The worklet instantiates synchronously (no await on the audio thread).
//
//   NOTE: this requires a `wasm-bindgen --target no-modules` build of
//   loui-dsp-wasm (the renderer uses the `--target web` build).  Adding
//   that second build target is the remaining build-system step before
//   the realtime flag can ship — see ROLLOUT_RECOMMENDATION.md.  Until
//   then this processor degrades to a safe passthrough (audio is never
//   silenced) and the app uses the re-render preview.
//
// Realtime-safety
//   * No allocation in `process()` steady state (chain buffers reused).
//   * No locks, no Promise, no exceptions on the audio thread.
//   * Parameter updates arrive via port messages and are applied between
//     blocks (setConfig only recomputes coefficients — no alloc).
//   * Metrics are posted every METRIC_INTERVAL blocks (cheap numbers).

/* global registerProcessor, AudioWorkletProcessor, sampleRate, currentTime */
/* eslint-disable */

const METRIC_INTERVAL = 64; // post metrics every N blocks

class MasteringChainProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this._ready = false;
    this._chain = null;
    this._bypass = true;          // safe default until configured
    this._pendingConfig = null;

    // Metrics state.
    this._sumMs = 0;
    this._peakMs = 0;
    this._xruns = 0;
    this._blockCount = 0;
    this._blockPeriodMs = (128 / sampleRate) * 1000;
    this._grDb = 0;

    // Attempt to instantiate the WASM chain from processorOptions.
    // If the no-modules glue / module isn't provided, we stay in safe
    // passthrough mode (this._ready = false).
    try {
      const opts = (options && options.processorOptions) || {};
      if (opts.wasmModule && typeof globalThis.__loui_init_mastering === 'function') {
        // `__loui_init_mastering` is provided by the no-modules glue the
        // main thread evaluates into this scope before construction.
        this._chain = globalThis.__loui_init_mastering(opts.wasmModule, sampleRate);
        this._ready = !!this._chain;
      }
    } catch (e) {
      this._ready = false;
    }

    this.port.onmessage = (ev) => {
      const msg = ev.data;
      if (!msg) return;
      if (msg.type === 'config') {
        this._pendingConfig = msg.config;
        this._bypass = !!msg.config && msg.config.masterBypass === true;
      } else if (msg.type === 'bypass') {
        this._bypass = !!msg.bypass;
      } else if (msg.type === 'reset') {
        if (this._ready && this._chain && this._chain.reset) this._chain.reset();
      }
    };
  }

  _applyPendingConfig() {
    if (!this._ready || !this._chain || !this._pendingConfig) return;
    const c = this._pendingConfig;
    this._pendingConfig = null;
    try {
      this._chain.setConfig(
        c.inputGainDb,
        c.eqLowCutHz, c.eqLowShelfDb, c.eqPresenceDb, c.eqAirDb, c.eqAdaptive, c.eqBypass,
        c.dynThresholdDb, c.dynRatio, c.dynAttackMs, c.dynReleaseMs, c.dynMixPct, c.dynBypass,
        c.imgWidthPct, c.imgLowMonoHz, c.imgBypass,
        c.limCeilingDbtp, c.limLookaheadMs, c.limIsp, c.limBypass,
        c.outputGainDb, c.masterBypass,
      );
    } catch (e) {
      // A bad config must never crash the audio thread → drop to bypass.
      this._bypass = true;
    }
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0 || !output || output.length === 0) {
      return true;
    }

    const chans = Math.min(input.length, output.length);
    // Always start by copying input → output (safe passthrough).
    for (let c = 0; c < chans; c++) {
      const inCh = input[c];
      const outCh = output[c];
      if (inCh && outCh && inCh.length === outCh.length) outCh.set(inCh);
    }

    // Passthrough when not ready or bypassed.
    if (!this._ready || this._bypass || !this._chain) {
      return true;
    }

    this._applyPendingConfig();

    // Process stereo in place on the OUTPUT buffers (already a copy of input).
    const left = output[0];
    const right = output.length > 1 ? output[1] : output[0];
    const t0 = currentTime;
    try {
      this._chain.processStereo(left, right);
      if (this._chain.limiterGrDb) this._grDb = this._chain.limiterGrDb();
    } catch (e) {
      // On any process error: restore passthrough for this block + bypass.
      for (let c = 0; c < chans; c++) {
        if (input[c] && output[c]) output[c].set(input[c]);
      }
      this._bypass = true;
      return true;
    }
    const dtMs = (currentTime - t0) * 1000;

    // Metrics.
    this._sumMs += dtMs;
    if (dtMs > this._peakMs) this._peakMs = dtMs;
    if (dtMs > this._blockPeriodMs) this._xruns++;
    this._blockCount++;
    if (this._blockCount >= METRIC_INTERVAL) {
      this.port.postMessage({
        type: 'metrics',
        avgProcessMs: this._sumMs / this._blockCount,
        peakProcessMs: this._peakMs,
        blockPeriodMs: this._blockPeriodMs,
        xruns: this._xruns,
        limiterGrDb: this._grDb,
      });
      this._sumMs = 0; this._peakMs = 0; this._xruns = 0; this._blockCount = 0;
    }

    return true;
  }
}

registerProcessor('loui-mastering-chain', MasteringChainProcessor);
