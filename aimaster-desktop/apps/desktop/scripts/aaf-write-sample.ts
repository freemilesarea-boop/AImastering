/**
 * Write a sample AAF for `aaf-interop-check.py`.
 *
 * Deliberately a separate entry point rather than part of the test suite:
 * the interoperability check needs a file on disk and a Python reader, and
 * the suite must run on a machine that has neither.
 */
import { writeFileSync } from 'node:fs';
import { writeAaf } from '../src/renderer/daw/io/aaf-write.js';
import type { InterchangeSession } from '../src/renderer/daw/io/interchange.js';

const session: InterchangeSession = {
  name: 'Reel 1', sampleRate: 48_000, problems: [],
  tracks: [
    { name: 'Dialogue', clips: [
      { name: 'dx01', startSec: 0, durationSec: 2, sourceOffsetSec: 0,
        sourceUrl: 'file:///Volumes/Media/dx01.wav', sourceName: 'dx01.wav',
        fadeInSec: 0.25, fadeOutSec: 0 },
      { name: 'dx02', startSec: 10, durationSec: 4, sourceOffsetSec: 3,
        sourceUrl: 'file:///Volumes/Media/dx02.wav', sourceName: 'dx02.wav',
        fadeInSec: 0, fadeOutSec: 0.5 },
    ] },
    { name: 'Music', clips: [
      { name: 'mx01', startSec: 1, durationSec: 8, sourceOffsetSec: 0,
        sourceUrl: 'file:///Volumes/Media/mx01.wav', sourceName: 'mx01.wav',
        fadeInSec: 0, fadeOutSec: 0 },
    ] },
  ],
};

const out = process.argv[2];
if (!out) { console.error('usage: tsx scripts/aaf-write-sample.ts <file.aaf>'); process.exit(1); }
const { bytes, problems } = writeAaf(session, { now: new Date(Date.UTC(2020, 0, 1)) });
writeFileSync(out, bytes);
console.log(`wrote ${out} — ${bytes.length} bytes`);
for (const p of problems) console.log(`  note: ${p}`);
