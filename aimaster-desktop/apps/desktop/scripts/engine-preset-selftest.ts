// engine-preset-selftest — two validators, one contract, 82 ways to break it.
//
// An EnginePreset file is read by two hand-written validators:
//
//   packages/shared-types/src/engine/validate.ts   (TS renderer / dsp path)
//   services/python-audio/app/engine/validate.py   (Python engine)
//
// The Python one opened with "Mirrors the rules in
// packages/shared-types/src/engine/validate.ts so the adapters agree on what
// counts as a valid preset."  Nothing checked that.  Running both over the
// seven shipped presets and 75 mutations of them found ELEVEN disagreements in
// six rules — each one a preset that one half of the engine would run and the
// other would refuse:
//
//   · `id`, `version` and `compatibility.engineApiMin` with a trailing
//     newline passed Python and failed TS.  Python's `$` also matches before
//     a final newline, so `re.match(r"^\d+\.\d+\.\d+$", "1.0.0\n")` succeeds
//     where the JavaScript regex does not.  Python now uses `fullmatch`.
//   · `policies.limiterStrength` had NO rule on the TS side, while every
//     shipped preset sets it and the Python adapter translates it into
//     per-limiter overrides.  `limiterStrength: 'ludicrous'` was a valid
//     preset to TS and an invalid one to Python.
//   · An `adaptive-eq` band with no `id`, a `dynamic-eq` or `multiband-eq`
//     with its `bands` key missing, and a `multiband-eq` band with `q: 50`
//     were all accepted by Python.  `node.get("bands", [])` turned a preset
//     that had forgotten its bands into a module that silently does nothing.
//
// And two of the seventeen module types — `multiband-eq` and `dither` —
// appear in no shipped preset at all, so their rules were exercised by
// nothing.  The cases below build a host preset for them.
//
// This needs python3, because the other half of the contract is written in
// Python and reading it as text is what let the claim stand for this long.
//
// Run: pnpm --filter @aimaster/desktop test:engine-preset

export {};

import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { validateEnginePreset } from '@aimaster/shared-types/engine';
import { ENGINE_MODULE_ORDER } from '@aimaster/shared-types/engine';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

type Obj = Record<string, unknown>;
const BUILTIN = '../../services/python-audio/app/engine/builtin';
const PY_ROOT = path.resolve('../../services/python-audio');

const files = readdirSync(BUILTIN).filter((f) => f.endsWith('.preset.json')).sort();
const shipped: { file: string; preset: Obj }[] = files.map((f) => ({
  file: f, preset: JSON.parse(readFileSync(path.join(BUILTIN, f), 'utf8')) as Obj,
}));
const base = shipped.find((s) => s.preset['id'] === 'builtin-balanced')?.preset
  ?? shipped[0]?.preset ?? {};

interface Case {
  name: string;
  preset: unknown;
  /** What BOTH validators must say. */
  expect: 'ok' | 'reject';
  /** The JSON pointer the rejection must name, when it is worth pinning. */
  atPath?: string;
  /** Module type this case exercises, for the coverage check. */
  module?: string;
}
const cases: Case[] = [];

const nodesOf = (p: Obj): Obj[] => (p['chain'] as Obj)['nodes'] as Obj[];
const indexOf = (p: Obj, type: string): number => nodesOf(p).findIndex((n) => n['type'] === type);

/** Deep copy with one value replaced; `undefined` deletes the key. */
function withChange(src: Obj, pointer: string, value: unknown): Obj {
  const copy = JSON.parse(JSON.stringify(src)) as Obj;
  const parts = pointer.split('/').filter(Boolean);
  let cur: Record<string | number, unknown> = copy as Record<string | number, unknown>;
  for (const part of parts.slice(0, -1)) {
    cur = cur[/^\d+$/.test(part) ? Number(part) : part] as Record<string | number, unknown>;
  }
  const last = parts[parts.length - 1] ?? '';
  const key = /^\d+$/.test(last) ? Number(last) : last;
  if (value === undefined) delete cur[key]; else cur[key] = value;
  return copy;
}

/**
 * Module types no shipped preset uses.  Built here so their rules are
 * exercised at all — and so the host itself is asserted valid first, which is
 * what makes a rejection below attributable to the mutation.
 */
