/**
 * reverb-selftest — do the rooms exist?
 *
 * A reverb is the easiest device in a rack to fake and the hardest to check by
 * ear.  Everything decays, so everything "works"; whether a 2.2-second hall
 * actually decays in 2.2 seconds, whether damping darkens anything, whether a
 * plate is stable at six seconds — none of that is audible as a yes/no, and
 * all of it is measurable.
 *
 * So this file measures.  RT60 by Schroeder backward integration, band energy
 * ratios for damping, arrival times for the image-source model, and a Goertzel
 * bin for the one claim that would otherwise be pure assertion: that the
 * shimmer's pitch shifter really produces an octave.
 *
 * The devices are rendered through a real OfflineAudioContext, because a
 * feedback delay network that is stable on paper and unstable in a graph is a
 * feedback delay network that ships as a scream.
 *
 * Run:  pnpm --filter @aimaster/desktop test:reverb
 */

import { OfflineAudioContext } from 'node-web-audio-api';

(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import {
  SPACES, clearIrCache, earlyTaps, irBuffer, irDisplay, irLengthSec, renderIr,
  spaceAt, spaceChoices, spaceIndex, type Space,
} from '../src/renderer/daw/engine/reverb-spaces.js';
import { REVERB_PLUGINS, octaveUp } from '../src/renderer/daw/engine/plugins-reverb.js';
import { PLUGINS, defaultParams, findPlugin } from '../src/renderer/daw/engine/plugins.js';
import {
  PLUGIN_PRESETS, presetGroups, presetsFor, resolvePreset,
} from '../src/renderer/daw/engine/plugin-presets.js';

const SR = 48_000;

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

// ── Measurement ─────────────────────────────────────────────────────────────

/**
 * RT60 by Schroeder backward integration.
 *
 * Integrate the energy from the end backwards, take the decibel curve of that,
 * and read the slope between −5 and −35 dB.  Reading it straight off the
 * envelope instead would measure the noise in the tail rather than the tail.
 */
function rt60(left: Float32Array, right: Float32Array, sampleRate: number): number {
  const n = left.length;
  const energy = new Float64Array(n);
  let acc = 0;
  for (let i = n - 1; i >= 0; i--) {
    acc += left[i]! * left[i]! + right[i]! * right[i]!;
    energy[i] = acc;
  }
  const total = energy[0]!;
  if (total <= 0) return NaN;
  let t5 = -1;
  let t35 = -1;
  for (let i = 0; i < n; i++) {
    const db = 10 * Math.log10(energy[i]! / total);
    if (t5 < 0 && db <= -5) t5 = i / sampleRate;
    if (db <= -35) { t35 = i / sampleRate; break; }
  }
  if (t5 < 0 || t35 < 0) return NaN;
  return (t35 - t5) * 2;   // T30, doubled
}

/** Energy of one frequency, without an FFT. */
function goertzel(data: Float32Array, sampleRate: number, hz: number): number {
  const k = (2 * Math.PI * hz) / sampleRate;
  const coeff = 2 * Math.cos(k);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < data.length; i++) {
    const s = data[i]! + coeff * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) / data.length;
}

/** A one-pole split, for asking how bright something is. */
function bandEnergy(data: Float32Array, sampleRate: number, cutoffHz: number): { low: number; high: number } {
  const a = Math.exp(-2 * Math.PI * cutoffHz / sampleRate);
  let z = 0;
  let low = 0;
  let high = 0;
  for (let i = 0; i < data.length; i++) {
    z = data[i]! * (1 - a) + z * a;
    low += z * z;
    const h = data[i]! - z;
    high += h * h;
  }
  return { low, high };
}

interface Rendered { peak: number; rms: number; finite: boolean; buffer: AudioBuffer }

/**
 * Render a device with a click and a tone burst.
 *
 * The click excites the room, the burst gives something sustained to measure a
 * pitch on, and there is silence after both so the tail is the only thing in
 * the last second.
 */
