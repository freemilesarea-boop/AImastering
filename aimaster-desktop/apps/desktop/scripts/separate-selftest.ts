// Stem separation.
//
// The hard part of testing a separator is that "does it sound separated" is
// not a test.  So the fixture builds a mix out of four parts it keeps, and
// every claim below is a number measured against those parts — how much of
// the real bass came back in the bass stem, how much of it leaked into the
// vocal, how far the four stems miss the input when added back up.
//
// The thresholds are deliberately a little below what the code does today.
// A test that asserts the current number to two decimal places fails on every
// harmless change; one that asserts the property fails when the property
// breaks.  Where a number IS the point — the reconstruction error, the mask
// sum — it is asserted tightly, because those are exact by construction and a
// drift in them means the construction broke.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Overlap, SEPARATION_STFT, analyse, binsFor, contextFrames, denominatorFor,
  frameCount, magnitudes,
} from '../src/renderer/daw/audio/separate/spectrum.js';
import { runningMedian } from '../src/renderer/daw/audio/separate/median.js';
import { DEFAULT_HPSS, hpssHarmonic } from '../src/renderer/daw/audio/separate/hpss.js';
import { bandProfiles, repetition } from '../src/renderer/daw/audio/separate/repet.js';
import { centreness, midMagnitude } from '../src/renderer/daw/audio/separate/stereo.js';
import { DEFAULT_BASS, bassShelf, bassWeight, trackBass } from '../src/renderer/daw/audio/separate/bass.js';
import {
  DEFAULT_SEPARATION, STEM_KINDS, separate, stemLabel,
} from '../src/renderer/daw/audio/separate/separate.js';
import { buildFixture, leakageMatrix, toMono, FIXTURE_SR } from './separate-fixture.js';

const results: Array<{ name: string; pass: boolean }> = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true }); console.log(`[PASS] ${name}`); }
  catch (e) {
    results.push({ name, pass: false });
    console.log(`[FAIL] ${name} — ${e instanceof Error ? e.message : String(e)}`);
  }
}
function assert(cond: unknown, why: string): asserts cond {
  if (!cond) throw new Error(why);
}
function eq<T>(got: T, want: T, why: string): void {
  if (!Object.is(got, want)) throw new Error(`${why} — got ${String(got)}, want ${String(want)}`);
}
function atLeast(got: number, want: number, why: string): void {
  if (!(got >= want)) throw new Error(`${why} — got ${got.toFixed(2)}, wanted at least ${want}`);
}
function atMost(got: number, want: number, why: string): void {
  if (!(got <= want)) throw new Error(`${why} — got ${got.toFixed(2)}, wanted at most ${want}`);
}

// ── The transform ────────────────────────────────────────────────────────────

const SR = 48000;
function tone(n: number, parts: Array<[number, number]>): Float32Array {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const [hz, amp] of parts) v += amp * Math.sin((2 * Math.PI * hz * i) / SR);
    x[i] = v;
  }
  return x;
}

check('the transform comes back as what went in', () => {
  const n = 40000;
  const x = tone(n, [[220, 0.4], [1310, 0.2], [77, 0.15]]);
  const total = frameCount(n);
  const den = denominatorFor(n, SEPARATION_STFT.fftSize);
  const acc = new Overlap(n, SEPARATION_STFT.fftSize, den);
  acc.add(analyse(x, SR, 0, total), null, true);
  const out = acc.finish(den);
  let worst = 0;
  for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs((out[i] ?? 0) - (x[i] ?? 0)));
  // Float32 storage of the spectrum is the floor here, not the algorithm.
  atMost(worst, 1e-6, 'round trip error');
});

