// Auto automation — the fader moves an engineer would have drawn.
//
// Two jobs, both of which are mechanical enough to compute and tedious enough
// that nobody enjoys doing them by hand:
//
//   RIDING   a vocal that wanders 6 dB across a verse gets nudged back toward
//            its own average, so a compressor does not have to do the whole
//            job by squashing.
//   DUCKING  the bass steps aside for every kick, printed as automation rather
//            than done live by a sidechain compressor.
//
// Why automation instead of a compressor for both?  Because automation is
// VISIBLE and EDITABLE.  A compressor's decisions are invisible and re-made on
// every render; a drawn curve can be looked at, disagreed with, and nudged.
// The engine already has sidechain compression for the cases where a live
// reaction is what you want — this is the other tool.
//
// Three rules keep the curves musical:
//
//   • Bounded.  A ride never moves more than `maxMoveDb`; a runaway ride is
//     worse than no ride.
//   • Slew-limited.  The curve cannot move faster than `maxSlewDbPerSec`, so
//     it rides the phrase rather than the syllable.
//   • Thinned.  Points that lie on the line between their neighbours are
//     dropped, so the lane is editable by hand afterwards.

import { thinPoints } from '../model/automation.js';
import type { AutomationPoint, TrackId } from '../model/types.js';
import type { IntelAction, Suggestion } from './actions.js';

export interface Envelope {
  /** One value per hop, in dB. */
  db: Float32Array;
  hopSec: number;
}

/** Short-window RMS in dB — the level the ride is reacting to. */
export function levelEnvelope(
  samples: Float32Array, sampleRate: number, windowSec = 0.25,
): Envelope {
  const hop = Math.max(1, Math.round(windowSec * sampleRate * 0.5));
  const window = Math.max(hop, Math.round(windowSec * sampleRate));
  const frames = Math.max(1, Math.floor(samples.length / hop));
  const db = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const centre = f * hop;
    const from = Math.max(0, centre - (window >> 1));
    const to = Math.min(samples.length, centre + (window >> 1));
    let sum = 0;
    for (let i = from; i < to; i++) sum += (samples[i] ?? 0) ** 2;
    const rms = Math.sqrt(sum / Math.max(1, to - from));
    db[f] = rms > 1e-7 ? 20 * Math.log10(rms) : -120;
  }
  return { db, hopSec: hop / sampleRate };
}

export interface RideOptions {
  /** Largest correction in either direction, dB. */
  maxMoveDb?: number;
  /** How fast the curve may move.  Low values ride phrases, not syllables. */
  maxSlewDbPerSec?: number;
  /** Level below this is silence and is not ridden. */
  floorDb?: number;
  /** 0…1 — how much of the deviation to correct. */
  amount?: number;
  /** Thinning tolerance, dB. */
  toleranceDb?: number;
}

const RIDE_DEFAULTS = {
  maxMoveDb: 4, maxSlewDbPerSec: 6, floorDb: -50, amount: 0.7, toleranceDb: 0.25,
};

/**
 * Compute the ride curve for one track's envelope.
 *
 * The target is the track's OWN median level, not an absolute one: the job is
 * to make a performance consistent with itself, and an absolute target would
 * simply be a fader move.
 */
export function rideCurve(
  envelope: Envelope, options: RideOptions = {},
): AutomationPoint[] {
  const maxMove = options.maxMoveDb ?? RIDE_DEFAULTS.maxMoveDb;
  const slew = options.maxSlewDbPerSec ?? RIDE_DEFAULTS.maxSlewDbPerSec;
  const floor = options.floorDb ?? RIDE_DEFAULTS.floorDb;
  const amount = Math.max(0, Math.min(1, options.amount ?? RIDE_DEFAULTS.amount));
  const tolerance = options.toleranceDb ?? RIDE_DEFAULTS.toleranceDb;

  const audible: number[] = [];
  for (let i = 0; i < envelope.db.length; i++) {
    const v = envelope.db[i] ?? -120;
    if (v > floor) audible.push(v);
  }
  if (audible.length < 4) return [];
  audible.sort((a, b) => a - b);
  const median = audible[Math.floor(audible.length / 2)] ?? 0;

  const maxStep = slew * envelope.hopSec;
  const points: AutomationPoint[] = [];
  let current = 0;

  for (let f = 0; f < envelope.db.length; f++) {
    const level = envelope.db[f] ?? -120;
    // Silence holds the last position instead of diving — a ride that dips
    // between phrases pumps the room tone.
    const wanted = level > floor
      ? Math.max(-maxMove, Math.min(maxMove, (median - level) * amount))
      : current;
    current += Math.max(-maxStep, Math.min(maxStep, wanted - current));
    points.push({ timeSec: f * envelope.hopSec, value: current });
  }

  return thinPoints(points, tolerance);
}

