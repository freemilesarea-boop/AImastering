// "Make this track sound like that one."
//
// The other half of the Match EQ.  `match-from-reference.ts` measures a
// commercial master against the whole rendered mix and corrects the master
// bus; that is the mastering question, and its target is hardcoded to the
// master for a good reason — a whole-mix measurement applied to one
// instrument would be wrong.  Which left the question a DAW user asks far
// more often with no route at all: this snare against that snare, this
// guitar against the one that already sits right.
//
// Every piece was already here — `renderTrackWindow` isolates a channel and
// takes its own latency off, `averageSpectrum` measures it level-blind,
// `matchCurve` turns two spectra into the 32 numbers, `writeMatchCurve`
// stores them.  This is the join.
//
// ── Which track is measured how, and why it is not symmetric ───────────────
//
// The MODEL is measured through its whole channel: what it sounds like is the
// point, and that includes its own inserts.
//
// The TARGET is measured up to, but NOT through, a Match EQ it already
// carries.  This is the difference between a button that can be pressed twice
// and one that destroys its own work: measure the target with last match's
// correction live and the remaining gap reads as nothing, so re-matching
// stores a flat curve and throws the match away.  Measured before the
// correction, the same two tracks give the same answer however many times it
// is taken.
//
// ── Silence ───────────────────────────────────────────────────────────────
//
// `averageSpectrum` floors every band at −120 dB when there is no audio, and
// −120 is a number, so a silent track does not fail — it asks for about
// +120 dB of boost at every frequency.  Limit clamps what is APPLIED, so the
// audio would survive; the stored curve would be nonsense and the match would
// mean nothing.  Both ends are checked, and each says which track it was.

import { averageSpectrum, type SpectrumCurve } from '../analysis/reference.js';
import { matchCurve } from '../engine/match-eq.js';
import { renderTrackWindow } from '../engine/offline-render.js';
import { clipEnd, findTrack, trackClips } from '../model/session-ops.js';
import type { DawSession, TrackId } from '../model/types.js';
import {
  MATCH_PLUGIN_ID, matchPlacement, writeMatchCurve, type MatchOutcome,
} from './match-from-reference.js';

/**
 * The most audio either side is measured over.
 *
 * A button that takes ten seconds is a button nobody presses twice, and the
 * tonal balance of a part is not a thing that needs four minutes to establish
 * — see the same argument on `renderTrackWindow`.
 */
export const MATCH_WINDOW_SEC = 30;

/**
 * A curve with no audio behind it.
 *
 * Not "quiet": `averageSpectrum` normalises the broadband level away, so a
 * whisper and a shout give the same curve.  What silence gives is the floor
 * at every single band, which no real material does.
 */
export function spectrumIsSilent(curve: SpectrumCurve): boolean {
  if (curve.db.length === 0) return true;
  for (const db of curve.db) if (db > -119.5) return false;
  return true;
}

/**
 * Measure one track's tonal balance.
 *
 * `beforeSlot` truncates the channel at an insert — used for the target, to
 * measure the material rather than the material already corrected.
 *
 * That the answer does not move when an unrelated track gains a plugin is
 * `renderTrackWindow`'s job, and it is stated there: it used to, by exactly
 * the neighbour's declared latency, because muting a track does not stop it
 * being delay-compensated.
 */
export async function measureTrackForMatch(
  session: DawSession,
  trackId: TrackId,
  beforeSlot?: number,
): Promise<SpectrumCurve> {
  const endSec = windowEndSec(session, trackId);
  const rendered = await renderTrackWindow(session, trackId, {
    ...(beforeSlot === undefined ? {} : { beforeSlot }),
    ...(endSec === undefined ? {} : { endSec }),
  });
  const n = rendered.length;
  const channels = rendered.numberOfChannels;
  const mono = new Float32Array(n);
  for (let c = 0; c < channels; c++) {
    const d = rendered.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] = (mono[i] ?? 0) + (d[i] ?? 0) / channels;
  }
  return averageSpectrum(mono, rendered.sampleRate);
}

