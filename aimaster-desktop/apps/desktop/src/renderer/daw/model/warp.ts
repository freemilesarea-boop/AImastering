// Warp — audio that follows the session's tempo.
//
// A warp marker ties a moment in the SOURCE FILE to a musical position
// (a beat).  Everything else follows from that pair:
//
//   • The session tempo decides where a beat lands in seconds, so a warped
//     clip re-times itself the instant you change the tempo — no re-render
//     decision, no dialog.
//   • Between two markers the mapping is linear, so the stretch ratio is
//     constant inside a segment and the renderer can walk it cheaply.
//   • Outside the outermost markers the nearest segment's ratio is extended,
//     so a clip trimmed past its last marker still plays.
//
// Why beats and not seconds: a marker written in seconds has to be rewritten
// every time the tempo moves, and two representations of the same truth is
// how tempo maps rot.  A beat is tempo-independent by construction.

import { nextId } from './ids.js';
import type { Clip, DawSession } from './types.js';
import {
  beatToSec, isConstantTempo, secToBeat, tempoMapKey, tempoMapOf,
} from './tempo-map.js';

export type WarpMode = 'beats' | 'tones' | 'texture' | 'complex';

export interface WarpMarker {
  id: string;
  /** Position in the source file, seconds from the file start. */
  sourceSec: number;
  /** Musical position, in quarter-note beats from the clip's start. */
  beat: number;
}

export interface WarpConfig {
  enabled: boolean;
  mode: WarpMode;
  /** Sorted by sourceSec; strictly increasing in BOTH axes. */
  markers: WarpMarker[];
  /**
   * Tempo the markers are played back at when the clip does NOT follow the
   * session.  Also the tempo auto-warp measured, so the UI can show it.
   */
  baseBpm: number;
  /** When false the clip keeps `baseBpm` no matter what the session does. */
  followTempo: boolean;
}

export const DEFAULT_WARP: WarpConfig = {
  enabled: false, mode: 'tones', markers: [], baseBpm: 120, followTempo: true,
};

/** Warp settings of a clip, tolerating sessions saved before warp existed. */
export function clipWarp(clip: Clip): WarpConfig | null {
  const warp = clip.warp;
  if (!warp || !warp.enabled) return null;
  return warp;
}

/** The tempo a clip's beats resolve at. */
export function resolveBpm(warp: WarpConfig, sessionBpm: number): number {
  return warp.followTempo ? sessionBpm : warp.baseBpm;
}

// ── Where a beat lands ────────────────────────────────────────────────────────
//
// A warp marker is a beat, and turning a beat into seconds used to be one
// division: 60/bpm.  With a tempo map it is a lookup, because the beats inside
// one clip can span a tempo change — a clip that straddles a ritardando has
// wider beats at its end than at its start, and the markers have to move with
// them or the warp fights the map.
//
// So the tempo is passed as a small object instead of a number.  Every
// existing call site passes a plain number and keeps the old behaviour
// exactly; the runtime passes one of these, built from the session's map.

export interface WarpTempo {
  /** The tempo to report, and what the constant-tempo path divides by. */
  bpm: number;
  /** Clip-local seconds for a beat measured from the clip's start. */
  beatToClipSec: (beat: number) => number;
  /** Identifies this mapping, so a cached render is invalidated when it moves. */
  key: string;
}

export function constantTempo(bpm: number): WarpTempo {
  const beat = beatSeconds(bpm);
  return { bpm, beatToClipSec: (b) => b * beat, key: bpm.toFixed(4) };
}

/** Accepts either form, so no call site has to change to keep working. */
export function asWarpTempo(tempo: number | WarpTempo): WarpTempo {
  return typeof tempo === 'number' ? constantTempo(tempo) : tempo;
}

/**
 * The tempo a clip's beats resolve through.
 *
 * A clip that does NOT follow the session keeps its own constant tempo — that
 * is what `followTempo: false` means, and a fixed loop must not breathe with a
 * ritardando it was never part of.
 */
