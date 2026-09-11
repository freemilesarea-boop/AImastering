/**
 * run-preset-selftest — does a preset run its OWN numbers?
 *
 * `runPreset` used to build a `ModeConfig` from the preset and then throw it
 * away, calling `processMasteringWithMode(input, mode.mode)` — which looks the
 * bucket up again.  Every preset in a bucket therefore rendered identically,
 * and the adapter report said `loudness-norm: applied` while it did so.
 *
 * Measured on the seven built-in presets before the fix: SEVEN PRESETS, THREE
 * WAVEFORMS.  `warm` asked for −14 LUFS and got −12, bit-identical to
 * `balanced`.  `kpop_loud` asked for −9 at a −0.8 dB ceiling and got −8.1 at
 * −1, bit-identical to `loud`.  Not one preset's own target was honoured.
 *
 * What is asserted here is the thing that was wrong: the number in the JSON is
 * the number that comes out.  What is NOT asserted is that every preset sounds
 * different — two presets whose TS-applied fields are identical SHOULD render
 * identically, and one pair does; the test says so rather than papering over
 * it with a threshold.
 *
 * Run: pnpm --filter @aimaster/desktop test:run-preset
 */

import { readFileSync } from 'node:fs';
import { validateEnginePreset, type EnginePreset } from '@aimaster/shared-types/engine';
import { runPreset } from '../src/renderer/audio/preset/index.js';
import { presetToModeConfig } from '../src/renderer/audio/preset/from-preset.js';
import {
  MODE_CONFIGS, processMasteringWithConfig, processMasteringWithMode,
} from '../src/renderer/audio/masteringModes.js';
import { getLoudnessMetrics, type AudioBufferLike } from '../src/renderer/audio/loudnessCore.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function close(a: number, b: number, m: string, tol: number): void {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${m} — ${a.toFixed(3)} vs ${b.toFixed(3)} (±${tol})`);
}

// ── Material ────────────────────────────────────────────────────────────────

const SR = 44100;
const SECONDS = 3;

/**
 * Three seconds of something with a level that moves.
 *
 * A steady tone would be normalised by a gain and nothing else, so every
 * limiter setting would look the same; the envelope is what gives the limiter
 * something to do.
 */
function material(): AudioBufferLike {
  const n = SR * SECONDS;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  let seed = 7;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) * 2 - 1;
  };
  for (let i = 0; i < n; i++) {
    const env = 0.4 + 0.4 * Math.sin((2 * Math.PI * i) / (SR * 0.5));
    const v = env * (0.35 * Math.sin((2 * Math.PI * 220 * i) / SR)
      + 0.2 * Math.sin((2 * Math.PI * 660 * i) / SR)
      + 0.06 * rnd());
    left[i] = v;
    right[i] = v * 0.95;
  }
  return {
    sampleRate: SR, length: n, numberOfChannels: 2,
    getChannelData: (c: number): Float32Array => (c === 0 ? left : right),
  };
}

const BUILTIN = ['natural', 'balanced', 'bright', 'warm', 'loud', 'kpop_loud', 'punch'];

function load(name: string): EnginePreset {
  const raw: unknown = JSON.parse(readFileSync(
    new URL(`../../../services/python-audio/app/engine/builtin/${name}.preset.json`, import.meta.url),
    'utf8',
  ));
  const v = validateEnginePreset(raw);
  if (!v.ok || !v.preset) {
    throw new Error(`${name} failed validation: ${v.errors.map((e) => e.message).join(', ')}`);
  }
  return v.preset;
}

/** The preset's own loudness target and ceiling, straight out of the JSON. */
function asked(preset: EnginePreset): { lufs: number | null; ceiling: number | null } {
  let lufs: number | null = null;
  let ceiling: number | null = null;
  for (const node of preset.chain.nodes) {
    if (node.type === 'loudness-norm') lufs = node.targetLufs;
    if (node.type === 'limiter') ceiling = node.ceilingDb;
  }
  return { lufs, ceiling };
}

/** A cheap fingerprint of the rendered audio, for "is this the same waveform". */
function fingerprint(buffer: AudioBufferLike): string {
  const ch = buffer.getChannelData(0);
  let h = 0;
  for (let i = 0; i < ch.length; i += 997) h = ((h * 31) + Math.round((ch[i] ?? 0) * 1e6)) | 0;
  return `${ch.length}:${h}`;
}

const input = material();
const rendered = new Map<string, { lufs: number; tp: number; print: string }>();
for (const name of BUILTIN) {
  const result = runPreset(input, load(name));
  const m = getLoudnessMetrics(result.buffer);
  rendered.set(name, {
    lufs: m.integratedLufs, tp: m.truePeakDbtp, print: fingerprint(result.buffer),
  });
}

