// python-suite-selftest — the other suite, and the thirty tests that had
// quietly taken themselves out of it.
//
// `services/python-audio` holds the mastering engine: 151 files, 44k lines,
// and 526 tests of its own.  Nothing automated runs them.  `pnpm test` — the
// 220-step chain this file belongs to — never touches them, and the only
// written record of how is a release runbook.
//
// Run by hand, they came back `496 passed, 30 skipped`, which looks fine until
// you ask what the thirty are.  All thirty live in
// `tests/mastering/test_extract_commercial_reference.py`, the file that covers
// building the commercial-reference corpus every mastering target is derived
// from, and they were gated on
//
//     pytestmark = pytest.mark.skipif(not os.environ.get("AIMASTER_FFMPEG"), …)
//
// while `tests/conftest.py` set that variable from a session-scoped autouse
// FIXTURE.  The condition there is a plain bool, evaluated while the module is
// imported for collection — before any fixture runs — so the resolution was
// always too late.  Measured, before and after moving it to import time:
//
//     30 skipped in 0.29s        ← as the suite actually ran it
//     30 passed  in 30.08s       ← with AIMASTER_FFMPEG exported by hand
//
// The release runbook recorded "79 passed, 41 skipped" as the baseline, which
// made a block of self-removing tests look like the normal state of things.
//
// So this file does the cheap half of the job on every suite run: it asks
// pytest to plan the whole suite without running it — 1.8 seconds — and fails
// if any test removes itself.  The expensive half stays one command away
// (`pnpm test:python`, about fourteen minutes) rather than being bolted onto a
// chain that already takes forty.
//
// Run: pnpm --filter @aimaster/desktop test:python-suite

export {};

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pythonBin } from './lib/python-bin.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

const SERVICE = path.resolve('../../services/python-audio');
const INSTALL = `${pythonBin()} -m pip install -r services/python-audio/requirements.txt`;

/** The pinned ffmpeg the TS suite already depends on. */
const FFMPEG = createRequire(import.meta.url)('ffmpeg-static') as string;

function pytest(args: string[], env: Record<string, string | undefined> = {}):
SpawnSyncReturns<string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) base[k] = v;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete base[k]; else base[k] = v;
  }
  return spawnSync(pythonBin(), ['-m', 'pytest', '--no-header', '-p', 'no:cacheprovider', ...args], {
    cwd: SERVICE, encoding: 'utf8', timeout: 300_000, env: base,
  });
}

/** Every "SKIPPED [n] path: reason" line pytest printed. */
function skipLines(out: string): string[] {
  return out.split('\n').filter((l) => l.startsWith('SKIPPED '));
}

/**
 * Why pytest did not finish, or '' when it did.
 *
 * Without this the two planning checks below printed "planned the whole suite,
 * nothing skipped" as the detail of their own FAILURE: a collection error
 * leaves zero skips and a non-zero exit, and the detail only looked at the
 * skips.  A failure detail that reads like a pass is worse than none.
 */
function pytestTrouble(r: SpawnSyncReturns<string>): string {
  if (r.status === 0) return '';
  const tail = ((r.stdout ?? '') + (r.stderr ?? '')).trim().split('\n')
    .filter((l) => l.trim().length > 0).slice(-2).join(' / ');
  return `pytest exited ${String(r.status)}: ${tail.slice(0, 200)}`;
}

function main(): void {
  console.log('\n=== The Python engine suite: is all of it still there? ===\n');

  {
    const r = spawnSync(pythonBin(), ['-c',
      'import pytest, numpy, soundfile; print(pytest.__version__, numpy.__version__, soundfile.__version__)'],
      { cwd: SERVICE, encoding: 'utf8', timeout: 60_000 });
    const ok = r.status === 0;
    check(
      'the Python engine’s test dependencies are installed',
      ok,
      ok ? `pytest/numpy/soundfile ${(r.stdout ?? '').trim()}`
         : `missing — ${INSTALL}\n       (${(r.stderr ?? '').trim().split('\n').pop() ?? ''})`,
    );
    if (!ok) { console.log(`\n=== ${passed} passed, ${failed} failed ===\n`); process.exit(1); }
  }

  const FLOOR = 500;
  {
    const r = pytest(['-q', '--collect-only']);
    const count = Number(/(\d+) tests collected/.exec(r.stdout ?? '')?.[1] ?? NaN);
    check(
      'the suite still collects what it used to',
      r.status === 0 && count >= FLOOR,
      Number.isNaN(count)
        ? `could not read a count: ${(r.stdout ?? r.stderr ?? '').trim().slice(-200)}`
        : `${count} tests collected (floor ${FLOOR} — raise it when the suite grows; `
          + 'it is here so a deleted file is noticed)',
    );
  }
  {
    // The regression catcher.  AIMASTER_FFMPEG is REMOVED on purpose: the
    // point is that `conftest.py` resolves one at import time, and passing a
    // path in from here would hide it going back into a fixture.
    const r = pytest(['-q', '-rs', '--setup-plan'], { AIMASTER_FFMPEG: undefined });
    const skipped = skipLines(r.stdout ?? '');
    const trouble = pytestTrouble(r);
    check(
      'and no test removes itself when nothing is exported by hand',
      trouble === '' && skipped.length === 0,
      skipped.length > 0
        ? `${skipped.length} test(s) skipped themselves:\n       `
          + skipped.slice(0, 3).map((l) => l.replace('SKIPPED ', '')).join('\n       ')
        : trouble || 'planned the whole suite, nothing skipped',
    );
  }
  {
    // The other direction: a packaged or CI run names the bundled binary, and
    // that must still satisfy the same gate.
    const r = pytest(['-q', '-rs', '--setup-plan'], { AIMASTER_FFMPEG: FFMPEG });
    const skipped = skipLines(r.stdout ?? '');
    const trouble = pytestTrouble(r);
    check(
      'and none when a bundled binary is named instead',
      trouble === '' && skipped.length === 0,
      skipped.length > 0
        ? `${skipped.length} skipped: ${skipped[0]?.slice(0, 120) ?? ''}`
        : trouble
          || `AIMASTER_FFMPEG=${path.basename(path.dirname(FFMPEG))}/${path.basename(FFMPEG)} — nothing skipped`,
    );
  }
  {
    // The thirty that were skipped are the reason this file exists; run that
    // one file for real.  Thirty seconds, which is worth paying every time.
    const r = pytest(['-q', 'tests/mastering/test_extract_commercial_reference.py'],
      { AIMASTER_FFMPEG: undefined });
    const line = (r.stdout ?? '').trim().split('\n').pop() ?? '';
    check(
      'the commercial-reference extraction tests run, and pass',
      r.status === 0 && /\b30 passed/.test(line),
      line.slice(0, 140) || (r.stderr ?? '').trim().slice(-140),
    );
  }
  {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    const full = pkg.scripts['test:python'] ?? '';
    check(
      'the whole Python suite is one command away',
      /pytest/.test(full) && /services\/python-audio/.test(full),
      full || 'no test:python script',
    );
    // `\b` is not enough: in `pnpm test:python-suite` the boundary falls on
    // the hyphen, so the first version of this check matched the two-second
    // step it is standing next to and reported the fourteen-minute one as
    // wired in.  The lookahead is what makes the two names different.
    check(
      'and it is deliberately NOT in the default chain',
      !/pnpm test:python(?![-\w])/.test(pkg.scripts['test'] ?? ''),
      'fourteen minutes of DSP tests stay opt-in; this file is the two-second '
      + 'part that runs every time',
    );
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

main();
