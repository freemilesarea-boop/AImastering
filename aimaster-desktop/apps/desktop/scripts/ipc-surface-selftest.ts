/**
 * ipc-surface-selftest — the renderer can reach every handler, and nothing else.
 *
 * `src/preload/index.ts` is the whole border between the renderer and the
 * main process, and it is three lists plus two hand-written namespaces.  Both
 * directions of drift are silent:
 *
 *   a channel on the allowlist with no handler  → the feature's button throws
 *     "No handler registered for '…'" the first time a user presses it
 *   a handler nobody can name                  → main-process code the
 *     renderer can never reach, which reads as a working feature in review
 *
 * Measured when this was written, and clean in every direction: 72 allowlisted
 * invoke channels against 72 handlers with no gap either way, and 2 listen
 * channels against the 2 the main process sends.  So this is a ratchet, not a
 * repair — the point is that nothing held the symmetry, and the next handler
 * added without a preload entry would have been an unreachable feature that
 * compiles, lints and reviews fine.
 *
 * ── What actually makes a channel safe ───────────────────────────────────
 *
 * Not the allowlist, for two of the three bridges.  `window.electronAPI`
 * takes the channel as an ARGUMENT, so it checks it against
 * `INVOKE_CHANNELS` and throws on anything else — there, the list is the
 * guard.  `window.updater` and `window.louiAssets` instead hardcode their
 * channel names and call `ipcRenderer.invoke` directly, so there is no
 * argument to validate and the list never runs.
 *
 * The `window.updater` docblock claimed the opposite — "All channels are
 * still routed through the validated INVOKE_CHANNELS list above" — which
 * would have told a reader that removing a channel from the list disables
 * the namespace.  It does not.  The claim is corrected and the real rule is
 * held here: a channel the renderer can NAME must be allowlisted; a channel
 * preload hardcodes needs only a handler.
 *
 * Run:  pnpm --filter @aimaster/desktop test:ipc-surface
 */

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(cond: unknown, detail: string): void { if (!cond) throw new Error(detail); }
const show = (s: Iterable<string>): string => [...s].sort().join(', ');

const PRELOAD = 'src/preload/index.ts';
const preload = readFileSync(PRELOAD, 'utf8');

