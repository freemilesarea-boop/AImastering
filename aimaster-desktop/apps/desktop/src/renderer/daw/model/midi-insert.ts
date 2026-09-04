// midi-insert.ts — what happens to the notes BEFORE the instrument hears them.
//
// `arpeggiate`, `stampChord` and the rest already existed as OFFLINE edits:
// you select some notes, press a button, and the notes in the part change.
// That is a different thing from an insert, and the difference is the whole
// feature — an insert leaves the part alone and transforms what reaches the
// instrument, so you hold three keys and hear an arpeggio, and the part still
// says "three notes".
//
// Which matters for three reasons.  You can change your mind: the chord is
// still a chord, so the arp rate is a knob rather than an undo.  You can play
// it: an offline edit cannot make a live keyboard arpeggiate.  And the part
// stays readable: an arpeggiated bar is 32 notes in the editor if it was
// baked, and four if it was not.
//
// The rule the whole file exists to keep is that ONE chain serves both paths.
// A live arpeggiator that does not agree with the rendered one is worse than
// no arpeggiator, because you record a take that sounds different on playback
// and there is nothing to point at.  So everything here is a pure function
// over notes, the live side feeds it the keys currently held, and playback
// feeds it the part.

import { arpeggiate, chordGroups, type ArpDirection } from '../edit/note-tools.js';
import { MIN_NOTE_BEATS } from '../edit/midi-edit.js';
import {
  clamp01, createNote, from7bit, noteEndBeat, sortNotes, to7bit, type MidiNote,
} from './midi.js';

export type MidiInsertKind =
  | 'transpose' | 'velocity' | 'range' | 'chorder' | 'arpeggiator' | 'echo';

export const INSERT_LABELS: Record<MidiInsertKind, string> = {
  transpose:   '트랜스포즈',
  velocity:    '벨로시티',
  range:       '음역 제한',
  chorder:     '코더',
  arpeggiator: '아르페지에이터',
  echo:        '노트 에코',
};

export interface TransposeInsert {
  kind: 'transpose';
  semitones: number;
}

export interface VelocityInsert {
  kind: 'velocity';
  /** Multiplied first, then offset — so 0.5/+20 compresses toward the top. */
  scale: number;
  /** In 7-bit units, the way everything outside the model counts velocity. */
  offset: number;
  /** When set, every note plays at this velocity and scale/offset are ignored. */
  fixed?: number;
}

export interface RangeInsert {
  kind: 'range';
  lowPitch: number;
  highPitch: number;
  /**
   * `drop` silences what is outside; `fold` transposes it in by octaves.
   *
   * Fold is the one that keeps a part playable on a small keyboard; drop is
   * the one that splits a keyboard between two instruments.
   */
  mode: 'drop' | 'fold';
}

export interface ChorderInsert {
  kind: 'chorder';
  /** Semitone offsets from the played note.  `0` keeps the original. */
  intervals: number[];
  /** Velocity multiplier applied to every added note but not to the original. */
  addedLevel?: number;
}

export interface ArpeggiatorInsert {
  kind: 'arpeggiator';
  direction: ArpDirection;
  /** One step, in beats.  0.25 is a sixteenth. */
  rateBeat: number;
  /** Fraction of a step each note sounds for. */
  gate: number;
  octaves: number;
  seed?: number;
}

export interface EchoInsert {
  kind: 'echo';
  /** Gap between repeats, in beats. */
  delayBeat: number;
  repeats: number;
  /** Each repeat is this much of the one before it. */
  feedback: number;
  /** Semitones added per repeat — 0 for a plain echo, 12 for a rising one. */
  pitchStep: number;
}

export type MidiInsertConfig =
  | TransposeInsert | VelocityInsert | RangeInsert
  | ChorderInsert | ArpeggiatorInsert | EchoInsert;

export type MidiInsert = MidiInsertConfig & {
  id: string;
  /** Off keeps the insert and its settings but takes it out of the chain. */
  bypass?: boolean;
};

export const MAX_MIDI_INSERTS = 8;

