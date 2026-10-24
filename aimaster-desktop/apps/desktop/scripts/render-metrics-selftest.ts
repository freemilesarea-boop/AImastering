/**
 * render-metrics-selftest — the crash a student hit, and the mapping that
 * stops it.
 *
 * REPORTED: "Cannot read properties of undefined (reading 'toFixed')" during
 * mastering, taking the whole app to the error boundary.
 *
 * FOUND: `audio:master-rust-experimental` (the Studio path — a song with
 * saved Studio work) answers with the OFFLINE RENDERER's metrics object:
 *
 *   { samplePeak, samplePeakDb, limiterGrDb, samples, durationSec, renderMs,
 *     measuredProcessedLufs, finalLufs, targetLufs, appliedLoudnessGainDb,
 *     finalTruePeakDb }
 *
 * `render-song.ts` put that object into `MasteringResult.loudnessAfter`
 * behind a cast, so `loudnessAfter.integratedLufs` was `undefined` while the
 * type said `number`, and the queue row's
 * `loudnessAfter.integratedLufs.toFixed(1)` threw.  The Python path was never
 * affected, which is why it reproduced for some students and not others.
 *
 * This file holds the payload that crashed it, the mapping that reads it, and
 * the rule that no unmeasured value is ever printed as a number.
 */
export {};

import { readFileSync } from 'node:fs';

import {
  loudnessAfterFromRenderMetrics,
} from '../src/renderer/audio/session/render-metrics.js';
import {
  buildExportPayload, exportAsJson, exportAsTxt,
} from '../src/renderer/components/masteringReportExport.js';
import { stampWav } from '../src/renderer/daw/engine/wav.js';
import { emptyProvenance } from '../src/renderer/daw/model/provenance.js';
import type { MasteringResult } from '@aimaster/shared-types';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}
const read = (f: string): string => readFileSync(f, 'utf8');

/** Exactly what `renderNormalized()` returns, key for key. */
const NORMALIZED = {
  samplePeak: 0.891,
  samplePeakDb: -1.0,
  limiterGrDb: 2.4,
  samples: 11_289_600,
  durationSec: 235.2,
  renderMs: 4120,
  measuredProcessedLufs: -11.8,
  finalLufs: -14.1,
  targetLufs: -14,
  appliedLoudnessGainDb: -2.3,
  finalTruePeakDb: -1.02,
};

/** And what `render()` returns when nothing asked for a loudness target. */
const PLAIN = {
  samplePeak: 0.891,
  samplePeakDb: -1.0,
  limiterGrDb: 2.4,
  samples: 11_289_600,
  durationSec: 235.2,
  renderMs: 4120,
};

console.log('\n=== The Studio-path master, and what it measured ===\n');

// ── The payload really is the shape that crashed ─────────────────────────
{
  const keys = Object.keys(NORMALIZED);
  check(
    'the offline renderer answers with none of the three names the UI reads',
    !keys.includes('integratedLufs') && !keys.includes('truePeakDbtp') && !keys.includes('lra'),
    `${keys.length} keys, none of them integratedLufs / truePeakDbtp / lra`,
  );
  // The crash itself, as arithmetic: this is what the queue row ran.
  const asIfCast = NORMALIZED as unknown as { integratedLufs: number };
  let threw = '';
  try { asIfCast.integratedLufs.toFixed(1); } catch (e) { threw = (e as Error).message; }
  check(
    'reading it the way the cast promised throws the reported error',
    threw.includes('toFixed'),
    threw || '(it did not throw — the payload changed)',
  );
}

// ── What the mapping makes of it ─────────────────────────────────────────
{
  const after = loudnessAfterFromRenderMetrics(NORMALIZED);
  check(
    'pass 2 measured the finished file, so LUFS and true peak are real numbers',
    after !== null && after.integratedLufs === -14.1 && after.truePeakDbtp === -1.02,
    after === null ? 'null' : `${after.integratedLufs} LUFS, ${after.truePeakDbtp} dBTP`,
  );
  check(
    'and the loudness range it never measured is null, not 0',
    after !== null && after.lra === null,
    after === null ? 'null' : `lra=${String(after.lra)}`,
  );
  check(
    'the numbers are the renderer’s own, renamed and not recomputed',
    after !== null
      && after.integratedLufs === NORMALIZED.finalLufs
      && after.truePeakDbtp === NORMALIZED.finalTruePeakDb,
    'finalLufs → integratedLufs, finalTruePeakDb → truePeakDbtp',
  );
}

