// list-events.ts — the part as a table of numbers.
//
// Two things in a MIDI part have no numeric view anywhere in this app.
//
// The first is any value that is WRONG BY ONE.  A note on 60 that should be
// on 61, a velocity of 99 that should be 100, a note eight ticks off the
// grid — all of them are a pixel or two in the piano roll, which is to say
// invisible, and none of them can be fixed by dragging without introducing a
// different error.
//
// The second is the expression curves.  A per-note bend or a CC lane can be
// DRAWN in the controller lane and nowhere read: there is no way to find out
// that a point sits at 0.734 rather than 0.75, and no way to type 0.75.
//
// A list editor is the answer to both, and it is one table rather than three
// because the whole point is that everything in the part is in it.
//
// The design problem is that these events are not the same shape.  A note has
// a pitch and a length; a curve point has neither and its time is measured
// from a DIFFERENT ORIGIN — per-note curves are relative to their note, part
// lanes to the part.  Flattening them into rows means choosing an origin, and
// the choice here is: every row shows an ABSOLUTE position in the part, and
// writing one back converts to whatever origin that event actually uses.
// Showing a bend point at "beat 0.25" when the note it belongs to starts at
// beat 12 would be true and useless.

import {
  findExpression, setExpression, sortNotes, targetKey, targetLabel, to7bit, from7bit,
  type ControllerLane, type ExpressionPoint, type ExpressionTarget, type MidiNote,
} from '../model/midi.js';
import {
  TICKS_PER_BEAT, barBeatAt, beatAtBarBeat, type BarBeat, type TempoMap,
} from '../model/tempo-map.js';

export type EventKind = 'note' | 'expression' | 'lane';

/** Which field of a row can be typed into. */
export type EditableField = 'position' | 'length' | 'pitch' | 'velocity' | 'channel' | 'value';

export interface ListRow {
  /** Stable across a re-read of the same part, so a cursor stays put. */
  id: string;
  kind: EventKind;
  /** Beats from the PART start, whatever origin the underlying event uses. */
  beat: number;
  /** What this row is, in words: `노트 C3` or `Pitch Bend`. */
  label: string;
  /** Notes only. */
  pitch?: number;
  /** Notes only, in beats. */
  lengthBeat?: number;
  /** Notes only, 1…127. */
  velocity?: number;
  /** Notes only, 0-based. */
  channel?: number;
  /** Curve points only, in the curve's own normalised units. */
  value?: number;
  muted?: boolean;
  /** The note this row belongs to, for `expression`. */
  noteId?: string;
  /** The lane this row belongs to, for `lane`. */
  laneId?: string;
  target?: ExpressionTarget;
  /** Index into that curve's points. */
  pointIndex?: number;
  /** Which fields this row will accept. */
  editable: EditableField[];
}

const NOTE_FIELDS: EditableField[] = ['position', 'length', 'pitch', 'velocity', 'channel'];
const POINT_FIELDS: EditableField[] = ['position', 'value'];

export interface ListInput {
  notes: readonly MidiNote[];
  lanes?: readonly ControllerLane[];
}

export interface ListOptions {
  /** Which kinds to include.  All three when absent. */
  kinds?: readonly EventKind[];
  /** Only rows for these notes, and the curves that hang off them. */
  noteIds?: ReadonlySet<string>;
}

/** `C3` for 60, the way the rest of the app names pitches. */
function shortPitch(pitch: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return `${names[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 2}`;
}

/**
 * Flatten a part into rows, ordered by position.
 *
 * Ties are broken by KIND — a note before the curve points that belong to it,
 * a curve point before a lane point — and then by pitch, so a chord always
 * reads the same way twice.  Without that a re-read after an edit can shuffle
 * two simultaneous rows past each other and the cursor lands on a different
 * event than the one that was being typed into.
 */