/**
 * How many notes one chain may produce from one.
 *
 * A chorder into an arpeggiator into an echo multiplies, and three settings
 * that each look reasonable can ask for tens of thousands of notes from a
 * held chord.  The ceiling is a refusal to melt the audio thread, not a
 * musical opinion — and it is reported rather than silently applied.
 */
export const MAX_INSERT_NOTES = 4000;

export function defaultInsert(kind: MidiInsertKind, id: string): MidiInsert {
  switch (kind) {
    case 'transpose':   return { id, kind, semitones: 12 };
    case 'velocity':    return { id, kind, scale: 1, offset: 0 };
    case 'range':       return { id, kind, lowPitch: 36, highPitch: 96, mode: 'fold' };
    case 'chorder':     return { id, kind, intervals: [0, 4, 7], addedLevel: 0.85 };
    case 'arpeggiator': return { id, kind, direction: 'up', rateBeat: 0.25, gate: 0.9, octaves: 1 };
    case 'echo':        return { id, kind, delayBeat: 0.25, repeats: 3, feedback: 0.6, pitchStep: 0 };
  }
}

// ── The individual inserts ──────────────────────────────────────────────────

function clampPitch(pitch: number): number {
  return Math.max(0, Math.min(127, Math.round(pitch)));
}

function applyTranspose(notes: readonly MidiNote[], insert: TransposeInsert): MidiNote[] {
  const by = Math.round(insert.semitones);
  if (by === 0) return [...notes];
  // A note pushed off the end of the keyboard is DROPPED, not clamped.  A
  // clamp would pile a run onto pitch 127 and sound like a broken instrument;
  // dropping it sounds like the note is out of range, which it is.
  const out: MidiNote[] = [];
  for (const note of notes) {
    const pitch = note.pitch + by;
    if (pitch < 0 || pitch > 127) continue;
    out.push({ ...note, pitch });
  }
  return out;
}

function applyVelocity(notes: readonly MidiNote[], insert: VelocityInsert): MidiNote[] {
  return notes.map((note) => {
    if (insert.fixed !== undefined) {
      return { ...note, velocity: from7bit(Math.max(1, Math.min(127, insert.fixed))) };
    }
    const seven = to7bit(note.velocity) * insert.scale + insert.offset;
    // Velocity 0 is a note-off in MIDI, so the floor is 1 — an insert must
    // not turn a note into a message that stops one.
    return { ...note, velocity: from7bit(Math.max(1, Math.min(127, Math.round(seven)))) };
  });
}

function applyRange(notes: readonly MidiNote[], insert: RangeInsert): MidiNote[] {
  const low = clampPitch(Math.min(insert.lowPitch, insert.highPitch));
  const high = clampPitch(Math.max(insert.lowPitch, insert.highPitch));
  const out: MidiNote[] = [];
  for (const note of notes) {
    if (note.pitch >= low && note.pitch <= high) { out.push(note); continue; }
    if (insert.mode === 'drop') continue;
    // Fold by OCTAVES so the note keeps its name.  Folding by semitones would
    // change the harmony, which is not what "keep it on the keyboard" means.
    let pitch = note.pitch;
    while (pitch < low) pitch += 12;
    while (pitch > high) pitch -= 12;
    // A range narrower than an octave cannot hold every note; the ones that
    // do not fit are dropped rather than left outside it.
    if (pitch < low || pitch > high) continue;
    out.push({ ...note, pitch });
  }
  return out;
}

function applyChorder(notes: readonly MidiNote[], insert: ChorderInsert): MidiNote[] {
  const intervals = insert.intervals.length > 0 ? insert.intervals : [0];
  const level = clamp01(insert.addedLevel ?? 1);
  const out: MidiNote[] = [];
  for (const note of notes) {
    for (const interval of intervals) {
      const pitch = note.pitch + Math.round(interval);
      if (pitch < 0 || pitch > 127) continue;
      out.push(interval === 0 ? { ...note } : {
        ...note,
        // A new id, or the added notes and the original all claim to be the
        // same note and anything keyed by id picks whichever it finds first.
        id: `${note.id}+${interval}`,
        pitch,
        velocity: clamp01(note.velocity * level),
      });
    }
  }
  return out;
}

