/**
 * fl-selftest — the FL Studio layer: step sequencer, patterns, note tools.
 *
 * What each part has to prove:
 *
 *   The step grid becomes real notes.  Swing, nudge, ratchet and probability
 *   are the difference between a groove and a drum machine from 1981, so each
 *   one is measured in the note times it produces.
 *
 *   A pattern is ONE copy of the notes.  Edit a placement and every other
 *   placement changes — that is the entire reason patterns exist, and the test
 *   fails if a placement quietly gets its own copy.
 *
 *   The piano-roll tools do what a player would.  A strum ends together, an
 *   arpeggio does not stutter at the turn, a slide is real bend data.
 *
 * Run: pnpm --filter @aimaster/desktop test:fl
 */

import {
  DEFAULT_STEP, GM_DRUM_MAP, createPattern as createStepPattern, createChannel,
  toggleStep, setStep, clearChannel, addChannel, removeChannel, resizePattern,
  rotateChannel, euclidFill, stepBeats, patternBeats, stepTime,
  stepsToNotes, notesToSteps, activeStepCount, describePattern as describeSteps,
  type StepPattern,
} from '../src/renderer/daw/model/step-sequencer.js';
import {
  createPattern, addPattern, findPattern, updatePattern, renamePattern,
  patternUsage, removePattern, clipNotes, writeClipNotes, patternClip,
  unlinkClip, captureAsPattern, describePattern, notesInClipTime,
} from '../src/renderer/daw/model/patterns.js';
import {
  stampChord, arpeggiate, chordGroups, strum, applySlides, clearSlides, flam,
  snapToScale,
} from '../src/renderer/daw/edit/note-tools.js';
import { createNote, from7bit, noteEndBeat, type MidiNote } from '../src/renderer/daw/model/midi.js';
import { makeChord } from '../src/renderer/daw/model/chords.js';
import {
  addTrack, createMidiPart, createSession, createTrack, findTrack, trackClips, updateClips,
} from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import type { DawSession } from '../src/renderer/daw/model/types.js';

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
function close(a: number, b: number, m: string, tol = 1e-9): void {
  if (Math.abs(a - b) > tol) throw new Error(`${m} — got ${a}, want ${b} ±${tol}`);
}

const BPM = 120;                       // a sixteenth is 0.125 s

function pattern4(): StepPattern {
  resetIds();
  return createStepPattern('Beat', 16, 4);
}

/** Turn on a channel's steps by index. */
function fill(p: StepPattern, channelIndex: number, indices: number[]): StepPattern {
  const id = p.channels[channelIndex]?.id ?? '';
  return indices.reduce((acc, i) => toggleStep(acc, id, i), p);
}

// ── The grid ──────────────────────────────────────────────────────────────────

check('a new pattern is a four-channel sixteenth grid', () => {
  const p = pattern4();
  eq(p.stepCount, 16, 'sixteen steps');
  eq(p.stepsPerBeat, 4, 'sixteenths');
  eq(p.channels.length, 4, 'kick, snare, clap, closed hat');
  eq(p.channels[0]?.name, 'Kick', 'in drum-map order');
  eq(p.channels[0]?.pitch, GM_DRUM_MAP[0]?.pitch, 'on the GM pitch');
  eq(activeStepCount(p), 0, 'and empty');
  close(stepBeats(p), 0.25, 'a sixteenth is a quarter of a beat, at any tempo', 1e-12);
  close(patternBeats(p), 4, 'one bar of 4/4', 1e-12);
});

check('steps toggle and carry their own values', () => {
  let p = pattern4();
  const kick = p.channels[0]!.id;
  p = toggleStep(p, kick, 0);
  assert(p.channels[0]?.steps[0]?.on, 'step on');
  eq(activeStepCount(p), 1, 'counted');
  p = setStep(p, kick, 0, { velocity: from7bit(60), nudge: 0.25, ratchet: 3 });
  close(p.channels[0]?.steps[0]?.velocity ?? 0, from7bit(60), 'velocity written', 1e-9);
  close(p.channels[0]?.steps[0]?.nudge ?? 0, 0.25, 'nudge written', 1e-9);
  p = toggleStep(p, kick, 0);
  assert(!p.channels[0]?.steps[0]?.on, 'toggled back off');
  // The values survive the toggle — turning a step off is not erasing it.
  close(p.channels[0]?.steps[0]?.nudge ?? 0, 0.25, 'nudge kept', 1e-9);
  eq(toggleStep(p, 'nope', 0), p, 'an unknown channel changes nothing');
  eq(setStep(p, kick, 99, { on: true }), p, 'a step past the end changes nothing');
});

