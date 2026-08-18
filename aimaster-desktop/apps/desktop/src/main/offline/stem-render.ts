// stem-render — sum N processed stems into one master.
//
// The offline half of the stem session: each stem runs through its OWN
// chain, the results are summed through a mixer, and the sum runs through
// the master chain. Same Rust `MasteringChain` throughout — a stem chain
// and a master chain are the same engine with different settings, which is
// what makes this affordable at all.
//
// Three things here are not obvious and all three are load-bearing.
//
// # 1. Delay compensation, or the sum combs
//
// The chain reports `latencySamples()`, and it is not a constant: the STFT
// modules (de-noise, spectral shaper, hiss gate) add ~2048 samples, and a
// chain without them adds none. So a vocal with the de-esser and hiss gate
// engaged comes out ~43 ms later than a kick with neither.
//
// Summed unaligned, that is not "slightly late" — it is comb filtering
// between parts that were recorded together, and it sounds like a phaser
// nobody switched on.
//
// The fix is to remove each chain's OWN reported delay from its own output,
// which puts every stem back on the source timeline. Note that this is a
// complete alignment by itself: there is no second step that pushes the
// stems to a common offset. Doing both — as the first version of this file
// did — un-aligns exactly the stems the compensation was for, and the test
// that catches it counts impulses in the sum.
//
// # 2. The tail has to be flushed
//
// A chain that delays by L samples has L samples still inside it when the
// input runs out. Processing exactly `n` samples throws those away — the
// last 43 ms of the fade-out, silently. Each stem is padded with L samples
// of silence so the chain flushes, and the head trim puts it back in time.
//
// # 3. Stems are accumulated, not collected
//
// Twenty five-minute stereo stems is ~2.3 GB as float32. Decoding them all
// and then summing would run the machine out of memory on a real session.
// Each stem is instead decoded, processed, added into one accumulator and
// released, so peak memory is one accumulator plus one stem regardless of
// how many stems there are.

import {
  createOfflineChain, applyChainConfigForRender,
  type OfflineChainConfig, type WasmMasteringChain,
} from './load-mastering-chain-node.js';
import { decodeToFloatStereo, deinterleaveStereo } from './process-audio-file-rust.js';

/** One channel of the mixer. */
export interface StemTrack {
  filePath: string;
  /** Fader, dB. */
  gainDb: number;
  /**
   * Balance, -1 (hard left) .. +1 (hard right).
   *
   * Balance, not a pan law: these are stereo channels, and a mixer's stereo
   * channel attenuates the opposite side rather than applying an equal-power
   * curve to a signal that already has a stereo image.
   */
  pan: number;
  mute: boolean;
  solo: boolean;
  /** This stem's chain, or null to pass it through untouched. */
  config: OfflineChainConfig | null;
}

export interface StemRenderOptions {
  sampleRate: number;
  /** The master bus chain, applied to the sum. Null passes the sum through. */
  master: OfflineChainConfig | null;
  blockSize?: number;
  onProgress?: (frac: number, stage: string) => void;
}

export interface StemRenderReport {
  /** Stems that actually contributed (after mute / solo). */
  rendered: number;
  /** Stems skipped by mute or solo. */
  skipped: number;
  /**
   * Peak of the SUM before the master chain, dBFS.
   *
   * Above 0 is normal and not an error — the master chain is there to catch
   * it — but far above 0 means the faders are wrong and the master is doing
   * work that belongs on the mixer, so the caller can say so.
   */
  sumPeakDb: number;
  /** Peak of the finished master, dBFS. */
  outputPeakDb: number;
  /**
   * The largest chain delay that had to be compensated, in samples.
   *
   * Reported for display, not used as an offset — compensation removes each
   * chain's own delay rather than pushing everything to this one.
   */
  alignmentSamples: number;
  /** Per-stem chain latency, for display. */
  latencies: Array<{ filePath: string; samples: number }>;
  /**
   * False when the engine could not report latency, so no alignment was
   * possible. The sum is still produced — refusing to render would be
   * worse — but the caller must say so rather than presenting it as a
   * correct mix.
   */
  latencyAvailable: boolean;
  samples: number;
  durationSec: number;
  renderMs: number;
}

export interface StemRenderResult {
  left: Float32Array;
  right: Float32Array;
  report: StemRenderReport;
}

const DEFAULT_BLOCK = 512;

