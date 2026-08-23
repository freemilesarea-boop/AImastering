// Four stems out of one mix.
//
// ── What this is, and what it is not ─────────────────────────────────────────
//
// This is signal processing, not a neural network.  It knows four things about
// records — drums are vertical stripes and notes are horizontal ones, the lead
// is in the middle, the backing repeats and the singer does not, and the bass
// is a note with harmonics — and it acts on them.  A trained model knows what a
// snare SOUNDS like, which is a different and better kind of knowledge, and on
// a dense mix it will win.  Nothing here pretends otherwise: every run comes
// back with a measured confidence per stem and a list of the cues that were
// not available, and the UI shows both.
//
// What it does have is that it runs on any machine, offline, on a file the user
// has not agreed to upload anywhere, with no download and no licence.
//
// ── The one property that is exact ───────────────────────────────────────────
//
// The four masks are built so that they sum to one at every bin of every
// frame.  Writing `p` for the drum credit, `lo` for the bass weight and `q`
// for the vocal cue:
//
//     bass   = (1−p)·lo
//     vocals = (1 − (1−p)·lo)·q
//     drums  = (1−q)·p
//     other  = (1−q)·(1−p)·(1−lo)
//
//     Σ = (1−p)lo + (1−(1−p)lo)·q + (1−q)·[p + (1−p)(1−lo)]
//       = (1−p)lo + (1−(1−p)lo)·q + (1−q)·(1 − (1−p)lo)
//       = (1−p)lo + (1 − (1−p)lo)                          = 1
//
// `p` was `1−h` for a long time, and the identity is the same either way — the
// proof only needs `p` to be a number in [0,1].  It is now the DRUM CREDIT from
// `percussive.ts`, which starts from `1−h` and then asks the kit templates
// whether anything was actually struck.  That file says why; the short version
// is that a compressed kick's sub tail is horizontal and a picked guitar is
// vertical, so "vertical stripe" and "drum" are not the same claim.
//
// The four stems therefore add back up to the input, and
// `report.reconstructionDb` says by how much they miss — a number, measured on
// the actual output, not a promise.  That is what makes the stems usable as an
// EDIT: mute one, keep the other three, and what is left is the record minus
// that part, with nothing added to it.
//
// ── Order of operations ──────────────────────────────────────────────────────
//
// THE BASS IS TAKEN FIRST.  It was not, at first, and the vocal went second —
// which sounded like the right order until it was measured: a centred bass
// guitar's harmonics at 110, 165 and 220 Hz look exactly like a centred male
// voice to the panning cue, and 28 % of the bass ended up singing.  The bass
// is the one part with a cue nothing else shares — it is a low note with a
// harmonic series, and `bass.ts` finds it — so it gets to claim its bins
// before anything else is asked.  Everything after divides what is left.

import { DEFAULT_HPSS, hpssHarmonic, type HpssOptions } from './hpss.js';
import { DEFAULT_REPET, repetition, type RepetOptions } from './repet.js';
import { centreness, midMagnitude, type CentrenessOptions } from './stereo.js';
import { DEFAULT_BASS, bassShelf, bassWeight, trackBass, type BassOptions } from './bass.js';
import {
  Overlap, SEPARATION_STFT, analyse, binHz, contextFrames, denominatorFor,
  frameCount, magnitudes, type HalfSpectrum, type SpectrumOptions,
} from './spectrum.js';
import {
  DEFAULT_DRUMS, DRUM_PARTS, drumMasks, drumPresence, drumTemplates,
  type DrumOptions, type DrumPart,
} from './drums.js';
import { voiceSplit, type VoiceSplitOptions } from './voices.js';
import {
  DEFAULT_DRUM_CREDIT, drumCredit, kickExcess, subBinCount,
  type DrumCreditOptions,
} from './percussive.js';
import { leadEnvelope, phraseLock, type PhraseOptions } from './phrase.js';
import {
  DETAILED_STEMS, FULL_STEMS, STEM_TREE, TOP_STEMS, coverProblems, needsModel,
  orderStems, stemColor, stemLabel, stemNode, stemRoot, stemSource,
  type StemKind, type StemNode, type StemSource,
} from './stem-tree.js';

/**
 * The four top-level stems.
 *
 * Kept under its old name because it is what "all of them, undivided" means
 * everywhere else in the app; `DETAILED_STEMS` is the same record split as far
 * as the cues go.  `stem-tree.ts` owns the taxonomy.
 */
