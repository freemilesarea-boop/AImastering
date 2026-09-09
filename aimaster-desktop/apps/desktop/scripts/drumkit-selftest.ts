/**
 * drumkit-selftest.ts — the one instrument where pitch is not pitch.
 *
 * Note 36 is not a low C, it is a kick.  Note 42 is not an F#, it is a closed
 * hi-hat.  Every other instrument in this engine turns the note number into a
 * frequency and plays it — and a kit that did that would answer a drum part
 * with a chromatic run of bleeps, which is what this app actually did: the
 * drum map named the rows and ordered them and choked the hats, and then
 * handed the part to a poly synth.
 *
 * So the claims here are about SOUND, measured, not about the table being
 * spelled correctly:
 *
 *   · a kick's energy is low and a hat's is high — if those two ever came out
 *     the same, the kit is a sine generator with a lookup table
 *   · a closed hat stops and an open hat rings, which is the only difference
 *     between them a listener can hear
 *   · the toms rise in pitch in the order the map lists them
 *   · the same hit twice is the SAME sound (a bounce has to match the preview
 *     it was approved from) and two different hits are not
 *
 * Rendered through node-web-audio-api.  Unlike the reverb suite, most of what
 * is measured here is envelope and spectrum rather than a host's reading of a
 * feedback graph, so a green run is meaningful about Chromium too — but the
 * running app was measured separately anyway.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:drumkit
 */

import { OfflineAudioContext } from 'node-web-audio-api';
(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import { readFileSync } from 'node:fs';
import { findInstrument, defaultInstrumentParams } from '../src/renderer/daw/engine/instruments.js';
import {
  DRUM_KIT, drumSpecFor, kitPitches, mulberry32, noiseSamples,
} from '../src/renderer/daw/engine/drum-model.js';
import { GM_DRUM_SLOTS } from '../src/renderer/daw/model/drum-map.js';
import { addInstrumentSlot } from '../src/renderer/daw/model/instrument-rack.js';
import { drumMapFor } from '../src/renderer/daw/model/drum-map-session.js';
import {
  createMidiPart, createSession, createTrack, findTrack, trackClips,
} from '../src/renderer/daw/model/session-ops.js';
import { createNote, DEFAULT_MIDI_CONFIG } from '../src/renderer/daw/model/midi.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => { results.push({ name, pass: true, detail: '' }); })
    .catch((e: Error) => { results.push({ name, pass: false, detail: e.message }); });
}
function assert(cond: boolean, detail: string): void {
  if (!cond) throw new Error(detail);
}

const SR = 48_000;

/** Render one drum hit on its own and hand back the mono sum. */
async function renderHit(
  pitch: number, velocity = 0.9, seconds = 2.5,
  params: Record<string, number> = {},
): Promise<Float32Array> {
  const kit = findInstrument('drumkit');
  if (!kit) throw new Error('there is no drumkit instrument');
  const ctx = new OfflineAudioContext(2, Math.round(SR * seconds), SR);
  const note = createNote({ pitch, velocity, startBeat: 0, durationBeat: 1 });
  kit.playNote({
    ctx: ctx as unknown as BaseAudioContext,
    destination: ctx.destination as unknown as AudioNode,
    note, config: DEFAULT_MIDI_CONFIG, when: 0, durationSec: 0.5,
    params: { ...defaultInstrumentParams('drumkit'), ...params },
  });
  const buf = await ctx.startRendering();
  const l = buf.getChannelData(0);
  const r = buf.getChannelData(1);
  const out = new Float32Array(l.length);
  for (let i = 0; i < l.length; i++) out[i] = (l[i]! + r[i]!) * 0.5;
  return out;
}

/** Both channels, for the stereo-position checks. */
async function renderStereo(pitch: number): Promise<{ l: Float32Array; r: Float32Array }> {
  const kit = findInstrument('drumkit')!;
  const ctx = new OfflineAudioContext(2, Math.round(SR * 2.5), SR);
  kit.playNote({
    ctx: ctx as unknown as BaseAudioContext,
    destination: ctx.destination as unknown as AudioNode,
    note: createNote({ pitch, velocity: 0.9, startBeat: 0, durationBeat: 1 }),
    config: DEFAULT_MIDI_CONFIG, when: 0, durationSec: 0.5,
    params: defaultInstrumentParams('drumkit'),
  });
  const buf = await ctx.startRendering();
  return { l: Float32Array.from(buf.getChannelData(0)), r: Float32Array.from(buf.getChannelData(1)) };
}

