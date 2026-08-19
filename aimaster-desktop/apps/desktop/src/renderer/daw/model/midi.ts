// MIDI data model — designed for MIDI 2.0 / MPE from the start.
//
// Why this shape, and not "pitch + velocity + 7-bit CC":
//
//   • Every continuous value is stored as a NORMALISED DOUBLE (0…1 unipolar,
//     −1…1 bipolar).  MIDI 1.0's 7-bit, high-resolution 14-bit CC pairs and
//     MIDI 2.0's 32-bit values all convert into that range without loss of
//     musical meaning, so widening the transport later never forces a
//     migration of everyone's sessions.
//   • Expression is PER NOTE, not per channel.  MPE and MIDI 2.0 both address
//     a single note (pitch bend, pressure, timbre); a channel-only model
//     cannot represent that and would have to be rebuilt.  Channel-level
//     lanes still exist, because ordinary CC automation is per part.
//   • Pitch is an integer key plus a signed semitone OFFSET.  The key is the
//     piano-roll row; the offset carries microtuning, MPE bend and — later —
//     the pitch curve a VariAudio-style vocal editor produces.
//
// Everything here is plain data and pure functions: no AudioContext, no React.

export type NoteId       = string;
export type LaneId       = string;

/** Normalised 0…1 (velocity, pressure, timbre, most CCs). */
export type Unipolar = number;
/** Normalised −1…+1 (pitch bend, pan). */
export type Bipolar  = number;

export const MIDDLE_C_PITCH = 60;          // C3 in the Cubase/Yamaha naming
export const MIN_PITCH = 0;
export const MAX_PITCH = 127;

// ── Value conversion ──────────────────────────────────────────────────────────

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const clampBipolar = (v: number): number => (v < -1 ? -1 : v > 1 ? 1 : v);

/** 7-bit MIDI 1.0 value → normalised. */
export const from7bit = (v: number): Unipolar => clamp01(v / 127);
/** Normalised → 7-bit, rounded the way a MIDI 1.0 port would send it. */
export const to7bit = (v: Unipolar): number => Math.round(clamp01(v) * 127);

/** 14-bit (high-resolution CC pair, MIDI 1.0 pitch bend) → normalised. */
export const from14bit = (v: number): Unipolar => clamp01(v / 16383);
export const to14bit = (v: Unipolar): number => Math.round(clamp01(v) * 16383);

/** MIDI 2.0 32-bit unsigned → normalised. */
export const from32bit = (v: number): Unipolar => clamp01(v / 4294967295);
export const to32bit = (v: Unipolar): number => Math.round(clamp01(v) * 4294967295);

/** MIDI 1.0 pitch-bend word (0…16383, centre 8192) → −1…+1. */
export const bendFrom14bit = (v: number): Bipolar => clampBipolar((v - 8192) / 8192);
export const bendTo14bit = (v: Bipolar): number => Math.round(clampBipolar(v) * 8192) + 8192;

// ── Expression targets ────────────────────────────────────────────────────────

/**
 * What a curve controls.
 *
 * `pitchBend`, `pressure` and `timbre` are the three MPE dimensions and the
 * three MIDI 2.0 per-note controllers everyone actually uses; `cc` and
 * `registered` cover the rest without inventing a new enum every time.
 */
export type ExpressionTarget =
  | { kind: 'pitchBend' }                       // bipolar, scaled by bendRangeSemitones
  | { kind: 'pressure' }                        // aftertouch (poly or channel)
  | { kind: 'timbre' }                          // MPE "Y" / CC74 brightness
  | { kind: 'cc'; controller: number }          // 0…127
  | { kind: 'registered'; index: number };      // MIDI 2.0 registered per-note controller

export function targetKey(target: ExpressionTarget): string {
  switch (target.kind) {
    case 'cc':         return `cc:${target.controller}`;
    case 'registered': return `rpn:${target.index}`;
    default:           return target.kind;
  }
}

export function targetLabel(target: ExpressionTarget): string {
  switch (target.kind) {
    case 'pitchBend':  return 'Pitch Bend';
    case 'pressure':   return 'Aftertouch';
    case 'timbre':     return 'Timbre (CC74)';
    case 'cc':         return CC_NAMES[target.controller] ?? `CC ${target.controller}`;
    case 'registered': return `RPN ${target.index}`;
    default:           return 'Unknown';
  }
}

/** The controllers worth naming in a menu. */
export const CC_NAMES: Record<number, string> = {
  1:  'Modulation',
  2:  'Breath',
  4:  'Foot',
  7:  'Volume',
  10: 'Pan',
  11: 'Expression',
  64: 'Sustain Pedal',
  71: 'Resonance',
  74: 'Brightness',
  91: 'Reverb Send',
  93: 'Chorus Send',
};

// ── Curves ────────────────────────────────────────────────────────────────────

export interface ExpressionPoint {
  /** Seconds, relative to the NOTE start (per-note) or PART start (lane). */
  timeSec: number;
  /** Normalised: 0…1 unipolar, −1…1 for pitch bend. */
  value: number;
}

export interface NoteExpression {
  target: ExpressionTarget;
  /** Sorted by time.  Empty means "no curve", not "zero". */
  points: ExpressionPoint[];
}

/** A part-level controller lane (ordinary CC automation inside a part). */
export interface ControllerLane {
  id: LaneId;
  target: ExpressionTarget;
  points: ExpressionPoint[];
  visible: boolean;
}

// ── Note ──────────────────────────────────────────────────────────────────────

