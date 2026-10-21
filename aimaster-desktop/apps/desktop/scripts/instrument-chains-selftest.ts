/**
 * instrument-chains-selftest — the chains a beginner is handed, checked.
 *
 * `daw/model/instrument-chains.ts` answers "what goes on a vocal" with
 * twelve ordered chains and about a hundred parameter values typed in by
 * hand.  Every one of those values is a chance to name a parameter that does
 * not exist, or to set one past its range, and both fail QUIETLY: a param
 * the engine does not know is dropped on load, and an out-of-range one is
 * clamped.  Either way the chain loads, nothing says anything, and the
 * device does not do what the line next to it in the UI claims.
 *
 * So the values are loaded through `loadRack` — the same path a saved rack
 * takes — and this file refuses if ANY device is skipped, if any value comes
 * back different from the one that was written, or if the devices do not
 * land in chain order.
 *
 * The order rules are the ones the mixing guides agree on, and only those:
 * time-based effects last, delay before reverb, stereo before both.  What
 * the guides disagree about (gate before or after EQ, de-esser before or
 * after the compressor) is deliberately not asserted — a test that pins a
 * disagreement is a test that will be wrong for half its readers.
 */
export {};

import { readFileSync } from 'node:fs';

import {
  INSTRUMENT_CHAINS, chainDeviceParams, findInstrumentChain, rackFromChain,
} from '../src/renderer/daw/model/instrument-chains.js';
import {
  INSTRUMENT_LABEL, INSTRUMENT_PRESETS,
} from '../src/renderer/daw/engine/plugin-presets-instrument.js';
import { loadRack } from '../src/renderer/daw/model/rack-preset.js';
import { sanitiseParams } from '../src/renderer/daw/engine/user-presets.js';
import { findPlugin } from '../src/renderer/daw/engine/plugins.js';
import { addTrack, createSession, createTrack, findTrack } from '../src/renderer/daw/model/session-ops.js';
import { INSERT_SLOTS } from '../src/renderer/daw/model/types.js';
import type { PluginCategory } from '../src/renderer/daw/engine/plugin-kit.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

const WANTED = [
  'vocal', 'backing', 'drums', 'percussion', 'bass', 'guitar',
  'keyboard', 'strings', 'brass', 'woodwinds', 'synth', 'fx',
];

console.log('\n=== 악기별 기본 체인 ===\n');

// ── The twelve the user asked for ────────────────────────────────────────
{
  const ids = INSTRUMENT_CHAINS.map((c) => c.id);
  const missing = WANTED.filter((w) => !ids.includes(w as typeof ids[number]));
  check(
    'every instrument category asked for is here, and nothing extra',
    missing.length === 0 && ids.length === WANTED.length,
    missing.length === 0 ? `${ids.length}: ${ids.join(', ')}` : `missing: ${missing.join(', ')}`,
  );
  check(
    'each one is findable by its id',
    WANTED.every((w) => findInstrumentChain(w)?.id === w),
    `findInstrumentChain('vocal') → ${findInstrumentChain('vocal')?.label ?? '(none)'}`,
  );
  const unlabelled = INSTRUMENT_CHAINS.filter(
    (c) => c.label.trim() === '' || c.english.trim() === '' || c.hint.trim() === '');
  check(
    'and says what it is in both languages, with a line about when to use it',
    unlabelled.length === 0,
    unlabelled.length === 0
      ? INSTRUMENT_CHAINS.map((c) => `${c.label}/${c.english}`).join(', ')
      : `blank: ${unlabelled.map((c) => c.id).join(', ')}`,
  );
}

