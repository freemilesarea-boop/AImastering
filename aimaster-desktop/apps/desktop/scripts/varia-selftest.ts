/**
 * varia-selftest — vocal pitch analysis and editing (VARIAUDIO-1).
 *
 * Everything is driven with SYNTHESISED voices whose pitch, vibrato and drift
 * are known exactly, so the analyser can be held to a number rather than to
 * "sounds about right": a 220 Hz tone must read as A2 within a few cents, a
 * 5 Hz / 40-cent vibrato must come back as 5 Hz / 40 cents, and a note shifted
 * up two semitones must actually measure a major second higher after
 * rendering.
 *
 * Run: pnpm --filter @aimaster/desktop test:varia
 */

import {
  yinF0, analyzePitch, segmentPitch, analyzeVocal, decimate, median, linearSlope,
  measureVibrato, targetPitchAt, shiftSemitonesAt, curveCentsAt, withEdit,
  quantizePitch, quantizeToPitches, straighten, tuneToPitch, resetSegmentIds,
  NEUTRAL_EDIT, type VariSegment,
} from '../src/renderer/daw/audio/pitch-analysis.js';
import {
  correctSegment, guideNoteFor, guideNotesFor,
} from '../src/renderer/daw/audio/varia-actions.js';
import {
  describeTiming, editedSpan, isEdited, moveSegmentTime, resetSegmentTime, timingRange,
} from '../src/renderer/daw/edit/vocal-edit.js';
import { createNote } from '../src/renderer/daw/model/midi.js';
import {
  addTrack, createClip, createMidiPart, createSession, createTrack, updateClips,
} from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import { renderVariAudioChannel, isNeutral } from '../src/renderer/daw/audio/pitch-shift.js';
import { frequencyToPitch, pitchToFrequency, pitchName } from '../src/renderer/daw/model/midi.js';
import { scalePitchClasses } from '../src/renderer/daw/model/scales.js';
import { partClock } from '../src/renderer/daw/model/note-time.js';
import { defaultTempoMap } from '../src/renderer/daw/model/tempo-map.js';

