// stem-defaults-selftest — the per-instrument chains are real and safe.
//
// A table of numbers like `STEM_CHAIN` has three ways to be silently wrong,
// and all three ship without an error:
//
//   1. A parameter key that no module reads. The preset writes it, nothing
//      happens, the button "works" and does nothing.
//   2. A value outside its own slider's range — a setting the UI can never
//      display and the user can never return to after moving it.
//   3. A move that is right for a master and wrong for a stem. This is the
//      dangerous one: limiting each stem to a loudness target destroys the
//      mix balance, which is the only thing a stem session exists to let
//      you set.
//
// The musical assertions at the end are deliberately about PROPERTIES, not
// exact numbers — "a kick is mono in the low end", "a lead vocal is
// de-essed", "no default boosts more than 4 dB" — so the values stay free
// to be tuned without rewriting the test, while the things that would be
// defects stay pinned.
//
// Run:  pnpm --filter @aimaster/desktop test:stem-defaults

import { ALL_MODULE_PARAMETER_DEFS } from '../src/renderer/audio/parameters/module-parameter-definitions.js';
import { MODULE_IDS, type ModuleId } from '../src/renderer/audio/parameters/parameter-state.js';
import {
  MAX_BANDS, MIN_Q, MAX_Q, MIN_FREQ_HZ, MAX_FREQ_HZ, MIN_GAIN_DB, MAX_GAIN_DB,
} from '../src/renderer/audio/modules/parametric-eq-model.js';
import {
  STEM_CHAIN, STEM_ROLES, MASTER_ONLY_MODULES, stemChainFor,
  type StemRole,
} from '../src/renderer/audio/presets/stem-defaults.js';
import { STEM_ROLES as MAIN_STEM_ROLES } from '../src/main/offline/stem-role.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

const num = (role: StemRole, mod: ModuleId, key: string): number | undefined => {
  const v = STEM_CHAIN[role].modules[mod]?.parameters[key];
  return typeof v === 'number' ? v : undefined;
};

// ── 1. Coverage and drift ───────────────────────────────────────────────────

console.log('\n=== COVERAGE ===\n');

check(
  'every role has a chain',
  STEM_ROLES.every((r) => STEM_CHAIN[r] !== undefined),
  `${STEM_ROLES.length} roles`,
);

{
  // The two sides of the IPC boundary declare this union separately. A role
  // added to the classifier and not here would be classified and then have
  // no chain to apply.
  const a = [...STEM_ROLES].sort().join(',');
  const b = [...MAIN_STEM_ROLES].sort().join(',');
  check(
    'the renderer and the classifier agree on the role list',
    a === b,
    a === b ? `${STEM_ROLES.length} roles on both sides` : `renderer: ${a}\n      main:     ${b}`,
  );
}

check(
  'every chain explains itself in Korean',
  STEM_ROLES.every((r) => STEM_CHAIN[r].why.trim().length > 20),
  '모든 역할에 설명이 있음',
);

// ── 2. The parameters are real ──────────────────────────────────────────────

console.log('\n=== PARAMETERS RESOLVE ===\n');

{
  const bad: string[] = [];
  for (const role of STEM_ROLES) {
    for (const [mod, setting] of Object.entries(STEM_CHAIN[role].modules)) {
      const id = mod as ModuleId;
      if (!MODULE_IDS.includes(id)) { bad.push(`${role}: module "${mod}" does not exist`); continue; }
      const known = new Set(ALL_MODULE_PARAMETER_DEFS[id].parameters.map((p) => p.id));
      for (const key of Object.keys(setting!.parameters)) {
        if (!known.has(key)) bad.push(`${role}.${mod}.${key}`);
      }
    }
  }
  check(
    'every parameter a preset writes exists on its module',
    bad.length === 0,
    bad.length === 0 ? 'all resolve' : bad.join(' · '),
  );
}

