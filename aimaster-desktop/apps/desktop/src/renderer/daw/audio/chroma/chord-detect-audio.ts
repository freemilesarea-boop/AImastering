// Audio in, a chord chart out.
//
// This is the one function the rest of the app calls, and it is deliberately
// thin: every decision it makes lives in a module that can be tested without
// audio, and everything here is plumbing.  The order, though, is not
// arbitrary — each step exists because the one after it cannot recover from
// its absence.
//
//   1. chroma       twelve numbers per frame, tuning-corrected  (chroma.ts)
//   2. beat grid    where a chord is allowed to change          (chord-segment)
//   3. average      one vector per beat, ten times the evidence
//   4. match        the chord that explains it                  (chord-match)
//   5. collapse     runs of one label become one chord
//
// ── What is NOT here yet ────────────────────────────────────────────────────
//
// Smoothing.  Step 4 decides each beat on its own, so a beat whose chroma is
// briefly ambiguous can win a wrong label with nothing to argue against it.
// Merging in step 5 hides the shortest of those, and that is not the same as
// a model that knows chords last and that some transitions are common — which
// is the next stage.
//
// The separator.  The accuracy setting the user chose means drums are removed
// before this runs and the bass stem supplies the bass pitch classes; both
// arrive here as arguments, because a function that fetched its own stems
// could not be tested on a signal built in a test.

import {
  chromagram, majorityPitchClass, PITCH_CLASSES,
  type ChromaOptions, type Chromagram,
} from './chroma.js';
import {
  beatChroma, beatGrid, bassPitchesFor, segmentChords, toChordEvents,
  UNSURE_MARGIN, type ChordReadout, type SegmentOptions,
} from './chord-segment.js';
import { DEFAULT_VOCABULARY, type ChordVocabulary } from './chord-match.js';
import {
  keyFromChords, keyFromChroma, keyIsAmbiguous, keyName,
} from '../../model/key.js';

export interface DetectChordsOptions {
  /** How much harmony to allow.  Sevenths by default. */
  vocabulary?: ChordVocabulary;
  /**
   * The tempo, when it is known — from the detector or from the session.
   *
   * Null analyses in fixed windows and says so in the readout, which is the
   * honest answer for material the tempo detector could not read.
   */
  tempo?: { bpm: number; phaseSec: number; confidence: number } | null;
  /**
   * The bass stem, mono, at the same sample rate.
   *
   * Optional but worth a lot: Am7 and C6 are the same four notes and only the
   * bass separates them.
   */
  bass?: ArrayLike<number> | null;
  chroma?: Partial<ChromaOptions>;
  segment?: Omit<SegmentOptions, 'bassPitches' | 'vocabulary'>;
  /** Progress, 0…1, for a long file. */
  onProgress?: (fraction: number, what: string) => void;
}

/**
 * The chords in a piece of audio.
 *
 * `samples` is MONO.  Summing a stereo file is the caller's job — the two
 * channels of a real record are not the same signal, and a caller that wanted
 * to analyse one side should be able to.
 */
