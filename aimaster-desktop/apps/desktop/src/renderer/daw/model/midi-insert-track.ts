// midi-insert-track.ts — where a chain lives, and what it costs to read it.
//
// The chain is per TRACK rather than per part, because it is a property of
// the instrument setup: the arp belongs to the pad patch, not to bar 17.
// Moving a part to another track should change what it plays through, and it
// does.
//
// The caching here is the same shape as the drum map's and for the same
// reason: `runChain` walks the whole part (an arpeggiator has to — a step
// depends on the chord around it) while the scheduler runs on every
// look-ahead tick.  Identity comparison is exact in this codebase because
// nothing mutates in place.

import { chainIsEmpty, runChain, type MidiInsert } from './midi-insert.js';
import type { MidiNote, Track } from './types.js';

export function midiInsertsOf(track: Track | undefined | null): MidiInsert[] {
  const raw = (track as { midiInserts?: MidiInsert[] } | null | undefined)?.midiInserts;
  return Array.isArray(raw) ? raw : [];
}

export function trackHasInserts(track: Track | undefined | null): boolean {
  return !chainIsEmpty(midiInsertsOf(track));
}

export function setMidiInserts(track: Track, chain: readonly MidiInsert[]): Track {
  return { ...track, midiInserts: [...chain] };
}

interface Entry { chain: readonly MidiInsert[]; played: MidiNote[]; overflowed: boolean }
const cache = new WeakMap<readonly MidiNote[], Entry>();

export interface InsertedPart {
  notes: readonly MidiNote[];
  /** True when the note ceiling stopped the chain — worth saying out loud. */
  overflowed: boolean;
}

/**
 * The notes the instrument should hear.
 *
 * A track with no chain gets its notes back BY REFERENCE and pays nothing —
 * most tracks have no chain and must not be charged for the feature.
 */
export function insertedNotes(
  chain: readonly MidiInsert[], notes: readonly MidiNote[],
): InsertedPart {
  if (chainIsEmpty(chain)) return { notes, overflowed: false };
  const hit = cache.get(notes);
  // The chain array is rebuilt on every edit, so its identity is the version.
  if (hit && hit.chain === chain) return { notes: hit.played, overflowed: hit.overflowed };
  const result = runChain(notes, chain);
  cache.set(notes, { chain, played: result.notes, overflowed: result.overflowed });
  return { notes: result.notes, overflowed: result.overflowed };
}

/** For tests: prove the cache is a cache and not a source of truth. */
export function cachedInsertsFor(notes: readonly MidiNote[]): readonly MidiNote[] | null {
  return cache.get(notes)?.played ?? null;
}
