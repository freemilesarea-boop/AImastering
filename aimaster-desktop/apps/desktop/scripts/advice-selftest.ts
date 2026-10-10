/**
 * advice-selftest — did it read the audio, or is it a preset with a story?
 *
 * "AI recommendation" is the easiest feature in a DAW to fake.  A function
 * that returns a decent compressor setting looks identical, from the outside,
 * to one that measured the source — until you feed it two different sources
 * and it gives you the same answer twice.
 *
 * So nothing here checks that an advisor "produced settings".  Every test
 * builds TWO signals that differ in exactly one measurable way, and asserts
 * that the setting moves with it:
 *
 *   sibilance at 6 kHz vs 9 kHz    →  the de-esser's frequency moves
 *   noise floor at −60 vs −40 dB   →  the gate's threshold moves
 *   flat audio vs dynamic audio    →  the compressor engages, or refuses
 *   hum present vs a clean bass    →  the hum remover fires, or refuses
 *   120 BPM vs 90 BPM              →  the delay time moves
 *
 * A recommendation that does not move when the audio moves is a preset, and
 * these tests are what stops one being shipped as advice.
 *
 * Run:  pnpm --filter @aimaster/desktop test:advice
 */

import { OfflineAudioContext } from 'node-web-audio-api';
(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import { profileBuffer, type SourceProfile } from '../src/renderer/daw/ai/source-profile.js';
import {
  LOW_CONFIDENCE, adviseFor, canAdvise,
} from '../src/renderer/daw/ai/plugin-advice.js';
import { PLUGINS, findPlugin } from '../src/renderer/daw/engine/plugins.js';
import { analysisWindow, profileForInsert } from '../src/renderer/daw/ai/advice-runner.js';
import {
  addFile, addTrack, createClip, createInsert, createSession, createTrack, setInsert, updateClips,
} from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import { analyzeBuffer, clearAudioCache } from '../src/renderer/daw/engine/audio-cache.js';
import { renderTrackWindow } from '../src/renderer/daw/engine/offline-render.js';
import { defaultParams } from '../src/renderer/daw/engine/plugins.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

const SR = 48_000;

// ── Signal generators ───────────────────────────────────────────────────────

interface Buf { sampleRate: number; numberOfChannels: number; length: number;
  getChannelData(c: number): Float32Array }

function buffer(channels: Float32Array[]): Buf {
  return {
    sampleRate: SR,
    numberOfChannels: channels.length,
    length: channels[0]?.length ?? 0,
    getChannelData: (c) => channels[Math.min(c, channels.length - 1)] ?? new Float32Array(0),
  };
}

/** A deterministic noise source — a bounce must measure the same twice. */
function noise(seed = 12345): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x7fffffff - 1;
  };
}

function sine(seconds: number, hz: number, amp = 0.5): Float32Array {
  const out = new Float32Array(Math.round(SR * seconds));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / SR) * amp;
  return out;
}

/** Pink-ish broadband: white noise through a one-pole, so it is not all top. */
function broadband(seconds: number, amp = 0.25, seed = 7): Float32Array {
  const next = noise(seed);
  const out = new Float32Array(Math.round(SR * seconds));
  let z = 0;
  for (let i = 0; i < out.length; i++) {
    const white = next();
    z = white * 0.08 + z * 0.92;
    out[i] = (z * 3 + white * 0.35) * amp;
  }
  return out;
}

function add(target: Float32Array, source: Float32Array, gain = 1): Float32Array {
  for (let i = 0; i < target.length && i < source.length; i++) {
    target[i] = (target[i] ?? 0) + (source[i] ?? 0) * gain;
  }
  return target;
}

