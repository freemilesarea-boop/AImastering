// latency-probe-selftest — the measurement every dry path in the rack is
// aligned by, and the two ways it used to be wrong.
//
// `probeRendererLatency` measures the host because the two renderers this
// code runs in disagree: Chromium's 4x shaper is 192 samples late and this
// one's is 128, and hardcoding either mis-aligns the other. So the number
// is measured, installed, and believed by every parallel path.
//
// It was measured against a dry render of its own, and about one run in
// forty-five that dry render came back three render quanta late. Caught with
// the probe instrumented:
//
//     dry render late by             384
//     lags against that dry          586, 586, 0
//     lags against the signal fed in 128, 128, 384
//
// Nothing was wrong with the devices. The reference had moved, and the probe
// installed what it got: 586 samples of alignment on a 128-sample shaper,
// and a compressor declaring no look-ahead at all.
//
// Run: pnpm --filter @aimaster/desktop test:latency-probe

export {};

import { OfflineAudioContext } from 'node-web-audio-api';
import {
  dynamicsLatencySamples, oversample2xLatencySamples, oversampleLatencySamples,
  probeIsTrustworthy, probeRendererLatency, probedLatency,
} from '../src/renderer/daw/engine/plugin-kit.js';

(globalThis as { OfflineAudioContext?: unknown }).OfflineAudioContext = OfflineAudioContext;

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

/** What this renderer is known to cost, so a wrong install is recognisable. */
const EXPECTED: Record<number, { oversample4x: number; oversample2x: number; dynamics: number }> = {
  44_100: { oversample4x: 128, oversample2x: 128, dynamics: 384 },
  48_000: { oversample4x: 128, oversample2x: 128, dynamics: 384 },
  96_000: { oversample4x: 128, oversample2x: 128, dynamics: 640 },
};

