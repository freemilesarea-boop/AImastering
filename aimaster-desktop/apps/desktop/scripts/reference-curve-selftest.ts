/**
 * reference-curve-selftest — the Match EQ target, measured.
 *
 * `src/main/offline/reference-curve.ts` had no test of any kind, and until
 * the WASM loader was fixed it had never run in the app either: the handler
 * called it, `createOfflineChain` threw because the offline engine could
 * not be found from the bundled main process, and the panel showed the
 * error.  So the only thing that had ever exercised this code was reading
 * it.
 *
 * What reading it missed, and measurement found:
 *
 *   30 s noise + 0 s silence → curve mean   -3.2 dB
 *   30 s noise + 2 s silence → curve mean -122.1 dB
 *   30 s noise + 5 s silence → curve mean -178.0 dB
 *   30 s of digital silence  → 32 FINITE bands (-200/-140), span 60 dB
 *   a 0.3 s file             → accepted, measuredSeconds 0.2
 *
 * Run via:  pnpm --filter @aimaster/desktop test:reference-curve
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// Same override the profiler's test uses: the decode path under test stays
// the real one, pointed at the dev ffmpeg since there is no Electron
// resourcesPath to find the bundled copy in.
process.env.AIMASTER_FFMPEG =
  createRequire(import.meta.url)('ffmpeg-static') as string;

import { measureReferenceCurve, REFERENCE_CURVE_BANDS } from '../src/main/offline/reference-curve.js';
import { findLoudSpan, spanRmsDbfs } from '../src/main/offline/loud-span.js';
import { bandHz } from '../src/main/offline/song-profile.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}

const SR = 48_000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-refcurve-'));

/** Write planar stereo as a 24-bit WAV. */
function writeWav(name: string, left: Float32Array, right: Float32Array): string {
  const n = left.length;
  const bytes = n * 2 * 3;
  const buf = Buffer.alloc(44 + bytes);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + bytes, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2 * 3, 28); buf.writeUInt16LE(6, 32); buf.writeUInt16LE(24, 34);
  buf.write('data', 36); buf.writeUInt32LE(bytes, 40);
  let o = 44;
  const put = (v: number): void => {
    buf.writeIntLE(Math.round(Math.max(-1, Math.min(1, v)) * 8_388_607), o, 3);
    o += 3;
  };
  for (let i = 0; i < n; i++) { put(left[i]!); put(right[i]!); }
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
}

