/**
 * ipc-validation-selftest — the check every file channel trusts.
 *
 * `src/main/utils/ipcValidation.ts` is the one validator fifteen IPC
 * handlers route their path argument through, and it had no test of any
 * kind.  Computing the import closure from `scripts/` found it: 645 source
 * files, 386 reached by some selftest, and this one among the 77 logic
 * modules nothing reached.
 *
 * What it was missing is what reading it found:
 *
 *     const resolved = path.resolve(input);
 *     if (!path.isAbsolute(resolved)) throw ...
 *
 * `path.resolve()` always returns an absolute path, so the throw was dead.
 * Measured, every one of these was accepted and resolved against the main
 * process's working directory:
 *
 *     "foo.wav"  "."  ".."  "../../../../etc/passwd"  "~/secret.wav"
 *
 * The same three checks were copy-pasted into `file:get-info`, dead branch
 * and all, so that channel had the hole twice.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:ipc-validation
 */

import fs from 'node:fs';
import path from 'node:path';
import { validateAbsoluteFilePath } from '../src/main/utils/ipcValidation.js';
import { samplePathIn, SamplePathError } from '../src/main/utils/samplePath.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}
/** The error a call threw, or '' when it returned. */
function threw(fn: () => unknown): string {
  try { fn(); return ''; } catch (e) { return (e as Error).message; }
}

const CH = 'test:channel';
const v = (x: unknown): string => validateAbsoluteFilePath(x, CH);

console.log('\n=== WHAT IT MUST REFUSE ===\n');

// The whole point of the function, and the thing it never did.
for (const bad of ['foo.wav', '.', '..', 'a/b.wav', './a.wav', '../../../../etc/passwd', '~/secret.wav']) {
  const msg = threw(() => v(bad));
  check(
    `a relative path is refused: ${JSON.stringify(bad)}`,
    msg.includes('must be absolute'),
    msg || `returned ${JSON.stringify(path.resolve(bad))} — resolved against cwd`,
  );
}

for (const [label, bad] of [
  ['a number', 42], ['null', null], ['undefined', undefined],
  ['an object', { path: '/x' }], ['an array', ['/x']], ['the empty string', ''],
] as const) {
  const msg = threw(() => v(bad));
  check(`${label} is refused`, msg.includes('non-empty string'), msg || 'returned');
}

check(
  'a null byte is refused even inside an absolute path',
  threw(() => v('/tmp/ok\0.wav')).includes('null byte'),
  threw(() => v('/tmp/ok\0.wav')),
);
check(
  'and the channel name is in the message, so a rejection says where it came from',
  threw(() => v('relative.wav')).startsWith(`${CH}:`),
  threw(() => v('relative.wav')),
);

console.log('\n=== WHAT IT MUST ACCEPT, AND HOW IT HANDS IT BACK ===\n');

check(
  'an absolute path comes back unchanged',
  v('/tmp/song.wav') === path.resolve('/tmp/song.wav'),
  v('/tmp/song.wav'),
);
check(
  'traversal segments inside an absolute path are collapsed once, here',
  v('/tmp/a/b/../../song.wav') === path.join(path.sep, 'tmp', 'song.wav'),
  v('/tmp/a/b/../../song.wav'),
);
check(
  'a trailing separator is normalised away',
  v(`${path.sep}tmp${path.sep}dir${path.sep}`) === path.join(path.sep, 'tmp', 'dir'),
  v(`${path.sep}tmp${path.sep}dir${path.sep}`),
);
check(
  'a path with spaces and non-ASCII is fine — these are real filenames',
  v('/tmp/LOOK GOOD Stems/보컬 믹스.wav') === '/tmp/LOOK GOOD Stems/보컬 믹스.wav',
  v('/tmp/LOOK GOOD Stems/보컬 믹스.wav'),
);
check(
  'the result is independent of the working directory',
  v('/tmp/x.wav') === '/tmp/x.wav' && !v('/tmp/x.wav').includes(process.cwd()),
);

console.log('\n=== AND IT IS NOT THE VALIDATOR FOR CONTENT-SUPPLIED PATHS ===\n');

