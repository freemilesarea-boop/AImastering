// MIDI note editing — every verb the Key Editor's inspector exposes.
//
// All pure `(notes, options) → notes`, so they are unit-testable exactly and
// reusable from the keyboard, the mouse and (later) an AI action without a
// second implementation.
//
// Everything here is in BEATS, note-relative — the domain notes are stored
// in.  A quantize grid of 0.25 is a sixteenth at every tempo, and none of
// these verbs needs a tempo map to do its job.
//
// Randomised operations (Humanize, quantize randomise) take a SEED and use a
// deterministic generator: an offline bounce has to reproduce exactly what
// you heard, and `Math.random()` would make every render different.

import {
  createNote, noteEndBeat, sortNotes, clamp01, type MidiNote,
} from '../model/midi.js';
import { snapPitchToScale, type Scale } from '../model/scales.js';

const EPS = 1e-9;

/**
 * Shortest a note may be shrunk to: a 128th note.
 *
 * A musical floor, not a millisecond one — the old 10 ms floor meant a
 * note's minimum length changed meaning with the tempo.
 */
export const MIN_NOTE_BEATS = 1 / 32;

// ── Deterministic randomness ──────────────────────────────────────────────────

/** Mulberry32 — small, fast, good enough, and identical on every machine. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** −1…+1 */
const bipolarRandom = (rng: () => number): number => rng() * 2 - 1;

// ── Basic edits ───────────────────────────────────────────────────────────────

export function addNote(notes: readonly MidiNote[], note: Partial<MidiNote>): MidiNote[] {
  return sortNotes([...notes, createNote(note)]);
}

export function deleteNotes(notes: readonly MidiNote[], ids: ReadonlySet<string>): MidiNote[] {
  return notes.filter((n) => !ids.has(n.id));
}

/** Apply `fn` to the selected notes, preserving array identity when idle. */
export function mapSelected(
  notes: readonly MidiNote[], ids: ReadonlySet<string>, fn: (n: MidiNote) => MidiNote,
): MidiNote[] {
  let changed = false;
  const next = notes.map((n) => {
    if (!ids.has(n.id)) return n;
    const updated = fn(n);
    if (updated !== n) changed = true;
    return updated;
  });
  return changed ? next : (notes as MidiNote[]);
}

export interface MoveOptions {
  deltaBeat?: number;
  deltaPitch?: number;
  /** Grid in beats to snap the resulting start to (0 = free). */
  gridBeat?: number;
  /** Constrain the result into a scale (Snap Pitch Editing). */
  scale?: Scale | null;
}

export function moveNotes(
  notes: readonly MidiNote[], ids: ReadonlySet<string>, options: MoveOptions,
): MidiNote[] {
  const { deltaBeat = 0, deltaPitch = 0, gridBeat = 0, scale = null } = options;
  return sortNotes(mapSelected(notes, ids, (n) => {
    let start = Math.max(0, n.startBeat + deltaBeat);
    if (gridBeat > 0) start = Math.max(0, Math.round(start / gridBeat) * gridBeat);
    let pitch = Math.min(127, Math.max(0, n.pitch + deltaPitch));
    if (scale) pitch = snapPitchToScale(pitch, scale);
    return { ...n, startBeat: start, pitch };
  }));
}

/** Drag the right edge.  `minBeat` keeps a note from collapsing to nothing. */
export function resizeNotes(
  notes: readonly MidiNote[], ids: ReadonlySet<string>, deltaBeat: number, minBeat = MIN_NOTE_BEATS,
): MidiNote[] {
  return mapSelected(notes, ids, (n) => ({
    ...n, durationBeat: Math.max(minBeat, n.durationBeat + deltaBeat),
  }));
}

export function setVelocity(
  notes: readonly MidiNote[], ids: ReadonlySet<string>, velocity: number,
): MidiNote[] {
  return mapSelected(notes, ids, (n) => ({ ...n, velocity: clamp01(velocity) }));
}