check('channels can be added, cleared and removed', () => {
  let p = pattern4();
  p = addChannel(p, 'Rim', 37);
  eq(p.channels.length, 5, 'added');
  eq(p.channels[4]?.steps.length, 16, 'sized to the grid');
  p = fill(p, 4, [0, 4, 8]);
  eq(activeStepCount(p), 3, 'three hits');
  p = clearChannel(p, p.channels[4]!.id);
  eq(activeStepCount(p), 0, 'cleared');
  eq(clearChannel(p, p.channels[4]!.id), p, 'clearing an empty channel changes nothing');
  p = removeChannel(p, p.channels[4]!.id);
  eq(p.channels.length, 4, 'removed');
  eq(removeChannel(p, 'nope'), p, 'removing nothing changes nothing');
});

check('resizing keeps what fits', () => {
  let p = fill(pattern4(), 0, [0, 4, 8, 12]);
  p = resizePattern(p, 8);
  eq(p.stepCount, 8, 'shrunk');
  eq(activeStepCount(p), 2, 'the hits past step 8 are gone');
  p = resizePattern(p, 16);
  eq(p.channels[0]?.steps.length, 16, 'grown back');
  eq(activeStepCount(p), 2, 'and the new steps are empty');
  eq(resizePattern(p, 16), p, 'resizing to the same size changes nothing');
});

check('rotation moves the groove without redrawing it', () => {
  const p = fill(pattern4(), 0, [0, 4, 8, 12]);
  const kick = p.channels[0]!.id;
  const shifted = rotateChannel(p, kick, 2);
  const on = shifted.channels[0]!.steps.map((s, i) => (s.on ? i : -1)).filter((i) => i >= 0);
  eq(on.join(','), '2,6,10,14', 'shifted by two');
  const wrapped = rotateChannel(p, kick, -1);
  const back = wrapped.channels[0]!.steps.map((s, i) => (s.on ? i : -1)).filter((i) => i >= 0);
  eq(back.join(','), '3,7,11,15', 'and it wraps');
  eq(rotateChannel(p, kick, 16), p, 'a full turn is a no-op');
});

check('euclidean fill spreads hits evenly', () => {
  const p = pattern4();
  const kick = p.channels[0]!.id;
  const four = euclidFill(p, kick, 4);
  eq(four.channels[0]!.steps.map((s, i) => (s.on ? i : -1)).filter((i) => i >= 0).join(','),
    '0,4,8,12', 'four on the floor');
  const tresillo = euclidFill(p, kick, 3);
  // 3 in 16 is the tresillo — the pattern under half of popular music.
  eq(tresillo.channels[0]!.steps.map((s, i) => (s.on ? i : -1)).filter((i) => i >= 0).join(','),
    '0,5,10', 'tresillo');
  eq(euclidFill(p, kick, 0).channels[0]!.steps.filter((s) => s.on).length, 0, 'zero hits');
});

// ── Grid → notes ──────────────────────────────────────────────────────────────

check('a straight grid becomes notes on the grid', () => {
  const p = fill(pattern4(), 0, [0, 4, 8, 12]);
  const notes = stepsToNotes(p);
  eq(notes.length, 4, 'four hits');
  notes.forEach((n, i) => {
    close(n.startBeat, i, `hit ${i} on the beat`, 1e-9);
    eq(n.pitch, 36, 'on the kick');
  });
});

