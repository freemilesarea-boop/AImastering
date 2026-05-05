// Simplified mastering mode system.
//
// Three preset bundles, each tuning every stage of the pipeline:
//
//   CLEAN     — minimal processing, broadcast-style headroom, slow release.
//               Soft clip barely engages; vocal correction is half-strength;
//               transients are virtually untouched; final loudness target
//               -16 LUFS leaves dynamic range intact.
//
//   BALANCED  — the default.  Modern streaming-style loudness target
//               (-12 LUFS), moderate soft-clip threshold, music-program
//               release times, full vocal-correction headroom.
//
//   LOUD      — aggressive.  Engineered for KPOP / EDM / commercial
//               loud-master targets (-8 LUFS), with earlier soft-clip
//               engagement to add harmonic glue, fast limiter release
//               for forward energy, more transient taming so the body
//               of the program comes up uniformly, and stronger vocal
//               correction to keep diction over a wall of mix.
//
// The mode object packages parameters for *every* downstream stage so
// the orchestrator below can run a coherent pipeline from one switch.

import { applyGainStaging,    type GainStagingParams }       from './gainStaging.js';
import { protectTransients,   type TransientProtectParams }  from './transientProtection.js';
import { enhanceVocal,        type EnhanceVocalOptions }     from './vocalEnhancer.js';
import { processLimiter,      type ProcessLimiterOptions }   from './limiterChain.js';
import { getLoudnessMetrics, type AudioBufferLike }          from './loudnessCore.js';
import { generateMasteringReport, type MasteringReport }     from './report.js';

export type MasteringMode = 'CLEAN' | 'BALANCED' | 'LOUD';

export interface ModeConfig {
  mode:             MasteringMode;
  label:            string;
  description:      string;
  /** Final integrated-LUFS target. */
  targetLufs:       number;
  // Per-stage parameter bundles.
  gainStaging:      GainStagingParams;
  transientProtect: TransientProtectParams;
  vocalEnhance:     EnhanceVocalOptions;
  limiter:          ProcessLimiterOptions;
}

// ── Preset definitions ───────────────────────────────────────────────────────
export const MODE_CONFIGS: Record<MasteringMode, ModeConfig> = {
  CLEAN: {
    mode:        'CLEAN',
    label:       'Clean',
    description: 'Minimal processing · maximum dynamics',
    targetLufs:  -16,

    gainStaging: {
      // Conservative — preserve the most headroom.
      targetPeakDb:    -8,
      targetRmsDb:     -22,
      targetLufs:      -22,
      maxBoostDb:      6,
    },

    transientProtect: {
      // Barely engage — preserve every kick / snare attack.
      thresholdRatio: 2.5,
      maxReductionDb: 0.5,
      attackMs:       1,
      releaseMs:      30,
      slope:          0.3,
    },

    vocalEnhance: {
      // Half-strength: only tiny adjustments allowed.
      scoreThreshold:  0.55,
      maxCorrectionDb: 0.8,
    },

    limiter: {
      // Loose ceiling, slow release, conservative TP guard.
      truePeakCeilingDb: -1.5,
      softClip:          { thresholdDb: -1, driveDb: 0 },
      peakLimiter: {
        ceilingDb:    -3,
        lookAheadMs:  6,
        releaseMs:    200,
        fastRatio:    2,
        holdMs:       3,
      },
      toleranceLu: 0.4,
      maxIters:    3,
    },
  },

  BALANCED: {
    mode:        'BALANCED',
    label:       'Balanced',
    description: 'Streaming-ready · default',
    targetLufs:  -12,

    gainStaging: {
      // Standard mastering working level.
      targetPeakDb:    -6,
      targetRmsDb:     -18,
      targetLufs:      -18,
      maxBoostDb:      12,
    },

    transientProtect: {
      // Moderate taming.
      thresholdRatio: 1.5,
      maxReductionDb: 1.5,
      attackMs:       1,
      releaseMs:      20,
      slope:          0.6,
    },

    vocalEnhance: {
      // Default: detector + full correction headroom.
      scoreThreshold:  0.40,
      maxCorrectionDb: 2.0,
    },

    limiter: {
      truePeakCeilingDb: -1,
      softClip:          { thresholdDb: -3, driveDb: 0 },
      peakLimiter: {
        ceilingDb:    -1.5,
        lookAheadMs:  5,
        releaseMs:    80,
        fastRatio:    3,
        holdMs:       2,
      },
      toleranceLu: 0.3,
      maxIters:    4,
    },
  },

  LOUD: {
    mode:        'LOUD',
    label:       'Loud',
    description: 'Commercial loudness · aggressive',
    targetLufs:  -8,

    gainStaging: {
      // Hot working level so stage 2 has less to do.
      targetPeakDb:    -3,
      targetRmsDb:     -14,
      targetLufs:      -14,
      maxBoostDb:      18,
    },

    transientProtect: {
      // Aggressive — body of the program comes up uniformly.
      thresholdRatio: 1.3,
      maxReductionDb: 2.5,
      attackMs:       1,
      releaseMs:      15,
      slope:          0.9,
    },

    vocalEnhance: {
      // Push diction through a wall of mix.
      scoreThreshold:  0.35,
      maxCorrectionDb: 3.0,
    },

    limiter: {
      truePeakCeilingDb: -1,
      // Soft-clip engages earlier + small drive for harmonic glue.
      softClip:          { thresholdDb: -6, driveDb: 1 },
      peakLimiter: {
        // -1.0 dBFS sample-peak ceiling gives the inter-sample peaks
        // ~0.5 dB of headroom so the TP guard almost never has to
        // engage — it stays a true safety net, not the primary control.
        ceilingDb:    -1.0,
        lookAheadMs:  3,
        releaseMs:    40,
        fastRatio:    4,
        holdMs:       1,
      },
      toleranceLu: 0.3,
      maxIters:    5,
    },
  },
};

