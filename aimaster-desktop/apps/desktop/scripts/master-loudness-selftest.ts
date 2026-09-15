/**
 * master-loudness-selftest — BS.1770 on the console's master bus.
 *
 * The mixer could meter a channel's headroom and could not say how loud the
 * record was.  The numbers existed — `loudnessCore.ts` has computed
 * momentary, short-term, integrated, true peak and LRA for the mastering half
 * of the app all along — but the console had no way to see them while there
 * was still something to do about them.
 *
 * ── The thing this suite exists for ─────────────────────────────────────────
 *
 * There are TWO implementations of BS.1770 in this repo, and they have to
 * agree.  `loudnessCore.ts` is the TypeScript one the offline analysis and the
 * mastering report use; `loudnessProcessor.worklet.js` is a hand-written copy
 * that runs inside `AudioWorkletGlobalScope`, where a TypeScript import is not
 * possible.  Its header says "when you change one, change both", and until
 * now nothing enforced that — so the console and the report could quietly
 * start disagreeing about the loudness of the same mix, which is the single
 * worst failure this feature has available to it.
 *
 * Measured before any of this was wired up: over ten seconds of programme
 * material the two agreed to 0.000000 on momentary, short-term, integrated
 * and true peak.  What follows keeps it that way, by loading the worklet's
 * own file, feeding both the same audio in 128-frame quanta, and comparing.
 *
 * Run: pnpm --filter @aimaster/desktop test:master-loudness
 */

import { readFileSync } from 'node:fs';

import { LoudnessAnalyzer } from '../src/renderer/audio/loudnessCore.js';

