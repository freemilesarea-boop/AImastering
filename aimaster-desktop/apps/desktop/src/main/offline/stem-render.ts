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
  createOfflineChain, applyChainConfigForRender, withInputGain,
  type OfflineChainConfig, type WasmMasteringChain,
} from './load-mastering-chain-node.js';
import { decodeToFloatStereo, deinterleaveStereo } from './process-audio-file-rust.js';
import { measureStereoLoudness, solveLoudnessGain } from './offline-loudness.js';

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

/** Loudness normalisation for the master bus. */
export interface MasterLoudnessTarget {
  targetLufs: number;
  /** Largest upward correction allowed, dB. Defaults to `DEFAULT_MAX_BOOST_DB`. */
  maxBoostDb?: number;
  /** Largest downward correction allowed, dB (negative). */
  maxCutDb?: number;
}

export interface StemRenderOptions {
  sampleRate: number;
  /** The master bus chain, applied to the sum. Null passes the sum through. */
  master: OfflineChainConfig | null;
  /**
   * Normalise the finished master to a loudness target.
   *
   * Done as a two-pass measure-then-correct rather than with the chain's
   * realtime loudness module, for the reason the master render already uses
   * two passes: an AGC has to guess while it plays, so it moves during quiet
   * sections and lands near the target; a measurement of the whole file
   * lands on it. And it is cheap here, because the second pass re-runs only
   * the MASTER chain over the already-summed buffer — the stems and their
   * chains are not touched again.
   */
  masterTarget?: MasterLoudnessTarget | null;
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
  /** Integrated loudness of the finished master, LUFS. */
  masterLufs: number;
  /** True peak of the finished master, dBTP. */
  masterTruePeakDb: number;
  /** Loudness correction applied on the second master pass, dB. */
  loudnessGainDb: number;
  /**
   * Why the correction was what it was.
   *
   * `clamped-boost` / `clamped-cut` mean the target was further away than
   * the policy allows, so the master did NOT reach it — the caller has to
   * say so rather than showing a target the file does not meet.
   */
  loudnessNote: 'ok' | 'silence' | 'clamped-boost' | 'clamped-cut' | 'ceiling-limited' | 'not-requested';
  /** How many master passes the correction took. */
  loudnessPasses: number;
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

/** How close to the target counts as landing on it, dB. */
const LOUDNESS_TOLERANCE_DB = 0.3;
/**
 * Most correction passes to spend on the master.
 *
 * Four is enough for the correction to converge on anything reachable; when
 * it has not converged by then the target is not reachable through this
 * chain's ceiling and more passes would only confirm that more slowly.
 */
const MAX_LOUDNESS_PASSES = 4;
/**
 * Default ceiling on the upward correction, dB.
 *
 * Higher than the single-file master render's 12, because a stem session
 * starts wherever the faders left it. A sum sitting 15 dB under a loud
 * target is an ordinary result of sensible gain staging, and a 12 dB cap
 * would refuse it — measured: the loud preset reached only -14.5 LUFS
 * against a -8 target at 12 dB, and -12.6 at 18.
 *
 * It stays bounded rather than unlimited so a nearly-silent session cannot
 * be amplified by 30 dB into a wall of its own noise floor.
 */
const DEFAULT_MAX_BOOST_DB = 18;

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
  let loudnessGainDb = 0;
  let loudnessNote: StemRenderReport['loudnessNote'] = 'not-requested';
  let loudnessPasses = 0;

