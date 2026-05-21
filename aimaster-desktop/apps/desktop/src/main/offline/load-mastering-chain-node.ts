// Loads the Node-target WASM MasteringChain (RUST-OFFLINE-RENDER-1).
//
// Reuses the EXACT same Rust MasteringChain as the realtime preview, built
// with `wasm-bindgen --target nodejs` (packages/dsp-wasm/pkg-node).  Loaded
// via `require` so it works in the Electron main (Node) process and in
// headless tsx scripts (the parity harness).

import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

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
  processStereo(left: Float32Array, right: Float32Array): void;
  limiterGrDb(): number;
  reset(): void;
  free?(): void;
}

interface WasmModule {
  LouiMasteringChain: new (sampleRate: number) => WasmMasteringChain;
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

/** Apply a flat config to a chain (spreads the 22 args in setConfig order). */
export function applyOfflineConfig(chain: WasmMasteringChain, c: OfflineChainConfig): void {
  chain.setConfig(
    c.inputGainDb,
    c.eqLowCutHz, c.eqLowShelfDb, c.eqPresenceDb, c.eqAirDb, c.eqAdaptive, c.eqBypass,
    c.dynThresholdDb, c.dynRatio, c.dynAttackMs, c.dynReleaseMs, c.dynMixPct, c.dynBypass,
    c.imgWidthPct, c.imgLowMonoHz, c.imgBypass,
    c.limCeilingDbtp, c.limLookaheadMs, c.limIsp, c.limBypass,
    c.outputGainDb, c.masterBypass,
  );
}
