// genre-detect — rule-based auto genre/mode detection (Phase 3).
//
// Classifies the input from loudness + tonal-tilt features against a small set
// of genre centroids, and recommends a mastering style + loudness target.
// Pure + headless-testable (no ML).  Reuses the spectral tilt from
// ai-music-spectral; works loudness-only when no spectrum is available.

import type { MasteringStyle } from '@aimaster/shared-types';
import type { TonalTilt } from './ai-music-spectral.js';

export type GenreId = 'edm' | 'kpop' | 'hiphop' | 'pop' | 'rock' | 'ballad' | 'acoustic';

export interface GenreFeatures {
  lufs: number;
  lra: number;
  crestDb?: number;
  tilt?: TonalTilt;
}

export interface GenreCandidate { genre: GenreId; label: string; score: number; }

export interface GenreReport {
  top: GenreId;
  label: string;
  /** 0..1 — gap between the best and 2nd-best match. */
  confidence: number;
  candidates: GenreCandidate[];
  recommendedStyle: MasteringStyle;
  targetLufs: number;
  targetLra: number;
  /** Whether tonal tilt (spectrum) was available — else loudness-only. */
  usedSpectrum: boolean;
}

interface Centroid {
  genre: GenreId; label: string;
  lufs: number; lra: number; crest: number;
  bassRel: number; presenceRel: number; brightRel: number; airRel: number;
  style: MasteringStyle; targetLufs: number; targetLra: number;
}

// Heuristic centroids (feature space).  Tuned for the existing 7 styles.
const CENTROIDS: Centroid[] = [
  { genre: 'edm',     label: 'EDM / 댄스',   lufs: -8,  lra: 3.5, crest: 8,  bassRel: 2,  presenceRel: -2, brightRel: -4,  airRel: -8,  style: 'loud',      targetLufs: -8,  targetLra: 4 },
  { genre: 'kpop',    label: 'K-Pop',        lufs: -9,  lra: 4,   crest: 9,  bassRel: 0,  presenceRel: 0,  brightRel: -2,  airRel: -6,  style: 'kpop_loud', targetLufs: -9,  targetLra: 4 },
  { genre: 'hiphop',  label: '힙합',         lufs: -9,  lra: 4.5, crest: 9,  bassRel: 4,  presenceRel: -3, brightRel: -8,  airRel: -12, style: 'punch',     targetLufs: -9,  targetLra: 5 },
  { genre: 'pop',     label: '팝',           lufs: -11, lra: 6,   crest: 11, bassRel: -1, presenceRel: -2, brightRel: -5,  airRel: -9,  style: 'balanced',  targetLufs: -12, targetLra: 7 },
  { genre: 'rock',    label: '록',           lufs: -10, lra: 6,   crest: 10, bassRel: -2, presenceRel: 0,  brightRel: -4,  airRel: -10, style: 'punch',     targetLufs: -10, targetLra: 6 },
  { genre: 'ballad',  label: '발라드',       lufs: -14, lra: 9,   crest: 13, bassRel: -3, presenceRel: -2, brightRel: -6,  airRel: -10, style: 'warm',      targetLufs: -14, targetLra: 9 },
  { genre: 'acoustic',label: '어쿠스틱/재즈',lufs: -16, lra: 12,  crest: 14, bassRel: -4, presenceRel: -2, brightRel: -5,  airRel: -9,  style: 'natural',   targetLufs: -16, targetLra: 11 },
];

const sq = (x: number): number => x * x;

/** Weighted squared distance of features to a centroid (lower = closer). */
function distance(f: GenreFeatures, c: Centroid): number {
  let d = sq((f.lufs - c.lufs) / 4) + sq((f.lra - c.lra) / 4);
  if (typeof f.crestDb === 'number') d += 0.4 * sq((f.crestDb - c.crest) / 4);
  if (f.tilt) {
    d += 1.4 * sq((f.tilt.bassRel - c.bassRel) / 4)
      + 1.2 * sq((f.tilt.presenceRel - c.presenceRel) / 4)
      + 1.2 * sq((f.tilt.brightRel - c.brightRel) / 4)
      + 0.8 * sq((f.tilt.airRel - c.airRel) / 4);
  }
  return d;
}

export function detectGenre(f: GenreFeatures): GenreReport {
  const scored = CENTROIDS
    .map((c) => ({ c, dist: distance(f, c) }))
    .sort((a, b) => a.dist - b.dist);

  const best = scored[0]!;
  const second = scored[1]!;
  // Confidence from the relative gap between best + 2nd (0..1).
  const confidence = Math.max(0, Math.min(1, (second.dist - best.dist) / (best.dist + second.dist + 1e-6)));

  const candidates: GenreCandidate[] = scored.slice(0, 3).map((s) => ({
    genre: s.c.genre, label: s.c.label, score: 1 / (1 + s.dist),
  }));

  return {
    top: best.c.genre,
    label: best.c.label,
    confidence,
    candidates,
    recommendedStyle: best.c.style,
    targetLufs: best.c.targetLufs,
    targetLra: best.c.targetLra,
    usedSpectrum: !!f.tilt,
  };
}
