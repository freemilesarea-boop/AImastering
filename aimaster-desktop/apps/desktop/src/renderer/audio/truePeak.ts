// True-peak (TP) measurement per BS.1770-4 Annex 2.
//
// Strategy: 4× oversample using a polyphase FIR, then take the max of the
// resampled output magnitude.  At 48 kHz this gives 192 kHz of effective
// resolution which is enough to catch inter-sample peaks within ~0.1 dB
// of the true analog peak — well within the ±0.3 LU envelope spec'd
// for the surrounding loudness pipeline.
//
// Filter design:
//   • 48-tap windowed-sinc (Kaiser, β≈8) lowpass at fs/2.
//   • Split into 4 phases of 12 taps each (polyphase decomposition).
//   • Phase 0 = identity (delay-line tap, no compute).
//   • Phases 1–3 = the FIR for the 3 inserted samples per input sample.
//
// We embed the precomputed coefficients here (fixed, ~96 numbers) so we
// have ZERO build-time deps and the worklet can ship as a single file.

// Polyphase FIR coefficients (4 phases × 12 taps).
// Source: BS.1770-4 Annex 2 reference — Kaiser-windowed sinc, fs/2 lowpass.
// These match libebur128's interpolator_filter table within rounding.
//
// Phase 0 is the identity tap (output sample n = input sample n) so it's
// trivially [0,...,0,1,0,...,0] — we skip it in the inner loop.

const PHASE1: Float32Array = new Float32Array([
   0.0017089843750,
   0.0109863281250,
  -0.0196533203125,
   0.0332031250000,
  -0.0594482421875,
   0.1373291015625,
   0.9721679687500,
  -0.1024169921875,
   0.0476074218750,
  -0.0266113281250,
   0.0148925781250,
  -0.0083007812500,
]);

const PHASE2: Float32Array = new Float32Array([
   0.0029296875000,
   0.0196533203125,
  -0.0376586914062,
   0.0709228515625,
  -0.1422119140625,
   0.4625244140625,
   0.4625244140625,
  -0.1422119140625,
   0.0709228515625,
  -0.0376586914062,
   0.0196533203125,
   0.0029296875000,
]);

const PHASE3: Float32Array = new Float32Array([
  -0.0083007812500,
   0.0148925781250,
  -0.0266113281250,
   0.0476074218750,
  -0.1024169921875,
   0.9721679687500,
   0.1373291015625,
  -0.0594482421875,
   0.0332031250000,
  -0.0196533203125,
   0.0109863281250,
   0.0017089843750,
]);

const N_TAPS = 12;

/**
 * Every branch must pass DC at unity, and one of them did not.
 *
 * Measured against signals whose true peak is known exactly — a sine of
 * amplitude A has a true peak of A, whatever the sample phase:
 *
 *     full-scale fs/4 at π/4 (samples ±0.7071, true peak 1.0 = 0 dBFS)
 *       as shipped      -1.520 dBTP
 *       normalised      -0.142 dBTP
 *
 *     worst under-read over a 200 Hz → 23.6 kHz × 8-phase sweep
 *       as shipped      -1.520 dB (at 12 kHz, which is fs/4)
 *       normalised      -0.351 dB (at 6 kHz)
 *
 * PHASE2 — the half-sample branch, the one that catches the worst
 * inter-sample peaks — summed to 0.752319 while PHASE1 and PHASE3 summed to
 * 1.001465.  An interpolator whose sub-sample positions have different gains
 * is not interpolating; it is dipping by 2.5 dB halfway between every pair of
 * samples.  That is indefensible whatever table the coefficients came from,
 * and it made the meter UNDER-report, which is the dangerous direction: the
 * app told people they were under their ceiling when they were over it.
 *
 * Normalised here rather than by editing the numbers, so the invariant is
 * stated in code and a future table cannot reintroduce the same fault
 * silently.  `true-peak-selftest` holds the invariant from both ends: it
 * reads the raw tables and shows one of them violates it, and it measures
 * the meter against peaks whose value is known exactly.
 */
