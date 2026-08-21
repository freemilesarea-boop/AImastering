// What a track can automate, and what each of those things means.
//
// The model in `model/automation.ts` knows how to interpolate and write
// breakpoints; it deliberately does not know that a volume breakpoint is
// decibels between −60 and +12, or that a plugin lane's range lives inside a
// device descriptor.  That knowledge is here, in one place, because three
// parts of the app need exactly the same answer and any disagreement between
// them shows up as a lane drawn at one scale and played back at another:
//
//   the lane UI      to place a breakpoint on a canvas
//   the recorder     to clamp and thin a captured gesture
//   the engine       to know what the number it reads actually is
//
// Everything here is a pure function of the session.

import {
  findLane, sortPoints, targetKey,
} from '../model/automation.js';
import { descriptorFor } from '../engine/external-device.js';
import type { PluginParamDef } from '../engine/plugin-kit.js';
import { nextId } from '../model/ids.js';
import type {
  AutomationLane, AutomationMode, AutomationTarget, DawSession, Track, TrackId,
} from '../model/types.js';
import { updateTrack } from '../model/session-ops.js';
import { setPan, setVolumeDb } from '../model/mixer-math.js';

export interface LaneRange {
  min: number;
  max: number;
  /** Where the lane's "nothing" sits — the line drawn across the middle. */
  neutral: number;
  unit: string;
  /** Two breakpoints closer than this in value are the same move. */
  thinTolerance: number;
  /** A lane whose value only ever steps, never ramps. */
  stepped: boolean;
}

const DB_RANGE: LaneRange = {
  min: -60, max: 12, neutral: 0, unit: 'dB', thinTolerance: 0.15, stepped: false,
};
const PAN_RANGE: LaneRange = {
  min: -1, max: 1, neutral: 0, unit: '', thinTolerance: 0.01, stepped: false,
};
const SWITCH_RANGE: LaneRange = {
  min: 0, max: 1, neutral: 0, unit: '', thinTolerance: 0.4, stepped: true,
};

/** How to read and draw a target's numbers. */
export function laneRange(track: Track, target: AutomationTarget): LaneRange {
  switch (target.kind) {
    case 'volume':
    case 'sendLevel':
      return DB_RANGE;
    case 'pan':
    case 'sendPan':
      return PAN_RANGE;
    case 'mute':
    case 'sendMute':
      return SWITCH_RANGE;
    case 'plugin': {
      const insert = track.inserts.find((i) => i.id === target.insertId);
      const def = insert && descriptorFor(insert)?.params.find((p) => p.id === target.paramId);
      if (!def) return { ...PAN_RANGE, min: 0, max: 1, neutral: 0 };
      const span = def.max - def.min;
      return {
        min: def.min,
        max: def.max,
        neutral: def.default,
        unit: def.unit,
        // A knob's worth of tolerance, not a fixed number: a 0.15 tolerance is
        // right for decibels and meaningless on a 0…1 mix control.
        thinTolerance: Math.max(1e-6, span * 0.004),
        stepped: def.choices !== undefined,
      };
    }
  }
}

export function clampToRange(range: LaneRange, value: number): number {
  const v = Math.max(range.min, Math.min(range.max, value));
  return range.stepped ? Math.round(v) : v;
}

/** The name shown on the lane, in the user's language. */
export function describeTarget(track: Track, target: AutomationTarget): string {
  switch (target.kind) {
    case 'volume': return '볼륨';
    case 'pan':    return '팬';
    case 'mute':   return '뮤트';
    case 'sendLevel':
    case 'sendPan':
    case 'sendMute': {
      const send = track.sends.find((s) => s.id === target.sendId);
      const slot = send ? String.fromCharCode(65 + send.slot) : '?';
      const what = target.kind === 'sendLevel' ? '레벨'
        : target.kind === 'sendPan' ? '팬' : '뮤트';
      return `센드 ${slot} ${what}`;
    }
    case 'plugin': {
      const insert = track.inserts.find((i) => i.id === target.insertId);
      if (!insert) return '플러그인 (없음)';
      const descriptor = descriptorFor(insert);
      const param = descriptor?.params.find((p) => p.id === target.paramId);
      const slot = String.fromCharCode(65 + insert.slot);
      return `${slot} ${descriptor?.name ?? insert.label} · ${param?.name ?? target.paramId}`;
    }
  }
}

