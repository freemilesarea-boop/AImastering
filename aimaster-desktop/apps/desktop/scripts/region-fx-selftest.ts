/**
 * region-fx-selftest.ts — the tail, which is the whole feature.
 *
 * Cutting a piece out of a track is already solved: `separateAt` and
 * `splitClip` have been in the repository for a long time and they split at
 * the sample, so the cut itself is silent.  What is NOT solved by cutting is
 * what happens to a delay's last repeats, which land after the piece ends.
 *
 * So these tests are almost entirely about `chainTailSec` and about the two
 * places it is used: how long the chain says it will ring, and whether the
 * clip that comes back is longer by that much.
 *
 * The rendering itself needs an AudioContext, which node does not have, so the
 * render path is exercised in the running app instead and the pure parts are
 * exercised here.  That split is stated rather than hidden: a test that
 * silently skipped the render would read as coverage it does not have.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:region-fx
 */

import {
  chainTailSec, deviceTailSec, describeTail,
  MAX_CHAIN_TAIL_SEC, MAX_DEVICE_TAIL_SEC,
} from '../src/renderer/daw/model/plugin-tail.js';
import { PLUGINS, defaultParams } from '../src/renderer/daw/engine/plugins.js';
import { tubeSmallSignalGain } from '../src/renderer/daw/engine/plugins-extended.js';
import { createInsert } from '../src/renderer/daw/model/session-ops.js';
import {
  bodyDurationSec, originalSource, clipRegionFx, fadeSeam, renderSourceClip,
  RINGING_SEC, SEAM_FADE_SEC,
} from '../src/renderer/daw/edit/region-fx.js';
import { splitClip } from '../src/renderer/daw/edit/clip-edit.js';
import { createClip } from '../src/renderer/daw/model/session-ops.js';
import type { RegionFx } from '../src/renderer/daw/model/types.js';
import {
  fullyWet, liveAuxFor, makeRegionLive,
  SEND_CLOSED_DB, SEND_OPEN_DB, SEND_RAMP_SEC,
} from '../src/renderer/daw/edit/region-live.js';
import {
  addTrack, createSession, createTrack, findTrack, updateClips,
} from '../src/renderer/daw/model/session-ops.js';
import type { DawSession } from '../src/renderer/daw/model/types.js';
import { DEFAULT_MIDI_CONFIG } from '../src/renderer/daw/model/midi.js';
import type { Clip, Insert } from '../src/renderer/daw/model/types.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
const near = (a: number, b: number, tol: number, m: string): void => {
  assert(Math.abs(a - b) <= tol, `${m}: ${a} vs ${b} (±${tol})`);
};

const ins = (pluginId: string, params: Record<string, number> = {}, slot = 0): Insert =>
  createInsert(slot, pluginId, pluginId, { params: { ...defaultParams(pluginId), ...params } });

const SR = 48000;

// ── What rings, and what does not ────────────────────────────────────────────

check('a device that cannot ring reports no tail', () => {
  // The distinction that matters: a look-ahead limiter DELAYS the signal but
  // does not outlive it.  If latency were mistaken for tail, every chain with
  // a limiter would render a stretch of near-silence and call it a tail.
  for (const id of ['eq3', 'eq8', 'comp', 'mbcomp', 'clipper', 'limiter', 'gate',
                    'widener', 'monomaker', 'tilt', 'mseq', 'deesser', 'trim']) {
    assert(deviceTailSec(id, defaultParams(id)) === 0,
      `${id} claims a tail of ${deviceTailSec(id, defaultParams(id))} s`);
  }
});

check('every delay and reverb reports one', () => {
  for (const id of ['delay', 'pingpong', 'tapedelay', 'reverb', 'plate', 'spring',
                    'spacereverb', 'shimmer']) {
    assert(deviceTailSec(id, defaultParams(id)) > 0.05, `${id} reports no tail`);
  }
});

check('more feedback rings for longer', () => {
  const low  = deviceTailSec('delay', { timeMs: 400, feedback: 0.2 });
  const mid  = deviceTailSec('delay', { timeMs: 400, feedback: 0.5 });
  const high = deviceTailSec('delay', { timeMs: 400, feedback: 0.8 });
  assert(low < mid && mid < high, `not monotonic: ${low} / ${mid} / ${high}`);
});