function applyEcho(notes: readonly MidiNote[], insert: EchoInsert): MidiNote[] {
  const repeats = Math.max(0, Math.round(insert.repeats));
  const gap = Math.max(MIN_NOTE_BEATS, insert.delayBeat);
  const feedback = clamp01(insert.feedback);
  const out: MidiNote[] = [...notes];
  for (const note of notes) {
    let velocity = note.velocity;
    for (let i = 1; i <= repeats; i++) {
      velocity *= feedback;
      // A repeat quieter than a 7-bit 1 is inaudible; stopping is honest and
      // saves the rest of the tail.
      if (to7bit(velocity) < 1) break;
      const pitch = note.pitch + Math.round(insert.pitchStep) * i;
      if (pitch < 0 || pitch > 127) break;
      out.push({
        ...note,
        id: `${note.id}~${i}`,
        pitch,
        startBeat: note.startBeat + gap * i,
        velocity,
      });
    }
  }
  return out;
}

function applyArpeggiator(notes: readonly MidiNote[], insert: ArpeggiatorInsert): MidiNote[] {
  // The offline verb, reused exactly.  Sharing the code is what makes an
  // arpeggiated part sound the same whether it was baked or inserted.
  const options: Parameters<typeof arpeggiate>[1] = {
    direction: insert.direction,
    rateBeat: insert.rateBeat,
    gate: insert.gate,
    octaves: insert.octaves,
    ...(insert.seed !== undefined ? { seed: insert.seed } : {}),
  };
  return arpeggiate(notes, options);
}

// ── The chain ───────────────────────────────────────────────────────────────

export interface ChainResult {
  notes: MidiNote[];
  /**
   * True when the ceiling stopped the chain part-way.
   *
   * The caller says so rather than handing back a quietly truncated part —
   * "the arp stops after two bars" with no explanation is a bug report.
   */
  overflowed: boolean;
}

/**
 * Run a part through a chain.
 *
 * Order matters and is the user's: a chorder before an arpeggiator arpeggiates
 * the chord, and after it harmonises every arp step.  Both are things people
 * want, so neither is imposed.
 */
export function runChain(
  notes: readonly MidiNote[], chain: readonly MidiInsert[],
): ChainResult {
  let current: MidiNote[] = [...notes];
  let overflowed = false;

  for (const insert of chain) {
    if (insert.bypass) continue;
    switch (insert.kind) {
      case 'transpose':   current = applyTranspose(current, insert); break;
      case 'velocity':    current = applyVelocity(current, insert); break;
      case 'range':       current = applyRange(current, insert); break;
      case 'chorder':     current = applyChorder(current, insert); break;
      case 'echo':        current = applyEcho(current, insert); break;
      case 'arpeggiator': current = applyArpeggiator(current, insert); break;
    }
    if (current.length > MAX_INSERT_NOTES) {
      current = sortNotes(current).slice(0, MAX_INSERT_NOTES);
      overflowed = true;
      break;
    }
  }

  return { notes: sortNotes(current), overflowed };
}

/** True when the chain would change nothing, so the caller can skip it. */
export function chainIsEmpty(chain: readonly MidiInsert[] | undefined): boolean {
  return !chain || chain.every((i) => i.bypass);
}

// ── Live ────────────────────────────────────────────────────────────────────

/**
 * The inserts that can act on ONE key press, with no idea what follows.
 *
 * Transpose, velocity, range and the chorder are decided by the note alone,
 * so a live keyboard can be run through them event by event with no clock and
 * no held state.  The arpeggiator and the echo cannot: both are about WHEN,
 * and when depends on a step clock and on which keys are still down.
 */
export function isStatelessInsert(insert: MidiInsert): boolean {
  return insert.kind !== 'arpeggiator' && insert.kind !== 'echo';
}

export function statelessPart(chain: readonly MidiInsert[]): MidiInsert[] {
  const out: MidiInsert[] = [];
  for (const insert of chain) {
    // Stop at the first timed insert rather than skipping past it: everything
    // after an arpeggiator acts on ITS output, and running those now would
    // apply them to the wrong notes.
    if (!isStatelessInsert(insert) && !insert.bypass) break;
    out.push(insert);
  }
  return out;
}

