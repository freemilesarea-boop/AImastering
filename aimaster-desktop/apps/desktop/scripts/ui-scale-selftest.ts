/**
 * ui-scale-selftest — one number against 521 pieces of small text.
 *
 * The console is dense on purpose, but the density was paid for in font size:
 * 521 pieces of text under 11 px, 64 of them at 8 px.  At that size a mixer
 * strip is not dense, it is unreadable, and no layout work fixes a glyph too
 * small for the eye reading it.
 *
 * The fix is not 521 edits — Electron scales the whole renderer with one
 * call — so what has to be guarded is the wiring, and the wiring has two
 * places it can fail silently:
 *
 *   · THE LIST IS IN TWO PROCESSES.  The settings page offers the steps, the
 *     main process validates and applies them.  Two copies drift, and the
 *     symptom is a value that stores fine and then shows as nothing selected.
 *   · STORED IS NOT APPLIED.  A number written to disk and not put on the
 *     window is a setting that "does not work", with a green toast saying it
 *     does — the exact shape of the bug the audio defaults section already
 *     carries a comment about.
 *
 * Both are checked by reading the two files, because neither can be imported
 * here: the handler pulls in `electron`.
 */
export {};

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  DEFAULT_UI_SCALE, UI_SCALES, UI_SCALE_LABELS, isUiScale,
} from '@aimaster/shared-types';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

const HANDLER = 'src/main/ipc/settingsHandlers.ts';
const MAIN = 'src/main/index.ts';
const PAGE = 'src/renderer/pages/SettingsPage.tsx';
const handler = readFileSync(HANDLER, 'utf8');
const main = readFileSync(MAIN, 'utf8');
const page = readFileSync(PAGE, 'utf8');

console.log('\n=== UI 배율 ===\n');

// ── The list ─────────────────────────────────────────────────────────────
{
  check(
    'the steps include 100 %, and that is the default',
    UI_SCALES.includes(1) && DEFAULT_UI_SCALE === 1 && isUiScale(DEFAULT_UI_SCALE),
    `${UI_SCALES.map((v) => `${Math.round(v * 100)}%`).join(' · ')}`,
  );
  check(
    'they go up as well as down — the problem being solved is text that is too SMALL',
    UI_SCALES.some((v) => v > 1) && Math.max(...UI_SCALES) >= 1.4,
    `largest ${Math.round(Math.max(...UI_SCALES) * 100)}% — 8 px becomes ${(8 * Math.max(...UI_SCALES)).toFixed(1)} px`,
  );
  check(
    'they are sorted and unique, so the dropdown reads in order',
    UI_SCALES.every((v, i) => i === 0 || v > (UI_SCALES[i - 1] ?? 0)),
    'ascending, no duplicates',
  );
  const unlabelled = UI_SCALES.filter((v) => !UI_SCALE_LABELS[String(v)]);
  check(
    'every step has a label, because "1.25" is not what anybody wants to read',
    unlabelled.length === 0,
    unlabelled.length === 0
      ? UI_SCALES.map((v) => UI_SCALE_LABELS[String(v)]).join(' / ')
      : `missing: ${unlabelled.join(', ')}`,
  );
  const extra = Object.keys(UI_SCALE_LABELS).filter((k) => !UI_SCALES.includes(Number(k)));
  check(
    'and no label describes a step that does not exist',
    extra.length === 0,
    extra.length === 0 ? `${Object.keys(UI_SCALE_LABELS).length} labels for ${UI_SCALES.length} steps` : extra.join(', '),
  );
}

// ── The guard ────────────────────────────────────────────────────────────
{
  const rejected = [0, 1.3, 2, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY,
    '1', null, undefined, {}, [1]];
  const leaked = rejected.filter((v) => isUiScale(v));
  check(
    'a value that is not one of the steps is refused, whatever its type',
    leaked.length === 0,
    leaked.length === 0
      ? `${rejected.length} non-steps refused, including 1.3 and the string "1"`
      : `accepted: ${leaked.map(String).join(', ')}`,
  );
  check(
    'and every step passes its own guard',
    UI_SCALES.every((v) => isUiScale(v)),
    `${UI_SCALES.length}/${UI_SCALES.length}`,
  );
}