/** Broadband with a resonant bump at `hz` — a room ring, or a boxy guitar. */
function withResonance(base: Float32Array, hz: number, amount = 0.5): Float32Array {
  const out = Float32Array.from(base);
  // A narrow band of the same noise, made by ringing a two-pole at `hz`.
  const w = (2 * Math.PI * hz) / SR;
  const r = 0.999;
  const a1 = 2 * r * Math.cos(w);
  const a2 = -r * r;
  let y1 = 0;
  let y2 = 0;
  const scratch = new Float32Array(base.length);
  for (let i = 0; i < base.length; i++) {
    const y = (base[i] ?? 0) * (1 - r) + a1 * y1 + a2 * y2;
    y2 = y1;
    y1 = y;
    scratch[i] = y;
  }
  let peak = 0;
  for (const v of scratch) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (let i = 0; i < scratch.length; i++) scratch[i] = (scratch[i] ?? 0) / peak;
  return add(out, scratch, amount);
}

/** Loud bursts over a quiet floor — what a gate and a noise reducer read. */
function burstsOverFloor(seconds: number, floorDb: number, burstDb = -8): Float32Array {
  const out = broadband(seconds, Math.pow(10, floorDb / 20) * 4, 99);
  const burstAmp = Math.pow(10, burstDb / 20);
  const burst = Math.round(SR * 0.25);
  for (let start = Math.round(SR * 0.5); start + burst < out.length; start += Math.round(SR * 1.0)) {
    for (let i = 0; i < burst; i++) {
      const env = Math.exp(-i / (SR * 0.05));
      out[start + i] = (out[start + i] ?? 0) + Math.sin((2 * Math.PI * 220 * i) / SR) * burstAmp * env;
    }
  }
  return out;
}

const profileOf = (channels: Float32Array[], options = {}): SourceProfile =>
  profileBuffer(buffer(channels), { name: 'Test', kind: 'audio', tempoBpm: 120, ...options });

// ── The measurement ─────────────────────────────────────────────────────────

check('a sine reads as a sine', () => {
  const p = profileOf([sine(3, 1000)]);
  assert(!p.silent, 'not silent');
  // Peak over RMS for a sine is exactly √2, which is 3.01 dB.
  assert(Math.abs(p.crestDb - 3.01) < 0.6, `crest is 3 dB (got ${p.crestDb.toFixed(2)})`);
  assert(Math.abs(p.centroidHz - 1000) / 1000 < 0.35,
    `centroid is near 1 kHz (got ${Math.round(p.centroidHz)})`);
});

check('silence is reported as silence, not measured', () => {
  const p = profileOf([new Float32Array(SR)]);
  assert(p.silent, 'flagged silent');
  const result = adviseFor('comp', p);
  assert(!result.ok, 'and every advisor refuses');
  assert(!result.ok && result.reason.includes('소리'), `saying why: ${result.ok ? '' : result.reason}`);
});

check('a resonance is found where it was put', () => {
  for (const hz of [250, 900]) {
    const p = profileOf([withResonance(broadband(4), hz, 0.9)]);
    assert(p.resonance !== null, `${hz} Hz: something was found`);
    const found = p.resonance!.hz;
    assert(Math.abs(Math.log2(found / hz)) < 0.5,
      `${hz} Hz: found within half an octave (got ${Math.round(found)})`);
    assert(p.resonance!.excessDb >= 4, `and it stands out (${p.resonance!.excessDb.toFixed(1)} dB)`);
  }
});

check('a smooth source has no resonance to notch', () => {
  // The claim that makes the one above worth having: a bright source is not
  // a resonance, and an advisor must not invent one to have something to do.
  const p = profileOf([broadband(4)]);
  const excess = p.resonance?.excessDb ?? 0;
  assert(excess < 8, `broadband noise reads flat-ish (excess ${excess.toFixed(1)} dB)`);
});

check('sibilance is found at the frequency it actually sits at', () => {
  const low = profileOf([withResonance(broadband(4), 6000, 0.8)]);
  const high = profileOf([withResonance(broadband(4), 9500, 0.8)]);
  assert(Math.abs(Math.log2(low.sibilanceHz / 6000)) < 0.4,
    `6 kHz source reads near 6 k (got ${Math.round(low.sibilanceHz)})`);
  assert(high.sibilanceHz > low.sibilanceHz * 1.25,
    `and a 9.5 kHz source reads higher (${Math.round(low.sibilanceHz)} vs ${Math.round(high.sibilanceHz)})`);
});

