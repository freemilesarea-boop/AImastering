// Warp actions — the verbs the UI and the shortcut layer call.
//
// Everything here is a pure session → session transform except the two that
// need decoded audio (they read the transient cache, which is already
// populated by the time a clip is visible).

import {
  DEFAULT_WARP, autoWarp, clipWarp, estimateBpm, warpFromBpm, warpedDuration,
  type WarpConfig, type WarpMode,
} from '../model/warp.js';
import { findTrack, trackClips, updateClip } from '../model/session-ops.js';
import { transientsFor } from '../engine/audio-cache.js';
import type { Clip, ClipId, DawSession, TrackId } from '../model/types.js';

function requireClip(session: DawSession, trackId: TrackId, clipId: ClipId): Clip {
  const track = findTrack(session, trackId);
  const clip = track ? trackClips(track).find((c) => c.id === clipId) : undefined;
  if (!clip) throw new Error('클립을 찾을 수 없습니다');
  if (clip.kind !== 'audio') throw new Error('오디오 클립에만 워프를 걸 수 있습니다');
  return clip;
}

/** Edit a clip's warp settings, creating a default config on first touch. */
export function updateWarp(
  session: DawSession, trackId: TrackId, clipId: ClipId,
  fn: (warp: WarpConfig) => WarpConfig,
): DawSession {
  return updateClip(session, trackId, clipId, (clip) => {
    const next = fn(clip.warp ?? DEFAULT_WARP);
    return next === clip.warp ? clip : { ...clip, warp: next };
  });
}

export function setWarpEnabled(
  session: DawSession, trackId: TrackId, clipId: ClipId, enabled: boolean,
): DawSession {
  return updateWarp(session, trackId, clipId, (w) => (w.enabled === enabled ? w : { ...w, enabled }));
}

export function setWarpMode(
  session: DawSession, trackId: TrackId, clipId: ClipId, mode: WarpMode,
): DawSession {
  return updateWarp(session, trackId, clipId, (w) => (w.mode === mode ? w : { ...w, mode }));
}

export function setFollowTempo(
  session: DawSession, trackId: TrackId, clipId: ClipId, followTempo: boolean,
): DawSession {
  return updateWarp(session, trackId, clipId, (w) =>
    (w.followTempo === followTempo ? w : { ...w, followTempo }));
}

export interface WarpSetupResult {
  session: DawSession;
  /** Tempo the warp was built against. */
  sourceBpm: number;
  markerCount: number;
  /** True when the tempo was measured rather than supplied. */
  estimated: boolean;
}

/**
 * Straight tempo match: two markers, one constant ratio.
 *
 * This is the case that covers most loops — the material is already on a grid,
 * it is just on a different one from the session.  No markers to drag.
 */
export function warpClipToTempo(
  session: DawSession, trackId: TrackId, clipId: ClipId, sourceBpm?: number,
): WarpSetupResult {
  const clip = requireClip(session, trackId, clipId);
  const measured = sourceBpm ?? estimateBpm(clipTransients(clip));
  if (measured === null) throw new Error('템포를 추정할 수 없습니다 — BPM 을 직접 입력하세요');

  const warp = warpFromBpm(measured, clip.offsetSec, clip.durationSec);
  return {
    session: applyWarp(session, trackId, clipId, warp, clip.durationSec),
    sourceBpm: measured,
    markerCount: warp.markers.length,
    estimated: sourceBpm === undefined,
  };
}

/**
 * Auto-warp: a marker on every transient, snapped to the grid.  This is what
 * straightens a human performance, not just a mismatched tempo.
 */
export function autoWarpClip(
  session: DawSession, trackId: TrackId, clipId: ClipId,
  options: { sourceBpm?: number; gridBeats?: number } = {},
): WarpSetupResult {
  const clip = requireClip(session, trackId, clipId);
  const transients = clipTransients(clip);
  const measured = options.sourceBpm ?? estimateBpm(transients);
  if (measured === null) throw new Error('템포를 추정할 수 없습니다 — BPM 을 직접 입력하세요');

  const warp = autoWarp(
    transients, measured, clip.offsetSec, clip.durationSec,
    options.gridBeats === undefined ? {} : { gridBeats: options.gridBeats },
  );
  return {
    session: applyWarp(session, trackId, clipId, warp, clip.durationSec),
    sourceBpm: measured,
    markerCount: warp.markers.length,
    estimated: options.sourceBpm === undefined,
  };
}

/** Onsets that fall inside the clip's own span of the source file. */
function clipTransients(clip: Clip): number[] {
  const from = clip.offsetSec;
  const to = clip.offsetSec + clip.durationSec;
  return transientsFor(clip.fileId).filter((t) => t > from && t < to);
}

/**
 * Install a warp and resize the clip so its whole source span still plays.
 * Without the resize, warping a 128 BPM loop into a 120 BPM session would
 * simply cut the last beats off.
 */
function applyWarp(
  session: DawSession, trackId: TrackId, clipId: ClipId,
  warp: WarpConfig, sourceDurationSec: number,
): DawSession {
  const durationSec = warpedDuration(warp, session.tempoBpm, sourceDurationSec);
  return updateClip(session, trackId, clipId, (clip) => ({
    ...clip,
    warp,
    durationSec: durationSec > 0.001 ? durationSec : clip.durationSec,
  }));
}

/** Turn warp off and put the clip back to its source length. */
export function unwarpClip(
  session: DawSession, trackId: TrackId, clipId: ClipId,
): DawSession {
  const clip = requireClip(session, trackId, clipId);
  const warp = clipWarp(clip);
  if (!warp) return session;
  const map = warp.markers;
  const sourceSpan = map.length >= 2
    ? (map[map.length - 1]?.sourceSec ?? 0) - (map[0]?.sourceSec ?? 0)
    : clip.durationSec;
  return updateClip(session, trackId, clipId, (c) => ({
    ...c,
    warp: { ...warp, enabled: false },
    durationSec: sourceSpan > 0.001 ? sourceSpan : c.durationSec,
  }));
}