{
  const bad: string[] = [];
  for (const role of STEM_ROLES) {
    for (const [mod, setting] of Object.entries(STEM_CHAIN[role].modules)) {
      const id = mod as ModuleId;
      if (!MODULE_IDS.includes(id)) continue;
      for (const p of ALL_MODULE_PARAMETER_DEFS[id].parameters) {
        const v = setting!.parameters[p.id];
        if (v === undefined) continue;
        if (p.kind === 'number') {
          if (typeof v !== 'number' || !Number.isFinite(v) || v < p.min || v > p.max) {
            bad.push(`${role}.${mod}.${p.id}=${String(v)} outside [${p.min}..${p.max}]`);
          }
        } else if (p.kind === 'enum') {
          if (typeof v !== 'string' || !p.values.includes(v)) {
            bad.push(`${role}.${mod}.${p.id}=${String(v)} not in {${p.values.join('|')}}`);
          }
        } else if (typeof v !== 'boolean') {
          bad.push(`${role}.${mod}.${p.id}=${String(v)} is not a boolean`);
        }
      }
    }
  }
  check(
    'every value is inside its own slider range',
    bad.length === 0,
    bad.length === 0 ? 'all in range' : bad.join(' · '),
  );
}

{
  const bad: string[] = [];
  for (const role of STEM_ROLES) {
    const bands = STEM_CHAIN[role].eqBands;
    if (bands.length > MAX_BANDS) bad.push(`${role}: ${bands.length} bands > ${MAX_BANDS}`);
    for (const b of bands) {
      if (b.frequencyHz < MIN_FREQ_HZ || b.frequencyHz > MAX_FREQ_HZ) bad.push(`${role}: ${b.frequencyHz} Hz`);
      if (b.gainDb < MIN_GAIN_DB || b.gainDb > MAX_GAIN_DB) bad.push(`${role}: ${b.gainDb} dB`);
      if (b.q < MIN_Q || b.q > MAX_Q) bad.push(`${role}: Q ${b.q}`);
    }
  }
  check(
    'every EQ band is inside the engine and UI limits',
    bad.length === 0,
    bad.length === 0 ? `최대 ${Math.max(...STEM_ROLES.map((r) => STEM_CHAIN[r].eqBands.length))}밴드` : bad.join(' · '),
  );
}

// ── 3. A stem is not a master ───────────────────────────────────────────────

console.log('\n=== STEM ≠ MASTER ===\n');

{
  const bad: string[] = [];
  for (const role of STEM_ROLES) {
    for (const mod of MASTER_ONLY_MODULES) {
      if (STEM_CHAIN[role].modules[mod] !== undefined) bad.push(`${role} writes to ${mod}`);
    }
  }
  check(
    'no stem chain touches the limiter or the export stage',
    bad.length === 0,
    bad.length === 0
      ? '스템마다 리미터를 걸면 믹스 밸런스가 사라지고, 디더는 마지막에 한 번만 걸려야 함'
      : bad.join(' · '),
  );
}

{
  // Loudness normalisation is a master-bus job for the same reason. It is
  // reached through the limiter module, which is already excluded — this
  // pins the intent so a new module carrying a LUFS target is caught too.
  const bad: string[] = [];
  for (const role of STEM_ROLES) {
    for (const [mod, setting] of Object.entries(STEM_CHAIN[role].modules)) {
      for (const key of Object.keys(setting!.parameters)) {
        if (/lufs|dither|ceiling/i.test(key)) bad.push(`${role}.${mod}.${key}`);
      }
    }
  }
  check(
    'no stem chain sets a loudness target, a dither mode or a ceiling',
    bad.length === 0,
    bad.length === 0 ? '레벨은 페이더, 라우드니스는 마스터 버스' : bad.join(' · '),
  );
}

// ── 4. Musical properties ───────────────────────────────────────────────────

console.log('\n=== WHAT THE CHAINS ACTUALLY DO ===\n');

{
  const shaped = STEM_ROLES.filter((r) => r !== 'mid' && r !== 'other');
  const without = shaped.filter((r) => !STEM_CHAIN[r].eqBands.some((b) => b.type === 'highpass'));
  check(
    'every identified instrument is high-passed',
    without.length === 0,
    without.length === 0
      ? shaped.map((r) => `${r} ${STEM_CHAIN[r].eqBands.find((b) => b.type === 'highpass')!.frequencyHz}Hz`).join(', ')
      : `없음: ${without.join(', ')}`,
  );
}

