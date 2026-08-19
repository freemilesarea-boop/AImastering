// Riff Machine — phrases from constraints.
//
// The easy version of this feature picks random notes from a scale, and it is
// worthless: scale-correct noise is still noise.  What separates a riff from a
// random walk is a short list of rules that every writer follows without
// thinking about them, and all of them are computable:
//
//   HARMONY   strong beats land on chord tones; weak beats may pass between
//             them.  This is the difference between "in the key" and "on the
//             chord", and it is most of what makes a line sound intentional.
//   CONTOUR   a phrase has a shape — it goes somewhere and comes back.  A
//             melody with no contour is an exercise.
//   VOICE LEADING  small steps by default, and a leap is answered by a step
//             in the opposite direction.  Without this rule a generator
//             produces melodies nobody can sing.
//   REPETITION  a riff is a motif plus variations, not sixteen new bars.
//
// Everything is seeded, so a riff you liked comes back identical — a generator
// you cannot reproduce is a slot machine, not a tool.

import { createNote, from7bit, type MidiNote } from '../model/midi.js';
import {
  chordAt, chordPitchClasses, voiceChord, type ChordEvent,
} from '../model/chords.js';
import { pitchClass, scalePitchClasses, snapPitchToScale, type Scale } from '../model/scales.js';
import { makeRng } from '../edit/midi-edit.js';

export type RiffStyle = 'melody' | 'bass' | 'chords' | 'arp';
export type Contour = 'rise' | 'fall' | 'arch' | 'valley' | 'wave' | 'flat';

export interface RiffOptions {
  bars: number;
  tempoBpm: number;
  beatsPerBar: number;
  style: RiffStyle;
  contour: Contour;
  /** 0…1 — how many of the grid's steps get a note. */
  density: number;
  /** 0…1 — how often an onset is pushed off the beat. */
  syncopation: number;
  lowPitch: number;
  highPitch: number;
  scale: Scale;
  /** The harmony, in the riff's own time base.  Empty means scale only. */
  chords: readonly ChordEvent[];
  seed: number;
  /** 0…1 — how often a passing note may step outside the scale. */
  chromaticism?: number;
  /** Note length as a fraction of the gap to the next onset. */
  gate?: number;
  /** Grid resolution.  4 = sixteenths in 4/4. */
  stepsPerBeat?: number;
  /** 0…1 — how strongly bar 2 repeats bar 1, bar 4 repeats bar 3, and so on. */
  repetition?: number;
  /** Widest interval the line may jump.  An octave is already a lot to sing. */
  maxLeapSemitones?: number;
}

export const DEFAULT_RIFF: RiffOptions = {
  bars: 2,
  tempoBpm: 120,
  beatsPerBar: 4,
  style: 'melody',
  contour: 'arch',
  density: 0.5,
  syncopation: 0.25,
  lowPitch: 60,
  highPitch: 79,
  scale: { root: 0, scaleId: 'major' },
  chords: [],
  seed: 1,
  chromaticism: 0.08,
  gate: 0.9,
  stepsPerBeat: 4,
  repetition: 0.5,
  maxLeapSemitones: 12,
};

// ── Shape ─────────────────────────────────────────────────────────────────────

/** Where in the register the line should sit at `t` (0…1 over the phrase). */
export function contourAt(contour: Contour, t: number): number {
  const x = Math.max(0, Math.min(1, t));
  switch (contour) {
    case 'rise': return x;
    case 'fall': return 1 - x;
    case 'arch': return Math.sin(Math.PI * x);
    case 'valley': return 1 - Math.sin(Math.PI * x);
    case 'wave': return 0.5 + 0.5 * Math.sin(2 * Math.PI * x - Math.PI / 2);
    case 'flat':
    default: return 0.5;
  }
}

// ── Rhythm ────────────────────────────────────────────────────────────────────

export interface Onset {
  /** Grid step index within the whole phrase. */
  step: number;
  /** Metric weight: 1 on the bar, 0.75 on a beat, less off it. */
  weight: number;
}

/**
 * Where the notes fall.
 *
 * The bar line and the beats come first, then the gaps are filled evenly —
 * which is why a low density still sounds like a rhythm and not like three
 * random pokes.  Syncopation then pushes some onsets off the beat, and never
 * the downbeat: a riff that loses its "one" loses its shape.
 */