const SR = 44_100;

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function eq<T>(a: T, b: T, m: string): void {
  if (a !== b) throw new Error(`${m} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}
function close(a: number, b: number, m: string, tol: number): void {
  if (Math.abs(a - b) > tol) throw new Error(`${m} — got ${a.toFixed(4)}, want ${b.toFixed(4)} ±${tol}`);
}

// ── Signal generators ─────────────────────────────────────────────────────────

interface ToneOptions {
  hz: number;
  seconds: number;
  /** Extra harmonics make it voice-like rather than a pure sine. */
  harmonics?: number;
  vibratoHz?: number;
  vibratoCents?: number;
  driftCents?: number;          // total drift across the note
  amplitude?: number;
}

function tone(options: ToneOptions): Float32Array {
  const {
    hz, seconds, harmonics = 4, vibratoHz = 0, vibratoCents = 0,
    driftCents = 0, amplitude = 0.5,
  } = options;
  const n = Math.floor(SR * seconds);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const vibrato = vibratoHz > 0 ? Math.sin(2 * Math.PI * vibratoHz * t) * vibratoCents : 0;
    const drift = seconds > 0 ? (driftCents * t) / seconds : 0;
    const f = hz * Math.pow(2, (vibrato + drift) / 1200);
    phase += (2 * Math.PI * f) / SR;
    let value = 0;
    for (let h = 1; h <= harmonics; h++) value += Math.sin(phase * h) / h;
    out[i] = value * amplitude * 0.6;
  }
  return out;
}

function silence(seconds: number): Float32Array {
  return new Float32Array(Math.floor(SR * seconds));
}

function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

/**
 * Measure the fundamental of a window with the same estimator the analyser
 * uses.  A hand-rolled autocorrelation in the test would have its own octave
 * errors and we would be debugging the ruler instead of the code.
 */
function measureHz(data: Float32Array, from: number, to: number): number {
  const slice = data.subarray(from, to);
  const { data: decimated, rate } = decimate(slice, SR, 16_000);
  const frameSize = Math.min(decimated.length, Math.round(0.06 * rate));
  const readings: number[] = [];
  for (let start = 0; start + frameSize <= decimated.length; start += Math.round(frameSize / 2)) {
    const { hz, confidence } = yinF0(decimated.subarray(start, start + frameSize), rate);
    if (hz > 0 && confidence > 0.5) readings.push(hz);
  }
  return readings.length > 0 ? median(readings) : 0;
}

const centsBetween = (a: number, b: number): number => 1200 * Math.log2(a / b);

// ── Helpers ───────────────────────────────────────────────────────────────────

check('decimation reduces the rate and keeps the signal', () => {
  const input = tone({ hz: 220, seconds: 0.2 });
  const { data, rate } = decimate(input, SR, 16_000);
  close(rate, SR / Math.round(SR / 16_000), 'decimated rate', 1);
  assert(data.length < input.length, 'shorter');
  let energy = 0;
  for (const v of data) energy += v * v;
  assert(energy > 0, 'signal survives');
  eq(decimate(input, SR, SR * 2).rate, SR, 'upsampling is refused, not faked');
});

check('median and slope are correct', () => {
  eq(median([3, 1, 2]), 2, 'odd');
  eq(median([4, 1, 2, 3]), 2.5, 'even');
  eq(median([]), 0, 'empty');
  close(linearSlope([{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 2, y: 4 }]), 2, 'slope', 1e-9);
  eq(linearSlope([{ x: 1, y: 5 }]), 0, 'one point');
});

// ── YIN ───────────────────────────────────────────────────────────────────────

check('YIN reads a steady pitch to within a few cents', () => {
  for (const hz of [110, 220, 440, 660]) {
    const signal = tone({ hz, seconds: 0.2 });
    const { data, rate } = decimate(signal, SR, 16_000);
    const frame = data.subarray(0, Math.round(0.04 * rate));
    const { hz: detected, confidence } = yinF0(frame, rate);
    const error = Math.abs(centsBetween(detected, hz));
    assert(error < 10, `${hz} Hz read as ${detected.toFixed(2)} (${error.toFixed(1)} cents off)`);
    assert(confidence > 0.6, `confident at ${hz} Hz — ${confidence.toFixed(2)}`);
  }
});

check('YIN reports no pitch for noise and silence', () => {
  const noise = new Float32Array(2048);
  let seed = 12345;
  for (let i = 0; i < noise.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    noise[i] = (seed / 0x3fffffff) - 1;
  }
  const noisy = yinF0(noise, 16_000);
  assert(noisy.confidence < 0.6, `noise is not confidently pitched — ${noisy.confidence.toFixed(2)}`);
  const quiet = yinF0(new Float32Array(2048), 16_000);
  assert(quiet.hz === 0 || quiet.confidence < 0.6, 'silence yields nothing');
});

// ── Frame track + segmentation ────────────────────────────────────────────────

check('the pitch track follows a sung line', () => {
  const line = concat(
    tone({ hz: 220, seconds: 0.4 }),
    silence(0.15),
    tone({ hz: 261.63, seconds: 0.4 }),
  );
  const frames = analyzePitch(line, SR);
  const voiced = frames.filter((f) => f.hz > 0);
  assert(voiced.length > 20, `voiced frames found — ${voiced.length}`);

  const early = voiced.filter((f) => f.timeSec < 0.35);
  const late = voiced.filter((f) => f.timeSec > 0.6);
  const earlyHz = median(early.map((f) => f.hz));
  const lateHz = median(late.map((f) => f.hz));
  assert(Math.abs(centsBetween(earlyHz, 220)) < 15, `first note ≈ A2 — ${earlyHz.toFixed(1)} Hz`);
  assert(Math.abs(centsBetween(lateHz, 261.63)) < 15, `second note ≈ C3 — ${lateHz.toFixed(1)} Hz`);
});

check('segmentation splits on silence and on pitch jumps', () => {
  resetSegmentIds();
  const line = concat(
    tone({ hz: 220, seconds: 0.35 }),
    silence(0.12),
    tone({ hz: 293.66, seconds: 0.35 }),
  );
  const segments = analyzeVocal(line, SR);
  eq(segments.length, 2, `two notes — got ${segments.length}`);
  const [first, second] = segments as [VariSegment, VariSegment];
  close(first.measured.medianPitch, frequencyToPitch(220), 'first pitch', 0.15);
  close(second.measured.medianPitch, frequencyToPitch(293.66), 'second pitch', 0.15);
  // 220 Hz is MIDI 57, which is A2 when middle C (60) is called C3.
  eq(pitchName(Math.round(first.measured.medianPitch)), 'A2', 'named in editor numbering');
  assert(second.startSec > first.endSec, 'second starts after the first ends');
  assert(first.measured.confidence > 0.6, 'confident');
});

check('a legato slide between two pitches is one segment with drift', () => {
  // 400 cents of drift over the note — a slide, not two notes.
  const slide = tone({ hz: 220, seconds: 0.7, driftCents: 400 });
  const segments = analyzeVocal(slide, SR, {}, { splitSemitones: 6 });
  assert(segments.length >= 1, 'at least one segment');
  const drift = segments[0]!.measured.driftCentsPerSec;
  assert(drift > 200, `rising drift detected — ${drift.toFixed(0)} cents/s`);
});

// ── Vibrato / drift measurement ───────────────────────────────────────────────

check('vibrato rate and depth come back as sung', () => {
  const sung = tone({ hz: 261.63, seconds: 1.2, vibratoHz: 5, vibratoCents: 40 });
  const segments = analyzeVocal(sung, SR, {}, { splitSemitones: 12 });
  assert(segments.length >= 1, 'one segment');
  const measured = segments[0]!.measured;
  close(measured.vibratoRateHz, 5, 'vibrato rate', 1.2);
  assert(measured.vibratoDepthCents > 20 && measured.vibratoDepthCents < 70,
    `vibrato depth ≈ 40 cents — got ${measured.vibratoDepthCents.toFixed(0)}`);
});

check('a straight note reports no vibrato', () => {
  const straightTone = tone({ hz: 220, seconds: 0.8 });
  const segments = analyzeVocal(straightTone, SR, {}, { splitSemitones: 12 });
  const measured = segments[0]!.measured;
  assert(measured.vibratoDepthCents < 15,
    `little modulation — ${measured.vibratoDepthCents.toFixed(1)} cents`);
});

check('measureVibrato ignores drift when finding the rate', () => {
  // A pure ramp has no oscillation, only slope.
  const curve = Array.from({ length: 60 }, (_, i) => ({ timeSec: i * 0.01, cents: i * 2 }));
  const rate = measureVibrato(curve, linearSlope(curve.map((p) => ({ x: p.timeSec, y: p.cents }))));
  assert(rate.depthCents < 5, `ramp is not vibrato — ${rate.depthCents.toFixed(1)}`);
});

// ── Edit model ────────────────────────────────────────────────────────────────

function syntheticSegment(): VariSegment {
  return {
    id: 'seg-test',
    startSec: 0,
    endSec: 1,
    measured: {
      medianPitch: 60,
      // +50 cents of drift plus a ±30-cent wobble.
      curve: Array.from({ length: 21 }, (_, i) => {
        const t = i / 20;
        return { timeSec: t, cents: 50 * t + 30 * Math.sin(2 * Math.PI * 5 * t) };
      }),
      confidence: 0.9,
      vibratoRateHz: 5,
      vibratoDepthCents: 30,
      driftCentsPerSec: 50,
    },
    edit: { ...NEUTRAL_EDIT },
  };
}

check('a neutral edit changes nothing', () => {
  const segment = syntheticSegment();
  assert(isNeutral(segment), 'flagged neutral');
  for (const t of [0, 0.25, 0.5, 1]) {
    close(shiftSemitonesAt(segment, t), 0, `no shift at ${t}`, 1e-9);
  }
});

check('pitch offset moves the whole note', () => {
  const segment = withEdit(syntheticSegment(), { pitchOffsetCents: 100 });
  assert(!isNeutral(segment), 'not neutral any more');
  for (const t of [0, 0.5, 1]) {
    close(shiftSemitonesAt(segment, t), 1, `+1 semitone at ${t}`, 1e-9);
  }
  close(targetPitchAt(segment, 0), 61 + curveCentsAt(segment.measured.curve, 0) / 100, 'target pitch', 1e-9);
});

check('straightening removes vibrato and drift but keeps the note', () => {
  const segment = straighten(syntheticSegment(), 1);
  close(targetPitchAt(segment, 0), 60, 'starts at the centre pitch', 1e-9);
  close(targetPitchAt(segment, 1), 60, 'ends at the centre pitch', 1e-9);
  close(targetPitchAt(segment, 0.37), 60, 'flat throughout', 1e-9);

  const half = straighten(syntheticSegment(), 0.5);
  const measured = 60 + curveCentsAt(half.measured.curve, 0.5) / 100;
  const target = targetPitchAt(half, 0.5);
  assert(Math.abs(target - 60) < Math.abs(measured - 60), 'half-straightened is closer to centre');
});

check('drift and vibrato scale independently', () => {
  const noDrift = withEdit(syntheticSegment(), { driftScale: 0 });
  // At t=1 the raw curve is 50 cents of drift + 0 wobble; killing drift zeroes it.
  close(targetPitchAt(noDrift, 1), 60, 'drift removed', 1e-9);

  const noVibrato = withEdit(syntheticSegment(), { vibratoScale: 0 });
  close(targetPitchAt(noVibrato, 1), 60 + 0.5, 'drift kept, wobble gone', 1e-9);
});

check('pitch quantise snaps to the nearest semitone or scale note', () => {
  const flat = { ...syntheticSegment() };
  flat.measured = { ...flat.measured, medianPitch: 60.4 };     // 40 cents sharp
  const snapped = quantizePitch(flat, 1);
  close(snapped.edit.pitchOffsetCents, -40, 'pulled back to C', 1e-6);
  const halfSnapped = quantizePitch(flat, 0.5);
  close(halfSnapped.edit.pitchOffsetCents, -20, 'half correction', 1e-6);

  // Snap into C major: 61.3 (C#) should land on D (62), not C.
  const offKey = { ...syntheticSegment() };
  offKey.measured = { ...offKey.measured, medianPitch: 61.3 };
  const inScale = quantizeToPitches(offKey, scalePitchClasses({ root: 0, scaleId: 'major' }), 1);
  close(inScale.edit.pitchOffsetCents, 70, 'snapped up to D', 1e-6);
});

// ── Rendering ─────────────────────────────────────────────────────────────────

check('rendering with no edits returns the input untouched', () => {
  const input = tone({ hz: 220, seconds: 0.5 });
  const segments = analyzeVocal(input, SR, {}, { splitSemitones: 12 });
  const output = renderVariAudioChannel(input, SR, segments);
  let maxDiff = 0;
  for (let i = 0; i < input.length; i++) {
    maxDiff = Math.max(maxDiff, Math.abs((output[i] ?? 0) - (input[i] ?? 0)));
  }
  close(maxDiff, 0, 'bit-identical pass-through', 1e-12);
});

check('a +2 semitone edit really raises the pitch by a major second', () => {
  const input = tone({ hz: 220, seconds: 0.8 });
  const segments = analyzeVocal(input, SR, {}, { splitSemitones: 12 });
  assert(segments.length >= 1, 'segment found');
  const edited = segments.map((s) => withEdit(s, { pitchOffsetCents: 200 }));
  const output = renderVariAudioChannel(input, SR, edited);

  const from = Math.floor(SR * 0.3);
  const to = Math.floor(SR * 0.6);
  const before = measureHz(input, from, to);
  const after = measureHz(output, from, to);
  close(before, 220, 'source pitch', 3);
  const shifted = centsBetween(after, before);
  close(shifted, 200, `rendered shift — ${after.toFixed(1)} Hz vs ${before.toFixed(1)} Hz`, 45);
});

check('a −3 semitone edit lowers it, and the length is preserved', () => {
  const input = tone({ hz: 330, seconds: 0.8 });
  const segments = analyzeVocal(input, SR, {}, { splitSemitones: 12 });
  const edited = segments.map((s) => withEdit(s, { pitchOffsetCents: -300 }));
  const output = renderVariAudioChannel(input, SR, edited);
  eq(output.length, input.length, 'duration unchanged');

  const from = Math.floor(SR * 0.3);
  const to = Math.floor(SR * 0.6);
  const shifted = centsBetween(measureHz(output, from, to), measureHz(input, from, to));
  close(shifted, -300, 'three semitones down', 55);
});

check('pitch correction lands an out-of-tune note on the target', () => {
  // 45 cents flat of A2 — the classic "fix this note" case.
  const flatHz = 220 * Math.pow(2, -45 / 1200);
  const input = tone({ hz: flatHz, seconds: 0.8 });
  const segments = analyzeVocal(input, SR, {}, { splitSemitones: 12 });
  const corrected = segments.map((s) => quantizePitch(s, 1));
  const output = renderVariAudioChannel(input, SR, corrected);

  const from = Math.floor(SR * 0.3);
  const to = Math.floor(SR * 0.6);
  const after = measureHz(output, from, to);
  const target = pitchToFrequency(Math.round(frequencyToPitch(flatHz)));
  const error = Math.abs(centsBetween(after, target));
  assert(error < 45, `corrected to ${after.toFixed(1)} Hz, target ${target.toFixed(1)} Hz (${error.toFixed(0)} cents off)`);
});

check('the renderer leaves unedited segments alone', () => {
  const input = concat(tone({ hz: 220, seconds: 0.5 }), silence(0.15), tone({ hz: 330, seconds: 0.5 }));
  const segments = analyzeVocal(input, SR, {}, { splitSemitones: 6 });
  assert(segments.length >= 2, 'two segments');
  const edited = [withEdit(segments[0]!, { pitchOffsetCents: 200 }), ...segments.slice(1)];
  const output = renderVariAudioChannel(input, SR, edited);

  const secondFrom = Math.floor(segments[1]!.startSec * SR) + 2000;
  const secondTo = Math.min(input.length, Math.floor(segments[1]!.endSec * SR) - 2000);
  let maxDiff = 0;
  for (let i = secondFrom; i < secondTo; i++) {
    maxDiff = Math.max(maxDiff, Math.abs((output[i] ?? 0) - (input[i] ?? 0)));
  }
  close(maxDiff, 0, 'the untouched note is bit-identical', 1e-12);
});

// ── MIDI-guided tuning ────────────────────────────────────────────────────────

/** A segment measured at `pitch`, spanning [start, end). */
function fakeSegment(pitch: number, startSec: number, endSec: number): VariSegment {
  return {
    id: `seg-${startSec}`,
    startSec,
    endSec,
    measured: {
      medianPitch: pitch,
      curve: [],
      confidence: 0.9,
      vibratoRateHz: 0,
      vibratoDepthCents: 0,
      driftCentsPerSec: 0,
    },
    edit: { ...NEUTRAL_EDIT },
  };
}

check('tuneToPitch moves a segment onto a named target', () => {
  // Sung at 59.6 (just under B3), the guide says 60 (C4).
  const segment = fakeSegment(59.6, 0, 0.5);
  const tuned = tuneToPitch(segment, 60, 1);
  close(tuned.edit.pitchOffsetCents, 40, 'forty cents up', 1e-6);
  // Half the amount is half the move — the performance keeps some of itself.
  close(tuneToPitch(segment, 60, 0.5).edit.pitchOffsetCents, 20, 'partial correction', 1e-6);
});

check('a guide note far from what was sung is refused, not dragged', () => {
  // Sung a fifth below the guide: that is an alignment mistake, not a
  // correction anybody wants.
  const segment = fakeSegment(60, 0, 0.5);
  eq(tuneToPitch(segment, 67, 1, 3), segment, 'left exactly as it was');
  assert(tuneToPitch(segment, 62, 1, 3) !== segment, 'but a whole tone is fine');
});

/**
 * A guide part's frame at 60 BPM, where a beat is a second.
 *
 * The comparison these tests are about is audio seconds against written
 * beats; at this tempo the two read alike, so the numbers stay legible
 * while the real conversion still runs.
 */
const GUIDE_CLOCK = partClock(defaultTempoMap(60), 0);

check('the guide note is the one with the most overlap', () => {
  const notes = [
    createNote({ pitch: 60, startBeat: 0, durationBeat: 1.0 }),
    createNote({ pitch: 64, startBeat: 0.9, durationBeat: 1.0 }),
  ];
  // A segment running 0.2–0.95 overlaps the first note far more than the
  // second — picking the first note that starts would retune it to the wrong
  // one at the end of a long held note.
  eq(guideNoteFor(notes, GUIDE_CLOCK, 0.2, 0.95)?.pitch, 60, 'the note it mostly sits under');
  eq(guideNoteFor(notes, GUIDE_CLOCK, 0.95, 1.8)?.pitch, 64, 'and the next one after that');
  eq(guideNoteFor(notes, GUIDE_CLOCK, 5, 6), null, 'nothing sounding there');
  eq(guideNoteFor([createNote({ pitch: 60, muted: true })], GUIDE_CLOCK, 0, 0.5), null, 'a muted guide is no guide');
});

check('a segment with no guide note over it is left alone', () => {
  const segment = fakeSegment(58.5, 2, 2.4);
  const notes = [createNote({ pitch: 60, startBeat: 0, durationBeat: 1 })];
  const corrected = correctSegment(segment, { kind: 'toMidi', notes, amount: 1, clock: GUIDE_CLOCK });
  eq(corrected, segment, 'between phrases the singer is on their own');
});

check('toMidi tunes to the guide, not to the nearest semitone', () => {
  // Sung at 61.4 — nearest semitone is 61, but the melody says 60.
  const segment = fakeSegment(61.4, 0, 0.5);
  const notes = [createNote({ pitch: 60, startBeat: 0, durationBeat: 1 })];

  const toGuide = correctSegment(segment, { kind: 'toMidi', notes, amount: 1, clock: GUIDE_CLOCK });
  close(toGuide.edit.pitchOffsetCents, -140, 'down to the written note', 1e-6);

  const toNearest = quantizePitch(segment, 1);
  close(toNearest.edit.pitchOffsetCents, -40, 'the nearest semitone is somewhere else entirely', 1e-6);
});

check('guide notes are translated into the audio clip\'s own time base', () => {
  resetIds();
  // 60 BPM, so a beat is a second and the timings below can be read as
  // the seconds of audio they line up with.
  const base = { ...createSession('guide test'), tempoBpm: 60 };
  const audioTrack = createTrack('Vox', 'audio');
  const midiTrack = createTrack('Guide', 'instrument');
  let session = addTrack(addTrack(base, audioTrack), midiTrack);

  // The audio starts at 8 s; the guide part starts at 10 s with a note at
  // its own 0.5 s.  In the audio clip's time that note is at 2.5 s.
  const audioClip = createClip('f1', 'Vox', { startSec: 8, durationSec: 6 });
  const guidePart = createMidiPart('Guide', {
    startSec: 10,
    durationSec: 4,
    notes: [createNote({ pitch: 67, startBeat: 0.5, durationBeat: 1 })],
  });
  session = updateClips(session, audioTrack.id, () => [audioClip]);
  session = updateClips(session, midiTrack.id, () => [guidePart]);

  const notes = guideNotesFor(session, audioClip, midiTrack.id, guidePart.id);
  eq(notes.length, 1, 'one guide note');
  // Two seconds between the clips, which at 60 BPM is two beats, plus
  // the note's own half-beat inside its part.
  close(notes[0]?.startBeat ?? -1, 2.5, 'moved into the audio clip\'s clock', 1e-9);
  eq(guideNotesFor(session, audioClip, audioTrack.id, audioClip.id).length, 0,
    'an audio clip is not a guide');
});

// ── Moving a note in time ─────────────────────────────────────────────────────
//
// The axis that was in the model, honoured by the renderer, drawn by the
// editor — and unreachable, because nothing could set it.  What these tests
// hold is the rule that makes it safe: a note cannot pass its neighbours,
// because the renderer lays each segment's grains into that segment's own
// span and two overlapping spans are two passes writing the same samples.

/** Three one-second notes with a quarter-second gap between them. */
function phrase(): VariSegment[] {
  return [0, 1.25, 2.5].map((startSec, i) => ({
    ...syntheticSegment(),
    id: `seg-${i}`,
    startSec,
    endSec: startSec + 1,
  }));
}
const only = (...ids: string[]): Set<string> => new Set(ids);

check('a note moves in time, and the span moves with it', () => {
  const list = phrase();
  const moved = moveSegmentTime(list, only('seg-1'), 0.1, 4);
  close(moved.deltaSec, 0.1, 'the whole move landed', 1e-9);
  eq(moved.clamped, false, 'nothing stopped it');
  const span = editedSpan(moved.segments[1]!);
  close(span.startSec, 1.35, 'the start moved', 1e-9);
  close(span.endSec, 2.35, 'and so did the end', 1e-9);
  close(editedSpan(moved.segments[0]!).startSec, 0, 'the others did not', 1e-9);
});

check('a note cannot pass its neighbour — it stops against it', () => {
  const list = phrase();
  // seg-1 ends at 2.25 and seg-2 starts at 2.5: a quarter second of room.
  const far = moveSegmentTime(list, only('seg-1'), 2, 4);
  eq(far.clamped, true, 'it was stopped');
  close(far.deltaSec, 0.25, 'exactly at the neighbour', 1e-9);
  close(editedSpan(far.segments[1]!).endSec, 2.5, 'touching, not overlapping', 1e-9);
  // And backwards against the one before.
  const back = moveSegmentTime(list, only('seg-1'), -2, 4);
  close(back.deltaSec, -0.25, 'the same room on the other side', 1e-9);
  close(editedSpan(back.segments[1]!).startSec, 1, 'up against the first note', 1e-9);
});

check('the clip’s own ends are as hard a limit as a neighbour', () => {
  const list = phrase();
  const off = moveSegmentTime(list, only('seg-2'), 5, 4);      // clip is 4 s
  eq(off.clamped, true, 'stopped');
  close(editedSpan(off.segments[2]!).endSec, 4, 'at the end of the clip', 1e-9);
  const before = moveSegmentTime(list, only('seg-0'), -5, 4);
  close(editedSpan(before.segments[0]!).startSec, 0, 'and not before the start', 1e-9);
});

check('a phrase moves as one, limited by what is OUTSIDE it', () => {
  // Moving two notes together must not be stopped by each other.
  const list = phrase();
  const moved = moveSegmentTime(list, only('seg-0', 'seg-1'), 0.2, 4);
  eq(moved.clamped, false, `the pair had room: ${moved.deltaSec}`);
  close(editedSpan(moved.segments[0]!).startSec, 0.2, 'the first moved', 1e-9);
  close(editedSpan(moved.segments[1]!).startSec, 1.45, 'the second moved the same', 1e-9);
  // And the limit is seg-2, which is not moving.
  const far = moveSegmentTime(list, only('seg-0', 'seg-1'), 2, 4);
  close(far.deltaSec, 0.25, 'stopped by the note that stayed behind', 1e-9);
});

check('the room available is reported before anything moves', () => {
  const list = phrase();
  const range = timingRange(list, only('seg-1'), 4);
  close(range.minDelta, -0.25, 'a quarter second back', 1e-9);
  close(range.maxDelta, 0.25, 'and a quarter second forward', 1e-9);
  const stuck = timingRange(
    [{ ...syntheticSegment(), id: 'a', startSec: 0, endSec: 1 },
     { ...syntheticSegment(), id: 'b', startSec: 1, endSec: 2 }],
    only('a'), 2);
  close(stuck.maxDelta, 0, 'a note already touching the next has nowhere to go', 1e-9);
});

check('a drag that goes out and comes back lands where it started', () => {
  // The base offsets are the gesture's frozen start.  Without them the range
  // is measured from the CURRENT position each time and the note ratchets
  // forward against its neighbour instead of returning.
  const list = phrase();
  const base = new Map([['seg-1', 0]]);
  const out = moveSegmentTime(list, only('seg-1'), 2, 4, base);      // clamped to +0.25
  const backAgain = moveSegmentTime(out.segments, only('seg-1'), 0, 4, base);
  close(backAgain.segments[1]!.edit.timeOffsetSec, 0, 'exactly back to zero', 1e-9);
  const half = moveSegmentTime(out.segments, only('seg-1'), 0.1, 4, base);
  close(half.segments[1]!.edit.timeOffsetSec, 0.1, 'and a smaller move is absolute, not additive', 1e-9);
});

check('a timing move counts as an edit, and can be undone on its own', () => {
  const list = phrase();
  const moved = moveSegmentTime(list, only('seg-1'), 0.05, 4).segments;
  assert(isEdited(moved[1]!), 'the note is edited');
  const cleared = resetSegmentTime(moved, only('seg-1'));
  close(cleared[1]!.edit.timeOffsetSec, 0, 'the timing is back', 1e-9);
  eq(isEdited(cleared[1]!), false, 'and nothing else was touched');
});

check('the read-out is milliseconds, signed', () => {
  const list = phrase();
  eq(describeTiming(list[0]!), '0 ms', 'unmoved');
  const late = moveSegmentTime(list, only('seg-1'), 0.012, 4).segments;
  eq(describeTiming(late[1]!), '+12 ms', 'late');
  const early = moveSegmentTime(list, only('seg-1'), -0.012, 4).segments;
  eq(describeTiming(early[1]!), '−12 ms', 'early');
});

check('an empty selection and a nonsense delta do nothing at all', () => {
  const list = phrase();
  const none = moveSegmentTime(list, new Set(), 0.1, 4);
  eq(none.deltaSec, 0, 'no move');
  eq(none.segments.length, 3, 'and the list is intact');
  const nan = moveSegmentTime(list, only('seg-1'), Number.NaN, 4);
  eq(nan.deltaSec, 0, 'NaN moves nothing');
  close(nan.segments[1]!.edit.timeOffsetSec, 0, 'and writes nothing', 1e-9);
});

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== VariAudio core (pitch analysis · edit model · PSOLA render) ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