check('chunking does not change one sample of the answer', () => {
  // This is the property the whole memory strategy rests on: a song is
  // separated a window at a time because 720 MB of spectrogram will not fit,
  // and that is only allowed if the seams are not there.
  const n = 40000;
  const x = tone(n, [[220, 0.4], [1310, 0.2], [77, 0.15]]);
  const total = frameCount(n);

  const run = (chunkFrames: number): Float32Array => {
    const den = denominatorFor(n, SEPARATION_STFT.fftSize);
    const acc = new Overlap(n, SEPARATION_STFT.fftSize, den);
    const ctx = contextFrames(SEPARATION_STFT, 20);
    for (let start = 0; start < total; start += chunkFrames) {
      const end = Math.min(total, start + chunkFrames);
      const from = Math.max(0, start - ctx);
      const to = Math.min(total, end + ctx);
      const spec = analyse(x, SR, from, to);
      acc.add({
        ...spec,
        data: spec.data.subarray((start - from) * spec.bins * 2, (end - from) * spec.bins * 2),
        frames: end - start,
        originSample: start * SEPARATION_STFT.hopSize,
      }, null, true);
    }
    return acc.finish(den);
  };

  const whole = run(10_000);
  const chopped = run(7);
  let worst = 0;
  for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs((whole[i] ?? 0) - (chopped[i] ?? 0)));
  eq(worst, 0, 'six chunks against one, bit for bit');
});

// ── The median ───────────────────────────────────────────────────────────────

check('the running median agrees with a naive one, every time', () => {
  const naive = (src: number[], w: number): number[] => {
    const half = w >> 1;
    return src.map((_, i) => {
      const win: number[] = [];
      for (let k = -half; k <= half; k++) {
        win.push(src[Math.min(src.length - 1, Math.max(0, i + k))]!);
      }
      return win.sort((a, b) => a - b)[half]!;
    });
  };
  let state = 7;
  const next = (): number => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state; };
  let worst = 0;
  for (let trial = 0; trial < 300; trial++) {
    const n = 3 + (next() % 40);
    const w = 1 + 2 * (next() % 6);
    const src = Array.from({ length: n }, () => Math.round((next() % 80) / 4) / 4);
    const out = new Float32Array(n);
    runningMedian(Float32Array.from(src), out, 0, n, 1, w, new Float32Array(w + 2));
    const want = naive(src, w);
    for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs((out[i] ?? 0) - want[i]!));
  }
  eq(worst, 0, 'across 300 random windows');
});

check('the median walks a stride, so one array holds a spectrogram', () => {
  // Frame-major storage means the time median reads with a stride of `bins`
  // and the frequency median with a stride of 1, out of the same buffer.
  const bins = 4;
  const grid = Float32Array.from([1, 9, 1, 1,  1, 9, 1, 1,  1, 9, 1, 1]);
  const out = new Float32Array(12);
  for (let b = 0; b < bins; b++) runningMedian(grid, out, b, 3, bins, 3, new Float32Array(8));
  eq(Array.from(out).join(','), '1,9,1,1,1,9,1,1,1,9,1,1', 'a ridge along time survives a time median');
  for (let f = 0; f < 3; f++) runningMedian(grid, out, f * bins, bins, 1, 3, new Float32Array(8));
  eq(Array.from(out).join(','), '1,1,1,1,1,1,1,1,1,1,1,1', 'and does not survive a frequency one');
});

// ── The cues ─────────────────────────────────────────────────────────────────

check('a sustained note reads harmonic and a click reads percussive', () => {
  const n = SR * 3;
  const x = tone(n, [[440, 0.3]]);
  for (let hit = 0; hit < 6; hit++) {
    const at = Math.floor(hit * 0.5 * SR);
    for (let i = 0; i < 300; i++) {
      x[at + i] = (x[at + i] ?? 0) + 0.6 * Math.exp(-i / 60) * Math.sin(i * 2.3);
    }
  }
  const spec = analyse(x, SR, 0, frameCount(n));
  const mag = magnitudes(spec);
  const h = hpssHarmonic(mag, spec.frames, spec.bins);
  const toneBin = Math.round((440 * SEPARATION_STFT.fftSize) / SR);
  let kept = 0;
  let total = 0;
  for (let f = 20; f < spec.frames - 20; f++) {
    const i = f * spec.bins + toneBin;
    const e = (mag[i] ?? 0) ** 2;
    kept += (h[i] ?? 0) * e;
    total += e;
  }
  atLeast(kept / total, 0.9, 'share of the 440 Hz ridge called harmonic');
});