check('swing pushes the off-beats late and leaves the down-beats alone', () => {
  const straight = fill(pattern4(), 3, [0, 1, 2, 3]);
  const swung: StepPattern = { ...straight, swing: 0.5 };
  const notes = stepsToNotes(swung);
  const step = stepBeats(swung);
  close(notes[0]?.startBeat ?? -1, 0, 'step 0 does not move', 1e-9);
  close(notes[1]?.startBeat ?? -1, step + 0.25 * step, 'step 1 is late by a quarter step', 1e-9);
  close(notes[2]?.startBeat ?? -1, 2 * step, 'step 2 does not move', 1e-9);
  // Straight is straight.
  const plain = stepsToNotes(straight);
  close(plain[1]?.startBeat ?? -1, step, 'with no swing the off-beat is on the grid', 1e-9);
});

check('nudge moves one hit without moving the grid', () => {
  let p = fill(pattern4(), 1, [4]);
  const snare = p.channels[1]!.id;
  p = setStep(p, snare, 4, { nudge: 0.2 });
  const notes = stepsToNotes(p);
  const step = stepBeats(p);
  close(notes[0]?.startBeat ?? -1, 4 * step + 0.2 * step, 'behind the beat', 1e-9);
  close(stepTime(p, 4, 0), 4 * step, 'and the grid itself did not move', 1e-9);
});

check('a ratchet stays inside its own step', () => {
  let p = fill(pattern4(), 3, [0]);
  const hat = p.channels[3]!.id;
  p = setStep(p, hat, 0, { ratchet: 4 });
  const notes = stepsToNotes(p);
  eq(notes.length, 4, 'four retriggers');
  const step = stepBeats(p);
  notes.forEach((n, i) => close(n.startBeat, (i * step) / 4, `retrigger ${i}`, 1e-9));
  assert(noteEndBeat(notes[3]!) <= step + 1e-6, 'the roll does not run over the next step');
  // A roll that does not taper sounds like a machine.
  assert((notes[3]?.velocity ?? 1) < (notes[0]?.velocity ?? 0), 'the roll tapers');
});

check('probability is deterministic, so a bounce reproduces the take', () => {
  let p = fill(pattern4(), 0, [0, 4, 8, 12]);
  const kick = p.channels[0]!.id;
  for (const i of [0, 4, 8, 12]) p = setStep(p, kick, i, { probability: 0.5 });
  const a = stepsToNotes(p).map((n) => n.startBeat).join(',');
  const b = stepsToNotes(p).map((n) => n.startBeat).join(',');
  eq(a, b, 'the same pattern plays the same way twice');
  assert(stepsToNotes(p).length < 4, 'and some hits actually drop');
  eq(stepsToNotes(p, { ignoreProbability: true }).length, 4,
    'the editor can see the grid as drawn');
  // A different seed is a different roll of the dice.
  const other = stepsToNotes({ ...p, seed: 99 }).map((n) => n.startBeat).join(',');
  assert(other !== a, 'the seed matters');
});

check('repeats lay the grid end to end', () => {
  const p = fill(pattern4(), 0, [0]);
  const notes = stepsToNotes(p, { repeats: 3 });
  eq(notes.length, 3, 'three hits');
  // Sixteen sixteenths is four beats — one bar of 4/4, per repeat.
  notes.forEach((n, i) => close(n.startBeat, i * 4, `bar ${i}`, 1e-9));
});

check('a muted channel is silent but still drawn', () => {
  let p = fill(pattern4(), 0, [0, 4]);
  eq(stepsToNotes(p).length, 2, 'audible');
  p = { ...p, channels: p.channels.map((c, i) => (i === 0 ? { ...c, muted: true } : c)) };
  eq(stepsToNotes(p).length, 0, 'muted');
  eq(activeStepCount(p), 2, 'but the steps are still there');
});

