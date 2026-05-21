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
     * Limiter gain reduction (dB, ≥ 0) from the last block.
     */
    limiterGrDb(): number;
    /**
     * Construct the chain for a sample rate.  Starts at unity (default
     * config = transparent pass-through until the UI sets parameters).
     */
    constructor(sample_rate: number);
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

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_louianalyzer_free: (a: number, b: number) => void;
    readonly __wbg_louimasteringchain_free: (a: number, b: number) => void;
    readonly __wbg_louispectrumanalyzer_free: (a: number, b: number) => void;
    readonly __wbg_wasmmetersnapshot_free: (a: number, b: number) => void;
    readonly __wbg_wasmspectrumoptions_free: (a: number, b: number) => void;
    readonly crateVersion: () => [number, number];
    readonly louianalyzer_channels: (a: number) => number;
    readonly louianalyzer_flush: (a: number) => void;
    readonly louianalyzer_new: (a: number, b: number) => [number, number, number];
    readonly louianalyzer_processMono: (a: number, b: number, c: number) => [number, number];
    readonly louianalyzer_processPlanar: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly louianalyzer_processStereo: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly louianalyzer_reset: (a: number) => void;
    readonly louianalyzer_sampleRate: (a: number) => number;
    readonly louianalyzer_snapshot: (a: number) => number;
    readonly louianalyzer_tickSnapshot: (a: number) => number;
    readonly louimasteringchain_limiterGrDb: (a: number) => number;
    readonly louimasteringchain_new: (a: number) => number;
    readonly louimasteringchain_processStereo: (a: number, b: number, c: number, d: any, e: number, f: number, g: any) => void;
    readonly louimasteringchain_reset: (a: number) => void;
    readonly louimasteringchain_safetyEvents: (a: number) => number;
    readonly louimasteringchain_setConfig: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number, o: number, p: number, q: number, r: number, s: number, t: number, u: number, v: number, w: number) => void;
    readonly louispectrumanalyzer_binCentresHz: (a: number) => [number, number];
    readonly louispectrumanalyzer_binCount: (a: number) => number;
    readonly louispectrumanalyzer_fftSize: (a: number) => number;
    readonly louispectrumanalyzer_magnitudeDb: (a: number) => [number, number];
    readonly louispectrumanalyzer_new: (a: number, b: number) => [number, number, number];
    readonly louispectrumanalyzer_peakHoldDb: (a: number) => [number, number];
    readonly louispectrumanalyzer_processMono: (a: number, b: number, c: number) => void;
    readonly louispectrumanalyzer_processStereo: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly louispectrumanalyzer_reset: (a: number) => void;
    readonly louispectrumanalyzer_sampleRate: (a: number) => number;
    readonly louispectrumanalyzer_samplesProcessed: (a: number) => number;
    readonly louispectrumanalyzer_tryFrame: (a: number) => number;
    readonly wasmmetersnapshot_correlation: (a: number) => number;
    readonly wasmmetersnapshot_gatedBlocks: (a: number) => number;
    readonly wasmmetersnapshot_integratedLufs: (a: number) => number;
    readonly wasmmetersnapshot_loudnessRange: (a: number) => number;
    readonly wasmmetersnapshot_msRatioDb: (a: number) => number;
    readonly wasmmetersnapshot_rmsDb: (a: number) => number;
    readonly wasmmetersnapshot_samplePeakDb: (a: number) => number;
    readonly wasmmetersnapshot_samplesProcessed: (a: number) => number;
    readonly wasmmetersnapshot_shortTermLufs: (a: number) => number;
    readonly wasmmetersnapshot_truePeakDbtp: (a: number) => number;
    readonly wasmspectrumoptions_new: () => number;
    readonly wasmspectrumoptions_setFftSize: (a: number, b: number) => number;
    readonly wasmspectrumoptions_setHopSize: (a: number, b: number) => number;
    readonly wasmspectrumoptions_setPeakHoldDecayDb: (a: number, b: number) => number;
    readonly wasmspectrumoptions_setSmoothing: (a: number, b: number) => number;
    readonly wasmspectrumoptions_useLinear: (a: number, b: number, c: number, d: number) => number;
    readonly wasmspectrumoptions_useLog: (a: number, b: number, c: number, d: number) => number;
    readonly wasmspectrumoptions_useThirdOctave: (a: number) => number;
    readonly start: () => void;
    readonly wasmmetersnapshot_momentaryLufs: (a: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