// ── Nothing measured is not something measured ───────────────────────────
{
  check(
    'a render with no loudness pass measures nothing, and says so',
    loudnessAfterFromRenderMetrics(PLAIN) === null,
    'un-normalised render → null',
  );
  check(
    'and a silent file, whose loudness is −Infinity, is not a number either',
    loudnessAfterFromRenderMetrics({ ...NORMALIZED, finalLufs: -Infinity }) === null
      && loudnessAfterFromRenderMetrics({ ...NORMALIZED, finalTruePeakDb: NaN }) === null,
    '−Infinity and NaN both refused',
  );
  check(
    'a missing, null or wrong-typed payload does not throw',
    loudnessAfterFromRenderMetrics(undefined) === null
      && loudnessAfterFromRenderMetrics(null) === null
      && loudnessAfterFromRenderMetrics('metrics') === null
      && loudnessAfterFromRenderMetrics({}) === null,
    'undefined / null / string / empty object all → null',
  );
  check(
    'a payload that already speaks LoudnessStats passes through',
    JSON.stringify(loudnessAfterFromRenderMetrics(
      { integratedLufs: -9.5, truePeakDbtp: -0.8, lra: 6.2 }))
      === JSON.stringify({ integratedLufs: -9.5, truePeakDbtp: -0.8, lra: 6.2 }),
    'the Python path’s own shape is unchanged by the mapping',
  );
}

