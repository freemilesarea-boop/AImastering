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
  chromagram, majorityPitchClass, type ChromaOptions, type Chromagram,
} from './chroma.js';
import {
  beatChroma, beatGrid, bassPitchesFor, segmentChords, toChordEvents,
  UNSURE_MARGIN, type ChordReadout, type SegmentOptions,
} from './chord-segment.js';
import { DEFAULT_VOCABULARY, type ChordVocabulary } from './chord-match.js';

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
  if (bass && bass.length > 0) {
    onProgress?.(0.75, '베이스 분석');
    const bassGram = chromagram(bass, sampleRate, {
      ...options.chroma,
      // The bass line is one note at a time, so suppressing its harmonics is
      // the whole job — an unsuppressed bass reads as a chord of its own.
      harmonicSuppression: 0.6,
    });
    bassPitches = bassPitchesFor(bassGram.frames, bassGram.hopSec, grid.times);
  }

  onProgress?.(0.85, '코드 매칭');
  const segments = segmentChords(spans, grid.times, {
    ...options.segment,
    vocabulary,
    ...(bassPitches ? { bassPitches } : {}),
  });

  onProgress?.(1, '완료');
  return {
    events: toChordEvents(segments),
    segments,
    grid,
    tuningCents: gram.tuningCents,
    vocabulary,
    unsure: segments.filter((s) => s.margin < UNSURE_MARGIN).length,
  };
}

/** One value per grid span, by majority over the frames inside it. */
function spanVotes(
  votes: readonly (number | null)[], hopSec: number, grid: readonly number[],
): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 0; i + 1 < grid.length; i++) {
    const from = Math.max(0, Math.ceil((grid[i] ?? 0) / hopSec));
    const to = Math.min(votes.length, Math.ceil((grid[i + 1] ?? 0) / hopSec));
    out.push(majorityPitchClass(votes.slice(from, to)));
  }
  return out;
}

/** One line for a toast: what was found, and how much to trust it. */
export function describeReadout(readout: ChordReadout): string {
  const parts = [`코드 ${readout.segments.length}개`];
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
