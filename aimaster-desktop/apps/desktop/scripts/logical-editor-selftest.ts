/**
 * logical-editor-selftest.ts — select by rule, change by rule.
 *
 * The things worth testing hard here are the ones that produce a part that
 * looks edited and is wrong:
 *
 *   • The filter running against notes it has already changed, so a note is
 *     transposed twice because the first transpose moved it into range.
 *   • Velocity spoken in the wrong units.  The model stores 0…1 and every
 *     human says 1…127; a rule reading "velocity < 40" that compares against
 *     0.315 matches nothing and looks like the rule engine is broken.
 *   • A transpose that pushes notes off the end of the keyboard and flattens
 *     them onto pitch 127 without saying so.
 *   • `and`/`or` precedence, which decides which notes are touched at all.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:logical-editor
 */

import {
  EMPTY_RULE, RULE_PRESETS, describeAction, describeCondition, describeResult,
  describeRule, matches, readProperty, ruleProblem, runRule, selectNotes,
  type Action, type Condition, type Rule, type RuleContext,
} from '../src/renderer/daw/edit/logical-editor.js';
import {
  createNote, from7bit, resetNoteIds, to7bit, type MidiNote,
} from '../src/renderer/daw/model/midi.js';
import { defaultTempoMap } from '../src/renderer/daw/model/tempo-map.js';

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
    pitch, startBeat,
    velocity: from7bit(vel ?? 100),
    durationBeat: len ?? 0.5,
  }));
}
const vels = (notes: readonly MidiNote[]): number[] => notes.map((n) => to7bit(n.velocity));
const pitches = (notes: readonly MidiNote[]): number[] => notes.map((n) => n.pitch);
const rule = (over: Partial<Rule>): Rule => ({ ...EMPTY_RULE, ...over });
const cond = (
  property: Condition['property'], comparison: Condition['comparison'],
  value: number, over: Partial<Condition> = {},
): Condition => ({ property, comparison, value, ...over });
const act = (
  property: Action['property'], operation: Action['operation'], value: number,
): Action => ({ property, operation, value });

// ── Units ───────────────────────────────────────────────────────────────────

check('velocity is read and written in 7-bit, not 0…1', () => {
  // The whole reason this is a test: a rule reading "velocity < 40" that
  // compared against the stored 0…1 would match nothing and look broken.
  const notes = part([[60, 0, 30], [62, 1, 100]]);
  near(readProperty(notes[0] as MidiNote, 'velocity'), 30, 0.6, 'read as 30, not 0.24');

  const quieter = runRule(notes, rule({
    conditions: [cond('velocity', 'less', 40)],
    actions: [act('velocity', 'set', 20)],
  }));
  assert(vels(quieter.notes).join() === '20,100', vels(quieter.notes).join());
  near((quieter.notes[0] as MidiNote).velocity, from7bit(20), 1e-9,
    'and it went back into the model as a 0…1 value');
});

check('the properties read what they say they read', () => {
  const notes = part([[64, 2.5, 77, 1.25]]);
  const n = notes[0] as MidiNote;
  near(readProperty(n, 'pitch'), 64, 0, 'pitch');
  near(readProperty(n, 'position'), 2.5, 1e-9, 'position in beats');
  near(readProperty(n, 'length'), 1.25, 1e-9, 'length in beats');
  near(readProperty(n, 'channel'), 0, 0, 'channel');
  near(readProperty(n, 'muted'), 0, 0, 'muted as 0/1 so the comparisons work');
});

check('bar and beat-in-bar come from the meter, not from arithmetic', () => {
  const notes = part([[60, 0], [62, 4], [64, 6]]);
  const four: RuleContext = { tempoMap: defaultTempoMap(120, [4, 4]) };
  near(readProperty(notes[1] as MidiNote, 'bar', four), 2, 0, 'beat 4 is bar 2 in 4/4');
  near(readProperty(notes[2] as MidiNote, 'barBeat', four), 3, 1e-6, 'and its third beat');

  // 3/4: beat 4 is bar 2 beat 2, not bar 2 beat 1.
  const three: RuleContext = { tempoMap: defaultTempoMap(120, [3, 4]) };
  near(readProperty(notes[1] as MidiNote, 'bar', three), 2, 0, 'beat 4 is bar 2 in 3/4');
  near(readProperty(notes[1] as MidiNote, 'barBeat', three), 2, 1e-6, 'on its SECOND beat');
});

// ── Matching ────────────────────────────────────────────────────────────────

check('no conditions matches the whole part', () => {
  // A rule that is only actions means "do this to everything"; one that
  // matched nothing until a condition was added would look broken.
  const notes = part([[60, 0], [62, 1]]);
  assert(selectNotes(notes, EMPTY_RULE).length === 2, 'both');
});