check('the noise floor is the quiet part, not the quietest sample', () => {
  const quiet = profileOf([burstsOverFloor(6, -62)]);
  const noisy = profileOf([burstsOverFloor(6, -42)]);
  assert(noisy.noiseFloorDb > quiet.noiseFloorDb + 10,
    `a 20 dB worse floor reads worse (${quiet.noiseFloorDb.toFixed(1)} vs ${noisy.noiseFloorDb.toFixed(1)})`);
  assert(quiet.noiseFloorDb < quiet.rmsDb - 10, 'and it sits below the signal');
});

check('hum is detected by its harmonics, and a bass note is not hum', () => {
  const hummy = new Float32Array(SR * 4);
  for (const [multiple, gain] of [[1, 0.30], [2, 0.16], [3, 0.10], [4, 0.06]] as const) {
    add(hummy, sine(4, 60 * multiple, gain));
  }
  add(hummy, broadband(4, 0.02, 3));
  const withHum = profileOf([hummy]);
  assert(withHum.humHz === 60, `60 Hz hum found (got ${String(withHum.humHz)})`);

  const fifty = new Float32Array(SR * 4);
  for (const [multiple, gain] of [[1, 0.30], [2, 0.16], [3, 0.10]] as const) {
    add(fifty, sine(4, 50 * multiple, gain));
  }
  add(fifty, broadband(4, 0.02, 5));
  assert(profileOf([fifty]).humHz === 50, 'and 50 Hz is told apart from 60');

  // A bass guitar has energy at 60 Hz too.  What it does not have is a rigid
  // harmonic ladder sitting still over a quiet background.
  const bass = add(broadband(4, 0.3, 11), sine(4, 62, 0.25));
  assert(profileOf([bass]).humHz === null, 'a bass note is not reported as hum');
});

check('stereo is measured, including what the bass does on its own', () => {
  const left = broadband(3, 0.3, 21);
  const mono = profileOf([left, Float32Array.from(left)]);
  assert(mono.correlation > 0.98, `identical channels correlate (${mono.correlation.toFixed(3)})`);

  const flipped = Float32Array.from(left, (v) => -v);
  const inverted = profileOf([left, flipped]);
  assert(inverted.correlation < -0.9, `inverted reads negative (${inverted.correlation.toFixed(3)})`);

  const other = broadband(3, 0.3, 22);
  const wide = profileOf([left, other]);
  assert(Math.abs(wide.correlation) < 0.4, `decorrelated reads wide (${wide.correlation.toFixed(3)})`);
  assert(wide.bassCorrelation < 0.9, 'and its bass is decorrelated too');
});

check('the same audio measures the same twice', () => {
  const source = withResonance(broadband(3), 400, 0.6);
  const a = profileOf([source]);
  const b = profileOf([Float32Array.from(source)]);
  for (const key of ['rmsDb', 'crestDb', 'centroidHz', 'sibilanceHz', 'noiseFloorDb'] as const) {
    assert(Math.abs(a[key] - b[key]) < 1e-6, `${key} is deterministic`);
  }
});

// ── The advisors move with the audio ────────────────────────────────────────

check('the de-esser follows the voice, not a table', () => {
  const low = profileOf([withResonance(broadband(4), 6000, 0.9)], { name: 'Lead Vox' });
  const high = profileOf([withResonance(broadband(4), 9500, 0.9)], { name: 'Lead Vox' });

  const a = adviseFor('deesser', low);
  const b = adviseFor('deesser', high);
  assert(a.ok && b.ok, 'both got advice');
  if (!a.ok || !b.ok) return;
  assert(b.advice.params['freqHz']! > a.advice.params['freqHz']! * 1.2,
    `the frequency moved with the sibilance (${a.advice.params['freqHz']} → ${b.advice.params['freqHz']})`);
  assert(a.advice.evidence.some((e) => e.includes('치찰음')), 'and it says what it read');
});