export function warpTempoFor(warp: WarpConfig, sessionTempo: number | WarpTempo): WarpTempo {
  return warp.followTempo ? asWarpTempo(sessionTempo) : constantTempo(warp.baseBpm);
}

/**
 * The session's tempo, as this clip sees it.
 *
 * A clip's markers are beats FROM THE CLIP'S START, so the map has to be read
 * relative to where the clip sits: the same marker at beat 4 is a different
 * number of seconds in a clip that begins during a ritardando than in one that
 * begins after it.
 *
 * Sessions with no tempo changes take the old path exactly — one division —
 * so nothing about a constant-tempo project changes, including its cache keys.
 */
export function sessionWarpTempo(session: DawSession, clip: Clip): WarpTempo {
  const map = tempoMapOf(session);
  if (isConstantTempo(map)) return constantTempo(session.tempoBpm);

  const startBeat = secToBeat(map, Math.max(0, clip.startSec));
  const startSec = beatToSec(map, startBeat);
  return {
    bpm: session.tempoBpm,
    beatToClipSec: (beat) => beatToSec(map, startBeat + beat) - startSec,
    key: `${startBeat.toFixed(6)}|${tempoMapKey(map)}`,
  };
}

export const beatSeconds = (bpm: number): number => 60 / Math.max(1e-6, bpm);

// ── The map ───────────────────────────────────────────────────────────────────

export interface WarpMap {
  bpm: number;
  /** Breakpoints in source time, ascending. */
  source: number[];
  /** The same breakpoints in clip-local destination time, ascending. */
  dest: number[];
  /** Source seconds consumed per destination second, inside each segment. */
  rates: number[];
}

/**
 * Build the piecewise-linear map.  `rates` is source-per-dest, which is the
 * direction the renderer reads: for every output sample it needs to know how
 * far to advance in the source.
 */
export function buildWarpMap(warp: WarpConfig, sessionTempo: number | WarpTempo): WarpMap {
  const tempo = warpTempoFor(warp, sessionTempo);
  const bpm = tempo.bpm;
  const markers = [...warp.markers].sort((a, b) => a.sourceSec - b.sourceSec);

  const source = markers.map((m) => m.sourceSec);
  const dest = markers.map((m) => tempo.beatToClipSec(m.beat));
  const rates: number[] = [];
  for (let i = 0; i + 1 < markers.length; i++) {
    const ds = (source[i + 1] ?? 0) - (source[i] ?? 0);
    const dd = (dest[i + 1] ?? 0) - (dest[i] ?? 0);
    rates.push(dd > 1e-9 ? ds / dd : 1);
  }
  return { bpm, source, dest, rates };
}

/** Rate outside the map's ends — the nearest segment, or 1:1 when there is none. */
function edgeRate(map: WarpMap, atEnd: boolean): number {
  if (map.rates.length === 0) return 1;
  return (atEnd ? map.rates[map.rates.length - 1] : map.rates[0]) ?? 1;
}

/** Destination (clip-local) time for a moment in the source file. */
export function sourceToDest(map: WarpMap, sourceSec: number): number {
  const n = map.source.length;
  if (n === 0) return sourceSec;
  const first = map.source[0] ?? 0;
  const firstDest = map.dest[0] ?? 0;
  if (sourceSec <= first) return firstDest + (sourceSec - first) / edgeRate(map, false);
  const last = map.source[n - 1] ?? 0;
  const lastDest = map.dest[n - 1] ?? 0;
  if (sourceSec >= last) return lastDest + (sourceSec - last) / edgeRate(map, true);

  for (let i = 0; i + 1 < n; i++) {
    const a = map.source[i] ?? 0;
    const b = map.source[i + 1] ?? 0;
    if (sourceSec <= b) {
      const t = b - a > 1e-12 ? (sourceSec - a) / (b - a) : 0;
      return (map.dest[i] ?? 0) + t * ((map.dest[i + 1] ?? 0) - (map.dest[i] ?? 0));
    }
  }
  return lastDest;
}

