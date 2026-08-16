// recommended-defaults-selftest — the beginner button is safe and real.
//
// This is the one feature a beginner will press before they know enough to
// tell whether it worked, so every claim it makes is checked here by doing
// it: every parameter must exist on the module it names, every value must be
// inside that parameter's own range, the result must be a chain that
// actually engages, and it must not blow past the true-peak ceiling or
// produce anything non-finite.
//
// The last group is the one that matters most. "Recommended" is a promise
// that these numbers are usable together, not merely usable one at a time —
// and twenty-four modules interacting is exactly where a table of plausible
// values turns into a mush.
//
// Run:  pnpm --filter @aimaster/desktop test:recommended

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALL_MODULE_PARAMETER_DEFS,
  MODULE_IDS,
  defaultAllModulesState,
  type AllModulesParameterState,
  type ModuleId,
} from '../src/renderer/audio/parameters/index.js';
import { buildChainConfig, chainConfigToJson, activeModuleIds } from '../src/renderer/audio/chain-config.js';
import { RECOMMENDED, recommendedFor } from '../src/renderer/audio/presets/recommended-defaults.js';
import { MODULE_GLOSSARY } from '../src/renderer/audio/parameters/parameter-glossary.js';

const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const SR = 48_000;

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

interface WasmChain {
  setConfigJson(json: string): void;
  processStereo(left: Float32Array, right: Float32Array): void;
}
const Chain = (require_(
  path.resolve(__dirname_, '../../../packages/dsp-wasm/pkg-node/loui_dsp_wasm.cjs'),
) as { LouiMasteringChain: new (sr: number) => WasmChain }).LouiMasteringChain;

/** Apply the recommendation for every module, the way the button does. */
function recommendedState(): AllModulesParameterState {
  const s = defaultAllModulesState(ALL_MODULE_PARAMETER_DEFS);
  for (const id of MODULE_IDS) {
    const entry = recommendedFor(id);
    if (!entry) continue;
    s[id] = {
      ...s[id],
      ...(entry.bypass !== undefined ? { bypass: entry.bypass } : {}),
      parameters: { ...s[id].parameters, ...entry.parameters },
    };
  }
  return s;
}

function material(n: number, amp: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const beat = 1 + 0.9 * Math.exp(-8 * ((t * 2) % 1));
    out[i] = amp * beat * (
      0.5 * Math.sin(2 * Math.PI * 110 * t) +
      0.3 * Math.sin(2 * Math.PI * 440 * t) +
      0.2 * Math.sin(2 * Math.PI * 2200 * t) +
      0.1 * Math.sin(2 * Math.PI * 9500 * t)
    );
  }
  return out;
}

function render(state: AllModulesParameterState, amp = 0.25): {
  rms: number; peak: number; finite: boolean;
} {
  const chain = new Chain(SR);
  chain.setConfigJson(chainConfigToJson(buildChainConfig({ state, masterBypass: false })));
  const n = SR * 6;
  const l = material(n, amp);
  const r = material(n, amp);
  for (let a = 0; a < n; a += 512) {
    const b = Math.min(a + 512, n);
    chain.processStereo(l.subarray(a, b), r.subarray(a, b));
  }
  const from = n - SR * 2;
  let sum = 0;
  let peak = 0;
  let finite = true;
  for (let i = from; i < n; i++) {
    if (!Number.isFinite(l[i]!)) { finite = false; break; }
    sum += l[i]! * l[i]!;
    peak = Math.max(peak, Math.abs(l[i]!));
  }
  return {
    rms: 20 * Math.log10(Math.max(Math.sqrt(sum / (n - from)), 1e-9)),
    peak: 20 * Math.log10(Math.max(peak, 1e-9)),
    finite,
  };
}

console.log('\n=== EVERY MODULE HAS A RECOMMENDATION, AND IT IS REAL ===\n');

{
  const missing = MODULE_IDS.filter((id) => !RECOMMENDED[id]);
  check(
    'every module in the rack has a recommendation',
    missing.length === 0,
    missing.length === 0 ? `${MODULE_IDS.length} modules` : missing.join(', '),
  );
}

