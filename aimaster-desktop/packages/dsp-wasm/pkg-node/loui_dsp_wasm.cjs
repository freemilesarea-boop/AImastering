/* @ts-self-types="./loui_dsp_wasm.d.ts" */

/**
 * WASM analyzer handle.  One per audio track / session.
 */
class LouiAnalyzer {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        LouiAnalyzerFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_louianalyzer_free(ptr, 0);
    }
    /**
     * Channel count.
     * @returns {number}
     */
    get channels() {
        const ret = wasm.louianalyzer_channels(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Finalise any pending partial 100-ms block.  Call before the final
     * `snapshot()` at end of input for accurate integrated LUFS.
     */
    flush() {
        wasm.louianalyzer_flush(this.__wbg_ptr);
    }
    /**
     * Construct an analyzer.  Sample rate must be > 0; channels in 1..=8.
     *
     * Allocates internal state — call once per session, off the audio
     * thread.  After this, `processPlanar` and `tickSnapshot` are safe
     * from an AudioWorklet `process` callback.
     * @param {number} sample_rate
     * @param {number} channels
     */
    constructor(sample_rate, channels) {
        const ret = wasm.louianalyzer_new(sample_rate, channels);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        LouiAnalyzerFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Mono fast path — single-channel, no allocation on the JS side.
     * @param {Float32Array} samples
     */
    processMono(samples) {
        const ptr0 = passArrayF32ToWasm0(samples, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.louianalyzer_processMono(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Process a planar audio block.  Pass per-channel `Float32Array`s.
     *
     * Zero-copy: wasm-bindgen creates a slice view directly into WASM
     * memory (the Float32Array contents are already there since JS
     * allocated it via wasm.memory).
     *
     * Both channel arrays must have the same length.
     * @param {Float32Array} left
     * @param {Float32Array | null} [right]
     */
    processPlanar(left, right) {
        const ptr0 = passArrayF32ToWasm0(left, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        var ptr1 = isLikeNone(right) ? 0 : passArrayF32ToWasm0(right, wasm.__wbindgen_malloc);
        var len1 = WASM_VECTOR_LEN;
        const ret = wasm.louianalyzer_processPlanar(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Stereo fast path — pass L and R as separate Float32Arrays.
     * Same length, channels=2 only.
     * @param {Float32Array} left
     * @param {Float32Array} right
     */
    processStereo(left, right) {
        const ptr0 = passArrayF32ToWasm0(left, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF32ToWasm0(right, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.louianalyzer_processStereo(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Reset all internal state.  Call when seeking, switching tracks,
     * or after a configuration change.
     */
    reset() {
        wasm.louianalyzer_reset(this.__wbg_ptr);
    }
    /**
     * Sample rate the analyzer was constructed with.
     * @returns {number}
     */
    get sampleRate() {
        const ret = wasm.louianalyzer_sampleRate(this.__wbg_ptr);
        return ret;
    }
    /**
     * Full snapshot including integrated LUFS + LRA.  Allocates briefly
     * (gated-block series) — call off the audio thread (e.g. from a
     * Worker or after `flush()` at end of file).
     * @returns {WasmMeterSnapshot}
     */
    snapshot() {
        const ret = wasm.louianalyzer_snapshot(this.__wbg_ptr);
        return WasmMeterSnapshot.__wrap(ret);
    }
    /**
     * Lightweight snapshot — momentary + short-term LUFS + TP + peak/RMS
     * + correlation.  Allocation-free, safe to call every audio quantum.
     * @returns {WasmMeterSnapshot}
     */
    tickSnapshot() {
        const ret = wasm.louianalyzer_tickSnapshot(this.__wbg_ptr);
        return WasmMeterSnapshot.__wrap(ret);
    }
}
if (Symbol.dispose) LouiAnalyzer.prototype[Symbol.dispose] = LouiAnalyzer.prototype.free;
exports.LouiAnalyzer = LouiAnalyzer;

/**
 * WASM handle for the preview mastering chain.
 */
class LouiMasteringChain {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        LouiMasteringChainFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_louimasteringchain_free(ptr, 0);
    }
    /**
     * Dynamics (compressor) gain reduction (dB, ≥ 0) from the last block.
     * @returns {number}
     */
    dynamicsGrDb() {
        const ret = wasm.louimasteringchain_dynamicsGrDb(this.__wbg_ptr);
        return ret;
    }
    /**
     * Limiter gain reduction (dB, ≥ 0) from the last block.
     * @returns {number}
     */
    limiterGrDb() {
        const ret = wasm.louimasteringchain_limiterGrDb(this.__wbg_ptr);
        return ret;
    }
    /**
     * Construct the chain for a sample rate.  Starts at unity (default
     * config = transparent pass-through until the UI sets parameters).
     * @param {number} sample_rate
     */
    constructor(sample_rate) {
        const ret = wasm.louimasteringchain_new(sample_rate);
        this.__wbg_ptr = ret;
        LouiMasteringChainFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Count of currently-active parametric EQ bands (for diagnostics).
     * @returns {number}
     */
    parametricEqBandCount() {
        const ret = wasm.louimasteringchain_parametricEqBandCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Process one block of planar stereo audio in place.  The mutations
     * are reflected back into the JS-side Float32Arrays.
     * @param {Float32Array} left
     * @param {Float32Array} right
     */
    processStereo(left, right) {
        var ptr0 = passArrayF32ToWasm0(left, wasm.__wbindgen_malloc);
        var len0 = WASM_VECTOR_LEN;
        var ptr1 = passArrayF32ToWasm0(right, wasm.__wbindgen_malloc);
        var len1 = WASM_VECTOR_LEN;
        wasm.louimasteringchain_processStereo(this.__wbg_ptr, ptr0, len0, left, ptr1, len1, right);
    }
    /**
     * Clear all module state (transport seek / source swap).
     */
    reset() {
        wasm.louimasteringchain_reset(this.__wbg_ptr);
    }
    /**
     * Count of blocks the output-safety layer had to replace with the dry
     * signal (non-finite or absurd peak).  0 in healthy operation.
     * @returns {number}
     */
    safetyEvents() {
        const ret = wasm.louimasteringchain_safetyEvents(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Update the full configuration from the UI parameters.  Flat
     * argument list keeps the JS binding simple + zero-alloc.  Units are
     * UI space (e.g. `width_pct` 0..200, `mix_pct` 0..100).
     * @param {number} input_gain_db
     * @param {number} eq_low_cut_hz
     * @param {number} eq_low_shelf_db
     * @param {number} eq_presence_db
     * @param {number} eq_air_db
     * @param {boolean} eq_adaptive
     * @param {boolean} eq_bypass
     * @param {number} dyn_threshold_db
     * @param {number} dyn_ratio
     * @param {number} dyn_attack_ms
     * @param {number} dyn_release_ms
     * @param {number} dyn_mix_pct
     * @param {boolean} dyn_bypass
     * @param {number} img_width_pct
     * @param {number} img_low_mono_hz
     * @param {boolean} img_bypass
     * @param {number} lim_ceiling_dbtp
     * @param {number} lim_lookahead_ms
     * @param {boolean} lim_isp
     * @param {boolean} lim_bypass
     * @param {number} output_gain_db
     * @param {boolean} master_bypass
     */
    setConfig(input_gain_db, eq_low_cut_hz, eq_low_shelf_db, eq_presence_db, eq_air_db, eq_adaptive, eq_bypass, dyn_threshold_db, dyn_ratio, dyn_attack_ms, dyn_release_ms, dyn_mix_pct, dyn_bypass, img_width_pct, img_low_mono_hz, img_bypass, lim_ceiling_dbtp, lim_lookahead_ms, lim_isp, lim_bypass, output_gain_db, master_bypass) {
        wasm.louimasteringchain_setConfig(this.__wbg_ptr, input_gain_db, eq_low_cut_hz, eq_low_shelf_db, eq_presence_db, eq_air_db, eq_adaptive, eq_bypass, dyn_threshold_db, dyn_ratio, dyn_attack_ms, dyn_release_ms, dyn_mix_pct, dyn_bypass, img_width_pct, img_low_mono_hz, img_bypass, lim_ceiling_dbtp, lim_lookahead_ms, lim_isp, lim_bypass, output_gain_db, master_bypass);
    }
    /**
     * Configure the fully-parametric dynamic EQ.  Parallel arrays, one entry
     * per band (up to MAX_DYNEQ_BANDS).  `types`: 0=Bell 1=LowShelf 2=HighShelf.
     * `modes`: 0=DownCut 1=UpBoost.  `enableds`: 0/1.
     * @param {boolean} bypass
     * @param {Uint8Array} enableds
     * @param {Uint8Array} types
     * @param {Float64Array} freqs
     * @param {Float64Array} qs
     * @param {Float64Array} thresholds
     * @param {Float64Array} ratios
     * @param {Float64Array} attacks
     * @param {Float64Array} releases
     * @param {Float64Array} ranges
     * @param {Uint8Array} modes
     */
    setDynamicEqBands(bypass, enableds, types, freqs, qs, thresholds, ratios, attacks, releases, ranges, modes) {
        const ptr0 = passArray8ToWasm0(enableds, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(types, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArrayF64ToWasm0(freqs, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArrayF64ToWasm0(qs, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passArrayF64ToWasm0(thresholds, wasm.__wbindgen_malloc);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passArrayF64ToWasm0(ratios, wasm.__wbindgen_malloc);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passArrayF64ToWasm0(attacks, wasm.__wbindgen_malloc);
        const len6 = WASM_VECTOR_LEN;
        const ptr7 = passArrayF64ToWasm0(releases, wasm.__wbindgen_malloc);
        const len7 = WASM_VECTOR_LEN;
        const ptr8 = passArrayF64ToWasm0(ranges, wasm.__wbindgen_malloc);
        const len8 = WASM_VECTOR_LEN;
        const ptr9 = passArray8ToWasm0(modes, wasm.__wbindgen_malloc);
        const len9 = WASM_VECTOR_LEN;
        wasm.louimasteringchain_setDynamicEqBands(this.__wbg_ptr, bypass, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7, ptr8, len8, ptr9, len9);
    }
    /**
     * Configure the imager's 4-band M/S width.  Independent of `setConfig`
     * (which carries the single-band width).  `widths_pct` is positional
     * [low, low-mid, high-mid, high]; missing entries keep the current value.
     * @param {boolean} enabled
     * @param {number} xover_lo_hz
     * @param {number} xover_mid_hz
     * @param {number} xover_hi_hz
     * @param {Float64Array} widths_pct
     */
    setImagerMultiband(enabled, xover_lo_hz, xover_mid_hz, xover_hi_hz, widths_pct) {
        const ptr0 = passArrayF64ToWasm0(widths_pct, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.louimasteringchain_setImagerMultiband(this.__wbg_ptr, enabled, xover_lo_hz, xover_mid_hz, xover_hi_hz, ptr0, len0);
    }
    /**
     * Configure the 4-band multiband compressor.  Independent of `setConfig`
     * so the frequent flat-arg slider updates don't reset it.  The five
     * per-band arrays are read positionally [low, low-mid, high-mid, high];
     * missing entries keep the current value.
     * @param {boolean} bypass
     * @param {number} xover_lo_hz
     * @param {number} xover_mid_hz
     * @param {number} xover_hi_hz
     * @param {Float64Array} thresholds_db
     * @param {Float64Array} ratios
     * @param {Float64Array} attacks_ms
     * @param {Float64Array} releases_ms
     * @param {Float64Array} makeups_db
     */
    setMultibandConfig(bypass, xover_lo_hz, xover_mid_hz, xover_hi_hz, thresholds_db, ratios, attacks_ms, releases_ms, makeups_db) {
        const ptr0 = passArrayF64ToWasm0(thresholds_db, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF64ToWasm0(ratios, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArrayF64ToWasm0(attacks_ms, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArrayF64ToWasm0(releases_ms, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passArrayF64ToWasm0(makeups_db, wasm.__wbindgen_malloc);
        const len4 = WASM_VECTOR_LEN;
        wasm.louimasteringchain_setMultibandConfig(this.__wbg_ptr, bypass, xover_lo_hz, xover_mid_hz, xover_hi_hz, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4);
    }
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
     * @param {Uint8Array} types
     * @param {Float64Array} freqs
     * @param {Float64Array} gains
     * @param {Float64Array} qs
     * @param {Uint8Array} enableds
     */
    setParametricEqBands(types, freqs, gains, qs, enableds) {
        const ptr0 = passArray8ToWasm0(types, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF64ToWasm0(freqs, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArrayF64ToWasm0(gains, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArrayF64ToWasm0(qs, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passArray8ToWasm0(enableds, wasm.__wbindgen_malloc);
        const len4 = WASM_VECTOR_LEN;
        const ret = wasm.louimasteringchain_setParametricEqBands(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Configure the saturation / exciter.  `character`: 0=Warm 1=Tape 2=Tube
     * 3=Modern.  `band_drives_pct` is positional [low, low-mid, high-mid,
     * high]; missing entries keep the current value.
     * @param {boolean} bypass
     * @param {number} character
     * @param {number} drive
     * @param {number} mix_pct
     * @param {boolean} multiband_enabled
     * @param {number} xover_lo_hz
     * @param {number} xover_mid_hz
     * @param {number} xover_hi_hz
     * @param {Float64Array} band_drives_pct
     */
    setSaturation(bypass, character, drive, mix_pct, multiband_enabled, xover_lo_hz, xover_mid_hz, xover_hi_hz, band_drives_pct) {
        const ptr0 = passArrayF64ToWasm0(band_drives_pct, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.louimasteringchain_setSaturation(this.__wbg_ptr, bypass, character, drive, mix_pct, multiband_enabled, xover_lo_hz, xover_mid_hz, xover_hi_hz, ptr0, len0);
    }
    /**
     * Configure the transient / impact shaper.  `band_attacks_pct` /
     * `band_sustains_pct` are positional [low, low-mid, high-mid, high];
     * missing entries keep the current value.
     * @param {boolean} bypass
     * @param {number} attack_pct
     * @param {number} sustain_pct
     * @param {boolean} multiband_enabled
     * @param {number} xover_lo_hz
     * @param {number} xover_mid_hz
     * @param {number} xover_hi_hz
     * @param {Float64Array} band_attacks_pct
     * @param {Float64Array} band_sustains_pct
     */
    setTransient(bypass, attack_pct, sustain_pct, multiband_enabled, xover_lo_hz, xover_mid_hz, xover_hi_hz, band_attacks_pct, band_sustains_pct) {
        const ptr0 = passArrayF64ToWasm0(band_attacks_pct, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF64ToWasm0(band_sustains_pct, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        wasm.louimasteringchain_setTransient(this.__wbg_ptr, bypass, attack_pct, sustain_pct, multiband_enabled, xover_lo_hz, xover_mid_hz, xover_hi_hz, ptr0, len0, ptr1, len1);
    }
}
if (Symbol.dispose) LouiMasteringChain.prototype[Symbol.dispose] = LouiMasteringChain.prototype.free;
exports.LouiMasteringChain = LouiMasteringChain;

/**
 * Streaming FFT spectrum analyzer exposed to JS.
 *
 * One per session.  Feed audio via `processMono` / `processStereo`,
 * poll `tryFrame()` to see whether new magnitudes are ready, then read
 * `magnitudeDb` / `peakHoldDb`.  The `binCentresHz` array is fixed for
 * the analyzer's lifetime.
 */
class LouiSpectrumAnalyzer {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        LouiSpectrumAnalyzerFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_louispectrumanalyzer_free(ptr, 0);
    }
    /**
     * Bin centre frequencies in Hz.  Fixed for the analyzer's lifetime
     * — caller should cache this on first call.
     *
     * Returns a `Float32Array` view directly into WASM linear memory
     * (zero-copy).  The view is valid until the analyzer is mutated;
     * for safety, copy into a JS Float32Array if storing across calls.
     * @returns {Float32Array}
     */
    get binCentresHz() {
        const ret = wasm.louispectrumanalyzer_binCentresHz(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Number of output bins.
     * @returns {number}
     */
    get binCount() {
        const ret = wasm.louispectrumanalyzer_binCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * FFT size in samples.
     * @returns {number}
     */
    get fftSize() {
        const ret = wasm.louispectrumanalyzer_fftSize(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Smoothed magnitude per bin in dB.  Same length as `binCount`.
     * Returned as a copy — the underlying buffer is mutated by every
     * `tryFrame` call.
     * @returns {Float32Array}
     */
    get magnitudeDb() {
        const ret = wasm.louispectrumanalyzer_magnitudeDb(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Construct an analyzer.
     * @param {number} sample_rate
     * @param {WasmSpectrumOptions} options
     */
    constructor(sample_rate, options) {
        _assertClass(options, WasmSpectrumOptions);
        var ptr0 = options.__destroy_into_raw();
        const ret = wasm.louispectrumanalyzer_new(sample_rate, ptr0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        LouiSpectrumAnalyzerFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Peak-hold magnitude per bin in dB.
     * @returns {Float32Array}
     */
    get peakHoldDb() {
        const ret = wasm.louispectrumanalyzer_peakHoldDb(this.__wbg_ptr);
        var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
        return v1;
    }
    /**
     * Process a mono block — zero-copy from `Float32Array`.
     * @param {Float32Array} samples
     */
    processMono(samples) {
        const ptr0 = passArrayF32ToWasm0(samples, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.louispectrumanalyzer_processMono(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Process a stereo block — channels are averaged to mono internally
     * for spectrum analysis (perceptual visualisers want one curve).
     * @param {Float32Array} left
     * @param {Float32Array} right
     */
    processStereo(left, right) {
        const ptr0 = passArrayF32ToWasm0(left, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF32ToWasm0(right, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.louispectrumanalyzer_processStereo(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Reset analyzer state.
     */
    reset() {
        wasm.louispectrumanalyzer_reset(this.__wbg_ptr);
    }
    /**
     * Sample rate.
     * @returns {number}
     */
    get sampleRate() {
        const ret = wasm.louispectrumanalyzer_sampleRate(this.__wbg_ptr);
        return ret;
    }
    /**
     * Number of audio samples processed so far.
     * @returns {number}
     */
    get samplesProcessed() {
        const ret = wasm.louispectrumanalyzer_samplesProcessed(this.__wbg_ptr);
        return ret;
    }
    /**
     * Try to compute an FFT frame.  Returns `true` iff a new frame is
     * available — read magnitudes via `magnitudeDb` / `peakHoldDb`.
     * @returns {boolean}
     */
    tryFrame() {
        const ret = wasm.louispectrumanalyzer_tryFrame(this.__wbg_ptr);
        return ret !== 0;
    }
}
if (Symbol.dispose) LouiSpectrumAnalyzer.prototype[Symbol.dispose] = LouiSpectrumAnalyzer.prototype.free;
exports.LouiSpectrumAnalyzer = LouiSpectrumAnalyzer;

/**
 * Lightweight snapshot exposed to JS — every field accessed via getter.
 *
 * `f64::NEG_INFINITY` is preserved across the JS boundary as `-Infinity`
 * (wasm-bindgen number conversion).  `NaN` indicates a value that needs
 * the full `Analyzer::snapshot()` (gated calc) instead of `tick_snapshot()`.
 */
class WasmMeterSnapshot {
    static __wrap(ptr) {
        const obj = Object.create(WasmMeterSnapshot.prototype);
        obj.__wbg_ptr = ptr;
        WasmMeterSnapshotFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmMeterSnapshotFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmmetersnapshot_free(ptr, 0);
    }
    /**
     * L/R Pearson correlation (-1..+1).
     * @returns {number}
     */
    get correlation() {
        const ret = wasm.wasmmetersnapshot_correlation(this.__wbg_ptr);
        return ret;
    }
    /**
     * Number of gated 400-ms blocks contributing to integrated LUFS.
     * @returns {number}
     */
    get gatedBlocks() {
        const ret = wasm.wasmmetersnapshot_gatedBlocks(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Integrated LUFS (NaN in tick snapshots — call `snapshot()` instead).
     * @returns {number}
     */
    get integratedLufs() {
        const ret = wasm.wasmmetersnapshot_integratedLufs(this.__wbg_ptr);
        return ret;
    }
    /**
     * EBU R128 LRA (NaN in tick snapshots).
     * @returns {number}
     */
    get loudnessRange() {
        const ret = wasm.wasmmetersnapshot_loudnessRange(this.__wbg_ptr);
        return ret;
    }
    /**
     * Momentary (400 ms) LUFS.
     * @returns {number}
     */
    get momentaryLufs() {
        const ret = wasm.wasmmetersnapshot_momentaryLufs(this.__wbg_ptr);
        return ret;
    }
    /**
     * Mid/Side ratio in dB (+Infinity for mono).
     * @returns {number}
     */
    get msRatioDb() {
        const ret = wasm.wasmmetersnapshot_msRatioDb(this.__wbg_ptr);
        return ret;
    }
    /**
     * Sliding-window RMS in dBFS.
     * @returns {number}
     */
    get rmsDb() {
        const ret = wasm.wasmmetersnapshot_rmsDb(this.__wbg_ptr);
        return ret;
    }
    /**
     * Sample peak in dBFS.
     * @returns {number}
     */
    get samplePeakDb() {
        const ret = wasm.wasmmetersnapshot_samplePeakDb(this.__wbg_ptr);
        return ret;
    }
    /**
     * Number of audio samples observed (per-channel).
     * @returns {number}
     */
    get samplesProcessed() {
        const ret = wasm.wasmmetersnapshot_samplesProcessed(this.__wbg_ptr);
        return ret;
    }
    /**
     * Short-term (3 s) LUFS.
     * @returns {number}
     */
    get shortTermLufs() {
        const ret = wasm.wasmmetersnapshot_shortTermLufs(this.__wbg_ptr);
        return ret;
    }
    /**
     * True peak in dBTP.
     * @returns {number}
     */
    get truePeakDbtp() {
        const ret = wasm.wasmmetersnapshot_truePeakDbtp(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) WasmMeterSnapshot.prototype[Symbol.dispose] = WasmMeterSnapshot.prototype.free;
exports.WasmMeterSnapshot = WasmMeterSnapshot;

/**
 * JS-side construction options for `LouiSpectrumAnalyzer`.  Use the
 * builder methods (`thirdOctave`, `log`, `linear`) to set the binning.
 */
class WasmSpectrumOptions {
    static __wrap(ptr) {
        const obj = Object.create(WasmSpectrumOptions.prototype);
        obj.__wbg_ptr = ptr;
        WasmSpectrumOptionsFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmSpectrumOptionsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmspectrumoptions_free(ptr, 0);
    }
    /**
     * Construct with defaults (fft 2048 / log 128 bins / 50 % smoothing).
     */
    constructor() {
        const ret = wasm.wasmspectrumoptions_new();
        this.__wbg_ptr = ret;
        WasmSpectrumOptionsFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {number} n
     * @returns {WasmSpectrumOptions}
     */
    setFftSize(n) {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.wasmspectrumoptions_setFftSize(ptr, n);
        return WasmSpectrumOptions.__wrap(ret);
    }
    /**
     * @param {number} n
     * @returns {WasmSpectrumOptions}
     */
    setHopSize(n) {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.wasmspectrumoptions_setHopSize(ptr, n);
        return WasmSpectrumOptions.__wrap(ret);
    }
    /**
     * @param {number} d
     * @returns {WasmSpectrumOptions}
     */
    setPeakHoldDecayDb(d) {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.wasmspectrumoptions_setPeakHoldDecayDb(ptr, d);
        return WasmSpectrumOptions.__wrap(ret);
    }
    /**
     * @param {number} s
     * @returns {WasmSpectrumOptions}
     */
    setSmoothing(s) {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.wasmspectrumoptions_setSmoothing(ptr, s);
        return WasmSpectrumOptions.__wrap(ret);
    }
    /**
     * Use linear-spaced centres between min/max Hz.
     * @param {number} bins
     * @param {number} min_hz
     * @param {number} max_hz
     * @returns {WasmSpectrumOptions}
     */
    useLinear(bins, min_hz, max_hz) {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.wasmspectrumoptions_useLinear(ptr, bins, min_hz, max_hz);
        return WasmSpectrumOptions.__wrap(ret);
    }
    /**
     * Use log-spaced centres between min/max Hz.
     * @param {number} bins
     * @param {number} min_hz
     * @param {number} max_hz
     * @returns {WasmSpectrumOptions}
     */
    useLog(bins, min_hz, max_hz) {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.wasmspectrumoptions_useLog(ptr, bins, min_hz, max_hz);
        return WasmSpectrumOptions.__wrap(ret);
    }
    /**
     * Use ANSI 1/3-octave centres.
     * @returns {WasmSpectrumOptions}
     */
    useThirdOctave() {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.wasmspectrumoptions_useThirdOctave(ptr);
        return WasmSpectrumOptions.__wrap(ret);
    }
}
if (Symbol.dispose) WasmSpectrumOptions.prototype[Symbol.dispose] = WasmSpectrumOptions.prototype.free;
exports.WasmSpectrumOptions = WasmSpectrumOptions;

/**
 * Crate version string ("0.1.0" at M2-lite-NEXT).  Useful for sanity-
 * checking the bundled binary on the JS side.
 * @returns {string}
 */
function crateVersion() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.crateVersion();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}
exports.crateVersion = crateVersion;

/**
 * Initialise crate-wide handlers.  Call once from JS before constructing
 * any analyzer.  Idempotent.
 */
function start() {
    wasm.start();
}
exports.start = start;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_9dc85fe1bc224456: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_copy_to_typed_array_caa344bd6a9e2ba2: function(arg0, arg1, arg2) {
            new Uint8Array(arg2.buffer, arg2.byteOffset, arg2.byteLength).set(getArrayU8FromWasm0(arg0, arg1));
        },
        __wbg___wbindgen_throw_bbadd78c1bac3a77: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_error_a6fa202b58aa1cd3: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_new_227d7c05414eb861: function() {
            const ret = new Error();
            return ret;
        },
        __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
            const ret = arg1.stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./loui_dsp_wasm_bg.js": import0,
    };
}

const LouiAnalyzerFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_louianalyzer_free(ptr, 1));
const LouiMasteringChainFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_louimasteringchain_free(ptr, 1));
const LouiSpectrumAnalyzerFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_louispectrumanalyzer_free(ptr, 1));
const WasmMeterSnapshotFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmmetersnapshot_free(ptr, 1));
const WasmSpectrumOptionsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmspectrumoptions_free(ptr, 1));

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
function decodeText(ptr, len) {
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

const wasmPath = `${__dirname}/loui_dsp_wasm_bg.wasm`;
const wasmBytes = require('fs').readFileSync(wasmPath);
const wasmModule = new WebAssembly.Module(wasmBytes);
let wasmInstance = new WebAssembly.Instance(wasmModule, __wbg_get_imports());
let wasm = wasmInstance.exports;
wasm.__wbindgen_start();