async function renderDevice(
  pluginId: string, overrides: Record<string, number>, seconds = 4,
  source: 'impulse' | 'tone' = 'impulse', toneHz = 440,
): Promise<Rendered> {
  const frames = Math.round(SR * seconds);
  const ctx = new OfflineAudioContext(2, frames, SR) as unknown as BaseAudioContext & {
    destination: AudioNode; startRendering: () => Promise<AudioBuffer>;
  };
  const def = findPlugin(pluginId);
  assert(def !== undefined, `${pluginId} exists`);
  const instance = def!.create(ctx, { ...defaultParams(pluginId), ...overrides });

  const buffer = ctx.createBuffer(2, frames, SR);
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c);
    if (source === 'impulse') {
      data[Math.round(SR * 0.02)] = 0.9;
    } else {
      // One second of tone, then silence — the tail is what is left.
      for (let i = 0; i < SR; i++) {
        const fade = Math.min(1, i / 2000, (SR - i) / 2000);
        data[i] = Math.sin((2 * Math.PI * toneHz * i) / SR) * 0.5 * fade;
      }
    }
  }
  const node = ctx.createBufferSource();
  node.buffer = buffer;
  node.connect(instance.input);
  instance.output.connect(ctx.destination);
  node.start(0);

  const out = await ctx.startRendering();
  let peak = 0;
  let sum = 0;
  let finite = true;
  for (let c = 0; c < out.numberOfChannels; c++) {
    const data = out.getChannelData(c);
    for (let i = 0; i < out.length; i++) {
      const v = data[i]!;
      if (!Number.isFinite(v)) finite = false;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sum += v * v;
    }
  }
  return { peak, rms: Math.sqrt(sum / (out.length * out.numberOfChannels)), finite, buffer: out };
}

/** Energy inside a window of the rendered result. */
function windowRms(buffer: AudioBuffer, fromSec: number, toSec: number): number {
  const from = Math.max(0, Math.round(fromSec * buffer.sampleRate));
  const to = Math.min(buffer.length, Math.round(toSec * buffer.sampleRate));
  if (to <= from) return 0;
  let sum = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = from; i < to; i++) sum += data[i]! * data[i]!;
  }
  return Math.sqrt(sum / ((to - from) * buffer.numberOfChannels));
}

