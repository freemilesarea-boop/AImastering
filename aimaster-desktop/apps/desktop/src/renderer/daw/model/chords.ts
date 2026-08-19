// Chords — the harmony the project knows about.
//
// This is the layer that makes "여기 코드 좀 재즈스럽게 바꿔" possible later:
// once the session stores `Cmaj7 → Am7 → Dm7 → G7` as structured data (root,
// quality, tensions, bass) instead of a text label, a transformation is a
// function over that data, not a guess over audio.
//
// Three capabilities:
//   • parse / format chord symbols
//   • DETECT a chord from the notes that are sounding (the Key Editor's
//     "Current Chord Display" and Chord Editing panel)
//   • TRANSFORM progressions (reharmonise, transpose, simplify)

import { pitchClass, PITCH_CLASS_NAMES, type Scale } from './scales.js';

export interface ChordQuality {
  id: string;
  /** Symbol suffix, e.g. 'maj7'. */
  suffix: string;
  name: string;
  /** Semitones above the root. */
  intervals: readonly number[];
  /** Aliases accepted by the parser. */
  aliases?: readonly string[];
}

export const QUALITIES: readonly ChordQuality[] = [
  { id: 'maj',      suffix: '',       name: 'Major',            intervals: [0, 4, 7],        aliases: ['maj', 'M'] },
  { id: 'min',      suffix: 'm',      name: 'Minor',            intervals: [0, 3, 7],        aliases: ['min', '-'] },
  { id: 'dim',      suffix: 'dim',    name: 'Diminished',       intervals: [0, 3, 6],        aliases: ['°', 'o'] },
  { id: 'aug',      suffix: 'aug',    name: 'Augmented',        intervals: [0, 4, 8],        aliases: ['+', '#5'] },
  { id: 'sus2',     suffix: 'sus2',   name: 'Suspended 2nd',    intervals: [0, 2, 7] },
  { id: 'sus4',     suffix: 'sus4',   name: 'Suspended 4th',    intervals: [0, 5, 7],        aliases: ['sus'] },
  { id: 'maj6',     suffix: '6',      name: 'Major 6th',        intervals: [0, 4, 7, 9],     aliases: ['maj6'] },
  { id: 'min6',     suffix: 'm6',     name: 'Minor 6th',        intervals: [0, 3, 7, 9],     aliases: ['min6'] },
  { id: 'dom7',     suffix: '7',      name: 'Dominant 7th',     intervals: [0, 4, 7, 10] },
  { id: 'maj7',     suffix: 'maj7',   name: 'Major 7th',        intervals: [0, 4, 7, 11],    aliases: ['M7', 'Δ', 'Δ7'] },
  { id: 'min7',     suffix: 'm7',     name: 'Minor 7th',        intervals: [0, 3, 7, 10],    aliases: ['min7', '-7'] },
  { id: 'min7b5',   suffix: 'm7b5',   name: 'Half Diminished',  intervals: [0, 3, 6, 10],    aliases: ['ø', 'ø7', 'm7-5'] },
  { id: 'dim7',     suffix: 'dim7',   name: 'Diminished 7th',   intervals: [0, 3, 6, 9],     aliases: ['°7', 'o7'] },
  { id: 'minMaj7',  suffix: 'mMaj7',  name: 'Minor Major 7th',  intervals: [0, 3, 7, 11],    aliases: ['minmaj7', 'mM7'] },
  { id: 'sus4_7',   suffix: '7sus4',  name: '7 sus4',           intervals: [0, 5, 7, 10],    aliases: ['sus4/7'] },
  { id: 'sus2_7',   suffix: '7sus2',  name: '7 sus2',           intervals: [0, 2, 7, 10],    aliases: ['sus2/7'] },
  { id: 'maj7s5',   suffix: 'maj7#5', name: 'Major 7th #5',     intervals: [0, 4, 8, 11] },
  { id: 'dom9',     suffix: '9',      name: 'Dominant 9th',     intervals: [0, 4, 7, 10, 14] },
  { id: 'maj9',     suffix: 'maj9',   name: 'Major 9th',        intervals: [0, 4, 7, 11, 14] },
  { id: 'min9',     suffix: 'm9',     name: 'Minor 9th',        intervals: [0, 3, 7, 10, 14], aliases: ['min9'] },
  { id: 'dom13',    suffix: '13',     name: 'Dominant 13th',    intervals: [0, 4, 7, 10, 14, 21] },
  { id: 'alt7',     suffix: '7alt',   name: 'Altered Dominant', intervals: [0, 4, 8, 10, 13] },
];