// ── The call site, and the two places that print it ──────────────────────
{
  const song = read('src/renderer/audio/session/render-song.ts');
  check(
    'the Studio path maps the metrics rather than casting them',
    /loudnessAfter: loudnessAfterFromRenderMetrics\(res\.metrics\)/.test(song)
      && !/res\.metrics as MasteringResult/.test(song),
    'the cast that produced the crash is gone',
  );
  check(
    'and it does not fall back to the BEFORE analysis for the after numbers',
    !/loudnessAfterFromRenderMetrics\(res\.metrics\)\s*\n?\s*\?\?\s*input\.analysis\.loudness/.test(song),
    'the source’s own loudness is not the master’s',
  );

  const home = read('src/renderer/pages/HomePage.tsx');
  check(
    'the queue row prints a measurement through a guard, never a bare toFixed',
    /metricText\(item\.masteringResult\.loudnessAfter\?\.integratedLufs\)/.test(home)
      && /metricText\(item\.masteringResult\.loudnessAfter\?\.lra\)/.test(home)
      && !/loudnessAfter\.integratedLufs\.toFixed/.test(home),
    'LUFS · TP · LRA all go through metricText',
  );
  check(
    'and the guard prints a dash for anything that is not a finite number',
    /function metricText\([\s\S]*?Number\.isFinite\(v\) \? v\.toFixed\(d\) : '—'/.test(home),
    'null / undefined / NaN → —',
  );

  const result = read('src/renderer/pages/ResultPage.tsx');
  check(
    'the result page formats through the same rule',
    /function fmt\(n: number \| null \| undefined[\s\S]*?Number\.isFinite\(n\) \? n\.toFixed\(d\) : '—'/.test(result),
    'fmt() is total over null, undefined and NaN',
  );
  check(
    'its QC rows do not claim a pass for a measurement nobody made',
    /const lufsOk = after !== null &&/.test(result) && /const tpOk   = after !== null &&/.test(result),
    'an unmeasured master is not reported as hitting the target',
  );
}

// ── It survives being saved, reloaded, shown and exported ────────────────
//
// A mastering result is held in the store for the session; what LEAVES the
// app is the report (JSON / TXT) and the stamped WAV.  Each of those is a
// place a null could throw, so each is run with one.
{
  const base: MasteringResult = {
    outputPath: '/tmp/song-master.wav',
    previewPath: '/tmp/song-master_preview.mp3',
    appliedCorrections: [],
    loudnessBefore: { integratedLufs: -18.2, truePeakDbtp: -3.1, lra: 9.4 },
    loudnessAfter: { integratedLufs: -14.1, truePeakDbtp: -1.02, lra: null },
    spectralBalance: null,
    analysisReport: null,
    pipelineWarnings: [],
    processingTimeSec: 4.12,
  };
  const unmeasured: MasteringResult = { ...base, loudnessAfter: null };

  // Save → reload.  The store holds it for the session and the report is
  // what goes to disk; both are JSON, and null survives JSON.
  for (const [name, r] of [['lra null', base], ['no measurement', unmeasured]] as const) {
    const reloaded = JSON.parse(JSON.stringify(r)) as MasteringResult;
    check(
      `a result with ${name} round-trips through save and reload unchanged`,
      JSON.stringify(reloaded) === JSON.stringify(r)
        && (reloaded.loudnessAfter?.lra ?? null) === null,
      `loudnessAfter=${JSON.stringify(reloaded.loudnessAfter)}`,
    );
  }

  // Export: JSON and TXT, both shapes.
  let threw = '';
  let jsonOut = '';
  let txtOut = '';
  try {
    const p1 = buildExportPayload(base, 'balanced', { now: '2026-01-01T00:00:00.000Z' });
    const p2 = buildExportPayload(unmeasured, 'balanced', { now: '2026-01-01T00:00:00.000Z' });
    jsonOut = exportAsJson(p1);
    txtOut = exportAsTxt(p2);
    const back = JSON.parse(jsonOut) as { loudness: Record<string, number | null> };
    check(
      'the report exports a null LRA as null, not as 0',
      back.loudness['afterLra'] === null && back.loudness['afterIntegratedLufs'] === -14.1,
      `afterIntegratedLufs=${String(back.loudness['afterIntegratedLufs'])}, afterLra=${String(back.loudness['afterLra'])}`,
    );
    const back2 = JSON.parse(exportAsJson(p2)) as { loudness: Record<string, number | null> };
    check(
      'and a result with no measurement at all exports nulls, not zeros',
      back2.loudness['afterIntegratedLufs'] === null && back2.loudness['afterTruePeakDbtp'] === null,
      JSON.stringify(back2.loudness),
    );
  } catch (e) { threw = (e as Error).message; }
  check(
    'neither export throws on a missing measurement',
    threw === '' && jsonOut.length > 0 && txtOut.length > 0,
    threw === '' ? `${jsonOut.length} B JSON, ${txtOut.length} B TXT` : threw,
  );

  // The stamped WAV: BWF `bext` says 0x7FFF for "not measured", which is the
  // same distinction in a file format that has had it since 2001.
  {
    const wav = new Uint8Array(44 + 8);
    const dv = new DataView(wav.buffer);
    const ascii = (at: number, t: string): void => {
      for (let i = 0; i < t.length; i++) dv.setUint8(at + i, t.charCodeAt(i));
    };
    ascii(0, 'RIFF'); dv.setUint32(4, wav.length - 8, true); ascii(8, 'WAVE');
    ascii(12, 'fmt '); dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
    dv.setUint32(24, 48_000, true); dv.setUint32(28, 192_000, true);
    dv.setUint16(32, 4, true); dv.setUint16(34, 16, true);
    ascii(36, 'data'); dv.setUint32(40, 8, true);

    let stampErr = '';
    let lraField = -1;
    let lufsField = -1;
    try {
      const out = stampWav(wav, {
        provenance: emptyProvenance('song'),
        appVersion: '3.7.0',
        // What HomePage now passes when the range was never measured: the
        // key is omitted rather than set to a number.
        loudness: { integratedLufs: -14.1, truePeakDbtp: -1.02 },
      });
      const text = new TextDecoder('latin1').decode(out);
      const at = text.indexOf('bext');
      const body = at + 8;
      const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
      lufsField = view.getInt16(body + 412, true);
      lraField  = view.getInt16(body + 414, true);
    } catch (e) { stampErr = (e as Error).message; }
    check(
      'the stamped master writes "not measured" for the range, and the real LUFS',
      stampErr === '' && lraField === 0x7fff && lufsField === -1410,
      stampErr === '' ? `bext lra=0x${lraField.toString(16)}, lufs=${lufsField} (−14.10)` : stampErr,
    );
  }
}

// ── The Python path is untouched ─────────────────────────────────────────
{
  const song = read('src/renderer/audio/session/render-song.ts');
  // The classic branch returns what the IPC answered, with no mapping and
  // no cast of a foreign shape — exactly as before this fix.
  check(
    'a song with no Studio settings still returns the engine\u2019s own result',
    /\) as MasteringResult;\n    return \{ result, path: 'classic' \};/.test(song),
    'the Python branch is unchanged',
  );
  const pythonShaped = { integratedLufs: -9.53, truePeakDbtp: -0.81, lra: 6.24 };
  check(
    'and a Python-shaped measurement is passed through to the digit',
    JSON.stringify(loudnessAfterFromRenderMetrics(pythonShaped)) === JSON.stringify(pythonShaped),
    'LUFS / TP / LRA all unchanged',
  );
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
