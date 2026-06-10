import { describe, it, expect } from 'vitest';
import {
  multichannelPeakDb, applyLinkedGain, linkedLimiter, masterSurroundOutput, interleaveN,
} from './surround-render.js';

const SR = 48000;
const ch = (...vals: number[][]) => vals.map((v) => Float32Array.from(v));

describe('multichannelPeakDb / applyLinkedGain / interleaveN', () => {
  it('peak is the max abs across all channels', () => {
    expect(multichannelPeakDb(ch([0.5, -0.1], [0.2, 0.25]))).toBeCloseTo(20 * Math.log10(0.5), 5);
  });
  it('linked gain scales every channel equally', () => {
    const out = applyLinkedGain(ch([0.5], [0.25]), 6.0206);
    expect(out[0]![0]!).toBeCloseTo(1.0, 3);
    expect(out[1]![0]!).toBeCloseTo(0.5, 3);
  });
  it('interleaveN round-trips channel order', () => {
    expect(Array.from(interleaveN(ch([1, 3], [2, 4])))).toEqual([1, 2, 3, 4]);
  });
});

describe('linkedLimiter', () => {
  it('output never exceeds the ceiling', () => {
    const n = 2000;
    const a = new Float32Array(n).fill(0.2);
    const b = new Float32Array(n).fill(0.2);
    a[1000] = 0.99; b[1000] = 0.5; // transient over a −6 dB ceiling
    const { channels } = linkedLimiter([a, b], SR, { ceilingDb: -6, lookaheadMs: 2, releaseMs: 50 });
    const ceil = Math.pow(10, -6 / 20);
    for (const c of channels) for (const v of c) expect(Math.abs(v)).toBeLessThanOrEqual(ceil + 1e-3);
  });

  it('preserves inter-channel ratio (linked gain)', () => {
    const n = 1000;
    const a = new Float32Array(n).fill(0.8);
    const b = new Float32Array(n).fill(0.4); // half of a, everywhere
    const { channels } = linkedLimiter([a, b], SR, { ceilingDb: -6, lookaheadMs: 0, releaseMs: 50 });
    for (let i = 0; i < n; i++) {
      if (channels[0]![i]! !== 0) expect(channels[1]![i]! / channels[0]![i]!).toBeCloseTo(0.5, 4);
    }
  });

  it('signal below the ceiling is unchanged (no look-ahead)', () => {
    const a = new Float32Array(500).fill(0.1);
    const { channels, maxReductionDb } = linkedLimiter([a], SR, { ceilingDb: -1, lookaheadMs: 0, releaseMs: 50 });
    expect(maxReductionDb).toBe(0);
    for (const v of channels[0]!) expect(v).toBeCloseTo(0.1, 6);
  });
});

describe('masterSurroundOutput', () => {
  it('applies master gain then limits to the ceiling, reporting metrics', () => {
    const n = 1000;
    const chans = [new Float32Array(n).fill(0.5), new Float32Array(n).fill(0.25), new Float32Array(n).fill(0.1)];
    const { channels, metrics } = masterSurroundOutput(chans, SR, { masterGainDb: 6, ceilingDb: -1 });
    const ceil = Math.pow(10, -1 / 20);
    for (const c of channels) for (const v of c) expect(Math.abs(v)).toBeLessThanOrEqual(ceil + 1e-3);
    expect(metrics.masterGainDb).toBe(6);
    expect(metrics.peakAfterDb).toBeLessThanOrEqual(-1 + 0.05);
    expect(metrics.limiterReductionDb).toBeGreaterThan(0); // +6 dB pushed it over → limited
  });

  it('clean quiet input needs no limiting', () => {
    const chans = [new Float32Array(200).fill(0.05)];
    const { metrics } = masterSurroundOutput(chans, SR, { masterGainDb: 0, ceilingDb: -1 });
    expect(metrics.limiterReductionDb).toBe(0);
  });
});
