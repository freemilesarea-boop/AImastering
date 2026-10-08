/**
 * parameter-grid-selftest — a control must be able to hold the value it is given.
 *
 * `LouiSliderRow` renders a native `<input type="range">` with the
 * definition's `min`, `max` and `step` passed straight through.  Such a
 * control's reachable values are `min + n*step` — the grid is anchored at
 * `min`, not at zero.  Nothing checked that the values the product actually
 * puts into these controls are ON that grid, and four separate places were
 * off it:
 *
 *   • `dynamics.attackMs` was declared [0.1 .. 100 / 0.5], so its grid ran
 *     0.1, 0.6, 1.1, 2.1 ... — no round attack time on it, and not its own
 *     default of 10.  Measured in the running app over CDP: setting the
 *     slider to 10 left it holding 10.1, stepUp gave 10.6 and stepDown 9.6,
 *     so 10 ms was not reachable at all.  All fourteen shipped presets
 *     (4, 5, 8, 10, 12, 14, 16, 18, 28 ms) were off-grid too.
 *   • `eq.lowCutQ`, `eq.lowShelfQ`, `eq.airQ` default to 0.707 — Butterworth
 *     — on a 0.01 grid from 0.3, which holds 0.70 and 0.71 and nothing
 *     between.
 *   • the imager's four per-band widths were step 5 while `widthPct`, the
 *     same unit over the same range in the same module, is step 1 — and
 *     `ai-vocal-texture` asks for 78 % and 92 %.
 *
 * The shape of the bug is always the same: the control and the value
 * disagree from the first paint, and one nudge throws the value away.  So
 * this file checks the grid, not the range — `adaptive-defaults-selftest`
 * already checks that values are between min and max, and every one of the
 * above was comfortably in range.
 *
 * Run via:
 *   pnpm --filter @aimaster/desktop test:parameter-grid
 */

import { ALL_MODULE_PARAMETER_DEFS } from '../src/renderer/audio/parameters/module-parameter-definitions.js';
import { SUITE_PARAMETER_DEFS } from '../src/renderer/audio/parameters/suite-parameter-definitions.js';
import { LOUI_PRESETS } from '../src/renderer/audio/presets/loui-presets.js';
import { RECOMMENDED } from '../src/renderer/audio/presets/recommended-defaults.js';
import { presetApplyPlan } from '../src/renderer/audio/presets/preset-to-state.js';
import { validateParameterValue } from '../src/renderer/audio/parameters/engine-command.js';
import type { ParameterDef } from '../src/renderer/audio/parameters/parameter-state.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e: unknown) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

/**
 * Is `v` a value the control can hold?
 *
 * The tolerance is 1e-6 rather than exact equality because `min + n*step`
 * is binary floating point: 0.3 + 407*0.001 is 0.7070000000000001, and a
 * check that called that off-grid would be testing IEEE 754, not the
 * definitions.
 */
function onGrid(v: number, min: number, step: number): boolean {
  if (step <= 0) return true;
  const n = (v - min) / step;
  return Math.abs(n - Math.round(n)) < 1e-6;
}

const BUNDLES: [string, Record<string, { moduleId: string; parameters: readonly ParameterDef[] }>][] = [
  ['module', ALL_MODULE_PARAMETER_DEFS as never],
  ['suite', SUITE_PARAMETER_DEFS as never],
];

function numericDefs(): Array<[string, string, ParameterDef & { kind: 'number' }]> {
  const out: Array<[string, string, ParameterDef & { kind: 'number' }]> = [];
  for (const [bundle, defs] of BUNDLES) {
    for (const mod of Object.values(defs)) {
      for (const d of mod.parameters) {
        if (d.kind === 'number') out.push([bundle, mod.moduleId, d]);
      }
    }
  }
  return out;
}