async function main(): Promise<void> {
  // ── The catalogue ─────────────────────────────────────────────────────────

  await check('every space is complete, unique and plausible', () => {
    const ids = new Set<string>();
    for (const space of SPACES) {
      assert(!ids.has(space.id), `${space.id} appears once`);
      ids.add(space.id);
      assert(space.name.length > 0 && space.note.length > 0, `${space.id} is named and described`);
      assert(space.rt60Sec > 0.05 && space.rt60Sec <= 14, `${space.id} decay is in range`);
      assert(space.sizeM >= 2 && space.sizeM <= 200, `${space.id} size is a room`);
      assert(space.diffusion >= 0 && space.diffusion <= 1, `${space.id} diffusion 0…1`);
      assert(space.damping >= 0 && space.damping <= 1, `${space.id} damping 0…1`);
      assert(space.width >= 0 && space.width <= 1, `${space.id} width 0…1`);
    }
    assert(SPACES.length >= 24, `a catalogue worth the name (${SPACES.length})`);
    assert(spaceChoices().length === SPACES.length, 'the picker lists all of them');
    assert(spaceAt(-5).id === SPACES[0]!.id, 'an out-of-range index clamps low');
    assert(spaceAt(999).id === SPACES[SPACES.length - 1]!.id, 'and high');
    assert(spaceIndex('nope') === 0, 'an unknown id falls back rather than throwing');
  });

  await check('every group is represented, live rooms included', () => {
    const groups = new Set(SPACES.map((s) => s.group));
    for (const wanted of ['live', 'hall', 'room', 'plate', 'ambience', 'special'] as const) {
      assert(groups.has(wanted), `${wanted} spaces exist`);
    }
    const live = SPACES.filter((s) => s.group === 'live');
    assert(live.length >= 6, `enough stages to choose from (${live.length})`);
    // A stage is not a hall: the live rooms have to actually span the range
    // from a monitor wedge to a stadium.
    const shortest = Math.min(...live.map((s) => s.rt60Sec));
    const longest = Math.max(...live.map((s) => s.rt60Sec));
    assert(shortest < 0.5, `something as tight as a wedge (${shortest})`);
    assert(longest > 4, `and something as big as a stadium (${longest})`);
  });

  // ── The impulse responses ────────────────────────────────────────────────

  await check('every space decays in the time it claims to', () => {
    const bad: string[] = [];
    for (const space of SPACES) {
      if (space.shape !== 'exp') continue;   // gated and reverse decay by design
      const ir = renderIr(space, { sampleRate: SR });
      const measured = rt60(ir.left, ir.right, SR);
      const error = Math.abs(measured - space.rt60Sec) / space.rt60Sec;
      if (!(error < 0.2)) bad.push(`${space.id} ${space.rt60Sec}s → ${measured.toFixed(2)}s`);
    }
    assert(bad.length === 0, `within 20 % of stated: ${bad.join(', ')}`);
  });

  await check('changing the space changes the room, not the level', () => {
    // Without this every A/B between two rooms is a loudness comparison, and
    // the louder one always wins.
    let min = Infinity;
    let max = 0;
    for (const space of SPACES) {
      const ir = renderIr(space, { sampleRate: SR });
      let energy = 0;
      for (let i = 0; i < ir.frames; i++) energy += ir.left[i]! ** 2 + ir.right[i]! ** 2;
      const rms = Math.sqrt(energy / 2);
      min = Math.min(min, rms);
      max = Math.max(max, rms);
    }
    const spreadDb = 20 * Math.log10(max / min);
    assert(spreadDb < 0.1, `every IR carries the same energy (spread ${spreadDb.toFixed(3)} dB)`);
  });

  await check('decay scaling really scales the decay', () => {
    const space = SPACES.find((s) => s.id === 'hall-concert')!;
    const half = renderIr(space, { sampleRate: SR, decayScale: 0.5 });
    const double = renderIr(space, { sampleRate: SR, decayScale: 2 });
    const a = rt60(half.left, half.right, SR);
    const b = rt60(double.left, double.right, SR);
    assert(Math.abs(a - space.rt60Sec * 0.5) / (space.rt60Sec * 0.5) < 0.25, `half → ${a.toFixed(2)}s`);
    assert(Math.abs(b - space.rt60Sec * 2) / (space.rt60Sec * 2) < 0.25, `double → ${b.toFixed(2)}s`);
    assert(b > a * 3, 'and the two are not the same room');
  });

  await check('size moves the walls — the first reflection moves with them', () => {
    const space = SPACES.find((s) => s.id === 'live-house')!;
    const small = earlyTaps(space, { sampleRate: SR, sizeScale: 0.5 });
    const large = earlyTaps(space, { sampleRate: SR, sizeScale: 2 });
    assert(small.length > 0 && large.length > 0, 'both rooms have reflections');
    const first = (taps: typeof small): number => taps[0]!.timeSec;
    const ratio = first(large) / first(small);
    // Four times the linear size, four times the path — sound has one speed.
    assert(ratio > 3 && ratio < 5, `first arrival scales with size (×${ratio.toFixed(2)})`);
    for (const taps of [small, large]) {
      for (let i = 1; i < taps.length; i++) {
        assert(taps[i]!.timeSec >= taps[i - 1]!.timeSec, 'taps come out in time order');
      }
      assert(taps.every((t) => t.timeSec > 0 && t.gain > 0), 'and are real arrivals');
      assert(taps.every((t) => t.pan >= -1 && t.pan <= 1), 'panned within the field');
    }
  });

  await check('diffusion is how many surfaces there are', () => {
    const open = SPACES.find((s) => s.id === 'live-openair')!;
    const hall = SPACES.find((s) => s.id === 'hall-symphony')!;
    const sparse = earlyTaps(open, { sampleRate: SR }).length;
    const dense = earlyTaps(hall, { sampleRate: SR }).length;
    assert(dense > sparse * 2, `an open stage reflects less than a hall (${sparse} vs ${dense})`);
  });

  await check('damping darkens the tail, and does not just turn it down', () => {
    const space = SPACES.find((s) => s.id === 'hall-concert')!;
    const bright = renderIr(space, { sampleRate: SR, damping: 0.05 });
    const dark = renderIr(space, { sampleRate: SR, damping: 0.95 });
    const b = bandEnergy(bright.left, SR, 3000);
    const d = bandEnergy(dark.left, SR, 3000);
    const brightRatio = b.high / Math.max(1e-12, b.low);
    const darkRatio = d.high / Math.max(1e-12, d.low);
    assert(darkRatio < brightRatio * 0.6,
      `a damped room has less top (${darkRatio.toFixed(3)} vs ${brightRatio.toFixed(3)})`);
  });

  await check('stone rings in the bass and wood does not', () => {
    const stone = SPACES.find((s) => s.id === 'hall-church')!;     // bassMult 1.35
    const wood = SPACES.find((s) => s.id === 'room-wood')!;        // bassMult 0.92
    assert(stone.bassMult > wood.bassMult, 'the catalogue says so');
    // Measured: the low band of the stone room should still be there when the
    // wooden one's has gone.  Compared at the same decay so it is the bass
    // multiplier being tested and not the room length.
    const scale = (space: Space): number => 2 / space.rt60Sec;
    const s = renderIr(stone, { sampleRate: SR, decayScale: scale(stone) });
    const w = renderIr(wood, { sampleRate: SR, decayScale: scale(wood) });
    const sBands = bandEnergy(s.left.subarray(Math.round(SR * 1.2)), SR, 250);
    const wBands = bandEnergy(w.left.subarray(Math.round(SR * 1.2)), SR, 250);
    const sShare = sBands.low / Math.max(1e-12, sBands.low + sBands.high);
    const wShare = wBands.low / Math.max(1e-12, wBands.low + wBands.high);
    assert(sShare > wShare, `late tail is bassier in stone (${sShare.toFixed(3)} vs ${wShare.toFixed(3)})`);
  });

  await check('a gated room stops, and a reverse one arrives backwards', () => {
    const gated = SPACES.find((s) => s.shape === 'gated')!;
    const reverse = SPACES.find((s) => s.shape === 'reverse')!;

    const g = renderIr(gated, { sampleRate: SR, holdMs: 200 });
    const hold = Math.round(SR * 0.2);
    let before = 0;
    let after = 0;
    for (let i = 0; i < g.frames; i++) {
      const v = g.left[i]! ** 2;
      if (i < hold) before += v; else after += v;
    }
    assert(after < before * 0.02, `the room is gone after the hold (${(after / before).toExponential(1)})`);

    const r = renderIr(reverse, { sampleRate: SR, holdMs: 600 });
    const third = Math.round(r.frames / 3);
    let head = 0;
    let tailEnd = 0;
    for (let i = 0; i < third; i++) head += r.left[i]! ** 2;
    for (let i = r.frames - third; i < r.frames; i++) tailEnd += r.left[i]! ** 2;
    assert(tailEnd > head * 4, `it swells rather than decays (${(tailEnd / head).toFixed(1)}×)`);
  });

  await check('the same room twice is the same samples', () => {
    // Math.random in an IR would make every bounce a different hall.
    const space = SPACES.find((s) => s.id === 'plate-vintage')!;
    const a = renderIr(space, { sampleRate: SR });
    const b = renderIr(space, { sampleRate: SR });
    assert(a.frames === b.frames, 'same length');
    for (let i = 0; i < a.frames; i += 97) {
      assert(a.left[i] === b.left[i] && a.right[i] === b.right[i], `sample ${i} identical`);
    }
  });

  await check('a room is synthesised once and then remembered', () => {
    clearIrCache();
    const ctx = new OfflineAudioContext(2, 128, SR) as unknown as BaseAudioContext;
    const space = SPACES.find((s) => s.id === 'hall-recital')!;
    const first = irBuffer(ctx, space, { sampleRate: SR });
    const again = irBuffer(ctx, space, { sampleRate: SR });
    assert(first === again, 'the identical request comes back from the cache');
    const nudged = irBuffer(ctx, space, { sampleRate: SR, decayScale: 1.5 });
    assert(nudged !== first, 'a different room is a different buffer');
    clearIrCache();
    assert(irBuffer(ctx, space, { sampleRate: SR }) !== first, 'and clearing really clears');
  });

  await check('the picture is drawn from the same numbers as the sound', () => {
    for (const id of ['hall-cathedral', 'spec-gated', 'spec-reverse', 'room-booth']) {
      const space = SPACES.find((s) => s.id === id)!;
      const display = irDisplay(space, { sampleRate: SR, holdMs: 300 });
      assert(display.envelope.length > 8, `${id} has an envelope`);
      assert(display.envelope.every((v) => Number.isFinite(v) && v >= 0), `${id} is finite and positive`);
      assert(Math.abs(display.lengthSec - irLengthSec(space, { sampleRate: SR, holdMs: 300 })) < 1e-9,
        `${id} draws the length the IR actually is`);
      assert(display.taps.length > 0, `${id} shows reflections`);
    }
    const gated = irDisplay(SPACES.find((s) => s.id === 'spec-gated')!, { sampleRate: SR, holdMs: 200 });
    assert(gated.envelope[gated.envelope.length - 1] === 0, 'a gated picture ends at zero, like the room');
    const peakAt = (values: number[]): number =>
      values.indexOf(Math.max(...values)) / (values.length - 1);
    const reverse = irDisplay(SPACES.find((s) => s.id === 'spec-reverse')!, { sampleRate: SR, holdMs: 500 });
    assert(peakAt(reverse.envelope) > 0.6, 'a reverse picture peaks near the end, not the start');
    const hall = irDisplay(SPACES.find((s) => s.id === 'hall-concert')!, { sampleRate: SR });
    assert(peakAt(hall.envelope) < 0.2, 'and an ordinary one peaks at the front');
  });

  // ── The devices ──────────────────────────────────────────────────────────

  await check('the reverb family is registered and distinct', () => {
    const ids = REVERB_PLUGINS.map((d) => d.id);
    assert(new Set(ids).size === ids.length, 'no duplicate ids');
    for (const device of REVERB_PLUGINS) {
      assert(PLUGINS.some((plugin) => plugin.id === device.id), `${device.id} is in the rack`);
      assert(device.category === 'reverb', `${device.id} is filed under reverb`);
      assert(device.params.length > 0, `${device.id} has controls`);
      for (const param of device.params) {
        assert(param.default >= param.min && param.default <= param.max,
          `${device.id}.${param.id} default is in range`);
        if (param.choices) {
          assert(param.choices.length === param.max - param.min + 1,
            `${device.id}.${param.id} has one choice per value`);
        }
      }
    }
    assert(PLUGINS.filter((plugin) => plugin.category === 'reverb').length >= 5,
      'the reverb shelf is no longer one device');
  });

  for (const id of ['reverb', 'spacereverb', 'plate', 'spring', 'shimmer']) {
    await check(`${id} renders finite audio with a tail`, async () => {
      const wet = await renderDevice(id, { mix: 1, mixPct: 100 });
      assert(wet.finite, 'no NaN or Infinity anywhere');
      assert(wet.peak > 0.0005, `it makes a sound (peak ${wet.peak.toFixed(5)})`);
      assert(wet.peak < 4, `and does not run away (peak ${wet.peak.toFixed(3)})`);
      const early = windowRms(wet.buffer, 0.05, 0.35);
      const late = windowRms(wet.buffer, 1.5, 2.0);
      assert(early > 0, 'something arrives');
      assert(late > 0, 'and it is still there a second and a half later');
      assert(late < early, 'decaying rather than building');
    });
  }

  for (const device of REVERB_PLUGINS) {
    await check(`${device.id} is unity when bypassed`, async () => {
      const ctx = new OfflineAudioContext(2, SR, SR) as unknown as BaseAudioContext & {
        destination: AudioNode; startRendering: () => Promise<AudioBuffer>;
      };
      const instance = device.create(ctx, defaultParams(device.id));
      instance.setBypass(true);
      const buffer = ctx.createBuffer(2, SR, SR);
      for (let c = 0; c < 2; c++) {
        const data = buffer.getChannelData(c);
        for (let i = 0; i < SR; i++) data[i] = Math.sin((2 * Math.PI * 300 * i) / SR) * 0.4;
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(instance.input);
      instance.output.connect(ctx.destination);
      source.start(0);
      const out = await ctx.startRendering();
      const level = windowRms(out, 0.2, 0.8);
      const expected = 0.4 / Math.SQRT2;          // RMS of a 0.4-amplitude sine
      const db = 20 * Math.log10(level / expected);
      assert(Math.abs(db) < 0.2, `bypass passes the signal through unchanged (${db.toFixed(2)} dB)`);
    });
  }

  await check('Space Reverb: a bigger hall really is a longer tail', async () => {
    const small = await renderDevice('spacereverb',
      { space: spaceIndex('room-booth'), mixPct: 100 }, 4);
    const big = await renderDevice('spacereverb',
      { space: spaceIndex('hall-cathedral'), mixPct: 100 }, 6);
    const smallLate = windowRms(small.buffer, 1.0, 1.5);
    const bigLate = windowRms(big.buffer, 1.0, 1.5);
    assert(bigLate > smallLate * 20,
      `the cathedral is still going when the booth is not (${(bigLate / smallLate).toFixed(0)}×)`);
  });

  await check('Space Reverb: early and tail are separate faders, not a tone knob', async () => {
    const erOnly = await renderDevice('spacereverb',
      { space: spaceIndex('live-house'), mixPct: 100, erDb: 0, tailDb: -24 }, 3);
    const tailOnly = await renderDevice('spacereverb',
      { space: spaceIndex('live-house'), mixPct: 100, erDb: -24, tailDb: 0 }, 3);
    // With the tail down, what is left is the reflection pattern: loud early,
    // gone later.  With the reflections down it is the other way round.
    const erShape = windowRms(erOnly.buffer, 0.02, 0.2) / Math.max(1e-9, windowRms(erOnly.buffer, 1.0, 1.4));
    const tailShape = windowRms(tailOnly.buffer, 0.02, 0.2) / Math.max(1e-9, windowRms(tailOnly.buffer, 1.0, 1.4));
    assert(erShape > tailShape * 2,
      `the two faders reach different parts of the room (${erShape.toFixed(1)} vs ${tailShape.toFixed(1)})`);
  });

  await check('Space Reverb: mix at zero is the dry signal and nothing else', async () => {
    const dry = await renderDevice('spacereverb', { mixPct: 0 }, 2);
    const late = windowRms(dry.buffer, 0.6, 1.8);
    assert(late < 1e-5, `no room leaks through at 0 % (${late.toExponential(1)})`);
  });

  await check('Plate: the decay control is a decay time, measured', async () => {
    // Not "longer sounds longer" — the number on the knob has to be the number
    // the tail actually decays in, or it is a vibe control with a unit on it.
    const bad: string[] = [];
    for (const seconds of [0.5, 2, 6, 12]) {
      const r = await renderDevice('plate', { decaySec: seconds, mixPct: 100 },
        Math.max(4, seconds * 1.4));
      assert(r.finite, `${seconds}s: a feedback network that does not blow up`);
      assert(r.peak < 4, `${seconds}s: nor scream (peak ${r.peak.toFixed(2)})`);
      const from = Math.round(SR * 0.02);
      const measured = rt60(
        r.buffer.getChannelData(0).slice(from), r.buffer.getChannelData(1).slice(from), SR);
      const error = Math.abs(measured - seconds) / seconds;
      if (!(error < 0.25)) bad.push(`${seconds}s → ${measured.toFixed(2)}s`);
    }
    assert(bad.length === 0, `within 25 % of the setting: ${bad.join(', ')}`);
  });

  await check('Plate: dense from the first millisecond — it has no walls', async () => {
    const short = await renderDevice('plate', { decaySec: 2, mixPct: 100 }, 3);
    // A room has a gap between the direct sound and its first reflection.  A
    // steel sheet does not, and the input diffusers are what make that true.
    const immediate = windowRms(short.buffer, 0.021, 0.045);
    const later = windowRms(short.buffer, 0.3, 0.5);
    assert(immediate > 0, `dense within twenty milliseconds (${immediate.toExponential(1)})`);
    assert(immediate > later, 'and loudest at the front');
  });

  await check('Spring: the allpass chain is counted in the decay time', async () => {
    // Eight allpasses add sixty-odd milliseconds to a thirty-two millisecond
    // line, and a feedback gain computed from the thirty-two alone makes every
    // setting about three times too long.  Measured, not assumed.
    const bad: string[] = [];
    for (const seconds of [0.5, 2, 6]) {
      const r = await renderDevice('spring', { decaySec: seconds, mixPct: 100 },
        Math.max(4, seconds * 1.5));
      const from = Math.round(SR * 0.02);
      const measured = rt60(
        r.buffer.getChannelData(0).slice(from), r.buffer.getChannelData(1).slice(from), SR);
      const error = Math.abs(measured - seconds) / seconds;
      if (!(error < 0.3)) bad.push(`${seconds}s → ${measured.toFixed(2)}s`);
    }
    assert(bad.length === 0, `within 30 % of the setting: ${bad.join(', ')}`);
  });

  await check('Spring: bandlimited and dispersive, the way a tank is', async () => {
    const r = await renderDevice('spring', { mixPct: 100 }, 3);
    assert(r.finite && r.peak > 0.0005, 'it rings');
    const bands = bandEnergy(r.buffer.getChannelData(0), SR, 250);
    const share = bands.low / Math.max(1e-12, bands.low + bands.high);
    assert(share < 0.5, `no bass in the tank (${(share * 100).toFixed(0)} % below 250 Hz)`);

    // Dispersion smears a click into a chirp.  The measurement is crest
    // factor: with the allpass chain off, the tank returns discrete echoes and
    // the peaks tower over the average; with it on, they are spread out.
    const crest = async (boing: number): Promise<number> => {
      const out = await renderDevice('spring', { mixPct: 100, boing }, 2);
      const data = out.buffer.getChannelData(0);
      let peak = 0;
      let sum = 0;
      let count = 0;
      for (let i = Math.round(SR * 0.02); i < Math.round(SR * 0.15); i++) {
        peak = Math.max(peak, Math.abs(data[i]!));
        sum += data[i]! ** 2;
        count++;
      }
      return peak / Math.sqrt(sum / count);
    };
    const none = await crest(0);
    const some = await crest(0.4);
    const lots = await crest(0.8);
    assert(none > some && some > lots,
      `more boing, more smear (${none.toFixed(1)} → ${some.toFixed(1)} → ${lots.toFixed(1)})`);
    assert(none > lots * 3, 'and the difference is not marginal');
  });

  await check('the pitch shifter really produces an octave', async () => {
    // The one claim in this family that cannot be argued from the code.  A
    // delay line whose delay shrinks at one second per second plays its input
    // twice as fast — so 440 Hz in, 880 Hz out, and nothing else.
    const frames = SR * 2;
    const ctx = new OfflineAudioContext(1, frames, SR) as unknown as BaseAudioContext & {
      destination: AudioNode; startRendering: () => Promise<AudioBuffer>;
    };
    const shifter = octaveUp(ctx);
    const buffer = ctx.createBuffer(1, frames, SR);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.sin((2 * Math.PI * 440 * i) / SR) * 0.5;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(shifter.input);
    shifter.output.connect(ctx.destination);
    source.start(0);
    const out = await ctx.startRendering();

    // The second half, so the delayed control signals are running.
    const seg = out.getChannelData(0).slice(SR);
    const octave = goertzel(seg, SR, 880);
    for (const other of [220, 440, 660, 1320, 1760]) {
      const level = goertzel(seg, SR, other);
      assert(octave > level * 20,
        `${other} Hz is not what came out (octave ${octave.toExponential(2)}, ${other} ${level.toExponential(2)})`);
    }

    // The two crossfade windows must sum to one at every sample, or the
    // shifter is also a tremolo.
    let peak = 0;
    for (const v of seg) peak = Math.max(peak, Math.abs(v));
    assert(Math.abs(peak - 0.5) < 0.02, `unity gain through the crossfade (peak ${peak.toFixed(3)})`);
  });

  await check('Shimmer: the control is what puts the octave there', async () => {
    // In the device the fundamental's own tail is still present — that is what
    // a shimmer sounds like.  What has to be true is that the octave rises
    // with the control, and rises a long way.
    const ratios: number[] = [];
    for (const amount of [0, 0.4, 0.8]) {
      const r = await renderDevice('shimmer',
        { mixPct: 100, shimmer: amount, loopMs: 60, lowCutHz: 60, highCutHz: 18000, decayPct: 60 },
        4, 'tone', 440);
      assert(r.finite, `shimmer ${amount} is finite`);
      assert(r.peak < 4, `shimmer ${amount} does not run away (peak ${r.peak.toFixed(2)})`);
      const tail = r.buffer.getChannelData(0).slice(Math.round(SR * 1.4), Math.round(SR * 2.6));
      ratios.push(goertzel(tail, SR, 880) / Math.max(1e-12, goertzel(tail, SR, 440)));
    }
    assert(ratios[1]! > ratios[0]! * 4,
      `turning it up puts an octave in the tail (${ratios[0]!.toExponential(1)} → ${ratios[1]!.toExponential(1)})`);
    assert(ratios[2]! > ratios[1]!,
      `and more of it puts in more (${ratios[1]!.toExponential(1)} → ${ratios[2]!.toExponential(1)})`);
  });

  await check('every reverb parameter is safe at both ends', async () => {
    // A device is only as trustworthy as its worst knob position, and nobody
    // auditions the extremes by hand.
    const bad: string[] = [];
    for (const device of REVERB_PLUGINS) {
      for (const param of device.params) {
        for (const value of [param.min, param.max]) {
          const r = await renderDevice(device.id, { [param.id]: value, mixPct: 100 }, 2);
          if (!r.finite) bad.push(`${device.id}.${param.id}=${value} produced NaN`);
          else if (r.peak > 8) bad.push(`${device.id}.${param.id}=${value} peaked ${r.peak.toFixed(1)}`);
        }
      }
    }
    assert(bad.length === 0, bad.join('; '));
  });

  // ── Presets ──────────────────────────────────────────────────────────────

  await check('every preset points at a device that exists', () => {
    const ids = new Set<string>();
    for (const preset of PLUGIN_PRESETS) {
      assert(!ids.has(preset.id), `${preset.id} appears once`);
      ids.add(preset.id);
      const device = findPlugin(preset.pluginId);
      assert(device !== undefined, `${preset.id} → ${preset.pluginId} exists`);
      assert(preset.name.length > 0 && preset.note.length > 0, `${preset.id} says what it is for`);
      assert(preset.group.length > 0, `${preset.id} is grouped`);
    }
  });

  await check('every preset sets parameters the device actually has, in range', () => {
    const bad: string[] = [];
    for (const preset of PLUGIN_PRESETS) {
      const device = findPlugin(preset.pluginId)!;
      for (const [id, value] of Object.entries(preset.params)) {
        const def = device.params.find((param) => param.id === id);
        if (!def) { bad.push(`${preset.id}: ${preset.pluginId} has no ${id}`); continue; }
        if (!(value >= def.min && value <= def.max)) {
          bad.push(`${preset.id}: ${id}=${value} outside ${def.min}…${def.max}`);
        }
      }
    }
    assert(bad.length === 0, bad.join('; '));
  });

  await check('loading a preset lands in the same place every time', () => {
    const preset = PLUGIN_PRESETS.find((entry) => entry.id === 'space-vox-lead')!;
    const resolved = resolvePreset(preset, defaultParams(preset.pluginId));
    const device = findPlugin(preset.pluginId)!;
    for (const param of device.params) {
      assert(typeof resolved[param.id] === 'number', `${param.id} is set`);
      const expected = preset.params[param.id] ?? param.default;
      assert(resolved[param.id] === expected, `${param.id} is the preset's value or the default`);
    }
    // Loading it a second time cannot drift: it is a pure merge.
    const again = resolvePreset(preset, defaultParams(preset.pluginId));
    assert(JSON.stringify(again) === JSON.stringify(resolved), 'idempotent');
  });

  await check('the reverb family is covered, and grouped by what it is for', () => {
    for (const id of ['spacereverb', 'plate', 'spring', 'shimmer', 'reverb']) {
      assert(presetsFor(id).length >= 3, `${id} has somewhere to start (${presetsFor(id).length})`);
    }
    const groups = presetGroups('spacereverb');
    assert(groups.length >= 5, `space presets span the sources (${groups.length} groups)`);
    const names = groups.map((g) => g.group);
    assert(new Set(names).size === names.length, 'each group appears once');
    for (const wanted of ['보컬', '드럼', '라이브']) {
      assert(names.includes(wanted), `${wanted} presets exist`);
    }
    const total = presetsFor('spacereverb').length;
    assert(groups.reduce((sum, g) => sum + g.presets.length, 0) === total, 'grouping loses nothing');
  });

  await check('presets render — every one of them', async () => {
    // A preset with a typo in it is a device that sounds broken the first time
    // anyone tries it, and there is no other way to find that out.
    const bad: string[] = [];
    for (const preset of PLUGIN_PRESETS) {
      const params = resolvePreset(preset, defaultParams(preset.pluginId));
      const r = await renderDevice(preset.pluginId, params, 2);
      if (!r.finite) bad.push(`${preset.id}: NaN`);
      else if (r.peak > 8) bad.push(`${preset.id}: peak ${r.peak.toFixed(1)}`);
      else if (r.rms < 1e-7) bad.push(`${preset.id}: silent`);
    }
    assert(bad.length === 0, bad.join('; '));
  });
}

function report(): void {
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log('\n=== Reverb — spaces, devices, presets ===');
  for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
  if (failed > 0) process.exit(1);
}

main().then(report, (err) => { console.error(err); process.exit(1); });
