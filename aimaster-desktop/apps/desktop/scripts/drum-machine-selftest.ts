/**
 * drum-machine-selftest.ts — whether the analogue drum machine is one.
 *
 * Two drum instruments live in this engine and the checks here are about the
 * difference.  `drum-model.ts` is a KIT — eleven genre variants of a drum set
 * with six controls for the whole thing.  This one is a MACHINE: eleven
 * voices built the way the circuits were, each with the controls that voice
 * actually has.  So what has to be proved is not "it makes drum noises" but
 * that each voice is the circuit it claims to be:
 *
 *   · the kick's frequency FALLS during the note, and the Bend knob sets how far
 *   · the hats have a PITCH, because they are six squares and no noise at all
 *   · the snare's Tone knob moves energy between two heads and a band of noise
 *   · the clap is four bursts, and Spread moves them apart
 *
 * And the last check sweeps every parameter the descriptor declares and
 * insists the engine reads it — a knob that does nothing is worse than a
 * missing one.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:drum-machine
 */

import {
  DRUM_MAP, DRUM_VOICES, DRUM_VOICE_NAMES, METAL_RATIOS, drumTail, drumVoiceFor,
  renderDrumVoice, type DrumVoice,
} from '../src/renderer/daw/engine/drum-machine.js';
import { defaultInstrumentParams, findInstrument } from '../src/renderer/daw/engine/instruments.js';

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true }); } catch (err) {
    results.push({ name, pass: false, detail: (err as Error).message });
  }
}

const SR = 48000;
const BASE = defaultInstrumentParams('drummachine');

function hit(voice: DrumVoice, over: Record<string, number> = {}, vel = 0.9, seed = 1234) {
  const params = { ...BASE, ...over };
  return renderDrumVoice({
    sampleRate: SR, seconds: drumTail(voice, params), voice, velocity: vel, seed, params,
  });
}

function mono(r: { left: Float32Array; right: Float32Array }): Float32Array {
  const out = new Float32Array(r.left.length);
  for (let i = 0; i < out.length; i++) out[i] = ((r.left[i] ?? 0) + (r.right[i] ?? 0)) / 2;
  return out;
}

function rms(buf: Float32Array, from = 0, len = buf.length): number {
  const n = Math.min(len, buf.length - from);
  let s = 0;
  for (let i = 0; i < n; i++) s += (buf[from + i] ?? 0) ** 2;
  return Math.sqrt(s / Math.max(1, n));
}