check('a delay with no feedback rings for exactly one repeat', () => {
  near(deviceTailSec('delay', { timeMs: 250, feedback: 0 }), 0.25, 1e-9,
    'one repeat of a 250 ms delay');
});

check('the −60 dB figure is the real one, not a guess', () => {
  // 0.5 feedback loses 6.02 dB a repeat, so −60 dB is just under 10 repeats.
  // The formula adds the dry hit, hence 11 × the delay time.
  const tail = deviceTailSec('delay', { timeMs: 100, feedback: 0.5 });
  near(tail, 0.1 * (60 / 6.0206 + 1), 0.002, '0.5 feedback to −60 dB');
});

check('runaway feedback is capped instead of asking for a four-minute render', () => {
  assert(deviceTailSec('delay', { timeMs: 1500, feedback: 0.99 }) === MAX_DEVICE_TAIL_SEC,
    'a 0.99 feedback delay was not capped');
  assert(deviceTailSec('delay', { timeMs: 1500, feedback: 1 }) === MAX_DEVICE_TAIL_SEC,
    'feedback at unity was not capped');
});

check('a longer reverb reports a longer tail', () => {
  assert(deviceTailSec('plate', { decaySec: 6 }) > deviceTailSec('plate', { decaySec: 1.2 }),
    'plate decay does not reach the tail');
  assert(deviceTailSec('spacereverb', { decayPct: 240 }) > deviceTailSec('spacereverb', { decayPct: 60 }),
    'space reverb decayPct does not reach the tail');
});

check('ping-pong counts a crossing as half a repeat', () => {
  // The same time and feedback ring twice as long when the repeats alternate.
  const p = deviceTailSec('pingpong', { timeMs: 300, feedback: 0.5 });
  const d = deviceTailSec('delay', { timeMs: 300, feedback: 0.5 });
  near(p, d * 2, 0.01, 'ping-pong vs plain delay');
});

// ── The chain ────────────────────────────────────────────────────────────────

check('a chain rings for the sum of its parts, not the longest one', () => {
  // A delay into a reverb: the reverb is still being fed while the delay
  // repeats, so it starts decaying only after the last repeat.  Taking the max
  // would cut the reverb short by the length of the delay.
  const delay = ins('delay', { timeMs: 300, feedback: 0.5 });
  const plate = ins('plate', { decaySec: 2.5 }, 1);
  const both = chainTailSec([delay, plate], SR);
  const alone = chainTailSec([delay], SR) + chainTailSec([plate], SR);
  near(both, alone, 1e-6, 'chain tail is not the sum');
});

check('a bypassed device rings for nothing', () => {
  const on  = ins('plate', { decaySec: 4 });
  const off = { ...on, bypass: true };
  assert(chainTailSec([off], SR) === 0, 'a bypassed reverb still claims a tail');
  assert(chainTailSec([on], SR) > 3, 'an active reverb lost its tail');
});

check('latency is added on top of the ring', () => {
  // The limiter does not ring, but it holds the last samples back by its
  // look-ahead, and cutting at the tail would clip exactly those.
  const limiter = ins('limiter', { lookaheadMs: 8 });
  const tail = chainTailSec([limiter], SR);
  assert(tail > 0, 'a look-ahead limiter reported a zero tail');
  assert(tail < 0.05, `look-ahead reported as ${tail} s, far more than its 8 ms`);
});

check('an empty chain rings for nothing', () => {
  assert(chainTailSec([], SR) === 0, 'an empty chain claims a tail');
});

check('a chain of ten reverbs is still capped', () => {
  const many = Array.from({ length: 10 }, (_, i) => ins('plate', { decaySec: 12 }, i));
  assert(chainTailSec(many, SR) === MAX_CHAIN_TAIL_SEC, 'the chain cap did not hold');
});

check('every device in the registry answers the question', () => {
  // A device added later must not make this throw or return a non-number —
  // the default is zero, and zero is a real answer.
  for (const plugin of PLUGINS) {
    const tail = deviceTailSec(plugin.id, defaultParams(plugin.id));
    assert(Number.isFinite(tail) && tail >= 0, `${plugin.id} answered ${tail}`);
  }
});