check('a range is inclusive at both ends, and survives being typed backwards', () => {
  const notes = part([[59, 0], [60, 1], [67, 2], [68, 3]]);
  const inside = selectNotes(notes, rule({
    conditions: [cond('pitch', 'inside', 60, { value2: 67 })] }));
  assert(pitches(inside).join() === '60,67', `both ends included: ${pitches(inside)}`);

  const backwards = selectNotes(notes, rule({
    conditions: [cond('pitch', 'inside', 67, { value2: 60 })] }));
  assert(pitches(backwards).join() === '60,67', 'a backwards range is still the range meant');

  const outside = selectNotes(notes, rule({
    conditions: [cond('pitch', 'outside', 60, { value2: 67 })] }));
  assert(pitches(outside).join() === '59,68', `and outside is the complement: ${pitches(outside)}`);
});

check('AND binds tighter than OR', () => {
  // `pitch = 60  OR  velocity > 90 AND length > 1`
  // Read as (60) or (loud and long).  The other reading — (60 or loud) and
  // long — would drop the short 60, which is a different set of notes and a
  // different edit.
  const notes = part([
    [60, 0, 20, 0.25],   // the short 60
    [72, 1, 120, 2],     // loud and long
    [74, 2, 120, 0.25],  // loud, short
    [76, 3, 20, 2],      // quiet, long
  ]);
  const picked = selectNotes(notes, rule({ conditions: [
    cond('pitch', 'equal', 60),
    cond('velocity', 'greater', 90, { join: 'or' }),
    cond('length', 'greater', 1, { join: 'and' }),
  ] }));
  assert(pitches(picked).join() === '60,72', `got ${pitches(picked)}`);
});

check('a chain of ANDs narrows, a chain of ORs widens', () => {
  const notes = part([[60, 0, 20], [64, 1, 100], [67, 2, 127]]);
  const both = selectNotes(notes, rule({ conditions: [
    cond('pitch', 'greaterOrEqual', 64),
    cond('velocity', 'greater', 110, { join: 'and' }),
  ] }));
  assert(pitches(both).join() === '67', `AND: ${pitches(both)}`);
  const either = selectNotes(notes, rule({ conditions: [
    cond('pitch', 'equal', 60),
    cond('velocity', 'greater', 110, { join: 'or' }),
  ] }));
  assert(pitches(either).join() === '60,67', `OR: ${pitches(either)}`);
});

// ── The filter runs first ───────────────────────────────────────────────────

check('the matched set is a snapshot of the originals, not of the result', () => {
  // `matched` is what the caller uses afterwards — copy and extract build
  // from it, and the UI selects those notes to show what the rule caught.
  // Handing back the CHANGED notes would make "it matched these" describe
  // something that did not exist when the rule was written.
  const notes = part([[60, 0], [70, 1]]);
  const done = runRule(notes, rule({
    conditions: [cond('pitch', 'less', 65)],
    actions: [act('pitch', 'add', 5)],
  }));
  assert(pitches(done.notes).join() === '65,70', `got ${pitches(done.notes)}`);
  assert(done.matched.length === 1, 'one note matched');
  assert((done.matched[0] as MidiNote).pitch === 60, 'reported as it was before the change');
});

// ── Operations ──────────────────────────────────────────────────────────────

check('the arithmetic operations do their arithmetic', () => {
  const one = part([[60, 4, 64, 1]]);
  const run = (a: Action): MidiNote => runRule(one, rule({ actions: [a] })).notes[0] as MidiNote;
  assert(run(act('pitch', 'set', 40)).pitch === 40, 'set');
  assert(run(act('pitch', 'add', 12)).pitch === 72, 'add');
  assert(run(act('pitch', 'subtract', 12)).pitch === 48, 'subtract');
  near(run(act('position', 'multiply', 2)).startBeat, 8, 1e-9, 'multiply');
  near(run(act('position', 'divide', 2)).startBeat, 2, 1e-9, 'divide');
  near(run(act('position', 'roundTo', 3)).startBeat, 3, 1e-9, 'roundTo');
  assert(to7bit(run(act('velocity', 'mirror', 64)).velocity) === 64, 'mirror around itself');
  assert(to7bit(runRule(part([[60, 0, 40]]), rule({
    actions: [act('velocity', 'mirror', 64)] })).notes[0]!.velocity) === 88,
    'and mirror inverts a ramp: 40 → 88');
});

