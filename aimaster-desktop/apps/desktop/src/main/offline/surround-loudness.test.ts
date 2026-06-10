import { describe, it, expect } from 'vitest';
import { integratedLoudnessLufs, loudnessNormGainDb } from './surround-loudness.js';

const SR = 48000;

// A ~1 s sine at the given amplitude on a single (front-left) channel of a 5.1
// program; remaining channels silent.
function sineProgram(amp: number, freq = 1000, secs = 1.5): Float32Array[] {
  const n = Math.round(secs * SR);
  const fl = Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / SR));
  const z = () => new Float32Array(n);
  return [fl, z(), z(), z(), z(), z()]; // FL, FR, FC, LFE, BL, BR
}

describe('integratedLoudnessLufs', () => {
  it('is finite for tonal content and silence-gated for silence', () => {
    expect(Number.isFinite(integratedLoudnessLufs(sineProgram(0.5), '5.1', SR))).toBe(true);
    const silent = Array.from({ length: 6 }, () => new Float32Array(SR));
    expect(integratedLoudnessLufs(silent, '5.1', SR)).toBe(-Infinity);
  });

  it('+6 dB amplitude raises integrated loudness by ~6 LU', () => {
    const a = integratedLoudnessLufs(sineProgram(0.25), '5.1', SR);
    const b = integratedLoudnessLufs(sineProgram(0.5), '5.1', SR);
    expect(b - a).toBeCloseTo(6.02, 1);
  });

  it('surround placement reads louder than the same energy in front (+1.5 dB weight)', () => {
    const n = SR;
    const tone = (i: number) => 0.4 * Math.sin((2 * Math.PI * 1000 * i) / SR);
    const z = () => new Float32Array(n);
    const front = [Float32Array.from({ length: n }, (_, i) => tone(i)), z(), z(), z(), z(), z()]; // FL
    const surr = [z(), z(), z(), z(), Float32Array.from({ length: n }, (_, i) => tone(i)), z()];   // BL
    expect(integratedLoudnessLufs(surr, '5.1', SR)).toBeGreaterThan(integratedLoudnessLufs(front, '5.1', SR));
  });

  it('LFE energy is excluded from the measurement', () => {
    const n = SR;
    const z = () => new Float32Array(n);
    const lfeOnly = [z(), z(), z(), Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 60 * i) / SR)), z(), z()];
    expect(integratedLoudnessLufs(lfeOnly, '5.1', SR)).toBe(-Infinity); // only LFE has energy → gated out
  });
});

describe('loudnessNormGainDb', () => {
  it('computes target − measured, clamped', () => {
    expect(loudnessNormGainDb(-20, -14)).toBeCloseTo(6, 6);
    expect(loudnessNormGainDb(-8, -14)).toBeCloseTo(-6, 6);
    expect(loudnessNormGainDb(-40, -14, 12)).toBe(12);  // boost clamp
    expect(loudnessNormGainDb(20, -14, 12, 24)).toBe(-24); // cut clamp
  });
  it('returns 0 for non-finite (silent) measurement', () => {
    expect(loudnessNormGainDb(-Infinity, -14)).toBe(0);
  });
});
