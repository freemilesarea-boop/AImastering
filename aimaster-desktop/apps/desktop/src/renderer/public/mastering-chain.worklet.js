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
//   The `wasm-bindgen --target no-modules` build now ships the glue +
//   `.wasm` as worklet-loadable assets (build-wasm-worklet.sh →
//   src/renderer/public/).  The main thread compiles the module and
//   loads the glue via `mastering-worklet-loader.ts`; the glue's appended
//   bootstrap defines `globalThis.__loui_init_mastering`.  If the assets
//   are absent or init throws, this processor degrades to a safe
//   passthrough (audio is never silenced) and the app uses the re-render
//   preview.  The realtime flag stays OFF until device tests pass.
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
    this._dynGrDb = 0;        // dynamics (compressor) gain reduction, last block
    this._safetyEvents = 0;   // chain output-safety bypasses (non-finite/absurd)
    this._processCalls = 0;   // total process() invocations
    this._audioBlocks = 0;    // process() calls with a non-empty input
    this._nonSilentBlocks = 0; // input blocks that carried real signal

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
      } else if (msg.type === 'multiband') {
        // Guarded: setMultibandConfig exists only on wasm artifacts rebuilt
        // after the binding landed.  On older artifacts this is a no-op.
        if (this._ready && this._chain && typeof this._chain.setMultibandConfig === 'function') {
          try {
            this._chain.setMultibandConfig(
              !!msg.bypass, msg.lo, msg.mid, msg.hi,
              msg.thresholds, msg.ratios, msg.attacks, msg.releases, msg.makeups,
            );
          } catch (e) { /* keep audio alive */ }
        }
      } else if (msg.type === 'imagerMultiband') {
        if (this._ready && this._chain && typeof this._chain.setImagerMultiband === 'function') {
          try {
            this._chain.setImagerMultiband(!!msg.enabled, msg.lo, msg.mid, msg.hi, msg.widths);
          } catch (e) { /* keep audio alive */ }
        }
      } else if (msg.type === 'saturation') {
        if (this._ready && this._chain && typeof this._chain.setSaturation === 'function') {
          try {
            this._chain.setSaturation(
              !!msg.bypass, msg.character | 0, msg.drive, msg.mix, !!msg.multiband,
              msg.lo, msg.mid, msg.hi, msg.bandDrives,
            );
          } catch (e) { /* keep audio alive */ }
        }
      } else if (msg.type === 'transient') {
        if (this._ready && this._chain && typeof this._chain.setTransient === 'function') {
          try {
            this._chain.setTransient(
              !!msg.bypass, msg.attack, msg.sustain, !!msg.multiband,
              msg.lo, msg.mid, msg.hi, msg.bandAttacks, msg.bandSustains,
            );
          } catch (e) { /* keep audio alive */ }
        }
      } else if (msg.type === 'dyneq') {
        if (this._ready && this._chain && typeof this._chain.setDynamicEqBands === 'function') {
          try {
            this._chain.setDynamicEqBands(
              !!msg.bypass, msg.enableds, msg.types, msg.freqs, msg.qs,
              msg.thresholds, msg.ratios, msg.attacks, msg.releases, msg.ranges, msg.modes,
            );
          } catch (e) { /* keep audio alive */ }
        }
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

    // Honest telemetry: count every process() call + whether real audio is
    // arriving, so the debug panel can tell "not attached" (no calls) from
    // "playing but silent" from "processing".
    this._processCalls++;
    const outChans = output.length;
    const inChans = input.length;
    const in0 = inChans > 0 ? input[0] : null;
    if (in0 && in0.length > 0) {
      this._audioBlocks++;
      // Cheap non-silence probe (sample a few points; avoids a full scan).
      let nonSilent = false;
      const step = Math.max(1, (in0.length / 8) | 0);
      for (let i = 0; i < in0.length; i += step) {
        if (in0[i] !== 0) { nonSilent = true; break; }
      }
      if (nonSilent) this._nonSilentBlocks++;
    }

    // Always start by copying input → output (safe passthrough).  A MONO
    // input is duplicated to every output channel so the stereo chain (esp.
    // the imager's M/S maths) never sees an uninitialised/foreign buffer.
    for (let c = 0; c < outChans; c++) {
      const inCh = inChans > 0 ? (input[c] || input[0]) : null;
      const outCh = output[c];
      if (inCh && outCh && inCh.length === outCh.length) outCh.set(inCh);
    }

    const processing = this._ready && !this._bypass && this._chain;
    if (processing) {
      this._applyPendingConfig();

      // Process stereo in place on the OUTPUT buffers (already a copy of
      // input).  For a single-channel output we hand the chain a scratch
      // right channel so it never aliases left (the writeback would
      // otherwise clobber it).
      const left = output[0];
      let right;
      if (outChans > 1) {
        right = output[1];
      } else {
        if (!this._monoScratch || this._monoScratch.length !== left.length) {
          this._monoScratch = new Float32Array(left.length);
        }
        this._monoScratch.set(left);
        right = this._monoScratch;
      }
      const t0 = currentTime;
      try {
        this._chain.processStereo(left, right);
        if (this._chain.limiterGrDb) this._grDb = this._chain.limiterGrDb();
        if (this._chain.dynamicsGrDb) this._dynGrDb = this._chain.dynamicsGrDb();
        if (this._chain.safetyEvents) this._safetyEvents = this._chain.safetyEvents();
      } catch (e) {
        // On any process error: restore passthrough for this block + bypass.
        for (let c = 0; c < outChans; c++) {
          const inCh = inChans > 0 ? (input[c] || input[0]) : null;
          if (inCh && output[c]) output[c].set(inCh);
        }
        this._bypass = true;
        this._postMetrics();
        return true;
      }
      const dtMs = (currentTime - t0) * 1000;
      this._sumMs += dtMs;
      if (dtMs > this._peakMs) this._peakMs = dtMs;
      if (dtMs > this._blockPeriodMs) this._xruns++;
    }

    // Post telemetry every window REGARDLESS of passthrough, so the panel
    // sees process activity even before/without the chain processing.
    this._blockCount++;
    if (this._blockCount >= METRIC_INTERVAL) this._postMetrics();

    return true;
  }

  _postMetrics() {
    if (this._blockCount === 0) return;
    this.port.postMessage({
      type: 'metrics',
      avgProcessMs: this._sumMs / this._blockCount,
      peakProcessMs: this._peakMs,
      blockPeriodMs: this._blockPeriodMs,
      xruns: this._xruns,
      limiterGrDb: this._grDb,
      dynamicsGrDb: this._dynGrDb,
      safetyEvents: this._safetyEvents,
      processCalls: this._processCalls,
      audioBlocks: this._audioBlocks,
      nonSilentBlocks: this._nonSilentBlocks,
    });
    this._sumMs = 0; this._peakMs = 0; this._xruns = 0; this._blockCount = 0;
  }
}

registerProcessor('loui-mastering-chain', MasteringChainProcessor);