/**
 * Where the measurement window ends: `MATCH_WINDOW_SEC` after the track's
 * first clip, or the end of its audio, whichever comes first.
 *
 * `renderTrackWindow` starts at the first clip on its own, so a track whose
 * material begins at 1:30 is measured from 1:30 rather than through ninety
 * seconds of silence that would drag the average to the floor.
 */
function windowEndSec(session: DawSession, trackId: TrackId): number | undefined {
  const track = findTrack(session, trackId);
  if (!track) return undefined;
  let first = Infinity;
  let last = 0;
  for (const clip of trackClips(track)) {
    first = Math.min(first, clip.startSec);
    last = Math.max(last, clipEnd(clip));
  }
  if (!Number.isFinite(first)) return undefined;
  return Math.min(last, first + MATCH_WINDOW_SEC);
}

/**
 * Store the difference between two measured tracks into a Match EQ on the
 * target.
 *
 * Pure, and takes the spectra rather than measuring them, so the direction of
 * the correction and every refusal can be checked without a renderer.
 *
 * The direction: `model − target`, which is what the target must be GIVEN.
 * The same convention as `matchCurve(reference, mix)`, and the negative of
 * what the Tonal Balance overlay draws — see `match-from-reference.ts`.
 */
export function matchEqBetweenTracks(
  session: DawSession,
  modelTrackId: TrackId,
  targetTrackId: TrackId,
  model: SpectrumCurve,
  target: SpectrumCurve,
  sampleRate = session.sampleRate,
): MatchOutcome {
  if (modelTrackId === targetTrackId) {
    return { ok: false, reason: '트랙을 자기 자신에 맞출 수는 없습니다' };
  }
  if (!findTrack(session, modelTrackId)) {
    return { ok: false, reason: '기준 트랙을 찾을 수 없습니다' };
  }
  if (!findTrack(session, targetTrackId)) {
    return { ok: false, reason: '대상 트랙을 찾을 수 없습니다' };
  }
  if (model.hz.length === 0 || target.hz.length === 0) {
    return { ok: false, reason: '분석 결과가 비어 있습니다' };
  }
  if (spectrumIsSilent(model)) {
    return { ok: false, reason: '기준 트랙에 분석할 소리가 없습니다' };
  }
  if (spectrumIsSilent(target)) {
    return { ok: false, reason: '대상 트랙에 분석할 소리가 없습니다' };
  }
  return writeMatchCurve(session, targetTrackId, matchCurve(model, target), sampleRate);
}

/**
 * How a track's tonal balance is obtained.  `measureTrackForMatch` in
 * practice; a stub in the suite, which is the only way to check that the
 * TARGET is measured in front of its existing Match EQ rather than through
 * it — the claim the whole design rests on, and one that a renderer would
 * bury under two offline renders per case.
 */
export type MatchMeasure = (
  session: DawSession, trackId: TrackId, beforeSlot?: number,
) => Promise<SpectrumCurve>;

/**
 * Measure both tracks and match the target to the model.
 *
 * The slot lookup happens twice on purpose: once here, to find the Match EQ
 * the target already has so the measurement can stop in front of it, and
 * again inside `writeMatchCurve`, which is what decides where the result
 * lands.  Reading it here and trusting it there would be the same number
 * fetched two ways.
 */
export async function matchTrackToTrack(
  session: DawSession,
  modelTrackId: TrackId,
  targetTrackId: TrackId,
  measure: MatchMeasure = measureTrackForMatch,
): Promise<MatchOutcome> {
  if (modelTrackId === targetTrackId) {
    return { ok: false, reason: '트랙을 자기 자신에 맞출 수는 없습니다' };
  }
  const existing = matchPlacement(session, targetTrackId)?.existing;
  const beforeSlot = existing?.pluginId === MATCH_PLUGIN_ID ? existing.slot : undefined;
  let model: SpectrumCurve;
  let target: SpectrumCurve;
  try {
    model = await measure(session, modelTrackId);
    target = await measure(session, targetTrackId, beforeSlot);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  return matchEqBetweenTracks(session, modelTrackId, targetTrackId, model, target);
}
