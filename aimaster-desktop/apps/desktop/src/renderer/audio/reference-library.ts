// reference-library — curated Asian-market mastering fingerprints (Phase 3).
//
// COPYRIGHT-SAFE: these are NUMERIC tonal/loudness fingerprints only — no
// audio, no song/artist names.  Each entry is a fabricated, genre-typical
// target profile representing a regional mastering "vibe" (e.g. modern K-Pop
// dance, J-Pop city-pop, K-ballad).  The matcher scores the user's measured
// features against these targets to suggest a reference tone to aim for.
//
// Pure + headless-testable.

import type { GenreId } from './genre-detect.js';
import type { TonalTilt } from './ai-music-spectral.js';

export type Region = 'KR' | 'JP' | 'ASIA';

export interface RefFingerprint {
  id: string;
  name: string;       // vibe/genre descriptor (NOT a song)
  region: Region;
  genre: GenreId;
  lufs: number;
  truePeakDbtp: number;
  lra: number;
  /** Tonal tilt relative to mid (dB). */
  tilt: TonalTilt;
}

const t = (bassRel: number, subRel: number, presenceRel: number, brightRel: number, airRel: number): TonalTilt =>
  ({ bassRel, subRel, presenceRel, brightRel, airRel });

export const REFERENCE_LIBRARY: RefFingerprint[] = [
  { id: 'kr-kpop-dance',   name: 'K-Pop 모던 댄스',   region: 'KR', genre: 'kpop',    lufs: -9,  truePeakDbtp: -1, lra: 4,  tilt: t(0, 1, 1, -2, -5) },
  { id: 'kr-kpop-ballad',  name: 'K-발라드',          region: 'KR', genre: 'ballad',  lufs: -13, truePeakDbtp: -1, lra: 9,  tilt: t(-2, -1, -1, -5, -9) },
  { id: 'kr-hiphop',       name: 'K-힙합',            region: 'KR', genre: 'hiphop',  lufs: -9,  truePeakDbtp: -1, lra: 5,  tilt: t(4, 5, -3, -8, -12) },
  { id: 'kr-rnb',          name: 'K-R&B 소울',        region: 'KR', genre: 'pop',     lufs: -12, truePeakDbtp: -1, lra: 7,  tilt: t(1, 2, -1, -5, -8) },
  { id: 'jp-citypop',      name: 'J-Pop 시티팝',      region: 'JP', genre: 'pop',     lufs: -12, truePeakDbtp: -1, lra: 7,  tilt: t(-1, 0, 0, -3, -6) },
  { id: 'jp-anison',       name: 'J-Pop 애니송',      region: 'JP', genre: 'pop',     lufs: -10, truePeakDbtp: -1, lra: 5,  tilt: t(-1, -1, 1, -2, -6) },
  { id: 'jp-rock',         name: 'J-Rock',            region: 'JP', genre: 'rock',    lufs: -10, truePeakDbtp: -1, lra: 6,  tilt: t(-2, -2, 0, -4, -10) },
  { id: 'asia-edm',        name: '아시아 EDM/페스티벌', region: 'ASIA', genre: 'edm',  lufs: -8,  truePeakDbtp: -1, lra: 3.5, tilt: t(2, 3, -2, -3, -7) },
  { id: 'asia-citypop',    name: '아시아 퓨전 시티팝', region: 'ASIA', genre: 'pop',  lufs: -13, truePeakDbtp: -1, lra: 8,  tilt: t(-1, 0, -1, -4, -7) },
  { id: 'asia-acoustic',   name: '아시아 어쿠스틱',    region: 'ASIA', genre: 'acoustic', lufs: -16, truePeakDbtp: -1, lra: 11, tilt: t(-3, -3, -2, -5, -9) },
];

export interface RefMatchFeatures {
  lufs: number;
  lra: number;
  tilt?: TonalTilt;
}

export interface RefMatch {
  ref: RefFingerprint;
  /** 0..1 — higher = closer. */
  score: number;
}

const sq = (x: number): number => x * x;

function refDistance(f: RefMatchFeatures, r: RefFingerprint): number {
  let d = sq((f.lufs - r.lufs) / 4) + sq((f.lra - r.lra) / 4);
  if (f.tilt) {
    d += 1.2 * sq((f.tilt.bassRel - r.tilt.bassRel) / 4)
      + 1.0 * sq((f.tilt.presenceRel - r.tilt.presenceRel) / 4)
      + 1.0 * sq((f.tilt.brightRel - r.tilt.brightRel) / 4)
      + 0.6 * sq((f.tilt.airRel - r.tilt.airRel) / 4);
  }
  return d;
}

/**
 * Rank reference fingerprints by closeness to the input.  Optionally filter by
 * region and/or genre (e.g. show only K-Pop targets).
 */
export function matchReferences(
  f: RefMatchFeatures,
  opts: { region?: Region; genre?: GenreId; limit?: number } = {},
): RefMatch[] {
  const pool = REFERENCE_LIBRARY.filter((r) =>
    (!opts.region || r.region === opts.region) && (!opts.genre || r.genre === opts.genre));
  const ranked = pool
    .map((ref) => ({ ref, score: 1 / (1 + refDistance(f, ref)) }))
    .sort((a, b) => b.score - a.score);
  return ranked.slice(0, opts.limit ?? 4);
}
