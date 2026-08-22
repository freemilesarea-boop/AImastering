// Note tools — the FL Studio piano roll's fast moves.
//
// FL's piano roll is not better than Cubase's because it draws notes more
// prettily; it is better because a handful of operations turn one gesture into
// a bar of music.  Those operations are what is worth stealing, and every one
// of them is a pure function on MidiNote[].
//
//   Chord stamp   one click writes a voiced chord
//   Arpeggiate    a held chord becomes a run
//   Strum         a block chord gets played by a hand, not a machine
//   Slide         a note bends into the next one
//   Flam          one hit becomes a grace note plus a hit
//
// Slide deserves a note.  In FL it is a special note type; here it does not
// need to be, because the MIDI 2.0 model already carries PER-NOTE pitch bend.
// A slide is a pitch-bend curve on the target note, which means it survives
// export, works per-note in a chord, and needs no special case in the player.

import { createNote, noteEndBeat, soundingPitch, type MidiNote, type NoteExpression } from '../model/midi.js';
import { voiceChord, type ChordSymbol } from '../model/chords.js';
import { isInScale, snapPitchToScale, type Scale } from '../model/scales.js';
import { makeRng, MIN_NOTE_BEATS } from './midi-edit.js';

// ── Chord stamp ───────────────────────────────────────────────────────────────

export interface StampOptions {
  /** Part-relative beat the chord lands on. */
  startBeat: number;
  /** Length of every voice, in beats. */
  durationBeat: number;
  /** Lowest pitch of the voicing. */
  bottomPitch?: number;
  velocity?: number;
  /** Spread the top voices up an octave — a fifth-and-up open voicing. */
  open?: boolean;
}

/** Write a chord as notes.  The voicing comes from the chord model. */
export function stampChord(chord: ChordSymbol, options: StampOptions): MidiNote[] {
  const pitches = voiceChord(chord, options.bottomPitch ?? 48);
  const spread = options.open
    // Open voicing: drop the second voice an octave and lift the top one.
    ? pitches.map((p, i) => (i === 1 ? p - 12 : i === pitches.length - 1 ? p + 12 : p))
    : pitches;
  return spread
    .slice()
    .sort((a, b) => a - b)
    .map((pitch) => createNote({
      pitch,
      startBeat: options.startBeat,
      durationBeat: options.durationBeat,
      ...(options.velocity === undefined ? {} : { velocity: options.velocity }),
    }));
}

// ── Arpeggiate ────────────────────────────────────────────────────────────────

export type ArpDirection = 'up' | 'down' | 'updown' | 'random' | 'chord';

export interface ArpOptions {
  direction?: ArpDirection;
  /** Length of one arp step, in beats (0.25 = a sixteenth). */
  rateBeat: number;
  /** Fraction of the step each note sounds for. */
  gate?: number;
  /** Extra octaves stacked above the chord. */
  octaves?: number;
  /** Seed for `random`, so a bounce reproduces the take you approved. */
  seed?: number;
}

/**
 * Turn simultaneous notes into a run.
 *
 * Only notes that OVERLAP are treated as one chord — a melody passed through
 * the arpeggiator should come out as a melody, not as garbage.
 */
export function arpeggiate(notes: readonly MidiNote[], options: ArpOptions): MidiNote[] {
  const direction = options.direction ?? 'up';
  const rate = Math.max(MIN_NOTE_BEATS, options.rateBeat);
  const gate = Math.max(0.05, Math.min(1, options.gate ?? 0.9));
  const octaves = Math.max(1, Math.round(options.octaves ?? 1));
  const random = makeRng(options.seed ?? 1);

  const out: MidiNote[] = [];
  for (const group of chordGroups(notes)) {
    const start = Math.min(...group.map((n) => n.startBeat));
    const end = Math.max(...group.map(noteEndBeat));
    const base = [...group].sort((a, b) => soundingPitch(a) - soundingPitch(b));

    const ladder: MidiNote[] = [];
    for (let o = 0; o < octaves; o++) {
      for (const note of base) ladder.push({ ...note, pitch: note.pitch + o * 12 });
    }
    const order = orderFor(ladder, direction, random);
    if (order.length === 0) continue;

    let time = start;
    let index = 0;
    while (time < end - 1e-6) {
      const source = order[index % order.length] as MidiNote;
      out.push(createNote({
        pitch: source.pitch,
        pitchOffsetSemitones: source.pitchOffsetSemitones,
        // The last step is trimmed to the chord's end rather than overhanging.
        startBeat: time,
        durationBeat: Math.min(rate * gate, end - time),
        velocity: source.velocity,
        channel: source.channel,
      }));
      time += rate;
      index++;
    }
  }
  return out.sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch);
}

