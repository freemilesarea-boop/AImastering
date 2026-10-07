/**
 * export-audio-selftest — does a saved setting reach the AUDIO?
 *
 * The reported bug was that pressing 설정 저장 and then mastering gave the
 * original back.  Four causes were found and fixed, and each got a test —
 * but every one of those tests stops short of the thing the user receives.
 * They check that the config is BUILT (`song-settings`), that it is SENT
 * (`song-settings`), that it can be APPLIED (`wasm-resolve`), that the
 * loudness stage moves (`rust-loudness`), and that the loader finds the
 * engine (`wasm-resolve`).  None of them listens to the output.
 *
 * `rust-offline-parity` comes closest and drives only FLAT configs, asking
 * safety questions: no NaN, the ceiling holds, bypass is a pass-through.
 * So the sentence the whole fix exists to make true —
 *
 *     a module the user moved changes the file that comes out
 *
 * — was asserted nowhere.  If the suite config stopped being applied again,
 * for any of the four reasons or a fifth, the only failing check would be an
 * indirect one.  This test fails directly: `tuned` would equal `base`.
 *
 * Measured with tones rather than noise so each band is an unambiguous
 * number, and at two amplitudes to confirm the compressor and limiter are
 * not the thing being measured (they are not: the deltas are identical).
 *
 * Run via:  pnpm --filter @aimaster/desktop test:export-audio
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// The file-level half decodes through the same ffmpeg the render uses.
process.env.AIMASTER_FFMPEG =
  createRequire(import.meta.url)('ffmpeg-static') as string;

import { renderStereoBuffer } from '../src/main/offline/rust-offline-render-core.js';
import { processAudioFileRust, decodeToFloatStereo, deinterleaveStereo } from '../src/main/offline/process-audio-file-rust.js';
import type { OfflineChainConfig } from '../src/main/offline/load-mastering-chain-node.js';
import { buildChainConfig } from '../src/renderer/audio/chain-config.js';
import {
  defaultAllModulesState, ALL_MODULE_PARAMETER_DEFS,
  type AllModulesParameterState,
} from '../src/renderer/audio/parameters/index.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}

const SR = 48_000;
/** A tone in the low shelf's reach, one nothing asks about, one in the air band. */
const LOW = 60;
const MID = 1_000;
const AIR = 12_000;
const SECONDS = 4;
const N = SR * SECONDS;

function tones(amp: number): { l: Float32Array; r: Float32Array } {
  const l = new Float32Array(N);
  const r = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const v = (Math.sin((2 * Math.PI * LOW * i) / SR)
             + Math.sin((2 * Math.PI * MID * i) / SR)
             + Math.sin((2 * Math.PI * AIR * i) / SR)) / 3;
    l[i] = v * amp; r[i] = v * amp;
  }
  return { l, r };
}

/**
 * Level of one tone, in dBFS, measured over the back half of the buffer.
 *
 * A single-bin DFT rather than a window of RMS: the three tones share the
 * buffer, and RMS cannot tell which one moved.  The back half only, so the
 * chain's settling and its reported latency cannot shift the answer.
 */
function levelAt(x: Float32Array, hz: number): number {
  const from = Math.floor(x.length / 2);
  const n = x.length - from;
  let re = 0; let im = 0;
  for (let i = 0; i < n; i++) {
    const t = 2 * Math.PI * hz * (i / SR);
    re += x[from + i]! * Math.cos(t);
    im -= x[from + i]! * Math.sin(t);
  }
  return 20 * Math.log10(Math.max((2 * Math.sqrt(re * re + im * im)) / n, 1e-12));
}

/** The export config for a state, with the loudness loop off as a render does. */
function cfgFor(mut?: (s: AllModulesParameterState) => void): OfflineChainConfig {
  const state = defaultAllModulesState(ALL_MODULE_PARAMETER_DEFS);
  mut?.(state);
  const suite = buildChainConfig({ state, masterBypass: false, parametricBands: [] });
  return {
    suiteConfig: {
      ...suite,
      ...(suite.loudness ? { loudness: { ...suite.loudness, enabled: false } } : {}),
    },
  };
}
const eqMove = (lowShelfDb: number, airDb: number) => (s: AllModulesParameterState): void => {
  s.eq = { ...s.eq, bypass: false, parameters: { ...s.eq.parameters, lowShelfDb, airDb } };
};