check('the harmonic mask is a mask: everything in [0,1]', () => {
  const spec = analyse(tone(20000, [[300, 0.4]]), SR, 0, frameCount(20000));
  const h = hpssHarmonic(magnitudes(spec), spec.frames, spec.bins);
  for (let i = 0; i < h.length; i++) {
    assert((h[i] ?? -1) >= 0 && (h[i] ?? 2) <= 1, `bin ${i} is ${h[i]}`);
  }
});

check('a centred source scores centred and a wide one does not', () => {
  const n = 20000;
  const mono = tone(n, [[500, 0.4]]);
  const wide = new Float32Array(n);
  for (let i = 0; i < n; i++) wide[i] = 0.4 * Math.sin((2 * Math.PI * 500 * i) / SR + 1.6);
  const centred = centreness(analyse(mono, SR, 0, frameCount(n)), analyse(mono, SR, 0, frameCount(n)));
  const spread = centreness(analyse(mono, SR, 0, frameCount(n)), analyse(wide, SR, 0, frameCount(n)));
  const bin = Math.round((500 * SEPARATION_STFT.fftSize) / SR);
  const bins = binsFor(SEPARATION_STFT.fftSize);
  const at = (c: { value: Float32Array }): number => c.value[10 * bins + bin] ?? 0;
  atLeast(at(centred), 0.95, 'the same signal in both channels');
  atMost(at(spread), 0.35, 'the same LEVEL but the wrong phase');
});

check('two identical channels are reported as no cue at all, not as perfect centre', () => {
  // A stereo file that is really mono would otherwise score 1 everywhere and
  // the vocal mask would believe it.
  const n = 20000;
  const x = tone(n, [[500, 0.4]]);
  const spec = analyse(x, SR, 0, frameCount(n));
  const same = centreness(spec, spec);
  eq(same.informative, false, 'informative');
  // And the values are 1 by arithmetic rather than by a special case: equal
  // magnitudes make the balance 1, identical phases make the coherence 1.
  // Only the silent bins differ, and they read 0 — which is the honest answer
  // for a bin with nothing in it.
  const bins = binsFor(SEPARATION_STFT.fftSize);
  const loud = 10 * bins + Math.round((500 * SEPARATION_STFT.fftSize) / SR);
  atLeast(same.value[loud] ?? 0, 0.999, 'a bin with signal in it');
  const silent = analyse(new Float32Array(20000), SR, 0, frameCount(20000));
  const nothing = centreness(silent, silent);
  eq(nothing.value[10 * bins + 40] ?? -1, 0, 'a bin with nothing in it');
  const fixture = buildFixture(4);
  const real = centreness(
    analyse(fixture.mix[0]!, FIXTURE_SR, 0, frameCount(fixture.length)),
    analyse(fixture.mix[1]!, FIXTURE_SR, 0, frameCount(fixture.length)));
  eq(real.informative, true, 'a real stereo mix does carry the cue');
});

check('the repetition profile is too coarse to see the singer, on purpose', () => {
  // Eight bands is not an optimisation.  A profile fine enough to tell two
  // sung notes apart finds the frames holding the SAME note, subtracts them,
  // and reports the voice as background — the exact opposite of the cue.
  atMost(DEFAULT_SEPARATION.repet.bands ?? 8, 12, 'default band count');
  const fixture = buildFixture(12, { vocalCycles: false });
  const spec = analyse(fixture.mix[0]!, FIXTURE_SR, 0, frameCount(fixture.length));
  const mag = magnitudes(spec);
  const profiles = bandProfiles(mag, spec.frames, spec.bins, 8);
  for (let f = 0; f < spec.frames; f++) {
    let norm = 0;
    for (let b = 0; b < 8; b++) norm += (profiles[f * 8 + b] ?? 0) ** 2;
    // Unit length is what makes the dot product a cosine similarity, so a
    // loud bar cannot out-score a quiet one that is the same music.
    assert(Math.abs(Math.sqrt(norm) - 1) < 1e-3 || norm === 0, `frame ${f} profile length ${Math.sqrt(norm)}`);
  }
});

