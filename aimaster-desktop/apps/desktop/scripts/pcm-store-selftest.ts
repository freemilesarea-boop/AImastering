// pcm-store-selftest — the decoded-audio store, and what its cap counts.
//
// `decodeHandlers.ts` keeps decoded songs on disk under a 12 GB ceiling.  The
// sweep that enforces it had no test, because the handler imports electron for
// `app.getPath('userData')`.
//
// What that hid: the sweep looked at `*.f32` only.  A decode writes
// `${key}.${uuid}.part` and renames it when whole, so a decode that is killed
// leaves a part-file — and those were counted by nothing and removed by
// nothing.  Measured with the old sweep, a 10 MB cap standing in for 12 GB:
//
//   before: directory 68 MB, what the sweep counts 8 MB, files 7
//   after : directory 68 MB, what the sweep counts 8 MB, files 7
//
// One dead decode of a four-minute song is ~92 MB; of a `MAX_SECONDS` file
// (three hours at 48 kHz stereo float32) ~4 GB.
//
// Run: pnpm --filter @aimaster/desktop test:pcm-store

export {};

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PART_MAX_AGE_MS, STORE_CAP_BYTES, partKey, storeKey, storeKeyOf, sweepStore,
} from '../src/main/utils/pcm-store.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

const KEYS = [
  'a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40), 'd'.repeat(40), 'e'.repeat(40),
];
const MB = 1024 * 1024;
const NOW = Date.parse('2026-10-16T12:00:00Z');
const HOUR = 60 * 60 * 1000;

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loui-pcm-'));
}
/** Write a file of `mb` megabytes and set its times, in that order. */
function put(dir: string, name: string, mb: number, ageMs = 0): void {
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.alloc(Math.round(mb * MB)));
  const t = (NOW - ageMs) / 1000;
  fs.utimesSync(file, t, t);
}
function names(dir: string): string[] {
  return fs.readdirSync(dir).sort();
}
function bytes(dir: string): number {
  return fs.readdirSync(dir).reduce((s, n) => s + fs.statSync(path.join(dir, n)).size, 0);
}
/** A complete store: samples plus the sidecar the hit path needs. */
function store(dir: string, key: string, mb: number, ageMs = 0): void {
  put(dir, `${key}.f32`, mb, ageMs);
  put(dir, `${key}.json`, 0.01, ageMs);
}