const SYNTHETIC: Record<string, Obj> = {
  'multiband-eq': {
    type: 'multiband-eq', id: 'mbeq', bands: [
      { id: 'low', centreHz: 90, q: 0.7, gainDb: 1 },
      { id: 'mid', centreHz: 900, q: 0.9, gainDb: -1 },
      { id: 'vocal', centreHz: 3000, q: 1.1, gainDb: 0.5 },
      { id: 'high', centreHz: 9000, q: 0.8, gainDb: 1.5 },
    ],
  },
  dither: { type: 'dither', id: 'dith', bitDepth: 24 },
};

const synthesised = new Set<string>();
function hostFor(type: string): Obj | null {
  const found = shipped.find((s) => indexOf(s.preset, type) >= 0);
  if (found) return found.preset;
  const module = SYNTHETIC[type];
  if (!module) return null;
  const host = JSON.parse(JSON.stringify(base)) as Obj;
  const nodes = nodesOf(host);
  nodes.splice(nodes.length - 1, 0, JSON.parse(JSON.stringify(module)) as Obj);
  host['id'] = `synthetic-${type.replace(/[^a-z]/g, '')}`;
  if (!synthesised.has(type)) {
    synthesised.add(type);
    cases.push({
      name: `a preset using ${type} — which nothing ships — is valid`,
      preset: JSON.parse(JSON.stringify(host)), expect: 'ok', module: type,
    });
  }
  return host;
}

/** A mutation of the whole preset. */
const top = (name: string, pointer: string, value: unknown, atPath = pointer): void => {
  cases.push({ name, preset: withChange(base, pointer, value), expect: 'reject', atPath });
};
/** A mutation inside one module, hosted by a preset that has it. */
function inModule(type: string, field: string, value: unknown, name: string, atField = field): void {
  const host = hostFor(type);
  if (host === null) {
    cases.push({ name: `${name} — NO HOST FOR ${type}`, preset: null, expect: 'reject', module: type });
    return;
  }
  const i = indexOf(host, type);
  cases.push({
    name: `${name} (${type})`,
    preset: withChange(host, `/chain/nodes/${i}/${field}`, value),
    expect: 'reject', atPath: `/chain/nodes/${i}/${atField}`, module: type,
  });
}

// ── The cases ───────────────────────────────────────────────────────────────

for (const { file, preset } of shipped) {
  cases.push({ name: `shipped: ${file}`, preset, expect: 'ok' });
}

// Identity and compatibility.  The three newline cases are the ones Python's
// `$` used to let through.
top('$schema from another project', '/$schema', 'https://example.com/other');
top('id of one character', '/id', 'a');
top('id with a space and a bang', '/id', 'bad id!');
top('id with a trailing newline', '/id', 'builtin-balanced\n');
top('id missing', '/id', undefined);
top('version with two parts', '/version', '1.0');
top('version with a trailing newline', '/version', '1.0.0\n');
top('name empty', '/name', '');
top('name a number', '/name', 42);
top('compatibility missing', '/compatibility', undefined, '/compatibility/engineApiMin');
top('engineApiMin not semver', '/compatibility/engineApiMin', 'v1');
top('engineApiMin with a trailing newline', '/compatibility/engineApiMin', '1.0.0\n');
top('meta an array', '/meta', []);

// Policies — where limiterStrength had no rule on the TS side at all.
top('policies missing', '/policies', undefined, '/policies');
top('vocalProtection invented', '/policies/vocalProtection', 'paranoid');
top('safeMode invented', '/policies/safeMode', 'maybe');
top('aiCorrections a string', '/policies/aiCorrections', 'yes');
top('limiterStrength invented', '/policies/limiterStrength', 'ludicrous');
top('limiterStrength a number', '/policies/limiterStrength', 3);

// Output.
top('sampleRate off by one', '/output/sampleRate', 44101);
top('sampleRate as a string', '/output/sampleRate', '48000');
top('bitDepth 8', '/output/bitDepth', 8);
top('format ogg', '/output/format', 'ogg');
top('output missing', '/output', undefined, '/output');