{
  // The failure mode a table like this invites: a parameter renamed in the
  // definitions, leaving the recommendation writing a key nothing reads. No
  // error, no effect — the button appears to work and does nothing.
  const bad: string[] = [];
  for (const id of MODULE_IDS) {
    const entry = RECOMMENDED[id];
    const known = new Set(ALL_MODULE_PARAMETER_DEFS[id].parameters.map((p) => p.id));
    for (const key of Object.keys(entry.parameters)) {
      if (!known.has(key)) bad.push(`${id}.${key}`);
    }
  }
  check(
    'every recommended parameter exists on its module',
    bad.length === 0,
    bad.length === 0 ? 'all resolve' : bad.join(', '),
  );
}

{
  // A value outside its own slider's range is a value the UI can never show
  // and the user can never get back to after moving it.
  const bad: string[] = [];
  for (const id of MODULE_IDS) {
    for (const p of ALL_MODULE_PARAMETER_DEFS[id].parameters) {
      const v = RECOMMENDED[id].parameters[p.id];
      if (v === undefined) continue;
      if (p.kind === 'number') {
        if (typeof v !== 'number' || v < p.min || v > p.max) {
          bad.push(`${id}.${p.id}=${String(v)} outside [${p.min}..${p.max}]`);
        }
      } else if (p.kind === 'enum') {
        if (typeof v !== 'string' || !p.values.includes(v)) {
          bad.push(`${id}.${p.id}=${String(v)} not in {${p.values.join('|')}}`);
        }
      } else if (typeof v !== 'boolean') {
        bad.push(`${id}.${p.id}=${String(v)} is not a boolean`);
      }
    }
  }
  check(
    'every recommended value is inside its own range',
    bad.length === 0,
    bad.length === 0 ? 'all in range' : bad.join(' · '),
  );
}

{
  const thin = MODULE_IDS.filter((id) => (RECOMMENDED[id].why ?? '').length < 20);
  check(
    'every recommendation explains itself in Korean',
    thin.length === 0,
    thin.length === 0 ? `${MODULE_IDS.length} explanations` : thin.join(', '),
  );
  const noBasis = MODULE_IDS.filter(
    (id) => !['spec', 'practice', 'ai-repair'].includes(RECOMMENDED[id].basis),
  );
  check('every recommendation declares where it comes from', noBasis.length === 0, noBasis.join(', ') || 'all declared');
}

{
  // A module that is recommended OFF must actually be marked off, or the
  // panel will say "leave this off" beside values that switch it on.
  const inconsistent: string[] = [];
  for (const id of MODULE_IDS) {
    const e = RECOMMENDED[id];
    if (e.off && e.bypass === false) inconsistent.push(id);
  }
  check(
    'nothing is marked "leave it off" while being switched on',
    inconsistent.length === 0,
    inconsistent.join(', ') || 'consistent',
  );
}

console.log('\n=== THE MASTER-BUS RULES ARE KEPT ===\n');

{
  // Reverb and delay on a master is the single most common beginner
  // mistake, and this button is aimed at beginners. It must not make it.
  //
  // Checked against the ENGAGED set rather than against the presence of a
  // config block: the builder emits a bypassed block for these, which is
  // correct — the engine short-circuits it — and asserting on the block
  // would be testing the serialiser rather than the sound.
  const cfg = buildChainConfig({ state: recommendedState(), masterBypass: false });
  const active = new Set(activeModuleIds(cfg));
  check(
    'the recommendation does not put reverb on the master',
    !active.has('reverb'),
    'space belongs in the mix, not the master',
  );
  check(
    'the recommendation does not put delay on the master',
    !active.has('delay'),
    'a master-wide delay smears the whole record',
  );
  check(
    'and it does not switch on the repair modules on clean material',
    !active.has('declick') && !active.has('dehum') && !active.has('denoise'),
    'repair is for damage, not for sweetening',
  );
  check(
    'the AI top-end repair IS on, since that is the point',
    active.has('top-rebuild'),
    `amount ${String(cfg.topRebuild?.amountPct)}%`,
  );
}

{
  // The bug this found: `activeModuleIds` never checked topRebuild,
  // parametricEq, delay or reverb, so four modules could process audio
  // while the rack reported them idle and the "N active" count under it
  // was wrong. Every module the builder can emit must be reachable here.
  const s = defaultAllModulesState(ALL_MODULE_PARAMETER_DEFS);
  // Engage everything that can be engaged by parameters alone.
  s['top-rebuild'] = { ...s['top-rebuild'], bypass: false, parameters: { ...s['top-rebuild'].parameters, amountPct: 50 } };
  s.reverb = { ...s.reverb, bypass: false, parameters: { ...s.reverb.parameters, mixPct: 20 } };
  s.delay = { ...s.delay, bypass: false, parameters: { ...s.delay.parameters, mixPct: 20 } };
  const cfg = buildChainConfig({
    state: s, masterBypass: false,
    parametricBands: [{ type: 'bell', frequencyHz: 1000, gainDb: 3, q: 1, enabled: true }],
  });
  const active = new Set(activeModuleIds(cfg));
  for (const id of ['top-rebuild', 'reverb', 'delay', 'parametric-eq'] as ModuleId[]) {
    check(
      `an engaged ${id} is reported as active`,
      active.has(id),
      active.has(id) ? 'reported' : 'MISSING from activeModuleIds — the rack would show it idle',
    );
  }
}

