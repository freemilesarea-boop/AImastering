// render-song — render ONE song through whatever the user actually set.
//
// Until now the Studio's chain config could be heard but not exported. The
// main process has had `audio:master-rust-experimental` — the same Rust
// `MasteringChain` the realtime preview runs, taking a full suite config —
// registered and allowlisted in the preload the whole time, with **zero
// callers** in the renderer. Every export went through `audio:master`,
// which takes five scalar options and knows nothing about the rack. That is
// why tuning a song in the Studio and then rendering it produced a file that
// sounded nothing like the preview.
//
// This module is that caller. Given a song's saved settings and the album
// preset, it layers them, builds the same `ChainConfigWire` the preview
// consumes, and sends it. A song with no saved settings falls through to
// `audio:master` exactly as before, so nothing regresses for someone who
// never opens the Studio.
//
// The main-process handler already falls back to the Python renderer on any
// Rust failure, so a render here cannot fail merely because the Rust backend
// is missing on this machine.

import { buildChainConfig } from '../chain-config.js';
import { freeBandToWire } from '../modules/eq-graph-model.js';
import { layerAlbumPreset, type LayerReport, type SongSettings } from './song-settings.js';
import { louiPresetToMasteringOptions } from '../presets/preset-to-options.js';
import type { LouiPreset } from '../presets/loui-presets.js';
import type { MasteringOptions } from '../../stores/audioStore.js';
import type { AudioAnalysisResult, MasteringResult } from '@aimaster/shared-types';

/** What the main process answers on the Rust render channel. */
interface RustRenderResponse {
  ok: boolean;
  backend: 'rust' | 'python';
  fallbackUsed: boolean;
  outputPath?: string;
  previewPath?: string;
  metrics?: unknown;
  renderMs?: number;
  error?: string;
}

export interface RenderSongInput {
  filePath: string;
  analysis: AudioAnalysisResult;
  /** Baseline options (loudness target, sample rate, bit depth). */
  options: MasteringOptions;
  /** The song's Studio work, or null if it was never opened. */
  settings: SongSettings | null;
  /** The one preset chosen for the whole batch, or null. */
  albumPreset: LouiPreset | null;
}

export interface RenderSongOutput {
  result: MasteringResult;
  /** Which path actually ran, for the queue row to report honestly. */
  path: 'studio' | 'classic';
  backend?: 'rust' | 'python';
  /** Only present on the studio path. */
  layered?: LayerReport;
}

/**
 * Resolve the loudness half of the job.
 *
 * The album preset decides how loud the record is even on the studio path,
 * because that is the thing a batch is for. Per-song limiter work is still
 * protected — `layerAlbumPreset` keeps it in the chain config — but the
 * two-pass normalisation target is an album-level decision.
 */
function optionsFor(base: MasteringOptions, albumPreset: LouiPreset | null): MasteringOptions {
  if (!albumPreset) return base;
  return { ...base, ...louiPresetToMasteringOptions(albumPreset) };
}

/**
 * Render one song.
 *
 * Throws only if the IPC bridge itself is unavailable or the main process
 * reports a hard failure; a Rust-side failure is handled there by falling
 * back to Python and is reported through `backend`.
 */
export async function renderSong(input: RenderSongInput): Promise<RenderSongOutput> {
  const api = window.electronAPI;
  if (!api) throw new Error('electronAPI unavailable');

  const options = optionsFor(input.options, input.albumPreset);

  // No Studio work on this song — the classic path, unchanged.
  if (!input.settings) {
    const result = await api.invoke(
      'audio:master',
      input.filePath,
      '',
      {
        style:              options.style,
        targetLufs:         options.targetLufs,
        targetTp:           options.targetTp,
        sampleRate:         options.sampleRate,
        bitDepth:           options.bitDepth,
        applyAiCorrections: options.applyAiCorrections,
        limiterStrength:    options.limiterStrength,
        saturationAmount:   options.saturationAmount,
        stereoWidth:        options.stereoWidth,
        outputGainDb:       options.outputGainDb,
        aiDetections:       input.analysis.aiDetection ?? {},
      },
      { preLoudness: input.analysis.loudness },
    ) as MasteringResult;
    return { result, path: 'classic' };
  }

  // The studio path. Layer the album preset under the song's own work,
  // then build the very config the preview plays.
  const { state, report } = layerAlbumPreset(input.settings.state, input.albumPreset);
  const suiteConfig = buildChainConfig({
    state,
    masterBypass: input.settings.masterBypass,
    parametricBands: input.settings.freeBands.map(freeBandToWire),
    // No `monitor`: A/B and delta are listening aids. Baking one into an
    // export would ship a level-matched bypass as the master.
  });

  // Loudness is reached differently offline, on purpose.
  //
  // The chain's loudness stage is a converging loop — it has to be, because
  // realtime gets one pass over audio it has not heard yet. The offline
  // render is not under that constraint: it measures the whole file and
  // re-renders with a single constant gain, which is strictly better,
  // because a loop that is still converging during the intro would leave
  // the first seconds of the file at a different level from the rest.
  //
  // So the loop is switched off for the render and the two-pass does the
  // job. Both aim at the same number, so the file lands where the preview
  // sounded — the mechanism differs, the result does not.
  const target = typeof suiteConfig.loudness?.targetLufs === 'number'
    ? suiteConfig.loudness.targetLufs
    : options.targetLufs;
  const exportConfig = {
    ...suiteConfig,
    ...(suiteConfig.loudness ? { loudness: { ...suiteConfig.loudness, enabled: false } } : {}),
  };

  const res = await api.invoke('audio:master-rust-experimental', {
    sourcePath: input.filePath,
    chainConfig: { suiteConfig: exportConfig },
    // The Studio's own Target LUFS decides the file's loudness — it is the
    // number the user was listening to. Layering has already settled who
    // owns it: a song that did not claim the limiter took the album
    // preset's value, so a batch still comes out even.
    options: { ...options, targetLufs: target },
  }) as RustRenderResponse;

  if (!res.ok || !res.outputPath) {
    throw new Error(res.error || 'render failed');
  }

  // The Rust channel answers with paths and metrics rather than the full
  // Python report. Fill the rest from the analysis so the result page has
  // its before/after without a second pass.
  const result: MasteringResult = {
    outputPath:  res.outputPath,
    previewPath: res.previewPath ?? '',
    appliedCorrections: [],
    loudnessBefore: {
      integratedLufs: input.analysis.loudness?.integratedLufs ?? 0,
      truePeakDbtp:   input.analysis.loudness?.truePeakDbtp ?? 0,
      lra:            input.analysis.loudness?.lra ?? 0,
    },
    loudnessAfter: (res.metrics as MasteringResult['loudnessAfter'])
      ?? input.analysis.loudness,
    spectralBalance: null,
    analysisReport: null,
    pipelineWarnings: res.fallbackUsed
      ? [{
          code: 'rust_offline_fallback',
          level: 'warning',
          userMessage: 'Rust 렌더에 실패해 기존 엔진으로 처리했습니다. 스튜디오 설정 일부가 반영되지 않았을 수 있습니다.',
        }]
      : [],
    processingTimeSec: (res.renderMs ?? 0) / 1000,
  };

  return { result, path: 'studio', backend: res.backend, layered: report };
}
