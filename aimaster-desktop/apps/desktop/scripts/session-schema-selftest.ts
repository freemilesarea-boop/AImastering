// session-schema-selftest — round-trip and validation for the .louisession
// serialize/deserialize pipeline.  Catches schema drift before it ships.
//
// Run: pnpm tsx scripts/session-schema-selftest.ts

import { serializeSession, deserializeSession, SESSION_VERSION } from '../src/renderer/audio/session/session-schema.js';

let fail = 0;
const check = (name: string, pass: boolean, detail = '') => {
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!pass) fail++;
};

console.log('\n=== SESSION SCHEMA ROUND-TRIP ===\n');

// Everything a user can tune, set away from its default — including every
// live-DSP override in `rt`, which is what actually drives the EQ, dynamics,
// imager and limiter.  This object IS the tuning; if a key of it does not
// come back, a saved session has silently lost a setting.
const TUNED = {
  style: 'kpop_loud' as const,
  targetLufs: -8,
  targetTp: -1.2,
  sampleRate: 44100,
  bitDepth: 16 as const,
  dither: 'tpdf' as const,
  applyAiCorrections: false,
  limiterStrength: 'low' as const,
  saturationAmount: 0.42,
  stereoWidth: 118,
  outputGainDb: -1.5,
  dynamicEqIntensity: 0.3,
  targetLufsExplicit: true,
  engineMode: 'rc' as const,
  quickPreset: 'kpop-loud',
  rt: {
    eqLowCutHz: 35, eqLowShelfDb: 2.5, eqPresenceDb: -1.5, eqAirDb: 3.5,
    dynThresholdDb: -22, dynRatio: 3.5, dynAttackMs: 4, dynReleaseMs: 250,
    dynMixPct: 70, imgWidthPct: 125, imgLowMonoHz: 140, limCeilingDbtp: -0.8,
    eqBypass: true, dynBypass: false, imgBypass: true, limBypass: false,
    masterBypass: false,
  },
};

const session = {
  version: SESSION_VERSION,
  createdAt: '2026-05-28T12:00:00.000Z',
  sourceFilePath: '/tmp/source.wav',
  referenceFilePath: '/tmp/ref.wav',
  presetId: 'kpop-loud',
  baseOptions: TUNED,
};

/** Every leaf of an object, as `a.b.c` → value. */
const flatten = (o: Record<string, unknown>, prefix = ''): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flatten(v as Record<string, unknown>, `${prefix}${k}.`));
    } else out[`${prefix}${k}`] = v;
  }
  return out;
};

// 1) Round-trip preserves all fields.
const json = serializeSession(session);
const loaded = deserializeSession(json);
check('Round-trip parses ok', loaded.ok);
if (loaded.ok) {
  check('Round-trip preserves source path', loaded.session.sourceFilePath === '/tmp/source.wav');
  check('Round-trip preserves reference path', loaded.session.referenceFilePath === '/tmp/ref.wav');
  check('Round-trip preserves preset id', loaded.session.presetId === 'kpop-loud');

  // Not a spot-check of two fields.  EVERY leaf of the tuning, by name, so a
  // setting that stops surviving a save is named here instead of being found
  // by a user whose mix came back flat.
  //
  // This replaced a check on `allModulesState.eq.parameters.airDb`, which
  // passed for as long as it existed while proving nothing: that field was
  // written at its defaults and never read back on open.  Its green was the
  // reason nobody noticed.
  const want = flatten(TUNED);
  const got = flatten(loaded.session.baseOptions as unknown as Record<string, unknown>);
  const keys = [...new Set([...Object.keys(want), ...Object.keys(got)])].sort();
  const lost = keys.filter((k) => JSON.stringify(want[k]) !== JSON.stringify(got[k]));
  check(`Round-trip preserves every tuned value (${keys.length} of them)`,
    lost.length === 0,
    lost.map((k) => `${k}: wrote ${JSON.stringify(want[k])}, read ${JSON.stringify(got[k])}`).join('; '));
  // And the count itself, so a tuning object that quietly shrinks — an `rt`
  // key dropped, a whole option gone — fails rather than passing on fewer.
  // 15 options plus the 17 live-DSP overrides in `rt` — every field of
  // `MasteringOptions` and `RealtimeDspOverrides`, so adding one without
  // tuning it here fails rather than going uncovered.
  check('…and the tuning still has every field it is supposed to',
    keys.length === 32, `counted ${keys.length}`);
}

// 2) Invalid JSON is rejected with a helpful error.
const badJson = deserializeSession('not json at all');
check('Invalid JSON rejected', !badJson.ok);

// 3) Wrong version is rejected.
const wrongVersion = deserializeSession(JSON.stringify({ ...session, version: 99 }));
check('Wrong version rejected', !wrongVersion.ok);

// 4) The one field worth refusing a file over is the one that carries tuning.
const noOptions = deserializeSession(JSON.stringify({ version: SESSION_VERSION }));
check('Missing baseOptions rejected', !noOptions.ok);

// 5) Missing optional fields → defaults.
const minimal = deserializeSession(JSON.stringify({
  version: SESSION_VERSION,
  baseOptions: session.baseOptions,
}));
check('Minimal session loads ok', minimal.ok);
if (minimal.ok) {
  check('Missing source path → null', minimal.session.sourceFilePath === null);
  check('Missing reference path → null', minimal.session.referenceFilePath === null);
  check('Missing preset id → undefined', minimal.session.presetId === undefined);
}

// 6) A session written before the free-EQ fields were dropped still loads.
//
// `freeEqEnabled` / `freeEqBands` described a WebAudio parametric EQ that was
// superseded by the Rust chain's `parametricBands`.  Nothing ever read them
// back — the writer hardcoded `false` / `[]` — so removing them loses no
// setting.  Files already on disk carry them, though, and must not be
// rejected or have the rest of their contents disturbed by the extra keys.
//
// `allModulesState` went the same way, and for the same reason: the writer
// filled it with `defaultAllModulesState(...)` on every save, `openSession`
// never looked at it, and it was 95 % of the bytes in the file.  The loader
// used to REFUSE a session that lacked it, which is why it outlived the
// free-EQ cleanup — so the case that matters most here is the one below in
// (4): a file without it now loads.
const legacy = deserializeSession(JSON.stringify({
  ...session,
  freeEqEnabled: true,
  freeEqBands: [
    { id: 'b1', type: 'bell', frequencyHz: 1200, gainDb: 3.5, q: 1.1, enabled: true },
    { id: 'b2', type: 'unknownType', frequencyHz: 100, gainDb: 0, q: 1, enabled: true },
  ],
  allModulesState: {
    eq: { moduleId: 'eq', bypass: false, parameters: { airDb: 4.5 } },
    imager: { moduleId: 'imager', bypass: false, parameters: { widthPct: 130 } },
  },
}));
check('A pre-removal session still loads', legacy.ok);
check('…and the fields around it survive intact',
  legacy.ok && legacy.session.baseOptions.targetLufs === -8
  && legacy.session.sourceFilePath === '/tmp/source.wav');
check('…and the dropped keys are gone rather than passed through',
  legacy.ok && !('freeEqBands' in (legacy.session as object))
  && !('freeEqEnabled' in (legacy.session as object))
  && !('allModulesState' in (legacy.session as object)));

// 7) And a session written from here on does not carry it at all.
check('A session we write has no module-state field',
  !('allModulesState' in JSON.parse(serializeSession(session as never)) as boolean));

console.log(`\n=== ${fail === 0 ? 'ALL SESSION SCHEMA TESTS PASS' : `${fail} FAILED`} ===\n`);
if (fail) process.exit(1);
