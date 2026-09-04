// drum-map.ts — turning pitch numbers into instruments.
//
// A MIDI drum part is a piano roll of anonymous numbers.  Note 36 is a kick
// and note 42 is a closed hi-hat, but only if you happen to know that, and
// the editor does not: it draws them as rows on a keyboard, in an order
// chosen by pitch, with a kick at the bottom and a crash somewhere up near
// the melody.  Nobody edits drums that way.
//
// A drum map fixes three separate things, and they are worth naming apart
// because they fail differently:
//
//   NAMES.  Row 42 says "Closed Hi-Hat".  Purely cosmetic, and the reason the
//   editor is usable at all.
//
//   ORDER.  The rows are laid out the way a kit is laid out — kick, snare,
//   hats, toms, cymbals — not by pitch.  Also cosmetic, also the difference
//   between a usable editor and a wall of numbers.
//
//   OUTPUT PITCH.  This one is NOT cosmetic.  A part written against General
//   MIDI has its kick on 36; a sampled kit might want it on 24.  The map
//   rewrites the pitch on the way OUT, so the part stays readable as GM while
//   playing the kit that is actually loaded.  Cubase calls these the I-note
//   and the O-note, and the distinction matters: editing moves the I-note,
//   playback uses the O-note, and confusing the two transposes a drum part
//   into silence.
//
// And one thing that is not about naming at all — CHOKE GROUPS.  On a real
// kit, closing the hi-hat stops the open one; a crash grabbed by hand stops
// ringing.  A sampler with one voice per note does this for free; a sampler
// with a voice per hit does not, and the open hat rings on underneath the
// closed one for its whole sample.  It sounds like a kit with two hi-hats.
// Slots in the same group cut each other off, and that is applied to the
// NOTES rather than asked of the instrument, because it has to survive being
// rendered, exported and bounced.

import type { MidiNote } from './midi.js';
import { sortNotes } from './midi.js';

/** One instrument in a kit. */
export interface DrumSlot {
  /** The pitch as WRITTEN in the part — the row you edit.  Cubase's I-note. */
  pitch: number;
  name: string;
  /**
   * The pitch actually PLAYED.  Cubase's O-note.
   *
   * Absent means "the same as `pitch`", which is the honest default and keeps
   * a map that only renames from carrying 128 redundant numbers.
   */
  outPitch?: number;
  /**
   * Per-instrument quantize grid in beats.  A hi-hat on 1/16 and a kick on
   * 1/8 is a normal thing to want and impossible with one grid for the part.
   */
  quantizeBeat?: number;
  /** Silenced without deleting — auditioning a kit without its cymbals. */
  muted?: boolean;
  /**
   * Choke group.  Slots sharing a group cut each other off; `undefined` means
   * this instrument rings freely, which is most of them.
   */
  chokeGroup?: number;
}

export interface DrumMap {
  id: string;
  name: string;
  /** In DISPLAY order, top row first.  Not sorted by pitch. */
  slots: DrumSlot[];
}

export const MIN_DRUM_PITCH = 0;
export const MAX_DRUM_PITCH = 127;

/**
 * The General MIDI kit, in the order a drummer would list it.
 *
 * Not every GM pitch — the ones a kit part actually uses.  A map is allowed to
 * be incomplete: a pitch with no slot still plays, it just has no name and no
 * row of its own (see `rowsFor`).
 */
export const GM_DRUM_SLOTS: readonly DrumSlot[] = [
  { pitch: 36, name: '킥' },
  { pitch: 35, name: '킥 2' },
  { pitch: 38, name: '스네어' },
  { pitch: 40, name: '스네어 (림)' },
  { pitch: 37, name: '사이드 스틱' },
  { pitch: 39, name: '핸드 클랩' },
  // The three hats are one physical instrument, so they cut each other off.
  { pitch: 42, name: '클로즈드 하이햇', chokeGroup: 1 },
  { pitch: 44, name: '페달 하이햇',     chokeGroup: 1 },
  { pitch: 46, name: '오픈 하이햇',     chokeGroup: 1 },
  { pitch: 41, name: '로우 플로어 톰' },
  { pitch: 43, name: '하이 플로어 톰' },
  { pitch: 45, name: '로우 톰' },
  { pitch: 47, name: '로우-미드 톰' },
  { pitch: 48, name: '하이-미드 톰' },
  { pitch: 50, name: '하이 톰' },
  { pitch: 49, name: '크래시 1' },
  { pitch: 57, name: '크래시 2' },
  { pitch: 51, name: '라이드' },
  { pitch: 53, name: '라이드 벨' },
  { pitch: 59, name: '라이드 2' },
  { pitch: 52, name: '차이니즈' },
  // A splash is grabbed and choked far more often than a crash is.
  { pitch: 55, name: '스플래시', chokeGroup: 2 },
  { pitch: 54, name: '탬버린' },
  { pitch: 56, name: '카우벨' },
  { pitch: 58, name: '베이스' },
];

