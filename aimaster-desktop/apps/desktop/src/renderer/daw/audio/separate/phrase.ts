// The cue that finds the voices that are NOT in the middle.
//
// ── The hole this fills ──────────────────────────────────────────────────────
//
// The vocal mask is built on centre-ness, and it works: a lead vocal is dead
// centre and the mask finds it.  Then stacked backing vocals were measured, and
// three quarters of them had gone to "그 외".
//
// Which is not a bug in the threshold.  It is the cue eating itself.  Backing
// vocals are DELIBERATELY not centred — doubled, spread hard left and right,
// detuned against each other — and every one of those choices is the thing
// that makes them fail a centre test.  The better a record's backing vocals
// are recorded, the more certainly the separator throws them away.
//
// ── What is left to go on ────────────────────────────────────────────────────
//
// Backing vocals do something a pad, a guitar and a string section do not:
// THEY START AND STOP WITH THE SINGER.  They enter on the phrase, breathe where
// the phrase breathes and leave when it leaves, because they are singing the
// same words.  A pad holds through the whole chorus; a guitar part follows the
// bar, not the sentence.
//
// So this measures how strongly the music's loudness over time tracks the lead
// vocal's.  It is a correlation coefficient — not a level, a SHAPE — so a quiet
// double an octave up scores as high as the lead itself, and a loud pad that
// simply happens to be playing throughout scores near zero because it does not
// move.
//
// ── Bands, not bins, and that is the whole trick ─────────────────────────────
//
// The first version correlated each BIN against the lead, and it produced
// nothing: measured over a 24-second chunk, the strongest bin scored 0.011
// against a floor of 0.35.  The reason is obvious in hindsight and invisible
// before it is measured — A MELODY DOES NOT STAY IN ONE BIN.  A backing vocal's
// third harmonic on the first note of a phrase is at one frequency and on the
// second note it is at another, so any single bin holds a lone spike against
// the lead's twenty, and a lone spike correlates with a train of them at about
// one over twenty.
//
// Third-octave bands are wide enough that a sung line stays inside one across
// a phrase, and narrow enough that "the region where the backings live" is
// still a region and not the whole spectrum.
//
// ── What it cannot do ────────────────────────────────────────────────────────
//
// A pad that is played in the same rhythm as the vocal will score high and be
// pulled in.  A backing vocal that sustains through a gap in the lead will
// score low and be left out.  The cue is a correlation, and correlation is not
// identity — which is why it is combined with, rather than substituted for,
// the others.

/**
 * Per-frame loudness of whatever the vocal mask currently believes in.
 *
 * The envelope this returns is the reference every bin is compared against, so
 * it has to come from the CONFIDENT part of the mask — the material that is
 * plainly centred — or it would be a correlation of a signal with itself.
 */
export function leadEnvelope(
  vocalMask: Float32Array, magnitude: Float32Array, frames: number, bins: number,
): Float32Array {
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const base = f * bins;
    let sum = 0;
    for (let b = 0; b < bins; b++) sum += (vocalMask[base + b] ?? 0) * (magnitude[base + b] ?? 0);
    env[f] = sum;
  }
  return env;
}

export interface PhraseOptions {
  /**
   * Correlation below which a band is not phrasing with the singer at all.
   *
   * Not zero: over a few hundred frames, two unrelated envelopes correlate at
   * a few tenths simply because both are music.  Starting the ramp above that
   * floor is what stops the cue from quietly promoting the whole arrangement.
   */
  floor: number;
  /** Correlation at which a band is taken to be phrasing with it completely. */
  full: number;
  /** Bands per octave.  Three is a third-octave analysis. */
  perOctave: number;
  /** The range the cue looks at — outside it, no vocal to find. */
  lowHz: number;
  highHz: number;
}

/**
 * Measured, not chosen: at 0.3/0.7 the cue recovered 28 % of the stacked
 * backing vocals, at 0.2/0.45 it recovered 43 %, and going lower still bought
 * nothing.  The cost either way was two points of "그 외" purity.
 */
export const DEFAULT_PHRASE: PhraseOptions = {
  floor: 0.2, full: 0.45, perOctave: 3, lowHz: 90, highHz: 12000,
};