check('every parameter can be set to its own default', () => {
  const defs = numericDefs();
  assert(defs.length > 100, `only ${defs.length} numeric parameters found — the sweep is not looking at the definitions`);
  const bad = defs
    .filter(([, , d]) => !onGrid(Number(d.default), d.min, d.step))
    .map(([b, m, d]) => `${b}:${m}.${d.id} default=${String(d.default)} is not on min+n*step [${d.min}../${d.step}]`);
  assert(bad.length === 0, `${bad.length} default(s) a control cannot hold:\n  ${bad.join('\n  ')}`);
});

check('every parameter can be set to its own maximum', () => {
  // The slider's top end is `max`, but a grid from `min` only reaches it if
  // `max - min` divides by `step`.  Where it does not, the control stops
  // short of the range the definition advertises.
  const bad = numericDefs()
    .filter(([, , d]) => !onGrid(d.max, d.min, d.step))
    .map(([b, m, d]) => `${b}:${m}.${d.id} max=${d.max} unreachable from min=${d.min} by step=${d.step}`);
  assert(bad.length === 0, `${bad.length} maximum(s) out of reach:\n  ${bad.join('\n  ')}`);
});

check('every value a shipped preset asks for is a value the control can hold', () => {
  const bad: string[] = [];
  let writes = 0;
  for (const preset of LOUI_PRESETS) {
    for (const e of presetApplyPlan(preset).parameters) {
      const d = ALL_MODULE_PARAMETER_DEFS[e.moduleId]?.parameters.find((x) => x.id === e.parameterId);
      if (d === undefined || d.kind !== 'number') continue;
      writes += 1;
      if (!onGrid(Number(e.value), d.min, d.step)) {
        bad.push(`${preset.id}: ${e.moduleId}.${e.parameterId}=${String(e.value)} off [${d.min}../${d.step}]`);
      }
    }
  }
  assert(writes > 100, `only ${writes} numeric preset writes seen — the presets are not being read`);
  assert(bad.length === 0,
    `${bad.length} preset value(s) the slider would snap away from:\n  ${bad.join('\n  ')}`);
});

check('every value the Recommended button would apply is one the control can hold', () => {
  // The other way a value the user did not type gets into these controls:
  // StudioPage's `applyRecommended`.  `adaptive-defaults-selftest` checks
  // these are in range; being in range is what every one of the four
  // off-grid cases above already was.
  const bad: string[] = [];
  let seen = 0;
  for (const [moduleId, entry] of Object.entries(RECOMMENDED)) {
    const defs = ALL_MODULE_PARAMETER_DEFS[moduleId as keyof typeof ALL_MODULE_PARAMETER_DEFS];
    if (defs === undefined) continue;
    for (const [parameterId, value] of Object.entries(entry.parameters)) {
      const d = defs.parameters.find((x) => x.id === parameterId);
      if (d === undefined || d.kind !== 'number' || typeof value !== 'number') continue;
      seen += 1;
      if (!onGrid(value, d.min, d.step)) {
        bad.push(`${moduleId}.${parameterId}=${value} off [${d.min}../${d.step}]`);
      }
    }
  }
  assert(seen > 50, `only ${seen} recommended numeric values seen — the table is not being read`);
  assert(bad.length === 0,
    `${bad.length} recommended value(s) the slider would snap away from:\n  ${bad.join('\n  ')}`);
});

check('the validator does not invent a correction for a value already on the grid', () => {
  // The regression this guards: `Math.round(v/step)*step` is not `v` even
  // when `v` is on the grid — 1.4/0.1 is 13.999999999999998 — so comparing
  // the product against the candidate reported 1837 of these as `clamped`,
  // and the UI this feeds says "you tried 1.4 dB; we clamped it to 1.4 dB".
  let checked = 0;
  const bad: string[] = [];
  for (const [bundle, moduleId, d] of numericDefs()) {
    if (d.step <= 0) continue;
    const steps = Math.round((d.max - d.min) / d.step);
    for (let i = 0; i <= steps; i += 1) {
      const v = Number((d.min + i * d.step).toPrecision(12));
      if (v > d.max) continue;
      checked += 1;
      const r = validateParameterValue(d, v);
      if (r.status !== 'ok' && bad.length < 8) {
        bad.push(`${bundle}:${moduleId}.${d.id} ${v} -> ${JSON.stringify(r)}`);
      }
    }
  }
  assert(checked > 100000, `only ${checked} on-grid values swept — expected the whole definition space`);
  assert(bad.length === 0, `on-grid values the validator corrected:\n  ${bad.join('\n  ')}`);
});