/** The first timed insert in the chain, which the live scheduler drives. */
export function timedInsert(chain: readonly MidiInsert[]): MidiInsert | null {
  for (const insert of chain) {
    if (insert.bypass) continue;
    if (!isStatelessInsert(insert)) return insert;
  }
  return null;
}

/**
 * One live key press through the stateless head of the chain.
 *
 * Returns the notes to sound now.  Empty is a real answer — a range insert
 * set to `drop` is exactly how a split keyboard stays silent above the split.
 */
export function liveNotes(
  pitch: number, velocity: number, channel: number, chain: readonly MidiInsert[],
): MidiNote[] {
  const source = createNote({
    pitch, velocity: clamp01(velocity), channel, startBeat: 0, durationBeat: 1,
  });
  return runChain([source], statelessPart(chain)).notes;
}

/**
 * What a held chord should play over one window of the arp's clock.
 *
 * `fromStep` and `toStep` are step indices, not beats, because the live
 * scheduler counts steps from the moment the first key went down — there is
 * no transport to be in step with when somebody is just playing.
 */
export function arpStepsFor(
  held: readonly MidiNote[], insert: ArpeggiatorInsert, fromStep: number, toStep: number,
): { pitch: number; velocity: number; channel: number; step: number }[] {
  if (held.length === 0 || toStep <= fromStep) return [];
  // Build one arp run long enough to cover the window, then read the steps
  // out of it — the SAME code path the rendered part uses, so a live take and
  // its playback cannot disagree.
  const rate = Math.max(MIN_NOTE_BEATS, insert.rateBeat);
  const span = (toStep - fromStep) * rate;
  const chord = held.map((n) => ({ ...n, startBeat: 0, durationBeat: span }));
  const run = applyArpeggiator(chord, insert);

  const out: { pitch: number; velocity: number; channel: number; step: number }[] = [];
  for (const note of run) {
    const offset = Math.round(note.startBeat / rate);
    if (offset < 0 || offset >= toStep - fromStep) continue;
    out.push({
      pitch: note.pitch,
      velocity: note.velocity,
      channel: note.channel,
      step: fromStep + offset,
    });
  }
  return out.sort((a, b) => a.step - b.step || a.pitch - b.pitch);
}

/** Seconds per arp step at a tempo — the live scheduler's tick. */
export function stepSeconds(insert: ArpeggiatorInsert, tempoBpm: number): number {
  const rate = Math.max(MIN_NOTE_BEATS, insert.rateBeat);
  return (60 / Math.max(1, tempoBpm)) * rate;
}

// ── Reading a chain back ────────────────────────────────────────────────────

export function describeInsert(insert: MidiInsert): string {
  const off = insert.bypass ? ' (꺼짐)' : '';
  switch (insert.kind) {
    case 'transpose':
      return `${INSERT_LABELS.transpose} ${insert.semitones > 0 ? '+' : ''}${insert.semitones}${off}`;
    case 'velocity':
      return insert.fixed !== undefined
        ? `${INSERT_LABELS.velocity} 고정 ${insert.fixed}${off}`
        : `${INSERT_LABELS.velocity} ×${insert.scale} ${insert.offset >= 0 ? '+' : ''}${insert.offset}${off}`;
    case 'range':
      return `${INSERT_LABELS.range} ${insert.lowPitch}…${insert.highPitch} ${insert.mode === 'fold' ? '접기' : '자르기'}${off}`;
    case 'chorder':
      return `${INSERT_LABELS.chorder} [${insert.intervals.join(', ')}]${off}`;
    case 'arpeggiator':
      return `${INSERT_LABELS.arpeggiator} ${insert.direction} 1/${Math.round(4 / insert.rateBeat)} ×${insert.octaves}옥타브${off}`;
    case 'echo':
      return `${INSERT_LABELS.echo} ${insert.repeats}회 ${insert.delayBeat}박${off}`;
  }
}

export function describeChain(chain: readonly MidiInsert[]): string {
  const on = chain.filter((i) => !i.bypass);
  if (on.length === 0) return 'MIDI 인서트 없음';
  return on.map(describeInsert).join(' → ');
}

export { chordGroups, noteEndBeat };
