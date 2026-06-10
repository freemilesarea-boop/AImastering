import { describe, it, expect } from 'vitest';
import { REFERENCE_LIBRARY, matchReferences } from './reference-library.js';
import type { TonalTilt } from './ai-music-spectral.js';

const tilt = (bassRel: number, subRel: number, presenceRel: number, brightRel: number, airRel: number): TonalTilt =>
  ({ bassRel, subRel, presenceRel, brightRel, airRel });

describe('reference-library', () => {
  it('every fingerprint is copyright-safe (numeric only, no audio/track field)', () => {
    for (const r of REFERENCE_LIBRARY) {
      expect(typeof r.lufs).toBe('number');
      expect(typeof r.lra).toBe('number');
      expect(r).not.toHaveProperty('audioPath');
      expect(r).not.toHaveProperty('url');
    }
  });

  it('matchReferences ranks closest first + respects limit', () => {
    const m = matchReferences({ lufs: -9, lra: 4, tilt: tilt(0, 1, 1, -2, -5) }, { limit: 3 });
    expect(m.length).toBe(3);
    expect(m[0]!.score).toBeGreaterThanOrEqual(m[1]!.score);
    // K-Pop dance fingerprint should be the closest for this profile.
    expect(m[0]!.ref.id).toBe('kr-kpop-dance');
  });

  it('region filter returns only that region', () => {
    const m = matchReferences({ lufs: -12, lra: 7 }, { region: 'JP', limit: 10 });
    expect(m.length).toBeGreaterThan(0);
    expect(m.every((x) => x.ref.region === 'JP')).toBe(true);
  });

  it('genre filter returns only that genre', () => {
    const m = matchReferences({ lufs: -9, lra: 5 }, { genre: 'hiphop', limit: 10 });
    expect(m.every((x) => x.ref.genre === 'hiphop')).toBe(true);
  });
});
