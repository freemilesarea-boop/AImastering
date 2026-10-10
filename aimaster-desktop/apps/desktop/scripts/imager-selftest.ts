/**
 * imager-selftest — width per band, and the two ways it goes wrong.
 *
 * The imaging shelf was broadband only: `widener`, `monomaker` and `haas` all
 * act on the whole spectrum at once, and `mseq` is a two-band mid/side shelf
 * pair rather than width per band.  Keeping the bass mono while the top opens
 * up is the one move every mastering chain makes, and nothing here could make
 * it.
 *
 * A device that sets width per band can fail in two ways that both sound like
 * something else, so both are measured rather than reasoned about:
 *
 *   · the bands do not add back up, and it becomes an EQ at neutral
 *   · the side is phase-shifted against the middle, and the image rotates
 *     with frequency while every magnitude still reads correct
 *
 * The second is why the middle goes through the same three-band split as the
 * side and is then thrown away: an LR crossover sums to an ALLPASS, and a
 * side that has been through one against a middle that has not is an image
 * that turns.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:imager
 */

import { OfflineAudioContext } from 'node-web-audio-api';
(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import { readFileSync } from 'node:fs';

import { defaultParams, findPlugin } from '../src/renderer/daw/engine/plugins.js';
import { stereoSplit } from '../src/renderer/daw/engine/plugin-kit.js';
import { widthPictureFor, WIDTH_DEVICES } from '../src/renderer/daw/model/plugin-shapes.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try { await fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function close(a: number, b: number, tol: number, m: string): void {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${m} — got ${a.toFixed(3)}, want ${b.toFixed(3)} ±${tol}`);
}

const SR = 48_000;
const ID = 'mbwidth';
const FREQS = [40, 80, 150, 300, 800, 2000, 4000, 8000, 14000] as const;

/**
 * A stereo tone that is EITHER pure middle or pure side, through the device,
 * read back as middle and side.
 *
 * Both halves at once, because the interesting failures are the cross terms:
 * a device that turns side into middle is one whose two paths are not the two
 * paths it claims.
 */