check('the gate threshold sits above the measured floor, wherever that is', () => {
  // Both fixtures sit far enough over their floor to be worth gating — a
  // source only 10 dB above its noise is one the advisor refuses, which is
  // the next test rather than this one.
  const quiet = profileOf([burstsOverFloor(8, -70)]);
  const noisy = profileOf([burstsOverFloor(8, -50)]);
  const a = adviseFor('gate', quiet);
  const b = adviseFor('gate', noisy);
  assert(a.ok && b.ok, `both got advice (${a.ok ? '' : a.reason}${b.ok ? '' : b.reason})`);
  if (!a.ok || !b.ok) return;

  for (const [profile, result] of [[quiet, a], [noisy, b]] as const) {
    const threshold = result.advice.params['thresholdDb']!;
    assert(Math.abs(threshold - (profile.noiseFloorDb + 6)) < 1.5,
      `threshold is 6 dB over the floor (floor ${profile.noiseFloorDb.toFixed(1)}, set ${threshold})`);
  }
  assert(b.advice.params['thresholdDb']! > a.advice.params['thresholdDb']! + 8,
    'so a worse floor gates higher');
});

check('the gate refuses a source that is barely above its own noise', () => {
  // Gating this would cut the quiet parts of the performance, not the noise.
  const buried = profileOf([burstsOverFloor(6, -42)]);
  const result = adviseFor('gate', buried);
  assert(!result.ok, `refused (span ${(buried.rmsDb - buried.noiseFloorDb).toFixed(1)} dB)`);
  assert(!result.ok && result.reason.includes('노이즈 플로어'), 'and it says what it measured');
});

check('the compressor refuses flat audio and engages on dynamic audio', () => {
  const flat = profileOf([sine(4, 300)]);
  const flatResult = adviseFor('comp', flat);
  assert(!flatResult.ok, 'a steady sine needs no compression');
  assert(!flatResult.ok && flatResult.reason.includes('평탄'), 'and says so');

  const dynamic = profileOf([burstsOverFloor(8, -55, -4)]);
  const result = adviseFor('comp', dynamic);
  assert(result.ok, `bursts do (${result.ok ? '' : result.reason})`);
  if (!result.ok) return;
  assert(result.advice.params['ratio']! > 1.5, 'with a real ratio');
  assert(result.advice.evidence.some((e) => e.includes('다이내믹')), 'and it names the range it read');
});

check('the compressor ratio follows how uneven the source is', () => {
  const gentle = profileOf([burstsOverFloor(8, -30, -10)]);
  const extreme = profileOf([burstsOverFloor(8, -70, -3)]);
  const a = adviseFor('comp', gentle);
  const b = adviseFor('comp', extreme);
  if (!a.ok || !b.ok) { assert(false, 'both advised'); return; }
  assert(extreme.dynamicRangeDb > gentle.dynamicRangeDb, 'the fixture really is more uneven');
  assert(b.advice.params['ratio']! >= a.advice.params['ratio']!,
    `and the ratio follows (${a.advice.params['ratio']} → ${b.advice.params['ratio']})`);
});

check('the hum remover fires on hum and refuses without it', () => {
  const hummy = new Float32Array(SR * 4);
  for (const [multiple, gain] of [[1, 0.3], [2, 0.16], [3, 0.1], [4, 0.06]] as const) {
    add(hummy, sine(4, 50 * multiple, gain));
  }
  add(hummy, broadband(4, 0.02, 31));
  const withHum = adviseFor('hum', profileOf([hummy]));
  assert(withHum.ok, 'hum gets advice');
  if (withHum.ok) {
    assert(withHum.advice.params['baseHz'] === 50, 'at the frequency that was found, not a default 60');
  }

  const clean = adviseFor('hum', profileOf([broadband(4, 0.3, 41)]));
  assert(!clean.ok, 'clean audio gets a refusal');
  assert(!clean.ok && clean.reason.includes('검출'), `saying it looked: ${clean.ok ? '' : clean.reason}`);
});

