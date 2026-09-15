/**
 * midi-insert-selftest.ts — the chain between the keyboard and the instrument.
 *
 * The one property the whole feature rests on is that LIVE AND PLAYBACK AGREE.
 * A live arpeggiator that does not match the rendered one is worse than no
 * arpeggiator at all: you record a take, it plays back different, and there is
 * nothing to point at.  So the live path is tested against the same function
 * the render uses, not against a description of what it should do.
 *
 * After that, the things that fail quietly:
 *
 *   • The chain multiplying.  A chorder into an arp into an echo can ask for
 *     tens of thousands of notes from three keys, and each setting looks
 *     reasonable on its own.
 *   • Velocity reaching 0, which is a note-OFF in MIDI, not a quiet note.
 *   • The order of the chain, which is a musical decision and must be the
 *     user's — a chorder before an arp arpeggiates the chord, after it
 *     harmonises every step.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:midi-insert
 */

import {
  MAX_INSERT_NOTES, arpStepsFor, chainIsEmpty, defaultInsert, describeChain,
  describeInsert, isStatelessInsert, liveNotes, runChain, statelessPart,
  stepSeconds, timedInsert,
  type ArpeggiatorInsert, type MidiInsert,
} from '../src/renderer/daw/model/midi-insert.js';
import {
  createNote, from7bit, resetNoteIds, to7bit, type MidiNote,
} from '../src/renderer/daw/model/midi.js';
import {
  cachedInsertsFor, insertedNotes, midiInsertsOf, setMidiInserts, trackHasInserts,
} from '../src/renderer/daw/model/midi-insert-track.js';
import { createTrack } from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function near(a: number, b: number, eps: number, m: string): void {
  if (!(Math.abs(a - b) <= eps)) throw new Error(`${m} — got ${a}, want ${b} ±${eps}`);
}

/** `[pitch, startBeat, velocity 1…127, lengthBeat]`. */
function part(spec: readonly [number, number, number?, number?][]): MidiNote[] {
  resetNoteIds();
  return spec.map(([pitch, startBeat, vel, len]) => createNote({
    pitch, startBeat, velocity: from7bit(vel ?? 100), durationBeat: len ?? 1,
  }));
}
const pitches = (notes: readonly MidiNote[]): number[] => notes.map((n) => n.pitch);
const vels = (notes: readonly MidiNote[]): number[] => notes.map((n) => to7bit(n.velocity));
const ins = (over: Partial<MidiInsert> & { kind: MidiInsert['kind'] }): MidiInsert =>
  ({ ...defaultInsert(over.kind, 'i'), ...over } as MidiInsert);

const CHORD = (): MidiNote[] => part([[60, 0, 100, 2], [64, 0, 100, 2], [67, 0, 100, 2]]);

// ── The chain leaves the part alone ─────────────────────────────────────────

check('an insert transforms what the instrument hears, not the part', () => {
  // The whole difference from the offline verbs.  The chord stays a chord, so
  // the arp rate is a knob rather than an undo.
  const notes = CHORD();
  const played = runChain(notes, [ins({ kind: 'arpeggiator' })]).notes;
  assert(played.length > 3, `the instrument hears a run: ${played.length} notes`);
  assert(notes.length === 3, 'and the part is still three notes');
  assert(pitches(notes).join() === '60,64,67', 'unchanged');
});

check('an empty or fully bypassed chain is recognised as doing nothing', () => {
  assert(chainIsEmpty([]), 'empty');
  assert(chainIsEmpty(undefined), 'absent');
  assert(chainIsEmpty([ins({ kind: 'transpose', bypass: true })]), 'all off');
  assert(!chainIsEmpty([ins({ kind: 'transpose' })]), 'one on');
});

check('a bypassed insert keeps its settings and leaves the chain', () => {
  const notes = part([[60, 0]]);
  const on = runChain(notes, [ins({ kind: 'transpose', semitones: 12 })]).notes;
  const off = runChain(notes, [ins({ kind: 'transpose', semitones: 12, bypass: true })]).notes;
  assert(pitches(on).join() === '72', 'on');
  assert(pitches(off).join() === '60', 'off');
});

// ── The individual inserts ──────────────────────────────────────────────────

check('transpose DROPS what runs off the keyboard rather than piling it up', () => {
  // Clamping would stack a run onto 127 and sound like a broken instrument.
  const notes = part([[60, 0], [120, 1], [125, 2]]);
  const up = runChain(notes, [ins({ kind: 'transpose', semitones: 12 })]).notes;
  assert(pitches(up).join() === '72', `only the one that fits: ${pitches(up)}`);
});

