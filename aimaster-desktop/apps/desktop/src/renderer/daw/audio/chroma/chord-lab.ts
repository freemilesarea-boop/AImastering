// Reference annotations, and scoring against them.
//
// Every accuracy number this repository has printed about chord recognition
// so far comes from audio it rendered itself, out of instruments it wrote,
// playing progressions it chose.  That is a fair test of whether the code
// does what it claims and it is EASIER than real music in ways that are hard
// to list: no reverb tail smearing one chord into the next, no guitar
// doubling the vocal a third above, no producer leaving a suspended fourth
// hanging for three bars because it sounded good.
//
// The way out is the same one the separator took — measure on real records,
// on the user's own machine, and let nothing leave it.  For chords the ground
// truth is a hand-made annotation file, and there is one format for that.
//
// ── The .lab format ─────────────────────────────────────────────────────────
//
// Three columns, whitespace separated, one line per chord:
//
//     0.000000  1.672902  N
//     1.672902  5.194149  C:maj
//     5.194149  8.712000  A:min7
//     8.712000  12.20000  G:maj/5
//
// This is Harte's syntax, and it is what the public reference sets are
// written in — Isophonics (the Beatles, Queen, Zweieck), the McGill Billboard
// set, RWC Popular.  Supporting it exactly means the user can point this at a
// corpus somebody else annotated by hand, rather than annotating their own
// record before they can find out whether the detector works.
//
// ── What is deliberately simplified ─────────────────────────────────────────
//
// Harte allows a chord to be written as a root plus an explicit interval list
// with additions and omissions: `C:min7(*b3,9)` is a C minor seventh with the
// third taken out and a ninth added.  Those parenthesised modifiers are
// parsed and then DROPPED, because a chroma has twelve numbers in it and the
// distinction between C:min7 and C:min7(9) is not one this detector could
// answer even in principle.  Dropping them is the standard simplification and
// it is written down here rather than left for someone to discover.

import {
  QUALITIES, formatChord, makeChord, type ChordSymbol,
} from '../../model/chords.js';
import { PITCH_CLASSES } from './chroma.js';

export interface LabSpan {
  startSec: number;
  endSec: number;
  /** The label as written, so an unparsable one can be reported verbatim. */
  label: string;
  /** Null for `N` (silence or no chord) and for anything unparsable. */
  chord: ChordSymbol | null;
  /** True for `X` — annotated as "not decidable", and excluded from scoring. */
  unknown: boolean;
}

// ── Labels ──────────────────────────────────────────────────────────────────

const NOTE_BASE: Readonly<Record<string, number>> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};

/**
 * Harte shorthand → this repository's quality ids.
 *
 * The left column is fixed by the format; the right is ours.  Anything not
 * here is reported as unparsable rather than guessed at, because a silent
 * mapping of an unknown shorthand onto a plausible quality would corrupt the
 * reference — the one thing in the measurement that has to be trusted.
 */
const SHORTHAND: Readonly<Record<string, string>> = {
  maj: 'maj', min: 'min', dim: 'dim', aug: 'aug',
  maj7: 'maj7', min7: 'min7', '7': 'dom7', dim7: 'dim7',
  hdim7: 'min7b5', minmaj7: 'minMaj7',
  maj6: 'maj6', '6': 'maj6', min6: 'min6',
  sus2: 'sus2', sus4: 'sus4',
  '9': 'dom9', maj9: 'maj9', min9: 'min9', '13': 'dom13',
};

/** Semitones above the root for Harte's degree names, for the bass of a slash. */
const DEGREE: Readonly<Record<string, number>> = {
  '1': 0, b2: 1, '2': 2, b3: 3, '3': 4, '4': 5, '#4': 6, b5: 6, '5': 7,
  '#5': 8, b6: 8, '6': 9, b7: 10, '7': 11, '9': 2, b9: 1, '#9': 3,
  '11': 5, '#11': 6, '13': 9, b13: 8,
};

