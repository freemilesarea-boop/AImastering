/**
 * midi-selftest — the MIDI layer (MIDI-CORE-1).
 *
 * Covers the model (MIDI 2.0 / MPE value handling and per-note expression),
 * the editing verbs (quantize · humanize · length · velocity · transpose),
 * the scale engine, the chord/harmony engine, and Standard MIDI File
 * import/export including MPE lifting.
 *
 * Run: pnpm --filter @aimaster/desktop test:midi
 */

import {
  from7bit, to7bit, from14bit, to14bit, from32bit, to32bit,
  bendFrom14bit, bendTo14bit, createNote, resetNoteIds, noteEndBeat, sortNotes,
  pitchName, isBlackKey, pitchToFrequency, frequencyToPitch, curveValueAt,
  setExpression, removeExpression, findExpression, pitchOffsetAt, noteExpressionAt,
  targetKey, targetLabel, soundingPitch, DEFAULT_MIDI_CONFIG,
  type MidiNote,
} from '../src/renderer/daw/model/midi.js';
import {
  SCALES, scalePitchClasses, isInScale, scaleDegree, snapPitchToScale,
  suggestScales, detectScale, scaleName, pitchClass, type Scale,
} from '../src/renderer/daw/model/scales.js';
import {
  parseChord, formatChord, detectChord, chordPitchClasses, voiceChord,
  transposeChord, jazzifyChord, simplifyChord, tritoneSub, relatedTwo,
  reharmonize, formatProgression, chordAt, chordScales, makeChord,
  type ChordEvent,
} from '../src/renderer/daw/model/chords.js';
import {
  addNote, deleteNotes, moveNotes, resizeNotes, setVelocity, nudgeVelocity,
  scaleVelocityRange, velocityRamp, transposeNotes, quantizePitches,
  quantizeNotes, nearestGridTime, humanizeNotes, applyLegato, scaleLegato,
  fixedLengths, extendToNextSelected, deleteOverlapsMono, deleteOverlapsPoly,
  pedalsToNoteLength, splitNotesAt, glueNotes, notesAt, noteBounds, makeRng,
} from '../src/renderer/daw/edit/midi-edit.js';
import {
  parseMidiFile, importMidiFile, exportMidiFile, makeTickToSeconds,
  fileTempoBpm, looksLikeMpe, trackToPart,
} from '../src/renderer/daw/io/midi-file.js';

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
function close(a: number, b: number, m: string, tol = 1e-6): void {
  if (Math.abs(a - b) > tol) throw new Error(`${m} — got ${a}, want ${b} ±${tol}`);
}
const ids = (...notes: MidiNote[]): Set<string> => new Set(notes.map((n) => n.id));
const allIds = (notes: readonly MidiNote[]): Set<string> => new Set(notes.map((n) => n.id));

// ── Model ─────────────────────────────────────────────────────────────────────

check('value conversions round-trip across MIDI 1.0 and 2.0 resolutions', () => {
  eq(to7bit(from7bit(100)), 100, '7-bit');
  eq(to14bit(from14bit(9000)), 9000, '14-bit');
  eq(to32bit(from32bit(1234567890)), 1234567890, '32-bit');
  close(from7bit(127), 1, 'full scale');
  close(from7bit(0), 0, 'zero');
  eq(bendTo14bit(bendFrom14bit(8192)), 8192, 'bend centre');
  close(bendFrom14bit(16383), 1, 'bend max', 1e-3);
  close(bendFrom14bit(0), -1, 'bend min');
  eq(to7bit(from7bit(200)), 127, 'out-of-range clamps');
});

check('pitch naming follows the editor (60 = C3) and black keys are right', () => {
  eq(pitchName(60), 'C3', 'middle C');
  eq(pitchName(61), 'C#3', 'C sharp');
  eq(pitchName(48), 'C2', 'octave below');
  eq(pitchName(72), 'C4', 'octave above');
  assert(isBlackKey(61) && isBlackKey(66), 'sharps are black');
  assert(!isBlackKey(60) && !isBlackKey(64), 'naturals are white');
});

