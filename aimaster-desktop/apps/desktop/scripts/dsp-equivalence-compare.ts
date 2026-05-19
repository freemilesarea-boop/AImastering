/**
 * dsp-equivalence-compare.ts — M1 cross-language DSP equivalence harness.
 *
 * What it does:
 *   1. For each built-in EnginePreset in services/python-audio/app/engine/builtin/,
 *      reads the same synthetic fixture WAV the Python test renders (the
 *      pytest must have run first — its metrics JSONs live under
 *      /tmp/aimaster-m1-metrics/python-*.json).
 *   2. Loads the same preset on the TS side, runs `runPreset(buffer, preset)`,
 *      writes the result to /tmp/aimaster-m1-metrics/ts-<preset>.wav.
 *   3. Measures the TS output using the SAME tool Python used (FFmpeg
 *      loudnorm pass-1) so the LUFS / TP / LRA numbers are apples-to-apples.
 *   4. Diffs Python's metrics JSON against TS's measurements per preset and
 *      writes a single equivalence-report.json.
 *
 * Usage:
 *   # 1. produce python-*.json
 *   cd aimaster-desktop/services/python-audio && pytest tests/test_engine_preset_render.py
 *   # 2. produce ts-*.json + equivalence-report.json
 *   cd aimaster-desktop && pnpm exec tsx apps/desktop/scripts/dsp-equivalence-compare.ts
 *
 * Output report shape: see writeEquivalenceReport().
 *
 * Reference: docs/redesign/loui-mastering-v2/m1/00-M1-SCOPE.md
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { validateEnginePreset, type EnginePreset } from '@aimaster/shared-types/engine';
import { runPreset } from '../src/renderer/audio/preset/index.js';
import { readWav, writeWav24 } from './lib/wav-codec.js';
import {
  crestDb,
  measureLoudness,
  rmsDb,
  THIRD_OCT_CENTRES,
  thirdOctaveSpectrumDb,
} from './lib/metrics.js';

// ── Paths ───────────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, '../../..');
const PYTHON_AUDIO_DIR = path.join(REPO_ROOT, 'services/python-audio');
const BUILTIN_PRESETS_DIR = path.join(PYTHON_AUDIO_DIR, 'app/engine/builtin');
const METRICS_DIR = '/tmp/aimaster-m1-metrics';

// The Python pytest fixture caches WAVs under /tmp/... but its complex_tone
// is generated under a pytest-managed tmp_path.  We re-generate the same
// fixture deterministically here so the harness is independent.
const FIXTURE_PATH = path.join(METRICS_DIR, 'fixture-complex-tone-20s.wav');

// ── Helpers ─────────────────────────────────────────────────────────────────

function ensureMetricsDir(): void {
  if (!fs.existsSync(METRICS_DIR)) fs.mkdirSync(METRICS_DIR, { recursive: true });
}

function ensureFixture(): void {
  if (fs.existsSync(FIXTURE_PATH)) return;
  // Generate the same complex tone the Python test uses, but to a stable path.
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  execFileSync(
    'ffmpeg',
    [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=220:duration=20',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20',
      '-f', 'lavfi', '-i', 'sine=frequency=880:duration=20',
      '-filter_complex',
      '[0:a][1:a][2:a]amix=inputs=3:duration=longest,' +
      'volume=-18dB,' +
      'channelsplit=channel_layout=stereo[L][R];' +
      '[L]apad=pad_dur=0[L1];' +
      '[R]adelay=2ms|2ms[R1];' +
      '[L1][R1]amerge=inputs=2',
      '-ac', '2', '-ar', '44100', '-acodec', 'pcm_s24le',
      FIXTURE_PATH,
    ],
    { stdio: 'inherit' },
  );
}

function listBuiltinPresetFiles(): string[] {
  if (!fs.existsSync(BUILTIN_PRESETS_DIR)) {
    throw new Error(`builtin presets dir missing: ${BUILTIN_PRESETS_DIR}`);
  }
  return fs
    .readdirSync(BUILTIN_PRESETS_DIR)
    .filter((f) => f.endsWith('.preset.json'))
    .sort();
}

function loadPreset(fileName: string): EnginePreset {
  const full = path.join(BUILTIN_PRESETS_DIR, fileName);
  const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
  const v = validateEnginePreset(raw);
  if (!v.ok || !v.preset) {
    throw new Error(
      `preset ${fileName} failed validation:\n${v.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`,
    );
  }
  return v.preset;
}

function planarFromBufferLike(buf: { numberOfChannels: number; getChannelData(c: number): Float32Array }): Float32Array[] {
  const out: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) out.push(buf.getChannelData(c));
  return out;
}

interface PerPresetMetrics {
  presetId: string;
  presetVersion: string;
  presetName: string;
  adapter: 'python' | 'ts';
  fixture: string;
  sampleRate: number;
  channels: number;
  durationSec: number;
  target: { lufs: number; tpDb: number };
  measured: {
    lufsI: number;
    tpDb: number;
    lra: number;
    rmsDb: number;
    crestDb: number;
    thirdOctSpectrumDb: Record<string, number>;
  };
  adapterReport: unknown;
}

function runTsForPreset(presetFile: string, fixture: string): {
  metrics: PerPresetMetrics;
  outputWavPath: string;
} {
  const preset = loadPreset(presetFile);
  // Use the file basename (matches Python pytest naming) so python-X.json
  // and ts-X.json can be paired by simple string equality.
  const basename = presetFile.replace(/\.preset\.json$/, '');
  const inputBuf = readWav(fixture);
  const inputCh = planarFromBufferLike(inputBuf);

  const { buffer, report } = runPreset(inputBuf, preset);
  const outCh = planarFromBufferLike(buffer);

  const outPath = path.join(METRICS_DIR, `ts-${basename}.wav`);
  writeWav24(outPath, outCh, buffer.sampleRate);

  // Measure with the same tool Python used.
  const loud = measureLoudness(outPath);
  const thirdOct = thirdOctaveSpectrumDb(outCh, buffer.sampleRate);

  void inputCh; // (kept for future input-vs-output comparisons)

  const metrics: PerPresetMetrics = {
    presetId: preset.id,
    presetVersion: preset.version,
    presetName: preset.name,
    adapter: 'ts',
    fixture: path.basename(fixture),
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
    durationSec: (buffer.length ?? outCh[0]!.length) / buffer.sampleRate,
    target: {
      lufs: (preset.chain.nodes.find((n) => n.type === 'loudness-norm') as { targetLufs: number } | undefined)
        ?.targetLufs ?? -14,
      tpDb: (preset.chain.nodes.find((n) => n.type === 'limiter') as { ceilingDb: number } | undefined)
        ?.ceilingDb ?? -1,
    },
    measured: {
      lufsI: loud.lufsI,
      tpDb: loud.tpDb,
      lra: loud.lra,
      rmsDb: rmsDb(outCh),
      crestDb: crestDb(outCh),
      thirdOctSpectrumDb: thirdOct,
    },
    adapterReport: report,
  };

  fs.writeFileSync(
    path.join(METRICS_DIR, `ts-${basename}.json`),
    JSON.stringify(metrics, null, 2),
    'utf8',
  );

  return { metrics, outputWavPath: outPath };
}

function loadPythonMetrics(baseName: string): PerPresetMetrics | null {
  const p = path.join(METRICS_DIR, `python-${baseName}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ── Equivalence report ──────────────────────────────────────────────────────

interface Diff {
  preset: string;
  lufsDelta: number;
  tpDelta: number;
  rmsDelta: number;
  crestDelta: number;
  spectrumRmsDeltaDb: number; // RMS of per-band dB diffs
  spectrumMaxDeltaDb: number;
  pythonOnlyModules: string[];
  tsOnlyModules: string[];
  bothApplied: string[];
  pythonReportEntries: unknown;
  tsReportEntries: unknown;
}

function diffPairs(python: PerPresetMetrics, ts: PerPresetMetrics): Diff {
  const lufsDelta  = ts.measured.lufsI - python.measured.lufsI;
  const tpDelta    = ts.measured.tpDb  - python.measured.tpDb;
  const rmsDelta   = ts.measured.rmsDb - python.measured.rmsDb;
  const crestDelta = ts.measured.crestDb - python.measured.crestDb;

  let sumSq = 0;
  let nBands = 0;
  let maxAbs = 0;
  for (const cf of THIRD_OCT_CENTRES) {
    const k = String(cf);
    const pyDb = python.measured.thirdOctSpectrumDb[k];
    const tsDb = ts.measured.thirdOctSpectrumDb[k];
    if (pyDb === undefined || tsDb === undefined) continue;
    if (!Number.isFinite(pyDb) || !Number.isFinite(tsDb)) continue;
    const d = tsDb - pyDb;
    sumSq += d * d;
    nBands++;
    if (Math.abs(d) > maxAbs) maxAbs = Math.abs(d);
  }
  const spectrumRmsDeltaDb = nBands === 0 ? 0 : Math.sqrt(sumSq / nBands);
  const spectrumMaxDeltaDb = maxAbs;

  // Module reports — gather noop / applied buckets per side.
  const pyEntries = (python.adapterReport as { entries?: Array<{ moduleType: string; status: string }> }).entries ?? [];
  const tsEntries = (ts.adapterReport     as { entries?: Array<{ moduleType: string; status: string }> }).entries ?? [];

  const pyApplied = new Set(pyEntries.filter((e) => e.status === 'applied').map((e) => e.moduleType));
  const tsApplied = new Set(tsEntries.filter((e) => e.status === 'applied').map((e) => e.moduleType));
  const pythonOnly = [...pyApplied].filter((m) => !tsApplied.has(m)).sort();
  const tsOnly = [...tsApplied].filter((m) => !pyApplied.has(m)).sort();
  const both = [...pyApplied].filter((m) => tsApplied.has(m)).sort();

  return {
    preset: python.presetName,
    lufsDelta,
    tpDelta,
    rmsDelta,
    crestDelta,
    spectrumRmsDeltaDb,
    spectrumMaxDeltaDb,
    pythonOnlyModules: pythonOnly,
    tsOnlyModules: tsOnly,
    bothApplied: both,
    pythonReportEntries: pyEntries,
    tsReportEntries: tsEntries,
  };
}

function fmt(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return 'n/a';
  return n.toFixed(digits);
}

function writeEquivalenceReport(diffs: Diff[]): void {
  const out = {
    schema: 'loui.m1.equivalence-report.v1',
    createdAt: new Date().toISOString(),
    fixture: path.basename(FIXTURE_PATH),
    aggregate: {
      maxLufsDelta: Math.max(...diffs.map((d) => Math.abs(d.lufsDelta))),
      maxTpDelta:   Math.max(...diffs.map((d) => Math.abs(d.tpDelta))),
      maxRmsDelta:  Math.max(...diffs.map((d) => Math.abs(d.rmsDelta))),
      maxSpectrumRmsDb: Math.max(...diffs.map((d) => d.spectrumRmsDeltaDb)),
      maxSpectrumPeakDb: Math.max(...diffs.map((d) => d.spectrumMaxDeltaDb)),
    },
    perPreset: diffs,
  };
  fs.writeFileSync(
    path.join(METRICS_DIR, 'equivalence-report.json'),
    JSON.stringify(out, null, 2),
    'utf8',
  );
}

// ── Main ────────────────────────────────────────────────────────────────────

function main(): void {
  ensureMetricsDir();
  ensureFixture();

  const presetFiles = listBuiltinPresetFiles();
  const diffs: Diff[] = [];
  let processed = 0;
  let missingPython = 0;

  console.log(`\nM1 equivalence harness — ${presetFiles.length} presets, fixture=${path.basename(FIXTURE_PATH)}\n`);
  console.log('─'.repeat(108));
  console.log(
    'preset            | Δ LUFS-I  Δ TP     Δ RMS    Δ Crest   spec ΔRMS  spec ΔMax  | py-only / ts-only modules',
  );
  console.log('─'.repeat(108));

  for (const f of presetFiles) {
    const baseName = f.replace(/\.preset\.json$/, '');
    const tsResult = runTsForPreset(f, FIXTURE_PATH);
    processed++;

    const pyMetrics = loadPythonMetrics(baseName);
    if (!pyMetrics) {
      missingPython++;
      console.log(
        `${baseName.padEnd(17)} |  (python metrics missing — run pytest tests/test_engine_preset_render.py first)`,
      );
      continue;
    }

    const d = diffPairs(pyMetrics, tsResult.metrics);
    diffs.push(d);
    console.log(
      `${baseName.padEnd(17)} | ` +
        `${fmt(d.lufsDelta, 2).padStart(7)}  ` +
        `${fmt(d.tpDelta, 2).padStart(7)}  ` +
        `${fmt(d.rmsDelta, 2).padStart(7)}  ` +
        `${fmt(d.crestDelta, 2).padStart(7)}  ` +
        `${fmt(d.spectrumRmsDeltaDb, 2).padStart(8)}  ` +
        `${fmt(d.spectrumMaxDeltaDb, 2).padStart(8)}  | ` +
        `py:${d.pythonOnlyModules.length} ts:${d.tsOnlyModules.length}`,
    );
  }

  console.log('─'.repeat(108));
  if (diffs.length > 0) {
    writeEquivalenceReport(diffs);
    console.log(`\nReport: ${path.join(METRICS_DIR, 'equivalence-report.json')}`);
    console.log(
      `Aggregate (max |delta|): ` +
        `LUFS=${fmt(Math.max(...diffs.map((d) => Math.abs(d.lufsDelta))))}  ` +
        `TP=${fmt(Math.max(...diffs.map((d) => Math.abs(d.tpDelta))))}  ` +
        `RMS=${fmt(Math.max(...diffs.map((d) => Math.abs(d.rmsDelta))))}  ` +
        `spec ΔMax=${fmt(Math.max(...diffs.map((d) => d.spectrumMaxDeltaDb)))} dB`,
    );
  }
  console.log(`\nProcessed: ${processed}, with python metrics: ${diffs.length}, missing: ${missingPython}\n`);
}

main();