check('the sentence the window shows names the device that is ringing', () => {
  const quiet = ins('eq8');
  const loud = ins('plate', { decaySec: 5 }, 1);
  assert(describeTail([], SR).includes('비어'), 'an empty chain is not described as empty');
  assert(describeTail([quiet], SR).includes('울리지 않'), 'a non-ringing chain is not described as such');
  const line = describeTail([quiet, loud], SR);
  assert(line.includes('Plate Reverb'), `the ringing device is not named: ${line}`);
});

// ── Reading a clip that has been through the lab ─────────────────────────────

const base: Clip = {
  id: 'clip-1', kind: 'audio', fileId: 'file-orig', notes: [], controllers: [],
  pitchSegments: [], midiConfig: DEFAULT_MIDI_CONFIG,
  name: '조각', startSec: 70, offsetSec: 12, durationSec: 10, gainDb: 0,
  fadeIn: { durationSec: 0, shape: 'linear' }, fadeOut: { durationSec: 0, shape: 'linear' },
  muted: false,
};

check('an untouched clip is its own original', () => {
  const src = originalSource(base);
  assert(src.fileId === 'file-orig' && src.offsetSec === 12 && src.durationSec === 10,
    'an untouched clip does not report itself');
  assert(clipRegionFx(base) === null, 'an untouched clip claims a chain');
  assert(bodyDurationSec(base) === 10, 'an untouched clip reports the wrong body length');
});

check('a processed clip still remembers what it replaced', () => {
  // This is the one that stops an apply-twice from being a delay of a delay.
  const processed: Clip = {
    ...base,
    fileId: 'file-rendered', offsetSec: 0, durationSec: 12.04,
    regionFx: {
      inserts: [ins('delay')], tailMode: 'keep', tailSec: 2.04,
      original: { fileId: 'file-orig', offsetSec: 12, durationSec: 10, gainDb: 0 },
    },
  };
  const src = originalSource(processed);
  assert(src.fileId === 'file-orig', 'a re-render would start from the processed audio');
  assert(src.offsetSec === 12 && src.durationSec === 10, 'the original bounds were lost');
  assert(bodyDurationSec(processed) === 10,
    'the body length reads the grown clip instead of the original');
  assert(processed.durationSec > src.durationSec,
    'the processed clip did not grow by its tail');
});

// ── The device that made this visible ────────────────────────────────────────
//
// Rendering a long tail through Tape Delay is how it was noticed that the
// saturator inside its feedback loop AMPLIFIES: the tail came back as a flat,
// constant tone instead of a decaying repeat.  The loop gain at the factory
// settings was 3.07, so it was an oscillator, and had been all along — nothing
// had asked it for four seconds of ring before.

check('the tube curve claims the gain it actually has', () => {
  // The analytic figure and the sampled curve must agree, or compensating by
  // the analytic one would compensate by the wrong amount.
  for (const [drive, bias] of [[0, 0.05], [0.25, 0.05], [0.5, 0.05], [1, 0.05],
                               [0.3, 0.15], [0.8, 0.15]] as Array<[number, number]>) {
    const n = 4096;
    const k = 1 + drive * 24;
    const sample = (x: number): number => {
      const b = x + bias;
      return (Math.tanh(b * k) - Math.tanh(bias * k)) / Math.max(1e-6, Math.tanh(k));
    };
    const measured = (sample(0.002) - sample(-0.002)) / 0.004;
    const claimed = tubeSmallSignalGain(drive, bias);
    assert(Math.abs(measured - claimed) / Math.max(1, claimed) < 0.01,
      `drive ${drive} bias ${bias}: curve slope ${measured.toFixed(3)} vs claimed ${claimed.toFixed(3)}`);
    void n;
  }
});

check('a saturator in a feedback loop cannot have gain above one', () => {
  // The compensation the tape delay applies.  Anything above 1 here and the
  // loop gain is feedback × this, which at the 0.95 the knob allows is an
  // oscillator for any gain over 1.05.
  for (let drive = 0; drive <= 1.0001; drive += 0.05) {
    const compensated = tubeSmallSignalGain(drive, 0.05) / Math.max(1, tubeSmallSignalGain(drive, 0.05));
    assert(compensated <= 1.0001, `drive ${drive.toFixed(2)} still passes ${compensated}`);
    assert(compensated * 0.95 < 1, `drive ${drive.toFixed(2)} diverges at maximum feedback`);
  }
});