function peak(x: Float32Array): number {
  let p = 0; for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]!));
  return p;
}
function rms(x: Float32Array, from = 0, to = x.length): number {
  let s = 0; const n = Math.max(1, to - from);
  for (let i = from; i < to; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / n);
}

/**
 * How long until the hit has fallen 40 dB below its own peak, in seconds.
 *
 * Windowed PEAK against a peak threshold.  The first version compared a
 * window's RMS against the whole hit's peak, which is not the same quantity —
 * RMS of a decaying signal sits below its peak — so every tail read short and
 * a crash that was audibly ringing at 0.85 s was reported dead at 0.67 s.
 */
function decaySec(x: Float32Array): number {
  const p = peak(x);
  if (p <= 0) return 0;
  const floor = p * 0.01;
  const win = Math.round(SR * 0.01);
  for (let i = x.length - win; i > 0; i -= win) {
    let w = 0;
    for (let j = i; j < i + win && j < x.length; j++) w = Math.max(w, Math.abs(x[j]!));
    if (w > floor) return (i + win) / SR;
  }
  return 0;
}

/** Energy in a band, by Goertzel over a sweep — enough to compare voices. */
function bandEnergy(x: Float32Array, lo: number, hi: number, steps = 24): number {
  let total = 0;
  const n = Math.min(x.length, Math.round(SR * 0.35));
  for (let k = 0; k < steps; k++) {
    const hz = lo * Math.pow(hi / lo, k / (steps - 1));
    const w = 2 * Math.PI * hz / SR, c = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < n; i++) { const s0 = x[i]! + c * s1 - s2; s2 = s1; s1 = s0; }
    total += s1 * s1 + s2 * s2 - c * s1 * s2;
  }
  return total / steps;
}

/** Where the energy sits, in Hz — the one number that separates a kick from a hat. */
function centroid(x: Float32Array): number {
  const n = Math.min(x.length, Math.round(SR * 0.25));
  let num = 0, den = 0;
  for (let k = 0; k < 40; k++) {
    const hz = 40 * Math.pow(14000 / 40, k / 39);
    const w = 2 * Math.PI * hz / SR, c = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < n; i++) { const s0 = x[i]! + c * s1 - s2; s2 = s1; s1 = s0; }
    const p = Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2);
    num += hz * p; den += p;
  }
  return den > 0 ? num / den : 0;
}

/**
 * The strongest frequency near an expected one — for the tom tuning check.
 *
 * Measured AFTER the pitch sweep, which is the first ~90 ms of every pitched
 * drum and is the whole reason a kick is a kick.  Including it averages the
 * fall into the answer: the first version of this read a 72 Hz floor tom as
 * 96 Hz and reported the kit 505 cents out of tune when it was not.
 */