/** Goertzel: the amplitude of one frequency in a window. */
function tone(buf: Float32Array, hz: number, from: number, len: number): number {
  const n = Math.min(len, buf.length - from);
  if (n < 16) return 0;
  const w = (2 * Math.PI * hz) / SR;
  const c = 2 * Math.cos(w);
  let s1 = 0; let s2 = 0;
  for (let i = 0; i < n; i++) {
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const s0 = (buf[from + i] ?? 0) * win + c * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return Math.hypot(s1 - s2 * Math.cos(w), s2 * Math.sin(w)) / n;
}

/**
 * The dominant frequency in a window, by counting zero crossings.
 *
 * Crude and exactly right for the job: the kick and the toms are one sine at
 * a time, so crossings per second is their pitch, and it works while that
 * pitch is CHANGING where a transform would smear it into a band.
 */
function zeroCrossingHz(buf: Float32Array, from: number, len: number): number {
  const n = Math.min(len, buf.length - from);
  let crossings = 0;
  let prev = buf[from] ?? 0;
  for (let i = 1; i < n; i++) {
    const v = buf[from + i] ?? 0;
    if ((prev < 0 && v >= 0) || (prev >= 0 && v < 0)) crossings++;
    prev = v;
  }
  return (crossings * SR) / (2 * n);
}

// ── The map ─────────────────────────────────────────────────────────────────

check('every General MIDI drum note lands on a voice, and the nearest one', () => {
  for (const key of Object.keys(DRUM_MAP)) {
    const v = DRUM_MAP[Number(key)]!;
    assert(DRUM_VOICES.includes(v), `pitch ${key} maps to ${v}, which is not a voice`);
  }
  // The General MIDI drum range, 35 to 81, has to answer.
  for (let p = 35; p <= 81; p++) {
    const v = drumVoiceFor(p);
    assert(DRUM_VOICES.includes(v), `pitch ${p} answers with ${v}`);
  }
  assert(drumVoiceFor(36) === 'bd', 'note 36 is not the kick');
  assert(drumVoiceFor(38) === 'sd', 'note 38 is not the snare');
  assert(drumVoiceFor(42) === 'ch', 'note 42 is not the closed hat');
  assert(drumVoiceFor(46) === 'oh', 'note 46 is not the open hat');
  assert(drumVoiceFor(49) === 'cy', 'note 49 is not the cymbal');
  // Off the end, the nearest mapped note rather than silence.
  assert(drumVoiceFor(20) === DRUM_MAP[35], 'a note below the map does not take the nearest');
  assert(drumVoiceFor(200) === DRUM_MAP[77], 'a note above the map does not take the nearest');
  // And every voice is reachable from some note — one that is not is a page
  // of knobs nothing can play.
  const reachable = new Set(Object.values(DRUM_MAP));
  for (const v of DRUM_VOICES) {
    assert(reachable.has(v), `${DRUM_VOICE_NAMES[v]} cannot be played by any note`);
  }
});

// ── The voices ──────────────────────────────────────────────────────────────

check('every voice makes a sound, ends quietly, and stays inside the rails', () => {
  for (const v of DRUM_VOICES) {
    const r = hit(v);
    let peak = 0;
    for (let i = 0; i < r.left.length; i++) {
      const l = r.left[i] ?? 0;
      const q = r.right[i] ?? 0;
      assert(Number.isFinite(l) && Number.isFinite(q), `${v} produced a non-finite sample at ${i}`);
      peak = Math.max(peak, Math.abs(l), Math.abs(q));
    }
    assert(peak > 0.05, `${DRUM_VOICE_NAMES[v]} is silent (peak ${peak.toExponential(2)})`);
    assert(peak < 2, `${DRUM_VOICE_NAMES[v]} peaks at ${peak.toFixed(2)} before the trim`);
    // The buffer has to end quiet, or every hit ends in a click.  60 dB down
    // from the hit is what `drumTail` promises.
    const m = mono(r);
    const head = rms(m, 0, Math.round(SR * 0.01));
    const tail = rms(m, m.length - Math.round(SR * 0.004));
    assert(tail < head * 0.02 || tail < 1e-4,
      `${DRUM_VOICE_NAMES[v]} ends at ${(20 * Math.log10(tail / Math.max(1e-12, head))).toFixed(1)} dB below its attack`);
  }
});

check('every voice is finite at every rate this engine renders at', () => {
  // Found by the panel, not by this file: the panel's preview renders at
  // 22 kHz to be cheap, and there the hats' band-pass coefficient came out at
  // 1.92 — past where this filter topology is stable — and every sample was
  // `Infinity`.  Sessions run at 44.1 and 48 kHz where the same call gives
  // 1.11, so nothing in the app would ever have shown it, and a bounce at a
  // low rate would have written infinities into a file.
  for (const rate of [16000, 22050, 32000, 44100, 48000, 96000]) {
    for (const v of DRUM_VOICES) {
      const params = { ...BASE };
      const r = renderDrumVoice({
        sampleRate: rate, seconds: drumTail(v, params), voice: v, velocity: 0.9, seed: 3, params,
      });
      let peak = 0;
      for (let i = 0; i < r.left.length; i++) {
        const l = r.left[i] ?? 0;
        assert(Number.isFinite(l), `${DRUM_VOICE_NAMES[v]} produced ${l} at ${rate} Hz, sample ${i}`);
        peak = Math.max(peak, Math.abs(l));
      }
      assert(peak > 0.02 && peak < 2.5,
        `${DRUM_VOICE_NAMES[v]} peaks at ${peak.toFixed(2)} at ${rate} Hz`);
    }
  }
});

check('the voices are balanced against each other, and the kick is the loudest', () => {
  const level = new Map<DrumVoice, number>();
  for (const v of DRUM_VOICES) {
    level.set(v, 20 * Math.log10(Math.max(1e-9, rms(mono(hit(v))))));
  }
  const bd = level.get('bd')!;
  for (const v of DRUM_VOICES) {
    const rel = level.get(v)! - bd;
    assert(rel <= 0.5, `${DRUM_VOICE_NAMES[v]} is ${rel.toFixed(1)} dB above the kick`);
    assert(rel > -20, `${DRUM_VOICE_NAMES[v]} is ${rel.toFixed(1)} dB below the kick — inaudible in a mix`);
  }
  // And they must not all be the same, or the level knobs are decoration.
  const values = [...level.values()];
  const spread = Math.max(...values) - Math.min(...values);
  assert(spread > 6, `the whole machine spans ${spread.toFixed(1)} dB — every voice is the same loudness`);
});

check('the kick falls in pitch, and Bend says how far', () => {
  // The thing that makes it an 808 kick rather than a sine with an envelope.
  const m = mono(hit('bd'));
  const early = zeroCrossingHz(m, Math.round(SR * 0.002), Math.round(SR * 0.012));
  const late = zeroCrossingHz(m, Math.round(SR * 0.15), Math.round(SR * 0.2));
  assert(early > late * 1.8,
    `the kick starts at ${early.toFixed(0)} Hz and settles at ${late.toFixed(0)} — it barely falls`);
  assert(Math.abs(late - BASE['bdtune']!) / BASE['bdtune']! < 0.25,
    `the kick settles at ${late.toFixed(0)} Hz, not near its tuning of ${BASE['bdtune']}`);

  const flat = mono(hit('bd', { bdbend: 0 }));
  const flatEarly = zeroCrossingHz(flat, Math.round(SR * 0.002), Math.round(SR * 0.012));
  assert(flatEarly < early * 0.75,
    `at Bend 0 the kick still starts at ${flatEarly.toFixed(0)} Hz against ${early.toFixed(0)} with bend`);

  // Tune moves where it lands.
  const high = mono(hit('bd', { bdtune: 90 }));
  const highLate = zeroCrossingHz(high, Math.round(SR * 0.15), Math.round(SR * 0.2));
  assert(highLate > late * 1.4, `the Tune knob moved the kick ${late.toFixed(0)} → ${highLate.toFixed(0)} Hz only`);
});

check('the hats have a pitch, because they are squares and not noise', () => {
  // Six inharmonic squares through a high-pass.  The first version of this
  // check compared one partial against the gap beside it and PASSED when the
  // source was replaced with noise — two nearby points in a band-passed hiss
  // differ by more than a factor of 1.5 often enough for that to be luck.
  //
  // So the claim is made about the whole band instead.  A spectrum of
  // discrete partials has a loudest point far above its median; a band of
  // noise does not.  Measured: 83 with the squares, 7.1 with noise in their
  // place.  And the loudest partial MOVES with the tuning — exactly 1.500×
  // for a 1.5× tune with the squares, and 1.000× with noise, because noise
  // has nothing to move.
  const scan = (over: Record<string, number>): { ratio: number; peakHz: number } => {
    const m = mono(hit('ch', { chdec: 0.25, ...over }));
    const from = Math.round(SR * 0.004);
    const len = Math.round(SR * 0.12);
    const vals: Array<{ hz: number; v: number }> = [];
    for (let k = 0; k < 400; k++) {
      const hz = 3000 * Math.pow(14000 / 3000, k / 399);
      vals.push({ hz, v: tone(m, hz, from, len) });
    }
    const sorted = [...vals].sort((a, b) => a.v - b.v);
    const median = sorted[Math.floor(sorted.length / 2)]?.v ?? 0;
    const top = sorted[sorted.length - 1]!;
    return { ratio: top.v / Math.max(1e-12, median), peakHz: top.hz };
  };
  const base = scan({});
  assert(base.ratio > 25,
    `the loudest point is only ${base.ratio.toFixed(1)}× the median of the band — this is noise, not partials`);

  const tuned = scan({ chtune: (BASE['chtune'] ?? 540) * 1.5 });
  const moved = tuned.peakHz / base.peakHz;
  assert(Math.abs(moved - 1.5) < 0.05,
    `tuning the hat up by half moved its loudest partial ${moved.toFixed(3)}× — the source is not the six squares`);
});

check('the metal ratios are mutually inharmonic', () => {
  // Not decoration: a set of harmonic ratios sums to a chord and a set of
  // near-equal ones sums to a beating tone.  Metal is the absence of any
  // period the ear can find.
  assert(METAL_RATIOS.length === 6, `there are ${METAL_RATIOS.length} ratios, not six`);
  assert(METAL_RATIOS[0] === 1, 'the first ratio is not the fundamental');
  for (let i = 0; i < METAL_RATIOS.length; i++) {
    for (let j = i + 1; j < METAL_RATIOS.length; j++) {
      const r = (METAL_RATIOS[j] ?? 1) / (METAL_RATIOS[i] ?? 1);
      assert(r > 1.18, `ratios ${i} and ${j} are ${r.toFixed(3)} apart — they will beat, not clash`);
      // No small whole-number relationship, which is what would make a chord.
      for (let n = 1; n <= 4; n++) {
        for (let d = 1; d <= 4; d++) {
          if (n === d) continue;
          assert(Math.abs(r - n / d) > 0.045,
            `ratios ${i} and ${j} are ${n}/${d} apart — that is a harmonic interval`);
        }
      }
    }
  }
});

check('the snare\'s Tone knob moves energy between the heads and the snares', () => {
  const headsOnly = mono(hit('sd', { sdtone: 0 }));
  const noiseOnly = mono(hit('sd', { sdtone: 1 }));
  const from = Math.round(SR * 0.004);
  const len = Math.round(SR * 0.09);
  const f0 = BASE['sdtune']!;
  // At Tone 0 the fundamental is there; at Tone 1 it is not.
  const drumAt0 = tone(headsOnly, f0, from, len);
  const drumAt1 = tone(noiseOnly, f0, from, len);
  assert(drumAt0 > drumAt1 * 3,
    `the head reads ${drumAt0.toExponential(2)} at Tone 0 and ${drumAt1.toExponential(2)} at Tone 1`);
  // And the high band is the other way round.
  const hiss0 = tone(headsOnly, 3200, from, len);
  const hiss1 = tone(noiseOnly, 3200, from, len);
  assert(hiss1 > hiss0 * 3,
    `the snares read ${hiss0.toExponential(2)} at Tone 0 and ${hiss1.toExponential(2)} at Tone 1`);

  // Snappy silences the noise without silencing the drum.
  const dry = mono(hit('sd', { sdsnappy: 0 }));
  assert(tone(dry, 3200, from, len) < hiss1 * 0.3, 'Snappy at 0 still passes the snares');
  assert(rms(dry, from, len) > 0.01, 'Snappy at 0 silenced the whole snare');
});

check('the clap is four bursts, and Spread moves them apart', () => {
  // With the tail turned right down, so the bursts are the only features.
  // The tail is an exponential that starts at the last burst and is still
  // above half its peak 40 ms later, which is what made the first version of
  // this check measure the DECAY and call it the spread.
  const envelopeOf = (over: Record<string, number>): number[] => {
    const m = mono(hit('cp', { cpdec: 0.06, ...over }));
    const w = Math.round(SR * 0.0015);
    const out: number[] = [];
    for (let i = 0; i + w < Math.round(SR * 0.16); i += w) out.push(rms(m, i, w));
    return out;
  };
  const peaks = (env: number[]): number[] => {
    const idx: number[] = [];
    for (let i = 1; i < env.length - 1; i++) {
      if ((env[i] ?? 0) > (env[i - 1] ?? 0) && (env[i] ?? 0) >= (env[i + 1] ?? 0)
        && (env[i] ?? 0) > 0.05) idx.push(i);
    }
    return idx;
  };
  // Where the bursts END, not how many local maxima the envelope has.  The
  // first version counted peaks over the whole 90 ms and picked up wiggles in
  // the tail, which made the TIGHT clap look wider than the wide one.
  const lastBurst = (env: number[]): number => {
    let peak = 0;
    for (const v of env) peak = Math.max(peak, v);
    let last = 0;
    for (let i = 0; i < env.length; i++) if ((env[i] ?? 0) > peak * 0.6) last = i;
    return last;
  };
  const tight = envelopeOf({ cpspread: 0.5 });
  const wide = envelopeOf({ cpspread: 2.5 });
  assert(peaks(tight).length >= 3, `at Spread 0.5 the clap shows ${peaks(tight).length} bursts`);
  assert(lastBurst(wide) > lastBurst(tight) * 2.5,
    `Spread moved the last burst from window ${lastBurst(tight)} to ${lastBurst(wide)} — barely`);
});

check('every decay knob changes how long its voice lasts', () => {
  for (const v of DRUM_VOICES) {
    const id = `${v}dec`;
    const def = findInstrument('drummachine')!.params.find((d) => d.id === id)!;
    const shortHit = hit(v, { [id]: def.min * 1.2 });
    const longHit = hit(v, { [id]: def.max * 0.8 });
    const lengthOf = (r: { left: Float32Array; right: Float32Array }): number => {
      const m = mono(r);
      // A loop, not `Math.max(...array)`: these buffers run to hundreds of
      // thousands of samples and spreading one into arguments overflows the
      // call stack, which is how this check first failed.
      let peak = 0;
      for (let i = 0; i < m.length; i++) peak = Math.max(peak, Math.abs(m[i] ?? 0));
      for (let i = m.length - 1; i >= 0; i--) if (Math.abs(m[i] ?? 0) > peak * 0.01) return i;
      return 0;
    };
    const a = lengthOf(shortHit);
    const b = lengthOf(longHit);
    assert(b > a * 1.5,
      `${DRUM_VOICE_NAMES[v]} lasts ${(a / SR).toFixed(3)} s at its shortest and ${(b / SR).toFixed(3)} at its longest`);
  }
});

check('accent decides how much velocity matters', () => {
  const soft = rms(mono(hit('bd', { accent: 1 }, 0.2)));
  const hard = rms(mono(hit('bd', { accent: 1 }, 1)));
  assert(hard > soft * 3, `at Accent 1, velocity 0.2 against 1 gave ${(20 * Math.log10(hard / soft)).toFixed(1)} dB`);
  const flatSoft = rms(mono(hit('bd', { accent: 0 }, 0.2)));
  const flatHard = rms(mono(hit('bd', { accent: 0 }, 1)));
  assert(Math.abs(20 * Math.log10(flatHard / flatSoft)) < 0.1,
    'at Accent 0 velocity still changed the level');
});

check('width spreads the voices without moving the kick', () => {
  const lr = (v: DrumVoice, width: number): number => {
    const r = hit(v, { width });
    let d = 0;
    for (let i = 0; i < r.left.length; i += 7) d = Math.max(d, Math.abs((r.left[i] ?? 0) - (r.right[i] ?? 0)));
    return d;
  };
  assert(lr('ch', 0) < 1e-9, 'at Width 0 the hat is not centred');
  assert(lr('cy', 0) < 1e-9, 'at Width 0 the cymbal is not centred');
  assert(lr('ch', 1) > 0.05, 'at Width 1 the hat is still centred');
  // The kick and snare stay in the middle at every width, because everything
  // else is built around them.
  assert(lr('bd', 1) < 1e-9, 'the kick moved off centre');
  assert(lr('sd', 1) < 1e-9, 'the snare moved off centre');
});

check('the same hit is the same samples, and two hits are not', () => {
  const a = hit('sd', {}, 0.9, 77);
  const b = hit('sd', {}, 0.9, 77);
  for (let i = 0; i < a.left.length; i += 37) {
    assert(a.left[i] === b.left[i], `the same seed differs at sample ${i}`);
  }
  const c = hit('sd', {}, 0.9, 78);
  let diff = 0;
  for (let i = 0; i < a.left.length; i += 7) diff = Math.max(diff, Math.abs((a.left[i] ?? 0) - (c.left[i] ?? 0)));
  assert(diff > 0.01, 'two different hits are the same noise');
});

check('every parameter the instrument declares is one the engine reads', () => {
  // A knob that does nothing is worse than a missing one, and with forty-six
  // of them across eleven voices it is easy for one to be typed in the
  // descriptor and never read.  So each is swept, on the voice it belongs to,
  // and the output has to change.
  const inst = findInstrument('drummachine')!;
  const dead: string[] = [];
  for (const def of inst.params) {
    if (def.id === 'level') continue;               // applied outside the render
    const prefix = def.id.slice(0, 2);
    const voices: DrumVoice[] = (DRUM_VOICES as readonly string[]).includes(prefix)
      ? [prefix as DrumVoice]
      : [...DRUM_VOICES];
    let moved = false;
    for (const v of voices) {
      const lo = mono(hit(v, { [def.id]: def.min }));
      const hi = mono(hit(v, { [def.id]: def.max }));
      const n = Math.min(lo.length, hi.length);
      let diff = 0;
      for (let i = 0; i < n; i += 3) diff = Math.max(diff, Math.abs((lo[i] ?? 0) - (hi[i] ?? 0)));
      if (diff > 1e-6) { moved = true; break; }
    }
    if (!moved) dead.push(def.id);
  }
  assert(dead.length === 0, `${dead.length} parameter(s) the engine never reads: ${dead.join(', ')}`);
});

check('the instrument is registered beside the kit, and is not the kit', () => {
  const machine = findInstrument('drummachine');
  const kit = findInstrument('drumkit');
  assert(machine, 'there is no drummachine instrument');
  assert(kit, 'the drum kit is gone');
  assert(machine.params.length > 40, `the machine only has ${machine.params.length} parameters`);
  assert(kit.params.length < 10, 'the kit has grown a per-voice page of its own');
  // The point of having both: the machine has controls per VOICE and the kit
  // has controls for the whole thing.
  for (const v of DRUM_VOICES) {
    assert(machine.params.some((d) => d.id === `${v}dec`), `the machine has no decay for ${v}`);
    assert(machine.params.some((d) => d.id === `${v}lvl`), `the machine has no level for ${v}`);
  }
});

console.log('');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
if (bad) process.exit(1);
