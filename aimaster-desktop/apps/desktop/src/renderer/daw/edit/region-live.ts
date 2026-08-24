// The third answer to the tail: don't render it, PLAY it.
//
// `region-fx.ts` bakes a chain into a clip.  That is the right answer most of
// the time — it costs nothing at playback and what you see on the timeline is
// what you get.  But it is a bake: to change one knob you re-render, and the
// processed audio has replaced the original.
//
// This is the other way, and it is how the effect is actually done on a desk:
//
//   · an aux carrying the chain, 100 % wet
//   · a send from the track to that aux
//   · the SEND automated open for the piece and shut after it
//
// The tail comes out right for free, and that is the whole point.  Shutting a
// send does not silence the aux — it stops FEEDING it — so the delay goes on
// repeating into the next phrase exactly as it would have if the chain had
// been on the track all along.  Nothing has to know how long the chain rings,
// because nothing is being cut.
//
// ── Why the aux copy is forced fully wet ─────────────────────────────────────
//
// A send is a PARALLEL path: the dry track is still playing.  If the aux's
// delay is at its usual 25 % mix, 75 % of what the aux returns is a second
// copy of the dry signal, arriving a few samples late through a different
// path.  That is a comb filter, not a delay throw.  So every device on the aux
// gets its mix control pinned to maximum — which is exactly what an engineer
// does by hand when patching a send effect, and forgetting it is the classic
// way a send bus ends up sounding thin and phasey.
//
// ── Why the send ramps instead of stepping ───────────────────────────────────
//
// The send opens and closes mid-signal.  A step from silence to unity on a
// waveform that is not at zero is a discontinuity, and a discontinuity is a
// click — on the send path, which then rings through the delay and is repeated
// for the length of the tail.  A few milliseconds of ramp at each edge costs
// nothing and removes the whole class of problem.

import {
  addTrack, createBus, createSend, createTrack, findTrack, setSend, trackClips,
} from '../model/session-ops.js';
import { ensureLane, setLanePoints } from './automation-lanes.js';
import { findPlugin } from '../engine/plugins.js';
import { canApplyRegionFx, bodyDurationSec } from './region-fx.js';
import type { ClipId, DawSession, Insert, TrackId } from '../model/types.js';

/** Send level when the throw is shut.  `laneRange` floors decibels at −60. */
export const SEND_CLOSED_DB = -60;
/** Send level when it is open. */
export const SEND_OPEN_DB = 0;
/** Ramp at each edge, in seconds. */
export const SEND_RAMP_SEC = 0.005;

/**
 * Every parameter that decides how much of a device's own output is heard.
 *
 * Devices in this repository spell it `mix` (0…1 on some, 0…100 on others) or
 * `mixPct`.  Pinning it to the parameter's declared maximum works for all
 * three without the caller having to know which.
 */
const MIX_PARAMS = ['mix', 'mixPct'] as const;

/** The same device, with its dry path removed. */
export function fullyWet(insert: Insert): Insert {
  const descriptor = findPlugin(insert.pluginId);
  if (!descriptor) return { ...insert };
  const params = { ...insert.params };
  let changed = false;
  for (const name of MIX_PARAMS) {
    const def = descriptor.params.find((p) => p.id === name);
    if (def) { params[name] = def.max; changed = true; }
  }
  // A device with no mix control — an EQ, a compressor — is already fully wet.
  return changed ? { ...insert, params } : { ...insert };
}

export interface RegionLiveResult {
  session: DawSession;
  /** The aux the chain landed on. */
  auxTrackId: TrackId;
  message: string;
}

/**
 * Wire the chain up as a live send that opens for this clip only.
 *
 * Nothing is rendered and the clip's audio is not touched: this is an
 * arrangement change, so it undoes in one step and every knob stays live.
 */
export function makeRegionLive(
  session: DawSession, trackId: TrackId, clipId: ClipId, inserts: readonly Insert[],
): RegionLiveResult {
  const guard = canApplyRegionFx(session, trackId, clipId);
  if (!guard.ok) throw new Error(guard.reason);
  const { clip } = guard;
  const live = inserts.filter((i) => !i.bypass);
  if (live.length === 0) throw new Error('걸린 플러그인이 없습니다 — 슬롯에 하나 넣으세요');

  const free = firstFreeSendSlot(session, trackId);
  if (free === null) throw new Error('센드 슬롯이 모두 찼습니다');

  // ── The aux ───────────────────────────────────────────────────────────────
  const bus = createBus(`${clip.name} 울림`);
  const aux = createTrack(`${clip.name} 울림`, 'aux', {
    input: bus.id,
    inserts: live.map((insert, index) => ({ ...fullyWet(insert), slot: index })),
  });
  let next = addTrack({ ...session, buses: [...session.buses, bus] }, aux,
    indexAfter(session, trackId));

  // ── The send ──────────────────────────────────────────────────────────────
  // Post-fader, so pulling the track down pulls its throw down with it — the
  // thing you almost always want, and the reason post-fader is the default on
  // every desk.  It starts SHUT; the lane is what opens it.
  const send = createSend(free, bus.id, { levelDb: SEND_CLOSED_DB });
  next = setSend(next, trackId, send);

  // ── The automation ────────────────────────────────────────────────────────
  const laned = ensureLane(next, trackId, { kind: 'sendLevel', sendId: send.id }, 'read');
  next = laned.session;

  const from = clip.startSec;
  const to = clip.startSec + bodyDurationSec(clip);
  // Clamped at zero so a piece that starts at the very top of the song does not
  // ask for a point at a negative time.
  const openFrom = Math.max(0, from - SEND_RAMP_SEC);
  next = setLanePoints(next, trackId, laned.laneId, [
    { timeSec: 0, value: SEND_CLOSED_DB },
    { timeSec: openFrom, value: SEND_CLOSED_DB },
    { timeSec: from, value: SEND_OPEN_DB },
    { timeSec: to, value: SEND_OPEN_DB },
    { timeSec: to + SEND_RAMP_SEC, value: SEND_CLOSED_DB },
  ]);

  const names = live.map((i) => i.label).join(' → ');
  return {
    session: next,
    auxTrackId: aux.id,
    message: `${names} 를 "${aux.name}" Aux 로 보냈습니다`
      + ` — 센드는 ${fmt(from)}–${fmt(to)} 만 열리고, 꼬리는 계속 울립니다`,
  };
}

/** Right below the track it is a send from, so the pair reads as a pair. */
function indexAfter(session: DawSession, trackId: TrackId): number | undefined {
  const at = session.tracks.findIndex((t) => t.id === trackId);
  return at === -1 ? undefined : at + 1;
}

function firstFreeSendSlot(session: DawSession, trackId: TrackId): number | null {
  const track = findTrack(session, trackId);
  if (!track) return null;
  for (let slot = 0; slot < 10; slot++) {
    if (!track.sends.some((s) => s.slot === slot)) return slot;
  }
  return null;
}

/**
 * Is this clip already being thrown to an aux?
 *
 * Pressing the button twice should not build a second aux and a second send:
 * the first thing anyone does after wiring a throw is press play, decide it is
 * too much, and press the button again.
 */
export function liveAuxFor(
  session: DawSession, trackId: TrackId, clipId: ClipId,
): TrackId | null {
  const track = findTrack(session, trackId);
  if (!track) return null;
  const clip = trackClips(track).find((c) => c.id === clipId);
  if (!clip) return null;
  const named = `${clip.name} 울림`;
  return session.tracks.find((t) => t.kind === 'aux' && t.name === named)?.id ?? null;
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}
