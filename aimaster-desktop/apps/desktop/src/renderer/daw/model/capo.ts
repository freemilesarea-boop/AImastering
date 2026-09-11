// Capo — which shapes to play, not which notes sound.
//
// The distinction this file exists to keep straight, because conflating them
// is the way a capo feature goes wrong:
//
//   TRANSPOSE changes the music.  The chart says B♭ and afterwards it says C,
//   and if you play along with the recording you are now in the wrong key.
//
//   CAPO changes nothing about the music.  The chart still says B♭, the
//   record is still in B♭, and with a capo on the third fret you play the G
//   SHAPE and B♭ comes out.  It is a lens over the chart, not an edit to it.
//
// So a capo is display state, and transposing is a session edit.  They are in
// different files for that reason.
//
// ── What makes a shape easy ─────────────────────────────────────────────────
//
// The whole point of a capo is to turn a chart full of barre chords into one
// you can play with open strings.  Which shapes those are is not a matter of
// opinion: on a guitar in standard tuning the open chords are the CAGED set
// and their minors and sevenths.  Everything else needs a barre.
//
// This is a HEURISTIC about shapes, not a fingering engine.  It does not know
// about voicings, stretches, or that some players barre happily.  It answers
// one question — "which fret turns most of this chart into open chords" —
// and that is the question people put a capo on for.

import { transposeChord, type ChordSymbol } from './chords.js';
import { pitchClass } from './scales.js';

/** Roots that are an open shape in standard tuning, by chord family. */
const OPEN_MAJOR = new Set([0, 2, 4, 7, 9]);      // C D E G A
const OPEN_MINOR = new Set([2, 4, 9]);            // Dm Em Am
const OPEN_SEVENTH = new Set([0, 2, 4, 7, 9, 11]); // C7 D7 E7 G7 A7 B7

/**
 * Which family a quality belongs to, for the open-shape question.
 *
 * Everything that is not a plain triad or a seventh is treated as hard: a
 * capo cannot make Cmaj9#11 easy, and pretending otherwise would make the
 * suggestion confident about a chart it has not helped.
 */
function family(qualityId: string): 'major' | 'minor' | 'seventh' | 'other' {
  if (qualityId === 'maj') return 'major';
  if (qualityId === 'min') return 'minor';
  if (qualityId === 'dom7') return 'seventh';
  if (qualityId === 'min7') return 'minor';
  if (qualityId === 'maj7' || qualityId === 'maj6') return 'major';
  return 'other';
}

/** Is this chord, as written, an open shape? */
export function isOpenShape(chord: ChordSymbol): boolean {
  const root = pitchClass(chord.root);
  switch (family(chord.qualityId)) {
    case 'major': return OPEN_MAJOR.has(root);
    case 'minor': return OPEN_MINOR.has(root);
    case 'seventh': return OPEN_SEVENTH.has(root);
    default: return false;
  }
}

/**
 * The shape to finger for a sounding chord, with the capo at `fret`.
 *
 * Down, not up.  A capo raises what comes out, so to make B♭ come out from
 * the third fret you finger the shape three semitones BELOW it — G.  Getting
 * this backwards produces a chart that is a whole tritone out at fret 6 and
 * looks plausible everywhere else, which is why it has its own test.
 */
export function shapeFor(chord: ChordSymbol, fret: number): ChordSymbol {
  return transposeChord(chord, -Math.round(fret));
}

/** The most a capo is worth putting on.  Past this the guitar runs out of neck. */
export const MAX_CAPO_FRET = 7;

export interface CapoOption {
  fret: number;
  /** Share of the progression, by weight, that becomes an open shape. */
  openShare: number;
  /** The shapes, in order — what the player would actually read. */
  shapes: ChordSymbol[];
}

export interface CapoChord {
  chord: ChordSymbol;
  /** How long it lasts.  Defaults to 1. */
  weight?: number;
}

/**
 * Every capo position, scored — best first.
 *
 * Weighted by how long each chord lasts, for the same reason everything else
 * here is: a capo that makes the passing chord easy and the four-bar chord
 * hard has not helped.
 *
 * Ties go to the LOWER fret, because a capo high on the neck shortens the
 * scale and thins the sound, and a player who can have the same shapes at
 * fret 2 will not choose fret 9.
 */
export function capoOptions(chords: readonly CapoChord[]): CapoOption[] {
  if (chords.length === 0) return [];
  let total = 0;
  for (const entry of chords) total += Math.max(0, entry.weight ?? 1);
  if (total <= 0) return [];

  const out: CapoOption[] = [];
  for (let fret = 0; fret <= MAX_CAPO_FRET; fret++) {
    let open = 0;
    const shapes: ChordSymbol[] = [];
    for (const entry of chords) {
      const shape = shapeFor(entry.chord, fret);
      shapes.push(shape);
      if (isOpenShape(shape)) open += Math.max(0, entry.weight ?? 1);
    }
    out.push({ fret, openShare: open / total, shapes });
  }
  out.sort((a, b) => b.openShare - a.openShare || a.fret - b.fret);
  return out;
}

/**
 * The capo worth suggesting, or null when none is.
 *
 * Null is a real answer and the important one: a chart that is already open
 * shapes, or one full of chords no capo can help, should get no suggestion
 * rather than a shrug dressed as advice.  A suggestion has to beat playing it
 * as written by a clear margin — moving a capo to gain one chord in eight is
 * not worth the interruption.
 */
export const CAPO_WORTH_IT = 0.2;

export function suggestCapo(chords: readonly CapoChord[]): CapoOption | null {
  const options = capoOptions(chords);
  const best = options[0];
  const asWritten = options.find((o) => o.fret === 0);
  if (!best || !asWritten) return null;
  if (best.fret === 0) return null;
  return best.openShare >= asWritten.openShare + CAPO_WORTH_IT ? best : null;
}