function main(): void {
  console.log('\n=== THE CAP COUNTS WHAT IS ON THE DISK ===\n');

  {
    const dir = makeDir();
    store(dir, KEYS[0]!, 4);
    store(dir, KEYS[1]!, 4);
    // Two decodes that died with most of the file written.
    put(dir, `${KEYS[2]}.1111-2222.part`, 30, 2 * HOUR);
    put(dir, `${KEYS[3]}.3333-4444.part`, 30, 2 * HOUR);
    const before = bytes(dir);
    const report = sweepStore(dir, { capBytes: 10 * MB, nowMs: NOW });
    check(
      'a part-file left by a killed decode is counted, where it used to be invisible',
      report.totalBytes >= 68 * MB,
      `the sweep saw ${(report.totalBytes / MB).toFixed(0)} MB of the ${(before / MB).toFixed(0)} MB `
      + 'on disk (the old one saw 8)',
    );
    check(
      'and removed, so the directory really is inside the cap afterwards',
      bytes(dir) <= 10 * MB && report.removedOrphans.length === 2,
      `${(bytes(dir) / MB).toFixed(2)} MB left, removed ${report.removedOrphans.length} leftover(s)`,
    );
    check(
      'and the usable stores survived it — rubbish goes before work does',
      names(dir).includes(`${KEYS[0]}.f32`) && names(dir).includes(`${KEYS[1]}.f32`)
        && report.evicted.length === 0,
      names(dir).join(', '),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }

  {
    // The sweep runs immediately before a decode, and several can be in
    // flight at once.  A part-file being written right now must survive.
    const dir = makeDir();
    store(dir, KEYS[0]!, 4);
    put(dir, `${KEYS[1]}.5555-6666.part`, 60, 30_000);
    const report = sweepStore(dir, { capBytes: 10 * MB, nowMs: NOW });
    check(
      'a decode in flight is not swept out from under itself',
      names(dir).includes(`${KEYS[1]}.5555-6666.part`) && report.removedOrphans.length === 0,
      `30 s old, left alone; age guard is ${(PART_MAX_AGE_MS / 60_000).toFixed(0)} min`,
    );
    check(
      'even though keeping it means the cap is briefly exceeded, which is the honest trade',
      report.keptBytes > 10 * MB,
      `${(report.keptBytes / MB).toFixed(0)} MB kept against a 10 MB cap`,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n=== AND EVICTS WHOLE STORES, OLDEST FIRST ===\n');

  {
    const dir = makeDir();
    // Same size, different last-use: the eviction order is the only thing
    // being measured here.
    store(dir, KEYS[0]!, 4);
    store(dir, KEYS[1]!, 4);
    store(dir, KEYS[2]!, 4);
    const touch = (key: string, ageMs: number): void => {
      const t = (NOW - ageMs) / 1000;
      fs.utimesSync(path.join(dir, `${key}.f32`), t, t);
    };
    touch(KEYS[0]!, 3 * 24 * HOUR);   // oldest
    touch(KEYS[1]!, 1 * HOUR);
    touch(KEYS[2]!, 60_000);          // newest
    const report = sweepStore(dir, { capBytes: 9 * MB, nowMs: NOW });
    check(
      'the least recently used store goes first',
      report.evicted.length === 1 && report.evicted[0] === `${KEYS[0]}.f32`,
      `evicted ${report.evicted.join(', ') || '(none)'}`,
    );
    check(
      "and its sidecar goes with it — a sidecar alone is a hit that cannot happen",
      !names(dir).includes(`${KEYS[0]}.json`) && names(dir).includes(`${KEYS[1]}.json`),
      names(dir).join(', '),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }

  {
    const dir = makeDir();
    store(dir, KEYS[0]!, 4, 3 * 24 * HOUR);
    store(dir, KEYS[1]!, 4, 2 * 24 * HOUR);
    store(dir, KEYS[2]!, 4, 1 * 24 * HOUR);
    const report = sweepStore(dir, { capBytes: 5 * MB, nowMs: NOW });
    check(
      'it stops as soon as what is left fits, rather than emptying the store',
      report.evicted.length === 2 && names(dir).includes(`${KEYS[2]}.f32`),
      `${report.evicted.length} evicted, ${(bytes(dir) / MB).toFixed(2)} MB left under 5 MB`,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n=== AND LEAVES ALONE WHAT IS NOT ITS OWN ===\n');

  {
    const dir = makeDir();
    store(dir, KEYS[0]!, 4);
    put(dir, 'settings.json', 0.01, 5 * 24 * HOUR);
    put(dir, 'notes.txt', 1, 5 * 24 * HOUR);
    put(dir, 'something.f32.gz', 20, 5 * 24 * HOUR);
    put(dir, 'ffmpeg-crash.part', 20, 5 * 24 * HOUR);
    const report = sweepStore(dir, { capBytes: 1 * MB, nowMs: NOW });
    check(
      'a file this store did not write is neither counted nor deleted',
      names(dir).includes('notes.txt') && names(dir).includes('something.f32.gz')
        && names(dir).includes('ffmpeg-crash.part')
        && report.totalBytes < 5 * MB,
      `counted ${(report.totalBytes / MB).toFixed(2)} MB of ${(bytes(dir) / MB).toFixed(0)} MB; `
      + `a .part without a 40-char key is not ours`,
    );
    check(
      'and `settings.json` is not mistaken for a sidecar',
      // This check failed on the first version of the module, which took any
      // `*.json` for a sidecar and deleted this one.  A key has a shape.
      names(dir).includes('settings.json')
        && storeKeyOf('settings.json', '.json') === null
        && storeKeyOf(`${KEYS[0]}.json`, '.json') === KEYS[0],
      'left alone — a sidecar is a 40-char sha1 key plus .json, nothing else',
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }

  {
    const dir = makeDir();
    // The crash-after-write classes, both old enough to judge.
    put(dir, `${KEYS[0]}.json`, 0.01, 2 * HOUR);          // sidecar, samples gone
    put(dir, `${KEYS[1]}.f32`, 90, 2 * HOUR);             // samples, sidecar gone
    store(dir, KEYS[2]!, 4);
    const report = sweepStore(dir, { capBytes: 100 * MB, nowMs: NOW });
    check(
      'a half-published store is cleared from either side, even under the cap',
      report.removedOrphans.length === 2
        && !names(dir).includes(`${KEYS[0]}.json`)
        && !names(dir).includes(`${KEYS[1]}.f32`),
      `removed ${report.removedOrphans.join(', ')}`,
    );
    check(
      'and the complete store beside them is untouched',
      names(dir).includes(`${KEYS[2]}.f32`) && names(dir).includes(`${KEYS[2]}.json`),
      names(dir).join(', '),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n=== AND THE KEY IS WHAT WOULD CHANGE THE SAMPLES ===\n');

  {
    const base = storeKey('/music/song.wav', 1_700_000_000_000, 40_000_000, 48_000);
    check(
      'the same file at the same rate is the same store',
      storeKey('/music/song.wav', 1_700_000_000_000, 40_000_000, 48_000) === base
        && /^[0-9a-f]{40}$/.test(base),
      `${base.slice(0, 12)}…`,
    );
    const differs = [
      ['a different path', storeKey('/music/other.wav', 1_700_000_000_000, 40_000_000, 48_000)],
      ['an edited file', storeKey('/music/song.wav', 1_700_000_001_000, 40_000_000, 48_000)],
      ['a different size', storeKey('/music/song.wav', 1_700_000_000_000, 40_000_001, 48_000)],
      ['a different rate', storeKey('/music/song.wav', 1_700_000_000_000, 40_000_000, 44_100)],
    ] as const;
    check(
      'and anything that would change the samples is a different store',
      differs.every(([, k]) => k !== base),
      differs.map(([what]) => what).join(', '),
    );
    check(
      'a part-file names the store it belongs to',
      partKey(`${base}.1111-2222.part`) === base
        && partKey('ffmpeg-crash.part') === null
        && partKey(`${base}.f32`) === null,
      'key recovered, foreign .part refused, .f32 refused',
    );
  }

  check(
    'the shipped cap is still the documented twelve gigabytes',
    STORE_CAP_BYTES === 12 * 1024 * 1024 * 1024,
    `${(STORE_CAP_BYTES / 1024 ** 3).toFixed(0)} GB`,
  );

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

main();