function normalise(phase: Float32Array): Float32Array {
  let sum = 0;
  for (const v of phase) sum += v;
  if (!(Math.abs(sum) > 1e-9)) return phase;
  const out = new Float32Array(phase.length);
  for (let i = 0; i < phase.length; i++) out[i] = (phase[i] as number) / sum;
  return out;
}

const P1 = normalise(PHASE1);
const P2 = normalise(PHASE2);
const P3 = normalise(PHASE3);


// Per-channel streaming TP detector.  Maintains a 12-sample input ring
// buffer and emits the running peak (linear, not dB).  Call `peakDb()`
// at any time for the running maximum in dBFS.
export class TruePeakChannel {
  private ring: Float32Array = new Float32Array(N_TAPS);
  private head = 0;
  private peak = 0;

  reset(): void {
    this.ring.fill(0);
    this.head = 0;
    this.peak = 0;
  }

  // Process one sample, update running peak.
  process(x: number): void {
    // Insert new sample into ring.
    this.ring[this.head] = x;
    this.head = (this.head + 1) % N_TAPS;

    // Phase 0 = identity (the input sample itself).
    let p = Math.abs(x);
    if (p > this.peak) this.peak = p;

    // Apply phases 1, 2, 3.
    // Tap order: oldest sample first (= index `head`, since we just wrote
    // to it and stepped forward — wait no, head now points to the
    // *next* slot to overwrite, which is the OLDEST sample).
    let acc1 = 0, acc2 = 0, acc3 = 0;
    let idx = this.head;
    for (let k = 0; k < N_TAPS; k++) {
      const v = this.ring[idx] as number;
      acc1 += v * (P1[k] as number);
      acc2 += v * (P2[k] as number);
      acc3 += v * (P3[k] as number);
      idx = (idx + 1) % N_TAPS;
    }
    p = Math.abs(acc1); if (p > this.peak) this.peak = p;
    p = Math.abs(acc2); if (p > this.peak) this.peak = p;
    p = Math.abs(acc3); if (p > this.peak) this.peak = p;
  }

  processBlock(buf: Float32Array | Float64Array): void {
    for (let i = 0; i < buf.length; i++) this.process(buf[i] as number);
  }

  peakLinear(): number { return this.peak; }
  peakDb(): number {
    return this.peak <= 0 ? -Infinity : 20 * Math.log10(this.peak);
  }
}

// Multi-channel convenience.
export class TruePeakBank {
  public readonly channels: TruePeakChannel[];
  constructor(numChannels: number) {
    this.channels = [];
    for (let c = 0; c < numChannels; c++) this.channels.push(new TruePeakChannel());
  }
  reset(): void { for (const c of this.channels) c.reset(); }
  // Returns max-across-channels TP in dBFS.
  maxPeakDb(): number {
    let p = 0;
    for (const c of this.channels) p = Math.max(p, c.peakLinear());
    return p <= 0 ? -Infinity : 20 * Math.log10(p);
  }
  // Per-channel TP in dBFS.
  perChannelPeakDb(): number[] {
    return this.channels.map((c) => c.peakDb());
  }
}

// ── Refined measurement, for the export guard ───────────────────────────────

const REFINE_HALF = 32;
const REFINE_SUB = 16;
/** How far below the 4x estimate a position can still hide the true peak. */
const CANDIDATE_WINDOW_DB = 1.5;