check('notes fold back onto the grid, and what does not fit becomes nudge', () => {
  const p = pattern4();
  const step = stepBeats(p);
  const notes = [
    createNote({ pitch: 36, startBeat: 0, durationBeat: 0.1 }),
    createNote({ pitch: 38, startBeat: 4 * step + step * 0.2, durationBeat: 0.1 }),
    createNote({ pitch: 99, startBeat: 0, durationBeat: 0.1 }),            // no channel
  ];
  const folded = notesToSteps(p, notes);
  assert(folded.channels[0]?.steps[0]?.on, 'the kick landed');
  assert(folded.channels[1]?.steps[4]?.on, 'the snare landed on the nearest step');
  close(folded.channels[1]?.steps[4]?.nudge ?? 0, 0.2, 'and its timing survived as nudge', 1e-6);
  eq(activeStepCount(folded), 2, 'the unmapped pitch was dropped, not guessed at');
});

check('the pattern describes itself', () => {
  const p = { ...fill(pattern4(), 0, [0, 4]), swing: 0.3 };
  const text = describeSteps(p);
  assert(text.includes('16스텝'), 'step count');
  assert(text.includes('2히트'), 'hit count');
  assert(text.includes('스윙'), 'swing when it is on');
  assert(!describeSteps(pattern4()).includes('스윙'), 'and not when it is off');
});

// ── Patterns ──────────────────────────────────────────────────────────────────

function sessionWithPart(): { session: DawSession; trackId: string; clipId: string } {
  resetIds();
  const base = createSession('fl test');
  const track = createTrack('Keys', 'instrument');
  const part = createMidiPart('Verse', {
    startSec: 0,
    durationSec: 2,
    notes: [createNote({ pitch: 60, startBeat: 0 }), createNote({ pitch: 64, startBeat: 1 })],
  });
  const session = updateClips(addTrack(base, track), track.id, () => [part]);
  return { session, trackId: track.id, clipId: part.id };
}

check('capturing a clip turns it into a linked placement', () => {
  const { session, trackId, clipId } = sessionWithPart();
  const captured = captureAsPattern(session, trackId, clipId, 'Verse A', 120);
  assert(captured !== null, 'captured');
  const { session: next, pattern } = captured!;

  eq(next.patterns?.length, 1, 'one pattern in the library');
  eq(pattern.notes.length, 2, 'holding the notes');
  const clip = trackClips(findTrack(next, trackId)!)[0]!;
  eq(clip.patternId, pattern.id, 'the clip is linked');
  eq(clip.notes.length, 0, 'and stores none of its own');
  eq(clipNotes(next, clip).length, 2, 'but resolves to two');
  eq(captureAsPattern(next, trackId, clipId, 'again', 120), null, 'a linked clip is not captured twice');
});

check('editing one placement changes every placement', () => {
  const { session, trackId, clipId } = sessionWithPart();
  const { session: linked, pattern } = captureAsPattern(session, trackId, clipId, 'Riff', 120)!;

  // Place the same pattern twice more.
  const placed = updateClips(linked, trackId, (clips) => [
    ...clips,
    { ...clips[0]!, id: 'clip-2', ...patternClip(pattern, 4, 120) } as never,
    { ...clips[0]!, id: 'clip-3', ...patternClip(pattern, 8, 120) } as never,
  ]);
  eq(patternUsage(placed, pattern.id).length, 3, 'three placements');

  // Edit through ONE of them.
  const edited = writeClipNotes(placed, trackId, 'clip-2', [
    createNote({ pitch: 72, startBeat: 0 }),
  ]);

  const clips = trackClips(findTrack(edited, trackId)!);
  for (const clip of clips) {
    eq(clipNotes(edited, clip).length, 1, 'every placement sees the edit');
    eq(clipNotes(edited, clip)[0]?.pitch, 72, 'and sees the new pitch');
  }
  eq(findPattern(edited, pattern.id)?.notes.length, 1, 'the pattern itself changed');
});

check('unlinking gives a placement its own copy', () => {
  const { session, trackId, clipId } = sessionWithPart();
  const { session: linked, pattern } = captureAsPattern(session, trackId, clipId, 'Riff', 120)!;
  const unlinked = unlinkClip(linked, trackId, clipId);

  const clip = trackClips(findTrack(unlinked, trackId)!)[0]!;
  eq(clip.patternId, undefined, 'no longer linked');
  eq(clip.notes.length, 2, 'and holds the notes itself');
  eq(patternUsage(unlinked, pattern.id).length, 0, 'the pattern has no users');

  // Now the pattern and the clip are genuinely separate.
  const changed = updatePattern(unlinked, pattern.id, (p) => ({ ...p, notes: [] }));
  eq(clipNotes(changed, trackClips(findTrack(changed, trackId)!)[0]!).length, 2,
    'emptying the pattern no longer touches the clip');
  eq(unlinkClip(unlinked, trackId, clipId), unlinked, 'unlinking twice changes nothing');
});

