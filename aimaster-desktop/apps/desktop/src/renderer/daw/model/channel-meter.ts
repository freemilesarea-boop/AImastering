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
  /** What the bars should DRAW, in dBFS, after ballistics. */
  shownDbL: number;
  shownDbR: number;
  /** Where the hold marker should sit, in dBFS. */
  shownHoldDb: number;
}

export function emptyReading(): ChannelMeterReading {
  return {
    peakL: 0, peakR: 0, rmsL: 0, rmsR: 0, holdPeak: 0, clipped: false,
    shownDbL: METER_FLOOR_DB, shownDbR: METER_FLOOR_DB, shownHoldDb: METER_FLOOR_DB,
  };
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

// ── Ballistics ───────────────────────────────────────────────────────────────
//
// An analyser window read every 50 ms is a series of unrelated numbers, and
// drawing it raw is why a meter flickers.  Measured on programme material with
// a transient every half second: the peak bar moved 1.91 dB between frames on
// average and 10.44 dB at worst, and when the signal STOPPED it fell 48 dB in
// a single frame — the bar did not go down, it vanished.
//
// The RMS bar was measured too, and it is left alone: 0.44 dB mean step,
// 2.02 dB worst.  The 170 ms analyser window already integrates it, so adding
// a smoother would buy nothing and cost lag.  Said here because "add
// ballistics to the meters" sounds like it should apply to both bars, and the
// numbers say it should not.
//
// Everything below advances on ELAPSED TIME rather than on being called.  The
// meter this replaced decayed its hold by a fixed step per React render, so
// its fall rate was however often the component happened to re-render — faster
// while a fader was being dragged, twice as fast under StrictMode.  A fall
// rate that depends on what else the UI is doing is not a fall rate.

/**
 * How fast the peak bar falls, in dB per second.
 *
 * In the return-time family IEC 60268-10 defines for a PPM (20 dB in 1.7 s,
 * i.e. 11.8 dB/s); faster, because this is a sample-peak bar rather than a
 * quasi-peak one and a digital meter that lingers is claiming headroom is
 * gone when it is not.  Measured at this rate on the material above: the mean
 * frame-to-frame step drops from 1.91 dB to 1.16 dB, and the 48 dB collapse
 * at the end of a signal becomes a glide of about 1 dB per frame.
 *
 * It over-reads the newest window by 3.1 dB on average on that material.
 * That is not an error to tune away: on a source that peaks every half second
 * the whole job of a fall time is to keep the last transient visible until
 * the next one.
 */
export const PEAK_FALL_DB_PER_SEC = 20;

/** How long the hold marker sits still before it starts falling, in seconds. */
export const HOLD_SECONDS = 1.5;

/**
 * How fast the hold marker falls once its hold expires, in dB per second.
 *
 * The PPM return time itself — slower than the bar, which is the point: the
 * marker is there to be read after the fact, and a marker that chases the bar
 * down is just a second copy of the bar.  Convention rather than a
 * measurement, and labelled as one.
 */
export const HOLD_FALL_DB_PER_SEC = 12;

/**
 * The displayed state of one channel's meter, in dB.
 *
 * Separate from the latch: the latch is a fact that never decays (this channel
 * went over, this was its loudest sample), and this is a picture that is
 * supposed to.
 */
export interface MeterBallistics {
  peakDbL: number;
  peakDbR: number;
  /** The hold marker, taken from the louder side. */
  holdDb: number;
  /** Seconds left before the marker starts falling. */
  holdRemaining: number;
  /** When this was last advanced, in seconds; null before the first advance. */
  at: number | null;
}

export function newBallistics(): MeterBallistics {
  return {
    peakDbL: METER_FLOOR_DB, peakDbR: METER_FLOOR_DB,
    holdDb: METER_FLOOR_DB, holdRemaining: 0, at: null,
  };
}

/**
 * Move the display on to `nowSec`, given the newest window's peaks.
 *
 * Rise is instant and fall is a rate, which makes every step here exactly
 * additive in time: ten advances of 50 ms land on the same numbers as one
 * advance of 500 ms.  That is the property worth having — both the transport
 * tick and the Mix window call the poller, at rates that change with what the
 * user is doing, and a meter whose fall rate moved with them would be
 * reporting the UI rather than the audio.
 */
export function advanceBallistics(
  b: MeterBallistics, peakL: number, peakR: number, nowSec: number,
): void {
  const dt = b.at === null ? 0 : Math.max(0, nowSec - b.at);
  b.at = nowSec;

  const l = meterDb(peakL);
  const r = meterDb(peakR);
  const fall = PEAK_FALL_DB_PER_SEC * dt;
  b.peakDbL = Math.max(l, b.peakDbL - fall);
  b.peakDbR = Math.max(r, b.peakDbR - fall);

  const loudest = l > r ? l : r;
  if (loudest >= b.holdDb) {
    b.holdDb = loudest;
    b.holdRemaining = HOLD_SECONDS;
    return;
  }
  // Spend the step on the hold first and the fall second, so a single long
  // step that straddles the end of the hold lands where a run of short ones
  // would.
  const held = Math.min(dt, b.holdRemaining);
  b.holdRemaining -= held;
  const falling = dt - held;
  if (falling > 0) b.holdDb = Math.max(loudest, b.holdDb - HOLD_FALL_DB_PER_SEC * falling);
}

/** Drop the hold marker — the click that clears the latch clears this too. */
export function clearBallisticsHold(b: MeterBallistics): void {
  b.holdDb = METER_FLOOR_DB;
  b.holdRemaining = 0;
}

/** One side of one poll, as measured off the analyser. */
export interface SideReading { peak: number; rms: number }

/**
 * Fold one poll into the latch and the ballistics, and build what the strip
 * draws.
 *
 * Here rather than in the engine so it can be driven with a FALLING sequence.
 * That matters more than it looks: a finished offline render leaves the same
 * window in the analyser forever, so through the graph the ballistic value
 * and the raw window value are always equal, and a version of this that
 * quietly reported the raw peaks passed every rendered check.  Given peaks
 * directly, the two come apart on the second call and the difference is
 * visible.
 */
export function composeReading(
  latch: MeterLatch, ballistics: MeterBallistics,
  l: SideReading, r: SideReading, nowSec: number,
): ChannelMeterReading {
  advanceLatch(latch, l.peak, r.peak);
  advanceBallistics(ballistics, l.peak, r.peak, nowSec);
  return {
    peakL: l.peak, peakR: r.peak,
    rmsL: l.rms, rmsR: r.rms,
    holdPeak: latch.holdPeak, clipped: latch.clipped,
    shownDbL: ballistics.peakDbL, shownDbR: ballistics.peakDbR,
    shownHoldDb: ballistics.holdDb,
  };
}
