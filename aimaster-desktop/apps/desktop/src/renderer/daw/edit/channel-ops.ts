// Copying a channel's processing onto another channel.
//
// The gesture every mixer has and this one did not: build the vocal chain
// once, then put it on the double, the harmony and the ad-libs without
// opening ten plugin windows.
//
// What is copied is what the SIGNAL passes through.  What is not is what
// makes the channel that channel:
//
//   copied   inserts (with their settings), sends, fader, pan, the device
//            chain when there is one, the macro rack
//   not      name, colour, clips, playlists, automation, record arm, freeze,
//            group membership, VCA assignment, track delay
//
// Automation is the one worth arguing about, and it stays out: a fader move
// written against the vocal's phrasing is not a thing to paste onto the
// harmony, and pasting it silently would overwrite work with someone else's.

import { findTrack, updateTrack } from '../model/session-ops.js';
import { nextId } from '../model/ids.js';
import type {
  DawSession, DeviceGraph, Insert, MacroRack, Rack, Send, TrackId,
} from '../model/types.js';

/** A channel's processing, detached from the track it came from. */
export interface ChannelSettings {
  /** Where it came from, for the toast — not used to paste. */
  sourceName: string;
  volumeDb: number;
  pan: number;
  inserts: Insert[];
  sends: Send[];
  macros: MacroRack;
  deviceGraph: DeviceGraph | null;
  /** Racks the device graph's `rack` nodes point at — useless without them. */
  racks: Rack[];
}

/** Take a copy of a channel's processing. */
export function channelSettings(session: DawSession, trackId: TrackId): ChannelSettings | null {
  const track = findTrack(session, trackId);
  if (!track) return null;
  return {
    sourceName: track.name,
    volumeDb: track.volumeDb,
    pan: track.pan,
    inserts: track.inserts.map((i) => ({ ...i, params: { ...i.params } })),
    sends: track.sends.map((s) => ({ ...s })),
    macros: track.macros,
    deviceGraph: track.deviceGraph,
    racks: track.racks,
  };
}

export interface PasteChannelOptions {
  /** Leave the fader and pan where they are — paste the processing only. */
  keepLevels?: boolean;
}

/**
 * Put a copy onto another channel.
 *
 * Every insert and send gets a NEW id.  Pasting the objects themselves would
 * give two channels that share their inserts, and then changing a threshold
 * on one changes it on the other — the same class of bug as duplicating a
 * track by copying it, and just as slow to find.
 */
export function pasteChannelSettings(
  session: DawSession, trackId: TrackId,
  settings: ChannelSettings, options: PasteChannelOptions = {},
): DawSession {
  return updateTrack(session, trackId, (t) => ({
    ...t,
    volumeDb: options.keepLevels === true ? t.volumeDb : settings.volumeDb,
    pan: options.keepLevels === true ? t.pan : settings.pan,
    inserts: settings.inserts.map((i) => ({ ...i, id: nextId('ins'), params: { ...i.params } })),
    sends: settings.sends.map((s) => ({ ...s, id: nextId('snd') })),
    macros: settings.macros,
    deviceGraph: settings.deviceGraph,
    racks: settings.racks,
  }));
}

/** `보컬 — 인서트 3 · 센드 1` — what is on the clipboard. */
export function describeChannel(settings: ChannelSettings): string {
  const parts = [`인서트 ${settings.inserts.length}`];
  if (settings.sends.length > 0) parts.push(`센드 ${settings.sends.length}`);
  if (settings.deviceGraph) parts.push('디바이스 체인');
  return `${settings.sourceName} — ${parts.join(' · ')}`;
}
