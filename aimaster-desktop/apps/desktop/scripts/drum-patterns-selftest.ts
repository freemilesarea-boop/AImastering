/**
 * drum-patterns-selftest.ts — twenty beats, and whether they are beats.
 *
 * A pattern table has exactly one kind of bug: a hit on the wrong step.  It
 * does not crash, it does not throw, and it passes any check that only looks
 * at shapes.  So the checks here are about WHERE THE HITS ARE, in beats, after
 * going through the real converter:
 *
 *   · a backbeat has its snare on 2 and 4 — that is what the word means
 *   · four-on-the-floor has its kick on every beat and 팝's does not
 *   · a trap beat has hi-hat rolls, or it is a slow sixteenth pattern
 *   · 재즈 is on a TRIPLET grid, so its ride lands on thirds of a beat that a
 *     sixteenth grid cannot express
 *   · every pattern's ghost notes are quieter than its accents, or the chart
 *     is a grid rather than a groove
 *
 * And the thing a table of charts is most likely to get wrong in review: two
 * rows of different length in the same pattern, which silently truncates one
 * drum and shifts nothing else.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:drum-patterns
 */

import { readFileSync } from 'node:fs';
import {
  DRUM_PATTERNS, describePattern, findPattern, patternBeatLength, patternFill,
  patternNotes, patternSteps, patternsForGenre, toStepPattern,
  type DrumPattern,
} from '../src/renderer/daw/engine/drum-patterns.js';
import { GENRE_ORDER, GENRE_LABEL, type GenreId } from '../src/renderer/daw/engine/plugin-presets-genre.js';
import { kitPitches } from '../src/renderer/daw/engine/drum-model.js';
import type { MidiNote } from '../src/renderer/daw/model/midi.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];

function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: (e as Error).message }); }
}
function assert(cond: boolean, detail: string): void {
  if (!cond) throw new Error(detail);
}

const KICK = 36, SNARE = 38, CLAP = 39, HAT = 42, RIDE = 51;

function pattern(id: string): DrumPattern {
  const p = findPattern(id);
  if (!p) throw new Error(`no pattern ${id}`);
  return p;
}
/** The beats a given drum lands on, one cycle. */
function beatsOf(id: string, pitch: number): number[] {
  return patternNotes(pattern(id), 1)
    .filter((n) => n.pitch === pitch)
    .map((n) => +n.startBeat.toFixed(4));
}
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

// ── The charts ───────────────────────────────────────────────────────────────

check('every genre has beats, and they are not the same beat twice', () => {
  for (const g of GENRE_ORDER) {
    const ps = patternsForGenre(g);
    assert(ps.length >= 2, `${GENRE_LABEL[g]} has ${ps.length} pattern(s)`);
    // Two entries that differ only in name would be worse than one entry.
    const shapes = ps.map((p) => JSON.stringify(p.rows.map((r) => [r.pitch, r.steps])));
    assert(new Set(shapes).size === ps.length, `${GENRE_LABEL[g]} repeats itself`);
  }
  assert(DRUM_PATTERNS.length >= 20, `only ${DRUM_PATTERNS.length} patterns`);
  assert(new Set(DRUM_PATTERNS.map((p) => p.id)).size === DRUM_PATTERNS.length,
    'two patterns share an id');
});

check('no chart has rows of different lengths', () => {
  // The bug this table is most likely to have in review: one row a character
  // short truncates that drum and shifts nothing else, so the beat is subtly
  // wrong in exactly one place.
  for (const p of DRUM_PATTERNS) {
    const lengths = new Set(p.rows.map((r) => r.steps.length));
    assert(lengths.size === 1,
      `${p.id} has rows of ${[...lengths].sort((a, b) => a - b).join(', ')} steps`);
    assert(patternSteps(p) % p.stepsPerBeat === 0,
      `${p.id} is ${patternSteps(p)} steps at ${p.stepsPerBeat}/beat — not a whole number of beats`);
  }
});