async function main(): Promise<void> {
  console.log('\n=== THE PROBE INSTALLS WHAT THE RENDERER ACTUALLY COSTS ===\n');

  for (const sr of [44_100, 48_000, 96_000]) {
    await probeRendererLatency(sr);
    const got = probedLatency(sr);
    const want = EXPECTED[sr]!;
    check(
      `${sr} Hz is measured, not guessed`,
      got !== null,
      got ? JSON.stringify(got) : 'nothing installed',
    );
    check(
      `${sr} Hz reads what this renderer costs`,
      got?.oversample4x === want.oversample4x
        && got?.oversample2x === want.oversample2x
        && got?.dynamics === want.dynamics,
      `${JSON.stringify(got)} against ${JSON.stringify(want)}`,
    );
    check(
      `${sr} Hz: the accessors hand back the measurement`,
      oversampleLatencySamples(sr) === want.oversample4x
        && oversample2xLatencySamples(sr) === want.oversample2x
        && dynamicsLatencySamples(sr) === want.dynamics,
      `${oversampleLatencySamples(sr)} / ${oversample2xLatencySamples(sr)} / ${dynamicsLatencySamples(sr)}`,
    );
  }

  console.log('\n=== AND IT IS STABLE, WHICH IS THE WHOLE POINT ===\n');

  {
    // The failure this replaces was intermittent: forty-four runs agreeing
    // and one installing 586.  One probe proves nothing, so the measurement
    // is repeated from scratch and every answer has to be the same answer.
    const ROUNDS = 25;
    const seen = new Set<string>();
    for (let i = 0; i < ROUNDS; i++) {
      // `freshProbe` builds the graph again rather than asking the cached
      // installation, which is what makes this a repeat of the measurement
      // and not a repeat of its answer.
      seen.add(JSON.stringify(await freshProbe(44_100)));
    }
    check(
      `${ROUNDS} independent probes at 44100 Hz agree`,
      seen.size === 1,
      seen.size === 1 ? `all read ${[...seen][0]}` : `${seen.size} different answers: ${[...seen].join(' · ')}`,
    );
    check(
      'and what they agree on is this renderer, not the Chromium default',
      [...seen][0] === JSON.stringify({ oversample4x: 128, oversample2x: 128, dynamics: 384 }),
      `${[...seen][0]}`,
    );
  }

  console.log('\n=== AND A READING IT CANNOT TRUST IS NOT INSTALLED ===\n');

  {
    // The measurements this renderer really gives: 0.94 for a 4x shaper,
    // 1.00 for a compressor.  The bar sits well under both and well over
    // the sort of number a search returns when it has nothing to find.
    check(
      'a real set of readings is trusted',
      probeIsTrustworthy([{ r: 0.939 }, { r: 0.941 }, { r: 1.0 }]),
      '0.939 / 0.941 / 1.000',
    );
    check(
      'one reading that correlates with nothing spoils the set',
      !probeIsTrustworthy([{ r: 0.939 }, { r: 0.941 }, { r: 0.11 }]),
      'one of the three at 0.11',
    );
    check(
      'and so does a reading that is merely poor',
      !probeIsTrustworthy([{ r: 0.6 }, { r: 0.941 }, { r: 1.0 }]),
      'one of the three at 0.60',
    );
    check(
      'nothing measured is nothing to trust',
      !probeIsTrustworthy([]),
      'an empty set',
    );
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

/**
 * The probe's own measurement, run again from nothing.
 *
 * `probeRendererLatency` caches per rate, which is right for the app and
 * useless for asking whether the measurement is repeatable — so this repeats
 * the graph the probe builds and reads it the same way.
 */
async function freshProbe(
  sampleRate: number,
): Promise<{ oversample4x: number; oversample2x: number; dynamics: number }> {
  const n = Math.round(sampleRate / 8);
  const pair = async (
    build: (ctx: OfflineAudioContext, src: AudioBufferSourceNode) => AudioNode,
  ): Promise<number> => {
    const ctx = new OfflineAudioContext(2, n, sampleRate);
    const buffer = ctx.createBuffer(1, n, sampleRate);
    const data = buffer.getChannelData(0);
    let seed = 12345;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      data[i] = (seed / 0x7fffffff) * 2 - 1;
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const merge = ctx.createChannelMerger(2);
    const bypass = ctx.createGain();
    src.connect(bypass);
    bypass.connect(merge, 0, 0);
    build(ctx, src).connect(merge, 0, 1);
    merge.connect(ctx.destination);
    src.start();
    const out = await ctx.startRendering();
    const dry = out.getChannelData(0);
    const wet = out.getChannelData(1);
    let best = { lag: 0, r: -2 };
    const from = Math.round(n * 0.1);
    const to = n - 1600;
    for (let lag = 0; lag <= 1024; lag++) {
      let num = 0; let da = 0; let db = 0;
      for (let i = from; i < to; i++) {
        const x = dry[i] ?? 0;
        const y = wet[i + lag] ?? 0;
        num += x * y; da += x * x; db += y * y;
      }
      const r = num / Math.sqrt(Math.max(1e-30, da * db));
      if (r > best.r) best = { lag, r };
    }
    return best.lag;
  };
  const shaper = (oversample: OverSampleType) =>
    (ctx: OfflineAudioContext, src: AudioBufferSourceNode): AudioNode => {
      const w = ctx.createWaveShaper();
      const size = 4096;
      const curve = new Float32Array(size);
      for (let i = 0; i < size; i++) curve[i] = (i / (size - 1)) * 2 - 1;
      w.curve = curve;
      w.oversample = oversample;
      src.connect(w);
      return w;
    };
  return {
    oversample4x: await pair(shaper('4x')),
    oversample2x: await pair(shaper('2x')),
    dynamics: await pair((ctx, src) => {
      const c = ctx.createDynamicsCompressor();
      c.threshold.value = 0;
      c.ratio.value = 1;
      c.knee.value = 0;
      src.connect(c);
      return c;
    }),
  };
}

void main();