/** Volume automation is written in dB, relative to the fader. */
export function rideSuggestion(
  trackId: TrackId, trackName: string, faderDb: number, points: readonly AutomationPoint[],
): Suggestion | null {
  if (points.length < 2) return null;
  const values = points.map((p) => p.value);
  const range = Math.max(...values) - Math.min(...values);
  if (range < 0.5) return null;
  return {
    id: `ride:${trackId}`,
    title: `${trackName} 볼륨 라이딩 — ${range.toFixed(1)} dB 범위, ${points.length}포인트`,
    reason: '트랙 자기 자신의 중앙값을 기준으로 흔들림만 되돌립니다.'
      + ' 컴프레서와 달리 곡선이 보이고, 마음에 안 들면 손으로 고칠 수 있습니다.',
    confidence: 0.6,
    actions: [{
      kind: 'automation',
      trackId,
      target: { kind: 'volume' },
      mode: 'read',
      points: points.map((p) => ({ timeSec: p.timeSec, value: faderDb + p.value })),
    }],
  };
}

// ── Ducking ───────────────────────────────────────────────────────────────────

export interface DuckOptions {
  /** How far the target drops at each trigger, dB. */
  depthDb?: number;
  /** Time to reach the bottom. */
  attackSec?: number;
  /** Time to come back. */
  releaseSec?: number;
  /** Triggers closer together than this are treated as one. */
  minSpacingSec?: number;
}

const DUCK_DEFAULTS = { depthDb: 4, attackSec: 0.01, releaseSec: 0.18, minSpacingSec: 0.08 };

/**
 * Build a ducking curve from trigger times.
 *
 * Each trigger writes four points: back up before it, down at it, held for the
 * attack, then back up over the release.  Overlapping ducks merge — a
 * sixteenth-note kick pattern must not produce a curve that never recovers.
 */
export function duckCurve(
  triggers: readonly number[], durationSec: number, options: DuckOptions = {},
): AutomationPoint[] {
  const depth = -Math.abs(options.depthDb ?? DUCK_DEFAULTS.depthDb);
  const attack = Math.max(0.001, options.attackSec ?? DUCK_DEFAULTS.attackSec);
  const release = Math.max(0.01, options.releaseSec ?? DUCK_DEFAULTS.releaseSec);
  const minSpacing = options.minSpacingSec ?? DUCK_DEFAULTS.minSpacingSec;

  const hits: number[] = [];
  for (const t of [...triggers].sort((a, b) => a - b)) {
    if (t < 0 || t > durationSec) continue;
    const previous = hits[hits.length - 1];
    if (previous !== undefined && t - previous < minSpacing) continue;
    hits.push(t);
  }
  if (hits.length === 0) return [];

  const points: AutomationPoint[] = [{ timeSec: 0, value: 0 }];
  hits.forEach((hit, index) => {
    const next = hits[index + 1];
    // The recovery is cut short when the next hit arrives first — otherwise
    // the curve would climb through a duck that has already started.
    const recovery = Math.min(release, next === undefined ? release : Math.max(0.01, next - hit - attack));
    const before = Math.max(0, hit - attack);
    if (before > (points[points.length - 1]?.timeSec ?? 0)) {
      points.push({ timeSec: before, value: 0 });
    }
    points.push({ timeSec: hit, value: depth });
    points.push({ timeSec: Math.min(durationSec, hit + recovery), value: 0 });
  });
  if ((points[points.length - 1]?.timeSec ?? 0) < durationSec) {
    points.push({ timeSec: durationSec, value: 0 });
  }
  return points.sort((a, b) => a.timeSec - b.timeSec);
}

export function duckSuggestion(
  targetId: TrackId, targetName: string, sourceName: string,
  faderDb: number, points: readonly AutomationPoint[], depthDb: number,
): Suggestion | null {
  if (points.length < 3) return null;
  return {
    id: `duck:${targetId}`,
    title: `${targetName} 를 ${sourceName} 에 맞춰 ${depthDb.toFixed(1)} dB 덕킹`,
    reason: '사이드체인 컴프레서와 달리 곡선이 그려져 남으므로, 어디서 얼마나 비켜 주는지 보입니다.',
    confidence: 0.6,
    actions: [{
      kind: 'automation',
      trackId: targetId,
      target: { kind: 'volume' },
      mode: 'read',
      points: points.map((p) => ({ timeSec: p.timeSec, value: faderDb + p.value })),
    }],
  };
}

export type { IntelAction };
