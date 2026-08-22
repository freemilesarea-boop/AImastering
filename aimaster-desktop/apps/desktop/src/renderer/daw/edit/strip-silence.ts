// Strip Silence — cutting the nothing out of a long take.
//
// A twenty-minute vocal take is four minutes of singing and sixteen of room
// tone, breaths, headphone bleed and the singer asking whether that one was
// any good.  Nobody edits that by hand; every DAW has one command that finds
// the sounding parts and throws the rest away.
//
// The measurement is an envelope against a threshold, and the whole art is in
// the three numbers that stop it from shredding the performance:
//
//   THRESHOLD   below this is not the performance.  In dBFS, not a ratio,
//               because engineers think in dB and a noise floor is quoted
//               in dB.
//   MIN SILENCE a quiet stretch shorter than this is a breath or a consonant
//               gap, not silence.  Cutting there is what makes an edit sound
//               chopped.
//   PAD         keep this much either side of every sounding region, so an
//               attack is not clipped off and a tail is allowed to decay.
//
// The output is REGIONS, not an edited session.  Deciding where the sound is
// and rewriting the timeline are different jobs, and keeping them apart is
// what lets the UI show the regions first and let the user look before
// anything is cut.

import { clipEnd, sortClips, trackClips, updateClips, findTrack } from '../model/session-ops.js';
import { trimClipEnd, trimClipStart } from './clip-edit.js';
import { nextId } from '../model/ids.js';
import type { Clip, DawSession, TrackId } from '../model/types.js';

export interface StripOptions {
  /** Below this, in dBFS, is not the performance. */
  thresholdDb: number;
  /** A quiet stretch shorter than this is a breath, not silence. */
  minSilenceSec: number;
  /** Sounding regions shorter than this are clicks, not notes. */
  minSoundSec: number;
  /** Kept either side of every region, so attacks and tails survive. */
  padSec: number;
}

export const DEFAULT_STRIP: StripOptions = {
  thresholdDb: -48,
  minSilenceSec: 0.35,
  minSoundSec: 0.08,
  padSec: 0.02,
};

export interface SoundRegion {
  startSec: number;
  endSec: number;
}

const EPS = 1e-6;
const dbToLinear = (db: number): number => Math.pow(10, db / 20);

/**
 * Where the sound is.
 *
 * Envelope-follows the absolute value at `hopSec` resolution rather than
 * testing every sample: a single sample above the threshold in the middle of a
 * quiet passage is noise, and a hop-sized window is the cheapest thing that
 * ignores it.
 */
export function findSoundRegions(
  samples: ArrayLike<number>,
  sampleRate: number,
  options: StripOptions = DEFAULT_STRIP,
  hopSec = 0.01,
): SoundRegion[] {
  if (samples.length === 0 || !(sampleRate > 0)) return [];
  const hop = Math.max(1, Math.round(hopSec * sampleRate));
  const threshold = dbToLinear(options.thresholdDb);

  // 1. Loud / quiet per hop.
  const loud: boolean[] = [];
  for (let start = 0; start < samples.length; start += hop) {
    let peak = 0;
    const end = Math.min(samples.length, start + hop);
    for (let i = start; i < end; i++) {
      const v = samples[i] ?? 0;
      const abs = v < 0 ? -v : v;
      if (abs > peak) peak = abs;
    }
    loud.push(peak >= threshold);
  }
  if (loud.length === 0) return [];

  // 2. Raw runs of loud hops.
  const runs: SoundRegion[] = [];
  let from = -1;
  for (let i = 0; i < loud.length; i++) {
    if (loud[i] && from < 0) from = i;
    if (!loud[i] && from >= 0) {
      runs.push({ startSec: (from * hop) / sampleRate, endSec: (i * hop) / sampleRate });
      from = -1;
    }
  }
  if (from >= 0) {
    runs.push({ startSec: (from * hop) / sampleRate, endSec: samples.length / sampleRate });
  }
  if (runs.length === 0) return [];

  // 3. Bridge gaps that are too short to be silence.  A breath between two
  //    words must not become an edit point.
  const bridged: SoundRegion[] = [runs[0]!];
  for (let i = 1; i < runs.length; i++) {
    const prev = bridged[bridged.length - 1]!;
    const next = runs[i]!;
    if (next.startSec - prev.endSec < options.minSilenceSec) prev.endSec = next.endSec;
    else bridged.push({ ...next });
  }

  // 4. Pad, drop what is too short to be a note, and clamp to the material.
  const total = samples.length / sampleRate;
  const out: SoundRegion[] = [];
  for (const region of bridged) {
    if (region.endSec - region.startSec < options.minSoundSec) continue;
    const padded = {
      startSec: Math.max(0, region.startSec - options.padSec),
      endSec: Math.min(total, region.endSec + options.padSec),
    };
    // Padding can make two regions touch; merge rather than emit an overlap.
    const prev = out[out.length - 1];
    if (prev && padded.startSec <= prev.endSec + EPS) prev.endSec = padded.endSec;
    else out.push(padded);
  }
  return out;
}

