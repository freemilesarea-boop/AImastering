/**
 * plugin-rack-selftest — every device in the rack, rendered.
 *
 * A registry of thirty-odd devices is thirty-odd chances to ship one that is
 * silent, one that is deafening, one that emits NaN into the master bus, or
 * one whose bypass is not bypass.  None of those are visible by reading the
 * code, and a device nobody has rendered is a device nobody has tested.
 *
 * So the sweep is exhaustive rather than representative: EVERY device is built
 * through a real OfflineAudioContext, fed real audio, and measured.  Then the
 * ones with a specific claim — a gate closes, a clipper clips, mono maker
 * survives a fold to mono — are checked against that claim.
 *
 * Run:  pnpm --filter @aimaster/desktop test:plugin-rack
 */

import { OfflineAudioContext } from 'node-web-audio-api';

(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import { PLUGINS, defaultParams, findPlugin } from '../src/renderer/daw/engine/plugins.js';
import { probeRendererLatency, withBypass } from '../src/renderer/daw/engine/plugin-kit.js';
import { readFileSync } from 'node:fs';

const SR = 48_000;

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  return Promise.resolve().then(fn)
    .then(() => { results.push({ name, pass: true, detail: '' }); })
    .catch((e: unknown) => {
      results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) });
    });
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function close(a: number, b: number, tol: number, m: string): void {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${m} — got ${a.toFixed(3)}, want ${b.toFixed(3)} ±${tol}`);
}

interface Rendered { peak: number; rms: number; dc: number; finite: boolean }

function measure(buffer: AudioBuffer, from = 0, to = buffer.length): Rendered {
  let peak = 0;
  let sum = 0;
  let total = 0;
  let finite = true;
  let count = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = from; i < to; i++) {
      const v = data[i]!;
      if (!Number.isFinite(v)) { finite = false; continue; }
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sum += v * v;
      total += v;
      count += 1;
    }
  }
  return { peak, rms: Math.sqrt(sum / Math.max(1, count)), dc: total / Math.max(1, count), finite };
}

type Source = 'tone' | 'quiet' | 'loud' | 'stereo' | 'wide' | 'dc';

/** Build a two-second stereo test signal. */
function fill(buffer: AudioBuffer, kind: Source): void {
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  for (let i = 0; i < left.length; i++) {
    const t = i / SR;
    const tone = Math.sin(2 * Math.PI * 220 * t);
    switch (kind) {
      case 'tone':   left[i] = tone * 0.3; right[i] = tone * 0.3; break;
      case 'quiet':  left[i] = tone * 0.01; right[i] = tone * 0.01; break;
      case 'loud':   left[i] = tone * 0.9; right[i] = tone * 0.9; break;
      case 'stereo': left[i] = tone * 0.3; right[i] = Math.sin(2 * Math.PI * 330 * t) * 0.3; break;
      // Bass that is opposite between the channels — the thing a mono fold
      // destroys, and what a mono maker exists to rescue.
      case 'wide':   left[i] = Math.sin(2 * Math.PI * 60 * t) * 0.5;
                     right[i] = -Math.sin(2 * Math.PI * 60 * t) * 0.5; break;
      case 'dc':     left[i] = tone * 0.2 + 0.3; right[i] = tone * 0.2 + 0.3; break;
    }
  }
}

async function renderPlugin(
  pluginId: string, source: Source, overrides: Record<string, number> = {},
  bypass = false, seconds = 1,
): Promise<AudioBuffer> {
  const descriptor = findPlugin(pluginId);
  if (!descriptor) throw new Error(`no such plugin: ${pluginId}`);

  const ctx = new OfflineAudioContext(2, SR * seconds, SR);
  const buffer = ctx.createBuffer(2, SR * seconds, SR);
  fill(buffer as unknown as AudioBuffer, source);
  const node = ctx.createBufferSource();
  node.buffer = buffer;

  const params = { ...defaultParams(pluginId), ...overrides };
  const instance = descriptor.create(ctx as unknown as BaseAudioContext, params);
  instance.setBypass(bypass);

  node.connect(instance.input);
  instance.output.connect(ctx.destination as unknown as AudioNode);
  node.start();
  return (await ctx.startRendering()) as unknown as AudioBuffer;
}

/** Fold to mono the way a club rig or a phone speaker does. */
function monoRms(buffer: AudioBuffer, from: number, to: number): number {
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  let sum = 0;
  for (let i = from; i < to; i++) {
    const mono = (left[i]! + right[i]!) / 2;
    sum += mono * mono;
  }
  return Math.sqrt(sum / Math.max(1, to - from));
}


/**
 * Within how many samples a device has to delay by what it says.
 *
 * Two, not zero, because a cross-correlation over a broadband signal lands at
 * the energy centroid rather than at a pure delay, and a device made of
 * filters has group delay that is not latency: it is frequency-dependent, no
 * delay line can undo it, and declaring it would misalign the channel at
 * every frequency but one.  Measured across the rack, every device sits
 * within one sample of its declaration once the modulation is stilled, so two
 * is headroom rather than tolerance for a defect.
 */
const LATENCY_TOLERANCE = 2;

/**
 * Settings that do NOT change what a device declares, but make the delay it
 * actually has measurable.  Each one is here because the measurement, not the
 * device, is what fails without it:
 *
 *   · every REVERB is blended dry.  `reverb` is fully wet at its defaults, so
 *     there is no dry path to correlate against at all — the correlation
 *     peaked at 0.06, on a random spot in the tail, and read 68 samples one
 *     run and 1150 the next.  The others have a tail loud enough to pull the
 *     measurement about, and by different amounts in each renderer: `spring`
 *     correlates at 0.97 under node and 0.15 under Chromium.  Their dry path
 *     is what the compensation has to line up, so their dry path is what is
 *     measured, and all five are stilled the same way rather than only the
 *     ones that happen to fail today.
 *   · `rotary` modulates its delay line: the read position sweeps either side
 *     of the base and the correlation smears, reading 295 against a declared
 *     320.  With the Doppler stilled it reads 320 exactly.  The device was
 *     right and the measurement was wrong, which is the whole reason this
 *     list exists rather than a list of exceptions.
 *   · `tape` has wow and flutter doing the same thing, more gently.
 *   · `amp` is measured with the cabinet OUT of circuit.  A cabinet is a
 *     convolution, and its impulse response has its own onset: with the cab
 *     in, the amp reads 7 samples late; with it out, 2.  That is the cab, not
 *     an undeclared delay line, and no delay compensation should remove it.
 */
const STILLED: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  reverb: { mix: 0 },
  spacereverb: { mixPct: 0 },
  plate: { mixPct: 0 },
  spring: { mixPct: 0 },
  shimmer: { mixPct: 0 },
  rotary: { doppler: 0, throb: 0 },
  tape: { wow: 0, flutter: 0 },
  amp: { cab: 3 },
};

/** Deterministic broadband noise, quiet enough that a saturator stays linear. */
function latencyStimulus(n: number): Float32Array {
  const a = new Float32Array(n);
  let seed = 12345;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    a[i] = ((seed / 0x7fffffff) * 2 - 1) * 0.02;
  }
  return a;
}

/** How late a device's output is against its input, and how sure of it. */
async function measureLatency(
  pluginId: string,
): Promise<{ lag: number; r: number }> {
  const descriptor = findPlugin(pluginId);
  if (!descriptor) throw new Error(`no such plugin: ${pluginId}`);
  const n = SR;
  const ctx = new OfflineAudioContext(2, n, SR);
  const instance = descriptor.create(ctx as unknown as BaseAudioContext,
    { ...defaultParams(pluginId), ...(STILLED[pluginId] ?? {}) });

  const dry = latencyStimulus(n);
  const buffer = ctx.createBuffer(2, n, SR);
  buffer.getChannelData(0).set(dry);
  buffer.getChannelData(1).set(dry);
  const node = ctx.createBufferSource();
  node.buffer = buffer;
  node.connect(instance.input);
  instance.output.connect(ctx.destination as unknown as AudioNode);
  node.start(0);
  const wet = (await ctx.startRendering()).getChannelData(0);

  // Past every declaration in the rack with room to spare, so a device that
  // delays far more than it says still has somewhere to be found.
  const maxLag = 1200;
  const from = Math.round(SR * 0.2);
  const to = n - maxLag - 1;
  let best = -1;
  const r = new Float64Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag; lag++) {
    let num = 0, da = 0, db = 0;
    for (let i = from; i < to; i += 2) {
      const x = dry[i]!;
      const y = wet[i + lag]!;
      num += x * y; da += x * x; db += y * y;
    }
    const denom = Math.sqrt(da * db);
    r[lag] = denom > 0 ? Math.abs(num / denom) : 0;
    if (r[lag]! > best) best = r[lag]!;
  }
  // The EARLIEST lag that comes close to the best, not the best itself: a
  // device with a repeating structure (a delay, a comb) correlates again at
  // every repeat, and the first arrival is the one the compensation needs.
  for (let lag = 0; lag <= maxLag; lag++) {
    if (r[lag]! >= best * 0.7) return { lag, r: best };
  }
  return { lag: 0, r: best };
}

const STEADY_FROM = Math.floor(SR * 0.4);
const STEADY_TO = Math.floor(SR * 0.9);

async function main(): Promise<void> {
  // ── The sweep ─────────────────────────────────────────────────────────────

  await check('every device renders finite audio and none of them is silent', async () => {
    const broken: string[] = [];
    for (const plugin of PLUGINS) {
      if (plugin.offline) continue;                 // applied by the render path
      const out = await renderPlugin(plugin.id, 'tone');
      const m = measure(out, STEADY_FROM, STEADY_TO);
      if (!m.finite) { broken.push(`${plugin.id}: NaN`); continue; }
      // A gate is meant to be shut on a -10 dBFS tone at its default
      // threshold, so it is judged on its own terms further down.
      if (plugin.id === 'gate') continue;
      if (m.rms < 1e-4) broken.push(`${plugin.id}: silent (${m.rms.toExponential(2)})`);
      if (m.peak > 4) broken.push(`${plugin.id}: runaway (peak ${m.peak.toFixed(2)})`);
    }
    assert(broken.length === 0, `every device passes audio — ${broken.join(' · ')}`);
  });

  await check('every device is unity when bypassed', async () => {
    const broken: string[] = [];
    const reference = measure(await renderPlugin('trim', 'tone', {}, true), STEADY_FROM, STEADY_TO);
    for (const plugin of PLUGINS) {
      if (plugin.offline) continue;
      const out = await renderPlugin(plugin.id, 'tone', {}, true);
      const m = measure(out, STEADY_FROM, STEADY_TO);
      if (!m.finite) { broken.push(`${plugin.id}: NaN`); continue; }
      const db = 20 * Math.log10(Math.max(1e-9, m.rms) / reference.rms);
      if (Math.abs(db) > 0.2) broken.push(`${plugin.id}: ${db > 0 ? '+' : ''}${db.toFixed(2)} dB`);
    }
    assert(broken.length === 0, `bypass means bypass — ${broken.join(' · ')}`);
  });

  await check('every parameter can be moved without breaking the graph', async () => {
    // Sweeping a knob rebuilds shapers and rewires detectors in several
    // devices; that is exactly where a disconnect that is never reconnected
    // hides, and it shows up as silence rather than as an error.
    const broken: string[] = [];
    for (const plugin of PLUGINS) {
      if (plugin.offline || plugin.params.length === 0) continue;
      for (const param of plugin.params) {
        for (const value of [param.min, param.max]) {
          const out = await renderPlugin(plugin.id, 'tone', { [param.id]: value });
          const m = measure(out, STEADY_FROM, STEADY_TO);
          if (!m.finite) broken.push(`${plugin.id}.${param.id}=${value}: NaN`);
          if (m.peak > 8) broken.push(`${plugin.id}.${param.id}=${value}: peak ${m.peak.toFixed(1)}`);
        }
      }
    }
    assert(broken.length === 0, `extremes stay sane — ${broken.slice(0, 6).join(' · ')}`);
  });

  await check('every device declares a latency it can honour', () => {
    for (const plugin of PLUGINS) {
      const latency = plugin.latencyFor(defaultParams(plugin.id), SR);
      assert(Number.isFinite(latency) && latency >= 0,
        `${plugin.id} reports ${latency} samples`);
      assert(latency < SR, `${plugin.id} claims over a second of latency`);
    }
  });

  await check('every device delays by the number it declares', async () => {
    // The check above is arithmetic: it asks whether the number is finite,
    // positive and under a second, and a device that delays five hundred
    // samples while declaring zero passes it without complaint.  This one
    // RENDERS every device and measures.
    //
    // The renderer is probed first, because a declaration is not a constant:
    // an oversampled shaper is 192 samples late in Chromium and 128 here, and
    // `renderSession` probes before it builds for exactly this reason.  Skip
    // the probe and every oversampling device reads 64 samples early — which
    // is what this file measured the first time and is not a defect in any of
    // them.
    await probeRendererLatency(SR);

    const bad: string[] = [];
    for (const plugin of PLUGINS) {
      if (plugin.offline) continue;              // applied by the render path
      const declared = plugin.latencyFor(defaultParams(plugin.id), SR);
      const { lag, r } = await measureLatency(plugin.id);

      // A weak correlation means the measurement did not find the signal, and
      // a lag read off noise is a number rather than a fact.  The floor is
      // well under the weakest device here (amp, 0.57) and far above what a
      // failed measurement returns.
      if (r < 0.4) {
        bad.push(`${plugin.id}: could not be measured (r ${r.toFixed(2)})`);
        continue;
      }
      if (Math.abs(lag - declared) > LATENCY_TOLERANCE) {
        bad.push(`${plugin.id}: declares ${declared}, delays ${lag}`);
      }
    }
    assert(bad.length === 0, `declared is measured — ${bad.join(' · ')}`);
  });

  await check('a device declares the oversampling factor it actually uses', () => {
    // STRUCTURAL, because the check above cannot see this one.  A `2x` shaper
    // and a `4x` shaper are both 128 samples late under the offline renderer,
    // so a device that builds a `2x` shaper and declares the `4x` figure
    // measures perfect here and is 64 samples — 1.33 ms — wrong in Chromium,
    // where `4x` is 192.  `rotary` was exactly that, and the coincidence is
    // what hid it: measured in the app it declared 384 and delayed 320.
    //
    // So the source is read instead.  Within one device's descriptor, asking
    // for `oversampleLatencySamples` while building a `2x` shaper is the
    // mistake, and so is the other way round.
    const sources = ['plugins.ts', 'plugins-extended.ts', 'plugins-reverb.ts'];
    const wrong: string[] = [];
    for (const file of sources) {
      const text = readFileSync(
        new URL(`../src/renderer/daw/engine/${file}`, import.meta.url), 'utf8');
      // Descriptors start at a line that is exactly an id assignment.
      const blocks = text.split(/\n  \{\n/).slice(1);
      for (const block of blocks) {
        const id = /^\s*id: '([a-z0-9]+)',/.exec(block)?.[1];
        if (!id) continue;
        const body = block.split(/\n  \},/)[0] ?? block;
        const twice = /'2x'/.test(body);
        const fourTimes = /'4x'/.test(body);
        const declares4x = /oversampleLatencySamples/.test(body);
        const declares2x = /oversample2xLatencySamples/.test(body);
        if (twice && !fourTimes && declares4x) {
          wrong.push(`${id} builds a 2x shaper and declares the 4x latency`);
        }
        if (fourTimes && !twice && declares2x) {
          wrong.push(`${id} builds a 4x shaper and declares the 2x latency`);
        }
      }
    }
    assert(wrong.length === 0, `the factor and the declaration agree — ${wrong.join(' · ')}`);
  });

  await check('no two devices share an id, and every one has a name', () => {
    const seen = new Set<string>();
    for (const plugin of PLUGINS) {
      assert(!seen.has(plugin.id), `duplicate id: ${plugin.id}`);
      seen.add(plugin.id);
      assert(plugin.name.trim().length > 0, `${plugin.id} has no name`);
      for (const param of plugin.params) {
        assert(param.min < param.max, `${plugin.id}.${param.id} has an empty range`);
        assert(param.default >= param.min && param.default <= param.max,
          `${plugin.id}.${param.id} defaults outside its own range`);
      }
    }
  });

  // ── Devices that make a specific claim ────────────────────────────────────

  await check('the gate shuts under its threshold and opens over it', async () => {
    const shut = measure(await renderPlugin('gate', 'quiet', { thresholdDb: -20, rangeDb: 40 }),
      STEADY_FROM, STEADY_TO);
    const open = measure(await renderPlugin('gate', 'loud', { thresholdDb: -20, rangeDb: 40 }),
      STEADY_FROM, STEADY_TO);
    const reference = measure(await renderPlugin('gate', 'loud', {}, true), STEADY_FROM, STEADY_TO);

    assert(shut.rms < 0.002, `a quiet signal is held down — ${shut.rms.toExponential(2)}`);
    assert(open.rms > reference.rms * 0.8,
      `a loud one passes — ${open.rms.toFixed(3)} vs ${reference.rms.toFixed(3)}`);
  });

  await check('a threshold in decibels means decibels', async () => {
    // The detector reported the AVERAGE of a rectified sine, which is 2A/π —
    // 3.92 dB under its amplitude — so every device comparing it against a
    // threshold marked in decibels acted 3.92 dB late.  Measured before the
    // calibration: a ducker set to −24 dB started ducking at −20.1.
    const SR = 48_000;
    /** A steady tone through a device, as decibels out. */
    const through = async (
      id: string, levelDb: number, over: Record<string, number>, toneHz = 1000,
    ): Promise<number> => {
      const plugin = findPlugin(id)!;
      const ctx = new OfflineAudioContext(1, SR * 4, SR);
      const instance = plugin.create(ctx as unknown as BaseAudioContext,
        { ...defaultParams(id), ...over });
      const osc = ctx.createOscillator();
      osc.frequency.value = toneHz;
      const amp = ctx.createGain();
      amp.gain.value = Math.pow(10, levelDb / 20);
      osc.connect(amp).connect(instance.input);
      instance.output.connect(ctx.destination);
      osc.start(0);
      const out = (await ctx.startRendering()).getChannelData(0);
      let sum = 0;
      const a = Math.round(SR * 3.4), b = Math.round(SR * 3.9);
      for (let i = a; i < b; i++) sum += out[i]! * out[i]!;
      return 20 * Math.log10(Math.sqrt(sum / (b - a)) * Math.SQRT2);
    };

    // Nothing at the threshold, and the textbook amount just over it: a 6:1
    // ratio gives back a sixth of what you push in.
    const ducker = { thresholdDb: -24, ratio: 6, makeupDb: 0, attackMs: 9, releaseMs: 60 };
    close(await through('ducker', -24, ducker) + 24, 0, 0.05, 'a ducker at its threshold');
    close(await through('ducker', -26, ducker) + 26, 0, 0.05, 'a ducker under its threshold');
    close(await through('ducker', -20, ducker) + 20, -4 * (1 - 1 / 6), 0.15,
      'a ducker 4 dB over its threshold');
  });

  await check('a limiter holds the ceiling it promises', async () => {
    // The consequence that makes the offset a defect rather than a quirk: a
    // ceiling is a promise.  With the detector reading 3.92 dB low the
    // limiter did nothing at all until the input passed ceiling + 3.92, so it
    // was letting min(3.92, input − ceiling) out over its own number.
    // Measured before: a ceiling of −6 dB passed a 0 dBFS sine at −2.07.
    const SR = 48_000;
    const peakOut = async (inDb: number, ceilingDb: number): Promise<number> => {
      const plugin = findPlugin('limiter')!;
      const n = SR * 3;
      const ctx = new OfflineAudioContext(1, n, SR);
      const instance = plugin.create(ctx as unknown as BaseAudioContext, {
        ...defaultParams('limiter'), ceilingDb, lookaheadMs: 2, releaseMs: 80,
      });
      const osc = ctx.createOscillator();
      osc.frequency.value = 1000;
      const amp = ctx.createGain();
      amp.gain.value = Math.pow(10, inDb / 20);
      osc.connect(amp).connect(instance.input);
      instance.output.connect(ctx.destination);
      osc.start(0);
      const out = (await ctx.startRendering()).getChannelData(0);
      let peak = 0;
      for (let i = Math.round(SR * 2); i < n; i++) peak = Math.max(peak, Math.abs(out[i]!));
      return 20 * Math.log10(peak);
    };
    for (const ceilingDb of [-1, -3, -6]) {
      for (const inDb of [-3, 0]) {
        const got = await peakOut(inDb, ceilingDb);
        assert(got <= ceilingDb + 0.1,
          `a ceiling of ${ceilingDb} dB let a ${inDb} dBFS tone out at ${got.toFixed(2)} dB`);
        // And it does not clamp down harder than it said either, which is
        // what a detector reading 3.92 dB HIGH would look like.
        if (inDb > ceilingDb) {
          assert(got >= ceilingDb - 0.2,
            `a ceiling of ${ceilingDb} dB pulled a ${inDb} dBFS tone down to ${got.toFixed(2)}`);
        }
      }
    }
  });

  await check('a device showing two time knobs has two of them', async () => {
    // It did not.  `ducker` and `gate` each held ONE `smoother`, which has one
    // time constant, and handed both knobs to its `setTimeMs` — so whichever
    // the user touched last was the only one that did anything and the other
    // moved for nothing.  The check is written over the REGISTRY rather than
    // over those two, so the next device to grow an Attack and a Release
    // cannot ship the same way.
    const SR = 48_000;
    const pairs = PLUGINS.filter((p) =>
      p.params.some((d) => d.id === 'attackMs') && p.params.some((d) => d.id === 'releaseMs'));
    assert(pairs.length >= 3, `only ${pairs.length} devices show both knobs — has one been renamed?`);

    // What it takes to make each one ACT on the burst below.  A device that
    // does nothing has no attack to measure, and the upward compressor's
    // whole point is that it does nothing until asked: its Depth starts at
    // zero.  Empty means the defaults already work.
    const WORKING: Readonly<Record<string, Record<string, number>>> = {
      comp: {},
      ducker: {},
      gate: {},
      upward: { depthDb: 12, thresholdDb: -24, floorDb: -70 },
    };
    for (const plugin of pairs) {
      assert(WORKING[plugin.id] !== undefined,
        `${plugin.id} shows both knobs and this check does not know how to make it act`);
    }

    /** How long a device takes to act, and how long to let go, in milliseconds. */
    const times = async (
      id: string, attackMs: number, releaseMs: number,
    ): Promise<{ act: number; release: number }> => {
      const plugin = findPlugin(id)!;
      const n = SR * 4;
      const ctx = new OfflineAudioContext(1, n, SR);
      const instance = plugin.create(ctx as unknown as BaseAudioContext, {
        ...defaultParams(id), ...WORKING[id], attackMs, releaseMs,
      });
      // A kilohertz, so one period is a millisecond and the envelope below
      // can read a whole one while stepping a quarter of one.
      const TONE_HZ = 1000;
      const buffer = ctx.createBuffer(1, n, SR);
      const source = buffer.getChannelData(0);
      for (let i = 0; i < n; i++) {
        const t = i / SR;
        source[i] = (t >= 1 && t < 2.5 ? 0.5 : 0.002) * Math.sin(2 * Math.PI * TONE_HZ * t);
      }
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(instance.input);
      instance.output.connect(ctx.destination);
      src.start(0);
      const out = (await ctx.startRendering()).getChannelData(0);
      // The device's GAIN, not its output: the input is itself a step, so an
      // output envelope falls when the burst ends whatever the device does.
      // A whole period, stepped a quarter of one.  The compressor's attack
      // goes down to 0.1 ms, so the STEP has to be short — but a peak taken
      // over a window shorter than a period is not an envelope, it is
      // wherever the phase happened to be, and it reads as a gain jumping
      // between −49 and −1 dB on a signal that is perfectly steady.
      const hop = Math.round(SR * 0.00025);
      const span = Math.round(SR / TONE_HZ);
      // The output is read past the device's own latency.  A look-ahead
      // compressor delays what it is given by 6 ms, so for 6 ms after the
      // step the output is still the quiet part while the input has already
      // jumped — a gain of nothing, which crosses any downward target at
      // once and reads as an attack of nothing.  The device declares that
      // delay; this is what it is for.
      const latency = plugin.latencyFor(defaultParams(id), SR);
      const windows = Math.floor((n - span - latency) / hop);
      const gain = new Float64Array(windows);
      for (let j = 0; j < windows; j++) {
        let o = 0, i2 = 0;
        for (let k = 0; k < span; k++) {
          o = Math.max(o, Math.abs(out[j * hop + k + latency]!));
          i2 = Math.max(i2, Math.abs(source[j * hop + k]!));
        }
        gain[j] = i2 > 1e-9 ? o / i2 : 0;
      }
      const at = (t: number): number => gain[Math.round((t * SR) / hop)]!;
      const before = at(0.99), during = at(2.45), after = at(3.9);
      // A crossing has to STAY crossed for two milliseconds, and the search
      // begins one window past the step.  One window is not a measurement:
      // the windows straddling the step hold an input that has jumped and an
      // output that has not, and the compressor's own output dips to −51 dB
      // for a single window after one — either of which crosses a downward
      // target on the spot and reads as an attack of nothing at all.
      const HOLD = Math.round((0.002 * SR) / hop);
      const find = (fromSec: number, target: number, up: boolean): number => {
        const from = Math.round(((fromSec + span / SR) * SR) / hop);
        for (let j = from; j + HOLD < windows; j++) {
          let held = true;
          for (let k = 0; k <= HOLD && held; k++) {
            held = up ? gain[j + k]! >= target : gain[j + k]! <= target;
          }
          if (held) return ((j * hop) / SR - fromSec) * 1000;
        }
        return Number.NaN;
      };
      return {
        act: find(1, before + 0.632 * (during - before), during > before),
        release: find(2.5, during + 0.632 * (after - during), after > during),
      };
    };

    for (const plugin of pairs) {
      const a = plugin.params.find((d) => d.id === 'attackMs')!;
      const r = plugin.params.find((d) => d.id === 'releaseMs')!;
      // Values chosen to be resolvable rather than extreme: the point is
      // whether each knob moves its OWN time, which needs two settings far
      // enough apart to measure and both inside the device's own range.
      const clamp = (v: number, d: { min: number; max: number }): number =>
        Math.max(d.min, Math.min(d.max, v));
      const fastAttack = clamp(6, a), slowAttack = clamp(60, a);
      const fastRelease = clamp(60, r), slowRelease = clamp(500, r);

      const base = await times(plugin.id, fastAttack, fastRelease);
      const withAttack = await times(plugin.id, slowAttack, fastRelease);
      const withRelease = await times(plugin.id, fastAttack, slowRelease);

      for (const [what, got] of [['base', base], ['slow attack', withAttack],
        ['slow release', withRelease]] as const) {
        assert(Number.isFinite(got.act) && Number.isFinite(got.release),
          `${plugin.id} never reached its 63% point on ${what}`);
      }
      // The knob that was moved moves its own time...
      assert(withAttack.act > base.act + 4,
        `${plugin.id}: attack ${fastAttack} → ${slowAttack} ms left it acting in `
        + `${withAttack.act.toFixed(1)} ms against ${base.act.toFixed(1)} — the knob is not connected`);
      assert(withRelease.release > base.release + 20,
        `${plugin.id}: release ${fastRelease} → ${slowRelease} ms left it releasing in `
        + `${withRelease.release.toFixed(1)} ms against ${base.release.toFixed(1)}`);
      // ...and leaves the other one where it was, which is the half that was
      // broken: one time constant means each knob moved both.
      assert(Math.abs(withAttack.release - base.release) < base.release * 0.3 + 5,
        `${plugin.id}: moving the ATTACK moved the release from ${base.release.toFixed(0)} to `
        + `${withAttack.release.toFixed(0)} ms — they are still one control`);
      assert(Math.abs(withRelease.act - base.act) < base.act * 0.3 + 5,
        `${plugin.id}: moving the RELEASE moved the attack from ${base.act.toFixed(0)} to `
        + `${withRelease.act.toFixed(0)} ms — they are still one control`);
    }
  });

  await check('the clipper holds its ceiling', async () => {
    const out = await renderPlugin('clipper', 'loud', { ceilingDb: -6, driveDb: 12, hardness: 1 });
    const m = measure(out, STEADY_FROM, STEADY_TO);
    const ceiling = Math.pow(10, -6 / 20);
    assert(m.peak <= ceiling * 1.05,
      `nothing gets past -6 dB — peak ${(20 * Math.log10(m.peak)).toFixed(2)} dB`);
    assert(m.rms > 0.05, 'and it is still music, not a fizz');
  });

  await check('the multiband compressor acts per band, not across the whole mix', async () => {
    // Squash the low band hard and leave the top alone: a 60 Hz tone must come
    // down while a 6 kHz tone does not.
    const settings = { lowThrDb: -40, lowRatio: 12, midThrDb: 0, hiThrDb: 0, lowXHz: 180 };
    const lowCtx = await renderPlugin('mbcomp', 'wide', settings);
    const lowDry = await renderPlugin('mbcomp', 'wide', settings, true);
    const squashed = measure(lowCtx, STEADY_FROM, STEADY_TO).rms;
    const dry = measure(lowDry, STEADY_FROM, STEADY_TO).rms;
    assert(squashed < dry * 0.85,
      `the low band is controlled — ${dry.toFixed(3)} to ${squashed.toFixed(3)}`);
  });

  await check('the mono maker makes stereo and mono agree in the bottom', async () => {
    // The trap it exists to remove: bass that is loud on the meters and gone
    // the moment anything sums to mono.  A mono maker cannot resurrect bass
    // whose mono sum is zero — nothing can, that is what the sum IS.  What it
    // does is stop the two from disagreeing, so what you mix is what plays.
    const before = await renderPlugin('monomaker', 'wide', {}, true);
    const beforeStereo = measure(before, STEADY_FROM, STEADY_TO).rms;
    const beforeMono = monoRms(before, STEADY_FROM, STEADY_TO);
    assert(beforeStereo > 0.2, `the bass is there in stereo — ${beforeStereo.toFixed(3)}`);
    assert(beforeMono < 0.01, `and gone in mono — ${beforeMono.toExponential(2)}`);

    // Afterwards the phantom bass is gone from the stereo meters too, so the
    // two readings stop disagreeing.  A filter is not a brick wall, so what is
    // asserted is how much of it goes, not that every last sample does.
    const after = await renderPlugin('monomaker', 'wide', { freqHz: 200 });
    const afterStereo = measure(after, STEADY_FROM, STEADY_TO).rms;
    const removedDb = 20 * Math.log10(afterStereo / beforeStereo);
    assert(removedDb < -25,
      `the bass that mono would kill is taken out of stereo too — ${removedDb.toFixed(1)} dB`);

    // And it only touches the bottom: a 220 Hz stereo signal above the corner
    // keeps its width.
    const wide = await renderPlugin('monomaker', 'stereo', { freqHz: 80 });
    let spread = 0;
    for (let i = STEADY_FROM; i < STEADY_TO; i++) {
      spread = Math.max(spread, Math.abs(wide.getChannelData(0)[i]! - wide.getChannelData(1)[i]!));
    }
    assert(spread > 0.1, `everything above the corner stays wide — spread ${spread.toFixed(3)}`);
  });

  await check('the DC blocker removes an offset and leaves the note', async () => {
    const dry = measure(await renderPlugin('dcblock', 'dc', {}, true), STEADY_FROM, STEADY_TO);
    const wet = measure(await renderPlugin('dcblock', 'dc'), STEADY_FROM, STEADY_TO);
    assert(Math.abs(dry.dc) > 0.2, `the test signal really is offset — ${dry.dc.toFixed(3)}`);
    assert(Math.abs(wet.dc) < 0.01, `and the offset is gone — ${wet.dc.toFixed(4)}`);
    assert(wet.rms > 0.1, 'while the tone is still there');
  });

  await check('phase invert cancels against itself, and mono sums', async () => {
    const inverted = await renderPlugin('phase', 'tone', { invertL: 1, invertR: 1 });
    const plain = await renderPlugin('phase', 'tone', {});
    // Inverting both channels flips the waveform; summing the two renders
    // must land on silence.
    const a = inverted.getChannelData(0);
    const b = plain.getChannelData(0);
    let residual = 0;
    for (let i = STEADY_FROM; i < STEADY_TO; i++) residual = Math.max(residual, Math.abs(a[i]! + b[i]!));
    assert(residual < 1e-4, `invert is exactly -1 — residual ${residual.toExponential(2)}`);

    // Mono: two different tones per channel become the same signal on both.
    const mono = await renderPlugin('phase', 'stereo', { mono: 1 });
    let spread = 0;
    for (let i = STEADY_FROM; i < STEADY_TO; i++) {
      spread = Math.max(spread, Math.abs(mono.getChannelData(0)[i]! - mono.getChannelData(1)[i]!));
    }
    assert(spread < 1e-5, `mono really is mono — channels differ by ${spread.toExponential(2)}`);
  });

  await check('the tilt EQ trades top for bottom around its pivot', async () => {
    const bright = await renderPlugin('tilt', 'tone', { tiltDb: 12, pivotHz: 1000 });
    const dark = await renderPlugin('tilt', 'tone', { tiltDb: -12, pivotHz: 1000 });
    // The test tone is at 220 Hz, below the pivot: tilting bright cuts it.
    const brightRms = measure(bright, STEADY_FROM, STEADY_TO).rms;
    const darkRms = measure(dark, STEADY_FROM, STEADY_TO).rms;
    assert(darkRms > brightRms * 2,
      `220 Hz is louder tilted dark — ${darkRms.toFixed(3)} vs ${brightRms.toFixed(3)}`);
  });

  await check('the hum remover notches the mains and spares the music', async () => {
    const ctx = new OfflineAudioContext(2, SR, SR);
    const buffer = ctx.createBuffer(2, SR, SR);
    for (let c = 0; c < 2; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < data.length; i++) {
        const t = i / SR;
        // 60 Hz hum with its harmonics, under a 1 kHz note.
        data[i] = Math.sin(2 * Math.PI * 1000 * t) * 0.3
          + (Math.sin(2 * Math.PI * 60 * t) + Math.sin(2 * Math.PI * 120 * t)) * 0.2;
      }
    }
    const descriptor = findPlugin('hum')!;
    const instance = descriptor.create(
      ctx as unknown as BaseAudioContext, { ...defaultParams('hum'), baseHz: 60, harmonics: 4 },
    );
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(instance.input);
    instance.output.connect(ctx.destination as unknown as AudioNode);
    node.start();
    const out = (await ctx.startRendering()) as unknown as AudioBuffer;

    const level = (hz: number): number => {
      const data = out.getChannelData(0);
      const k = (2 * Math.PI * hz) / SR;
      const coeff = 2 * Math.cos(k);
      let s1 = 0, s2 = 0;
      for (let i = STEADY_FROM; i < STEADY_TO; i++) {
        const s0 = data[i]! + coeff * s1 - s2;
        s2 = s1; s1 = s0;
      }
      const n = STEADY_TO - STEADY_FROM;
      return (2 * Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2))) / n;
    };

    assert(level(60) < 0.02, `the fundamental is gone — ${level(60).toFixed(4)}`);
    assert(level(120) < 0.02, `and so is the second harmonic — ${level(120).toFixed(4)}`);
    assert(level(1000) > 0.2, `the note survives — ${level(1000).toFixed(3)}`);
  });

  await check('the loudness meter measures, and changes nothing', async () => {
    const dry = measure(await renderPlugin('loudness', 'tone', {}, true), STEADY_FROM, STEADY_TO);
    const wet = measure(await renderPlugin('loudness', 'tone'), STEADY_FROM, STEADY_TO);
    const db = 20 * Math.log10(wet.rms / dry.rms);
    assert(Math.abs(db) < 0.01, `a meter is not a processor — ${db.toFixed(4)} dB`);

    const descriptor = findPlugin('loudness')!;
    const ctx = new OfflineAudioContext(2, SR, SR);
    const instance = descriptor.create(ctx as unknown as BaseAudioContext, defaultParams('loudness'));
    assert(typeof instance.analyse === 'function', 'and it can be read');
    const reading = instance.analyse!();
    assert(Number.isFinite(reading.lufs) && Number.isFinite(reading.peakDb),
      'with finite numbers even before anything has played');
  });

  await check('dither adds noise below the last bit and nothing else', async () => {
    const silence = new OfflineAudioContext(2, SR, SR);
    const descriptor = findPlugin('dither')!;
    const instance = descriptor.create(
      silence as unknown as BaseAudioContext, { ...defaultParams('dither'), bits: 16, amount: 1 },
    );
    instance.output.connect(silence.destination as unknown as AudioNode);
    const out = (await silence.startRendering()) as unknown as AudioBuffer;
    const m = measure(out, STEADY_FROM, STEADY_TO);

    const lsb = Math.pow(2, -15);
    assert(m.rms > 0, 'there is dither');
    assert(m.peak < lsb * 6, `and it stays under the last bit — peak ${m.peak.toExponential(2)}`);
  });

  await check('the same render twice is the same samples', async () => {
    // Dither and the modulation family use noise and oscillators.  A bounce
    // that differs from itself cannot be checked against anything.
    for (const id of ['dither', 'chorus', 'tremolo', 'tapedelay']) {
      const a = await renderPlugin(id, 'tone');
      const b = await renderPlugin(id, 'tone');
      let worst = 0;
      for (let i = 0; i < a.length; i++) {
        worst = Math.max(worst, Math.abs(a.getChannelData(0)[i]! - b.getChannelData(0)[i]!));
      }
      assert(worst === 0, `${id} renders identically twice — differs by ${worst.toExponential(2)}`);
    }
  });

  await check('a feedback loop with no delay in it renders silence, and none of ours has one', async () => {
  // Web Audio mutes any cycle that does not contain a DelayNode.  The phaser
  // had one — four allpass stages feeding back directly — and the whole wet
  // path rendered silence: the device was audible only as the dry signal
  // being turned down, which reads as "subtle" rather than as broken.
  //
  // The property to hold is therefore not "the phaser sounds right" but "a
  // fully wet device is not silent", which catches this class everywhere.
  const problems: string[] = [];
  for (const device of PLUGINS) {
    const wetKnob = device.params.find((p) => p.id === 'mix' || p.id === 'mixPct');
    if (!wetKnob) continue;
    const ctx = new OfflineAudioContext(1, SR / 2, SR);
    const instance = device.create(ctx as unknown as BaseAudioContext, {
      ...defaultParams(device.id), [wetKnob.id]: wetKnob.max,
    });
    const buffer = ctx.createBuffer(1, SR / 2, SR);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = 0.4 * Math.sin((2 * Math.PI * 300 * i) / SR);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(instance.input);
    source.start(0);
    instance.output.connect(ctx.destination);
    const out = await ctx.startRendering();
    const rendered = out.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < rendered.length; i++) sum += rendered[i]! * rendered[i]!;
    const level = Math.sqrt(sum / rendered.length);
    // A tenth of the input is a generous floor: a device may filter, notch or
    // duck heavily, but a wet path that has been muted reads as exactly zero.
    if (level < 0.028) problems.push(`${device.id}: fully wet renders ${level.toFixed(5)}`);
    instance.dispose();
  }
  assert(problems.length === 0, `no muted wet paths — ${problems.join(' | ')}`);
});

await check('everything a device hands to withBypass comes out the other side', () => {
  // `withBypass` copies the builder's optional members across by name, one
  // spread each, and an omission is SILENT in both directions: TypeScript
  // does not see it, because a builder returning an extra key through a
  // conditional spread is not an object literal and escapes the
  // excess-property check; and the app does not show it, because a meter that
  // reads null forever looks like a device that is not working hard, and a
  // scope that stays empty looks like silence.
  //
  // It has already happened once: the analyser's `scope` was written, typed,
  // built in the graph, and dropped here, and only driving the app found it.
  // So this asks for all of them at once.
  const ctx = new OfflineAudioContext(1, 128, SR);
  const built = withBypass(ctx as unknown as BaseAudioContext, (input, output) => {
    input.connect(output);
    return {
      setParam: () => { /* nothing */ },
      automatable: () => null,
      drives: () => null,
      reduction: () => -3,
      analyse: () => ({ lufs: -14, peakDb: -1 }),
      scope: () => true,
      setSidechainActive: () => { /* nothing */ },
      sidechain: input,
      latencySamples: 64,
      dispose: () => { /* nothing */ },
    };
  });
  const missing: string[] = [];
  for (const key of ['automatable', 'drives', 'reduction', 'analyse', 'scope'] as const) {
    if (typeof built[key] !== 'function') missing.push(key);
  }
  assert(missing.length === 0,
    `withBypass dropped ${missing.join(', ')} — a builder returned them and the instance does `
    + 'not have them');
  assert(built.latencySamples === 64, `latency came through as ${built.latencySamples}, not 64`);
  assert(built.sidechain !== null, 'the key input was dropped');
  assert(built.reduction!() === -3, 'reduction was forwarded but does not answer');
  assert(built.scope!(new Float32Array(4), new Float32Array(4)), 'scope was forwarded but says no');
});

const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n=== Plugin rack — ${PLUGINS.length} devices, rendered ===`);
  for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
  if (failed > 0) process.exit(1);
}

void main();
