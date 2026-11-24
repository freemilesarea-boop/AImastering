// log-format-selftest — what the log file says after a crash.
//
// `logger.ts` is the record the app leaves behind, and it had no test because
// it imports electron for `app.getPath('userData')`.  It built every record
// with `' ' + JSON.stringify(extra)`, which for the value eleven main-process
// call sites actually pass — a raw Error — produces `{}`, because `message`
// and `stack` are not enumerable own properties.  Two of those call sites:
//
//   log.error('[CRASH] Uncaught exception', err);
//   log.error('[CRASH] Unhandled rejection', reason);
//
// So the crash log read `[CRASH] Uncaught exception {}`.  And because the line
// was built OUTSIDE the `try` that guarded the write, an extra holding a cycle
// or a BigInt threw out of the log call — out of the very handler that exists
// to be the last thing that still works.
//
// Run: pnpm --filter @aimaster/desktop test:log-format

export {};

import {
  KEEP_DAYS, MAX_CAUSE_DEPTH, MAX_EXTRA_CHARS,
  formatExtra, logLine, safeJson, staleLogs,
} from '../src/main/utils/log-format.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

/** What the old implementation did, kept so the fix is measured against it. */
const legacy = (extra: unknown): string =>
  extra !== undefined ? ` ${JSON.stringify(extra)}` : '';