export interface ParsedLabel {
  chord: ChordSymbol | null;
  unknown: boolean;
  /** Set when the label could not be read at all. */
  problem?: string;
}

/** A Harte chord label — `C:maj7/3`, `N`, `X`, `Bb:min`. */
export function parseHarteLabel(raw: string): ParsedLabel {
  const label = raw.trim();
  if (label === '' || label === 'N') return { chord: null, unknown: false };
  if (label === 'X') return { chord: null, unknown: true };

  // Root, then an optional `:shorthand`, then an optional `/bass`.
  const slash = label.indexOf('/');
  const head = slash >= 0 ? label.slice(0, slash) : label;
  const bassText = slash >= 0 ? label.slice(slash + 1).trim() : '';

  const colon = head.indexOf(':');
  const rootText = (colon >= 0 ? head.slice(0, colon) : head).trim();
  // The parenthesised additions and omissions, dropped on purpose — see the
  // note at the top of this file.
  const qualityText = (colon >= 0 ? head.slice(colon + 1) : 'maj')
    .replace(/\(.*?\)/g, '').trim();

  const root = parseRoot(rootText);
  if (root === null) return { chord: null, unknown: false, problem: `근음을 읽을 수 없습니다: ${rootText}` };

  const qualityId = SHORTHAND[qualityText === '' ? 'maj' : qualityText];
  if (!qualityId) return { chord: null, unknown: false, problem: `모르는 코드 종류: ${qualityText}` };

  if (bassText === '') return { chord: makeChord(root, qualityId), unknown: false };
  const degree = DEGREE[bassText];
  if (degree === undefined) {
    // A bass we cannot place is not a reason to throw the chord away — the
    // root and the quality are still the annotation's claim.
    return { chord: makeChord(root, qualityId), unknown: false };
  }
  return {
    chord: makeChord(root, qualityId, (root + degree) % PITCH_CLASSES),
    unknown: false,
  };
}

function parseRoot(text: string): number | null {
  const letter = text[0]?.toUpperCase();
  if (!letter || !(letter in NOTE_BASE)) return null;
  let pc = NOTE_BASE[letter] ?? 0;
  for (const ch of text.slice(1)) {
    if (ch === '#') pc += 1;
    else if (ch === 'b') pc -= 1;
    else return null;
  }
  return ((pc % PITCH_CLASSES) + PITCH_CLASSES) % PITCH_CLASSES;
}

/** A chord as Harte shorthand, so our output can be diffed against a reference. */
export function formatHarteLabel(chord: ChordSymbol | null): string {
  if (!chord) return 'N';
  const shorthand = Object.entries(SHORTHAND)
    // The first spelling that maps to this quality, preferring the named ones
    // over the numeric aliases so `C:maj6` comes out rather than `C:6`.
    .filter(([, id]) => id === chord.qualityId)
    .sort((a, b) => b[0].length - a[0].length)[0]?.[0];
  if (!shorthand) return 'X';
  const root = PITCH_NAMES[chord.root] ?? 'C';
  const head = `${root}:${shorthand}`;
  if (chord.bass === undefined || chord.bass === null || chord.bass === chord.root) return head;
  const interval = ((chord.bass - chord.root) % PITCH_CLASSES + PITCH_CLASSES) % PITCH_CLASSES;
  const degree = Object.entries(DEGREE).find(([, v]) => v === interval)?.[0];
  return degree ? `${head}/${degree}` : head;
}

const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// ── Files ───────────────────────────────────────────────────────────────────

export interface LabParse {
  spans: LabSpan[];
  /** Lines that could not be read, with their numbers.  Reported, not hidden. */
  problems: string[];
}

