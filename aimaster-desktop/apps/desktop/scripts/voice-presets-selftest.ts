/**
 * voice-presets-selftest.ts — 남성 보컬 / 여성 보컬, on every device.
 *
 * Two presets across 36 devices is 72 parameter maps, and the way a set this
 * size rots is not that it fails to load.  It is that one map gets pasted
 * from its neighbour and never corrected, so the 남성 compressor and the
 * 여성 compressor turn out to be the same device and the menu is offering two
 * answers while holding one.
 *
 * So: no pastes, no near-pastes, no invented parameters, nothing out of
 * range — and, the interesting part, the numbers have to agree with the
 * profiles written at the top of `plugin-presets-voice.ts`.
 *
 * That header makes four claims, and each is testable:
 *
 *   1. the male high-pass is LOWER, on every device that has one
 *   2. the male de-esser sits LOWER, and the female one works HARDER
 *   3. the presence lift is lower on a man and higher on a woman
 *   4. 250–400 Hz is cut on a man and left alone on a woman
 *
 * If the prose and the numbers disagree, one of them is wrong, and this says
 * which rows to look at.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:voice-presets
 */

import { readFileSync } from 'node:fs';
import { findPlugin, PLUGINS } from '../src/renderer/daw/engine/plugins.js';
import { PLUGIN_PRESETS, presetGroups } from '../src/renderer/daw/engine/plugin-presets.js';
import {
  VOICE_PRESETS, VOICE_ORDER, VOICE_LABEL, VOICE_GROUP,
  NO_VOICE_PRESETS, VOICE_SINGLE_AXIS, partitionVoice, type VoiceId,
} from '../src/renderer/daw/engine/plugin-presets-voice.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

/** The voice preset for one device, or undefined. */
function P(pluginId: string, id: VoiceId): Record<string, number> | undefined {
  return VOICE_PRESETS.find(
    (p) => p.pluginId === pluginId && p.name === VOICE_LABEL[id],
  )?.params;
}
/** A parameter's value, or the device default when the preset stays quiet. */
function V(pluginId: string, id: VoiceId, param: string): number {
  const v = P(pluginId, id)?.[param];
  if (typeof v === 'number') return v;
  const d = findPlugin(pluginId)?.params.find((x) => x.id === param);
  assert(d, `${pluginId}.${param} does not exist`);
  return d!.default;
}

const devices = [...new Set(VOICE_PRESETS.map((p) => p.pluginId))];

// ── Coverage ────────────────────────────────────────────────────────────────

check('every device with voice presets has both voices', () => {
  for (const id of devices) {
    for (const v of VOICE_ORDER) {
      assert(P(id, v), `${id} is missing ${VOICE_LABEL[v]}`);
    }
  }
});

// The rule the instrument set set: excluded devices are LISTED with a reason,
// so adding a device without presets fails here rather than quietly shrinking
// the set to whatever somebody got round to.
check('the devices without voice presets are exactly the ones with a stated reason', () => {
  const all = PLUGINS.map((p) => p.id);
  const missing = all.filter((id) => !devices.includes(id)).sort();
  const declared = Object.keys(NO_VOICE_PRESETS).sort();
  assert(missing.join() === declared.join(),
    `missing=[${missing.join()}] declared=[${declared.join()}]`);
  for (const id of declared) {
    assert(NO_VOICE_PRESETS[id]!.length > 8, `${id} has no real reason given`);
  }
});

check('every device the app has is either covered or excused', () => {
  const accounted = new Set([...devices, ...Object.keys(NO_VOICE_PRESETS)]);
  for (const p of PLUGINS) assert(accounted.has(p.id), `${p.id} is neither`);
});

// ── The maps are real ───────────────────────────────────────────────────────

check('every parameter a voice preset names exists on that device', () => {
  for (const preset of VOICE_PRESETS) {
    const plugin = findPlugin(preset.pluginId);
    assert(plugin, `${preset.pluginId} is not a device`);
    for (const key of Object.keys(preset.params)) {
      assert(plugin!.params.some((x) => x.id === key),
        `${preset.pluginId}.${key} does not exist (${preset.name})`);
    }
  }
});

