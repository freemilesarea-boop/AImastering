// waveform-peaks — what a track looks like.
//
// A DAW's arrange window is mostly waveforms, and a waveform is the one
// thing in this product a user can check against their own ears instantly:
// if the picture does not match the take, nothing else on the screen is
// trusted either. So these are real minima and maxima of the real decoded
// audio, not an envelope or an RMS curve dressed up as one.
//
// # Why min AND max
//
// Drawing |x| gives a symmetric blob and loses the asymmetry that makes a
// snare look like a snare. Keeping the extremes of each bucket and drawing
// between them is what a DAW draws, and it costs the same.
//
// # Why it is cached
//
// Decoding a five-minute stem is seconds; a twelve-stem session drawn on
// every mount would be a minute of staring at an empty arrange window. The
// key is the file's size and mtime, so a stem re-exported from the DAW
// redraws and an untouched one is instant.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { decodeToFloatStereo, deinterleaveStereo } from './process-audio-file-rust.js';

export interface WaveformPeaks {
  /** Buckets across the whole file. */
  count: number;
  /** Per-bucket minimum, -1..1, interleaved with `max` by index. */
  min: number[];
  max: number[];
  /** Per-bucket RMS, for the fill a DAW draws inside the outline. */
  rms: number[];
  durationSec: number;
  sampleRate: number;
  cached: boolean;
  computeMs: number;
}

/**
 * Buckets per file.
 *
 * Fixed rather than per-pixel: the arrange window zooms, and re-decoding on
 * every zoom step would make zooming the slowest thing in the app. 2000 is
 * finer than any single screen shows, so zooming in reads more of the same
 * array and only a very deep zoom loses detail — at which point the answer
 * is a second pass at higher resolution, not a slower first one.
 */
const BUCKETS = 2000;

const CACHE_DIR = path.join(os.tmpdir(), 'aimaster-waveform');

/** Identity of a file's peaks: the path plus what would change its audio. */
export function peaksKey(filePath: string): string {
  let stat = 'missing';
  try {
    const st = fs.statSync(filePath);
    stat = `${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch { /* a missing file fails the decode with a real message */ }
  return crypto.createHash('sha1').update(`${filePath} ${stat} ${BUCKETS}`).digest('hex').slice(0, 24);
}

/**
 * Reduce a stereo buffer to per-bucket extremes.
 *
 * Both channels feed the same bucket: the arrange window draws one lane per
 * track, and a lane that showed only the left channel would hide a hard-
 * panned part entirely.
 */
export function computePeaks(
  left: Float32Array,
  right: Float32Array,
  buckets = BUCKETS,
): { min: number[]; max: number[]; rms: number[] } {
  const n = Math.min(left.length, right.length);
  const min = new Array<number>(buckets).fill(0);
  const max = new Array<number>(buckets).fill(0);
  const rms = new Array<number>(buckets).fill(0);
  if (n === 0) return { min, max, rms };

  const per = n / buckets;
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * per);
    const end = Math.min(n, Math.max(start + 1, Math.floor((b + 1) * per)));
    let lo = Infinity;
    let hi = -Infinity;
    let sum = 0;
    let count = 0;
    for (let i = start; i < end; i++) {
      const a = left[i]!;
      const c = right[i]!;
      if (a < lo) lo = a;
      if (c < lo) lo = c;
      if (a > hi) hi = a;
      if (c > hi) hi = c;
      sum += a * a + c * c;
      count += 2;
    }
    min[b] = Number.isFinite(lo) ? lo : 0;
    max[b] = Number.isFinite(hi) ? hi : 0;
    rms[b] = count > 0 ? Math.sqrt(sum / count) : 0;
  }
  return { min, max, rms };
}

/** Peaks for a file, decoded once and cached. */
export async function waveformPeaks(filePath: string, sampleRate = 48_000): Promise<WaveformPeaks> {
  const t0 = Date.now();
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const cachePath = path.join(CACHE_DIR, `${peaksKey(filePath)}.json`);
  if (fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as WaveformPeaks;
      return { ...cached, cached: true, computeMs: Date.now() - t0 };
    } catch { /* corrupt cache — recompute */ }
  }

  const interleaved = await decodeToFloatStereo(filePath, sampleRate);
  const { left, right } = deinterleaveStereo(interleaved);
  const { min, max, rms } = computePeaks(left, right, BUCKETS);

  const result: WaveformPeaks = {
    count: BUCKETS,
    min, max, rms,
    durationSec: left.length / sampleRate,
    sampleRate,
    cached: false,
    computeMs: Date.now() - t0,
  };

  try {
    fs.writeFileSync(cachePath, JSON.stringify(result));
  } catch { /* the cache is an optimisation */ }

  return result;
}

/** Delete every cached waveform. */
export function clearPeaksCache(): number {
  let removed = 0;
  try {
    for (const name of fs.readdirSync(CACHE_DIR)) {
      try { fs.unlinkSync(path.join(CACHE_DIR, name)); removed++; } catch { /* ignore */ }
    }
  } catch { /* no cache yet */ }
  return removed;
}