export const GM_DRUM_MAP: DrumMap = {
  id: 'gm', name: 'General MIDI 킷', slots: [...GM_DRUM_SLOTS],
};

export function createDrumMap(name: string, id: string, slots: readonly DrumSlot[] = GM_DRUM_SLOTS): DrumMap {
  return { id, name, slots: slots.map((s) => ({ ...s })) };
}

// ── Reading a map ───────────────────────────────────────────────────────────

export function slotFor(map: DrumMap, pitch: number): DrumSlot | null {
  return map.slots.find((s) => s.pitch === pitch) ?? null;
}

/** What the synth is asked to play.  Falls back to the written pitch. */
export function outPitchOf(map: DrumMap, pitch: number): number {
  const slot = slotFor(map, pitch);
  const out = slot?.outPitch;
  return Number.isFinite(out) ? clampPitch(out as number) : pitch;
}

export function clampPitch(pitch: number): number {
  if (!Number.isFinite(pitch)) return MIN_DRUM_PITCH;
  return Math.max(MIN_DRUM_PITCH, Math.min(MAX_DRUM_PITCH, Math.round(pitch)));
}

/** `36 킥` — what a row header says. */
export function describeSlot(slot: DrumSlot): string {
  const out = slot.outPitch !== undefined && slot.outPitch !== slot.pitch
    ? ` → ${slot.outPitch}` : '';
  return `${slot.pitch}${out} ${slot.name}`;
}

/**
 * The rows to draw, top first.
 *
 * The map's own slots in their display order, then any pitch the part uses
 * that the map does not name — appended rather than dropped, because a note
 * with no row would be invisible and un-deletable.  That is the failure mode
 * worth designing against: an editor that silently hides part of the part.
 */
export function rowsFor(map: DrumMap, notes: readonly MidiNote[]): DrumSlot[] {
  const rows = map.slots.map((s) => ({ ...s }));
  const named = new Set(rows.map((s) => s.pitch));
  const extra = new Set<number>();
  for (const note of notes) if (!named.has(note.pitch)) extra.add(note.pitch);
  for (const pitch of [...extra].sort((a, b) => b - a)) {
    rows.push({ pitch, name: `${pitch}` });
  }
  return rows;
}

/** Which row a pitch draws on, or -1 when the map has no row for it. */
export function rowOf(rows: readonly DrumSlot[], pitch: number): number {
  return rows.findIndex((s) => s.pitch === pitch);
}

// ── Playing a map ───────────────────────────────────────────────────────────

/**
 * Rewrite a part for output: out-pitches applied, muted slots dropped, choke
 * groups honoured.
 *
 * Called on the way to the instrument and on the way to a render — never on
 * the stored part, which stays written in the pitches the editor shows.  Doing
 * it the other way would make the map destructive and un-changeable: rewrite
 * the part once and the original pitches are gone.
 */
export function applyDrumMap(map: DrumMap, notes: readonly MidiNote[]): MidiNote[] {
  const kept: MidiNote[] = [];
  for (const note of notes) {
    const slot = slotFor(map, note.pitch);
    if (slot?.muted) continue;
    const out = outPitchOf(map, note.pitch);
    kept.push(out === note.pitch ? note : { ...note, pitch: out });
  }
  return applyChokes(map, kept, notes);
}

/**
 * Cut a ringing hit off when its group is struck again.
 *
 * The previous note's duration is shortened to end where the next one starts.
 * A note is never lengthened by this and never given a negative length: two
 * hits at the same instant are simultaneous, not a choke of zero length.
 *
 * `written` carries the notes as the editor shows them, because the group is
 * a property of the WRITTEN pitch — after the out-pitch rewrite, two slots in
 * one group may have collapsed onto the same output note, and grouping by
 * that would choke instruments the map never grouped.
 */