check('pitch ↔ frequency round-trips at concert pitch', () => {
  close(pitchToFrequency(69), 440, 'A3 = 440 Hz');
  close(pitchToFrequency(60), 261.6255653, 'middle C', 1e-4);
  close(frequencyToPitch(pitchToFrequency(53.4)), 53.4, 'round trip', 1e-9);
});

check('per-note expression is stored, replaced and removed by target', () => {
  resetNoteIds();
  let note = createNote({ durationBeat: 1 });
  note = setExpression(note, {
    target: { kind: 'pitchBend' },
    points: [{ timeBeat: 1, value: 1 }, { timeBeat: 0, value: 0 }],
  });
  eq(note.expression.length, 1, 'one curve');
  eq(findExpression(note, { kind: 'pitchBend' })?.points[0]?.timeBeat, 0, 'points sorted on insert');

  note = setExpression(note, { target: { kind: 'timbre' }, points: [{ timeBeat: 0, value: 0.5 }] });
  eq(note.expression.length, 2, 'second target coexists');
  note = setExpression(note, { target: { kind: 'pitchBend' }, points: [{ timeBeat: 0, value: -1 }] });
  eq(note.expression.length, 2, 'same target replaces');
  eq(findExpression(note, { kind: 'pitchBend' })?.points.length, 1, 'replaced curve');

  note = removeExpression(note, { kind: 'timbre' });
  eq(note.expression.length, 1, 'removed');
  eq(removeExpression(note, { kind: 'timbre' }), note, 'removing what is absent is identity');
});

check('expression targets have stable keys and readable labels', () => {
  eq(targetKey({ kind: 'cc', controller: 74 }), 'cc:74', 'cc key');
  eq(targetKey({ kind: 'pitchBend' }), 'pitchBend', 'bend key');
  eq(targetLabel({ kind: 'cc', controller: 1 }), 'Modulation', 'named CC');
  eq(targetLabel({ kind: 'cc', controller: 33 }), 'CC 33', 'unnamed CC');
  eq(targetLabel({ kind: 'pressure' }), 'Aftertouch', 'pressure');
});

check('curves interpolate linearly with flat ends', () => {
  const points = [{ timeBeat: 0, value: 0 }, { timeBeat: 2, value: 1 }];
  close(curveValueAt(points, -1, 0.5), 0, 'before start');
  close(curveValueAt(points, 1, 0.5), 0.5, 'midpoint');
  close(curveValueAt(points, 9, 0.5), 1, 'after end');
  close(curveValueAt([], 1, 0.42), 0.42, 'empty → fallback');
});

check('pitch offset folds the static offset with the bend curve and range', () => {
  resetNoteIds();
  let note = createNote({ durationBeat: 1, pitchOffsetSemitones: 0.25 });
  note = setExpression(note, {
    target: { kind: 'pitchBend' },
    points: [{ timeBeat: 0, value: 0 }, { timeBeat: 1, value: 1 }],
  });
  close(pitchOffsetAt(note, 0, DEFAULT_MIDI_CONFIG), 0.25, 'start = static only');
  close(pitchOffsetAt(note, 1, { ...DEFAULT_MIDI_CONFIG, bendRangeSemitones: 2 }), 2.25, '±2 range');
  // MPE's default ±48 makes the same curve a four-octave sweep.
  close(pitchOffsetAt(note, 1, { bendRangeSemitones: 48, mpe: true }), 48.25, 'MPE range');
  close(soundingPitch({ ...note, pitch: 60 }), 60.25, 'sounding pitch includes the offset');
  close(noteExpressionAt(note, { kind: 'pressure' }, 0.5, 0.7), 0.7, 'absent curve → fallback');
});

// ── Scales ────────────────────────────────────────────────────────────────────

check('scale tables are well formed', () => {
  for (const s of SCALES) {
    assert(s.intervals[0] === 0, `${s.id} starts at the root`);
    assert(s.intervals.every((i) => i >= 0 && i < 12), `${s.id} stays inside an octave`);
    assert(new Set(s.intervals).size === s.intervals.length, `${s.id} has no duplicates`);
  }
});