check('every chart uses only characters the reader knows', () => {
  for (const p of DRUM_PATTERNS) {
    for (const row of p.rows) {
      const bad = [...row.steps].filter((c) => !'-xXo2345678'.includes(c));
      assert(bad.length === 0, `${p.id} pitch ${row.pitch} uses ${JSON.stringify(bad.join(''))}`);
    }
  }
});

check('every drum a chart names is a drum the kit has', () => {
  // A row on a pitch the kit does not define falls back to a neighbour, which
  // is fine for an imported file and wrong for a beat we wrote ourselves.
  const known = new Set(kitPitches());
  for (const p of DRUM_PATTERNS) {
    for (const row of p.rows) {
      assert(known.has(row.pitch), `${p.id} plays pitch ${row.pitch}, which the kit does not have`);
    }
  }
});

check('a chart with no hits would be caught', () => {
  for (const p of DRUM_PATTERNS) {
    const notes = patternNotes(p, 1);
    assert(notes.length >= 4, `${p.id} produces only ${notes.length} notes`);
    assert(notes.every((n) => n.startBeat >= 0), `${p.id} has a note before beat 0`);
    const end = patternBeatLength(p);
    assert(notes.every((n) => n.startBeat < end + 1e-6),
      `${p.id} has a note past its own length`);
  }
});

// ── Where the hits actually are ──────────────────────────────────────────────

check('a backbeat has its snare on 2 and 4', () => {
  // The word means this and nothing else.
  assert(beatsOf('pop-backbeat', SNARE).join(',') === '1,3',
    `팝 backbeat snare on ${beatsOf('pop-backbeat', SNARE).join(', ')}`);
  // Beats are 0-based here: beat 1 of the bar is 0.  So 1 and 3 IS 2 and 4.
  assert(beatsOf('pop-backbeat', KICK)[0] === 0, 'the kick does not start the bar');
  assert(beatsOf('pop-backbeat', HAT).length === 8, 'the hats are not eighths');
});

check('four-on-the-floor is on the floor, and 팝 is not', () => {
  assert(beatsOf('edm-four', KICK).join(',') === '0,1,2,3',
    `EDM kick on ${beatsOf('edm-four', KICK).join(', ')}`);
  assert(beatsOf('kpop-drop', KICK).join(',') === '0,1,2,3',
    `K-POP drop kick on ${beatsOf('kpop-drop', KICK).join(', ')}`);
  assert(beatsOf('pop-backbeat', KICK).join(',') !== '0,1,2,3',
    'the 팝 backbeat is four-on-the-floor');
  // The clap answers on 2 and 4, which is what makes it a dance beat rather
  // than a march.
  assert(beatsOf('edm-four', CLAP).join(',') === '1,3', beatsOf('edm-four', CLAP).join(','));
});

check('trap has rolls, and the rolls are inside their own step', () => {
  const hats = beatsOf('hiphop-trap', HAT);
  assert(hats.length > 16, `the trap hat plays ${hats.length} times — no rolls`);
  // A ratchet divides ITS step; if it ran over, the next hit would be late or
  // doubled.  Every hat must still sit inside one sixteenth of the grid.
  const step = 0.25;
  const cycle = patternBeatLength(pattern('hiphop-trap'));
  assert(hats.every((b) => b >= 0 && b < cycle), 'a roll ran past the bar');
  const inSteps = new Set(hats.map((b) => Math.floor(b / step + 1e-6)));
  assert(inSteps.size <= 16, 'a roll spilled into a step of its own');
  // And the retriggers taper, or a roll sounds like a machine.
  const notes = patternNotes(pattern('hiphop-trap'), 1).filter((n) => n.pitch === HAT);
  const byStep = new Map<number, MidiNote[]>();
  for (const n of notes) {
    const k = Math.floor(n.startBeat / step + 1e-6);
    byStep.set(k, [...(byStep.get(k) ?? []), n]);
  }
  const rolled = [...byStep.values()].find((g) => g.length > 1);
  assert(rolled !== undefined, 'no step actually retriggered');
  assert(rolled![1]!.velocity < rolled![0]!.velocity, 'a roll does not taper');
});

