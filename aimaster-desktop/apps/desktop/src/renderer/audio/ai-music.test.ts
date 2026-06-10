import { describe, it, expect } from 'vitest';
import { detectAiMusic, buildAiMusicFeatures, refineWithSpectrum, type AiMusicFeatures } from './ai-music.js';
import { isDynamicEqUnity } from './dyneq-config.js';
import { isDeesserActive } from './deesser-config.js';
import { isTransientUnity } from './transient-config.js';
import { isImagerMultibandUnity } from './imager-config.js';
import type { AudioAnalysisResult } from '@aimaster/shared-types';

const clean = (over: Partial<AiMusicFeatures> = {}): AiMusicFeatures => ({
  harshHighMid: false, boomyLowEnd: false, brickwallCompression: false, stereoImbalance: false,
  intersampleRisk: false, upsampleSuspected: false, lufs: -12, truePeakDbtp: -1, lra: 8, ...over,
});

describe('detectAiMusic', () => {
  it('clean input → no findings, severity ok, correction all bypassed', () => {
    const r = detectAiMusic(clean());
    expect(r.detected).toBe(false);
    expect(r.severity).toBe('ok');
    expect(isDynamicEqUnity(r.correction.dynamicEq)).toBe(true);
    expect(isDeesserActive(r.correction.deesser)).toBe(false);
    expect(isTransientUnity(r.correction.transient)).toBe(true);
    expect(isImagerMultibandUnity(r.correction.imagerMultiband)).toBe(true);
  });

  it('harshHighMid → metallic finding + dynamic-EQ band + de-esser', () => {
    const r = detectAiMusic(clean({ harshHighMid: true }));
    expect(r.findings.some((f) => f.id === 'metallicHighMid')).toBe(true);
    expect(r.correction.dynamicEq.bands.length).toBeGreaterThan(0);
    expect(isDeesserActive(r.correction.deesser)).toBe(true);
    expect(r.severity).toBe('warn');
  });

  it('upsampleSuspected → brittle highs finding + high-shelf downcut', () => {
    const r = detectAiMusic(clean({ upsampleSuspected: true }));
    expect(r.findings.some((f) => f.id === 'brittleHighs')).toBe(true);
    expect(r.correction.dynamicEq.bands.some((b) => b.filterType === 'highshelf')).toBe(true);
  });

  it('low LRA → over-compressed finding + transient restore', () => {
    const r = detectAiMusic(clean({ lra: 2.0 }));
    expect(r.findings.some((f) => f.id === 'overCompressed')).toBe(true);
    expect(isTransientUnity(r.correction.transient)).toBe(false);
    expect(r.correction.transient.attackPct).toBeGreaterThan(0);
  });

  it('boomyLowEnd → low-band dynamic cut', () => {
    const r = detectAiMusic(clean({ boomyLowEnd: true }));
    expect(r.findings.some((f) => f.id === 'boomyLow')).toBe(true);
    expect(r.correction.dynamicEq.bands.some((b) => b.freqHz <= 200)).toBe(true);
  });

  it('stereoImbalance → phasiness finding + imager (lows mono)', () => {
    const r = detectAiMusic(clean({ stereoImbalance: true }));
    expect(r.findings.some((f) => f.id === 'phasiness')).toBe(true);
    expect(isImagerMultibandUnity(r.correction.imagerMultiband)).toBe(false);
    expect(r.correction.imagerMultiband.widthsPct[0]).toBe(0);
  });

  it('many artefacts → multiple findings, dynamic-EQ capped at 6 bands', () => {
    const r = detectAiMusic(clean({ harshHighMid: true, upsampleSuspected: true, boomyLowEnd: true, brickwallCompression: true, stereoImbalance: true }));
    expect(r.findings.length).toBeGreaterThanOrEqual(4);
    expect(r.correction.dynamicEq.bands.length).toBeLessThanOrEqual(6);
    expect(r.severity).toBe('warn');
  });

  it('optional spectral refinements trigger findings without booleans', () => {
    const r = detectAiMusic(clean({ highToMidDb: -8, lowToMidDb: -6, lrCorrelation: 0.1 }));
    expect(r.detected).toBe(true);
  });

  it('spectral metallicScore triggers the metallic finding (no boolean)', () => {
    expect(detectAiMusic(clean({ metallicScore: 0.8 })).findings.some((f) => f.id === 'metallicHighMid')).toBe(true);
  });

  it('spectral aliasingScore triggers the brittle-highs finding', () => {
    expect(detectAiMusic(clean({ aliasingScore: 0.8 })).findings.some((f) => f.id === 'brittleHighs')).toBe(true);
  });

  it('strong scores increase the corrective dynamic-EQ range', () => {
    const wBand = detectAiMusic(clean({ metallicScore: 0.6 })).correction.dynamicEq.bands.find((b) => Math.round(b.freqHz) === 3800)!;
    const sBand = detectAiMusic(clean({ metallicScore: 0.9, harshnessScore: 0.8 })).correction.dynamicEq.bands.find((b) => Math.round(b.freqHz) === 3800)!;
    expect(sBand.rangeDb).toBeGreaterThanOrEqual(wBand.rangeDb);
  });
});

describe('refineWithSpectrum', () => {
  it('adds spectral scores from a usable frame; no-op on null', () => {
    const refined = refineWithSpectrum(clean(), { magsDb: new Float32Array(256).fill(-30), sampleRate: 48000 });
    expect(typeof refined.metallicScore).toBe('number');
    expect(refineWithSpectrum(clean(), null).metallicScore).toBeUndefined();
  });
});

describe('buildAiMusicFeatures', () => {
  it('maps analysis aiDetection + loudness into features', () => {
    const analysis = {
      fileInfo: { path: '/x', name: 'x', sizeBytes: 1, durationSec: 10, sampleRate: 48000, bitDepth: 24, channels: 2, format: 'wav' },
      loudness: { integratedLufs: -9, truePeakDbtp: -0.5, lra: 2.5, shortTermMax: -7 },
      aiDetection: { harshHighMid: true, boomyLowEnd: false, brickwallCompression: true, stereoImbalance: false, silenceAtStart: false, silenceAtEnd: false, intersampleRisk: false, upsampleSuspected: false },
      dcOffsetDb: -90, silenceStartMs: 0, silenceEndMs: 0,
    } as AudioAnalysisResult;
    const f = buildAiMusicFeatures(analysis, { highToMidDb: -12 });
    expect(f.harshHighMid).toBe(true);
    expect(f.brickwallCompression).toBe(true);
    expect(f.lra).toBe(2.5);
    expect(f.highToMidDb).toBe(-12);
  });
});