export function findQuality(id: string): ChordQuality | undefined {
  return QUALITIES.find((q) => q.id === id);
}

export interface ChordSymbol {
  /** Root pitch class 0…11. */
  root: number;
  qualityId: string;
  /** Slash bass, when it differs from the root. */
  bass: number | null;
}

export function makeChord(root: number, qualityId = 'maj', bass: number | null = null): ChordSymbol {
  return { root: pitchClass(root), qualityId, bass: bass === null ? null : pitchClass(bass) };
}

export function formatChord(chord: ChordSymbol): string {
  const quality = findQuality(chord.qualityId);
  const root = PITCH_CLASS_NAMES[chord.root] ?? 'C';
  const suffix = quality?.suffix ?? '';
  const slash = chord.bass !== null && chord.bass !== chord.root
    ? `/${PITCH_CLASS_NAMES[chord.bass] ?? ''}`
    : '';
  return `${root}${suffix}${slash}`;
}

const ROOT_PATTERN = /^([A-Ga-g])([#b♯♭]?)/;

function parseRoot(text: string): { pc: number; rest: string } | null {
  const m = ROOT_PATTERN.exec(text);
  if (!m || !m[1]) return null;
  const base: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
  let pc = base[m[1].toLowerCase()] ?? 0;
  if (m[2] === '#' || m[2] === '♯') pc += 1;
  if (m[2] === 'b' || m[2] === '♭') pc -= 1;
  return { pc: pitchClass(pc), rest: text.slice(m[0].length) };
}

/** Parse "Cmaj7", "Emin9/D", "F#m7b5", "Bb7sus4". */
export function parseChord(text: string): ChordSymbol | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const rootPart = parseRoot(trimmed);
  if (!rootPart) return null;

  let rest = rootPart.rest;
  let bass: number | null = null;
  const slash = rest.indexOf('/');
  if (slash !== -1) {
    const bassPart = parseRoot(rest.slice(slash + 1));
    if (bassPart) bass = bassPart.pc;
    rest = rest.slice(0, slash);
  }

  const normalized = rest.trim();
  if (normalized === '') return makeChord(rootPart.pc, 'maj', bass);

  // Longest suffix wins so 'maj7' is not read as 'maj' + a stray '7'.
  const candidates = QUALITIES.flatMap((q) => [q.suffix, ...(q.aliases ?? [])]
    .filter(Boolean)
    .map((token) => ({ token, id: q.id })));
  candidates.sort((a, b) => b.token.length - a.token.length);

  // Case matters in chord symbols: 'M' is major and 'm' is minor, so an exact
  // match is tried first.  Only longer tokens ('maj7', 'MIN7') fall back to a
  // case-insensitive match, where no such collision exists.
  const exact = candidates.find((c) => c.token === normalized);
  if (exact) return makeChord(rootPart.pc, exact.id, bass);

  const loose = candidates.find(
    (c) => c.token.length > 1 && c.token.toLowerCase() === normalized.toLowerCase(),
  );
  return loose ? makeChord(rootPart.pc, loose.id, bass) : null;
}

/** Pitch classes the chord contains (tensions folded into the octave). */
export function chordPitchClasses(chord: ChordSymbol): Set<number> {
  const quality = findQuality(chord.qualityId);
  const out = new Set<number>();
  for (const i of quality?.intervals ?? [0, 4, 7]) out.add(pitchClass(chord.root + i));
  if (chord.bass !== null) out.add(chord.bass);
  return out;
}

/** Voice the chord as absolute pitches from `bottomPitch` upward. */
export function voiceChord(chord: ChordSymbol, bottomPitch = 48): number[] {
  const quality = findQuality(chord.qualityId);
  const intervals = quality?.intervals ?? [0, 4, 7];
  const rootPitch = bottomPitch + pitchClass(chord.root - pitchClass(bottomPitch));
  const notes = intervals.map((i) => rootPitch + i);
  if (chord.bass !== null && chord.bass !== chord.root) {
    const bassPitch = rootPitch - 12 + pitchClass(chord.bass - pitchClass(rootPitch - 12));
    return [bassPitch, ...notes];
  }
  return notes;
}

// ── Detection ─────────────────────────────────────────────────────────────────

export interface ChordMatch {
  chord: ChordSymbol;
  /** 0…1 — how well the template explains the sounding pitches. */
  score: number;
}

/**
 * Identify the chord a set of pitches spells.
 *
 * Scored by template matching: every chord tone present adds, every sounding
 * pitch NOT in the template subtracts, and a missing template tone costs less
 * than a wrong one (real voicings drop fifths all the time).  The lowest
 * pitch decides the slash bass.
 */
export function detectChord(pitches: readonly number[]): ChordMatch | null {
  const unique = [...new Set(pitches.map(pitchClass))];
  if (unique.length === 0) return null;
  if (unique.length === 1) {
    return { chord: makeChord(unique[0] ?? 0, 'maj'), score: 0.35 };
  }

  const lowest = pitches.length > 0 ? pitchClass(Math.min(...pitches)) : null;
  const sounding = new Set(unique);
  let best: ChordMatch | null = null;

  for (const quality of QUALITIES) {
    for (let root = 0; root < 12; root++) {
      const template = new Set(quality.intervals.map((i) => pitchClass(root + i)));
      let matched = 0;
      for (const pc of template) if (sounding.has(pc)) matched += 1;
      let extra = 0;
      for (const pc of sounding) if (!template.has(pc)) extra += 1;
      const missing = template.size - matched;

      // Root present is worth a lot — a rootless voicing is the exception.
      const rootBonus = sounding.has(root) ? 0.12 : 0;
      const bassBonus = lowest === root ? 0.06 : 0;
      const score = matched / template.size - extra * 0.25 - missing * 0.1 + rootBonus + bassBonus;
      if (!best || score > best.score) {
        const bass = lowest !== null && lowest !== root ? lowest : null;
        best = { chord: makeChord(root, quality.id, bass), score };
      }
    }
  }
  return best && best.score > 0 ? best : null;
}

// ── Chord track ───────────────────────────────────────────────────────────────

export interface ChordEvent {
  id: string;
  /** Timeline position in seconds. */
  timeSec: number;
  chord: ChordSymbol;
}

export function chordAt(events: readonly ChordEvent[], timeSec: number): ChordEvent | null {
  let current: ChordEvent | null = null;
  for (const e of [...events].sort((a, b) => a.timeSec - b.timeSec)) {
    if (e.timeSec <= timeSec + 1e-9) current = e; else break;
  }
  return current;
}

/** Scales that fit a chord, best first — feeds the Scale Assistant. */
export function chordScales(chord: ChordSymbol): Scale[] {
  const quality = findQuality(chord.qualityId);
  const set = new Set(quality?.intervals.map((i) => i % 12) ?? []);
  const has = (i: number): boolean => set.has(i);

  if (has(10) && has(4)) return [                      // dominant
    { root: chord.root, scaleId: 'mixolydian' },
    { root: chord.root, scaleId: 'blues' },
    { root: chord.root, scaleId: 'wholeTone' },
  ];
  if (has(11) && has(4)) return [                      // major 7
    { root: chord.root, scaleId: 'major' },
    { root: chord.root, scaleId: 'lydian' },
    { root: chord.root, scaleId: 'majorPenta' },
  ];
  if (has(3) && has(6)) return [                       // half / full diminished
    { root: chord.root, scaleId: 'locrian' },
    { root: chord.root, scaleId: 'harmonicMinor' },
  ];
  if (has(3)) return [                                 // minor
    { root: chord.root, scaleId: 'dorian' },
    { root: chord.root, scaleId: 'aeolian' },
    { root: chord.root, scaleId: 'minorPenta' },
  ];
  return [{ root: chord.root, scaleId: 'major' }];
}

// ── Transformations ───────────────────────────────────────────────────────────

export function transposeChord(chord: ChordSymbol, semitones: number): ChordSymbol {
  return {
    root: pitchClass(chord.root + semitones),
    qualityId: chord.qualityId,
    bass: chord.bass === null ? null : pitchClass(chord.bass + semitones),
  };
}

const JAZZ_UPGRADE: Record<string, string> = {
  maj: 'maj7', min: 'min7', dom7: 'dom9', dim: 'min7b5',
  sus4: 'sus4_7', sus2: 'sus2_7', maj6: 'maj7', min6: 'min7',
};

const SIMPLIFY: Record<string, string> = {
  maj7: 'maj', maj9: 'maj', dom7: 'maj', dom9: 'maj', dom13: 'maj', alt7: 'maj',
  min7: 'min', min9: 'min', min6: 'min', minMaj7: 'min', min7b5: 'dim',
  dim7: 'dim', sus4_7: 'sus4', sus2_7: 'sus2', maj7s5: 'aug',
};

/** Richer voicings: triads become sevenths, sevenths grow a ninth. */
export function jazzifyChord(chord: ChordSymbol): ChordSymbol {
  const next = JAZZ_UPGRADE[chord.qualityId];
  return next ? { ...chord, qualityId: next } : chord;
}

export function simplifyChord(chord: ChordSymbol): ChordSymbol {
  const next = SIMPLIFY[chord.qualityId];
  return next ? { ...chord, qualityId: next, bass: null } : chord;
}

/** Tritone substitution — the classic dominant swap (G7 → Db7). */
export function tritoneSub(chord: ChordSymbol): ChordSymbol {
  const quality = findQuality(chord.qualityId);
  const isDominant = quality?.intervals.includes(10) && quality.intervals.includes(4);
  return isDominant ? { ...chord, root: pitchClass(chord.root + 6), bass: null } : chord;
}

/** The ii chord a fifth above a dominant — the front half of a ii–V. */
export function relatedTwo(dominant: ChordSymbol): ChordSymbol {
  return makeChord(pitchClass(dominant.root + 7), 'min7');
}

export interface ReharmonizeOptions {
  /** Upgrade triads to sevenths / ninths. */
  extend?: boolean;
  /** Insert the related ii before each dominant. */
  insertTwoFive?: boolean;
  /** Replace dominants with their tritone sub. */
  tritone?: boolean;
}

/**
 * Reharmonise a progression.
 *
 * Deterministic and reversible-by-inspection on purpose: this is the layer an
 * AI feature calls, and a model that cannot explain what it changed is not
 * usable for editing.  `Cmaj7 → Am7 → Dm7 → G7` with `insertTwoFive` puts a
 * Dm7 in front of the G7; with `tritone` the G7 becomes Db7.
 */
export function reharmonize(
  progression: readonly ChordEvent[], options: ReharmonizeOptions = {},
): ChordEvent[] {
  const sorted = [...progression].sort((a, b) => a.timeSec - b.timeSec);
  const out: ChordEvent[] = [];

  sorted.forEach((event, index) => {
    let chord = event.chord;
    if (options.extend) chord = jazzifyChord(chord);

    const quality = findQuality(chord.qualityId);
    const isDominant = Boolean(quality?.intervals.includes(10) && quality.intervals.includes(4));

    if (options.insertTwoFive && isDominant) {
      const next = sorted[index + 1];
      const span = (next ? next.timeSec : event.timeSec + 2) - event.timeSec;
      if (span > 0.5) {
        out.push({ id: `${event.id}-ii`, timeSec: event.timeSec, chord: relatedTwo(chord) });
        out.push({ id: event.id, timeSec: event.timeSec + span / 2, chord: options.tritone ? tritoneSub(chord) : chord });
        return;
      }
    }
    if (options.tritone && isDominant) chord = tritoneSub(chord);
    out.push({ ...event, chord });
  });

  return out;
}

/** "Cmaj7 → Am7 → Dm7 → G7" for logs, tooltips and AI prompts. */
export function formatProgression(events: readonly ChordEvent[]): string {
  return [...events]
    .sort((a, b) => a.timeSec - b.timeSec)
    .map((e) => formatChord(e.chord))
    .join(' → ');
}