  if (opts.master) {
    // The master's delay is removed the same way, so the finished file
    // starts where the session starts.
    const masterLat = chainLatency(opts.master, sr) ?? 0;
    const out = renderAligned(sumL, sumR, opts.master, sr, masterLat, length, block);
    outL = out.left;
    outR = out.right;

    if (opts.masterTarget) {
      // Measure what the master chain produced, work out the correction,
      // and re-run the master with it as INPUT gain. Input, not output:
      // pushing the level before the limiter is what makes a track louder;
      // adding it after would just move the ceiling.
      progress?.(0.95, '라우드니스 맞추기');
      const target = opts.masterTarget.targetLufs;
      const policy = {
        maxBoostDb: opts.masterTarget.maxBoostDb ?? DEFAULT_MAX_BOOST_DB,
        ...(opts.masterTarget.maxCutDb !== undefined ? { maxCutDb: opts.masterTarget.maxCutDb } : {}),
      };

      let measured = measureStereoLoudness(outL, outR, sr).integratedLufs;
      let total = 0;
      let clamped: 'clamped-boost' | 'clamped-cut' | 'silence' | null = null;
      let saturated = false;

      // Iterate, because a chain with a limiter in it is not linear in its
      // input gain. A single measure-and-correct pass assumes +6 dB in gives
      // +6 dB out; once the limiter is working, most of what is added at the
      // input is taken straight back off, and a correction computed that way
      // undershoots — by 7 dB on dense material aiming at a loud target.
      //
      // Each pass costs one run of the MASTER chain over the already-summed
      // buffer. The stems and their chains are not touched again, so this is
      // a few seconds on a full session, not a re-render.
      for (loudnessPasses = 1; loudnessPasses <= MAX_LOUDNESS_PASSES; loudnessPasses++) {
        const solved = solveLoudnessGain(measured, target, policy);
        if (solved.note === 'silence') { clamped = 'silence'; break; }

        // The policy bounds the TOTAL correction, not each step of it.
        const wanted = total + solved.appliedGainDb;
        const bounded = Math.max(policy.maxCutDb ?? -24, Math.min(policy.maxBoostDb ?? 12, wanted));
        if (bounded !== wanted) clamped = wanted > bounded ? 'clamped-boost' : 'clamped-cut';

        const step = bounded - total;
        if (Math.abs(step) < 0.05) break;

        const cfgN = withInputGain(opts.master, bounded);
        const outN = renderAligned(sumL, sumR, cfgN, sr, chainLatency(cfgN, sr) ?? 0, length, block);
        const after = measureStereoLoudness(outN.left, outN.right, sr).integratedLufs;

        // More gain in, no more loudness out: the ceiling is holding the
        // level and no further correction will move it. Stopping here and
        // saying so is the honest outcome — continuing would add another
        // 12 dB of limiting for nothing.
        if (Math.abs(step) > 0.5 && (after - measured) < Math.abs(step) * 0.1 && step > 0) {
          saturated = true;
          outL = outN.left; outR = outN.right;
          total = bounded; measured = after;
          break;
        }

        outL = outN.left; outR = outN.right;
        total = bounded;
        measured = after;

        if (Math.abs(target - measured) <= LOUDNESS_TOLERANCE_DB) break;
      }

      loudnessPasses = Math.min(loudnessPasses, MAX_LOUDNESS_PASSES);
      loudnessGainDb = total;
      loudnessNote = clamped === 'silence' ? 'silence'
        : saturated ? 'ceiling-limited'
        : clamped ?? (Math.abs(target - measured) <= LOUDNESS_TOLERANCE_DB ? 'ok' : 'ceiling-limited');
    }
  } else if (opts.masterTarget) {
    // A loudness target with no master chain would have no limiter to hold
    // the ceiling, so the correction would simply clip. Refused rather than
    // half-done.
    throw new Error('라우드니스 목표를 맞추려면 마스터 버스 체인이 필요합니다 (리미터가 피크를 잡아야 합니다).');
  }

  let outPeak = 0;
  for (let i = 0; i < length; i++) {
    const a = Math.abs(outL[i]!); if (a > outPeak) outPeak = a;
    const b = Math.abs(outR[i]!); if (b > outPeak) outPeak = b;
  }

  const finalMeasure = measureStereoLoudness(outL, outR, sr);
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
      masterLufs: finalMeasure.integratedLufs,
      masterTruePeakDb: finalMeasure.truePeakDbtp,
      loudnessGainDb,
      loudnessNote,
      loudnessPasses,
      samples: length,
      durationSec: length / sr,
      renderMs: Date.now() - t0,
    },
  };
}