/** Strip `//` comments so a channel named in prose is not read as a channel. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** The string literals inside a named `const X = [ … ]` array. */
function arrayLiteral(name: string): Set<string> {
  const m = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\]`).exec(preload);
  if (!m) throw new Error(`${PRELOAD} has no ${name} array — the border moved, so this test has to move with it`);
  return new Set([...codeOnly(m[1]!).matchAll(/'([^']+)'/g)].map((x) => x[1]!));
}

const INVOKE_ALLOWED = arrayLiteral('INVOKE_CHANNELS');
const LISTEN_ALLOWED = arrayLiteral('LISTEN_CHANNELS');

/** Channels a preload namespace hardcodes — no argument, so no allowlist. */
const code = codeOnly(preload);
const HARDCODED_INVOKE = new Set([...code.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]!));
const HARDCODED_LISTEN = new Set([...code.matchAll(/ipcRenderer\.on\('([^']+)'/g)].map((m) => m[1]!));

const mainFiles = execSync("find src/main -name '*.ts'", { encoding: 'utf8' }).trim().split('\n');
const HANDLERS = new Set<string>();
const SENDS = new Set<string>();
for (const f of mainFiles) {
  const t = codeOnly(readFileSync(f, 'utf8'));
  for (const m of t.matchAll(/ipc(?:Main)?\.handle\(\s*'([^']+)'/g)) HANDLERS.add(m[1]!);
  for (const m of t.matchAll(/\.send\(\s*'([^']+)'/g)) SENDS.add(m[1]!);
}

check('every channel the renderer may invoke has a handler', () => {
  // The failure a user meets: a button that throws on first press.
  const missing = [...INVOKE_ALLOWED].filter((c) => !HANDLERS.has(c));
  assert(missing.length === 0,
    `${missing.length} allowlisted channel(s) with no handler: ${show(missing)}`);
  assert(INVOKE_ALLOWED.size > 0, 'the allowlist parsed empty — the regex lost the array');
});

check('and every handler can be reached from the renderer', () => {
  // The other direction: main-process code behind a door with no handle.
  const unreachable = [...HANDLERS].filter((c) => !INVOKE_ALLOWED.has(c) && !HARDCODED_INVOKE.has(c));
  assert(unreachable.length === 0,
    `${unreachable.length} handler(s) no bridge can name: ${show(unreachable)}\n`
    + `  Add it to INVOKE_CHANNELS, give it a namespace, or delete it.`);
  assert(HANDLERS.size > 0, 'no handlers found — the find/regex lost them');
});

check('every event the renderer may listen for is actually sent', () => {
  const never = [...LISTEN_ALLOWED, ...HARDCODED_LISTEN].filter((c) => !SENDS.has(c));
  assert(never.length === 0,
    `${never.length} listen channel(s) nothing sends: ${show(never)}`);
});

check('and every event main sends can be listened for', () => {
  // A `webContents.send` the preload blocks is a message that arrives
  // nowhere — the renderer's `on()` throws "Blocked listen channel".
  const unheard = [...SENDS].filter((c) => !LISTEN_ALLOWED.has(c) && !HARDCODED_LISTEN.has(c));
  assert(unheard.length === 0,
    `${unheard.length} sent event(s) no bridge passes through: ${show(unheard)}`);
  assert(SENDS.size > 0, 'no sends found — the regex lost them');
});

check('the generic bridge validates the channel it is handed', () => {
  // `invoke` and `on` take the channel from the CALLER, so the list is the
  // only thing between the renderer and every handler in main.  Checked
  // against the source because running preload needs Electron.
  assert(/INVOKE_CHANNELS as readonly string\[\]\)\.includes\(channel\)/.test(code),
    'electronAPI.invoke no longer checks the channel against INVOKE_CHANNELS');
  assert(/Blocked IPC channel/.test(preload), 'the invoke guard no longer throws');
  assert(/LISTEN_CHANNELS as readonly string\[\]\)\.includes\(channel\)/.test(code),
    'electronAPI.on no longer checks the channel against LISTEN_CHANNELS');
  assert(/Blocked listen channel/.test(preload), 'the listen guard no longer throws');
});

check('the dedicated namespaces hardcode their channels, so the list is not their guard', () => {
  // This is the claim that was wrong.  `window.updater` said its channels
  // were "routed through the validated INVOKE_CHANNELS list"; they are not —
  // it calls `ipcRenderer.invoke` with a literal.  That is safe for the
  // opposite reason: there is no caller-supplied name to validate.
  assert(HARDCODED_INVOKE.size > 0, 'no namespace hardcodes a channel any more — then this check is obsolete');
  for (const c of HARDCODED_INVOKE) {
    assert(HANDLERS.has(c), `${c} is hardcoded in a preload namespace with no handler`);
  }
  // And the corrected comment must not say the list protects them.
  const updaterBlock = /Dedicated `window\.updater`[\s\S]*?exposeInMainWorld\('updater'/.exec(preload)?.[0] ?? '';
  assert(updaterBlock !== '', 'the window.updater block moved — re-read it before trusting this check');
  // Flattened first.  The claim spans a line break, so matching it as written
  // never matched and this check passed while the sentence was still there —
  // a decorative check is worse than none, because it reports the opposite.
  const flat = updaterBlock.replace(/\n\s*\/\/\s?/g, ' ').replace(/\s+/g, ' ');
  assert(!/routed through the validated INVOKE_CHANNELS/.test(flat),
    'the window.updater docblock claims the allowlist validates its calls — it bypasses the wrapper entirely');
});

check('no channel is listed twice, in either list', () => {
  // A duplicate is harmless to `includes()` and a sign the two halves of a
  // rename did not meet.
  for (const [label, name] of [['INVOKE_CHANNELS', 'INVOKE_CHANNELS'], ['LISTEN_CHANNELS', 'LISTEN_CHANNELS']] as const) {
    const m = new RegExp(`const ${name} = \\[([\\s\\S]*?)\\n\\]`).exec(preload)!;
    const all = [...codeOnly(m[1]!).matchAll(/'([^']+)'/g)].map((x) => x[1]!);
    const dupes = all.filter((c, i) => all.indexOf(c) !== i);
    assert(dupes.length === 0, `${label} lists ${show(new Set(dupes))} more than once`);
  }
});

console.log('');
console.log(`  invoke: ${INVOKE_ALLOWED.size} allowlisted + ${HARDCODED_INVOKE.size} hardcoded, ${HANDLERS.size} handlers`);
console.log(`  listen: ${LISTEN_ALLOWED.size} allowlisted + ${HARDCODED_LISTEN.size} hardcoded, ${SENDS.size} senders`);
console.log('');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
if (bad) process.exit(1);
