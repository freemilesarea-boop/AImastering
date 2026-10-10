/**
 * parameter-reach-selftest — does every knob reach an engine?
 *
 * A panel that offers a control the engine has never heard of is worse than a
 * missing feature: the user moves it, hears nothing, and has no way to tell
 * whether the control is broken, the audio is unaffected, or they misheard.
 * The suite has 203 parameters across 25 modules and one generic panel renders
 * all of them from the definitions, so nothing about a definition says whether
 * anything is listening.
 *
 * `ParameterDef.unimplemented` says it, and this file checks the claim in both
 * directions — an undeclared parameter that reaches nothing fails, and a
 * declared one that has started working fails too.  A flag that can only be
 * added is a flag that goes stale.
 *
 * ── How a parameter is measured ─────────────────────────────────────────────
 *
 * Move it away from its default and rebuild BOTH chain configs: the flat one
 * the realtime worklet takes and the wire one the offline render takes.  If
 * neither changes, nothing downstream could behave differently.
 *
 * The trap is engagement.  `chain-config.ts` omits a module that is doing
 * nothing — a delay at 0 % mix is not worth eight comb filters — so moving its
 * delay time changes nothing, and the parameter looks dead when it is not.  An
 * earlier run of exactly this measurement forced `bypass: false` and reported
 * sixteen dead parameters on delay, reverb and top-rebuild, every one of them
 * wrong.  The rule is `engaged(m, active) = active || m.bypass`, so BYPASSING
 * the module is what forces its section into the config with every field
 * written, and that is what this does.
 *
 * Two modules are conditional on something outside their own state and get it
 * here: Match EQ does nothing without a target curve to match, and the dither
 * block is only built when the export bit depth is below the native one.
 *
 * Run:  pnpm --filter @aimaster/desktop test:parameter-reach
 */

import { buildChainConfig } from '../src/renderer/audio/chain-config.js';
import { stateToChainConfig } from '../src/renderer/audio/realtime-mastering-chain.js';
import { ALL_MODULE_PARAMETER_DEFS } from '../src/renderer/audio/parameters/module-parameter-definitions.js';
import {
  MODULE_IDS, defaultAllModulesState,
  type AllModulesParameterState, type ModuleId, type ParameterDef, type ParameterValue,
} from '../src/renderer/audio/parameters/parameter-state.js';
import { classifyParamExport } from '../src/renderer/audio/engine-bridge/export-parameter-adapter.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(cond: unknown, detail: string): void { if (!cond) throw new Error(detail); }

/** A curve for Match EQ, which is off without one. */
const MATCH_TARGET = Array.from({ length: 32 }, (_, i) => (i % 4) - 1.5);

function fingerprint(state: AllModulesParameterState): string {
  return `${JSON.stringify(stateToChainConfig(state))}`
    + `|${JSON.stringify(buildChainConfig({ state, matchTargetCurveDb: MATCH_TARGET }))}`;
}

/**
 * Somewhere else in range, measured from the value the rig actually starts
 * from — not from the definition's default, which is not the same thing once
 * the rig has overridden one (the export depth below).
 */
function elsewhere(def: ParameterDef, from: ParameterValue | undefined): ParameterValue | null {
  if (def.kind === 'number') {
    const at = typeof from === 'number' ? from : def.default;
    return at === def.max ? def.min : def.max;
  }
  if (def.kind === 'boolean') return !(typeof from === 'boolean' ? from : def.default);
  const at = typeof from === 'string' ? from : def.default;
  return def.values.find((v) => v !== at) ?? null;
}

const base = defaultAllModulesState(ALL_MODULE_PARAMETER_DEFS);
// Below the native depth, or the dither block is never built.
base.export = {
  ...base.export,
  parameters: { ...base.export.parameters, bitDepth: '16' },
};

/** Does moving this parameter change either chain config? */
function reaches(moduleId: ModuleId, def: ParameterDef): boolean {
  const moved = elsewhere(def, base[moduleId].parameters[def.id]);
  if (moved === null) return true;                 // a one-value enum moves nowhere
  // Bypassed AND not: bypassing forces the section into the config, and the
  // un-bypassed pass catches anything a module only emits when it is working.
  for (const bypass of [true, false]) {
    const reference: AllModulesParameterState = {
      ...base, [moduleId]: { ...base[moduleId], bypass },
    };
    const after: AllModulesParameterState = {
      ...base,
      [moduleId]: {
        ...base[moduleId], bypass,
        parameters: { ...base[moduleId].parameters, [def.id]: moved },
      },
    };
    if (fingerprint(after) !== fingerprint(reference)) return true;
  }
  return false;
}

