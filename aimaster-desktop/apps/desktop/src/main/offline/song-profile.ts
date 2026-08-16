// song-profile — measure the song, so the defaults can be about THIS song.
//
// The recommended defaults are one table for everyone. That is a real
// improvement over neutral, and it is still wrong for any particular
// record: a dark ballad and a bright trap record need opposite EQ moves,
// a track already mastered at -8 LUFS needs no compression thresholds
// placed for a -20 LUFS mix, and the hiss gate's threshold is meaningless
// until somebody knows where this file's noise floor actually sits.
//
// So this measures the file and hands back numbers the renderer turns into
// per-song settings.
//
// # What it measures, and why each one earns its cost
//
//   - **loudness / crest** — where to put compressor thresholds. A
//     threshold in dBFS is a guess until you know the programme level; this
//     is why the stock multiband starting point does nothing on a quiet mix.
//   - **tonal curve** — the 32-band long-term spectrum, on the engine's own
//     grid, from the engine's own analysis pass. Everything tonal derives
//     from it: tilt, sub weight, harshness, air.
//   - **the quiet window's HF floor** — the one measurement that cannot be
//     guessed. The hiss gate's threshold is a per-bin level in dBFS, and
//     the whole feature is inert or destructive at the wrong value.
//   - **top cutoff** — generative and lossy sources often stop dead at a
//     fixed frequency. Finding it puts Top Rebuild's crossover exactly
//     there instead of at a stock 9 kHz.
//   - **stereo width and low correlation** — whether the image needs
//     widening or rescuing, and how high the bass has to be summed.
//
// # The two-window trick
//
// Two separate analysis passes run, over deliberately different material:
// the LOUD part decides tone and dynamics, because that is the record; the
// QUIETEST part decides the noise floor, because that is where the noise is
// exposed. Averaging the whole file would put the floor measurement halfway
// between the two and it would be right for neither.

import { createOfflineChain, type WasmMasteringChain } from './load-mastering-chain-node.js';
import { decodeToFloatStereo, deinterleaveStereo } from './process-audio-file-rust.js';
import { measureStereoLoudness } from './offline-loudness.js';

/** Sample rate everything is measured at. */
const SR = 48_000;
const BLOCK = 512;
/** Bands in the shared log grid — `CURVE_BANDS` in `spectral.rs`. */
const BANDS = 32;
/** Lowest / highest band centre, matching `curve_band_hz`. */
const LO_HZ = 20;
const HI_HZ = 20_000;
/**
 * FFT-magnitude-to-dBFS calibration.
 *
 * The same measured constant the gate uses (`GATE_CAL_DB` in `spectral.rs`).
 * It has to be the same number, or the threshold this file recommends means
 * something different from the threshold the engine applies.
 */
const CAL_DB = 54.19;
/** Length of the window used to find the quiet passage, in seconds. */
const QUIET_WINDOW_S = 2.0;
/** How much of the file to analyse for tone, in seconds. */
const TONE_SECONDS = 120;

export interface SongProfile {
  durationSec: number;
  integratedLufs: number;
  truePeakDbtp: number;
  /** Peak minus RMS over the loud half — how much dynamic range is left. */
  crestDb: number;
  /** 32-band long-term spectrum, per-bin dBFS. */
  curveDb: number[];
  /** Spectral tilt, dB per octave. Negative is darker at the top. */
  tiltDbPerOct: number;
  /** Sub (below 40 Hz) relative to low (40-120 Hz), dB. */
  subVsLowDb: number;
  /** 2-4 kHz relative to the whole curve's mean, dB. */
  harshDb: number;
  /** 10-16 kHz relative to the mean, dB. */
  airDb: number;
  /** 5-9 kHz relative to 1-3 kHz, dB — how sibilant the source is. */
  sibilanceDb: number;
  /** Frequency where the top falls off a cliff, or null if it does not. */
  topCutoffHz: number | null;
  /** Per-bin HF level in the quietest passage, dBFS. */
  quietHfFloorDbfs: number;
  /** Side energy as a percentage of mid — 0 is mono. */
  widthPct: number;
  /** Correlation below ~120 Hz, -1..1. Below 0 means bass cancels in mono. */
  lowCorrelation: number;
}

interface ChainWithCurve extends WasmMasteringChain {
  tonalCurveDb?(): Float64Array;
  setConfigJson?(json: string): void;
}

/** Centre frequency of curve band `i` — mirrors `curve_band_hz`. */
export function bandHz(i: number): number {
  return LO_HZ * Math.pow(HI_HZ / LO_HZ, i / (BANDS - 1));
}

