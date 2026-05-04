// Stage 2 — look-ahead peak limiter.
//
// Properties:
//   • Stereo-linked  — both channels share one gain envelope.  The L/R
//                       balance is preserved bit-for-bit (no image collapse).
//   • Look-ahead    — gain ramps down AHEAD of incoming peaks via a sliding-
//                       window minimum over an N-sample look-ahead buffer.
//                       This gives a virtually instant attack without
//                       chopping the transient.
//   • Dual release  — fast initial recovery (≈ release/3) for the first
//                       70 % of the way back to unity, then slow recovery
//                       for the last 30 %.  Suppresses pumping while still
//                       restoring loudness cleanly.
//   • Conservative ceiling — defaults to -1.5 dBFS sample peak so that
//                       inter-sample peaks stay within roughly -1 dBTP
//                       even before the final true-peak guard runs.
//
// Offline-only.  All processing happens in a single forward pass over a
// pre-computed required-gain array, plus an O(N) monotonic-deque sliding
// minimum for the look-ahead phase.

export interface PeakLimiterParams {
  /** Sample-peak ceiling in dBFS.  Default -1.5 dBFS (TP-safe headroom). */
  ceilingDb?:    number;
  /** Look-ahead window in milliseconds.  Default 5 ms. */
  lookAheadMs?:  number;
  /** Release time-constant in milliseconds.  Default 80 ms. */
  releaseMs?:    number;
  /** Fast-stage release factor (release / fastRatio).  Default 3. */
  fastRatio?:    number;
  /** Hold time (ms) — keep the GR pinned briefly after a peak.  Default 2 ms. */
  holdMs?:       number;
}

export interface PeakLimiterResult {
  out:            Float32Array[];   // processed channels, same length as input
  maxGainReducDb: number;           // largest GR (positive number, in dB)
  rmsGainReducDb: number;           // average GR over the program
}

// ── Sliding-window minimum (monotonic deque) ──────────────────────────────────
// Returns g[t] = min over k in [t, min(t+win-1, N-1)] of x[k].
function slidingWindowMin(x: Float32Array, win: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  // Deque holding indexes in increasing position with non-decreasing x value.
  const dq: number[] = [];
  for (let i = 0; i < n; i++) {
    // Push i while removing tail elements that are larger than x[i].
    while (dq.length && (x[dq[dq.length - 1] as number] as number) >= (x[i] as number)) dq.pop();
    dq.push(i);
    // Pop head if it's outside the window of any t we've already finalised.
    // We finalise t = i - (win - 1) — for i < win-1 we haven't started yet.
    if (i >= win - 1) {
      const t = i - (win - 1);
      // Drop heads with index < t.
      while (dq.length && (dq[0] as number) < t) dq.shift();
      out[t] = x[dq[0] as number] as number;
    }
  }
  // Finalise the tail (t = n-win+1 ... n-1).  Window shrinks toward end.
  for (let t = Math.max(0, n - win + 1); t < n; t++) {
    while (dq.length && (dq[0] as number) < t) dq.shift();
    out[t] = x[dq[0] as number] as number;
  }
  return out;
}

// ── Main limiter ──────────────────────────────────────────────────────────────
export function processPeakLimiter(
  channels: Float32Array[],
  sampleRate: number,
  params: PeakLimiterParams = {},
): PeakLimiterResult {
  const ceilingDb   = params.ceilingDb   ?? -1.5;
  const lookAheadMs = params.lookAheadMs ?? 5;
  const releaseMs   = params.releaseMs   ?? 80;
  const fastRatio   = params.fastRatio   ?? 3;
  const holdMs      = params.holdMs      ?? 2;

  const ceiling      = Math.pow(10, ceilingDb / 20);
  const lookAheadSmp = Math.max(1, Math.round(sampleRate * lookAheadMs / 1000));
  const releaseSmpSlow = Math.max(1, Math.round(sampleRate * releaseMs / 1000));
  const releaseSmpFast = Math.max(1, Math.round(sampleRate * (releaseMs / fastRatio) / 1000));
  const holdSmp      = Math.max(0, Math.round(sampleRate * holdMs / 1000));

  const nCh = channels.length;
  if (nCh === 0) return { out: [], maxGainReducDb: 0, rmsGainReducDb: 0 };
  const N = (channels[0] as Float32Array).length;

  // Step 1: per-sample required gain (= 1 when peak ≤ ceiling).
  const required = new Float32Array(N);
  for (let t = 0; t < N; t++) {
    let peak = 0;
    for (let c = 0; c < nCh; c++) {
      const v = Math.abs((channels[c] as Float32Array)[t] as number);
      if (v > peak) peak = v;
    }
    required[t] = peak <= ceiling || peak === 0 ? 1 : ceiling / peak;
  }

  // Step 2: look-ahead — sliding-window minimum so the gain has already
  // dipped to handle the upcoming peak.
  const lookMin = slidingWindowMin(required, lookAheadSmp);

  // Step 3: forward smoothing — release envelope with hold + dual-stage.
  // env[t] is the actual applied gain.  Attack is "instant" (since lookMin
  // already encodes the future), so when lookMin[t] < env[t-1] we drop to
  // lookMin[t] immediately.  Release is two-stage exponential.
  const env = new Float32Array(N);
  const fastAlpha = 1 - Math.exp(-1 / releaseSmpFast);
  const slowAlpha = 1 - Math.exp(-1 / releaseSmpSlow);
  // Fast/slow crossover: when env has recovered to ≥ this fraction of the
  // way back to its target, switch to slow release.
  const FAST_TO_SLOW = 0.70;

  let g = 1;
  let holdRemaining = 0;
  let lastAttackTarget = 1;          // most recent floor we attacked toward
  let maxGr = 0;
  let sumGrDb = 0;
  let nGrDb = 0;
  for (let t = 0; t < N; t++) {
    const target = lookMin[t] as number;
    if (target < g) {
      g = target;
      holdRemaining = holdSmp;
      lastAttackTarget = target;
    } else if (holdRemaining > 0) {
      holdRemaining--;
      // freeze g at the attack floor
    } else {
      // Release: choose alpha based on how close we are to recovery.
      // recovery = (g - lastAttackTarget) / (target - lastAttackTarget)
      // (clamped 0..1).  recovery < FAST_TO_SLOW → fast; else slow.
      const denom = target - lastAttackTarget;
      const recovery = denom > 1e-9
        ? (g - lastAttackTarget) / denom
        : 1;
      const alpha = recovery < FAST_TO_SLOW ? fastAlpha : slowAlpha;
      g = g + (target - g) * alpha;
      if (g > 1) g = 1;
    }
    env[t] = g;
    if (g < 1) {
      const grDb = -20 * Math.log10(g);
      if (grDb > maxGr) maxGr = grDb;
      sumGrDb += grDb;
      nGrDb++;
    }
  }

  // Step 4: apply.
  const out: Float32Array[] = new Array(nCh);
  for (let c = 0; c < nCh; c++) {
    const src = channels[c] as Float32Array;
    const dst = new Float32Array(N);
    for (let t = 0; t < N; t++) {
      dst[t] = (src[t] as number) * (env[t] as number);
    }
    out[c] = dst;
  }

  return {
    out,
    maxGainReducDb: maxGr,
    rmsGainReducDb: nGrDb > 0 ? sumGrDb / nGrDb : 0,
  };
}