// ── Every device is a device this build has ──────────────────────────────
{
  const unknown: string[] = [];
  for (const chain of INSTRUMENT_CHAINS) {
    for (const device of chain.devices) {
      if (!findPlugin(device.pluginId)) unknown.push(`${chain.id}:${device.pluginId}`);
    }
  }
  const total = INSTRUMENT_CHAINS.reduce((n, c) => n + c.devices.length, 0);
  check(
    'every device in every chain exists in this build',
    unknown.length === 0,
    unknown.length === 0 ? `${total} devices across ${INSTRUMENT_CHAINS.length} chains`
      : `unknown: ${unknown.join(', ')}`,
  );
  const offline = INSTRUMENT_CHAINS.flatMap((c) => c.devices
    .filter((d) => findPlugin(d.pluginId)?.offline === true)
    .map((d) => `${c.id}:${d.pluginId}`));
  check(
    'and none of them is an offline device a beginner would not hear',
    offline.length === 0,
    offline.length === 0 ? 'all realtime' : `offline: ${offline.join(', ')}`,
  );
  const tooLong = INSTRUMENT_CHAINS.filter((c) => c.devices.length > INSERT_SLOTS);
  check(
    'and no chain asks for more slots than a channel has',
    tooLong.length === 0,
    `longest ${Math.max(...INSTRUMENT_CHAINS.map((c) => c.devices.length))} of ${INSERT_SLOTS}`,
  );
}

// ── Every number is a number that device accepts ─────────────────────────
{
  const wrong: string[] = [];
  for (const chain of INSTRUMENT_CHAINS) {
    for (const device of chain.devices) {
      const descriptor = findPlugin(device.pluginId);
      if (!descriptor) continue;
      const known = new Set(descriptor.params.map((p) => p.id));
      const settings = chainDeviceParams(chain, device);
      for (const [id, value] of Object.entries(settings)) {
        if (!known.has(id)) { wrong.push(`${chain.id}/${device.pluginId}: no param "${id}"`); continue; }
        const def = descriptor.params.find((p) => p.id === id);
        if (def && (value < def.min || value > def.max)) {
          wrong.push(`${chain.id}/${device.pluginId}.${id}=${value} outside [${def.min}..${def.max}]`);
        }
      }
      // The engine's own gate, which is what actually runs on load.
      const cleaned = sanitiseParams(device.pluginId, settings).params;
      for (const [id, value] of Object.entries(settings)) {
        if (cleaned[id] !== value) {
          wrong.push(`${chain.id}/${device.pluginId}.${id}: wrote ${value}, engine kept ${String(cleaned[id])}`);
        }
      }
    }
  }
  const values = INSTRUMENT_CHAINS.reduce(
    (n, c) => n + c.devices.reduce((m, d) => m + Object.keys(chainDeviceParams(c, d)).length, 0), 0);
  check(
    'every parameter exists on its device and survives the engine unchanged',
    wrong.length === 0,
    wrong.length === 0 ? `${values} values across ${INSTRUMENT_CHAINS.length} chains`
      : wrong.slice(0, 4).join(' · '),
  );
}

// ── Nothing loads at a setting that does nothing ─────────────────────────
{
  // `saturation` defaults to mix 0 and `deesser` to amount 0 — a chain that
  // takes the defaults is a chain of devices that are switched off.
  const SILENT: Record<string, { param: string; off: number }> = {
    saturation: { param: 'mix', off: 0 },
    deesser: { param: 'amount', off: 0 },
    exciter: { param: 'amount', off: 0 },
  };
  const asleep: string[] = [];
  for (const chain of INSTRUMENT_CHAINS) {
    for (const device of chain.devices) {
      const rule = SILENT[device.pluginId];
      if (rule && (chainDeviceParams(chain, device)[rule.param] ?? rule.off) === rule.off) {
        asleep.push(`${chain.id}/${device.pluginId}.${rule.param}`);
      }
    }
  }
  check(
    'the devices whose default is "do nothing" are not left at it',
    asleep.length === 0,
    asleep.length === 0 ? Object.keys(SILENT).join(', ') + ' all set' : `inaudible: ${asleep.join(', ')}`,
  );
}