{
  const kickHp = STEM_CHAIN.kick.eqBands.find((b) => b.type === 'highpass')!.frequencyHz;
  const vocalHp = STEM_CHAIN.vocal.eqBands.find((b) => b.type === 'highpass')!.frequencyHz;
  const backHp = STEM_CHAIN['vocal-back'].eqBands.find((b) => b.type === 'highpass')!.frequencyHz;
  check(
    'the high-pass follows the instrument, not a fixed number',
    kickHp < vocalHp && vocalHp < backHp,
    `킥 ${kickHp} Hz < 리드 보컬 ${vocalHp} Hz < 백 보컬 ${backHp} Hz — 백보컬을 더 자르는 것이 리드와 자리를 나누는 방법`,
  );
}

{
  const deessed = STEM_ROLES.filter((r) => STEM_CHAIN[r].modules.deess !== undefined);
  check(
    'de-essing is on the voices and only on the voices',
    deessed.length === 2 && deessed.includes('vocal') && deessed.includes('vocal-back'),
    `${deessed.join(', ')} — 디에서는 사람 목소리의 치찰음을 위한 것이라 다른 악기에 걸면 고음만 깎임`,
  );
}

{
  const lowMono = (r: StemRole): number => num(r, 'imager', 'lowMonoHz') ?? 0;
  check(
    'the low end is summed to mono where the low end lives',
    lowMono('kick') >= 150 && lowMono('bass') >= 150,
    `킥 ${lowMono('kick')} Hz, 베이스 ${lowMono('bass')} Hz — 저역이 모노가 아니면 클럽 시스템에서 사라진다`,
  );
  check(
    'and the lead vocal stays centred while backing vocals spread',
    (num('vocal', 'imager', 'widthPct') ?? 0) <= 100 &&
    (num('vocal-back', 'imager', 'widthPct') ?? 0) >= 120,
    `리드 ${num('vocal', 'imager', 'widthPct')}% vs 백 ${num('vocal-back', 'imager', 'widthPct')}%`,
  );
}

{
  // A fast attack on a drum is what turns a hit into a thud. This is the
  // single most common way an automatic chain ruins percussion.
  const attacks = (['kick', 'snare', 'drums'] as StemRole[])
    .map((r) => [r, num(r, 'dynamics', 'attackMs') ?? 0] as const);
  const tooFast = attacks.filter(([, ms]) => ms < 8);
  check(
    'percussive stems keep their transient — no sub-8 ms attack',
    tooFast.length === 0,
    tooFast.length === 0
      ? attacks.map(([r, ms]) => `${r} ${ms} ms`).join(', ')
      : tooFast.map(([r, ms]) => `${r} ${ms} ms`).join(', '),
  );
  check(
    'a vocal is compressed faster than a pad',
    (num('vocal', 'dynamics', 'attackMs') ?? 0) < (num('keys', 'dynamics', 'attackMs') ?? 0),
    `보컬 ${num('vocal', 'dynamics', 'attackMs')} ms < 건반 ${num('keys', 'dynamics', 'attackMs')} ms`,
  );
  check(
    'and a bass is held harder than a pad',
    (num('bass', 'dynamics', 'ratio') ?? 0) > (num('keys', 'dynamics', 'ratio') ?? 0),
    `베이스 ${num('bass', 'dynamics', 'ratio')}:1 > 건반 ${num('keys', 'dynamics', 'ratio')}:1`,
  );
}

{
  // A default that adds 8 dB somewhere is a default that breaks a mix the
  // moment it is applied to twelve stems at once.
  const big: string[] = [];
  for (const role of STEM_ROLES) {
    for (const b of STEM_CHAIN[role].eqBands) {
      if (b.gainDb > 4) big.push(`${role} +${b.gainDb} dB @ ${b.frequencyHz} Hz`);
    }
  }
  check(
    'no default boosts more than 4 dB',
    big.length === 0,
    big.length === 0 ? '기본값은 시작점이지 완성이 아니다' : big.join(' · '),
  );
}

{
  const unknown = (['mid', 'other'] as StemRole[]);
  const busy = unknown.filter((r) =>
    Object.keys(STEM_CHAIN[r].modules).length > 0 ||
    STEM_CHAIN[r].eqBands.some((b) => b.gainDb !== 0));
  check(
    'an unidentified stem is left almost alone',
    busy.length === 0,
    busy.length === 0
      ? '서브소닉 하이패스만 — 이름을 모르는 스템에 확신을 갖고 손대지 않는다'
      : busy.join(', '),
  );
}

{
  check(
    'stemChainFor returns the same object the table holds',
    stemChainFor('kick') === STEM_CHAIN.kick,
    'lookup helper',
  );
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