async function probe(
  hz: number, over: Record<string, number>, content: 'mid' | 'side',
): Promise<{ midDb: number; sideDb: number }> {
  const plugin = findPlugin(ID)!;
  const n = SR * 2;
  const ctx = new OfflineAudioContext(2, n, SR);
  const instance = plugin.create(ctx as unknown as BaseAudioContext,
    { ...defaultParams(ID), ...over });
  const buffer = ctx.createBuffer(2, n, SR);
  const left = buffer.getChannelData(0), right = buffer.getChannelData(1);
  for (let i = 0; i < n; i++) {
    const v = 0.4 * Math.sin(2 * Math.PI * hz * (i / SR));
    left[i] = v;
    right[i] = content === 'side' ? -v : v;
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(instance.input);
  instance.output.connect(ctx.destination);
  src.start(0);
  const out = await ctx.startRendering();
  const a = out.getChannelData(0), b = out.getChannelData(1);
  // RMS, not peak: at 14 kHz a 48 kHz render is three samples a cycle and the
  // peak sample can miss the crest by 3 dB, which reads as a filter rolling
  // off when nothing is.
  let m = 0, s = 0, count = 0;
  for (let i = Math.round(SR * 1.2); i < n; i++) {
    const mm = (a[i]! + b[i]!) / 2, ss = (a[i]! - b[i]!) / 2;
    m += mm * mm; s += ss * ss; count++;
  }
  const reference = 0.4 / Math.SQRT2;
  const db = (x: number): number => 20 * Math.log10(Math.max(1e-12, Math.sqrt(x / count)) / reference);
  return { midDb: db(m), sideDb: db(s) };
}

async function main(): Promise<void> {
  await check('at its defaults it does nothing, to either half', async () => {
    for (const hz of FREQS) {
      close((await probe(hz, {}, 'side')).sideDb, 0, 0.05, `the side at ${hz} Hz`);
      close((await probe(hz, {}, 'mid')).midDb, 0, 0.05, `the middle at ${hz} Hz`);
    }
  });

  await check('a signal in one speaker stays in that speaker', async () => {
    // The check that catches the failure no magnitude can see.  A pure side
    // and a pure middle each measure correct even when the two paths have
    // different phase, because in each case the other half is zero and has
    // no phase to be wrong about.  A signal in ONE channel is half middle and
    // half side, in step — and it stays in one channel only if the two halves
    // come out in step too.
    //
    // This is why the middle goes through the same three-band split as the
    // side: an LR crossover sums to an allpass, and a side that has been
    // through one against a middle that has not is an image that turns with
    // frequency.  Take the split off the middle and this check fails while
    // every other one in this file still passes.
    const plugin = findPlugin(ID)!;
    const leak = async (hz: number): Promise<number> => {
      const n = SR * 2;
      const ctx = new OfflineAudioContext(2, n, SR);
      const instance = plugin.create(ctx as unknown as BaseAudioContext, defaultParams(ID));
      const buffer = ctx.createBuffer(2, n, SR);
      const left = buffer.getChannelData(0);
      for (let i = 0; i < n; i++) left[i] = 0.4 * Math.sin(2 * Math.PI * hz * (i / SR));
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(instance.input);
      instance.output.connect(ctx.destination);
      src.start(0);
      const out = await ctx.startRendering();
      const a = out.getChannelData(0), b = out.getChannelData(1);
      let kept = 0, spilled = 0, count = 0;
      for (let i = Math.round(SR * 1.2); i < n; i++) {
        kept += a[i]! * a[i]!; spilled += b[i]! * b[i]!; count++;
      }
      close(20 * Math.log10(Math.sqrt(kept / count) / (0.4 / Math.SQRT2)), 0, 0.05,
        `the speaker it was in, at ${hz} Hz`);
      return 20 * Math.log10(Math.max(1e-12, Math.sqrt(spilled / count)) / (0.4 / Math.SQRT2));
    };
    for (const hz of FREQS) {
      const got = await leak(hz);
      assert(got < -60,
        `a left-only tone at ${hz} Hz put ${got.toFixed(1)} dB into the right — the two halves `
        + 'are not arriving together');
    }
  });

  await check('the width knobs are the width, in decibels of side', async () => {
    // A width of w is a side multiplied by w, which is 20·log10(w) — and it
    // has to be that in the band it belongs to and nowhere else.
    for (const [w, hz] of [[1.6, 14_000], [0.5, 14_000], [1.4, 800], [0.25, 800]] as const) {
      const band = hz > 8000 ? 'hiWidth' : 'midWidth';
      const got = (await probe(hz, { [band]: w }, 'side')).sideDb;
      close(got, 20 * Math.log10(w), 0.1, `${band} at ${w}× measured at ${hz} Hz`);
    }
  });

  await check('the bass goes mono and the transition is the crossover\'s', async () => {
    const at = async (hz: number): Promise<number> =>
      (await probe(hz, { lowWidth: 0, lowXHz: 150 }, 'side')).sideDb;
    // Half the side gone at the corner, which is what Linkwitz-Riley means.
    close(await at(150), -6.02, 0.2, 'the side at the crossover');
    // 18.6 dB an octave below it, not 24: what is left of the side down
    // there is the band ABOVE, and a Linkwitz-Riley highpass at half its
    // corner is (0.25/√1.0625)² = −24.6 dB, against −6.02 at the corner.
    // 24 dB an octave is the low band's own skirt, which is not what this
    // measures — the check was written expecting it and the device was right.
    close(await at(75) - await at(150), -18.6, 0.5, 'an octave below the crossover');
    assert(await at(40) < -40, `40 Hz is only ${(await at(40)).toFixed(1)} dB down — not mono`);
    // And the band above it is untouched.
    close(await at(800), 0, 0.05, 'an octave and a half above, nothing');
  });

  await check('the middle is never touched, whatever the widths do', async () => {
    // The property that makes this a width control rather than an EQ.  The
    // two paths never cross: the middle is summed from its own three bands
    // and the widths are only ever on the side's.
    const hard = { lowWidth: 0, midWidth: 1.8, hiWidth: 0.2 };
    for (const hz of FREQS) {
      close((await probe(hz, hard, 'mid')).midDb, 0, 0.05, `the middle at ${hz} Hz`);
    }
  });

  await check('nothing leaks from one half into the other', async () => {
    // A side that turns into middle is a device whose bands do not line up.
    // −60 dB is generous; measured it is the floor of the arithmetic.
    const hard = { lowWidth: 0, midWidth: 1.8, hiWidth: 0.2 };
    for (const hz of FREQS) {
      const fromSide = await probe(hz, hard, 'side');
      assert(fromSide.midDb < -60,
        `a pure side at ${hz} Hz put ${fromSide.midDb.toFixed(1)} dB into the middle`);
      const fromMid = await probe(hz, hard, 'mid');
      assert(fromMid.sideDb < -60,
        `a pure middle at ${hz} Hz put ${fromMid.sideDb.toFixed(1)} dB into the side`);
    }
  });

  await check('the crossovers move where they are told', async () => {
    // Both edges, and both halves of each edge — eight biquads for the low
    // one, which is why it is not an insert lane.
    const low = async (x: number, hz: number): Promise<number> =>
      (await probe(hz, { lowWidth: 0, lowXHz: x }, 'side')).sideDb;
    close(await low(100, 100), -6.02, 0.25, 'a 100 Hz crossover halves at 100 Hz');
    close(await low(400, 400), -6.02, 0.25, 'a 400 Hz crossover halves at 400 Hz');
    assert(await low(400, 150) < -15,
      'moving the crossover up did not take 150 Hz with it');
    const high = async (x: number, hz: number): Promise<number> =>
      (await probe(hz, { hiWidth: 0, highXHz: x }, 'side')).sideDb;
    close(await high(2000, 2000), -6.02, 0.25, 'a 2 kHz crossover halves at 2 kHz');
    close(await high(8000, 8000), -6.02, 0.3, 'an 8 kHz crossover halves at 8 kHz');
  });

  await check('the trim is a trim and moves both halves together', async () => {
    for (const outDb of [-6, 4]) {
      close((await probe(1000, { outDb }, 'side')).sideDb, outDb, 0.05, `the side at ${outDb} dB`);
      close((await probe(1000, { outDb }, 'mid')).midDb, outDb, 0.05, `the middle at ${outDb} dB`);
    }
  });

  await check('the picture is the width the device applies', async () => {
    assert(WIDTH_DEVICES.includes(ID), 'the device draws no width picture');
    const params = { ...defaultParams(ID), lowWidth: 0, midWidth: 1.2, hiWidth: 1.6 };
    const picture = widthPictureFor(ID, params);
    assert(picture !== null, 'the picture is missing');
    for (const hz of [40, 150, 300, 800, 2000, 8000, 14_000]) {
      const drawn = 20 * Math.log10(Math.max(1e-6, picture!.widthAt(hz)));
      const played = (await probe(hz, params, 'side')).sideDb;
      // Half a decibel: the drawing adds the bands' MAGNITUDES while the
      // device adds their complex responses, which agree where one band
      // dominates and differ slightly in a crossover's skirt.
      close(drawn, played, 0.5, `the drawing at ${hz} Hz against the device`);
    }
    assert(picture!.caption.includes('120%') && picture!.caption.includes('160%'),
      `the caption does not say what it is doing: ${picture!.caption}`);
    const idle = widthPictureFor(ID, defaultParams(ID))!;
    assert(idle.caption.includes('그대로'), `an idle imager claims ${idle.caption}`);
  });

  await check('every mid/side device up-mixes before it splits', () => {
    // Structural, and deliberately so: the rendered check below passes with
    // or without the up-mix, because the offline renderer up-mixes on its own
    // and Chromium does not.  Measured in the browser, a mono tone through a
    // bare `ChannelSplitter` with channel 1 taken out: left −0.00 dB, right
    // −230.97 dB.  So what is held here is the CONSTRUCTION — and over the
    // whole engine, not over this one device, because `widener`, the shared
    // `midSide` helper and the reverbs' width stage all had it.
    const ctx = new OfflineAudioContext(2, 128, SR);
    const { input, splitter } = stereoSplit(ctx as unknown as BaseAudioContext);
    assert(input.channelCount === 2, `the up-mix takes ${input.channelCount} channels`);
    assert(input.channelCountMode === 'explicit',
      `the up-mix is ${input.channelCountMode}, so a mono input stays mono`);
    assert(input.channelInterpretation === 'speakers',
      `the up-mix is ${input.channelInterpretation}, which copies nothing into the right`);
    assert(splitter.numberOfOutputs === 2, 'the splitter is not a pair');

    const sources = [
      'src/renderer/daw/engine/plugins.ts',
      'src/renderer/daw/engine/plugins-extended.ts',
      'src/renderer/daw/engine/plugins-reverb.ts',
    ];
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      // `createChannelSplitter(` — the call, not the capability guard some of
      // these files make before reaching for it.
      assert(!/createChannelSplitter\s*\(/.test(text),
        `${file} makes a splitter of its own — it has to go through stereoSplit, or a mono `
        + 'track loses a channel in the browser');
    }
  });

  await check('a mono source comes out of both speakers', async () => {
    // The rendered half.  It cannot fail here — see the check above — but it
    // is what the structural one is standing in for, and it would fail in the
    // browser.
    const plugin = findPlugin(ID)!;
    const n = SR;
    const ctx = new OfflineAudioContext(2, n, SR);
    const instance = plugin.create(ctx as unknown as BaseAudioContext, defaultParams(ID));
    const buffer = ctx.createBuffer(1, n, SR);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = 0.4 * Math.sin(2 * Math.PI * 1000 * (i / SR));
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(instance.input);
    instance.output.connect(ctx.destination);
    src.start(0);
    const out = await ctx.startRendering();
    const rms = (channel: number): number => {
      const x = out.getChannelData(channel);
      let sum = 0, count = 0;
      for (let i = Math.round(SR * 0.5); i < n; i++) { sum += x[i]! * x[i]!; count++; }
      return 20 * Math.log10(Math.max(1e-12, Math.sqrt(sum / count)) / (0.4 / Math.SQRT2));
    };
    close(rms(0), 0, 0.05, 'the left of a mono source');
    close(rms(1), 0, 0.05, 'the right of a mono source');
  });

  console.log('\n=== Multiband imaging ===');
  for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  const bad = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
  if (bad > 0) process.exit(1);
}

void main();