function dbToLin(db: number): number {
  return Math.pow(10, db / 20);
}

function dbfs(peak: number): number {
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

/** Balance gains for a stereo channel. */
export function balanceGains(pan: number): { l: number; r: number } {
  const p = Math.max(-1, Math.min(1, Number.isFinite(pan) ? pan : 0));
  return { l: p <= 0 ? 1 : 1 - p, r: p >= 0 ? 1 : 1 + p };
}

/**
 * Which tracks are audible.
 *
 * Solo wins over everything: if any track is soloed, the un-soloed ones are
 * silent no matter what their mute says. A track that is both soloed and
 * muted stays silent — an explicit mute is a stronger statement than a solo
 * left on from earlier.
 */
export function audibleTracks<T extends { mute: boolean; solo: boolean }>(tracks: readonly T[]): boolean[] {
  const anySolo = tracks.some((t) => t.solo && !t.mute);
  return tracks.map((t) => (t.mute ? false : anySolo ? t.solo : true));
}

/**
 * Latency a config's chain will add, in samples, or null when this WASM
 * build cannot report it.
 *
 * Null is not the same as zero and must not be collapsed into it: zero
 * means "aligned already", null means "alignment is impossible on this
 * build", and a caller that treats the second as the first sums stems that
 * are up to 43 ms apart and calls it a mix.
 */
export function chainLatency(config: OfflineChainConfig | null, sampleRate: number): number | null {
  if (!config) return 0;
  let chain: WasmMasteringChain | null = null;
  try {
    chain = createOfflineChain(sampleRate);
    applyChainConfigForRender(chain, config);
    if (typeof chain.latencySamples !== 'function') return null;
    const n = chain.latencySamples();
    return Number.isFinite(n) && n > 0 ? n : 0;
  } finally {
    chain?.free?.();
  }
}

/**
 * Run one buffer through one chain, flushing the tail and removing the
 * chain's own delay.
 *
 * The result is `outLength` samples long and sits on the SAME timeline as
 * the input, whatever the chain's latency was. That is the whole alignment:
 * two stems processed by chains with different latencies come out of this
 * function already lined up with each other.
 */
function renderAligned(
  inLeft: Float32Array,
  inRight: Float32Array,
  config: OfflineChainConfig | null,
  sampleRate: number,
  latency: number,
  outLength: number,
  blockSize: number,
): { left: Float32Array; right: Float32Array } {
  const n = Math.min(inLeft.length, inRight.length);
  const outL = new Float32Array(outLength);
  const outR = new Float32Array(outLength);

  if (!config) {
    const count = Math.min(n, outLength);
    for (let i = 0; i < count; i++) {
      outL[i] = inLeft[i]!;
      outR[i] = inRight[i]!;
    }
    return { left: outL, right: outR };
  }

  // Padded by `latency` so the chain's internal buffer is flushed out.
  const total = n + latency;
  const work = new Float32Array(total);
  const workR = new Float32Array(total);
  work.set(inLeft.subarray(0, n));
  workR.set(inRight.subarray(0, n));

  let chain: WasmMasteringChain | null = null;
  try {
    chain = createOfflineChain(sampleRate);
    chain.reset();
    applyChainConfigForRender(chain, config);

    for (let pos = 0; pos < total; pos += blockSize) {
      const end = Math.min(pos + blockSize, total);
      // wasm-bindgen copies in and back out, so the block has to be handed
      // over as its own array and written back.
      const lb = work.subarray(pos, end).slice();
      const rb = workR.subarray(pos, end).slice();
      chain.processStereo(lb, rb);
      work.set(lb, pos);
      workR.set(rb, pos);
    }
  } finally {
    chain?.free?.();
  }

  // The chain's output is late by `latency`; reading from there removes it.
  for (let i = 0; i < n; i++) {
    if (i >= outLength) break;
    const src = latency + i;
    if (src >= total) break;
    outL[i] = work[src]!;
    outR[i] = workR[src]!;
  }
  return { left: outL, right: outR };
}

/**
 * Decode, process, mix and master a stem session.
 *
 * Throws if no stem is audible or if every decode fails — a render that
 * quietly returns silence is worse than one that says why.
 */
export async function renderStemSession(
  tracks: readonly StemTrack[],
  opts: StemRenderOptions,
): Promise<StemRenderResult> {
  const t0 = Date.now();
  const sr = opts.sampleRate;
  const block = opts.blockSize ?? DEFAULT_BLOCK;
  const progress = opts.onProgress;

  if (tracks.length === 0) throw new Error('스템이 없습니다.');

  const audible = audibleTracks(tracks);
  const playing = tracks.filter((_, i) => audible[i]);
  if (playing.length === 0) {
    throw new Error('들리는 스템이 없습니다 — 모두 뮤트되었거나 솔로가 다른 스템에 걸려 있습니다.');
  }

  // ── Pass 1: latencies ────────────────────────────────────────────────────
  // Every chain is built and asked how much delay it adds, BEFORE anything
  // is rendered — the alignment target is the longest of them and cannot be
  // known one stem at a time.
  progress?.(0, '지연 측정');
  const measured = playing.map((t) => ({
    filePath: t.filePath,
    reported: chainLatency(t.config, sr),
  }));
  const latencyAvailable = measured.every((m) => m.reported !== null);
  const latencies = measured.map((m) => ({ filePath: m.filePath, samples: m.reported ?? 0 }));
  const alignTo = latencies.reduce((m, l) => Math.max(m, l.samples), 0);

  // ── Pass 2: decode, process, accumulate ──────────────────────────────────
  let sumL = new Float32Array(0);
  let sumR = new Float32Array(0);
  let length = 0;
  let rendered = 0;
  const failures: string[] = [];

  for (let i = 0; i < playing.length; i++) {
    const track = playing[i]!;
    progress?.(i / playing.length, `스템 ${i + 1}/${playing.length}`);

    let left: Float32Array;
    let right: Float32Array;
    try {
      const interleaved = await decodeToFloatStereo(track.filePath, sr);
      ({ left, right } = deinterleaveStereo(interleaved));
    } catch (err) {
      failures.push(`${track.filePath}: ${(err as Error).message}`);
      continue;
    }

    // Compensation removes each chain's delay rather than adding one, so
    // the session is exactly as long as its longest stem.
    const need = left.length;
    if (need > length) {
      const nl = new Float32Array(need);
      const nr = new Float32Array(need);
      nl.set(sumL); nr.set(sumR);
      sumL = nl; sumR = nr;
      length = need;
    }

    const lat = latencies[i]!.samples;
    const processed = renderAligned(left, right, track.config, sr, lat, length, block);

    const g = dbToLin(Number.isFinite(track.gainDb) ? track.gainDb : 0);
    const bal = balanceGains(track.pan);
    const gl = g * bal.l;
    const gr = g * bal.r;
    for (let s = 0; s < length; s++) {
      sumL[s]! += processed.left[s]! * gl;
      sumR[s]! += processed.right[s]! * gr;
    }
    rendered++;
  }

  if (rendered === 0) {
    throw new Error(`스템을 하나도 읽지 못했습니다 — ${failures.join(' / ')}`);
  }

  let sumPeak = 0;
  for (let i = 0; i < length; i++) {
    const a = Math.abs(sumL[i]!); if (a > sumPeak) sumPeak = a;
    const b = Math.abs(sumR[i]!); if (b > sumPeak) sumPeak = b;
  }

  // ── Pass 3: the master bus ───────────────────────────────────────────────
  progress?.(0.9, '마스터 버스');
  let outL: Float32Array = sumL;
  let outR: Float32Array = sumR;
  if (opts.master) {
    // The master's delay is removed the same way, so the finished file
    // starts where the session starts.
    const masterLat = chainLatency(opts.master, sr) ?? 0;
    const out = renderAligned(sumL, sumR, opts.master, sr, masterLat, length, block);
    outL = out.left;
    outR = out.right;
  }

  let outPeak = 0;
  for (let i = 0; i < length; i++) {
    const a = Math.abs(outL[i]!); if (a > outPeak) outPeak = a;
    const b = Math.abs(outR[i]!); if (b > outPeak) outPeak = b;
  }

  progress?.(1, '완료');

  return {
    left: outL,
    right: outR,
    report: {
      rendered,
      skipped: tracks.length - rendered,
      sumPeakDb: dbfs(sumPeak),
      outputPeakDb: dbfs(outPeak),
      alignmentSamples: alignTo,
      latencies,
      latencyAvailable,
      samples: length,
      durationSec: length / sr,
      renderMs: Date.now() - t0,
    },
  };
}