check('C Aeolian contains the right pitch classes', () => {
  const scale: Scale = { root: 0, scaleId: 'aeolian' };
  const pcs = [...scalePitchClasses(scale)].sort((a, b) => a - b);
  eq(pcs.join(','), '0,2,3,5,7,8,10', 'C natural minor');
  eq(scaleName(scale), 'C Aeolian (nat. min.)', 'display name');
  assert(isInScale(63, scale), 'D#3 is in C minor');
  assert(!isInScale(64, scale), 'E3 is not');
  eq(scaleDegree(67, scale), 5, 'G is the fifth degree');
  eq(scaleDegree(64, scale), null, 'outside → null');
});

check('snapping to a scale respects direction and ties downward', () => {
  const scale: Scale = { root: 0, scaleId: 'major' };
  eq(snapPitchToScale(60, scale), 60, 'already in scale');
  eq(snapPitchToScale(61, scale), 60, 'C# → C (tie goes down)');
  eq(snapPitchToScale(61, scale, 'up'), 62, 'forced up');
  eq(snapPitchToScale(61, scale, 'down'), 60, 'forced down');
  eq(snapPitchToScale(66, scale, 'up'), 67, 'F# → G upward');
});

check('scale suggestions rank the real key first', () => {
  // A C-major melody: C D E F G A B C
  const melody = [60, 62, 64, 65, 67, 69, 71, 72].map((pitch) => ({ pitch }));
  const top = suggestScales(melody, 5);
  assert(top.length > 0, 'got suggestions');
  const best = top[0]!;
  eq(pitchClass(best.scale.root), 0, 'root C');
  eq(best.scale.scaleId, 'major', 'major');
  assert(best.score > 0.85, `confident — ${best.score.toFixed(2)}`);
});

check('duration weighting separates a key from its relative minor', () => {
  // Same pitch classes, but the A minor material dwells on A and ends there.
  const aMinor = [
    { pitch: 69, weight: 4 }, { pitch: 72, weight: 1 }, { pitch: 76, weight: 1 },
    { pitch: 71, weight: 1 }, { pitch: 67, weight: 1 }, { pitch: 69, weight: 4 },
  ];
  const detected = detectScale(aMinor);
  eq(pitchClass(detected?.root ?? -1), 9, 'root A');
  eq(detectScale([]), null, 'no input → null');
});

// ── Chords ────────────────────────────────────────────────────────────────────

check('chord symbols parse and format back to themselves', () => {
  for (const text of ['C', 'Cm', 'Cmaj7', 'C7', 'Cm7', 'Cm7b5', 'Cdim7', 'C7sus4', 'Cm9', 'C13']) {
    const parsed = parseChord(text);
    assert(parsed !== null, `parsed ${text}`);
    eq(formatChord(parsed!), text, `round trip ${text}`);
  }
  eq(formatChord(parseChord('F#m7')!), 'F#m7', 'sharp root');
  eq(parseChord('Hmaj7'), null, 'invalid root');
  eq(parseChord('Cwat'), null, 'unknown quality');
});

check('slash chords keep their bass', () => {
  const chord = parseChord('Em9/D');
  assert(chord !== null, 'parsed');
  eq(chord!.root, 4, 'root E');
  eq(chord!.bass, 2, 'bass D');
  eq(formatChord(chord!), 'Em9/D', 'formatted');
  assert(chordPitchClasses(chord!).has(2), 'bass is part of the sound');
});

check('chord detection reads triads, sevenths and inversions', () => {
  eq(formatChord(detectChord([60, 64, 67])!.chord), 'C', 'C major triad');
  eq(formatChord(detectChord([60, 63, 67])!.chord), 'Cm', 'C minor triad');
  eq(formatChord(detectChord([60, 64, 67, 71])!.chord), 'Cmaj7', 'Cmaj7');
  eq(formatChord(detectChord([60, 64, 67, 70])!.chord), 'C7', 'C7');
  eq(formatChord(detectChord([62, 65, 69, 72])!.chord), 'Dm7', 'Dm7');
  eq(detectChord([]), null, 'nothing sounding');
  // The Key Editor's chord display: E minor 9 over D.
  const overD = detectChord([50, 55, 59, 64, 66]);
  assert(overD !== null && overD.chord.bass === 2, 'bass note detected as D');
});

