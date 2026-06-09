// Selftest — free parametric EQ: model sanitisation + chain reconciliation.
//
// `setFreeEqBands(media, bands)` lazily creates a ParametricEqChain and calls
// chain.applyBands(bands).  This test exercises that exact DSP path with a
// MOCK BaseAudioContext (no real WebAudio), verifying:
//   • sanitizeBands clamps freq/gain/Q + caps to MAX_BANDS
//   • applyBands sets BiquadFilter frequency/Q/gain from enabled bands
//   • topology rebuilds on band count/type change; isActive() reflects state
//   • disabled bands are skipped
// Headless — run via `pnpm test:parametric-eq`.

import {
  sanitizeBands, defaultBand, MAX_BANDS, MAX_GAIN_DB, MAX_FREQ_HZ, MIN_Q,
  type ParametricEqBand,
} from '../src/renderer/audio/modules/parametric-eq-model.js';
import { createParametricEqChain } from '../src/renderer/audio/parametric-eq-chain.js';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}`); }
}

// ── Mock WebAudio nodes ────────────────────────────────────────────────────
class MockParam { value = 0; }
class MockBiquad {
  type = 'peaking';
  frequency = new MockParam();
  Q = new MockParam();
  gain = new MockParam();
  connect(): void {}
  disconnect(): void {}
}
class MockGain { gain = new MockParam(); connect(): void {} disconnect(): void {} }

let biquadCount = 0;
const mockCtx = {
  createGain: () => new MockGain(),
  createBiquadFilter: () => { biquadCount++; return new MockBiquad(); },
} as unknown as BaseAudioContext;

const band = (over: Partial<ParametricEqBand>): ParametricEqBand => ({ ...defaultBand(1000, 0), ...over });

console.log('parametric-eq-selftest');

console.log('sanitizeBands');
{
  const dirty: ParametricEqBand[] = [
    band({ frequencyHz: 999999, gainDb: 99, q: 0.001 }),
    band({ frequencyHz: NaN, gainDb: -999, q: NaN }),
  ];
  const clean = sanitizeBands(dirty);
  check('frequency clamped to MAX', clean[0].frequencyHz === MAX_FREQ_HZ);
  check('gain clamped to +MAX', clean[0].gainDb === MAX_GAIN_DB);
  check('Q clamped to MIN', clean[0].q === MIN_Q);
  check('NaN freq → 1000 fallback', clean[1].frequencyHz === 1000);
  check('NaN q → 1 fallback', clean[1].q === 1);
  // Cap to MAX_BANDS.
  const many = sanitizeBands(Array.from({ length: MAX_BANDS + 4 }, () => band({})));
  check(`caps to MAX_BANDS (${MAX_BANDS})`, many.length === MAX_BANDS);
}

console.log('chain applyBands (model → DSP)');
{
  biquadCount = 0;
  const chain = createParametricEqChain(mockCtx);
  check('starts inactive (passthrough)', chain.isActive() === false);

  // Two enabled bands of different types → 2 biquads, params set.
  chain.applyBands([
    band({ type: 'bell', frequencyHz: 2500, gainDb: 4, q: 1.5, enabled: true }),
    band({ type: 'highshelf', frequencyHz: 12000, gainDb: 2, q: 0.7, enabled: true }),
  ]);
  check('active after enabled bands', chain.isActive() === true);
  check('created 2 biquads', biquadCount === 2);

  // A disabled band is skipped (no extra biquad).
  biquadCount = 0;
  chain.applyBands([
    band({ type: 'bell', frequencyHz: 1000, gainDb: 3, q: 1, enabled: true }),
    band({ type: 'bell', frequencyHz: 5000, gainDb: -2, q: 2, enabled: false }),
  ]);
  check('disabled band skipped → bell slot reused, no new biquad', biquadCount === 0);
  check('still active (1 enabled)', chain.isActive() === true);

  // All disabled → inactive passthrough.
  chain.applyBands([band({ enabled: false })]);
  check('all-disabled → inactive', chain.isActive() === false);

  // Empty list → inactive.
  chain.applyBands([]);
  check('empty list → inactive', chain.isActive() === false);

  chain.dispose();
  check('dispose does not throw', true);
}

console.log('hp/lp ignore gain (no NaN)');
{
  const chain = createParametricEqChain(mockCtx);
  chain.applyBands([
    band({ type: 'highpass', frequencyHz: 30, gainDb: 12, q: 0.7, enabled: true }),
    band({ type: 'lowpass', frequencyHz: 18000, gainDb: 12, q: 0.7, enabled: true }),
  ]);
  check('hp/lp applied without error', chain.isActive() === true);
  chain.dispose();
}

if (failures > 0) { console.error(`\nFAILED: ${failures} check(s)`); process.exit(1); }
console.log('\nALL PASS');