check('a value a hair off the grid is the same value, not a correction', () => {
  // The check above feeds clean decimals, and `snapToGrid` hands those back
  // unchanged — so an exact `!==` comparison passes it.  Breaking the fix
  // proved as much: reverting the tolerance left all six checks green.
  // This is the case the tolerance is actually for.  A parameter value
  // round-trips through state, JSON and drag arithmetic, and comes back as
  // 0.1 + 0.2 = 0.30000000000000004.  Reporting that as a correction tells
  // the user we changed a value we did not change.
  const d = ALL_MODULE_PARAMETER_DEFS.eq.parameters.find((x) => x.id === 'presenceDb');
  if (d === undefined || d.kind !== 'number') throw new Error('eq.presenceDb not found');
  for (const candidate of [1.4000000000000001, 0.1 + 0.2]) {
    const r = validateParameterValue(d, candidate);
    assert(r.status === 'ok',
      `${candidate} differs from the grid by ~1e-16 and is the same value, `
      + `but the validator reported ${JSON.stringify(r)}`);
  }
  // And the value it settles on is the clean decimal, so state does not
  // accumulate 1.4000000000000001 across edits.
  const clean = validateParameterValue(d, 1.4000000000000001);
  assert(clean.status === 'ok' && Object.is(clean.value, 1.4),
    `expected the stored value to be exactly 1.4, got ${JSON.stringify(clean)}`);
});

check('the validator snaps to the grid the control uses, not to multiples of step', () => {
  // A definition whose `min` is not a multiple of `step`.  Deliberately
  // synthetic: the one real parameter shaped like this has been fixed, and
  // the next one should trip the checks above rather than reach here — but
  // if it does reach here, the quantiser must agree with the slider.
  const def: ParameterDef = {
    kind: 'number', id: 'probe', label: 'Probe',
    min: 0.1, max: 100, default: 0.1, step: 0.5,
    binding: { moduleType: null, path: 'probe', status: 'unavailable' },
  } as ParameterDef;
  const onSlider = validateParameterValue(def, 0.6);
  assert(onSlider.status === 'ok',
    `0.6 is min+1*step and the slider can produce it, but the validator said ${JSON.stringify(onSlider)}`);
  const offSlider = validateParameterValue(def, 0.7);
  assert(offSlider.status === 'clamped' && Math.abs(Number(offSlider.to) - 0.6) < 1e-9,
    `0.7 is off the slider's grid and should snap to 0.6, got ${JSON.stringify(offSlider)}`);
});

check('a value outside the range is still reported as out-of-range, not quantised', () => {
  // The tolerance added above must not swallow a real clamp.
  const d = ALL_MODULE_PARAMETER_DEFS.dynamics.parameters.find((x) => x.id === 'thresholdDb');
  if (d === undefined || d.kind !== 'number') throw new Error('dynamics.thresholdDb not found');
  const r = validateParameterValue(d, -500);
  assert(r.status === 'clamped' && r.reason === 'out-of-range' && Number(r.to) === d.min,
    `-500 dB should clamp to ${d.min} as out-of-range, got ${JSON.stringify(r)}`);
  const rejected = validateParameterValue(d, Number.NaN);
  assert(rejected.status === 'rejected', `NaN should be rejected, got ${JSON.stringify(rejected)}`);
});

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.pass ? '' : `\n       ${r.detail}`}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