check('voicings put the chord above a chosen bottom note', () => {
  const voiced = voiceChord(makeChord(0, 'maj7'), 48);
  eq(voiced.join(','), '48,52,55,59', 'C2 maj7');
  const slash = voiceChord(parseChord('C/G')!, 48);
  assert(slash[0]! < slash[1]!, 'bass sits below the chord');
});

check('harmony transforms do what their names say', () => {
  eq(formatChord(transposeChord(parseChord('Cmaj7')!, 2)), 'Dmaj7', 'transpose');
  eq(formatChord(jazzifyChord(parseChord('C')!)), 'Cmaj7', 'triad → maj7');
  eq(formatChord(jazzifyChord(parseChord('Am')!)), 'Am7', 'minor → m7');
  eq(formatChord(jazzifyChord(parseChord('G7')!)), 'G9', 'dominant → 9');
  eq(formatChord(simplifyChord(parseChord('Cmaj9')!)), 'C', 'simplify');
  eq(formatChord(tritoneSub(parseChord('G7')!)), 'C#7', 'tritone sub');
  eq(formatChord(tritoneSub(parseChord('Cmaj7')!)), 'Cmaj7', 'only dominants are substituted');
  eq(formatChord(relatedTwo(parseChord('G7')!)), 'Dm7', 'related ii');
});

check('reharmonize rewrites a progression the way the panel promises', () => {
  const progression: ChordEvent[] = [
    { id: 'a', timeSec: 0, chord: parseChord('Cmaj7')! },
    { id: 'b', timeSec: 2, chord: parseChord('Am7')! },
    { id: 'c', timeSec: 4, chord: parseChord('Dm7')! },
    { id: 'd', timeSec: 6, chord: parseChord('G7')! },
  ];
  eq(formatProgression(progression), 'Cmaj7 → Am7 → Dm7 → G7', 'baseline');

  const extended = reharmonize(progression, { extend: true });
  eq(formatProgression(extended), 'Cmaj7 → Am7 → Dm7 → G9', 'extend upgrades the dominant');

  const tritoned = reharmonize(progression, { tritone: true });
  eq(formatProgression(tritoned), 'Cmaj7 → Am7 → Dm7 → C#7', 'tritone sub on the V');

  const twoFive = reharmonize(progression, { insertTwoFive: true });
  eq(formatProgression(twoFive), 'Cmaj7 → Am7 → Dm7 → Dm7 → G7', 'ii inserted before the V');
  eq(twoFive.length, 5, 'one event added');
});

check('chordAt reads the progression at a moment; chordScales suggests scales', () => {
  const events: ChordEvent[] = [
    { id: 'a', timeSec: 0, chord: parseChord('Cmaj7')! },
    { id: 'b', timeSec: 4, chord: parseChord('G7')! },
  ];
  eq(formatChord(chordAt(events, 2)!.chord), 'Cmaj7', 'first chord still sounding');
  eq(formatChord(chordAt(events, 5)!.chord), 'G7', 'second chord');
  eq(chordAt(events, -1), null, 'before the first chord');
  eq(chordScales(parseChord('G7')!)[0]?.scaleId, 'mixolydian', 'dominant → mixolydian');
  eq(chordScales(parseChord('Am7')!)[0]?.scaleId, 'dorian', 'minor → dorian');
});

// ── Note editing ──────────────────────────────────────────────────────────────

function scale16(count: number, step = 0.25): MidiNote[] {
  resetNoteIds();
  return Array.from({ length: count }, (_, i) => createNote({
    pitch: 60 + i,
    startBeat: i * step,
    durationBeat: step * 0.5,
    velocity: from7bit(100),
  }));
}

check('notes are added, deleted and kept in time order', () => {
  resetNoteIds();
  let notes = addNote([], { pitch: 64, startBeat: 1 });
  notes = addNote(notes, { pitch: 60, startBeat: 0 });
  eq(notes.map((n) => n.pitch).join(','), '60,64', 'sorted by time');
  notes = deleteNotes(notes, new Set([notes[0]!.id]));
  eq(notes.length, 1, 'deleted');
});

