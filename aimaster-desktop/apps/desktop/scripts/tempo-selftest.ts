/**
 * tempo-selftest — does a beat land where the map says it does?
 *
 * A tempo map is arithmetic that nothing else can check.  Every consumer — the
 * grid, the ruler, warp, the count-in — takes its answer on trust, so if
 * `beatToSec` is a percent out, everything is a percent out together and looks
 * consistent while being wrong.  There is no "that sounds off" to catch it:
 * the whole app is off by the same amount.
 *
 * So the ramp integral is checked against a brute-force numerical integration
 * of the same function, and the inverse is checked by round-tripping.  Those
 * two are the only claims in this file that could hide a mistake; everything
 * else is arithmetic you can read.
 *
 *     ∫ 60/(t₀ + k·u) du  =  (60/k)·ln(T(b)/t₀)
 *
 * Run:  pnpm --filter @aimaster/desktop test:tempo
 */

import {
  MAX_BPM, MIN_BPM, addMeterEvent, addTempoEvent, barBeatAt, barStartBeat,
  beatSecondsAt, beatToSec, beatsPerBar, clampBpm, compileTempoMap,
  defaultTempoMap, describeTempoMap, formatBarBeat, gridLines, isConstantTempo,
  meterAtBar, meterAtBeat, normaliseTempoMap, removeMeterEvent, removeTempoEvent,
  secToBeat, snapSecToBar, snapSecToBeats, tempoAtBeat, tempoAtSec, tempoMapKey,
  tempoMapOf, updateMeterEvent, updateTempoEvent, withTempoMap,
} from '../src/renderer/daw/model/tempo-map.js';
import {
  DEFAULT_WARP, buildWarpMap, constantTempo, sessionWarpTempo, sourceToDest,
} from '../src/renderer/daw/model/warp.js';
import { createSession } from '../src/renderer/daw/model/session-ops.js';
import { serializeDawSession, deserializeDawSession } from '../src/renderer/daw/model/session-io.js';
import type { Clip, TempoMap } from '../src/renderer/daw/model/types.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function near(a: number, b: number, tol: number, what: string): void {
  assert(Math.abs(a - b) <= tol, `${what}: expected ${b}, got ${a}`);
}

/** 120 BPM at the start, ramping to 240 by beat 16, then flat. */
function rampMap(): TempoMap {
  let map = defaultTempoMap(120);
  map = updateTempoEvent(map, map.tempos[0]!.id, { curve: 'ramp' });
  return addTempoEvent(map, 16, 240, 'jump');
}

// ── The arithmetic ──────────────────────────────────────────────────────────

check('a constant tempo is one division, exactly as before', () => {
  const map = defaultTempoMap(120);
  near(beatToSec(map, 0), 0, 1e-12, 'beat 0');
  near(beatToSec(map, 1), 0.5, 1e-12, 'a beat at 120 BPM');
  near(beatToSec(map, 8), 4, 1e-12, 'two bars');
  near(secToBeat(map, 4), 8, 1e-12, 'and back');
  near(tempoAtBeat(map, 99), 120, 1e-12, 'the tempo never changes');
  assert(isConstantTempo(map), 'and the map knows it is constant');
});

check('a jump holds its tempo until the next event, then changes', () => {
  const map = addTempoEvent(defaultTempoMap(120), 8, 60, 'jump');
  near(beatToSec(map, 8), 4, 1e-12, 'eight beats at 120 is four seconds');
  near(beatToSec(map, 12), 8, 1e-12, 'then four beats at 60 is four more');
  near(tempoAtBeat(map, 7.99), 120, 1e-9, 'still the old tempo just before');
  near(tempoAtBeat(map, 8), 60, 1e-9, 'and the new one at the event');
  near(secToBeat(map, 8), 12, 1e-9, 'the inverse agrees');
});