// Chain shape.
top('chain missing', '/chain', undefined, '/chain/nodes');
top('nodes not an array', '/chain/nodes', {}, '/chain/nodes');
top('nodes empty', '/chain/nodes', [], '/chain/nodes');
cases.push({
  name: 'a chain of one node', expect: 'reject', atPath: '/chain/nodes',
  preset: (() => { const o = JSON.parse(JSON.stringify(base)) as Obj;
    (o['chain'] as Obj)['nodes'] = [nodesOf(o)[0]]; return o; })(),
});
cases.push({
  name: 'a chain that does not start at the source', expect: 'reject', atPath: '/chain/nodes/0/type',
  preset: (() => { const o = JSON.parse(JSON.stringify(base)) as Obj; nodesOf(o).shift(); return o; })(),
});
cases.push({
  name: 'a chain that does not end at the sink', expect: 'reject',
  preset: (() => { const o = JSON.parse(JSON.stringify(base)) as Obj; nodesOf(o).pop(); return o; })(),
});
cases.push({
  name: 'two nodes with the same id', expect: 'reject', atPath: '/chain/nodes/1/id',
  preset: (() => { const o = JSON.parse(JSON.stringify(base)) as Obj;
    const n = nodesOf(o); n[1]!['id'] = n[0]!['id']; return o; })(),
});
top('a module type from the future', '/chain/nodes/1/type', 'time-machine', '/chain/nodes/1/type');
top('a module with no id', '/chain/nodes/1/id', undefined, '/chain/nodes/1/id');
top('a module id of one punctuation mark', '/chain/nodes/1/id', '!', '/chain/nodes/1/id');

// Per-module rules.  Each is hosted by a preset that actually has the module.
inModule('adaptive-eq', 'bands', [], 'no bands at all');
inModule('adaptive-eq', 'bands/0/id', undefined, 'a band with no id', 'bands/0/id');
inModule('adaptive-eq', 'bands/0/id', 7, 'a band whose id is a number', 'bands/0/id');
inModule('adaptive-eq', 'bands/0/filterType', 'notch', 'a filterType nothing implements', 'bands/0/filterType');
inModule('adaptive-eq', 'bands/0/freqHz', 0, 'a band at 0 Hz', 'bands/0/freqHz');
inModule('adaptive-eq', 'bands/0/freqHz', '1000', 'a frequency as a string', 'bands/0/freqHz');
inModule('adaptive-eq', 'bands/0/gainDb', 25, 'a band 25 dB up', 'bands/0/gainDb');
inModule('dynamic-eq', 'bands', undefined, 'the bands key removed');
inModule('dynamic-eq', 'intensity', 3, 'intensity past 2');
inModule('dynamic-eq', 'intensity', undefined, 'intensity missing');
inModule('dynamic-eq', 'bands/0/q', 50, 'a Q of 50', 'bands/0/q');
inModule('dynamic-eq', 'bands/0/mode', 'duck', 'a mode that is neither cut nor boost', 'bands/0/mode');
inModule('dynamic-eq', 'bands/0/thresholdDb', 3, 'a threshold above 0 dB', 'bands/0/thresholdDb');
inModule('multiband-eq', 'bands', undefined, 'the bands key removed');
inModule('multiband-eq', 'bands/0/id', 'air', 'a band id outside low|mid|vocal|high', 'bands/0/id');
inModule('multiband-eq', 'bands/0/q', 50, 'a Q of 50', 'bands/0/q');
inModule('multiband-eq', 'bands/0/q', undefined, 'no Q at all', 'bands/0/q');
inModule('multiband-eq', 'bands/0/centreHz', 10, 'a centre below 20 Hz', 'bands/0/centreHz');
inModule('multiband-eq', 'bands/0/gainDb', 13, '13 dB of gain', 'bands/0/gainDb');
inModule('bus-comp', 'ratio', 25, 'a ratio of 25:1');
inModule('bus-comp', 'attackMs', 0, 'a zero attack');
inModule('bus-comp', 'releaseMs', 6000, 'a six-second release');
inModule('bus-comp', 'kneeDb', -1, 'a negative knee');
inModule('bus-comp', 'makeupDb', undefined, 'makeup missing');
inModule('saturator', 'amount', 1.5, 'more than all of it');
inModule('stereo-imager', 'width', 5, 'five times wide');
inModule('deesser', 'freqHz', 500, 'a de-esser at 500 Hz');
inModule('deesser', 'reductionDb', 20, '20 dB of de-essing');
inModule('loudness-norm', 'targetLufs', -40, 'a target of -40 LUFS');
inModule('loudness-norm', 'targetTpDb', 1, 'a true peak above 0');
inModule('loudness-norm', 'targetLra', 0, 'an LRA of 0');
inModule('limiter', 'ceilingDb', -7, 'a ceiling of -7 dB');
inModule('isp-safety', 'ceilingDbtp', 0.5, 'an ISP ceiling above 0');
inModule('dither', 'bitDepth', 8, '8-bit dither');

