// Mixer arithmetic — gain, pan law, solo state, groups and VCA folding.
//
// The engine asks this module "what gain should this channel be at right
// now"; the Mix window asks it "what should this fader read".  Both get the
// same answer because there is exactly one implementation.

import type { DawSession, GroupDef, Track, TrackId } from './types.js';
import { findTrack, updateTrack } from './session-ops.js';

export const MIN_FADER_DB = -Infinity;

export function dbToGain(db: number): number {
  return db <= -144 ? 0 : Math.pow(10, db / 20);
}

export function gainToDb(gain: number): number {
  return gain <= 1e-7 ? -Infinity : 20 * Math.log10(gain);
}

// ── Pan ───────────────────────────────────────────────────────────────────────

export type PanLaw = 'equalPower' | 'linear';

/** Stereo gains for a pan position in [-1, +1]. */
export function panGains(pan: number, law: PanLaw = 'equalPower'): { left: number; right: number } {
  const p = Math.max(-1, Math.min(1, pan));
  // Linear law: -6 dB at centre.
  if (law === 'linear') return { left: (1 - p) / 2, right: (1 + p) / 2 };
  // Equal power: -3 dB at centre, constant perceived loudness across the sweep.
  const angle = (p + 1) * (Math.PI / 4);
  return { left: Math.cos(angle), right: Math.sin(angle) };
}

// ── VCA ───────────────────────────────────────────────────────────────────────

/**
 * Total dB contributed by the VCA chain above a track.  VCAs may be nested
 * (a VCA assigned to another VCA); a cycle stops the walk instead of hanging.
 */
export function vcaChainDb(session: DawSession, track: Track): number {
  let db = 0;
  const seen = new Set<TrackId>([track.id]);
  let current: Track | undefined = track.vcaId ? findTrack(session, track.vcaId) : undefined;
  while (current && current.kind === 'vca' && !seen.has(current.id)) {
    seen.add(current.id);
    db += current.volumeDb;
    current = current.vcaId ? findTrack(session, current.vcaId) : undefined;
  }
  return db;
}

/** The fader value the engine should apply: channel fader folded with VCAs. */
export function effectiveFaderDb(session: DawSession, track: Track, automationDb?: number): number {
  const base = automationDb ?? track.volumeDb;
  return base + vcaChainDb(session, track);
}

// ── Solo / mute ───────────────────────────────────────────────────────────────

export function anySoloActive(session: DawSession): boolean {
  return session.tracks.some((t) => t.solo && t.kind !== 'master' && t.kind !== 'vca');
}

/**
 * Solo-in-place: while anything is soloed, every other audio/aux channel is
 * implicitly muted unless it is solo-safed.  Master and VCA channels are
 * never implicitly muted (a VCA mutes its members through its own mute).
 */
export function isImplicitlyMuted(session: DawSession, track: Track): boolean {
  if (track.kind === 'master' || track.kind === 'vca') return false;
  if (!anySoloActive(session)) return false;
  return !track.solo && !track.soloSafe;
}

/** VCA mute propagates to members, exactly like a VCA fader pulled to -∞. */
export function isMutedByVca(session: DawSession, track: Track): boolean {
  const seen = new Set<TrackId>([track.id]);
  let current: Track | undefined = track.vcaId ? findTrack(session, track.vcaId) : undefined;
  while (current && !seen.has(current.id)) {
    if (current.mute) return true;
    seen.add(current.id);
    current = current.vcaId ? findTrack(session, current.vcaId) : undefined;
  }
  return false;
}

/** Everything folded: does this channel pass audio right now? */
export function isAudible(session: DawSession, track: Track): boolean {
  if (track.mute) return false;
  if (isMutedByVca(session, track)) return false;
  if (isImplicitlyMuted(session, track)) return false;
  return true;
}

// ── Groups ────────────────────────────────────────────────────────────────────

export function enabledGroupsFor(session: DawSession, trackId: TrackId): GroupDef[] {
  return session.groups.filter((g) => g.enabled && g.memberIds.includes(trackId));
}

/** Every track that moves when `trackId` moves, including itself. */
export function linkedMembers(
  session: DawSession, trackId: TrackId, control: 'volume' | 'mute' | 'solo' | 'pan',
): TrackId[] {
  const linked = new Set<TrackId>([trackId]);
  for (const g of enabledGroupsFor(session, trackId)) {
    const on = control === 'volume' ? g.linkVolume
      : control === 'mute' ? g.linkMute
      : control === 'solo' ? g.linkSolo
      : g.linkPan;
    if (!on) continue;
    for (const m of g.memberIds) linked.add(m);
  }
  return [...linked];
}

/**
 * Move a fader with its group.  Group moves are RELATIVE: the offsets the
 * engineer dialled between members survive the move.
 */
export function setVolumeDb(session: DawSession, trackId: TrackId, db: number): DawSession {
  const track = findTrack(session, trackId);
  if (!track) return session;
  const delta = db - track.volumeDb;
  let out = session;
  for (const id of linkedMembers(session, trackId, 'volume')) {
    out = updateTrack(out, id, (t) => ({
      ...t,
      volumeDb: id === trackId ? db : t.volumeDb + delta,
    }));
  }
  return out;
}

export function setPan(session: DawSession, trackId: TrackId, pan: number): DawSession {
  const clamped = Math.max(-1, Math.min(1, pan));
  const track = findTrack(session, trackId);
  if (!track) return session;
  const delta = clamped - track.pan;
  let out = session;
  for (const id of linkedMembers(session, trackId, 'pan')) {
    out = updateTrack(out, id, (t) => ({
      ...t,
      pan: id === trackId ? clamped : Math.max(-1, Math.min(1, t.pan + delta)),
    }));
  }
  return out;
}

export function toggleMute(session: DawSession, trackId: TrackId): DawSession {
  const track = findTrack(session, trackId);
  if (!track) return session;
  const next = !track.mute;
  let out = session;
  for (const id of linkedMembers(session, trackId, 'mute')) {
    out = updateTrack(out, id, (t) => ({ ...t, mute: next }));
  }
  return out;
}

export function toggleSolo(session: DawSession, trackId: TrackId): DawSession {
  const track = findTrack(session, trackId);
  if (!track) return session;
  const next = !track.solo;
  let out = session;
  for (const id of linkedMembers(session, trackId, 'solo')) {
    out = updateTrack(out, id, (t) => ({ ...t, solo: next }));
  }
  return out;
}

export function clearAllSolo(session: DawSession): DawSession {
  if (!session.tracks.some((t) => t.solo)) return session;
  return { ...session, tracks: session.tracks.map((t) => (t.solo ? { ...t, solo: false } : t)) };
}

export function clearAllMute(session: DawSession): DawSession {
  if (!session.tracks.some((t) => t.mute)) return session;
  return { ...session, tracks: session.tracks.map((t) => (t.mute ? { ...t, mute: false } : t)) };
}
