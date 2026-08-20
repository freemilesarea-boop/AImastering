// Warp rendering — a warped clip becomes a plain AudioBuffer.
//
// The engine rule everywhere else in this DAW is "native WebAudio nodes
// only", so that a live playback and an offline bounce are the same graph and
// therefore bit-identical.  A time stretch cannot be expressed as native
// nodes, so warp obeys the rule a different way: the stretch is rendered ONCE
// into a buffer, and playback stays an ordinary AudioBufferSourceNode.  Live
// and offline read the same rendered samples, so they still agree exactly.
//
// The render is cached per (file, clip span, tempo, mode, markers).  Change
// the tempo and the key changes, so the clip re-renders; scrub the timeline
// and nothing does.

import {
  asWarpTempo, buildWarpMap, clipWarp, destToSource, sessionWarpTempo, sourceToDest,
  warpTempoFor, type WarpConfig, type WarpTempo,
} from '../model/warp.js';
import { modeOptions, stretchChannels } from '../audio/time-stretch.js';
import { getCached } from './audio-cache.js';
import type { Clip, DawSession } from '../model/types.js';

export interface WarpedClipAudio {
  channels: Float32Array[];
  sampleRate: number;
  /** Clip-local seconds this render covers, starting at the clip's first sample. */
  durationSec: number;
}

/** Ratio deviation below which a segment is treated as 1:1 and simply copied. */
const IDENTITY_TOLERANCE = 1e-6;

function isIdentity(rates: readonly number[]): boolean {
  return rates.every((r) => Math.abs(r - 1) < IDENTITY_TOLERANCE);
}

/**
 * Render the clip's span, warped.  Output sample 0 is the clip's first sample,
 * so the player reads it with no offset.
 */
export function renderWarpedClip(
  channels: readonly Float32Array[], sampleRate: number,
  clip: Clip, sessionTempo: number | WarpTempo,
): WarpedClipAudio | null {
  const warp = clipWarp(clip);
  if (!warp) return null;

  const map = buildWarpMap(warp, sessionTempo);
  const outLength = Math.max(0, Math.round(clip.durationSec * sampleRate));
  if (outLength === 0) return { channels: channels.map(() => new Float32Array(0)), sampleRate, durationSec: 0 };

  const destStart = sourceToDest(map, clip.offsetSec);

  // A 1:1 warp still has to be honoured (the clip may be shifted in time),
  // but running WSOLA over it would add artefacts for nothing.
  if (isIdentity(map.rates) || map.source.length < 2) {
    const startSample = Math.round(destToSource(map, destStart) * sampleRate);
    return {
      channels: channels.map((ch) => {
        const out = new Float32Array(outLength);
        for (let i = 0; i < outLength; i++) {
          const index = startSample + i;
          out[i] = index >= 0 && index < ch.length ? (ch[index] ?? 0) : 0;
        }
        return out;
      }),
      sampleRate,
      durationSec: clip.durationSec,
    };
  }

  const sourceSampleAt = (outSample: number): number =>
    destToSource(map, destStart + outSample / sampleRate) * sampleRate;

  return {
    channels: stretchChannels(channels, outLength, sourceSampleAt, modeOptions(warp.mode, sampleRate)),
    sampleRate,
    durationSec: clip.durationSec,
  };
}

// ── Cache ─────────────────────────────────────────────────────────────────────

/**
 * Identity of a render.  Everything that changes the samples is in the key,
 * and nothing that does not (clip position on the timeline, gain, fades) is —
 * moving a warped clip must not cost a re-render.
 */
export function warpKey(clip: Clip, sessionTempo: number | WarpTempo): string | null {
  const warp = clipWarp(clip);
  if (!warp) return null;
  const markers = warp.markers
    .map((m) => `${m.sourceSec.toFixed(6)}:${m.beat.toFixed(6)}`)
    .join(',');
  // The tempo's own key, not just its BPM: under a tempo map two clips at the
  // same nominal tempo can stretch differently because they sit on different
  // parts of the map, and a cache keyed on BPM alone would hand the second one
  // the first one's audio.
  const tempo = warpTempoFor(warp, sessionTempo);
  return [
    clip.fileId, warp.mode, tempo.key,
    clip.offsetSec.toFixed(6), clip.durationSec.toFixed(6), markers,
  ].join('|');
}