check('randomize is deterministic, and different per note', () => {
  const notes = part([[60, 1], [62, 1], [64, 1]]);
  const r = rule({ actions: [act('position', 'randomize', 0.05)], seed: 7 });
  const a = runRule(notes, r).notes.map((n) => n.startBeat);
  const b = runRule(notes, r).notes.map((n) => n.startBeat);
  assert(a.join() === b.join(), 'the same rule on the same part repeats exactly');
  assert(new Set(a).size === 3, 'and every note moved differently');
  for (const v of a) assert(Math.abs(v - 1) <= 0.05 + 1e-9, `within ±0.05: ${v}`);
  const other = runRule(notes, { ...r, seed: 8 }).notes.map((n) => n.startBeat);
  assert(other.join() !== a.join(), 'a different seed is a different spread');
});

// ── Limits ──────────────────────────────────────────────────────────────────

check('a value that runs off the end is clamped AND reported', () => {
  // Twelve notes flattened onto pitch 127 is something to be told about, not
  // to discover by listening.
  const notes = part([[120, 0], [125, 1], [60, 2]]);
  const done = runRule(notes, rule({ actions: [act('pitch', 'add', 12)] }));
  // Sorted by position, so the two clamped notes (beats 0 and 1) come first.
  assert(pitches(done.notes).join() === '127,127,72', `got ${pitches(done.notes)}`);
  assert(done.clamped === 2, `two hit the ceiling, got ${done.clamped}`);
  assert(describeResult(rule({}), done).includes('2개'), describeResult(rule({}), done));
});

check('nothing is dropped by a transform, only held', () => {
  const notes = part([[0, 0], [1, 1]]);
  const done = runRule(notes, rule({ actions: [act('pitch', 'subtract', 24)] }));
  assert(done.notes.length === 2, 'both notes are still there');
  assert(pitches(done.notes).join() === '0,0', 'held at the floor');
});

check('a note is never shortened to nothing', () => {
  const done = runRule(part([[60, 0, 100, 1]]), rule({
    actions: [act('length', 'multiply', 0) ] }));
  assert((done.notes[0] as MidiNote).durationBeat > 0,
    'a zero-length note is inaudible and un-clickable');
});

// ── Modes ───────────────────────────────────────────────────────────────────

check('select changes nothing and reports what it picked', () => {
  const notes = part([[60, 0, 20], [72, 1, 120]]);
  const done = runRule(notes, rule({
    mode: 'select',
    conditions: [cond('velocity', 'greater', 90)],
    actions: [act('pitch', 'add', 12)],
  }));
  assert(pitches(done.notes).join() === '60,72', 'the part is untouched');
  assert(done.matched.length === 1 && (done.matched[0] as MidiNote).pitch === 72, 'one picked');
});

check('delete removes the matched and keeps the rest', () => {
  const notes = part([[60, 0, 20], [72, 1, 120]]);
  const done = runRule(notes, rule({
    mode: 'delete', conditions: [cond('velocity', 'less', 40)] }));
  assert(pitches(done.notes).join() === '72', 'the quiet one is gone');
  assert(done.removed.length === 1, 'and reported as removed');
});

check('extract takes the matched OUT and hands them back separately', () => {
  const notes = part([[40, 0], [60, 1], [43, 2]]);
  const done = runRule(notes, rule({
    mode: 'extract', conditions: [cond('pitch', 'lessOrEqual', 47)] }));
  assert(pitches(done.notes).join() === '60', 'the part keeps what did not match');
  assert(pitches(done.extracted).join() === '40,43', `and the bass comes out: ${pitches(done.extracted)}`);
});

check('copy leaves the originals and adds transformed duplicates', () => {
  const notes = part([[60, 0], [64, 1]]);
  const done = runRule(notes, rule({
    mode: 'copy', actions: [act('pitch', 'subtract', 12)] }));
  assert(done.notes.length === 4, `two plus two, got ${done.notes.length}`);
  // Sorted by position first: beat 0 holds 60 and its copy, beat 1 holds 64
  // and its copy.  The copy sits under its original, which is what a doubling
  // an octave down should look like in the roll.
  assert(pitches(done.notes).join() === '48,60,52,64', pitches(done.notes).join());
});

check('copies get their OWN ids', () => {
  // Two notes claiming to be the same one would make selection, undo and the
  // drum-map cache all pick whichever they found first.
  const notes = part([[60, 0]]);
  const done = runRule(notes, rule({ mode: 'copy', actions: [act('pitch', 'add', 7)] }));
  const ids = done.notes.map((n) => n.id);
  assert(new Set(ids).size === ids.length, `ids are unique: ${ids.join()}`);
});

// ── Refusing what cannot mean anything ──────────────────────────────────────