// Fields both sides treat as optional: these must stay VALID on both.
{
  const host = hostFor('loudness-norm');
  if (host) {
    const i = indexOf(host, 'loudness-norm');
    cases.push({
      name: 'targetLra is optional, and stays optional on both sides',
      preset: withChange(host, `/chain/nodes/${i}/targetLra`, undefined),
      expect: 'ok', module: 'loudness-norm',
    });
  }
  cases.push({
    name: 'meta is optional', preset: withChange(base, '/meta', undefined), expect: 'ok',
  });
  cases.push({
    name: 'policies may be empty', preset: withChange(base, '/policies', {}), expect: 'ok',
  });
}

// ── Run both validators over every case ─────────────────────────────────────

interface Verdict { ok: boolean; firstPath: string; count: number }

function tsVerdict(preset: unknown): Verdict {
  const r = validateEnginePreset(preset);
  return { ok: r.ok, firstPath: r.errors[0]?.path ?? '', count: r.errors.length };
}

/** The Python validator's verdict for every case, in one subprocess. */
function pythonVerdicts(presets: unknown[]): { verdicts: Verdict[]; error: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aimaster-preset-'));
  const input = path.join(dir, 'cases.json');
  writeFileSync(input, JSON.stringify(presets));
  const program = `
import json, sys
sys.path.insert(0, ${JSON.stringify(PY_ROOT)})
from app.engine.validate import validate_preset
out = []
for p in json.load(open(${JSON.stringify(input)})):
    errs = validate_preset(p)
    out.append({"ok": not errs, "firstPath": errs[0]["path"] if errs else "", "count": len(errs)})
sys.stdout.write(json.dumps(out))
`;
  // `-I` so nothing is imported from the CWD or a user site-packages: the
  // cases file sits in a temp directory and the validator must be the repo's.
  const r = spawnSync('python3', ['-I', '-c', program], { encoding: 'utf8', timeout: 120_000 });
  rmSync(dir, { recursive: true, force: true });
  if (r.error || r.status !== 0) {
    return {
      verdicts: [],
      error: `python3 exited ${String(r.status)}: ${(r.stderr ?? String(r.error)).trim().slice(-400)}`,
    };
  }
  try {
    return { verdicts: JSON.parse(r.stdout ?? '') as Verdict[], error: '' };
  } catch (err) {
    return { verdicts: [], error: `could not read python output: ${String(err)}` };
  }
}

