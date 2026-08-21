// Getting the audio a device actually hears, and keeping it around.
//
// `adviseFor` is pure and takes a measurement; something has to produce the
// measurement, and that means rendering.  Two things make that bearable:
//
//   BOUNDED   thirty seconds from where the material starts, not the whole
//             song.  A button that takes ten seconds is a button nobody
//             presses twice, and the numbers a knob needs do not get better
//             with more minutes.
//
//   CACHED    keyed by what the render depends on — the track's clips and the
//             inserts BEFORE the one being advised.  Advising six devices on
//             one channel renders once per distinct insert position, not six
//             times, and moving a clip invalidates it because the key changes.

import { renderTrackWindow } from '../engine/offline-render.js';
import { profileBuffer, type SourceProfile } from './source-profile.js';
import { tempoMapOf, tempoAtSec } from '../model/tempo-map.js';
import { findTrack, trackClips } from '../model/session-ops.js';
import { clipEnd } from '../model/session-ops.js';
import type { DawSession, TrackId } from '../model/types.js';

/** How much audio is enough to set a knob from. */
export const ANALYSIS_WINDOW_SEC = 30;

export interface AnalysisWindow {
  startSec: number;
  endSec: number;
}

/**
 * Which part of the track to measure.
 *
 * A time selection wins, because selecting a chorus and asking for advice
 * plainly means "set it for the chorus".  Otherwise the window starts where
 * the material starts — measuring the silence before the first clip would
 * make every source look like a noise floor.
 */
export function analysisWindow(
  session: DawSession, trackId: TrackId,
  selection?: { startSec: number; endSec: number; trackIds: readonly string[] },
): AnalysisWindow | null {
  const track = findTrack(session, trackId);
  if (!track) return null;

  if (selection && selection.endSec - selection.startSec > 0.5
    && (selection.trackIds.length === 0 || selection.trackIds.includes(trackId))) {
    return {
      startSec: selection.startSec,
      endSec: Math.min(selection.endSec, selection.startSec + ANALYSIS_WINDOW_SEC * 2),
    };
  }

  const clips = trackClips(track);
  if (clips.length === 0) return null;
  const first = clips.reduce((min, c) => Math.min(min, c.startSec), Infinity);
  const last = clips.reduce((max, c) => Math.max(max, clipEnd(c)), 0);
  if (!Number.isFinite(first) || !(last > first)) return null;
  return { startSec: first, endSec: Math.min(last, first + ANALYSIS_WINDOW_SEC) };
}

/** Everything the render depends on.  Change any of it and the cache misses. */
function cacheKey(
  session: DawSession, trackId: TrackId, beforeSlot: number, window: AnalysisWindow,
): string | null {
  const track = findTrack(session, trackId);
  if (!track) return null;
  const clips = trackClips(track)
    .map((c) => `${c.fileId ?? c.id}@${c.startSec.toFixed(3)}+${c.durationSec.toFixed(3)}`
      + `:${c.offsetSec.toFixed(3)}:${(c.gainDb ?? 0).toFixed(2)}`)
    .join(',');
  const inserts = track.inserts
    .filter((i) => i.slot < beforeSlot)
    .sort((a, b) => a.slot - b.slot)
    .map((i) => `${i.slot}:${i.pluginId}:${i.bypass ? 'b' : ''}`
      + Object.entries(i.params).sort().map(([k, v]) => `${k}=${v}`).join(''))
    .join('|');
  return [
    trackId, beforeSlot, window.startSec.toFixed(3), window.endSec.toFixed(3),
    clips, inserts,
  ].join('#');
}

interface Entry { key: string; profile: SourceProfile }

const cache: Entry[] = [];
const CACHE_MAX = 12;

export function clearProfileCache(): void { cache.length = 0; }

export interface ProfileRequest {
  session: DawSession;
  trackId: TrackId;
  /** The insert being advised; everything before it is rendered in. */
  slot: number;
  selection?: { startSec: number; endSec: number; trackIds: readonly string[] };
}

export interface ProfileResult {
  profile: SourceProfile;
  window: AnalysisWindow;
  /** True when the render was skipped because the same audio was measured before. */
  cached: boolean;
}

/**
 * Measure what arrives at one insert.
 *
 * Throws with a readable message rather than returning null: every failure
 * here is something the user can act on — an empty track, a track whose
 * source has not decoded yet — and swallowing it would leave the button doing
 * nothing for no stated reason.
 */
export async function profileForInsert(request: ProfileRequest): Promise<ProfileResult> {
  const { session, trackId, slot, selection } = request;
  const track = findTrack(session, trackId);
  if (!track) throw new Error('트랙을 찾을 수 없습니다');

  const window = analysisWindow(session, trackId, selection);
  if (!window) throw new Error('이 트랙에는 분석할 오디오가 없습니다');

  const key = cacheKey(session, trackId, slot, window);
  const hit = key ? cache.find((e) => e.key === key) : undefined;
  if (hit) return { profile: hit.profile, window, cached: true };

  const buffer = await renderTrackWindow(session, trackId, {
    beforeSlot: slot,
    startSec: window.startSec,
    endSec: window.endSec,
  });

  const map = tempoMapOf(session);
  const profile = profileBuffer(buffer, {
    name: track.name,
    kind: track.kind,
    // The tempo where the window is, not the song's opening tempo — the
    // delays and modulation rates are derived from it.
    tempoBpm: tempoAtSec(map, window.startSec),
  });

  if (key) {
    cache.push({ key, profile });
    if (cache.length > CACHE_MAX) cache.shift();
  }
  return { profile, window, cached: false };
}

/** `0:12 → 0:42` — what was measured, for the UI to say so. */
export function describeWindow(window: AnalysisWindow): string {
  const clock = (sec: number): string => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec - m * 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  };
  return `${clock(window.startSec)} → ${clock(window.endSec)}`;
}
