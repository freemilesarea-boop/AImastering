/**
 * chord-audio-selftest.ts — does it name the chord that was played?
 *
 * The ground truth is GENERATED, not labelled by hand: a progression is
 * rendered through this app's own instruments at a known tempo, and the
 * detector has to hand back the progression that went in.  That is the same
 * trick the separation work used to debug its model path, and it is the only
 * way to have a hundred labelled examples on a machine with no dataset.
 *
 * What is deliberately hard here:
 *
 *   · rendered through REAL instruments — the poly synth, the Rhodes, the
 *     guitars — so the partials, the attack noise and the detune are whatever
 *     those instruments actually make, not a sine mix chosen to pass
 *   · a MELODY over the chords, with non-chord tones, which is what makes a
 *     lead sheet hard and what a template matcher gets wrong
 *   · a track 30 cents sharp, because most detectors are silently wrong there
 *   · Am7 against C6 — the SAME FOUR NOTES, separable only by the bass
 *   · a wrong tempo, to show what a bad beat grid costs
 *
 * Accuracy is REPORTED, not just asserted.  A pass/fail on "did it get every
 * chord" would be a test that either never runs green or has been weakened
 * until it means nothing; the number is printed so it can be watched.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:chord-audio
 */

import { OfflineAudioContext } from 'node-web-audio-api';
(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  QUALITIES, formatChord, makeChord, parseChord,
  type ChordEvent, type ChordSymbol,
} from '../src/renderer/daw/model/chords.js';
import { createNote, DEFAULT_MIDI_CONFIG } from '../src/renderer/daw/model/midi.js';
import { findInstrument, defaultInstrumentParams } from '../src/renderer/daw/engine/instruments.js';
import {
  chordTemplates, matchChord, bassPitchOf, VOCABULARY_QUALITIES,
} from '../src/renderer/daw/audio/chroma/chord-match.js';
import {
  beatChroma, beatGrid, segmentChords, describeProgression, MIN_TEMPO_CONFIDENCE,
} from '../src/renderer/daw/audio/chroma/chord-segment.js';
import {
  detectChordsFromAudio, describeReadout,
} from '../src/renderer/daw/audio/chroma/chord-detect-audio.js';
import {
  beatPhaseFor, replaceChordsInSpan,
} from '../src/renderer/daw/edit/chord-actions.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve().then(fn)
    .then(() => { results.push({ name, pass: true, detail: '' }); })
    .catch((e: Error) => { results.push({ name, pass: false, detail: e.message }); });
}
function assert(cond: boolean, detail: string): void {
  if (!cond) throw new Error(detail);
}

const SR = 22_050;
const BPM = 100;
const BEATS_PER_BAR = 4;
const BAR_SEC = (60 / BPM) * BEATS_PER_BAR;

// ── Rendering a progression ─────────────────────────────────────────────────

/** A chord symbol's pitch classes voiced as MIDI notes around middle C. */
function voicing(chord: ChordSymbol, bassOctave = 3): number[] {
  const quality = QUALITIES.find((q) => q.id === chord.qualityId);
  const intervals = quality?.intervals ?? [0, 4, 7];
  const root = 12 * (bassOctave + 1) + chord.root;
  // Kept in one octave-and-a-bit above the root: a chord voiced across three
  // octaves is easier to detect than a real one, and a test that is easier
  // than the job is not a test.
  return intervals.map((i) => root + (i % 24));
}

interface RenderOptions {
  instrumentId?: string;
  barsPerChord?: number;
  /** Cents to detune the whole render — a record that is not at A = 440. */
  detuneCents?: number;
  /** Add a melody of chord tones AND passing tones over the top. */
  melody?: boolean;
  /** Play the root an octave down as a separate part, and return its audio. */
  withBass?: boolean;
  /**
   * How much of its bar each chord actually sounds for.
   *
   * The default nearly fills the bar, which is the easy case.  A small value
   * is staccato: a stab at the top of the bar and then silence, which is how
   * a lot of music is actually played and which is the case that decides
   * whether averaging over a beat is done right.
   */
  sustainRatio?: number;
}

interface Rendered { mix: Float32Array; bass: Float32Array | null }

