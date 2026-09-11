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
  smoothChords, DEFAULT_SIZE_PENALTY,
} from '../src/renderer/daw/audio/chroma/chord-hmm.js';
import { chromagram, majorityPitchClass } from '../src/renderer/daw/audio/chroma/chroma.js';
import {
  formatHarteLabel, formatLab, parseHarteLabel, parseLab, scoreChords,
  segmentsToSpans, SCORE_TIERS, type LabSpan,
} from '../src/renderer/daw/audio/chroma/chord-lab.js';
import { writeWav24 } from './lib/wav-codec.js';
import { describeGrid } from './lib/grid-label.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectChordsFromAudio, describeReadout, MIX_BASS_MAJORITY,
} from '../src/renderer/daw/audio/chroma/chord-detect-audio.js';
import {
  beatPhaseFor, chordEventsFor, replaceChordsInSpan,
} from '../src/renderer/daw/edit/chord-actions.js';
import {
  describeChordBlock, isUnsure, nextUnsureAfter, unsureChords, UNSURE_MARGIN,
} from '../src/renderer/daw/edit/chord-confidence.js';
import {
  setChord, setCapo, moveChord, transposeChords, transposeChordTrack, withChords as _wc2,
} from '../src/renderer/daw/edit/chord-edit.js';
import {
  capoOptions, isOpenShape, shapeFor, suggestCapo, MAX_CAPO_FRET,
} from '../src/renderer/daw/model/capo.js';
import {
  formatChordIn, keyNameIn, keyUsesFlats, spellPitchClass,
} from '../src/renderer/daw/model/key.js';
import { transposeChord } from '../src/renderer/daw/model/chords.js';
import {
  voiceLead, voiceDistance, totalMovement, voicingCandidates, DEFAULT_VOICING,
} from '../src/renderer/daw/model/chord-voicing.js';
import {
  backingNotes, BACKING_STYLES, backingInstrumentFor, generateBackingPart,
  type BackingSpan,
} from '../src/renderer/daw/edit/chord-parts.js';
import { withChords } from '../src/renderer/daw/edit/chord-edit.js';
import { createSession } from '../src/renderer/daw/model/session-ops.js';
import { voiceChord } from '../src/renderer/daw/model/chords.js';
import { to7bit } from '../src/renderer/daw/model/midi.js';
import {
  keyFromChords, keyFromChroma, keyIsAmbiguous, keyName, keyPitchClasses,
  KEY_AMBIGUOUS_MARGIN, MAJOR_ID, MINOR_ID, type KeyChord,
} from '../src/renderer/daw/model/key.js';
import { DEFAULT_KEY_PRIOR } from '../src/renderer/daw/audio/chroma/chord-hmm.js';

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

const PITCH_CLASS_COUNT = 12;

/**
 * A melody: chord tones on the strong eighths, passing tones between them.
 *
 * Eight eighth notes in the octave above the chord.  EVERY off-beat note is
 * outside the chord — that is the point of the fixture — but they are passing
 * notes, chromatic or scalar, that do not stack with the chord into anything.
 *
 * That last clause is the whole finding, and it was measured, not assumed.
 * See `thirdsBar`.
 */
function melodyBar(chord: ChordSymbol, bar: number): number[] {
  const quality = QUALITIES.find((q) => q.id === chord.qualityId);
  const intervals = quality?.intervals ?? [0, 4, 7];
  const tones = intervals.map((i) => 72 + ((chord.root + i) % PITCH_CLASS_COUNT));
  // A different contour each bar, so the line moves instead of repeating.
  const shapes = [[0, 1, 2, 1], [2, 1, 0, 1], [0, 2, 1, 2], [1, 2, 1, 0]];
  const shape = shapes[bar % shapes.length] ?? [0, 1, 2, 1];
  const strong = shape.map((i) => tones[i % tones.length] ?? 72);
  const out: number[] = [];
  for (let step = 0; step < strong.length; step++) {
    const here = strong[step] ?? 72;
    const next = strong[(step + 1) % strong.length] ?? 72;
    out.push(here);
    // Step toward the next chord tone: a passing note when they are apart, a
    // chromatic neighbour when they are the same.
    const gap = next - here;
    out.push(here + (gap === 0 ? 1 : Math.sign(gap) * (Math.abs(gap) > 2 ? 2 : 1)));
  }
  return out;
}

/**
 * The melody this fixture used to have — and why it is no longer the melody.
 *
 * `scale[(bar * 3 + step * 2) % 7]`: scale degrees stacked in THIRDS.  Over
 * C that spells C E G B, so the only note outside the triad is the major
 * seventh and the bar's entire pitch content is a Cmaj7.  Over G it spells
 * F A C E, and the bar then contains all seven notes of the key.
 *
 * Scored against the written chart that read 0 %, and it was recorded as the
 * one place smoothing made things worse.  It was not: the detector answered
 * Cmaj7 to a bar that contains exactly the notes of Cmaj7 and nothing else.
 * A test that asks for an answer the audio contradicts is not a test.
 *
 * It is kept, because genuinely ambiguous material is worth having — but what
 * is asserted about it is now something true: every chord it names has to be
 * notes that are actually sounding.
 */
function thirdsBar(bar: number): number[] {
  const scale = [0, 2, 4, 5, 7, 9, 11];
  const out: number[] = [];
  for (let step = 0; step < 4; step++) {
    out.push(72 + (scale[(bar * 3 + step * 2) % scale.length] ?? 0));
  }
  return out;
}

/** The pitch classes a chord symbol actually contains. */
function pitchClassesOf(symbol: string): Set<number> {
  const chord = parseChord(symbol);
  if (!chord) return new Set();
  const quality = QUALITIES.find((q) => q.id === chord.qualityId);
  const intervals = quality?.intervals ?? [0, 4, 7];
  const out = new Set<number>();
  for (const i of intervals) out.add((chord.root + i) % PITCH_CLASS_COUNT);
  if (chord.bass !== undefined && chord.bass !== null) out.add(chord.bass % PITCH_CLASS_COUNT);
  return out;
}