check('novelty is higher where the voice is than where the band is', () => {
  const fixture = buildFixture(14, { vocalCycles: false });
  const total = frameCount(fixture.length);
  const specL = analyse(fixture.mix[0]!, FIXTURE_SR, 0, total);
  const specR = analyse(fixture.mix[1]!, FIXTURE_SR, 0, total);
  const mag = midMagnitude(specL, specR);
  const { novelty } = repetition(mag, specL.frames, specL.bins);

  const voice = magnitudes(analyse(fixture.parts.vocals[0]!, FIXTURE_SR, 0, total));
  const bandOnly = new Float32Array(fixture.length);
  for (let i = 0; i < fixture.length; i++) {
    bandOnly[i] = (fixture.mix[0]![i] ?? 0) - (fixture.parts.vocals[0]![i] ?? 0);
  }
  const band = magnitudes(analyse(bandOnly, FIXTURE_SR, 0, total));

  let voiceSum = 0, voiceN = 0, bandSum = 0, bandN = 0;
  for (let i = 0; i < novelty.length; i++) {
    const v = voice[i] ?? 0;
    const b = band[i] ?? 0;
    if (v > 3 * b) { voiceSum += novelty[i] ?? 0; voiceN++; }
    else if (b > 3 * v) { bandSum += novelty[i] ?? 0; bandN++; }
  }
  assert(voiceN > 1000 && bandN > 1000, `enough cells of each kind (${voiceN}/${bandN})`);
  const ratio = (voiceSum / voiceN) / (bandSum / bandN);
  atLeast(ratio, 1.5, 'novelty at vocal cells over novelty at accompaniment cells');
});

check('the bass tracker finds the note, not the octave above it', () => {
  const n = FIXTURE_SR * 3;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // A note whose second harmonic is louder than its fundamental — the
    // classic way a naive peak-picker lands an octave high.
    x[i] = 0.15 * Math.sin((2 * Math.PI * 55 * i) / FIXTURE_SR)
         + 0.4 * Math.sin((2 * Math.PI * 110 * i) / FIXTURE_SR)
         + 0.25 * Math.sin((2 * Math.PI * 165 * i) / FIXTURE_SR);
  }
  const spec = analyse(x, FIXTURE_SR, 0, frameCount(n));
  const track = trackBass(magnitudes(spec), spec.frames, spec.bins,
    SEPARATION_STFT.fftSize, FIXTURE_SR);
  const middle = Math.floor(spec.frames / 2);
  const found = track.hz[middle] ?? 0;
  assert(Math.abs(found - 55) < 4, `fundamental: ${found.toFixed(1)} Hz, wanted 55`);
});

check('the bass comb claims the note\'s harmonics, not a flat low band', () => {
  const bins = binsFor(SEPARATION_STFT.fftSize);
  const shelf = bassShelf(bins, SEPARATION_STFT.fftSize, FIXTURE_SR, DEFAULT_BASS);
  const out = new Float32Array(bins);
  bassWeight(out, { hz: Float32Array.from([110]), strength: Float32Array.from([1]) },
    shelf, 1, bins, SEPARATION_STFT.fftSize, FIXTURE_SR);
  const at = (hz: number): number => out[Math.round((hz * SEPARATION_STFT.fftSize) / FIXTURE_SR)] ?? 0;
  atLeast(at(110), 0.9, 'the fundamental');
  atLeast(at(440), 0.9, 'the fourth harmonic, well above any sensible shelf');
  atMost(at(600), 0.2, 'and a frequency between harmonics is left alone');
  atLeast(at(50), 0.9, 'the shelf still covers the bottom');
});

// ── The whole thing ──────────────────────────────────────────────────────────

const fixture = buildFixture(20, { vocalCycles: false });
const report = separate(fixture.mix, FIXTURE_SR);
const matrix = leakageMatrix(fixture.parts, report.stems);

check('the four stems add back up to the record', () => {
  // The property that makes them an edit rather than four new recordings:
  // mute one, keep three, and what is left is the record minus that part with
  // nothing added.  −100 dB is 0.001 % — inaudible under any circumstances.
  atMost(report.reconstructionDb, -100,
    `sum of stems against the input: ${report.reconstructionDb.toFixed(1)} dB`);
});