/**
 * Does moving this parameter change the RENDER's chain config specifically?
 *
 * `reaches` above is satisfied by either config, which is the right question
 * for "does anything hear this at all".  `binding.status` asks a narrower
 * one — does the chain the Studio render runs on carry the value — so it
 * needs its own measure, and the two must not be conflated: 194 parameters
 * move the render config and not the preview's.
 */
function reachesRender(moduleId: ModuleId, def: ParameterDef): boolean {
  const moved = elsewhere(def, base[moduleId].parameters[def.id]);
  if (moved === null) return true;
  for (const bypass of [true, false]) {
    const reference: AllModulesParameterState = {
      ...base, [moduleId]: { ...base[moduleId], bypass },
    };
    const after: AllModulesParameterState = {
      ...base,
      [moduleId]: {
        ...base[moduleId], bypass,
        parameters: { ...base[moduleId].parameters, [def.id]: moved },
      },
    };
    const a = JSON.stringify(buildChainConfig({ state: reference, matchTargetCurveDb: MATCH_TARGET }));
    const b = JSON.stringify(buildChainConfig({ state: after, matchTargetCurveDb: MATCH_TARGET }));
    if (a !== b) return true;
  }
  return false;
}

/** Does moving it change the PREVIEW's config — i.e. can the user hear it live? */
function reachesPreview(moduleId: ModuleId, def: ParameterDef): boolean {
  const moved = elsewhere(def, base[moduleId].parameters[def.id]);
  if (moved === null) return true;
  for (const bypass of [true, false]) {
    const reference: AllModulesParameterState = {
      ...base, [moduleId]: { ...base[moduleId], bypass },
    };
    const after: AllModulesParameterState = {
      ...base,
      [moduleId]: {
        ...base[moduleId], bypass,
        parameters: { ...base[moduleId].parameters, [def.id]: moved },
      },
    };
    if (JSON.stringify(stateToChainConfig(reference)) !== JSON.stringify(stateToChainConfig(after))) return true;
  }
  return false;
}

const measured: { id: string; reaches: boolean; declared: boolean; support: string;
                  status: string; render: boolean; preview: boolean }[] = [];
for (const moduleId of MODULE_IDS) {
  const defs = ALL_MODULE_PARAMETER_DEFS[moduleId];
  if (!defs) continue;
  // The export module's parameters are decisions about the FILE — a format, a
  // sample rate, a bit depth — and only reach a chain config when they happen
  // to gate a stage, as the depth does with dither.  They are graded by
  // `classifyParamExport` instead, and the check below holds that grading
  // against this measurement.
  if (moduleId === 'export') continue;
  for (const def of defs.parameters) {
    measured.push({
      id: `${moduleId}.${def.id}`,
      reaches: reaches(moduleId, def),
      declared: def.unimplemented !== undefined,
      support: classifyParamExport(def),
      status: def.binding.status,
      render: reachesRender(moduleId, def),
      preview: reachesPreview(moduleId, def),
    });
  }
}

check('every parameter the panels offer reaches an engine, or says it does not', () => {
  const silent = measured.filter((m) => !m.reaches && !m.declared).map((m) => m.id);
  assert(silent.length === 0,
    `${silent.length} parameter(s) change neither chain config and do not say so: ${silent.join(', ')}`);
});

check('and nothing claims to be unimplemented after it starts working', () => {
  const stale = measured.filter((m) => m.reaches && m.declared).map((m) => m.id);
  assert(stale.length === 0,
    `${stale.length} parameter(s) are marked unimplemented but move the config: ${stale.join(', ')}`);
});

