// loud-span — where in a file the music actually is.
//
// Every long-term spectral measurement in this app has the same problem:
// the engine's band average is an exponential decay with a ~2 s constant,
// so whatever the analysed span ENDS on is most of what it reports.  Point
// a measurement at a fixed window and it describes whatever happens to be
// there — an intro, an outro, or the trailing silence almost every audio
// file has.
//
// `song-profile` learned this the hard way: its first version ran to the
// end of the file and came back with a -210 dBFS curve on every input, dark
// and bright alike, because both ended in silence.  Its fix — start at the
// loudest window, extend only while the level stays up — lived inside that
// one function, so `reference-curve` was still taking a fixed 20-110 s
// window.  Measured on the real chain:
//
//   30 s of noise + 0 s of silence  → curve mean   -3.2 dB
//   30 s of noise + 2 s of silence  → curve mean -122.1 dB
//   30 s of noise + 5 s of silence  → curve mean -178.0 dB
//
// Two seconds of trailing silence is enough to replace the measurement with
// the analyser's noise floor, which then normalises into a shape that looks
// like a reference.  So the span-finding lives here, and both callers use
// it.

/** How the span is chosen. */
export interface LoudSpanOptions {
  /** Cap on the returned span, in seconds. */
  maxSec: number;
  /** Analysis window, in seconds.  Two is the chain's own time constant. */
  windowSec?: number;
  /**
   * Fraction of the loudest window's RMS the level must stay above for the
   * span to keep extending.  A quarter is -12 dB: well below any musical
   * dynamic, well above an outro.
   */
  holdFraction?: number;
  /**
   * Grow the span backwards from the loudest window as well as forwards.
   *
   * Off by default, which is forward-only — what `song-profile` has always
   * done and what its measurements were taken against.  Turning it on
   * changes which audio is averaged and therefore the numbers that come
   * out: with it on, `song-profile` started reporting a 16 kHz top cutoff
   * on material whose highest partial is 12 kHz, because a wider average
   * settles the near-empty top bands lower against the 1-4 kHz reference.
   * Arguably a better answer; not one to adopt as a side effect of a change
   * made for a different module.
   *
   * `reference-curve` wants it on: on steady material every window has the
   * same RMS to fifteen decimal places, so forward-only keeps whatever
   * follows the arbitrary "loudest" one — 10 s of a 40 s file.
   */
  growBackward?: boolean;
  /**
   * Walk the end of the span back past a stretch that is below the hold.
   *
   * Also off by default, for the same reason.  A window only has to AVERAGE
   * above the hold to be kept, so one that is half digital silence passes
   * at around -6 dB and the span ends on silence — which a decaying average
   * cannot survive: 68 dB of band movement, measured.
   */
  trimTrailingQuiet?: boolean;
}

export interface LoudSpan {
  /** First sample of the span. */
  from: number;
  /** One past the last sample. */
  to: number;
  /** RMS of the loudest window. */
  loudRms: number;
  /** Start of the quietest window that is not digital silence. */
  quietStart: number;
  /** That window's RMS, or `Infinity` when every window was silence. */
  quietRms: number;
  /** Window length in samples — the quiet window's length too. */
  windowSamples: number;
}

/**
 * Find the loudest run of audio, and the quietest window.
 *
 * One pass of windowed RMS drives both: the LOUD part is what a tonal or
 * dynamic measurement should describe, because that is the record; the
 * QUIETEST part is what a noise-floor measurement should describe, because
 * that is where the noise is exposed.  Averaging the whole file would put
 * both halfway between and be right for neither.
 *
 * A file shorter than one window has no windows to compare, so the span is
 * the whole file — the caller decides whether that is enough to measure.
 */
export function findLoudSpan(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  opts: LoudSpanOptions,
): LoudSpan {
  const n = Math.min(left.length, right.length);
  const windowSamples = Math.floor((opts.windowSec ?? 2.0) * sampleRate);
  const hold = opts.holdFraction ?? 0.25;
  const step = Math.max(1, Math.floor(windowSamples / 2));

  const rmsAt: number[] = [];
  let quietStart = 0;
  let quietRms = Infinity;
  let loudIdx = 0;
  let loudRms = 0;
  for (let a = 0; a + windowSamples <= n; a += step) {
    let sq = 0;
    for (let i = a; i < a + windowSamples; i++) {
      const m = (left[i]! + right[i]!) * 0.5;
      sq += m * m;
    }
    const rms = Math.sqrt(sq / windowSamples);
    rmsAt.push(rms);
    // A window that is essentially digital silence is not a noise floor —
    // it is a gap, and measuring it would recommend gating everything.
    if (rms < quietRms && rms > 1e-5) { quietRms = rms; quietStart = a; }
    if (rms > loudRms) { loudRms = rms; loudIdx = rmsAt.length - 1; }
  }

  // Grow the span from the loudest window — forwards always, backwards on
  // request.  See `growBackward` for why that is a choice and not a fix.
  const maxWindows = Math.max(1, Math.floor((opts.maxSec * sampleRate) / step));
  let loIdx = loudIdx;
  let hiIdx = loudIdx;
  const holds = (i: number): boolean => i >= 0 && i < rmsAt.length && rmsAt[i]! > loudRms * hold;
  for (;;) {
    if (hiIdx - loIdx + 1 >= maxWindows) break;
    if (holds(hiIdx + 1)) { hiIdx++; continue; }
    if (opts.growBackward && holds(loIdx - 1)) { loIdx--; continue; }
    break;
  }

  const from = loIdx * step;
  let to = Math.min(n, hiIdx * step + windowSamples);

  if (opts.trimTrailingQuiet) {
    // Only this edge: the average weights the end, and the start of the
    // span has long decayed away by the time the curve is read.
    const probe = Math.max(1, Math.floor(windowSamples / 8));
    while (to - probe > from) {
      let sq = 0;
      for (let i = to - probe; i < to; i++) {
        const m = (left[i]! + right[i]!) * 0.5;
        sq += m * m;
      }
      if (Math.sqrt(sq / probe) > loudRms * hold) break;
      to -= probe;
    }
  }

  return { from, to, loudRms, quietStart, quietRms, windowSamples };
}

/** RMS of the mid signal over `[from, to)`, in dBFS (-Infinity for silence). */
export function spanRmsDbfs(
  left: Float32Array, right: Float32Array, from: number, to: number,
): number {
  if (to <= from) return -Infinity;
  let sq = 0;
  for (let i = from; i < to; i++) {
    const m = (left[i]! + right[i]!) * 0.5;
    sq += m * m;
  }
  const rms = Math.sqrt(sq / (to - from));
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}