function pitchNear(x: Float32Array, expectHz: number): number {
  let best = expectHz, bestP = -Infinity;
  const from = Math.round(SR * 0.12);
  const to = Math.min(x.length, Math.round(SR * 0.35));
  for (let cents = -900; cents <= 900; cents += 5) {
    const hz = expectHz * Math.pow(2, cents / 1200);
    const w = 2 * Math.PI * hz / SR, c = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (let i = from; i < to; i++) { const s0 = x[i]! + c * s1 - s2; s2 = s1; s1 = s0; }
    const p = s1 * s1 + s2 * s2 - c * s1 * s2;
    if (p > bestP) { bestP = p; best = hz; }
  }
  return best;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

async function main(): Promise<void> {
  // ── The table ────────────────────────────────────────────────────────────────

  await check('every slot the drum map names has a sound', () => {
    const missing = GM_DRUM_SLOTS
      .filter((slot) => DRUM_KIT[slot.pitch] === undefined)
      .map((slot) => `${slot.pitch} ${slot.name}`);
    // A map row with no kit entry falls back to a neighbour, which is the right
    // behaviour for a pitch nobody named — and the wrong one for a row the
    // editor is drawing, where it would silently play the drum next door.
    assert(missing.length === 0, `no sound for: ${missing.join(', ')}`);
  });

  await check('an unmapped pitch takes the nearest piece rather than silence', () => {
    // GM 60 is a bongo — not in this kit.  Answering it with nothing reads as
    // "the drums are broken" for a part that came from somewhere else.
    const spec = drumSpecFor(60);
    assert(spec.name === DRUM_KIT[59]!.name, spec.name);
    assert(drumSpecFor(200).name === DRUM_KIT[59]!.name, drumSpecFor(200).name);
    assert(drumSpecFor(0).name === DRUM_KIT[35]!.name, drumSpecFor(0).name);
  });

  await check('the noise is repeatable, and not a constant', () => {
    // The engine's contract is that a bounce sounds like the preview.
    // `Math.random()` here would break it and nothing downstream would notice.
    const a = noiseSamples(512, 1234);
    const b = noiseSamples(512, 1234);
    const c = noiseSamples(512, 5678);
    assert(a.every((v, i) => v === b[i]), 'the same seed gave different noise');
    assert(!a.every((v, i) => v === c[i]), 'two seeds gave the same noise');
    let sum = 0; for (const v of a) sum += v;
    assert(Math.abs(sum / a.length) < 0.1, `noise is biased: mean ${(sum / a.length).toFixed(3)}`);
    const rnd = mulberry32(7);
    const first = rnd();
    assert(first >= 0 && first < 1, `PRNG out of range: ${first}`);
  });

  // ── The sound ────────────────────────────────────────────────────────────────

  await check('a kick is low and a hat is high', async () => {
    const kick = await renderHit(36);
    const hat = await renderHit(42);
    assert(peak(kick) > 0.02, `the kick is inaudible (peak ${peak(kick).toFixed(4)})`);
    assert(peak(hat) > 0.005, `the hat is inaudible (peak ${peak(hat).toFixed(4)})`);
    const ck = centroid(kick), ch = centroid(hat);
    // If these two ever converge, the kit has stopped choosing a voice by pitch.
    assert(ck < 300, `kick centroid ${ck.toFixed(0)} Hz — not a kick`);
    assert(ch > 4000, `hat centroid ${ch.toFixed(0)} Hz — not a hat`);
    const lowKick = bandEnergy(kick, 40, 160) / Math.max(1e-12, bandEnergy(kick, 4000, 12000));
    assert(lowKick > 100, `kick is only ${lowKick.toFixed(1)}x low-heavy`);
  });

  await check('a closed hat stops and an open hat rings', async () => {
    const closed = decaySec(await renderHit(42));
    const open = decaySec(await renderHit(46));
    const pedal = decaySec(await renderHit(44));
    // This ratio IS the difference between the two hats — they are the same
    // noise through the same filter, and only the envelope tells them apart.
    assert(open > closed * 4, `open ${open.toFixed(3)}s vs closed ${closed.toFixed(3)}s`);
    assert(pedal > closed && pedal < open, `pedal ${pedal.toFixed(3)}s is not between the two`);
  });

  await check('a crash rings longer than a snare, and a snare than a hat', async () => {
    const crash = decaySec(await renderHit(49));
    const snare = decaySec(await renderHit(38));
    const hat = decaySec(await renderHit(42));
    assert(crash > snare, `crash ${crash.toFixed(2)}s vs snare ${snare.toFixed(2)}s`);
    assert(snare > hat, `snare ${snare.toFixed(2)}s vs hat ${hat.toFixed(2)}s`);
    assert(crash > 1.3, `a crash that dies in ${crash.toFixed(2)}s is a splash`);
  });

  await check('the toms rise in pitch in the order the kit lists them', async () => {
    const toms = [41, 43, 45, 47, 48, 50];
    const measured: number[] = [];
    for (const p of toms) measured.push(pitchNear(await renderHit(p), DRUM_KIT[p]!.hz));
    for (let i = 1; i < measured.length; i++) {
      assert(measured[i]! > measured[i - 1]!,
        `tom ${toms[i]} (${measured[i]!.toFixed(0)} Hz) is not above tom ${toms[i - 1]} (${measured[i - 1]!.toFixed(0)} Hz)`);
    }
    // And each one is close to what the table promises, not merely ordered.
    for (let i = 0; i < toms.length; i++) {
      const want = DRUM_KIT[toms[i]!]!.hz;
      const cents = Math.abs(1200 * Math.log2(measured[i]! / want));
      assert(cents < 120, `tom ${toms[i]} is ${cents.toFixed(0)} cents off ${want} Hz`);
    }
  });

  await check('a snare is not a small tom', async () => {
    const snare = await renderHit(38);
    const tom = await renderHit(47);
    // The wires are most of what a snare is; a tom has almost nothing up there.
    const snareHigh = bandEnergy(snare, 2000, 9000) / Math.max(1e-12, bandEnergy(snare, 80, 300));
    const tomHigh = bandEnergy(tom, 2000, 9000) / Math.max(1e-12, bandEnergy(tom, 80, 300));
    assert(snareHigh > tomHigh * 8,
      `snare/tom brightness ratio only ${(snareHigh / Math.max(1e-12, tomHigh)).toFixed(1)}x`);
  });

  await check('the kit is not mono in the middle', async () => {
    // A kit panned nowhere sounds like a drum machine even when every piece is
    // right.  Hats sit left of a right-handed drummer, the ride to the right.
    const hat = await renderStereo(42);
    const ride = await renderStereo(51);
    const hatBias = rms(hat.l) / Math.max(1e-12, rms(hat.r));
    const rideBias = rms(ride.r) / Math.max(1e-12, rms(ride.l));
    assert(hatBias > 1.2, `hat is centred (L/R ${hatBias.toFixed(2)})`);
    assert(rideBias > 1.2, `ride is centred (R/L ${rideBias.toFixed(2)})`);
    const kick = await renderStereo(36);
    const kickBias = rms(kick.l) / Math.max(1e-12, rms(kick.r));
    assert(Math.abs(kickBias - 1) < 0.05, `the kick is off centre (L/R ${kickBias.toFixed(2)})`);
  });

  await check('velocity is dynamics, not a trim', async () => {
    const soft = peak(await renderHit(38, 0.2));
    const hard = peak(await renderHit(38, 1.0));
    assert(hard > soft * 3, `a ghost note is only ${(hard / Math.max(1e-9, soft)).toFixed(1)}x below a hit`);
    assert(soft > 0.001, 'a soft hit is inaudible');
  });

  await check('the same hit twice is the same sound', async () => {
    // The whole reason the noise is seeded.  Two renders of the same note must
    // be bit-identical, or a bounce does not match the preview it was approved
    // from and nothing in the app would report the difference.
    const a = await renderHit(42);
    const b = await renderHit(42);
    let worst = 0;
    for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
    assert(worst === 0, `two renders differ by ${worst.toExponential(2)}`);
  });

  await check('two hits in a row are not the same sound', async () => {
    // Seeded from the note, so a repeated hat on the next beat draws different
    // noise — a hat pattern of one identical sample is a machine gun.
    const kit = findInstrument('drumkit')!;
    const ctx = new OfflineAudioContext(2, Math.round(SR * 1.5), SR);
    const params = defaultInstrumentParams('drumkit');
    for (const [i, beat] of [0, 1].entries()) {
      kit.playNote({
        ctx: ctx as unknown as BaseAudioContext,
        destination: ctx.destination as unknown as AudioNode,
        note: createNote({ pitch: 42, velocity: 0.9, startBeat: beat, durationBeat: 0.5 }),
        config: DEFAULT_MIDI_CONFIG, when: i * 0.5, durationSec: 0.25, params,
      });
    }
    const buf = await ctx.startRendering();
    const x = Float32Array.from(buf.getChannelData(0));
    const first = x.slice(0, Math.round(SR * 0.04));
    const second = x.slice(Math.round(SR * 0.5), Math.round(SR * 0.54));
    let same = 0;
    for (let i = 0; i < first.length; i++) if (first[i] === second[i]) same++;
    assert(same < first.length * 0.9, 'the second hat is a copy of the first');
  });

  await check('decay and tune reach the sound', async () => {
    const normal = decaySec(await renderHit(46));
    const shorter = decaySec(await renderHit(46, 0.9, 2.5, { decay: 0.3 }));
    assert(shorter < normal * 0.6, `decay 0.3 gave ${shorter.toFixed(3)}s against ${normal.toFixed(3)}s`);
    const base = pitchNear(await renderHit(45), DRUM_KIT[45]!.hz);
    const up = pitchNear(await renderHit(45, 0.9, 2.5, { tune: 12 }), DRUM_KIT[45]!.hz * 2);
    const ratio = up / base;
    assert(Math.abs(ratio - 2) < 0.15, `+12 st moved the tom by ${ratio.toFixed(2)}x, not 2x`);
  });

  // ── Reachability ─────────────────────────────────────────────────────────────

  await check('adding a kit brings its drum map with it', () => {
    // Checked by BUILDING a session, not by grepping the panel for the call.
    // The grep version passed a break that removed the assignment from the
    // add path, because the same call still appeared elsewhere in the file —
    // and a drum track with no map opens onto a wall of anonymous numbers.
    const kitTrack = createTrack('Drum Kit 1', 'instrument', { instrumentId: 'drumkit' });
    const withKit = addInstrumentSlot(createSession('x'), kitTrack,
      createMidiPart('Drum Kit 1 1', { startSec: 0, durationSec: 8 }));
    const map = drumMapFor(withKit, findTrack(withKit, kitTrack.id));
    assert(map !== null, 'a new drum track has no kit map');
    assert(map!.slots.length > 10, `the map has only ${map?.slots.length} rows`);
    assert(trackClips(findTrack(withKit, kitTrack.id)!).length === 1, 'the part did not arrive');

    // And a synth must NOT get one — a drum map on a piano renames its keys.
    const synth = createTrack('Poly Synth 1', 'instrument', { instrumentId: 'polysynth' });
    const withSynth = addInstrumentSlot(createSession('x'), synth,
      createMidiPart('p', { startSec: 0, durationSec: 8 }));
    assert(drumMapFor(withSynth, findTrack(withSynth, synth.id)) === null,
      'a poly synth was given a drum map');

    const engine = stripComments(
      readFileSync(new URL('../src/renderer/daw/engine/instruments.ts', import.meta.url), 'utf8'));
    assert(/id: 'drumkit'/.test(engine), 'the drum kit is not registered as an instrument');
  });

  await check('a kick is a beater arriving, not a low sine', async () => {
    // The pitch sweep IS the drum: held at its fundamental the same
    // oscillator is a bass note.  Two earlier versions of this check missed a
    // break that deleted the sweep — a zero-crossing rate over the first
    // 12 ms measures the ATTACK TRANSIENT (and, with the click on, the click),
    // not the pitch.  What a sweep actually means is energy well above the
    // fundamental while it is still falling, so that is what is measured.
    //
    // `snap: 0` also removes the beater click, which is highpassed noise and
    // would supply that energy whether the tone swept or not.
    const head = (x: Float32Array): Float32Array => x.slice(0, Math.round(SR * 0.025));
    const kick = head(await renderHit(36, 0.9, 2.5, { snap: 0 }));
    // 55 Hz fundamental, sweeping in from 55 × 4.2 = 231 Hz.
    const kickRatio = bandEnergy(kick, 150, 400) / Math.max(1e-12, bandEnergy(kick, 40, 80));
    assert(kickRatio > 0.05,
      `the kick has no energy above its fundamental (${kickRatio.toExponential(1)}) — no sweep`);

    const tom = head(await renderHit(45, 0.9, 2.5, { snap: 0 }));
    // 105 Hz fundamental, sweeping in from 105 × 1.6 = 168 Hz.
    const tomRatio = bandEnergy(tom, 200, 500) / Math.max(1e-12, bandEnergy(tom, 60, 130));
    assert(tomRatio > 0.01,
      `the tom does not sweep (${tomRatio.toExponential(1)})`);
  });

  await check('nothing here turns a drum note into a frequency', () => {
    const engine = stripComments(
      readFileSync(new URL('../src/renderer/daw/engine/instruments.ts', import.meta.url), 'utf8'));
    const at = engine.indexOf('function drumVoice');
    assert(at > 0, 'drumVoice is gone');
    const body = engine.slice(at, engine.indexOf('\n}\n', at));
    assert(!/pitchToFrequency/.test(body),
      'the kit calls pitchToFrequency — pitch chooses the PIECE, not the note');
    // `drumSpecIn` since the genre kits landed — same claim, one more
    // argument: which kit, then which piece.
    assert(/drumSpecIn\(/.test(body), 'the kit does not look the piece up by pitch');
    assert(/kitGenreOf\(/.test(body), 'the kit does not read which kit is loaded');
  });

  await check('the kit covers a real part, end to end', async () => {
    // Every pitch the kit names, played once: nothing silent, nothing clipping.
    const silent: number[] = [];
    const loud: number[] = [];
    for (const p of kitPitches()) {
      const x = await renderHit(p);
      const v = peak(x);
      if (v < 0.004) silent.push(p);
      if (v > 1.0) loud.push(p);
    }
    assert(silent.length === 0, `silent pieces: ${silent.join(', ')}`);
    assert(loud.length === 0, `clipping pieces: ${loud.join(', ')}`);
  });

  console.log('\n=== Drum kit — pitch chooses the piece ===');
  for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  const bad = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
  if (bad) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