function main(): void {
  console.log('\n=== EnginePreset: two validators, one contract ===\n');

  const missingHost = cases.filter((c) => c.preset === null);
  check(
    'every case has a preset to mutate',
    missingHost.length === 0,
    missingHost.length === 0
      ? `${cases.length} cases over ${shipped.length} shipped presets`
      : missingHost.map((c) => c.name).join('; '),
  );
  const runnable = cases.filter((c) => c.preset !== null);

  // ── The TS side, case by case ─────────────────────────────────────────
  {
    const ship = runnable.filter((c) => c.name.startsWith('shipped:'));
    const bad = ship.filter((c) => !tsVerdict(c.preset).ok);
    check(
      'every preset the app ships validates',
      ship.length === shipped.length && bad.length === 0,
      bad.length === 0
        ? ship.map((c) => c.name.replace('shipped: ', '')).join(', ')
        : bad.map((c) => `${c.name}: ${tsVerdict(c.preset).firstPath}`).join('; '),
    );
  }
  {
    const optional = runnable.filter((c) => c.expect === 'ok' && !c.name.startsWith('shipped:'));
    const bad = optional.filter((c) => !tsVerdict(c.preset).ok);
    check(
      'and what the schema calls optional really is',
      optional.length >= 4 && bad.length === 0,
      bad.length === 0
        ? `${optional.length} cases: ${optional.map((c) => c.name).join('; ').slice(0, 110)}`
        : bad.map((c) => `${c.name} → ${tsVerdict(c.preset).firstPath}`).join('; '),
    );
  }

  const groups: [string, (c: Case) => boolean][] = [
    ['identity and compatibility', (c) => /\/(\$schema|id|name|version|compatibility|meta)$/.test(c.atPath ?? '')],
    ['policies', (c) => (c.atPath ?? '').startsWith('/policies')],
    ['output', (c) => (c.atPath ?? '').startsWith('/output')],
    ['chain shape', (c) => (c.atPath ?? '').startsWith('/chain') && c.module === undefined],
    ['module parameters', (c) => c.module !== undefined],
  ];
  for (const [label, belongs] of groups) {
    const group = runnable.filter((c) => c.expect === 'reject' && belongs(c));
    const wrong = group.filter((c) => {
      const v = tsVerdict(c.preset);
      if (v.ok) return true;
      return c.atPath !== undefined && v.firstPath !== c.atPath;
    });
    check(
      `${label}: every mutation is refused, at the field that is wrong`,
      group.length > 0 && wrong.length === 0,
      wrong.length === 0
        ? `${group.length} mutations`
        : wrong.map((c) => {
          const v = tsVerdict(c.preset);
          return `"${c.name}" → ${v.ok ? 'ACCEPTED' : `error at ${v.firstPath}, expected ${String(c.atPath)}`}`;
        }).join('; '),
    );
  }
  {
    // A rejection has to say where.  An empty path is a validator that knows
    // something is wrong and cannot tell you what.
    const pathless = runnable.filter((c) => c.expect === 'reject')
      .filter((c) => { const v = tsVerdict(c.preset); return !v.ok && v.firstPath === ''; });
    check(
      'and names a field rather than just saying no',
      pathless.length === 0,
      pathless.length === 0 ? 'every rejection carries a JSON pointer' : pathless.map((c) => c.name).join('; '),
    );
  }

  // ── Both sides, on the same cases ─────────────────────────────────────
  const { verdicts, error } = pythonVerdicts(runnable.map((c) => c.preset));
  check(
    'the Python validator can be reached and read these cases',
    error === '' && verdicts.length === runnable.length,
    error === ''
      ? `python3 answered for ${verdicts.length} cases`
      : `${error}\n       (python3 is required: the other half of this contract is validate.py)`,
  );
  if (error === '' && verdicts.length === runnable.length) {
    const disagreed: string[] = [];
    runnable.forEach((c, i) => {
      const ts = tsVerdict(c.preset);
      const py = verdicts[i]!;
      if (ts.ok !== py.ok) {
        disagreed.push(`"${c.name}": TS ${ts.ok ? 'accepts' : 'refuses'} / PY ${py.ok ? 'accepts' : 'refuses'}`);
      }
    });
    check(
      'and the two agree on every one of them',
      disagreed.length === 0,
      disagreed.length === 0
        ? `${runnable.length} cases, no disagreement`
        : `${disagreed.length} disagreement(s): ${disagreed.join(' | ').slice(0, 400)}`,
    );

    // Not decoration: agreeing to refuse while pointing at different fields is
    // how two error messages about the same preset send two people to two
    // different places.  A missing `compatibility` object was reported at
    // `/compatibility` here and at `/compatibility/engineApiMin` in Python —
    // a field inside an object that does not exist.
    const pointerMismatch = runnable
      .map((c, i) => ({ c, ts: tsVerdict(c.preset), py: verdicts[i]! }))
      .filter(({ ts, py }) => !ts.ok && !py.ok && ts.firstPath !== py.firstPath);
    check(
      'and point at the same field when they refuse',
      pointerMismatch.length === 0,
      pointerMismatch.length === 0
        ? 'same JSON pointer on both sides, every rejection'
        : pointerMismatch
          .map(({ c, ts, py }) => `"${c.name}": ts=${ts.firstPath} py=${py.firstPath}`)
          .join('; ').slice(0, 320),
    );
  }

  // ── Coverage: no module type left unexercised ─────────────────────────
  {
    const exercised = new Set(cases.map((c) => c.module).filter((m): m is string => m !== undefined));
    // source and sink carry no parameters of their own — the chain-shape cases
    // are what cover them.
    const expected = ENGINE_MODULE_ORDER.filter(
      (t) => !['source', 'sink', 'gain-staging', 'transient-protection', 'vocal-enhancer', 'soft-clip'].includes(t),
    );
    const uncovered = expected.filter((t) => !exercised.has(t));
    check(
      'every module type with parameters has a case',
      uncovered.length === 0,
      uncovered.length === 0
        ? `${expected.length} parameterised types, plus 4 with no parameters and source/sink`
        : `no case for ${uncovered.join(', ')}`,
    );
    check(
      'including the two no shipped preset uses',
      synthesised.has('multiband-eq') && synthesised.has('dither'),
      `built a host for ${[...synthesised].join(' and ')}`,
    );
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

main();
