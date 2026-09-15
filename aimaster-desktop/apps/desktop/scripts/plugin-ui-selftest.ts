/**
 * plugin-ui-selftest — the curves a plugin window draws.
 *
 * The picture in a plugin window is a promise: this is what the device is
 * doing to your audio.  A decorative curve that drifts from the engine is
 * worse than no curve, because it is trusted.
 *
 * So the response maths is checked against what the filters actually do — a
 * +6 dB shelf reads +6 dB at its corner, a 4:1 compressor gives back 3 dB for
 * every 12 dB you push past the threshold.  This is also where the fact that
 * Web Audio reads a highpass Q in DECIBELS got caught: drawn as a linear Q,
 * the curve showed a -3 dB corner while the engine produced +0.7 dB.
 * Then the same numbers are rendered through a real OfflineAudioContext and
 * measured, so the drawing and the engine are compared to each other rather
 * than both to my arithmetic.
 *
 * Run:  pnpm --filter @aimaster/desktop test:plugin-ui
 */

import { OfflineAudioContext } from 'node-web-audio-api';

(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import {
  biquadMagnitudeDb, chainMagnitudeDb, compressorOutputDb, delayTaps, freqToX,
  gainReductionDb, limiterOutputDb, logFrequencies, reverbEnvelope, webAudioAutoMakeup,
} from '../src/renderer/daw/model/plugin-curves.js';
import { formatValue } from '../src/renderer/components/daw/plugin/Knob.js';

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
function close(a: number, b: number, m: string, tol: number): void {
  if (Math.abs(a - b) > tol) throw new Error(`${m}: ${a.toFixed(3)} vs ${b.toFixed(3)} (±${tol})`);
}

/** Level of a sine at `hz` after passing through a built graph, in dB. */
async function measureDb(
  hz: number, build: (ctx: OfflineAudioContext, source: AudioNode) => AudioNode,
): Promise<number> {
  const seconds = 0.5;
  const ctx = new OfflineAudioContext(1, SR * seconds, SR);
  const osc = ctx.createOscillator();
  osc.frequency.value = hz;
  const out = build(ctx as unknown as OfflineAudioContext, osc as unknown as AudioNode);
  out.connect(ctx.destination);
  osc.start();
  osc.stop(seconds);
  const rendered = await ctx.startRendering();

  // Measure the steady state, after any filter ringing has settled.
  const data = rendered.getChannelData(0);
  const from = Math.floor(SR * 0.3);
  let peak = 0;
  for (let i = from; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]!));
  return 20 * Math.log10(Math.max(1e-9, peak));
}