check('velocity never reaches 0, which is a note-OFF', () => {
  const notes = part([[60, 0, 10]]);
  const quiet = runChain(notes, [ins({ kind: 'velocity', scale: 0, offset: 0 })]).notes;
  assert((vels(quiet)[0] as number) >= 1, `got ${vels(quiet)[0]}`);
  const loud = runChain(notes, [ins({ kind: 'velocity', scale: 10, offset: 100 })]).notes;
  assert(vels(loud)[0] === 127, 'and it stops at the top');
});

check('velocity scales then offsets, and fixed ignores both', () => {
  const notes = part([[60, 0, 64]]);
  const scaled = runChain(notes, [ins({ kind: 'velocity', scale: 0.5, offset: 20 })]).notes;
  near(vels(scaled)[0] as number, 52, 1, '64 × 0.5 + 20');
  const fixed = runChain(notes, [ins({ kind: 'velocity', scale: 0.5, offset: 20, fixed: 90 })]).notes;
  assert(vels(fixed)[0] === 90, 'fixed wins');
});

check('range folds by OCTAVES so a note keeps its name', () => {
  // Folding by semitones would change the harmony, which is not what
  // "keep it on the keyboard" means.
  const notes = part([[36, 0], [100, 1]]);
  const folded = runChain(notes,
    [ins({ kind: 'range', lowPitch: 48, highPitch: 72, mode: 'fold' })]).notes;
  assert(pitches(folded).sort((a, b) => a - b).join() === '48,64',
    `36→48 and 100→64: ${pitches(folded)}`);
  for (const p of pitches(folded)) assert(p % 12 === (p === 48 ? 0 : 4), 'same pitch class');
});

check('range drop is a keyboard split, not a fold', () => {
  const notes = part([[36, 0], [60, 1], [100, 2]]);
  const kept = runChain(notes,
    [ins({ kind: 'range', lowPitch: 48, highPitch: 72, mode: 'drop' })]).notes;
  assert(pitches(kept).join() === '60', `only what was in range: ${pitches(kept)}`);
});

check('a range typed backwards is still the range that was meant', () => {
  // Somebody typing the high note first should get the range, not silence.
  const notes = part([[36, 0], [60, 1], [100, 2]]);
  const kept = runChain(notes,
    [ins({ kind: 'range', lowPitch: 72, highPitch: 48, mode: 'drop' })]).notes;
  assert(pitches(kept).join() === '60', `48…72 either way round: ${pitches(kept)}`);
});

check('a range narrower than an octave drops what cannot fit', () => {
  // Folding into a five-semitone window is not possible for every note, and
  // an endless loop trying would be the alternative.
  const notes = part([[60, 0], [61, 1], [70, 2]]);
  const kept = runChain(notes,
    [ins({ kind: 'range', lowPitch: 60, highPitch: 64, mode: 'fold' })]).notes;
  for (const p of pitches(kept)) assert(p >= 60 && p <= 64, `${p} is inside`);
  assert(kept.length < notes.length, 'and the ones that cannot fit are gone');
});

check('the chorder keeps the original and marks the added notes apart', () => {
  const notes = part([[60, 0, 100]]);
  const chord = runChain(notes,
    [ins({ kind: 'chorder', intervals: [0, 4, 7], addedLevel: 0.5 })]).notes;
  assert(pitches(chord).join() === '60,64,67', pitches(chord).join());
  assert(vels(chord)[0] === 100, 'the played note keeps its velocity');
  assert((vels(chord)[1] as number) < 100, 'the added ones are quieter');
  assert(new Set(chord.map((n) => n.id)).size === 3, 'and every note has its own id');
});

check('the echo decays, and stops when a repeat would be inaudible', () => {
  const notes = part([[60, 0, 100]]);
  const echoed = runChain(notes,
    [ins({ kind: 'echo', delayBeat: 0.5, repeats: 20, feedback: 0.3, pitchStep: 0 })]).notes;
  const levels = vels(echoed);
  for (let i = 1; i < levels.length; i++) {
    assert((levels[i] as number) < (levels[i - 1] as number), 'each repeat is quieter');
  }
  assert(echoed.length < 21, `stopped short of 20 repeats: ${echoed.length}`);
  assert((levels[levels.length - 1] as number) >= 1, 'and never reached a note-off');
});