console.log('\n=== A MOVED MODULE CHANGES THE RENDERED AUDIO ===\n');

// Two amplitudes, because the answer must be the EQ and not the dynamics.
const deltas: Record<number, Record<number, number>> = {};
for (const amp of [0.02, 0.1]) {
  const sig = tones(amp);
  const base = renderStereoBuffer(sig.l, sig.r, cfgFor(), SR);
  const tuned = renderStereoBuffer(sig.l, sig.r, cfgFor(eqMove(6, 6)), SR);
  deltas[amp] = {};
  for (const hz of [LOW, MID, AIR]) {
    deltas[amp]![hz] = levelAt(tuned.left, hz) - levelAt(base.left, hz);
  }
  const d = deltas[amp]!;
  console.log(
    `amp ${String(amp).padEnd(5)} ${LOW} Hz ${d[LOW]!.toFixed(2).padStart(6)} dB · `
    + `${MID} Hz ${d[MID]!.toFixed(2).padStart(6)} dB · ${AIR} Hz ${d[AIR]!.toFixed(2).padStart(6)} dB`,
  );
}

const d = deltas[0.1]!;
check(
  'a +6 dB low shelf raises the low tone',
  d[LOW]! > 3.5 && d[LOW]! < 6.5,
  `${d[LOW]!.toFixed(2)} dB at ${LOW} Hz (a 120 Hz corner reaches most, not all, of +6 an octave down)`,
);
check(
  'a +6 dB air shelf raises the high tone',
  d[AIR]! > 1.2 && d[AIR]! < 4.5,
  `${d[AIR]!.toFixed(2)} dB at ${AIR} Hz`,
);
check(
  'and leaves alone the tone nothing asked about',
  Math.abs(d[MID]!) < 0.3,
  `${d[MID]!.toFixed(2)} dB at ${MID} Hz`,
);
check(
  'the same move gives the same answer at a different level',
  [LOW, MID, AIR].every((hz) => Math.abs(deltas[0.02]![hz]! - deltas[0.1]![hz]!) < 0.3),
  'so what is measured is the EQ, not the compressor or the limiter',
);

// Sign, not just magnitude: a cut must cut.
{
  const sig = tones(0.1);
  const base = renderStereoBuffer(sig.l, sig.r, cfgFor(), SR);
  const cut = renderStereoBuffer(sig.l, sig.r, cfgFor(eqMove(-6, -6)), SR);
  const dl = levelAt(cut.left, LOW) - levelAt(base.left, LOW);
  const da = levelAt(cut.left, AIR) - levelAt(base.left, AIR);
  check(
    'a cut cuts, so the sign survives the trip',
    dl < -3.5 && da < -1.2,
    `${dl.toFixed(2)} dB at ${LOW} Hz, ${da.toFixed(2)} dB at ${AIR} Hz`,
  );
}

// And the module is what did it: with the module bypassed, the same numbers
// do nothing.
//
// Compared against a BYPASSED-and-flat render, not against the default one.
// The first version of this check compared bypassed-with-+6 against the
// default render and failed by 0.99 dB — correctly, because the default EQ
// is not a no-op: it carries a 32 Hz low cut and `adaptive: true`, and
// bypassing the module removes those too.  The question is whether a
// bypassed module ignores its parameters, so both sides have to be
// bypassed.
{
  const sig = tones(0.1);
  const off = renderStereoBuffer(sig.l, sig.r, cfgFor((s) => {
    s.eq = { ...s.eq, bypass: true };
  }), SR);
  const offTuned = renderStereoBuffer(sig.l, sig.r, cfgFor((s) => {
    s.eq = { ...s.eq, bypass: true, parameters: { ...s.eq.parameters, lowShelfDb: 6, airDb: 6 } };
  }), SR);
  const moved = [LOW, MID, AIR].map((hz) => Math.abs(levelAt(offTuned.left, hz) - levelAt(off.left, hz)));
  check(
    'a bypassed module ignores the numbers it is holding',
    moved.every((m) => m < 0.1),
    `largest band move ${Math.max(...moved).toFixed(3)} dB`,
  );

  // And bypassing is itself audible, which is why the comparison above had
  // to be made this way rather than against the default render.
  const base = renderStereoBuffer(sig.l, sig.r, cfgFor(), SR);
  const bypassDelta = [LOW, MID, AIR].map((hz) => levelAt(off.left, hz) - levelAt(base.left, hz));
  check(
    "bypassing the EQ is not the same as a flat EQ — it drops the module's low cut too",
    Math.max(...bypassDelta.map(Math.abs)) > 0.3,
    `${[LOW, MID, AIR].map((hz, i) => `${hz} Hz ${bypassDelta[i]!.toFixed(2)}`).join(' · ')} dB`,
  );
}

