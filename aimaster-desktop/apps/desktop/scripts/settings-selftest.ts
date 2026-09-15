/**
 * settings-selftest.ts — the settings page has to mean something.
 *
 * Every one of the four rows on that page used to be write-only.  Two of them
 * were worse than that: 샘플레이트 and 비트 뎁스 are `<select value={options.*}>`
 * whose onChange wrote to disk and not to the store, so the dropdown SNAPPED
 * BACK to the old value while a green "설정이 저장되었습니다" said otherwise.
 * And nothing on either side of the app ever read any of the four keys again,
 * so a preference set on Monday was gone on Tuesday.
 *
 * Three things have to hold for that to stay fixed, and only the first is
 * testable as a function:
 *
 *   1. the rules — what a stored value has to look like to be honoured, and
 *      where a dialog opens because of one;
 *   2. the wiring — the page writes BOTH halves, startup reads them back, and
 *      the export dialogs ask for the directory;
 *   3. the agreement — the list the page offers, the list the main-process
 *      validator accepts and the type the options hold are one list.
 *
 * 2 and 3 are read out of the source, because a rule that holds in a unit test
 * and not in the file that ships is not a rule.
 *
 * Run via:
 *   pnpm --filter @aimaster/desktop test:settings
 */

import { readFileSync } from 'node:fs';
import { resolveOutputDir, joinSavePath } from '../src/main/utils/savePath.js';
import {
  audioDefaultsPatch, readAudioDefaults,
  SAMPLE_RATES, BIT_DEPTHS, AUDIO_DEFAULT_KEYS,
} from '../src/renderer/lib/audio-defaults.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void | Promise<void>): void {
  try {
    const r = fn();
    if (r instanceof Promise) throw new Error('use checkAsync for an async body');
    results.push({ name, pass: true, detail: '' });
  } catch (e) {
    results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) });
  }
}
const pending: Promise<void>[] = [];
function checkAsync(name: string, fn: () => Promise<void>): void {
  pending.push(fn().then(
    () => { results.push({ name, pass: true, detail: '' }); },
    (e: unknown) => { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); },
  ));
}
function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
function eq<T>(a: T, b: T, msg: string): void {
  if (a !== b) throw new Error(`${msg} — got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`);
}
function deep(a: unknown, b: unknown, msg: string): void {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${msg} — got ${x}, expected ${y}`);
}

const SETTINGS_PAGE = readFileSync('src/renderer/pages/SettingsPage.tsx', 'utf8');
const SETTINGS_HANDLERS = readFileSync('src/main/ipc/settingsHandlers.ts', 'utf8');
const FILE_HANDLERS = readFileSync('src/main/ipc/fileHandlers.ts', 'utf8');
const MAIN_TSX = readFileSync('src/renderer/main.tsx', 'utf8');

// ── 1. Where a dialog opens ─────────────────────────────────────────────────

check('a folder that is there is the folder the dialog opens in', () => {
  eq(resolveOutputDir('/music/masters', () => true), '/music/masters', 'a live folder');
  eq(joinSavePath('song.wav', '/music/masters'), '/music/masters/song.wav', 'the suggested path');
});

check('a folder that is gone is no folder at all', () => {
  // An unplugged drive must not be handed to a dialog — it opens somewhere
  // else on macOS and errors on Windows, and neither is something a user can
  // act on.  Falling back to the basename restores the pre-setting behaviour.
  eq(resolveOutputDir('/Volumes/gone', () => false), null, 'a dead path');
  eq(joinSavePath('song.wav', null), 'song.wav', 'the fallback is the bare name');
});

check('nothing stored is not an error', () => {
  for (const nothing of [undefined, null, '', 42, {}, []]) {
    eq(resolveOutputDir(nothing, () => true), null, `resolveOutputDir(${JSON.stringify(nothing)})`);
  }
});

check('a name with separators in it cannot escape the chosen folder', () => {
  // The callers pass names they built themselves, but the rule is the point:
  // if a name could carry a path, the setting would stop meaning anything.
  eq(joinSavePath('../../etc/passwd', '/music'), '/music/passwd', 'a climbing name');
  eq(joinSavePath('/tmp/elsewhere.wav', '/music'), '/music/elsewhere.wav', 'an absolute name');
});

// ── 2. What startup reads back ──────────────────────────────────────────────

check('a stored preference survives the relaunch it was stored for', () => {
  deep(
    audioDefaultsPatch({ defaultStyle: 'warm', defaultSampleRate: 48000, defaultBitDepth: 16 }),
    { style: 'warm', sampleRate: 48000, bitDepth: 16 },
    'all three keys',
  );
});

check('a fresh install reads back nothing and that is fine', () => {
  deep(audioDefaultsPatch({}), {}, 'an empty store');
});

check('one bad key does not throw away the good ones', () => {
  // The whole reason each key is validated on its own.  A hand-edited config
  // or a key written by an older build must cost that key, not the section.
  deep(
    audioDefaultsPatch({ defaultStyle: 'warm', defaultSampleRate: 22050, defaultBitDepth: 99 }),
    { style: 'warm' },
    'a good style beside two bad numbers',
  );
});

check('a value the options type cannot hold is dropped, not coerced', () => {
  for (const bad of [88200, 32000, '48000', null, NaN]) {
    deep(audioDefaultsPatch({ defaultSampleRate: bad }), {}, `sampleRate ${String(bad)}`);
  }
  for (const bad of [32, 8, '24', true]) {
    deep(audioDefaultsPatch({ defaultBitDepth: bad }), {}, `bitDepth ${String(bad)}`);
  }
  for (const bad of ['natural', 'loud', 'kpop_loud', 'nonsense', 7]) {
    // MasteringStyle has more members than this page offers; hydration must
    // not install one the dropdown cannot show, or the select goes blank.
    deep(audioDefaultsPatch({ defaultStyle: bad }), {}, `style ${String(bad)}`);
  }
});

checkAsync('a key that throws costs that key and nothing else', async () => {
  const patch = await readAudioDefaults(async (_c, key) => {
    if (key === 'defaultSampleRate') throw new Error('unknown key');
    if (key === 'defaultStyle') return 'bright';
    return 24;
  });
  deep(patch, { style: 'bright', bitDepth: 24 }, 'two of three');
});

checkAsync('every key this module owns is actually asked for', async () => {
  const asked: string[] = [];
  await readAudioDefaults(async (_c, key) => { asked.push(String(key)); return undefined; });
  deep(asked, [...AUDIO_DEFAULT_KEYS], 'the keys read at startup');
});

// ── 3. The page writes both halves ──────────────────────────────────────────

check('the settings page updates the store, not only the disk', () => {
  // The exact defect: `onChange` that only called `save(...)`.  Each of the
  // two numeric rows must now hand `save` an options patch as well.
  assert(/save\(\{ sampleRate: v \}, 'defaultSampleRate', v\)/.test(SETTINGS_PAGE),
    '샘플레이트 no longer patches options.sampleRate — the dropdown will snap back');
  assert(/save\(\{ bitDepth: v \}, 'defaultBitDepth', v\)/.test(SETTINGS_PAGE),
    '비트 뎁스 no longer patches options.bitDepth — the dropdown will snap back');
  assert(SETTINGS_PAGE.includes('updateOptions(patch)'),
    'save() no longer applies its patch to the store');
});

check('a write that fails does not raise a success toast', () => {
  const body = SETTINGS_PAGE.slice(SETTINGS_PAGE.indexOf('const save = useCallback'));
  const save = body.slice(0, body.indexOf('}, [notify'));
  assert(save.includes('try {') && save.includes('catch'),
    'settings:set is unguarded again — a refused write would still say 저장되었습니다');
  assert(save.indexOf("notify('설정이 저장되었습니다.', 'success')") > save.indexOf('await window.electronAPI.invoke'),
    'the success toast no longer waits for the write');
});

// ── 4. Startup hydrates ─────────────────────────────────────────────────────

check('something actually calls the read side at startup', () => {
  // The CALL, not the import.  An earlier version of this check looked for
  // the bare name and passed against a file where only the import survived.
  assert(/readAudioDefaults\s*\(/.test(MAIN_TSX),
    'nothing calls readAudioDefaults at startup — the section is write-only again');
  const at = MAIN_TSX.search(/readAudioDefaults\s*\(/);
  const block = MAIN_TSX.slice(at, at + 600);
  assert(/updateOptions\(patch\)/.test(block),
    'the hydrated patch is read but never applied to the store');
});

// ── 5. The export dialogs ask where to open ─────────────────────────────────

check('every user-facing audio export opens in the chosen folder', () => {
  // The four dialogs a person reaches with 내보내기 / 저장 / 바운스 / 일괄 저장.
  for (const channel of ['file:save-wav', 'file:save-audio', 'daw:bounce-audio']) {
    const at = FILE_HANDLERS.indexOf(`ipc.handle('${channel}'`);
    assert(at > 0, `${channel} is gone`);
    const body = FILE_HANDLERS.slice(at, FILE_HANDLERS.indexOf("ipc.handle('", at + 20));
    assert(body.includes('defaultSavePath('),
      `${channel} builds its defaultPath without the output directory`);
  }
  const batchAt = FILE_HANDLERS.indexOf("ipc.handle('file:batch-save-wav'");
  const batch = FILE_HANDLERS.slice(batchAt, FILE_HANDLERS.indexOf("ipc.handle('", batchAt + 20));
  assert(batch.includes('outputDir()'),
    'the batch folder picker ignores the output directory');
});

// ── 6. One list, three places ───────────────────────────────────────────────

check('the page offers exactly what the main process accepts', () => {
  const rates = SETTINGS_HANDLERS.slice(SETTINGS_HANDLERS.indexOf('defaultSampleRate:'));
  for (const rate of SAMPLE_RATES) {
    assert(rates.slice(0, rates.indexOf('\n')).includes(String(rate)),
      `the validator rejects ${rate} Hz, which the page offers`);
  }
  const depths = SETTINGS_HANDLERS.slice(SETTINGS_HANDLERS.indexOf('defaultBitDepth:'));
  const depthLine = depths.slice(0, depths.indexOf('\n'));
  for (const d of BIT_DEPTHS) {
    assert(depthLine.includes(String(d)), `the validator rejects ${d}-bit, which the page offers`);
  }
  // And the other way: a validator wider than the page is how 88.2 kHz and
  // 32-bit sat in the whitelist for values the options type cannot hold.
  for (const never of ['88200', '32']) {
    const line = never === '32' ? depthLine : rates.slice(0, rates.indexOf('\n'));
    assert(!new RegExp(`\\b${never}\\b`).test(line),
      `the validator still accepts ${never}, which the page never offers`);
  }
});

check('the page builds its dropdowns from that list rather than a second copy', () => {
  assert(SETTINGS_PAGE.includes('SAMPLE_RATES.map') && SETTINGS_PAGE.includes('BIT_DEPTHS.map'),
    'the settings page hardcodes its options again — the two lists will drift');
});

// ── Report ──────────────────────────────────────────────────────────────────

// The async checks finish before anything is counted: a tally taken while a
// promise is still in flight reports fewer checks than it printed, which is a
// bug this suite has shipped once already.
void (async () => {
  await Promise.all(pending);

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;

  console.log('\n=== settings: the page has to mean something ===');
  for (const r of results) {
    console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
  if (failed > 0) process.exit(1);
})();
