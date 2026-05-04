// ITU-R BS.1770-4 loudness analyzer — pure-JS, no DOM dependency.
//
// Provides:
//   • getLoudnessMetrics(buffer)      — one-shot for an AudioBuffer
//   • LoudnessAnalyzer (class)        — streaming, fed sample blocks
//
// All three loudness windows (Momentary 400 ms / Short-term 3 s /
// Integrated whole-program) are computed in a single pass over a shared
// 100-ms grid of mean-square sums.  Memory cost is O(programSeconds * 10)
// floats — for a 10-minute song that's 6,000 floats (~24 kB).
//
// Channel weights per BS.1770-4 §1.2:
//   L = R = C = 1.0
//   LFE     = 0   (excluded)
//   Ls = Rs = 1.41
//
// Reference layouts assumed for channel index:
//   1  ch:  [Mono]                          (treat as L, weight 1.0)
//   2  ch:  [L, R]
//   3  ch:  [L, R, C]
//   4  ch:  [L, R, Ls, Rs]                  (quad)
//   5  ch:  [L, R, C, Ls, Rs]
//   6  ch:  [L, R, C, LFE, Ls, Rs]          (5.1)
//   8  ch:  [L, R, C, LFE, Ls, Rs, Lb, Rb]  (7.1 — back as surround weight)
// Anything else: every channel weighted 1.0 (safe default).

import { KWeightingFilter, makeKWeightingBank } from './kWeighting.js';
import { TruePeakBank } from './truePeak.js';

export interface LoudnessMetrics {
  // BS.1770-4 measurements
  integratedLufs:  number;   // -Infinity for silence
  shortTermLufs:   number;   // most-recent 3 s
  momentaryLufs:   number;   // most-recent 400 ms
  // True-peak (BS.1770-4 Annex 2)
  truePeakDbtp:    number;   // overall max across channels
  perChannelTpDb:  number[];
  // Companion stats
  loudnessRange:   number;   // EBU LRA (R128 §3.6)
  // Diagnostics
  durationSec:     number;
  sampleRate:      number;
  channels:        number;
  blocksAnalyzed:  number;
}

// Channel weight lookup (per layout convention above).
export function getChannelWeights(numChannels: number): number[] {
  const w = new Array<number>(numChannels).fill(1.0);
  switch (numChannels) {
    case 1: return [1.0];
    case 2: return [1.0, 1.0];
    case 3: return [1.0, 1.0, 1.0];
    case 4: return [1.0, 1.0, 1.41, 1.41];
    case 5: return [1.0, 1.0, 1.0, 1.41, 1.41];
    case 6: return [1.0, 1.0, 1.0, 0.0, 1.41, 1.41];
    case 8: return [1.0, 1.0, 1.0, 0.0, 1.41, 1.41, 1.41, 1.41];
    default: return w;
  }
}

// LUFS = -0.691 + 10 log10( Σ_c G_c · meanSquare_c )
// where G_c is the channel weight and meanSquare_c is the mean of the
// K-weighted squared signal over the integration window.
const LUFS_OFFSET_DB = -0.691;

function meanSquareToLufs(weightedMs: number): number {
  if (weightedMs <= 0) return -Infinity;
  return LUFS_OFFSET_DB + 10 * Math.log10(weightedMs);
}

// Streaming analyzer — accumulates 100-ms "sub-blocks" of K-weighted
// sum-of-squares, then derives momentary/short-term/integrated by sliding
// 4-block (400 ms) and 30-block (3 s) windows over them.
export class LoudnessAnalyzer {
  public readonly sampleRate: number;
  public readonly channels:   number;
  public readonly weights:    number[];

  private kFilters: KWeightingFilter[];
  private tp:       TruePeakBank;

  // 100-ms sub-block accumulator (per channel sum of K²).
  private subSamplesNeeded: number;   // = round(sampleRate * 0.1)
  private subAccum:        Float64Array;  // [ch] partial Σx²
  private subSamplesIn:    number;        // count toward next sub-block

  // History of fully-formed sub-blocks: each entry is the per-channel mean
  // square (Σx² / N) for that 100-ms slice.  Stored as flat Float64Array
  // [block * channels + ch].  Pushed in arrival order.
  private subBlocks: number[][] = [];   // each row = [ch] mean squares

  // Running gating buckets — for integrated loudness we keep weighted-MS of
  // every 400-ms (4-block) momentary window so we can apply -10 LU relative
  // gating at the end without re-walking the audio.
  private momentaryBlockMs: number[] = [];   // weighted MS, one per 100-ms hop

  // For LRA we keep all short-term (3 s) values, computed on the same hop.
  private shortTermBlockMs: number[] = [];

  // Latest sliding-window readings — useful for streaming UI.
  private lastMomentaryLufs = -Infinity;
  private lastShortTermLufs = -Infinity;

  // Total sample count across all process() calls — for duration.
  private totalSamples = 0;