check('moving notes snaps to grid and, optionally, to a scale', () => {
  const notes = scale16(2, 1);
  const moved = moveNotes(notes, allIds(notes), { deltaBeat: 0.13, gridBeat: 0.25 });
  close(moved[0]!.startBeat, 0.25, 'snapped to the grid');
  const snapped = moveNotes(notes, allIds(notes), {
    deltaPitch: 1, scale: { root: 0, scaleId: 'major' },
  });
  eq(snapped[0]!.pitch, 60, 'C# pulled back to C by scale snap');
  eq(snapped[1]!.pitch, 62, 'D is already in the scale');
});

check('velocity edits: set, nudge, compress and ramp', () => {
  const notes = scale16(3);
  const set = setVelocity(notes, allIds(notes), 0.5);
  close(set[0]!.velocity, 0.5, 'set');
  const nudged = nudgeVelocity(set, allIds(set), 0.25);
  close(nudged[0]!.velocity, 0.75, 'nudged');
  eq(nudgeVelocity(set, allIds(set), 5)[0]!.velocity, 1, 'clamped at full');

  const varied = [
    { ...notes[0]!, velocity: 0.2 }, { ...notes[1]!, velocity: 0.8 }, { ...notes[2]!, velocity: 0.5 },
  ];
  const flat = scaleVelocityRange(varied, allIds(varied), 0);
  close(flat[0]!.velocity, 0.5, 'flattened to the mean');
  close(flat[1]!.velocity, 0.5, 'all equal');

  const ramp = velocityRamp(notes, allIds(notes), 0.2, 1);
  close(ramp[0]!.velocity, 0.2, 'ramp start');
  close(ramp[2]!.velocity, 1, 'ramp end');
  close(ramp[1]!.velocity, 0.6, 'ramp middle');
});

check('transpose can correct into a scale and stay inside a register', () => {
  const notes = scale16(1);
  eq(transposeNotes(notes, allIds(notes), { semitones: 3 })[0]!.pitch, 63, 'plain transpose');
  eq(transposeNotes(notes, allIds(notes), {
    semitones: 1, scale: { root: 0, scaleId: 'major' },
  })[0]!.pitch, 60, 'scale correction pulls C# back');
  eq(transposeNotes(notes, allIds(notes), {
    semitones: 24, keepInRange: { lowest: 48, highest: 72 },
  })[0]!.pitch, 72, 'folded back into the register');
  eq(quantizePitches([{ ...notes[0]!, pitch: 61 }], allIds(notes), { root: 0, scaleId: 'major' })[0]!.pitch,
    60, 'quantize pitches');
});

// ── Quantize ──────────────────────────────────────────────────────────────────

check('the grid line search handles straight, tuplet and swung grids', () => {
  const straight = { gridBeat: 0.25 };
  close(nearestGridTime(0.26, straight), 0.25, 'nearest line');
  close(nearestGridTime(0.13, straight), 0.25, 'rounds up past halfway');
  const triplet = { gridBeat: 0.25, tuplet: 3 };
  close(nearestGridTime(0.17, triplet), 1 / 6, 'triplet line', 1e-6);
  const swung = { gridBeat: 0.25, swingPercent: 100 };
  close(nearestGridTime(0.3, swung), 0.375, 'off-beat pushed late');
  close(nearestGridTime(0.02, swung), 0, 'down-beat unmoved');
});

check('quantize honours strength, catch range and safe range', () => {
  resetNoteIds();
  const notes = [
    createNote({ startBeat: 0.03, durationBeat: 0.1 }),     // slightly late
    createNote({ startBeat: 0.6,  durationBeat: 0.1 }),     // far from any line
  ];
  const full = quantizeNotes(notes, allIds(notes), { gridBeat: 0.25 });
  close(full[0]!.startBeat, 0, 'snapped hard');

  const soft = quantizeNotes(notes, allIds(notes), { gridBeat: 0.25, strengthPercent: 50 });
  close(soft[0]!.startBeat, 0.015, 'moved half way');

  const caught = quantizeNotes(notes, allIds(notes), { gridBeat: 0.25, catchRangeBeat: 0.02 });
  close(caught[0]!.startBeat, 0.03, 'outside the catch range → untouched');

  const safe = quantizeNotes(notes, allIds(notes), { gridBeat: 0.25, safeRangeBeat: 0.05 });
  close(safe[0]!.startBeat, 0.03, 'inside the safe range → untouched');
});