check('a rule that cannot run says so instead of running', () => {
  assert(ruleProblem(rule({ actions: [act('pitch', 'divide', 0)] }))?.includes('0'),
    'divide by zero is refused when the rule is built');
  assert(ruleProblem(rule({ actions: [act('position', 'roundTo', 0)] })) !== null,
    'and so is rounding to nothing');
  assert(ruleProblem(rule({ actions: [] })) !== null, 'a transform with no actions');
  assert(ruleProblem(rule({ mode: 'copy', actions: [] })) !== null,
    'and a copy with no actions, which would lay a twin on every note');
  assert(ruleProblem(rule({ mode: 'delete', actions: [] })) === null,
    'but delete needs no actions');
  assert(ruleProblem(rule({ mode: 'extract', actions: [] })) === null,
    'and neither does extract — taking the bass out unchanged IS the rule');
  assert(ruleProblem(rule({ mode: 'select', actions: [] })) === null, 'nor select');
  assert(ruleProblem(rule({ actions: [act('pitch', 'add', 1)] })) === null, 'a sane rule is fine');
});

check('the read-only properties are refused as targets, not silently ignored', () => {
  // `bar` is a VIEW of position through the meter.  Writing it would mean
  // solving for a beat under a map whose signature can change underneath the
  // answer — so it is refused with a message that says what to use instead.
  const problem = ruleProblem(rule({ actions: [act('bar', 'set', 3)] }));
  assert(problem !== null && problem.includes('위치'), `${problem}`);
  // And a rule built by hand that gets past the check still cannot corrupt.
  const done = runRule(part([[60, 4]]), rule({ actions: [act('bar', 'set', 1)] }));
  near((done.notes[0] as MidiNote).startBeat, 4, 1e-9, 'the note did not move');
});

check('a divide by zero that reaches the runner cannot put Infinity in a part', () => {
  const done = runRule(part([[60, 4]]), rule({ actions: [act('position', 'divide', 0)] }));
  assert(Number.isFinite((done.notes[0] as MidiNote).startBeat), 'still a number');
});

// ── Reading a rule back ─────────────────────────────────────────────────────

check('a rule reads as a sentence', () => {
  const text = describeRule(rule({
    name: 'x',
    conditions: [cond('velocity', 'less', 45)],
    actions: [act('velocity', 'multiply', 0.7)],
  }));
  assert(text.includes('벨로시티') && text.includes('45') && text.includes('0.7'), text);
  assert(describeCondition(cond('pitch', 'inside', 67, { value2: 60 })).includes('60…67'),
    'a backwards range reads the way it will behave');
  assert(describeAction(act('pitch', 'add', 12)).includes('음정'), 'and an action names its target');
  assert(describeRule(EMPTY_RULE).includes('모든 노트'), 'no conditions says so');
});

check('a run that matched nothing says nothing matched', () => {
  const done = runRule(part([[60, 0]]), rule({ conditions: [cond('pitch', 'equal', 99)] }));
  assert(describeResult(rule({}), done).includes('없습니다'), describeResult(rule({}), done));
});

// ── The presets ─────────────────────────────────────────────────────────────

check('every preset is runnable and does something', () => {
  const notes = part([
    [36, 0, 120, 0.25], [42, 0.5, 30, 0.02], [38, 1, 100, 0.5],
    [60, 2, 64, 1], [72, 3, 110, 0.5],
  ]);
  const context: RuleContext = { tempoMap: defaultTempoMap(120, [4, 4]) };
  for (const preset of RULE_PRESETS) {
    assert(ruleProblem(preset) === null, `${preset.name}: ${ruleProblem(preset)}`);
    const done = runRule(notes, preset, context);
    assert(done.matched.length > 0, `${preset.name} matched nothing on a normal part`);
    assert(Number.isFinite(done.notes[0]?.startBeat ?? 0), `${preset.name} produced a number`);
  }
});

check('no two presets are the same rule wearing two names', () => {
  const seen = new Map<string, string>();
  for (const preset of RULE_PRESETS) {
    const key = JSON.stringify({ m: preset.mode, c: preset.conditions, a: preset.actions });
    const twin = seen.get(key);
    assert(!twin, `${preset.name} is the same rule as ${twin}`);
    seen.set(key, preset.name);
  }
});

check('the ghost-note preset touches only the ghost notes', () => {
  const preset = RULE_PRESETS.find((p) => p.name.includes('고스트')) as Rule;
  const notes = part([[38, 0, 30], [38, 1, 100]]);
  const done = runRule(notes, preset);
  assert(vels(done.notes)[1] === 100, 'the accented hit is untouched');
  assert((vels(done.notes)[0] as number) < 30, 'and the ghost got quieter');
});

// ─────────────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Logical editor: select by rule, change by rule ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