function orderFor(
  ladder: readonly MidiNote[], direction: ArpDirection, random: () => number,
): MidiNote[] {
  switch (direction) {
    case 'down': return [...ladder].reverse();
    case 'updown': {
      // The turning notes are not repeated — that is what makes it sound like
      // a run and not a stutter.
      const down = [...ladder].reverse().slice(1, Math.max(1, ladder.length - 1));
      return [...ladder, ...down];
    }
    case 'random': {
      const shuffled = [...ladder];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        const a = shuffled[i] as MidiNote;
        shuffled[i] = shuffled[j] as MidiNote;
        shuffled[j] = a;
      }
      return shuffled;
    }
    case 'chord': return ladder.length > 0 ? [ladder[0] as MidiNote] : [];
    case 'up':
    default: return [...ladder];
  }
}

/** Notes that sound together, as groups.  A melody yields groups of one. */
export function chordGroups(notes: readonly MidiNote[]): MidiNote[][] {
  const sorted = [...notes].sort((a, b) => a.startBeat - b.startBeat);
  const groups: MidiNote[][] = [];
  for (const note of sorted) {
    const group = groups[groups.length - 1];
    // Same onset within a hair, or genuinely overlapping in time.
    if (group && note.startBeat < Math.max(...group.map(noteEndBeat)) - 1e-6) group.push(note);
    else groups.push([note]);
  }
  return groups;
}

// ── Strum ─────────────────────────────────────────────────────────────────────

export interface StrumOptions {
  /**
   * Delay between adjacent voices, in BEATS.
   *
   * A strum is a physical gesture — roughly 20 ms of hand travel, not a
   * musical subdivision — so the caller converts it through the part clock
   * (`secToBeatsAt`) rather than this module guessing a tempo.
   */
  spreadBeat: number;
  direction?: 'up' | 'down';
  /** Later voices come in this much quieter, 0…1. */
  velocityFalloff?: number;
  /** Keep every note ending together, like a real strum. */
  alignEnds?: boolean;
}

/**
 * Offset a block chord so a hand played it.  The ends stay together by
 * default: a guitarist's fingers land one after another but the chord rings
 * out as one, and shortening every note by its own offset is what makes a
 * strummed chord sound clipped instead of played.
 */
export function strum(notes: readonly MidiNote[], options: StrumOptions): MidiNote[] {
  const spread = Math.max(0, options.spreadBeat);
  const direction = options.direction ?? 'up';
  const falloff = Math.max(0, Math.min(1, options.velocityFalloff ?? 0.15));
  const alignEnds = options.alignEnds ?? true;

  const out: MidiNote[] = [];
  for (const group of chordGroups(notes)) {
    if (group.length < 2) { out.push(...group); continue; }
    const ordered = [...group].sort((a, b) =>
      (direction === 'up' ? 1 : -1) * (soundingPitch(a) - soundingPitch(b)));
    const end = Math.max(...group.map(noteEndBeat));

    ordered.forEach((note, i) => {
      const offset = i * spread;
      const startBeat = note.startBeat + offset;
      out.push({
        ...note,
        startBeat,
        durationBeat: alignEnds ? Math.max(MIN_NOTE_BEATS, end - startBeat) : note.durationBeat,
        velocity: Math.max(0.01, note.velocity * (1 - falloff * (i / Math.max(1, ordered.length - 1)))),
      });
    });
  }
  return out.sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch);
}