/**
 * Every parameter of one insert that can carry a lane.
 *
 * A device declares this, because the answer is "is there exactly one
 * AudioParam behind it".  A parameter that rebuilds an impulse response or
 * splits across two gains cannot be ramped, and offering it would draw a
 * beautiful lane that does nothing.
 */
export function automatableParamsOf(insert: Track['inserts'][number]): PluginParamDef[] {
  const descriptor = descriptorFor(insert);
  const allowed = descriptor?.automatableParams;
  if (!descriptor || !allowed || allowed.length === 0) return [];
  const set = new Set(allowed);
  return descriptor.params.filter((p) => set.has(p.id));
}

/**
 * What this track can automate today, in the order a channel is read.
 *
 * Deliberately only the targets the ENGINE PLAYS BACK.  `AutomationTarget`
 * has more members — mute, send pan — and a lane for one of those would draw
 * beautifully and do nothing, which is the worst outcome available: you would
 * spend an afternoon wondering why the move you drew has no effect.
 *
 * Plugin parameters are now here too, but only the ones the device says are a
 * single AudioParam: those take the same ramp as the fader, on the same clock,
 * through the same code — which is why a bounce reproduces them.  The rest of
 * a device's knobs are simply absent from the menu.
 */
export function availableTargets(track: Track): AutomationTarget[] {
  const out: AutomationTarget[] = [{ kind: 'volume' }, { kind: 'pan' }];
  for (const send of [...track.sends].sort((a, b) => a.slot - b.slot)) {
    out.push({ kind: 'sendLevel', sendId: send.id });
  }
  // In chain order, so the menu reads down the channel the way the signal does.
  for (const insert of [...track.inserts].sort((a, b) => a.slot - b.slot)) {
    for (const param of automatableParamsOf(insert)) {
      out.push({ kind: 'plugin', insertId: insert.id, paramId: param.id });
    }
  }
  return out;
}

/**
 * True when the engine will actually reproduce a lane for this target.
 *
 * For a plugin lane this needs the TRACK, because the answer depends on which
 * device is in that slot: the same lane is playable before someone swaps the
 * insert and dead afterwards, and saying so is better than pretending.
 */
export function isPlayable(target: AutomationTarget, track?: Track): boolean {
  if (target.kind === 'volume' || target.kind === 'pan' || target.kind === 'sendLevel') {
    return true;
  }
  if (target.kind !== 'plugin') return false;
  if (!track) return false;
  const insert = track.inserts.find((i) => i.id === target.insertId);
  if (!insert) return false;
  return automatableParamsOf(insert).some((p) => p.id === target.paramId);
}

/**
 * The value the channel has right now, ignoring automation.
 *
 * This is the `fallback` every read and write in the model takes: an empty
 * lane means "whatever the control is set to", and a gesture that begins
 * before any lane exists begins from here.
 */
export function staticValue(track: Track, target: AutomationTarget): number {
  switch (target.kind) {
    case 'volume': return track.volumeDb;
    case 'pan':    return track.pan;
    case 'mute':   return track.mute ? 1 : 0;
    case 'sendLevel': return track.sends.find((s) => s.id === target.sendId)?.levelDb ?? 0;
    case 'sendPan':   return track.sends.find((s) => s.id === target.sendId)?.pan ?? 0;
    case 'sendMute':  return track.sends.find((s) => s.id === target.sendId)?.mute ? 1 : 0;
    case 'plugin': {
      const insert = track.inserts.find((i) => i.id === target.insertId);
      if (!insert) return 0;
      const fromSession = insert.params[target.paramId];
      if (typeof fromSession === 'number') return fromSession;
      const def = descriptorFor(insert)?.params.find((p) => p.id === target.paramId);
      return def?.default ?? 0;
    }
  }
}

/**
 * Move the control itself.
 *
 * While a pass is being recorded the fader has to follow the hand — you are
 * listening to the move you are making, not to the lane you are writing.  So
 * a gesture writes the static value on every sample and the lane only at the
 * end, and this is the one function that knows how to set each kind.
 */