  constructor(sampleRate: number, channels: number) {
    this.sampleRate = sampleRate;
    this.channels   = channels;
    this.weights    = getChannelWeights(channels);
    this.kFilters   = makeKWeightingBank(sampleRate, channels);
    this.tp         = new TruePeakBank(channels);
    this.subSamplesNeeded = Math.round(sampleRate * 0.1);
    this.subAccum         = new Float64Array(channels);
    this.subSamplesIn     = 0;
  }

  reset(): void {
    for (const f of this.kFilters) f.reset();
    this.tp.reset();
    this.subAccum.fill(0);
    this.subSamplesIn      = 0;
    this.subBlocks         = [];
    this.momentaryBlockMs  = [];
    this.shortTermBlockMs  = [];
    this.lastMomentaryLufs = -Infinity;
    this.lastShortTermLufs = -Infinity;
    this.totalSamples      = 0;
  }

  // Feed a planar block of audio samples.  `data[c]` is one channel's
  // Float32Array (length = N).  All channels MUST be the same length.
  processBlock(data: ArrayLike<Float32Array> | Float32Array[]): void {
    if (this.channels === 0) return;
    const ch0 = data[0] as Float32Array;
    const nFrames = ch0.length;
    for (let f = 0; f < nFrames; f++) {
      for (let c = 0; c < this.channels; c++) {
        const x = (data[c] as Float32Array)[f] as number;
        (this.tp.channels[c] as NonNullable<typeof this.tp.channels[number]>).process(x);
        const k = (this.kFilters[c] as KWeightingFilter).process(x);
        this.subAccum[c] = (this.subAccum[c] as number) + k * k;
      }
      this.subSamplesIn++;
      if (this.subSamplesIn >= this.subSamplesNeeded) this.commitSubBlock();
    }
    this.totalSamples += nFrames;
  }

  // Variant: interleaved Float32Array (frame-major: [s0c0, s0c1, s1c0, s1c1, ...])
  processInterleaved(buf: Float32Array): void {
    if (this.channels === 0) return;
    const nFrames = (buf.length / this.channels) | 0;
    let idx = 0;
    for (let f = 0; f < nFrames; f++) {
      for (let c = 0; c < this.channels; c++) {
        const x = buf[idx++] as number;
        (this.tp.channels[c] as NonNullable<typeof this.tp.channels[number]>).process(x);
        const k = (this.kFilters[c] as KWeightingFilter).process(x);
        this.subAccum[c] = (this.subAccum[c] as number) + k * k;
      }
      this.subSamplesIn++;
      if (this.subSamplesIn >= this.subSamplesNeeded) this.commitSubBlock();
    }
    this.totalSamples += nFrames;
  }

  // Close out the currently accumulating 100-ms slot, slide the
  // momentary/short-term windows, refresh the cached values.
  private commitSubBlock(): void {
    const N = this.subSamplesIn;
    const row: number[] = new Array(this.channels);
    for (let c = 0; c < this.channels; c++) {
      row[c] = (this.subAccum[c] as number) / N;   // mean square
      this.subAccum[c] = 0;
    }
    this.subBlocks.push(row);
    this.subSamplesIn = 0;

    const nBlocks = this.subBlocks.length;

    // ── Momentary (400 ms = 4 most-recent sub-blocks) ────────────────────
    if (nBlocks >= 4) {
      const wms = this.windowWeightedMs(nBlocks - 4, 4);
      this.momentaryBlockMs.push(wms);
      this.lastMomentaryLufs = meanSquareToLufs(wms);
    } else {
      // Not enough data yet — push 0 (will be gated out anyway).
      this.momentaryBlockMs.push(0);
    }

    // ── Short-term (3 s = 30 most-recent sub-blocks) ─────────────────────
    if (nBlocks >= 30) {
      const wms = this.windowWeightedMs(nBlocks - 30, 30);
      this.shortTermBlockMs.push(wms);
      this.lastShortTermLufs = meanSquareToLufs(wms);
    } else {
      this.shortTermBlockMs.push(0);
    }
  }

  // Sum_c { W_c · ( (1/winLen) Σ_block meanSquare_c[block] ) }
  // over a window of `winLen` consecutive sub-blocks starting at `start`.
  private windowWeightedMs(start: number, winLen: number): number {
    let total = 0;
    for (let c = 0; c < this.channels; c++) {
      const w = this.weights[c] as number;
      if (w === 0) continue;
      let sum = 0;
      for (let i = 0; i < winLen; i++) sum += (this.subBlocks[start + i] as number[])[c] as number;
      total += w * (sum / winLen);
    }
    return total;
  }

  // Latest sliding-window values — cheap, suitable for 100-ms UI updates.
  getMomentaryLufs(): number { return this.lastMomentaryLufs; }
  getShortTermLufs(): number { return this.lastShortTermLufs; }

