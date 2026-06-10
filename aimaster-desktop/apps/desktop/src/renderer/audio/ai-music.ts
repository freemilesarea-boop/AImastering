// ai-music — AI-generated music mode (Phase 3 differentiator).
//
// Suno / Udio / Stable Audio output has recognisable artefacts — metallic
// high-mid, brittle/aliased highs, over-compressed (squashed) sources, boomy
// low end, weird stereo.  This module DETECTS them from the existing analysis
// features and proposes a CORRECTION built from the Phase-2 modules (dynamic
// EQ / de-esser / transient / imager / multiband), which the UI can apply in
// one click.  Pure + rule-based → headless-testable; no ML model.

import type { AudioAnalysisResult } from '@aimaster/shared-types';
import { type MultibandConfig, defaultMultibandConfig } from './multiband-config.js';
import { type ImagerMultibandConfig, defaultImagerMultiband } from './imager-config.js';
import { type SaturationConfig, defaultSaturationConfig } from './saturation-config.js';
import { type TransientConfig, defaultTransientConfig } from './transient-config.js';
import { type DynamicEqConfig, type DynEqBand, defaultDynamicEqConfig, defaultDynEqBand, sanitizeDynamicEq } from './dyneq-config.js';
import { type DeesserConfig, defaultDeesserConfig } from './deesser-config.js';

/** Normalised feature set the detector reads.  Booleans come from the existing
 *  rule-based aiDetection; the rest are optional refinements. */
export interface AiMusicFeatures {
  harshHighMid: boolean;
  boomyLowEnd: boolean;
  brickwallCompression: boolean;
  stereoImbalance: boolean;
  intersampleRisk: boolean;
  upsampleSuspected: boolean;
  lufs: number;
  truePeakDbtp: number;
  lra: number;
  /** Optional refinements (from the master result / waveform stats). */
  crestDb?: number;
  lrCorrelation?: number;
  highToMidDb?: number;
  lowToMidDb?: number;
}

export type AiMusicSeverity = 'ok' | 'info' | 'warn';

export interface AiMusicFinding {
  id: string;
  label: string;
  detail: string;
  severity: 'info' | 'warn';
}

export interface AiMusicCorrection {
  multiband: MultibandConfig;
  imagerMultiband: ImagerMultibandConfig;
  saturation: SaturationConfig;
  transient: TransientConfig;
  dynamicEq: DynamicEqConfig;
  deesser: DeesserConfig;
}

export interface AiMusicReport {
  findings: AiMusicFinding[];
  severity: AiMusicSeverity;
  /** Whether any AI-music artefact was detected (findings non-empty). */
  detected: boolean;
  correction: AiMusicCorrection;
}

/** Build the feature set from an analysis result (+ optional refinements). */
export function buildAiMusicFeatures(
  analysis: AudioAnalysisResult,
  extra: Partial<Pick<AiMusicFeatures, 'crestDb' | 'lrCorrelation' | 'highToMidDb' | 'lowToMidDb'>> = {},
): AiMusicFeatures {
  const ai = analysis.aiDetection;
  const l = analysis.loudness;
  return {
    harshHighMid: !!ai.harshHighMid,
    boomyLowEnd: !!ai.boomyLowEnd,
    brickwallCompression: !!ai.brickwallCompression,
    stereoImbalance: !!ai.stereoImbalance,
    intersampleRisk: !!ai.intersampleRisk,
    upsampleSuspected: !!ai.upsampleSuspected,
    lufs: l.integratedLufs,
    truePeakDbtp: l.truePeakDbtp,
    lra: l.lra,
    ...extra,
  };
}

function dynBand(over: Partial<Omit<DynEqBand, 'id'>> & { freqHz: number }): DynEqBand {
  return { ...defaultDynEqBand(over.freqHz), ...over };
}

/**
 * Detect AI-music artefacts + build a one-click corrective module bundle.
 * The correction starts from all-bypassed defaults and engages only the
 * modules needed for the detected issues.
 */
