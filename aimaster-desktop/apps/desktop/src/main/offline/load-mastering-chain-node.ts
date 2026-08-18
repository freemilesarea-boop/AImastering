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

/**
 * The flat config passed to the WASM chain's `setConfig`.
 *
 * Covers the original five modules only.  `suiteConfig` carries everything
 * the Ozone-class suite added; when it is present the render uses the JSON
 * path instead, which is the same object the realtime preview sends — that
 * is what keeps preview and export from drifting apart.
 */
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
  /**
   * Full module-suite config (the renderer's `ChainConfigWire`).  When set,
   * it is applied via `setConfigJson` and the flat fields above are ignored
   * — the suite config already carries their values.
   */
  suiteConfig?: Record<string, unknown>;
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
  /** Full-suite config path.  Absent on WASM builds older than the suite. */
  setConfigJson?(json: string): void;
  /** Total processing latency for the current config, in samples. */
  latencySamples?(): number;
  processStereo(left: Float32Array, right: Float32Array): void;
  /** Measured long-term tonal curve, dB per curve band.  Absent on WASM
   *  builds older than the spectral stage. */
  tonalCurveDb?(): Float64Array;
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

/**
 * Candidate locations for the node-target WASM glue (.cjs).
 *
 * # Why this walks rather than counting `..`
 *
 * The original list counted five levels up from `__dirname`, which is right
 * for `apps/desktop/src/main/offline` — the layout the headless tests run
 * in. The APP does not run from there: esbuild bundles the main process to
 * `apps/desktop/dist-electron/main/index.js`, which is two levels shallower,
 * so the same five `..` landed outside the workspace entirely and the module
 * was never found.
 *
 * Nothing said so. `loadWasmModule` returns null when it cannot resolve, and
 * every caller that has a Python fallback quietly took it — so the Rust
 * engine simply never ran in the running application, while every test that
 * exercised it passed. The parts with no fallback (the stem session) failed
 * with "unavailable" and no explanation of why it would be unavailable in a
 * checkout that contains the file.
 *
 * Walking up from wherever this module actually sits removes the assumption
 * instead of correcting it, so a future change to the bundle layout cannot
 * reintroduce the same silence.
 */
export function candidatePathsFrom(startDir: string): string[] {
  const file = 'loui_dsp_wasm.cjs';
  const c: string[] = [];

  // 1) explicit override
  if (process.env['LOUI_WASM_NODE_PATH']) c.push(process.env['LOUI_WASM_NODE_PATH']!);

  // 2) the workspace dependency, resolved by Node rather than by counting.
  //    `@loui/dsp-wasm` is a dependency of this app, so when the bundle keeps
  //    node_modules resolution this is exact and layout-independent.
  try {
    c.push(require_.resolve('@loui/dsp-wasm/pkg-node/loui_dsp_wasm.cjs'));
  } catch { /* not resolvable from here — the walk below covers it */ }

  // 3) walk up looking for the package. Covers the source layout
  //    (src/main/offline), the dev bundle (dist-electron/main) and any
  //    packaged layout that keeps the workspace shape.
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    c.push(path.join(dir, 'packages/dsp-wasm/pkg-node', file));
    c.push(path.join(dir, 'node_modules/@loui/dsp-wasm/pkg-node', file));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // 4) packaged resources
  if (process.resourcesPath) c.push(path.join(process.resourcesPath, 'dsp-wasm-node', file));

  return c;
}

function candidatePaths(): string[] {
  return candidatePathsFrom(__dirname);
}

/**
 * Where the last resolution attempt looked, and what it found.
 *
 * Exposed so the app can say "the engine is missing, and here is where it
 * was looked for" instead of "unavailable". A path bug that produces silence
 * costs far more to find than one that prints its search.
 */
export interface WasmResolution {
  resolved: string | null;
  tried: string[];
}

let lastResolution: WasmResolution = { resolved: null, tried: [] };

export function wasmResolution(): WasmResolution {
  // Force a resolution attempt so a caller asking before first use gets a
  // real answer rather than an empty one.
  loadWasmModule();
  return lastResolution;
}

let cached: WasmModule | null | undefined;

/** Resolve + require the node WASM module.  Returns null when unavailable
 *  (caller falls back to the Python engine). */
export function loadWasmModule(): WasmModule | null {
  if (cached !== undefined) return cached;
  const tried = candidatePaths();
  for (const p of tried) {
    try {
      if (!fs.existsSync(p)) continue;
      const mod = require_(p) as WasmModule;
      if (mod && typeof mod.LouiMasteringChain === 'function') {
        cached = mod;
        lastResolution = { resolved: p, tried };
        return mod;
      }
    } catch { /* try next */ }
  }
  cached = null;
  lastResolution = { resolved: null, tried };
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

/**
 * Apply a config to a chain.
 *
 * Prefers the full-suite JSON path when the config carries one and the WASM
 * build supports it; otherwise falls back to the flat positional call, which
 * still covers the original five modules.  Falling back is not silent —
 * `usedSuiteConfig` in the return value says which path ran, so the caller
 * can report an old WASM build rather than shipping a render that quietly
 * dropped half the chain.
 */
export function applyChainConfigForRender(
  chain: WasmMasteringChain,
  c: OfflineChainConfig,
): { usedSuiteConfig: boolean } {
  if (c.suiteConfig && typeof chain.setConfigJson === 'function') {
    chain.setConfigJson(JSON.stringify(c.suiteConfig));
    return { usedSuiteConfig: true };
  }
  applyOfflineConfig(chain, c);
  return { usedSuiteConfig: false };
}

/**
 * Add gain to a config's INPUT stage, wherever that config keeps it.
 *
 * A config has two input-gain fields and only one of them is ever read.
 * `applyChainConfigForRender` prefers `suiteConfig`: when it is present the
 * whole JSON goes to the engine and the flat fields are never looked at
 * again. So adding a loudness correction to the flat `inputGainDb` of a
 * suite-configured render is a no-op — the second pass renders at exactly
 * the level of the first, the render reports the gain it "applied", and the
 * file misses the target by however much was asked for.
 *
 * That is not hypothetical. The app's export path sends `suiteConfig`, so
 * every loudness-normalised master went out with the correction silently
 * discarded until this was fixed.
 */
export function withInputGain(config: OfflineChainConfig, addDb: number): OfflineChainConfig {
  if (config.suiteConfig) {
    const suite = config.suiteConfig as { inputGainDb?: number };
    return {
      ...config,
      suiteConfig: { ...suite, inputGainDb: (suite.inputGainDb ?? 0) + addDb },
    };
  }
  return { ...config, inputGainDb: config.inputGainDb + addDb };
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
}