check('deleting a pattern never deletes the music', () => {
  const { session, trackId, clipId } = sessionWithPart();
  const { session: linked, pattern } = captureAsPattern(session, trackId, clipId, 'Riff', 120)!;
  const removed = removePattern(linked, pattern.id);

  eq(removed.patterns?.length, 0, 'the pattern is gone');
  const clip = trackClips(findTrack(removed, trackId)!)[0]!;
  eq(clip.patternId, undefined, 'the placement was unlinked');
  eq(clip.notes.length, 2, 'and kept the notes');
  eq(removePattern(removed, pattern.id), removed, 'removing it again changes nothing');
});

check('a placement is re-timed for the session tempo', () => {
  const notes = [createNote({ pitch: 60, startBeat: 0 })];
  const pattern = createPattern('Loop', notes, 2, 120, 0);
  const atSame = patternClip(pattern, 0, 120);
  close(atSame.durationSec ?? 0, 2, 'same tempo, same length', 1e-9);
  const atHalf = patternClip(pattern, 0, 60);
  close(atHalf.durationSec ?? 0, 4, 'half the tempo, twice the length', 1e-9);
  eq(atSame.notes?.length, 0, 'a placement stores no notes');
  eq(atSame.patternId, pattern.id, 'it stores the link');
});

check('the library renames and describes', () => {
  resetIds();
  const base = createSession('s');
  const pattern = createPattern('A', [createNote({})], 2, 120, 0);
  const withPattern = addPattern(base, pattern);
  eq(withPattern.patterns?.length, 1, 'added');
  const renamed = renamePattern(withPattern, pattern.id, 'Chorus');
  eq(findPattern(renamed, pattern.id)?.name, 'Chorus', 'renamed');
  eq(renamePattern(renamed, pattern.id, 'Chorus'), renamed, 'renaming to the same name is a no-op');
  assert(describePattern(renamed, findPattern(renamed, pattern.id)!).includes('배치 0회'),
    'reports how many times it is placed');
  eq(findPattern(base, 'nope'), undefined, 'a session with no library returns nothing');
});

check('another part can be read in this clip\'s time base', () => {
  // What ghost notes and MIDI-guided pitch correction both need: "what is
  // that other part playing, in MY clock".
  resetIds();
  const base = createSession('ghost test');
  const track = createTrack('Keys', 'instrument');
  let session = addTrack(base, track);

  const host = createMidiPart('Bass', { startSec: 8, durationSec: 4 });
  const chords = createMidiPart('Chords', {
    startSec: 10,
    durationSec: 4,
    notes: [createNote({ pitch: 60, startBeat: 0.5, durationBeat: 1 })],
  });
  session = updateClips(session, track.id, () => [host, chords]);

  const seen = notesInClipTime(session, host, track.id, chords.id);
  eq(seen.length, 1, 'one note');
  // The clips are two seconds apart, which at 120 BPM is four beats.
  close(seen[0]?.startBeat ?? 0, 4.5, 'shifted by the four beats between the clips', 1e-9);
  eq(seen[0]?.pitch, 60, 'and unchanged otherwise');

  // A pattern-backed source resolves through the link, so a placed pattern
  // works as a ghost like anything else.
  const captured = captureAsPattern(session, track.id, chords.id, 'Chords', 120)!;
  const throughLink = notesInClipTime(captured.session, host, track.id, chords.id);
  eq(throughLink.length, 1, 'still one note');
  close(throughLink[0]?.startBeat ?? 0, 4.5, 'still in the host\'s clock', 1e-9);

  eq(notesInClipTime(session, host, track.id, 'nope').length, 0, 'a missing source is empty');
});