/** What the strip would remove, as a fraction — for the confirm line. */
export function silenceShare(regions: readonly SoundRegion[], totalSec: number): number {
  if (totalSec <= 0) return 0;
  const sounding = regions.reduce((n, r) => n + (r.endSec - r.startSec), 0);
  return Math.max(0, Math.min(1, 1 - sounding / totalSec));
}

// ── Applying it ───────────────────────────────────────────────────────────────

export interface StripResult {
  session: DawSession;
  /** How many clips the take became. */
  pieces: number;
  removedSec: number;
}

/**
 * Replace one clip with the sounding parts of it.
 *
 * Regions are in CLIP time — seconds from the clip's own start — because that
 * is the frame the analysis ran in, and translating once here beats every
 * caller getting it right.
 *
 * The clips keep their place on the timeline: this cuts holes, it does not
 * close them.  Closing the gaps would move every downstream note, and a strip
 * that also retimed the performance is not a strip.
 */
export function stripClipSilence(
  session: DawSession,
  trackId: TrackId,
  clipId: string,
  regions: readonly SoundRegion[],
): StripResult {
  const track = findTrack(session, trackId);
  const clip = track ? trackClips(track).find((c) => c.id === clipId) : undefined;
  if (!clip) return { session, pieces: 0, removedSec: 0 };
  if (regions.length === 0) {
    // Everything measured as silence.  Removing the clip entirely would be a
    // very confident reading of a threshold the user can still change.
    return { session, pieces: 0, removedSec: 0 };
  }

  const pieces: Clip[] = [];
  for (const region of regions) {
    const from = clip.startSec + Math.max(0, region.startSec);
    const to = clip.startSec + Math.min(clip.durationSec, region.endSec);
    if (to - from <= EPS) continue;
    let piece: Clip = { ...clip, id: nextId('clip') };
    if (from > clip.startSec + EPS) piece = trimClipStart(piece, from);
    if (clipEnd(piece) > to + EPS) piece = trimClipEnd(piece, to);
    if (piece.durationSec > EPS) pieces.push(piece);
  }
  if (pieces.length === 0) return { session, pieces: 0, removedSec: 0 };

  const kept = pieces.reduce((n, p) => n + p.durationSec, 0);
  const out = updateClips(session, trackId, (clips) =>
    sortClips([...clips.filter((c) => c.id !== clipId), ...pieces]));

  return { session: out, pieces: pieces.length, removedSec: Math.max(0, clip.durationSec - kept) };
}

/** `12조각 · 3분 24초 제거` — the result, in one line. */
export function describeStrip(result: StripResult): string {
  if (result.pieces === 0) return '자를 무음을 찾지 못했습니다 — 임계값을 올려 보세요';
  const m = Math.floor(result.removedSec / 60);
  const s = Math.round(result.removedSec - m * 60);
  const removed = m > 0 ? `${m}분 ${s}초` : `${s}초`;
  return `${result.pieces}조각 · ${removed} 제거`;
}
