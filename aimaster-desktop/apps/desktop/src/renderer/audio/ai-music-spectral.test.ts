import { describe, it, expect } from 'vitest';
import {
  bandPowerDb, computeAiSpectralFeatures, isUsableSpectrum, type SpectrumFrame,
} from './ai-music-spectral.js';

const SR = 48000;
const N = 1024; // bins (fftSize 2048)

/** Build a spectrum where dbAt(freqHz) sets each bin's dB. */
function makeSpectrum(dbAt: (freqHz: number) => number): SpectrumFrame {
  const mags = new Float32Array(N);
  const binHz = SR / (2 * N);
  for (let i = 0; i < N; i++) mags[i] = dbAt(i * binHz);
  return { magsDb: mags, sampleRate: SR };
}

describe('bandPowerDb', () => {
  it('a flat -20 dB spectrum reads ~-20 dB in any band', () => {
    const f = makeSpectrum(() => -20);
    expect(bandPowerDb(f, 200, 2000)).toBeCloseTo(-20, 1);
    expect(bandPowerDb(f, 6000, 12000)).toBeCloseTo(-20, 1);
  });
  it('empty band returns -120', () => {
    const f = makeSpectrum(() => -20);
    expect(bandPowerDb(f, 24500, 25000)).toBe(-120);
  });
});

describe('computeAiSpectralFeatures', () => {
  // Natural-ish: mids at -20, gentle HF rolloff above 6k.
  const natural = makeSpectrum((hz) => (hz < 200 ? -22 : hz < 3000 ? -20 : hz < 6000 ? -22 : hz < 12000 ? -30 : hz < 18000 ? -42 : -58));

  it('natural spectrum → low metallic + low aliasing', () => {
    const s = computeAiSpectralFeatures(natural);
    expect(s.metallicScore).toBeLessThan(0.45);
    expect(s.aliasingScore).toBeLessThan(0.35);
  });

  it('metallic spectrum (3–5 kHz boosted) → high metallicScore', () => {
    const s = computeAiSpectralFeatures(makeSpectrum((hz) => (hz >= 3000 && hz < 6000 ? -10 : -24)));
    expect(s.metallicScore).toBeGreaterThan(0.7);
  });

  it('aliased spectrum (flat to Nyquist) → high aliasingScore', () => {
    const s = computeAiSpectralFeatures(makeSpectrum((hz) => (hz >= 18000 ? -22 : -25)));
    expect(s.aliasingScore).toBeGreaterThan(0.7);
  });

  it('harsh spectrum (5–9 kHz boosted) → high harshnessScore', () => {
    const s = computeAiSpectralFeatures(makeSpectrum((hz) => (hz >= 5000 && hz < 9000 ? -10 : -24)));
    expect(s.harshnessScore).toBeGreaterThan(0.7);
  });

  it('tilt signs: bright spectrum → positive highToMidDb', () => {
    const s = computeAiSpectralFeatures(makeSpectrum((hz) => (hz >= 6000 ? -14 : -24)));
    expect(s.highToMidDb).toBeGreaterThan(0);
  });
});

describe('isUsableSpectrum', () => {
  it('all -Inf / empty → false; real signal → true', () => {
    expect(isUsableSpectrum(null)).toBe(false);
    expect(isUsableSpectrum({ magsDb: new Float32Array(N).fill(-Infinity), sampleRate: SR })).toBe(false);
    expect(isUsableSpectrum(makeSpectrum(() => -30))).toBe(true);
  });
});