check('every value is inside the range the device declares', () => {
  for (const preset of VOICE_PRESETS) {
    const plugin = findPlugin(preset.pluginId)!;
    for (const [key, value] of Object.entries(preset.params)) {
      const spec = plugin.params.find((x) => x.id === key)!;
      assert(value >= spec.min && value <= spec.max,
        `${preset.pluginId}.${key}=${value} outside [${spec.min}..${spec.max}] (${preset.name})`);
    }
  }
});

// ── The paste, and the near-paste ──────────────────────────────────────────

check('the two voices never share a parameter map on the same device', () => {
  for (const id of devices) {
    const a = JSON.stringify(P(id, 'male'));
    const b = JSON.stringify(P(id, 'female'));
    assert(a !== b, `${id}: both voices have the same map`);
  }
});

check('and they differ in more than one parameter, unless the device says why', () => {
  for (const id of devices) {
    const a = P(id, 'male')!;
    const b = P(id, 'female')!;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    let differing = 0;
    for (const k of keys) if (V(id, 'male', k) !== V(id, 'female', k)) differing += 1;
    if (VOICE_SINGLE_AXIS[id]) {
      assert(differing >= 1, `${id} is declared single-axis but differs in nothing`);
      continue;
    }
    assert(differing >= 2,
      `${id}: the two voices differ in only ${differing} parameter — paste, or declare it in VOICE_SINGLE_AXIS`);
  }
});

check('the single-axis exemptions are real devices with real reasons', () => {
  for (const [id, why] of Object.entries(VOICE_SINGLE_AXIS)) {
    assert(findPlugin(id), `${id} is not a device`);
    assert(devices.includes(id), `${id} has no voice presets to excuse`);
    assert(why.length > 8, `${id} has no real reason given`);
  }
});

check('every preset says something, and the two never say the same thing', () => {
  for (const id of devices) {
    const a = VOICE_PRESETS.find((p) => p.pluginId === id && p.name === VOICE_LABEL.male)!;
    const b = VOICE_PRESETS.find((p) => p.pluginId === id && p.name === VOICE_LABEL.female)!;
    // A LENGTH is a crude proxy for "gives a reason", and it is the proxy
    // that caught the two notes this set shipped with which did not: '느리고
    // 깊게' says what the knobs read, not why they read that for this voice.
    // Twelve is about the shortest a Korean sentence can be and still contain
    // a because.
    assert(a.note.length >= 12, `${id}: 남성 note says nothing — "${a.note}"`);
    assert(b.note.length >= 12, `${id}: 여성 note says nothing — "${b.note}"`);
    assert(a.note !== b.note, `${id}: both notes are identical`);
  }
});

