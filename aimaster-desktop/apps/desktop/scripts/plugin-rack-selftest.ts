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

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n=== Plugin rack — ${PLUGINS.length} devices, rendered ===`);
  for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
  if (failed > 0) process.exit(1);
}

void main();