function main(): void {
  console.log('\n=== AN ERROR SAYS WHAT IT IS ===\n');

  {
    const err = new Error('boom');
    const out = formatExtra(err);
    check(
      'an Error carries its message, which JSON.stringify dropped entirely',
      out.includes('Error: boom') && legacy(err) === ' {}',
      `now "${out.split('\n')[0]!.trim()}", before "${legacy(err).trim()}"`,
    );
    check(
      'and its stack, so the line says where',
      out.includes('at ') && out.split('\n').length > 1,
      `${out.split('\n').length - 1} stack line(s)`,
    );
  }

  {
    const err = Object.assign(new Error('no such file'), { code: 'ENOENT', path: '/x/y.wav' });
    const out = formatExtra(err).split('\n')[0]!;
    check(
      'a code and whatever else the thrower attached are kept',
      out.includes('code=ENOENT') && out.includes('/x/y.wav') && out.includes('no such file'),
      out.trim(),
    );
  }

  {
    const inner = new Error('socket hang up');
    const outer = new Error('upload failed', { cause: inner });
    const out = formatExtra(outer);
    check(
      'a cause chain is followed, because that is where the reason lives',
      out.includes('upload failed') && out.includes('caused by:') && out.includes('socket hang up'),
      `${out.split('caused by:').length - 1} cause(s) reported`,
    );
    // A chain long enough to be a loop must not become one.
    let deep: Error = new Error('root');
    for (let i = 0; i < 12; i++) deep = new Error(`layer ${i}`, { cause: deep });
    const deepOut = formatExtra(deep);
    check(
      `a long cause chain stops at ${MAX_CAUSE_DEPTH}`,
      (deepOut.split('caused by:').length - 1) <= MAX_CAUSE_DEPTH,
      `${deepOut.split('caused by:').length - 1} cause(s) for 12 layers`,
    );
  }

  {
    // Not every error is an `instanceof Error`: one from a worker, a context
    // boundary or a bundled copy of a library is still an error.
    const foreign = { name: 'TypeError', message: 'x is not a function', stack: 'TypeError: x is not a function\n    at foreign.js:1' };
    check(
      'an error-shaped object from another context is treated as an error',
      formatExtra(foreign).includes('x is not a function'),
      formatExtra(foreign).split('\n')[0]!.trim(),
    );
  }

  console.log('\n=== AND A LOG CALL CANNOT BE THE THING THAT FAILS ===\n');

  {
    const circular: Record<string, unknown> = { stage: 'upload' };
    circular['self'] = circular;
    let legacyThrew = false;
    try { legacy(circular); } catch { legacyThrew = true; }
    let out = '';
    let threw = false;
    try { out = formatExtra(circular); } catch { threw = true; }
    check(
      'an extra holding itself is named, where it used to throw',
      legacyThrew && !threw && out.includes('[circular]') && out.includes('upload'),
      `before: threw, now: ${out.trim()}`,
    );
  }

  {
    let legacyThrew = false;
    try { legacy({ size: 1n }); } catch { legacyThrew = true; }
    let threw = false;
    let out = '';
    try { out = formatExtra({ size: 1n }); } catch { threw = true; }
    check(
      'a BigInt is written out, where it used to throw',
      legacyThrew && !threw && out.includes('1n'),
      `before: threw, now: ${out.trim()}`,
    );
  }

  {
    // The shapes a real failure path hands over: a getter that throws, a
    // toJSON that throws, and a Proxy that refuses to be read.
    const hostile: unknown[] = [
      Object.defineProperty({}, 'boom', { get(): never { throw new Error('getter'); }, enumerable: true }),
      { toJSON(): never { throw new Error('toJSON'); } },
      new Proxy({}, { ownKeys(): never { throw new Error('proxy'); } }),
      Symbol('tag'),
      () => 'fn',
      null,
    ];
    const results = hostile.map((v) => {
      try { return { ok: true, text: formatExtra(v) }; }
      catch (e) { return { ok: false, text: String(e) }; }
    });
    check(
      'nothing a caller can hand over makes formatting throw',
      results.every((r) => r.ok),
      results.map((r, i) => `${i}:${r.ok ? 'ok' : 'THREW'}`).join(' '),
    );
  }

  {
    const huge = { blob: 'x'.repeat(50_000) };
    const out = formatExtra(huge);
    check(
      'one record cannot become the whole log',
      out.length < MAX_EXTRA_CHARS + 60 && out.includes('…(+'),
      `${out.length} chars from a ${50_000} char extra`,
    );
  }

  console.log('\n=== AND THE ORDINARY CASES READ LIKE TEXT ===\n');

  {
    check(
      'a string is the string, not a quoted and escaped one',
      formatExtra('python said hello') === ' python said hello'
        && legacy('python said hello') === ' "python said hello"',
      `now "${formatExtra('python said hello')}", before "${legacy('python said hello')}"`,
    );
    const pre = JSON.stringify({ reason: 'oom' });
    check(
      'and a pre-stringified object is not escaped a second time',
      formatExtra(pre) === ' {"reason":"oom"}' && legacy(pre).includes('\\"'),
      `now ${formatExtra(pre).trim()}, before ${legacy(pre).trim()}`,
    );
    check(
      'no extra means no extra',
      formatExtra(undefined) === '' && formatExtra('') === '',
      'undefined and empty string both add nothing',
    );
    check(
      'a plain object still reads as JSON',
      formatExtra({ filePath: '/a/b.wav', ms: 12 }) === ' {"filePath":"/a/b.wav","ms":12}',
      formatExtra({ filePath: '/a/b.wav', ms: 12 }).trim(),
    );
    check(
      'safeJson never returns undefined, whatever it is handed',
      safeJson(undefined) === 'undefined' && typeof safeJson(() => 1) === 'string',
      `undefined → "${safeJson(undefined)}"`,
    );
  }

  {
    const line = logLine('ERROR', '[CRASH] Uncaught exception', new Error('boom'), '2026-10-15T00:00:00.000Z');
    check(
      'a whole record ends in exactly one newline and names the level',
      line.startsWith('[2026-10-15T00:00:00.000Z] [ERROR] [CRASH] Uncaught exception Error: boom')
        && line.endsWith('\n') && !line.endsWith('\n\n'),
      JSON.stringify(line.split('\n')[0]),
    );
  }

  console.log('\n=== AND THE LOGS DO NOT GROW FOREVER ===\n');

  {
    const day = 24 * 60 * 60 * 1000;
    const now = Date.parse('2026-10-15T12:00:00Z');
    const name = (ms: number) => `${new Date(ms).toISOString().slice(0, 10)}.log`;
    const names = [
      name(now), name(now - 5 * day), name(now - (KEEP_DAYS - 1) * day),
      name(now - (KEEP_DAYS + 5) * day), name(now - 400 * day),
      'settings.json', 'main.log.gz', 'notes.txt', '2026-13-45.log',
    ];
    const stale = staleLogs(names, now);
    check(
      `only logs past ${KEEP_DAYS} days are swept`,
      stale.length === 2
        && stale.includes(name(now - (KEEP_DAYS + 5) * day))
        && stale.includes(name(now - 400 * day)),
      `${stale.length} swept of ${names.length}: ${stale.join(', ')}`,
    );
    check(
      "today's log is never swept, and neither is a file we did not write",
      !stale.includes(name(now)) && !stale.some((n) => !/^\d{4}-\d{2}-\d{2}\.log$/.test(n)),
      'today kept, settings.json / main.log.gz / notes.txt / impossible date all left alone',
    );
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

main();
