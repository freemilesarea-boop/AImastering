/**
 * snapshot-panel-selftest.ts — the way back out of a mix snapshot.
 *
 * The audit that produced this: `Mod+Alt+Shift+M` took a snapshot, twelve of
 * them could pile up, and `restoreSnapshot` / `removeSnapshot` — both fully
 * written and covered by tier-c — had NO caller anywhere in the app.  The
 * "목록" shortcut did not show a list; it raised a one-line toast about the
 * newest one and switched windows.  So the mixer could save a version of
 * itself that nothing could recall or throw away, which is worse than not
 * offering it, because it looks like it worked.
 *
 * Two kinds of check, and the second is the one that would have caught it:
 *
 *   • BEHAVIOUR — the two helpers the panel needs (`snapshotAge`,
 *     `describeRestore`) say the right thing at the boundaries.
 *   • ROUTE — the panel exists, the mixer renders it, the shortcut toggles
 *     it, and the panel actually calls restore and delete.  A helper with a
 *     passing unit test and no route to it is the exact defect here, so a
 *     test that only exercised the model would have passed throughout.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  describeRestore, snapshotAge, type RestoreResult,
} from '../src/renderer/daw/model/mix-snapshot.js';
import type { DawSession } from '../src/renderer/daw/model/types.js';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed += 1; console.log(`[PASS] ${name}`); }
  else    { failed += 1; console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}

function read(rel: string): string {
  return fs.readFileSync(path.join(DESKTOP, rel), 'utf8');
}

/** Comments out, because this repo has repeatedly written checks that matched prose. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; })
    .join('\n');
}

// ── 1. How long ago ─────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const ago = (ms: number): string => snapshotAge(NOW - ms, NOW);

check('under a minute reads as 방금', ago(0) === '방금' && ago(59_000) === '방금',
  `${ago(0)} / ${ago(59_000)}`);
check('a minute is a minute', ago(60_000) === '1분 전', ago(60_000));
check('59 minutes is still minutes', ago(59 * 60_000) === '59분 전', ago(59 * 60_000));
check('an hour turns over to hours', ago(60 * 60_000) === '1시간 전', ago(60 * 60_000));
check('23 hours is still hours', ago(23 * 3600_000) === '23시간 전', ago(23 * 3600_000));
// Past a day a duration stops being something anyone can feel — "1500분 전"
// is not an answer — so it goes back to being a date.
check('past a day it becomes a date',
  !/[분시]간? 전|방금/.test(ago(25 * 3600_000)) && ago(25 * 3600_000).length > 0,
  ago(25 * 3600_000));
// A clock that moved backwards must not print a negative age.
check('a snapshot from the future clamps to 방금',
  snapshotAge(NOW + 90_000, NOW) === '방금', snapshotAge(NOW + 90_000, NOW));

// ── 2. What a restore did ───────────────────────────────────────────────────

const result = (restored: number, gone: string[], added: string[]): RestoreResult =>
  ({ session: null as unknown as DawSession, restored, gone, added });

check('a clean restore says only what it restored',
  describeRestore(result(9, [], [])) === '채널 9개 복구',
  describeRestore(result(9, [], [])));

// The defect this guards: a snapshot that matched two of nine channels DID
// restore something, and a message that said only "복구" would let that pass
// for success.  The channels it could not find are the part worth reading.
const partial = describeRestore(result(2, ['킥', '스네어'], []));
check('channels the snapshot lost are named in the count',
  partial.includes('2개 복구') && partial.includes('없어진 채널 2개'), partial);

const fresh = describeRestore(result(4, [], ['보컬 더블']));
check('channels added since are reported as left alone',
  fresh.includes('새 채널 1개') && fresh.includes('그대로'), fresh);
check('nothing extra is said when there is nothing extra',
  !describeRestore(result(3, [], [])).includes('·'),
  describeRestore(result(3, [], [])));

// ── 3. The route from the mixer to those functions ──────────────────────────

const panel = stripComments(read('src/renderer/components/daw/mix/SnapshotPanel.tsx'));
const mixWindow = stripComments(read('src/renderer/components/daw/mix/MixWindow.tsx'));
const store = stripComments(read('src/renderer/stores/dawStore.ts'));
const commands = stripComments(read('src/renderer/shortcuts/daw-commands.ts'));

check('the panel restores', /restoreSnapshot\s*\(/.test(panel));
check('the panel deletes', /dropSnapshot\s*\(/.test(panel));
check('the panel previews the difference before restoring',
  /diffSnapshot\s*\(/.test(panel) && /describeSnapshot\s*\(/.test(panel));
// Restoring a mix is an edit.  Through `onApply` it lands on the undo stack;
// setting the session directly would make it the one edit Mod+Z cannot reach.
check('restoring goes through apply, so it is undoable', /onApply\s*\(/.test(panel));

check('the mixer renders the panel',
  /import\s+SnapshotPanel\s+from/.test(mixWindow) && /<SnapshotPanel\b/.test(mixWindow));
check('the mixer has a button for it', /스냅샷 \{snapshots\.length\}/.test(mixWindow));

check('the store can delete one snapshot',
  /dropSnapshot:\s*\(id\)\s*=>/.test(store) && /removeSnapshot\(/.test(store));
check('the store holds whether the panel is open',
  /snapshotsOpen:\s*false/.test(store) && /setSnapshotsOpen:/.test(store));

check('the shortcut toggles the panel rather than raising a toast',
  /setSnapshotsOpen\(false\)/.test(commands) && /setSnapshotsOpen\(true\)/.test(commands));

// The reason this file exists: these two had no caller outside a test.
for (const fn of ['restoreSnapshot', 'removeSnapshot'] as const) {
  const callers = ['src/renderer/components/daw/mix/SnapshotPanel.tsx', 'src/renderer/stores/dawStore.ts']
    .map((f) => stripComments(read(f)))
    .filter((src) => src.includes(fn));
  check(`${fn} is reachable from the app`, callers.length > 0,
    'implemented and tested, with no route to it');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
