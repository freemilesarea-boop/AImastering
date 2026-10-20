// engine-notice-selftest — does the app say it when its engine is half-built?
//
// Two PyInstaller specs shipped an engine whose numpy or soundfile could not
// be imported.  Both built cleanly, both started, both reached READY, both
// answered every request — with `available: false`, every band at -120 dB and
// duration 0, which the app showed as "분석할 수 없습니다" about files that
// were fine.  The loudness numbers kept coming, because those come from
// ffmpeg, so nothing looked broken.
//
// `env_info` answered this all along.  It was one of six engine methods the
// app could not call: `bridge.call()` takes `RPCRequest['method']`, and that
// union named three.  Not uncalled — uncallable.

import { engineWarning, readEngineWarning } from '../src/renderer/lib/engine-notice.js';
import { IPC } from '@aimaster/shared-types';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) { passed++; console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('\n=== WHAT THE USER IS TOLD ===\n');

const healthy = { waveform: { available: true, numpy: '1.26.4', soundfile: '0.13.1', reason: null } };
check(
  'a working engine produces no warning',
  engineWarning(healthy) === null,
  String(engineWarning(healthy)),
);

const broken = {
  waveform: {
    available: false, numpy: null, soundfile: null,
    reason: "ModuleNotFoundError: No module named 'secrets'",
  },
};
const sentence = engineWarning(broken);
check(
  'a half-built engine produces a warning',
  sentence !== null,
  String(sentence),
);
check(
  'and the warning names what is lost and what still works',
  sentence !== null && /밴드/.test(sentence) && /스테레오/.test(sentence)
    && /라우드니스/.test(sentence) && /내보내기/.test(sentence),
  'a user who only hears "something is wrong" cannot tell whether to keep working',
);
check(
  'and it does not read as a damaged file, which is what the app said before',
  sentence !== null && !/손상/.test(sentence),
  String(sentence),
);

console.log('\n=== AND WHEN THE QUESTION CANNOT BE ASKED ===\n');

// Not knowing is not a verdict.  `null` from the channel, a channel that
// throws, and an engine too old to carry the field must all stay silent —
// warning wrongly about an engine that is fine is its own defect.
check(
  'nothing to say when the status could not be read',
  engineWarning(null) === null,
);
check(
  'nothing to say when the engine does not report the field',
  engineWarning({}) === null,
  'an engine built before env_info carried `waveform`',
);

void (async (): Promise<void> => {
  check(
    'a channel that throws is silent, not a warning',
    await readEngineWarning(() => Promise.reject(new Error('No handler registered'))) === null,
  );
  check(
    'a channel that answers null is silent',
    await readEngineWarning(() => Promise.resolve(null)) === null,
  );
  check(
    'and a real answer comes back as the sentence',
    (await readEngineWarning(() => Promise.resolve(broken))) === sentence,
  );
  check(
    'the channel it asks is the one the shared map names',
    IPC.ENGINE_STATUS === 'system:engine-status',
    IPC.ENGINE_STATUS,
  );

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
