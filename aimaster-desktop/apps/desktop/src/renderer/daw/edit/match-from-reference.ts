// The route from "the reference is 1.7 dB brighter up top" to a filter that
// closes the gap.
//
// Both ends of this have been in the app for a while. `analysis/reference.ts`
// measures a commercial master and the rendered mix and draws the difference;
// `engine/match-eq.ts` is a 32-band linear-phase device built to apply exactly
// that difference. Nothing joined them: `matchCurve` — the function whose only
// job is to turn two spectra into the 32 numbers the device reads — had no
// caller at all, so every Match EQ anyone inserted carried a flat curve and
// 511 samples of latency and matched nothing.
//
// ── Two directions that are supposed to disagree ───────────────────────────
//
// `spectrumDelta` is mix − reference: where your mix SITS, which is what the
// Tonal Balance overlay draws. `matchCurve` is reference − mix: what the mix
// must be GIVEN. They are negatives of each other on purpose, and neither is
// a typo for the other.
//
// ── What is kept when a match is re-taken ──────────────────────────────────
//
// Only the 32 measured bands. Amount, Smooth, Limit, Resolution, Mix and Out
// are the controls the user rides after the measurement, and re-measuring is
// not a reason to put them back to where they started. The stored curve is
// the raw difference, unsmoothed and unclamped, because those three controls
// have to stay movable afterwards — see `matchShapeDb`.

import type { SpectrumCurve } from '../analysis/reference.js';
import { MATCH_BANDS, matchBandId, matchCurve } from '../engine/match-eq.js';
import { defaultParams, findPlugin } from '../engine/plugins.js';
import { createInsert, findTrack, setInsert } from '../model/session-ops.js';
import { INSERT_SLOTS, type DawSession, type Insert, type TrackId } from '../model/types.js';

/** The device this action reaches for. */
export const MATCH_PLUGIN_ID = 'matcheq';

/**
 * Where a whole-mix match belongs.
 *
 * The Reference panel renders the entire session, so the correction goes
 * where the entire session passes. Putting it on the selected track would
 * apply a master-bus measurement to one instrument.
 */
export function matchTargetTrack(session: DawSession): TrackId | null {
  return session.tracks.find((t) => t.kind === 'master')?.id ?? null;
}

export interface MatchPlacement {
  slot: number;
  /** The Match EQ already on the track, whose settings are kept. */
  existing: Insert | null;
}

/**
 * The slot a match should land in: the one a Match EQ already occupies, or
 * the first free one. A second Match EQ beside the first would correct the
 * same gap twice.
 */
export function matchPlacement(session: DawSession, trackId: TrackId): MatchPlacement | null {
  const track = findTrack(session, trackId);
  if (!track) return null;
  const existing = track.inserts.find((i) => i.pluginId === MATCH_PLUGIN_ID) ?? null;
  if (existing) return { slot: existing.slot, existing };
  for (let slot = 0; slot < INSERT_SLOTS; slot++) {
    if (!track.inserts.some((i) => i.slot === slot)) return { slot, existing: null };
  }
  return null;
}

export type MatchOutcome =
  | {
    ok: true;
    session: DawSession;
    slot: number;
    /** True when an existing Match EQ was re-measured rather than one added. */
    replaced: boolean;
    /** The largest correction the measurement asks for, in dB. */
    peakDb: number;
  }
  | { ok: false; reason: string };

/**
 * Measure the two spectra into a Match EQ on `trackId`.
 *
 * Every refusal names itself: a route that does nothing and says nothing is
 * how a feature comes to look broken.
 */
export function matchEqFromReference(
  session: DawSession,
  trackId: TrackId,
  reference: SpectrumCurve,
  mix: SpectrumCurve,
  sampleRate = session.sampleRate,
): MatchOutcome {
  if (reference.hz.length === 0 || mix.hz.length === 0) {
    return { ok: false, reason: '분석 결과가 비어 있습니다' };
  }
  return writeMatchCurve(session, trackId, matchCurve(reference, mix), sampleRate);
}

/**
 * Store 32 measured decibels into a Match EQ on `trackId`, adding the device
 * if the track has not got one.
 *
 * Shared by both routes that take a match — the whole-mix one above and the
 * track-to-track one in `match-between-tracks.ts` — because the part that is
 * easy to get subtly wrong is this one, not the measuring: which slot, whose
 * settings survive, and what latency the insert then declares.  Two copies of
 * it would drift.
 */
export function writeMatchCurve(
  session: DawSession,
  trackId: TrackId,
  curve: readonly number[],
  sampleRate = session.sampleRate,
): MatchOutcome {
  const descriptor = findPlugin(MATCH_PLUGIN_ID);
  if (!descriptor) return { ok: false, reason: '매치 EQ 장치를 찾을 수 없습니다' };
  const place = matchPlacement(session, trackId);
  if (!place) {
    return { ok: false, reason: findTrack(session, trackId)
      ? '인서트 슬롯이 모두 찼습니다'
      : '대상 트랙을 찾을 수 없습니다' };
  }

  // Defaults underneath, so a device stored by an older build that never knew
  // about a control still comes back with every parameter the engine reads.
  const params: Record<string, number> = {
    ...defaultParams(MATCH_PLUGIN_ID),
    ...(place.existing?.params ?? {}),
  };
  let peakDb = 0;
  for (let b = 0; b < MATCH_BANDS; b++) {
    const db = curve[b] ?? 0;
    params[matchBandId(b)] = db;
    peakDb = Math.max(peakDb, Math.abs(db));
  }

  const insert: Insert = place.existing
    ? { ...place.existing, params, latencySamples: descriptor.latencyFor(params, sampleRate) }
    : createInsert(place.slot, MATCH_PLUGIN_ID, descriptor.name, {
      params,
      latencySamples: descriptor.latencyFor(params, sampleRate),
    });

  return {
    ok: true,
    session: setInsert(session, trackId, insert),
    slot: place.slot,
    replaced: place.existing !== null,
    peakDb,
  };
}

/** `A`–`J`, the way the rack labels a slot. */
export function slotLetter(slot: number): string {
  return String.fromCharCode(65 + Math.max(0, Math.min(INSERT_SLOTS - 1, slot)));
}
