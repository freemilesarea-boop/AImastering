// The live spectrum drawn behind an EQ curve.
//
// An EQ with no analyser is an EQ you use by guessing.  You can hear that
// something is boxy; finding out that the box is at 340 Hz means sweeping a
// narrow boost around until it gets worse, which is a technique people teach
// because there was no alternative, not because it is a good way to spend
// four minutes.  With the spectrum behind the curve the 340 is just there.
//
// This file is the arithmetic between an FFT and a picture, and all four of
// its decisions are ones a naive version gets wrong.
//
// ── 1. Take the MAXIMUM across the bins in a pixel, never the mean ──────────
//
// A log-frequency display has roughly 40 pixels per octave at the bottom and
// the same 40 at the top — but the top octave of a 48 kHz signal holds 4096
// FFT bins and the bottom holds about two.  So at the right-hand end every
// pixel is averaging a hundred bins, and a resonance one bin wide and 20 dB
// proud of its neighbours AVERAGES AWAY TO NOTHING.  The single most useful
// thing an analyser does — show you the whistle — is exactly what the mean
// destroys.  Maximum keeps it.
//
// ── 2. Interpolate where there are FEWER bins than pixels ───────────────────
//
// The same axis has the opposite problem at the other end: below about
// 100 Hz, several pixels fall inside one bin, and taking the nearest bin for
// each draws a staircase.  Straight lines between bin centres are not more
// information — they are the honest way to draw the information there is.
//
// ── 3. Tilt it, or music looks like a landslide ─────────────────────────────
//
// Programme material falls at roughly 3 to 4.5 dB per octave; that is what
// music IS, not a fault in it.  Drawn untilted, every mix looks like a ramp
// down to the right and the only thing anybody can read off it is "there is
// less treble than bass", which they knew.  Tilting the display back by the
// same slope makes a normal mix look roughly level, so what stands out is
// what is actually unusual.  Pro-Q calls this the slope and offers 0, 3, 4.5
// and 6 dB/oct; the same four are here and 4.5 is the default, for the same
// reason it is theirs.
//
// ── 4. Fast up, slow down, and a separate line that remembers ───────────────
//
// An analyser redrawn raw every frame is a flickering mess nobody can read a
// number off.  Smoothing it symmetrically instead hides transients, which is
// the opposite failure.  So: it follows a rise immediately and falls slowly,
// the way a peak meter does — and a SECOND line holds the maximum for a few
// seconds, because the question being asked is usually "did that ever get
// loud" rather than "is it loud now".

/** The four slopes the display offers, in dB per octave. */
export const SPECTRUM_SLOPES: readonly number[] = [0, 3, 4.5, 6];

/** Where the tilt pivots.  1 kHz, so the mid does not move when it changes. */
export const SLOPE_PIVOT_HZ = 1000;

export interface SpectrumScale {
  /** Lowest frequency drawn, in hertz. */
  minHz: number;
  maxHz: number;
  /** dB at the top of the picture, and at the bottom. */
  topDb: number;
  bottomDb: number;
}

export const DEFAULT_SCALE: SpectrumScale = {
  minHz: 20, maxHz: 20_000, topDb: -6, bottomDb: -96,
};

/**
 * The frequency a pixel column stands for.
 *
 * Log, because pitch is: the octave 40–80 Hz has to be as wide as the octave
 * 5–10 kHz or the bottom three octaves of the picture are four pixels and
 * nothing in the bass can be pointed at.
 */
export function columnHz(x: number, width: number, scale: SpectrumScale): number {
  const t = width <= 1 ? 0 : x / (width - 1);
  return scale.minHz * Math.pow(scale.maxHz / scale.minHz, t);
}

/** How much the tilt adds at a given frequency. */
export function slopeDbAt(freqHz: number, slopeDbPerOct: number): number {
  if (slopeDbPerOct === 0) return 0;
  return Math.log2(Math.max(1e-6, freqHz) / SLOPE_PIVOT_HZ) * slopeDbPerOct;
}

/**
 * Turn one FFT frame into one dB value per pixel column.
 *
 * `bins` is what `AnalyserNode.getFloatFrequencyData` gives: bin k covers
 * k·sampleRate/(2·bins.length) hertz, already in dB.  `out` is written in
 * place so a frame costs no allocation — this runs every animation frame.
 *
 * Returns `out` for convenience.
 */