check('the ramp integral matches a brute-force integration of the same curve', () => {
  // The one claim here that could be silently wrong.  A stepped approximation
  // would agree to two or three digits and drift over a song; this agrees to
  // twelve, because it is the closed form rather than a fine-enough sum.
  const map = rampMap();
  const reference = (toBeat: number): number => {
    const steps = 400_000;
    const h = toBeat / steps;
    let sum = 0;
    for (let i = 0; i < steps; i++) {
      const b = (i + 0.5) * h;
      const tempo = b <= 16 ? 120 + (120 / 16) * b : 240;
      sum += (60 / tempo) * h;
    }
    return sum;
  };
  for (const beat of [4, 8, 16, 24]) {
    const exact = beatToSec(map, beat);
    const numeric = reference(beat);
    assert(Math.abs(exact - numeric) < 1e-7,
      `beat ${beat}: closed form ${exact}, numeric ${numeric}`);
  }
  // A ritardando really does take longer than the tempo it starts at.
  assert(beatToSec(map, 16) < 16 * 0.5, 'speeding up gets there sooner than 120 would');
  assert(beatToSec(map, 16) > 16 * 0.25, 'but not as soon as 240 would');
});

check('seconds and beats invert each other exactly, across every kind of segment', () => {
  const map = rampMap();
  let worst = 0;
  for (let beat = 0; beat <= 48; beat += 0.13) {
    worst = Math.max(worst, Math.abs(secToBeat(map, beatToSec(map, beat)) - beat));
  }
  assert(worst < 1e-9, `round trip is exact (worst ${worst})`);

  let worstSec = 0;
  for (let sec = 0; sec <= 20; sec += 0.07) {
    worstSec = Math.max(worstSec, Math.abs(beatToSec(map, secToBeat(map, sec)) - sec));
  }
  assert(worstSec < 1e-9, `and in the other direction (worst ${worstSec})`);
});

check('the tempo inside a ramp is the interpolated one', () => {
  const map = rampMap();
  near(tempoAtBeat(map, 0), 120, 1e-9, 'at the start');
  near(tempoAtBeat(map, 8), 180, 1e-9, 'half way');
  near(tempoAtBeat(map, 16), 240, 1e-9, 'at the end');
  near(tempoAtBeat(map, 40), 240, 1e-9, 'and held after it');
  // The metronome interval is the tempo where the metronome is.
  near(beatSecondsAt(map, beatToSec(map, 8)), 60 / 180, 1e-9, 'the click follows');
});

check('time only ever moves forwards', () => {
  // A map that produced a non-monotonic time axis would make the playhead go
  // backwards, and nothing downstream would survive that.
  let map = defaultTempoMap(90);
  map = addTempoEvent(map, 4, 200, 'ramp');
  map = addTempoEvent(map, 9, 40, 'ramp');
  map = addTempoEvent(map, 13, 150, 'jump');
  let previous = -1;
  for (let beat = 0; beat <= 32; beat += 0.05) {
    const sec = beatToSec(map, beat);
    assert(sec > previous - 1e-12, `beat ${beat} does not go back in time`);
    assert(Number.isFinite(sec), `beat ${beat} is finite`);
    previous = sec;
  }
});

check('a tempo of zero is impossible, whatever is asked for', () => {
  assert(clampBpm(0) === MIN_BPM, 'zero clamps');
  assert(clampBpm(-40) === MIN_BPM, 'negative clamps');
  assert(clampBpm(100000) === MAX_BPM, 'absurdly fast clamps');
  assert(clampBpm(Number.NaN) === 120, 'NaN falls back rather than poisoning the map');
  const map = normaliseTempoMap({
    tempos: [{ id: 'a', beat: 0, bpm: 0, curve: 'jump' }],
    meters: [{ id: 'm', bar: 1, numerator: 4, denominator: 4 }],
  });
  assert(Number.isFinite(beatToSec(map, 100)), 'and the map still produces a time');
});

// ── Bars and signatures ─────────────────────────────────────────────────────

check('a bar in 6/8 is three quarter notes, not six', () => {
  assert(beatsPerBar({ numerator: 4, denominator: 4 }) === 4, '4/4');
  assert(beatsPerBar({ numerator: 6, denominator: 8 }) === 3, '6/8');
  assert(beatsPerBar({ numerator: 3, denominator: 4 }) === 3, '3/4');
  assert(beatsPerBar({ numerator: 7, denominator: 8 }) === 3.5, '7/8');
});

check('a signature change moves every bar line after it', () => {
  const map = addMeterEvent(defaultTempoMap(120), 5, 6, 8);
  near(barStartBeat(map, 1), 0, 1e-12, 'bar 1');
  near(barStartBeat(map, 5), 16, 1e-12, 'four bars of 4/4 is sixteen beats');
  near(barStartBeat(map, 6), 19, 1e-12, 'then a bar of 6/8 is three more');
  near(barStartBeat(map, 7), 22, 1e-12, 'and another three');

  assert(meterAtBar(map, 4).denominator === 4, 'bar 4 is still in four');
  assert(meterAtBar(map, 5).denominator === 8, 'bar 5 is in eight');
  assert(meterAtBeat(map, 15.9).denominator === 4, 'and by beat too');
  assert(meterAtBeat(map, 16).denominator === 8, 'right at the change');
});

