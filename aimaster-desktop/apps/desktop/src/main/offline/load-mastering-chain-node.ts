// Loads the Node-target WASM MasteringChain (RUST-OFFLINE-RENDER-1).
//
// Reuses the EXACT same Rust MasteringChain as the realtime preview, built
// with `wasm-bindgen --target nodejs` (packages/dsp-wasm/pkg-node).  Loaded
// via `require` so it works in the Electron main (Node) process and in
// headless tsx scripts (the parity harness).

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

/** One band in the free parametric EQ (RUST-OFFLINE-RENDER-FREE-EQ). */
export interface OfflineParametricBand {
  /** 0=HighPass, 1=LowPass, 2=Bell, 3=LowShelf, 4=HighShelf */
  type: 0 | 1 | 2 | 3 | 4;
  frequencyHz: number;
  gainDb: number;
  q: number;
  enabled: boolean;
}

/** One band of the multiband compressor (structural — matches the renderer's
 *  `MultibandBand` so the IPC payload deserialises 1:1). */
export interface OfflineMultibandBand {
  thresholdDb: number; ratio: number; attackMs: number; releaseMs: number; makeupDb: number;
}

/** Multiband compressor config (structural — matches `MultibandConfig`). */
export interface OfflineMultibandConfig {
  bypass: boolean;
  xoverLoHz: number; xoverMidHz: number; xoverHiHz: number;
  bands: OfflineMultibandBand[];
}

/** 4-band M/S imager config (structural — matches `ImagerMultibandConfig`). */
export interface OfflineImagerMultibandConfig {
  enabled: boolean;
  xoverLoHz: number; xoverMidHz: number; xoverHiHz: number;
  widthsPct: number[];
}

/** Saturation/exciter config (structural).  `characterCode`: 0=Warm 1=Tape
 *  2=Tube 3=Modern. */
export interface OfflineSaturationConfig {
  bypass: boolean;
  characterCode: number;
  drive: number;
  mixPct: number;
  multibandEnabled: boolean;
  bandDrivesPct: number[];
  xoverLoHz: number; xoverMidHz: number; xoverHiHz: number;
}

/** The flat config passed to the WASM chain's `setConfig` (same order as the
 *  realtime preview's `RealtimeChainConfig`). */
export interface OfflineChainConfig {
  inputGainDb: number;
  eqLowCutHz: number; eqLowShelfDb: number; eqPresenceDb: number; eqAirDb: number;
  eqAdaptive: boolean; eqBypass: boolean;
  dynThresholdDb: number; dynRatio: number; dynAttackMs: number; dynReleaseMs: number;
  dynMixPct: number; dynBypass: boolean;
  imgWidthPct: number; imgLowMonoHz: number; imgBypass: boolean;
  limCeilingDbtp: number; limLookaheadMs: number; limIsp: boolean; limBypass: boolean;
  outputGainDb: number;
  masterBypass: boolean;
  /** Optional free parametric EQ bands.  Absent / empty = no parametric EQ. */
  parametricBands?: OfflineParametricBand[];
  /** Optional 4-band multiband compressor.  Absent = none. */
  multiband?: OfflineMultibandConfig;
  /** Optional 4-band M/S stereo imager.  Absent = single-band width only. */
  imagerMultiband?: OfflineImagerMultibandConfig;
  /** Optional saturation / exciter.  Absent = none. */
  saturation?: OfflineSaturationConfig;
}