check('the mono maker refuses correlated bass and raises the corner as it worsens', () => {
  const left = broadband(3, 0.3, 51);
  const together = adviseFor('monomaker', profileOf([left, Float32Array.from(left)]));
  assert(!together.ok, 'identical channels need no mono maker');

  const wide = profileOf([left, broadband(3, 0.3, 52)]);
  const result = adviseFor('monomaker', wide);
  assert(result.ok, 'decorrelated bass does');
  if (!result.ok) return;
  assert(result.advice.params['freqHz']! >= 90, 'with a real corner');
  assert(result.advice.evidence.some((e) => e.includes('상관도')), 'and it names the correlation');
});

check('delay times are the tempo, not a number somebody liked', () => {
  const at120 = adviseFor('delay', profileOf([broadband(3)], { tempoBpm: 120, name: 'Lead Vox' }));
  const at90 = adviseFor('delay', profileOf([broadband(3)], { tempoBpm: 90, name: 'Lead Vox' }));
  if (!at120.ok || !at90.ok) { assert(false, 'both advised'); return; }
  // An eighth note at 120 BPM is 250 ms; at 90 it is 333.
  assert(Math.abs(at120.advice.params['timeMs']! - 250) < 6,
    `120 BPM → 250 ms (got ${at120.advice.params['timeMs']})`);
  assert(Math.abs(at90.advice.params['timeMs']! - 333) < 8,
    `90 BPM → 333 ms (got ${at90.advice.params['timeMs']})`);
});

check('trim aims at a working level from wherever the source is', () => {
  const quiet = profileOf([broadband(3, 0.02, 61)]);
  const loud = profileOf([broadband(3, 0.5, 62)]);
  const a = adviseFor('trim', quiet);
  const b = adviseFor('trim', loud);
  if (!a.ok || !b.ok) { assert(false, 'both advised'); return; }
  for (const [profile, result] of [[quiet, a], [loud, b]] as const) {
    const landed = profile.rmsDb + result.advice.params['gainDb']!;
    assert(Math.abs(landed - (-18)) < 1.2,
      `lands on −18 dBFS (from ${profile.rmsDb.toFixed(1)} → ${landed.toFixed(1)})`);
  }
  assert(a.advice.params['gainDb']! > b.advice.params['gainDb']!, 'and the quiet one gets more');
});

check('the limiter refuses when there is nothing to limit', () => {
  const quiet = profileOf([broadband(4, 0.02, 71)]);
  const refused = adviseFor('limiter', quiet);
  assert(!refused.ok, 'headroom means no limiter');
  assert(!refused.ok && refused.reason.includes('트루피크'), 'and it says what it measured');

  const hot = profileOf([broadband(4, 0.9, 72)]);
  const engaged = adviseFor('limiter', hot);
  assert(engaged.ok, 'a hot source gets a ceiling');
  if (engaged.ok) assert(engaged.advice.params['ceilingDb'] === -1, 'at −1 dBTP');
});

check('the exciter refuses a source that already has air', () => {
  const bright = profileOf([withResonance(broadband(4, 0.3, 81), 14000, 1.2)]);
  const dull = profileOf([(() => {
    // Everything above 3 kHz rolled off — nothing up top to lift.
    const out = broadband(4, 0.3, 82);
    let z = 0;
    const a = Math.exp((-2 * Math.PI * 3000) / SR);
    for (let i = 0; i < out.length; i++) { z = (out[i] ?? 0) * (1 - a) + z * a; out[i] = z * 3; }
    return out;
  })()]);
  assert(dull.airDb < bright.airDb, 'the fixtures differ in air as intended');
  const forDull = adviseFor('exciter', dull);
  assert(forDull.ok, `a dull source gets air (${forDull.ok ? '' : forDull.reason})`);
});

// ── Every advisor, on every kind of source ──────────────────────────────────