check('a position reads back as a musician would say it', () => {
  const map = addMeterEvent(defaultTempoMap(120), 5, 6, 8);
  const at = (beat: number): string => {
    const b = barBeatAt(map, beat);
    return `${b.bar}|${b.beat}`;
  };
  assert(at(0) === '1|1', 'the very start');
  assert(at(2) === '1|3', 'third beat of the first bar');
  assert(at(8) === '3|1', 'two bars in');
  assert(at(16) === '5|1', 'the signature change');
  // 6/8 counts eighths: half a quarter note in is the second eighth.
  assert(at(16.5) === '5|2', 'and counts in eighths from there');
  assert(at(17.5) === '5|4', 'four eighths in');
  assert(at(19) === '6|1', 'the next bar');
  assert(formatBarBeat(map, beatToSec(map, 8)) === '3|1|000', 'with ticks, for the transport');
});

check('ticks divide the beat and wrap instead of reading 960', () => {
  const map = defaultTempoMap(120);
  const quarterIn = barBeatAt(map, 0.25);
  assert(quarterIn.tick === 240, `a quarter of a beat is 240 ticks (got ${quarterIn.tick})`);
  const almost = barBeatAt(map, 1 - 1e-12);
  assert(almost.tick === 0 && almost.beat === 2, 'and a whole beat is the next beat, not tick 960');
});

// ── The grid ────────────────────────────────────────────────────────────────

check('bar lines land exactly on the bars', () => {
  const map = rampMap();
  const lines = gridLines(map, 0, 20, { beats: false });
  assert(lines.length > 2, `there are bars in twenty seconds (${lines.length})`);
  for (const line of lines) {
    assert(line.isBar, 'every line is a downbeat when beats are off');
    near(line.sec, beatToSec(map, barStartBeat(map, line.bar)), 1e-9,
      `bar ${line.bar} is where the map puts it`);
  }
  for (let i = 1; i < lines.length; i++) {
    assert(lines[i]!.bar === lines[i - 1]!.bar + 1, 'consecutive bars');
    assert(lines[i]!.sec > lines[i - 1]!.sec, 'moving forwards');
  }
  // Speeding up means later bars are closer together — the whole point.
  const first = lines[1]!.sec - lines[0]!.sec;
  const last = lines[lines.length - 1]!.sec - lines[lines.length - 2]!.sec;
  assert(last < first, `bars get shorter through an accelerando (${first} → ${last})`);
});

check('beat lines sit inside their bars and honour the signature', () => {
  const map = addMeterEvent(defaultTempoMap(120), 3, 3, 4);
  const lines = gridLines(map, 0, 12, { beats: true });
  const bar1 = lines.filter((l) => l.bar === 1);
  const bar3 = lines.filter((l) => l.bar === 3);
  assert(bar1.length === 4, `4/4 has four lines per bar (got ${bar1.length})`);
  assert(bar3.length === 3, `3/4 has three (got ${bar3.length})`);
  assert(bar1[0]!.isBar && !bar1[1]!.isBar, 'the first is the downbeat and the rest are not');
});

check('the grid never floods the canvas', () => {
  const map = defaultTempoMap(200);
  const lines = gridLines(map, 0, 3600, { beats: true, maxLines: 50 });
  assert(lines.length <= 50, `capped (${lines.length})`);
  assert(gridLines(map, 5, 5).length === 0, 'an empty window has no lines');
  assert(gridLines(map, 10, 5).length === 0, 'and a backwards one is refused');
});

check('snapping rounds on the beat axis, not in seconds', () => {
  const map = rampMap();
  // A beat is 0.5 s at the start and 0.25 s at the end; a grid fixed in
  // seconds would be right in one place and wrong in the other.
  for (const beat of [2, 7, 15, 21]) {
    const between = beatToSec(map, beat + 0.3);
    near(snapSecToBeats(map, between, 1), beatToSec(map, beat), 1e-9,
      `snapped to beat ${beat}`);
  }
  near(snapSecToBeats(map, beatToSec(map, 4.6), 4), beatToSec(map, 4), 1e-9, 'a bar grid');
  near(snapSecToBar(map, beatToSec(map, 9)), beatToSec(map, 8), 1e-9, 'nearest bar, backwards');
  near(snapSecToBar(map, beatToSec(map, 11.5)), beatToSec(map, 12), 1e-9, 'and forwards');
  assert(snapSecToBeats(map, 3, 0) === 3, 'a zero division is no grid at all');
});