export const STEM_KINDS = TOP_STEMS;
export {
  DETAILED_STEMS, FULL_STEMS, STEM_TREE, TOP_STEMS, needsModel, stemColor,
  stemLabel, stemNode, stemRoot, stemSource,
};
export type { StemKind, StemNode, StemSource };

export interface VocalOptions {
  /** How much the centre cue counts.  Higher = a narrower, cleaner vocal. */
  centreWeight: number;
  /** How much the "does not repeat" cue counts. */
  noveltyWeight: number;
  /**
   * How much of the percussive part a vocal may claim.
   *
   * Consonants ARE transients — "t", "k", "s" are broadband clicks and hisses —
   * so a vocal taken purely from the harmonic part comes back lisping.  This
   * is the fraction of a percussive bin the vocal cue can still win.  Too high
   * and the snare joins the singer.
   */
  consonants: number;
  /** Below this the vocal cue is treated as noise and zeroed. */
  floor: number;
  /**
   * What the centre cue is worth when there is no centre cue — mono, or a
   * stereo file whose two channels turn out to be the same signal.
   *
   * It cannot be 1.  With the panning cue gone the vocal mask is just "harmonic
   * and a bit novel", which on a real mix is most of the record: measured on
   * the test mix, a mono run put 47 % of the total energy in the vocal stem.
   * Asking more of the one cue that is left is the honest response to losing
   * the other one, and the note in the report says it happened.
   *
   * Leaning HARDER on novelty to compensate was tried and measured worse: at
   * 0.55 with novelty's power raised 1.8×, the mono run recovered 45 % of the
   * voice against 58 % at a plain 0.7, because the repetition cue is not
   * accurate enough to carry that much weight on its own.  So there is one
   * number here and not two.
   */
  monoCentre: number;
  /**
   * What a bin that phrases with the singer is worth when it is NOT centred.
   *
   * This is how stacked backing vocals get in at all.  They are deliberately
   * spread and detuned, so they fail the centre test by design — measured, three
   * quarters of them were landing in "그 외".  A bin whose loudness tracks the
   * lead's over the whole chunk is given this much credit instead.
   */
  phraseCredit: number;
}

export const DEFAULT_VOCAL: VocalOptions = {
  centreWeight: 1.4,
  noveltyWeight: 1,
  consonants: 0.35,
  floor: 0.06,
  monoCentre: 0.7,
  phraseCredit: 1,
};

export interface SeparationOptions {
  stft: SpectrumOptions;
  hpss: Partial<HpssOptions>;
  repet: Partial<RepetOptions>;
  centre: Partial<CentrenessOptions>;
  vocal: Partial<VocalOptions>;
  bass: BassOptions;
  phrase: Partial<PhraseOptions>;
  drums: Partial<DrumOptions>;
  credit: Partial<DrumCreditOptions>;
  voices: Partial<VoiceSplitOptions>;
  /**
   * Frames kept per chunk.  Everything else is context and is thrown away, so
   * this trades memory against how often the file is re-analysed — it does not
   * change the answer.  1400 frames is about thirty seconds.
   */
  chunkFrames: number;
  /**
   * Which stems to make.
   *
   * Must cover the tree exactly once — see `stem-tree.ts`.  Asking for both
   * 보컬 and 리드 is refused rather than obeyed, because obeying it writes the
   * singer into two files and playing them together is the singer twice.
   */
  wanted: readonly StemKind[];
}

export const DEFAULT_SEPARATION: SeparationOptions = {
  stft: SEPARATION_STFT,
  hpss: {},
  repet: {},
  centre: {},
  vocal: {},
  bass: DEFAULT_BASS,
  phrase: {},
  drums: {},
  credit: {},
  voices: {},
  chunkFrames: 1400,
  wanted: STEM_KINDS,
};

export interface StemResult {
  kind: StemKind;
  channels: Float32Array[];
  /** Share of the mix's total energy that landed here, 0…1. */
  energyShare: number;
  /**
   * Share of THIS stem's energy that came from a mask above 0.8 — i.e. from
   * bins the separator was sure about rather than ones it split down the
   * middle.  Low means the stem is mostly a blend, and the UI says so.
   */
  confidence: number;
  peak: number;
}