export function nudgeVelocity(
  notes: readonly MidiNote[], ids: ReadonlySet<string>, delta: number,
): MidiNote[] {
  return mapSelected(notes, ids, (n) => ({ ...n, velocity: clamp01(n.velocity + delta) }));
}

/**
 * Compress or expand velocities around their own mean.
 * `amount` 0 = flatten to the mean, 1 = unchanged, >1 = exaggerate.
 */
export function scaleVelocityRange(
  notes: readonly MidiNote[], ids: ReadonlySet<string>, amount: number,
): MidiNote[] {
  const selected = notes.filter((n) => ids.has(n.id));
  if (selected.length === 0) return notes as MidiNote[];
  const mean = selected.reduce((sum, n) => sum + n.velocity, 0) / selected.length;
  return mapSelected(notes, ids, (n) => ({
    ...n, velocity: clamp01(mean + (n.velocity - mean) * amount),
  }));
}

/** Linear velocity ramp across the selection, in time order. */
export function velocityRamp(
  notes: readonly MidiNote[], ids: ReadonlySet<string>, fromVelocity: number, toVelocity: number,
): MidiNote[] {
  const selected = sortNotes(notes.filter((n) => ids.has(n.id)));
  if (selected.length === 0) return notes as MidiNote[];
  const position = new Map<string, number>();
  selected.forEach((n, i) => position.set(n.id, selected.length === 1 ? 0 : i / (selected.length - 1)));
  return mapSelected(notes, ids, (n) => ({
    ...n,
    velocity: clamp01(fromVelocity + (toVelocity - fromVelocity) * (position.get(n.id) ?? 0)),
  }));
}

// ── Transpose ─────────────────────────────────────────────────────────────────

export interface TransposeOptions {
  semitones: number;
  /** Pull the result back into a scale (Cubase's "Scale Correction"). */
  scale?: Scale | null;
  /** Fold notes back inside a register instead of letting them run away. */
  keepInRange?: { lowest: number; highest: number } | null;
}

export function transposeNotes(
  notes: readonly MidiNote[], ids: ReadonlySet<string>, options: TransposeOptions,
): MidiNote[] {
  const { semitones, scale = null, keepInRange = null } = options;
  return mapSelected(notes, ids, (n) => {
    let pitch = n.pitch + semitones;
    if (scale) pitch = snapPitchToScale(pitch, scale);
    if (keepInRange) {
      while (pitch > keepInRange.highest) pitch -= 12;
      while (pitch < keepInRange.lowest) pitch += 12;
    }
    return { ...n, pitch: Math.min(127, Math.max(0, pitch)) };
  });
}

/** Force every selected note into the scale without moving it in time. */
export function quantizePitches(
  notes: readonly MidiNote[], ids: ReadonlySet<string>, scale: Scale,
): MidiNote[] {
  return mapSelected(notes, ids, (n) => {
    const pitch = snapPitchToScale(n.pitch, scale);
    return pitch === n.pitch ? n : { ...n, pitch };
  });
}

// ── Quantize ──────────────────────────────────────────────────────────────────

export interface QuantizeOptions {
  /** Base grid in BEATS (a 1/16 note = 0.25). */
  gridBeat: number;
  /** 3 = triplets, 5 = quintuplets… 0/1 = straight. */
  tuplet?: number;
  /** 0…100 — pushes every second grid line later. */
  swingPercent?: number;
  /** 0…100 — how far toward the grid a note travels (Soft Quantize). */
  strengthPercent?: number;
  /**
   * Notes further than this from a grid line are left alone (Catch Range).
   * 0 = catch everything.
   */
  catchRangeBeat?: number;
  /** Notes already this close (beats) to the grid are left alone (Safe Range). */
  safeRangeBeat?: number;
  /** Deterministic humanising spread applied after quantising. */
  randomizeBeat?: number;
  seed?: number;
  /** Also snap the note ENDS (Quantize Ends). */
  quantizeEnds?: boolean;
  /** Snap the LENGTHS to the grid (Quantize Lengths). */
  quantizeLengths?: boolean;
}