// ── The thing that was wrong ────────────────────────────────────────────────

check('every preset hits the loudness target written in its own JSON', () => {
  for (const name of BUILTIN) {
    const want = asked(load(name)).lufs;
    assert(want !== null, `${name} has a loudness-norm node`);
    const got = rendered.get(name)!.lufs;
    // A quarter of a LU: the limiter is in the path and moves the integrated
    // figure a little, so this is "it aimed here", not "it is a gain stage".
    close(got, want!, `${name} target`, 0.25);
  }
  console.log(`      (${BUILTIN.map((n) => `${n} ${rendered.get(n)!.lufs.toFixed(1)}`).join(', ')})`);
});

check('presets that ask for different loudness render differently', () => {
  // All three of these pairs share a bucket, so before the fix each pair was
  // bit-identical.  They are the whole point of the test.
  const pairs: Array<[string, string]> = [
    ['balanced', 'warm'],     // both BALANCED, −12 against −14
    ['loud', 'kpop_loud'],    // both LOUD, −10 against −9
    ['loud', 'punch'],        // both LOUD, −10 against −11
  ];
  for (const [a, b] of pairs) {
    const wantA = asked(load(a)).lufs!;
    const wantB = asked(load(b)).lufs!;
    assert(wantA !== wantB, `${a} and ${b} ask for different targets`);
    const gotA = rendered.get(a)!;
    const gotB = rendered.get(b)!;
    assert(gotA.print !== gotB.print, `${a} and ${b} rendered the identical waveform`);
    // And in the direction asked for, not merely differently.
    close(gotA.lufs - gotB.lufs, wantA - wantB, `${a} − ${b}`, 0.3);
  }
});

check('a preset does not exceed its own true-peak ceiling', () => {
  for (const name of BUILTIN) {
    const ceiling = asked(load(name)).ceiling;
    assert(ceiling !== null, `${name} has a limiter node`);
    const tp = rendered.get(name)!.tp;
    assert(tp <= ceiling! + 0.05, `${name} peaked at ${tp.toFixed(2)} over ${ceiling}`);
  }
  // kpop_loud is the only one that asks for something other than −1, so it is
  // the only one where honouring the ceiling is distinguishable at all.
  assert(asked(load('kpop_loud')).ceiling === -0.8, 'kpop_loud still asks for −0.8');
});

check('two presets the TS chain cannot tell apart render the same, and say why', () => {
  // `balanced` and `bright` have the SAME loudness target, ceiling and limiter
  // strength.  Everything that differs between them — the EQ curve, the
  // saturator, the imager — is in the noop list.  Identical output is the
  // right answer here, and the report is what makes it honest rather than a
  // coincidence.
  const a = rendered.get('balanced')!;
  const b = rendered.get('bright')!;
  assert(a.print === b.print,
    'balanced and bright differ — check whether a TS-applied field now differs');
  const report = runPreset(input, load('bright')).report;
  const noop = report.entries.filter((e) => e.status === 'noop').map((e) => e.moduleType);
  for (const type of ['adaptive-eq', 'saturator', 'stereo-imager']) {
    assert(noop.includes(type as never),
      `${type} is what makes bright bright, and the report has to admit it is skipped`);
  }
});

// ── The refactor did not move the built-in modes ────────────────────────────

check('the three built-in modes render exactly as before', () => {
  // `processMasteringWithMode` now delegates to `processMasteringWithConfig`.
  // Same config in, same samples out — bit for bit, not approximately.
  for (const mode of ['CLEAN', 'BALANCED', 'LOUD'] as const) {
    const viaName = processMasteringWithMode(input, mode);
    const viaConfig = processMasteringWithConfig(input, MODE_CONFIGS[mode]);
    assert(fingerprint(viaName.buffer) === fingerprint(viaConfig.buffer),
      `${mode} differs between the two entry points`);
    assert(viaName.mode === mode, `${mode} is reported as itself`);
  }
});

check('the config drives the run — change it and the output changes', () => {
  // The guard on the seam itself: if `processMasteringWithConfig` went back to
  // looking the bucket up, this would pass anyway unless the config is what it
  // actually reads.
  const base = MODE_CONFIGS.BALANCED;
  const quieter = { ...base, targetLufs: base.targetLufs - 4 };
  const a = processMasteringWithConfig(input, base);
  const b = processMasteringWithConfig(input, quieter);
  assert(fingerprint(a.buffer) !== fingerprint(b.buffer),
    'a different targetLufs produced the identical waveform');
  const la = getLoudnessMetrics(a.buffer).integratedLufs;
  const lb = getLoudnessMetrics(b.buffer).integratedLufs;
  close(la - lb, 4, 'the four LU it was asked to move', 0.3);
});

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== runPreset: the preset\'s own numbers ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