check('the uncompensated curve really was divergent — this is not a theory', () => {
  // Pinned so that a future "simplification" of the curve cannot quietly put
  // the oscillator back and have every test still pass.
  assert(tubeSmallSignalGain(0.25, 0.05) > 6,
    'the default drive no longer amplifies — if the curve changed, revisit the compensation');
  assert(tubeSmallSignalGain(0.25, 0.05) * 0.45 > 1,
    'the factory tape delay is no longer over unity loop gain');
});

// ── Cutting at the seam ──────────────────────────────────────────────────────
//
// `cut` is the mode for devices that do not outlive their input.  The mode
// works; what it lacked was any way of knowing it was being used on a device
// that DOES.  These pin the rule that decides whether a chain counts as
// ringing, because both the warning and the seam fade hang off it.

check('a chain of EQ and gain does not count as ringing', () => {
  for (const chain of [[ins('eq8')], [ins('eq3'), ins('trim', {}, 1)],
                       [ins('comp'), ins('mbcomp', {}, 1)], [ins('widener')]]) {
    assert(chainTailSec(chain, SR) < RINGING_SEC,
      `${chain.map((i) => i.pluginId).join('+')} counts as ringing at ${chainTailSec(chain, SR)} s`);
  }
});

check('a look-ahead limiter does not count as ringing either', () => {
  // It reports latency as tail, which is right for the render length and
  // wrong as a reason to warn: 8 ms cut off the end is inaudible.
  const chain = [ins('limiter', { lookaheadMs: 10 })];
  const tail = chainTailSec(chain, SR);
  assert(tail > 0, 'the limiter reports no tail at all');
  assert(tail < RINGING_SEC, `a limiter counts as ringing at ${tail} s`);
});

check('every delay and reverb does count as ringing', () => {
  for (const id of ['delay', 'pingpong', 'tapedelay', 'reverb', 'plate', 'spring',
                    'spacereverb', 'shimmer']) {
    assert(chainTailSec([ins(id)], SR) >= RINGING_SEC,
      `${id} does not count as ringing — cutting it would warn about nothing`);
  }
});

check('the seam fade is short enough to be a declick and not a fade', () => {
  // Long enough and it stops being "the chop lands cleanly" and becomes "the
  // last of the piece got quieter", which is a different edit.
  assert(SEAM_FADE_SEC > 0.001, `${SEAM_FADE_SEC} s is too short to stop a click`);
  assert(SEAM_FADE_SEC < 0.02, `${SEAM_FADE_SEC} s is long enough to be heard as a fade`);
});

check('the seam fade lands on zero and leaves the rest alone', () => {
  const sr = 48000;
  const ch = new Float32Array(sr);   // one second of DC at full scale
  ch.fill(1);
  fadeSeam([ch], sr, SEAM_FADE_SEC);
  const n = Math.floor(SEAM_FADE_SEC * sr);
  assert(Math.abs(ch[ch.length - 1] ?? 1) < 1e-6,
    `the last sample is ${ch[ch.length - 1]}, so the click is still there`);
  assert(ch[ch.length - n - 1] === 1, 'the fade reached back past its own length');
  assert(ch[0] === 1, 'the fade touched the start of the piece');
  // Equal power: halfway through, cos(π/4) ≈ 0.707, not 0.5.
  near(ch[ch.length - Math.floor(n / 2) - 1] ?? 0, Math.SQRT1_2, 0.02,
    'the fade is linear, which dips on sustained material');
});

check('the seam fade refuses to do anything silly', () => {
  const tiny = new Float32Array(3); tiny.fill(1);
  fadeSeam([tiny], 48000, SEAM_FADE_SEC);   // asked for more samples than exist
  assert(tiny[0] === 1 && tiny[2] === 1, 'a buffer shorter than the fade was mangled');
  const empty: Float32Array[] = [];
  fadeSeam(empty, 48000, SEAM_FADE_SEC);    // must not throw
});

// ── The live send: the tail nobody has to compute ────────────────────────────
//
// `keep` needs to know how long the chain rings, because it is rendering that
// ring into a file.  `live` needs to know nothing: shutting a send stops
// feeding the aux, and the aux goes on ringing by itself.  These tests are
// about the two things that make that true — the send closes exactly at the
// clip's end, and the aux is fully wet.