const CACHE_CAP = 24;
const cache = new Map<string, AudioBuffer>();

export function getWarped(key: string): AudioBuffer | undefined {
  const hit = cache.get(key);
  if (hit) { cache.delete(key); cache.set(key, hit); }     // LRU touch
  return hit;
}

export function clearWarpCache(): void { cache.clear(); }
export function warpCacheSize(): number { return cache.size; }

function store(key: string, buffer: AudioBuffer): AudioBuffer {
  cache.set(key, buffer);
  while (cache.size > CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return buffer;
}

/**
 * Render (or return) the warped buffer for a clip.  Returns null when the
 * clip is not warped or its source is not decoded yet — callers fall back to
 * playing the source directly, which is the right behaviour in both cases.
 */
export function ensureWarpedBuffer(
  ctx: BaseAudioContext, clip: Clip, sessionTempo: number | WarpTempo,
): AudioBuffer | null {
  const key = warpKey(clip, sessionTempo);
  if (!key) return null;
  const hit = getWarped(key);
  if (hit) return hit;

  const cached = getCached(clip.fileId);
  if (!cached) return null;

  const source = cached.buffer;
  const channels: Float32Array[] = [];
  for (let c = 0; c < source.numberOfChannels; c++) channels.push(source.getChannelData(c));

  const rendered = renderWarpedClip(channels, source.sampleRate, clip, sessionTempo);
  if (!rendered) return null;

  const length = rendered.channels[0]?.length ?? 0;
  if (length === 0) return null;
  const buffer = ctx.createBuffer(rendered.channels.length, length, rendered.sampleRate);
  for (let c = 0; c < rendered.channels.length; c++) {
    buffer.getChannelData(c).set(rendered.channels[c] ?? new Float32Array(length));
  }
  return store(key, buffer);
}

/** Pre-render every warped clip in a session — called before playback. */
export function prepareWarps(
  ctx: BaseAudioContext, clips: readonly Clip[], sessionTempo: number | WarpTempo,
): number {
  let rendered = 0;
  for (const clip of clips) {
    if (clip.kind !== 'audio') continue;
    const key = warpKey(clip, sessionTempo);
    if (!key || getWarped(key)) continue;
    if (ensureWarpedBuffer(ctx, clip, sessionTempo)) rendered++;
  }
  return rendered;
}

/** True when a warped clip still needs rendering before it can play. */
export function warpPending(clip: Clip, sessionTempo: number | WarpTempo): boolean {
  const key = warpKey(clip, sessionTempo);
  return key !== null && getWarped(key) === undefined;
}

/**
 * The same two entry points, for callers that have a session.
 *
 * Each clip resolves its own tempo, because under a map two clips at the same
 * nominal tempo genuinely stretch differently depending on where they sit.
 */
export function prepareWarpsForSession(
  ctx: BaseAudioContext, clips: readonly Clip[], session: DawSession,
): number {
  let rendered = 0;
  for (const clip of clips) {
    if (clip.kind !== 'audio' || !clipWarp(clip)) continue;
    const tempo = sessionWarpTempo(session, clip);
    const key = warpKey(clip, tempo);
    if (!key || getWarped(key)) continue;
    if (ensureWarpedBuffer(ctx, clip, tempo)) rendered++;
  }
  return rendered;
}

export function ensureWarpedBufferForSession(
  ctx: BaseAudioContext, clip: Clip, session: DawSession,
): AudioBuffer | null {
  return ensureWarpedBuffer(ctx, clip, sessionWarpTempo(session, clip));
}

export type { WarpConfig, WarpTempo };
export { asWarpTempo };
