// mix-snapshot.ts — the whole mixer, saved, so you can go back to it.
//
// Undo goes backwards one step at a time.  A/B is a different question: "is
// the version I had twenty minutes ago better than this one?"  Twenty presses
// of Mod+Z is not an answer, because by the time you get there you cannot
// remember what the other one sounded like.
//
// A snapshot is the MIXER only — faders, pans, mutes, solos, inserts, sends,
// routing.  Not the clips, not the automation lanes, not the arrangement.
// That boundary is the whole point: comparing two mixes of the same edit is
// the comparison people want, and a snapshot that also rolled back an edit
// would make the two versions differ in a way nobody asked about.
//
// Automation is the one hard call.  It is arguably part of a mix — a fader
// ride IS the mix — but a lane is written against clips at particular times,
// and restoring a lane onto an edit that has moved since produces a ride that
// fights the music.  So automation stays put, and the snapshot says so rather
// than pretending it captured everything.

import type { DawSession, Insert, OutputTarget, Send, TrackId } from './types.js';
import { updateTrack } from './session-ops.js';

/** One channel's worth of mixer state. */
export interface ChannelSnapshot {
  trackId: TrackId;
  /** Kept so a snapshot taken before a rename still reads as the right channel. */
  name: string;
  volumeDb: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  soloSafe: boolean;
  inserts: Insert[];
  sends: Send[];
  output: OutputTarget;
  input: string | null;
}

export interface MixSnapshot {
  id: string;
  name: string;
  /** Epoch ms, so the list can say "12 minutes ago". */
  takenAt: number;
  channels: ChannelSnapshot[];
}

export const MAX_SNAPSHOTS = 12;

/** Everything the mixer is right now. */
export function takeSnapshot(session: DawSession, name: string, id: string): MixSnapshot {
  return {
    id,
    name: name.trim() || `스냅샷 ${new Date().toLocaleTimeString('ko-KR')}`,
    takenAt: Date.now(),
    channels: session.tracks.map((t) => ({
      trackId: t.id,
      name: t.name,
      volumeDb: t.volumeDb,
      pan: t.pan,
      mute: t.mute,
      solo: t.solo,
      soloSafe: t.soloSafe,
      // Deep-copied: an insert list shared with the live session would make
      // the snapshot follow every later edit, which is the one thing it must
      // not do.
      inserts: t.inserts.map((i) => ({ ...i, params: { ...i.params } })),
      sends: t.sends.map((s) => ({ ...s })),
      output: { ...t.output },
      input: t.input,
    })),
  };
}

export interface RestoreResult {
  session: DawSession;
  /** Channels restored. */
  restored: number;
  /** Channels in the snapshot that no longer exist. */
  gone: string[];
  /** Channels in the session the snapshot never had. */
  added: string[];
}

/**
 * Put a snapshot back.
 *
 * Matched by track ID, not by name or position: a rename must not lose the
 * channel, and inserting a track above must not shift every restore down one.
 * Channels the snapshot does not know are LEFT ALONE rather than reset — a
 * track added since is not part of what was saved, and zeroing it would be
 * inventing a decision the snapshot never made.
 */
export function restoreSnapshot(session: DawSession, snapshot: MixSnapshot): RestoreResult {
  const byId = new Map(snapshot.channels.map((c) => [c.trackId, c]));
  const live = new Set(session.tracks.map((t) => t.id));

  let out = session;
  let restored = 0;
  for (const channel of snapshot.channels) {
    if (!live.has(channel.trackId)) continue;
    restored++;
    out = updateTrack(out, channel.trackId, (t) => ({
      ...t,
      volumeDb: channel.volumeDb,
      pan: channel.pan,
      mute: channel.mute,
      solo: channel.solo,
      soloSafe: channel.soloSafe,
      inserts: channel.inserts.map((i) => ({ ...i, params: { ...i.params } })),
      sends: channel.sends.map((s) => ({ ...s })),
      output: { ...channel.output },
      input: channel.input,
    }));
  }

  return {
    session: out,
    restored,
    gone: snapshot.channels.filter((c) => !live.has(c.trackId)).map((c) => c.name),
    added: session.tracks.filter((t) => !byId.has(t.id)).map((t) => t.name),
  };
}

/** Add a snapshot, dropping the oldest past the cap. */
export function pushSnapshot(
  snapshots: readonly MixSnapshot[], snapshot: MixSnapshot,
): MixSnapshot[] {
  const next = [...snapshots, snapshot];
  return next.length > MAX_SNAPSHOTS ? next.slice(next.length - MAX_SNAPSHOTS) : next;
}

export function removeSnapshot(snapshots: readonly MixSnapshot[], id: string): MixSnapshot[] {
  return snapshots.filter((s) => s.id !== id);
}

export interface SnapshotDiff {
  /** Channels whose fader, pan, mute, solo or safe differ. */
  levels: string[];
  /** Channels whose insert chain differs. */
  inserts: string[];
  /** Channels whose sends or routing differ. */
  routing: string[];
  /** True when nothing at all differs. */
  same: boolean;
}

/**
 * What a snapshot would change, before it changes it.
 *
 * The point of A/B is knowing WHAT is different, not just that something is —
 * "restore" with no preview is a coin flip you cannot undo by ear.
 */
export function diffSnapshot(session: DawSession, snapshot: MixSnapshot): SnapshotDiff {
  const byId = new Map(snapshot.channels.map((c) => [c.trackId, c]));
  const levels: string[] = [], inserts: string[] = [], routing: string[] = [];

  for (const track of session.tracks) {
    const c = byId.get(track.id);
    if (!c) continue;
    if (track.volumeDb !== c.volumeDb || track.pan !== c.pan
      || track.mute !== c.mute || track.solo !== c.solo || track.soloSafe !== c.soloSafe) {
      levels.push(track.name);
    }
    if (!same(track.inserts, c.inserts)) inserts.push(track.name);
    if (!same(track.sends, c.sends) || !same(track.output, c.output) || track.input !== c.input) {
      routing.push(track.name);
    }
  }
  return {
    levels, inserts, routing,
    same: levels.length === 0 && inserts.length === 0 && routing.length === 0,
  };
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try { return JSON.stringify(a ?? null) === JSON.stringify(b ?? null); }
  catch { return false; }
}

export function describeSnapshot(diff: SnapshotDiff): string {
  if (diff.same) return '지금 믹스와 같습니다';
  const parts: string[] = [];
  if (diff.levels.length) parts.push(`레벨 ${diff.levels.length}개`);
  if (diff.inserts.length) parts.push(`인서트 ${diff.inserts.length}개`);
  if (diff.routing.length) parts.push(`라우팅 ${diff.routing.length}개`);
  return `${parts.join(' · ')} 다름 — 오토메이션은 그대로 둡니다`;
}
