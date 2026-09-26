/**
 * plucked-selftest — five instruments out of one string, or one instrument
 * under five names?
 *
 * The string family had bowed strings and three guitars, and no harp, mandolin,
 * ukulele, banjo or koto.  They are built here as one instrument over a table,
 * the way the bowed family is four boxes over one bow, and the risk of doing it
 * that way is exactly the thing to measure: a table makes it easy to ship five
 * names for one sound.
 *
 * So nothing here checks that a body "loads".  Every check asks whether the
 * numbers in the table reach the audio, and whether what comes out differs in
 * the way the instrument differs:
 *
 *   · a banjo's note is over while a harp's has barely started
 *   · a mandolin's paired courses beat, and one string cannot
 *   · where the string is caught is a comb, not a tone control
 *   · and the trims move each body inside ITS own range, so one patch reads
 *     the same way on all five
 *
 * Run:  pnpm --filter @aimaster/desktop test:plucked
 */

import { OfflineAudioContext } from 'node-web-audio-api';
(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import {
  PLUCK_KINDS, findInstrument, defaultInstrumentParams,
} from '../src/renderer/daw/engine/instruments.js';
import { createNote, DEFAULT_MIDI_CONFIG } from '../src/renderer/daw/model/midi.js';
import { patchesFor } from '../src/renderer/daw/engine/instrument-patches.js';

const SR = 48_000;
const results: { name: string; pass: boolean; detail: string }[] = [];
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

const db = (x: number): number => 20 * Math.log10(Math.max(1e-12, x));

/**
 * One note, held.
 *
 * `dur` defaults to most of the buffer on purpose.  `pluckVoice`'s envelope
 * closes at `durationSec + release` — a plucked string here decays from the
 * moment it is hit and the envelope only ends it cleanly — so a short note
 * measures the ENVELOPE and not the string.  Asked for 0.6 s notes, every one
 * of the five bodies "rang" for 0.70 s, which is the envelope to the sample.
 */
async function play(
  over: Record<string, number>, pitch = 52, seconds = 7, vel = 0.85,
  dur = seconds - 0.5,
): Promise<Float32Array> {
  const inst = findInstrument('plucked')!;
  const params = { ...defaultInstrumentParams('plucked'), ...over };
  const ctx = new OfflineAudioContext(2, Math.round(SR * seconds), SR);
  inst.playNote({
    ctx: ctx as never, destination: ctx.destination as never,
    note: createNote({ pitch, velocity: vel, startBeat: 0, durationBeat: 1 }) as never,
    config: DEFAULT_MIDI_CONFIG as never, when: 0, durationSec: dur, params,
  });
  const buf = await ctx.startRendering();
  const l = buf.getChannelData(0);
  const r = buf.getChannelData(1);
  const mono = new Float32Array(buf.length);
  for (let i = 0; i < mono.length; i++) mono[i] = ((l[i] ?? 0) + (r[i] ?? 0)) / 2;
  return mono;
}

function rms(a: Float32Array, t0: number, t1: number): number {
  let s = 0;
  let n = 0;
  for (let i = Math.round(t0 * SR); i < Math.min(a.length, Math.round(t1 * SR)); i++) {
    s += (a[i] ?? 0) ** 2; n++;
  }
  return Math.sqrt(s / Math.max(1, n));
}

/** How long until the note has fallen 40 dB below its own start. */
function decaySec(a: Float32Array): number {
  const start = rms(a, 0.02, 0.09);
  if (!(start > 0)) return 0;
  for (let t = 0.1; t < 6.5; t += 0.05) {
    if (rms(a, t, t + 0.05) < start * 0.01) return t;
  }
  return 6.5;
}

function magAt(a: Float32Array, f: number, t0: number, dur: number): number {
  const from = Math.round(t0 * SR);
  const n = Math.min(a.length - from, Math.round(dur * SR));
  if (n < 64) return 0;
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    const ph = 2 * Math.PI * f * i / SR;
    re += (a[from + i] ?? 0) * w * Math.cos(ph);
    im += (a[from + i] ?? 0) * w * Math.sin(ph);
  }
  return Math.hypot(re, im) / n * 4;
}