/** Read a `.lab` file's text. */
export function parseLab(text: string): LabParse {
  const spans: LabSpan[] = [];
  const problems: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (line === '' || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) { problems.push(`${i + 1}행: 열이 3개가 아닙니다 — ${line}`); continue; }
    const startSec = Number(parts[0]);
    const endSec = Number(parts[1]);
    const label = parts.slice(2).join(' ');
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec < startSec) {
      problems.push(`${i + 1}행: 시간을 읽을 수 없습니다 — ${line}`);
      continue;
    }
    const parsed = parseHarteLabel(label);
    if (parsed.problem) problems.push(`${i + 1}행: ${parsed.problem}`);
    spans.push({ startSec, endSec, label, chord: parsed.chord, unknown: parsed.unknown });
  }
  spans.sort((a, b) => a.startSec - b.startSec);
  return { spans, problems };
}

/** Chord segments as `.lab` text, for diffing against a reference by eye. */
export function formatLab(
  segments: readonly { startSec: number; endSec: number; chord: ChordSymbol | null }[],
): string {
  return segments
    .map((s) => `${s.startSec.toFixed(6)}\t${s.endSec.toFixed(6)}\t${formatHarteLabel(s.chord)}`)
    .join('\n') + '\n';
}

// ── Scoring ─────────────────────────────────────────────────────────────────

/**
 * The tiers, and why there are four.
 *
 * A single "was it right" number hides the thing you most need to know. A
 * detector that answers Cmaj7 where the truth is C got the harmony right and
 * the colour wrong; one that answers Em got neither.  Reporting them apart is
 * how stage C's real gain was found — the exact-label number was FLAT across
 * that change while the root and triad numbers moved fifteen points.
 */
export type ScoreTier = 'root' | 'triad' | 'sevenths' | 'exact';

export const SCORE_TIERS: readonly ScoreTier[] = ['root', 'triad', 'sevenths', 'exact'];

export interface ChordScore {
  /** Seconds of agreement per tier, divided by the scored duration. */
  scores: Record<ScoreTier, number>;
  /** Reference seconds that were scored — `X` spans are not. */
  scoredSec: number;
  /** Reference seconds skipped because the annotation said `X`. */
  skippedSec: number;
  /** How many chord changes each side has.  Ratios far from 1 mean a chart nobody can read. */
  referenceChanges: number;
  estimateChanges: number;
  /** Median distance from a reference boundary to the nearest estimated one. */
  medianBoundaryErrorSec: number;
}

/**
 * The colour a tier compares.
 *
 * These definitions are OURS.  They are in the spirit of the MIREX chord
 * tasks, and they are written out here rather than borrowed from a library,
 * which means a number from this benchmark is comparable across our own runs
 * and is NOT directly comparable to a published MIREX figure.  Saying so is
 * the difference between a benchmark and a marketing number.
 */
function tierKey(chord: ChordSymbol | null, tier: ScoreTier): string {
  if (!chord) return 'N';
  if (tier === 'root') return String(chord.root);
  if (tier === 'exact') return formatChord(chord);
  const intervals = QUALITIES.find((q) => q.id === chord.qualityId)?.intervals ?? [0, 4, 7];
  if (tier === 'triad') {
    // Major, minor, or neither — a sus chord is not a bad major.
    const colour = intervals.includes(3) ? 'm' : intervals.includes(4) ? 'M' : 'x';
    return `${chord.root}${colour}`;
  }
  // sevenths: the root and the quality, but not the inversion.
  return `${chord.root}:${chord.qualityId}`;
}

/** Where either sequence changes — the intervals scoring runs over. */
function boundaries(...lists: ReadonlyArray<readonly LabSpan[]>): number[] {
  const set = new Set<number>();
  for (const list of lists) for (const s of list) { set.add(s.startSec); set.add(s.endSec); }
  return [...set].sort((a, b) => a - b);
}

function spanAt(spans: readonly LabSpan[], timeSec: number): LabSpan | null {
  for (const s of spans) if (s.startSec <= timeSec && timeSec < s.endSec) return s;
  return null;
}