// ── Slide ─────────────────────────────────────────────────────────────────────

export interface SlideOptions {
  /** How long the bend takes, as a fraction of the target note. */
  timeFraction?: number;
  /** Pitch-bend range the instrument is set to, semitones. */
  bendRangeSemitones?: number;
  /** Largest interval that will be slid; wider jumps are left alone. */
  maxIntervalSemitones?: number;
}

/**
 * Bend each note up from the one before it.
 *
 * The bend is written as a per-note pitch-bend curve, so it is real expression
 * data rather than a flag the player has to interpret.  Intervals wider than
 * `maxIntervalSemitones` are skipped — a slide across an octave is a portamento
 * effect, not a legato, and doing it by accident sounds like a fault.
 */
export function applySlides(
  notes: readonly MidiNote[], options: SlideOptions = {},
): MidiNote[] {
  const fraction = Math.max(0.01, Math.min(1, options.timeFraction ?? 0.25));
  const range = Math.max(1, options.bendRangeSemitones ?? 2);
  const maxInterval = options.maxIntervalSemitones ?? 7;

  const sorted = [...notes].sort((a, b) => a.startBeat - b.startBeat);
  return sorted.map((note, i) => {
    const previous = sorted[i - 1];
    if (!previous) return note;
    const interval = soundingPitch(previous) - soundingPitch(note);
    if (interval === 0 || Math.abs(interval) > maxInterval) return note;
    // Normalised bend: −1…+1 maps to ∓ the instrument's range.
    const from = Math.max(-1, Math.min(1, interval / range));
    const expression: NoteExpression = {
      target: { kind: 'pitchBend' },
      points: [
        { timeBeat: 0, value: from },
        { timeBeat: note.durationBeat * fraction, value: 0 },
      ],
    };
    return {
      ...note,
      expression: [
        ...note.expression.filter((e) => e.target.kind !== 'pitchBend'),
        expression,
      ],
    };
  });
}

/** Remove slide curves again. */
export function clearSlides(notes: readonly MidiNote[]): MidiNote[] {
  return notes.map((n) => (n.expression.some((e) => e.target.kind === 'pitchBend')
    ? { ...n, expression: n.expression.filter((e) => e.target.kind !== 'pitchBend') }
    : n));
}

// ── Flam ──────────────────────────────────────────────────────────────────────

export interface FlamOptions {
  /** Gap between the grace note and the hit, in beats (a physical ~30 ms). */
  spacingBeat?: number;
  /** Grace-note level relative to the hit. */
  graceVelocity?: number;
  /** Hits per flam, including the main one. */
  count?: number;
}

/** One hit becomes a grace note plus the hit — a roll, without drawing it. */
export function flam(notes: readonly MidiNote[], options: FlamOptions = {}): MidiNote[] {
  const spacing = Math.max(MIN_NOTE_BEATS / 4, options.spacingBeat ?? MIN_NOTE_BEATS * 2);
  const grace = Math.max(0.05, Math.min(1, options.graceVelocity ?? 0.55));
  const count = Math.max(2, Math.round(options.count ?? 2));

  const out: MidiNote[] = [];
  for (const note of notes) {
    for (let i = count - 1; i >= 1; i--) {
      const startBeat = note.startBeat - i * spacing;
      if (startBeat < 0) continue;
      out.push(createNote({
        pitch: note.pitch,
        startBeat,
        durationBeat: Math.min(spacing * 0.9, note.durationBeat),
        velocity: note.velocity * grace,
        channel: note.channel,
      }));
    }
    out.push(note);
  }
  return out.sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch);
}

// ── Scale snap ────────────────────────────────────────────────────────────────

/** Pull every note onto the scale — FL's "scale highlighting", made to act. */
export function snapToScale(notes: readonly MidiNote[], scale: Scale): MidiNote[] {
  return notes.map((n) => (isInScale(n.pitch, scale)
    ? n
    : { ...n, pitch: snapPitchToScale(n.pitch, scale) }));
}