const hz = (pitch: number): number => 440 * Math.pow(2, (pitch - 69) / 12);

async function main(): Promise<void> {
  console.log('\n=== PLUCKED STRINGS — five bodies, one string ===\n');

  await check('the table is five instruments, not five labels', async () => {
    // How long each one rings, which is the single most audible difference
    // between a banjo and a harp and the first thing a shared engine loses.
    const decays = new Map<string, number>();
    for (let k = 0; k < PLUCK_KINDS.length; k++) {
      decays.set(PLUCK_KINDS[k]!.name, decaySec(await play({ kind: k })));
    }
    const harp = decays.get('Harp')!;
    const banjo = decays.get('Banjo')!;
    assert(harp > banjo * 2.5,
      `a harp rings ${harp.toFixed(2)} s and a banjo ${banjo.toFixed(2)} s — a banjo's head throws `
      + 'the energy out, and if those are close the table is not reaching the string');
    // And every one of them is somewhere different, in order.
    const sorted = [...decays.entries()].sort((a, b) => a[1] - b[1]);
    assert(sorted[0]![0] === 'Banjo' && sorted[sorted.length - 1]![0] === 'Harp',
      `shortest to longest came out ${sorted.map(([n, v]) => `${n} ${v.toFixed(2)}`).join(', ')}`);
  });

  await check('and it is the STRING that differs, not only how long it is allowed to ring', async () => {
    // Found by breaking the engine: replacing every body's loop gain with one
    // constant left the check above green, because how long a note lasts here
    // is set by `ring` — the buffer's length — and `ring` was still the table's.
    // A body could have had the wrong damping from the start and nothing would
    // have said so.
    //
    // So this measures the decay RATE, in dB per second, over a window well
    // inside a note that every body is allowed to hold.  That rate is the loop
    // gain and nothing else.
    const rate = async (kind: number): Promise<number> => {
      const a = await play({ kind, ringTrim: 1 }, 52, 7);
      const early = db(rms(a, 0.25, 0.45));
      const late = db(rms(a, 0.95, 1.15));
      return (early - late) / 0.7;
    };
    const rates = new Map<string, number>();
    for (let k = 0; k < PLUCK_KINDS.length; k++) {
      rates.set(PLUCK_KINDS[k]!.name, await rate(k));
    }
    const harp = rates.get('Harp')!;
    const banjo = rates.get('Banjo')!;
    assert(banjo > harp * 2,
      `a banjo's string loses ${banjo.toFixed(1)} dB/s and a harp's ${harp.toFixed(1)} — those are `
      + 'the loop gains, and if they are close the table is not reaching the string itself');
    // Every body's rate its own, not two pairs sharing.
    const values = [...rates.values()].sort((a, b) => a - b);
    for (let i = 1; i < values.length; i++) {
      assert(values[i]! - values[i - 1]! > 0.3,
        `two bodies lose their energy at the same rate — ${[...rates.entries()]
          .map(([n, v]) => `${n} ${v.toFixed(1)}`).join(', ')}`);
    }
  });

  await check('paired courses beat, and one string cannot', async () => {
    // A mandolin's two strings per note are a thing no EQ imitates: two
    // slightly different pitches sum to an amplitude that moves.  Measured as
    // the wobble in the envelope after the attack is over.
    const swing = async (over: Record<string, number>): Promise<number> => {
      const a = await play(over, 55, 4);
      const env: number[] = [];
      for (let t = 0.4; t < 1.8; t += 0.02) env.push(rms(a, t, t + 0.02));
      let mean = 0;
      for (const v of env) mean += v;
      mean /= env.length;
      if (!(mean > 0)) return 0;
      // Deviation from a smooth decay: compare each point with the average of
      // its neighbours, so the decay itself does not read as wobble.
      let wobble = 0;
      for (let i = 1; i < env.length - 1; i++) {
        const smooth = ((env[i - 1] ?? 0) + (env[i + 1] ?? 0)) / 2;
        wobble += Math.abs((env[i] ?? 0) - smooth);
      }
      return wobble / (env.length * mean);
    };
    // Both on the mandolin: comparing a paired mandolin with an unpaired HARP
    // would be comparing two bodies, and the harp's longer decay alone moves
    // the number.  The only difference here is the second string.
    const single = await swing({ kind: 1, doubleTrim: -1 });
    const paired = await swing({ kind: 1, doubleTrim: 1 });
    assert(paired > single * 1.5,
      `a paired course wobbles ${paired.toFixed(4)} against a single string's ${single.toFixed(4)} — `
      + 'two strings beating is the whole point of a course');
  });

  await check('where the string is caught is a comb, not a tone control', async () => {
    // A pluck cancels the partials with a node at the pick point.  At a third
    // of the string that is the third harmonic, and a tone control cannot do
    // it because it does not know where the string was touched.
    const pitch = 52;
    const f = hz(pitch);
    const near = await play({ kind: 0, pickTrim: -1 }, pitch, 4);
    const third = await play({ kind: 0, pickTrim: 1 }, pitch, 4);
    const ratio = (a: Float32Array): number =>
      db(magAt(a, f * 3, 0.15, 0.6)) - db(magAt(a, f, 0.15, 0.6));
    const nearR = ratio(near);
    const farR = ratio(third);
    assert(Math.abs(nearR - farR) > 4,
      `the third harmonic sits at ${nearR.toFixed(1)} dB plucked near the bridge and `
      + `${farR.toFixed(1)} dB plucked away from it — a comb should move it much further`);
  });

  await check('the trims move each body inside its own range', async () => {
    // An absolute Damping knob would mean one number across five loop gains
    // running 0.9905 to 0.9994 — and 0.99 is a banjo's whole note and a harp's
    // first tenth.  So a trim of +1 has to lengthen EVERY body and −1 shorten
    // every body, or the same patch means different things on different ones.
    const bad: string[] = [];
    for (let k = 0; k < PLUCK_KINDS.length; k++) {
      const shortRing = decaySec(await play({ kind: k, dampTrim: -1, ringTrim: -1 }));
      const longRing = decaySec(await play({ kind: k, dampTrim: 1, ringTrim: 1 }));
      if (!(longRing > shortRing * 1.3)) {
        bad.push(`${PLUCK_KINDS[k]!.name}: ${shortRing.toFixed(2)} s at −1 and `
          + `${longRing.toFixed(2)} s at +1`);
      }
    }
    assert(bad.length === 0, `a trim did not move the body it was applied to — ${bad.join('; ')}`);
  });

  await check('velocity is the release corner, not a volume knob', async () => {
    // The same rule the guitars follow: a string displaced further leaves a
    // sharper corner, and a sharper corner is more high partials.  Normalised
    // for level, a soft note and a hard one have to differ in SHAPE.
    //
    // Measured HIGH, and that took a wrong answer first.  The corner is the
    // excitation's one-pole, which at a soft velocity sits near 3 kHz and at a
    // hard one near 13 kHz — so the fifth partial of a low E, at 824 Hz, is far
    // below both and moved 0.3 dB.  The difference is above 3 kHz, which is
    // where the two corners are, and asking about it anywhere else is asking
    // the wrong question rather than getting a wrong answer.
    const pitch = 52;
    const f = hz(pitch);
    const highOverFundamental = async (vel: number): Promise<number> => {
      const a = await play({ kind: 0 }, pitch, 4, vel);
      let high = 0;
      // Every partial of this note that lands between 3 and 8 kHz.
      for (let k = Math.ceil(3000 / f); k * f < 8000; k++) {
        high += magAt(a, f * k, 0.005, 0.08) ** 2;
      }
      return db(Math.sqrt(high)) - db(magAt(a, f, 0.005, 0.08));
    };
    const soft = await highOverFundamental(0.2);
    const hard = await highOverFundamental(1);
    // 3 dB, against 4.8 measured over a five-to-one velocity range.  The bound
    // is set from what the mechanism gives rather than from what would be
    // impressive: a velocity that had become a fader would read near zero here,
    // which is what this is for.
    assert(hard - soft > 3,
      `the 3–8 kHz partials are ${(hard - soft).toFixed(1)} dB stronger played hard, relative to the `
      + 'fundamental — if that is near zero then velocity is only a fader');
  });

  await check('the body table is what the patches reach, and it is not overridable', async () => {
    // The trap this design has: `pluckVoice` resolves every body control as
    // `params[id] ?? tuning.id`, so a PARAMETER with a default always wins over
    // the table.  If `bodyHz` and friends were exposed here, picking a banjo
    // would change its name and nothing else.
    const inst = findInstrument('plucked')!;
    const exposed = new Set(inst.params.map((q) => q.id));
    for (const owned of ['bodyHz', 'bodyQ', 'body', 'plate', 'tone']) {
      assert(!exposed.has(owned),
        `'${owned}' is a parameter of the plucked instrument, so its default overrides the body `
        + 'table and the instrument selector stops selecting an instrument');
    }
    // And the selector must not be called `body`, which `pluckVoice` reads as
    // the body resonance's gain in decibels.
    assert(exposed.has('kind'),
      'the selector should be `kind`; `body` is read as a gain in dB and would silently not select');
  });

  await check('every patch names a control the instrument has', async () => {
    const inst = findInstrument('plucked')!;
    const ids = new Set(inst.params.map((q) => q.id));
    const bad: string[] = [];
    for (const patch of patchesFor('plucked')) {
      for (const [k, v] of Object.entries(patch.params)) {
        if (!ids.has(k)) { bad.push(`${patch.id}: no such control '${k}'`); continue; }
        const def = inst.params.find((q) => q.id === k)!;
        if (v < def.min || v > def.max) {
          bad.push(`${patch.id}: ${k}=${v} outside ${def.min}…${def.max}`);
        }
      }
    }
    assert(bad.length === 0, bad.join('; '));
  });

  await check('a selector parameter is offered as a list', async () => {
    // Not cosmetic.  Every instrument parameter used to be drawn as a slider
    // with a number, so the reed family's five pipes read as 0.000 to 4.000 and
    // choosing a bass clarinet meant knowing it was 1.
    const inst = findInstrument('plucked')!;
    const kind = inst.params.find((q) => q.id === 'kind')!;
    assert(kind.choices !== undefined && kind.choices.length === PLUCK_KINDS.length,
      `the selector offers ${String(kind.choices?.length)} names for ${PLUCK_KINDS.length} bodies`);
    assert(kind.choiceNotes !== undefined && kind.choiceNotes.length === PLUCK_KINDS.length,
      'every body should say in one line what it is');
    assert(kind.max === PLUCK_KINDS.length - 1,
      `the selector's range stops at ${kind.max} for ${PLUCK_KINDS.length} bodies`);
  });

  await check('the same note renders identically, and two notes do not', async () => {
    const a = await play({ kind: 1 }, 55, 3);
    const b = await play({ kind: 1 }, 55, 3);
    let worst = 0;
    for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
    assert(worst === 0, `two renders of one note differ by ${worst.toExponential(2)}`);
    const c = await play({ kind: 1 }, 57, 3);
    let same = true;
    for (let i = 4000; i < 9000; i++) if ((a[i] ?? 0) !== (c[i] ?? 0)) { same = false; break; }
    assert(!same, 'two different pitches rendered the same samples');
  });

  let failed = 0;
  for (const r of results) {
    if (!r.pass) failed++;
    console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.pass ? '' : ` — ${r.detail}`}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
  if (failed) process.exit(1);
}
void main();
