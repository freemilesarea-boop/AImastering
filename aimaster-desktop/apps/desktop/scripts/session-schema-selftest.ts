// session-schema-selftest — round-trip and validation for the .louisession
// serialize/deserialize pipeline.  Catches schema drift before it ships.
//
// Run: pnpm tsx scripts/session-schema-selftest.ts

import { serializeSession, deserializeSession, SESSION_VERSION } from '../src/renderer/audio/session/session-schema.js';
import { defaultAllModulesState } from '../src/renderer/audio/parameters/parameter-state.js';
import { ALL_MODULE_PARAMETER_DEFS } from '../src/renderer/audio/parameters/module-parameter-definitions.js';

let fail = 0;
const check = (name: string, pass: boolean, detail = '') => {
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!pass) fail++;
};

console.log('\n=== SESSION SCHEMA ROUND-TRIP ===\n');

const baseState = defaultAllModulesState(ALL_MODULE_PARAMETER_DEFS);
// Tweak some params so we can prove they survive the round trip.
const editedState = JSON.parse(JSON.stringify(baseState));
editedState.eq.parameters.airDb = 4.5;
editedState.imager.parameters.widthPct = 130;

const session = {
  version: SESSION_VERSION,
  createdAt: '2026-05-28T12:00:00.000Z',
  sourceFilePath: '/tmp/source.wav',
  referenceFilePath: '/tmp/ref.wav',
  allModulesState: editedState,
  presetId: 'kpop-loud',
  baseOptions: {
    style: 'kpop_loud' as const,
    targetLufs: -8,
    targetTp: -1,
    sampleRate: 48000,
    bitDepth: 24 as const,
    applyAiCorrections: true,
    limiterStrength: 'high' as const,
  },
};

// 1) Round-trip preserves all fields.
const json = serializeSession(session);
const loaded = deserializeSession(json);
check('Round-trip parses ok', loaded.ok);
if (loaded.ok) {
  check('Round-trip preserves source path', loaded.session.sourceFilePath === '/tmp/source.wav');
  check('Round-trip preserves reference path', loaded.session.referenceFilePath === '/tmp/ref.wav');
  check('Round-trip preserves preset id', loaded.session.presetId === 'kpop-loud');
  check('Round-trip preserves param edits',
    loaded.session.allModulesState.eq.parameters.airDb === 4.5
    && loaded.session.allModulesState.imager.parameters.widthPct === 130);
  check('Round-trip preserves base options', loaded.session.baseOptions.targetLufs === -8);
}

// 2) Invalid JSON is rejected with a helpful error.
const badJson = deserializeSession('not json at all');
check('Invalid JSON rejected', !badJson.ok);

// 3) Wrong version is rejected.
const wrongVersion = deserializeSession(JSON.stringify({ ...session, version: 99 }));
check('Wrong version rejected', !wrongVersion.ok);

// 4) Missing required fields is rejected.
const noState = deserializeSession(JSON.stringify({ version: SESSION_VERSION, baseOptions: session.baseOptions }));
check('Missing allModulesState rejected', !noState.ok);

const noOptions = deserializeSession(JSON.stringify({ version: SESSION_VERSION, allModulesState: editedState }));
check('Missing baseOptions rejected', !noOptions.ok);

// 5) Missing optional fields → defaults.
const minimal = deserializeSession(JSON.stringify({
  version: SESSION_VERSION,
  allModulesState: baseState,
  baseOptions: session.baseOptions,
}));
check('Minimal session loads ok', minimal.ok);
if (minimal.ok) {
  check('Missing source path → null', minimal.session.sourceFilePath === null);
  check('Missing reference path → null', minimal.session.referenceFilePath === null);
  check('Missing preset id → undefined', minimal.session.presetId === undefined);
}

console.log(`\n=== ${fail === 0 ? 'ALL SESSION SCHEMA TESTS PASS' : `${fail} FAILED`} ===\n`);
if (fail) process.exit(1);