check('quantize can snap lengths and ends', () => {
  resetNoteIds();
  const notes = [createNote({ startBeat: 0, durationBeat: 0.31 })];
  const lengths = quantizeNotes(notes, allIds(notes), { gridBeat: 0.25, quantizeLengths: true });
  close(lengths[0]!.durationBeat, 0.25, 'length snapped');
  const ends = quantizeNotes(notes, allIds(notes), { gridBeat: 0.25, quantizeEnds: true });
  close(ends[0]!.startBeat + ends[0]!.durationBeat, 0.25, 'end snapped');
});

// ── Humanize ──────────────────────────────────────────────────────────────────

check('humanize is deterministic for a seed and different across seeds', () => {
  const notes = scale16(8);
  const a = humanizeNotes(notes, allIds(notes), { seed: 42 });
  const b = humanizeNotes(notes, allIds(notes), { seed: 42 });
  const c = humanizeNotes(notes, allIds(notes), { seed: 7 });
  eq(JSON.stringify(a), JSON.stringify(b), 'same seed → identical (bounce reproduces)');
  assert(JSON.stringify(a) !== JSON.stringify(c), 'different seed → different');
});

check('humanize stays inside its stated amounts', () => {
  const notes = scale16(16);
  const humanized = humanizeNotes(notes, allIds(notes), {
    timingBeat: 0.01, velocity: 0.05, seed: 3,
  });
  humanized.forEach((n, i) => {
    const original = notes.find((o) => o.id === n.id)!;
    assert(Math.abs(n.startBeat - original.startBeat) <= 0.0101, `timing bound at ${i}`);
    assert(Math.abs(n.velocity - original.velocity) <= 0.0501, `velocity bound at ${i}`);
    assert(n.startBeat >= 0, 'never negative');
  });
});

check('groove biases strong beats early and weak beats late', () => {
  resetNoteIds();
  const notes = [
    createNote({ startBeat: 0,    durationBeat: 0.2 }),   // strong
    createNote({ startBeat: 0.25, durationBeat: 0.2 }),   // weak
  ];
  const grooved = humanizeNotes(notes, allIds(notes), {
    timingBeat: 0, velocity: 0, grooveBeat: 0.01, gridBeat: 0.25, seed: 1,
  });
  close(grooved[0]!.startBeat, 0, 'strong beat pulled early (clamped at 0)');
  close(grooved[1]!.startBeat, 0.26, 'weak beat pushed late');
});

check('the RNG is stable across runs', () => {
  const a = Array.from({ length: 4 }, makeRng(99));
  eq(makeRng(99)(), makeRng(99)(), 'same seed → same first value');
  assert(a.length === 4, 'generator constructed');
});

// ── Length operations ─────────────────────────────────────────────────────────

check('legato stretches each note to the next', () => {
  const notes = scale16(3, 1);            // starts 0, 1, 2 — lengths 0.5
  const legato = applyLegato(notes, allIds(notes));
  close(legato[0]!.durationBeat, 1, 'first reaches the second');
  close(legato[1]!.durationBeat, 1, 'second reaches the third');
  close(legato[2]!.durationBeat, 0.5, 'last one is left alone');

  const gapped = applyLegato(notes, allIds(notes), -0.1);
  close(gapped[0]!.durationBeat, 0.9, 'negative overlap leaves a gap');
});

check('scale legato blends between the original and full legato', () => {
  const notes = scale16(2, 1);
  const half = scaleLegato(notes, allIds(notes), 50);
  close(half[0]!.durationBeat, 0.75, 'half way to legato');
  eq(scaleLegato(notes, allIds(notes), 0), notes, '0 % is identity');
});

