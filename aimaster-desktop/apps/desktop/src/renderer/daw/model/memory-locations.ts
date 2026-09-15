// memory-locations.ts — numbered markers you store and recall with a key.
//
// Pro Tools calls them Memory Locations, Cubase calls them Cycle Markers plus
// the numbered locators; the shared idea is that a position in the song gets a
// NUMBER, and the number key takes you there.  A named marker you have to find
// in a list is a different, slower thing.
//
// What a slot remembers is deliberately more than a time.  Recalling "chorus 2"
// and landing on the right second but on the wrong tracks, zoomed somewhere
// else, is not the same as being back where you were — so a slot stores the
// whole time selection (range + tracks) when there was one, and just the
// position when there wasn't.
//
// The store is `session.markers`: a numbered location IS a marker with a
// `slot`, which means it draws on the ruler and survives save/load without a
// second list to keep in step.  Markers without a slot (dropped by name) keep
// working exactly as before.

import type { DawSession, Marker, TrackId } from './types.js';
import { nextId } from './ids.js';

/**
 * Slots reachable from the number row: 1–9 plus 0 as the tenth.
 *
 * Pro Tools allows hundreds via the numeric keypad.  Ten is what a keyboard
 * without a keypad can actually reach, and a list of three hundred locations
 * is a list, not a shortcut.
 */
export const MEMORY_SLOTS = 10;

/** The keyboard order: `1`…`9`, then `0`.  Slot n is at index n-1. */
export const SLOT_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] as const;

export function isSlot(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= MEMORY_SLOTS;
}

/** The key that recalls slot `n`, or null when `n` is not a slot. */
export function slotKey(n: number): string | null {
  return isSlot(n) ? (SLOT_KEYS[n - 1] as string) : null;
}

/** The slot a number-row key recalls, or null for any other key. */
export function slotForKey(key: string): number | null {
  const index = SLOT_KEYS.indexOf(key as (typeof SLOT_KEYS)[number]);
  return index < 0 ? null : index + 1;
}

/**
 * What a slot remembers.
 *
 * `endSec` is present only when the stored selection had a length: storing a
 * bare play head and storing a zero-length selection are the same act, and
 * recalling either should not wipe a range the user has since made.
 */
export interface MemoryLocation {
  slot: number;
  id: string;
  name: string;
  timeSec: number;
  endSec?: number;
  trackIds?: TrackId[];
}

/** What recalling a slot asks the caller to do. */
export interface MemoryRecall {
  playheadSec: number;
  /** Present only when the slot stored a range — otherwise leave the selection alone. */
  selection?: { startSec: number; endSec: number; trackIds: TrackId[] };
}

const markersOf = (session: DawSession): Marker[] => session.markers ?? [];

/** True when the marker occupies a numbered slot. */
export function hasSlot(marker: Marker): boolean {
  return isSlot(marker.slot ?? 0);
}

/** The location in slot `n`, or null when the slot is empty. */
export function locationAt(session: DawSession, slot: number): MemoryLocation | null {
  if (!isSlot(slot)) return null;
  const marker = markersOf(session).find((m) => m.slot === slot);
  if (!marker) return null;
  return toLocation(marker);
}

function toLocation(marker: Marker): MemoryLocation {
  const out: MemoryLocation = {
    slot: marker.slot as number,
    id: marker.id,
    name: marker.name,
    timeSec: marker.timeSec,
  };
  if (marker.endSec !== undefined && marker.endSec > marker.timeSec) out.endSec = marker.endSec;
  if (marker.trackIds && marker.trackIds.length > 0) out.trackIds = [...marker.trackIds];
  return out;
}

/** Every filled slot, in slot order — what the panel lists. */
export function memoryLocations(session: DawSession): MemoryLocation[] {
  return markersOf(session)
    .filter(hasSlot)
    .map(toLocation)
    .sort((a, b) => a.slot - b.slot);
}

/**
 * The lowest empty slot, or null when all ten are taken.
 *
 * Lowest rather than "one past the highest": after clearing slot 3, the next
 * marker should land in 3, not in 8.
 */
export function nextFreeSlot(session: DawSession): number | null {
  const taken = new Set(markersOf(session).filter(hasSlot).map((m) => m.slot as number));
  for (let n = 1; n <= MEMORY_SLOTS; n++) if (!taken.has(n)) return n;
  return null;
}

export interface StoreRequest {
  timeSec: number;
  endSec?: number;
  trackIds?: readonly TrackId[];
  name?: string;
}