interface RenderOptions {
  instrumentId?: string;
  barsPerChord?: number;
  /** Cents to detune the whole render — a record that is not at A = 440. */
  detuneCents?: number;
  /**
   * Put a tune over the top.
   *
   *   'line'   a real melody — chord tones on the strong eighths, non-chord
   *            tones passing between them.  This is the case a chart has to
   *            survive, and it is HARD: every off-beat note is outside the
   *            chord.
   *   'thirds' the melody this fixture used to have: scale degrees stacked in
   *            thirds.  Kept because it is a genuinely ambiguous case, NOT as
   *            a chart to be matched — see the note on `melodyBar`.
   */
  melody?: 'line' | 'thirds';
  /** Play the root an octave down as a separate part, and return its audio. */
  withBass?: boolean;
  /**
   * Play the chord one note at a time instead of as a block.
   *
   * The case stage B could not read: at any instant an arpeggio sounds one
   * or two of the chord's notes, so every beat is genuinely ambiguous on its
   * own and the chord is only in the bar.
   */
  arpeggio?: boolean;
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
    arpeggio = false,
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
      if (arpeggio && which === 'mix') {
        // Eighth notes, cycling up through the chord and into the next
        // octave — which is what an arpeggiator does and what a guitarist
        // picking a chord does.
        const steps = Math.round(8 * barsPerChord);
        const stepSec = (BAR_SEC * barsPerChord) / steps;
        for (let step = 0; step < steps; step++) {
          const pitch = (pitches[step % pitches.length] ?? 60)
            + (step % (pitches.length * 2) >= pitches.length ? 12 : 0);
          instrument.playNote({
            ctx: ctx as unknown as BaseAudioContext,
            destination: ctx.destination as unknown as AudioNode,
            note: createNote({
              pitch: Math.round(pitch), velocity: 0.7,
              startBeat: 0, durationBeat: 1,
              pitchOffsetSemitones: cents,
            }),
            config: DEFAULT_MIDI_CONFIG, when: at + step * stepSec,
            durationSec: stepSec * 0.9, params,
          });
        }
      } else {
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
      }
      if (which === 'mix' && melody) {
        const line = melody === 'thirds' ? thirdsBar(index) : melodyBar(chord, index);
        const each = (BAR_SEC * barsPerChord) / line.length;
        line.forEach((pitch, step) => {
          instrument.playNote({
            ctx: ctx as unknown as BaseAudioContext,
            destination: ctx.destination as unknown as AudioNode,
            note: createNote({
              pitch, velocity: 0.55,
              startBeat: 0, durationBeat: 1,
              pitchOffsetSemitones: cents,
            }),
            config: DEFAULT_MIDI_CONFIG,
            when: at + step * each,
            durationSec: each * 0.9, params,
          });
        });
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
    const audio = await render(POP, { melody: 'line' });
    const got = labelsFor(audio, POP);
    assert(accuracy(POP, got) >= 0.75, `${POP.join(' ')} → ${got.join(' ')}`);
    console.log(`      (melody over chords: ${(accuracy(POP, got) * 100).toFixed(0)}% — ${got.join(' ')})`);
  });

  await check('a melody over an ARPEGGIO does not rewrite them either', async () => {
    // The hard version, and the one that was recorded as smoothing's only
    // regression.  A block chord holds its triad under the tune; an arpeggio
    // sounds one or two notes at a time, so the melody is half the evidence
    // on every beat.
    //
    // Measured on both progressions, because four chords can be half right by
    // accident.
    for (const prog of [POP, MINOR]) {
      const audio = await render(prog, { arpeggio: true, melody: 'line' });
      const got = labelsFor(audio, prog);
      assert(accuracy(prog, got) >= 0.75,
        `arpeggio under a melody: ${prog.join(' ')} → ${got.join(' ')}`);
      console.log(`      (melody over an arpeggio: `
        + `${(accuracy(prog, got) * 100).toFixed(0)}% — ${got.join(' ')})`);
    }
  });

  await check('the melody really is outside the chords, or it proves nothing', async () => {
    // The guard on the fixture above.  A "melody" that happens to stay inside
    // the triad would make that test pass while testing nothing, and the
    // whole reason this fixture was rewritten is that its old tune was not
    // the thing it claimed to be.
    for (const [bar, symbol] of POP.entries()) {
      const chord = parseChord(symbol);
      assert(chord !== null, `cannot parse ${symbol}`);
      const tones = pitchClassesOf(symbol);
      const line = melodyBar(chord!, bar);
      const strong = line.filter((_, i) => i % 2 === 0).map((p) => p % 12);
      const weak = line.filter((_, i) => i % 2 === 1).map((p) => p % 12);
      assert(strong.every((pc) => tones.has(pc)),
        `bar ${bar}: a strong beat left the chord — ${strong.join(' ')}`);
      assert(weak.every((pc) => !tones.has(pc)),
        `bar ${bar}: an off-beat note was IN the chord, so it is not a passing tone`);
      // And the tune must not stack with the chord into one nice extension —
      // that is exactly the trap the old fixture fell into.
      const union = new Set([...tones, ...weak, ...strong]);
      assert(union.size >= 5, `bar ${bar}: only ${union.size} pitch classes — too easy`);
    }
  });

  await check('when the melody spells an extension, the chart is genuinely ambiguous', async () => {
    // The old fixture's tune, kept and told the truth about.  Over C it plays
    // C E G B: the bar contains the notes of Cmaj7 and NOTHING else, so
    // "Cmaj7" is not an error and scoring it against a written "C" measures
    // the annotation, not the detector.
    //
    // What IS required is that the detector never names a note that is not
    // playing.  That is checkable and it is the real requirement.
    const audio = await render(POP, { arpeggio: true, melody: 'thirds' });
    const got = labelsFor(audio, POP);
    for (const [bar, symbol] of POP.entries()) {
      const sounding = new Set([
        ...pitchClassesOf(symbol),
        ...thirdsBar(bar).map((p) => p % 12),
      ]);
      const named = pitchClassesOf(got[bar] ?? '');
      assert(named.size > 0, `bar ${bar} got no chord at all (${got[bar]})`);
      for (const pc of named) {
        assert(sounding.has(pc),
          `bar ${bar}: called it ${got[bar]}, which needs pitch class ${pc} — `
          + `not among the notes playing (${[...sounding].sort((a, b) => a - b).join(' ')})`);
      }
    }
    // And the ambiguity is real, not an excuse: the bar over C contains four
    // pitch classes and they are exactly Cmaj7.
    const barZero = new Set([...pitchClassesOf('C'), ...thirdsBar(0).map((p) => p % 12)]);
    const cmaj7 = pitchClassesOf('Cmaj7');
    assert(barZero.size === cmaj7.size && [...cmaj7].every((pc) => barZero.has(pc)),
      `bar 0 should be exactly Cmaj7's notes, got ${[...barZero].join(' ')}`);
    console.log(`      (melody spelling extensions: ${got.join(' ')} `
      + `— every note named is a note playing)`);
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
    // Stated as a GAP rather than as a ceiling on the blind run, because the
    // blind run is no longer as bad as it was: the smoother rescues part of a
    // damaged chroma by making the surviving evidence agree with itself.  It
    // rescued the number, not the tuning — the correction still has to be
    // worth half the chart, which is a stronger claim than "the blind run is
    // under half" and does not move when the smoother improves.
    const gap = accuracy(POP, farTuned) - accuracy(POP, farBlind);
    assert(gap >= 0.5,
      `at 45 cents the correction was only worth ${(gap * 100).toFixed(0)} points `
      + `(${(accuracy(POP, farTuned) * 100).toFixed(0)}% vs ${(accuracy(POP, farBlind) * 100).toFixed(0)}%, `
      + `${farBlind.join(' ')})`);

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

  await check('arpeggiated sevenths are exact — once there is a bass', async () => {
    // The case that sat at 75 %.  An arpeggiated seventh sounds one or two of
    // its four notes at a time, so the CHORD is only in the bar; and the two
    // spellings a bar of A C E G can have — Am7 and C6 — are the same four
    // pitch classes, which no chroma can separate.  The bass can, and that is
    // what it is for.
    //
    // Four shapes, because one turnaround can be right by luck: two
    // progressions × one chord a bar and one every two beats.
    const shapes = [
      { name: 'sevenths, 1 bar',   prog: SEVENTHS, bars: 1 },
      { name: 'sevenths, 2 beats', prog: SEVENTHS, bars: 0.5 },
      { name: 'jazz, 1 bar',       prog: JAZZ,     bars: 1 },
      { name: 'jazz, 2 beats',     prog: JAZZ,     bars: 0.5 },
    ];
    let blindTotal = 0;
    for (const shape of shapes) {
      const audio = await render(shape.prog, {
        arpeggio: true, withBass: true, barsPerChord: shape.bars,
      });
      const got = labelsFor(audio, shape.prog, shape.bars);
      assert(accuracy(shape.prog, got) === 1,
        `${shape.name}: ${shape.prog.join(' ')} → ${got.join(' ')}`);
      // And the bass has to be what did it, or this check is decoration.
      const blind = labelsFor({ mix: audio.mix, bass: null }, shape.prog, shape.bars);
      blindTotal += accuracy(shape.prog, blind);
      console.log(`      (${shape.name}: with bass 100% — `
        + `without ${(accuracy(shape.prog, blind) * 100).toFixed(0)}% ${blind.join(' ')})`);
    }
    assert(blindTotal / shapes.length <= 0.8,
      `the bass earned nothing: blind average ${((blindTotal / shapes.length) * 100).toFixed(0)}%`);
  });

  await check('without a bass, an arpeggio names the right NOTES, not the right root', async () => {
    // What the detector can still be held to when the bass is missing — a
    // solo guitar picking jazz chords, say.  Am7 and C6 are A C E G either
    // way; reporting one for the other is a spelling, not a wrong reading.
    //
    // So the requirement is the pitch-class SET, and the exact-label number
    // is printed beside it rather than asserted.
    const audio = await render(SEVENTHS, { arpeggio: true });
    const got = labelsFor(audio, SEVENTHS);
    let sameNotes = 0;
    for (const [bar, symbol] of SEVENTHS.entries()) {
      const want = pitchClassesOf(symbol);
      const named = pitchClassesOf(got[bar] ?? '');
      const same = named.size === want.size && [...want].every((pc) => named.has(pc));
      if (same) sameNotes += 1;
    }
    assert(sameNotes === SEVENTHS.length,
      `blind arpeggio got the notes wrong somewhere: ${SEVENTHS.join(' ')} → ${got.join(' ')}`);
    console.log(`      (blind arpeggiated sevenths: notes 100%, exact label `
      + `${(accuracy(SEVENTHS, got) * 100).toFixed(0)}% — ${got.join(' ')})`);
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

  // ── Stage C: deciding every beat at once ──────────────────────────────────

  /** A chroma with these pitch classes sounding equally.  No audio needed. */
  const chromaOf = (...pcs: number[]): Float32Array => {
    const v = new Float32Array(12);
    for (const pc of pcs) v[pc] = 1;
    return v;
  };

  await check('the most likely path is not the sequence of most likely beats', () => {
    // A bar of C major where the second beat is dominated by a G–D dyad —
    // an arpeggio reaching the fifth while a passing D goes by, with the C
    // and E still ringing underneath it.  That is not a contrived shape; it
    // is what the measured chroma of arpeggiated music looks like.
    //
    // On that beat alone G is genuinely the better answer, and it leads by a
    // LITTLE.  That is the case smoothing is for: it overrules small leads
    // using the rest of the bar, and it does not overrule large ones.  A beat
    // that really is nothing but G and D really is a G, and a model that
    // called it C would not be smoothing, it would be deaf.
    const ringing = new Float32Array(12);
    ringing[7] = 1; ringing[2] = 0.9; ringing[0] = 0.35; ringing[4] = 0.3;
    const bar = [chromaOf(0, 4), ringing, chromaOf(4, 7), chromaOf(0, 4)];

    const alone = bar.map((c) => { const h = matchChord(c); return h ? formatChord(h.chord) : '—'; });
    const together = smoothChords(bar).path.map((c) => (c ? formatChord(c) : '—'));

    assert(together.every((label) => label === 'C'),
      `the path should be four beats of C, got ${together.join(' ')}`);
    // And the point is that this was NOT available beat by beat.  If the
    // per-beat answers were already all C, this fixture proves nothing and
    // the check should fail rather than quietly pass.
    assert(!alone.every((label) => label === 'C'),
      `the fixture is too easy — per-beat matching already answered ${alone.join(' ')}`);
    console.log(`      (a bar of C: beat by beat ${alone.join(' ')} → together ${together.join(' ')})`);
  });

  await check('smoothing does not smooth away a real chord change', () => {
    // The failure mode of a switch cost that is too high is one chord for the
    // whole song, which would score well on the check above and be useless.
    const bars = [
      ...[0, 1, 2, 3].map(() => chromaOf(0, 4, 7)),
      ...[0, 1, 2, 3].map(() => chromaOf(7, 11, 2)),
      ...[0, 1, 2, 3].map(() => chromaOf(9, 0, 4)),
      ...[0, 1, 2, 3].map(() => chromaOf(5, 9, 0)),
    ];
    const got = smoothChords(bars).path.map((c) => (c ? formatChord(c) : '—'));
    const want = ['C', 'G', 'Am', 'F'];
    for (let bar = 0; bar < 4; bar++) {
      for (let beat = 0; beat < 4; beat++) {
        assert(got[bar * 4 + beat] === want[bar],
          `bar ${bar + 1} beat ${beat + 1} should be ${want[bar]}: ${got.join(' ')}`);
      }
    }
  });

  await check('an extra note has to earn its place', async () => {
    // The third of a triad, sounding alone, puts its own third harmonic a
    // major seventh above the root.  So an arpeggiated C major arrives with a
    // real B in it and reads as Cmaj7 with nothing wrong anywhere — measured,
    // not supposed: this is rendered audio, and turning the penalty off is
    // what shows where the B comes from.
    const audio = await render(['C', 'C', 'C', 'C'], { arpeggio: true });
    const readout = detectChordsFromAudio(audio.mix, SR, { tempo: TEMPO });
    const free = detectChordsFromAudio(audio.mix, SR, {
      tempo: TEMPO, segment: { smooth: { sizePenalty: 0 } },
    });
    const label = (r: typeof readout): string =>
      (r.segments[0] ? formatChord(r.segments[0].chord) : '—');
    assert(label(readout) === 'C', `an arpeggiated C read as ${label(readout)}`);
    assert(label(free) !== 'C',
      `without the penalty this audio already read as C — it proves nothing (${label(free)})`);
    console.log(`      (arpeggiated C major: ${label(free)} without the size penalty, ${label(readout)} with it)`);

    // And a seventh that is really there must still be written, or the
    // penalty has simply deleted the vocabulary the user asked for.
    const real = new Float32Array(12);
    real[0] = 1; real[4] = 0.95; real[7] = 0.95; real[11] = 0.9;
    const sevenths = smoothChords([real, real, real, real]).path
      .map((c) => (c ? formatChord(c) : '—'));
    assert(sevenths.every((l) => l === 'Cmaj7'),
      `a real major seventh must survive the penalty: ${sevenths.join(' ')}`);
    assert(DEFAULT_SIZE_PENALTY > 0, 'the size penalty is off by default');
  });

  await check('silence stays silence through the smoother', () => {
    // The no-chord state has to be reachable and leavable, or a rest in the
    // middle of a song becomes whichever chord was sounding before it.
    const bar = [
      chromaOf(0, 4, 7), chromaOf(0, 4, 7),
      new Float32Array(12), new Float32Array(12),
      chromaOf(5, 9, 0), chromaOf(5, 9, 0),
    ];
    const got = smoothChords(bar).path.map((c) => (c ? formatChord(c) : '—'));
    assert(got[2] === '—' && got[3] === '—', `silence became a chord: ${got.join(' ')}`);
    assert(got[0] === 'C' && got[5] === 'F', `the chords either side were lost: ${got.join(' ')}`);
  });

  await check('smoothing is what makes an arpeggio readable', async () => {
    // The headline claim of this stage, measured end to end rather than
    // asserted.  Block chords were already right; arpeggios were not, and a
    // four-chord loop is too short to show it — half of a four-chord answer
    // can be right by accident.
    const prog = ['C', 'Am', 'F', 'G', 'Em', 'Am', 'Dm7', 'G7'];
    const audio = await render(prog, { arpeggio: true });
    const smoothed = labelsFor(audio, prog);
    const perBeat = labelsFor(audio, prog, 1, { segment: { smooth: false } });
    const withSmoothing = accuracy(prog, smoothed);
    const without = accuracy(prog, perBeat);
    assert(withSmoothing >= 0.85,
      `arpeggios should read: ${prog.join(' ')} → ${smoothed.join(' ')}`);
    assert(withSmoothing - without >= 0.4,
      `smoothing was only worth ${((withSmoothing - without) * 100).toFixed(0)} points `
      + `(${(without * 100).toFixed(0)}% → ${(withSmoothing * 100).toFixed(0)}%) — `
      + `beat by beat: ${perBeat.join(' ')}`);
    console.log(
      `      (8 arpeggiated chords: beat by beat ${(without * 100).toFixed(0)}% → smoothed `
      + `${(withSmoothing * 100).toFixed(0)}% — ${smoothed.join(' ')})`,
    );
  });

  await check('a slash chord is never invented from the mix alone', () => {
    // A bass STEM is a bass line, and what it holds under a chord is the
    // inversion.  The lowest note of a MIX is a different thing wearing the
    // same shape — under an arpeggio it is whichever chord tone the pattern
    // reached — so it may move the score and must not reach the chart.
    const bar = [chromaOf(0, 4, 7), chromaOf(0, 4, 7), chromaOf(0, 4, 7), chromaOf(0, 4, 7)];
    const overE = [4, 4, 4, 4];
    const fromMix = segmentChords(bar, [0, 1, 2, 3, 4], { bassPitches: overE, bassIsStem: false });
    const fromStem = segmentChords(bar, [0, 1, 2, 3, 4], { bassPitches: overE, bassIsStem: true });
    assert(fromMix.length === 1 && formatChord(fromMix[0]!.chord) === 'C',
      `the mix invented an inversion: ${fromMix.map((x) => formatChord(x.chord)).join(' ')}`);
    assert(fromStem.length === 1 && formatChord(fromStem[0]!.chord) === 'C/E',
      `a measured bass should give the inversion: ${fromStem.map((x) => formatChord(x.chord)).join(' ')}`);
  });

  await check('an arpeggio reports no bass, because it has none', async () => {
    // The gate above, through the real pipeline.  A block chord has a lowest
    // note: it is there for the whole bar and reading it is reporting.  An
    // arpeggio does not — its lowest note is whichever chord tone the pattern
    // has reached — and the difference has to be visible in what comes out,
    // not just in a unit test of the helper.
    const block = await render(POP, {});
    const arp = await render(POP, { arpeggio: true });
    const share = (mix: Float32Array): number => {
      const gram = chromagram(mix, SR);
      const grid = beatGrid(mix.length / SR, TEMPO);
      let voted = 0;
      let spans = 0;
      for (let i = 0; i + 1 < grid.times.length; i++) {
        const from = Math.max(0, Math.ceil((grid.times[i] ?? 0) / gram.hopSec));
        const to = Math.min(gram.lowPitches.length, Math.ceil((grid.times[i + 1] ?? 0) / gram.hopSec));
        if (to <= from) continue;
        spans += 1;
        // The detector's own threshold, not a copy of it: a test that
        // hardcodes 0.6 measures the helper and proves nothing about whether
        // the pipeline still passes anything to it.
        if (majorityPitchClass(gram.lowPitches.slice(from, to), MIX_BASS_MAJORITY) !== null) voted += 1;
      }
      return spans === 0 ? 0 : voted / spans;
    };
    const blockShare = share(block.mix);
    const arpShare = share(arp.mix);
    assert(blockShare > 0.8,
      `a block chord should have a readable bass on most beats, got ${(blockShare * 100).toFixed(0)}%`);
    assert(arpShare < blockShare - 0.25,
      `an arpeggio reported a bass on ${(arpShare * 100).toFixed(0)}% of beats against the `
      + `block chord's ${(blockShare * 100).toFixed(0)}% — the gate is not doing anything`);
    console.log(
      `      (beats with a readable bass: block chords ${(blockShare * 100).toFixed(0)}%, `
      + `arpeggio ${(arpShare * 100).toFixed(0)}%)`,
    );
  });

  await check('a bass that walks is not an inversion either', () => {
    // The same rule one level up.  A bass STEM may be measured and still not
    // be sitting on a note: a walking bass visits three of the chord's tones
    // inside the bar, and the one it happened to visit most is not what the
    // chord is over.
    const bar = [chromaOf(0, 4, 7), chromaOf(0, 4, 7), chromaOf(0, 4, 7), chromaOf(0, 4, 7)];
    const grid = [0, 1, 2, 3, 4];
    const walking = segmentChords(bar, grid, { bassPitches: [4, 7, 0, 4], bassIsStem: true });
    assert(walking.length === 1 && formatChord(walking[0]!.chord) === 'C',
      `a walking bass was written as an inversion: ${walking.map((x) => formatChord(x.chord)).join(' ')}`);
    // And a bass that really does sit on the third still gets its slash.
    const sitting = segmentChords(bar, grid, { bassPitches: [4, 4, 4, 4], bassIsStem: true });
    assert(sitting.length === 1 && formatChord(sitting[0]!.chord) === 'C/E',
      `a held bass note lost its slash: ${sitting.map((x) => formatChord(x.chord)).join(' ')}`);
  });

  await check('a bass that only has a plurality is not a bass note', () => {
    // An arpeggio's lowest note is the root 40 % of the time and the third
    // and the fifth 30 % each.  Answering "the root" there states something
    // the audio did not say.
    const walking = [0, 0, 4, 7, 7];
    assert(majorityPitchClass(walking) === 0,
      'with no threshold the plurality still wins, as the older callers expect');
    assert(majorityPitchClass(walking, 0.6) === null,
      `a 40 % plurality was reported as a bass note: ${majorityPitchClass(walking, 0.6)}`);
    assert(majorityPitchClass([5, 5, 5, 5, 9], 0.6) === 5,
      'a real majority should still come through');
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

  // ── Stage D: measuring against a real annotation ──────────────────────────

  await check('the reference format is read as it is actually written', () => {
    // Harte's syntax, which is what every public reference set uses.  Getting
    // this wrong does not produce an error, it produces a WRONG SCORE — the
    // one number in the measurement that has to be trusted.
    const cases: [string, string | null][] = [
      ['C', 'C'], ['C:maj', 'C'], ['A:min', 'Am'], ['G:7', 'G7'],
      ['F:maj7', 'Fmaj7'], ['B:hdim7', 'Bm7b5'], ['D:minmaj7', 'DmMaj7'],
      ['Bb:maj', 'A#'], ['C#:min7', 'C#m7'], ['Db:maj', 'C#'],
      ['E:sus4', 'Esus4'], ['A:maj6', 'A6'], ['G:min6', 'Gm6'],
      ['N', null], ['', null],
    ];
    for (const [label, want] of cases) {
      const got = parseHarteLabel(label).chord;
      const text = got ? formatChord(got) : null;
      assert(text === want, `${label} → ${text}, expected ${want}`);
    }
    // X is not "no chord" — it is "the annotator could not tell", and the
    // difference decides whether those seconds are scored or skipped.
    assert(parseHarteLabel('X').unknown, 'X should be unknown');
    assert(!parseHarteLabel('N').unknown, 'N is a statement, not a shrug');

    // An inversion is a bass DEGREE above the root, not a note name.
    const slash = parseHarteLabel('C:maj/3').chord;
    assert(slash !== null && formatChord(slash) === 'C/E', `C:maj/3 → ${slash ? formatChord(slash) : 'null'}`);
    const seventh = parseHarteLabel('G:7/b7').chord;
    assert(seventh !== null && formatChord(seventh) === 'G7/F', `G:7/b7 → ${seventh ? formatChord(seventh) : 'null'}`);

    // An unknown shorthand is REPORTED, never quietly turned into something
    // plausible: a silent mapping would corrupt the reference itself.
    assert(parseHarteLabel('C:wat').problem !== undefined, 'an unknown quality passed silently');
    assert(parseHarteLabel('H:maj').problem !== undefined, 'an unknown root passed silently');
  });

  await check('our own labels survive the round trip', () => {
    // The benchmark can write what it found as a .lab so it can be diffed by
    // eye against the reference.  If that spelling does not read back, the
    // file is a dead end.
    for (const symbol of ['C', 'Am7', 'G7', 'Fmaj7', 'Bm7b5', 'D#dim7', 'C/E', 'Esus4', 'A6']) {
      const chord = parseChord(symbol)!;
      const round = parseHarteLabel(formatHarteLabel(chord)).chord;
      assert(round !== null && formatChord(round) === symbol,
        `${symbol} → ${formatHarteLabel(chord)} → ${round ? formatChord(round) : 'null'}`);
    }
    assert(formatHarteLabel(null) === 'N', 'no chord should be written as N');
  });

  await check('a reference file is read, and its bad lines are named', () => {
    const parsed = parseLab([
      '# a comment',
      '',
      '0.000000\t2.500000\tC:maj',
      '2.500000\t5.000000\tA:min7',
      'nonsense',
      '5.000000\t7.500000\tC:wat',
    ].join('\n'));
    assert(parsed.spans.length === 3, `expected 3 spans, got ${parsed.spans.length}`);
    assert(parsed.problems.length === 2,
      `expected 2 problems, got ${parsed.problems.length}: ${parsed.problems.join(' | ')}`);
    assert(parsed.problems.some((p) => p.includes('5행')), 'the bad line was not named');
  });

  await check('the score is weighted by seconds, not by chord', () => {
    // Eight bars of C and one passing F#dim7 are one chord each, and they are
    // not one unit each of being right: the listener hears the C for eight
    // bars.  A benchmark that counts chords rewards a detector for getting
    // the blips right and missing the song.
    const span = (startSec: number, endSec: number, symbol: string): LabSpan => ({
      startSec, endSec, label: symbol,
      chord: symbol === 'N' ? null : parseChord(symbol)!, unknown: false,
    });
    const reference = [span(0, 16, 'C'), span(16, 17, 'F#dim7')];
    const longRight = [span(0, 16, 'C'), span(16, 17, 'G')];
    const shortRight = [span(0, 16, 'G'), span(16, 17, 'F#dim7')];
    const a = scoreChords(reference, longRight).scores.exact;
    const b = scoreChords(reference, shortRight).scores.exact;
    assert(Math.abs(a - 16 / 17) < 1e-9, `sixteen of seventeen seconds → ${a}`);
    assert(Math.abs(b - 1 / 17) < 1e-9, `one of seventeen seconds → ${b}`);
    assert(a > b, 'getting the long chord right must be worth more than the blip');
  });

  await check('the four tiers say different things', () => {
    const span = (startSec: number, endSec: number, symbol: string): LabSpan => ({
      startSec, endSec, label: symbol, chord: parseChord(symbol)!, unknown: false,
    });
    const reference = [span(0, 4, 'C')];
    // Right harmony, wrong colour: the root is right, the triad is right, the
    // seventh is not.  A single number would call this a total miss and hide
    // the fact that the chart is usable.
    const asSeventh = scoreChords(reference, [span(0, 4, 'Cmaj7')]).scores;
    assert(asSeventh.root === 1 && asSeventh.triad === 1, 'Cmaj7 should keep the root and the triad');
    assert(asSeventh.sevenths === 0 && asSeventh.exact === 0, 'Cmaj7 is not C');
    // Right root, wrong third.
    const asMinor = scoreChords(reference, [span(0, 4, 'Cm')]).scores;
    assert(asMinor.root === 1 && asMinor.triad === 0, 'Cm should keep the root and lose the triad');
    // An inversion is the same chord until the last tier.
    const asSlash = scoreChords(reference, [span(0, 4, 'C/E')]).scores;
    assert(asSlash.sevenths === 1 && asSlash.exact === 0,
      'an inversion is the same chord except at the exact tier');
    // A suspended fourth is not a bad major.  Forcing everything into
    // major-or-minor would score a detector as right for answering C where
    // the record plainly says Csus4, which is the distinction a chart is for.
    const susRef = [span(0, 4, 'Csus4')];
    const asMajor = scoreChords(susRef, [span(0, 4, 'C')]).scores;
    assert(asMajor.root === 1, 'a sus chord keeps its root');
    assert(asMajor.triad === 0, 'C should not count as Csus4 at the triad tier');
    assert(scoreChords(susRef, [span(0, 4, 'Csus4')]).scores.triad === 1,
      'a sus chord should match itself');

    // Nothing at all.
    const wrong = scoreChords(reference, [span(0, 4, 'F#')]).scores;
    assert(SCORE_TIERS.every((t) => wrong[t] === 0), 'F# should score nothing against C');
  });

  await check('X is skipped and a gap is not', () => {
    const reference: LabSpan[] = [
      { startSec: 0, endSec: 4, label: 'C', chord: parseChord('C')!, unknown: false },
      { startSec: 4, endSec: 8, label: 'X', chord: null, unknown: true },
    ];
    const estimate: LabSpan[] = [
      { startSec: 0, endSec: 8, label: 'C', chord: parseChord('C')!, unknown: false },
    ];
    const score = scoreChords(reference, estimate);
    assert(score.scoredSec === 4 && score.skippedSec === 4,
      `scored ${score.scoredSec}s and skipped ${score.skippedSec}s`);
    assert(score.scores.exact === 1, 'the scored half was right and should score 1');

    // But a detector that simply stopped answering must be scored as wrong on
    // what it did not answer, not excused from it.
    const halfAnswered = segmentsToSpans(
      [{ startSec: 0, endSec: 4, chord: parseChord('C')! }], 8);
    const strict = scoreChords([
      { startSec: 0, endSec: 8, label: 'C', chord: parseChord('C')!, unknown: false },
    ], halfAnswered);
    assert(Math.abs(strict.scores.exact - 0.5) < 1e-9,
      `answering half the song scored ${strict.scores.exact}`);

    // The same at the front.  A detector that says nothing until the intro is
    // over has not answered the intro, and the gap before its first segment
    // has to be filled in as "no chord" or those seconds vanish from the
    // denominator and the score goes UP for answering less.
    const lateStart = segmentsToSpans(
      [{ startSec: 4, endSec: 8, chord: parseChord('C')! }], 8);
    const scored = scoreChords([
      { startSec: 0, endSec: 8, label: 'C', chord: parseChord('C')!, unknown: false },
    ], lateStart);
    assert(Math.abs(scored.scoredSec - 8) < 1e-9,
      `the unanswered intro left the denominator at ${scored.scoredSec}s instead of 8`);
    assert(Math.abs(scored.scores.exact - 0.5) < 1e-9,
      `starting halfway through scored ${scored.scores.exact}`);

    // And the file it writes has to cover the whole recording, because that
    // is what a reference annotation is.  This is the property the explicit
    // `N` spans exist for — the scoring reads a hole as no chord either way,
    // so nothing above would notice if they stopped being written.
    const text = formatLab(lateStart);
    const back = parseLab(text).spans;
    assert(Math.abs((back[0]?.startSec ?? -1)) < 1e-9,
      `the written file starts at ${back[0]?.startSec} instead of 0`);
    assert(Math.abs((back[back.length - 1]?.endSec ?? 0) - 8) < 1e-9,
      `the written file ends at ${back[back.length - 1]?.endSec} instead of 8`);
    for (let i = 1; i < back.length; i++) {
      assert(Math.abs((back[i]!.startSec) - (back[i - 1]!.endSec)) < 1e-6,
        `the written file has a hole at ${back[i - 1]!.endSec}s`);
    }
  });

  await check('a chart with the right names in the wrong places is caught', () => {
    // The tier scores can look respectable while every change lands half a bar
    // late, and a chart like that is not a usable chart.
    const span = (startSec: number, endSec: number, symbol: string): LabSpan => ({
      startSec, endSec, label: symbol, chord: parseChord(symbol)!, unknown: false,
    });
    const reference = [span(0, 4, 'C'), span(4, 8, 'G'), span(8, 12, 'Am')];
    const onTime = [span(0, 4, 'C'), span(4, 8, 'G'), span(8, 12, 'Am')];
    const late = [span(0, 5, 'C'), span(5, 9, 'G'), span(9, 12, 'Am')];
    assert(scoreChords(reference, onTime).medianBoundaryErrorSec === 0, 'an exact chart has no boundary error');
    const shifted = scoreChords(reference, late);
    assert(shifted.medianBoundaryErrorSec >= 1 - 1e-9,
      `a second late everywhere reported ${shifted.medianBoundaryErrorSec}s`);
    assert(shifted.scores.exact > 0.7,
      'the tier score should still look respectable — that is why the boundary number exists');
  });

  await check('a rejected tempo is never printed as the grid', () => {
    // The chord detector refuses a tempo it does not trust and lays a fixed
    // window instead.  A report that prints the rejected BPM next to the
    // results is telling the reader the chart is on a grid it is not on —
    // which is exactly what this benchmark found on its own first run, where
    // 96 BPM was detected, rejected at 28 % confidence, and the chart came
    // out on half-second windows.
    const accepted = describeGrid({
      detectedBpm: 96, detectedConfidence: 0.9, fromTempo: true, gridBpm: 96,
    });
    assert(accepted === '96.0 BPM', `an accepted tempo read as ${accepted}`);

    const rejected = describeGrid({
      detectedBpm: 96, detectedConfidence: 0.28, fromTempo: false, gridBpm: 0,
    });
    assert(rejected.includes('고정 창'), `a rejected tempo read as ${rejected}`);
    assert(rejected.includes('기각'), `the rejection was not named: ${rejected}`);
    assert(!/^\s*96/.test(rejected), `the rejected BPM was printed as the grid: ${rejected}`);

    const none = describeGrid({
      detectedBpm: 0, detectedConfidence: 0, fromTempo: false, gridBpm: 0,
    });
    assert(none.includes('고정 창') && !none.includes('기각'),
      `no tempo at all read as ${none}`);
  });

  await check('the benchmark command runs, end to end', () => {
    // The whole stage-D path on a real file: WAV in, tempo from the audio,
    // chords, scored against a .lab on disk.  A benchmark nothing runs is a
    // benchmark that rots, and this one cannot be run on real music here.
    const dir = mkdtempSync(join(tmpdir(), 'chord-bench-'));
    try {
      const bpm = 96;
      const barSec = (60 / bpm) * 4;
      const prog = ['C', 'G', 'Am', 'F'];
      // A simple additive render — no instruments needed, and it keeps this
      // check fast enough to live in the chain.
      const rate = 44_100;
      const total = Math.round(rate * (prog.length * barSec));
      const mono = new Float32Array(total);
      const lab: string[] = [];
      prog.forEach((symbol, index) => {
        const chord = parseChord(symbol)!;
        const quality = QUALITIES.find((q) => q.id === chord.qualityId)!;
        const at = index * barSec;
        lab.push(`${at.toFixed(6)}\t${(at + barSec).toFixed(6)}\t${formatHarteLabel(chord)}`);
        for (const interval of quality.intervals) {
          const hz = 440 * 2 ** ((48 + chord.root + interval - 69) / 12);
          const from = Math.round(at * rate);
          const to = Math.min(total, Math.round((at + barSec * 0.98) * rate));
          for (let i = from; i < to; i++) {
            const t = (i - from) / rate;
            // A short attack and a slow decay, so the transient detector has
            // something to find and the tempo is discoverable.
            const env = Math.min(1, t * 200) * Math.exp(-t * 1.2);
            mono[i] = (mono[i] ?? 0) + 0.2 * env * Math.sin(2 * Math.PI * hz * t);
          }
        }
      });
      writeWav24(join(dir, 'take.wav'), [mono], rate);
      writeFileSync(join(dir, 'take.lab'), lab.join('\n') + '\n');

      const run = spawnSync('npx', ['tsx', 'scripts/chord-benchmark.ts', dir], {
        cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', timeout: 600_000,
      });
      const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
      assert(run.status === 0, `the benchmark exited ${run.status}: ${out.slice(0, 400)}`);
      assert(out.includes('take.wav'), `the file was not reported: ${out.slice(0, 400)}`);
      assert(/정답과 비교/.test(out), `no scored table was printed: ${out.slice(0, 400)}`);
      // The numbers themselves are the point: a benchmark that runs and
      // reports 0 % on audio built from the reference is broken.
      const row = out.split('\n').find((l) => l.includes('take.wav')) ?? '';
      const first = Number((row.match(/(\d+\.\d)/) ?? [])[1] ?? '0');
      assert(first >= 75,
        `the benchmark scored its own reference at ${first}% — the harness is wrong, not the detector`);
      console.log(`      (benchmark on a generated take: 근음 ${first.toFixed(1)}%)`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── The chart, on screen ──────────────────────────────────────────────────

  const chordEvent = (
    timeSec: number, symbol: string, margin?: number,
  ): ChordEvent => ({
    id: `e${timeSec}`, timeSec, chord: parseChord(symbol)!,
    ...(margin === undefined ? {} : { margin }),
  });

  await check('a chord a person wrote is never marked doubtful', () => {
    // The rule that matters most here, and the easy one to get backwards.  A
    // typed chord has no margin, and "no number" must not read as "no
    // confidence" — that would put the user's own decisions into the list of
    // things to go back and check.
    assert(!isUnsure(chordEvent(0, 'C')), 'a hand-written chord was marked doubtful');
    assert(isUnsure(chordEvent(0, 'C', 0.01)), 'a coin-toss margin was not marked');
    assert(!isUnsure(chordEvent(0, 'C', 0.5)), 'a confident margin was marked');
    assert(!isUnsure(chordEvent(0, 'C', UNSURE_MARGIN)),
      'the threshold itself should not count as doubtful');
  });

  await check('retyping a chord clears the doubt', () => {
    // Otherwise the lane keeps marking a bar after the person doubting it has
    // said what it is, and it stays in the "go and check these" list for ever.
    const events = [chordEvent(0, 'C', 0.01), chordEvent(4, 'G', 0.9)];
    assert(unsureChords(events).length === 1, 'setup: one doubtful chord');
    const fixed = setChord(events, 'e0', parseChord('Am')!);
    assert(fixed[0]!.margin === undefined, 'retyping left the old margin behind');
    assert(unsureChords(fixed).length === 0, 'the chord is still in the doubtful list');
    assert(formatChord(fixed[0]!.chord) === 'Am', 'the retyped chord did not take');

    // Moving or transposing is not answering the question, so those keep it.
    const moved = moveChord(events, 'e0', 1);
    assert(moved.find((e) => e.id === 'e0')?.margin === 0.01,
      'dragging a chord should not change how sure the detector was');
    const shifted = transposeChords(events, 2);
    assert(shifted[0]?.margin === 0.01,
      'transposing the whole song does not make its chords more certain');
  });

  await check('the doubtful bars can be walked through, and they wrap', () => {
    // A count with no way to reach the bars is a number that tells you there
    // is work and not where.  Ninety bars cannot be checked; six can, if you
    // can get to them.
    const events = [
      chordEvent(0, 'C', 0.9), chordEvent(4, 'G', 0.01),
      chordEvent(8, 'Am', 0.9), chordEvent(12, 'F', 0.02),
    ];
    assert(unsureChords(events).map((e) => e.timeSec).join(',') === '4,12',
      `the doubtful list was ${unsureChords(events).map((e) => e.timeSec).join(',')}`);
    assert(nextUnsureAfter(events, 0)?.timeSec === 4, 'from the top, the first doubtful bar');
    assert(nextUnsureAfter(events, 4)?.timeSec === 12, 'standing on one, the next');
    // Wrapping, so working through the list does not go dead at the end.
    assert(nextUnsureAfter(events, 12)?.timeSec === 4, 'past the last one it should wrap to the first');
    assert(nextUnsureAfter([chordEvent(0, 'C')], 0) === null, 'nothing doubtful, nowhere to go');
  });

  await check('the block says which of the three things it is', () => {
    // A chord somebody typed, one the detector is sure of, and one it nearly
    // called something else are three different situations, and one tooltip
    // for all of them would tell the user nothing.
    const typed = describeChordBlock(chordEvent(0, 'C'));
    const sure = describeChordBlock(chordEvent(0, 'C', 0.42));
    const doubtful = describeChordBlock(chordEvent(0, 'C', 0.01));
    assert(new Set([typed, sure, doubtful]).size === 3,
      `the three cases share wording: ${[typed, sure, doubtful].join(' | ')}`);
    assert(!typed.includes('%'), `a typed chord should not quote a margin: ${typed}`);
    assert(sure.includes('오디오에서 읽음'), `a detected chord should say so: ${sure}`);
    assert(doubtful.includes('비등'), `a doubtful chord should say why: ${doubtful}`);
    assert(doubtful.includes('1.0%'), `the margin should be quoted: ${doubtful}`);
  });

  await check('the margin reaches the chart from the detector', () => {
    // The step between the two: the action itself needs a decoded clip, so a
    // version of it that quietly dropped the margin would go on passing every
    // other check in this file.  Everything above tests what the lane does
    // with a margin; this tests that it ever gets one.
    const segments = [
      { startSec: 0, endSec: 2, chord: parseChord('C')!, margin: 0.42, score: 1, beats: 4 },
      { startSec: 2, endSec: 4, chord: parseChord('G')!, margin: 0.01, score: 1, beats: 4 },
    ];
    const events = chordEventsFor(segments, 10);
    assert(events.length === 2, `expected 2 events, got ${events.length}`);
    assert(events[0]!.timeSec === 10 && events[1]!.timeSec === 12,
      `the clip offset was not applied: ${events.map((e) => e.timeSec).join(',')}`);
    assert(events[0]!.margin === 0.42 && events[1]!.margin === 0.01,
      'the margin did not survive the trip from the detector to the chart');
    assert(unsureChords(events).length === 1,
      'the doubtful chord did not arrive marked');
  });

  await check('the doubt survives being saved and reopened', () => {
    // Kept on the event rather than in a side table precisely so that it
    // does.  A chart that forgot which bars were doubtful the moment the file
    // was closed is a chart nobody checks.
    const events = [chordEvent(0, 'C', 0.9), chordEvent(4, 'G', 0.01)];
    const reopened = JSON.parse(JSON.stringify(events)) as ChordEvent[];
    assert(unsureChords(reopened).length === 1,
      'the margin did not survive the round trip through the session file');
    assert(reopened[0]!.margin === 0.9, 'a confident margin was lost');
  });

  // ── Playing the chart ─────────────────────────────────────────────────────

  const symbols = (...names: string[]) => names.map((n) => parseChord(n)!);

  await check('the hand stays still — voice leading beats root position', () => {
    // The one thing about a voicing that is objectively measurable, so it is
    // measured rather than admired.  Root position is right for a chord on
    // its own and wrong for a progression: the top note swings and the hand
    // jumps a fifth between every pair.
    const cases: [string, string[]][] = [
      ['pop', ['C', 'G', 'Am', 'F']],
      ['sevenths', ['Cmaj7', 'Am7', 'Dm7', 'G7']],
      ['jazz', ['Dm7', 'G7', 'Cmaj7', 'Am7', 'Dm7', 'G7', 'Em7', 'A7']],
    ];
    const top = (v: readonly number[][]): number => {
      const tops = v.map((x) => Math.max(...x));
      return Math.max(...tops) - Math.min(...tops);
    };
    for (const [name, names] of cases) {
      const chords = symbols(...names);
      const rooted = chords.map((c) => voiceChord(c, 60));
      const led = voiceLead(chords);
      const rootMove = totalMovement(rooted);
      const ledMove = totalMovement(led);
      assert(ledMove * 2 <= rootMove,
        `${name}: voice leading moved ${ledMove} against root position's ${rootMove} — `
        + 'it should be at least half');
      // Stated against root position rather than as a fixed number of
      // semitones.  An absolute threshold here was set from one register and
      // had to be retuned the moment the register changed, which is a test
      // measuring the settings instead of the claim.
      assert(top(led) * 2 <= top(rooted),
        `${name}: the top note swings ${top(led)} against root position's ${top(rooted)} — `
        + 'it should be at most half');
      console.log(`      (${name}: 이동 ${rootMove} → ${ledMove} 반음, 최고음 폭 ${top(rooted)} → ${top(led)})`);
    }
  });

  await check('a held note is free, and that is what connects a progression', () => {
    // Distance is measured to the NEAREST previous note, not by pairing up
    // index by index.  Pairing would charge a triad for following a seventh
    // with one fewer voice, and would charge nothing for the common tone that
    // is the whole reason a progression sounds joined up.
    assert(voiceDistance([60, 64, 67], [60, 64, 67]) === 0, 'the same voicing must be free');
    assert(voiceDistance([60, 64, 67], [60, 65, 69]) === 3,
      `C→F should be three semitones of work, got ${voiceDistance([60, 64, 67], [60, 65, 69])}`);
    // Four voices onto three: the extra voice finds a home, it is not a fine.
    assert(voiceDistance([60, 64, 67, 71], [60, 64, 67]) === 0,
      'dropping to a triad on notes that were already sounding must be free');
    assert(voiceDistance([], [60, 64, 67]) === 0, 'the first chord has nothing to lead from');
  });

  await check('the chart decides the bass, not the voicer', () => {
    // A slash chord is a statement.  A voicer that overruled it to save
    // movement would be answering a question nobody asked.
    const slash = parseChord('C/E')!;
    for (const voicing of voicingCandidates(slash)) {
      assert(voicing[0]! % 12 === 4,
        `every C/E voicing must sit on E, got ${voicing.join(',')}`);
    }
    const led = voiceLead(symbols('C', 'C/E', 'F'));
    assert((led[1]?.[0] ?? 0) % 12 === 4, `C/E was voiced as ${led[1]?.join(',')}`);
  });

  await check('the leading is doing the work, not just the centring', () => {
    // The check above compares against ROOT POSITION, and it turns out that
    // is too easy: simply choosing the inversion nearest the middle of the
    // register beats root position almost as well.  Measured, the travel term
    // changed one voicing in nine and one semitone of total travel — it was
    // very nearly decoration, and nothing here would have said so.
    //
    // So this compares against the honest rival: the same candidates, chosen
    // by register alone.  (The fix was to widen the register — in two octaves
    // there is barely a choice to make.)
    const chords = symbols('C', 'Am', 'F', 'G', 'Em', 'Am', 'Dm7', 'G7', 'Cmaj7');
    const centre = (DEFAULT_VOICING.lowPitch + DEFAULT_VOICING.highPitch) / 2;
    const anchorOnly = chords.map((chord) => {
      const candidates = voicingCandidates(chord);
      let best = candidates[0] ?? [];
      let bestCost = Infinity;
      for (const candidate of candidates) {
        const middle = candidate.reduce((a, b) => a + b, 0) / candidate.length;
        const cost = Math.abs(middle - centre);
        if (cost < bestCost) { bestCost = cost; best = candidate; }
      }
      return best;
    });
    const led = voiceLead(chords);
    const ledMove = totalMovement(led);
    const centredMove = totalMovement(anchorOnly);
    assert(ledMove < centredMove * 0.85,
      `leading moved ${ledMove} against centring's ${centredMove} — the travel term is not earning its place`);
    const differ = led.filter((v, i) => v.join(',') !== (anchorOnly[i] ?? []).join(',')).length;
    assert(differ >= 3,
      `leading and centring chose the same voicing ${led.length - differ} times out of ${led.length}`);
    console.log(`      (리딩 ${ledMove} vs 앵커만 ${centredMove} 반음, 다른 보이싱 ${differ}/${led.length})`);
  });

  await check('the register is anchored, so a long song does not walk away', () => {
    // Cheapest-move alone lets a progression drift for eighty bars, because
    // every individual step is cheap.  Sixteen repeats of a loop that has a
    // natural downward pull is what finds it.
    const loop = symbols('C', 'G', 'Am', 'F');
    const long = Array.from({ length: 16 }, () => loop).flat();
    const led = voiceLead(long);
    const lows = led.map((v) => Math.min(...v));
    const highs = led.map((v) => Math.max(...v));
    // Tighter than the register allows on purpose: the point is not that it
    // stayed legal, it is that it stayed PUT.  The allowed range is three
    // octaves and every fixture measured used about one.
    assert(Math.min(...lows) >= 58 && Math.max(...highs) <= 76,
      `after 64 chords the voicing ran to ${Math.min(...lows)}–${Math.max(...highs)}, `
      + `out of an allowed ${DEFAULT_VOICING.lowPitch}–${DEFAULT_VOICING.highPitch}`);
    // And the first loop and the last should be in the same place.
    assert(Math.abs((led[0]?.[0] ?? 0) - (led[60]?.[0] ?? 0)) <= 2,
      `the loop drifted: bar 1 ${led[0]?.join(',')} vs bar 61 ${led[60]?.join(',')}`);
  });

  await check('each backing style plays something different', () => {
    const spans: BackingSpan[] = ['C', 'G', 'Am', 'F'].map((s, i) => ({
      startBeat: i * 4, endBeat: i * 4 + 4, chord: parseChord(s)!,
    }));
    const counts = new Map<string, number>();
    for (const style of BACKING_STYLES) {
      const notes = backingNotes(spans, { style });
      assert(notes.length > 0, `${style} produced nothing`);
      counts.set(style, notes.length);
      // Everything must land inside the chords it was written for.
      for (const note of notes) {
        assert(note.startBeat >= 0 && note.startBeat < 16 + 1e-9,
          `${style} wrote a note at beat ${note.startBeat}`);
        assert(note.startBeat + note.durationBeat <= 16 + 1e-6,
          `${style} wrote a note running past the last chord`);
      }
      assert(backingInstrumentFor(style).length > 0, `${style} has no instrument`);
    }
    // A pad is one chord held; a comp is many; they must not be the same
    // thing under two names.
    assert(new Set(counts.values()).size === BACKING_STYLES.length,
      `two styles produced the same number of notes: ${[...counts].map(([k, v]) => `${k} ${v}`).join(', ')}`);
    assert((counts.get('pad') ?? 0) < (counts.get('comp') ?? 0), 'a pad should be sparser than a comp');
    console.log(`      (음 개수: ${[...counts].map(([k, v]) => `${k} ${v}`).join(', ')})`);
  });

  await check('the arpeggio does not stutter at the turn', () => {
    // Up then down repeats the top note at the turn and the bottom at the
    // wrap unless BOTH ends are dropped from the descent.  Measured as
    // 64 67 72 67 64 *64* 67 72 — twice a bar, and easy to miss by ear.
    const spans: BackingSpan[] = [{ startBeat: 0, endBeat: 8, chord: parseChord('C')! }];
    const notes = backingNotes(spans, { style: 'arp' }).sort((a, b) => a.startBeat - b.startBeat);
    for (let i = 1; i < notes.length; i++) {
      assert(notes[i]!.pitch !== notes[i - 1]!.pitch,
        `the arpeggio repeated ${notes[i]!.pitch} at beat ${notes[i]!.startBeat}: `
        + notes.map((n) => n.pitch).join(' '));
    }
  });

  await check('a chord held for four bars still gets a bass note in each', () => {
    // The failure this rule exists for: a bass line that plays once and then
    // leaves four bars empty is not a bass line.
    const spans: BackingSpan[] = [{ startBeat: 0, endBeat: 16, chord: parseChord('C')! }];
    const notes = backingNotes(spans, { style: 'bass', beatsPerBar: 4 });
    assert(notes.length === 4, `expected one per bar, got ${notes.length}`);
    assert(notes.every((n) => n.pitch === notes[0]!.pitch), 'the bass wandered off the root');
    // The downbeat of the chord is the loud one.
    assert(to7bit(notes[0]!.velocity) > to7bit(notes[1]!.velocity),
      'the chord change should land harder than the repeats');
  });

  await check('every chord in the chart reaches the part', () => {
    // Found in the running app: an eight-bar skeleton generated a part with
    // SEVEN chords in it.  `songEnd` measures clips, so a session whose only
    // content is a chord chart returns zero, the last chord's range came out
    // zero-length and it vanished.  The lane never showed the problem because
    // it draws to the edge of the viewport — the chart and the part generated
    // from it disagreed about how many chords there were.
    const names = ['C', 'G', 'Am', 'F', 'C', 'G', 'F', 'F'];
    const bar = (60 / 120) * 4;
    const events = names.map((symbol, i) => ({
      id: `s${i}`, timeSec: i * bar, chord: parseChord(symbol)!,
    }));
    const session = withChords(createSession(), events);
    const made = generateBackingPart(session, { style: 'pad' });
    assert(made.ok, made.ok ? '' : made.reason);
    if (!made.ok) return;
    // Three notes per chord, held: eight chords is 24 notes, not 21.
    assert(made.noteCount === names.length * 3,
      `expected ${names.length * 3} notes for ${names.length} chords, got ${made.noteCount}`);
    assert(made.message.includes(`코드 ${names.length}개`),
      `the message dropped a chord: ${made.message}`);

    // And the part has to cover the last chord, not stop at its downbeat.
    const track = made.session.tracks.find((t) => t.id === made.trackId);
    const part = track?.playlists[0]?.clips[0];
    assert(part !== undefined, 'the part was not added to the session');
    assert((part?.durationSec ?? 0) >= names.length * bar - 1e-6,
      `the part is ${part?.durationSec}s for ${names.length * bar}s of chords`);
  });

  await check('generating a part never writes over what is there', () => {
    // A new track every time.  Generating four bars of piano on top of
    // somebody's vocal take is not the kind of accident undo fixes — they
    // have to notice first.
    const bar = (60 / 120) * 4;
    const session = withChords(createSession(), [
      { id: 'a', timeSec: 0, chord: parseChord('C')! },
      { id: 'b', timeSec: bar, chord: parseChord('F')! },
    ]);
    const before = session.tracks.length;
    const made = generateBackingPart(session, { style: 'comp' });
    assert(made.ok, made.ok ? '' : made.reason);
    if (!made.ok) return;
    assert(made.session.tracks.length === before + 1,
      `expected one new track, went from ${before} to ${made.session.tracks.length}`);
    // The chord track itself is untouched — generating is not editing.
    assert(made.session.chordTrack.length === session.chordTrack.length,
      'generating a part changed the chord track');
  });

  await check('an empty chord track says so instead of making an empty part', () => {
    const made = generateBackingPart(createSession(), { style: 'pad' });
    assert(!made.ok, 'an empty chart produced a part');
    if (!made.ok) assert(made.reason.includes('코드'), `unhelpful reason: ${made.reason}`);
  });

  // ── What key is this in ───────────────────────────────────────────────────

  const progression = (...names: string[]): KeyChord[] =>
    names.map((n) => ({ chord: parseChord(n)! }));

  await check('the key of a progression', () => {
    const cases: [string[], string][] = [
      [['C', 'G', 'Am', 'F'], 'C Major'],
      [['Dm7', 'G7', 'Cmaj7', 'Cmaj7'], 'C Major'],
      [['F', 'G', 'C', 'C'], 'C Major'],
      [['Bb', 'F', 'Gm', 'Eb', 'Bb'], 'A# Major'],
      [['Cm', 'Ab', 'Eb', 'Bb'], 'C Minor'],
      [['Em', 'C', 'G', 'D'], 'E Minor'],
      [['F#m', 'D', 'A', 'E'], 'F# Minor'],
      [['D', 'A', 'Bm', 'G'], 'D Major'],
      [['Dm7b5', 'G7', 'Cm', 'Cm'], 'C Minor'],
    ];
    let right = 0;
    for (const [names, want] of cases) {
      const estimate = keyFromChords(progression(...names));
      const got = estimate ? keyName(estimate.key) : '—';
      if (got === want) right += 1;
      else console.log(`         ${names.join(' ')} → ${got}, expected ${want}`);
    }
    assert(right >= cases.length - 1,
      `${right}/${cases.length} keys — the estimator regressed`);
    console.log(`      (조성: ${right}/${cases.length})`);
  });

  await check('the relative minor is not the relative major', () => {
    // The single most common way a key detector is wrong: C major and A minor
    // contain exactly the same seven notes, so only WEIGHT on the tonic can
    // tell them apart.  Same four chords, two orders, two keys.
    const major = keyFromChords(progression('C', 'G', 'Am', 'F'));
    const minor = keyFromChords(progression('Am', 'F', 'C', 'G'));
    assert(major !== null && keyName(major.key) === 'C Major',
      `C G Am F → ${major ? keyName(major.key) : 'null'}`);
    assert(minor !== null && keyName(minor.key) === 'A Minor',
      `Am F C G → ${minor ? keyName(minor.key) : 'null'}`);
    // And when they are that close, the chart should offer both rather than
    // pick one and look certain.
    assert(minor !== null && keyIsAmbiguous(minor),
      `the relative pair should be flagged ambiguous, margin was ${minor?.margin}`);
    assert(minor?.alternative !== null && keyName(minor!.alternative!) === 'C Major',
      `the runner-up should be the relative major, got ${minor?.alternative ? keyName(minor.alternative) : 'none'}`);
  });

  await check('a progression that only reaches its tonic at the end', () => {
    // ii–V–I: the tonic chord is not played until the last bar, and the
    // chord before it is the dominant, whose own root has been sitting in the
    // histogram the whole time.  Without extra weight on chord ROOTS this
    // reads as G major — measured, it is the one thing the root bonus buys,
    // and an aggregate "8 of 9" check absorbed its removal without noticing.
    const inC = keyFromChords(progression('Dm7', 'G7', 'Cmaj7', 'Cmaj7'));
    assert(inC !== null && keyName(inC.key) === 'C Major',
      `Dm7 G7 Cmaj7 → ${inC ? keyName(inC.key) : 'null'}`);
    const inBb = keyFromChords(progression('Cm7', 'F7', 'Bbmaj7', 'Bbmaj7'));
    assert(inBb !== null && keyName(inBb.key) === 'A# Major',
      `Cm7 F7 Bbmaj7 → ${inBb ? keyName(inBb.key) : 'null'}`);
  });

  await check('a long chord outvotes a passing one', () => {
    // Weighted by how long each chord lasts, like everything else here.  Four
    // bars of C with a one-beat F#dim7 in them is in C; counting chords
    // instead of seconds lets the blip argue as loudly as the song.
    // Eight bars of C and G against a fast run of six foreign chords that
    // together last a beat and a half.  By the clock this is plainly in C; by
    // the chord COUNT the run is the majority and wins.
    const weighted: KeyChord[] = [
      { chord: parseChord('C')!, weight: 16 },
      { chord: parseChord('G')!, weight: 16 },
      ...['F#', 'C#', 'G#', 'D#', 'A#', 'B'].map((name) => ({
        chord: parseChord(name)!, weight: 0.25,
      })),
      { chord: parseChord('C')!, weight: 16 },
    ];
    const withWeights = keyFromChords(weighted);
    assert(withWeights !== null && keyName(withWeights.key) === 'C Major',
      `weighted → ${withWeights ? keyName(withWeights.key) : 'null'}`);
    // And the same chords counted equally must give a DIFFERENT answer, or
    // this fixture proves nothing about the weighting.
    const flat = keyFromChords(weighted.map((w) => ({ chord: w.chord })));
    assert(flat === null || keyName(flat.key) !== 'C Major',
      `counting chords equally also said C Major — the fixture does not test the weighting`);
  });

  await check('the margin is not sold as a confidence', () => {
    // Measured over 26 progressions: the margin does NOT separate right
    // answers from wrong ones — mean 0.145 correct against 0.128 wrong, with
    // 15 of 24 correct answers scoring below the worst wrong one.  So it must
    // not be named or used as trust; it exists to say "the runner-up is
    // close", which is a different and true statement.
    const src = stripComments(
      readFileSync(new URL('../src/renderer/daw/model/key.ts', import.meta.url), 'utf8'));
    assert(!/\bconfidence\b/.test(src),
      'key.ts is calling the margin a confidence again');
    // A tight pair is flagged; a clear key is not.
    const tight = keyFromChords(progression('Am', 'F', 'C', 'G'));
    const clear = keyFromChords(progression('Bb', 'F', 'Gm', 'Eb', 'Bb'));
    assert(tight !== null && tight.margin < KEY_AMBIGUOUS_MARGIN, 'a relative pair should be tight');
    assert(clear !== null && clear.margin >= KEY_AMBIGUOUS_MARGIN,
      `an unambiguous key was flagged, margin ${clear?.margin.toFixed(3)}`);
  });

  await check('a key is a scale the rest of the app already understands', () => {
    // Expressed as a `Scale` so the Key Editor, note snapping and the riff
    // machine can read it without a translation layer that would drift.
    const estimate = keyFromChords(progression('C', 'G', 'Am', 'F'))!;
    assert(estimate.key.scaleId === MAJOR_ID, `major key used scaleId ${estimate.key.scaleId}`);
    const minor = keyFromChords(progression('Am', 'F', 'C', 'G'))!;
    assert(minor.key.scaleId === MINOR_ID, `minor key used scaleId ${minor.key.scaleId}`);
    // And its notes are the notes of that scale.
    const notes = [...keyPitchClasses(estimate.key)].sort((a, b) => a - b);
    assert(notes.join(',') === '0,2,4,5,7,9,11', `C major came out as ${notes.join(',')}`);
    const aMinor = [...keyPitchClasses(minor.key)].sort((a, b) => a - b);
    assert(aMinor.join(',') === '0,2,4,5,7,9,11',
      `A minor should be the same seven notes, got ${aMinor.join(',')}`);
  });

  await check('a chroma can be read for a key too, and is worse at it', () => {
    // The estimator that needs no chords — for callers that have none.  It is
    // kept honest about being the weaker one: measured 6 of 11 rendered
    // fixtures against 10 of 11 for the chord route.
    const chroma = new Float32Array(12);
    // A C major scale's worth of energy, tonic-heavy.
    const weights: [number, number][] = [
      [0, 6], [2, 3], [4, 4], [5, 3], [7, 5], [9, 3], [11, 2],
    ];
    for (const [pc, w] of weights) chroma[pc] = w;
    const estimate = keyFromChroma(chroma);
    assert(estimate !== null && keyName(estimate.key) === 'C Major',
      `a C major profile read as ${estimate ? keyName(estimate.key) : 'null'}`);
    assert(keyFromChroma(new Float32Array(12)) === null, 'silence has no key');
  });

  await check('the key prior is off, because it was measured', () => {
    // Stage C said: estimate the key, condition on it, then measure whether
    // it helped.  It did not — 85.2 % at zero, 84.7 % at 0.03, 85.8 % at 0.06
    // across eleven fixtures, a spread smaller than one fixture.  Turning it
    // on for that would be fitting the setting to the fixtures.
    assert(DEFAULT_KEY_PRIOR === 0,
      `the key prior is on at ${DEFAULT_KEY_PRIOR} without a measurement that says it helps`);
    // But it must still WORK when asked for, or the knob is a lie.
    const chroma = (...pcs: number[]): Float32Array => {
      const v = new Float32Array(12);
      for (const pc of pcs) v[pc] = 1;
      return v;
    };
    // C#dim is not in C major; C is.  With a strong prior the diatonic one
    // should win a tie it would otherwise lose.
    const bar = [chroma(1, 4, 7), chroma(1, 4, 7), chroma(1, 4, 7), chroma(1, 4, 7)];
    const free = smoothChords(bar, { keyPrior: 0 }).path.map((c) => (c ? formatChord(c) : '—'));
    const keyed = smoothChords(bar, {
      key: { root: 0, scaleId: MAJOR_ID }, keyPrior: 0.5,
    }).path.map((c) => (c ? formatChord(c) : '—'));
    assert(free.join(' ') !== keyed.join(' '),
      `the key prior changed nothing even at 0.5: ${free.join(' ')}`);
  });

  await check('the key is read from the chords, not from the chroma', async () => {
    // Two routes, measured: from the raw chroma 6 of 11 rendered fixtures, from
    // the chords 10 of 11.  A pitch-class histogram cannot see a cadence, and
    // C major and A minor are the same seven notes — so an arpeggiated C–G–Am–F
    // reads as A minor from the chroma and as C major from its own chords.
    const audio = await render(POP, { arpeggio: true });
    const readout = detectChordsFromAudio(audio.mix, SR, { tempo: TEMPO });
    assert(readout.key !== null, 'no key was estimated at all');
    assert(readout.key !== null && keyName(readout.key.key) === 'C Major',
      `C G Am F read as ${readout.key ? keyName(readout.key.key) : 'null'}`);

    // The chroma route on the same audio is the weaker one, and saying so is
    // what stops this check passing for the wrong reason.
    const gram = chromagram(audio.mix, SR);
    const grid = beatGrid(audio.mix.length / SR, TEMPO);
    const spans = beatChroma(gram.frames, gram.hopSec, grid.times);
    const average = new Float32Array(12);
    for (const span of spans) for (let k = 0; k < 12; k++) average[k] = (average[k] ?? 0) + (span[k] ?? 0);
    const fromChroma = keyFromChroma(average);
    assert(fromChroma !== null && keyName(fromChroma.key) !== 'C Major',
      `the chroma route also got it right (${fromChroma ? keyName(fromChroma.key) : 'null'}) — `
      + 'this fixture does not show why the chords are used');
    console.log(`      (조성: 코드에서 ${keyName(readout.key!.key)}, 크로마에서 ${keyName(fromChroma!.key)})`);
  });

  await check('the key reaches the session, not just a toast', () => {
    // A key that vanished with the message would have to be worked out again
    // by hand every time, and the Key Editor's scale and the note snapping
    // both want it.
    const src = stripComments(
      readFileSync(new URL('../src/renderer/daw/edit/chord-actions.ts', import.meta.url), 'utf8'));
    assert(/readout\.key/.test(src) && /key: readout\.key\.key/.test(src),
      'the detected key is not written onto the session');
    const types = stripComments(
      readFileSync(new URL('../src/renderer/daw/model/types.ts', import.meta.url), 'utf8'));
    assert(/key\?: Scale;/.test(types), 'the session has nowhere to put a key');
  });

  // ── Transpose and capo ────────────────────────────────────────────────────

  await check('transposing the chart takes the key with it', () => {
    // The key HAS to follow.  A chart moved up two semitones whose session
    // still says C major will spell the new accidentals wrong, hand the wrong
    // scale to the Key Editor and snap notes to a key the music has left —
    // all quietly, because nothing about it looks broken.
    const base = withChords(createSession(), [
      { id: 'a', timeSec: 0, chord: parseChord('C')! },
      { id: 'b', timeSec: 2, chord: parseChord('Am')! },
    ]);
    const session = { ...base, key: { root: 0, scaleId: 'major' } };
    const up = transposeChordTrack(session, 2);
    assert(formatChord(up.chordTrack[0]!.chord) === 'D',
      `C +2 → ${formatChord(up.chordTrack[0]!.chord)}`);
    assert(up.key?.root === 2 && up.key.scaleId === 'major',
      `the key went to ${up.key ? keyNameIn(up.key) : 'nothing'}`);

    // Down past zero has to wrap, not go negative.
    const down = transposeChordTrack(session, -2);
    assert(down.key?.root === 10, `C −2 → key root ${down.key?.root}`);
    assert(formatChord(down.chordTrack[0]!.chord) === 'A#',
      `C −2 → ${formatChord(down.chordTrack[0]!.chord)}`);

    // And a session with no key estimated must not gain one from being moved.
    const keyless = transposeChordTrack(base, 5);
    assert(keyless.key === undefined, 'transposing invented a key that was never estimated');
  });

  await check('transposing does not touch the capo', () => {
    // A capo is a statement about the player's hands, not about the music.
    // Someone who moves a chart up a tone has not moved their capo by doing it.
    const session = setCapo(withChords(createSession(), [
      { id: 'a', timeSec: 0, chord: parseChord('C')! },
    ]), 3);
    assert(session.capoFret === 3, 'setup: the capo did not take');
    assert(transposeChordTrack(session, 2).capoFret === 3, 'transposing moved the capo');
    assert(setCapo(session, 0).capoFret === undefined,
      'clearing the capo should remove it, not store a zero');
    assert(setCapo(session, 99).capoFret === MAX_CAPO_FRET, 'the capo ran off the neck');
  });

  await check('a capo lowers the shape, it does not raise it', () => {
    // The direction is the whole thing and it is easy to get backwards: a
    // capo RAISES what comes out, so to sound B♭ from the third fret you
    // finger the shape three semitones BELOW it.  Backwards, the chart is a
    // tritone out at fret 6 and looks plausible everywhere else.
    const bFlat = parseChord('A#')!;
    assert(formatChord(shapeFor(bFlat, 3)) === 'G',
      `B♭ with capo 3 should be a G shape, got ${formatChord(shapeFor(bFlat, 3))}`);
    assert(formatChord(shapeFor(parseChord('E')!, 4)) === 'C',
      `E with capo 4 → ${formatChord(shapeFor(parseChord('E')!, 4))}`);
    // And the shape, played at that fret, must sound the original back.
    for (const name of ['C', 'A#', 'F#m', 'Ebmaj7', 'G7']) {
      const chord = parseChord(name)!;
      for (let fret = 0; fret <= MAX_CAPO_FRET; fret++) {
        const back = transposeChord(shapeFor(chord, fret), fret);
        assert(formatChord(back) === formatChord(chord),
          `${name} through capo ${fret} came back as ${formatChord(back)}`);
      }
    }
  });

  await check('the capo suggestion is the one guitarists already know', () => {
    // B♭ major with a capo on 3 is G D Em C.  Every guitarist knows this one,
    // which makes it the right thing to check a heuristic against.
    const inBFlat = ['A#', 'F', 'Gm', 'D#'].map((n) => ({ chord: parseChord(n)! }));
    const best = suggestCapo(inBFlat);
    assert(best !== null && best.fret === 3,
      `B♭ suggested capo ${best?.fret ?? 'none'}`);
    assert(best!.shapes.map((c) => formatChord(c)).join(' ') === 'G D Em C',
      `capo 3 shapes came out ${best!.shapes.map((c) => formatChord(c)).join(' ')}`);
    assert(best!.openShare === 1, `only ${(best!.openShare * 100).toFixed(0)}% open`);

    // A chart that is already open gets no suggestion — advice that is not
    // worth taking should not be offered.
    assert(suggestCapo(['Dm7', 'G7', 'Cmaj7', 'Am7'].map((n) => ({ chord: parseChord(n)! }))) === null,
      'a chart that is already playable was told to fetch a capo');

    // And neither does a chart a capo would barely improve.  One barre chord
    // in eight bars is 88 % open already; capo 5 makes it 100 %, and nobody
    // stops to fit a capo for that.  Without a worth-it threshold this is the
    // case that produces confident, useless advice.
    const oneBarre = ['C', 'G', 'Am', 'F', 'C', 'G', 'Am', 'C']
      .map((n) => ({ chord: parseChord(n)! }));
    const options = capoOptions(oneBarre);
    const gain = (options[0]?.openShare ?? 0)
      - (options.find((o) => o.fret === 0)?.openShare ?? 0);
    assert(gain > 0 && gain < 0.2,
      `the fixture should offer a small gain, measured ${(gain * 100).toFixed(0)}%`);
    assert(suggestCapo(oneBarre) === null,
      `a ${(gain * 100).toFixed(0)}% gain was offered as advice — not worth interrupting for`);
  });

  await check('the capo is weighted by time, like everything else', () => {
    // A capo that makes the passing chord easy and the four-bar chord hard
    // has not helped.
    // Contrived on purpose, because the weighting is what is under test: two
    // chords that last four bars each and are only open at fret 1, against
    // six that last a beat between them and are only open at fret 3.  By the
    // clock the answer is fret 1; by the chord COUNT the short ones are the
    // majority and drag it to 3.
    const chords = [
      { chord: parseChord('C#')!, weight: 16 },
      { chord: parseChord('G#')!, weight: 16 },
      ...['C', 'G', 'C', 'G', 'C', 'G'].map((name) => ({
        chord: parseChord(name)!, weight: 0.25,
      })),
    ];
    const weighted = suggestCapo(chords);
    const flat = suggestCapo(chords.map((c) => ({ chord: c.chord })));
    assert(weighted !== null, 'no capo suggested for a chart full of barre chords');
    assert(weighted?.fret === 1, `the four-bar chords want fret 1, got ${weighted?.fret}`);
    // Counting chords equally, the six quick ones are the majority and they
    // are already open as written — so it concludes no capo is worth it, and
    // leaves the player barring the two chords they spend the song on.
    assert(flat === null,
      `counting chords equally suggested fret ${flat?.fret} — expected it to see no reason `
      + 'for a capo at all, which is the mistake the weighting exists to avoid');
  });

  await check('an open shape is an open shape, and a barre is not', () => {
    for (const name of ['C', 'D', 'E', 'G', 'A', 'Am', 'Em', 'Dm', 'G7', 'E7']) {
      assert(isOpenShape(parseChord(name)!), `${name} should be an open shape`);
    }
    for (const name of ['A#', 'C#', 'Fm', 'Bm', 'D#7', 'Cdim7', 'Caug']) {
      assert(!isOpenShape(parseChord(name)!), `${name} should need a barre or worse`);
    }
    // Every fret is offered, so a caller can show the whole neck.
    assert(capoOptions([{ chord: parseChord('C')! }]).length === MAX_CAPO_FRET + 1,
      'the capo options do not cover the neck');
  });

  await check('a chart in a flat key is spelled with flats', () => {
    // `formatChord` writes every accidental as a sharp because a pitch class
    // is a number.  On a chart that is wrong in a way musicians see instantly:
    // in F major the fourth chord is B♭ and nobody writes A♯ there.
    const fMajor = { root: 5, scaleId: 'major' };
    const bMajor = { root: 11, scaleId: 'major' };
    assert(keyUsesFlats(fMajor) && !keyUsesFlats(bMajor), 'the signatures are backwards');
    assert(spellPitchClass(10, fMajor) === 'Bb', `F major spelled 10 as ${spellPitchClass(10, fMajor)}`);
    assert(spellPitchClass(10, bMajor) === 'A#', `B major spelled 10 as ${spellPitchClass(10, bMajor)}`);
    assert(formatChordIn(parseChord('A#')!, fMajor) === 'Bb',
      `F major printed ${formatChordIn(parseChord('A#')!, fMajor)}`);
    assert(keyNameIn({ root: 10, scaleId: 'major' }) === 'Bb Major',
      `the key itself printed ${keyNameIn({ root: 10, scaleId: 'major' })}`);
    // A minor key takes its signature from its relative major.
    assert(keyUsesFlats({ root: 2, scaleId: 'aeolian' }),
      'D minor is one flat and should spell flats');
    assert(!keyUsesFlats({ root: 9, scaleId: 'aeolian' }),
      'A minor has no accidentals and should not go flat');

    // And `formatChord` itself must be left alone — the .lab writer, the
    // stored labels and every other test go through it.
    assert(formatChord(parseChord('A#')!) === 'A#',
      'formatChord was changed to spell flats — that moves the file format');
  });

  console.log('\n=== Chords from audio — did it name what was played? ===');
  for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  const bad = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
  if (bad) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
