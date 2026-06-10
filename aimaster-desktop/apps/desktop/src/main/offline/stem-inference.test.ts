import { describe, it, expect } from 'vitest';
import { planSegments, hannWindow, overlapAddWeighted, resampleLinear } from './stem-inference.js';

describe('planSegments', () => {
  it('covers the whole signal with overlapping segments', () => {
    const segs = planSegments(1000, 400, 300); // 25% overlap
    expect(segs[0]).toEqual({ start: 0, length: 400 });
    expect(segs[segs.length - 1]!.start + segs[segs.length - 1]!.length).toBe(1000);
    // every sample is covered by at least one segment
    const covered = new Array(1000).fill(false);
    for (const s of segs) for (let i = s.start; i < s.start + s.length; i++) covered[i] = true;
    expect(covered.every(Boolean)).toBe(true);
  });

  it('returns a single clamped segment when total < segLen', () => {
    expect(planSegments(100, 400, 300)).toEqual([{ start: 0, length: 100 }]);
  });

  it('returns nothing for empty input and validates params', () => {
    expect(planSegments(0, 400, 300)).toEqual([]);
    expect(() => planSegments(100, 0, 10)).toThrow();
    expect(() => planSegments(100, 10, 0)).toThrow();
  });
});

describe('hannWindow', () => {
  it('is zero at the endpoints and peaks in the middle', () => {
    const w = hannWindow(8);
    expect(w[0]).toBeCloseTo(0, 6);
    expect(Math.max(...w)).toBeGreaterThan(0.9);
  });
  it('handles n=1 without NaN', () => {
    expect(Array.from(hannWindow(1))).toEqual([1]);
  });
});

describe('overlapAddWeighted', () => {
  it('reconstructs a signal exactly through windowed overlap-add (partition of unity)', () => {
    const total = 1000;
    const signal = Float32Array.from({ length: total }, (_, i) => Math.sin(i * 0.05));
    const segs = planSegments(total, 256, 192); // overlapping
    const segData = segs.map((s) => signal.subarray(s.start, s.start + s.length).slice());
    const weights = segs.map((s) => hannWindow(s.length));
    const out = overlapAddWeighted(total, segs, segData, weights);
    for (let i = 0; i < total; i++) expect(out[i]!).toBeCloseTo(signal[i]!, 4);
  });

  it('throws on length mismatch', () => {
    expect(() => overlapAddWeighted(10, [{ start: 0, length: 10 }], [], [])).toThrow();
  });
});

describe('resampleLinear', () => {
  it('is identity when rates match', () => {
    const x = Float32Array.from([1, 2, 3]);
    expect(Array.from(resampleLinear(x, 48000, 48000))).toEqual([1, 2, 3]);
  });
  it('changes length by the rate ratio', () => {
    const x = new Float32Array(100);
    expect(resampleLinear(x, 48000, 44100).length).toBe(Math.round(100 * 44100 / 48000));
  });
  it('preserves a constant signal under resampling', () => {
    const x = new Float32Array(100).fill(0.5);
    const y = resampleLinear(x, 44100, 48000);
    for (const v of y) expect(v).toBeCloseTo(0.5, 6);
  });
});