check('an echo that would walk off the keyboard stops there', () => {
  const notes = part([[110, 0, 100]]);
  const rising = runChain(notes,
    [ins({ kind: 'echo', delayBeat: 0.5, repeats: 8, feedback: 0.95, pitchStep: 12 })]).notes;
  for (const p of pitches(rising)) assert(p >= 0 && p <= 127, `${p} is a real pitch`);
  assert(rising.length < 9, 'and it stopped rather than clamping');
});

// ── Order ───────────────────────────────────────────────────────────────────

check('the chain order is the user’s, and it changes the result', () => {
  // A chorder BEFORE an arp arpeggiates the chord; AFTER it harmonises every
  // step.  Both are things people want, so neither is imposed.
  const notes = part([[60, 0, 100, 1]]);
  const chorder = ins({ kind: 'chorder', intervals: [0, 4, 7], addedLevel: 1 });
  const arp = ins({ kind: 'arpeggiator', rateBeat: 0.25, octaves: 1 });

  const arpFirst = runChain(notes, [arp, chorder]).notes;
  const chordFirst = runChain(notes, [chorder, arp]).notes;
  assert(arpFirst.length !== chordFirst.length
    || pitches(arpFirst).join() !== pitches(chordFirst).join(),
    'the two orders are different edits');
  // Chorder first: one note per step, drawn from the chord.
  assert(new Set(pitches(chordFirst)).size === 3, 'arping a chord uses its three notes');
  // Arp first: every step becomes a chord, so steps and pitches both multiply.
  assert(arpFirst.length === 4 * 3, `four steps harmonised three ways: ${arpFirst.length}`);
});

// ── The ceiling ─────────────────────────────────────────────────────────────

check('a chain that multiplies is stopped and SAYS it was stopped', () => {
  // Three settings that each look reasonable.  "The arp stops after two bars"
  // with no explanation is a bug report; a reported ceiling is a setting.
  const notes = part([[60, 0, 100, 64], [64, 0, 100, 64], [67, 0, 100, 64]]);
  const result = runChain(notes, [
    ins({ kind: 'chorder', intervals: [0, 3, 5, 7, 10] }),
    ins({ kind: 'arpeggiator', rateBeat: 1 / 32, octaves: 4 }),
    ins({ kind: 'echo', repeats: 6, feedback: 0.98, delayBeat: 0.02 }),
  ]);
  assert(result.overflowed, 'it says so');
  assert(result.notes.length <= MAX_INSERT_NOTES, `held at the ceiling: ${result.notes.length}`);
});

check('a normal chain does not trip the ceiling', () => {
  const result = runChain(CHORD(), [
    ins({ kind: 'chorder', intervals: [0, 12] }),
    ins({ kind: 'arpeggiator', rateBeat: 0.25 }),
  ]);
  assert(!result.overflowed, 'no false alarm');
});

// ── Live ────────────────────────────────────────────────────────────────────

check('the stateless inserts are the ones one key press can answer', () => {
  assert(isStatelessInsert(ins({ kind: 'transpose' })), 'transpose');
  assert(isStatelessInsert(ins({ kind: 'chorder' })), 'chorder');
  assert(!isStatelessInsert(ins({ kind: 'arpeggiator' })), 'an arp is about WHEN');
  assert(!isStatelessInsert(ins({ kind: 'echo' })), 'and so is an echo');
});

check('the live head STOPS at the first timed insert, it does not skip it', () => {
  // Everything after an arpeggiator acts on ITS output.  Running those now
  // would apply them to the wrong notes — the held keys instead of the steps.
  const chain: MidiInsert[] = [
    { ...ins({ kind: 'transpose', semitones: 12 }), id: 'a' },
    { ...ins({ kind: 'arpeggiator' }), id: 'b' },
    { ...ins({ kind: 'chorder', intervals: [0, 7] }), id: 'c' },
  ];
  const head = statelessPart(chain);
  assert(head.map((i) => i.id).join() === 'a', `only the transpose: ${head.map((i) => i.id)}`);
  assert(timedInsert(chain)?.id === 'b', 'and the arp is what the scheduler drives');
});