export function generateRhythm(options: RiffOptions): Onset[] {
  const stepsPerBeat = Math.max(1, Math.round(options.stepsPerBeat ?? 4));
  const stepsPerBar = stepsPerBeat * options.beatsPerBar;
  const total = stepsPerBar * options.bars;
  const random = makeRng(options.seed);

  const weightOf = (step: number): number => {
    const inBar = step % stepsPerBar;
    if (inBar === 0) return 1;
    if (inBar % stepsPerBeat === 0) return 0.75;
    if (inBar % (stepsPerBeat / 2) === 0) return 0.5;
    return 0.3;
  };

  const wanted = Math.max(1, Math.round(total * Math.max(0.05, Math.min(1, options.density))));
  const chosen = new Set<number>();

  // Strong positions first, in metric order.
  const candidates = Array.from({ length: total }, (_, i) => i)
    .sort((a, b) => weightOf(b) - weightOf(a) || a - b);
  for (const step of candidates) {
    if (chosen.size >= wanted) break;
    chosen.add(step);
  }

  // Syncopation: move a chosen off-beat note one step earlier, into the gap
  // before a strong beat.  The downbeat of each bar is never moved.
  const syncopation = Math.max(0, Math.min(1, options.syncopation));
  const moved = new Set<number>();
  for (const step of [...chosen].sort((a, b) => a - b)) {
    if (step % stepsPerBar === 0) { moved.add(step); continue; }
    const pushable = step % stepsPerBeat === 0 && step > 0;
    if (pushable && random() < syncopation && !chosen.has(step - 1) && !moved.has(step - 1)) {
      moved.add(step - 1);
    } else {
      moved.add(step);
    }
  }

  return [...moved].sort((a, b) => a - b).map((step) => ({ step, weight: weightOf(step) }));
}

// ── Pitch ─────────────────────────────────────────────────────────────────────

/** Pitches available at a moment, given the harmony and the register. */
function candidatePitches(
  chord: ChordEvent | null, scale: Scale, low: number, high: number, chordOnly: boolean,
): number[] {
  const allowed = chord && chordOnly
    ? chordPitchClasses(chord.chord)
    : chord
      ? new Set([...chordPitchClasses(chord.chord), ...scalePitchClasses(scale)])
      : scalePitchClasses(scale);
  const out: number[] = [];
  for (let pitch = Math.ceil(low); pitch <= Math.floor(high); pitch++) {
    if (allowed.has(pitchClass(pitch))) out.push(pitch);
  }
  return out;
}

/**
 * Generate the line.
 *
 * Each onset scores every available pitch and takes the best.  The score is
 * the three rules, weighed against each other:
 *
 *   distance from the contour's target register  — the shape
 *   interval from the previous note              — the singability
 *   a leap-then-step bonus                       — the resolution
 *
 * Scoring rather than sampling is deliberate: a random choice among "legal"
 * notes is what produces scale-correct noise.
 */
