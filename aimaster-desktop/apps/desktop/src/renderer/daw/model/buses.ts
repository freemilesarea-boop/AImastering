// Buses — naming them, folding them to mono, and taking them away again.
//
// A bus could be created and then never touched: the Mix window had a
// "+ 버스" button and nothing else, so a session accumulated `Bus 1`,
// `Bus 2`, `Bus 3` with no way to say what any of them was for and no way to
// get rid of one.  `BusDef.channels` was in the model, saved to session files
// and carried through import, and — measured through a render — did nothing
// at all: a mono bus and a stereo bus produced identical audio.
//
// The delicate one is removal.  A bus is referenced from three directions at
// once, and a session that keeps a reference to a bus that no longer exists
// is not a cosmetic problem: the engine resolves those references to nodes,
// and a track whose output points at a missing bus is a track whose audio
// goes nowhere — silently, because there is nothing to warn about at the
// moment the sound should have been there.

import type { BusId, DawSession, Track, TrackId } from './types.js';

export function renameBus(session: DawSession, busId: BusId, name: string): DawSession {
  const trimmed = name.trim();
  if (trimmed === '') return session;
  let changed = false;
  const buses = session.buses.map((b) => {
    if (b.id !== busId || b.name === trimmed) return b;
    changed = true;
    return { ...b, name: trimmed };
  });
  return changed ? { ...session, buses } : session;
}

export function setBusChannels(session: DawSession, busId: BusId, channels: 1 | 2): DawSession {
  let changed = false;
  const buses = session.buses.map((b) => {
    if (b.id !== busId || b.channels === channels) return b;
    changed = true;
    return { ...b, channels };
  });
  return changed ? { ...session, buses } : session;
}

/** Everything that would stop working if this bus went away. */
export interface BusUsage {
  /** Tracks whose OUTPUT is this bus — they would fall back to the master. */
  outputs: TrackId[];
  /** Aux tracks reading this bus — they would be left with no input. */
  inputs: TrackId[];
  /** [trackId, send slot] for every send aimed here. */
  sends: Array<[TrackId, number]>;
  /** Inserts keying their sidechain off this bus. */
  sidechains: Array<[TrackId, string]>;
}

/**
 * What points at a bus right now.
 *
 * Separate from `removeBus` so the panel can SAY what it is about to
 * disconnect before the user commits to it.  Deleting a bus is the one
 * destructive thing in this file, and the count of what it takes with it is
 * the only information that makes the choice an informed one.
 */
export function busUsage(session: DawSession, busId: BusId): BusUsage {
  const usage: BusUsage = { outputs: [], inputs: [], sends: [], sidechains: [] };
  for (const track of session.tracks) {
    if (track.output.kind === 'bus' && track.output.busId === busId) usage.outputs.push(track.id);
    if (track.input === busId) usage.inputs.push(track.id);
    for (const send of track.sends) {
      if (send.target === busId) usage.sends.push([track.id, send.slot]);
    }
    for (const insert of track.inserts) {
      if (insert.sidechainSource === busId) usage.sidechains.push([track.id, insert.id]);
    }
  }
  return usage;
}

export function busUsageCount(usage: BusUsage): number {
  return usage.outputs.length + usage.inputs.length + usage.sends.length + usage.sidechains.length;
}

/**
 * Remove a bus and every reference to it, in one step.
 *
 * One step deliberately.  Dropping the bus and cleaning up after it have to
 * land in the same session object or there is a version of the session in
 * between that is internally inconsistent — and with undo recording every
 * `apply`, "in between" is a state a user can press Ctrl+Z back into.
 *
 * Where each reference goes:
 *
 *   · a track OUTPUT becomes the master, which is the only destination that
 *     always exists.  Silence would be the alternative, and a track that goes
 *     quiet when you delete an unrelated bus is a bug report, not a feature.
 *   · an aux INPUT becomes null.  There is no sensible substitute — an aux
 *     reading some other bus at random is worse than one reading nothing —
 *     and an aux with no input is a state the model already understands.
 *   · a SEND is deleted.  A send with no target is not a send.
 *   · a SIDECHAIN key falls back to the insert's own input, which is what
 *     `sidechainSource: null` already means everywhere else.
 */
export function removeBus(session: DawSession, busId: BusId): DawSession {
  if (!session.buses.some((b) => b.id === busId)) return session;
  const tracks: Track[] = session.tracks.map((track) => {
    const outputChanges = track.output.kind === 'bus' && track.output.busId === busId;
    const inputChanges = track.input === busId;
    const sends = track.sends.filter((s) => s.target !== busId);
    const sidechainChanges = track.inserts.some((i) => i.sidechainSource === busId);
    if (!outputChanges && !inputChanges && !sidechainChanges && sends.length === track.sends.length) {
      return track;
    }
    return {
      ...track,
      output: outputChanges ? { kind: 'master' } : track.output,
      input: inputChanges ? null : track.input,
      sends,
      inserts: sidechainChanges
        ? track.inserts.map((i) => (i.sidechainSource === busId ? { ...i, sidechainSource: null } : i))
        : track.inserts,
    };
  });
  return { ...session, buses: session.buses.filter((b) => b.id !== busId), tracks };
}

/**
 * A name no other bus in the session is using.
 *
 * `Bus 3` is only free because there happen to be two buses; rename one to
 * `Bus 4` and the next "+ 버스" collides.  Counting is not naming.
 */
export function nextBusName(session: DawSession, stem = 'Bus'): string {
  const taken = new Set(session.buses.map((b) => b.name));
  for (let n = 1; ; n++) {
    const name = `${stem} ${n}`;
    if (!taken.has(name)) return name;
  }
}