export function setStaticValue(
  session: DawSession, trackId: TrackId, target: AutomationTarget, value: number,
): DawSession {
  const found = session.tracks.find((t) => t.id === trackId);
  if (!found) return session;
  const clamped = clampToRange(laneRange(found, target), value);

  // Volume and pan go through the mixer's own setters, because a fader in a
  // group does not move alone: the members move with it, keeping their
  // offsets.  Writing `volumeDb` directly here would silently break grouping
  // for exactly the case this file exists to serve — a fader being ridden.
  if (target.kind === 'volume') return setVolumeDb(session, trackId, clamped);
  if (target.kind === 'pan') return setPan(session, trackId, clamped);

  return updateTrack(session, trackId, (track) => {
    const v = clampToRange(laneRange(track, target), value);
    switch (target.kind) {
      case 'mute':   return { ...track, mute: v >= 0.5 };
      case 'sendLevel':
      case 'sendPan':
      case 'sendMute':
        return {
          ...track,
          sends: track.sends.map((send) => {
            if (send.id !== target.sendId) return send;
            if (target.kind === 'sendLevel') return { ...send, levelDb: v };
            if (target.kind === 'sendPan') return { ...send, pan: v };
            return { ...send, mute: v >= 0.5 };
          }),
        };
      case 'plugin':
        return {
          ...track,
          inserts: track.inserts.map((insert) => (insert.id === target.insertId
            ? { ...insert, params: { ...insert.params, [target.paramId]: v } }
            : insert)),
        };
    }
  });
}

/**
 * The lane for a target, creating it if the track has none.
 *
 * A new lane starts at the control's current value rather than empty: an empty
 * lane and a lane holding the current value read back the same, but the
 * one-point lane draws as a flat line at the right height, which is what
 * somebody who just opened it expects to see.
 */
export function ensureLane(
  session: DawSession, trackId: TrackId, target: AutomationTarget,
  mode: AutomationMode = 'read',
): { session: DawSession; laneId: string } {
  const track = session.tracks.find((t) => t.id === trackId);
  if (!track) return { session, laneId: '' };
  const existing = findLane(track.automation, target);
  if (existing) return { session, laneId: existing.id };

  const lane: AutomationLane = {
    id: nextId('lane'),
    target,
    mode,
    points: [{ timeSec: 0, value: staticValue(track, target) }],
    visible: true,
  };
  return {
    session: updateTrack(session, trackId, (t) => ({ ...t, automation: [...t.automation, lane] })),
    laneId: lane.id,
  };
}

/** Show a lane (creating it if needed) or hide it again. */
export function setLaneVisible(
  session: DawSession, trackId: TrackId, target: AutomationTarget, visible: boolean,
): DawSession {
  if (!visible) {
    return updateTrack(session, trackId, (t) => ({
      ...t,
      automation: t.automation.map((lane) => (
        targetKey(lane.target) === targetKey(target) ? { ...lane, visible: false } : lane)),
    }));
  }
  const created = ensureLane(session, trackId, target);
  return updateTrack(created.session, trackId, (t) => ({
    ...t,
    automation: t.automation.map((lane) => (
      targetKey(lane.target) === targetKey(target) ? { ...lane, visible: true } : lane)),
  }));
}

/** The lanes a track is currently showing, in the order targets are listed. */
export function visibleLanes(track: Track): AutomationLane[] {
  const order = availableTargets(track).map(targetKey);
  return track.automation
    .filter((lane) => lane.visible)
    .sort((a, b) => {
      const ai = order.indexOf(targetKey(a.target));
      const bi = order.indexOf(targetKey(b.target));
      return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
    });
}

/** Replace a lane's points wholesale, keeping them sorted. */
export function setLanePoints(
  session: DawSession, trackId: TrackId, laneId: string,
  points: AutomationLane['points'],
): DawSession {
  return updateTrack(session, trackId, (t) => ({
    ...t,
    automation: t.automation.map((lane) => (
      lane.id === laneId ? { ...lane, points: sortPoints(points) } : lane)),
  }));
}
