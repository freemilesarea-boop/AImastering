/* tslint:disable */
/* eslint-disable */

/**
 * WASM analyzer handle.  One per audio track / session.
 */
export class LouiAnalyzer {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Finalise any pending partial 100-ms block.  Call before the final
     * `snapshot()` at end of input for accurate integrated LUFS.
     */
    flush(): void;
    /**
     * Construct an analyzer.  Sample rate must be > 0; channels in 1..=8.
     *
     * Allocates internal state — call once per session, off the audio
     * thread.  After this, `processPlanar` and `tickSnapshot` are safe
     * from an AudioWorklet `process` callback.
     */
    constructor(sample_rate: number, channels: number);
    /**
     * Mono fast path — single-channel, no allocation on the JS side.
     */
    processMono(samples: Float32Array): void;
    /**
     * Process a planar audio block.  Pass per-channel `Float32Array`s.
     *
     * Zero-copy: wasm-bindgen creates a slice view directly into WASM
     * memory (the Float32Array contents are already there since JS
     * allocated it via wasm.memory).
     *
     * Both channel arrays must have the same length.
     */
    processPlanar(left: Float32Array, right?: Float32Array | null): void;
    /**
     * Stereo fast path — pass L and R as separate Float32Arrays.
     * Same length, channels=2 only.
     */
    processStereo(left: Float32Array, right: Float32Array): void;
    /**
     * Reset all internal state.  Call when seeking, switching tracks,
     * or after a configuration change.
     */
    reset(): void;
    /**
     * Full snapshot including integrated LUFS + LRA.  Allocates briefly
     * (gated-block series) — call off the audio thread (e.g. from a
     * Worker or after `flush()` at end of file).
     */
    snapshot(): WasmMeterSnapshot;
    /**
     * Lightweight snapshot — momentary + short-term LUFS + TP + peak/RMS
     * + correlation.  Allocation-free, safe to call every audio quantum.
     */
    tickSnapshot(): WasmMeterSnapshot;
    /**
     * Channel count.
     */
    readonly channels: number;
    /**
     * Sample rate the analyzer was constructed with.
     */
    readonly sampleRate: number;
}

/**
 * WASM handle for the preview mastering chain.
 */
export class LouiMasteringChain {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Dynamics (compressor) gain reduction (dB, ≥ 0) from the last block.
     */
    dynamicsGrDb(): number;
    /**
     * Limiter gain reduction (dB, ≥ 0) from the last block.
     */
    limiterGrDb(): number;
    /**
     * Construct the chain for a sample rate.  Starts at unity (default
     * config = transparent pass-through until the UI sets parameters).
     */
    constructor(sample_rate: number);
    /**
     * Count of currently-active parametric EQ bands (for diagnostics).
     */
    parametricEqBandCount(): number;
    /**
     * Process one block of planar stereo audio in place.  The mutations
     * are reflected back into the JS-side Float32Arrays.
     */
    processStereo(left: Float32Array, right: Float32Array): void;
    /**
     * Clear all module state (transport seek / source swap).
     */
    reset(): void;
    /**
     * Count of blocks the output-safety layer had to replace with the dry
     * signal (non-finite or absurd peak).  0 in healthy operation.
     */
    safetyEvents(): number;
    /**
     * Update the full configuration from the UI parameters.  Flat
     * argument list keeps the JS binding simple + zero-alloc.  Units are
     * UI space (e.g. `width_pct` 0..200, `mix_pct` 0..100).
     */
    setConfig(input_gain_db: number, eq_low_cut_hz: number, eq_low_shelf_db: number, eq_presence_db: number, eq_air_db: number, eq_adaptive: boolean, eq_bypass: boolean, dyn_threshold_db: number, dyn_ratio: number, dyn_attack_ms: number, dyn_release_ms: number, dyn_mix_pct: number, dyn_bypass: boolean, img_width_pct: number, img_low_mono_hz: number, img_bypass: boolean, lim_ceiling_dbtp: number, lim_lookahead_ms: number, lim_isp: boolean, lim_bypass: boolean, output_gain_db: number, master_bypass: boolean): void;
    /**
     * Replace the free parametric EQ band list.  Bands are passed as five
     * parallel typed arrays so JS can populate them without per-band JS
     * object overhead (single zero-copy pass into WASM memory):
     *
     *   types:    Uint8Array      0=HighPass, 1=LowPass, 2=Bell, 3=LowShelf, 4=HighShelf
     *   freqs:    Float64Array    Hz
     *   gains:    Float64Array    dB (ignored for cuts/passes)
     *   qs:       Float64Array    Q (0.1..18)
     *   enableds: Uint8Array      0 = off, non-zero = on
     *
     * All arrays must have the same length.  Pass empty arrays to clear
     * all bands (chain becomes a parametric-EQ passthrough).
     */
    setParametricEqBands(types: Uint8Array, freqs: Float64Array, gains: Float64Array, qs: Float64Array, enableds: Uint8Array): void;
}