// ── Stored means applied ─────────────────────────────────────────────────
{
  check(
    'uiScale is in the handler\'s validator table, so the key is writable at all',
    /uiScale:\s*isUiScale,/.test(handler),
    'the table is the whitelist — an unlisted key is rejected by name',
  );
  check(
    'and the validator IS the shared guard, not a second range check',
    !/uiScale:\s*\(v\)/.test(handler) && /from '@aimaster\/shared-types'/.test(handler),
    'isUiScale passed by reference',
  );
  check(
    'the window is scaled in the same call that stores the number',
    /if \(key === 'uiScale'\) applyUiScale\(win\);/.test(handler),
    'no separate channel to forget to call — stored and applied cannot diverge',
  );
  check(
    'the apply falls back to the default when nothing is stored, or junk is',
    /const scale = isUiScale\(stored\) \? stored : DEFAULT_UI_SCALE;/.test(handler),
    'a store written by an older build cannot leave the window at an impossible zoom',
  );
  check(
    'and it is the main process that calls setZoomFactor, not the renderer',
    /win\?\.webContents\.setZoomFactor\(scale\)/.test(handler)
      && !/setZoomFactor/.test(page),
    'the renderer cannot scale itself out of reach',
  );
}

// ── Startup ──────────────────────────────────────────────────────────────
{
  check(
    'the stored scale is applied at startup, not only when it is changed',
    /applyUiScale\(mainWindow\)/.test(main),
    'otherwise every launch opens at 100 % and the setting looks forgotten',
  );
  check(
    'on did-finish-load, which is before the window is shown',
    /did-finish-load'[\s\S]{0,200}applyUiScale\(mainWindow\)/.test(main),
    'applying it to a visible window is a visible reflow the user watches happen',
  );
  const showAt = main.indexOf("mainWindow.once('ready-to-show'");
  const scaleAt = main.indexOf('applyUiScale(mainWindow)');
  check(
    'and the listener is registered before the show handler',
    scaleAt > 0 && showAt > 0 && scaleAt < showAt,
    'registration order: scale, then show',
  );
}

// ── The page ─────────────────────────────────────────────────────────────
{
  check(
    'the settings page has an appearance section at all',
    /function AppearanceSection\(\)/.test(page) && /<AppearanceSection \/>/.test(page),
    'it had six rows and none of them was about reading the screen',
  );
  check(
    'and it builds its options from the shared list, not from a literal',
    /UI_SCALES\.map\(/.test(page) && !/\[0\.9,\s*1,/.test(page),
    'one list, two processes',
  );
  check(
    'it reads the stored value back on mount',
    /invoke\('settings:get', 'uiScale'\)/.test(page) && /isUiScale\(saved\)/.test(page),
    'the main process already scaled this window from that value — a local default would contradict it',
  );
  check(
    'and a refused write puts the control back instead of lying',
    /setScale\(previous\);/.test(page) && /배율을 저장하지 못했습니다/.test(page),
    'no green toast over a store that refused',
  );
}

// ── The measurement that started it ──────────────────────────────────────
{
  // Not an assertion about a target — the density is deliberate — but a
  // record of what the setting exists for, and a tripwire if it ever gets
  // dramatically worse while nobody is looking.
  const count = Number(execSync(
    `grep -rhoE 'text-\\[(8|8\\.5|9|9\\.5|10|10\\.5)px\\]' --include=*.tsx src/renderer | wc -l`,
    { encoding: 'utf8' },
  ).trim());
  check(
    'the small-text count is still in the range this setting was built for',
    count > 300 && count < 900,
    `${count} pieces of text under 11 px — one number scales all of them`,
  );
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
