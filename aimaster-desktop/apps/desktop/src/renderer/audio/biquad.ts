// Direct-Form-I biquad filter — branch-free, allocation-free.
// All state held inline so the same instance can run in an AudioWorklet
// without GC pressure.

export interface BiquadCoefficients {
  b0: number;
  b1: number;
  b2: number;
  a1: number; // a0 is normalized to 1
  a2: number;
}

export class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(public coeffs: BiquadCoefficients) {}

  reset(): void {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }

  // Single-sample tick (hot path — keep tiny).
  process(x: number): number {
    const c = this.coeffs;
    const y = c.b0 * x + c.b1 * this.x1 + c.b2 * this.x2
            - c.a1 * this.y1 - c.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }

  // Block in-place processing (renderer / one-shot API).
  processBlock(buf: Float32Array | Float64Array): void {
    const c = this.coeffs;
    let { x1, x2, y1, y2 } = this;
    const { b0, b1, b2, a1, a2 } = c;
    for (let i = 0; i < buf.length; i++) {
      const x = buf[i] as number;
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x;
      y2 = y1; y1 = y;
      buf[i] = y;
    }
    this.x1 = x1; this.x2 = x2;
    this.y1 = y1; this.y2 = y2;
  }
}

// Build a peaking-EQ (high-shelf at f0 with given gain) using RBJ cookbook.
// Used as Stage-1 of K-weighting.  We DO NOT use this — K-weighting uses
// pre-defined coefficients computed via libebur128's pre-warped bilinear
// transform — but kept here in case a future feature needs it.
export function rbjHighShelf(
  fs: number, f0: number, q: number, gainDb: number,
): BiquadCoefficients {
  const A = Math.pow(10, gainDb / 40);
  const w0 = 2 * Math.PI * f0 / fs;
  const cosw0 = Math.cos(w0);
  const sinw0 = Math.sin(w0);
  const alpha = sinw0 / (2 * q);
  const sqrtA = Math.sqrt(A);

  const b0 =     A * ((A + 1) + (A - 1) * cosw0 + 2 * sqrtA * alpha);
  const b1 = -2 * A * ((A - 1) + (A + 1) * cosw0);
  const b2 =     A * ((A + 1) + (A - 1) * cosw0 - 2 * sqrtA * alpha);
  const a0 =          (A + 1) - (A - 1) * cosw0 + 2 * sqrtA * alpha;
  const a1 =     2 * ((A - 1) - (A + 1) * cosw0);
  const a2 =          (A + 1) - (A - 1) * cosw0 - 2 * sqrtA * alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}