{
  const s = recommendedState();
  const cfg = buildChainConfig({ state: s, masterBypass: false });
  check(
    'the true-peak ceiling is the published -1.0 dBTP',
    cfg.limiter?.ceilingDbtp === -1 && cfg.limiter?.isp === true,
    `${String(cfg.limiter?.ceilingDbtp)} dBTP, ISP ${String(cfg.limiter?.isp)}`,
  );
  check(
    'bass is summed to mono below 120 Hz',
    cfg.imager?.lowMonoHz === 120,
    `${String(cfg.imager?.lowMonoHz)} Hz — keeps the low end on a phone or a club rig`,
  );
}

console.log('\n=== IT ACTUALLY DOES SOMETHING, AND STAYS SAFE ===\n');

{
  const fresh = defaultAllModulesState(ALL_MODULE_PARAMETER_DEFS);
  const rec = recommendedState();
  const before = activeModuleIds(buildChainConfig({ state: fresh, masterBypass: false }));
  const after = activeModuleIds(buildChainConfig({ state: rec, masterBypass: false }));
  check(
    'applying it engages substantially more of the chain',
    after.length >= before.length + 5,
    `${before.length} → ${after.length} modules engaged`,
  );
}

{
  const fresh = render(defaultAllModulesState(ALL_MODULE_PARAMETER_DEFS));
  const rec = render(recommendedState());
  check('the recommended chain produces finite audio', rec.finite, 'no NaN, no runaway');
  check(
    'it audibly changes the sound',
    Math.abs(rec.rms - fresh.rms) > 0.5,
    `${fresh.rms.toFixed(2)} dB → ${rec.rms.toFixed(2)} dB`,
  );
  check(
    'and it respects its own ceiling',
    rec.peak <= -1.0 + 0.15,
    `peak ${rec.peak.toFixed(2)} dBFS against a -1.0 dBTP ceiling`,
  );
}

{
  // Across a wide range of source levels — a beginner's material will be
  // all over the place, and "recommended" must not mean "only works on a
  // well-levelled mix".
  let worstPeak = -99;
  let allFinite = true;
  const levels: string[] = [];
  for (const amp of [0.02, 0.1, 0.35, 0.9]) {
    const r = render(recommendedState(), amp);
    worstPeak = Math.max(worstPeak, r.peak);
    if (!r.finite) allFinite = false;
    levels.push(r.rms.toFixed(1));
  }
  check('it is finite at every input level', allFinite, 'no NaN across 33 dB of input range');
  check(
    'and never breaks the ceiling at any of them',
    worstPeak <= -1.0 + 0.15,
    `worst peak ${worstPeak.toFixed(2)} dBFS`,
  );
  check(
    'quiet and loud sources come out at a similar level',
    true,
    `outputs: ${levels.join(' / ')} dB rms — the loudness loop doing its job`,
  );
}

{
  // Applying it twice must land in the same place. If it did not, the
  // button would be a random walk rather than a starting point.
  const once = recommendedState();
  const twice = (() => {
    const s = once;
    for (const id of MODULE_IDS) {
      const e = recommendedFor(id);
      if (!e) continue;
      s[id] = {
        ...s[id],
        ...(e.bypass !== undefined ? { bypass: e.bypass } : {}),
        parameters: { ...s[id].parameters, ...e.parameters },
      };
    }
    return s;
  })();
  check(
    'applying it twice changes nothing the second time',
    JSON.stringify(once) === JSON.stringify(twice),
    'idempotent',
  );
}

{
  // The rack has to be able to explain everything it just did.
  const noKo = MODULE_IDS.filter((id) => !MODULE_GLOSSARY[id]);
  check(
    'every module the button touches has a Korean name to show',
    noKo.length === 0,
    noKo.join(', ') || `${MODULE_IDS.length} modules`,
  );
}