check('a bypassed arp does not block the inserts behind it', () => {
  const chain: MidiInsert[] = [
    { ...ins({ kind: 'transpose', semitones: 12 }), id: 'a' },
    { ...ins({ kind: 'arpeggiator', bypass: true }), id: 'b' },
    { ...ins({ kind: 'chorder', intervals: [0, 7] }), id: 'c' },
  ];
  assert(statelessPart(chain).map((i) => i.id).join() === 'a,b,c', 'all three');
  assert(timedInsert(chain) === null, 'nothing to schedule');
});

check('one live key press runs through the stateless head', () => {
  const chain: MidiInsert[] = [
    ins({ kind: 'transpose', semitones: 12 }),
    ins({ kind: 'chorder', intervals: [0, 4, 7], addedLevel: 1 }),
  ];
  const out = liveNotes(60, from7bit(100), 0, chain);
  assert(pitches(out).join() === '72,76,79', pitches(out).join());
});

check('a live key press outside a drop range plays nothing, and that is correct', () => {
  // A split keyboard staying silent above the split is the feature, not a
  // failure — so an empty answer has to be a real answer.
  const chain = [ins({ kind: 'range', lowPitch: 0, highPitch: 59, mode: 'drop' })];
  assert(liveNotes(72, from7bit(100), 0, chain).length === 0, 'silent above the split');
  assert(liveNotes(48, from7bit(100), 0, chain).length === 1, 'and sounding below it');
});

// ── Live and playback agree ─────────────────────────────────────────────────

check('the live arp plays the SAME steps the rendered one does', () => {
  // The property the whole feature rests on.  Compared against the render, not
  // against a description of what an arp should do.
  const arp: ArpeggiatorInsert = {
    kind: 'arpeggiator', direction: 'up', rateBeat: 0.25, gate: 0.9, octaves: 1,
  };
  const held = CHORD();
  const steps = arpStepsFor(held, arp, 0, 8);
  // The rendered version of the same chord held for the same eight steps.
  const rendered = runChain(
    held.map((n) => ({ ...n, startBeat: 0, durationBeat: 8 * 0.25 })),
    [{ ...arp, id: 'x' }],
  ).notes;
  assert(steps.length === rendered.length,
    `same number of steps: live ${steps.length}, rendered ${rendered.length}`);
  for (let i = 0; i < steps.length; i++) {
    const live = steps[i] as { pitch: number; step: number };
    const note = rendered[i] as MidiNote;
    assert(live.pitch === note.pitch, `step ${i}: live ${live.pitch}, rendered ${note.pitch}`);
    near(live.step * 0.25, note.startBeat, 1e-9, `step ${i} lands at the same time`);
  }
});

check('the live arp keeps counting across windows', () => {
  // The scheduler asks for one window at a time; the run must not restart at
  // every window or a held chord stutters on the first note forever.
  const arp: ArpeggiatorInsert = {
    kind: 'arpeggiator', direction: 'up', rateBeat: 0.25, gate: 0.9, octaves: 1,
  };
  const held = CHORD();
  const all = arpStepsFor(held, arp, 0, 6).map((s) => s.pitch);
  const firstHalf = arpStepsFor(held, arp, 0, 3).map((s) => s.pitch);
  const secondHalf = arpStepsFor(held, arp, 3, 6).map((s) => s.pitch);
  assert([...firstHalf, ...secondHalf].join() === all.join(),
    `two windows equal one: ${firstHalf.join()} + ${secondHalf.join()} vs ${all.join()}`);
});

check('the live arp reports the absolute step, not one relative to the window', () => {
  const arp: ArpeggiatorInsert = {
    kind: 'arpeggiator', direction: 'up', rateBeat: 0.25, gate: 0.9, octaves: 1,
  };
  const steps = arpStepsFor(CHORD(), arp, 10, 13);
  assert(steps.map((s) => s.step).join() === '10,11,12', steps.map((s) => s.step).join());
});

check('no held keys is no steps, not a crash', () => {
  const arp: ArpeggiatorInsert = {
    kind: 'arpeggiator', direction: 'up', rateBeat: 0.25, gate: 0.9, octaves: 1,
  };
  assert(arpStepsFor([], arp, 0, 8).length === 0, 'nothing held, nothing played');
  assert(arpStepsFor(CHORD(), arp, 5, 5).length === 0, 'an empty window is empty');
});