export function generateRiff(options: Partial<RiffOptions> = {}): MidiNote[] {
  const config = { ...DEFAULT_RIFF, ...options };
  const stepsPerBeat = Math.max(1, Math.round(config.stepsPerBeat ?? 4));
  const beatSec = 60 / Math.max(1, config.tempoBpm);
  const stepSec = beatSec / stepsPerBeat;
  const stepsPerBar = stepsPerBeat * config.beatsPerBar;
  const totalSteps = stepsPerBar * config.bars;
  const random = makeRng(config.seed * 7919 + 13);

  const onsets = generateRhythm(config);
  if (onsets.length === 0) return [];

  const low = Math.min(config.lowPitch, config.highPitch);
  const high = Math.max(config.lowPitch, config.highPitch);
  const gate = Math.max(0.1, Math.min(1, config.gate ?? 0.9));

  const notes: MidiNote[] = [];
  let previous: number | null = null;
  let lastInterval = 0;
  const maxLeap = Math.max(2, Math.round(config.maxLeapSemitones ?? 12));
  const repetition = Math.max(0, Math.min(1, config.repetition ?? 0));
  // What was played at each grid step, so a later bar can echo an earlier one.
  const played = new Map<number, number>();

  onsets.forEach((onset, index) => {
    const startSec = onset.step * stepSec;
    const nextStep = onsets[index + 1]?.step ?? totalSteps;
    const durationSec = Math.max(stepSec * 0.25, (nextStep - onset.step) * stepSec * gate);
    const chord = config.chords.length > 0 ? chordAt(config.chords, startSec) : null;

    if (config.style === 'chords') {
      // A chord stab uses the harmony's own voicing; nothing to choose.
      const voicing = chord ? voiceChord(chord.chord, low) : [];
      for (const pitch of voicing) {
        if (pitch > high) continue;
        notes.push(createNote({
          pitch, startSec, durationSec,
          velocity: from7bit(Math.round(70 + onset.weight * 40)),
        }));
      }
      return;
    }

    // Strong beats take chord tones; weak beats may pass between them.
    const strong = onset.weight >= 0.75;
    const chordOnly = config.style === 'bass' ? true : strong;
    let pool = candidatePitches(chord, config.scale, low, high, chordOnly);
    if (pool.length === 0) pool = candidatePitches(null, config.scale, low, high, false);
    if (pool.length === 0) return;

    // A leap wider than the limit is not a choice the line gets to make.
    // Scoring it down is not enough: when the contour pulls hard the penalty
    // loses, and the result is a melody nobody can sing.
    if (previous !== null) {
      const reachable = pool.filter((p) => Math.abs(p - previous!) <= maxLeap);
      if (reachable.length > 0) pool = reachable;
    }

    // A riff is a motif plus variations.  The echo is a BIAS inside the same
    // pool, never an overwrite afterwards — which is what keeps it on the
    // chord when the harmony has moved on since the bar it is echoing.
    const echo = repetition > 0 && onset.step >= stepsPerBar
      ? played.get(onset.step - stepsPerBar)
      : undefined;

    // Where the shape wants this note to sit.
    const t = onset.step / Math.max(1, totalSteps - 1);
    const target = low + contourAt(config.contour, t) * (high - low);

    let best = pool[0] as number;
    let bestScore = -Infinity;
    for (const pitch of pool) {
      // Shape.
      let score = -Math.abs(pitch - target) * 1.0;
      if (previous !== null) {
        const interval = Math.abs(pitch - previous);
        // Singability: steps are cheap, leaps are expensive, an octave leap
        // is very expensive.
        score -= interval * 0.8;
        if (interval > 12) score -= 20;
        // Resolution: after a leap, a step the other way is what the ear
        // expects, and giving it that is most of "sounds composed".
        if (Math.abs(lastInterval) > 4) {
          const opposite = Math.sign(pitch - previous) !== Math.sign(lastInterval);
          if (opposite && interval <= 2) score += 14;
          else if (opposite && interval <= 4) score += 6;
        }
        // Never repeat the same pitch twice in a row on strong beats — that
        // is a held note, not a melody.
        if (interval === 0 && strong) score -= 4;
        // Two leaps the same way in a row runs the line off the end of its
        // register and sounds like a mistake.
        if (Math.abs(lastInterval) > 4 && interval > 4
          && Math.sign(pitch - previous) === Math.sign(lastInterval)) score -= 8;
      }
      if (echo !== undefined && pitch === echo) score += 10 * repetition;
      // A little noise, so two riffs with the same constraints are not the
      // same riff.  Deterministic through the seed.
      score += (random() - 0.5) * 2.5;
      if (score > bestScore) { bestScore = score; best = pitch; }
    }

    // Chromatic approach: step into the next note from outside the scale.
    const chromaticism = Math.max(0, Math.min(1, config.chromaticism ?? 0));
    if (!strong && chromaticism > 0 && random() < chromaticism && previous !== null) {
      const direction = best >= previous ? -1 : 1;
      const approach = best + direction;
      if (approach >= low && approach <= high) best = approach;
    }

    if (previous !== null) lastInterval = best - previous;
    previous = best;
    played.set(onset.step, best);

    notes.push(createNote({
      pitch: best,
      startSec,
      durationSec,
      velocity: from7bit(Math.round(64 + onset.weight * 45)),
    }));
  });

  return config.style === 'arp' ? arpOrder(notes) : notes;
}

/** An arp runs the pool in order rather than following a contour. */
function arpOrder(notes: readonly MidiNote[]): MidiNote[] {
  const pitches = [...new Set(notes.map((n) => n.pitch))].sort((a, b) => a - b);
  if (pitches.length === 0) return [...notes];
  return notes.map((note, i) => ({ ...note, pitch: pitches[i % pitches.length] as number }));
}

// ── Variation ─────────────────────────────────────────────────────────────────

export type VariationKind = 'transpose' | 'invert' | 'retrograde' | 'displace' | 'thin' | 'densify';

export interface VaryOptions {
  kind: VariationKind;
  scale: Scale;
  /** Scale degrees for `transpose`. */
  degrees?: number;
  /** Seconds for `displace`. */
  shiftSec?: number;
  seed?: number;
  lowPitch?: number;
  highPitch?: number;
}

/**
 * Turn a riff into a related riff.
 *
 * Every variation stays in the scale, because a variation that leaves the key
 * is a different idea rather than a variation of this one.
 */
