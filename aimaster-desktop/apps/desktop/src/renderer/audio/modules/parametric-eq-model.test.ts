import { describe, it, expect } from 'vitest';
import {
  sanitizeBands, defaultBand, parametricEqCurveDb,
  MAX_BANDS, MAX_FREQ_HZ, MAX_GAIN_DB, MIN_Q,
  type ParametricEqBand,
} from './parametric-eq-model.js';

const band = (over: Partial<ParametricEqBand>): ParametricEqBand => ({ ...defaultBand(1000, 0), ...over });

describe('sanitizeBands', () => {
  it('clamps frequency / gain / Q into range', () => {
    const b = sanitizeBands([band({ frequencyHz: 1e9, gainDb: 999, q: 1e-6 })])[0]!;
    expect(b.frequencyHz).toBe(MAX_FREQ_HZ);
    expect(b.gainDb).toBe(MAX_GAIN_DB);
    expect(b.q).toBe(MIN_Q);
  });
  it('replaces non-finite values with safe fallbacks (not range clamps)', () => {
    const b = sanitizeBands([band({ frequencyHz: NaN, gainDb: Infinity, q: NaN })])[0]!;
    expect(b.frequencyHz).toBe(1000); // NaN → 1 kHz
    expect(b.gainDb).toBe(0);         // non-finite → 0 dB (safe), not +MAX
    expect(b.q).toBe(1);              // NaN → 1
  });
  it('caps the list to MAX_BANDS', () => {
    const many = sanitizeBands(Array.from({ length: MAX_BANDS + 5 }, () => band({})));
    expect(many).toHaveLength(MAX_BANDS);
  });
  it('preserves id + enabled flag', () => {
    const src = band({ id: 'keep-me', enabled: false });
    const b = sanitizeBands([src])[0]!;
    expect(b.id).toBe('keep-me');
    expect(b.enabled).toBe(false);
  });
});

describe('parametricEqCurveDb', () => {
  it('is ~0 dB with no enabled bands', () => {
    expect(Math.abs(parametricEqCurveDb([], 1000))).toBeLessThan(1e-6);
  });
  it('a +6 dB bell lifts its centre frequency', () => {
    const bands = [band({ type: 'bell', frequencyHz: 1000, gainDb: 6, q: 1, enabled: true })];
    expect(parametricEqCurveDb(bands, 1000)).toBeGreaterThan(4);
  });
  it('a disabled band contributes nothing', () => {
    const bands = [band({ type: 'bell', frequencyHz: 1000, gainDb: 6, q: 1, enabled: false })];
    expect(Math.abs(parametricEqCurveDb(bands, 1000))).toBeLessThan(1e-6);
  });
});
