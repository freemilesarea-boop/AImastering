// What a channel meter reads, and the scale it is drawn on.
//
// Split out of both the engine and the Mix window because the two have to
// agree about three numbers — the window the peak is taken over, where full
// scale sits on the strip, and what counts as an over — and a meter whose
// reader and writer disagree is worse than no meter.
//
// ── What was wrong before ───────────────────────────────────────────────────
//
// The old meter was one `AnalyserNode` on the post-fader tap, read as RMS and
// drawn on a scale whose top was labelled like peak.  Two things were being
// lost, and they were measured rather than guessed:
//
//   · RMS on a peak scale.  Programme material with a 15.7 dB crest read
//     15.7 dB below where it actually was.
//   · The analyser's own down-mix.  An `AnalyserNode` sums its input to mono
//     as (L+R)/2, so a channel panned hard read 6 dB LOW at the exact moment
//     the pan had made one side louder — measured: L=1, R=0 reads −6.02 dB
//     while the channel really peaks at 0.00 dBFS.
//
// Together those put the red zone out of reach: to light `> −1 dB` on that
// meter a centred channel had to peak at +13.6 dBFS, and a hard-panned one at
// +20.7 dBFS.  The console could not show clipping at all, and nothing else
// in the app could either.
//
// So: one analyser PER SIDE, hung off a splitter so nothing is down-mixed,
// peak AND RMS reported separately, and a latch that remembers an over after
// the sample that caused it is long gone.

/**
 * How often the meters are read, in milliseconds.
 *
 * Exported so the poller and the analyser window are sized from the same
 * number.  20 Hz is enough for the eye; the LATCH is what catches what
 * happens between two polls, which is why the window below overlaps.
 */
export const METER_POLL_MS = 50;

/**
 * Where the over latch trips, as a linear sample value.
 *
 * Full scale exactly.  Nothing clips inside the graph — it is float, and a
 * channel at +6 dBFS is arithmetically fine — but everything the signal is
 * eventually written to is not: the interface, the bounce, the master.  A
 * channel meter that only complained once the master had already clipped
 * would be telling the user where the damage landed rather than where it came
 * from.
 *
 * Not "three consecutive samples", which is the converter-era rule for
 * deciding whether a RECORDING clipped.  This is a live mixer reading a float
 * bus; one sample over is a real fact about the gain staging, and hiding it
 * behind a run length would just make the latch miss short transients, which
 * are the ones a fader move actually causes.
 */
export const CLIP_CEILING = 1;

/** Bottom of the drawn scale, in dBFS. */
export const METER_FLOOR_DB = -60;
/** Top of the drawn scale, in dBFS — the over-zone above 0. */
export const METER_TOP_DB = 6;

/** One channel's meter, as of the last poll. */
export interface ChannelMeterReading {
  /** Peak of the newest window, linear, per side. */
  peakL: number;
  peakR: number;
  /** RMS of the newest window, linear, per side. */
  rmsL: number;
  rmsR: number;
  /**
   * Highest peak seen on either side since the latch was cleared.
   *
   * Held by the ENGINE rather than the strip, so it survives the Mix window
   * being closed and reopened — the number a user goes looking for is the one
   * from the take they just played, not from the 50 ms since they opened the
   * window.
   */
  holdPeak: number;
  /** True once any sample reached `CLIP_CEILING`; stays true until cleared. */
  clipped: boolean;
}

export function emptyReading(): ChannelMeterReading {
  return { peakL: 0, peakR: 0, rmsL: 0, rmsR: 0, holdPeak: 0, clipped: false };
}

/**
 * The analyser window to use at a given sample rate.
 *
 * `getFloatTimeDomainData` hands back the most recent `fftSize` samples and
 * nothing else, so a window SHORTER than the polling interval leaves a gap
 * that no reader ever sees — and an over inside that gap is an over the latch
 * never learns about.  The old meter had one: 2048 samples is 42.7 ms at
 * 48 kHz against a 50 ms poll, so 7.3 ms in every 50 was invisible.
 *
 * Two poll intervals, rounded up to a power of two, makes consecutive windows
 * overlap instead.  Overlap costs nothing here: peak is a maximum, so seeing a
 * sample twice gives the same answer as seeing it once — which is also why
 * this reports a HOLD and a latch rather than counting overs, since a count
 * under overlapping windows would double.
 */
export function meterFftSize(sampleRate: number): number {
  const wanted = 2 * (METER_POLL_MS / 1000) * sampleRate;
  let size = 2048;
  while (size < wanted && size < 32768) size *= 2;
  return size;
}

/** A linear amplitude as dBFS, floored rather than −Infinity. */
export function meterDb(linear: number): number {
  if (!(linear > 0)) return METER_FLOOR_DB;
  const db = 20 * Math.log10(linear);
  return db < METER_FLOOR_DB ? METER_FLOOR_DB : db;
}

/** Where a dB value sits on the drawn scale, 0 (bottom) to 1 (top). */
export function meterFraction(db: number): number {
  const span = METER_TOP_DB - METER_FLOOR_DB;
  const f = (db - METER_FLOOR_DB) / span;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

/** The louder side of a reading, linear — for callers that want one number. */
export function readingPeak(r: ChannelMeterReading): number {
  return Math.max(r.peakL, r.peakR);
}

/**
 * The part of a meter that outlives the analyser's window.
 *
 * Kept here, as plain numbers on a plain object, for one reason: an
 * `AnalyserNode` remembers exactly `fftSize` samples and nothing before them,
 * so everything about "did this channel EVER go over" lives in whatever the
 * poller wrote down.  That makes the latch the one piece of the meter with
 * real state, and the one piece worth testing without an audio graph.
 */
export interface MeterLatch {
  holdPeak: number;
  clipped: boolean;
}

export function newLatch(): MeterLatch {
  return { holdPeak: 0, clipped: false };
}

/**
 * Fold one poll's peaks into the latch.
 *
 * Takes the louder SIDE, not a sum or an average: a channel panned hard is
 * over when one side is over, and averaging the two is precisely the mistake
 * that hid clipping before.
 */
export function advanceLatch(latch: MeterLatch, peakL: number, peakR: number): void {
  const loudest = peakL > peakR ? peakL : peakR;
  if (loudest > latch.holdPeak) latch.holdPeak = loudest;
  if (loudest >= CLIP_CEILING) latch.clipped = true;
}

export function clearLatch(latch: MeterLatch): void {
  latch.holdPeak = 0;
  latch.clipped = false;
}
