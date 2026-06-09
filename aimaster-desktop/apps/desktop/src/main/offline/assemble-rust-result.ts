// assemble-rust-result — build a MasteringResult-compatible object from a
// Rust offline render + Python post-analysis (RUST-OFFLINE-RENDER / engine
// unification, Phase 1 / C-2a).
//
// Why this exists
//   The production `audio:master` (Python) returns the rich MasteringResult
//   the ResultPage renders (loudness before/after, analysisReport, quality
//   check, metric comparison, …).  The Rust offline render returns only a
//   slim `{outputPath, previewPath, metrics}` shape, so routing export
//   through it would leave the result UI half-empty.
//
//   This module closes the gap WITHOUT re-running the Python master
//   pipeline: after the Rust chain renders the WAV, the caller runs the
//   Python `analyze` on the source + the rendered output and (optionally)
//   `qc_check` on the output, then assembles those parts into a
//   MasteringResult.  Fields that are intrinsically Python-pipeline-internal
//   (per-stage gain-staging, suspect segments) are left undefined — they are
//   all optional and the UI renders without them.
//
//   `analysisReport` is SYNTHESISED from the Rust chain config (what the Rust
//   chain was told to apply) + the measured before/after loudness, so the UI
//   still shows the applied EQ / dynamics / limiter for the Rust backend.
//
// This function is PURE (no I/O, no Python, no ffmpeg) → unit-testable
// headlessly.  The orchestration that calls `analyze`/`qc_check` lives in
// the IPC handler.

import type {
  AnalysisReport,
  AudioAnalysisResult,
  EqMoveReport,
  MasteringOptions,
  MasteringResult,
  MetricComparisonRow,
  QCResult,
  QualityCheckItem,
  QualityCheckReport,
} from '@aimaster/shared-types';
import type { OfflineChainConfig } from './load-mastering-chain-node.js';

