// Running a separation model over a stem.
//
// ── What this is asked to do, and what it deliberately is not ────────────────
//
// It does NOT separate the mix.  It takes a stem the DSP separator has already
// made — in practice 그 외 — and splits it into that stem's children.
//
// That is not a smaller ambition, it is a better shape, for three reasons:
//
//   THE SUM SURVIVES.  `stem-tree.ts` says 기타 · 건반 · 신스 · 스트링 · 브라스 ·
//   목관 · 퍼커션 · 그 밖 are all children of 그 외.  If the model's masks sum to
//   one over the children, the children sum to 그 외, and the whole set still
//   adds back up to the record — the property that makes stems usable as an
//   edit rather than as eight approximations.
//
//   THE PROBLEM IS EASIER.  Telling a guitar from a piano is hard.  Telling a
//   guitar from a piano AFTER the vocal, the drums and the bass are gone is the
//   same problem with three quarters of the interference removed.
//
//   `separate()` STAYS SYNCHRONOUS.  Inference is asynchronous and the DSP
//   separator is a long synchronous chunk loop with its own context rules.
//   Threading a promise through it would have meant rewriting all of it and
//   every test that calls it, to make the DSP wait on something it does not
//   use.  The model runs afterwards, where the code is already async.
//
// ── The contract ─────────────────────────────────────────────────────────────
//
//   input   `mix`    float32 [1, channels, frames, bins]  magnitude
//   output  `masks`  float32 [1, stems, channels, frames, bins]  in [0,1]
//
// Masks and not audio, because a mask composes with everything above it and
// waveform output does not: the residual is exact by construction rather than
// by the model's good behaviour.  `stems` is in the order the descriptor lists.
//
// ── What it refuses ──────────────────────────────────────────────────────────
//
// A model trained at a sample rate other than the audio's.  Resampling is a
// real piece of work with real audible consequences and doing it badly here
// would show up as a quality loss nobody could trace back to this decision.
// Until there is a resampler worth the name, this says the two numbers and
// stops.

import {
  Overlap, SEPARATION_STFT, analyse, denominatorFor, frameCount, magnitudes,
  type SpectrumOptions,
} from './spectrum.js';
import { stemLabel, type StemKind } from './stem-tree.js';
import type { ModelDescriptor } from './model-registry.js';

/** The bit of onnxruntime this needs, named so it can be faked in a test. */
export interface InferenceLike {
  run(feeds: Record<string, TensorLike>): Promise<Record<string, TensorLike>>;
}
export interface TensorLike {
  readonly data: Float32Array;
  readonly dims: readonly number[];
}
/** Constructs the runtime's tensor type.  Injected for the same reason. */
export type MakeTensor = (data: Float32Array, dims: number[]) => TensorLike;

export interface ModelRunOptions {
  stft: SpectrumOptions;
  /**
   * Frames handed to the model at once.
   *
   * Bounded because the masks are the model's output and they are
   * frames × bins × stems × channels floats: on a four-minute file with eight
   * children that is a gigabyte and a half if it is done in one call.  Applied
   * and accumulated a segment at a time it is a few megabytes.
   */
  segmentFrames: number;
}

export const DEFAULT_MODEL_RUN: ModelRunOptions = {
  stft: SEPARATION_STFT,
  segmentFrames: 512,
};

export interface ModelRunResult {
  /** One entry per stem the descriptor declares, in that order. */
  stems: Array<{ kind: StemKind; channels: Float32Array[] }>;
  /** dB of `input − Σ children` against the input.  Measured, not asserted. */
  reconstructionDb: number;
  elapsedMs: number;
}

export type ModelProgress = (fraction: number) => void;

/**
 * Split `channels` into the descriptor's stems using `session`.
 *
 * `channels` is the parent stem's audio, already at `sampleRate`.
 */