check('each part comes back mostly in its own stem', () => {
  for (const kind of STEM_KINDS) {
    atLeast(matrix[kind]![kind]!, 60,
      `${stemLabel(kind)} recovered in the ${stemLabel(kind)} stem`);
  }
});

check('each part is loudest in its own stem, not in someone else\'s', () => {
  for (const kind of STEM_KINDS) {
    const row = matrix[kind]!;
    const best = STEM_KINDS.reduce((a, b) => (row[a]! >= row[b]! ? a : b));
    eq(best, kind, `${stemLabel(kind)} went mostly to ${stemLabel(best)}`);
  }
});

check('the vocal stem is not just the whole mix', () => {
  // The failure mode with teeth: a vocal mask that claims everything looks
  // like it works until you solo it.
  const vocals = report.stems.find((s) => s.kind === 'vocals')!;
  atMost(vocals.energyShare, 0.35, 'share of the mix energy in the vocal stem');
  atMost(matrix.other!.vocals!, 25, 'pad leaking into the vocal');
  atMost(matrix.drums!.vocals!, 25, 'drums leaking into the vocal');
});

check('every stem is real audio and none of it clips', () => {
  for (const stem of report.stems) {
    eq(stem.channels.length, 2, `${stemLabel(stem.kind)} channel count`);
    eq(stem.channels[0]!.length, fixture.length, `${stemLabel(stem.kind)} length`);
    for (const ch of stem.channels) {
      for (let i = 0; i < ch.length; i += 97) {
        assert(Number.isFinite(ch[i] ?? 0), `${stemLabel(stem.kind)} sample ${i} is ${ch[i]}`);
      }
    }
    atLeast(stem.peak, 0.001, `${stemLabel(stem.kind)} is not silence`);
    atMost(stem.peak, 4, `${stemLabel(stem.kind)} peak`);
  }
});

check('confidence is a measurement, and it moves with the material', () => {
  for (const stem of report.stems) {
    assert(stem.confidence >= 0 && stem.confidence <= 1, `${stem.kind}: ${stem.confidence}`);
  }
  // The bass has the sharpest cue of the four — a tracked note with a comb —
  // and the drums the softest, because a soft HPSS mask splits rather than
  // decides.  If that ordering inverts, something is reporting the wrong mask.
  const by = Object.fromEntries(report.stems.map((s) => [s.kind, s.confidence]));
  atLeast(by.bass!, by.drums!, 'bass confidence against drums confidence');
});

check('separating in one chunk and in many gives the same audio', () => {
  const short = buildFixture(6, { vocalCycles: false });
  const one = separate(short.mix, FIXTURE_SR, { chunkFrames: 100_000 });
  const many = separate(short.mix, FIXTURE_SR, { chunkFrames: 60 });
  for (const kind of STEM_KINDS) {
    const a = one.stems.find((s) => s.kind === kind)!.channels[0]!;
    const b = many.stems.find((s) => s.kind === kind)!.channels[0]!;
    let worst = 0;
    for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
    // Not bit-exact and not claimed to be: the repetition cue looks a fixed
    // distance either side, and at the very edges of the file a short chunk
    // has fewer frames to reach for.  Everything else is identical.
    atMost(worst, 0.02, `${stemLabel(kind)} between a 100 000-frame chunk and a 60-frame one`);
  }
});

check('asking for fewer stems gives the same stems, faster', () => {
  const short = buildFixture(6, { vocalCycles: false });
  const all = separate(short.mix, FIXTURE_SR);
  const one = separate(short.mix, FIXTURE_SR, { wanted: ['vocals'] });
  eq(one.stems.length, 1, 'one stem back');
  const a = all.stems.find((s) => s.kind === 'vocals')!.channels[0]!;
  const b = one.stems[0]!.channels[0]!;
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  atMost(worst, 1e-6, 'the vocal stem is the same either way');
  assert(Number.isNaN(one.reconstructionDb),
    'and the sum property is NOT reported, because three quarters of the sum is missing');
});

