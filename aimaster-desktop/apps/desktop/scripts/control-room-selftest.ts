/**
 * control-room-selftest.ts — the monitoring path, which is not the mix.
 *
 * A studio has two level controls that look identical and mean opposite
 * things.  The MASTER FADER is part of the mix — printed, bounced, heard by
 * the listener.  The CONTROL ROOM level is how loud this room is right now.
 *
 * Every DAW without a control room grows the same bug: somebody turns the
 * master down because it is too loud, and every export after that is 8 dB
 * quiet.  Nobody notices until a client does.
 *
 * So the test that matters most is not about arithmetic at all — it is that
 * the offline render never constructs a control room, which is checked
 * against the SOURCE of the render path rather than by trusting a comment.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:control-room
 */

import { readFileSync } from 'node:fs';
import {
  DEFAULT_CONTROL_ROOM, DEFAULT_DIM_DB, MAX_CUES, MAX_LEVEL_DB, MIN_LEVEL_DB,
  MONITOR_LABELS, NOT_IN_THE_MIX, SILENCE_DB, addCue, clampLevelDb, cueGain,
  dbToGain, describeCue, describeMonitor, monitorDb, monitorGain, nudgeLevel,
  removeCue, setCue, setLevel, setSource, setTrim, toggleDim, toggleMono,
  toggleMute, type ControlRoomState, type MonitorSource,
} from '../src/renderer/daw/model/control-room.js';
import { ControlRoomNode } from '../src/renderer/daw/engine/control-room-node.js';
import { Metronome } from '../src/renderer/daw/engine/metronome.js';
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
const room = (over: Partial<ControlRoomState> = {}): ControlRoomState =>
  ({ ...DEFAULT_CONTROL_ROOM, ...over });

// ── The promise the whole feature rests on ──────────────────────────────────