export interface RustResultParts {
  outputPath: string;
  previewPath: string;
  processingTimeSec: number;
  loudnessNormalized: boolean;
  chainConfig: OfflineChainConfig;
  options: MasteringOptions;
  /** Python `analyze` on the SOURCE file (before).  Null if it failed. */
  sourceAnalysis: AudioAnalysisResult | null;
  /** Python `analyze` on the RENDERED file (after).  Required. */
  outputAnalysis: AudioAnalysisResult;
  /** Python `qc_check` on the rendered file.  Optional. */
  outputQc?: QCResult | null;
  /** Extra pipeline warnings (e.g. the rust→python fallback notice). */
  extraWarnings?: Array<{ code: string; level: string; userMessage: string }>;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** Human-readable list of what the Rust chain applied (UI "처리 내역"). */
export function buildAppliedCorrections(cfg: OfflineChainConfig, options: MasteringOptions): string[] {
  const out: string[] = [];
  if (cfg.masterBypass) { out.push('마스터 바이패스 (처리 없음)'); return out; }
  if (!cfg.eqBypass) {
    if (cfg.eqLowCutHz > 20) out.push(`EQ: 로우컷 ${Math.round(cfg.eqLowCutHz)} Hz`);
    if (cfg.eqLowShelfDb) out.push(`EQ: 로우셸프 ${cfg.eqLowShelfDb > 0 ? '+' : ''}${r2(cfg.eqLowShelfDb)} dB`);
    if (cfg.eqPresenceDb) out.push(`EQ: 프레즌스 ${cfg.eqPresenceDb > 0 ? '+' : ''}${r2(cfg.eqPresenceDb)} dB`);
    if (cfg.eqAirDb) out.push(`EQ: 에어 ${cfg.eqAirDb > 0 ? '+' : ''}${r2(cfg.eqAirDb)} dB`);
  }
  const bands = cfg.parametricBands?.filter((b) => b.enabled) ?? [];
  if (bands.length) out.push(`파라메트릭 EQ: ${bands.length} 밴드`);
  if (!cfg.dynBypass && cfg.dynRatio > 1) {
    out.push(`컴프레서: ${r2(cfg.dynRatio)}:1, thr ${r2(cfg.dynThresholdDb)} dB`);
  }
  if (!cfg.imgBypass && cfg.imgWidthPct !== 100) out.push(`스테레오 폭: ${Math.round(cfg.imgWidthPct)}%`);
  if (!cfg.limBypass) out.push(`리미터: ceiling ${r2(cfg.limCeilingDbtp)} dBTP${cfg.limIsp ? ' (ISP)' : ''}`);
  if (cfg.outputGainDb) out.push(`출력 게인 ${cfg.outputGainDb > 0 ? '+' : ''}${r2(cfg.outputGainDb)} dB`);
  if (options) out.push(`라우드니스 타겟 ${r2(options.targetLufs)} LUFS`);
  return out;
}

/** Synthesise an AnalysisReport from the Rust chain config + measured loudness. */
export function buildAnalysisReport(parts: RustResultParts): AnalysisReport {
  const { chainConfig: cfg, options, sourceAnalysis, outputAnalysis } = parts;
  const before = sourceAnalysis?.loudness ?? null;
  const after = outputAnalysis.loudness;
  const beforeLufs = before?.integratedLufs ?? after.integratedLufs;

  const eqMoves: EqMoveReport[] = [];
  if (!cfg.eqBypass) {
    if (cfg.eqLowShelfDb) eqMoves.push({ band: 'low', freqHz: 120, gainDb: r2(cfg.eqLowShelfDb), gainStr: `${r2(cfg.eqLowShelfDb)} dB`, filter: 'lowshelf', adaptive: cfg.eqAdaptive });
    if (cfg.eqPresenceDb) eqMoves.push({ band: 'presence', freqHz: 3000, gainDb: r2(cfg.eqPresenceDb), gainStr: `${r2(cfg.eqPresenceDb)} dB`, filter: 'bell', adaptive: cfg.eqAdaptive });
    if (cfg.eqAirDb) eqMoves.push({ band: 'air', freqHz: 12000, gainDb: r2(cfg.eqAirDb), gainStr: `${r2(cfg.eqAirDb)} dB`, filter: 'highshelf', adaptive: cfg.eqAdaptive });
  }

  const targetReached = Math.abs(after.integratedLufs - options.targetLufs) <= 1.0;

  return {
    mastering: {
      mode: options.style,
      targetLufs: options.targetLufs,
      targetTruePeak: options.targetTp,
      limiterStrength: options.limiterStrength ?? 'medium',
      appliedGainDb: r2(cfg.outputGainDb),
      limiterReductionDb: 0,
      correctionApplied: false,
      correctionGainDb: 0,
      staticChain: parts.loudnessNormalized,
      useLinearLoudnorm: parts.loudnessNormalized,
      targetReached,
    },
    eqMoves,
    compressor: {
      style: options.style,
      thresholdDb: r2(cfg.dynThresholdDb),
      ratio: r2(cfg.dynRatio),
      attackMs: r2(cfg.dynAttackMs),
      releaseMs: r2(cfg.dynReleaseMs),
      makeupDb: 0,
      estimatedGrDb: 0,
    },
    limiter: {
      ceilingDbtp: r2(cfg.limCeilingDbtp),
      preGainDbtp: 0,
      appliedGrDb: 0,
      preLimLufs: r2(beforeLufs),
    },
    loudnorm: {
      targetLufs: options.targetLufs,
      measuredBefore: r2(beforeLufs),
      gainAppliedDb: r2(after.integratedLufs - beforeLufs),
    },
    spectralBefore: null,
    spectralAfter: null,
    loudnessBefore: {
      integratedLufs: r2(beforeLufs),
      truePeakDbtp: r2(before?.truePeakDbtp ?? after.truePeakDbtp),
      lra: r2(before?.lra ?? after.lra),
    },
    loudnessAfter: {
      integratedLufs: r2(after.integratedLufs),
      truePeakDbtp: r2(after.truePeakDbtp),
      lra: r2(after.lra),
    },
  };
}

function cmpStatus(key: string, after: number, options: MasteringOptions): MetricComparisonRow['status'] {
  if (key === 'lufs') return Math.abs(after - options.targetLufs) <= 1 ? 'ok' : Math.abs(after - options.targetLufs) <= 3 ? 'warn' : 'danger';
  if (key === 'tp') return after <= options.targetTp + 0.01 ? 'ok' : after <= options.targetTp + 1 ? 'warn' : 'danger';
  if (key === 'lra') return after >= 4 ? 'ok' : after >= 2.5 ? 'warn' : 'danger';
  return 'ok';
}

/** before/after metric comparison rows (LUFS / True-Peak / LRA). */
export function buildMetricComparison(parts: RustResultParts): MetricComparisonRow[] {
  const before = parts.sourceAnalysis?.loudness ?? null;
  const after = parts.outputAnalysis.loudness;
  const row = (key: string, label: string, unit: string, b: number | null, a: number, hint: string): MetricComparisonRow => ({
    key, label, unit, before: b === null ? null : r2(b), after: r2(a),
    delta: b === null ? null : r2(a - b), status: cmpStatus(key, a, parts.options), hint,
  });
  return [
    row('lufs', 'Integrated LUFS', 'LUFS', before?.integratedLufs ?? null, after.integratedLufs, '타겟 대비 통합 라우드니스'),
    row('tp', 'True Peak', 'dBTP', before?.truePeakDbtp ?? null, after.truePeakDbtp, '인터샘플 피크 / 실링'),
    row('lra', 'Loudness Range', 'LU', before?.lra ?? null, after.lra, '다이내믹 레인지'),
  ];
}

/** Map the 12-item QCResult into the MasteringResult.qualityCheck shape. */
export function mapQcToQualityCheck(qc: QCResult): QualityCheckReport {
  const toStatus = (s: string): 'ok' | 'warn' | 'danger' =>
    s === 'pass' ? 'ok' : s === 'warning' ? 'warn' : 'danger';
  const items: QualityCheckItem[] = qc.items.map((i) => ({
    name: i.label,
    status: toStatus(i.status),
    message: i.message,
    value: i.value ?? null,
  }));
  const overall = toStatus(qc.overall);
  return {
    overall,
    summary: `${qc.passCount}/${qc.totalCount} 통과`,
    items,
  };
}

/** Assemble the full MasteringResult-compatible object (pure). */
export function assembleRustMasteringResult(parts: RustResultParts): MasteringResult {
  const before = parts.sourceAnalysis?.loudness ?? null;
  const after = parts.outputAnalysis.loudness;

  const result: MasteringResult = {
    outputPath: parts.outputPath,
    previewPath: parts.previewPath,
    appliedCorrections: buildAppliedCorrections(parts.chainConfig, parts.options),
    loudnessBefore: {
      integratedLufs: r2(before?.integratedLufs ?? after.integratedLufs),
      truePeakDbtp: r2(before?.truePeakDbtp ?? after.truePeakDbtp),
      lra: r2(before?.lra ?? after.lra),
    },
    loudnessAfter: {
      integratedLufs: r2(after.integratedLufs),
      truePeakDbtp: r2(after.truePeakDbtp),
      lra: r2(after.lra),
      shortTermMax: r2(after.shortTermMax),
    },
    spectralBalance: null,
    analysisReport: buildAnalysisReport(parts),
    pipelineWarnings: parts.extraWarnings ?? [],
    processingTimeSec: r2(parts.processingTimeSec),
    metricComparison: buildMetricComparison(parts),
  };

  if (parts.outputQc) result.qualityCheck = mapQcToQualityCheck(parts.outputQc);

  return result;
}