/** The grid line nearest `time`, honouring tuplets and swing. */
export function nearestGridTime(time: number, options: QuantizeOptions): number {
  const tuplet = options.tuplet && options.tuplet > 1 ? options.tuplet : 1;
  const step = options.gridBeat / (tuplet === 1 ? 1 : tuplet / 2);
  if (step <= 0) return time;

  const swing = (options.swingPercent ?? 0) / 100;
  const index = Math.round(time / step);
  const candidates = [index - 1, index, index + 1].map((i) => {
    // Swing delays every odd grid line by a fraction of the step.
    const offset = swing !== 0 && Math.abs(i % 2) === 1 ? step * swing * 0.5 : 0;
    return i * step + offset;
  });
  let best = candidates[0] ?? time;
  for (const c of candidates) if (Math.abs(c - time) < Math.abs(best - time)) best = c;
  return Math.max(0, best);
}

export function quantizeNotes(
  notes: readonly MidiNote[], ids: ReadonlySet<string>, options: QuantizeOptions,
): MidiNote[] {
  const strength = (options.strengthPercent ?? 100) / 100;
  const catchRange = options.catchRangeBeat ?? 0;
  const safeRange = options.safeRangeBeat ?? 0;
  const rng = makeRng(options.seed ?? 1);
  const randomize = options.randomizeBeat ?? 0;

  return sortNotes(mapSelected(notes, ids, (n) => {
    const target = nearestGridTime(n.startBeat, options);
    const distance = Math.abs(target - n.startBeat);

    let start = n.startBeat;
    const outsideCatch = catchRange > 0 && distance > catchRange;
    const insideSafe = safeRange > 0 && distance <= safeRange;
    if (!outsideCatch && !insideSafe) {
      start = n.startBeat + (target - n.startBeat) * strength;
    }
    if (randomize > 0) start += bipolarRandom(rng) * randomize;
    start = Math.max(0, start);

    let duration = n.durationBeat;
    if (options.quantizeLengths) {
      const step = options.gridBeat;
      duration = Math.max(step, Math.round(duration / step) * step);
    } else if (options.quantizeEnds) {
      const end = nearestGridTime(start + duration, options);
      duration = Math.max(MIN_NOTE_BEATS, end - start);
    }

    return start === n.startBeat && duration === n.durationBeat
      ? n
      : { ...n, startBeat: start, durationBeat: duration };
  }));
}

// ── Humanize ──────────────────────────────────────────────────────────────────

export interface HumanizeOptions {
  /** Maximum timing displacement, in beats. */
  timingBeat?: number;
  /** Maximum velocity displacement, normalised (0.08 ≈ 10 of 127). */
  velocity?: number;
  /** Maximum length displacement, as a fraction of each note's length. */
  lengthPercent?: number;
  /**
   * Push notes that land on strong beats slightly earlier and weak ones
   * later — the "playing ahead of the beat" feel, not just noise.
   */
  grooveBeat?: number;
  /** Grid in beats used to decide what a strong beat is. */
  gridBeat?: number;
  seed?: number;
}

/**
 * Humanize — deterministic, musical jitter.
 *
 * Pure white noise on timing sounds broken rather than human, so the groove
 * term biases on-beat notes early and off-beat notes late; the random term
 * then adds the individual variation on top.
 */
export function humanizeNotes(
  notes: readonly MidiNote[], ids: ReadonlySet<string>, options: HumanizeOptions = {},
): MidiNote[] {
  const {
    timingBeat = 0.012, velocity = 0.06, lengthPercent = 0,
    grooveBeat = 0, gridBeat = 0, seed = 1,
  } = options;
  const rng = makeRng(seed);

  return sortNotes(mapSelected(notes, ids, (n) => {
    let start = n.startBeat + bipolarRandom(rng) * timingBeat;
    if (grooveBeat !== 0 && gridBeat > 0) {
      const beatIndex = Math.round(n.startBeat / gridBeat);
      const onStrongBeat = beatIndex % 2 === 0;
      start += onStrongBeat ? -grooveBeat : grooveBeat;
    }
    const nextVelocity = clamp01(n.velocity + bipolarRandom(rng) * velocity);
    const duration = lengthPercent > 0
      ? Math.max(MIN_NOTE_BEATS, n.durationBeat * (1 + bipolarRandom(rng) * lengthPercent))
      : n.durationBeat;
    return { ...n, startBeat: Math.max(0, start), velocity: nextVelocity, durationBeat: duration };
  }));
}

