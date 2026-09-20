/**
 * text-prompt-selftest.ts — the five features that died at `window.prompt`.
 *
 * Electron does not implement it.  Not "missing", which an optional call
 * survives: it is present as a function and THROWS when called —
 *
 *     prompt() is and will not be supported.
 *
 * Measured in the packaged app over CDP, not read from a changelog.  So
 * `globalThis.prompt?.(…)` did not return undefined and fall through; it threw
 * out of the command handler, leaving whatever it was doing half done and no
 * message on screen.  Five things were reached ONLY through that call:
 *
 *     트랙 이름 바꾸기 · 클립 이름 바꾸기 · 트랙 메모 · 템플릿 가져오기 · 믹스 스냅샷 찍기
 *
 * All five worked in a browser tab, which is why a dev-server session never
 * showed it, and none of them worked in the app that ships.
 *
 * The load-bearing check here is the last one: no source file may call
 * `prompt()` again.  The behaviour checks below would all keep passing if
 * somebody added a sixth call site tomorrow.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { askText, useTextPromptStore } from '../src/renderer/ui/text-prompt.js';

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

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; })
    .join('\n');
}

const answer = (v: string | null): void => useTextPromptStore.getState().answer(v);

/**
 * Await, but never forever.
 *
 * A first version of this file awaited the promises directly, and the break
 * that removes the "cancel the replaced ask" line was NOT caught: an
 * unresolved promise does not fail a check, it hangs the process before the
 * report is printed — which in a suite chained with && is a stall, the worst
 * of the three outcomes.  So a promise that does not settle promptly settles
 * here, as the string below, and the check reads it as the failure it is.
 */
const HUNG = '(never resolved)';
function settled(p: Promise<string | null>): Promise<string | null> {
  return Promise.race([
    p,
    // NOT unref'd, deliberately: an unref'd timer does not hold the event
    // loop open, so with nothing else pending node exited silently before it
    // fired — the same stall in a different costume.  Measured: the break
    // that removes the cancel went on reporting zero failures until this.
    new Promise<string>((resolve) => { setTimeout(() => resolve(HUNG), 500); }),
  ]);
}
const open = (): boolean => useTextPromptStore.getState().request !== null;

async function behaviour(): Promise<void> {
  // ── 1. Asking and answering ─────────────────────────────────────────────────

  {
    const p = askText('트랙 이름', '킥');
    check('asking puts a request on screen', open());
    check('the question and its default come through',
      useTextPromptStore.getState().request?.title === '트랙 이름'
      && useTextPromptStore.getState().request?.initial === '킥');
    answer('스네어');
    check('the answer resolves the promise', (await settled(p)) === '스네어');
    check('answering closes the dialog', !open());
  }

  {
    const p = askText('클립 이름', 'x');
    answer(null);
    check('cancelling resolves null, not the default', (await settled(p)) === null);
  }

  // An empty string is a real answer — "clear this memo" — and must not read as
  // a cancel.  `if (!raw) return` at a call site is that same bug one level up.
  {
    const p = askText('메모', '이전 메모');
    answer('');
    const got = await settled(p);
    check('an empty answer is a value, not a cancel', got === '' && got !== null,
      JSON.stringify(got));
  }

  // ── 2. Two asks at once ─────────────────────────────────────────────────────

  // A promise nobody resolves is a caller waiting forever.  If a second ask
  // replaces the first, the first must be told.
  {
    const first = askText('첫 번째', '');
    const second = askText('두 번째', '');
    check('the replaced ask is cancelled, not abandoned', (await settled(first)) === null);
    check('the newer question is the one on screen',
      useTextPromptStore.getState().request?.title === '두 번째');
    answer('ok');
    check('the newer ask still answers normally', (await settled(second)) === 'ok');
  }

  // A second click on 확인 must not resolve twice or reopen anything.
  {
    const p = askText('중복', '');
    answer('한 번');
    answer('두 번');
    check('answering an already-closed dialog does nothing',
      (await settled(p)) === '한 번' && !open());
  }
}

// ── 3. No call site may go back to prompt() ─────────────────────────────────

const SRC = path.join(DESKTOP, 'src');
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const offenders = walk(SRC).filter((file) =>
  /(?:window|globalThis)\s*\.\s*prompt\s*\??\s*\.?\s*\(/.test(stripComments(fs.readFileSync(file, 'utf8'))),
).map((f) => path.relative(DESKTOP, f));

check('nothing calls prompt(), because it throws in Electron',
  offenders.length === 0, offenders.join(', '));

// ── 4. The five that were dead now ask through askText ──────────────────────

const commands = stripComments(read('src/renderer/shortcuts/daw-commands.ts'));
const template = stripComments(read('src/renderer/components/daw/template/TemplatePanel.tsx'));
const snapPanel = stripComments(read('src/renderer/components/daw/mix/SnapshotPanel.tsx'));

/**
 * The handler body for one command id, so "does this ask?" is asked of the
 * right handler.  Matching the whole file would let one call site vouch for
 * five — which is the shape of mistake this suite exists to stop.
 */
function handler(src: string, id: string): string {
  const at = src.indexOf(`'${id}': () =>`);
  if (at < 0) return '';
  const rest = src.slice(at);
  // Handlers are written at one indent level and closed by `    },`.
  const end = rest.indexOf('\n    },');
  return end < 0 ? rest : rest.slice(0, end);
}

for (const [what, src, question] of [
  ['트랙 이름', handler(commands, 'daw.renameTrack'), '트랙 이름'],
  ['클립 이름', handler(commands, 'daw.renameClip'), '클립 이름'],
  ['트랙 메모', handler(commands, 'daw.trackNote'), '메모'],
  ['믹스 스냅샷', snapPanel, '스냅샷 이름'],
  ['템플릿 가져오기', template, '템플릿 파일'],
] as const) {
  check(`${what} asks through askText`,
    src.includes('askText(') && src.includes(question),
    src === '' ? 'handler not found' : 'no askText in that handler');
}

// A dialog nobody renders is the same defect wearing a different hat.
const app = stripComments(read('src/renderer/App.tsx'));
check('the dialog is mounted at the app root',
  /import\s+TextPromptDialog\s+from/.test(app) && /<TextPromptDialog\s*\/>/.test(app));

void behaviour().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
});