check('fixed lengths, extend-to-next-selected and overlap cleanup', () => {
  const notes = scale16(4, 1);
  close(fixedLengths(notes, allIds(notes), 0.3)[0]!.durationBeat, 0.3, 'fixed');

  const selected = ids(notes[0]!, notes[2]!);
  const extended = extendToNextSelected(notes, selected);
  close(extended[0]!.durationBeat, 2, 'stretched past the unselected note');
  close(extended[1]!.durationBeat, 0.5, 'unselected untouched');

  resetNoteIds();
  const overlapping = [
    createNote({ pitch: 60, startBeat: 0, durationBeat: 2 }),
    createNote({ pitch: 64, startBeat: 1, durationBeat: 2 }),
    createNote({ pitch: 60, startBeat: 1.5, durationBeat: 2 }),
  ];
  const mono = deleteOverlapsMono(overlapping);
  close(mono[0]!.durationBeat, 1, 'mono cuts at the next note of any pitch');
  const poly = deleteOverlapsPoly(overlapping);
  close(poly[0]!.durationBeat, 1.5, 'poly cuts only at the same pitch');
  close(poly[1]!.durationBeat, 2, 'the chord tone survives');
});

check('sustain pedal spans become note lengths', () => {
  resetNoteIds();
  const notes = [createNote({ startBeat: 0.1, durationBeat: 0.1 })];
  const held = pedalsToNoteLength(notes, [{ startBeat: 0, endBeat: 2 }]);
  close(held[0]!.durationBeat, 1.9, 'held to the pedal release');
  eq(pedalsToNoteLength(notes, []), notes, 'no pedal data → identity');
});

check('split and glue', () => {
  resetNoteIds();
  const notes = [createNote({ pitch: 60, startBeat: 0, durationBeat: 2 })];
  const split = splitNotesAt(notes, 0.5);
  eq(split.length, 2, 'two notes');
  close(split[0]!.durationBeat, 0.5, 'head');
  close(split[1]!.startBeat, 0.5, 'tail start');
  close(split[1]!.durationBeat, 1.5, 'tail length');
  eq(splitNotesAt(notes, 5).length, 1, 'outside the note → no split');

  const glued = glueNotes(split, allIds(split));
  eq(glued.length, 1, 'glued back');
  close(glued[0]!.durationBeat, 2, 'full length restored');
});

check('queries: sounding notes and bounds', () => {
  resetNoteIds();
  const notes = [
    createNote({ pitch: 60, startBeat: 0, durationBeat: 1 }),
    createNote({ pitch: 67, startBeat: 0.5, durationBeat: 1 }),
  ];
  eq(notesAt(notes, 0.75).length, 2, 'both sounding');
  eq(notesAt(notes, 1.2).length, 1, 'one sounding');
  eq(notesAt(notes, 5).length, 0, 'silence');
  const bounds = noteBounds(notes)!;
  close(bounds.startBeat, 0, 'start'); close(bounds.endBeat, 1.5, 'end');
  eq(bounds.lowPitch, 60, 'low'); eq(bounds.highPitch, 67, 'high');
  eq(noteBounds([]), null, 'no notes');
});

// ── MIDI files ────────────────────────────────────────────────────────────────

check('a written file reads back with the same notes', () => {
  resetNoteIds();
  const notes = [
    createNote({ pitch: 60, startBeat: 0,   durationBeat: 0.5, velocity: from7bit(100) }),
    createNote({ pitch: 64, startBeat: 0.5, durationBeat: 0.5, velocity: from7bit(80) }),
    createNote({ pitch: 67, startBeat: 1,   durationBeat: 1,   velocity: from7bit(120) }),
  ];
  const bytes = exportMidiFile(notes, 120);
  const imported = importMidiFile(bytes);
  eq(imported.tempoBpm, 120, 'tempo survives');
  const part = imported.parts[0];
  assert(part !== undefined, 'one part');
  eq(part!.notes.length, 3, 'all notes');
  eq(part!.notes.map((n) => n.pitch).join(','), '60,64,67', 'pitches');
  close(part!.notes[1]!.startBeat, 0.5, 'timing');
  close(part!.notes[2]!.durationBeat, 1, 'length');
  eq(to7bit(part!.notes[0]!.velocity), 100, 'velocity');
});