/** Measure one span through the engine's analysis-only spectral pass. */
function curveOf(left: Float32Array, right: Float32Array, from: number, to: number): number[] {
  const chain = createOfflineChain(SR) as ChainWithCurve;
  if (typeof chain.setConfigJson !== 'function' || typeof chain.tonalCurveDb !== 'function') {
    throw new Error('this build cannot analyse a song');
  }
  chain.setConfigJson(JSON.stringify({ spectral: { analysisOnly: true } }));
  for (let a = from; a < to; a += BLOCK) {
    const b = Math.min(a + BLOCK, to);
    chain.processStereo(left.slice(a, b), right.slice(a, b));
  }
  const raw = Array.from(chain.tonalCurveDb());
  chain.free?.();
  // Unobserved bands come back as -Infinity; filled from the nearest
  // measured neighbour so one empty band cannot poison a mean.
  const out = raw.slice();
  for (let i = 0; i < out.length; i++) {
    if (Number.isFinite(out[i]!)) continue;
    let lo = i - 1;
    while (lo >= 0 && !Number.isFinite(out[lo]!)) lo--;
    let hi = i + 1;
    while (hi < out.length && !Number.isFinite(raw[hi]!)) hi++;
    out[i] = lo >= 0 ? out[lo]! : hi < out.length ? raw[hi]! : -120;
  }
  // Into per-bin dBFS, which is what the gate threshold is expressed in.
  return out.map((v) => v - CAL_DB);
}

/** Mean of the bands whose centre falls in [lo, hi). */
function bandMean(curve: number[], lo: number, hi: number): number {
  let acc = 0;
  let n = 0;
  for (let i = 0; i < curve.length; i++) {
    const hz = bandHz(i);
    if (hz >= lo && hz < hi) { acc += curve[i]!; n++; }
  }
  return n > 0 ? acc / n : -120;
}

/**
 * Where the spectrum falls off a cliff, if it does.
 *
 * Generative and lossy sources frequently stop dead at a fixed frequency —
 * a codec's cutoff, or the band a model was never trained above. Found by
 * walking down from the top for the first band that is far below the 1-4 kHz
 * reference, since a natural roll-off is gradual and a cutoff is not.
 */
function findTopCutoff(curve: number[]): number | null {
  const reference = bandMean(curve, 1_000, 4_000);
  // Walk up and take the first band that drops more than 24 dB below the
  // reference and stays down.
  for (let i = 0; i < curve.length; i++) {
    const hz = bandHz(i);
    if (hz < 6_000) continue;
    if (curve[i]! < reference - 24) {
      // Confirm it stays down, so a single notch is not read as a cutoff.
      let stays = true;
      for (let j = i; j < curve.length; j++) {
        if (curve[j]! > reference - 18) { stays = false; break; }
      }
      if (stays) return Math.round(hz);
    }
  }
  return null;
}

/** Least-squares tilt of the curve against log2(frequency), dB per octave. */
function fitTilt(curve: number[]): number {
  let sx = 0; let sy = 0; let sxx = 0; let sxy = 0; let n = 0;
  for (let i = 0; i < curve.length; i++) {
    const hz = bandHz(i);
    // Ignore the extremes: below 50 Hz and above 16 kHz most material is
    // roll-off rather than tone, and they would dominate a straight fit.
    if (hz < 50 || hz > 16_000) continue;
    const x = Math.log2(hz);
    sx += x; sy += curve[i]!; sxx += x * x; sxy += x * curve[i]!; n++;
  }
  if (n < 3) return 0;
  const denom = n * sxx - sx * sx;
  return denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
}

/**
 * Measure a source file.
 *
 * Throws when the file cannot be decoded, or when the WASM build predates
 * the spectral stage — better than answering with a flat profile that would
 * silently produce the stock defaults while claiming to be tailored.
 */