// ── Length operations ─────────────────────────────────────────────────────────

/**
 * Legato: stretch each note until the next one on the same "voice".
 * `overlapBeat` can be negative to leave a gap (Cubase's Overlap in ticks).
 */
export function applyLegato(
  notes: readonly MidiNote[], ids: ReadonlySet<string>, overlapBeat = 0,
): MidiNote[] {
  const ordered = sortNotes(notes);
  const result = ordered.map((n) => {
    if (!ids.has(n.id)) return n;
    const next = ordered.find((m) => m.id !== n.id && m.startBeat > n.startBeat + EPS);
    if (!next) return n;
    const duration = Math.max(MIN_NOTE_BEATS, next.startBeat - n.startBeat + overlapBeat);
    return duration === n.durationBeat ? n : { ...n, durationBeat: duration };
  });
  return result;
}

/**
 * Scale Legato — the same idea as a percentage, so notes keep some of their
 * own phrasing: 0 % leaves lengths alone, 100 % is full legato.
 */
export function scaleLegato(
  notes: readonly MidiNote[], ids: ReadonlySet<string>, percent: number, overlapBeat = 0,
): MidiNote[] {
  const amount = Math.max(0, Math.min(1, percent / 100));
  if (amount === 0) return notes as MidiNote[];
  const legato = applyLegato(notes, ids, overlapBeat);
  const byId = new Map(legato.map((n) => [n.id, n] as const));
  return mapSelected(notes, ids, (n) => {
    const target = byId.get(n.id);
    if (!target) return n;
    const duration = n.durationBeat + (target.durationBeat - n.durationBeat) * amount;
    return { ...n, durationBeat: Math.max(MIN_NOTE_BEATS, duration) };
  });
}

export function fixedLengths(
  notes: readonly MidiNote[], ids: ReadonlySet<string>, lengthBeat: number,
): MidiNote[] {
  return mapSelected(notes, ids, (n) => ({ ...n, durationBeat: Math.max(MIN_NOTE_BEATS, lengthBeat) }));
}

/**
 * Extend to Next Selected — stretch each selected note to the start of the
 * next SELECTED note, ignoring everything in between.
 */
export function extendToNextSelected(
  notes: readonly MidiNote[], ids: ReadonlySet<string>,
): MidiNote[] {
  const selected = sortNotes(notes.filter((n) => ids.has(n.id)));
  const nextStart = new Map<string, number>();
  selected.forEach((n, i) => {
    const next = selected[i + 1];
    if (next) nextStart.set(n.id, next.startBeat);
  });
  return mapSelected(notes, ids, (n) => {
    const end = nextStart.get(n.id);
    if (end === undefined) return n;
    return { ...n, durationBeat: Math.max(MIN_NOTE_BEATS, end - n.startBeat) };
  });
}

/**
 * Delete Overlaps (mono): no two notes may sound at once — each note is cut
 * where the next one starts, whatever its pitch.
 */
export function deleteOverlapsMono(notes: readonly MidiNote[]): MidiNote[] {
  const ordered = sortNotes(notes);
  return ordered.map((n, i) => {
    const next = ordered[i + 1];
    if (!next) return n;
    if (noteEndBeat(n) <= next.startBeat + EPS) return n;
    return { ...n, durationBeat: Math.max(MIN_NOTE_BEATS, next.startBeat - n.startBeat) };
  });
}

/**
 * Delete Overlaps (poly): only notes of the SAME pitch are trimmed, so chords
 * survive but a repeated note never re-triggers over itself.
 */
