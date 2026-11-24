// autosave-files-selftest — the recovery files, on a real disk.
//
// These rules had no test at all, because they lived in `autosaveHandlers.ts`
// next to `import { app } from 'electron'`: nothing could import the module
// outside a running Electron main process, so the atomic write, the kept
// generation, the sweep and the directory guard were all unverified in a path
// whose entire job is to survive the app dying.
//
// What that hid: the handler's own header promised that when the newest
// autosave faithfully preserves a session that was already broken, "the one
// before it is the way out".  `autosave:list` filtered `*.louisession`, which
// excludes `*.louisession.bak`, and the renderer only ever gets paths from
// that listing.  The copy was written, swept after thirty days and deleted on
// a clean save, and no code path could ever reach it.
//
// Run: pnpm --filter @aimaster/desktop test:autosave-files

export {};

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AUTOSAVE_EXT, BACKUP_SUFFIX, KEEP_DAYS, LIST_LIMIT, MAX_BYTES,
  autosaveFile, autosaveFiles, generationOf, isInsideDir, listAutosaves,
  readMeta, safeKey, sweep, writeAutosave, writeProblem,
} from '../src/main/utils/autosave-files.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

/** A session as the serializer writes one: `id` and `name` near the top. */
function sessionJson(id: string, name: string, pad = 0): string {
  return JSON.stringify(
    { version: 3, id, name, sampleRate: 48000, filler: 'x'.repeat(pad) },
    null,
    2,
  );
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-autosave-'));

function main(): void {
  console.log('\n=== THE WRITE KEEPS THE ONE BEFORE IT ===\n');

  {
    const first = sessionJson('ses-1', '첫 번째', 200);
    const target = writeAutosave(dir, 'ses-1', first);
    check(
      'the first write lands on the target and leaves no .bak',
      fs.existsSync(target) && !fs.existsSync(`${target}${BACKUP_SUFFIX}`),
      `${path.basename(target)}, no backup yet`,
    );
    check(
      'and no temp file survives it',
      fs.readdirSync(dir).every((n) => !n.endsWith('.tmp')),
      fs.readdirSync(dir).join(', '),
    );

    const second = sessionJson('ses-1', '두 번째', 300);
    writeAutosave(dir, 'ses-1', second);
    const bak = `${target}${BACKUP_SUFFIX}`;
    check(
      'the second write keeps the first as .bak',
      fs.existsSync(bak) && fs.readFileSync(bak, 'utf8') === first,
      `${path.basename(bak)} is byte-identical to the first write`,
    );
    check(
      'and the target is the new one',
      fs.readFileSync(target, 'utf8') === second,
      'target holds the second write',
    );

    const third = sessionJson('ses-1', '세 번째', 400);
    writeAutosave(dir, 'ses-1', third);
    check(
      'a third write moves the window — only two generations are ever kept',
      fs.readFileSync(bak, 'utf8') === second
        && fs.readFileSync(target, 'utf8') === third
        && fs.readdirSync(dir).filter((n) => n.startsWith(safeKey('ses-1'))).length === 2,
      'bak = second, target = third, two files',
    );
  }

  console.log('\n=== AND BOTH OF THEM CAN BE FOUND AGAIN ===\n');

  {
    const records = listAutosaves(dir);
    const gens = records.map((r) => r.generation).sort();
    check(
      'a listing carries BOTH generations, which is the whole fix',
      records.length === 2 && gens[0] === 'latest' && gens[1] === 'previous',
      `${records.length} record(s): ${records.map((r) => `${r.generation}/${r.sessionName}`).join(', ')}`,
    );
    const latest = records.find((r) => r.generation === 'latest');
    check(
      'the name and the id are read out of the file, not the filename',
      latest?.sessionName === '세 번째' && latest?.sessionId === 'ses-1',
      `name "${latest?.sessionName}", id "${latest?.sessionId}"`,
    );
    const prev = records.find((r) => r.generation === 'previous');
    check(
      "and the previous generation's path is the latest's plus the suffix",
      prev !== undefined && latest !== undefined
        && prev.path === `${latest.path}${BACKUP_SUFFIX}`,
      `${path.basename(prev?.path ?? '')}`,
    );
    // This check used to read `records[0].savedAtMs >= records[1].savedAtMs`,
    // which every ordering satisfies once the sort has run, and it PASSED
    // while printing "previous then latest".  `rename` preserves the temp
    // file's mtime, so the backup — copied after the temp was written — was
    // stamped LATER than the autosave it backs up: measured at 32.9 ms on a
    // 10 MB session.  Asserting the generations, not the sort, is what makes
    // this a check.
    check(
      'the newest autosave is the newest — not older than its own backup',
      records[0]!.generation === 'latest'
        && records[1]!.generation === 'previous'
        && records[0]!.savedAtMs >= records[1]!.savedAtMs,
      `${records[0]?.generation} then ${records[1]?.generation}, `
      + `latest leads by ${(records[0]!.savedAtMs - records[1]!.savedAtMs).toFixed(1)} ms`,
    );
    check(
      'and a tie on the millisecond still puts the latest first',
      // Both of this session's writes landed inside one millisecond, so the
      // ordering above is decided by the sort's tie-break and not by the
      // clock.  Said out loud because a 0.0 ms lead reads like a measurement
      // when it is really an absence of one.
      records[0]!.savedAtMs === records[1]!.savedAtMs
        ? records[0]!.generation === 'latest'
        : true,
      records[0]!.savedAtMs === records[1]!.savedAtMs
        ? 'same millisecond, tie-break decided it'
        : 'the clock decided it, no tie to break',
    );
  }

  {
    check(
      'a file that is neither generation is not an autosave',
      generationOf('notes.txt') === null
        && generationOf(`a${AUTOSAVE_EXT}`) === 'latest'
        && generationOf(`a${AUTOSAVE_EXT}${BACKUP_SUFFIX}`) === 'previous'
        && generationOf(`a${AUTOSAVE_EXT}.12345.999.tmp`) === null,
      'txt null, .louisession latest, .bak previous, .tmp null',
    );
    fs.writeFileSync(path.join(dir, 'stray.txt'), 'not a session');
    fs.writeFileSync(path.join(dir, `half${AUTOSAVE_EXT}`), '');
    const records = listAutosaves(dir);
    check(
      'a stray file and a zero-length autosave are both left out',
      records.length === 2 && records.every((r) => !r.path.includes('stray') && r.bytes > 0),
      `${records.length} record(s) with ${fs.readdirSync(dir).length} files in the directory`,
    );
    fs.unlinkSync(path.join(dir, 'stray.txt'));
    fs.unlinkSync(path.join(dir, `half${AUTOSAVE_EXT}`));
  }

  {
    // The ordering above was decided by the sort's tie-break, because two
    // small writes land in the same millisecond.  The regression it exists to
    // catch — `rename` carrying the temp file's mtime, so the backup copied
    // afterwards outranks the autosave it backs up — only shows on a write
    // long enough to cross a millisecond.  So this one is big.
    const big = fs.mkdtempSync(path.join(os.tmpdir(), 'loui-autosave-big-'));
    const pad = 'x'.repeat(6_000_000);
    writeAutosave(big, 'ses-big', sessionJson('ses-big', '먼저', 0).replace('"filler": ""', `"filler": "${pad}"`));
    writeAutosave(big, 'ses-big', sessionJson('ses-big', '나중', 0).replace('"filler": ""', `"filler": "${pad}"`));
    const recs = listAutosaves(big);
    const latest = recs.find((r) => r.generation === 'latest')!;
    const previous = recs.find((r) => r.generation === 'previous')!;
    const lead = latest.savedAtMs - previous.savedAtMs;
    check(
      'on a write long enough to measure, the mtimes themselves are in order',
      lead > 0,
      `latest leads its backup by ${lead.toFixed(1)} ms on a ${(Buffer.byteLength(pad) / 1e6).toFixed(0)} MB session`,
    );
    fs.rmSync(big, { recursive: true, force: true });
  }

  console.log('\n=== THE RULES AROUND THEM ===\n');

  {
    check(
      'a session id never reaches the filesystem raw',
      safeKey('../../etc/passwd') === 'etcpasswd'
        && safeKey('ses-1') === 'ses-1'
        && safeKey('') === 'session'
        && safeKey('!!!') === 'session'
        && safeKey('x'.repeat(200)).length === 64,
      "'../../etc/passwd' → 'etcpasswd', empty → 'session', long → 64 chars",
    );
    check(
      'clear names both generations, and only those',
      autosaveFiles(dir, 'ses-1').length === 2
        && autosaveFiles(dir, 'ses-1')[0] === autosaveFile(dir, 'ses-1')
        && autosaveFiles(dir, 'ses-1')[1] === `${autosaveFile(dir, 'ses-1')}${BACKUP_SUFFIX}`,
      'target and target.bak',
    );
  }

  {
    const outside = path.join(path.dirname(dir), 'elsewhere.louisession');
    check(
      'a path outside the autosave directory is refused',
      !isInsideDir(dir, outside)
        && !isInsideDir(dir, path.join(dir, '..', 'escape.louisession'))
        && !isInsideDir(dir, dir)
        && isInsideDir(dir, autosaveFile(dir, 'ses-1')),
      'sibling no, ".." no, the directory itself no, a file inside yes',
    );
  }

  {
    // The ceiling is in bytes because that is what lands on the disk.  Korean
    // text is three UTF-8 bytes per character, so a string one third of
    // MAX_BYTES in length is already at the limit — the two are different
    // ceilings even though an ordinary session is almost all ASCII.
    const korean = '가'.repeat(MAX_BYTES / 3 + 1000);
    check(
      'the size ceiling counts bytes, not characters',
      korean.length < MAX_BYTES && writeProblem(korean) !== null,
      `${korean.length} chars (under ${MAX_BYTES}) = ${Buffer.byteLength(korean, 'utf8')} bytes (over) → refused`,
    );
    check(
      'an empty payload is refused and an ordinary session is not',
      writeProblem('') !== null && writeProblem(sessionJson('ses-9', '보통', 1000)) === null,
      'empty refused, 1 KB session allowed',
    );
  }

  {
    const old = path.join(dir, `stale${AUTOSAVE_EXT}`);
    fs.writeFileSync(old, sessionJson('ses-stale', '오래된', 100));
    const ageMs = (KEEP_DAYS + 1) * 24 * 60 * 60 * 1000;
    const then = Date.now() - ageMs;
    fs.utimesSync(old, then / 1000, then / 1000);
    const before = listAutosaves(dir).length;
    sweep(dir);
    const after = listAutosaves(dir).length;
    check(
      `an autosave older than ${KEEP_DAYS} days is swept, the rest are not`,
      before === 3 && after === 2 && !fs.existsSync(old),
      `${before} before, ${after} after`,
    );
  }

  {
    check(
      'a listing is capped, so a directory nobody cleaned cannot flood a prompt',
      LIST_LIMIT === 20 && listAutosaves(dir).length <= LIST_LIMIT,
      `limit ${LIST_LIMIT}`,
    );
    check(
      'reading a missing file is null, not a throw',
      readMeta(path.join(dir, `gone${AUTOSAVE_EXT}`)) === null
        && readMeta(path.join(dir, 'gone.txt')) === null,
      'missing null, wrong extension null',
    );
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

main();
