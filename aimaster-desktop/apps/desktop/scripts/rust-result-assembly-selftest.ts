// Selftest — assembleRustMasteringResult shape parity (engine unification C-2a).
//
// Verifies the PURE assembler produces a MasteringResult-compatible object
// from a Rust render + Python analysis parts: required fields present,
// loudness mapped from before/after analysis, analysisReport synthesised
// from the chain config, QC mapped, metric comparison built.  Headless — no
// Python, no ffmpeg, no audio thread.  Run via `pnpm test:rust-result`.

import {
  assembleRustMasteringResult,
  buildAppliedCorrections,
  mapQcToQualityCheck,
  type RustResultParts,
} from '../src/main/offline/assemble-rust-result.js';
import type {
  AudioAnalysisResult,
  MasteringOptions,
  QCResult,
} from '@aimaster/shared-types';
import type { OfflineChainConfig } from '../src/main/offline/load-mastering-chain-node.js';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
}

const cfg: OfflineChainConfig = {
  inputGainDb: 0,
  eqLowCutHz: 32, eqLowShelfDb: 2, eqPresenceDb: 1.5, eqAirDb: 1,
  eqAdaptive: true, eqBypass: false,
  dynThresholdDb: -18, dynRatio: 2, dynAttackMs: 10, dynReleaseMs: 120,
  dynMixPct: 100, dynBypass: false,
  imgWidthPct: 110, imgLowMonoHz: 120, imgBypass: false,
  limCeilingDbtp: -1, limLookaheadMs: 2.5, limIsp: true, limBypass: false,
  outputGainDb: 0, masterBypass: false,
};

const options: MasteringOptions = {
  style: 'balanced', targetLufs: -12, targetTp: -1, sampleRate: 48000,
  bitDepth: 24, applyAiCorrections: true, limiterStrength: 'medium',
};

const mkAnalysis = (lufs: number, tp: number, lra: number): AudioAnalysisResult => ({
  fileInfo: { path: '/x.wav', name: 'x.wav', sizeBytes: 1, durationSec: 10, sampleRate: 48000, bitDepth: 24, channels: 2, format: 'pcm_s24le' },
  loudness: { integratedLufs: lufs, truePeakDbtp: tp, lra, shortTermMax: lufs + 2 },
  aiDetection: { harshHighMid: false, boomyLowEnd: false, brickwallCompression: false, stereoImbalance: false, silenceAtStart: false, silenceAtEnd: false, intersampleRisk: false, upsampleSuspected: false },
  dcOffsetDb: -90, silenceStartMs: 0, silenceEndMs: 0,
});

const qc: QCResult = {
  overall: 'pass',
  passCount: 11, totalCount: 12,
  items: [
    { id: 'lufs', label: 'LUFS', status: 'pass', message: 'ok', value: -12 },
    { id: 'tp', label: 'True Peak', status: 'warning', message: 'close', value: -0.8 },
  ],
  platforms: [],
};

const parts: RustResultParts = {
  outputPath: '/out.wav', previewPath: '/out_preview.mp3',
  processingTimeSec: 1.23, loudnessNormalized: true,
  chainConfig: cfg, options,
  sourceAnalysis: mkAnalysis(-18, -3, 9),
  outputAnalysis: mkAnalysis(-12.1, -1.0, 7),
  outputQc: qc,
};

console.log('rust-result-assembly-selftest');

console.log('required MasteringResult fields');
{
  const r = assembleRustMasteringResult(parts);
  check('outputPath / previewPath carried', r.outputPath === '/out.wav' && r.previewPath === '/out_preview.mp3');
  check('appliedCorrections non-empty', Array.isArray(r.appliedCorrections) && r.appliedCorrections.length > 0);
  check('loudnessBefore from sourceAnalysis', r.loudnessBefore.integratedLufs === -18 && r.loudnessBefore.truePeakDbtp === -3);
  check('loudnessAfter from outputAnalysis (LoudnessStats incl. shortTermMax)', r.loudnessAfter.integratedLufs === -12.1 && r.loudnessAfter.shortTermMax === -10.1);
  check('analysisReport synthesised (mastering meta present)', !!r.analysisReport?.mastering && r.analysisReport!.mastering!.mode === 'balanced');
  check('analysisReport targetReached true (|−12.1 − −12| ≤ 1)', r.analysisReport!.mastering!.targetReached === true);
  check('analysisReport eqMoves from cfg (3 moves)', r.analysisReport!.eqMoves.length === 3);
  check('analysisReport loudnorm gainApplied ≈ +5.9', Math.abs(r.analysisReport!.loudnorm.gainAppliedDb - 5.9) < 0.05);
  check('processingTimeSec carried', r.processingTimeSec === 1.23);
  check('pipelineWarnings is array', Array.isArray(r.pipelineWarnings));
}

console.log('metric comparison');
{
  const r = assembleRustMasteringResult(parts);
  const rows = r.metricComparison!;
  check('3 rows (LUFS / TP / LRA)', rows.length === 3);
  const lufs = rows.find((x) => x.key === 'lufs')!;
  check('LUFS row before/after/delta', lufs.before === -18 && lufs.after === -12.1 && Math.abs((lufs.delta ?? 0) - 5.9) < 0.05);
  check('LUFS status ok (within 1 of target)', lufs.status === 'ok');
  const tp = rows.find((x) => x.key === 'tp')!;
  check('TP status ok (≤ target)', tp.status === 'ok');
}

console.log('QC mapping');
{
  const mapped = mapQcToQualityCheck(qc);
  check('overall pass → ok', mapped.overall === 'ok');
  check('summary shows pass/total', mapped.summary === '11/12 통과');
  check('item status warning → warn', mapped.items[1].status === 'warn');
  check('item name from label', mapped.items[0].name === 'LUFS');
}

console.log('edge cases');
{
  // No source analysis → loudnessBefore falls back to after; no crash.
  const noSrc = assembleRustMasteringResult({ ...parts, sourceAnalysis: null, outputQc: null });
  check('null sourceAnalysis → before falls back to after', noSrc.loudnessBefore.integratedLufs === -12.1);
  check('null outputQc → qualityCheck omitted', noSrc.qualityCheck === undefined);
  // Bypass → single applied-correction line.
  const byp = buildAppliedCorrections({ ...cfg, masterBypass: true }, options);
  check('masterBypass → bypass notice only', byp.length === 1 && byp[0].includes('바이패스'));
}

if (failures > 0) { console.error(`\nFAILED: ${failures} check(s)`); process.exit(1); }
console.log('\nALL PASS');