console.log('\n=== AND IT REACHES THE FILE ON DISK ===\n');

// The buffer is not what the user gets. This renders through the export
// path that writes the WAV, then decodes the WAV back and measures it.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-export-'));
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
  for (let i = 0; i < n; i++) {
    for (const v of [left[i]!, right[i]!]) {
      buf.writeIntLE(Math.round(Math.max(-1, Math.min(1, v)) * 8_388_607), o, 3);
      o += 3;
    }
  }
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
}

async function renderToFile(name: string, cfg: OfflineChainConfig, src: string): Promise<Float32Array> {
  const out = path.join(dir, name);
  // No targetLufs: a normalising render would move every band together and
  // hide the question being asked.
  await processAudioFileRust(src, cfg, { sampleRate: SR, bitDepth: 24, outputPath: out });
  const { left } = deinterleaveStereo(await decodeToFloatStereo(out, SR));
  return left;
}

async function fileHalf(): Promise<void> {
  const sig = tones(0.1);
  const src = writeWav('src.wav', sig.l, sig.r);
  const baseL = await renderToFile('base.wav', cfgFor(), src);
  const tunedL = await renderToFile('tuned.wav', cfgFor(eqMove(6, 6)), src);

  check(
    'the export wrote a file of the right length',
    Math.abs(baseL.length - N) < SR * 0.1 && baseL.length > 0,
    `${baseL.length} samples vs ${N}`,
  );

  const fd: Record<number, number> = {};
  for (const hz of [LOW, MID, AIR]) fd[hz] = levelAt(tunedL, hz) - levelAt(baseL, hz);
  console.log(
    `in the decoded WAV: ${LOW} Hz ${fd[LOW]!.toFixed(2)} dB · `
    + `${MID} Hz ${fd[MID]!.toFixed(2)} dB · ${AIR} Hz ${fd[AIR]!.toFixed(2)} dB`,
  );
  check(
    'the low shelf is in the exported file',
    fd[LOW]! > 3.5 && fd[LOW]! < 6.5,
    `${fd[LOW]!.toFixed(2)} dB at ${LOW} Hz`,
  );
  check(
    'the air shelf is in the exported file',
    fd[AIR]! > 1.2 && fd[AIR]! < 4.5,
    `${fd[AIR]!.toFixed(2)} dB at ${AIR} Hz`,
  );
  check(
    'and the untouched tone came out untouched',
    Math.abs(fd[MID]!) < 0.4,
    `${fd[MID]!.toFixed(2)} dB at ${MID} Hz (dither and 24-bit rounding live in this margin)`,
  );
  // The file and the buffer must agree, or the encoder is editing the master.
  check(
    'the file agrees with the buffer it was written from',
    [LOW, MID, AIR].every((hz) => Math.abs(fd[hz]! - deltas[0.1]![hz]!) < 0.4),
    `largest disagreement ${Math.max(...[LOW, MID, AIR].map((hz) => Math.abs(fd[hz]! - deltas[0.1]![hz]!))).toFixed(2)} dB`,
  );
}

void fileHalf()
  .then(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((e) => { console.error(e); process.exit(1); });
