// Stage 1 — analog-style soft clipper.
//
// Design: piecewise transfer function with true pass-through below the
// threshold, and an odd-order cubic saturation above it asymptoting at
// the ceiling.  Both halves are tangent-matched at the threshold so the
// curve is C¹-continuous (no derivative kink → no audible click on
// peaks crossing the threshold).
//
//   For |x| ≤ T:    y = x                                  (transparent)
//   For |x| > T:    s   = (|x| - T) / (1 - T)
//                    y_n = (3/2)·s - (1/2)·s³  clamped at 1
//                    y   = sign(x) · ( T + y_n · (C_eff - T) )
//
// where C_eff is set so the slope of the saturation half at |x|=T equals
// the slope of the linear half (=1).  Solving (3/2)·(C_eff - T)/(1 - T)
// = 1 gives C_eff = T + (2/3)(1 - T) = (T + 2)/3.  This forces the
// effective asymptote — i.e., the EFFECTIVE ceiling — to fall out of the
// math; users who want a different output ceiling can stack the limiter
// on top to set the final headroom.
//
// The result: below T the chain is bit-transparent, so a -10 LUFS sine
// gets through with THD that is essentially numerical noise (~-90 dB).

export interface SoftClipParams {
  /** Knee threshold in dBFS.  Above this, the soft saturation starts.
   *  Default -3 dBFS — well below the limiter ceiling but high enough
   *  that anything mastering at -10 LUFS or quieter stays linear. */
  thresholdDb?: number;
  /** Drive in dB applied to the input before clipping (gain-compensated
   *  on the output side).  Default 0 dB — off. */
  driveDb?: number;
}

export interface CompiledSoftClip {
  threshold:    number;          // linear
  effCeiling:   number;          // linear — derived from threshold
  preGain:      number;
  postGain:     number;
}

export function compileSoftClip(p: SoftClipParams = {}): CompiledSoftClip {
  const thresholdDb = p.thresholdDb ?? -3;
  const driveDb     = p.driveDb     ?? 0;

  const threshold  = Math.pow(10, thresholdDb / 20);
  const effCeiling = (threshold + 2) / 3;          // C¹-continuous knee
  const preGain    = Math.pow(10, driveDb / 20);
  const postGain   = 1 / preGain;                  // gain-compensate drive

  return { threshold, effCeiling, preGain, postGain };
}

// Apply the clipper to a single sample.  Hot path — keep small.
export function softClipSample(x: number, c: CompiledSoftClip): number {
  const driven = x * c.preGain;
  const a = Math.abs(driven);
  let y: number;
  if (a <= c.threshold) {
    y = driven;                                    // transparent below knee
  } else {
    const s = (a - c.threshold) / (1 - c.threshold);
    const sat = s >= 1 ? 1 : (1.5 * s - 0.5 * s * s * s);
    y = (driven < 0 ? -1 : 1) * (c.threshold + sat * (c.effCeiling - c.threshold));
  }
  return y * c.postGain;
}

// In-place block process (one channel).
export function softClipBlock(buf: Float32Array, c: CompiledSoftClip): void {
  const T = c.threshold;
  const E = c.effCeiling;
  const G = c.preGain;
  const P = c.postGain;
  const inv = 1 - T;
  for (let i = 0; i < buf.length; i++) {
    const driven = (buf[i] as number) * G;
    const a = driven < 0 ? -driven : driven;
    let y: number;
    if (a <= T) {
      y = driven;
    } else {
      const s = (a - T) / inv;
      const sat = s >= 1 ? 1 : (1.5 * s - 0.5 * s * s * s);
      y = (driven < 0 ? -1 : 1) * (T + sat * (E - T));
    }
    buf[i] = y * P;
  }
}