// ── The order the guides agree on ────────────────────────────────────────
{
  const categoryOf = (id: string): PluginCategory | undefined => findPlugin(id)?.category;
  const problems: string[] = [];
  for (const chain of INSTRUMENT_CHAINS) {
    const cats = chain.devices.map((d) => categoryOf(d.pluginId));
    const firstTime = cats.findIndex((c) => c === 'delay' || c === 'reverb');
    if (firstTime >= 0) {
      const after = cats.slice(firstTime);
      if (!after.every((c) => c === 'delay' || c === 'reverb')) {
        problems.push(`${chain.id}: something is after the time-based devices`);
      }
    }
    const delayAt = cats.indexOf('delay');
    const reverbAt = cats.indexOf('reverb');
    if (delayAt >= 0 && reverbAt >= 0 && reverbAt < delayAt) {
      problems.push(`${chain.id}: reverb before delay`);
    }
    const imagingAt = cats.indexOf('imaging');
    if (imagingAt >= 0 && firstTime >= 0 && imagingAt > firstTime) {
      problems.push(`${chain.id}: stereo width after the time-based devices`);
    }
    if (new Set(chain.devices.map((d) => d.pluginId)).size !== chain.devices.length) {
      problems.push(`${chain.id}: the same device twice`);
    }
  }
  check(
    'time-based effects come last, delay before reverb, stereo before both',
    problems.length === 0,
    problems.length === 0
      ? INSTRUMENT_CHAINS.map((c) => `${c.id}:${c.devices.length}`).join(' ')
      : problems.join(' · '),
  );
}

// ── An EQ and something that controls level, on every instrument ─────────
{
  const thin: string[] = [];
  for (const chain of INSTRUMENT_CHAINS) {
    const cats = chain.devices.map((d) => findPlugin(d.pluginId)?.category);
    if (!cats.includes('eq')) thin.push(`${chain.id}: no EQ`);
    // FX is the exception every guide makes: a riser is not compressed.
    if (chain.id !== 'fx' && !cats.includes('dynamics')) thin.push(`${chain.id}: nothing controlling level`);
  }
  check(
    'every instrument gets an EQ, and every one but FX something dynamic',
    thin.length === 0,
    thin.length === 0 ? 'eq + dynamics on 11 of 12, fx by design' : thin.join(' · '),
  );
}

// ── And it loads, through the path a saved rack loads through ────────────
{
  const bad: string[] = [];
  for (const chain of INSTRUMENT_CHAINS) {
    const track = createTrack(chain.label, 'audio');
    const session = addTrack(createSession('chains'), track);
    const result = loadRack(session, track.id, rackFromChain(chain), 'replace');
    if (result.problems.length > 0) {
      bad.push(`${chain.id}: ${result.problems.join(', ')}`);
      continue;
    }
    const loaded = findTrack(result.session, track.id)?.inserts ?? [];
    const order = [...loaded].sort((a, b) => a.slot - b.slot).map((i) => i.pluginId);
    const wanted = chain.devices.map((d) => d.pluginId);
    if (order.join('>') !== wanted.join('>')) {
      bad.push(`${chain.id}: loaded ${order.join('>')} for ${wanted.join('>')}`);
      continue;
    }
    // The values the device will actually run with.
    for (const insert of loaded) {
      const device = chain.devices[insert.slot];
      if (!device) { bad.push(`${chain.id}: slot ${insert.slot} has no device`); continue; }
      for (const [id, value] of Object.entries(chainDeviceParams(chain, device))) {
        if (insert.params[id] !== value) {
          bad.push(`${chain.id}/${device.pluginId}.${id}: ${String(insert.params[id])} ≠ ${value}`);
        }
      }
    }
  }
  check(
    'every chain loads onto a track with nothing skipped and nothing changed',
    bad.length === 0,
    bad.length === 0
      ? `${INSTRUMENT_CHAINS.length} chains loaded, slots packed from A`
      : bad.slice(0, 3).join(' · '),
  );
}