export function detectAiMusic(f: AiMusicFeatures): AiMusicReport {
  const findings: AiMusicFinding[] = [];
  const dynBands: DynEqBand[] = [];
  let deesser: DeesserConfig = defaultDeesserConfig();
  let transient: TransientConfig = defaultTransientConfig();
  let imager: ImagerMultibandConfig = defaultImagerMultiband();
  const multiband: MultibandConfig = defaultMultibandConfig();
  const saturation: SaturationConfig = defaultSaturationConfig();

  // 1) Metallic / harsh high-mid (Suno/Udio vocals + synths).
  if (f.harshHighMid || (typeof f.highToMidDb === 'number' && f.highToMidDb > -14)) {
    findings.push({
      id: 'metallicHighMid', severity: 'warn',
      label: '금속성 고중역',
      detail: 'AI 보컬/신스 특유의 3–5 kHz 금속성·거친 질감. 다이내믹 EQ로 라우드 시에만 완화합니다.',
    });
    dynBands.push(dynBand({ freqHz: 3800, filterType: 'bell', q: 3, thresholdDb: -26, ratio: 4, rangeDb: 5, mode: 'downcut' }));
    deesser = { ...deesser, enabled: true, freqHz: 7000, thresholdDb: -28, rangeDb: 5, q: 3.5, filterType: 'bell' };
  }

  // 2) Brittle / aliased highs (upsample-suspected / harsh top).
  if (f.upsampleSuspected || (typeof f.highToMidDb === 'number' && f.highToMidDb > -10)) {
    findings.push({
      id: 'brittleHighs', severity: 'warn',
      label: '고역 브리틀/에일리어싱',
      detail: '업샘플·합성 특유의 부서지는 고역. 8 kHz 이상 하이셸프를 동적으로 눌러 정리합니다.',
    });
    dynBands.push(dynBand({ freqHz: 9000, filterType: 'highshelf', q: 0.7, thresholdDb: -28, ratio: 3, rangeDb: 4, mode: 'downcut' }));
  }

  // 3) Over-compressed source (brickwall / low LRA) — restore punch instead of
  //    squashing further; recommend a lighter limiter.
  if (f.brickwallCompression || f.lra < 3.5) {
    findings.push({
      id: 'overCompressed', severity: 'warn',
      label: '원본 과압축',
      detail: 'AI 생성물이 이미 강하게 압축됨(LRA 낮음). 추가 압축을 피하고 트랜지언트로 펀치를 복원합니다.',
    });
    transient = { ...transient, bypass: false, attackPct: 25, sustainPct: 8 };
  }

  // 4) Boomy low end.
  if (f.boomyLowEnd || (typeof f.lowToMidDb === 'number' && f.lowToMidDb > -8)) {
    findings.push({
      id: 'boomyLow', severity: 'info',
      label: '저역 부밍',
      detail: '60–200 Hz 부밍. 저역 벨을 라우드 시 동적으로 정리합니다.',
    });
    dynBands.push(dynBand({ freqHz: 120, filterType: 'bell', q: 1.4, thresholdDb: -24, ratio: 3, rangeDb: 4, mode: 'downcut' }));
  }

  // 5) Phasiness / odd stereo.
  if (f.stereoImbalance || (typeof f.lrCorrelation === 'number' && f.lrCorrelation < 0.2)) {
    findings.push({
      id: 'phasiness', severity: 'info',
      label: '위상/스테레오 이상',
      detail: '좌우 상관도 낮음(위상 의심). 저역을 모노로 모으고 전체 폭을 약간 좁힙니다.',
    });
    imager = { ...imager, enabled: true, widthsPct: [0, 90, 95, 100] };
  }

  const dynamicEq: DynamicEqConfig = dynBands.length
    ? sanitizeDynamicEq({ bypass: false, bands: dynBands.slice(0, 6) })
    : defaultDynamicEqConfig();

  const severity: AiMusicSeverity = findings.some((x) => x.severity === 'warn')
    ? 'warn' : findings.length ? 'info' : 'ok';

  return {
    findings,
    severity,
    detected: findings.length > 0,
    correction: { multiband, imagerMultiband: imager, saturation, transient, dynamicEq, deesser },
  };
}
