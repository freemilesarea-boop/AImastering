/**
 * true-peak-selftest.ts — the meter that said a master was safe when it was
 * over full scale.
 *
 * `truePeak.ts` splits a 48-tap interpolator into four polyphase branches.
 * Phase 0 is the identity; phases 1–3 read the sample positions in between.
 * Every branch has to pass DC at unity, or the interpolated waveform changes
 * level depending on which sub-sample position you look at. PHASE2 — the
 * HALF-sample branch, the one that catches the worst inter-sample peaks —
 * summed to 0.752319 while its two siblings summed to 1.001465.
 *
 * Measured against signals whose true peak is known exactly (a sine of
 * amplitude A has a true peak of A, whatever the sample phase):
 *
 *     full-scale fs/4 at π/4 — samples are ±0.7071, true peak is 1.0
 *       as shipped   -1.520 dBTP          normalised   -0.142 dBTP
 *     worst under-read over 200 Hz → 23.6 kHz × 8 phases
 *       as shipped   -1.520 dB            normalised   -0.351 dB
 *
 * Under-reading is the dangerous direction, and this meter is not only a
 * readout: `limiterChain.ts` uses it as the FINAL TRUE-PEAK GUARD on the
 * export path, iterating until the meter says the ceiling is met. Measured
 * end to end on dense material at a -1.0 dBTP ceiling:
 *
 *     target -9 LUFS   guard reported -1.000, the file was truly -0.575
 *     target -7 LUFS   guard reported -1.000, the file was truly  +0.286
 *
 * A delivered master above full scale, certified at -1 dBTP by the app that
 * made it.
 *
 * NOTHING HERE JUDGES THE METER WITH THE METER. The sine cases have exact
 * analytic answers, and the limiter output is judged by an independent
 * high-order sinc interpolation built in this file.
 */