check('재즈 is on triplets, which a sixteenth grid cannot say', () => {
  const ride = beatsOf('jazz-ride', RIDE);
  // A third of a beat is 0.3333 — not expressible on a 16th grid, and the
  // reason these two charts are the only ones with stepsPerBeat 3.
  assert(pattern('jazz-ride').stepsPerBeat === 3, 'the jazz grid is not triplets');
  const hasThird = ride.some((b) => Math.abs((b % 1) - 2 / 3) < 1e-3);
  assert(hasThird, `no ride hit on a third of a beat: ${ride.join(', ')}`);
  assert(ride.includes(0) && ride.includes(1), `the ride misses a downbeat: ${ride.join(', ')}`);
  // The feathered kick is on every beat and very quiet — that IS the style.
  const kicks = patternNotes(pattern('jazz-ride'), 1).filter((n) => n.pitch === KICK);
  assert(kicks.length === 4, `${kicks.length} feathered kicks`);
  assert(kicks.every((n) => n.velocity < 0.45), 'the feathered kick is not feathered');
});

check('a ghost note is quieter than an accent, everywhere', () => {
  // If these ever converge, every chart is a grid: the velocities are what
  // make it a groove.
  for (const p of DRUM_PATTERNS) {
    const chars = p.rows.flatMap((r) => [...r.steps]);
    if (!chars.includes('o') || !chars.includes('X')) continue;
    const notes = patternNotes(p, 1);
    const loud = Math.max(...notes.map((n) => n.velocity));
    const soft = Math.min(...notes.map((n) => n.velocity));
    assert(loud > soft * 1.8, `${p.id}: accent ${loud.toFixed(2)} vs ghost ${soft.toFixed(2)}`);
  }
});

check('swing moves the off-beats and nothing else', () => {
  const swung = DRUM_PATTERNS.filter((p) => p.swing > 0);
  assert(swung.length >= 4, `only ${swung.length} patterns swing`);
  for (const p of swung) {
    const notes = patternNotes(p, 1);
    const step = 1 / p.stepsPerBeat;
    for (const n of notes) {
      const index = Math.round(n.startBeat / step);
      const offset = n.startBeat - index * step;
      if (index % 2 === 0) {
        // Even steps sit on the grid.  A ratchet's retriggers are the one
        // thing allowed off it, and none of the swung charts use ratchets.
        assert(Math.abs(offset) < 1e-6,
          `${p.id}: an on-beat hit at ${n.startBeat.toFixed(4)} moved`);
      } else {
        assert(offset > 0, `${p.id}: an off-beat hit did not swing late`);
      }
    }
  }
});

check('a straight pattern is straight', () => {
  // Written loosely the first time — `off < 0.5` against a quantity never
  // anywhere near 0.5 is a check that passes everything.  Tightened to
  // eighths of a step, it immediately caught something real about ITSELF:
  // a ratchet of 3 puts hits on THIRDS of a step, so eighths is the wrong
  // lattice.  840 is lcm(1..8) — exact for every ratchet the reader accepts.
  const LATTICE = 840;
  for (const p of DRUM_PATTERNS.filter((x) => x.swing === 0)) {
    for (const n of patternNotes(p, 1)) {
      const units = n.startBeat * p.stepsPerBeat * LATTICE;
      const off = Math.abs(units - Math.round(units));
      assert(off < 1e-6,
        `${p.id}: a hit at beat ${n.startBeat.toFixed(5)} is off every clean subdivision`);
    }
  }
});

// ── Dropping one on a track ──────────────────────────────────────────────────