check('the offline render never builds a control room', () => {
  // Checked against the SOURCE, not against a comment.  The mixer takes its
  // destination as an argument; the live runtime hands it the monitor chain
  // and the render hands it the render destination.  If somebody ever wires
  // the monitor path into the render, the level a person set for their room
  // starts printing into every master, and it is not the kind of bug anybody
  // finds by listening.
  const render = readFileSync('src/renderer/daw/engine/offline-render.ts', 'utf8');
  assert(!/ControlRoom/.test(render),
    'offline-render.ts must not so much as mention the control room');
  assert(/new MixerEngine\(ctx, ctx\.destination/.test(render),
    'and it renders straight into its own destination');

  const runtime = readFileSync('src/renderer/daw/engine/daw-runtime.ts', 'utf8');
  assert(/new ControlRoomNode\(/.test(runtime), 'the LIVE runtime is where it is built');
  assert(/new MixerEngine\(this\.ctx, this\.controlRoom\.input/.test(runtime),
    'and the live mixer plays into it');
});

check('the panel says out loud that this is not the mix', () => {
  // A monitor section people do not trust is a monitor section people reach
  // past, for the master fader.
  assert(NOT_IN_THE_MIX.includes('바운스'), NOT_IN_THE_MIX);
  assert(NOT_IN_THE_MIX.includes('마스터링'), NOT_IN_THE_MIX);
});

// ── Level ───────────────────────────────────────────────────────────────────

check('the level is held in a sane range', () => {
  assert(clampLevelDb(999) === MAX_LEVEL_DB, 'ceiling');
  assert(clampLevelDb(-999) === MIN_LEVEL_DB, 'floor');
  assert(clampLevelDb(Number.NaN) === MIN_LEVEL_DB, 'and nonsense is silence, not a crash');
});

check('the bottom of the fader is actually silent', () => {
  // Not "-60 dB, which is very quiet".  A monitor fader pulled all the way
  // down is a person expecting nothing, in a room where somebody is talking.
  near(dbToGain(SILENCE_DB), 0, 0, 'exactly zero');
  near(monitorGain(room({ levelDb: MIN_LEVEL_DB })), 0, 0, 'through the whole chain');
  assert(dbToGain(0) === 1, 'and unity is unity');
});

check('mute silences without losing the level you had set', () => {
  const set = room({ levelDb: -6 });
  const muted = toggleMute(set);
  near(monitorGain(muted), 0, 0, 'silent');
  near(muted.levelDb, -6, 1e-9, 'and the fader has not moved');
  near(monitorGain(toggleMute(muted)), monitorGain(set), 1e-12, 'un-muting comes back to it');
});

check('dim drops by a fixed amount and comes back exactly', () => {
  const set = room({ levelDb: -10 });
  const dimmed = toggleDim(set);
  near(monitorDb(dimmed), -10 + DEFAULT_DIM_DB, 1e-9, 'twenty down');
  near(monitorDb(toggleDim(dimmed)), -10, 1e-9, 'and back to where it was');
});

check('a nudge changes the LEVEL, not the dim or the mute', () => {
  // Two different controls.  A nudge that silently un-dims loses your place.
  const dimmed = room({ levelDb: -10, dim: true });
  const up = nudgeLevel(dimmed, 3);
  near(up.levelDb, -7, 1e-9, 'the fader moved');
  assert(up.dim, 'and it is still dimmed');
  const muted = nudgeLevel(room({ muted: true, levelDb: -10 }), 3);
  assert(muted.muted, 'a nudge does not un-mute either');
});

check('a nudge cannot walk off either end', () => {
  let s = room({ levelDb: MAX_LEVEL_DB });
  for (let i = 0; i < 20; i++) s = nudgeLevel(s, 3);
  assert(s.levelDb === MAX_LEVEL_DB, 'held at the top');
  for (let i = 0; i < 60; i++) s = nudgeLevel(s, -3);
  assert(s.levelDb === MIN_LEVEL_DB, 'and at the bottom');
});

// ── Speaker sets ────────────────────────────────────────────────────────────

check('switching speakers does not change the fader', () => {
  const set = room({ levelDb: -8 });
  const alt = setSource(set, 'alt');
  near(alt.levelDb, -8, 1e-9, 'the level is where it was');
  assert(alt.source === 'alt', 'on the other speakers');
});

check('each set has its own trim, so an A/B is about the speakers', () => {
  // Comparing two speakers at different loudnesses is a comparison about
  // volume.  The trim is what makes it a comparison about the speakers.
  const set = setTrim(room({ levelDb: -10 }), 'alt', -4);
  near(monitorDb(set), -10, 1e-9, 'mains unaffected');
  near(monitorDb(setSource(set, 'alt')), -14, 1e-9, 'alts trimmed four down');
});

check('the trim sits UNDER the fader, and dim over both', () => {
  const s = setTrim(room({ levelDb: -10, dim: true }), 'main', -3);
  near(monitorDb(s), -10 - 3 + DEFAULT_DIM_DB, 1e-9, 'level + trim, then dim');
});

check('every speaker set has a name', () => {
  for (const key of Object.keys(MONITOR_LABELS) as MonitorSource[]) {
    assert(MONITOR_LABELS[key].length > 0, `${key} is named`);
  }
});

// ── Mono ────────────────────────────────────────────────────────────────────

check('mono is a flag on the monitor path, not a level change', () => {
  // The fold is done by the audio node; the state only says whether to.  A
  // mono button that also changed the level would make the check useless,
  // because you would be judging a loudness difference.
  const s = toggleMono(room({ levelDb: -8 }));
  assert(s.mono, 'on');
  near(monitorDb(s), -8, 1e-9, 'and not a decibel different');
  assert(!toggleMono(s).mono, 'and it toggles back');
});

// ── Cues ────────────────────────────────────────────────────────────────────

check('a cue is independent of the room level', () => {
  // Turning the room down must not turn the singer's headphones down.  This
  // is the whole reason cues exist as separate sends.
  const quiet = room({ levelDb: MIN_LEVEL_DB });
  const cue = quiet.cues[0];
  assert(cue, 'there is a cue');
  assert(cueGain(cue) > 0, 'and it is still feeding the headphones');
});

check('a muted cue is silent, and a cue fader is held in range', () => {
  const s = setCue(room(), 'cue-1', { muted: true });
  near(cueGain(s.cues[0]!), 0, 0, 'muted');
  const loud = setCue(room(), 'cue-1', { levelDb: 999 });
  assert(cueGain(loud.cues[0]!) <= dbToGain(MAX_LEVEL_DB) + 1e-9, 'and not louder than the ceiling');
});

check('cues can be added up to a limit and removed', () => {
  let s = room();
  const start = s.cues.length;
  for (let i = 0; i < 10; i++) s = addCue(s);
  assert(s.cues.length === MAX_CUES, `stops at ${MAX_CUES} — got ${s.cues.length}`);
  assert(s.cues.every((c, i) => s.cues.findIndex((o) => o.id === c.id) === i),
    'and every cue has its own id');
  const fewer = removeCue(s, s.cues[0]!.id);
  assert(fewer.cues.length === MAX_CUES - 1, 'one removed');
  assert(start >= 1, 'there were cues to begin with');
});

check('a cue added after a removal is a NEW cue, not a second copy of an old one', () => {
  // Numbering by count hands out an id that is already taken: remove Cue 2,
  // add one, and there are two `cue-3`s.  From then on every level move on
  // one of them moves the other, which reads as the fader being broken.
  let st = room();
  while (st.cues.length < MAX_CUES) st = addCue(st);
  const victim = st.cues[1]!.id;
  st = removeCue(st, victim);
  st = addCue(st);
  const ids = st.cues.map((c) => c.id);
  assert(new Set(ids).size === ids.length, `every cue has its own id — got ${ids.join(',')}`);
  const names = st.cues.map((c) => c.name);
  assert(new Set(names).size === names.length, `and its own name — got ${names.join(',')}`);

  // And the consequence itself, not just the ids: setting one leaves the rest.
  const target = st.cues.at(-1)!.id;
  const after = setCue(st, target, { levelDb: -3 });
  const moved = after.cues.filter((c) => c.levelDb === -3);
  assert(moved.length === 1, `one fader moved, not ${moved.length}`);
});

check('the cue limit is something the panel can SEE, not only enforce', () => {
  // addCue caps silently.  A button that stays lit and does nothing is worse
  // than no button, so the panel has to be able to ask.
  let st = room();
  while (st.cues.length < MAX_CUES) st = addCue(st);
  assert(addCue(st) === st, 'at the cap, adding is a no-op returning the same state');
  const panel = readFileSync('src/renderer/components/daw/mix/ControlRoomPanel.tsx', 'utf8');
  assert(/disabled=\{s\.cues\.length >= MAX_CUES\}/.test(panel),
    'and the add button is disabled at the cap');
});

check('editing one cue leaves the others alone', () => {
  const s = setCue(room(), 'cue-2', { levelDb: -20 });
  near(s.cues[1]!.levelDb, -20, 1e-9, 'the one asked for');
  near(s.cues[0]!.levelDb, DEFAULT_CONTROL_ROOM.cues[0]!.levelDb, 1e-9, 'and not the other');
});

// ── Reading it back ─────────────────────────────────────────────────────────

check('the read-out says the level, the speakers and what is engaged', () => {
  const s = room({ levelDb: -8, dim: true, mono: true, source: 'alt' });
  const text = describeMonitor(s);
  assert(text.includes('DIM') && text.includes('MONO'), text);
  assert(text.includes(MONITOR_LABELS.alt), text);
  assert(describeMonitor(room({ muted: true })) === '뮤트', 'and mute says mute');
});

check('a cue reads back as what it is doing', () => {
  assert(describeCue({ id: 'c', name: 'Cue 1', levelDb: -6, muted: false, followsMain: true })
    .includes('메인 믹스'), 'following the main mix');
  assert(describeCue({ id: 'c', name: 'Cue 1', levelDb: -6, muted: true, followsMain: true })
    .includes('뮤트'), 'and a muted one says so first');
});

check('the reference SPL is a label, never a claim', () => {
  // Nothing here can measure a room.  It exists so somebody who HAS
  // calibrated can write the number down, and so the panel never implies a
  // calibration it did not perform.
  assert(DEFAULT_CONTROL_ROOM.referenceSpl === null, 'nothing is claimed by default');
});

// ── The node itself: the wiring, and the two numbers hidden inside it ───────
//
// Node has no Web Audio, so this builds the real `ControlRoomNode` against a
// context that records what was connected to what and what was written to
// each gain.  That is enough to hold the two things a stub can genuinely
// hold: the SHAPE of the graph, and the VALUES pushed onto it.
//
// It is not enough to hold that the result sounds right, so that was measured
// separately in the running app through Chromium's own OfflineAudioContext —
// unity 0.00 dB, fader −12 → −11.99, DIM → −19.97, MONO in phase → 0.00 (no
// 6 dB jump), MONO on an out-of-phase pair → cancels while the stereo path
// leaves it untouched.  Those figures are what the numbers below stand for.

class StubParam {
  value: number;
  constructor(v: number) { this.value = v; }
  setTargetAtTime(target: number, _t: number, _tau: number): StubParam {
    this.value = target;              // the stub has no clock: land immediately
    return this;
  }
  setValueAtTime(v: number): StubParam { this.value = v; return this; }
  linearRampToValueAtTime(v: number): StubParam { this.value = v; return this; }
  exponentialRampToValueAtTime(v: number): StubParam { this.value = v; return this; }
}
class StubNode {
  readonly outs: { node: StubNode; from: number; to: number }[] = [];
  readonly gain = new StubParam(1);
  readonly frequency = new StubParam(440);
  constructor(readonly kind: string) {}
  connect(n: StubNode, from = 0, to = 0): StubNode { this.outs.push({ node: n, from, to }); return n; }
  disconnect(): void { this.outs.length = 0; }
  start(): void { /* the stub has no clock */ }
  stop(): void { /* nor a way to run out of one */ }
}
/** Every oscillator the stub has handed out since it was last cleared. */
const oscillators: StubNode[] = [];
function stubCtx(): { ctx: BaseAudioContext; dest: StubNode } {
  const dest = new StubNode('destination');
  const ctx = {
    currentTime: 0,
    destination: dest,
    createGain: () => new StubNode('gain'),
    createChannelSplitter: () => new StubNode('splitter'),
    createChannelMerger: () => new StubNode('merger'),
    createOscillator: () => {
      const o = new StubNode('oscillator');
      oscillators.push(o);
      return o;
    },
  };
  return { ctx: ctx as unknown as BaseAudioContext, dest };
}
/** Every node reachable from `from`, with the path of kinds taken to get there. */
function pathsTo(from: StubNode, to: StubNode, trail: string[] = []): string[][] {
  const found: string[][] = [];
  for (const edge of from.outs) {
    const next = [...trail, edge.node.kind];
    if (edge.node === to) found.push(next);
    else found.push(...pathsTo(edge.node, to, next));
  }
  return found;
}
/** Build one, and name the internals by their position rather than their order. */
function built(state: ControlRoomState) {
  const { ctx, dest } = stubCtx();
  const cr = new ControlRoomNode(ctx, dest as unknown as AudioNode);
  cr.apply(state);
  const input = cr.input as unknown as StubNode;
  // The level is the only thing that reaches the destination.
  const level = input.outs.map((e) => e.node)
    .flatMap((n) => [n, ...n.outs.map((e) => e.node)])
    .find((n) => n.outs.some((e) => e.node === dest));
  const splitter = input.outs.find((e) => e.node.kind === 'splitter')?.node;
  const merger = splitter?.outs[0]?.node;
  const monoTrim = merger?.outs[0]?.node;
  const stereoPath = input.outs.find((e) => e.node.kind === 'gain' && e.node !== level)?.node;
  return { cr, dest, input, level, splitter, merger, monoTrim, stereoPath };
}

check('the mix reaches the speakers two ways, and only through the level', () => {
  const g = built(room());
  assert(g.level !== undefined, 'something has to reach the destination');
  // Distinct ROUTES, not edges: the fold's four cross-connections all take
  // the same route, and counting them as four would hide a real third path.
  const routes = [...new Set(pathsTo(g.input, g.dest).map((p) => p.join('→')))].sort();
  assert(routes.join(' | ') === 'gain→gain→destination | splitter→merger→gain→gain→destination',
    `one straight route and one folded, both through the level — got ${routes.join(' | ')}`);
  // Both routes pass the level on the way out, so the fader sits downstream of
  // the fold and a level move cannot mean two things depending on MONO.
  for (const r of routes) {
    assert(r.split('→').at(-2) === 'gain', `every route lands on the level — ${r}`);
    assert(g.level!.outs.some((e) => e.node === g.dest), 'which is the node reaching the speakers');
  }
});

check('the fold sums both sides into both outputs', () => {
  // A mono check that only summed into the left would move the image instead
  // of collapsing it, and would look fine on a meter.
  const g = built(room());
  const pairs = g.splitter!.outs.map((e) => `${e.from}->${e.to}`).sort();
  assert(pairs.join(',') === '0->0,0->1,1->0,1->1',
    `L and R into both outputs — got ${pairs.join(',')}`);
});

check('MONO is a fold, not a 6 dB boost', () => {
  // L+R with a centred source is twice the amplitude.  Without the halving,
  // pressing MONO makes everything louder, and loud reads as better — so
  // every judgement made about the fold is about the jump instead.
  const on = built(room({ mono: true }));
  near(on.monoTrim!.gain.value, 0.5, 1e-9, 'the sum is halved');
  near(on.stereoPath!.gain.value, 0, 1e-9, 'and the straight path is out');
});

check('with MONO off the fold is out of circuit, not merely quiet', () => {
  const off = built(room());
  near(off.monoTrim!.gain.value, 0, 1e-9, 'the fold contributes nothing');
  near(off.stereoPath!.gain.value, 1, 1e-9, 'and the straight path is unity');
});

check('the level carries the fader, the trim, DIM and MUTE', () => {
  near(built(room({ levelDb: 0 })).level!.gain.value, 1, 1e-9, 'unity is unity');
  near(built(room({ levelDb: -12 })).level!.gain.value, dbToGain(-12), 1e-9, 'the fader');
  near(built(room({ levelDb: 0, dim: true })).level!.gain.value, dbToGain(DEFAULT_DIM_DB), 1e-9, 'DIM');
  near(built(room({ levelDb: 0, source: 'alt', trimDb: { main: 0, alt: -6, phones: 0 } }))
    .level!.gain.value, dbToGain(-6), 1e-9, 'the speaker set trim');
  near(built(room({ muted: true })).level!.gain.value, 0, 1e-9, 'and MUTE is silence');
});

check('disposing lets go of the graph', () => {
  const g = built(room());
  g.cr.dispose();
  assert(g.input.outs.length === 0, 'the input is released');
  assert(g.level!.outs.length === 0, 'and so is the level');
  g.cr.dispose();  // twice is not a crash
});

check('the click is heard in the room, so it goes through the room', () => {
  // Found by looking at the live path rather than at the node: the metronome
  // connected straight to `ctx.destination`, downstream of everything the
  // control room does.  Press MUTE to take a phone call and the click keeps
  // going at full level — which makes MUTE a button that does not do what it
  // says.  DIM and the speaker trim missed it for the same reason.
  //
  // It is still not in the MIX: it never enters the mixer, so no bounce, stem
  // or master can contain it.  The control room sits after the mixer.
  // Run the real Metronome against a recording context and see where the
  // oscillator it makes actually lands.
  const { ctx, dest } = stubCtx();
  const room = new StubNode('gain');            // stands in for the room input
  const m = new Metronome();
  m.attach(ctx as unknown as never, room as unknown as AudioNode);
  m.setEnabled(true);
  m.tick(defaultTempoMap(120), 0, 2, 0);
  assert(oscillators.length > 0, 'a click was scheduled at all');
  const landed = oscillators.flatMap((o) => o.outs.map((e) => e.node))
    .flatMap((g) => g.outs.map((e) => e.node));
  assert(landed.length > 0 && landed.every((n) => n === room),
    'every click lands on what it was attached to, not on the speakers');
  assert(!landed.includes(dest), 'and none of them goes straight to the destination');

  // With nothing to attach to, it still clicks — a test or a headless context
  // must not go silent just because there is no control room.
  oscillators.length = 0;
  const bare = new Metronome();
  bare.attach(ctx as unknown as never);
  bare.setEnabled(true);
  bare.tick(defaultTempoMap(120), 0, 2, 0);
  const bareLanded = oscillators.flatMap((o) => o.outs.map((e) => e.node))
    .flatMap((g) => g.outs.map((e) => e.node));
  assert(bareLanded.length > 0 && bareLanded.every((n) => n === dest),
    'with no output given, the click falls back to the speakers');

  const runtime = readFileSync('src/renderer/daw/engine/daw-runtime.ts', 'utf8');
  assert(/this\.metronome\.attach\(this\.ctx, this\.controlRoom\.input\)/.test(runtime),
    'and the live runtime attaches it to the monitor path when it builds one');
  // Attached where the context is CREATED, not only where the click is
  // toggled: switching the click on before there was a context left it
  // attached to nothing at all.
  const ensure = runtime.slice(runtime.indexOf('ensure(sampleRate'),
    runtime.indexOf('/** Push the current session into the graph'));
  assert(/this\.metronome\.attach\(/.test(ensure),
    'attached inside ensure(), where the context and the room are made');

  const render = readFileSync('src/renderer/daw/engine/offline-render.ts', 'utf8');
  assert(!/[Mm]etronome/.test(render), 'and the render still never makes a click');
});

// ─────────────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Control room: the monitor path, which is not the mix ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