  // Two-pass gated integrated loudness per BS.1770-4 §5.6 + EBU R128.
  //   1. Drop momentary blocks below the absolute -70 LUFS gate.
  //   2. Compute mean of the survivors → relative threshold = mean - 10 LU.
  //   3. Mean of survivors above relative threshold → integrated.
  getIntegratedLufs(): number {
    const G_ABS_DB = -70;
    const G_REL_DB = -10;

    // Convert -70 LUFS back to weighted-MS: ms = 10^((-70 + 0.691)/10)
    const absGateMs = Math.pow(10, (G_ABS_DB - LUFS_OFFSET_DB) / 10);

    // Pass 1.
    const survivors: number[] = [];
    for (const ms of this.momentaryBlockMs) {
      if (ms > absGateMs) survivors.push(ms);
    }
    if (survivors.length === 0) return -Infinity;

    let sum = 0;
    for (const ms of survivors) sum += ms;
    const meanMs = sum / survivors.length;
    const meanLufs = meanSquareToLufs(meanMs);

    // Pass 2: relative gate at meanLufs + G_REL_DB.
    const relGateMs = Math.pow(10, (meanLufs + G_REL_DB - LUFS_OFFSET_DB) / 10);
    let sum2 = 0;
    let n2   = 0;
    for (const ms of survivors) {
      if (ms > relGateMs) { sum2 += ms; n2++; }
    }
    if (n2 === 0) return -Infinity;
    return meanSquareToLufs(sum2 / n2);
  }

  // EBU R128 §3.6 Loudness Range: difference between the 95th and 10th
  // percentile of short-term blocks that pass an absolute (-70 LUFS) and
  // a relative (-20 LU) gate.
  getLoudnessRange(): number {
    const G_ABS_DB = -70;
    const G_REL_DB = -20;
    const absGateMs = Math.pow(10, (G_ABS_DB - LUFS_OFFSET_DB) / 10);

    // Stage-1 absolute gate.
    const survivors: number[] = [];
    for (const ms of this.shortTermBlockMs) {
      if (ms > absGateMs) survivors.push(ms);
    }
    if (survivors.length < 2) return 0;

    // Stage-2: relative gate on the LUFS values themselves, threshold =
    // power-mean LUFS of the survivors - 20 LU.
    let sum = 0;
    for (const ms of survivors) sum += ms;
    const meanLufs = meanSquareToLufs(sum / survivors.length);
    const relGateMs = Math.pow(10, (meanLufs + G_REL_DB - LUFS_OFFSET_DB) / 10);

    const lufsList: number[] = [];
    for (const ms of survivors) {
      if (ms > relGateMs) lufsList.push(meanSquareToLufs(ms));
    }
    if (lufsList.length < 2) return 0;

    lufsList.sort((a, b) => a - b);
    const pick = (p: number): number => {
      const idx = Math.min(lufsList.length - 1,
                           Math.max(0, Math.floor(p * (lufsList.length - 1))));
      return lufsList[idx] as number;
    };
    return pick(0.95) - pick(0.10);
  }

  // Snapshot — call any time, including during streaming.
  getMetrics(): LoudnessMetrics {
    return {
      integratedLufs: this.getIntegratedLufs(),
      shortTermLufs:  this.lastShortTermLufs,
      momentaryLufs:  this.lastMomentaryLufs,
      truePeakDbtp:   this.tp.maxPeakDb(),
      perChannelTpDb: this.tp.perChannelPeakDb(),
      loudnessRange:  this.getLoudnessRange(),
      durationSec:    this.totalSamples / this.sampleRate,
      sampleRate:     this.sampleRate,
      channels:       this.channels,
      blocksAnalyzed: this.subBlocks.length,
    };
  }
}

// ── Public one-shot API ───────────────────────────────────────────────────────
//
// Accepts a Web-Audio AudioBuffer (renderer / OfflineAudioContext) OR a
// duck-typed { sampleRate, numberOfChannels, getChannelData(c) } object so
// the same routine works in tests with a stub.

export interface AudioBufferLike {
  sampleRate:        number;
  numberOfChannels:  number;
  length?:           number;
  getChannelData(c: number): Float32Array;
}

export function getLoudnessMetrics(buf: AudioBufferLike): LoudnessMetrics {
  const channels = buf.numberOfChannels;
  const sr       = buf.sampleRate;
  const an       = new LoudnessAnalyzer(sr, channels);

  // Process in 8192-frame chunks to keep transient memory low.
  const ch0 = buf.getChannelData(0);
  const total = ch0.length;
  const CHUNK = 8192;

  // Pre-fetch channel arrays once (Web-Audio getChannelData is cheap on
  // modern impls but not free).
  const chans: Float32Array[] = new Array(channels);
  for (let c = 0; c < channels; c++) chans[c] = buf.getChannelData(c);

  // Scratch planar view (slice copies the data — we want a view).  Use
  // subarray to share the underlying buffer.
  const view: Float32Array[] = new Array(channels);

  let pos = 0;
  while (pos < total) {
    const len = Math.min(CHUNK, total - pos);
    for (let c = 0; c < channels; c++) view[c] = (chans[c] as Float32Array).subarray(pos, pos + len);
    an.processBlock(view);
    pos += len;
  }
  return an.getMetrics();
}