export interface MidiNote {
  id: NoteId;
  /** Integer key 0…127 — the piano-roll row. */
  pitch: number;
  /**
   * Static pitch offset in semitones, added to `pitch`.  Microtuning, MPE
   * tuning, and the per-note pitch a vocal-to-MIDI transfer produces.
   * Continuous bend over time lives in `expression`.
   */
  pitchOffsetSemitones: number;
  /** Seconds from the PART start. */
  startSec: number;
  durationSec: number;
  velocity: Unipolar;
  releaseVelocity: Unipolar;
  /** 0-based.  Under MPE this is the per-note channel the renderer assigns. */
  channel: number;
  muted: boolean;
  /** Per-note curves — MPE / MIDI 2.0 per-note controllers. */
  expression: NoteExpression[];
  /** Expression-map slot (staccato, pizzicato…), null when unset. */
  articulation: string | null;
  /** 0…1 — Cubase-style play probability for humanised repeats. */
  playProbability: number;
}

/** Per-part MIDI configuration. */
export interface MidiPartConfig {
  /** Semitone range a full ±1 bend represents (MPE default is ±48). */
  bendRangeSemitones: number;
  /** True when the part is authored as MPE (per-note channels on output). */
  mpe: boolean;
}

export const DEFAULT_MIDI_CONFIG: MidiPartConfig = { bendRangeSemitones: 2, mpe: false };

let noteCounter = 0;
export function nextNoteId(): NoteId { noteCounter += 1; return `note-${noteCounter}`; }
export function resetNoteIds(): void { noteCounter = 0; }

export function createNote(over: Partial<MidiNote> = {}): MidiNote {
  return {
    id: nextNoteId(),
    pitch: MIDDLE_C_PITCH,
    pitchOffsetSemitones: 0,
    startSec: 0,
    durationSec: 0.5,
    velocity: from7bit(100),
    releaseVelocity: from7bit(64),
    channel: 0,
    muted: false,
    expression: [],
    articulation: null,
    playProbability: 1,
    ...over,
  };
}

export const noteEnd = (n: MidiNote): number => n.startSec + n.durationSec;

/** Sounding pitch including the static offset — what the synth plays. */
export const soundingPitch = (n: MidiNote): number => n.pitch + n.pitchOffsetSemitones;

export function sortNotes(notes: readonly MidiNote[]): MidiNote[] {
  return [...notes].sort((a, b) => (a.startSec - b.startSec) || (a.pitch - b.pitch));
}

// ── Curve evaluation ──────────────────────────────────────────────────────────

/** Linear interpolation with flat ends — the same rule as automation lanes. */
export function curveValueAt(
  points: readonly ExpressionPoint[], timeSec: number, fallback: number,
): number {
  if (points.length === 0) return fallback;
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return fallback;
  if (timeSec <= first.timeSec) return first.value;
  if (timeSec >= last.timeSec) return last.value;
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const p = points[mid];
    if (!p) break;
    if (p.timeSec <= timeSec) lo = mid; else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  if (!a || !b) return fallback;
  const span = b.timeSec - a.timeSec;
  if (span <= 1e-12) return b.value;
  return a.value + (b.value - a.value) * ((timeSec - a.timeSec) / span);
}

export function findExpression(
  note: MidiNote, target: ExpressionTarget,
): NoteExpression | undefined {
  const key = targetKey(target);
  return note.expression.find((e) => targetKey(e.target) === key);
}

/** Note expression value at a note-relative time (fallback when no curve). */
export function noteExpressionAt(
  note: MidiNote, target: ExpressionTarget, timeSec: number, fallback: number,
): number {
  const curve = findExpression(note, target);
  return curve ? curveValueAt(curve.points, timeSec, fallback) : fallback;
}

/** Replace (or add) one per-note curve, keeping the others. */
export function setExpression(note: MidiNote, expression: NoteExpression): MidiNote {
  const key = targetKey(expression.target);
  const rest = note.expression.filter((e) => targetKey(e.target) !== key);
  const points = [...expression.points].sort((a, b) => a.timeSec - b.timeSec);
  return { ...note, expression: [...rest, { ...expression, points }] };
}

export function removeExpression(note: MidiNote, target: ExpressionTarget): MidiNote {
  const key = targetKey(target);
  if (!note.expression.some((e) => targetKey(e.target) === key)) return note;
  return { ...note, expression: note.expression.filter((e) => targetKey(e.target) !== key) };
}

/**
 * Total pitch offset in semitones at a moment inside the note: the static
 * offset plus the per-note bend curve scaled by the part's bend range.
 */
export function pitchOffsetAt(
  note: MidiNote, timeSec: number, config: MidiPartConfig,
): number {
  const bend = noteExpressionAt(note, { kind: 'pitchBend' }, timeSec, 0);
  return note.pitchOffsetSemitones + bend * config.bendRangeSemitones;
}

// ── Naming ────────────────────────────────────────────────────────────────────

const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/**
 * Cubase/Yamaha naming: middle C (60) is C3.
 * (Some hosts call it C4 — this app follows the editor in the reference.)
 */
export function pitchName(pitch: number): string {
  const p = Math.round(pitch);
  const name = PITCH_NAMES[((p % 12) + 12) % 12] ?? 'C';
  const octave = Math.floor(p / 12) - 2;
  return `${name}${octave}`;
}

export function isBlackKey(pitch: number): boolean {
  const n = ((Math.round(pitch) % 12) + 12) % 12;
  return n === 1 || n === 3 || n === 6 || n === 8 || n === 10;
}

/** Frequency of a (possibly fractional) MIDI pitch, A3 = 440 Hz. */
export function pitchToFrequency(pitch: number, a4 = 440): number {
  return a4 * Math.pow(2, (pitch - 69) / 12);
}

export function frequencyToPitch(hz: number, a4 = 440): number {
  return hz > 0 ? 69 + 12 * Math.log2(hz / a4) : 0;
}