export function listRows(input: ListInput, options: ListOptions = {}): ListRow[] {
  const kinds = new Set<EventKind>(options.kinds ?? ['note', 'expression', 'lane']);
  const rows: ListRow[] = [];

  for (const note of input.notes) {
    if (options.noteIds && !options.noteIds.has(note.id)) continue;

    if (kinds.has('note')) {
      rows.push({
        id: `n:${note.id}`,
        kind: 'note',
        beat: note.startBeat,
        label: `노트 ${shortPitch(note.pitch)}`,
        pitch: note.pitch,
        lengthBeat: note.durationBeat,
        velocity: to7bit(note.velocity),
        channel: note.channel,
        muted: note.muted,
        noteId: note.id,
        editable: NOTE_FIELDS,
      });
    }

    if (!kinds.has('expression')) continue;
    for (const expression of note.expression) {
      const key = targetKey(expression.target);
      expression.points.forEach((point, index) => {
        rows.push({
          id: `e:${note.id}:${key}:${index}`,
          kind: 'expression',
          // Absolute in the part.  A bend point shown at "beat 0.25" when its
          // note starts at beat 12 would be true and useless.
          beat: note.startBeat + point.timeBeat,
          label: `${targetLabel(expression.target)} · ${shortPitch(note.pitch)}`,
          value: point.value,
          noteId: note.id,
          target: expression.target,
          pointIndex: index,
          editable: POINT_FIELDS,
        });
      });
    }
  }

  if (kinds.has('lane')) {
    for (const lane of input.lanes ?? []) {
      lane.points.forEach((point, index) => {
        rows.push({
          id: `l:${lane.id}:${index}`,
          kind: 'lane',
          beat: point.timeBeat,
          label: `${targetLabel(lane.target)} (파트)`,
          value: point.value,
          laneId: lane.id,
          target: lane.target,
          pointIndex: index,
          editable: POINT_FIELDS,
        });
      });
    }
  }

  const kindRank: Record<EventKind, number> = { note: 0, expression: 1, lane: 2 };
  return rows.sort((a, b) => (a.beat - b.beat)
    || (kindRank[a.kind] - kindRank[b.kind])
    || ((a.pitch ?? 128) - (b.pitch ?? 128))
    || a.id.localeCompare(b.id));
}

// ── Position, as a musician types it ────────────────────────────────────────

/**
 * `9|3|480` — the only readable way to say where an event is.
 *
 * `partStartBeat` is where the part sits in the SONG, because bar numbers are
 * a property of the song and a part that starts at bar 9 must not call its
 * first bar 1.
 */
export function formatPosition(
  map: TempoMap, partStartBeat: number, beat: number,
): string {
  const at = barBeatAt(map, partStartBeat + beat);
  return `${at.bar}|${at.beat}|${String(at.tick).padStart(3, '0')}`;
}

/**
 * Parse `9|3|480`, `9|3` or `9` back into a part-relative beat.
 *
 * Returns null for anything it cannot read, so a half-typed position leaves
 * the event where it was instead of moving it to bar 0.
 */
export function parsePosition(
  map: TempoMap, partStartBeat: number, text: string,
): number | null {
  const parts = text.trim().split(/[|:.\s]+/).filter((p) => p.length > 0);
  if (parts.length === 0 || parts.length > 3) return null;
  const numbers = parts.map((p) => Number(p));
  if (numbers.some((n) => !Number.isFinite(n))) return null;
  const at: BarBeat = {
    bar: numbers[0] as number,
    beat: numbers[1] ?? 1,
    tick: numbers[2] ?? 0,
  };
  const songBeat = beatAtBarBeat(map, at);
  // A position before the part is clamped to its start rather than made
  // negative: an event at a negative beat is unreachable in every editor.
  return Math.max(0, songBeat - partStartBeat);
}

/** `2.500박` — a length, which has no bar number. */
export function formatLength(beats: number): string {
  const ticks = Math.round(beats * TICKS_PER_BEAT);
  const whole = Math.floor(ticks / TICKS_PER_BEAT);
  const rest = ticks % TICKS_PER_BEAT;
  return rest === 0 ? `${whole}` : `${whole}.${String(rest).padStart(3, '0')}`;
}

