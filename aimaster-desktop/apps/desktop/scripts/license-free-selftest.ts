/**
 * license-free-selftest — this build ships free, and stays that way.
 *
 * The licensing machinery is still here, still tested, still one word away
 * from being switched on.  What this file holds is that the word is off and
 * that every gate actually reads it.
 *
 * The gates live in the MAIN process, so they are checked against the source:
 * a gate that grew its own copy of the answer would keep locking exports long
 * after the switch said not to, and the only way anyone would find out is a
 * customer who cannot save their master.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:license-free
 */

import { readFileSync } from 'node:fs';
import { LICENSE_ENFORCED } from '@aimaster/license-core';
import { KEY_LENGTH } from '../src/renderer/components/LicenseModal.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

const core = readFileSync('../../packages/license-core/src/index.ts', 'utf8');

check('the switch is off — this build is free', () => {
  assert(LICENSE_ENFORCED === false, 'LICENSE_ENFORCED is false');
});

check('nothing is counted and nothing is refused while it is off', () => {
  // Read from the source rather than by constructing a service, which would
  // need electron-store.  Each of the three has to consult the switch: the
  // gate that says yes, the counter that must not tick, and the number the
  // UI would show.
  for (const fn of ['canProcess():', 'decrementTrialUsage():', 'getRemainingTrials():']) {
    // The SIGNATURE, not the first mention — the doc comments name these too,
    // and a slice starting at a comment proves nothing about the code.
    const at = core.indexOf(`\n  ${fn}`);
    assert(at >= 0, `${fn} exists`);
    const body = core.slice(at, at + 500);
    assert(/!LICENSE_ENFORCED/.test(body), `${fn} checks the switch before doing anything`);
  }
});

check('canProcess answers paid, because that is what opens the export gates', () => {
  // The main process asks exactly this and nothing else — see licensePaid().
  const at = core.indexOf('\n  canProcess():');
  assert(at >= 0, 'canProcess is there');
  const body = core.slice(at, at + 400);
  assert(/isPaid: true/.test(body), 'the free answer is a paid answer');
  assert(/remaining: Infinity/.test(body), 'with no runs left to count down');
});

check('every export gate reads that one answer, not its own copy', () => {
  const handlers = readFileSync('src/main/ipc/fileHandlers.ts', 'utf8');
  assert(/licenseService\.canProcess\(\)\.isPaid/.test(handlers),
    'the gate asks canProcess');
  // Any gate that decided for itself would survive the switch being off.
  assert(!/TRIAL_MAX|trialUsed|_readTrialUsed/.test(handlers),
    'and no gate counts trials on its own');
});

check('the activation dialog cannot appear', () => {
  // Belt and braces: a license record left by an older build must not put a
  // paywall dialog in front of somebody using a free build.
  const modal = readFileSync('src/renderer/components/LicenseModal.tsx', 'utf8');
  assert(/if \(!LICENSE_ENFORCED\) return null;/.test(modal),
    'the modal returns null while the switch is off');
  const at = modal.indexOf('if (!LICENSE_ENFORCED) return null;');
  const showAt = modal.indexOf('if (!showModal) return null;');
  assert(at >= 0 && showAt >= 0 && at < showAt,
    'and checks it BEFORE anything that could open it');
});

check('what the app REPORTS matches what the gate actually does', () => {
  // license:status used to answer canSaveMasterWav:false on a build whose
  // gate saves masters all day.  Nothing read the field yet, which is exactly
  // why it was worth fixing: the first thing to read it would have believed
  // the wrong half.
  // The DEFINITION, not a call site.
  const at = core.indexOf('private _buildInfo(');
  assert(at >= 0, '_buildInfo exists');
  const body = core.slice(at, at + 1200);
  for (const flag of ['canSaveMasterWav', 'canExportReport', 'canUseAllPresets']) {
    assert(new RegExp(`${flag}:\\s*!LICENSE_ENFORCED`).test(body),
      `${flag} reports the truth on a free build`);
  }
  // The tier stays 'free' — nobody bought anything, and saying 'pro' would be
  // a different lie in the other direction.
  assert(/tier: 'free'/.test(body), "an unlicensed build is still tier 'free'");
});

check('the key field can hold a whole key', () => {
  // This one was real and reported: maxLength was 22 for a 23-character key,
  // so the browser refused the last character, `isComplete` never went true,
  // and the 활성화 button could never leave grey.  A dialog that cannot be
  // completed is worse than no dialog — you cannot even tell it is broken.
  const modal = readFileSync('src/renderer/components/LicenseModal.tsx', 'utf8');
  assert(!/maxLength=\{22\}/.test(modal), 'the cap is not one short any more');
  assert(/maxLength=\{KEY_LENGTH\}/.test(modal),
    'the cap comes from the key itself, not a number somebody added up');
  assert(KEY_LENGTH === 23, `a complete key is 23 characters, not ${KEY_LENGTH}`);

  // And the format the field enforces is the format the validator accepts.
  const sample = 'AIMASTER-DEV1-TEST-0001';
  assert(sample.length === KEY_LENGTH, 'a real key fits exactly');
  assert(/^AIMASTER-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(sample),
    'and matches what license-core validates');
});

check('the machinery is still here, so selling it later is one word', () => {
  // The point of a switch rather than a deletion.  If somebody strips the
  // licensing out, this fails and they find out now instead of when the
  // business decision changes.
  assert(/export const LICENSE_ENFORCED/.test(core), 'the switch itself');
  for (const kept of ['activate', 'canProcess', 'revalidate', 'TRIAL_MAX']) {
    assert(new RegExp(kept).test(core), `${kept} is still there to switch back on`);
  }
});

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== License: this build ships free ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