// ── Note tools ────────────────────────────────────────────────────────────────

check('a chord stamp writes a voicing, low to high', () => {
  const notes = stampChord(makeChord(0, 'maj7'), { startBeat: 1, durationBeat: 2, bottomPitch: 48 });
  eq(notes.length, 4, 'four voices');
  for (const n of notes) {
    close(n.startBeat, 1, 'all at the same time', 1e-9);
    close(n.durationBeat, 2, 'all the same length', 1e-9);
  }
  const pitches = notes.map((n) => n.pitch);
  eq(pitches.join(','), [...pitches].sort((a, b) => a - b).join(','), 'sorted low to high');
  const open = stampChord(makeChord(0, 'maj7'), { startBeat: 0, durationBeat: 1, open: true });
  assert(Math.max(...open.map((n) => n.pitch)) - Math.min(...open.map((n) => n.pitch))
    > Math.max(...pitches) - Math.min(...pitches), 'an open voicing spans wider');
});

check('chord grouping tells a chord from a melody', () => {
  const chord = [
    createNote({ pitch: 60, startBeat: 0, durationBeat: 1 }),
    createNote({ pitch: 64, startBeat: 0, durationBeat: 1 }),
    createNote({ pitch: 67, startBeat: 0, durationBeat: 1 }),
  ];
  eq(chordGroups(chord).length, 1, 'three notes at once are one chord');
  const melody = [
    createNote({ pitch: 60, startBeat: 0, durationBeat: 0.4 }),
    createNote({ pitch: 62, startBeat: 0.5, durationBeat: 0.4 }),
    createNote({ pitch: 64, startBeat: 1.0, durationBeat: 0.4 }),
  ];
  eq(chordGroups(melody).length, 3, 'a melody is three groups');
});

check('arpeggiate turns a held chord into a run', () => {
  const chord = [60, 64, 67].map((pitch) =>
    createNote({ pitch, startBeat: 0, durationBeat: 1 }));
  const up = arpeggiate(chord, { rateBeat: 0.25, direction: 'up' });
  eq(up.length, 4, 'four steps in one second');
  eq(up.map((n) => n.pitch).join(','), '60,64,67,60', 'up, then round again');
  up.forEach((n, i) => close(n.startBeat, i * 0.25, `step ${i}`, 1e-9));

  const down = arpeggiate(chord, { rateBeat: 0.25, direction: 'down' });
  eq(down.map((n) => n.pitch).join(','), '67,64,60,67', 'down');

  const octaves = arpeggiate(chord, { rateBeat: 0.25, direction: 'up', octaves: 2 });
  eq(octaves.map((n) => n.pitch).join(','), '60,64,67,72', 'a second octave stacks on top');
});

check('updown does not stutter at the turn', () => {
  const chord = [60, 64, 67].map((pitch) =>
    createNote({ pitch, startBeat: 0, durationBeat: 1 }));
  const notes = arpeggiate(chord, { rateBeat: 0.2, direction: 'updown' });
  // 60 64 67 64 then round to 60 — the top and bottom are not played twice.
  eq(notes.slice(0, 5).map((n) => n.pitch).join(','), '60,64,67,64,60', 'a clean turn');
});

check('a melody through the arpeggiator stays a melody', () => {
  const melody = [
    createNote({ pitch: 60, startBeat: 0, durationBeat: 0.25 }),
    createNote({ pitch: 62, startBeat: 0.5, durationBeat: 0.25 }),
  ];
  const notes = arpeggiate(melody, { rateBeat: 0.25, direction: 'up' });
  eq(notes.length, 2, 'two notes in, two notes out');
  eq(notes.map((n) => n.pitch).join(','), '60,62', 'unchanged');
});

check('a random arpeggio is the same every time it renders', () => {
  const chord = [60, 64, 67, 71].map((pitch) =>
    createNote({ pitch, startBeat: 0, durationBeat: 2 }));
  const options = { rateBeat: 0.25, direction: 'random' as const, seed: 7 };
  eq(arpeggiate(chord, options).map((n) => n.pitch).join(','),
    arpeggiate(chord, options).map((n) => n.pitch).join(','), 'deterministic');
  assert(arpeggiate(chord, { ...options, seed: 8 }).map((n) => n.pitch).join(',')
    !== arpeggiate(chord, options).map((n) => n.pitch).join(','), 'the seed matters');
});

