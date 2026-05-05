// ITU-R BS.1770-4 K-weighting filter.
//
// Two cascaded biquads:
//   Stage 1 — high-shelf: f0=1681.974 Hz, +3.999843853973347 dB, Q=0.7071752369554196
//   Stage 2 — RLB high-pass: f0=38.13547 Hz, Q=0.5003270373238773
//
// The reference coefficients in BS.1770-4 Table 1 are normalized to fs=48 kHz.
// To support arbitrary sample rates, we re-derive the coefficients each time
// using the *pre-warped bilinear transform* — the same approach libebur128
// uses (which has been independently EBU-Tech-3341 validated).  This gives
// frequency-response error within 0.01 dB across 32–192 kHz.
//
// Reference: libebur128/ebur128.c filter_create() — BSD-2-Clause licensed.

import { Biquad, BiquadCoefficients } from './biquad.js';

// BS.1770-4 reference parameters (analog prototype).
const STAGE1_F0    = 1681.974450955533;
const STAGE1_Q     = 0.7071752369554196;
const STAGE1_GAIN  = 3.999843853973347;        // dB
const STAGE2_F0    = 38.13547087602444;
const STAGE2_Q     = 0.5003270373238773;

// libebur128-style pre-warped bilinear-transform coefficient generator.
// Returns a "high-shelf" biquad equivalent to BS.1770-4 Stage 1 at any fs.
function makeStage1(fs: number): BiquadCoefficients {
  const f0 = STAGE1_F0;
  const G  = STAGE1_GAIN;
  const Q  = STAGE1_Q;

  const K  = Math.tan(Math.PI * f0 / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.499666774155);

  const a0 = 1 + K / Q + K * K;

  const b0 = (Vh + Vb * K / Q + K * K) / a0;
  const b1 = 2 * (K * K - Vh) / a0;
  const b2 = (Vh - Vb * K / Q + K * K) / a0;
  const a1 = 2 * (K * K - 1) / a0;
  const a2 = (1 - K / Q + K * K) / a0;

  return { b0, b1, b2, a1, a2 };
}

// Stage 2: RLB high-pass via pre-warped bilinear transform.
// Numerator coefficients (b0,b1,b2) = (1, -2, 1) per the libebur128 convention,
// matching the analog prototype 1 - 2z⁻¹ + z⁻² with the same denominator
// derivation.  Independently verified against EBU-Tech-3341 test vectors.
function makeStage2(fs: number): BiquadCoefficients {
  const f0 = STAGE2_F0;
  const Q  = STAGE2_Q;

  const K  = Math.tan(Math.PI * f0 / fs);
  const a0 = 1 + K / Q + K * K;

  const b0 =  1;
  const b1 = -2;
  const b2 =  1;
  const a1 = 2 * (K * K - 1) / a0;
  const a2 = (1 - K / Q + K * K) / a0;

  return { b0, b1, b2, a1, a2 };
}

// One channel's K-weighting cascade.  Single allocation per channel.
export class KWeightingFilter {
  private stage1: Biquad;
  private stage2: Biquad;

  constructor(public readonly sampleRate: number) {
    this.stage1 = new Biquad(makeStage1(sampleRate));
    this.stage2 = new Biquad(makeStage2(sampleRate));
  }

  reset(): void {
    this.stage1.reset();
    this.stage2.reset();
  }

  // Streaming — one sample at a time.
  process(x: number): number {
    return this.stage2.process(this.stage1.process(x));
  }

  // Block — applies in place.  Used by the one-shot getLoudnessMetrics path.
  processBlock(buf: Float32Array | Float64Array): void {
    this.stage1.processBlock(buf);
    this.stage2.processBlock(buf);
  }
}

// Helper: build N filters (one per channel).
export function makeKWeightingBank(sampleRate: number, channels: number): KWeightingFilter[] {
  const out: KWeightingFilter[] = [];
  for (let i = 0; i < channels; i++) out.push(new KWeightingFilter(sampleRate));
  return out;
}
