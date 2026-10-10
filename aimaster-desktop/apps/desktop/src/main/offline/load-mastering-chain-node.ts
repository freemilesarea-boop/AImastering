// Loads the Node-target WASM MasteringChain (RUST-OFFLINE-RENDER-1).
//
// Reuses the EXACT same Rust MasteringChain as the realtime preview, built
// with `wasm-bindgen --target nodejs` (packages/dsp-wasm/pkg-node).  Loaded
// via `require` so it works in the Electron main (Node) process and in
// headless tsx scripts (the parity harness).

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import { ancestorCandidates } from '../utils/workspace-paths.js';

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
 * Covers the original five modules only — everything the Ozone-class suite
 * added travels as `suiteConfig` instead (see `OfflineSuiteChainConfig`).
 */
export interface OfflineFlatChainConfig {
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
  /** Never set on this member — it is what distinguishes the two. */
  suiteConfig?: undefined;
}

/**
 * A render driven by the full module-suite config (the renderer's
 * `ChainConfigWire`), applied via `setConfigJson`.
 *
 * It is the same object the realtime preview sends, which is what keeps
 * preview and export from drifting apart.
 *
 * The flat fields are optional here, and that is the point: `render-song`
 * sends `{ suiteConfig }` and nothing else, while this type used to require
 * all 22 of them.  Nothing complained, because the IPC boundary is cast
 * rather than checked — so the declared shape of the one config the Studio
 * actually renders with had never been true.
 */
export interface OfflineSuiteChainConfig
  extends Partial<Omit<OfflineFlatChainConfig, 'suiteConfig'>> {
  suiteConfig: Record<string, unknown>;
}

export type OfflineChainConfig = OfflineFlatChainConfig | OfflineSuiteChainConfig;

/**
 * Whether the Python engine may stand in for a failed Rust render.
 *
 * It may only when there is nothing for it to drop.  `masterFile` takes
 * five scalar options and has no way to apply a chain config, so standing
 * in for a request that carried one produces a master the user did not ask
 * for — which was reported, correctly, as "설정 저장을 눌렀는데 원본으로
 * 돌아간다".
 *
 * A pure predicate rather than a condition inlined in the IPC handler, so
 * the rule can be tested without an Electron main process.
 */
export function pythonFallbackMayStandIn(
  chainConfig: { suiteConfig?: unknown } | null | undefined,
): boolean {
  return !chainConfig?.suiteConfig;
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

/** Where the node-target WASM glue sits, relative to the workspace root. */
const WASM_NODE_REL  = path.join('packages', 'dsp-wasm', 'pkg-node');
const WASM_NODE_FILE = 'loui_dsp_wasm.cjs';
/**
 * The directory electron-builder copies `pkg-node` into, under
 * `process.resourcesPath`.
 *
 * Exported because two places have to agree on it — this loader and the
 * `extraResources` entry in electron-builder.yml — and a test checks that
 * they still do.  They did not: there was no entry at all, so the packaged
 * candidate pointed at a directory nothing ever created.
 */
export const WASM_NODE_RESOURCE_DIR = 'dsp-wasm-node';

/**
 * Candidate locations for the node-target WASM glue, in priority order.
 *
 * The workspace copy is found by WALKING UP from `fromDir`, not by counting
 * directories.  The count was `../../../../../packages/dsp-wasm/pkg-node`,
 * which is correct from `src/main/offline` — where tsx runs this, so every
 * selftest found the module — and one level too high from
 * `dist-electron/main`, where esbuild puts the bundled main process.  So the
 * tests passed and the app never loaded the chain: `isRustOfflineAvailable()`
 * was false in every dev run and every packaged build, and the three
 * features that need it (the Studio's offline render, the song profile, the
 * Match EQ reference) all silently took their failure path.
 *
 * Walking up cannot be made wrong again by moving the build output.
 *
 * Takes its starting directory as an argument so a test can ask about a
 * directory it is not running in — which is the only way to check the one
 * that matters.
 */
export function wasmNodeCandidates(fromDir: string, resourcesPath?: string | null): string[] {
  const c: string[] = [];
  const override = process.env['LOUI_WASM_NODE_PATH'];
  if (override) c.push(override);
  c.push(...ancestorCandidates(fromDir, path.join(WASM_NODE_REL, WASM_NODE_FILE)));
  if (resourcesPath) c.push(path.join(resourcesPath, WASM_NODE_RESOURCE_DIR, WASM_NODE_FILE));
  return c;
}

let cached: WasmModule | null | undefined;

/** Resolve + require the node WASM module.  Returns null when unavailable
 *  (caller falls back to the Python engine). */
export function loadWasmModule(): WasmModule | null {
  if (cached !== undefined) return cached;
  for (const p of wasmNodeCandidates(__dirname, process.resourcesPath)) {
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

/**
 * Apply a config to a chain.
 *
 * A config that carries a `suiteConfig` is applied through
 * `setConfigJson` — the same object the realtime preview sends, which is
 * what keeps preview and export from drifting apart.  A WASM build too old
 * to have that entry point cannot honour it, so this THROWS.
 *
 * It used to fall through to the flat positional call instead, and return a
 * `usedSuiteConfig: false` flag so "the caller can report an old WASM build
 * rather than shipping a render that quietly dropped half the chain".  No
 * caller ever read the flag.  Worse, the fall-through could not work: the
 * only producer of a `suiteConfig` (`render-song`) sends `{ suiteConfig }`
 * and nothing else, so `applyOfflineConfig` would have passed `undefined`
 * into all 22 arguments of `setConfig`.  Refusing is the only honest
 * answer — a master that silently is not what the user set is the bug this
 * whole change is about.
 */
export function applyChainConfigForRender(
  chain: WasmMasteringChain,
  c: OfflineChainConfig,
): void {
  if (c.suiteConfig) {
    if (typeof chain.setConfigJson !== 'function') {
      throw new Error(
        'this WASM build has no setConfigJson, so the module-suite config cannot be applied '
        + '(rebuild: pnpm --filter @loui/dsp-wasm run build:node)',
      );
    }
    chain.setConfigJson(JSON.stringify(c.suiteConfig));
    return;
  }
  applyOfflineConfig(chain, c);
}

/** Apply a flat config to a chain (spreads the 22 args in setConfig order).
 *  Also applies the optional free parametric EQ band list. */
export function applyOfflineConfig(chain: WasmMasteringChain, c: OfflineFlatChainConfig): void {
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