// ── One answer per question ──────────────────────────────────────────────
//
// `plugin-presets-instrument.ts` holds 301 presets over 43 devices for seven
// instruments, each with a written reason.  A chain that typed its own
// numbers for a pair that file already answers would be a second answer one
// click away: load the 베이스 chain, open the compressor, pick 베이스 from
// its own menu, and every number changes.  (It did: the chain said ratio 4 /
// attack 20 ms / release 110, the preset says 6 / 35 / 260, and the tube said
// drive 0.22 mix 40 against the preset's 0.55 and 75.)
{
  const both: string[] = [];
  const neither: string[] = [];
  let fromPreset = 0;
  let ownNumbers = 0;
  for (const chain of INSTRUMENT_CHAINS) {
    for (const device of chain.devices) {
      const preset = chain.profile === null ? undefined : INSTRUMENT_PRESETS.find(
        (p) => p.pluginId === device.pluginId && p.id === `inst-${device.pluginId}-${chain.profile}`);
      if (preset) {
        fromPreset++;
        if (device.params !== undefined) both.push(`${chain.id}/${device.pluginId}`);
        // and what it loads with IS the preset, parameter for parameter
        const resolved = chainDeviceParams(chain, device);
        const same = Object.keys(preset.params).length === Object.keys(resolved).length
          && Object.entries(preset.params).every(([k, v]) => resolved[k] === v);
        if (!same) both.push(`${chain.id}/${device.pluginId} resolves to something else`);
      } else {
        ownNumbers++;
        if (device.params === undefined) neither.push(`${chain.id}/${device.pluginId}`);
      }
    }
  }
  check(
    'a device the instrument presets already answer carries no second answer',
    both.length === 0,
    both.length === 0
      ? `${fromPreset} devices take the preset, ${ownNumbers} carry their own`
      : both.slice(0, 4).join(' · '),
  );
  check(
    'and a device they do not answer carries settings of its own',
    neither.length === 0,
    neither.length === 0 ? 'no device loads at its factory defaults' : neither.join(' · '),
  );
  const profiled = INSTRUMENT_CHAINS.filter((c) => c.profile !== null);
  check(
    'six of the twelve map onto an instrument the app already knows',
    profiled.length === 6
      && profiled.every((c) => c.profile !== null && INSTRUMENT_LABEL[c.profile] !== undefined),
    profiled.map((c) => `${c.id}→${c.profile === null ? '' : INSTRUMENT_LABEL[c.profile]}`).join(', '),
  );
  // Named, not silent: the device menus offer seven instruments and a VOCAL
  // is not one of them, in an app whose first category is 보컬.
  const unprofiled = INSTRUMENT_CHAINS.filter((c) => c.profile === null).map((c) => c.id);
  check(
    'and the six with no instrument profile are the ones the app has none for',
    unprofiled.join(',') === 'vocal,backing,percussion,brass,woodwinds,fx',
    `no profile: ${unprofiled.join(', ')}`,
  );
}

// ── Both doors into the devices ──────────────────────────────────────────
//
// The chains are only an answer if they are where the question is asked:
// the mixer strip, where somebody is staring at fifty device names, and the
// insert rack, where the categories are the plugin folder.
{
  const rack = readFileSync(
    'src/renderer/components/daw/plugin/InsertRack.tsx', 'utf8');
  const mixer = readFileSync(
    'src/renderer/components/daw/mix/MixWindow.tsx', 'utf8');
  check(
    'the insert rack offers every chain, not a chosen few',
    /INSTRUMENT_CHAINS\.map\(/.test(rack) && /rackFromChain\(chain\)/.test(rack),
    'the rack builds its buttons from the list itself',
  );
  check(
    'and so does the mixer strip, where the fifty device names are',
    /INSTRUMENT_CHAINS\.map\(/.test(mixer) && /rackFromChain\(chain\)/.test(mixer),
    'one option per chain, above the slot pickers',
  );
  check(
    'both load through loadRack rather than setting inserts by hand',
    /loadRack\(s, trackId, preset, 'replace'\)/.test(rack)
      && /loadRack\(s, track\.id, rackFromChain\(chain\), 'replace'\)/.test(mixer),
    'the path a saved rack takes, including its problem report',
  );
  check(
    'and the master strip is not offered a vocal chain',
    /!isMaster && !isVca && \(\s*<LazySelect/.test(mixer),
    'the picker is hidden on master and VCA strips',
  );
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
