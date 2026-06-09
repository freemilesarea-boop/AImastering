// export-backend — choose the offline export engine (engine unification C-2b).
//
// Production export historically always went through the Python engine
// (`audio:master`).  The Rust offline render (`audio:master-rust-experimental`)
// now returns a full MasteringResult (see main/offline/assemble-rust-result.ts),
// so the renderer can prefer it when the flag is on — with an automatic
// fall-back to Python on ANY failure.
//
//   isRustOfflineRenderEnabled() === false (DEFAULT)
//     → only `audio:master` (Python).  Zero behaviour change.
//   isRustOfflineRenderEnabled() === true (opt-in / post-sign-off)
//     → try the Rust channel; on throw or unusable result, fall back to
//       `audio:master`.  The Rust handler ALSO falls back internally, so the
//       renderer fallback only fires when the whole IPC fails.
//
// The routing is a PURE function of an injected `invoke`, so it is unit
// tested headlessly with a mock transport (no Electron, no Python).

import type { MasteringResult } from '@aimaster/shared-types';
import type { MasteringOptions, RealtimeDspOverrides } from '../stores/audioStore.js';
import type { RealtimeChainConfig } from './realtime-mastering-chain.js';
import type { MultibandConfig } from './multiband-config.js';
import { isMultibandUnity } from './multiband-config.js';
import { isRustOfflineRenderEnabled } from './rust-offline-render-flag.js';

/**
 * Build a RealtimeChainConfig from MasteringOptions.  Single source of truth
 * for store-options → DSP-chain mapping, shared by the live preview chain
 * (ResultPage) and the Rust offline export request.  A RealtimeChainConfig
 * structurally satisfies the main process's OfflineChainConfig (whose only
 * extra field, `parametricBands`, is optional), so it is sent as-is.
 */
export function optionsToChainConfig(opts: MasteringOptions): RealtimeChainConfig {
  const rt: RealtimeDspOverrides = opts.rt ?? {};
  return {
    inputGainDb:    0,
    eqLowCutHz:     rt.eqLowCutHz     ?? 20,
    eqLowShelfDb:   rt.eqLowShelfDb   ?? 0,
    eqPresenceDb:   rt.eqPresenceDb   ?? 0,
    eqAirDb:        rt.eqAirDb        ?? 0,
    eqAdaptive:     opts.applyAiCorrections,
    eqBypass:       rt.eqBypass       ?? false,
    dynThresholdDb: rt.dynThresholdDb ?? -18,
    dynRatio:       rt.dynRatio       ?? 2,
    dynAttackMs:    rt.dynAttackMs    ?? 10,
    dynReleaseMs:   rt.dynReleaseMs   ?? 120,
    dynMixPct:      rt.dynMixPct      ?? 100,
    dynBypass:      rt.dynBypass      ?? false,
    imgWidthPct:    rt.imgWidthPct    ?? (opts.stereoWidth != null ? opts.stereoWidth * 100 : 100),
    imgLowMonoHz:   rt.imgLowMonoHz   ?? 120,
    imgBypass:      rt.imgBypass      ?? false,
    limCeilingDbtp: rt.limCeilingDbtp ?? opts.targetTp ?? -1,
    limLookaheadMs: 2.5,
    limIsp:         true,
    limBypass:      rt.limBypass      ?? false,
    outputGainDb:   opts.outputGainDb ?? 0,
    masterBypass:   rt.masterBypass   ?? false,
  };
}

export type InvokeFn = (channel: string, ...args: unknown[]) => Promise<unknown>;

/** MasteringResult plus the Rust-channel envelope fields (all optional). */
export type MasterExportResult = MasteringResult & {
  backend?: 'rust' | 'python';
  fallbackUsed?: boolean;
  ok?: boolean;
  error?: string;
  renderMs?: number;
};

/** A Rust-channel response is usable iff it succeeded with a real output path. */
export function isUsableRustResult(res: unknown): res is MasterExportResult {
  if (!res || typeof res !== 'object') return false;
  const r = res as Record<string, unknown>;
  return r['ok'] === true && typeof r['outputPath'] === 'string' && (r['outputPath'] as string).length > 0;
}

export interface MasterExportArgs {
  invoke: InvokeFn;
  sourcePath: string;
  /** Renderer MasteringOptions (incl. rt overrides) — drives the Rust chain. */
  options: MasteringOptions;
  /** The python `audio:master` options object (snake/camel as the bridge wants). */
  pythonOptions: Record<string, unknown>;
  /** The python `audio:master` extras (e.g. { preLoudness }). */
  pythonExtras?: Record<string, unknown>;
  /** Optional 4-band multiband compressor — applied on the Rust export path. */
  multiband?: MultibandConfig;
  requestId?: number;
  /** Override the flag (tests).  Defaults to isRustOfflineRenderEnabled(). */
  rustEnabled?: boolean;
}

/**
 * Master a file through the preferred backend with automatic Python
 * fallback.  Returns a MasteringResult(-compatible) object either way.
 */
export async function masterWithPreferredBackend(args: MasterExportArgs): Promise<MasterExportResult> {
  const { invoke, sourcePath, options, pythonOptions, pythonExtras, requestId } = args;
  const rustEnabled = args.rustEnabled ?? isRustOfflineRenderEnabled();

  if (rustEnabled) {
    try {
      const chainConfig: Record<string, unknown> = { ...optionsToChainConfig(options) };
      // Only attach multiband when it would actually do something.
      if (args.multiband && !isMultibandUnity(args.multiband)) {
        chainConfig['multiband'] = args.multiband;
      }
      const res = await invoke('audio:master-rust-experimental', {
        sourcePath,
        chainConfig,
        options,
        requestId,
      });
      if (isUsableRustResult(res)) return res;
      // eslint-disable-next-line no-console
      console.warn('[export-backend] rust result unusable — python fallback');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[export-backend] rust channel threw — python fallback:', err);
    }
  }

  const res = await invoke('audio:master', sourcePath, '', pythonOptions, pythonExtras ?? {});
  return res as MasterExportResult;
}
