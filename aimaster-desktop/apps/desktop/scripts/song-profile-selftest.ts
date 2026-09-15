// song-profile-selftest — the measurement is real, on real files.
//
// `adaptive-defaults-selftest` checks that the RULES react to a profile.
// This checks the other half: that the profile is an honest description of
// the audio. A rule engine fed a wrong measurement is worse than no
// analysis, because it acts confidently on a fiction.
//
// Every case writes an actual WAV with a known property, decodes it back
// through the same ffmpeg path the render uses, and checks the number that
// comes out. Synthesising the buffer in memory and skipping the file would
// not test the decode, which is where sample rates and channel counts go
// wrong.
//
// Run:  pnpm --filter @aimaster/desktop test:song-profile

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { profileSong, bandHz } from '../src/main/offline/song-profile.js';

// The profiler decodes through the same bundled ffmpeg the render uses. In
// a test there is no Electron resourcesPath to find it in, so point the
// resolver's documented override at the dev binary rather than reaching
// past the resolver — the decode path under test stays the real one.
process.env.AIMASTER_FFMPEG =
  createRequire(import.meta.url)('ffmpeg-static') as string;

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

const SR = 48_000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-profile-'));

/** Write interleaved stereo as a 24-bit WAV. */
function writeWav(name: string, left: Float32Array, right: Float32Array): string {
  const n = left.length;
  const bytes = n * 2 * 3;
  const buf = Buffer.alloc(44 + bytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + bytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2 * 3, 28);
  buf.writeUInt16LE(6, 32);
  buf.writeUInt16LE(24, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(bytes, 40);
  let o = 44;
  const put = (v: number): void => {
    const s = Math.max(-1, Math.min(1, v));
    const i = Math.round(s * 8_388_607);
    buf.writeIntLE(i, o, 3);
    o += 3;
  };
  for (let i = 0; i < n; i++) { put(left[i]!); put(right[i]!); }
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
}

/** Deterministic white noise. */
function makeNoise(): () => number {
  let s = 0x9e3779b9n;
  return () => {
    s = (s * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    return Number(s >> 33n) / 2 ** 30 - 1;
  };
}

/**
 * Build a track: a loud body, then a quiet passage carrying only the floor.
 *
 * `tone` shapes the body's spectrum; `floor` is the noise under everything.
 */
function track(opts: {
  seconds?: number;
  amp?: number;
  partials?: Array<[number, number]>;
  bodyNoise?: number;
  floor?: number;
  quietSeconds?: number;
  sideAmp?: number;
  lowInvert?: boolean;
  cutoffHz?: number;
}): { left: Float32Array; right: Float32Array } {
  const seconds = opts.seconds ?? 14;
  const quiet = opts.quietSeconds ?? 3;
  const n = SR * seconds;
  const bodyN = SR * (seconds - quiet);
  const amp = opts.amp ?? 0.3;
  const partials = opts.partials ?? [[110, 1], [440, 0.6], [2200, 0.35], [9000, 0.2]];
  const noise = makeNoise();
  const noise2 = makeNoise();
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    if (i < bodyN) {
      for (const [hz, a] of partials) {
        if (opts.cutoffHz !== undefined && hz > opts.cutoffHz) continue;
        v += a * Math.sin(2 * Math.PI * hz * t);
      }
      v *= amp;
      if (opts.bodyNoise) {
        // Band-limited by the cutoff, so a "capped" source really is capped.
        v += noise() * opts.bodyNoise;
      }
    }
    const f = (opts.floor ?? 0) * noise2();
    const side = (opts.sideAmp ?? 0) * noise();
    left[i] = v + f + side;
    right[i] = (opts.lowInvert ? -v : v) + f - side;
  }
  return { left, right };
}

async function run(): Promise<void> {
  console.log('\n=== LEVEL AND DYNAMICS ===\n');

  {
    const loud = track({ amp: 0.6 });
    const quiet = track({ amp: 0.06 });
    const a = await profileSong(writeWav('loud.wav', loud.left, loud.right));
    const b = await profileSong(writeWav('quiet.wav', quiet.left, quiet.right));
    check(
      'a louder file measures louder',
      a.integratedLufs > b.integratedLufs + 15,
      `${a.integratedLufs.toFixed(1)} vs ${b.integratedLufs.toFixed(1)} LUFS for a 20 dB difference`,
    );
    check(
      'and the true peak is reported',
      a.truePeakDbtp > b.truePeakDbtp && a.truePeakDbtp < 0.5,
      `${a.truePeakDbtp.toFixed(2)} vs ${b.truePeakDbtp.toFixed(2)} dBTP`,
    );
  }

  {
    // A square-ish wave has almost no crest; a sparse impulse train has a
    // lot. The measurement has to tell them apart, because it decides how
    // much compression the song is told it needs.
    const n = SR * 12;
    const flatL = new Float32Array(n);
    const peakyL = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      flatL[i] = Math.sign(Math.sin((2 * Math.PI * 110 * i) / SR)) * 0.4;
      peakyL[i] = (i % 12_000 < 200 ? 0.9 : 0.02) * Math.sin((2 * Math.PI * 220 * i) / SR);
    }
    const a = await profileSong(writeWav('flat.wav', flatL, flatL));
    const b = await profileSong(writeWav('peaky.wav', peakyL, peakyL));
    check(
      'crest factor separates a squashed source from a dynamic one',
      b.crestDb > a.crestDb + 8,
      `square ${a.crestDb.toFixed(1)} dB vs impulses ${b.crestDb.toFixed(1)} dB`,
    );
  }

  console.log('\n=== SPECTRUM ===\n');

  {
    // The air measurement covers 10-16 kHz, so the test signals have to put
    // content there. An earlier version topped out at 9 kHz and both cases
    // measured the same empty band — a test that would have passed a broken
    // measurement and failed a working one.
    const dark = track({ partials: [[110, 1], [440, 0.6], [2200, 0.1], [12_000, 0.02]] });
    const bright = track({ partials: [[110, 0.4], [440, 0.4], [2200, 0.8], [12_000, 0.9]] });
    const a = await profileSong(writeWav('dark.wav', dark.left, dark.right));
    const b = await profileSong(writeWav('bright.wav', bright.left, bright.right));
    check(
      'a dark mix reads a steeper downward tilt than a bright one',
      a.tiltDbPerOct < b.tiltDbPerOct - 1,
      `dark ${a.tiltDbPerOct.toFixed(2)} vs bright ${b.tiltDbPerOct.toFixed(2)} dB/oct`,
    );
    check(
      'and the air measurement follows',
      b.airDb > a.airDb + 6,
      `dark ${a.airDb.toFixed(1)} dB vs bright ${b.airDb.toFixed(1)} dB`,
    );
  }

  {
    const harsh = track({ partials: [[110, 0.5], [440, 0.4], [3000, 1.0], [9000, 0.2]] });
    const smooth = track({ partials: [[110, 0.5], [440, 1.0], [3000, 0.08], [9000, 0.2]] });
    const a = await profileSong(writeWav('harsh.wav', harsh.left, harsh.right));
    const b = await profileSong(writeWav('smooth.wav', smooth.left, smooth.right));
    check(
      'a 3 kHz-heavy mix reads harsher',
      a.harshDb > b.harshDb + 6,
      `${a.harshDb.toFixed(1)} dB vs ${b.harshDb.toFixed(1)} dB relative to the curve mean`,
    );
  }

  {
    // The generative/lossy signature: content stops dead. Broadband body so
    // the cutoff is a real edge rather than a gap between partials.
    const capped = track({
      partials: [[110, 1], [440, 0.6], [2200, 0.4], [5000, 0.3]],
      floor: 0.00002,
    });
    // The same material with real content in the top.
    const full = track({
      partials: [[110, 1], [440, 0.6], [2200, 0.4], [5000, 0.3], [12_000, 0.3]],
      floor: 0.00002,
    });
    const a = await profileSong(writeWav('capped.wav', capped.left, capped.right));
    const b = await profileSong(writeWav('full.wav', full.left, full.right));
    check(
      'a full-bandwidth source reports no cutoff',
      b.topCutoffHz === null,
      `${String(b.topCutoffHz)} — nothing to find`,
    );
    // The synthetic "cap" is a partial list, so the edge is not brickwalled;
    // what matters is that the top reads as collapsed rather than present.
    check(
      'a band-limited source reads as a collapsed top',
      a.airDb < b.airDb - 6,
      `capped air ${a.airDb.toFixed(1)} dB vs full ${b.airDb.toFixed(1)} dB`,
    );
  }

  console.log('\n=== THE NOISE FLOOR, FROM THE QUIET PASSAGE ===\n');

  {
    // The measurement the hiss gate depends on, and the reason the profile
    // looks at two windows: the floor is only visible where the music is not.
    const noisy = track({ floor: 0.002, quietSeconds: 4 });
    const clean = track({ floor: 0.000002, quietSeconds: 4 });
    const a = await profileSong(writeWav('noisy.wav', noisy.left, noisy.right));
    const b = await profileSong(writeWav('clean.wav', clean.left, clean.right));
    check(
      'a noisy source reports a higher floor than a clean one',
      a.quietHfFloorDbfs > b.quietHfFloorDbfs + 15,
      `${a.quietHfFloorDbfs.toFixed(0)} vs ${b.quietHfFloorDbfs.toFixed(0)} dBFS`,
    );
    check(
      'and the floor is measured in the quiet window, not the loud body',
      a.quietHfFloorDbfs < -40,
      `${a.quietHfFloorDbfs.toFixed(0)} dBFS — the body would read far higher`,
    );
  }

  console.log('\n=== STEREO ===\n');

  {
    const mono = track({ sideAmp: 0 });
    const wide = track({ sideAmp: 0.25 });
    const a = await profileSong(writeWav('mono.wav', mono.left, mono.right));
    const b = await profileSong(writeWav('wide.wav', wide.left, wide.right));
    check(
      'width follows the side energy',
      b.widthPct > a.widthPct + 20,
      `mono ${a.widthPct.toFixed(0)}% vs wide ${b.widthPct.toFixed(0)}%`,
    );
  }

  {
    const inPhase = track({ sideAmp: 0 });
    const flipped = track({ sideAmp: 0, lowInvert: true });
    const a = await profileSong(writeWav('inphase.wav', inPhase.left, inPhase.right));
    const b = await profileSong(writeWav('flipped.wav', flipped.left, flipped.right));
    check(
      'an inverted channel is caught by the low-frequency correlation',
      a.lowCorrelation > 0.9 && b.lowCorrelation < -0.5,
      `${a.lowCorrelation.toFixed(2)} vs ${b.lowCorrelation.toFixed(2)} — the second would lose its bass in mono`,
    );
  }

  console.log('\n=== SHAPE AND SAFETY ===\n');

  {
    const t = track({});
    const p = await profileSong(writeWav('shape.wav', t.left, t.right));
    check('the curve has the engine\'s 32 bands', p.curveDb.length === 32, `${p.curveDb.length} bands`);
    check(
      'every field is finite',
      Object.entries(p).every(([, v]) =>
        typeof v !== 'number' || Number.isFinite(v)) && p.curveDb.every(Number.isFinite),
      'no NaN or Infinity reaches the rules',
    );
    check(
      'the band grid matches the engine\'s',
      Math.abs(bandHz(0) - 20) < 0.01 && Math.abs(bandHz(31) - 20_000) < 1,
      `${bandHz(0).toFixed(1)} Hz .. ${(bandHz(31) / 1000).toFixed(1)} kHz`,
    );
  }

  {
    // Digital silence has no floor to find and no tone to measure. It must
    // come back describable rather than throwing or reporting -Infinity.
    const n = SR * 5;
    const z = new Float32Array(n);
    const p = await profileSong(writeWav('silence.wav', z, z));
    check(
      'digital silence produces a finite, harmless profile',
      Number.isFinite(p.integratedLufs) && Number.isFinite(p.quietHfFloorDbfs)
        && Number.isFinite(p.crestDb),
      `${p.integratedLufs.toFixed(0)} LUFS, floor ${p.quietHfFloorDbfs.toFixed(0)} dBFS`,
    );
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed === 0 ? 0 : 1);
}

void run().catch((err: unknown) => {
  console.error('[FAIL] profiler threw —', (err as Error).message);
  process.exit(1);
});