check('a strum lands one note at a time and ends together', () => {
  const chord = [60, 64, 67, 72].map((pitch) =>
    createNote({ pitch, startBeat: 1, durationBeat: 2 }));
  const played = strum(chord, { spreadBeat: 0.02, direction: 'up' });
  eq(played.length, 4, 'four voices');
  played.forEach((n, i) => close(n.startBeat, 1 + i * 0.02, `voice ${i} comes in late`, 1e-9));
  // The ends stay together — shortening every note by its own offset is what
  // makes a strummed chord sound clipped.
  for (const n of played) close(noteEndBeat(n), 3, 'all ring out together', 1e-9);
  // Later voices are quieter.
  assert((played[3]?.velocity ?? 1) < (played[0]?.velocity ?? 0), 'velocity falls off');

  const down = strum(chord, { spreadBeat: 0.02, direction: 'down' });
  eq(down[0]?.pitch, 72, 'a downstroke starts at the top');
});

check('a slide is real pitch-bend data, and wide jumps are left alone', () => {
  const line = [
    createNote({ pitch: 60, startBeat: 0, durationBeat: 0.5 }),
    createNote({ pitch: 62, startBeat: 0.5, durationBeat: 0.5 }),      // +2, slid
    createNote({ pitch: 74, startBeat: 1.0, durationBeat: 0.5 }),      // +12, not slid
  ];
  const slid = applySlides(line, { bendRangeSemitones: 2, timeFraction: 0.25 });
  eq(slid[0]?.expression.length, 0, 'the first note has nothing to slide from');

  const bend = slid[1]?.expression.find((e) => e.target.kind === 'pitchBend');
  assert(!!bend, 'the second note bends');
  close(bend!.points[0]?.value ?? 0, -1, 'starting a whole tone below, at the range limit', 1e-9);
  close(bend!.points[1]?.value ?? 1, 0, 'and arriving in tune', 1e-9);
  close(bend!.points[1]?.timeBeat ?? 0, 0.125, 'a quarter of the way in', 1e-9);

  eq(slid[2]?.expression.length, 0, 'an octave jump is a portamento effect, not a legato');
  eq(clearSlides(slid).every((n) => n.expression.length === 0), true, 'and slides can be removed');
});

check('a flam is a grace note before the hit', () => {
  const hit = [createNote({ pitch: 38, startBeat: 1, durationBeat: 0.2, velocity: 1 })];
  const flammed = flam(hit, { spacingBeat: 0.03, graceVelocity: 0.5 });
  eq(flammed.length, 2, 'grace plus hit');
  close(flammed[0]?.startBeat ?? -1, 0.97, 'the grace comes first', 1e-9);
  close(flammed[1]?.startBeat ?? -1, 1, 'the hit stays put', 1e-9);
  close(flammed[0]?.velocity ?? 0, 0.5, 'and is softer', 1e-9);

  // A hit too close to zero cannot have a grace note before it.
  eq(flam([createNote({ pitch: 38, startBeat: 0.01 })], { spacingBeat: 0.05 }).length, 1,
    'no negative start times');
  eq(flam(hit, { count: 4 }).length, 4, 'a longer roll');
});

check('scale snap pulls stray notes into key', () => {
  const scale = { root: 0, scaleId: 'major' };           // C major
  const notes: MidiNote[] = [61, 60, 66].map((pitch) => createNote({ pitch }));
  const snapped = snapToScale(notes, scale);
  eq(snapped[1]?.pitch, 60, 'a note already in key is untouched');
  assert(snapped[0]?.pitch !== 61, 'C# moved');
  assert(snapped[2]?.pitch !== 66, 'F# moved');
  for (const n of snapped) assert(Math.abs(n.pitch - 61) <= 6, 'and nothing moved far');
});

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== FL: step sequencer · patterns · note tools ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