// ── Mono, and saying so ──────────────────────────────────────────────────────

const monoReport = separate(toMono(fixture.mix), FIXTURE_SR);

check('a mono file still separates, and says which cue it lost', () => {
  eq(monoReport.stereo, false, 'reported as mono');
  eq(monoReport.centreInformative, false, 'no centre cue');
  assert(monoReport.notes.some((n) => n.includes('모노')), `a note says so: ${monoReport.notes.join(' | ')}`);
  atMost(monoReport.reconstructionDb, -100, 'and the sum property still holds');
});

check('mono does not let the vocal mask swallow the record', () => {
  // With the panning cue gone the mask is "harmonic and a bit novel", which on
  // a real mix is most of the record.  Ungoverned it took 47 % of the energy.
  const vocals = monoReport.stems.find((s) => s.kind === 'vocals')!;
  atMost(vocals.energyShare, 0.35, 'vocal share of a mono mix');
});

check('a stereo file whose channels are identical is treated as mono', () => {
  const doubled = [fixture.parts.vocals[0]!.slice(), fixture.parts.vocals[0]!.slice()];
  const r = separate(doubled, FIXTURE_SR);
  eq(r.centreInformative, false, 'the cue is reported as absent');
  assert(r.notes.some((n) => n.includes('같은 신호')), `and named: ${r.notes.join(' | ')}`);
});

// ── What it refuses ──────────────────────────────────────────────────────────

check('it refuses what it cannot do, with the reason', () => {
  let threw = '';
  try { separate([], FIXTURE_SR); } catch (e) { threw = String(e); }
  assert(threw.includes('비어'), `empty input: ${threw}`);
  threw = '';
  try {
    separate([new Float32Array(100), new Float32Array(100), new Float32Array(100)], FIXTURE_SR);
  } catch (e) { threw = String(e); }
  assert(threw.includes('3채널'), `names the channel count: ${threw}`);
});

check('progress runs from start to finish and never goes backwards', () => {
  const short = buildFixture(5);
  const seen: number[] = [];
  separate(short.mix, FIXTURE_SR, { chunkFrames: 40 }, (f) => seen.push(f));
  assert(seen.length > 2, `some progress was reported (${seen.length})`);
  for (let i = 1; i < seen.length; i++) {
    assert(seen[i]! >= seen[i - 1]! - 1e-9, `step ${i}: ${seen[i - 1]} → ${seen[i]}`);
  }
  eq(seen[seen.length - 1], 1, 'it ends at 1');
});

// ── The worker bundle ────────────────────────────────────────────────────────

check('the committed worker bundle matches the TypeScript it came from', () => {
  // The worker is fetched as text and run from a Blob, so it has to be one
  // self-contained file on disk.  A committed bundle that has drifted from its
  // source is a bug that only shows up in the packaged app, which is the worst
  // place to find one.
  const here = path.dirname(fileURLToPath(import.meta.url));
  execFileSync('node', [path.join(here, 'build-separate-worker.mjs'), '--check'],
    { stdio: 'pipe' });
});

// ── Report ───────────────────────────────────────────────────────────────────

console.log('\n원본 파트가 어느 스템으로 갔는가 (%)');
console.log('          ' + STEM_KINDS.map((k) => stemLabel(k).padStart(8)).join(''));
for (const truth of STEM_KINDS) {
  console.log(stemLabel(truth).padEnd(8)
    + STEM_KINDS.map((k) => matrix[truth]![k]!.toFixed(0).padStart(8)).join(''));
}
console.log(`합 − 원본 = ${report.reconstructionDb.toFixed(0)} dB   `
  + `${(fixture.length / FIXTURE_SR / (report.elapsedMs / 1000)).toFixed(1)}배속   `
  + report.stems.map((s) => `${stemLabel(s.kind)} 확신 ${(s.confidence * 100).toFixed(0)}%`).join(' · '));

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed${passed === results.length ? '' : `, ${results.length - passed} FAILED`}`);
if (passed !== results.length) process.exit(1);