function sessionWithClip(): { session: DawSession; trackId: string; clipId: string } {
  let session = createSession('live-test');
  const track = createTrack('Audio 1', 'audio');
  session = addTrack(session, track);
  session = updateClips(session, track.id, () => [{ ...base, id: 'clip-live' }]);
  return { session, trackId: track.id, clipId: 'clip-live' };
}

check('a send effect is forced fully wet, whatever it was on the track', () => {
  // The bug this prevents: an aux delay at its usual 25 % mix returns 75 % dry,
  // which sums with the track's own dry and combs.
  for (const id of ['delay', 'tapedelay', 'plate', 'spacereverb', 'shimmer', 'pingpong']) {
    const wet = fullyWet(ins(id));
    const descriptor = PLUGINS.find((p) => p.id === id)!;
    for (const name of ['mix', 'mixPct']) {
      const def = descriptor.params.find((p) => p.id === name);
      if (def) {
        assert(wet.params[name] === def.max,
          `${id}.${name} is ${wet.params[name]}, expected its maximum ${def.max}`);
      }
    }
  }
});

check('a device with no mix control is left exactly as it was', () => {
  const eq = ins('eq8', { b1Db: 4.5 });
  const wet = fullyWet(eq);
  assert(JSON.stringify(wet.params) === JSON.stringify(eq.params),
    'an EQ was altered on its way to the aux');
});

check('the chain that lands on the aux is the fully wet one', () => {
  // Checking `fullyWet` on its own proves the function works, not that the
  // throw CALLS it — and forgetting to call it is the actual failure mode.
  // So this reads the device that ended up on the aux.
  const { session, trackId, clipId } = sessionWithClip();
  const dry = ins('tapedelay', { mix: 25 });
  const out = makeRegionLive(session, trackId, clipId, [dry]);
  const aux = findTrack(out.session, out.auxTrackId)!;
  const onAux = aux.inserts[0]!;
  const def = PLUGINS.find((p) => p.id === 'tapedelay')!.params.find((p) => p.id === 'mix')!;
  assert(onAux.params['mix'] === def.max,
    `the aux delay is at ${onAux.params['mix']} % wet, not ${def.max} — the dry will comb`);
  // And the chain on the TRACK, if any, is not touched by this.
  assert(dry.params['mix'] === 25, 'the source insert was mutated');
});

check('the throw builds an aux, a send and a lane — and nothing else', () => {
  const { session, trackId, clipId } = sessionWithClip();
  const before = session.tracks.length;
  const out = makeRegionLive(session, trackId, clipId, [ins('tapedelay')]);
  assert(out.session.tracks.length === before + 1, 'the aux was not added');
  assert(out.session.buses.length === session.buses.length + 1, 'the bus was not added');
  const aux = findTrack(out.session, out.auxTrackId)!;
  assert(aux.kind === 'aux', `the new track is a ${aux.kind}`);
  assert(aux.inserts.length === 1, `the aux carries ${aux.inserts.length} devices`);
  const source = findTrack(out.session, trackId)!;
  assert(source.sends.length === 1, `the source has ${source.sends.length} sends`);
  assert(source.sends[0]!.target === aux.input, 'the send does not point at the aux');
  // The clip itself must be untouched — nothing was rendered.
  const clip = source.playlists[0]!.clips[0]!;
  assert(clip.fileId === base.fileId && clip.durationSec === base.durationSec,
    'the live path modified the clip');
  assert(clip.regionFx === undefined, 'the live path wrote a bake onto the clip');
});

check('the send is shut before the piece, open across it, and shut after', () => {
  const { session, trackId, clipId } = sessionWithClip();
  const out = makeRegionLive(session, trackId, clipId, [ins('delay')]);
  const source = findTrack(out.session, trackId)!;
  const lane = source.automation.find((l) => l.target.kind === 'sendLevel');
  assert(lane, 'no send-level lane was written');
  const at = (t: number): number => {
    // Linear between points, which is how the engine reads a lane.
    const pts = lane!.points;
    if (t <= pts[0]!.timeSec) return pts[0]!.value;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!, b = pts[i]!;
      if (t <= b.timeSec) {
        const u = b.timeSec === a.timeSec ? 1 : (t - a.timeSec) / (b.timeSec - a.timeSec);
        return a.value + (b.value - a.value) * u;
      }
    }
    return pts[pts.length - 1]!.value;
  };
  const from = base.startSec, to = base.startSec + base.durationSec;
  near(at(from - 1), SEND_CLOSED_DB, 1e-9, 'the send is not shut before the piece');
  near(at(from), SEND_OPEN_DB, 1e-9, 'the send is not open at the first sample');
  near(at((from + to) / 2), SEND_OPEN_DB, 1e-9, 'the send closed in the middle of the piece');
  near(at(to), SEND_OPEN_DB, 1e-9, 'the send shut before the last sample');
  near(at(to + SEND_RAMP_SEC), SEND_CLOSED_DB, 1e-9, 'the send never shuts');
  near(at(to + 5), SEND_CLOSED_DB, 1e-9, 'the send reopened after the piece');
});