/** The inverse: where in the source file a clip-local moment reads from. */
export function destToSource(map: WarpMap, destSec: number): number {
  const n = map.dest.length;
  if (n === 0) return destSec;
  const first = map.dest[0] ?? 0;
  const firstSource = map.source[0] ?? 0;
  if (destSec <= first) return firstSource + (destSec - first) * edgeRate(map, false);
  const last = map.dest[n - 1] ?? 0;
  const lastSource = map.source[n - 1] ?? 0;
  if (destSec >= last) return lastSource + (destSec - last) * edgeRate(map, true);

  for (let i = 0; i + 1 < n; i++) {
    const a = map.dest[i] ?? 0;
    const b = map.dest[i + 1] ?? 0;
    if (destSec <= b) {
      const t = b - a > 1e-12 ? (destSec - a) / (b - a) : 0;
      return (map.source[i] ?? 0) + t * ((map.source[i + 1] ?? 0) - (map.source[i] ?? 0));
    }
  }
  return lastSource;
}

/** Source seconds per destination second at a moment — the local stretch. */
export function rateAt(map: WarpMap, destSec: number): number {
  const n = map.dest.length;
  if (n < 2) return edgeRate(map, false);
  if (destSec <= (map.dest[0] ?? 0)) return edgeRate(map, false);
  if (destSec >= (map.dest[n - 1] ?? 0)) return edgeRate(map, true);
  for (let i = 0; i + 1 < n; i++) {
    if (destSec <= (map.dest[i + 1] ?? 0)) return map.rates[i] ?? 1;
  }
  return edgeRate(map, true);
}

// ── Marker editing ────────────────────────────────────────────────────────────

export function createMarker(sourceSec: number, beat: number): WarpMarker {
  return { id: nextId('warp'), sourceSec, beat };
}

const sortMarkers = (markers: WarpMarker[]): WarpMarker[] =>
  [...markers].sort((a, b) => a.sourceSec - b.sourceSec);

/** Add a marker, ignoring one that would sit on top of a neighbour. */
export function addMarker(warp: WarpConfig, sourceSec: number, beat: number): WarpConfig {
  const tooClose = warp.markers.some((m) =>
    Math.abs(m.sourceSec - sourceSec) < 1e-3 || Math.abs(m.beat - beat) < 1e-4);
  if (tooClose) return warp;
  return { ...warp, markers: sortMarkers([...warp.markers, createMarker(sourceSec, beat)]) };
}

export function removeMarker(warp: WarpConfig, id: string): WarpConfig {
  const markers = warp.markers.filter((m) => m.id !== id);
  return markers.length === warp.markers.length ? warp : { ...warp, markers };
}

/**
 * Drag a marker onto a musical position.  This is the core gesture: you grab
 * the downbeat the drummer played late and pull it onto the grid.
 *
 * The beat is clamped strictly between the neighbours, because a marker that
 * crosses its neighbour would make the map non-monotonic — audio would have
 * to play backwards to satisfy it.
 */
export function moveMarker(warp: WarpConfig, id: string, beat: number): WarpConfig {
  const sorted = sortMarkers(warp.markers);
  const index = sorted.findIndex((m) => m.id === id);
  if (index === -1) return warp;
  const MIN_GAP = 1e-3;
  const lower = index > 0 ? (sorted[index - 1]?.beat ?? -Infinity) + MIN_GAP : -Infinity;
  const upper = index + 1 < sorted.length ? (sorted[index + 1]?.beat ?? Infinity) - MIN_GAP : Infinity;
  const clamped = Math.min(upper, Math.max(lower, beat));
  const current = sorted[index];
  if (!current || Math.abs(current.beat - clamped) < 1e-9) return warp;
  return {
    ...warp,
    markers: sorted.map((m) => (m.id === id ? { ...m, beat: clamped } : m)),
  };
}

