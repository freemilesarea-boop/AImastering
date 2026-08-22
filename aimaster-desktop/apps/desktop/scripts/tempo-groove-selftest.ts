/**
 * tempo-groove-selftest — reading the tempo, and lifting the feel off a take.
 *
 * Two things are being tested and they fail in opposite directions.
 *
 * A TEMPO DETECTOR fails by being confident.  Any list of onsets can be made
 * to fit some grid, so the tests here are mostly about the answers it must
 * REFUSE to give — too few attacks, too short a window, material with no
 * pulse — and about the classic wrong answer, double time, which is what you
 * get when the snare halfway between the kicks is counted as a beat.
 *
 * A GROOVE EXTRACTOR fails by being complete.  It is easy to produce a full
 * template where every slot has a number; it is right to produce one where
 * the slots that were never played say so, because `applyGroove` must leave
 * those notes alone.  A groove that quietly quantises the notes it knows
 * nothing about is a quantiser with better marketing.
 *
 * The material is synthetic and the ground truth is therefore known exactly:
 * a grid built at a stated BPM with a stated phase and a stated swing, then
 * measured back.
 *
 * Run: pnpm --filter @aimaster/desktop test:tempo-groove
 */

import {
  TRUST_THRESHOLD, describeDetection, detectTempo, evenWeights,
} from '../src/renderer/daw/model/tempo-detect.js';
import type { WeightedOnset } from '../src/renderer/daw/model/tempo-detect.js';
import {
  applyGroove, chooseGrid, describeGroove, extractGroove, gridConsistency,
  grooveDepth, grooveKnows, onsetsFromNotes, onsetsToBeats, swingPercent,
} from '../src/renderer/daw/model/groove.js';
import type { Groove, GrooveOnset } from '../src/renderer/daw/model/groove.js';
import { createNote, from7bit } from '../src/renderer/daw/model/midi.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import {
  addTrack, createMidiPart, createSession, createTrack, findTrack, trackClips, updateClip,
} from '../src/renderer/daw/model/session-ops.js';
import {
  applyGrooveToPart, extractClipGroove, matchSessionTempo,
} from '../src/renderer/daw/edit/tempo-groove-actions.js';
import type { DawSession } from '../src/renderer/daw/model/types.js';

