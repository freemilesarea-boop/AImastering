// Scales — the Scale Assistant's brain.
//
// Three jobs:
//   1. Say whether a pitch belongs to a scale (note guides in the editor).
//   2. Snap a pitch INTO a scale (snap pitch editing, quantize pitches).
//   3. Guess which scales a piece of music is in (scale suggestions).
//
// Pitch classes are 0…11 with 0 = C.  Everything is pure.

export interface ScaleDef {
  id: string;
  name: string;
  /** Semitone offsets from the root, ascending, starting at 0. */
  intervals: readonly number[];
}

export const SCALES: readonly ScaleDef[] = [
  { id: 'major',        name: 'Major (Ionian)',   intervals: [0, 2, 4, 5, 7, 9, 11] },
  { id: 'dorian',       name: 'Dorian',           intervals: [0, 2, 3, 5, 7, 9, 10] },
  { id: 'phrygian',     name: 'Phrygian',         intervals: [0, 1, 3, 5, 7, 8, 10] },
  { id: 'lydian',       name: 'Lydian',           intervals: [0, 2, 4, 6, 7, 9, 11] },
  { id: 'mixolydian',   name: 'Mixolydian',       intervals: [0, 2, 4, 5, 7, 9, 10] },
  { id: 'aeolian',      name: 'Aeolian (nat. min.)', intervals: [0, 2, 3, 5, 7, 8, 10] },
  { id: 'locrian',      name: 'Locrian',          intervals: [0, 1, 3, 5, 6, 8, 10] },
  { id: 'harmonicMinor', name: 'Harmonic Minor',  intervals: [0, 2, 3, 5, 7, 8, 11] },
  { id: 'melodicMinor',  name: 'Melodic Minor',   intervals: [0, 2, 3, 5, 7, 9, 11] },
  { id: 'majorPenta',   name: 'Major Pentatonic', intervals: [0, 2, 4, 7, 9] },
  { id: 'minorPenta',   name: 'Minor Pentatonic', intervals: [0, 3, 5, 7, 10] },
  { id: 'blues',        name: 'Blues',            intervals: [0, 3, 5, 6, 7, 10] },
  { id: 'wholeTone',    name: 'Whole Tone',       intervals: [0, 2, 4, 6, 8, 10] },
  { id: 'chromatic',    name: 'Chromatic',        intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
];

export const PITCH_CLASS_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

export interface Scale {
  /** Root pitch class 0…11. */
  root: number;
  scaleId: string;
}

export const DEFAULT_SCALE: Scale = { root: 0, scaleId: 'aeolian' };

export const pitchClass = (pitch: number): number => ((Math.round(pitch) % 12) + 12) % 12;

export function findScale(id: string): ScaleDef | undefined {
  return SCALES.find((s) => s.id === id);
}

export function scaleName(scale: Scale): string {
  const def = findScale(scale.scaleId);
  return `${PITCH_CLASS_NAMES[scale.root] ?? 'C'} ${def?.name ?? scale.scaleId}`;
}

/** The pitch classes a scale contains. */
export function scalePitchClasses(scale: Scale): Set<number> {
  const def = findScale(scale.scaleId);
  const out = new Set<number>();
  for (const i of def?.intervals ?? []) out.add(pitchClass(scale.root + i));
  return out;
}

export function isInScale(pitch: number, scale: Scale): boolean {
  return scalePitchClasses(scale).has(pitchClass(pitch));
}

/**
 * Scale degree of a pitch (1-based), or null when it is outside the scale.
 * Used for the note guides and for chord-scale matching.
 */
export function scaleDegree(pitch: number, scale: Scale): number | null {
  const def = findScale(scale.scaleId);
  if (!def) return null;
  const offset = pitchClass(pitch - scale.root);
  const index = def.intervals.indexOf(offset);
  return index === -1 ? null : index + 1;
}

/**
 * Nearest pitch inside the scale.
 *
 * `direction` decides ties and constrains the move: 'nearest' picks the
 * closest (down on a tie, matching how editors behave when you drag a note
 * onto a black key), 'up'/'down' force the direction.
 */
export function snapPitchToScale(
  pitch: number, scale: Scale, direction: 'nearest' | 'up' | 'down' = 'nearest',
): number {
  const allowed = scalePitchClasses(scale);
  if (allowed.size === 0) return pitch;
  const base = Math.round(pitch);
  if (allowed.has(pitchClass(base))) return base;

  for (let distance = 1; distance <= 12; distance++) {
    const down = base - distance;
    const up = base + distance;
    const downOk = allowed.has(pitchClass(down));
    const upOk = allowed.has(pitchClass(up));
    if (direction === 'down') { if (downOk) return down; continue; }
    if (direction === 'up')   { if (upOk) return up; continue; }
    if (downOk) return down;      // tie → downward, like dragging onto the key below
    if (upOk) return up;
  }
  return base;
}

// ── Scale detection ───────────────────────────────────────────────────────────

export interface ScaleSuggestion {
  scale: Scale;
  /** 0…1 — share of the weighted material that fits. */
  score: number;
  /** How many distinct pitches fell outside. */
  outsideCount: number;
}

/**
 * Rank the scales that fit a set of pitches.
 *
 * Weighting by duration (not note count) is what makes this usable: sixteen
 * passing sixteenths must not outvote a held tonic.  The tonic bonus breaks
 * the tie between relative major and minor, which share every pitch class.
 */
export function suggestScales(
  pitches: ReadonlyArray<{ pitch: number; weight?: number }>,
  limit = 8,
): ScaleSuggestion[] {
  if (pitches.length === 0) return [];

  const histogram = new Array<number>(12).fill(0);
  let total = 0;
  let firstPc: number | null = null;
  let lastPc: number | null = null;
  for (const p of pitches) {
    const w = p.weight ?? 1;
    const pc = pitchClass(p.pitch);
    histogram[pc] = (histogram[pc] ?? 0) + w;
    total += w;
    if (firstPc === null) firstPc = pc;
    lastPc = pc;
  }
  if (total <= 0) return [];

  const suggestions: ScaleSuggestion[] = [];
  for (const def of SCALES) {
    if (def.id === 'chromatic') continue;              // fits everything, says nothing
    for (let root = 0; root < 12; root++) {
      const scale: Scale = { root, scaleId: def.id };
      const allowed = scalePitchClasses(scale);
      let inside = 0;
      let outsideCount = 0;
      for (let pc = 0; pc < 12; pc++) {
        const weight = histogram[pc] ?? 0;
        if (weight <= 0) continue;
        if (allowed.has(pc)) inside += weight; else outsideCount += 1;
      }
      // The root and the fifth carry the tonal centre; and music tends to
      // start or end on it.
      const rootWeight  = (histogram[root] ?? 0) / total;
      const fifthWeight = (histogram[pitchClass(root + 7)] ?? 0) / total;
      const cadence = (firstPc === root ? 0.05 : 0) + (lastPc === root ? 0.08 : 0);
      const score = (inside / total) * 0.8 + rootWeight * 0.1 + fifthWeight * 0.04 + cadence;
      suggestions.push({ scale, score, outsideCount });
    }
  }

  suggestions.sort((a, b) => b.score - a.score || a.outsideCount - b.outsideCount);
  return suggestions.slice(0, limit);
}

/** Convenience: the single best-fitting scale, or null for no input. */
export function detectScale(
  pitches: ReadonlyArray<{ pitch: number; weight?: number }>,
): Scale | null {
  return suggestScales(pitches, 1)[0]?.scale ?? null;
}