export async function runModel(
  channels: readonly Float32Array[], sampleRate: number,
  descriptor: ModelDescriptor, session: InferenceLike, tensor: MakeTensor,
  options: Partial<ModelRunOptions> = {}, onProgress: ModelProgress = () => {},
): Promise<ModelRunResult> {
  const started = Date.now();
  const opts: ModelRunOptions = { ...DEFAULT_MODEL_RUN, ...options };
  const { fftSize, hopSize } = opts.stft;

  if (channels.length === 0) throw new Error('오디오가 비어 있습니다');
  if (sampleRate !== descriptor.sampleRate) {
    throw new Error(`이 모델은 ${descriptor.sampleRate} Hz 로 학습됐는데 오디오는 ${sampleRate} Hz 입니다`
      + ' — 리샘플러가 아직 없어서 거절합니다');
  }
  if (descriptor.channels !== 1 && descriptor.channels !== 2) {
    throw new Error(`모델이 ${descriptor.channels}채널을 요구합니다 — 모노나 스테레오만 됩니다`);
  }
  const stemCount = descriptor.stems.length;
  if (stemCount === 0) throw new Error('모델이 스템을 하나도 선언하지 않았습니다');

  const left = channels[0]!;
  const right = channels[1] ?? left;
  const length = left.length;
  if (length === 0) throw new Error('오디오가 비어 있습니다');
  // The model's channel count decides what it is fed; ours decides what comes
  // back out.  A mono model on a stereo stem is run once per channel.
  const modelStereo = descriptor.channels === 2;
  const outChannels = channels.length === 2 ? 2 : 1;
  const bins = (fftSize >> 1) + 1;

  const denominator = denominatorFor(length, fftSize);
  const accumulators: Overlap[][] = descriptor.stems.map(() =>
    Array.from({ length: outChannels }, () => new Overlap(length, fftSize, denominator)));

  const total = frameCount(length, opts.stft);
  const segments = Math.max(1, Math.ceil(total / opts.segmentFrames));
  let done = 0;

  for (let start = 0; start < total; start += opts.segmentFrames) {
    const stop = Math.min(total, start + opts.segmentFrames);
    const specL = analyse(left, sampleRate, start, stop, opts.stft);
    const specR = outChannels === 2 ? analyse(right, sampleRate, start, stop, opts.stft) : specL;
    const frames = specL.frames;
    if (frames === 0) break;
    const magL = magnitudes(specL);
    const magR = outChannels === 2 ? magnitudes(specR) : magL;

    // Feed: one pass for a stereo model, one pass per channel for a mono one.
    const passes = modelStereo ? 1 : outChannels;
    // The denominator is ONE buffer shared by every stem and every channel —
    // the window sum does not depend on what is being windowed — so exactly
    // one writer in the whole segment may count it.  Counting it per channel
    // halves the output and counting it per stem divides it by the stem count,
    // and neither is audible as anything but "quiet": everything still sums,
    // everything is just wrong by a constant.
    let counted = false;
    for (let pass = 0; pass < passes; pass++) {
      const feedChannels = modelStereo ? 2 : 1;
      const input = new Float32Array(feedChannels * frames * bins);
      for (let c = 0; c < feedChannels; c++) {
        const source = modelStereo ? (c === 0 ? magL : magR) : (pass === 0 ? magL : magR);
        input.set(source.subarray(0, frames * bins), c * frames * bins);
      }
      const out = await session.run({
        mix: tensor(input, [1, feedChannels, frames, bins]),
      });
      const masks = out['masks'];
      if (masks === undefined) {
        throw new Error(`모델이 masks 출력을 내지 않았습니다 — 나온 것: ${Object.keys(out).join(', ') || '없음'}`);
      }
      checkShape(masks.dims, [1, stemCount, feedChannels, frames, bins], descriptor);

      // Apply and accumulate immediately: holding every segment's masks is the
      // gigabyte this segmenting exists to avoid.
      const per = frames * bins;
      for (let s = 0; s < stemCount; s++) {
        for (let c = 0; c < feedChannels; c++) {
          const outChannel = modelStereo ? c : pass;
          if (outChannel >= outChannels) continue;
          const mask = masks.data.subarray((s * feedChannels + c) * per, (s * feedChannels + c + 1) * per);
          const spec = outChannel === 0 ? specL : specR;
          // Exactly one writer counts the overlap-add denominator per segment
          // per channel, or the output is divided by the number of stems.
          accumulators[s]![outChannel]!.add(spec, mask, !counted);
          counted = true;
        }
      }
    }
    done++;
    onProgress(done / segments);
  }

  const stems = descriptor.stems.map((kind, s) => ({
    kind,
    channels: accumulators[s]!.map((acc) => acc.finish(denominator)),
  }));
  const input = outChannels === 2 ? [left, right] : [left];
  return { stems, reconstructionDb: residualDb(input, stems), elapsedMs: Date.now() - started };
}

function checkShape(
  got: readonly number[], want: readonly number[], descriptor: ModelDescriptor,
): void {
  const same = got.length === want.length && got.every((v, i) => v === want[i]);
  if (same) return;
  throw new Error(`${descriptor.id} 의 masks 모양이 [${want.join(', ')}] 여야 하는데`
    + ` [${got.join(', ')}] 입니다 — 스템 ${descriptor.stems.map(stemLabel).join(' · ')} 순서와 채널 수를 확인하세요`);
}

/** How far the children miss the parent, in dB.  Measured on the output. */
function residualDb(
  input: readonly Float32Array[],
  stems: readonly { channels: Float32Array[] }[],
): number {
  let residual = 0;
  let signal = 0;
  for (let c = 0; c < input.length; c++) {
    const source = input[c]!;
    for (let i = 0; i < source.length; i++) {
      let sum = 0;
      for (const stem of stems) sum += stem.channels[c]?.[i] ?? 0;
      const d = (source[i] ?? 0) - sum;
      residual += d * d;
      signal += (source[i] ?? 0) ** 2;
    }
  }
  if (signal <= 0) return -Infinity;
  return 10 * Math.log10(Math.max(residual, Number.MIN_VALUE) / signal);
}

/**
 * Replace one stem in a finished separation with the children a model made.
 *
 * The result is still an exact decomposition of the record: the parent is
 * removed and its children put in its place, and because the model's masks sum
 * to one over the children, the children sum to the parent.  Nothing else in
 * the set is touched.
 *
 * Refuses rather than guesses when the model's stems are not all children of
 * the same parent — a set that half-replaces a stem leaves the record's energy
 * counted twice in one place and not at all in another, and neither is visible
 * in a waveform.
 */
export function expandStems<T extends { kind: StemKind; channels: Float32Array[] }>(
  stems: readonly T[], parent: StemKind,
  children: ReadonlyArray<{ kind: StemKind; channels: Float32Array[] }>,
): Array<T | { kind: StemKind; channels: Float32Array[] }> {
  const at = stems.findIndex((s) => s.kind === parent);
  if (at < 0) {
    throw new Error(`${stemLabel(parent)} 스템이 없는데 그 자식을 넣으려 했습니다`);
  }
  if (children.length === 0) {
    throw new Error(`${stemLabel(parent)} 을(를) 나눈 결과가 비어 있습니다`);
  }
  const already = new Set(stems.map((s) => s.kind));
  const clash = children.filter((c) => c.kind !== parent && already.has(c.kind));
  if (clash.length > 0) {
    throw new Error(`${clash.map((c) => stemLabel(c.kind)).join(' · ')} 은(는) 이미 있습니다`
      + ' — 같은 파트가 두 스템에 들어갑니다');
  }
  return [...stems.slice(0, at), ...children, ...stems.slice(at + 1)];
}