/** Deterministic noise — the same generator the profiler's test uses. */
function noiseGen(): () => number {
  let s = 0x9e3779b9n;
  return () => {
    s = (s * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    return Number(s >> 33n) / 2 ** 30 - 1;
  };
}

/**
 * `seconds` of noise, optionally followed by `tailSec` of digital silence.
 *
 * `dark` runs it through a one-pole low-pass; otherwise through the
 * complementary high-pass, so the two have opposite tilts from the same
 * source.
 */
function material(seconds: number, dark: boolean, tailSec = 0): { l: Float32Array; r: Float32Array } {
  const nm = Math.floor(seconds * SR);
  const n = nm + Math.floor(tailSec * SR);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  const g = noiseGen();
  let lp = 0;
  for (let i = 0; i < nm; i++) {
    const w = g();
    lp += 0.2 * (w - lp);
    const v = (dark ? lp * 3 : w - lp) * 0.25;
    l[i] = v; r[i] = v * 0.95;
  }
  return { l, r };
}

function meanOf(c: readonly number[]): number {
  return c.reduce((a, b) => a + b, 0) / c.length;
}
/** Mean of the bands whose centre falls in [lo, hi). */
function bandMean(c: readonly number[], lo: number, hi: number): number {
  let acc = 0; let n = 0;
  for (let i = 0; i < c.length; i++) {
    const hz = bandHz(i);
    if (hz >= lo && hz < hi) { acc += c[i]!; n++; }
  }
  return n > 0 ? acc / n : 0;
}

async function main(): Promise<void> {
  console.log('\n=== IT MEASURES THE REFERENCE ===\n');

  const dark = await measureReferenceCurve(
    writeWav('dark.wav', ...Object.values(material(30, true)) as [Float32Array, Float32Array]),
  );
  const bright = await measureReferenceCurve(
    writeWav('bright.wav', ...Object.values(material(30, false)) as [Float32Array, Float32Array]),
  );

  check(
    "the curve is on the engine's 32-band grid",
    dark.curveDb.length === REFERENCE_CURVE_BANDS,
    `${dark.curveDb.length} bands`,
  );
  check(
    'and is normalised to zero mean, so it is a shape and not a level',
    Math.abs(meanOf(dark.curveDb)) < 1e-9 && Math.abs(meanOf(bright.curveDb)) < 1e-9,
    `${meanOf(dark.curveDb).toExponential(2)} / ${meanOf(bright.curveDb).toExponential(2)}`,
  );

  // The one thing a tonal reference has to get right: which end is up.
  const darkHf = bandMean(dark.curveDb, 4_000, 16_000) - bandMean(dark.curveDb, 100, 1_000);
  const brightHf = bandMean(bright.curveDb, 4_000, 16_000) - bandMean(bright.curveDb, 100, 1_000);
  check(
    'a dark reference reads darker at the top than a bright one',
    darkHf < brightHf - 6,
    `HF-vs-LF: dark ${darkHf.toFixed(1)} dB, bright ${brightHf.toFixed(1)} dB`,
  );
  check(
    'every band is finite, so Match EQ cannot be handed a NaN target',
    dark.curveDb.every(Number.isFinite) && bright.curveDb.every(Number.isFinite),
  );

  console.log('\n=== AND IT IS NOT FOOLED BY WHERE THE MUSIC STOPS ===\n');

  // The measured defect: the chain's band average decays with a ~2 s
  // constant, so the end of the analysed span dominates. A fixed window
  // ran into whatever was there.
  const clean = await measureReferenceCurve(
    writeWav('clean.wav', ...Object.values(material(40, false)) as [Float32Array, Float32Array]),
  );
  const tailed = await measureReferenceCurve(
    writeWav('tailed.wav', ...Object.values(material(40, false, 6)) as [Float32Array, Float32Array]),
  );
  const drift = Math.max(
    ...clean.curveDb.map((v, i) => Math.abs(v - tailed.curveDb[i]!)),
  );
  check(
    'six seconds of trailing silence does not change the curve',
    drift < 3,
    `largest band difference ${drift.toFixed(2)} dB `
    + `(the fixed window moved the mean by 119 dB on this material)`,
  );
  // Growing the span backwards as well as forwards. On steady material
  // every window has the same RMS to fifteen decimal places, so which is
  // "loudest" is decided by the last bits — and forward-only then keeps
  // only what follows it: 10.0 s of this 40 s file, measured.
  check(
    'a steady 40 s reference is averaged over the track, not a tenth of it',
    clean.measuredSeconds > 30,
    `${clean.measuredSeconds.toFixed(1)} s of 40`,
  );
  check(
    'and the span stops before the silence rather than running into it',
    tailed.measuredSeconds <= 40.5 && tailed.measuredSeconds > 4,
    `${tailed.measuredSeconds.toFixed(1)} s of a 46 s file`,
  );

  console.log('\n=== AND IT REFUSES WHAT IS NOT A REFERENCE ===\n');

  // Digital silence. The existing `finite.length === 0` guard cannot catch
  // this: the analyser floors bands at -200/-140 dBFS, all finite, and
  // normalising turns that floor pattern into a 60 dB shape.
  const z = new Float32Array(Math.floor(30 * SR));
  let err = '';
  try {
    const r = await measureReferenceCurve(writeWav('silence.wav', z, z.slice()));
    err = `returned a curve: span ${(Math.max(...r.curveDb) - Math.min(...r.curveDb)).toFixed(1)} dB`;
  } catch (e) { err = (e as Error).message; }
  check(
    'digital silence is refused, not normalised into a shape',
    err.includes('측정할 소리가 없습니다'),
    err,
  );

  // Too short for the average to converge.
  for (const secs of [0.3, 1, 2]) {
    const m = material(secs, false);
    let msg = '';
    try {
      const r = await measureReferenceCurve(writeWav(`short${secs}.wav`, m.l, m.r));
      msg = `accepted with measuredSeconds ${r.measuredSeconds.toFixed(1)}`;
    } catch (e) { msg = (e as Error).message; }
    check(
      `a ${secs} s file is refused rather than becoming a match target`,
      msg.includes('너무 짧습니다'),
      msg,
    );
  }

  // And the boundary holds the other way: enough audio still works.
  const ok = await measureReferenceCurve(
    writeWav('tensec.wav', ...Object.values(material(10, false)) as [Float32Array, Float32Array]),
  );
  check(
    'ten seconds is enough',
    ok.curveDb.length === REFERENCE_CURVE_BANDS && ok.measuredSeconds >= 4,
    `${ok.measuredSeconds.toFixed(1)} s`,
  );

  console.log('\n=== THE SPAN FINDER ITSELF ===\n');

  // Both callers depend on this, so it is checked directly rather than only
  // through what it produces.
  const m = material(20, false, 10);
  const span = findLoudSpan(m.l, m.r, SR, { maxSec: 90 });
  check(
    'the span starts in the music, not in the tail',
    span.from < 20 * SR,
    `from ${(span.from / SR).toFixed(1)} s`,
  );
  check(
    'and ends at the music, not at the end of the file',
    span.to <= 21 * SR,
    `to ${(span.to / SR).toFixed(1)} s of a 30 s file`,
  );
  check(
    'the span it picks has signal in it',
    spanRmsDbfs(m.l, m.r, span.from, span.to) > -40,
    `${spanRmsDbfs(m.l, m.r, span.from, span.to).toFixed(1)} dBFS`,
  );
  check(
    'silence has no level to report',
    spanRmsDbfs(z, z, 0, z.length) === -Infinity,
  );
  // A file shorter than one window has no windows to compare; the span is
  // then the whole file and the caller's own minimum decides.
  const tiny = material(0.5, false);
  const tinySpan = findLoudSpan(tiny.l, tiny.r, SR, { maxSec: 90 });
  check(
    'a file shorter than one window yields the whole file',
    tinySpan.from === 0 && tinySpan.to === tiny.l.length,
    `${tinySpan.from}..${tinySpan.to} of ${tiny.l.length}`,
  );

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
}

void main()
  .then(() => { fs.rmSync(dir, { recursive: true, force: true }); process.exit(failed === 0 ? 0 : 1); })
  .catch((e) => { console.error(e); process.exit(1); });