export function detectChordsFromAudio(
  samples: ArrayLike<number>, sampleRate: number,
  options: DetectChordsOptions = {},
): ChordReadout {
  const {
    vocabulary = DEFAULT_VOCABULARY,
    tempo = null,
    bass = null,
    onProgress,
  } = options;

  onProgress?.(0.05, '크로마 분석');
  const gram: Chromagram = chromagram(samples, sampleRate, options.chroma);
  const durationSec = samples.length / Math.max(1, sampleRate);

  onProgress?.(0.55, '비트 그리드');
  const grid = beatGrid(durationSec, tempo);

  onProgress?.(0.65, '비트별 평균');
  const spans = beatChroma(gram.frames, gram.hopSec, grid.times);

  // The bass stem gets the same treatment on the same grid, so span i of one
  // lines up with span i of the other.  A different hop here would put the
  // bass of beat 5 under the chord of beat 4.
  // Failing that, the lowest note in the MIX.  Not as good as a stem, and far
  // better than nothing: without it a measured Cmaj7–Am7–Dm7–G7 came back as
  // Cmaj7–C6–F6–G7 — the same notes, the same sound, the wrong chart.
  let bassPitches: (number | null)[] | undefined = spanVotes(
    gram.lowPitches, gram.hopSec, grid.times,
  );
  let bassIsStem = false;
  if (bass && bass.length > 0) {
    onProgress?.(0.75, '베이스 분석');
    const bassGram = chromagram(bass, sampleRate, {
      ...options.chroma,
      // The bass line is one note at a time, so suppressing its harmonics is
      // the whole job — an unsuppressed bass reads as a chord of its own.
      harmonicSuppression: 0.6,
    });
    bassPitches = bassPitchesFor(bassGram.frames, bassGram.hopSec, grid.times);
    bassIsStem = true;
  }

  // The key — in two passes, and the reason is measured.
  //
  // Estimating it from the raw chroma is the obvious single-pass route and it
  // is WEAK: 6 of 11 fixtures, because a pitch-class histogram cannot see a
  // cadence and C major and A minor contain the same seven notes.  Feeding
  // that estimate back as a prior made the chords WORSE — 85.2 % to 82.4 % —
  // which is what a prior pointed at the wrong key does.
  //
  // Chords carry the evidence a histogram lacks, and this function is in the
  // business of finding chords.  So: decode once with no key at all, read the
  // key off that unbiased chart, then decode again knowing it.  Not circular
  // — the first pass cannot have been biased by a prior it never saw.
  onProgress?.(0.8, '조성 추정');
  // `smooth: false` is the caller saying "decide each beat alone", and it has
  // to survive both passes.  Replacing it with an options object here turned
  // it silently back on — every caller that asked for the stage-B behaviour
  // quietly got stage C, which the selftest caught only because a check that
  // compares the two suddenly measured them as identical.
  const asked = options.segment?.smooth;
  const smoothWith = (
    extra: Record<string, unknown>,
  ): NonNullable<SegmentOptions['smooth']> =>
    (asked === false ? false : {
      ...(typeof asked === 'object' ? asked : {}),
      ...extra,
    });

  const keyOptions = { ...options.segment, vocabulary, bassIsStem,
    ...(bassPitches ? { bassPitches } : {}) };
  const firstPass = segmentChords(spans, grid.times, {
    ...keyOptions,
    smooth: smoothWith({ keyPrior: 0 }),
  });
  const key = firstPass.length > 0
    ? keyFromChords(firstPass.map((segment) => ({
      chord: segment.chord,
      // By how long each chord lasts, for the same reason everything else
      // here is: a bar of C and a passing F#dim7 are not one vote each.
      weight: Math.max(1e-6, segment.endSec - segment.startSec),
    })))
    : keyFromChroma(averageChroma(spans));

  onProgress?.(0.85, '코드 매칭');
  const segments = segmentChords(spans, grid.times, {
    ...options.segment,
    vocabulary,
    bassIsStem,
    smooth: smoothWith(key ? { key: key.key } : {}),
    ...(bassPitches ? { bassPitches } : {}),
  });

  onProgress?.(1, '완료');
  return {
    events: toChordEvents(segments),
    segments,
    grid,
    tuningCents: gram.tuningCents,
    vocabulary,
    key,
    unsure: segments.filter((s) => s.margin < UNSURE_MARGIN).length,
  };
}

/** The whole passage's pitch-class distribution — the fallback key evidence. */
function averageChroma(spans: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(PITCH_CLASSES);
  for (const span of spans) {
    for (let k = 0; k < PITCH_CLASSES; k++) out[k] = (out[k] ?? 0) + (span[k] ?? 0);
  }
  return out;
}

/**
 * The bass reading the MIX can support, one per grid span.
 *
 * Held to a real majority rather than a plurality.  Without that gate an
 * arpeggio — where the lowest sounding note is simply whichever chord tone
 * the pattern has reached — reports a confident bass that walks, and a
 * walking bass read as an inversion turns one chord into three labels.
 */
export const MIX_BASS_MAJORITY = 0.6;

function spanVotes(
  votes: readonly (number | null)[], hopSec: number, grid: readonly number[],
): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 0; i + 1 < grid.length; i++) {
    const from = Math.max(0, Math.ceil((grid[i] ?? 0) / hopSec));
    const to = Math.min(votes.length, Math.ceil((grid[i + 1] ?? 0) / hopSec));
    out.push(majorityPitchClass(votes.slice(from, to), MIX_BASS_MAJORITY));
  }
  return out;
}

/** One line for a toast: what was found, and how much to trust it. */
export function describeReadout(readout: ChordReadout): string {
  const parts = [`코드 ${readout.segments.length}개`];
  if (readout.key) {
    // The runner-up is named when it is close, which for a key means "the
    // relative major or minor", and that is a question a person answers in a
    // second and a histogram cannot answer at all.
    parts.push(keyIsAmbiguous(readout.key) && readout.key.alternative
      ? `${keyName(readout.key.key)} 또는 ${keyName(readout.key.alternative)}`
      : keyName(readout.key.key));
  }
  if (readout.grid.fromTempo) {
    parts.push(`${readout.grid.bpm.toFixed(1)} BPM 그리드`);
  } else {
    // Said out loud rather than hidden: without a beat grid every boundary is
    // approximate, and the user should know before they build on it.
    parts.push('비트 그리드 없음 — 고정 창');
  }
  if (Math.abs(readout.tuningCents) >= 5) {
    parts.push(`튜닝 ${readout.tuningCents > 0 ? '+' : ''}${readout.tuningCents.toFixed(0)}센트`);
  }
  if (readout.unsure > 0) parts.push(`불확실 ${readout.unsure}개`);
  return parts.join(' · ');
}