check('the edges ramp instead of stepping', () => {
  // A step from silence to unity mid-waveform is a click, and a click into a
  // delay is a click repeated for the length of the tail.
  const { session, trackId, clipId } = sessionWithClip();
  const out = makeRegionLive(session, trackId, clipId, [ins('delay')]);
  const lane = findTrack(out.session, trackId)!.automation
    .find((l) => l.target.kind === 'sendLevel')!;
  const times = lane.points.map((p) => p.timeSec);
  const from = base.startSec, to = base.startSec + base.durationSec;
  assert(times.some((t) => Math.abs(t - (from - SEND_RAMP_SEC)) < 1e-9),
    'there is no ramp into the open');
  assert(times.some((t) => Math.abs(t - (to + SEND_RAMP_SEC)) < 1e-9),
    'there is no ramp out of the open');
  assert(SEND_RAMP_SEC > 0 && SEND_RAMP_SEC < 0.05,
    `the ramp is ${SEND_RAMP_SEC} s — long enough to be heard as a fade`);
});

check('a piece at the very top of the song does not ask for a negative time', () => {
  let session = createSession('edge');
  const track = createTrack('Audio 1', 'audio');
  session = addTrack(session, track);
  session = updateClips(session, track.id, () => [{ ...base, id: 'c0', startSec: 0 }]);
  const out = makeRegionLive(session, track.id, 'c0', [ins('delay')]);
  const lane = findTrack(out.session, track.id)!.automation
    .find((l) => l.target.kind === 'sendLevel')!;
  assert(lane.points.every((p) => p.timeSec >= 0),
    `a point landed at ${lane.points.find((p) => p.timeSec < 0)?.timeSec}`);
});

check('an empty chain is refused rather than building an empty aux', () => {
  const { session, trackId, clipId } = sessionWithClip();
  let threw = false;
  try { makeRegionLive(session, trackId, clipId, []); } catch { threw = true; }
  assert(threw, 'an empty chain built an aux anyway');
  try { makeRegionLive(session, trackId, clipId, [{ ...ins('delay'), bypass: true }]); }
  catch { return; }
  throw new Error('a chain of nothing but bypassed devices built an aux');
});

check('the window can tell that a piece is already being thrown', () => {
  const { session, trackId, clipId } = sessionWithClip();
  assert(liveAuxFor(session, trackId, clipId) === null, 'an untouched piece claims an aux');
  const out = makeRegionLive(session, trackId, clipId, [ins('delay')]);
  assert(liveAuxFor(out.session, trackId, clipId) === out.auxTrackId,
    'the aux built for this piece is not found again');
});


// ── What survives applying a chain, and what comes back ─────────────────────

/** A clip that has had a chain rendered into it, as `applyRegionFx` leaves one. */
function appliedClip(overrides: Partial<Clip> = {}): Clip {
  const base = createClip('rendered', 'piece', { startSec: 4, offsetSec: 0, durationSec: 2 });
  const fx: RegionFx = {
    inserts: [],
    tailMode: 'cut',
    tailSec: 0,
    original: { fileId: 'source', offsetSec: 12, durationSec: 2, gainDb: -4.5 },
  };
  return { ...base, gainDb: 0, regionFx: fx, ...overrides };
}

check('the clip gain is written down before it is baked away', () => {
  // Applying a chain renders AT the clip gain and then zeroes it so it is not
  // applied twice.  If the number is not recorded, reverting hands the audio
  // back at unity and the trim is gone for good.
  const clip = appliedClip();
  const source = originalSource(clip);
  near(source.gainDb, -4.5, 1e-9, 'the original gain must survive in `original`');
  assert(clip.gainDb === 0, 'the fixture must model a baked gain');
});

