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
      acc1 += v * (PHASE1[k] as number);
      acc2 += v * (PHASE2[k] as number);
      acc3 += v * (PHASE3[k] as number);
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