check('tempo changes are integrated, not applied globally', () => {
  // 120 BPM for one quarter, then 60 BPM.
  const file = parseMidiFile(exportMidiFile([createNote({ startBeat: 0, durationBeat: 0.1 })], 120));
  const toSeconds = makeTickToSeconds({
    ...file,
    tempoMap: [
      { tick: 0, microsecondsPerQuarter: 500_000 },      // 120 BPM
      { tick: file.ticksPerQuarter, microsecondsPerQuarter: 1_000_000 },  // 60 BPM
    ],
  });
  close(toSeconds(file.ticksPerQuarter), 0.5, 'first quarter at 120');
  close(toSeconds(file.ticksPerQuarter * 2), 1.5, 'second quarter at 60');
  eq(fileTempoBpm(file), 120, 'reported tempo');
});

check('rejects files that are not MIDI', () => {
  let threw = false;
  try { parseMidiFile(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])); } catch { threw = true; }
  assert(threw, 'garbage rejected');
});

// Build an MPE-style file by hand: three notes, each on its own channel,
// each with its own pitch bend while it sounds.
function buildMpeFile(): Uint8Array {
  const tpq = 480;
  const bytes: number[] = [];
  const push = (...b: number[]): void => { bytes.push(...b); };
  const vlq = (v: number): number[] => {
    const out = [v & 0x7f];
    let x = v >> 7;
    while (x > 0) { out.unshift((x & 0x7f) | 0x80); x >>= 7; }
    return out;
  };

  const events: Array<{ tick: number; data: number[] }> = [];
  [0, 1, 2].forEach((i) => {
    const channel = i + 1;                       // MPE member channels
    const start = i * tpq;
    events.push({ tick: start, data: [0x90 | channel, 60 + i * 4, 100] });
    events.push({ tick: start + tpq / 2, data: [0xe0 | channel, 0x00, 0x60] });  // bend up
    events.push({ tick: start + tpq, data: [0x80 | channel, 60 + i * 4, 64] });
  });
  events.sort((a, b) => a.tick - b.tick);

  const track: number[] = [];
  track.push(...vlq(0), 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20);   // 120 BPM
  let last = 0;
  for (const e of events) { track.push(...vlq(e.tick - last), ...e.data); last = e.tick; }
  track.push(...vlq(0), 0xff, 0x2f, 0x00);

  push(0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (tpq >> 8) & 0xff, tpq & 0xff);
  push(0x4d, 0x54, 0x72, 0x6b,
    (track.length >> 24) & 0xff, (track.length >> 16) & 0xff,
    (track.length >> 8) & 0xff, track.length & 0xff);
  push(...track);
  return new Uint8Array(bytes);
}

check('MPE files are detected and their bends become per-note expression', () => {
  const file = parseMidiFile(buildMpeFile());
  const track = file.tracks[0]!;
  assert(looksLikeMpe(track.events), 'detected as MPE');

  const part = trackToPart(track, file);
  eq(part.notes.length, 3, 'three notes');
  eq(part.mpe, true, 'part marked MPE');
  eq(part.bendRangeSemitones, 48, 'MPE default bend range');
  eq(part.controllers.length, 0, 'no part-level lanes — the bends went to the notes');

  for (const note of part.notes) {
    const bend = findExpression(note, { kind: 'pitchBend' });
    assert(bend !== undefined, `note ${note.pitch} carries its own bend`);
    assert(bend!.points.length > 0, 'has points');
    assert(bend!.points[0]!.timeBeat >= 0, 'curve time is note-relative');
    assert(bend!.points[0]!.value > 0, 'bends upward');
  }
});

check('a single-channel file keeps controllers at part level', () => {
  resetNoteIds();
  const notes = [createNote({ pitch: 60, startBeat: 0, durationBeat: 1 })];
  const file = parseMidiFile(exportMidiFile(notes, 120));
  assert(!looksLikeMpe(file.tracks[0]!.events), 'not MPE');
  const part = trackToPart(file.tracks[0]!, file);
  eq(part.mpe, false, 'flagged as ordinary MIDI');
  eq(part.bendRangeSemitones, 2, 'standard bend range');
});

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== MIDI core (model · scales · chords · editing · files) ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