/**
 * Duration-weighted agreement between an annotation and an estimate.
 *
 * Weighted by SECONDS, not by chord or by beat.  A four-bar C and a passing
 * F♯dim7 are one chord each and they are not one unit each of being right:
 * the listener hears the C for eight seconds.
 */
export function scoreChords(
  reference: readonly LabSpan[], estimate: readonly LabSpan[],
): ChordScore {
  const scores: Record<ScoreTier, number> = { root: 0, triad: 0, sevenths: 0, exact: 0 };
  const agreed: Record<ScoreTier, number> = { root: 0, triad: 0, sevenths: 0, exact: 0 };
  let scoredSec = 0;
  let skippedSec = 0;

  const edges = boundaries(reference, estimate);
  for (let i = 0; i + 1 < edges.length; i++) {
    const from = edges[i] ?? 0;
    const to = edges[i + 1] ?? 0;
    const length = to - from;
    if (length <= 0) continue;
    const mid = from + length / 2;
    const ref = spanAt(reference, mid);
    if (!ref) continue;                       // outside the annotation entirely
    if (ref.unknown) { skippedSec += length; continue; }
    scoredSec += length;
    const est = spanAt(estimate, mid);
    for (const tier of SCORE_TIERS) {
      if (tierKey(ref.chord, tier) === tierKey(est?.chord ?? null, tier)) agreed[tier] += length;
    }
  }
  for (const tier of SCORE_TIERS) {
    scores[tier] = scoredSec > 0 ? agreed[tier] / scoredSec : 0;
  }

  // Boundaries.  A chart with the right labels in the wrong places is not a
  // usable chart, and the tier scores above can look respectable while every
  // change lands half a bar late.
  const refEdges = changePoints(reference);
  const estEdges = changePoints(estimate);
  const errors = refEdges.map((t) => {
    let best = Infinity;
    for (const e of estEdges) best = Math.min(best, Math.abs(e - t));
    return best;
  }).sort((a, b) => a - b);
  const median = errors.length === 0 ? 0
    : (errors[Math.floor(errors.length / 2)] ?? 0);

  return {
    scores,
    scoredSec,
    skippedSec,
    referenceChanges: refEdges.length,
    estimateChanges: estEdges.length,
    medianBoundaryErrorSec: Number.isFinite(median) ? median : 0,
  };
}

/** The times a sequence changes chord — not every span edge. */
function changePoints(spans: readonly LabSpan[]): number[] {
  const out: number[] = [];
  let previous: string | null = null;
  for (const s of spans) {
    const key = s.chord ? formatChord(s.chord) : 'N';
    if (key !== previous) out.push(s.startSec);
    previous = key;
  }
  return out;
}

/** Chord segments as lab spans, so an estimate can be scored or written out. */
export function segmentsToSpans(
  segments: readonly { startSec: number; endSec: number; chord: ChordSymbol }[],
  totalSec: number,
): LabSpan[] {
  const spans: LabSpan[] = [];
  let cursor = 0;
  for (const s of segments) {
    // The gaps are written out as explicit `N` spans.
    //
    // Not for the scoring — `scoreChords` already reads a hole as no chord,
    // and removing this changes no number it produces.  It is for the FILE:
    // a reference annotation covers the whole recording, and a .lab with
    // holes in it is not one.  Anything that reads our output back — this
    // benchmark, another tool, a person diffing two files side by side —
    // needs the same shape it would get from Isophonics.
    if (s.startSec > cursor + 1e-6) {
      spans.push({ startSec: cursor, endSec: s.startSec, label: 'N', chord: null, unknown: false });
    }
    spans.push({
      startSec: s.startSec, endSec: s.endSec, label: formatHarteLabel(s.chord),
      chord: s.chord, unknown: false,
    });
    cursor = s.endSec;
  }
  if (totalSec > cursor + 1e-6) {
    spans.push({ startSec: cursor, endSec: totalSec, label: 'N', chord: null, unknown: false });
  }
  return spans;
}
