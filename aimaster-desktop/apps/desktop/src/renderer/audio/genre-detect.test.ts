import { describe, it, expect } from 'vitest';
import { detectGenre, type GenreFeatures } from './genre-detect.js';
import type { TonalTilt } from './ai-music-spectral.js';

const tilt = (bassRel: number, subRel: number, presenceRel: number, brightRel: number, airRel: number): TonalTilt =>
  ({ bassRel, subRel, presenceRel, brightRel, airRel });

describe('detectGenre', () => {
  it('loud + low LRA + bassy/bright → EDM (loud style)', () => {
    const f: GenreFeatures = { lufs: -8, lra: 3.5, crestDb: 8, tilt: tilt(2, 3, -2, -4, -8) };
    const r = detectGenre(f);
    expect(r.top).toBe('edm');
    expect(r.recommendedStyle).toBe('loud');
    expect(r.usedSpectrum).toBe(true);
  });

  it('high LRA + quiet → acoustic/jazz (natural style)', () => {
    const r = detectGenre({ lufs: -16, lra: 12, crestDb: 14 });
    expect(r.top).toBe('acoustic');
    expect(r.recommendedStyle).toBe('natural');
    expect(r.usedSpectrum).toBe(false);
  });

  it('moderate loud + mid LRA → pop (balanced)', () => {
    const r = detectGenre({ lufs: -11, lra: 6 });
    expect(r.top).toBe('pop');
    expect(r.recommendedStyle).toBe('balanced');
  });

  it('high LRA ~9 quiet-ish → ballad (warm)', () => {
    const r = detectGenre({ lufs: -14, lra: 9 });
    expect(r.top).toBe('ballad');
    expect(r.recommendedStyle).toBe('warm');
  });

  it('returns 3 candidates + confidence in [0,1] + a target LUFS', () => {
    const r = detectGenre({ lufs: -9, lra: 4 });
    expect(r.candidates).toHaveLength(3);
    expect(r.confidence).toBeGreaterThanOrEqual(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
    expect(typeof r.targetLufs).toBe('number');
  });
});