const results: { name: string; pass: boolean }[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true }); console.log(`[PASS] ${name}`); }
  catch (err) {
    results.push({ name, pass: false });
    console.log(`[FAIL] ${name} — ${err instanceof Error ? err.message : String(err)}`);
  }
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function eq(a: unknown, b: unknown, msg: string): void {
  if (a !== b) throw new Error(`${msg} — got ${String(a)}, want ${String(b)}`);
}
function close(a: number, b: number, msg: string, tol = 1e-6): void {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg} — got ${a}, want ${b} ±${tol}`);
}

/** Deterministic jitter — a performance, not a machine, and reproducible. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** `count` beats at `bpm`, first beat at `phaseSec`. */
function click(bpm: number, count: number, phaseSec = 0, jitterSec = 0, seed = 7): WeightedOnset[] {
  const rng = makeRng(seed);
  const period = 60 / bpm;
  return Array.from({ length: count }, (_, i) => ({
    timeSec: phaseSec + i * period + (jitterSec > 0 ? (rng() * 2 - 1) * jitterSec : 0),
    weight: 1,
  }));
}

// ── Tempo detection ───────────────────────────────────────────────────────────

check('a bare click at 120 is read as 120, on the beat', () => {
  const d = detectTempo(click(120, 32));
  eq(d.reason, null, 'no refusal');
  close(d.bpm, 120, 'bpm', 0.5);
  close(d.phaseSec, 0, 'the first beat is at zero', 0.01);
  assert(d.confidence > TRUST_THRESHOLD, `confident, got ${d.confidence}`);
});

check('the phase is found, not assumed', () => {
  const d = detectTempo(click(100, 32, 0.37));
  close(d.bpm, 100, 'bpm', 0.5);
  // The grid repeats every beat, so any phase congruent with 0.37 is right.
  const period = 60 / 100;
  const err = Math.abs(((d.phaseSec - 0.37) % period + period) % period);
  close(Math.min(err, period - err), 0, 'phase modulo the beat', 0.02);
});

check('a played performance still reads, jitter and all', () => {
  // ±18 ms is a real drummer, not a click.
  const d = detectTempo(click(92, 40, 0.12, 0.018));
  close(d.bpm, 92, 'bpm', 1.0);
  assert(d.confidence > TRUST_THRESHOLD, `still confident, got ${d.confidence}`);
});

check('an offbeat hat between the kicks does NOT double the tempo', () => {
  // The classic wrong answer.  Every eighth has an attack, so a double-time
  // grid explains the recording perfectly — but the grid comes out striped,
  // loud-soft-loud-soft, and half of a beat is not a beat.
  const kick = click(90, 32);
  const hat = click(90, 32).map((o) => ({ timeSec: o.timeSec + 60 / 90 / 2, weight: 0.35 }));
  const d = detectTempo([...kick, ...hat].sort((a, b) => a.timeSec - b.timeSec));
  close(d.bpm, 90, 'the tempo a musician would count', 0.6);
  close(d.phaseSec, 0, 'and the beat is on the kick, not the hat', 0.02);
});

check('an even eighth pulse is left alone — the stripe has to be real', () => {
  // Same shape, but the two attacks are equally strong.  There is nothing in
  // the timing to say which is the beat, so the reading is not forced down;
  // a detector that halves this is guessing.
  const a = click(90, 32);
  const b = click(90, 32).map((o) => ({ timeSec: o.timeSec + 60 / 90 / 2, weight: 1 }));
  const d = detectTempo([...a, ...b].sort((x, y) => x.timeSec - y.timeSec));
  close(d.bpm, 180, 'the pulse that is actually there', 0.6);
});

check('a faster reading is taken when it earns it', () => {
  // Every eighth played, evenly and equally: there is no half-time reading
  // that explains this better, so 160 must win over 80.
  const d = detectTempo(click(160, 48));
  close(d.bpm, 160, 'bpm', 0.6);
});

check('the phase is decided by refinement, not by where the sweep happened to step', () => {
  // 108 BPM shuffled.  The swung eighths sit on a triplet, and a grid at
  // 162 — one and a half times the tempo — explains every one of them if its
  // phase lands exactly right while the true tempo's phase misses the sweep
  // by a rounding error.  Which of the two is on the step list is not a
  // musical fact, so it must not decide the answer.
  const bpm = 108;
  const period = 60 / bpm;
  const phase = 0.25;
  const onsets: WeightedOnset[] = [];
  for (let beat = 0; beat < 32; beat++) {
    onsets.push({ timeSec: phase + beat * period, weight: 1 });
    onsets.push({ timeSec: phase + (beat + 0.5 + 1 / 6) * period, weight: 0.55 });
  }
  const d = detectTempo(onsets);
  close(d.bpm, 108, 'the tempo that was played, not one and a half of it', 0.6);
  close(d.phaseSec, 0.25, 'and the first beat is exactly where it is', 0.005);
});

check('material with no pulse is not given a tempo to act on', () => {
  const rng = makeRng(11);
  const onsets = Array.from({ length: 40 }, () => ({ timeSec: rng() * 20, weight: 1 }))
    .sort((a, b) => a.timeSec - b.timeSec);
  const d = detectTempo(onsets);
  assert(d.confidence < TRUST_THRESHOLD,
    `random onsets must stay under the threshold, got ${d.confidence}`);
});

check('a sustained pad — four attacks and nothing else — is refused outright', () => {
  const d = detectTempo(evenWeights([0, 3.1, 7.4, 12.9]).slice(0, 3));
  assert(d.reason !== null, 'must refuse');
  eq(d.bpm, 0, 'and give no number');
});

check('an excerpt shorter than two slow bars is refused', () => {
  const d = detectTempo(click(120, 8));  // 3.5 s
  assert(d.reason?.includes('짧습니다'), `must say it is too short, got ${d.reason}`);
});

check('the alternatives offered are genuinely different tempos', () => {
  const d = detectTempo(click(120, 32));
  for (const alt of d.alternatives) {
    // 60 and 240 are the same tempo in other clothes and must not be listed
    // as rivals — otherwise every reading looks contested.
    for (const ratio of [0.5, 1, 2]) {
      assert(Math.abs(alt.bpm - d.bpm * ratio) > 1.5,
        `alternative ${alt.bpm} is just ${d.bpm} × ${ratio}`);
    }
  }
});

check('the description says the tempo, the confidence and the refusal', () => {
  const good = describeDetection(detectTempo(click(120, 32)));
  assert(good.includes('BPM') && good.includes('확신'), `got ${good}`);
  const bad = describeDetection(detectTempo(click(120, 4)));
  assert(!bad.includes('BPM'), `a refusal must not read like an answer: ${bad}`);
});

// ── Groove: choosing the grid ─────────────────────────────────────────────────

/** Eighths where every off-eighth is late by `swing` of a beat. */
function swungEighths(bars: number, swing: number): GrooveOnset[] {
  const out: GrooveOnset[] = [];
  for (let beat = 0; beat < bars * 4; beat++) {
    out.push({ beat, weight: 1 });
    out.push({ beat: beat + 0.5 + swing, weight: 0.6 });
  }
  return out;
}

check('a shuffle is measured on the grid it was played against', () => {
  // On an eighth grid the late note is the off-eighth, consistently late.
  // On a sixteenth grid it is the third sixteenth, slightly early — a true
  // statement that describes no swing at all.
  const onsets = swungEighths(4, 1 / 6);
  eq(chooseGrid(onsets, 4), 2, 'eighths');
});

check('an onset on the "and" is evidence for the tempo — worth less, not nothing', () => {
  // Counting only what lands ON the beat throws away most of a real part.
  // Eighths between the beats must read as better support than the same
  // number of attacks scattered anywhere.
  const beats = click(100, 32);
  const period = 60 / 100;
  const eighths = beats.map((o) => ({ timeSec: o.timeSec + period / 2, weight: 0.7 }));
  const rng = makeRng(31);
  const scattered = beats.map((o) => ({ timeSec: o.timeSec + rng() * period, weight: 0.7 }));

  const sort = (a: WeightedOnset[]) => [...a].sort((x, y) => x.timeSec - y.timeSec);
  const subdivided = detectTempo(sort([...beats, ...eighths]));
  const noisy = detectTempo(sort([...beats, ...scattered]));
  close(subdivided.bpm, 100, 'the tempo is still read', 0.6);
  assert(subdivided.confidence > noisy.confidence + 0.1,
    `subdivision beats noise — ${subdivided.confidence} vs ${noisy.confidence}`);
  // And not worth as much as a beat: a part that is half off-beat cannot be
  // as certain as a bare click.
  assert(subdivided.confidence < detectTempo(beats).confidence,
    'an off-beat attack is weaker evidence than an on-beat one');
});

check('the grid is the coarsest that fits, not the one that fits best', () => {
  // A sixteenth grid describes an eighth part perfectly — with half its
  // slots empty, which is how a template quietly stops applying to anything.
  // Loosening what counts as "fits" must give a COARSER grid, not a better
  // scoring one.
  const onsets = swungEighths(4, 1 / 6);
  eq(chooseGrid(onsets, 4, 0.1), 1, 'a lax threshold takes the quarter-note grid');
  eq(chooseGrid(onsets, 4, 0.7), 2, 'the honest one takes eighths');
});

check('straight sixteenths choose the sixteenth grid', () => {
  const onsets: GrooveOnset[] = [];
  for (let i = 0; i < 64; i++) onsets.push({ beat: i * 0.25, weight: 1 });
  const grid = chooseGrid(onsets, 4);
  assert(grid >= 4, `needs at least sixteenths to hold every note, got ${grid}`);
});

check('consistency measures agreement, not closeness to the line', () => {
  // Every onset a fixed 0.2 of a beat late: far from the grid, perfectly
  // consistent, and a groove template is exactly the right shape for it.
  const late: GrooveOnset[] = Array.from({ length: 32 }, (_, i) => ({ beat: i + 0.2, weight: 1 }));
  assert(gridConsistency(late, 1, 4) > 0.95, 'a uniformly late take is consistent');
  // Scattered by the same amount is not.
  const rng = makeRng(3);
  const loose: GrooveOnset[] = Array.from({ length: 32 }, (_, i) =>
    ({ beat: i + (rng() * 2 - 1) * 0.4, weight: 1 }));
  assert(gridConsistency(loose, 1, 4) < 0.7, 'a scattered one is not');
});

// ── Groove: extraction ────────────────────────────────────────────────────────

check('a triplet shuffle comes back as 66.7 % swing', () => {
  const { groove, reason } = extractGroove(swungEighths(4, 1 / 6), { slotsPerBeat: 2 });
  eq(reason, null, 'no refusal');
  assert(groove, 'a groove');
  close(swingPercent(groove!)!, 66.7, 'swing', 0.2);
});

check('a straight take comes back as 50 % — straight', () => {
  const { groove } = extractGroove(swungEighths(4, 0), { slotsPerBeat: 2 });
  close(swingPercent(groove!)!, 50, 'swing', 0.1);
});

check('slots nobody played carry zero weight and no velocity', () => {
  // Kick on 1 and 3 only.  A sixteenth template built from it knows fourteen
  // sixteenths' worth of nothing, and has to say so.
  const kicks: GrooveOnset[] = [];
  for (let bar = 0; bar < 6; bar++) {
    kicks.push({ beat: bar * 4, weight: 1 });
    kicks.push({ beat: bar * 4 + 2, weight: 0.9 });
  }
  const { groove } = extractGroove(kicks, { slotsPerBeat: 4, beats: 4 });
  assert(groove, 'a groove');
  const g = groove!;
  eq(g.weights.filter((w) => w > 0).length, 2, 'two slots know anything');
  eq(g.velocities[1], null, 'the second sixteenth has no velocity to report');
  assert((g.weights[0] ?? 0) > 0 && (g.weights[8] ?? 0) > 0, 'beats 1 and 3 do');
});

check('velocity is measured, not invented', () => {
  const onsets: GrooveOnset[] = [];
  for (let beat = 0; beat < 16; beat++) {
    onsets.push({ beat, weight: beat % 2 === 0 ? 0.9 : 0.4 });
  }
  const { groove } = extractGroove(onsets, { slotsPerBeat: 1, beats: 2 });
  close(groove!.velocities[0] ?? -1, 0.9, 'downbeats loud', 1e-9);
  close(groove!.velocities[1] ?? -1, 0.4, 'the other beat soft', 1e-9);
});

check('a groove needs more than one occupied slot', () => {
  const same: GrooveOnset[] = [0, 4, 8, 12, 16].map((beat) => ({ beat, weight: 1 }));
  const { groove, reason } = extractGroove(same, { slotsPerBeat: 1, beats: 4 });
  eq(groove, null, 'refused');
  assert(reason?.includes('한 자리'), `and says why: ${reason}`);
});

check('four attacks is the floor', () => {
  const { groove, reason } = extractGroove([{ beat: 0, weight: 1 }, { beat: 1, weight: 1 }]);
  eq(groove, null, 'refused');
  assert(reason !== null, 'with a reason');
});

// ── Groove: application ───────────────────────────────────────────────────────

function straightEighths(count: number): ReturnType<typeof createNote>[] {
  resetIds();
  return Array.from({ length: count }, (_, i) =>
    createNote({ startBeat: i * 0.5, durationBeat: 0.5, velocity: from7bit(100) }));
}

check('applying a shuffle swings notes that were typed in straight', () => {
  const { groove } = extractGroove(swungEighths(4, 1 / 6), { slotsPerBeat: 2 });
  const swung = applyGroove(straightEighths(8), null, groove!);
  for (let i = 0; i < 8; i++) {
    const want = i % 2 === 0 ? i * 0.5 : i * 0.5 + 1 / 6;
    close(swung[i]!.startBeat, want, `note ${i}`, 1e-6);
  }
});

check('strength is a real dial, not a switch', () => {
  const { groove } = extractGroove(swungEighths(4, 1 / 6), { slotsPerBeat: 2 });
  const half = applyGroove(straightEighths(4), null, groove!, { strength: 0.5 });
  close(half[1]!.startBeat, 0.5 + 1 / 12, 'halfway to the groove', 1e-6);
  const none = applyGroove(straightEighths(4), null, groove!, { strength: 0 });
  close(none[1]!.startBeat, 0.5, 'and zero moves nothing', 1e-9);
});

check('notes on slots the groove never saw are left exactly where they were', () => {
  // A kick-only groove: it knows beats 1 and 3 and nothing else.
  const kicks: GrooveOnset[] = [];
  for (let bar = 0; bar < 6; bar++) {
    kicks.push({ beat: bar * 4 + 0.05, weight: 1 });
    kicks.push({ beat: bar * 4 + 2 + 0.05, weight: 1 });
  }
  const { groove } = extractGroove(kicks, { slotsPerBeat: 4, beats: 4 });
  // Hats on every sixteenth, deliberately sloppy.
  resetIds();
  const hats = Array.from({ length: 16 }, (_, i) =>
    createNote({ startBeat: i * 0.25 + (i % 3) * 0.01, durationBeat: 0.25 }));
  const after = applyGroove(hats, null, groove!);
  const byId = new Map(after.map((n) => [n.id, n]));
  let moved = 0;
  for (const hat of hats) {
    const slot = Math.round(hat.startBeat * 4) % 16;
    const known = slot === 0 || slot === 8;
    const changed = Math.abs((byId.get(hat.id)?.startBeat ?? 0) - hat.startBeat) > 1e-9;
    if (changed) moved++;
    eq(changed, known, `slot ${slot} ${known ? 'should' : 'should not'} move`);
  }
  eq(moved, 2, 'only the two slots the kick actually played');
});

check('velocity only moves when asked, and only where measured', () => {
  const onsets: GrooveOnset[] = [];
  for (let beat = 0; beat < 16; beat++) onsets.push({ beat, weight: beat % 2 === 0 ? 0.9 : 0.3 });
  const { groove } = extractGroove(onsets, { slotsPerBeat: 1, beats: 2 });
  resetIds();
  const flat = Array.from({ length: 4 }, (_, i) => createNote({ startBeat: i, velocity: 0.6 }));
  const untouched = applyGroove(flat, null, groove!);
  close(untouched[1]!.velocity, 0.6, 'velocity left alone by default', 1e-9);
  const shaped = applyGroove(flat, null, groove!, { velocityStrength: 1 });
  close(shaped[0]!.velocity, 0.9, 'downbeat takes the loud slot', 1e-9);
  close(shaped[1]!.velocity, 0.3, 'the off-beat takes the soft one', 1e-9);
});

check('a selection is respected — unselected notes never move', () => {
  const { groove } = extractGroove(swungEighths(4, 1 / 6), { slotsPerBeat: 2 });
  const notes = straightEighths(6);
  const ids = new Set([notes[1]!.id, notes[3]!.id]);
  const after = applyGroove(notes, ids, groove!);
  const byId = new Map(after.map((n) => [n.id, n]));
  for (const n of notes) {
    const changed = Math.abs((byId.get(n.id)?.startBeat ?? 0) - n.startBeat) > 1e-9;
    eq(changed, ids.has(n.id), `note at ${n.startBeat}`);
  }
});

// ── The whole path: audio to notes ────────────────────────────────────────────

check('detect, extract, apply — a recorded shuffle ends up on typed-in notes', () => {
  // A shuffled eighth-note performance at 96 BPM starting a third of a second
  // in, with the human wobble left on.
  const bpm = 96;
  const period = 60 / bpm;
  const phase = 0.333;
  const rng = makeRng(23);
  const onsets: WeightedOnset[] = [];
  for (let beat = 0; beat < 32; beat++) {
    const jitter = () => (rng() * 2 - 1) * 0.006;
    onsets.push({ timeSec: phase + beat * period + jitter(), weight: 1 });
    onsets.push({ timeSec: phase + (beat + 0.5 + 1 / 6) * period + jitter(), weight: 0.6 });
  }

  const detected = detectTempo(onsets);
  eq(detected.reason, null, 'the tempo reads');
  close(detected.bpm, bpm, 'and it is the one that was played', 1.0);
  assert(detected.confidence >= TRUST_THRESHOLD, `and is trusted: ${detected.confidence}`);

  const beats = onsetsToBeats(onsets, detected.bpm, detected.phaseSec);
  const { groove } = extractGroove(beats, { slotsPerBeat: 2, name: '취주' });
  assert(groove, 'a groove came out');
  close(swingPercent(groove!)!, 66.7, 'carrying the shuffle', 1.5);

  const swung = applyGroove(straightEighths(8), null, groove!, { strength: 1 });
  // The off-eighths moved late by about a sixth of a beat; the on-beats
  // barely moved at all.
  close(swung[1]!.startBeat - 0.5, 1 / 6, 'the off-eighth swings', 0.02);
  close(swung[2]!.startBeat - 1.0, 0, 'the downbeat stays put', 0.02);
});

check('a groove lifted from MIDI matches one lifted from the same audio', () => {
  resetIds();
  const notes = Array.from({ length: 32 }, (_, i) => createNote({
    startBeat: i % 2 === 0 ? i * 0.5 : i * 0.5 + 1 / 6,
    durationBeat: 0.5,
    velocity: i % 2 === 0 ? 0.9 : 0.6,
  }));
  const { groove } = extractGroove(onsetsFromNotes(notes), { slotsPerBeat: 2 });
  close(swingPercent(groove!)!, 66.7, 'same shuffle', 0.2);
  close(groove!.velocities[0] ?? -1, 0.9, 'and the same accents', 1e-9);
});

check('muted notes are not part of the feel', () => {
  resetIds();
  const notes = [
    createNote({ startBeat: 0, velocity: 0.9 }),
    createNote({ startBeat: 1, velocity: 0.9 }),
    createNote({ startBeat: 0.5, velocity: 0.2, muted: true }),
  ];
  const onsets = onsetsFromNotes(notes);
  eq(onsets.length, 2, 'the muted note is not an attack');
});

check('the description names the grid, the coverage and the swing', () => {
  const { groove } = extractGroove(swungEighths(4, 1 / 6), { slotsPerBeat: 2 });
  const text = describeGroove(groove!);
  assert(text.includes('8분음표'), `the grid: ${text}`);
  assert(text.includes('8/8슬롯'), `the coverage: ${text}`);
  assert(text.includes('스윙 66'), `the swing: ${text}`);
  close(grooveDepth(groove!), 1 / 6, 'and the depth is the shuffle', 1e-6);
});

check('a triplet grid reports no swing rather than a wrong number', () => {
  const onsets: GrooveOnset[] = [];
  for (let beat = 0; beat < 16; beat++) {
    for (let t = 0; t < 3; t++) onsets.push({ beat: beat + t / 3, weight: 1 });
  }
  const { groove } = extractGroove(onsets, { slotsPerBeat: 3, beats: 4 });
  eq(swingPercent(groove!), null, 'a triplet grid has no off-slot to be late');
  const g: Groove = groove!;
  eq(g.weights.filter((w) => w > 0).length, 12, 'every triplet is occupied');
});

// ── The action layer ──────────────────────────────────────────────────────────

/** A session with one MIDI part whose notes are given in beats. */
function partSession(starts: readonly number[]): {
  session: DawSession; trackId: string; clipId: string;
} {
  resetIds();
  let session = createSession('groove', 48000);
  const track = createTrack('Keys', 'instrument');
  session = addTrack(session, track);
  const part = createMidiPart('Take 1', { startSec: 0, durationSec: 8 });
  session = updateClip(
    { ...session, tracks: session.tracks.map((t) => (t.id === track.id
      ? { ...t, playlists: t.playlists.map((pl, i) => (i === 0 ? { ...pl, clips: [part] } : pl)) }
      : t)) },
    track.id, part.id,
    (c) => ({ ...c, notes: starts.map((b, i) =>
      createNote({ startBeat: b, durationBeat: 0.5, velocity: i % 2 === 0 ? 0.9 : 0.55 })) }),
  );
  return { session, trackId: track.id, clipId: part.id };
}

check('a groove is lifted straight off an open MIDI part', () => {
  const starts: number[] = [];
  for (let b = 0; b < 8; b++) { starts.push(b); starts.push(b + 0.5 + 1 / 6); }
  const { session, trackId, clipId } = partSession(starts);
  const result = extractClipGroove(session, trackId, clipId, { slotsPerBeat: 2 });
  eq(result.detection, null, 'a MIDI part needs no tempo detection — it is already in beats');
  assert(result.groove, 'a groove');
  close(swingPercent(result.groove!)!, 66.7, 'the shuffle came across', 0.2);
});

check('applying to a part reports what moved AND what it left alone', () => {
  // A groove that only knows the down-beats, put onto a part that also has
  // off-beats.  The count has to name both, or the user believes the whole
  // selection was treated.
  const beatsOnly: GrooveOnset[] = Array.from({ length: 16 }, (_, i) => ({ beat: i + 0.05, weight: 1 }));
  const { groove } = extractGroove(beatsOnly, { slotsPerBeat: 2, beats: 4 });
  const { session, trackId, clipId } = partSession([0, 0.5, 1, 1.5, 2, 2.5]);
  const result = applyGrooveToPart(session, trackId, clipId, groove!, null);
  eq(result.movedCount, 3, 'the three on-beats moved');
  eq(result.untouchedCount, 3, 'the three off-beats were left alone');
  assert(result.message.includes('그대로 뒀습니다'), `and it says so: ${result.message}`);

  const part = trackClips(findTrack(result.session, trackId)!).find((c) => c.id === clipId)!;
  const at = (beat: number) => part.notes.find((n) => Math.abs(n.startBeat - beat) < 0.2)!;
  close(at(0.5).startBeat, 0.5, 'the off-beat is exactly where it was', 1e-9);
  close(at(0.05).startBeat, 0.05, 'and the on-beat took the groove', 1e-6);
});

check('a note already in the groove is treated, not reported as skipped', () => {
  // The two ways a note does not move are not the same thing.  A part that
  // already sits exactly on the template was fitted perfectly; saying "8 notes
  // the groove knows nothing about" tells the user the opposite.
  const straight: GrooveOnset[] = [];
  for (let i = 0; i < 16; i++) straight.push({ beat: i * 0.5, weight: 1 });
  const { groove } = extractGroove(straight, { slotsPerBeat: 2, beats: 4 });
  assert(grooveKnows(groove!, 0.5), 'the off-beat is a slot it knows');
  const { session, trackId, clipId } = partSession([0, 0.5, 1, 1.5]);
  const result = applyGrooveToPart(session, trackId, clipId, groove!, null);
  eq(result.movedCount, 0, 'nothing had to move');
  eq(result.untouchedCount, 0, 'and nothing was skipped');
  assert(!result.message.includes('그대로 뒀습니다'), `so it says nothing: ${result.message}`);
});

check('a MIDI part cannot be asked for a tempo it does not have', () => {
  const { session, trackId, clipId } = partSession([0, 1, 2, 3]);
  const result = matchSessionTempo(session, trackId, clipId);
  eq(result.applied, false, 'refused');
  assert(result.message.includes('오디오'), `and says why: ${result.message}`);
  eq(result.session, session, 'and the session is untouched');
});

check('an undecoded audio clip says so instead of guessing', () => {
  resetIds();
  let session = createSession('audio', 48000);
  const track = createTrack('Drums', 'audio');
  session = addTrack(session, track);
  const clip = { ...createMidiPart('Loop'), kind: 'audio' as const, fileId: 'nothing',
    startSec: 0, durationSec: 8, notes: [] };
  session = { ...session, tracks: session.tracks.map((t) => (t.id === track.id
    ? { ...t, playlists: t.playlists.map((pl, i) => (i === 0 ? { ...pl, clips: [clip] } : pl)) }
    : t)) };
  const result = matchSessionTempo(session, track.id, clip.id);
  eq(result.applied, false, 'refused');
  assert(result.message.includes('디코딩'), `and says why: ${result.message}`);
});

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed${passed === results.length ? '' : `, ${results.length - passed} FAILED`}`);
if (passed !== results.length) process.exit(1);