export function applyChokes(
  map: DrumMap, notes: readonly MidiNote[], written: readonly MidiNote[] = notes,
): MidiNote[] {
  const groupOf = new Map<string, number>();
  for (const note of written) {
    const group = slotFor(map, note.pitch)?.chokeGroup;
    if (group !== undefined) groupOf.set(note.id, group);
  }
  if (groupOf.size === 0) return [...notes];

  const byGroup = new Map<number, MidiNote[]>();
  for (const note of notes) {
    const group = groupOf.get(note.id);
    if (group === undefined) continue;
    const list = byGroup.get(group);
    if (list) list.push(note); else byGroup.set(group, [note]);
  }

  const shortened = new Map<string, number>();
  for (const list of byGroup.values()) {
    const ordered = [...list].sort((a, b) => a.startBeat - b.startBeat);
    for (let i = 0; i < ordered.length - 1; i++) {
      const here = ordered[i] as MidiNote;
      const next = ordered[i + 1] as MidiNote;
      const cut = next.startBeat - here.startBeat;
      if (cut > 0 && cut < here.durationBeat) shortened.set(here.id, cut);
    }
  }
  if (shortened.size === 0) return [...notes];
  return notes.map((n) => {
    const cut = shortened.get(n.id);
    return cut === undefined ? n : { ...n, durationBeat: cut };
  });
}

// ── Editing through a map ───────────────────────────────────────────────────

/**
 * Quantize each instrument to its OWN grid.
 *
 * Slots without a grid are left exactly as they are rather than falling back
 * to a part-wide one: "no grid set" is a decision, and quietly quantising a
 * ghost-note snare to 1/16 because the hats were set that way would flatten
 * the one thing the player was doing on purpose.
 */
export function quantizeByMap(
  map: DrumMap, notes: readonly MidiNote[], ids?: ReadonlySet<string>,
): MidiNote[] {
  return sortNotes(notes.map((note) => {
    if (ids && !ids.has(note.id)) return note;
    const grid = slotFor(map, note.pitch)?.quantizeBeat;
    if (!grid || grid <= 0) return note;
    const snapped = Math.max(0, Math.round(note.startBeat / grid) * grid);
    return snapped === note.startBeat ? note : { ...note, startBeat: snapped };
  }));
}

/** Move every hit of one instrument to another row — dragging a lane. */
export function remapPitch(
  notes: readonly MidiNote[], fromPitch: number, toPitch: number,
): MidiNote[] {
  const to = clampPitch(toPitch);
  if (to === fromPitch) return [...notes];
  return notes.map((n) => (n.pitch === fromPitch ? { ...n, pitch: to } : n));
}

export function setSlot(map: DrumMap, pitch: number, patch: Partial<DrumSlot>): DrumMap {
  const index = map.slots.findIndex((s) => s.pitch === pitch);
  if (index < 0) {
    return { ...map, slots: [...map.slots, { pitch, name: `${pitch}`, ...patch }] };
  }
  const slots = map.slots.slice();
  slots[index] = { ...(slots[index] as DrumSlot), ...patch, pitch };
  return { ...map, slots };
}

/**
 * Take an optional property off a slot.
 *
 * A separate verb from `setSlot` because "no out-pitch" and "an out-pitch of
 * undefined" are not the same object: spreading `undefined` in leaves the key
 * present, and a session round-tripped through JSON would then differ from
 * one that never had it.  Deleting says what was meant.
 */
export function clearSlotField(
  map: DrumMap, pitch: number,
  field: 'outPitch' | 'quantizeBeat' | 'chokeGroup' | 'muted',
): DrumMap {
  const index = map.slots.findIndex((s) => s.pitch === pitch);
  if (index < 0) return map;
  const slot = { ...(map.slots[index] as DrumSlot) };
  if (!(field in slot)) return map;
  delete slot[field];
  const slots = map.slots.slice();
  slots[index] = slot;
  return { ...map, slots };
}

/** Move a row up or down the display order.  Out-of-range moves do nothing. */
export function moveSlot(map: DrumMap, pitch: number, delta: number): DrumMap {
  const from = map.slots.findIndex((s) => s.pitch === pitch);
  if (from < 0) return map;
  const to = from + delta;
  if (to < 0 || to >= map.slots.length) return map;
  const slots = map.slots.slice();
  const [moved] = slots.splice(from, 1);
  slots.splice(to, 0, moved as DrumSlot);
  return { ...map, slots };
}

/** Which instruments the part actually uses, in display order. */
export function usedSlots(map: DrumMap, notes: readonly MidiNote[]): DrumSlot[] {
  const used = new Set(notes.map((n) => n.pitch));
  return rowsFor(map, notes).filter((s) => used.has(s.pitch));
}

export function describeMap(map: DrumMap, notes: readonly MidiNote[]): string {
  const used = usedSlots(map, notes).length;
  const named = notes.filter((n) => slotFor(map, n.pitch)).length;
  const unnamed = notes.length - named;
  const tail = unnamed > 0 ? ` · 이름 없는 노트 ${unnamed}개` : '';
  return `${map.name} · 악기 ${used}개${tail}`;
}