export function deleteOverlapsPoly(notes: readonly MidiNote[]): MidiNote[] {
  const ordered = sortNotes(notes);
  return ordered.map((n, i) => {
    const next = ordered.slice(i + 1).find((m) => m.pitch === n.pitch);
    if (!next) return n;
    if (noteEndBeat(n) <= next.startBeat + EPS) return n;
    return { ...n, durationBeat: Math.max(MIN_NOTE_BEATS, next.startBeat - n.startBeat) };
  });
}

/** Sustain-pedal (CC64) spans stretched into note lengths. */
export function pedalsToNoteLength(
  notes: readonly MidiNote[], pedalSpans: ReadonlyArray<{ startBeat: number; endBeat: number }>,
): MidiNote[] {
  if (pedalSpans.length === 0) return notes as MidiNote[];
  return notes.map((n) => {
    const span = pedalSpans.find((p) => n.startBeat >= p.startBeat - EPS && n.startBeat < p.endBeat);
    if (!span) return n;
    const duration = Math.max(n.durationBeat, span.endBeat - n.startBeat);
    return duration === n.durationBeat ? n : { ...n, durationBeat: duration };
  });
}

// ── Split / glue ──────────────────────────────────────────────────────────────

export function splitNotesAt(notes: readonly MidiNote[], atBeat: number): MidiNote[] {
  const out: MidiNote[] = [];
  for (const n of notes) {
    if (atBeat > n.startBeat + EPS && atBeat < noteEndBeat(n) - EPS) {
      const headLength = atBeat - n.startBeat;
      out.push({ ...n, id: createNote().id, durationBeat: headLength });
      out.push({
        ...n,
        id: createNote().id,
        startBeat: atBeat,
        durationBeat: n.durationBeat - headLength,
        // The tail continues the phrase, so it starts from the head's release.
        velocity: n.velocity,
      });
    } else {
      out.push(n);
    }
  }
  return sortNotes(out);
}

/** Glue every selected note of the same pitch into one long note. */
export function glueNotes(notes: readonly MidiNote[], ids: ReadonlySet<string>): MidiNote[] {
  const selected = sortNotes(notes.filter((n) => ids.has(n.id)));
  if (selected.length < 2) return notes as MidiNote[];

  const byPitch = new Map<number, MidiNote[]>();
  for (const n of selected) {
    const list = byPitch.get(n.pitch) ?? [];
    list.push(n);
    byPitch.set(n.pitch, list);
  }

  const removed = new Set<string>();
  const merged: MidiNote[] = [];
  for (const [, list] of byPitch) {
    if (list.length < 2) continue;
    const first = list[0];
    const last = list[list.length - 1];
    if (!first || !last) continue;
    for (const n of list) removed.add(n.id);
    merged.push({ ...first, durationBeat: Math.max(MIN_NOTE_BEATS, noteEndBeat(last) - first.startBeat) });
  }
  if (merged.length === 0) return notes as MidiNote[];
  return sortNotes([...notes.filter((n) => !removed.has(n.id)), ...merged]);
}

// ── Queries ───────────────────────────────────────────────────────────────────

/** Notes sounding at a moment — feeds the Current Chord Display. */
export function notesAt(notes: readonly MidiNote[], atBeat: number): MidiNote[] {
  return notes.filter((n) => !n.muted && atBeat >= n.startBeat - EPS && atBeat < noteEndBeat(n));
}

/** Pitch and time bounds of a set of notes, for zoom-to-fit. */
export function noteBounds(notes: readonly MidiNote[]): {
  startBeat: number; endBeat: number; lowPitch: number; highPitch: number;
} | null {
  if (notes.length === 0) return null;
  let startBeat = Infinity;
  let endBeat = -Infinity;
  let lowPitch = 127;
  let highPitch = 0;
  for (const n of notes) {
    startBeat = Math.min(startBeat, n.startBeat);
    endBeat = Math.max(endBeat, noteEndBeat(n));
    lowPitch = Math.min(lowPitch, n.pitch);
    highPitch = Math.max(highPitch, n.pitch);
  }
  return { startBeat, endBeat, lowPitch, highPitch };
}