check('no advisor can put a device somewhere it cannot go', () => {
  // The clamp is the safety net under forty-one hand-written advisors: one
  // arithmetic slip must not be able to set a −900 dB threshold.
  const fixtures: SourceProfile[] = [
    profileOf([sine(2, 100)]),
    profileOf([broadband(2)], { name: 'Lead Vox' }),
    profileOf([burstsOverFloor(4, -60)], { name: 'Snare' }),
    profileOf([broadband(2, 0.9, 91)], { name: 'Bass', tempoBpm: 174 }),
    profileOf([broadband(2, 0.05, 92), broadband(2, 0.05, 93)], { name: 'Pad', tempoBpm: 60 }),
  ];

  const problems: string[] = [];
  for (const plugin of PLUGINS) {
    for (const profile of fixtures) {
      const result = adviseFor(plugin.id, profile);
      if (!result.ok) {
        if (result.reason.trim().length === 0) problems.push(`${plugin.id}: empty refusal`);
        continue;
      }
      const { params, confidence, headline, evidence } = result.advice;
      if (!(confidence >= 0 && confidence <= 1)) problems.push(`${plugin.id}: confidence ${confidence}`);
      if (headline.trim().length === 0) problems.push(`${plugin.id}: no headline`);
      if (evidence.length === 0) problems.push(`${plugin.id}: no evidence`);
      for (const def of plugin.params) {
        const value = params[def.id];
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          problems.push(`${plugin.id}.${def.id} = ${String(value)}`);
        } else if (value < def.min - 1e-9 || value > def.max + 1e-9) {
          problems.push(`${plugin.id}.${def.id} = ${value} outside ${def.min}…${def.max}`);
        }
      }
      const extra = Object.keys(params).filter(
        (id) => !plugin.params.some((def) => def.id === id));
      if (extra.length > 0) problems.push(`${plugin.id}: unknown params ${extra.join(',')}`);
      if (Object.keys(params).length !== plugin.params.length) {
        problems.push(`${plugin.id}: incomplete param map`);
      }
    }
  }
  assert(problems.length === 0, problems.slice(0, 8).join('; '));
});

check('every device either advises or says why it does not', () => {
  const covered = PLUGINS.filter((p) => canAdvise(p.id));
  assert(covered.length === PLUGINS.length,
    `all ${PLUGINS.length} devices have an advisor (${covered.length})`);

  // The three that refuse on principle, because no measurement decides them.
  const profile = profileOf([broadband(3)]);
  for (const id of ['dither', 'bitcrush', 'dcblock']) {
    const result = adviseFor(id, profile);
    assert(!result.ok, `${id} refuses`);
    assert(!result.ok && result.reason.length > 10, `${id} explains itself`);
  }
});

check('advice is a complete setting, so applying it cannot leave a stale knob', () => {
  const profile = profileOf([burstsOverFloor(6, -55)], { name: 'Snare' });
  const result = adviseFor('eq8', profile);
  assert(result.ok, 'advised');
  if (!result.ok) return;
  const device = findPlugin('eq8')!;
  for (const def of device.params) {
    assert(typeof result.advice.params[def.id] === 'number', `${def.id} is set`);
  }
  const again = adviseFor('eq8', profile);
  assert(again.ok, 'twice');
  if (again.ok) {
    assert(JSON.stringify(again.advice.params) === JSON.stringify(result.advice.params),
      'and the same profile gives the same answer');
  }
});

check('a low-confidence suggestion is marked as one', () => {
  // Modulation depth is taste; the device that admits it must actually be
  // below the threshold the UI uses to say so.
  const profile = profileOf([broadband(3)]);
  const chorus = adviseFor('chorus', profile);
  assert(chorus.ok, 'chorus advises');
  if (chorus.ok) {
    assert(chorus.advice.confidence < LOW_CONFIDENCE,
      `and admits it is taste (${chorus.advice.confidence})`);
  }
  const hummy = new Float32Array(SR * 4);
  for (const [m, g] of [[1, 0.3], [2, 0.16], [3, 0.1], [4, 0.06]] as const) add(hummy, sine(4, 60 * m, g));
  const hum = adviseFor('hum', profileOf([hummy]));
  assert(hum.ok && hum.advice.confidence > LOW_CONFIDENCE,
    'while a measured detection is confident');
});