/** Structural type of the WASM chain (avoids a hard dep on the typings). */
export interface WasmMasteringChain {
  setConfig(
    inputGainDb: number,
    eqLowCutHz: number, eqLowShelfDb: number, eqPresenceDb: number, eqAirDb: number,
    eqAdaptive: boolean, eqBypass: boolean,
    dynThresholdDb: number, dynRatio: number, dynAttackMs: number, dynReleaseMs: number,
    dynMixPct: number, dynBypass: boolean,
    imgWidthPct: number, imgLowMonoHz: number, imgBypass: boolean,
    limCeilingDbtp: number, limLookaheadMs: number, limIsp: boolean, limBypass: boolean,
    outputGainDb: number, masterBypass: boolean,
  ): void;
  /** Free parametric EQ — pass parallel typed arrays (length must match). */
  setParametricEqBands(
    types: Uint8Array, freqs: Float64Array, gains: Float64Array, qs: Float64Array, enableds: Uint8Array,
  ): void;
  parametricEqBandCount(): number;
  /** 4-band multiband compressor (optional — present only on rebuilt artifacts).
   *  Per-band arrays are positional [low, low-mid, high-mid, high]. */
  setMultibandConfig?(
    bypass: boolean,
    xoverLoHz: number, xoverMidHz: number, xoverHiHz: number,
    thresholdsDb: Float64Array, ratios: Float64Array, attacksMs: Float64Array,
    releasesMs: Float64Array, makeupsDb: Float64Array,
  ): void;
  /** 4-band M/S imager (optional — present only on rebuilt artifacts). */
  setImagerMultiband?(
    enabled: boolean,
    xoverLoHz: number, xoverMidHz: number, xoverHiHz: number,
    widthsPct: Float64Array,
  ): void;
  /** Saturation / exciter (optional — present only on rebuilt artifacts). */
  setSaturation?(
    bypass: boolean,
    character: number,
    drive: number,
    mixPct: number,
    multibandEnabled: boolean,
    xoverLoHz: number, xoverMidHz: number, xoverHiHz: number,
    bandDrivesPct: Float64Array,
  ): void;
  processStereo(left: Float32Array, right: Float32Array): void;
  limiterGrDb(): number;
  reset(): void;
  free?(): void;
}

/** Pack `OfflineParametricBand[]` into the 5 parallel typed arrays the WASM
 *  binding expects.  Disabled bands are still included — the Rust side
 *  filters them out, and including them keeps the round-trip honest. */
export function packParametricBands(bands: OfflineParametricBand[]): {
  types: Uint8Array; freqs: Float64Array; gains: Float64Array; qs: Float64Array; enableds: Uint8Array;
} {
  const n = bands.length;
  const types = new Uint8Array(n);
  const freqs = new Float64Array(n);
  const gains = new Float64Array(n);
  const qs = new Float64Array(n);
  const enableds = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const b = bands[i]!;
    types[i] = b.type;
    freqs[i] = b.frequencyHz;
    gains[i] = b.gainDb;
    qs[i] = b.q;
    enableds[i] = b.enabled ? 1 : 0;
  }
  return { types, freqs, gains, qs, enableds };
}

interface WasmModule {
  LouiMasteringChain: new (sampleRate: number) => WasmMasteringChain;
  LouiAnalyzer: new (sampleRate: number, channels: number) => WasmAnalyzer;
}

/** Minimal analyzer surface for offline loudness measurement. */
export interface WasmAnalyzer {
  processStereo(left: Float32Array, right: Float32Array): void;
  /** Full snapshot (gated integrated LUFS + true peak). */
  snapshot(): { integratedLufs: number; truePeakDbtp: number; samplePeakDb: number };
  reset(): void;
  free?(): void;
}

const require_ = createRequire(__filename);

/** Candidate locations for the node-target WASM glue (.cjs). */
function candidatePaths(): string[] {
  const file = 'loui_dsp_wasm.cjs';
  const c: string[] = [];
  // 1) explicit override
  if (process.env['LOUI_WASM_NODE_PATH']) c.push(process.env['LOUI_WASM_NODE_PATH']!);
  // 2) workspace dev layout (apps/desktop/src/main/offline → packages/dsp-wasm/pkg-node)
  c.push(path.resolve(__dirname, '../../../../../packages/dsp-wasm/pkg-node', file));
  // 3) packaged resources
  if (process.resourcesPath) c.push(path.join(process.resourcesPath, 'dsp-wasm-node', file));
  return c;
}

let cached: WasmModule | null | undefined;

/** Resolve + require the node WASM module.  Returns null when unavailable
 *  (caller falls back to the Python engine). */