export function parseLength(text: string): number | null {
  const value = Number(text.trim().replace(/[|:]/g, '.'));
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

// ── Writing one cell back ───────────────────────────────────────────────────

export interface EditResult {
  notes: MidiNote[];
  lanes: ControllerLane[];
  /** True when the edit actually changed something. */
  changed: boolean;
}

const LIMITS: Record<EditableField, { min: number; max: number; integer: boolean }> = {
  position: { min: 0, max: Infinity, integer: false },
  length:   { min: 1 / 32, max: Infinity, integer: false },
  pitch:    { min: 0, max: 127, integer: true },
  velocity: { min: 1, max: 127, integer: true },
  channel:  { min: 0, max: 15, integer: true },
  // Bipolar targets reach −1; the caller narrows this for unipolar ones.
  value:    { min: -1, max: 1, integer: false },
};

function hold(field: EditableField, value: number, target?: ExpressionTarget): number {
  const limit = LIMITS[field];
  const min = field === 'value' && target?.kind !== 'pitchBend' ? 0 : limit.min;
  const held = Math.max(min, Math.min(limit.max, value));
  return limit.integer ? Math.round(held) : held;
}

function replacePoints(
  points: readonly ExpressionPoint[], index: number, patch: Partial<ExpressionPoint>,
): ExpressionPoint[] {
  const next = points.map((p, i) => (i === index ? { ...p, ...patch } : p));
  // A curve whose points are out of order is read by `curveValueAt` as
  // jumping backwards in time.
  //
  // Per-note curves get this for free — `setExpression` sorts on the way in —
  // so the sort here is load-bearing for PART LANES, which are written
  // straight back with nothing else to put them in order.  Kept on both paths
  // because a caller should not have to know which one it is on.
  return next.sort((a, b) => a.timeBeat - b.timeBeat);
}

/**
 * Apply one typed cell.
 *
 * Returns the part unchanged (and `changed: false`) whenever the value cannot
 * be used — a row that no longer exists, a field the row does not accept, a
 * number that is not a number.  Nothing here throws: this runs on every
 * keystroke's commit and a half-typed cell is normal, not exceptional.
 */
export function editRow(
  input: ListInput, row: ListRow, field: EditableField, value: number,
): EditResult {
  const notes = [...input.notes];
  const lanes = [...(input.lanes ?? [])];
  const unchanged: EditResult = { notes, lanes, changed: false };

  if (!row.editable.includes(field)) return unchanged;
  if (!Number.isFinite(value)) return unchanged;

  if (row.kind === 'note') {
    const index = notes.findIndex((n) => n.id === row.noteId);
    if (index < 0) return unchanged;
    const note = notes[index] as MidiNote;
    const held = hold(field, value);
    let next: MidiNote;
    switch (field) {
      case 'position': next = { ...note, startBeat: held }; break;
      case 'length':   next = { ...note, durationBeat: held }; break;
      case 'pitch':    next = { ...note, pitch: held }; break;
      case 'velocity': next = { ...note, velocity: from7bit(held) }; break;
      case 'channel':  next = { ...note, channel: held }; break;
      default:         return unchanged;
    }
    notes[index] = next;
    return { notes: sortNotes(notes), lanes, changed: true };
  }

  if (row.kind === 'expression') {
    const index = notes.findIndex((n) => n.id === row.noteId);
    if (index < 0 || !row.target || row.pointIndex === undefined) return unchanged;
    const note = notes[index] as MidiNote;
    const curve = findExpression(note, row.target);
    if (!curve || !curve.points[row.pointIndex]) return unchanged;

    // The row showed an ABSOLUTE position; the curve stores one relative to
    // its note.  Converting back here is the whole reason the two are
    // different types rather than one number passed around.
    const patch: Partial<ExpressionPoint> = field === 'position'
      ? { timeBeat: Math.max(0, hold('position', value) - note.startBeat) }
      : { value: hold('value', value, row.target) };
    notes[index] = setExpression(note, {
      target: row.target,
      points: replacePoints(curve.points, row.pointIndex, patch),
    });
    return { notes, lanes, changed: true };
  }

  const index = lanes.findIndex((l) => l.id === row.laneId);
  if (index < 0 || row.pointIndex === undefined) return unchanged;
  const lane = lanes[index] as ControllerLane;
  if (!lane.points[row.pointIndex]) return unchanged;
  const patch: Partial<ExpressionPoint> = field === 'position'
    ? { timeBeat: hold('position', value) }
    : { value: hold('value', value, lane.target) };
  lanes[index] = { ...lane, points: replacePoints(lane.points, row.pointIndex, patch) };
  return { notes, lanes, changed: true };
}

/** Toggle a note's mute from the list, which has no other way to say it. */
export function toggleRowMute(input: ListInput, row: ListRow): EditResult {
  const notes = [...input.notes];
  const lanes = [...(input.lanes ?? [])];
  if (row.kind !== 'note') return { notes, lanes, changed: false };
  const index = notes.findIndex((n) => n.id === row.noteId);
  if (index < 0) return { notes, lanes, changed: false };
  const note = notes[index] as MidiNote;
  notes[index] = { ...note, muted: !note.muted };
  return { notes, lanes, changed: true };
}

/**
 * Delete the events these rows point at.
 *
 * A curve point is removed from its curve, not from the note — deleting the
 * last point of a curve leaves an empty curve, which `findExpression` and the
 * drawing code already read as "no curve".
 */
export function deleteRows(input: ListInput, rows: readonly ListRow[]): EditResult {
  const dropNotes = new Set<string>();
  /** `noteId|targetKey` or `lane:laneId` → the point indices to drop. */
  const dropPoints = new Map<string, Set<number>>();

  for (const row of rows) {
    if (row.kind === 'note' && row.noteId) { dropNotes.add(row.noteId); continue; }
    if (row.pointIndex === undefined) continue;
    const key = row.kind === 'expression' && row.noteId && row.target
      ? `${row.noteId}|${targetKey(row.target)}`
      : row.laneId ? `lane:${row.laneId}` : null;
    if (!key) continue;
    const set = dropPoints.get(key);
    if (set) set.add(row.pointIndex); else dropPoints.set(key, new Set([row.pointIndex]));
  }

  let changed = dropNotes.size > 0;
  const notes = input.notes.filter((n) => !dropNotes.has(n.id)).map((note) => {
    let next = note;
    for (const expression of note.expression) {
      const set = dropPoints.get(`${note.id}|${targetKey(expression.target)}`);
      if (!set) continue;
      changed = true;
      next = setExpression(next, {
        target: expression.target,
        points: expression.points.filter((_, i) => !set.has(i)),
      });
    }
    return next;
  });

  const lanes = (input.lanes ?? []).map((lane) => {
    const set = dropPoints.get(`lane:${lane.id}`);
    if (!set) return lane;
    changed = true;
    return { ...lane, points: lane.points.filter((_, i) => !set.has(i)) };
  });

  return { notes, lanes, changed };
}

// ── Reading the table back ──────────────────────────────────────────────────

/** The value column, in the units the row's target actually uses. */
export function formatValue(row: ListRow): string {
  if (row.value === undefined) return '';
  if (row.target?.kind === 'pitchBend') return row.value.toFixed(3);
  // Unipolar curves are 0…1 in the model and 0…127 to everybody else.
  return `${to7bit(row.value)}`;
}

export function parseValue(row: ListRow, text: string): number | null {
  const raw = Number(text.trim());
  if (!Number.isFinite(raw)) return null;
  if (row.target?.kind === 'pitchBend') return raw;
  return from7bit(raw);
}

export function describeList(rows: readonly ListRow[]): string {
  const notes = rows.filter((r) => r.kind === 'note').length;
  const points = rows.length - notes;
  return points > 0 ? `노트 ${notes}개 · 커브 포인트 ${points}개` : `노트 ${notes}개`;
}