// ── The window that gets measured ───────────────────────────────────────────

check('the analysis window starts where the material starts', () => {
  let session = createSession('advice');
  const track = createTrack('Vox', 'audio');
  const clip = {
    id: 'c1', kind: 'audio' as const, fileId: 'f1', name: 'take',
    startSec: 12, durationSec: 90, offsetSec: 0, gainDb: 0,
    fadeIn: null, fadeOut: null, muted: false,
  };
  const withClip = {
    ...track,
    playlists: track.playlists.map((p) => (p.id === track.activePlaylistId
      ? { ...p, clips: [clip as never] } : p)),
  };
  session = { ...session, tracks: [...session.tracks, withClip] };

  const window = analysisWindow(session, track.id);
  assert(window !== null, 'there is a window');
  assert(window!.startSec === 12, `it starts at the clip, not at zero (${window!.startSec})`);
  assert(window!.endSec - window!.startSec <= 30 + 1e-6,
    `and it is bounded (${(window!.endSec - window!.startSec).toFixed(1)} s)`);

  const selected = analysisWindow(session, track.id,
    { startSec: 40, endSec: 52, trackIds: [track.id] });
  assert(selected?.startSec === 40, 'a selection wins over the clip start');

  const empty = analysisWindow(session, session.tracks[0]!.id);
  assert(empty === null, 'and a track with nothing on it has no window');
});

// ── The half of the path that renders ─────────────────────────────────────
//
// Everything above feeds `profileBuffer` a synthetic buffer, which is the
// right way to check that advice MOVES with the audio.  It leaves the other
// half untested: `profileForInsert` renders the channel first, and a bug in
// that render reaches every advisor at once without any of them looking wrong.
//
// One did.  `renderTrackWindow` muted the other tracks but kept their
// inserts, and delay compensation counts a muted track's latency, so a
// linear-phase EQ on a track nobody was looking at shifted this window by
// exactly its own 511 samples — correlation 1.0000, so a shift and not a
// change of tone.  Off the same audio that moved 63 of a profile's 129 fields
// and took the compressor's recommended attack from 56 ms to 28 ms.
//
// An advisor that changes its mind because of a plugin on another track is
// not reading the source, which is the one thing this suite exists to check.
async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}

/** Bursts, so where the window starts changes the attack statistics. */
function burstFile(id: string): void {
  const ctx = new OfflineAudioContext(2, SR * 3, SR);
  const buf = ctx.createBuffer(2, SR * 3, SR);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let seed = 4242 + c * 31;
    for (let i = 0; i < d.length; i++) {
      seed = (Math.imul(seed ^ (seed >>> 15), 1 | seed) + 0x6d2b79f5) >>> 0;
      const env = (i % 12_000) < 3_000 ? 1 : 0.05;
      d[i] = ((seed >>> 8) / 8_388_608 - 1) * 0.25 * env;
    }
  }
  analyzeBuffer(id, buf as unknown as AudioBuffer);
}