export function spectrumColumns(
  bins: Float32Array, sampleRate: number, out: Float32Array,
  scale: SpectrumScale = DEFAULT_SCALE, slopeDbPerOct = 4.5,
): Float32Array {
  const width = out.length;
  const binHz = sampleRate / (2 * bins.length);
  if (!(binHz > 0) || width === 0) { out.fill(scale.bottomDb); return out; }

  for (let x = 0; x < width; x++) {
    // The span of frequencies this column covers — half a column either side,
    // so neighbouring columns tile the axis rather than sampling points on it
    // and leaving the gaps between them unlooked-at.
    const centre = columnHz(x, width, scale);
    const lower = columnHz(Math.max(0, x - 0.5), width, scale);
    const upper = columnHz(Math.min(width - 1, x + 0.5), width, scale);

    const from = lower / binHz;
    const to = upper / binHz;
    const firstBin = Math.ceil(from);
    const lastBin = Math.floor(to);

    let db: number;
    if (lastBin < firstBin) {
      // Fewer bins than columns — decision 2.  Straight line between the two
      // bins this column falls between.
      const at = centre / binHz;
      const i0 = Math.max(0, Math.min(bins.length - 1, Math.floor(at)));
      const i1 = Math.max(0, Math.min(bins.length - 1, i0 + 1));
      const frac = Math.max(0, Math.min(1, at - i0));
      const a = bins[i0] ?? scale.bottomDb;
      const b = bins[i1] ?? scale.bottomDb;
      db = a + (b - a) * frac;
    } else {
      // More bins than columns — decision 1.  The loudest one wins.
      let peak = -Infinity;
      const lo = Math.max(0, firstBin);
      const hi = Math.min(bins.length - 1, lastBin);
      for (let k = lo; k <= hi; k++) {
        const v = bins[k] ?? -Infinity;
        if (v > peak) peak = v;
      }
      db = peak === -Infinity ? scale.bottomDb : peak;
    }

    if (!Number.isFinite(db)) db = scale.bottomDb;
    out[x] = db + slopeDbAt(centre, slopeDbPerOct);
  }
  return out;
}

/**
 * How fast the drawn line rises and falls, per second.
 *
 * Rise is effectively instant — a transient that the display softened would
 * be a transient you cannot see.  Fall is 46 dB per second, which is about
 * how long a VU-ish decay takes to leave a peak visible for a beat at 120 bpm
 * without smearing into the next one.
 */
export const SPECTRUM_FALL_DB_PER_SEC = 46;

/** How long the hold line keeps a maximum before it starts to slide. */
export const SPECTRUM_HOLD_SEC = 1.5;
export const SPECTRUM_HOLD_FALL_DB_PER_SEC = 12;

/**
 * Advance the displayed line towards a new frame.
 *
 * `display` is modified in place.  Rises are taken whole; falls are limited
 * by `SPECTRUM_FALL_DB_PER_SEC`, which is what makes the picture readable
 * rather than a strobe.
 */
export function advanceSpectrum(
  display: Float32Array, target: Float32Array, dtSec: number, floorDb: number,
): void {
  const maxFall = SPECTRUM_FALL_DB_PER_SEC * Math.max(0, Math.min(0.25, dtSec));
  for (let i = 0; i < display.length; i++) {
    const want = target[i] ?? floorDb;
    const now = display[i] ?? floorDb;
    display[i] = want >= now ? want : Math.max(want, now - maxFall);
  }
}

/**
 * Advance the hold line — the one that remembers.
 *
 * Each column keeps its own countdown, so a peak in one band does not reset
 * the hold everywhere else.  `ages` is seconds since that column was last
 * beaten, and it is modified in place alongside `hold`.
 */
export function advanceHold(
  hold: Float32Array, ages: Float32Array, target: Float32Array,
  dtSec: number, floorDb: number,
): void {
  const dt = Math.max(0, Math.min(0.25, dtSec));
  for (let i = 0; i < hold.length; i++) {
    const want = target[i] ?? floorDb;
    const now = hold[i] ?? floorDb;
    if (want >= now) {
      hold[i] = want;
      ages[i] = 0;
      continue;
    }
    const age = (ages[i] ?? 0) + dt;
    ages[i] = age;
    if (age > SPECTRUM_HOLD_SEC) {
      hold[i] = Math.max(want, now - SPECTRUM_HOLD_FALL_DB_PER_SEC * dt);
    }
  }
}

/** Where a dB value sits vertically, 0 at the top of the picture. */
export function dbToY(db: number, height: number, scale: SpectrumScale): number {
  const span = scale.topDb - scale.bottomDb;
  if (span <= 0) return height;
  const t = (scale.topDb - db) / span;
  return Math.max(0, Math.min(1, t)) * height;
}