/**
 * Put a location in slot `n`, replacing whatever was there.
 *
 * Replacing is the point: pressing store on an occupied slot in every DAW that
 * has these moves the location, it does not refuse or make a second one.  The
 * id is kept when replacing so anything holding a reference to the marker (the
 * ruler's selected marker, say) does not lose it.
 */
export function storeLocation(session: DawSession, slot: number, req: StoreRequest): DawSession {
  if (!isSlot(slot)) return session;
  const markers = markersOf(session);
  const existing = markers.find((m) => m.slot === slot);
  const start = Math.max(0, req.timeSec);
  const end = req.endSec !== undefined ? Math.max(0, req.endSec) : undefined;

  const marker: Marker = {
    id: existing?.id ?? nextId('mem'),
    name: req.name?.trim() || defaultName(slot, start, end),
    timeSec: start,
    slot,
  };
  if (end !== undefined && end > start) marker.endSec = end;
  if (req.trackIds && req.trackIds.length > 0) marker.trackIds = [...req.trackIds];

  const kept = markers.filter((m) => m.slot !== slot);
  return { ...session, markers: sortMarkers([...kept, marker]) };
}

/** Empty slot `n`.  Identity when it was already empty. */
export function clearLocation(session: DawSession, slot: number): DawSession {
  if (!isSlot(slot)) return session;
  const markers = markersOf(session);
  const kept = markers.filter((m) => m.slot !== slot);
  return kept.length === markers.length ? session : { ...session, markers: kept };
}

/** Rename slot `n`.  Identity when the slot is empty or the name is unchanged. */
export function renameLocation(session: DawSession, slot: number, name: string): DawSession {
  if (!isSlot(slot)) return session;
  const trimmed = name.trim();
  if (trimmed === '') return session;
  const markers = markersOf(session);
  const existing = markers.find((m) => m.slot === slot);
  if (!existing || existing.name === trimmed) return session;
  return {
    ...session,
    markers: markers.map((m) => (m.slot === slot ? { ...m, name: trimmed } : m)),
  };
}

/**
 * What recalling slot `n` should do, or null when the slot is empty.
 *
 * Tracks that no longer exist are dropped, and a range whose tracks have ALL
 * gone recalls as a position rather than as a selection over nothing.
 */
export function recallLocation(session: DawSession, slot: number): MemoryRecall | null {
  const loc = locationAt(session, slot);
  if (!loc) return null;
  const out: MemoryRecall = { playheadSec: loc.timeSec };
  if (loc.endSec === undefined) return out;

  const live = new Set(session.tracks.map((t) => t.id));
  const trackIds = (loc.trackIds ?? []).filter((id) => live.has(id));
  if (trackIds.length === 0) return out;
  out.selection = { startSec: loc.timeSec, endSec: loc.endSec, trackIds };
  return out;
}

/** Move an existing slot to a new time, keeping its name and its range LENGTH. */
export function moveLocation(session: DawSession, slot: number, toSec: number): DawSession {
  const loc = locationAt(session, slot);
  if (!loc) return session;
  const start = Math.max(0, toSec);
  if (start === loc.timeSec) return session;
  const length = loc.endSec === undefined ? undefined : loc.endSec - loc.timeSec;
  const req: StoreRequest = { timeSec: start, name: loc.name };
  if (length !== undefined) req.endSec = start + length;
  if (loc.trackIds) req.trackIds = loc.trackIds;
  return storeLocation(session, slot, req);
}

/** Markers sorted by time, with slot order breaking a tie so the list is stable. */
function sortMarkers(markers: Marker[]): Marker[] {
  return [...markers].sort((a, b) =>
    a.timeSec - b.timeSec || (a.slot ?? MEMORY_SLOTS + 1) - (b.slot ?? MEMORY_SLOTS + 1));
}

function defaultName(slot: number, startSec: number, endSec?: number): string {
  return endSec !== undefined && endSec > startSec ? `구간 ${slot}` : `위치 ${slot}`;
}

/** One line for the toast: what was stored, or where you landed. */
export function describeLocation(loc: MemoryLocation): string {
  const at = `${loc.timeSec.toFixed(2)}s`;
  if (loc.endSec === undefined) return `${loc.slot}. ${loc.name} — ${at}`;
  const length = (loc.endSec - loc.timeSec).toFixed(2);
  const tracks = loc.trackIds?.length ?? 0;
  const on = tracks > 0 ? `, 트랙 ${tracks}개` : '';
  return `${loc.slot}. ${loc.name} — ${at} +${length}s${on}`;
}