/**
 * True peak of a whole buffer, accurate enough to certify a master.
 *
 * The 4x bank above is what a live meter can afford, and it is not accurate
 * enough to be the final word on a dBTP ceiling: validated against sines,
 * whose true peak is exactly their amplitude, its error on real material runs
 * to several tenths of a dB in BOTH directions, and on the output of a
 * brickwall limiter it under-read by 0.58 dB.  `limiterChain` iterates until
 * this number meets the ceiling, so its error lands directly in the file that
 * goes to the client.
 *
 * Scan cheaply, refine expensively, and only where it matters:
 *
 *   1. one 4x pass over everything, which is within about 0.6 dB, and
 *   2. a 64-tap Blackman-windowed sinc at 16 sub-sample positions around
 *      only those samples whose 4x value is within 1.5 dB of that maximum.
 *
 * The window is the 4x estimate's own worst-case error with margin, so the
 * true peak cannot be outside it.  A first version gated on the raw SAMPLE
 * peak instead, 3 dB down — on brickwall material nearly every sample
 * qualifies, and a five-second preview that has to render in under a second
 * took eleven.  The performance check in `loudness-selftest` caught it.
 *
 * Offline only: even gated, this is far too much work per block in a worklet.
 */
export function refinedTruePeakDb(data: Float32Array): number {
  if (data.length < 2 * REFINE_HALF + 2) return -Infinity;

  // ── 1. Coarse 4x pass, keeping the per-sample estimate ───────────────────
  const coarse = new Float32Array(data.length);
  let coarseMax = 0;
  // The branch outputs are computed here rather than through
  // `TruePeakChannel`, which only keeps a running maximum: the gate below
  // needs to know WHERE the estimate was high, not just how high it got.
  {
    const ring = new Float32Array(N_TAPS);
    let head = 0;
    for (let i = 0; i < data.length; i++) {
      ring[head] = data[i] as number;
      head = (head + 1) % N_TAPS;
      let best = Math.abs(data[i] as number);
      let a1 = 0, a2 = 0, a3 = 0;
      let idx = head;
      for (let k = 0; k < N_TAPS; k++) {
        const v = ring[idx] as number;
        a1 += v * (P1[k] as number);
        a2 += v * (P2[k] as number);
        a3 += v * (P3[k] as number);
        idx = (idx + 1) % N_TAPS;
      }
      const m = Math.max(Math.abs(a1), Math.abs(a2), Math.abs(a3));
      if (m > best) best = m;
      // WHERE this estimate belongs.  The branches read the window ending at
      // i, which holds samples i-11 … i, and each is a causal fractional
      // delay whose group delay is 5 + d samples from the start of that
      // window — so the interpolated point sits at i - 6 (plus a fraction).
      //
      // Getting this wrong is not academic: a first version wrote the
      // estimate at i - 11 and the gate below then looked five samples away
      // from the peak, missed it, and let 0.42 dB through while running fast
      // enough to look correct.  Its neighbours are marked too, so a
      // one-sample slip cannot lose it.
      if (best > coarseMax) coarseMax = best;
      for (let at = i - 7; at <= i - 5; at++) {
        if (at < 0) continue;
        if (best > (coarse[at] as number)) coarse[at] = best;
      }
    }
  }
  if (coarseMax <= 0) return -Infinity;

  // ── 2. Refine only the neighbourhoods that could hold the peak ───────────
  const gate = coarseMax * Math.pow(10, -CANDIDATE_WINDOW_DB / 20);
  let peak = coarseMax;
  for (let i = REFINE_HALF; i < data.length - REFINE_HALF; i++) {
    if ((coarse[i] as number) < gate) continue;
    for (let sub = 1; sub < REFINE_SUB; sub++) {
      const d = sub / REFINE_SUB;
      let acc = 0;
      for (let k = -REFINE_HALF; k < REFINE_HALF; k++) {
        const x = k - d;
        const sinc = Math.sin(Math.PI * x) / (Math.PI * x);
        const w = 0.42
          + 0.5 * Math.cos((Math.PI * x) / REFINE_HALF)
          + 0.08 * Math.cos((2 * Math.PI * x) / REFINE_HALF);
        acc += (data[i + k] as number) * sinc * w;
      }
      const a = Math.abs(acc);
      if (a > peak) peak = a;
    }
  }
  return 20 * Math.log10(peak);
}