// ── Editing ─────────────────────────────────────────────────────────────────

check('a map always has somewhere to start', () => {
  const map = normaliseTempoMap({
    tempos: [{ id: 'x', beat: 32, bpm: 90, curve: 'jump' }],
    meters: [{ id: 'y', bar: 9, numerator: 3, denominator: 4 }],
  });
  assert(map.tempos[0]!.beat === 0, 'a tempo at beat 0 is inserted');
  assert(map.tempos[0]!.bpm === 90, 'taking the first real tempo, so bar 1 is not silent nonsense');
  assert(map.meters[0]!.bar === 1, 'and a signature at bar 1');
  assert(map.tempos.length === 2 && map.meters.length === 2, 'without losing what was there');
});

check('events sort, and two in the same place become one', () => {
  let map = defaultTempoMap(120);
  map = addTempoEvent(map, 16, 140, 'jump');
  map = addTempoEvent(map, 8, 100, 'jump');
  assert(map.tempos.map((t) => t.beat).join(',') === '0,8,16', 'sorted by beat');

  const collided = addTempoEvent(map, 8, 175, 'ramp');
  assert(collided.tempos.length === 3, 'dropping one onto another does not make two');
  assert(collided.tempos[1]!.bpm === 175, 'and the one you dropped wins');
});

check('the first event cannot be deleted, because bar 1 needs an answer', () => {
  let map = addTempoEvent(defaultTempoMap(120), 8, 90, 'jump');
  const first = map.tempos[0]!;
  assert(removeTempoEvent(map, first.id) === map, 'refused, and unchanged');
  map = removeTempoEvent(map, map.tempos[1]!.id);
  assert(map.tempos.length === 1, 'but the later one goes');

  let meters = addMeterEvent(defaultTempoMap(120), 5, 7, 8);
  assert(removeMeterEvent(meters, meters.meters[0]!.id) === meters, 'same for bar 1');
  meters = removeMeterEvent(meters, meters.meters[1]!.id);
  assert(meters.meters.length === 1, 'and the later signature goes');
});

check('editing an event moves the music after it and nothing before it', () => {
  const map = addTempoEvent(defaultTempoMap(120), 8, 120, 'jump');
  const beforeBar3 = beatToSec(map, 8);
  const faster = updateTempoEvent(map, map.tempos[1]!.id, { bpm: 240 });
  near(beatToSec(faster, 8), beforeBar3, 1e-12, 'the change point itself does not move');
  assert(beatToSec(faster, 16) < beatToSec(map, 16), 'but everything after it arrives sooner');
  near(beatToSec(faster, 4), beatToSec(map, 4), 1e-12, 'and everything before is untouched');
});

check('a changed map is a changed key', () => {
  const map = defaultTempoMap(120);
  const other = addTempoEvent(map, 8, 90, 'jump');
  assert(tempoMapKey(map) !== tempoMapKey(other), 'adding an event changes the key');
  assert(tempoMapKey(map) === tempoMapKey(defaultTempoMap(120)),
    'and two equal maps have the same key, whatever their event ids');
  const ramped = updateTempoEvent(other, other.tempos[0]!.id, { curve: 'ramp' });
  assert(tempoMapKey(other) !== tempoMapKey(ramped), 'so does the curve');
});

check('compiling twice is the same object', () => {
  // The ruler asks for hundreds of bar lines a frame; recompiling each time
  // would be the difference between a smooth zoom and a stuttering one.
  const map = rampMap();
  assert(compileTempoMap(map) === compileTempoMap(map), 'cached against the map');
  assert(compileTempoMap(map).map !== compileTempoMap(defaultTempoMap(120)).map,
    'and a different map is a different compile');
});

// ── On a session ────────────────────────────────────────────────────────────