export function varyRiff(notes: readonly MidiNote[], options: VaryOptions): MidiNote[] {
  if (notes.length === 0) return [];
  const low = options.lowPitch ?? 0;
  const high = options.highPitch ?? 127;
  const inRange = (pitch: number): number => Math.max(low, Math.min(high, pitch));
  const snap = (pitch: number): number => snapPitchToScale(inRange(pitch), options.scale);
  const random = makeRng(options.seed ?? 1);

  switch (options.kind) {
    case 'transpose': {
      // Diatonic transposition: move by scale steps, not semitones, so the
      // shape survives and the key does too.
      const degrees = Math.round(options.degrees ?? 2);
      const allowed = [...scalePitchClasses(options.scale)].sort((a, b) => a - b);
      if (allowed.length === 0) return [...notes];
      return notes.map((n) => {
        let pitch = n.pitch;
        for (let i = 0; i < Math.abs(degrees); i++) {
          pitch = nextScalePitch(pitch, options.scale, degrees > 0 ? 1 : -1);
        }
        return { ...n, pitch: inRange(pitch) };
      });
    }
    case 'invert': {
      // Flip around the first note: every rise becomes a fall.
      const axis = notes[0]?.pitch ?? 60;
      return notes.map((n) => ({ ...n, pitch: snap(axis - (n.pitch - axis)) }));
    }
    case 'retrograde': {
      // Play the pitches backwards over the same rhythm — the rhythm is the
      // riff's identity, so reversing it too would make a different riff.
      const pitches = notes.map((n) => n.pitch).reverse();
      return notes.map((n, i) => ({ ...n, pitch: pitches[i] as number }));
    }
    case 'displace': {
      const shift = options.shiftSec ?? 0;
      return notes
        .map((n) => ({ ...n, startSec: Math.max(0, n.startSec + shift) }))
        .sort((a, b) => a.startSec - b.startSec);
    }
    case 'thin':
      // Drop weak notes, keep the frame.
      return notes.filter((n, i) => i === 0 || n.velocity > 0.62 || random() > 0.5);
    case 'densify':
      // Split long notes in two, the second an octave-safe neighbour.
      return notes.flatMap((n) => {
        if (n.durationSec < 0.12) return [n];
        const half = n.durationSec / 2;
        return [
          { ...n, durationSec: half },
          createNote({
            pitch: snap(nextScalePitch(n.pitch, options.scale, random() > 0.5 ? 1 : -1)),
            startSec: n.startSec + half,
            durationSec: half,
            velocity: n.velocity * 0.85,
          }),
        ];
      });
    default:
      return [...notes];
  }
}

/** The next pitch up or down that belongs to the scale. */
export function nextScalePitch(pitch: number, scale: Scale, direction: 1 | -1): number {
  const allowed = scalePitchClasses(scale);
  if (allowed.size === 0) return pitch + direction;
  for (let step = 1; step <= 12; step++) {
    const candidate = pitch + direction * step;
    if (allowed.has(pitchClass(candidate))) return candidate;
  }
  return pitch + direction;
}

// ── Reporting ─────────────────────────────────────────────────────────────────

const CONTOUR_LABELS: Record<Contour, string> = {
  rise: '상승', fall: '하강', arch: '아치', valley: '골짜기', wave: '물결', flat: '평탄',
};

const STYLE_LABELS: Record<RiffStyle, string> = {
  melody: '멜로디', bass: '베이스', chords: '코드', arp: '아르페지오',
};

export function describeRiff(options: Partial<RiffOptions>, noteCount: number): string {
  const config = { ...DEFAULT_RIFF, ...options };
  return `${STYLE_LABELS[config.style]} · ${config.bars}마디 · ${CONTOUR_LABELS[config.contour]}`
    + ` · 노트 ${noteCount}개 · 시드 ${config.seed}`
    + (config.chords.length > 0 ? ` · 코드 ${config.chords.length}개 참조` : ' · 스케일만');
}

export const CONTOURS: readonly Contour[] = ['rise', 'fall', 'arch', 'valley', 'wave', 'flat'];
export const RIFF_STYLES: readonly RiffStyle[] = ['melody', 'bass', 'chords', 'arp'];
export const VARIATIONS: readonly VariationKind[] =
  ['transpose', 'invert', 'retrograde', 'displace', 'thin', 'densify'];

export const contourLabel = (c: Contour): string => CONTOUR_LABELS[c];
export const styleLabel = (s: RiffStyle): string => STYLE_LABELS[s];
