// Glossary self-test — every control explains itself, in Korean.
//
// This app has two audiences that cannot be separated into two builds: the
// engineer who knows what a ratio is, and the learner who does not. The
// panel serves both by showing the English term, the Korean name and one
// plain sentence — and that only works if EVERY control has all three. One
// untranslated row is the row a beginner gets stuck on.
//
// Coverage cannot be eyeballed: there are 203 parameters and adding a
// module adds more. So it is a test. Adding a parameter without a glossary
// entry fails the build, which is the only way a translation layer stays
// complete after the day it was written.
//
// Run:  pnpm --filter @aimaster/desktop test:glossary

import {
  ALL_MODULE_PARAMETER_DEFS,
  MODULE_IDS,
  type ModuleId,
} from '../src/renderer/audio/parameters/index.js';
import {
  MODULE_GLOSSARY,
  GLOSSARY_KEYS,
  glossaryFor,
  stripBandPrefix,
} from '../src/renderer/audio/parameters/parameter-glossary.js';
import { LOUI_MODULES } from '../src/renderer/audio/modules/loui-module-suite.js';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    passed++;
    console.log(`[PASS] ${name} — ${detail}`);
  } else {
    failed++;
    console.error(`[FAIL] ${name} — ${detail}`);
  }
}

console.log('\n=== GLOSSARY — every control is explained ===\n');

{
  const missing: string[] = [];
  let covered = 0;
  for (const id of MODULE_IDS) {
    for (const p of ALL_MODULE_PARAMETER_DEFS[id].parameters) {
      if (glossaryFor(id, p.id)) covered += 1;
      else missing.push(`${id}.${p.id}`);
    }
  }
  check(
    'every parameter has a Korean name and a plain sentence',
    missing.length === 0,
    missing.length === 0
      ? `${covered} parameters covered`
      : `${missing.length} missing: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? '…' : ''}`,
  );
}

{
  const missing = MODULE_IDS.filter((id) => !MODULE_GLOSSARY[id]);
  check(
    'every module has a Korean name and a plain sentence',
    missing.length === 0,
    missing.length === 0 ? `${MODULE_IDS.length} modules` : missing.join(', '),
  );
}

{
  // A key nothing reads is a translation that will drift out of step with
  // the parameter it was written for, unnoticed.
  const used = new Set<string>();
  for (const id of MODULE_IDS) {
    for (const p of ALL_MODULE_PARAMETER_DEFS[id].parameters) {
      used.add(`${id}.${stripBandPrefix(p.id)}`);
    }
  }
  const orphans = GLOSSARY_KEYS.filter((k) => !used.has(k));
  check(
    'no glossary entry is orphaned',
    orphans.length === 0,
    orphans.length === 0 ? `${GLOSSARY_KEYS.length} keys all in use` : orphans.join(', '),
  );
}

{
  // Band-repeated parameters must collapse, or the glossary would need
  // sixty entries to say the same thing six times.
  const cases: Array<[string, string]> = [
    ['band0ThresholdDb', 'thresholdDb'],
    ['band5ReleaseMs', 'releaseMs'],
    ['band2Pct', 'pct'],
    ['crossover1Hz', 'crossover1Hz'],
    ['widthPct', 'widthPct'],
    // `bandLowPct` is not a numbered band — the prefix rule must not eat it.
    ['bandLowPct', 'bandLowPct'],
  ];
  const wrong = cases.filter(([input, want]) => stripBandPrefix(input) !== want);
  check(
    'the band prefix collapses only numbered bands',
    wrong.length === 0,
    wrong.length === 0
      ? cases.map(([a, b]) => `${a}→${b}`).join(' · ')
      : wrong.map(([a, b]) => `${a} gave ${stripBandPrefix(a)}, wanted ${b}`).join(', '),
  );
}

{
  // The whole point is plain language.  A "plain" sentence that is one word
  // long, or that just repeats the English term, helps nobody.
  const thin: string[] = [];
  for (const id of MODULE_IDS) {
    for (const p of ALL_MODULE_PARAMETER_DEFS[id].parameters) {
      const g = glossaryFor(id, p.id);
      if (!g) continue;
      if (g.plain.length < 12 || g.ko.length === 0) thin.push(`${id}.${p.id}`);
    }
  }
  check(
    'no explanation is a placeholder',
    thin.length === 0,
    thin.length === 0 ? 'all substantive' : thin.slice(0, 6).join(', '),
  );
}

{
  // Every live rack row should be able to name itself in Korean.
  const live = LOUI_MODULES.filter((m) => m.status === 'live' && m.paramModuleId);
  const unnamed = live.filter((m) => !MODULE_GLOSSARY[m.paramModuleId as ModuleId]);
  check(
    'every live rack row resolves a Korean name',
    unnamed.length === 0,
    unnamed.length === 0 ? `${live.length} rows` : unnamed.map((m) => m.id).join(', '),
  );
}

// ── Every module draws something ─────────────────────────────────────────
//
// "Show me what it is doing" is not a nice-to-have in a tool used by people
// who cannot read a parameter name and picture the result. A module with no
// display is a module they cannot learn from, so coverage is a test rather
// than an intention.

console.log('\n=== VISUALS — every module has a display ===\n');

{
  const { GRAPH_EQ_MODULES } = require('../src/renderer/audio/modules/eq-graph-model.js') as
    typeof import('../src/renderer/audio/modules/eq-graph-model.js');
  const { buildDynamicsGraph } = require('../src/renderer/audio/modules/dynamics-graph-model.js') as
    typeof import('../src/renderer/audio/modules/dynamics-graph-model.js');
  const { RESTORATION_VIEW_MODULES } = require(
    '../src/renderer/components/product/modules/LouiRestorationViews.js',
  ) as typeof import('../src/renderer/components/product/modules/LouiRestorationViews.js');
  const { TONE_DYN_VIEW_MODULES } = require(
    '../src/renderer/components/product/modules/LouiToneDynamicsViews.js',
  ) as typeof import('../src/renderer/components/product/modules/LouiToneDynamicsViews.js');
  const { CHARACTER_VIEW_MODULES } = require(
    '../src/renderer/components/product/modules/LouiCharacterViews.js',
  ) as typeof import('../src/renderer/components/product/modules/LouiCharacterViews.js');

  const hasView = (id: ModuleId): boolean =>
    GRAPH_EQ_MODULES.has(id)
    || RESTORATION_VIEW_MODULES.has(id)
    || TONE_DYN_VIEW_MODULES.has(id)
    || CHARACTER_VIEW_MODULES.has(id)
    || buildDynamicsGraph(id, ALL_MODULE_PARAMETER_DEFS[id].parameters.reduce(
      (acc, p) => ({ ...acc, [p.id]: p.kind === 'number' ? p.default : p.default }), {},
    )) !== null;

  const blind = MODULE_IDS.filter((id) => !hasView(id));
  check(
    'every module in the rack draws something',
    blind.length === 0,
    blind.length === 0 ? `${MODULE_IDS.length} modules covered` : `no display: ${blind.join(', ')}`,
  );
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