export interface SeparationReport {
  stems: StemResult[];
  sampleRate: number;
  length: number;
  stereo: boolean;
  /** False when the two channels were identical, so the centre cue said nothing. */
  centreInformative: boolean;
  /** How repetitive the backing turned out to be, 0…1. */
  repetitiveness: number;
  /** Drum hits found, when the kit was taken apart.  Zero is a fact worth saying. */
  drumOnsets: number;
  /** Whether the lead/코러스 split had a cue to work from at all. */
  voicesSeparable: boolean;
  /** dB of `input − Σ stems` relative to the input.  Lower is better. */
  reconstructionDb: number;
  /** Plain-language caveats, in the order they matter. */
  notes: string[];
  elapsedMs: number;
}

export type SeparationProgress = (fraction: number, what: string) => void;

/** Vocal plausibility by frequency alone — a prior, not a decision. */
function vocalPrior(bins: number, fftSize: number, sampleRate: number): Float32Array {
  const prior = new Float32Array(bins);
  for (let b = 0; b < bins; b++) {
    const hz = binHz(b, fftSize, sampleRate);
    let v: number;
    // Nothing sings below 70 Hz, and everything below it is bass or kick.
    if (hz < 70) v = 0;
    else if (hz < 110) v = (hz - 70) / 40;
    else if (hz <= 8000) v = 1;
    // Sibilance lives above 8 k, but so does every cymbal in the mix, so the
    // cue is weakened rather than cut — the other cues decide up there.
    else if (hz < 16000) v = 1 - 0.6 * ((hz - 8000) / 8000);
    else v = 0.4;
    prior[b] = v;
  }
  return prior;
}

function energyOf(channels: readonly Float32Array[]): number {
  let sum = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) sum += (ch[i] ?? 0) ** 2;
  return sum;
}

function peakOf(channels: readonly Float32Array[]): number {
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) {
      const v = Math.abs(ch[i] ?? 0);
      if (v > peak) peak = v;
    }
  }
  return peak;
}

/**
 * Separate `channels` into stems.
 *
 * Mono is allowed and is not silently treated as stereo: the centre cue is
 * unavailable, `centreInformative` is false, and a note says so.
 */