/**
 * Streaming FFT spectrum analyzer exposed to JS.
 *
 * One per session.  Feed audio via `processMono` / `processStereo`,
 * poll `tryFrame()` to see whether new magnitudes are ready, then read
 * `magnitudeDb` / `peakHoldDb`.  The `binCentresHz` array is fixed for
 * the analyzer's lifetime.
 */
export class LouiSpectrumAnalyzer {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Construct an analyzer.
     */
    constructor(sample_rate: number, options: WasmSpectrumOptions);
    /**
     * Process a mono block — zero-copy from `Float32Array`.
     */
    processMono(samples: Float32Array): void;
    /**
     * Process a stereo block — channels are averaged to mono internally
     * for spectrum analysis (perceptual visualisers want one curve).
     */
    processStereo(left: Float32Array, right: Float32Array): void;
    /**
     * Reset analyzer state.
     */
    reset(): void;
    /**
     * Try to compute an FFT frame.  Returns `true` iff a new frame is
     * available — read magnitudes via `magnitudeDb` / `peakHoldDb`.
     */
    tryFrame(): boolean;
    /**
     * Bin centre frequencies in Hz.  Fixed for the analyzer's lifetime
     * — caller should cache this on first call.
     *
     * Returns a `Float32Array` view directly into WASM linear memory
     * (zero-copy).  The view is valid until the analyzer is mutated;
     * for safety, copy into a JS Float32Array if storing across calls.
     */
    readonly binCentresHz: Float32Array;
    /**
     * Number of output bins.
     */
    readonly binCount: number;
    /**
     * FFT size in samples.
     */
    readonly fftSize: number;
    /**
     * Smoothed magnitude per bin in dB.  Same length as `binCount`.
     * Returned as a copy — the underlying buffer is mutated by every
     * `tryFrame` call.
     */
    readonly magnitudeDb: Float32Array;
    /**
     * Peak-hold magnitude per bin in dB.
     */
    readonly peakHoldDb: Float32Array;
    /**
     * Sample rate.
     */
    readonly sampleRate: number;
    /**
     * Number of audio samples processed so far.
     */
    readonly samplesProcessed: number;
}

/**
 * Lightweight snapshot exposed to JS — every field accessed via getter.
 *
 * `f64::NEG_INFINITY` is preserved across the JS boundary as `-Infinity`
 * (wasm-bindgen number conversion).  `NaN` indicates a value that needs
 * the full `Analyzer::snapshot()` (gated calc) instead of `tick_snapshot()`.
 */
export class WasmMeterSnapshot {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * L/R Pearson correlation (-1..+1).
     */
    readonly correlation: number;
    /**
     * Number of gated 400-ms blocks contributing to integrated LUFS.
     */
    readonly gatedBlocks: number;
    /**
     * Integrated LUFS (NaN in tick snapshots — call `snapshot()` instead).
     */
    readonly integratedLufs: number;
    /**
     * EBU R128 LRA (NaN in tick snapshots).
     */
    readonly loudnessRange: number;
    /**
     * Momentary (400 ms) LUFS.
     */
    readonly momentaryLufs: number;
    /**
     * Mid/Side ratio in dB (+Infinity for mono).
     */
    readonly msRatioDb: number;
    /**
     * Sliding-window RMS in dBFS.
     */
    readonly rmsDb: number;
    /**
     * Sample peak in dBFS.
     */
    readonly samplePeakDb: number;
    /**
     * Number of audio samples observed (per-channel).
     */
    readonly samplesProcessed: number;
    /**
     * Short-term (3 s) LUFS.
     */
    readonly shortTermLufs: number;
    /**
     * True peak in dBTP.
     */
    readonly truePeakDbtp: number;
}

/**
 * JS-side construction options for `LouiSpectrumAnalyzer`.  Use the
 * builder methods (`thirdOctave`, `log`, `linear`) to set the binning.
 */
export class WasmSpectrumOptions {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Construct with defaults (fft 2048 / log 128 bins / 50 % smoothing).
     */
    constructor();
    setFftSize(n: number): WasmSpectrumOptions;
    setHopSize(n: number): WasmSpectrumOptions;
    setPeakHoldDecayDb(d: number): WasmSpectrumOptions;
    setSmoothing(s: number): WasmSpectrumOptions;
    /**
     * Use linear-spaced centres between min/max Hz.
     */
    useLinear(bins: number, min_hz: number, max_hz: number): WasmSpectrumOptions;
    /**
     * Use log-spaced centres between min/max Hz.
     */
    useLog(bins: number, min_hz: number, max_hz: number): WasmSpectrumOptions;
    /**
     * Use ANSI 1/3-octave centres.
     */
    useThirdOctave(): WasmSpectrumOptions;
}

/**
 * Crate version string ("0.1.0" at M2-lite-NEXT).  Useful for sanity-
 * checking the bundled binary on the JS side.
 */
export function crateVersion(): string;

/**
 * Initialise crate-wide handlers.  Call once from JS before constructing
 * any analyzer.  Idempotent.
 */
export function start(): void;