export function clearMarkers(warp: WarpConfig): WarpConfig {
  return warp.markers.length === 0 ? warp : { ...warp, markers: [] };
}

// ── Building a warp ───────────────────────────────────────────────────────────

/**
 * The common case: "this loop is 128 BPM, the session is 120".  Two markers,
 * a constant ratio, nothing to drag.
 */
export function warpFromBpm(
  sourceBpm: number, sourceStartSec: number, sourceDurationSec: number,
  over: Partial<WarpConfig> = {},
): WarpConfig {
  const beats = (sourceDurationSec / beatSeconds(sourceBpm));
  return {
    ...DEFAULT_WARP,
    enabled: true,
    baseBpm: sourceBpm,
    ...over,
    markers: [
      createMarker(sourceStartSec, 0),
      createMarker(sourceStartSec + sourceDurationSec, beats),
    ],
  };
}

export interface AutoWarpOptions {
  /** Grid the onsets snap to, in beats.  0.25 = sixteenths. */
  gridBeats?: number;
  /** Ignore onsets closer together than this many beats. */
  minSpacingBeats?: number;
  /** Cap on markers, so a busy take does not produce a thousand of them. */
  maxMarkers?: number;
}

/**
 * Auto-warp: put a marker on each detected transient and snap it to the grid.
 *
 * The tempo estimate decides the nominal beat of each onset; snapping then
 * removes the player's timing error, which is exactly what "warp this to the
 * grid" means.  Onsets that snap onto an already-used grid slot are dropped —
 * two markers on one beat is a divide-by-zero waiting to happen.
 */
export function autoWarp(
  transients: readonly number[], sourceBpm: number,
  sourceStartSec: number, sourceDurationSec: number,
  options: AutoWarpOptions = {},
): WarpConfig {
  const grid = options.gridBeats ?? 0.25;
  const minSpacing = options.minSpacingBeats ?? grid;
  const maxMarkers = options.maxMarkers ?? 256;
  const beat = beatSeconds(sourceBpm);
  const endSec = sourceStartSec + sourceDurationSec;

  const markers: WarpMarker[] = [createMarker(sourceStartSec, 0)];
  const used = new Set<number>([0]);
  let lastBeat = 0;

  for (const onset of transients) {
    if (onset <= sourceStartSec + 1e-3 || onset >= endSec - 1e-3) continue;
    if (markers.length >= maxMarkers) break;
    const nominal = (onset - sourceStartSec) / beat;
    const snapped = Math.round(nominal / grid) * grid;
    if (snapped - lastBeat < minSpacing - 1e-9) continue;
    if (used.has(snapped)) continue;
    used.add(snapped);
    lastBeat = snapped;
    markers.push(createMarker(onset, snapped));
  }

  const endBeat = Math.max(lastBeat + grid, Math.round((sourceDurationSec / beat) / grid) * grid);
  markers.push(createMarker(endSec, endBeat));

  return { ...DEFAULT_WARP, enabled: true, baseBpm: sourceBpm, markers };
}

/**
 * Tempo from onset spacing: histogram the intervals between transients, take
 * the strongest, and fold it into a musical range (70–180 BPM) so a detector
 * that locked onto eighth notes still reports the tempo a musician would.
 */