export function separate(
  channels: readonly Float32Array[], sampleRate: number,
  options: Partial<SeparationOptions> = {}, onProgress: SeparationProgress = () => {},
): SeparationReport {
  const started = Date.now();
  const opts: SeparationOptions = { ...DEFAULT_SEPARATION, ...options };
  const vocal: VocalOptions = { ...DEFAULT_VOCAL, ...opts.vocal };
  const creditOpts: DrumCreditOptions = { ...DEFAULT_DRUM_CREDIT, ...opts.credit };
  const { fftSize, hopSize } = opts.stft;

  if (channels.length === 0) throw new Error('오디오가 비어 있습니다');
  if (channels.length > 2) {
    throw new Error(`${channels.length}채널은 아직 분리하지 못합니다 — 모노나 스테레오만 됩니다`);
  }
  const left = channels[0]!;
  const right = channels[1] ?? left;
  const stereo = channels.length === 2;
  const length = left.length;
  if (length === 0) throw new Error('오디오가 비어 있습니다');

  const total = frameCount(length, opts.stft);
  // Read from the same defaults the algorithms will read from.  A context
  // computed against one number while the median filter uses another is a
  // chunk boundary you can hear.
  const repetWindow = opts.repet.windowFrames ?? DEFAULT_REPET.windowFrames;
  const hpssFrames = opts.hpss.harmonicFrames ?? DEFAULT_HPSS.harmonicFrames;
  // Enough context that a kept frame sees exactly what it would have seen in a
  // single whole-file pass: the overlap-add reach, the median filter's reach,
  // and the repetition window's reach.
  const context = contextFrames(opts.stft, Math.max(repetWindow, hpssFrames));

  const wanted = orderStems(opts.wanted.length > 0 ? opts.wanted : STEM_KINDS);
  // Nothing here can make a 기타 stem, and pretending otherwise would not fail
  // — it would hand every timbre stem the same "그 외" mask and write the same
  // audio into eight files.  A refusal that names them is the only honest
  // outcome until a model is installed.
  const modelOnly = needsModel(wanted);
  if (modelOnly.length > 0) {
    throw new Error(`${modelOnly.map(stemLabel).join(' · ')} 은(는) 음색으로만 구분되는 스템이라`
      + ' 신호 처리로는 나눌 수 없습니다 — 분리 모델이 설치되어야 합니다');
  }

  const cover = coverProblems(wanted);
  if (cover.overlapping.length > 0) {
    throw new Error(`${cover.overlapping.map(stemLabel).join(' · ')} 은(는) 상위 스템에 이미 포함됩니다`
      + ' — 같이 만들면 그 파트가 두 번 들어갑니다');
  }
  const wantsDrumParts = wanted.includes('kick') || wanted.includes('kit');
  const wantsVoiceParts = wanted.includes('lead') || wanted.includes('backing');
  const outChannels = stereo ? 2 : 1;
  const denominator = denominatorFor(length, fftSize);
  const accumulators = new Map<string, Overlap>();
  for (const kind of wanted) {
    for (let c = 0; c < outChannels; c++) {
      accumulators.set(`${kind}:${c}`, new Overlap(length, fftSize, denominator));
    }
  }

  const prior = vocalPrior((fftSize >> 1) + 1, fftSize, sampleRate);
  const shelf = bassShelf((fftSize >> 1) + 1, fftSize, sampleRate, opts.bass);

  let centreInformative = false;
  let similarityTotal = 0;
  let similarityChunks = 0;
  // Energy that came from a mask above this counts as a confident decision.
  const CONFIDENT = 0.8;
  const confidentEnergy = new Map<StemKind, number>();
  const stemEnergy = new Map<StemKind, number>();
  for (const node of STEM_TREE) { confidentEnergy.set(node.kind, 0); stemEnergy.set(node.kind, 0); }
  // Needed on every run now, not only when the kit is being split: the drum
  // credit is what DEFINES the drum stem, and the templates are how it knows a
  // struck drum from a picked guitar.
  const templates = drumTemplates((fftSize >> 1) + 1, fftSize, sampleRate);
  const subBins = subBinCount(templates.kick, (fftSize >> 1) + 1);
  let drumOnsets = 0;
  let voicesInformative = false;

  const chunks = Math.max(1, Math.ceil(total / opts.chunkFrames));
  let chunkIndex = 0;

  for (let start = 0; start < total; start += opts.chunkFrames) {
    const end = Math.min(total, start + opts.chunkFrames);
    const from = Math.max(0, start - context);
    const to = Math.min(total, end + context);
    const step = (label: string, within: number): void => {
      onProgress((chunkIndex + within) / chunks, label);
    };

    step('분석', 0.05);
    const specL = analyse(left, sampleRate, from, to, opts.stft);
    const specR = stereo ? analyse(right, sampleRate, from, to, opts.stft) : specL;
    const frames = specL.frames;
    const bins = specL.bins;

    step('타악기 분리', 0.25);
    const magL = magnitudes(specL);
    const magR = stereo ? magnitudes(specR) : magL;
    const harmonicL = hpssHarmonic(magL, frames, bins, opts.hpss);
    const harmonicR = stereo ? hpssHarmonic(magR, frames, bins, opts.hpss) : harmonicL;

    step('가운데 성분', 0.45);
    const centre = centreness(specL, specR, opts.centre);
    if (centre.informative) centreInformative = true;

    step('반복 성분', 0.55);
    const mid = stereo ? midMagnitude(specL, specR) : magL;
    const repeat = repetition(mid, frames, bins, opts.repet);
    similarityTotal += repeat.repetitiveness;
    similarityChunks++;

    step('스템 만들기', 0.8);
    // Exactly one writer per chunk counts the overlap-add denominator: every
    // accumulator covers the same samples with the same window, so counting it
    // per stem would divide the output by four.
    let countedThisChunk = false;
    // One mask buffer, reused for every stem of every channel: at 2049 bins
    // and two thousand frames each of these is 16 MB, and four of them alive
    // at once for two channels is a renderer that runs out of memory on a
    // five-minute file.
    const mask = new Float32Array(frames * bins);
    const bassW = new Float32Array(frames * bins);
    const sustainedMag = new Float32Array(frames * bins);
    const vocalMask = new Float32Array(frames * bins);
    // The drum credit, and the percussive magnitude the onset detector reads.
    // Both are per-channel and both are needed before anything else can be
    // decided, so they are allocated once per chunk and rewritten per channel.
    const credit = new Float32Array(frames * bins);
    const percussiveMag = new Float32Array(frames * bins);
    // Only the kick's register — about fourteen bins — so this is kilobytes
    // where the buffers above it are megabytes.
    const excess = new Float32Array(frames * Math.max(1, subBins));
    // Only allocated when the tree actually asks for them: four more buffers
    // this size is another 72 MB per chunk, and most runs want the four
    // top-level stems and nothing else.
    const kitMask: Record<DrumPart, Float32Array> | null = wantsDrumParts ? {
      kick: new Float32Array(frames * bins), snare: new Float32Array(frames * bins),
      toms: new Float32Array(frames * bins), cymbals: new Float32Array(frames * bins),
    } : null;

    // The lead/backing split is a threshold on the centre cue, which is joint
    // across the channels, so it is the same answer for both of them.
    const voices = wantsVoiceParts
      ? voiceSplit(centre, frames, bins, opts.voices) : null;
    if (voices?.available) voicesInformative = true;

    for (let c = 0; c < outChannels; c++) {
      const spec = c === 0 ? specL : specR;
      const mag = c === 0 ? magL : magR;
      const harmonic = c === 0 ? harmonicL : harmonicR;

      // ── What was struck ──
      //
      // Onsets are found in the PERCUSSIVE magnitude, because an onset is a
      // transient by definition and that is the one thing the median filter is
      // reliable about.  What the onset means — and how far past it a drum is
      // still ringing — is what the credit answers.
      for (let i = 0; i < frames * bins; i++) {
        percussiveMag[i] = (1 - (harmonic[i] ?? 0)) * (mag[i] ?? 0);
      }
      // Classified from THIS channel's percussive magnitude, so a hard-panned
      // hat is scored where it actually is.
      const kit = drumPresence(percussiveMag, frames, bins, templates,
        hopSize / sampleRate, opts.drums);
      if (c === 0) drumOnsets += kit.onsets;
      // Under the kick's ceiling the onset envelope is a GUESS at how long a hit
      // lasted; `kickExcess` is a measurement of it.  See `percussive.ts`.
      if (subBins > 0) kickExcess(excess, mag, frames, bins, subBins, creditOpts);
      drumCredit(credit, harmonic, kit.presence, templates, frames, bins, creditOpts,
        subBins > 0 ? excess : null, subBins);

      // The bass tracker works on what is left after the drums — a bass note is
      // a sustained thing, and asking a spectrogram that still contains the
      // kick where the low note is just finds the kick.  This used to be the
      // harmonic magnitude, which is the same array only while `p` is `1−h`;
      // a compressed kick's sub tail is harmonic and was landing in the
      // tracker's search range as a very convincing 40 Hz note.
      for (let i = 0; i < frames * bins; i++) {
        sustainedMag[i] = (1 - (credit[i] ?? 0)) * (mag[i] ?? 0);
      }
      const track = trackBass(sustainedMag, frames, bins, fftSize, sampleRate, opts.bass);
      bassWeight(bassW, track, shelf, frames, bins, fftSize, sampleRate, opts.bass);

      // ── Pass one: what is plainly centred ──
      //
      // This is the lead, and it is only used to find out WHEN the singing is
      // happening.  The mask it produces is thrown away and rebuilt below.
      for (let i = 0; i < frames * bins; i++) {
        const p = credit[i] ?? 0;
        const place = centre.informative
          ? Math.pow(centre.value[i] ?? 0, vocal.centreWeight) : vocal.monoCentre;
        const cue = (prior[i % bins] ?? 0) * place
          * Math.pow(repeat.novelty[i] ?? 0, vocal.noveltyWeight)
          * ((1 - p) + vocal.consonants * p);
        vocalMask[i] = cue < vocal.floor ? 0 : Math.min(1, cue);
      }
      const envelope = leadEnvelope(vocalMask, mag, frames, bins);
      const phrasing = phraseLock(mag, envelope, frames, bins, fftSize, sampleRate, opts.phrase);

      // ── Pass two: centred OR phrasing with whoever is ──
      for (let i = 0; i < frames * bins; i++) {
        const p = credit[i] ?? 0;
        // What is left after the bass has taken its share.  The vocal cue is
        // scaled by it, so a bin the bass owns cannot also be sung.
        const remaining = 1 - (1 - p) * (bassW[i] ?? 0);
        const place = centre.informative
          ? Math.pow(centre.value[i] ?? 0, vocal.centreWeight) : vocal.monoCentre;
        // MAX, not sum: the two are alternative reasons to believe the same
        // thing, and adding them would let a bin that is a bit of both beat
        // one that is unmistakably centred.
        const belongs = Math.max(place, vocal.phraseCredit * (phrasing[i] ?? 0));
        // The consonant allowance is spent against the DRUM CREDIT, not
        // against `1−h`.  A sibilant is a transient wherever it happens, but it
        // is only in competition with a cymbal when a cymbal was struck; on the
        // real song 51 % of the vocal's 8 kHz band was going to drums for want
        // of this distinction.
        const cue = (prior[i % bins] ?? 0)
          * belongs
          * Math.pow(repeat.novelty[i] ?? 0, vocal.noveltyWeight)
          * ((1 - p) + vocal.consonants * p);
        vocalMask[i] = remaining <= 0 ? 0
          : cue < vocal.floor ? 0 : Math.min(1, cue);
      }

      // The kit split reuses the presences the credit was built from, so the
      // classifier that decided this bin IS a drum and the one that decides
      // WHICH drum cannot disagree.
      if (kitMask) drumMasks(kitMask, kit.presence, templates, frames, bins);

      for (const kind of wanted) {
        const root = stemRoot(kind);
        // A leaf's mask is its parent's mask times its share of it, so the
        // children of a stem always sum back to that stem — and the whole set
        // still sums to one however deep it is cut.
        // 나머지 드럼 is written as 1 − 킥 rather than as the sum of the other
        // three internal parts: one subtraction cannot leave a residue, and
        // three additions of rounded floats can.
        const share = kind === 'lead' || kind === 'backing' ? voices?.lead ?? null
          : kind === 'kick' || kind === 'kit' ? kitMask?.kick ?? null
          : null;
        const invert = kind === 'backing' || kind === 'kit';
        for (let i = 0; i < frames * bins; i++) {
          const q = vocalMask[i] ?? 0;
          const p = credit[i] ?? 0;
          const lo = bassW[i] ?? 0;
          const parent = root === 'bass' ? (1 - p) * lo
            : root === 'vocals' ? (1 - (1 - p) * lo) * q
            : root === 'drums' ? (1 - q) * p
            : (1 - q) * (1 - p) * (1 - lo);
          const s = share === null ? 1 : invert ? 1 - (share[i] ?? 0) : (share[i] ?? 0);
          mask[i] = parent * s;
        }
        // Measure on the KEPT frames only — the context is analysed twice and
        // would be counted twice.
        for (let f = start - from; f < end - from; f++) {
          const base = f * bins;
          for (let b = 0; b < bins; b++) {
            const g = mask[base + b] ?? 0;
            const e = ((mag[base + b] ?? 0) * g) ** 2;
            stemEnergy.set(kind, (stemEnergy.get(kind) ?? 0) + e);
            if (g >= CONFIDENT) confidentEnergy.set(kind, (confidentEnergy.get(kind) ?? 0) + e);
          }
        }
        const keep = keptFrames(spec, start - from, end - start, start * hopSize);
        const keptMask = mask.subarray((start - from) * bins, (end - from) * bins);
        const acc = accumulators.get(`${kind}:${c}`);
        if (!acc) continue;
        acc.add(keep, keptMask, !countedThisChunk);
        countedThisChunk = true;
      }
    }
    chunkIndex++;
  }

  onProgress(1, '마무리');

  const inputEnergy = energyOf(stereo ? [left, right] : [left]);
  const stems: StemResult[] = wanted.map((kind) => {
    const out: Float32Array[] = [];
    for (let c = 0; c < outChannels; c++) {
      const key = `${kind}:${c}`;
      const acc = accumulators.get(key);
      out.push(acc ? acc.finish(denominator) : new Float32Array(length));
      // Let the accumulator go as soon as its stem exists.  Holding all eight
      // of them alive while eight output buffers are built beside them doubles
      // the peak for no reason.
      accumulators.delete(key);
    }
    const energy = energyOf(out);
    const confident = confidentEnergy.get(kind) ?? 0;
    const spectral = stemEnergy.get(kind) ?? 0;
    return {
      kind,
      channels: out,
      energyShare: inputEnergy > 0 ? energy / inputEnergy : 0,
      confidence: spectral > 0 ? confident / spectral : 0,
      peak: peakOf(out),
    };
  });

  // Only meaningful when the set covers the whole record — otherwise the
  // "residual" is just the parts nobody asked for, and reporting it as
  // reconstruction error would be a lie in the user's favour.
  const reconstructionDb = cover.missing.length === 0
    ? residualDb(stereo ? [left, right] : [left], stems)
    : Number.NaN;

  const repetitiveness = similarityChunks > 0 ? similarityTotal / similarityChunks : 0;
  const notes: string[] = [];
  if (!stereo || !centreInformative) {
    notes.push(stereo
      ? '두 채널이 같은 신호입니다 — 가운데 성분 단서를 쓸 수 없어 보컬 분리가 반복 성분에만 의존합니다'
      : '모노 파일입니다 — 가운데 성분 단서가 없어 보컬 분리가 반복 성분에만 의존합니다');
  }
  // 0.35 and not 0.75.  The old threshold was written against a figure that
  // came back as 1.00 on everything — the median over frames of the BEST of
  // eight hundred candidate matches, which is near 1 whatever the music is —
  // so the note could never fire.  What is measured now is the share of the
  // record that has a near-match nearby at all, and it sits at 0.57 to 0.65 on
  // mixes where the cue works, 0.98 on material that is self-similar by
  // construction.  The line is drawn well below the working range rather than
  // in the middle of it: this warns about a record the cue cannot help with,
  // not about a record it merely finds harder.
  if (repetitiveness < 0.35) {
    notes.push(`반복되는 부분이 적은 음악입니다 (${(repetitiveness * 100).toFixed(0)} %) — `
      + '반복 성분 단서가 반주를 걸러내지 못해 보컬에 섞일 수 있습니다');
  }
  if (wantsVoiceParts && !voicesInformative) {
    notes.push('리드와 코러스를 가를 단서가 없습니다 — 보컬이 전부 리드로 갑니다');
  }
  if (wantsDrumParts && drumOnsets === 0) {
    notes.push('드럼 타격을 하나도 찾지 못했습니다 — 킥 · 스네어 · 탐 · 심벌은 주파수만으로 나뉘었습니다');
  }
  if (wanted.includes('kit')) {
    notes.push('스네어 · 심벌 · 하이햇은 더 못 나눕니다 — 스네어 줄과 하이햇이 같은 대역의 잡음이고 거의 항상 같이 울립니다');
  }
  const vague = stems.filter((s) => s.confidence < 0.5 && s.energyShare > 0.02);
  if (vague.length > 0) {
    notes.push(`${vague.map((s) => stemLabel(s.kind)).join(' · ')} 은(는) 절반 이상이 애매한 판정입니다 — 섞여 들릴 수 있습니다`);
  }
  notes.push('신호 처리 기반 분리입니다 — 학습된 모델이 아니라서 밀도 높은 믹스에서는 한계가 있습니다');

  return {
    stems, sampleRate, length, stereo,
    centreInformative: stereo && centreInformative,
    repetitiveness, reconstructionDb, notes,
    drumOnsets,
    voicesSeparable: voicesInformative,
    elapsedMs: Date.now() - started,
  };
}

/** A view of `spec` covering only the frames this chunk is responsible for. */
function keptFrames(
  spec: HalfSpectrum, offsetFrame: number, count: number, originSample: number,
): HalfSpectrum {
  return {
    ...spec,
    data: spec.data.subarray(offsetFrame * spec.bins * 2, (offsetFrame + count) * spec.bins * 2),
    frames: count,
    originSample,
  };
}

/** How far the stems miss the input, in dB.  Measured, not assumed. */
function residualDb(input: readonly Float32Array[], stems: readonly StemResult[]): number {
  let residual = 0;
  let signal = 0;
  for (let c = 0; c < input.length; c++) {
    const source = input[c]!;
    for (let i = 0; i < source.length; i++) {
      let sum = 0;
      for (const stem of stems) sum += stem.channels[c]?.[i] ?? 0;
      const d = (source[i] ?? 0) - sum;
      residual += d * d;
      signal += (source[i] ?? 0) ** 2;
    }
  }
  if (signal <= 0) return -Infinity;
  return 10 * Math.log10(Math.max(residual, Number.MIN_VALUE) / signal);
}