import { TruePeakChannel } from '../src/renderer/audio/truePeak.js';
import { processLimiter } from '../src/renderer/audio/limiterChain.js';
import type { AudioBufferLike } from '../src/renderer/audio/loudnessCore.js';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SR = 48_000;

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed += 1; console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`); }
  else    { failed += 1; console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── 1. Every branch passes DC at unity ──────────────────────────────────────

/** The coefficient literals, read out of the module. */
function rawTable(src: string, name: string): number[] {
  const m = new RegExp(`const ${name}[\\s\\S]*?\\[([\\s\\S]*?)\\]`).exec(src);
  return (m?.[1] ?? '').split(',').map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v)).slice(0, 12);
}

{
  const src = readFileSync(path.join(DESKTOP, 'src/renderer/audio/truePeak.ts'), 'utf8');
  const sums = ['PHASE1', 'PHASE2', 'PHASE3']
    .map((n) => rawTable(src, n).reduce((a, v) => a + v, 0));
  // Stated from both ends. First: the shipped table really does violate the
  // invariant, so the correction below is not decoration.
  check('the tabulated half-sample branch does not pass DC at unity',
    Math.abs(sums[1]! - 1) > 0.2,
    `branch sums ${sums.map((v) => v.toFixed(6)).join(', ')}`);
  // Second: the module corrects every branch before using it, rather than
  // one of them, or none.
  check('and the module normalises all three before use',
    /const P1 = normalise\(PHASE1\);/.test(src)
    && /const P2 = normalise\(PHASE2\);/.test(src)
    && /const P3 = normalise\(PHASE3\);/.test(src)
    && /acc1 \+= v \* \(P1\[k\]/.test(src)
    && /acc2 \+= v \* \(P2\[k\]/.test(src)
    && /acc3 \+= v \* \(P3\[k\]/.test(src),
    'a branch is normalised but not used, or used but not normalised');
}

// The audio-thread copy of the same table must not disagree about level.
{
  const worklet = readFileSync(path.join(DESKTOP, 'src/renderer/audio/loudnessProcessor.worklet.js'), 'utf8');
  check('the worklet normalises its copy too',
    /_norm\(/.test(worklet) && /_P1\[k\]/.test(worklet) && /_P2\[k\]/.test(worklet),
    'the live meter and the offline meter would report different levels');
}

// ── 2. Known answers ────────────────────────────────────────────────────────

const meter = (sig: Float32Array): number => {
  const tp = new TruePeakChannel();
  tp.processBlock(sig);
  return tp.peakDb();
};
const sine = (freq: number, amp: number, phase: number, n = SR / 4): Float32Array => {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR + phase);
  return out;
};

{
  // The textbook inter-sample case: at fs/4 with a π/4 phase every sample is
  // ±0.7071 and the true peak is 1.0. A meter that trusts the samples reads
  // -3 dB; this one read -1.52.
  const got = meter(sine(12_000, 1, Math.PI / 4));
  check('a full-scale fs/4 sine sampled at ±0.7071 reads as full scale',
    Math.abs(got) < 0.4, `${got.toFixed(3)} dBTP, truth 0.000`);
}

{
  // A sine's true peak is its amplitude at every frequency and every phase.
  const want = 20 * Math.log10(0.5);
  let under = 0, over = 0, atU = 0;
  // fs/4 is IN the list explicitly.  A first version swept f = 200, 600,
  // 1000 … which never lands on 12 000, so the one frequency where the
  // defect was worst — a whole 1.52 dB — was the one the sweep stepped
  // over, and the check passed with the bug still in place.
  const freqs = [SR / 4, SR / 8, SR / 3];
  for (let f = 200; f <= 23_600; f += 400) freqs.push(f);
  for (const f of freqs) {
    for (let k = 0; k < 8; k++) {
      const e = meter(sine(f, 0.5, (k * Math.PI) / 8)) - want;
      if (e < under) { under = e; atU = f; }
      if (e > over) over = e;
    }
  }
  check('the sweep actually reaches the frequencies that matter',
    freqs.includes(SR / 4), 'fs/4 is where a 4x interpolator is worst');
  // 4x oversampling cannot see between its own samples, so some under-read is
  // inherent; BS.1770 accepts about 0.6 dB. 1.5 dB is a broken filter.
  check('the meter never under-reads a known peak by more than 0.6 dB',
    under > -0.6, `worst ${under.toFixed(3)} dB at ${atU} Hz`);
  // Over-reading is safe but should still be bounded, and only near Nyquist.
  check('and does not wildly over-read either', over < 1.5, `worst +${over.toFixed(3)} dB`);
}

// ── 3. The export guard keeps the promise its own header makes ──────────────

/**
 * An independent true peak, by direct sinc interpolation at 16 sub-sample
 * positions with a 64-tap kernel.
 *
 * Deliberately NOT the product's own bank: a check that measured the meter
 * with the meter would have passed throughout the defect above.
 */
function independentTruePeakDb(data: Float32Array): number {
  const HALF = 32, SUB = 16;
  let peak = 0;
  for (let i = HALF; i < data.length - HALF; i++) {
    for (let s = 0; s < SUB; s++) {
      const d = s / SUB;
      if (d === 0) { peak = Math.max(peak, Math.abs(data[i] as number)); continue; }
      let acc = 0;
      for (let k = -HALF; k < HALF; k++) {
        const x = k - d;
        const sinc = Math.sin(Math.PI * x) / (Math.PI * x);
        // Blackman window over the kernel span, so truncation does not ring.
        const w = 0.42 + 0.5 * Math.cos((Math.PI * x) / HALF) + 0.08 * Math.cos((2 * Math.PI * x) / HALF);
        acc += (data[i + k] as number) * sinc * w;
      }
      peak = Math.max(peak, Math.abs(acc));
    }
  }
  return 20 * Math.log10(Math.max(peak, 1e-12));
}

function material(n: number, amp: number, seed0: number): Float32Array {
  const out = new Float32Array(n);
  let seed = seed0;
  const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const hit = Math.exp(-40 * ((t * 6) % 1));
    out[i] = amp * (0.5 * Math.sin(2 * Math.PI * 80 * t)
      + 0.9 * hit * (rnd() * 2 - 1)
      + 0.35 * Math.sin(2 * Math.PI * 11_000 * t));
  }
  return out;
}

{
  // Short but dense — the independent reference is O(n · 16 · 64).
  const n = SR;
  const CEILING = -1.0;
  for (const target of [-9, -7]) {
    const input: AudioBufferLike = {
      numberOfChannels: 2, length: n, sampleRate: SR,
      getChannelData: (c: number) => (c === 0 ? material(n, 0.8, 11) : material(n, 0.74, 29)),
    } as AudioBufferLike;
    const res = processLimiter(input, target, { truePeakCeilingDb: CEILING });
    const truly = Math.max(
      independentTruePeakDb(res.buffer.getChannelData(0)),
      independentTruePeakDb(res.buffer.getChannelData(1)));
    check(`a master limited to ${CEILING} dBTP at ${target} LUFS is really under it`,
      truly <= CEILING + 0.35,
      `truly ${truly.toFixed(3)} dBTP${truly > CEILING ? ` (over by ${(truly - CEILING).toFixed(2)})` : ''}`);
    // And the number it hands back has to be that number, because the report
    // and the provenance record carry it to whoever receives the master.
    check(`and the value it reports at ${target} LUFS is the value it delivered`,
      Math.abs(res.truePeakDbtp - truly) < 0.4,
      `reported ${res.truePeakDbtp.toFixed(3)}, truly ${truly.toFixed(3)}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