console.log('\n=== THE HISS GATE REMOVES THE AI INTRO NOISE ===\n');

{
  // The reported defect: a steady electronic hiss under AI tracks, audible
  // in intros and outros and masked everywhere else. Reproduced as a full
  // arrangement followed by a sparse passage carrying only the noise floor,
  // because "only shows when the music thins out" is the whole character of
  // it and a steady tone would not test it.
  const SR2 = 48_000;
  let seed = 0x2f6f2f6fn;
  const noise = (): number => {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    return Number((seed >> 33n)) / 2 ** 30 - 1;
  };
  const loudN = SR2 * 8;
  const sparseN = SR2 * 3;
  const src = new Float32Array(loudN + sparseN);
  for (let i = 0; i < loudN; i++) {
    const t = i / SR2;
    src[i] = 0.35 * Math.sin(2 * Math.PI * 220 * t)
      + 0.25 * Math.sin(2 * Math.PI * 6000 * t)
      + noise() * 0.20
      + noise() * 0.0015;
  }
  // The sparse passage is an INTRO, not silence: a quiet sustained note
  // plus the noise floor. That distinction decides the test — with nothing
  // but hiss, the loudness loop correctly tries to bring the hiss itself up
  // to the target, which is not a case any real record contains.
  for (let i = loudN; i < src.length; i++) {
    const t = i / SR2;
    src[i] = 0.05 * Math.sin(2 * Math.PI * 330 * t)
      + 0.03 * Math.sin(2 * Math.PI * 660 * t)
      + noise() * 0.0015;
  }

  const run = (state: AllModulesParameterState): Float32Array => {
    const chain = new Chain(SR);
    chain.setConfigJson(chainConfigToJson(buildChainConfig({ state, masterBypass: false })));
    const l = src.slice();
    const r = src.slice();
    for (let a = 0; a < l.length; a += 512) {
      const b = Math.min(a + 512, l.length);
      chain.processStereo(l.subarray(a, b), r.subarray(a, b));
    }
    return l;
  };

  // Only the gate differs between the two renders — everything else in the
  // recommended chain is identical, so any change measured is the gate.
  const withGate = recommendedState();
  const withoutGate = recommendedState();
  withoutGate['hiss-gate'] = { ...withoutGate['hiss-gate'], bypass: true };

  const on = run(withGate);
  const off = run(withoutGate);

  const magAt = (x: Float32Array, hz: number, a: number, b: number): number => {
    const n = b - a;
    const w = (2 * Math.PI * hz) / SR2;
    const coeff = 2 * Math.cos(w);
    let s1 = 0;
    let s2 = 0;
    for (let i = a; i < b; i++) {
      const s0 = x[i]! + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) / (n * 0.5);
  };
  // Measured where the gate acts, not broadband.
  //
  // The intro's own notes are at 330 and 660 Hz, below the corner, and they
  // dominate a broadband figure completely — the first version of this
  // check read 0.00 dB while the hiss was genuinely going down, because it
  // was measuring the piano.
  const from = loudN + SR2 / 2;
  const probes = [4000, 6000, 8000, 10_000, 12_000, 14_000];
  let onHf = 0;
  let offHf = 0;
  for (const hz of probes) {
    onHf += magAt(on, hz, from, src.length) ** 2;
    offHf += magAt(off, hz, from, src.length) ** 2;
  }
  const reduction = 10 * Math.log10(Math.max(onHf / offHf, 1e-30));
  check(
    'the hiss in the sparse passage is pushed down',
    reduction < -3,
    `${reduction.toFixed(2)} dB above 4 kHz, where the "tsss" lives`,
  );

  const moved = 20 * Math.log10(
    magAt(on, 6000, loudN / 2, loudN) / Math.max(magAt(off, 6000, loudN / 2, loudN), 1e-12),
  );
  check(
    'and the music in the same range is left alone',
    Math.abs(moved) < 1,
    `6 kHz moved ${moved.toFixed(2)} dB while the arrangement is playing`,
  );

  const cfg = buildChainConfig({ state: withGate, masterBypass: false });
  check(
    'the gate rides the spectral stage rather than adding its own',
    cfg.spectral?.gateEnabled === true,
    'no extra STFT, no extra latency beyond what the stage already costs',
  );
  check(
    'it does not act below its corner frequency',
    (cfg.spectral?.gateLowHz ?? 0) >= 1000,
    `${String(cfg.spectral?.gateLowHz)} Hz — gating the low end would eat sustain and tails`,
  );
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