export function estimateBpm(
  transients: readonly number[], min = 70, max = 180,
): number | null {
  if (transients.length < 4) return null;
  const intervals: number[] = [];
  for (let i = 1; i < transients.length; i++) {
    const d = (transients[i] ?? 0) - (transients[i - 1] ?? 0);
    if (d > 0.05 && d < 2) intervals.push(d);
  }
  if (intervals.length < 3) return null;

  // Cluster intervals at 10 ms resolution and take the fullest bucket.
  const buckets = new Map<number, number[]>();
  for (const d of intervals) {
    const key = Math.round(d * 100);
    const list = buckets.get(key);
    if (list) list.push(d); else buckets.set(key, [d]);
  }
  let best: number[] = [];
  for (const list of buckets.values()) if (list.length > best.length) best = list;
  if (best.length === 0) return null;
  const period = best.reduce((a, b) => a + b, 0) / best.length;

  let bpm = 60 / period;
  while (bpm < min) bpm *= 2;
  while (bpm > max) bpm /= 2;
  return Math.round(bpm * 100) / 100;
}

// ── Clip-level helpers ────────────────────────────────────────────────────────

/** Source span a clip covers, in file seconds, once warp is taken into account. */
export function clipSourceSpan(clip: Clip, sessionBpm: number | WarpTempo): { fromSec: number; toSec: number } {
  const warp = clipWarp(clip);
  if (!warp) return { fromSec: clip.offsetSec, toSec: clip.offsetSec + clip.durationSec };
  const map = buildWarpMap(warp, sessionBpm);
  const destStart = sourceToDest(map, clip.offsetSec);
  return {
    fromSec: clip.offsetSec,
    toSec: destToSource(map, destStart + clip.durationSec),
  };
}

/** How long the clip plays for when its whole warped span is used. */
export function warpedDuration(warp: WarpConfig, sessionBpm: number | WarpTempo, sourceDurationSec: number): number {
  const map = buildWarpMap(warp, sessionBpm);
  const from = map.source[0] ?? 0;
  return sourceToDest(map, from + sourceDurationSec) - sourceToDest(map, from);
}

/**
 * Resize a tempo-following clip for a new session tempo.  Called when the
 * tempo changes: the clip keeps its musical length and changes its seconds.
 */
export function retimeClip(clip: Clip, fromBpm: number, toBpm: number): Clip {
  const warp = clipWarp(clip);
  if (!warp || !warp.followTempo || fromBpm <= 0 || toBpm <= 0) return clip;
  const ratio = fromBpm / toBpm;
  if (Math.abs(ratio - 1) < 1e-12) return clip;
  return {
    ...clip,
    durationSec: clip.durationSec * ratio,
    fadeIn: { ...clip.fadeIn, durationSec: clip.fadeIn.durationSec * ratio },
    fadeOut: { ...clip.fadeOut, durationSec: clip.fadeOut.durationSec * ratio },
  };
}

// ── Validation ────────────────────────────────────────────────────────────────

export interface WarpProblem {
  severity: 'error' | 'warning';
  message: string;
  markerId?: string;
}

/** Ratios beyond this are not stretching any more, they are sound design. */
export const MAX_RATE = 8;
export const MIN_RATE = 1 / 8;

export function validateWarp(warp: WarpConfig, sessionBpm: number | WarpTempo): WarpProblem[] {
  const problems: WarpProblem[] = [];
  const sorted = [...warp.markers].sort((a, b) => a.sourceSec - b.sourceSec);

  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (!a || !b) continue;
    if (b.beat <= a.beat) {
      problems.push({
        severity: 'error', markerId: b.id,
        message: `마커가 순서를 뒤집습니다 (${a.beat.toFixed(2)} → ${b.beat.toFixed(2)} 비트)`,
      });
    }
  }

  const map = buildWarpMap(warp, sessionBpm);
  map.rates.forEach((rate, i) => {
    if (rate <= MAX_RATE && rate >= MIN_RATE) return;
    const message = `${i + 1}번 구간의 스트레치가 ${rate.toFixed(2)}× 입니다 — 아티팩트가 들립니다`;
    const markerId = sorted[i + 1]?.id;
    problems.push(markerId
      ? { severity: 'warning', markerId, message }
      : { severity: 'warning', message });
  });

  if (warp.enabled && warp.markers.length < 2) {
    problems.push({ severity: 'warning', message: '마커가 2개 미만이라 스트레치가 적용되지 않습니다' });
  }
  return problems;
}

