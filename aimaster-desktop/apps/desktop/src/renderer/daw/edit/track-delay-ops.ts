// Track Delay — the session-level verbs.
//
// The readers live in `model/track-delay.ts` and depend on nothing; the edits
// live here, where they can reach `session-ops` without the two importing
// each other.  Same split as warp: a model that answers questions, and an
// actions layer that changes the session.

import { trackClips, updateTrack } from '../model/session-ops.js';
import {
  MAX_TRACK_DELAY_MS, delayMechanism, scheduleShiftSec, trackDelayMs,
  type DelayMechanism,
} from '../model/track-delay.js';
import type { DawSession, Track, TrackId } from '../model/types.js';

// ── Setting it ────────────────────────────────────────────────────────────────

export interface DelayRefusal { ok: false; reason: string }
export type DelayCheck = { ok: true } | DelayRefusal;

/** Whether this track can take this delay, and why not when it cannot. */
export function canDelay(track: Track, ms: number): DelayCheck {
  const mechanism = delayMechanism(track);
  if (mechanism === 'none') {
    return { ok: false, reason: `${track.name} — 신호가 지나가지 않는 트랙입니다` };
  }
  if (mechanism === 'signal' && ms < 0) {
    return {
      ok: false,
      reason: `${track.name} — 버스에서는 소리를 앞당길 수 없습니다.`
        + ' 아직 도착하지 않은 소리입니다 — 이 버스로 들어오는 트랙을 당기세요',
    };
  }
  return { ok: true };
}

export interface DelayResult {
  session: DawSession;
  /** False when nothing changed — the reason says why. */
  applied: boolean;
  reason: string | null;
}

export function setTrackDelay(session: DawSession, trackId: TrackId, ms: number): DelayResult {
  const track = session.tracks.find((t) => t.id === trackId);
  if (!track) return { session, applied: false, reason: '트랙을 찾을 수 없습니다' };

  const clamped = Number.isFinite(ms)
    ? Math.max(-MAX_TRACK_DELAY_MS, Math.min(MAX_TRACK_DELAY_MS, Math.round(ms * 10) / 10))
    : 0;
  const check = canDelay(track, clamped);
  if (!check.ok) return { session, applied: false, reason: check.reason };
  if (clamped === trackDelayMs(track)) return { session, applied: false, reason: null };

  return {
    session: updateTrack(session, trackId, (t) => ({ ...t, delayMs: clamped })),
    applied: true,
    reason: null,
  };
}

export function nudgeTrackDelay(session: DawSession, trackId: TrackId, deltaMs: number): DelayResult {
  const track = session.tracks.find((t) => t.id === trackId);
  if (!track) return { session, applied: false, reason: '트랙을 찾을 수 없습니다' };
  return setTrackDelay(session, trackId, trackDelayMs(track) + deltaMs);
}

export function clearTrackDelay(session: DawSession, trackId: TrackId): DelayResult {
  return setTrackDelay(session, trackId, 0);
}

// ── Reading it back ───────────────────────────────────────────────────────────

export function describeDelay(ms: number): string {
  if (ms === 0) return '0 ms';
  const sign = ms > 0 ? '+' : '−';
  const when = ms > 0 ? '늦게' : '먼저';
  return `${sign}${Math.abs(ms).toFixed(1)} ms · ${when}`;
}

export interface DelayedTrack { trackId: TrackId; name: string; ms: number; mechanism: DelayMechanism }

export function delayedTracks(session: DawSession): DelayedTrack[] {
  return session.tracks
    .filter((t) => trackDelayMs(t) !== 0)
    .map((t) => ({
      trackId: t.id, name: t.name, ms: trackDelayMs(t), mechanism: delayMechanism(t),
    }));
}

/**
 * What a delay is costing that nobody asked for.
 *
 * A negative delay runs out of timeline: a clip starting 10 ms in, pulled
 * 30 ms early, has 20 ms with nowhere to go and loses them.  The engine will
 * do the right thing silently, and silently is exactly wrong — the user hears
 * a clipped attack and blames the take.
 */
export function delayProblems(session: DawSession): string[] {
  const problems: string[] = [];
  for (const track of session.tracks) {
    const shift = scheduleShiftSec(track);
    if (shift >= 0) continue;
    let worst = 0;
    let count = 0;
    for (const clip of trackClips(track)) {
      const lost = -(clip.startSec + shift);
      if (lost <= 1e-9) continue;
      count++;
      worst = Math.max(worst, Math.min(lost, -shift));
    }
    if (count > 0) {
      problems.push(
        `${track.name} — 클립 ${count}개의 앞 ${(worst * 1000).toFixed(0)} ms 가 잘립니다`
        + ' (타임라인 0 보다 앞은 없습니다)');
    }
  }
  return problems;
}

/** One line for a status readout. */
export function describeDelays(session: DawSession): string {
  const delayed = delayedTracks(session);
  if (delayed.length === 0) return '트랙 딜레이 없음';
  return delayed.map((d) => `${d.name} ${describeDelay(d.ms)}`).join(' · ');
}
