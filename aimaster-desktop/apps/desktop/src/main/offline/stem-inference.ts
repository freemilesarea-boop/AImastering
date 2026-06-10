// stem-inference — pure DSP helpers for windowed stem-separation inference.
//
// Demucs-style models process audio in OVERLAPPING segments and recombine them
// with a weighted overlap-add (WOLA) so segment seams are inaudible.  These
// helpers are the deterministic, headless-testable core of that pipeline; the
// ONNX session itself lives in stem-separation.ts.
//
// None of this imports a native runtime — it is plain Float32 math.

export interface Segment {
  /** Sample offset of the segment within the full signal. */
  start: number;
  /** Number of samples in the segment (last one may be short). */
  length: number;
}

/**
 * Split `total` samples into overlapping segments of `segLen` advancing by
 * `hop` (hop < segLen ⇒ overlap).  The final segment is clamped to the end.
 */
export function planSegments(total: number, segLen: number, hop: number): Segment[] {
  if (segLen <= 0) throw new Error('planSegments: segLen must be > 0');
  if (hop <= 0) throw new Error('planSegments: hop must be > 0');
  const segs: Segment[] = [];
  if (total <= 0) return segs;
  let start = 0;
  while (start < total) {
    const length = Math.min(segLen, total - start);
    segs.push({ start, length });
    if (start + segLen >= total) break; // this segment already reaches the end
    start += hop;
  }
  return segs;
}

/** Periodic Hann window of length n (raised cosine, endpoints → 0). */
export function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n);
  if (n === 1) { w[0] = 1; return w; }
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  }
  return w;
}

/**
 * Weighted overlap-add reconstruction.  Each segment carries a per-sample
 * weight; overlapping regions are normalized by the summed weight so the
 * recombined signal is an exact partition-of-unity blend (no level dip at
 * seams) regardless of overlap ratio.
 */
export function overlapAddWeighted(
  total: number,
  segments: Segment[],
  segData: Float32Array[],
  weights: Float32Array[],
): Float32Array {
  if (segData.length !== segments.length || weights.length !== segments.length) {
    throw new Error('overlapAddWeighted: segments/segData/weights length mismatch');
  }
  const out = new Float32Array(total);
  const wsum = new Float32Array(total);
  for (let s = 0; s < segments.length; s++) {
    const start = segments[s]!.start;
    const d = segData[s]!;
    const w = weights[s]!;
    const n = Math.min(d.length, w.length, total - start);
    for (let i = 0; i < n; i++) {
      out[start + i]! += d[i]! * w[i]!;
      wsum[start + i]! += w[i]!;
    }
  }
  for (let i = 0; i < total; i++) {
    if (wsum[i]! > 1e-8) out[i]! /= wsum[i]!;
  }
  return out;
}

/**
 * Linear-interpolation resampler.  Adequate as a first pass for feeding a model
 * at its native rate; a polyphase resampler can replace this later without
 * touching callers (see docs/STEM_SEPARATION_PLAN.md).  Pure.
 */
export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate <= 0 || toRate <= 0) throw new Error('resampleLinear: rates must be > 0');
  if (fromRate === toRate || input.length === 0) return input.slice();
  const ratio = toRate / fromRate;
  const outLen = Math.max(1, Math.round(input.length * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcPos - i0;
    out[i] = input[i0]! * (1 - frac) + input[i1]! * frac;
  }
  return out;
}