export function getModeConfig(mode: MasteringMode): ModeConfig {
  return MODE_CONFIGS[mode];
}

// ── Pipeline orchestrator ────────────────────────────────────────────────────

export interface ModePipelineResult {
  mode:           MasteringMode;
  buffer:         AudioBufferLike;
  /** Per-stage diagnostics (so the report panel can pull from them). */
  stages: {
    gainStaging:      ReturnType<typeof applyGainStaging>;
    transientProtect: ReturnType<typeof protectTransients>;
    vocalEnhance:     ReturnType<typeof enhanceVocal>;
    limiter:          ReturnType<typeof processLimiter>;
  };
  inputMetrics:   ReturnType<typeof getLoudnessMetrics>;
  outputMetrics:  ReturnType<typeof getLoudnessMetrics>;
  report:         MasteringReport;
}

/**
 * Run the full mastering pipeline using a mode preset.  Order:
 *
 *   gain-stage → transient-protect → vocal-enhance → limiter → report
 *
 * Returns the processed buffer + every stage's diagnostics + the
 * generated MasteringReport, all in one shot.
 */
export function processMasteringWithMode(
  input: AudioBufferLike,
  mode: MasteringMode,
): ModePipelineResult {
  const cfg = MODE_CONFIGS[mode];

  const inputMetrics = getLoudnessMetrics(input);

  const gainStaging      = applyGainStaging(input,                cfg.gainStaging);
  const transientProtect = protectTransients(gainStaging.buffer,  cfg.transientProtect);
  const vocalEnhance     = enhanceVocal(transientProtect.buffer,  cfg.vocalEnhance);
  const limiter          = processLimiter(vocalEnhance.buffer, cfg.targetLufs, cfg.limiter);

  const outputMetrics = getLoudnessMetrics(limiter.buffer);

  const report = generateMasteringReport({
    inputMetrics,
    outputMetrics,
    gainStaging,
    transientProtect,
    vocalEnhance,
    limiter,
    customNotes: [`Preset: ${cfg.label} (${cfg.description})`],
  });

  return {
    mode,
    buffer: limiter.buffer,
    stages: { gainStaging, transientProtect, vocalEnhance, limiter },
    inputMetrics,
    outputMetrics,
    report,
  };
}