export async function profileSong(filePath: string): Promise<SongProfile> {
  const interleaved = await decodeToFloatStereo(filePath, SR);
  const { left, right } = deinterleaveStereo(interleaved);
  const n = left.length;
  if (n < SR) throw new Error('too short to analyse');

  const loudness = measureStereoLoudness(left, right, SR);

  // ── Find the loud span and the quietest window ─────────────────────────
  // One pass of windowed RMS drives both.
  const win = Math.floor(QUIET_WINDOW_S * SR);
  const step = Math.floor(win / 2);
  const rmsAt: number[] = [];
  let quietStart = 0;
  let quietRms = Infinity;
  let loudIdx = 0;
  let loudRms = 0;
  let peak = 0;
  let totalSq = 0;
  for (let a = 0; a + win <= n; a += step) {
    let sq = 0;
    for (let i = a; i < a + win; i++) {
      const m = (left[i]! + right[i]!) * 0.5;
      sq += m * m;
    }
    const rms = Math.sqrt(sq / win);
    rmsAt.push(rms);
    // A window that is essentially digital silence is not a noise floor —
    // it is a gap, and measuring it would recommend gating everything.
    if (rms < quietRms && rms > 1e-5) { quietRms = rms; quietStart = a; }
    if (rms > loudRms) { loudRms = rms; loudIdx = rmsAt.length - 1; }
  }
  for (let i = 0; i < n; i++) {
    const m = Math.max(Math.abs(left[i]!), Math.abs(right[i]!));
    if (m > peak) peak = m;
    const mid = (left[i]! + right[i]!) * 0.5;
    totalSq += mid * mid;
  }
  const rmsAll = Math.sqrt(totalSq / n);
  const crestDb = 20 * Math.log10(Math.max(peak, 1e-9) / Math.max(rmsAll, 1e-9));

  // ── Tone, from the LOUD part ───────────────────────────────────────────
  //
  // Not "the middle", and not "the whole file". The engine's band average is
  // an exponential decay with a ~2 s constant, so whatever the analysed span
  // ENDS on is most of what it reports. A span that runs into an outro or a
  // gap measures the gap: the first version of this ran to the end of the
  // file and came back with a -210 dBFS curve on every input, dark and
  // bright alike, because both ended in silence.
  //
  // So the span starts at the loudest window and extends only while the
  // music stays up. That is the record, which is what a tonal profile is
  // supposed to describe.
  const toneFrom = loudIdx * step;
  let toneEndIdx = loudIdx;
  while (
    toneEndIdx + 1 < rmsAt.length
    && rmsAt[toneEndIdx + 1]! > loudRms * 0.25
    && (toneEndIdx - loudIdx + 1) * step < TONE_SECONDS * SR
  ) {
    toneEndIdx++;
  }
  const toneTo = Math.min(n, toneEndIdx * step + win);
  const curveDb = curveOf(left, right, toneFrom, toneTo);

  // ── The noise floor, from the quietest window ──────────────────────────
  const quietCurve = Number.isFinite(quietRms)
    ? curveOf(left, right, quietStart, Math.min(n, quietStart + win))
    : curveDb;
  const quietHfFloorDbfs = bandMean(quietCurve, 4_000, 16_000);

  // ── Stereo ─────────────────────────────────────────────────────────────
  let midSq = 0;
  let sideSq = 0;
  for (let i = 0; i < n; i++) {
    const m = (left[i]! + right[i]!) * 0.5;
    const s = (left[i]! - right[i]!) * 0.5;
    midSq += m * m;
    sideSq += s * s;
  }
  const widthPct = 100 * Math.sqrt(sideSq / Math.max(midSq, 1e-20));

  // Low-band correlation, through a cheap one-pole pair at ~120 Hz. Enough
  // to answer "does the bass survive a mono fold", which is the only
  // question the imager needs from it.
  const c = Math.exp((-2 * Math.PI * 120) / SR);
  let ll = 0; let rr = 0; let lo = 0; let ro = 0; let lr = 0; let l2 = 0; let r2 = 0;
  for (let i = 0; i < n; i++) {
    lo = left[i]! * (1 - c) + lo * c;
    ro = right[i]! * (1 - c) + ro * c;
    lr += lo * ro; l2 += lo * lo; r2 += ro * ro;
  }
  ll = Math.sqrt(l2); rr = Math.sqrt(r2);
  const lowCorrelation = ll > 1e-12 && rr > 1e-12 ? lr / (ll * rr) : 1;

  const mean = curveDb.reduce((a, b) => a + b, 0) / curveDb.length;
  return {
    durationSec: n / SR,
    integratedLufs: Number.isFinite(loudness.integratedLufs) ? loudness.integratedLufs : -70,
    truePeakDbtp: Number.isFinite(loudness.truePeakDbtp) ? loudness.truePeakDbtp : -70,
    crestDb,
    curveDb,
    tiltDbPerOct: fitTilt(curveDb),
    subVsLowDb: bandMean(curveDb, LO_HZ, 40) - bandMean(curveDb, 40, 120),
    harshDb: bandMean(curveDb, 2_000, 4_000) - mean,
    airDb: bandMean(curveDb, 10_000, 16_000) - mean,
    sibilanceDb: bandMean(curveDb, 5_000, 9_000) - bandMean(curveDb, 1_000, 3_000),
    topCutoffHz: findTopCutoff(curveDb),
    quietHfFloorDbfs,
    widthPct,
    lowCorrelation,
  };
}