check('the step clock follows the tempo', () => {
  const arp: ArpeggiatorInsert = {
    kind: 'arpeggiator', direction: 'up', rateBeat: 0.25, gate: 0.9, octaves: 1,
  };
  near(stepSeconds(arp, 120), 0.125, 1e-9, 'a sixteenth at 120 bpm');
  near(stepSeconds(arp, 60), 0.25, 1e-9, 'twice as long at half the tempo');
  assert(Number.isFinite(stepSeconds(arp, 0)), 'and a nonsense tempo does not divide by zero');
});

// ── Reading a chain back ────────────────────────────────────────────────────

check('a chain reads as a sentence, in order', () => {
  const text = describeChain([
    ins({ kind: 'transpose', semitones: -12 }),
    ins({ kind: 'arpeggiator', rateBeat: 0.25 }),
  ]);
  assert(text.includes('-12') && text.includes('→'), text);
  assert(describeChain([]).includes('없음'), 'and an empty chain says so');
  assert(describeInsert(ins({ kind: 'echo', bypass: true })).includes('꺼짐'),
    'a bypassed insert is marked');
});

check('every kind has a default that runs', () => {
  const kinds = ['transpose', 'velocity', 'range', 'chorder', 'arpeggiator', 'echo'] as const;
  for (const kind of kinds) {
    const insert = defaultInsert(kind, kind);
    const out = runChain(CHORD(), [insert]);
    assert(out.notes.length > 0, `${kind} produced nothing from a chord`);
    assert(!out.overflowed, `${kind} tripped the ceiling on its own default`);
    assert(describeInsert(insert).length > 0, `${kind} has no description`);
  }
});

// ── The chain on a track ────────────────────────────────────────────────────

check('a track without a chain reads as having none, not as an empty one', () => {
  resetIds();
  const track = createTrack('Pad', 'instrument');
  assert(midiInsertsOf(track).length === 0, 'no chain');
  assert(!trackHasInserts(track), 'and it says so');
  // A session saved before inserts existed has no field at all.
  assert(midiInsertsOf(undefined).length === 0, 'and neither does no track');
});

check('a chain of only bypassed inserts is not a chain', () => {
  resetIds();
  const track = setMidiInserts(createTrack('Pad', 'instrument'),
    [ins({ kind: 'arpeggiator', bypass: true })]);
  assert(midiInsertsOf(track).length === 1, 'the insert is kept');
  assert(!trackHasInserts(track), 'but the track is not running one');
});

check('a part with no chain is handed back BY REFERENCE', () => {
  // Most tracks have no chain and must not pay for the feature — not a walk,
  // not an array.
  const notes = CHORD();
  assert(insertedNotes([], notes).notes === notes, 'the same array');
});

check('the inserted part is computed once and reused', () => {
  const chain = [ins({ kind: 'arpeggiator', rateBeat: 0.25 })];
  const notes = CHORD();
  const first = insertedNotes(chain, notes).notes;
  assert(insertedNotes(chain, notes).notes === first, 'a second read is the same object');
  assert(cachedInsertsFor(notes) === first, 'because it was cached');
});

check('the cache is a cache, not a source of truth', () => {
  // Both of the things it depends on, changed one at a time.  Getting this
  // wrong means an edited chain or an edited part keeps playing the old one,
  // which looks exactly like "the insert does nothing".
  const chain = [ins({ kind: 'transpose', semitones: 12 })];
  const notes = part([[60, 0]]);
  const first = insertedNotes(chain, notes).notes;
  assert(pitches([...first]).join() === '72', 'transposed');

  const edited = [ins({ kind: 'transpose', semitones: 7 })];
  const second = insertedNotes(edited, notes).notes;
  assert(second !== first, 'a changed chain is recomputed');
  assert(pitches([...second]).join() === '67', 'and plays the new interval');

  const moreNotes = part([[60, 0], [64, 1]]);
  assert(insertedNotes(edited, moreNotes).notes.length === 2, 'a changed part is recomputed');
});

check('an overflow is reported through the track path too', () => {
  const notes = part([[60, 0, 100, 64], [64, 0, 100, 64], [67, 0, 100, 64]]);
  const chain = [
    ins({ kind: 'chorder', intervals: [0, 3, 5, 7, 10] }),
    ins({ kind: 'arpeggiator', rateBeat: 1 / 32, octaves: 4 }),
    ins({ kind: 'echo', repeats: 6, feedback: 0.98, delayBeat: 0.02 }),
  ];
  assert(insertedNotes(chain, notes).overflowed, 'the caller can say so');
});

// ─────────────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== MIDI inserts: the chain before the instrument ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
