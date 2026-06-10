import { describe, it, expect } from 'vitest';
import { applyPreciseRebalance, type PreciseRebalanceOptions } from './precise-rebalance.js';
import type { StemSeparator, SeparatedStems } from './stem-separation.js';

const sine = (n: number, f: number): Float32Array => Float32Array.from({ length: n }, (_, i) => Math.sin(i * f));

const opts = (over: Partial<PreciseRebalanceOptions> = {}): PreciseRebalanceOptions => ({
  enabled: true, gainsDb: { vocals: 0, drums: 0, bass: 0, other: 0 }, userDataDir: '/u', ...over,
});

// A fake separator that splits a mix into 4 equal quarters → 0 dB sum == mix.
function quarterSeparator(sr: number): StemSeparator {
  return {
    id: 'fake',
    isReady: async () => true,
    async separate(input): Promise<SeparatedStems> {
      const q = (x: Float32Array) => x.map((v) => v / 4);
      const mk = () => ({ left: q(input.left), right: q(input.right), sampleRate: sr });
      return { vocals: mk(), drums: mk(), bass: mk(), other: mk() };
    },
  };
}

describe('applyPreciseRebalance', () => {
  it('is a no-op (applied=false) when disabled', async () => {
    const L = sine(64, 0.1), R = sine(64, 0.2);
    const r = await applyPreciseRebalance(L, R, 48000, opts({ enabled: false }));
    expect(r.applied).toBe(false);
    expect(r.left).toBe(L);
  });

  it('falls back (applied=false) when no separator/model is available', async () => {
    const L = sine(64, 0.1), R = sine(64, 0.2);
    const r = await applyPreciseRebalance(L, R, 48000, opts(), undefined, async () => null);
    expect(r.applied).toBe(false);
    expect(r.left).toBe(L);
  });

  it('at 0 dB gains, reconstructs the original mix from additive stems', async () => {
    const L = sine(128, 0.1), R = sine(128, 0.2);
    const r = await applyPreciseRebalance(L, R, 48000, opts(), undefined, async () => quarterSeparator(48000));
    expect(r.applied).toBe(true);
    for (let i = 0; i < L.length; i++) {
      expect(r.left[i]!).toBeCloseTo(L[i]!, 5);
      expect(r.right[i]!).toBeCloseTo(R[i]!, 5);
    }
  });

  it('+6 dB on every stem ≈ doubles the mix', async () => {
    const L = sine(128, 0.1), R = sine(128, 0.2);
    const g = 6.0206;
    const r = await applyPreciseRebalance(L, R, 48000, opts({ gainsDb: { vocals: g, drums: g, bass: g, other: g } }), undefined, async () => quarterSeparator(48000));
    for (let i = 0; i < L.length; i++) expect(r.left[i]!).toBeCloseTo(L[i]! * 2, 3);
  });

  it('resamples stems back to the render rate (model 44.1k → 48k)', async () => {
    const L = sine(441, 0.1), R = sine(441, 0.1);
    const r = await applyPreciseRebalance(L, R, 48000, opts(), undefined, async () => quarterSeparator(44100));
    expect(r.applied).toBe(true);
    expect(r.left.length).toBe(L.length); // output matches the render-rate buffer length
  });
});