// Two different jobs with opposite answers, and a reader of one should not
// assume the other. A path the USER chose may be anywhere on their disk; a
// path that arrived inside a downloaded .sfz may not.
const root = path.join(path.sep, 'tmp', 'library');
check(
  'the user-path validator does not confine anything, on purpose',
  v('/etc/passwd') === '/etc/passwd',
  'these channels exist to open the user\'s own files anywhere',
);
check(
  'the content-path validator refuses an absolute path',
  threw(() => samplePathIn(root, '/etc/passwd')) !== '',
  threw(() => samplePathIn(root, '/etc/passwd')),
);
check(
  'and refuses a traversal out of its root',
  threw(() => samplePathIn(root, '../../../../etc/passwd')) !== '',
  threw(() => samplePathIn(root, '../../../../etc/passwd')),
);
check(
  'while allowing what is genuinely inside',
  samplePathIn(root, 'kicks/kick.wav') === path.join(root, 'kicks', 'kick.wav'),
  samplePathIn(root, 'kicks/kick.wav'),
);
check(
  'its refusals are typed, so a caller can tell them from an I/O error',
  (() => { try { samplePathIn(root, '/x'); return false; } catch (e) { return e instanceof SamplePathError; } })(),
);

console.log('\n=== AND THERE IS ONLY ONE OF IT ===\n');

// The dead check did not only live in the validator: `file:get-info` had
// its own copy of all three tests, dead branch included, so that channel
// carried the hole twice and fixing one place would not have fixed it.
//
// A source check rather than a behavioural one, because the handlers need
// an Electron main process to run. It asks the narrow question that catches
// the duplicate coming back: who decides whether a path is absolute?
const OWNERS = ['src/main/utils/ipcValidation.ts', 'src/main/utils/samplePath.ts'];
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(full));
    else if (e.name.endsWith('.ts')) out.push(full);
  }
  return out;
}
const DESKTOP = path.resolve(__dirname, '..');
// Comments are stripped first. The question is who DECIDES, and a comment
// recording why the old check could not fail is exactly the kind of note
// that should survive — this check flagged its own explanation on the first
// run.
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[^\n]*?\/\/.*$/gm, (line) => (
    // Keep anything before a `//` so a trailing comment does not hide code.
    line.slice(0, line.indexOf('//'))
  ));
}
const offenders = filesUnder(path.join(DESKTOP, 'src', 'main'))
  .filter((f) => /\bisAbsolute\b/.test(codeOnly(fs.readFileSync(f, 'utf8'))))
  .map((f) => path.relative(DESKTOP, f).split(path.sep).join('/'))
  .filter((f) => !OWNERS.includes(f));
check(
  'only the two path validators decide whether a path is absolute',
  offenders.length === 0,
  offenders.length > 0
    ? `also in: ${offenders.join(', ')} — route it through validateAbsoluteFilePath instead`
    : OWNERS.join(' + '),
);

// The null-byte test is the second marker, and a better one: nothing needs
// to look for `\0` in a string unless it is about to treat it as a path.
// Three channels were found this way — `daw:pcm-source`, `video:probe` and
// `file:open-in-finder` — each with its own copy of the string / empty /
// null-byte trio, and each accepting a RELATIVE path that the shared
// validator refuses. Same shape as the `file:get-info` copy that carried
// the dead check.
//
// `settingsHandlers.ts` is allowed: its null-byte test guards a settings
// VALUE on its way into the store, not a path on its way to `fs`.
const NULLBYTE_OK = [...OWNERS, 'src/main/ipc/settingsHandlers.ts'];
const handRolled = filesUnder(path.join(DESKTOP, 'src', 'main'))
  .filter((f) => /includes\('\\0'\)/.test(codeOnly(fs.readFileSync(f, 'utf8'))))
  .map((f) => path.relative(DESKTOP, f).split(path.sep).join('/'))
  .filter((f) => !NULLBYTE_OK.includes(f));
check(
  'no handler re-implements the path checks for itself',
  handRolled.length === 0,
  handRolled.length > 0
    ? `hand-rolled in: ${handRolled.join(', ')}`
    : 'every renderer path goes through one of the two validators',
);
// And the owner is where it says it is, so the check above cannot pass by
// looking at the wrong tree.
check(
  'the validator this test guards is one of them',
  fs.existsSync(path.join(DESKTOP, OWNERS[0]!)),
  OWNERS[0]!,
);

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