export function loadWasmModule(): WasmModule | null {
  if (cached !== undefined) return cached;
  for (const p of candidatePaths()) {
    try {
      if (!fs.existsSync(p)) continue;
      const mod = require_(p) as WasmModule;
      if (mod && typeof mod.LouiMasteringChain === 'function') { cached = mod; return mod; }
    } catch { /* try next */ }
  }
  cached = null;
  return null;
}

/** Construct a chain at the given sample rate.  Throws if unavailable. */
export function createOfflineChain(sampleRate: number): WasmMasteringChain {
  const mod = loadWasmModule();
  if (!mod) throw new Error('node-target WASM MasteringChain unavailable (build: pnpm --filter @loui/dsp-wasm run build:node)');
  return new mod.LouiMasteringChain(sampleRate);
}

/** Construct an analyzer for offline loudness measurement.  Throws if unavailable. */
export function createOfflineAnalyzer(sampleRate: number, channels = 2): WasmAnalyzer {
  const mod = loadWasmModule();
  if (!mod) throw new Error('node-target WASM analyzer unavailable (build: pnpm --filter @loui/dsp-wasm run build:node)');
  return new mod.LouiAnalyzer(sampleRate, channels);
}

/** Apply a flat config to a chain (spreads the 22 args in setConfig order).
 *  Also applies the optional free parametric EQ band list. */
export function applyOfflineConfig(chain: WasmMasteringChain, c: OfflineChainConfig): void {
  chain.setConfig(
    c.inputGainDb,
    c.eqLowCutHz, c.eqLowShelfDb, c.eqPresenceDb, c.eqAirDb, c.eqAdaptive, c.eqBypass,
    c.dynThresholdDb, c.dynRatio, c.dynAttackMs, c.dynReleaseMs, c.dynMixPct, c.dynBypass,
    c.imgWidthPct, c.imgLowMonoHz, c.imgBypass,
    c.limCeilingDbtp, c.limLookaheadMs, c.limIsp, c.limBypass,
    c.outputGainDb, c.masterBypass,
  );
  // Free parametric EQ — always call so disabling the chain is a clean reset.
  const bands = c.parametricBands ?? [];
  const packed = packParametricBands(bands);
  chain.setParametricEqBands(packed.types, packed.freqs, packed.gains, packed.qs, packed.enableds);

  // Multiband compressor — guarded: the method exists only on WASM artifacts
  // rebuilt after the binding landed.  On older artifacts this is a no-op
  // (multiband simply not applied) so the render still succeeds.
  if (c.multiband && typeof chain.setMultibandConfig === 'function') {
    const mb = c.multiband;
    const arr = (sel: (b: OfflineMultibandBand) => number): Float64Array =>
      Float64Array.from((mb.bands ?? []).slice(0, 4).map(sel));
    chain.setMultibandConfig(
      !!mb.bypass,
      mb.xoverLoHz, mb.xoverMidHz, mb.xoverHiHz,
      arr((b) => b.thresholdDb), arr((b) => b.ratio), arr((b) => b.attackMs),
      arr((b) => b.releaseMs), arr((b) => b.makeupDb),
    );
  }

  // 4-band M/S imager — guarded, same rebuilt-artifact contract as above.
  if (c.imagerMultiband && typeof chain.setImagerMultiband === 'function') {
    const im = c.imagerMultiband;
    chain.setImagerMultiband(
      !!im.enabled, im.xoverLoHz, im.xoverMidHz, im.xoverHiHz,
      Float64Array.from((im.widthsPct ?? []).slice(0, 4)),
    );
  }

  // Saturation / exciter — guarded.
  if (c.saturation && typeof chain.setSaturation === 'function') {
    const s = c.saturation;
    chain.setSaturation(
      !!s.bypass, s.characterCode, s.drive, s.mixPct, !!s.multibandEnabled,
      s.xoverLoHz, s.xoverMidHz, s.xoverHiHz,
      Float64Array.from((s.bandDrivesPct ?? []).slice(0, 4)),
    );
  }
}
