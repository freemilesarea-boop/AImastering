/**
 * dsp-equivalence-realmusic.ts — M1.5 cross-language harness on real-music
 * fixtures (synthesized multitrack mixes + AI-harsh defect pattern).
 *
 * Prerequisite:
 *   The Python tests must run first to materialise the fixture WAVs and
 *   produce python-*.json metric files:
 *     cd aimaster-desktop/services/python-audio
 *     pytest tests/test_engine_preset_realmusic.py
 *
 * Then:
 *   cd aimaster-desktop
 *   pnpm exec tsx apps/desktop/scripts/dsp-equivalence-realmusic.ts
 *
 * Output:
 *   /tmp/aimaster-m1.5-metrics/ts-<fixture>__<preset>.json     (per pair)
 *   /tmp/aimaster-m1.5-metrics/equivalence-report-realmusic.json
 *
 * Reference: docs/redesign/loui-mastering-v2/m1.5/03-M1.5-EXECUTION-REPORT.md
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { validateEnginePreset, type EnginePreset } from '@aimaster/shared-types/engine';
import { validateFixture, type FixtureMetadata } from '@aimaster/shared-types/fixtures';
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
const PY_AUDIO_DIR = path.join(REPO_ROOT, 'services/python-audio');
const PRESETS_DIR = path.join(PY_AUDIO_DIR, 'app/engine/builtin');
const FIXTURES_DIR = path.join(PY_AUDIO_DIR, 'app/fixtures/recipes');
const FIXTURE_CACHE = process.env.LOUI_FIXTURE_CACHE ?? '/tmp/aimaster-fixtures';
const METRICS_DIR = '/tmp/aimaster-m1.5-metrics';

if (!fs.existsSync(METRICS_DIR)) fs.mkdirSync(METRICS_DIR, { recursive: true });

// ── Loaders ─────────────────────────────────────────────────────────────────

function loadJson(p: string): unknown {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function loadFixture(name: string): FixtureMetadata {
  const fp = path.join(FIXTURES_DIR, `${name}.fixture.json`);
  const v = validateFixture(loadJson(fp));
  if (!v.ok || !v.fixture) {
    throw new Error(`fixture ${name} invalid:\n${v.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`);
  }
  return v.fixture;
}

function loadPreset(presetId: string): EnginePreset {
  const baseName = presetId.replace(/^builtin-/, '').replace(/-/g, '_');
  const fp = path.join(PRESETS_DIR, `${baseName}.preset.json`);
  const v = validateEnginePreset(loadJson(fp));
  if (!v.ok || !v.preset) {
    throw new Error(`preset ${presetId} invalid:\n${v.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`);
  }
  return v.preset;
}

function listFixtureRecipes(): string[] {
  return fs.readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.fixture.json'))
    .map((f) => f.replace(/\.fixture\.json$/, ''))
    .sort();
}

// ── Per-pair runner ─────────────────────────────────────────────────────────

function planarFromBufferLike(b: { numberOfChannels: number; getChannelData(c: number): Float32Array }): Float32Array[] {
  const ch: Float32Array[] = [];
  for (let i = 0; i < b.numberOfChannels; i++) ch.push(b.getChannelData(i));
  return ch;
}

interface TsMetrics {
  fixtureId: string;
  fixtureCategory: string;
  presetId: string;
  presetName: string;
  isRecommendedPair: boolean;
  sampleRate: number;
  channels: number;
  durationSec: number;
  target: { lufsI: number; tpMaxDb: number; lraMinLu: number; lraMaxLu: number };
  measured: { lufsI: number; tpDb: number; lra: number; rmsDb: number; crestDb: number; thirdOctSpectrumDb: Record<string, number> };
  deltas: { lufsDelta: number; tpHeadroomDb: number };
  adapterReport: unknown;
}

function runPair(fixture: FixtureMetadata, preset: EnginePreset): TsMetrics {
  const wavPath = path.join(FIXTURE_CACHE, `${fixture.id}.wav`);
  if (!fs.existsSync(wavPath)) {
    throw new Error(
      `fixture WAV missing: ${wavPath}\nRun the Python test first to materialise: ` +
      `cd ${PY_AUDIO_DIR} && pytest tests/test_engine_preset_realmusic.py`,
    );
  }
  const buf = readWav(wavPath);
  const { buffer, report } = runPreset(buf, preset);
  const ch = planarFromBufferLike(buffer);

  const fixtureBase = fixture.id;
  const presetBase = preset.id.replace(/^builtin-/, '').replace(/-/g, '_');
  const outPath = path.join(METRICS_DIR, `ts-${fixtureBase}__${presetBase}.wav`);
  writeWav24(outPath, ch, buffer.sampleRate);

  const loud = measureLoudness(outPath);
  const target = fixture.referenceMaster.targetMetrics;

  const metrics: TsMetrics = {
    fixtureId: fixture.id,
    fixtureCategory: fixture.category,
    presetId: preset.id,
    presetName: preset.name,
    isRecommendedPair: fixture.recommendedPresetId === preset.id,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
    durationSec: (buffer.length ?? ch[0]!.length) / buffer.sampleRate,
    target: {
      lufsI: target.lufsI,
      tpMaxDb: target.tpMaxDb,
      lraMinLu: target.lraMinLu,
      lraMaxLu: target.lraMaxLu,
    },
    measured: {
      lufsI: loud.lufsI,
      tpDb: loud.tpDb,
      lra: loud.lra,
      rmsDb: rmsDb(ch),
      crestDb: crestDb(ch),
      thirdOctSpectrumDb: thirdOctaveSpectrumDb(ch, buffer.sampleRate),
    },
    deltas: {
      lufsDelta: loud.lufsI - target.lufsI,
      tpHeadroomDb: target.tpMaxDb - loud.tpDb,
    },
    adapterReport: report,
  };

  const jsonPath = path.join(METRICS_DIR, `ts-${fixtureBase}__${presetBase}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(metrics, null, 2), 'utf8');
  return metrics;
}

// ── Cross-language diff ─────────────────────────────────────────────────────

interface Diff {
  fixture: string;
  preset: string;
  category: string;
  python: { lufs: number; tp: number; lra: number; rms: number };
  ts:     { lufs: number; tp: number; lra: number; rms: number };
  delta:  { lufs: number; tp: number; lra: number; rms: number };
  spec:   { rmsDb: number; maxDb: number };
  policyHits: {
    pythonInLufsTol: boolean;
    tsInLufsTol: boolean;
    pythonInLra: boolean;
    tsInLra: boolean;
  };
}

function fmt(n: number, d = 2): string {
  return Number.isFinite(n) ? n.toFixed(d) : 'n/a';
}

function loadPythonMetrics(fixtureBase: string, presetBase: string): TsMetrics | null {
  const p = path.join(METRICS_DIR, `python-${fixtureBase}__${presetBase}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function diffPair(fixture: FixtureMetadata, py: TsMetrics, ts: TsMetrics): Diff {
  let sumSq = 0;
  let nBands = 0;
  let maxAbs = 0;
  for (const cf of THIRD_OCT_CENTRES) {
    const k = String(cf);
    const a = py.measured.thirdOctSpectrumDb[k];
    const b = ts.measured.thirdOctSpectrumDb[k];
    if (a === undefined || b === undefined) continue;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const d = b - a;
    sumSq += d * d;
    nBands++;
    if (Math.abs(d) > maxAbs) maxAbs = Math.abs(d);
  }
  const tgt = fixture.referenceMaster.targetMetrics;
  const tol = fixture.policy.lufsToleranceLu;
  return {
    fixture: fixture.id,
    preset: ts.presetName,
    category: fixture.category,
    python: { lufs: py.measured.lufsI, tp: py.measured.tpDb, lra: py.measured.lra, rms: py.measured.rmsDb },
    ts:     { lufs: ts.measured.lufsI, tp: ts.measured.tpDb, lra: ts.measured.lra, rms: ts.measured.rmsDb },
    delta:  {
      lufs: ts.measured.lufsI - py.measured.lufsI,
      tp:   ts.measured.tpDb  - py.measured.tpDb,
      lra:  ts.measured.lra   - py.measured.lra,
      rms:  ts.measured.rmsDb - py.measured.rmsDb,
    },
    spec: {
      rmsDb: nBands === 0 ? 0 : Math.sqrt(sumSq / nBands),
      maxDb: maxAbs,
    },
    policyHits: {
      pythonInLufsTol: Math.abs(py.measured.lufsI - tgt.lufsI) <= tol,
      tsInLufsTol:     Math.abs(ts.measured.lufsI - tgt.lufsI) <= tol,
      pythonInLra:     py.measured.lra >= tgt.lraMinLu && py.measured.lra <= tgt.lraMaxLu,
      tsInLra:         ts.measured.lra >= tgt.lraMinLu && ts.measured.lra <= tgt.lraMaxLu,
    },
  };
}

function writeReport(diffs: Diff[]): string {
  const report = {
    schema: 'loui.m1.5.equivalence-report.v1',
    createdAt: new Date().toISOString(),
    aggregate: {
      maxLufsDelta:    Math.max(...diffs.map((d) => Math.abs(d.delta.lufs))),
      maxTpDelta:      Math.max(...diffs.map((d) => Math.abs(d.delta.tp))),
      maxLraDelta:     Math.max(...diffs.map((d) => Math.abs(d.delta.lra))),
      maxRmsDelta:     Math.max(...diffs.map((d) => Math.abs(d.delta.rms))),
      maxSpectrumRmsDb: Math.max(...diffs.map((d) => d.spec.rmsDb)),
      maxSpectrumMaxDb: Math.max(...diffs.map((d) => d.spec.maxDb)),
      pythonPolicyPassRate: diffs.filter((d) => d.policyHits.pythonInLufsTol).length / diffs.length,
      tsPolicyPassRate:     diffs.filter((d) => d.policyHits.tsInLufsTol).length / diffs.length,
    },
    perPair: diffs,
  };
  const p = path.join(METRICS_DIR, 'equivalence-report-realmusic.json');
  fs.writeFileSync(p, JSON.stringify(report, null, 2), 'utf8');
  return p;
}

// ── Main ────────────────────────────────────────────────────────────────────

function main(): void {
  const fullMatrix = process.env.LOUI_FULL_MATRIX === '1';
  const fixtureNames = listFixtureRecipes();
  const allPresets = fs.readdirSync(PRESETS_DIR)
    .filter((f) => f.endsWith('.preset.json'))
    .map((f) => f.replace(/\.preset\.json$/, ''))
    .sort();

  console.log(
    `\nM1.5 real-music equivalence harness — ` +
    `${fixtureNames.length} fixtures${fullMatrix ? ` × ${allPresets.length} presets` : ' (recommended pairs only)'}\n`,
  );

  const diffs: Diff[] = [];
  let processed = 0;
  let missingPy = 0;

  console.log('─'.repeat(122));
  console.log(
    'fixture × preset                                  Py LUFS  TS LUFS  Δ LUFS   Δ TP    Δ LRA   spec ΔRMS  py-pol  ts-pol',
  );
  console.log('─'.repeat(122));

  for (const fxName of fixtureNames) {
    const fixture = loadFixture(fxName);
    const presetsToRun = fullMatrix ? allPresets : [
      fixture.recommendedPresetId.replace(/^builtin-/, '').replace(/-/g, '_'),
    ];

    for (const psName of presetsToRun) {
      const preset = loadPreset(`builtin-${psName.replace(/_/g, '-')}`);
      const ts = runPair(fixture, preset);
      processed++;

      const pyBase = preset.id.replace(/^builtin-/, '').replace(/-/g, '_');
      const py = loadPythonMetrics(fxName, pyBase);
      if (!py) {
        missingPy++;
        console.log(`${(fxName + ' × ' + psName).padEnd(49)}  (no python metrics — run pytest first)`);
        continue;
      }
      const d = diffPair(fixture, py, ts);
      diffs.push(d);
      const label = `${fxName} × ${psName}`;
      console.log(
        `${label.padEnd(49)} ${fmt(d.python.lufs).padStart(7)} ${fmt(d.ts.lufs).padStart(7)} ` +
        `${fmt(d.delta.lufs).padStart(7)} ${fmt(d.delta.tp).padStart(6)} ${fmt(d.delta.lra).padStart(7)} ` +
        `${fmt(d.spec.rmsDb).padStart(9)}  ` +
        `${(d.policyHits.pythonInLufsTol ? '✓' : '✗').padStart(5)}   ` +
        `${(d.policyHits.tsInLufsTol ? '✓' : '✗').padStart(4)}`,
      );
    }
  }

  console.log('─'.repeat(122));
  if (diffs.length > 0) {
    const out = writeReport(diffs);
    console.log(`\nReport: ${out}`);
    console.log(
      `Aggregate: max ΔLUFS=${fmt(Math.max(...diffs.map((d) => Math.abs(d.delta.lufs))))}  ` +
      `max ΔTP=${fmt(Math.max(...diffs.map((d) => Math.abs(d.delta.tp))))}  ` +
      `max ΔLRA=${fmt(Math.max(...diffs.map((d) => Math.abs(d.delta.lra))))}  ` +
      `max spec ΔMax=${fmt(Math.max(...diffs.map((d) => d.spec.maxDb)))} dB`,
    );
    console.log(
      `Policy hit rate (LUFS tolerance): python=${(diffs.filter((d) => d.policyHits.pythonInLufsTol).length / diffs.length * 100).toFixed(0)}%  ` +
      `ts=${(diffs.filter((d) => d.policyHits.tsInLufsTol).length / diffs.length * 100).toFixed(0)}%`,
    );
  }
  console.log(`\nProcessed: ${processed}, with python metrics: ${diffs.length}, missing: ${missingPy}\n`);
}

main();