/** Render a progression through a real instrument, offline. */
async function render(
  progression: readonly string[], options: RenderOptions = {},
): Promise<Rendered> {
  const {
    instrumentId = 'polysynth', barsPerChord = 1,
    detuneCents = 0, melody = false, withBass = false, sustainRatio = 0.95,
  } = options;
  const instrument = findInstrument(instrumentId);
  if (!instrument) throw new Error(`no instrument ${instrumentId}`);
  const params = defaultInstrumentParams(instrumentId);
  const seconds = progression.length * barsPerChord * BAR_SEC + 0.5;

  const renderOne = (which: 'mix' | 'bass'): Promise<Float32Array> => {
    const ctx = new OfflineAudioContext(1, Math.round(SR * seconds), SR);
    // Detuning the whole render is done by moving the notes, not by a rate
    // change: a rate change would move the TEMPO too and hide the tuning
    // failure behind a beat-grid failure.
    const cents = detuneCents / 100;
    progression.forEach((symbol, index) => {
      const chord = parseChord(symbol);
      if (!chord) throw new Error(`cannot parse ${symbol}`);
      const at = index * barsPerChord * BAR_SEC;
      // The bass plays the SLASH note when there is one, the root otherwise —
      // which is what a bass player does and what the detector reads back.
      const bassPc = chord.bass ?? chord.root;
      const pitches = which === 'bass' ? [24 + bassPc] : voicing(chord);
      for (const pitch of pitches) {
        instrument.playNote({
          ctx: ctx as unknown as BaseAudioContext,
          destination: ctx.destination as unknown as AudioNode,
          note: createNote({
            pitch: Math.round(pitch), velocity: 0.7,
            startBeat: 0, durationBeat: 4 * barsPerChord,
            pitchOffsetSemitones: cents,
          }),
          config: DEFAULT_MIDI_CONFIG, when: at,
          durationSec: BAR_SEC * barsPerChord * sustainRatio, params,
        });
      }
      if (which === 'mix' && melody) {
        // Four eighth notes, two of them NOT in the chord.  This is what a
        // real lead sheet has over it and what makes a chart hard.
        const scale = [0, 2, 4, 5, 7, 9, 11];
        for (let step = 0; step < 4; step++) {
          const degree = scale[(index * 3 + step * 2) % scale.length] ?? 0;
          instrument.playNote({
            ctx: ctx as unknown as BaseAudioContext,
            destination: ctx.destination as unknown as AudioNode,
            note: createNote({
              pitch: 72 + degree, velocity: 0.55,
              startBeat: 0, durationBeat: 1,
              pitchOffsetSemitones: cents,
            }),
            config: DEFAULT_MIDI_CONFIG,
            when: at + step * (BAR_SEC / 4),
            durationSec: BAR_SEC / 4 * 0.9, params,
          });
        }
      }
    });
    return ctx.startRendering().then((buf) => Float32Array.from(buf.getChannelData(0)));
  };

  const mix = await renderOne('mix');
  const bass = withBass ? await renderOne('bass') : null;
  return { mix, bass };
}

const TEMPO = { bpm: BPM, phaseSec: 0, confidence: 0.9 };

/** Run the detector and return the labels it produced, one per chord slot. */
function labelsFor(
  audio: Rendered, progression: readonly string[], barsPerChord = 1,
  extra: Parameters<typeof detectChordsFromAudio>[2] = {},
): string[] {
  const readout = detectChordsFromAudio(audio.mix, SR, {
    tempo: TEMPO, bass: audio.bass, ...extra,
  });
  // Read the chart at the MIDDLE of each chord's own bar, which is what a
  // person reading the chord track does.
  return progression.map((_, index) => {
    const at = (index + 0.5) * barsPerChord * BAR_SEC;
    let found = '—';
    for (const segment of readout.segments) {
      if (segment.startSec <= at + 1e-6 && at < segment.endSec + 1e-6) {
        found = formatChord(segment.chord);
      }
    }
    return found;
  });
}