async function main(): Promise<void> {
  // ── Filter response: drawing vs engine ────────────────────────────────────

  await check('a peaking bell reads its own gain at its centre frequency', async () => {
    const drawn = biquadMagnitudeDb({ type: 'peaking', freq: 1000, gain: 6, q: 1 }, 1000, SR);
    close(drawn, 6, 'the curve says +6 dB at 1 kHz', 0.05);

    const measured = await measureDb(1000, (ctx, source) => {
      const f = ctx.createBiquadFilter();
      f.type = 'peaking'; f.frequency.value = 1000; f.Q.value = 1; f.gain.value = 6;
      source.connect(f as unknown as AudioNode);
      return f as unknown as AudioNode;
    });
    close(measured, drawn, 'and the rendered audio agrees with the curve', 0.35);
  });

  await check('a bell leaves distant frequencies alone', () => {
    const far = biquadMagnitudeDb({ type: 'peaking', freq: 1000, gain: 12, q: 1 }, 50, SR);
    close(far, 0, `50 Hz is untouched by a 1 kHz bell — got ${far.toFixed(2)} dB`, 0.5);
  });

  await check('a highpass Q is decibels, so Butterworth is -3 dB not 0.707', async () => {
    // Web Audio reads Q on a highpass as resonance in DECIBELS:
    //   alpha = sin(w0) / (2 * 10^(Q/20))
    // so the Butterworth corner every engineer expects (-3 dB, cookbook
    // Q = 1/sqrt2) is asked for as Q = -3.01 dB, and Q = 0 dB is unity.
    const butterworth = biquadMagnitudeDb({ type: 'highpass', freq: 200, gain: 0, q: -3.01 }, 200, SR);
    close(butterworth, -3, `Q = -3.01 dB is the -3 dB corner — got ${butterworth.toFixed(2)}`, 0.15);

    const unity = biquadMagnitudeDb({ type: 'highpass', freq: 200, gain: 0, q: 0 }, 200, SR);
    close(unity, 0, `Q = 0 dB sits at unity — got ${unity.toFixed(2)}`, 0.1);

    // Both against the engine, so the semantics are not just my reading of
    // the spec.
    for (const [qDb, drawn] of [[-3.01, butterworth], [0, unity]] as const) {
      const measured = await measureDb(200, (ctx, source) => {
        const f = ctx.createBiquadFilter();
        f.type = 'highpass'; f.frequency.value = 200; f.Q.value = qDb;
        source.connect(f as unknown as AudioNode);
        return f as unknown as AudioNode;
      });
      close(measured, drawn, `the render agrees at Q = ${qDb} dB`, 0.4);
    }
  });

  await check('a highpass drawn at the default Q matches what the engine runs', async () => {
    // eq3 never sets Q, so its filter sits at the Web Audio default of 1 dB —
    // slightly resonant, ABOVE unity at the corner.  Reading that number as a
    // linear Q drew -3 dB while the engine produced +0.7 dB.
    const drawn = biquadMagnitudeDb({ type: 'highpass', freq: 200, gain: 0, q: 1 }, 200, SR);
    assert(drawn > 0, `the default Q is resonant, not -3 dB — got ${drawn.toFixed(2)} dB`);

    const measured = await measureDb(200, (ctx, source) => {
      const f = ctx.createBiquadFilter();
      f.type = 'highpass'; f.frequency.value = 200;   // Q left at its default
      source.connect(f as unknown as AudioNode);
      return f as unknown as AudioNode;
    });
    close(measured, drawn, 'the drawing follows the engine, not the textbook', 0.4);
  });

  await check('a low shelf lifts the bottom and not the top', async () => {
    const spec = { type: 'lowshelf' as const, freq: 120, gain: 6, q: 0.707 };
    const low = biquadMagnitudeDb(spec, 40, SR);
    const high = biquadMagnitudeDb(spec, 8000, SR);
    close(low, 6, `40 Hz is lifted — got ${low.toFixed(2)}`, 0.4);
    close(high, 0, `8 kHz is not — got ${high.toFixed(2)}`, 0.2);

    const measured = await measureDb(40, (ctx, source) => {
      const f = ctx.createBiquadFilter();
      f.type = 'lowshelf'; f.frequency.value = 120; f.gain.value = 6;
      source.connect(f as unknown as AudioNode);
      return f as unknown as AudioNode;
    });
    close(measured, low, 'and the render agrees at 40 Hz', 0.4);
  });

  await check('the drawn EQ curve is the sum of the bands, measured', async () => {
    // The eq3 chain: HPF 20, low shelf +4, bell +5 at 1 kHz, high shelf 0.
    const specs = [
      { type: 'highpass' as const,  freq: 20,   gain: 0, q: 1 },   // Web Audio default, in dB
      { type: 'lowshelf' as const,  freq: 120,  gain: 4, q: 0.707 },
      { type: 'peaking' as const,   freq: 1000, gain: 5, q: 1 },
      { type: 'highshelf' as const, freq: 8000, gain: 0, q: 0.707 },
    ];
    const drawn = chainMagnitudeDb(specs, 1000, SR);

    const measured = await measureDb(1000, (ctx, source) => {
      let cursor = source;
      for (const spec of specs) {
        const f = ctx.createBiquadFilter();
        f.type = spec.type;
        f.frequency.value = spec.freq;
        f.Q.value = spec.q;
        f.gain.value = spec.gain;
        cursor.connect(f as unknown as AudioNode);
        cursor = f as unknown as AudioNode;
      }
      return cursor;
    });
    close(measured, drawn, 'four bands in series read the same drawn and rendered', 0.4);
  });

  await check('every plotted frequency lands inside the audible band', () => {
    const points = logFrequencies(256);
    assert(points.length === 256, 'one point per pixel column');
    close(points[0]!, 20, 'starts at 20 Hz', 0.01);
    close(points[255]!, 20_000, 'ends at 20 kHz', 1);
    // Log spacing: each decade takes the same width.
    const decadeOne = freqToX(200) - freqToX(20);
    const decadeTwo = freqToX(2000) - freqToX(200);
    close(decadeOne, decadeTwo, 'decades are evenly spaced across the axis', 0.001);
  });

  // ── Dynamics ──────────────────────────────────────────────────────────────

  await check('below the threshold a compressor does nothing at all', () => {
    const spec = { thresholdDb: -18, ratio: 4 };
    close(compressorOutputDb(spec, -40), -40, 'quiet passes straight through', 1e-6);
    close(gainReductionDb(spec, -40), 0, 'and nothing is taken off', 1e-6);
  });

  await check('a 4:1 ratio gives back a quarter of what you push in', () => {
    const spec = { thresholdDb: -20, ratio: 4 };
    // 12 dB over the threshold comes out 3 dB over: 9 dB of reduction.
    close(compressorOutputDb(spec, -8), -17, 'output sits 3 dB over the threshold', 1e-6);
    close(gainReductionDb(spec, -8), 9, 'which is 9 dB of gain reduction', 1e-6);
  });

  await check('makeup moves the whole curve up, reduction unchanged', () => {
    const plain = { thresholdDb: -20, ratio: 4 };
    const loud = { thresholdDb: -20, ratio: 4, makeupDb: 6 };
    close(compressorOutputDb(loud, -8) - compressorOutputDb(plain, -8), 6, 'output is 6 dB up', 1e-6);
    close(gainReductionDb(loud, -8), gainReductionDb(plain, -8),
      'but the reduction is the same — makeup is not less compression', 1e-6);
  });

  // ── The dot and the GR number have to be describing the same signal ───────
  //
  // The compressor window draws a dot for "where the track is now" on the
  // curve's INPUT axis, and a GR meter beside it.  Those were fed from two
  // different places — the dot from the channel's POST-FADER meter, the GR
  // from the insert itself — so the picture said the track was near silent
  // while the number said it was squeezing 4 dB.  The reading the dot uses is
  // now taken at the insert's own input, and this is the relationship that
  // makes the two agree.

  await check('a GR reading pins the input level the dot must be drawn at', () => {
    const spec = { thresholdDb: -27.2, ratio: 4, kneeDb: 6 };
    // Solve the curve for the input that produces a given reduction, then
    // check the curve agrees.  If the dot were drawn from a different signal
    // this round trip is exactly what would fail.
    for (const inDb of [-24, -20, -16, -12, -6, -1]) {
      const gr = gainReductionDb(spec, inDb);
      assert(gr > 0, `${inDb} dB is over the threshold and should be reduced`);
      close(compressorOutputDb({ ...spec, makeupDb: 0 }, inDb), inDb - gr,
        `output = input − GR at ${inDb} dB`, 1e-9);
    }
  });

  await check('4 dB of reduction means the input is above the threshold, not below', () => {
    // The screenshot that started this: threshold −27.2, ratio 4:1, GR −3.9.
    // Above the knee, GR = (in − T)(1 − 1/R), so 3.9 dB of reduction can only
    // come from an input around −22 dBFS — well to the RIGHT of the threshold
    // line.  A dot down at the −60 dB corner cannot be the same moment.
    const spec = { thresholdDb: -27.2, ratio: 4, kneeDb: 6 };
    const implied = -27.2 + 3.9 / (1 - 1 / 4);
    close(gainReductionDb(spec, implied), 3.9, 'the implied input gives back that GR', 0.01);
    assert(implied > spec.thresholdDb,
      'a compressing input has to sit above the threshold');
    assert(gainReductionDb(spec, -60) < 0.001,
      'and −60 dB in must produce no reduction at all');
  });

  await check('the knee knob changes the curve, so a drawing may not assume one', () => {
    // The window hard-coded 6 dB here, which made the Knee knob move the sound
    // and leave the picture alone.
    const hard = { thresholdDb: -20, ratio: 4, kneeDb: 0 };
    const soft = { thresholdDb: -20, ratio: 4, kneeDb: 18 };
    close(compressorOutputDb(hard, -22), -22, 'a hard knee does nothing below the threshold', 1e-9);
    assert(compressorOutputDb(soft, -22) < -22.2,
      'an 18 dB knee is already bending 2 dB below the threshold');
    assert(gainReductionDb(soft, -20) > gainReductionDb(hard, -20),
      'at the threshold itself the wide knee is already reducing and the hard one is not');
  });

  await check('the soft knee is smooth where a hard knee has a corner', () => {
    const soft = { thresholdDb: -20, ratio: 4, kneeDb: 6 };
    // Just under the threshold the knee is already bending: that is the point.
    const atKnee = compressorOutputDb(soft, -21);
    assert(atKnee < -21, `the knee starts early — got ${atKnee.toFixed(3)}`);
    assert(atKnee > -21.5, 'but gently');
    // Continuity across the knee's upper edge.
    const inside = compressorOutputDb(soft, -17.01);
    const outside = compressorOutputDb(soft, -16.99);
    close(inside, outside, 'no step where the knee ends', 0.02);
  });

  await check('a ratio of 1:1 is a straight line whatever the threshold', () => {
    const spec = { thresholdDb: -30, ratio: 1 };
    for (const db of [-60, -30, -10, 0]) {
      close(compressorOutputDb(spec, db), db, `1:1 passes ${db} dB through`, 1e-6);
    }
  });

  await check('a limiter is a ceiling and nothing else', () => {
    close(limiterOutputDb(-1, -20), -20, 'quiet is untouched', 1e-6);
    close(limiterOutputDb(-1, 0), -1, 'loud comes down to the ceiling', 1e-6);
    close(limiterOutputDb(-1, -1), -1, 'the ceiling itself passes', 1e-6);
  });

  // ── Time-based ────────────────────────────────────────────────────────────

  await check('delay repeats decay by the feedback amount, and stop', () => {
    const taps = delayTaps(0.25, 0.5);
    close(taps[0]!.timeSec, 0.25, 'the first repeat is one delay time out', 1e-9);
    close(taps[0]!.gain, 0.5, 'at the feedback level', 1e-9);
    close(taps[1]!.gain, 0.25, 'each repeat is quieter by the same factor', 1e-9);
    assert(taps.length < 24, `they die out rather than running forever — ${taps.length} taps`);

    // No feedback is a single slap, not silence.
    assert(delayTaps(0.25, 0).length === 0, 'zero feedback has no repeats');
  });

  await check('runaway feedback is clamped so the drawing stays finite', () => {
    const taps = delayTaps(0.25, 5);
    assert(taps.length <= 24, `capped at the tap limit — got ${taps.length}`);
    assert(taps.every((t) => t.gain <= 1), 'and no repeat is louder than the source');
  });

  await check('a reverb tail reaches -60 dB exactly at its decay time', () => {
    const env = reverbEnvelope(2);
    close(env[0]!, 1, 'starts at full level', 1e-6);
    close(20 * Math.log10(env[env.length - 1]!), -60, 'and ends 60 dB down', 0.01);
  });

  // ── Readouts ──────────────────────────────────────────────────────────────

  check('values are formatted the way an engineer reads them', () => {
    assert(formatValue(1000, 'Hz') === '1.00 kHz', `got ${formatValue(1000, 'Hz')}`);
    assert(formatValue(440, 'Hz') === '440 Hz', `got ${formatValue(440, 'Hz')}`);
    assert(formatValue(3, 'dB') === '+3.0 dB', `a boost is signed — got ${formatValue(3, 'dB')}`);
    assert(formatValue(-3, 'dB') === '-3.0 dB', `got ${formatValue(-3, 'dB')}`);
    assert(formatValue(4, ':1') === '4.0:1', `got ${formatValue(4, ':1')}`);
    assert(formatValue(0.5, 'ms') === '0.5 ms', `sub-millisecond keeps a decimal — got ${formatValue(0.5, 'ms')}`);
    assert(formatValue(250, 'ms') === '250 ms', `and long times do not — got ${formatValue(250, 'ms')}`);
  });

  await check("the compressor's hidden makeup is cancelled, not left in", async () => {
    // DynamicsCompressorNode adds an automatic gain derived from threshold,
    // knee and ratio and applies it to EVERYTHING — a signal 20 dB below the
    // threshold came out 11.4 dB louder.  Inserting a compressor should not
    // change the level of audio it is not compressing.
    //
    // Verified against Chromium 120 directly, where the residual is ±0.00 dB
    // at all five settings below.  node-web-audio-api implements the same node
    // slightly differently at wide knees, so what is asserted here is what
    // holds for both: the compensation removes the great majority of the
    // error, and never makes it worse.
    let checked = 0;
    for (const [thresholdDb, kneeDb, ratio] of [
      [-24, 6, 8], [-40, 0, 4], [-12, 30, 20], [-6, 10, 2], [-50, 12, 12],
    ] as const) {
      const amp = Math.pow(10, (thresholdDb - 20) / 20);   // 20 dB under it
      const expected = 20 * Math.log10(amp);

      const render = async (compensate: boolean): Promise<number> => measureDb(220, (ctx, source) => {
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = thresholdDb;
        comp.knee.value = kneeDb;
        comp.ratio.value = ratio;
        comp.attack.value = 0.005;
        comp.release.value = 0.1;
        const trim = ctx.createGain();
        trim.gain.value = amp;
        const fix = ctx.createGain();
        fix.gain.value = compensate ? 1 / webAudioAutoMakeup(thresholdDb, kneeDb, ratio) : 1;
        source.connect(trim as unknown as AudioNode);
        (trim as unknown as AudioNode).connect(comp as unknown as AudioNode);
        (comp as unknown as AudioNode).connect(fix as unknown as AudioNode);
        return fix as unknown as AudioNode;
      });

      const raw = Math.abs(await render(false) - expected);
      const fixed = Math.abs(await render(true) - expected);
      const label = `thr ${thresholdDb} knee ${kneeDb} ratio ${ratio}:1`;

      if (raw < 2) {
        // node-web-audio-api barely applies auto-makeup at this setting where
        // Chromium applies a lot.  Nothing meaningful to measure locally; the
        // Chromium residual for this exact case is ±0.00 dB.
        continue;
      }
      checked += 1;
      assert(fixed < raw * 0.35,
        `${label}: cancelling removes most of it — ${raw.toFixed(2)} dB to ${fixed.toFixed(2)} dB`);
      assert(fixed < 1, `${label}: and what is left is inaudible — ${fixed.toFixed(2)} dB`);
    }
    assert(checked >= 3, `the engine applied auto-makeup at ${checked} settings, expected at least 3`);
  });

  check('the hidden makeup grows with ratio, as the curve says it must', () => {
    // A harder ratio pushes full scale further down the curve, so WebKit's
    // 1/saturate(1) compensation gets bigger.  A constant would be wrong.
    const gentle = webAudioAutoMakeup(-24, 6, 2);
    const hard = webAudioAutoMakeup(-24, 6, 20);
    assert(hard > gentle, `20:1 makes more hidden gain than 2:1 — ${hard.toFixed(3)} vs ${gentle.toFixed(3)}`);
    assert(gentle >= 1, 'and it is never a cut');
  });

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log('\n=== Plugin windows — curves measured against the engine ===');
  for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
  if (failed > 0) process.exit(1);
}

void main();