check('a parameter marked wired moves the config the render is built from', () => {
  // What this does NOT catch: a wrong `binding.path`.  The measure is
  // state → config, and the config is built by `chain-config.ts` reading
  // parameter IDs, not binding paths — so renaming a path to nonsense
  // leaves this green.  Tried it, to see.  What it does catch is the
  // regression that matters: a field dropped from the render's config while
  // the definition still claims the render carries it.
  const lying = measured.filter((m) => m.status === 'wired' && !m.render).map((m) => m.id);
  assert(lying.length === 0,
    `${lying.length} parameter(s) say 'wired' and move no render config: ${lying.join(', ')}`);
});

check('and nothing says pending for a value the render already carries', () => {
  // The direction this field actually failed in.  Twenty-three entries said
  // `pending`, several with notes promising "M2-full will add it", for
  // fields the Rust engine's own config structs already had and its DSP
  // already read.  `unimplemented` has been measured both ways since it was
  // introduced; `status` was asserted and nothing checked it.
  const stale = measured
    .filter((m) => m.status !== 'wired' && m.render)
    .map((m) => `${m.id} [${m.status}]`);
  assert(stale.length === 0,
    `${stale.length} parameter(s) claim the render cannot carry them, and it does: ${stale.join(', ')}`);
});

check('the sweep is actually looking at the suite', () => {
  // A measurement that measured nothing would pass both checks above.
  assert(measured.length > 150, `only ${measured.length} parameters were swept`);
  const live = measured.filter((m) => m.reaches).length;
  assert(live > measured.length * 0.9,
    `only ${live} of ${measured.length} reach an engine — the rig is probably not engaging modules`);
  console.log(`      (${live} of ${measured.length} parameters reach a chain config; `
    + `${measured.length - live} declare that nothing implements them)`);
});

check('nothing is graded preview-only that the preview chain cannot hear', () => {
  // `classifyParamExport` grades by module type: every parameter on a module
  // the realtime chain processes is "Preview only".  That is a per-module
  // answer to a per-parameter question, and the badge it draws is a promise.
  const lying = measured.filter((m) => m.support === 'preview-only' && !m.reaches).map((m) => m.id);
  assert(lying.length === 0,
    `${lying.length} parameter(s) badged "Preview only" reach neither chain config: ${lying.join(', ')}`);
});

check('an unimplemented parameter tells the user, in Korean', () => {
  const bad: string[] = [];
  for (const moduleId of MODULE_IDS) {
    for (const def of ALL_MODULE_PARAMETER_DEFS[moduleId]?.parameters ?? []) {
      if (def.unimplemented === undefined) continue;
      if (!/[가-힣]/.test(def.unimplemented) || def.unimplemented.length < 8) {
        bad.push(`${moduleId}.${def.id}`);
      }
    }
  }
  assert(bad.length === 0, `not a sentence a user can read: ${bad.join(', ')}`);
});

// What the PREVIEW can let you hear, per module.
//
// `wired` says the render carries a value; it says nothing about whether the
// user can audition it.  That difference is the real gap in this product and
// it is a number nobody had: the realtime chain carries a small fraction of
// the suite, and three modules split MID-MODULE, which is the worst case for
// a user — in the EQ panel, moving Air Gain is audible and moving Air Freq
// is not, and nothing on screen distinguishes them from a broken control.
// Printed rather than asserted: which modules the preview implements is a
// product decision, and a test that froze today's answer would fight it.
const perModule = new Map<string, { heard: number; total: number; ids: string[] }>();
for (const m of measured) {
  const moduleId = m.id.slice(0, m.id.lastIndexOf('.'));
  const row = perModule.get(moduleId) ?? { heard: 0, total: 0, ids: [] };
  row.total += 1;
  if (m.preview) { row.heard += 1; row.ids.push(m.id.slice(moduleId.length + 1)); }
  perModule.set(moduleId, row);
}
const heardTotal = measured.filter((m) => m.preview).length;
console.log(`\n      the preview chain carries ${heardTotal} of ${measured.length} parameters`);
const split = [...perModule].filter(([, r]) => r.heard > 0 && r.heard < r.total);
const silentModules = [...perModule].filter(([, r]) => r.heard === 0).map(([k]) => k);
console.log(`      ${silentModules.length} module(s) it cannot play at all: ${silentModules.join(', ')}`);
for (const [moduleId, r] of split) {
  console.log(`      ${moduleId}: ${r.heard}/${r.total} audible — ${r.ids.join(', ')}`);
}

console.log('');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
if (bad) process.exit(1);