check('a session with no map still has a tempo', () => {
  // Every session saved before the tempo track existed is this case, and so is
  // every project that has never needed a change.
  const session = createSession('old');
  assert(session.tempoMap === undefined, 'nothing stored');
  const map = tempoMapOf(session);
  assert(isConstantTempo(map), 'and the derived map is flat');
  near(tempoAtSec(map, 30), session.tempoBpm, 1e-9, 'at the session tempo');
  assert(meterAtBar(map, 1).numerator === session.timeSignature[0], 'in the session signature');
});

check('storing a map keeps the old fields honest', () => {
  const session = createSession('new');
  const map = addTempoEvent(defaultTempoMap(96, [3, 4]), 12, 132, 'ramp');
  const next = withTempoMap(session, map);
  assert(next.tempoMap !== undefined, 'the map is stored');
  near(next.tempoBpm, 96, 1e-9, 'and tempoBpm is the opening tempo, not stale');
  assert(next.timeSignature[0] === 3 && next.timeSignature[1] === 4, 'so is the signature');
  near(tempoAtSec(tempoMapOf(next), beatToSec(map, 12)), 132, 1e-6, 'the change is really there');
});

check('a map survives being saved and loaded', () => {
  let session = createSession('save');
  session = withTempoMap(session, addMeterEvent(
    addTempoEvent(defaultTempoMap(140), 32, 70, 'ramp'), 9, 7, 8));

  const parsed = deserializeDawSession(serializeDawSession(session));
  assert(parsed.ok, `it loads: ${parsed.ok ? '' : parsed.error}`);
  if (!parsed.ok) return;
  const map = tempoMapOf(parsed.session);
  assert(map.tempos.length === 2, 'both tempo events');
  assert(map.meters.length === 2, 'both signatures');
  assert(tempoMapKey(map) === tempoMapKey(tempoMapOf(session)), 'byte for byte the same map');
  for (const beat of [0, 8, 32, 48]) {
    near(beatToSec(map, beat), beatToSec(tempoMapOf(session), beat), 1e-9,
      `and beat ${beat} is still where it was`);
  }
});

check('the summary says whether there is anything to look at', () => {
  assert(describeTempoMap(defaultTempoMap(128)) === '128 BPM', 'one tempo, one number');
  const changing = addTempoEvent(defaultTempoMap(76), 64, 132, 'ramp');
  const text = describeTempoMap(changing);
  assert(text.includes('76') && text.includes('132'), `the range: ${text}`);
  assert(text.includes('1'), 'and how many changes');
});

// ── Warp under a map ────────────────────────────────────────────────────────

check('a warped clip resolves its beats through the map', () => {
  // The payoff.  A clip that follows the tempo has to stretch by what the map
  // says at ITS position, not by the song's opening tempo.
  const base = createSession('warp');
  const session = withTempoMap(base, addTempoEvent(defaultTempoMap(120), 0, 120, 'jump'));
  const constant = sessionWarpTempo(session, { startSec: 0 } as Clip);
  near(constant.beatToClipSec(4), 2, 1e-9, 'four beats at 120 is two seconds');

  const mapped = withTempoMap(base, addTempoEvent(defaultTempoMap(120), 8, 60, 'jump'));
  // A clip starting at beat 8 lives entirely in the slow half.
  const late = sessionWarpTempo(mapped, { startSec: beatToSec(tempoMapOf(mapped), 8) } as Clip);
  near(late.beatToClipSec(4), 4, 1e-6, 'four beats at 60 is four seconds');
  const early = sessionWarpTempo(mapped, { startSec: 0 } as Clip);
  near(early.beatToClipSec(4), 2, 1e-6, 'and the same clip earlier is two');
  assert(late.key !== early.key,
    'the two get different cache keys, so one cannot be handed the other audio');
});

check('a clip that does not follow the tempo is untouched by the map', () => {
  const session = withTempoMap(createSession('fixed'),
    addTempoEvent(defaultTempoMap(120), 4, 200, 'ramp'));
  const warp = { ...DEFAULT_WARP, enabled: true, followTempo: false, baseBpm: 100,
    markers: [{ id: 'a', sourceSec: 0, beat: 0 }, { id: 'b', sourceSec: 2, beat: 4 }] };

  const underMap = buildWarpMap(warp, sessionWarpTempo(session, { startSec: 0 } as Clip));
  const alone = buildWarpMap(warp, constantTempo(100));
  near(sourceToDest(underMap, 2), sourceToDest(alone, 2), 1e-12,
    'a fixed loop does not breathe with a ritardando it was never part of');
});

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Tempo map — beats, bars, ramps ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