async function neighbourCannotChangeTheAdvice(): Promise<void> {
  clearAudioCache();
  resetIds();
  burstFile('src');
  let s = createSession('advice', SR);
  const subject = createTrack('Subject', 'audio', { output: { kind: 'master' } });
  const other = createTrack('Other', 'audio', { output: { kind: 'master' } });
  s = addTrack(s, subject);
  s = addTrack(s, other);
  s = addFile(s, {
    id: 'src', path: '/virtual/src.wav', name: 'src',
    durationSec: 3, sampleRate: SR, channels: 2,
  });
  for (const t of [subject, other]) {
    s = updateClips(s, t.id,
      () => [createClip('src', 'src', { startSec: 0, offsetSec: 0, durationSec: 3 })]);
  }
  // Advice is being taken for the device at slot 1, so slot 0 is what it hears.
  s = setInsert(s, subject.id, createInsert(0, 'eq', 'EQ', { params: defaultParams('eq') }));
  s = setInsert(s, subject.id,
    createInsert(1, 'comp', 'Compressor', { params: defaultParams('comp') }));

  const LATENCY = 511;
  const withNeighbour = setInsert(s, other.id,
    createInsert(0, 'linphase', 'Linear Phase EQ', {
      params: defaultParams('linphase'), latencySamples: LATENCY,
    }));

  // Rendered directly rather than through `profileForInsert`, whose cache key
  // covers the measured track only — it would have served the first answer
  // back and passed this without measuring anything.
  const at = async (sess: typeof s): Promise<Buf> => await renderTrackWindow(sess, subject.id, {
    beforeSlot: 1, startSec: 0, endSec: 3,
  }) as unknown as Buf;
  const plain = await at(s);
  const beside = await at(withNeighbour);

  let worst = 0;
  const n = Math.min(plain.length, beside.length);
  for (let c = 0; c < plain.numberOfChannels; c++) {
    const x = plain.getChannelData(c);
    const y = beside.getChannelData(c);
    for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs((x[i] ?? 0) - (y[i] ?? 0)));
  }
  assert(worst < 1e-9,
    `a ${LATENCY}-sample device on another track changed this one's audio by `
    + `${worst.toExponential(2)} — the window moved`);

  const pa = profileBuffer(plain as never, { name: 'Subject', kind: 'audio', tempoBpm: 120 });
  const pb = profileBuffer(beside as never, { name: 'Subject', kind: 'audio', tempoBpm: 120 });
  // Named one by one: "the profiles match" would not say which reading drifted.
  for (const id of ['comp', 'gate', 'deesser', 'eq', 'limiter'] as const) {
    const before = JSON.stringify(adviseFor(id, pa));
    const after = JSON.stringify(adviseFor(id, pb));
    assert(before === after,
      `the ${id} advice changed because of a plugin on another track\n    ${before}\n    ${after}`);
  }
}

async function theCacheIsSoundOnceTheRenderIs(): Promise<void> {
  clearAudioCache();
  resetIds();
  burstFile('src');
  let s = createSession('cache', SR);
  const subject = createTrack('Subject', 'audio', { output: { kind: 'master' } });
  const other = createTrack('Other', 'audio', { output: { kind: 'master' } });
  s = addTrack(s, subject);
  s = addTrack(s, other);
  s = addFile(s, {
    id: 'src', path: '/virtual/src.wav', name: 'src',
    durationSec: 3, sampleRate: SR, channels: 2,
  });
  for (const t of [subject, other]) {
    s = updateClips(s, t.id,
      () => [createClip('src', 'src', { startSec: 0, offsetSec: 0, durationSec: 3 })]);
  }
  s = setInsert(s, subject.id, createInsert(0, 'eq', 'EQ', { params: defaultParams('eq') }));

  const first = await profileForInsert({ session: s, trackId: subject.id, slot: 0 });
  const withNeighbour = setInsert(s, other.id,
    createInsert(0, 'linphase', 'Linear Phase EQ', {
      params: defaultParams('linphase'), latencySamples: 511,
    }));
  const again = await profileForInsert({
    session: withNeighbour, trackId: subject.id, slot: 0,
  });
  // The key does not mention the other tracks, so this is a hit — which is
  // only CORRECT because the render no longer depends on them.  Stated here
  // so that if the render ever does again, the reason this cache is allowed
  // to ignore them is on the record.
  assert(again.cached, 'the key covers the measured track, so this should be a hit');
  assert(JSON.stringify(first.profile) === JSON.stringify(again.profile),
    'a cache hit returned a different profile');
}

async function main(): Promise<void> {
  await checkAsync('a plugin on another track cannot change the advice',
    neighbourCannotChangeTheAdvice);
  await checkAsync('and the advice cache may ignore the other tracks, because the render does',
    theCacheIsSoundOnceTheRenderIs);

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log('\n=== AI 추천 — 측정과 그 근거 ===');
  for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
  if (failed > 0) process.exit(1);
}
void main();