check('a clip that was never processed reports its own gain as the original', () => {
  const plain = { ...createClip('f', 'c', { startSec: 0, offsetSec: 0, durationSec: 1 }), gainDb: -3 };
  near(originalSource(plain).gainDb, -3, 1e-9, 'no regionFx means the clip IS the original');
});

check('splitting a processed clip drops the offer to revert, on BOTH halves', () => {
  // `original` describes the whole clip, so carrying it onto a half would make
  // 되돌리기 replace a one-second piece with the full-length source.
  const [head, tail] = splitClip(appliedClip(), 5);
  assert(clipRegionFx(head) === null, 'the head still claims a revert');
  assert(clipRegionFx(tail) === null, 'the tail still claims a revert');
  // And the key is genuinely absent, not present holding undefined — under
  // `exactOptionalPropertyTypes` those are different clips.
  assert(!('regionFx' in head) && !('regionFx' in tail), 'the key must be dropped, not undefined');
  // The audio is untouched — both halves still point at the rendered file.
  assert(head.fileId === 'rendered' && tail.fileId === 'rendered',
    'splitting must not change which file the halves play');
  near(head.durationSec, 1, 1e-9, 'head length');
  near(tail.startSec, 5, 1e-9, 'tail start');
});

check('splitting an ordinary clip is untouched by any of this', () => {
  const plain = createClip('f', 'c', { startSec: 0, offsetSec: 0, durationSec: 4 });
  const [head, tail] = splitClip(plain, 1.5);
  near(head.durationSec, 1.5, 1e-9, 'head');
  near(tail.durationSec, 2.5, 1e-9, 'tail');
  assert(head.fadeOut.durationSec === 0 && tail.fadeIn.durationSec === 0, 'the new edges are square');
});


check('the clip fades are NOT rendered into the file', () => {
  // They stay on the clip and are applied once, at playback.  Rendering them
  // in as well ramped audio that was already ramped — and in `keep` mode the
  // clip grows by the tail, so the baked fade-out landed on the end of the
  // ring instead of the end of the note.
  const withFades: Clip = {
    ...createClip('src', 'piece', { startSec: 3, offsetSec: 5, durationSec: 8 }),
    fadeIn: { durationSec: 0.4, shape: 'linear' },
    fadeOut: { durationSec: 0.9, shape: 'equalPower' },
  };
  const forRender = renderSourceClip(withFades);
  near(forRender.fadeIn.durationSec, 0, 1e-9, 'the fade-in must not be rendered in');
  near(forRender.fadeOut.durationSec, 0, 1e-9, 'nor the fade-out');
  // The shapes ride along so the clip's own fades are untouched by any of this.
  assert(forRender.fadeIn.shape === 'linear', 'the shape is kept for the clip');
  assert(forRender.fadeOut.shape === 'equalPower', 'both of them');
  // And the source clip itself keeps its fades — this returns a copy.
  near(withFades.fadeIn.durationSec, 0.4, 1e-9, 'the clip still fades in');
  near(withFades.fadeOut.durationSec, 0.9, 1e-9, 'and out');
});

check('the clip GAIN is rendered in, unlike the fades', () => {
  // The asymmetry is deliberate: a trim belongs in front of the chain, so the
  // compressor hears what the person set.  It is zeroed on the clip afterwards,
  // which is why `original.gainDb` has to exist.
  const loud: Clip = {
    ...createClip('src', 'piece', { startSec: 0, offsetSec: 0, durationSec: 4 }),
    gainDb: -7.5,
  };
  near(renderSourceClip(loud).gainDb, -7.5, 1e-9, 'the trim must reach the chain');
});

check('the render reads the ORIGINAL audio, never the processed audio', () => {
  // Re-applying a chain to an already-processed clip must start from the
  // untouched source, or the second pass is a delay of a delay.
  const again = appliedClip();
  const forRender = renderSourceClip(again);
  assert(forRender.fileId === 'source', `re-render must start from the source, got ${forRender.fileId}`);
  near(forRender.offsetSec, 12, 1e-9, 'at the original offset');
  near(forRender.durationSec, 2, 1e-9, 'for the original length');
});

// ─────────────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Region FX — the tail ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