/** One-line summary for the clip header. */
export function describeWarp(warp: WarpConfig | null, sessionBpm: number): string {
  if (!warp) return 'Warp off';
  const map = buildWarpMap(warp, sessionBpm);
  const bpm = resolveBpm(warp, sessionBpm);
  if (map.rates.length === 0) return `Warp · ${warp.mode} · 마커 없음`;
  const constant = map.rates.every((r) => Math.abs(r - (map.rates[0] ?? 1)) < 1e-6);
  const rate = map.rates[0] ?? 1;
  return constant
    ? `Warp · ${warp.mode} · ${(1 / rate).toFixed(3)}× @ ${bpm.toFixed(1)} BPM`
    : `Warp · ${warp.mode} · 마커 ${warp.markers.length}개 @ ${bpm.toFixed(1)} BPM`;
}

// ── Tempo change ──────────────────────────────────────────────────────────────

export interface TempoChangeResult {
  session: DawSession;
  /** Audio clips that could not follow because warp is off — they keep their
   *  length while everything around them moved. */
  unwarpedClipIds: string[];
}

const scalePoints = <T extends { timeSec: number }>(points: T[], ratio: number): T[] =>
  points.map((p) => ({ ...p, timeSec: p.timeSec * ratio }));

/**
 * Change the session tempo, moving the arrangement with it.
 *
 * The timeline is stored in seconds, but the ARRANGEMENT is musical: bar 9 has
 * to stay bar 9 when the tempo changes.  So every position scales by the tempo
 * ratio, and lengths scale for anything that can stretch — MIDI parts always,
 * audio clips only when they are warped and following.  MIDI NOTES are the
 * exception that needs no work: they are stored in beats and were never in
 * the seconds domain this function rescales.
 *
 * An unwarped audio clip is the one thing that cannot follow.  It is moved
 * (its start is musical) but keeps its length, and its id is returned so the
 * UI can say so rather than letting the user discover it by ear.
 */
export function setSessionTempo(session: DawSession, bpm: number): TempoChangeResult {
  const from = session.tempoBpm;
  const to = Math.max(20, Math.min(300, bpm));
  const unwarpedClipIds: string[] = [];
  if (from <= 0 || Math.abs(from - to) < 1e-9) {
    return { session: { ...session, tempoBpm: to }, unwarpedClipIds };
  }
  const ratio = from / to;

  const retimeClipAt = (clip: Clip): Clip => {
    const moved: Clip = { ...clip, startSec: clip.startSec * ratio };
    if (clip.kind === 'midi') {
      // Notes and their curves are in BEATS, so they need no rescaling: the
      // tempo map moved under them and they are still on the beats they were
      // written on.  Only the part's own seconds — where it sits and how long
      // its box is — follow the ratio.
      return {
        ...moved,
        durationSec: clip.durationSec * ratio,
        fadeIn: { ...clip.fadeIn, durationSec: clip.fadeIn.durationSec * ratio },
        fadeOut: { ...clip.fadeOut, durationSec: clip.fadeOut.durationSec * ratio },
      };
    }
    const warp = clipWarp(clip);
    if (!warp || !warp.followTempo) {
      unwarpedClipIds.push(clip.id);
      return moved;
    }
    return retimeClip(moved, from, to);
  };

  return {
    session: {
      ...session,
      tempoBpm: to,
      tracks: session.tracks.map((track) => ({
        ...track,
        playlists: track.playlists.map((p) => ({ ...p, clips: p.clips.map(retimeClipAt) })),
        automation: track.automation.map((lane) => ({ ...lane, points: scalePoints(lane.points, ratio) })),
      })),
      chordTrack: session.chordTrack.map((c) => ({ ...c, timeSec: c.timeSec * ratio })),
    },
    unwarpedClipIds,
  };
}