check('ids are unique and do not collide with the other preset sets', () => {
  const ids = PLUGIN_PRESETS.map((p) => p.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert(dupes.length === 0, `duplicate preset ids: ${[...new Set(dupes)].join()}`);
});

// ── The header's four claims ───────────────────────────────────────────────

// Claim 1.  The whole file follows from the fundamental being an octave
// apart, and this is where that is most load-bearing: a high-pass safe on a
// woman takes the bottom octave off a baritone.
check('the male high-pass is lower on every device that has one', () => {
  for (const id of devices) {
    for (const param of ['hpfHz', 'lowCutHz', 'lowMonoHz', 'freqHz']) {
      // `freqHz` only counts where it IS a high-pass — monomaker's crossover.
      if (param === 'freqHz' && id !== 'monomaker') continue;
      const plugin = findPlugin(id)!;
      if (!plugin.params.some((x) => x.id === param)) continue;
      const m = V(id, 'male', param);
      const f = V(id, 'female', param);
      assert(m < f, `${id}.${param}: male ${m} is not below female ${f}`);
    }
  }
});

// Claim 2.  Sibilance follows the voice up, and there is more of it.
check('the male de-esser sits lower and the female one works harder', () => {
  assert(V('deesser', 'male', 'freqHz') < V('deesser', 'female', 'freqHz'),
    'the male de-esser is not below the female one');
  assert(V('deesser', 'female', 'amount') > V('deesser', 'male', 'amount'),
    'the female de-esser does not work harder');
  // And low enough to actually be male sibilance rather than air.
  assert(V('deesser', 'male', 'freqHz') <= 7000,
    `male de-esser at ${V('deesser', 'male', 'freqHz')} Hz is above male sibilance`);
  assert(V('deesser', 'female', 'freqHz') >= 7000,
    `female de-esser at ${V('deesser', 'female', 'freqHz')} Hz is too low`);
});

// Claim 3.  Presence is intelligibility, and it moves up with the voice.
check('the presence lift is lower on a man and higher on a woman', () => {
  assert(V('eq8', 'male', 'b3Hz') < V('eq8', 'female', 'b3Hz'),
    'the male presence band is not below the female one');
  assert(V('exciter', 'male', 'freqHz') < V('exciter', 'female', 'freqHz'),
    'the male exciter is not below the female one');
  // The header says a man needs intelligibility and a woman already has it.
  assert(V('exciter', 'male', 'amount') > V('exciter', 'female', 'amount'),
    'the male exciter is not doing more work than the female one');
});

// Claim 4.  The same region is mud on one voice and body on the other — the
// single most common way a female vocal gets ruined by a male vocal's EQ.
check('250-400 Hz is cut on a man and left alone on a woman', () => {
  const maleCut = V('eq8', 'male', 'b1Db');
  const femaleCut = V('eq8', 'female', 'b1Db');
  assert(maleCut < 0, `the male 진흙 band is not a cut (${maleCut} dB)`);
  assert(femaleCut > maleCut,
    `the female cut ${femaleCut} dB is not gentler than the male ${maleCut} dB`);
  assert(V('eq3', 'male', 'midHz') < V('eq3', 'female', 'midHz'),
    'the eq3 problem frequency does not move up for the female voice');
});

// ── The menu ────────────────────────────────────────────────────────────────

check('both voices are in one group, named the same everywhere', () => {
  for (const p of VOICE_PRESETS) {
    assert(p.group === VOICE_GROUP, `${p.id} is in group ${p.group}`);
  }
  const names = new Set(VOICE_PRESETS.map((p) => p.name));
  assert(names.size === 2, `expected two names, got ${[...names].join()}`);
});

check('the set is the size it claims to be', () => {
  assert(VOICE_PRESETS.length === devices.length * 2,
    `${VOICE_PRESETS.length} presets for ${devices.length} devices`);
});

// ── Reachable ───────────────────────────────────────────────────────────────
//
// A preset in an array nothing renders is the defect this repository has
// caught more than once.  The two have to reach the plugin window as their
// own chip row, the way the instrument set does.

check('both voices come out as a chip row, not buried in the dropdown', () => {
  for (const id of devices) {
    const { voice, rest } = partitionVoice(presetGroups(id));
    assert(voice.length === 2, `${id}: the chip row has ${voice.length} presets`);
    assert(!rest.some((g) => g.group === VOICE_GROUP),
      `${id}: the dropdown still lists the voices as well`);
  }
});

check('the excused devices get no chip row', () => {
  for (const id of Object.keys(NO_VOICE_PRESETS)) {
    assert(partitionVoice(presetGroups(id)).voice.length === 0,
      `${id} has a voice chip row it should not`);
  }
});

// The three checks above call `partitionVoice` themselves, so they prove the
// FUNCTION works and say nothing about whether the window calls it.  That gap
// was found by breaking them: deleting the call in PluginWindow left all three
// green, which is precisely the defect they were written to prevent.  So the
// window is read.
check('the plugin window actually renders the chip row', () => {
  const src = readFileSync('src/renderer/components/daw/plugin/PluginWindow.tsx', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; })
    .join('\n');
  assert(/partitionVoice\s*\(/.test(src), 'PluginWindow never calls partitionVoice');
  assert(/<ChipRow[^>]*presets=\{voicePresets\}/.test(src),
    'PluginWindow has no ChipRow fed by voicePresets');
  assert(/label="목소리"/.test(src), 'the chip row is not labelled 목소리');
});

check('the chip row is in the declared order — 남성 then 여성', () => {
  for (const id of devices) {
    const names = partitionVoice(presetGroups(id)).voice.map((p) => p.name);
    assert(names.join() === VOICE_ORDER.map((v) => VOICE_LABEL[v]).join(),
      `${id}: chip order is ${names.join()}`);
  }
});

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== 목소리 프리셋 ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
console.log(`(${devices.length} devices × ${VOICE_ORDER.length} voices = ${VOICE_PRESETS.length} presets)`);
if (failed > 0) process.exit(1);