/** Third-octave band edges in bins, covering `lowHz`…`highHz`. */
function bandEdges(
  bins: number, fftSize: number, sampleRate: number, options: PhraseOptions,
): Int32Array {
  const binOf = (hz: number): number =>
    Math.max(1, Math.min(bins - 1, Math.round((hz * fftSize) / sampleRate)));
  const edges: number[] = [];
  const step = Math.pow(2, 1 / Math.max(1, options.perOctave));
  for (let hz = options.lowHz; hz < options.highHz; hz *= step) {
    const b = binOf(hz);
    if (edges.length === 0 || b > (edges[edges.length - 1] ?? 0)) edges.push(b);
  }
  const top = binOf(options.highHz);
  if (top > (edges[edges.length - 1] ?? 0)) edges.push(top);
  return Int32Array.from(edges);
}

/**
 * How much the music in each band moves with `envelope`, as a gain in [0,1].
 *
 * One pass to build the band envelopes, one to correlate them — next to the
 * transform that produced the spectrogram, free.
 */
export function phraseLock(
  magnitude: Float32Array, envelope: Float32Array, frames: number, bins: number,
  fftSize: number, sampleRate: number, options: Partial<PhraseOptions> = {},
): Float32Array {
  const opts: PhraseOptions = { ...DEFAULT_PHRASE, ...options };
  const out = new Float32Array(frames * bins);
  if (frames < 8 || opts.full <= opts.floor) return out;

  let envMean = 0;
  for (let f = 0; f < frames; f++) envMean += envelope[f] ?? 0;
  envMean /= frames;
  let envVar = 0;
  for (let f = 0; f < frames; f++) envVar += ((envelope[f] ?? 0) - envMean) ** 2;
  if (envVar <= 0) return out;          // the singer never stops, or never starts
  const envSd = Math.sqrt(envVar);

  const edges = bandEdges(bins, fftSize, sampleRate, opts);
  const bandCount = Math.max(0, edges.length - 1);
  if (bandCount === 0) return out;

  // Band envelopes.
  const band = new Float32Array(bandCount * frames);
  for (let f = 0; f < frames; f++) {
    const base = f * bins;
    for (let k = 0; k < bandCount; k++) {
      const from = edges[k] ?? 0;
      const to = edges[k + 1] ?? from;
      let sum = 0;
      for (let b = from; b < to; b++) sum += magnitude[base + b] ?? 0;
      band[k * frames + f] = sum;
    }
  }

  const scale = 1 / (opts.full - opts.floor);
  const gain = new Float32Array(bandCount);
  for (let k = 0; k < bandCount; k++) {
    let mean = 0;
    for (let f = 0; f < frames; f++) mean += band[k * frames + f] ?? 0;
    mean /= frames;
    let sd = 0;
    let cov = 0;
    for (let f = 0; f < frames; f++) {
      const d = (band[k * frames + f] ?? 0) - mean;
      sd += d * d;
      cov += d * ((envelope[f] ?? 0) - envMean);
    }
    sd = Math.sqrt(sd);
    const r = sd > 0 ? cov / (sd * envSd) : 0;
    const t = (r - opts.floor) * scale;
    // Raised cosine, so the cue does not switch on at a hard edge that would
    // print itself on the audio as a band appearing mid-phrase.
    gain[k] = t <= 0 ? 0 : t >= 1 ? 1 : 0.5 * (1 - Math.cos(Math.PI * t));
  }

  // The correlation is a property of the BAND over the whole chunk, but it is
  // only evidence where there is something to be evidence about — a band that
  // phrases with the singer is still just the pad between phrases, and handing
  // it a gain there would pull the pad up in every gap.
  for (let f = 0; f < frames; f++) {
    const base = f * bins;
    const active = Math.min(1, Math.max(0, ((envelope[f] ?? 0) - envMean) / envSd + 0.5));
    if (active <= 0) continue;
    for (let k = 0; k < bandCount; k++) {
      const g = (gain[k] ?? 0) * active;
      if (g <= 0) continue;
      const from = edges[k] ?? 0;
      const to = edges[k + 1] ?? from;
      for (let b = from; b < to; b++) out[base + b] = g;
    }
  }
  return out;
}