check('a pattern fills four bars, whatever length it is', () => {
  // One bar of a beat is a demonstration, not a part.  The rack's other
  // button makes four bars; this has to match or the arrangement gets ragged.
  for (const p of DRUM_PATTERNS) {
    const { repeats, beats } = patternFill(p, 4);
    assert(beats >= 16 - 1e-6, `${p.id} fills only ${beats} beats`);
    assert(repeats >= 1, `${p.id} repeats ${repeats} times`);
    // And the repeats do not overlap: the last cycle's notes stay inside.
    const notes = patternNotes(p, repeats);
    assert(notes.every((n) => n.startBeat < beats + 1e-6),
      `${p.id} spills past ${beats} beats`);
    assert(notes.length === patternNotes(p, 1).length * repeats,
      `${p.id} loses notes when repeated`);
  }
  // The two-bar 앰비언트 chart needs two repeats where a one-bar chart needs
  // four — the arithmetic, not a constant.
  assert(patternFill(pattern('ambient-pulse'), 4).repeats === 2,
    `앰비언트 repeats ${patternFill(pattern('ambient-pulse'), 4).repeats} times`);
  assert(patternFill(pattern('pop-backbeat'), 4).repeats === 4,
    `팝 repeats ${patternFill(pattern('pop-backbeat'), 4).repeats} times`);
});

check('repeating lays the cycles end to end, not on top of each other', () => {
  const one = beatsOf('pop-backbeat', SNARE);
  const four = patternNotes(pattern('pop-backbeat'), 4)
    .filter((n) => n.pitch === SNARE).map((n) => +n.startBeat.toFixed(4));
  assert(four.length === one.length * 4, `${four.length} snares in four bars`);
  assert(four.join(',') === '1,3,5,7,9,11,13,15', four.join(','));
});

check('the chart goes through the step sequencer, not around it', () => {
  // A second converter here would be a second definition of where a swung
  // sixteenth falls, and the two would disagree within a month.
  const src = stripComments(
    readFileSync(new URL('../src/renderer/daw/engine/drum-patterns.ts', import.meta.url), 'utf8'));
  assert(/stepsToNotes\(/.test(src), 'the patterns do not use stepsToNotes');
  assert(!/createNote\(/.test(src), 'the patterns build notes themselves');
  // And a chart really does become an editable grid.
  const step = toStepPattern(pattern('pop-backbeat'));
  assert(step.stepCount === 16, `${step.stepCount} steps`);
  assert(step.channels.length === pattern('pop-backbeat').rows.length, 'rows lost');
  assert(step.channels.some((c) => c.steps.some((s) => s.on)), 'the grid is empty');
});

check('the rack can drop a beat on a drum track', () => {
  const rack = stripComments(
    readFileSync(new URL('../src/renderer/components/daw/InstrumentRack.tsx', import.meta.url), 'utf8'));
  const at = rack.indexOf("slot.instrumentId === 'drumkit'");
  assert(at > 0, 'the drum controls are not gated on a drum slot');
  const near = rack.slice(at, at + 2200);
  assert(/DRUM_PATTERNS\.filter/.test(near), 'the pattern menu does not enumerate the patterns');
  assert(/addPattern\(/.test(near), 'the pattern menu inserts nothing');
  assert(/patternNotes\(/.test(rack), 'nothing turns a chart into notes');
  assert(/patternFill\(/.test(rack), 'the inserted part is not filled to length');
  assert(!/'pop-backbeat'\s*,/.test(rack), 'the rack hardcodes a pattern list');
});

check('every pattern says what it is', () => {
  for (const p of DRUM_PATTERNS) {
    assert(p.note.trim().length > 8, `${p.id} has no note`);
    assert(p.name.trim().length > 0, `${p.id} has no name`);
    const line = describePattern(p);
    assert(line.startsWith(GENRE_LABEL[p.genre as GenreId]), line);
    assert(line.includes(p.name), line);
  }
});

console.log('\n=== Drum patterns — twenty beats, and where the hits are ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
if (bad) process.exit(1);