const SR = 48_000;
/** One render quantum — the block size the worklet is actually handed. */
const QUANTUM = 128;

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); } catch (e: unknown) {
    results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) });
  }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function close(a: number, b: number, m: string, tol: number): void {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${m} — got ${a.toFixed(6)}, want ${b.toFixed(6)} ±${tol}`);
}

// ── Loading the worklet's private copy ───────────────────────────────────────

interface WorkletAnalyzer {
  feed: (planar: Float32Array[]) => void;
  integrated: () => number;
  loudnessRange: () => number;
  truePeakDb: () => number;
  perChannelTpDb: () => number[];
  lastM: number;
  lastS: number;
  channels: number;
}

/**
 * Pull `_Analyzer` out of the worklet file without an AudioWorklet.
 *
 * The file ends in `registerProcessor`, which only exists inside
 * `AudioWorkletGlobalScope`; the tail is stripped and the one base class it
 * extends is stubbed.  Everything above that is plain arithmetic and runs
 * anywhere — which is the whole reason this comparison is possible at all.
 */
function loadWorkletAnalyzer(): new (fs: number, channels: number) => WorkletAnalyzer {
  const source = readFileSync('src/renderer/audio/loudnessProcessor.worklet.js', 'utf8')
    .replace(/registerProcessor\([\s\S]*?\);\s*$/, '');
  assert(!source.includes('registerProcessor'), 'the worklet tail was not stripped');
  const build = new Function('AudioWorkletProcessor', 'sampleRate', 'currentTime',
    `${source}\nreturn _Analyzer;`) as (
      base: unknown, sr: number, t: number,
    ) => new (fs: number, channels: number) => WorkletAnalyzer;
  return build(class {}, SR, 0);
}

const WorkletAnalyzerClass = loadWorkletAnalyzer();

// ── Material ─────────────────────────────────────────────────────────────────

/**
 * Ten seconds with something for every gate to do.
 *
 * A loud passage, two seconds of near-silence in the middle, and a transient
 * train throughout: the quiet stretch is what the -70 LUFS absolute gate and
 * the -10 LU relative gate are FOR, and material without one lets a broken
 * gate pass.
 */
function programme(seconds: number, quietFrom = 4, quietTo = 6): [Float32Array, Float32Array] {
  const n = SR * seconds;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  let seed = 7;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x3fffffff - 1;
  };
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const quiet = t > quietFrom && t < quietTo ? 0.02 : 1;
    let v = 0;
    for (const f of [110, 164.8, 220, 277.2, 329.6]) v += Math.sin((2 * Math.PI * f * i) / SR) / 5 * 0.4;
    v += Math.exp(-(i % Math.round(SR * 0.5)) / (SR * 0.015)) * rnd() * 0.8;
    left[i] = v * quiet;
    right[i] = v * quiet * 0.85 + Math.sin((2 * Math.PI * 330 * i) / SR) * 0.05 * quiet;
  }
  return [left, right];
}

/**
 * Three sections: full level, 14 dB down, and 48 dB down.
 *
 * Uniform material cannot tell either gate from a wrong one, and both of
 * those were measured rather than assumed:
 *
 *   · relative gate.  Moving the worklet's from -10 to -11 LU changed the
 *     answer by 0.000000 on steady programme.  The 14 dB step puts blocks in
 *     the band between the two thresholds; the same slip then moves
 *     integrated by 1.99 LU.
 *   · absolute gate.  Moving it from -70 to -60 LUFS also changed nothing,
 *     because nothing in the take lived down there — silence is exactly zero
 *     and is dropped by any gate.  The 48 dB section puts 77 blocks between
 *     -70 and -60 LUFS, and the slip then moves integrated by 2.32 LU.
 *
 * Both breaks passed a version of the agreement check that used only steady
 * programme.  Material is part of a test, and uniform material tests very
 * little.
 */
function dynamic(): [Float32Array, Float32Array] {
  const parts = ([0, -14, -48] as const).map((db) => {
    const [l, r] = programme(8, -1, -1);
    const g = Math.pow(10, db / 20);
    return [Float32Array.from(l, (v) => v * g), Float32Array.from(r, (v) => v * g)] as const;
  });
  const total = parts.reduce((n, p) => n + p[0].length, 0);
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  let at = 0;
  for (const [l, r] of parts) { left.set(l, at); right.set(r, at); at += l.length; }
  return [left, right];
}

function silence(seconds: number): [Float32Array, Float32Array] {
  const n = SR * seconds;
  return [new Float32Array(n), new Float32Array(n)];
}

interface Pair { core: LoudnessAnalyzer; worklet: WorkletAnalyzer }

function newPair(): Pair {
  return { core: new LoudnessAnalyzer(SR, 2), worklet: new WorkletAnalyzerClass(SR, 2) };
}

/** Feed both, a render quantum at a time, exactly as the audio thread would. */
function feed(pair: Pair, [left, right]: [Float32Array, Float32Array]): void {
  for (let off = 0; off + QUANTUM <= left.length; off += QUANTUM) {
    const l = left.subarray(off, off + QUANTUM);
    const r = right.subarray(off, off + QUANTUM);
    pair.core.processBlock([l, r]);
    pair.worklet.feed([l, r]);
  }
}

// ── The two implementations must agree ───────────────────────────────────────

check('the worklet and loudnessCore agree on every metric they both report', () => {
  const pair = newPair();
  feed(pair, programme(10));
  // Exact, not approximate.  They are the same arithmetic written twice; any
  // difference at all is a transcription error, and rounding one away would
  // hide the next one.
  close(pair.core.getMomentaryLufs(), pair.worklet.lastM, 'momentary', 1e-9);
  close(pair.core.getShortTermLufs(), pair.worklet.lastS, 'short-term', 1e-9);
  close(pair.core.getIntegratedLufs(), pair.worklet.integrated(), 'integrated', 1e-9);
  close(pair.core.getMetrics().truePeakDbtp, pair.worklet.truePeakDb(), 'true peak', 1e-9);
  close(pair.core.getLoudnessRange(), pair.worklet.loudnessRange(), 'loudness range', 1e-9);
});

check('and agree on material wide enough to move the relative gate', () => {
  // Steady programme cannot tell a -10 LU relative gate from a -11 LU one:
  // no block lives between the two thresholds, so both answers are identical
  // and a transcription error there is invisible.  This material has a 14 LU
  // step in it, which puts blocks in that band.
  const pair = newPair();
  feed(pair, dynamic());
  assert(pair.core.getLoudnessRange() > 10,
    `the material must actually be dynamic, LRA is ${pair.core.getLoudnessRange().toFixed(2)}`);
  close(pair.core.getIntegratedLufs(), pair.worklet.integrated(), 'integrated', 1e-9);
  close(pair.core.getLoudnessRange(), pair.worklet.loudnessRange(), 'loudness range', 1e-9);
  close(pair.core.getMomentaryLufs(), pair.worklet.lastM, 'momentary', 1e-9);
  close(pair.core.getShortTermLufs(), pair.worklet.lastS, 'short-term', 1e-9);
});

check('and both gates are doing something on it, not sitting idle', () => {
  // Guards the check above from quietly becoming vacuous: if the gate stopped
  // excluding anything, the material would no longer distinguish the two
  // implementations and the agreement would prove nothing.  Integrated must
  // sit ABOVE the ungated mean, because the gate is what drops the quiet half.
  const pair = newPair();
  feed(pair, dynamic());
  const gated = pair.core.getIntegratedLufs();
  const series = pair.core.getMomentaryLufsSeries().filter((v) => Number.isFinite(v) && v > -70);
  const ungatedMean = series.reduce((a, b) => a + b, 0) / series.length;
  assert(gated > ungatedMean + 2,
    `the relative gate excluded nothing: gated ${gated.toFixed(2)} vs ungated mean ${ungatedMean.toFixed(2)}`);
  // And the absolute one: blocks must actually live in the band where moving
  // it from -70 to -60 LUFS would change which of them count.
  const inBand = series.filter((v) => v > -70 && v < -60).length;
  assert(inBand > 20, `only ${inBand} blocks sit where the absolute gate lives`);
});

check('and per channel, so a swapped index cannot hide behind the maximum', () => {
  const pair = newPair();
  feed(pair, programme(6));
  const coreTp = pair.core.getMetrics().perChannelTpDb;
  const workletTp = pair.worklet.perChannelTpDb();
  assert(coreTp.length === workletTp.length, `${coreTp.length} channels vs ${workletTp.length}`);
  assert(coreTp[0] !== coreTp[1], 'the material must differ between sides or this proves nothing');
  for (let c = 0; c < coreTp.length; c++) {
    close(coreTp[c]!, workletTp[c]!, `channel ${c} true peak`, 1e-9);
  }
});

check('they agree on silence too, rather than one of them returning a number', () => {
  const pair = newPair();
  feed(pair, silence(4));
  assert(pair.core.getIntegratedLufs() === -Infinity, 'core called silence a loudness');
  assert(pair.worklet.integrated() === -Infinity, 'worklet called silence a loudness');
  close(pair.core.getLoudnessRange(), pair.worklet.loudnessRange(), 'LRA of silence', 1e-9);
});

check('the worklet file still exports what the loader reaches for', () => {
  // The extraction above is a private arrangement with a file that is not a
  // module.  If it is ever refactored — renamed class, ESM export, a bundler
  // in the way — this suite would silently stop comparing anything, so the
  // shape it depends on is asserted rather than assumed.
  const source = readFileSync('src/renderer/audio/loudnessProcessor.worklet.js', 'utf8');
  assert(/class\s+_Analyzer\s*\{/.test(source), 'the analyzer class was renamed');
  assert(/registerProcessor\(\s*'loudness-processor'/.test(source),
    'the processor name the DAW and the mastering panel both construct has changed');
  assert(/loudnessRange\s*\(\s*\)\s*\{/.test(source), 'the worklet lost its LRA');
});

// ── What the master meter is measuring ───────────────────────────────────────

check('a stopped transport stops mattering after the first second', () => {
  // The measurement behind having no automatic reset on play.
  //
  // Silence is not free: the 400 ms momentary window straddles the moment the
  // music stops, and those few windows are real, quieter blocks that survive
  // the gates.  Measured, that is a ONE-OFF of about 0.11 LU.  Past it the
  // -70 LUFS absolute gate drops every block, and one second of silence and
  // two hundred give bit-identical answers — so a meter left running while
  // the transport sits idle is not drifting anywhere.
  const one = newPair();
  const many = newPair();
  feed(one, programme(8, -1, -1));
  feed(many, programme(8, -1, -1));
  feed(one, silence(1));
  feed(many, silence(200));
  close(many.core.getIntegratedLufs(), one.core.getIntegratedLufs(),
    '199 further seconds of silence moved the reading', 1e-9);
  close(many.worklet.integrated(), one.worklet.integrated(), 'and the worklet drifted', 1e-9);
});

check('and repeated play-stop passes converge instead of drifting', () => {
  // The usage this has to survive: press play, listen, stop, adjust, repeat,
  // for an afternoon.  Integrated is a mean over every surviving block, so
  // each further pass moves it less than the last.  Measured over eight
  // passes of eight seconds: 0.028 LU in total, and shrinking.
  const pair = newPair();
  const music = programme(8, -1, -1);
  const gap = silence(5);
  const readings: number[] = [];
  for (let pass = 0; pass < 8; pass++) {
    feed(pair, music);
    feed(pair, gap);
    readings.push(pair.core.getIntegratedLufs());
  }
  const total = Math.abs(readings[readings.length - 1]! - readings[0]!);
  assert(total < 0.05, `eight passes drifted ${total.toFixed(3)} LU`);
  const firstStep = Math.abs(readings[1]! - readings[0]!);
  const lastStep = Math.abs(readings[7]! - readings[6]!);
  assert(lastStep < firstStep,
    `the drift is not settling: step 1 was ${firstStep.toFixed(4)}, step 7 was ${lastStep.toFixed(4)}`);
});

check('LRA counts the stop, once — it is range, and a fade to silence is range', () => {
  // Pinned because it LOOKS like a bug and is not.  Stopping the transport
  // adds the 3 s short-term windows that straddle the ending, which really
  // are quieter, so the loudness range genuinely widens the first time —
  // measured from 0.12 LU to about 6 on steady material.  It then settles:
  // after the second pass it does not move again.  Anyone who "fixes" this
  // by gating the transition away is deleting a real R128 measurement.
  const pair = newPair();
  const music = programme(8, -1, -1);
  const gap = silence(5);
  feed(pair, music);
  const playing = pair.core.getLoudnessRange();
  feed(pair, gap);
  const afterFirstStop = pair.core.getLoudnessRange();
  assert(afterFirstStop > playing + 1,
    `the stop should widen the range, ${playing.toFixed(2)} -> ${afterFirstStop.toFixed(2)}`);
  for (let pass = 0; pass < 4; pass++) { feed(pair, music); feed(pair, gap); }
  const settled = pair.core.getLoudnessRange();
  const after = pair.core.getLoudnessRange();
  close(settled, after, 'LRA kept moving', 1e-9);
  assert(Math.abs(settled - afterFirstStop) < 1,
    `LRA is still climbing pass after pass: ${afterFirstStop.toFixed(2)} -> ${settled.toFixed(2)}`);
  close(pair.worklet.loudnessRange(), settled, 'and the worklet agrees throughout', 1e-9);
});

check('an hour of metering costs under a megabyte of history', () => {
  // Checked because this meter is attached for the life of the AudioContext
  // and never stops accumulating.  The history is one row per 100 ms; an hour
  // is 36,000 rows, and measured with GC forced that came to under 1 MB, so
  // an all-day session is single-digit megabytes.  The hypothesis that this
  // needed a ring buffer is rejected by the number.
  const a = new LoudnessAnalyzer(SR, 2);
  const oneSecond = new Float32Array(SR);
  for (let i = 0; i < SR; i++) oneSecond[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / SR);
  for (let sec = 0; sec < 60; sec++) a.processBlock([oneSecond, oneSecond]);
  const blocks = a.getMetrics().blocksAnalyzed;
  close(blocks, 600, 'a minute is six hundred 100 ms blocks', 1);
  assert(blocks * 60 < 40_000, `an hour would be ${blocks * 60} rows`);
});

check('a reset actually starts again from nothing', () => {
  const loud = new LoudnessAnalyzer(SR, 2);
  const quiet = new LoudnessAnalyzer(SR, 2);
  for (const [a, mat] of [[loud, programme(6)], [quiet, programme(6)]] as const) {
    for (let off = 0; off + QUANTUM <= mat[0].length; off += QUANTUM) {
      a.processBlock([mat[0].subarray(off, off + QUANTUM), mat[1].subarray(off, off + QUANTUM)]);
    }
  }
  loud.reset();
  assert(loud.getIntegratedLufs() === -Infinity, 'a reset analyzer still had a reading');
  assert(loud.getMetrics().truePeakDbtp === -Infinity, 'and still remembered its true peak');
  assert(quiet.getIntegratedLufs() > -Infinity, 'the control was empty, so this proves nothing');
});

check('integrated is gated — a quiet stretch does not drag the number down', () => {
  // Two takes of the same music, one with two seconds of near-silence in the
  // middle.  Ungated, the hole would pull the mean down; gated, it is dropped.
  const withHole = newPair();
  const without = newPair();
  feed(withHole, programme(10, 4, 6));
  feed(without, programme(10, -1, -1));
  const gap = Math.abs(withHole.core.getIntegratedLufs() - without.core.getIntegratedLufs());
  assert(gap < 1, `the hole moved integrated by ${gap.toFixed(2)} LU — the gate is not working`);
  close(withHole.worklet.integrated(), withHole.core.getIntegratedLufs(), 'and the worklet gates the same', 1e-9);
});

check('a 6 dB gain shows up as 6 LU, in both implementations', () => {
  // The sanity check that catches a filter or a weight being wrong in a way
  // the two copies share: an absolute offset is not something a transcription
  // error can agree on by accident.
  const quiet = newPair();
  const loudPair = newPair();
  const [l, r] = programme(6);
  const twice: [Float32Array, Float32Array] = [
    Float32Array.from(l, (v) => v * 2), Float32Array.from(r, (v) => v * 2),
  ];
  feed(quiet, [l, r]);
  feed(loudPair, twice);
  close(loudPair.core.getIntegratedLufs() - quiet.core.getIntegratedLufs(), 6.0206,
    'doubling the amplitude', 1e-6);
  close(loudPair.worklet.integrated() - quiet.worklet.integrated(), 6.0206,
    'and the worklet says the same', 1e-6);
});

check('true peak sees between the samples, so it can exceed sample peak', () => {
  // A tone at a quarter of the sample rate, offset so no sample lands on a
  // crest: sample peak reads low, the oversampled true peak does not.
  const n = SR;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    left[i] = 0.5 * Math.sin(2 * Math.PI * (SR / 4) * (i / SR) + Math.PI / 4);
    right[i] = left[i]!;
  }
  let samplePeak = 0;
  for (let i = 0; i < n; i++) samplePeak = Math.max(samplePeak, Math.abs(left[i]!));
  const pair = newPair();
  feed(pair, [left, right]);
  const tp = pair.core.getMetrics().truePeakDbtp;
  assert(tp > 20 * Math.log10(samplePeak) + 0.5,
    `true peak ${tp.toFixed(2)} did not exceed sample peak ${(20 * Math.log10(samplePeak)).toFixed(2)}`);
  close(pair.worklet.truePeakDb(), tp, 'and the worklet oversamples identically', 1e-9);
});

const failed = results.filter((r) => !r.pass);
for (const r of results) {
  // eslint-disable-next-line no-console
  console.log(`${r.pass ? '[PASS]' : '[FAIL]'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
// eslint-disable-next-line no-console
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
