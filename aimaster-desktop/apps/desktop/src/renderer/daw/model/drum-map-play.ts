// drum-map-play.ts — the part as the instrument hears it, computed once.
//
// `applyDrumMap` walks the whole part: it has to, because a choke group
// depends on what comes NEXT, so it cannot be decided one note at a time.
// The scheduler, on the other hand, runs on every look-ahead tick.  Calling
// the first from the second would rebuild every note of every drum part
// several times a second for a result that almost never changes.
//
// So the answer is cached against the two things it depends on — the notes
// and the map — by IDENTITY, not by value.  Everything in this model is
// immutable, so a changed part is a new array and a changed kit is a new
// object; comparing references is therefore exact here, and cheap, in a way
// that comparing contents would not be.

import { applyDrumMap, type DrumMap } from './drum-map.js';
import type { MidiNote } from './midi.js';

interface Entry { map: DrumMap; played: MidiNote[] }

/**
 * Keyed by the notes array so a part that is dropped from the session takes
 * its cache entry with it.  Nothing here needs clearing by hand.
 */
const cache = new WeakMap<readonly MidiNote[], Entry>();

/**
 * The notes to play: out-pitches applied, muted slots gone, chokes honoured.
 *
 * `null` for a map means the track has no kit, and the notes are handed back
 * UNCHANGED and by the same reference — a non-drum track must not pay for
 * this, and must not have anything applied to it.
 */
export function playedNotes(
  map: DrumMap | null, notes: readonly MidiNote[],
): readonly MidiNote[] {
  if (!map) return notes;
  const hit = cache.get(notes);
  if (hit && hit.map === map) return hit.played;
  const played = applyDrumMap(map, notes);
  cache.set(notes, { map, played });
  return played;
}

/** For tests: prove the cache is a cache and not a source of truth. */
export function cachedFor(notes: readonly MidiNote[]): readonly MidiNote[] | null {
  return cache.get(notes)?.played ?? null;
}