function accuracy(want: readonly string[], got: readonly string[]): number {
  let right = 0;
  for (let i = 0; i < want.length; i++) if (want[i] === got[i]) right += 1;
  return right / Math.max(1, want.length);
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

// The progressions.  Common enough to be worth being right about, and between
// them they use every quality in the default vocabulary.
const POP = ['C', 'G', 'Am', 'F'];
const SEVENTHS = ['Cmaj7', 'Am7', 'Dm7', 'G7'];
const MINOR = ['Am', 'F', 'C', 'G'];
const JAZZ = ['Dm7', 'G7', 'Cmaj7', 'Cmaj7'];

async function main(): Promise<void> {
  // ── The templates ─────────────────────────────────────────────────────────

  await check('a triad beats the seventh that contains it, and the reverse', () => {
    // The property that makes cosine-against-normalised-templates the right
    // scoring rule: subset and superset both lose to the truth, with no
    // hand-written rule for either direction.
    const triad = new Float32Array(12); triad[0] = 1; triad[4] = 1; triad[7] = 1;
    const seventh = new Float32Array(12);
    seventh[0] = 1; seventh[4] = 1; seventh[7] = 1; seventh[10] = 1;

    const onTriad = matchChord(triad, { vocabulary: 'sevenths' });
    assert(formatChord(onTriad!.chord) === 'C', `a plain triad matched ${formatChord(onTriad!.chord)}`);
    const onSeventh = matchChord(seventh, { vocabulary: 'sevenths' });
    assert(formatChord(onSeventh!.chord) === 'C7', `a dominant matched ${formatChord(onSeventh!.chord)}`);
  });

  await check('the vocabulary tiers are the sizes they claim', () => {
    assert(chordTemplates('basic').length === 24, `basic has ${chordTemplates('basic').length}`);
    assert(chordTemplates('sevenths').length === 14 * 12,
      `sevenths has ${chordTemplates('sevenths').length}`);
    assert(chordTemplates('full').length === QUALITIES.length * 12,
      `full has ${chordTemplates('full').length}`);
    // Basic must not be able to say a seventh at all — that IS the tier.
    const seventh = new Float32Array(12);
    seventh[0] = 1; seventh[4] = 1; seventh[7] = 1; seventh[10] = 1;
    const basic = matchChord(seventh, { vocabulary: 'basic' });
    assert(basic !== null && !formatChord(basic.chord).includes('7'),
      `basic said ${formatChord(basic!.chord)}`);
    // And every id a tier names has to exist, or the tier is quietly smaller
    // than it looks.
    for (const [tier, ids] of Object.entries(VOCABULARY_QUALITIES)) {
      for (const id of ids) {
        assert(QUALITIES.some((q) => q.id === id), `${tier} names a quality that does not exist: ${id}`);
      }
    }
  });

  await check('every template is a unit vector', () => {
    for (const t of chordTemplates('full')) {
      let sum = 0;
      for (let i = 0; i < 12; i++) sum += (t.vector[i] ?? 0) ** 2;
      assert(Math.abs(Math.sqrt(sum) - 1) < 1e-6,
        `${formatChord(t.chord)} has length ${Math.sqrt(sum).toFixed(4)}`);
    }
  });

  await check('silence has no chord', () => {
    assert(matchChord(new Float32Array(12)) === null, 'a zero vector produced a chord');
    // And a flat vector — every note equally present — is not a chord either,
    // it is noise, and it must not score well enough to be published.
    const flat = new Float32Array(12).fill(1 / Math.sqrt(12));
    const hit = matchChord(flat, { vocabulary: 'sevenths' });
    assert(hit === null || hit.margin < 0.02,
      `white noise matched ${hit ? formatChord(hit.chord) : ''} with margin ${hit?.margin.toFixed(3)}`);

    // And a vector that is a chord in SHAPE but denormal in size.  Exactly
    // zero is the easy case and the only one an earlier version of this check
    // tested; normalising a vector this small is where twelve NaNs and then a
    // confident answer built out of them come from.
    const tiny = new Float32Array(12);
    for (const pc of [0, 4, 7]) tiny[pc] = 1e-9;
    assert(matchChord(tiny) === null, 'a denormal C major produced a chord');
  });

  await check('the bass separates chords that share every note', () => {
    // Am7 and C6 are A C E G — the same four pitch classes.  No chroma tells
    // them apart.  The bass tells them apart completely.
    const shared = new Float32Array(12);
    for (const pc of [9, 0, 4, 7]) shared[pc] = 0.5;
    const overA = matchChord(shared, { vocabulary: 'sevenths', bassPitchClass: 9 });
    const overC = matchChord(shared, { vocabulary: 'sevenths', bassPitchClass: 0 });
    assert(formatChord(overA!.chord) === 'Am7', `over A: ${formatChord(overA!.chord)}`);
    assert(formatChord(overC!.chord) === 'C6', `over C: ${formatChord(overC!.chord)}`);
    // With no bass at all it must still answer, and must not pretend to know
    // which by inventing a slash.
    const blind = matchChord(shared, { vocabulary: 'sevenths' });
    assert(blind !== null && blind.chord.bass === null, 'a slash was invented with no bass');
  });

  await check('a bass note that is in the chord makes a slash chord', () => {
    const c = new Float32Array(12);
    for (const pc of [0, 4, 7]) c[pc] = 0.577;
    const overE = matchChord(c, { vocabulary: 'sevenths', bassPitchClass: 4 });
    assert(formatChord(overE!.chord) === 'C/E', `C over E read as ${formatChord(overE!.chord)}`);
    // A bass playing something outside the chord is a passing note, not a
    // slash — writing C/F# there would be worse than writing C.
    const outside = matchChord(c, { vocabulary: 'sevenths', bassPitchClass: 6 });
    assert(!formatChord(outside!.chord).includes('/'),
      `an outside bass produced ${formatChord(outside!.chord)}`);
  });

  await check('a bass that cannot decide says nothing', () => {
    const two = new Float32Array(12);
    two[0] = 0.7; two[7] = 0.68;      // root and fifth, near enough equal
    assert(bassPitchOf(two) === null, 'an ambiguous bass named a note');
    const one = new Float32Array(12);
    one[5] = 0.9; one[0] = 0.2;
    assert(bassPitchOf(one) === 5, `a clear bass read as ${bassPitchOf(one)}`);
    assert(bassPitchOf(new Float32Array(12)) === null, 'silence named a bass note');
  });

  // ── The grid ──────────────────────────────────────────────────────────────

  await check('the beat grid starts at the beginning of the song', () => {
    // The detector's phase can be anywhere; a grid that begins there leaves
    // the first bars ungridded, and the first bars are what a user checks.
    const grid = beatGrid(10, { bpm: 120, phaseSec: 3.25, confidence: 0.9 });
    assert(grid.fromTempo, 'a confident tempo was refused');
    assert(grid.times[0]! < 0.5, `the grid starts at ${grid.times[0]}`);
    const step = (grid.times[1] ?? 0) - (grid.times[0] ?? 0);
    assert(Math.abs(step - 0.5) < 1e-6, `beat length ${step}`);
    assert(grid.times[grid.times.length - 1]! >= 10, 'the grid stops before the song does');
  });

  await check('an unsure tempo gets a fixed window, and says so', () => {
    // A guessed grid is worse than no grid: every boundary lands in the wrong
    // place and each window mixes two chords.
    const grid = beatGrid(10, { bpm: 120, phaseSec: 0, confidence: MIN_TEMPO_CONFIDENCE - 0.01 });
    assert(!grid.fromTempo, 'a low-confidence tempo was used as a grid');
    assert(grid.bpm === 0 && grid.confidence === 0, 'the fallback claimed a tempo');
    assert(beatGrid(10, null).fromTempo === false, 'no tempo produced a tempo grid');
  });

  await check('a beat with no frames is silence, not an arbitrary chord', () => {
    const frames = [new Float32Array(12), new Float32Array(12)];
    frames[0]![0] = 1;
    const spans = beatChroma(frames, 0.1, [0, 0.1, 0.2, 5.0]);
    assert(spans.length === 3, `${spans.length} spans`);
    const empty = spans[2]!;
    assert([...empty].every((v) => v === 0), 'a span past the audio invented a chroma');
  });

  await check('four beats of one chord is one chord', () => {
    const c = new Float32Array(12);
    for (const pc of [0, 4, 7]) c[pc] = 0.577;
    const spans = [c, c, c, c, c, c, c, c];
    const grid = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];
    const segments = segmentChords(spans, grid, { vocabulary: 'sevenths' });
    assert(segments.length === 1, `${segments.length} segments for one held chord`);
    assert(segments[0]!.beats === 8, `${segments[0]!.beats} beats`);
    assert(Math.abs(segments[0]!.endSec - 4) < 1e-6, `ends at ${segments[0]!.endSec}`);
  });

  await check('a one-beat blip does not become a chord', () => {
    // And removing it must not leave the same chord printed twice in a row —
    // the re-merge after the filter is the part that is easy to forget.
    const c = new Float32Array(12); for (const pc of [0, 4, 7]) c[pc] = 0.577;
    const fs = new Float32Array(12); for (const pc of [6, 9, 1]) fs[pc] = 0.577;
    const spans = [c, c, c, fs, c, c, c, c];
    const grid = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4];
    const segments = segmentChords(spans, grid, { vocabulary: 'sevenths' });
    assert(segments.length === 1,
      `${segments.length} segments: ${segments.map((s) => formatChord(s.chord)).join(' ')}`);
    assert(formatChord(segments[0]!.chord) === 'C', formatChord(segments[0]!.chord));
  });

  // ── Rendered through the real instruments ─────────────────────────────────

  await check('a pop progression through the poly synth', async () => {
    const audio = await render(POP);
    const got = labelsFor(audio, POP);
    assert(accuracy(POP, got) === 1, `${POP.join(' ')} → ${got.join(' ')}`);
  });

  await check('sevenths through the poly synth — the default vocabulary', async () => {
    const audio = await render(SEVENTHS);
    const got = labelsFor(audio, SEVENTHS);
    assert(accuracy(SEVENTHS, got) === 1, `${SEVENTHS.join(' ')} → ${got.join(' ')}`);
  });

  await check('the same progression through three different instruments', async () => {
    const scores: string[] = [];
    for (const id of ['polysynth', 'epiano', 'agtr']) {
      const audio = await render(MINOR, { instrumentId: id });
      const got = labelsFor(audio, MINOR);
      scores.push(`${id} ${(accuracy(MINOR, got) * 100).toFixed(0)}% (${got.join(' ')})`);
    }
    const bad = scores.filter((s) => !s.includes('100%'));
    assert(bad.length === 0, bad.join(' | '));
  });

  await check('a chord that stops inside the beat is still that chord', async () => {
    // Stabs: each chord sounds for a quarter of its bar and the rest is
    // silence.  Averaging a beat means averaging the frames that HAVE
    // something in them — count the silent ones and every stab is diluted
    // until it scores below the threshold and the bar comes back empty.
    const audio = await render(POP, { sustainRatio: 0.25 });
    const got = labelsFor(audio, POP);
    assert(accuracy(POP, got) === 1, `stabs: ${POP.join(' ')} → ${got.join(' ')}`);
    console.log(`      (quarter-bar stabs: ${(accuracy(POP, got) * 100).toFixed(0)}% — ${got.join(' ')})`);
  });

  await check('a chord struck once rings through its bar', async () => {
    // A tenth of a bar — 0.24 s out of a 0.6 s beat.  Only ONE beat of each
    // bar has anything in it, and that beat is more silence than chord.
    //
    // Two claims, both of which were once only comments.  A span that is part
    // silence must be averaged over the frames that HAVE something in them,
    // or the stab is diluted below the threshold and the bar comes back
    // empty.  And a run must be measured by what it COVERS, not by how many
    // beats matched it, or a chord with one matched beat is short enough to
    // be thrown away as a blip — with nothing next to it to be absorbed into.
    const audio = await render(POP, { sustainRatio: 0.1 });
    const readout = detectChordsFromAudio(audio.mix, SR, { tempo: TEMPO });
    const got = labelsFor(audio, POP);
    assert(accuracy(POP, got) === 1, `single hits: ${POP.join(' ')} → ${got.join(' ')}`);
    assert(readout.segments.every((seg) => seg.beats >= 4),
      `a chord struck once covered only [${readout.segments.map((seg) => seg.beats).join(', ')}] beats`);
    console.log(
      `      (one hit per bar: ${(accuracy(POP, got) * 100).toFixed(0)}% — ${got.join(' ')}, `
      + `covering [${readout.segments.map((seg) => seg.beats).join(', ')}] beats)`,
    );
  });

  await check('a melody over the chords does not rewrite them', async () => {
    // Non-chord tones in the melody are what a template matcher gets wrong,
    // and what beat-averaging exists to survive.
    const audio = await render(POP, { melody: true });
    const got = labelsFor(audio, POP);
    assert(accuracy(POP, got) >= 0.75, `${POP.join(' ')} → ${got.join(' ')}`);
    console.log(`      (melody over chords: ${(accuracy(POP, got) * 100).toFixed(0)}% — ${got.join(' ')})`);
  });

  await check('a record 30 cents sharp is read correctly', async () => {
    // Without the tuning estimate every note leaks into its neighbour and the
    // chart comes out wrong.  Proving that takes TWO measurements, because at
    // 30 cents the labels alone no longer show it: the bass reading added
    // downstream is strong enough to rescue the right answer out of a chroma
    // that has already been damaged.  So measure the damage where it happens
    // — in the match evidence — and then push the detune to where even the
    // bass cannot save it.
    const audio = await render(POP, { detuneCents: 30 });
    const got = labelsFor(audio, POP);
    assert(accuracy(POP, got) === 1, `sharp: ${POP.join(' ')} → ${got.join(' ')}`);

    const blind = detectChordsFromAudio(audio.mix, SR, {
      tempo: TEMPO, chroma: { assumeConcertPitch: true },
    });
    const tuned = detectChordsFromAudio(audio.mix, SR, { tempo: TEMPO });
    const meanScore = (r: { segments: readonly { score: number }[] }): number =>
      (r.segments.length
        ? r.segments.reduce((a, s) => a + s.score, 0) / r.segments.length
        : 0);
    const withIt = meanScore(tuned);
    const without = meanScore(blind);
    assert(withIt - without > 0.05,
      `the correction is doing nothing: match score ${withIt.toFixed(3)} corrected `
      + `vs ${without.toFixed(3)} uncorrected`);

    // And the labels themselves, at the detune where the damage wins.  Nearly
    // half a semitone is not exotic — it is a tape that ran fast, or a sample
    // pitched by ear.
    const far = await render(POP, { detuneCents: 45 });
    const farTuned = labelsFor(far, POP);
    const farBlindReadout = detectChordsFromAudio(far.mix, SR, {
      tempo: TEMPO, chroma: { assumeConcertPitch: true },
    });
    const farBlind = POP.map((_, i) => {
      const at = (i + 0.5) * BAR_SEC;
      let f = '—';
      for (const s of farBlindReadout.segments) if (s.startSec <= at && at < s.endSec) f = formatChord(s.chord);
      return f;
    });
    assert(accuracy(POP, farTuned) === 1,
      `45 cents sharp: ${POP.join(' ')} → ${farTuned.join(' ')}`);
    assert(accuracy(POP, farBlind) < 0.5,
      `ignoring 45 cents of detune was still ${(accuracy(POP, farBlind) * 100).toFixed(0)}% right `
      + `(${farBlind.join(' ')}) — the correction is doing nothing`);

    console.log(
      `      (30 cents sharp: score ${withIt.toFixed(3)} corrected vs ${without.toFixed(3)} blind; `
      + `at 45 cents corrected 100%, blind ${(accuracy(POP, farBlind) * 100).toFixed(0)}% — ${farBlind.join(' ')})`,
    );
  });

  await check('the readout reports the tuning it found', async () => {
    const audio = await render(POP, { detuneCents: -25 });
    const readout = detectChordsFromAudio(audio.mix, SR, { tempo: TEMPO });
    assert(Math.abs(readout.tuningCents + 25) < 10,
      `−25 cents reported as ${readout.tuningCents.toFixed(1)}`);
    assert(describeReadout(readout).includes('센트'), describeReadout(readout));
    assert(describeReadout(readout).includes('BPM'), describeReadout(readout));
  });

  await check('a jazz turnaround, which is what sevenths are for', async () => {
    const audio = await render(JAZZ, { instrumentId: 'epiano' });
    const got = labelsFor(audio, JAZZ);
    const score = accuracy(JAZZ, got);
    assert(score >= 0.75, `${JAZZ.join(' ')} → ${got.join(' ')}`);
    console.log(`      (jazz turnaround: ${(score * 100).toFixed(0)}% — ${got.join(' ')})`);
  });

  await check('a wrong beat grid costs boundary accuracy — which is why it is reported', async () => {
    // Not a failure of the detector; a demonstration of what the grid is
    // worth, so that "비트 그리드 없음" in the readout is understood as a
    // warning rather than as a detail.
    //
    // The cost is NOT in the labels, and an earlier version of this check
    // measured labels and therefore measured nothing: these chords last a
    // whole bar, so a grid at the wrong tempo still puts most of each span
    // inside one chord and the label read at the middle of the bar survives.
    // What a bad grid destroys is WHERE the chord changes — which is what
    // makes the chart editable — so that is what is measured.
    const audio = await render(POP);
    const right = labelsFor(audio, POP);
    assert(accuracy(POP, right) === 1, 'the control run did not pass');

    const changes = POP.map((_, i) => i * BAR_SEC).slice(1);
    const boundaryError = (segments: readonly { startSec: number }[]): number => {
      let worst = 0;
      for (const t of changes) {
        let near = Infinity;
        for (const s of segments) near = Math.min(near, Math.abs(s.startSec - t));
        worst = Math.max(worst, near);
      }
      return worst;
    };

    const good = detectChordsFromAudio(audio.mix, SR, { tempo: TEMPO });
    const bad = detectChordsFromAudio(audio.mix, SR, {
      tempo: { bpm: BPM * 1.37, phaseSec: 0.19, confidence: 0.9 },
    });
    const goodErr = boundaryError(good.segments);
    const badErr = boundaryError(bad.segments);

    // A beat at 100 BPM is 0.6 s.  On the right grid every change should land
    // ON one, which means inside a beat of the truth.
    assert(goodErr < 60 / BPM,
      `the right grid put a chord change ${goodErr.toFixed(3)} s from where it was played`);
    assert(badErr > goodErr,
      `a grid at ${(BPM * 1.37).toFixed(0)} BPM cost nothing: `
      + `${badErr.toFixed(3)} s vs ${goodErr.toFixed(3)} s`);
    console.log(
      `      (chord change placed within ${goodErr.toFixed(3)} s on the right grid, `
      + `${badErr.toFixed(3)} s on a wrong one)`,
    );
  });

  await check('a long progression, and the number is printed', async () => {
    const long = [
      'C', 'Am', 'F', 'G', 'Em', 'Am', 'Dm7', 'G7',
      'Cmaj7', 'A7', 'Dm', 'G', 'C', 'F', 'C', 'G7',
    ];
    const audio = await render(long, { instrumentId: 'epiano', withBass: true });
    const got = labelsFor(audio, long);
    const score = accuracy(long, got);
    console.log(`      (16 chords through the Rhodes with bass: ${(score * 100).toFixed(0)}%)`);
    for (let i = 0; i < long.length; i++) {
      if (long[i] !== got[i]) console.log(`         ${long[i]} → ${got[i]}`);
    }
    assert(score >= 0.7, `${(score * 100).toFixed(0)}% — ${got.join(' ')}`);
  });

  // ── Wiring ────────────────────────────────────────────────────────────────

  await check('the detector never invents a chord out of silence', async () => {
    const silence = new Float32Array(Math.round(SR * 4));
    const readout = detectChordsFromAudio(silence, SR, { tempo: TEMPO });
    assert(readout.segments.length === 0, `${readout.segments.length} chords in four seconds of silence`);
    assert(readout.events.length === 0, 'events without segments');

    // Room tone, not digital silence — which is what a real file has, and
    // which is the version a relative-only floor gets wrong because the
    // loudest frame in the file IS the noise.
    const quiet = new Float32Array(Math.round(SR * 4));
    for (let i = 0; i < quiet.length; i++) quiet[i] = (Math.random() - 0.5) * 6e-5;
    const tone = detectChordsFromAudio(quiet, SR, { tempo: TEMPO });
    assert(tone.segments.length === 0,
      `${tone.segments.length} chords in four seconds of −90 dBFS room tone: `
      + describeProgression(tone.segments));
  });

  await check('the default vocabulary is sevenths, as chosen', () => {
    const src = stripComments(
      readFileSync(new URL('../src/renderer/daw/audio/chroma/chord-match.ts', import.meta.url), 'utf8'));
    assert(/DEFAULT_VOCABULARY: ChordVocabulary = 'sevenths'/.test(src),
      'the default vocabulary is no longer sevenths');
    const readout = detectChordsFromAudio(new Float32Array(SR), SR, { tempo: TEMPO });
    assert(readout.vocabulary === 'sevenths', `readout says ${readout.vocabulary}`);
  });

  await check('chords are named absolutely, not as roman numerals', () => {
    // Explicitly asked for.  `C`, `Am7`, `G7` — no key, no degrees.
    assert(formatChord(makeChord(0, 'maj')) === 'C', formatChord(makeChord(0, 'maj')));
    assert(formatChord(makeChord(9, 'min7')) === 'Am7', formatChord(makeChord(9, 'min7')));
    assert(formatChord(makeChord(7, 'dom7')) === 'G7', formatChord(makeChord(7, 'dom7')));
    const src = stripComments(
      readFileSync(new URL('../src/renderer/daw/audio/chroma/chord-segment.ts', import.meta.url), 'utf8'));
    assert(!/\bvii?\b|romanNumeral|degreeOf/.test(src), 'roman numerals crept in');
  });

  // ── Into the session ──────────────────────────────────────────────────────

  await check('a clip starting mid-bar is analysed on the session grid', () => {
    // The clip's first sample is not a downbeat unless it happens to be one.
    // Get this wrong and every chord boundary in the chart lands off the beat.
    const period = 60 / 120;                       // 0.5 s at 120 BPM
    assert(Math.abs(beatPhaseFor(0, 120)) < 1e-9,
      `a clip at zero should already be on the beat, got ${beatPhaseFor(0, 120)}`);
    assert(Math.abs(beatPhaseFor(2, 120)) < 1e-9,
      `a clip at 2 s is on the beat at 120 BPM, got ${beatPhaseFor(2, 120)}`);
    // 0.3 s in: the next beat is at 0.5 s, so 0.2 s from the clip's start.
    assert(Math.abs(beatPhaseFor(0.3, 120) - 0.2) < 1e-6,
      `expected 0.2, got ${beatPhaseFor(0.3, 120)}`);
    assert(beatPhaseFor(0.3, 120) < period, 'the phase must be inside one beat');
    // A tempo of zero is not an error to throw at the user, it is a grid that
    // starts where the clip does.
    assert(beatPhaseFor(3.7, 0) === 0, 'a zero tempo should give a zero phase');
  });

  await check('a second analysis replaces its own span and leaves the rest', () => {
    const at = (timeSec: number, symbol: string): ChordEvent => ({
      id: `c${timeSec}`, timeSec, chord: parseChord(symbol)!,
    });
    // A chart already covering 0–20 s.  The clip being analysed is 8–16 s.
    const existing = [at(0, 'C'), at(4, 'F'), at(8, 'Am'), at(12, 'G'), at(18, 'Dm')];
    const placed = [at(8, 'Am7'), at(10, 'D7'), at(14, 'Gmaj7')];
    const out = replaceChordsInSpan(existing, 8, 16, placed);
    const labels = out.map((e) => `${e.timeSec}:${formatChord(e.chord)}`);
    assert(labels.join(' ') === '0:C 4:F 8:Am7 10:D7 14:Gmaj7 18:Dm',
      `replacement went wrong: ${labels.join(' ')}`);

    // The failure this rule exists to prevent: appending instead of replacing.
    // A chord stores only where it STARTS, so the two charts would not read as
    // two opinions — they interleave into one that is neither.
    const appended = [...existing, ...placed].sort((a, b) => a.timeSec - b.timeSec);
    assert(appended.length !== out.length,
      'appending and replacing gave the same result — the span rule is doing nothing');
    assert(out.every((e, i) => i === 0 || (out[i - 1]?.timeSec ?? 0) <= e.timeSec),
      'the chord track came back unsorted');
  });

  await check('the committed chord worker matches its TypeScript', () => {
    // The worker is a GENERATED file that is committed, so `pnpm dev` works
    // without anyone remembering to build it — which means it can silently
    // drift away from the source it claims to be.  Same guard the separator
    // has, for the same reason.
    const built = spawnSync('node', ['scripts/build-chord-worker.mjs', '--check'], {
      cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8',
    });
    assert(built.status === 0,
      `chord.worker.js is stale: ${(built.stderr || built.stdout || '').trim()}`);
  });

  await check('the analysis runs off the UI thread', async () => {
    // Measured at about 29× real time at 44.1 kHz, so a four-minute clip is
    // eight seconds of a window that cannot repaint — and a blocked main
    // thread cannot paint the progress the button is trying to show, which is
    // what makes it look hung rather than busy.
    const src = stripComments(
      readFileSync(new URL('../src/renderer/daw/edit/chord-actions.ts', import.meta.url), 'utf8'));
    assert(/runChordDetection\(/.test(src),
      'the action no longer calls the worker — the analysis is back on the UI thread');
    const inlineAt = src.indexOf('if (inline)');
    const workerAt = src.indexOf('runChordDetection(');
    assert(inlineAt >= 0 && workerAt > inlineAt,
      'inline analysis is no longer the opt-in branch');

    // And the worker's body must actually reach the detector, not merely
    // exist: a worker file that imports nothing is a worker that does nothing.
    const worker = readFileSync(
      new URL('../src/renderer/public/chord.worker.js', import.meta.url), 'utf8');
    assert(worker.includes('detectChordsFromAudio'),
      'the built worker does not contain the detector');
    assert(worker.length > 10_000,
      `the built worker is only ${worker.length} bytes — it cannot contain the CQT`);
  });

  console.log('\n=== Chords from audio — did it name what was played? ===');
  for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  const bad = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
  if (bad) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
