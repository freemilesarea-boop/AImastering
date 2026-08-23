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
  DEFAULT_SEPARATION, DETAILED_STEMS, STEM_KINDS, separate, stemLabel,
} from '../src/renderer/daw/audio/separate/separate.js';
import {
  STEM_TREE, TOP_STEMS, coverIsValid, coverProblems, family, orderStems,
  stemRoot, toggleStem, type StemKind,
} from '../src/renderer/daw/audio/separate/stem-tree.js';
import { DEFAULT_PHRASE, leadEnvelope, phraseLock } from '../src/renderer/daw/audio/separate/phrase.js';
import { drumPresence, drumTemplates } from '../src/renderer/daw/audio/separate/drums.js';
import { voiceSplit } from '../src/renderer/daw/audio/separate/voices.js';
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
  // One threshold for all four would say nothing.  These are what each stem
  // actually manages on this fixture, with room under it — and they are not
  // equal because the parts are not equally separable.  베이스 has a cue
  // nothing else shares.  보컬 is the low one because the fixture's vocal is
  // a lead PLUS stacked doubles that are deliberately spread, which is the
  // hardest thing here and the thing a listener notices first.
  const floors: Record<string, number> = { vocals: 50, drums: 65, bass: 70, other: 70 };
  for (const kind of STEM_KINDS) {
    atLeast(matrix[kind]![kind]!, floors[kind] ?? 60,
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

// ── The tree ─────────────────────────────────────────────────────────────────

check('a set that names a stem and its parent is refused, not obeyed', () => {
  // Obeying it writes the singer into two files, and playing them together is
  // the singer at double level — which sounds like the separator is broken
  // rather than like the request was impossible.
  eq(coverIsValid(['vocals', 'lead', 'drums', 'bass', 'other']), false, 'parent plus child');
  eq(coverProblems(['vocals', 'lead', 'drums', 'bass', 'other']).overlapping.join(), 'lead',
    'and it names which one');
  let threw = '';
  try {
    separate(fixture.mix, FIXTURE_SR, { wanted: ['vocals', 'lead', 'drums', 'bass', 'other'] });
  } catch (e) { threw = String(e); }
  assert(threw.includes('두 번'), `the separator refuses too: ${threw}`);
});

check('a set is valid at any depth, as long as it covers each part once', () => {
  eq(coverIsValid(TOP_STEMS), true, 'the four');
  eq(coverIsValid(DETAILED_STEMS), true, 'all the leaves');
  eq(coverIsValid(['lead', 'backing', 'drums', 'bass', 'other']), true, 'a mixture of depths');
  eq(coverProblems(['vocals', 'bass']).missing.length > 0, true, 'and an incomplete one is noticed');
});

check('toggling a stem keeps the set covering the record exactly once', () => {
  // The user should not have to know the invariant, so the toggle enforces it:
  // turning 킥 on brings its sibling with it and stands 드럼 down.
  const on = toggleStem([...TOP_STEMS], 'kick');
  eq(coverIsValid(on), true, `still a cover: ${on.join(' ')}`);
  assert(on.includes('kick') && on.includes('kit'), `the level came on together: ${on.join(' ')}`);
  assert(!on.includes('drums'), 'and the parent stood down');
  const off = toggleStem(on, 'kick');
  eq(off.join(), TOP_STEMS.join(), 'and turning it off folds the family back');
});

check('stems come back in the order the tree reads', () => {
  eq(orderStems(['other', 'kick', 'lead', 'bass']).join(), 'lead,kick,bass,other', 'depth first');
  eq(stemRoot('backing'), 'vocals', 'a leaf knows its trunk');
  eq(stemRoot('bass'), 'bass', 'and a trunk is its own');
  eq(family('drums').join(), 'drums,kick,kit', 'a family is itself and its children');
});

check('every node in the tree says what it is and what puts a sound there', () => {
  for (const node of STEM_TREE) {
    assert(node.label.length > 0, `${node.kind} has a name`);
    assert(node.what.length > 8, `${node.kind} says what lands there: "${node.what}"`);
    assert(/^#[0-9a-f]{6}$/i.test(node.color), `${node.kind} has a colour: ${node.color}`);
  }
});

// ── The deeper cuts ──────────────────────────────────────────────────────────

const detailed = separate(fixture.mix, FIXTURE_SR, { wanted: DETAILED_STEMS });
const deepMatrix = leakageMatrix(fixture.parts, detailed.stems,
  ['lead', 'backing', 'kick', 'kit', 'bass', 'other']);

check('six stems still add back up to the record', () => {
  atMost(detailed.reconstructionDb, -100,
    `sum of six against the input: ${detailed.reconstructionDb.toFixed(1)} dB`);
});

check('the children of a stem add up to that stem', () => {
  // Not a restatement of the line above: the whole set summing to the input
  // would still hold if 리드 and 코러스 traded energy with 베이스.  This says
  // the vocal was cut in two and nothing left the room.
  const four = separate(fixture.mix, FIXTURE_SR);
  for (const [parent, kids] of [['vocals', ['lead', 'backing']], ['drums', ['kick', 'kit']]] as const) {
    const whole = four.stems.find((s) => s.kind === parent)!;
    let worst = 0;
    for (let c = 0; c < whole.channels.length; c++) {
      const one = whole.channels[c]!;
      for (let i = 0; i < one.length; i++) {
        let sum = 0;
        for (const kid of kids) sum += detailed.stems.find((s) => s.kind === kid)!.channels[c]![i] ?? 0;
        worst = Math.max(worst, Math.abs((one[i] ?? 0) - sum));
      }
    }
    atMost(worst, 2e-4, `${stemLabel(parent)} against its children`);
  }
});

check('the kick comes back, and it comes back clean', () => {
  atLeast(deepMatrix.kick!.kick!, 65, 'kick recovered');
  atMost(deepMatrix.kick!.kit!, 15, 'kick leaking into the rest of the kit');
  atMost(deepMatrix.kit!.kick!, 20, 'the rest of the kit leaking into the kick');
  atLeast(deepMatrix.kit!.kit!, 50, 'the rest of the kit recovered');
});

check('drum hits are actually found, not assumed', () => {
  // Every mask below rests on the onset classifier having something to
  // classify.  Zero onsets is a silent fallback to frequency alone, and the
  // report says so rather than looking the same as a good run.
  atLeast(detailed.drumOnsets, 40, `onsets in 24 seconds at 120 BPM: ${detailed.drumOnsets}`);
});

check('the kick template does not reach up into the snare', () => {
  const bins = binsFor(SEPARATION_STFT.fftSize);
  const t = drumTemplates(bins, SEPARATION_STFT.fftSize, FIXTURE_SR);
  const at = (tpl: Float32Array, hz: number): number =>
    tpl[Math.round((hz * SEPARATION_STFT.fftSize) / FIXTURE_SR)] ?? 0;
  atLeast(at(t.kick, 55), 0.95, 'the kick owns 55 Hz');
  atMost(at(t.kick, 200), 0.05, 'and has let go by 200');
  atMost(at(t.cymbals, 500), 0.02, 'the cymbals do not reach down to 500 Hz');
  atLeast(at(t.cymbals, 9000), 0.9, 'and do own 9 kHz');
});

// ── Lead against 코러스 ──────────────────────────────────────────────────────

check('stacked backing vocals are recovered at all', () => {
  // They were not, at first: three quarters of them went to "그 외", because
  // backings are DELIBERATELY spread and the vocal mask is built on being
  // centred.  The phrase cue is what gets them back.
  atLeast(deepMatrix.backing!.backing!, 25, '코러스 recovered');
  atLeast(deepMatrix.lead!.lead!, 55, 'and the lead did not suffer for it');
  atMost(deepMatrix.lead!.backing!, 20, 'the lead does not fall into 코러스');
});

check('a lead sits dead centre and a double does not', () => {
  const spread = voiceSplit(
    { value: Float32Array.from([1, 0.95, 0.6, 0.3, 0]), informative: true }, 1, 5);
  eq(spread.available, true, 'the cue was there');
  atLeast(spread.lead[0] ?? 0, 0.99, 'perfectly centred is all lead');
  atMost(spread.lead[4] ?? 1, 0.01, 'and fully spread is all 코러스');
  assert((spread.lead[2] ?? 0) > 0 && (spread.lead[2] ?? 1) < 1, 'with a crossfade between');
});

check('with no centre cue there is no 코러스, and it says so', () => {
  const none = voiceSplit({ value: new Float32Array(8), informative: false }, 1, 8);
  eq(none.available, false, 'reported unavailable');
  assert(Array.from(none.lead).every((v) => v === 1),
    'and the lead takes it all rather than a 코러스 stem being invented');
  const mono = separate(toMono(fixture.mix), FIXTURE_SR, { wanted: DETAILED_STEMS });
  eq(mono.voicesSeparable, false, 'a mono run reports it');
  assert(mono.notes.some((n) => n.includes('리드')), `and names it: ${mono.notes.join(' | ')}`);
});

// ── The phrase cue ───────────────────────────────────────────────────────────

check('the phrase cue works on bands, because a melody does not stay in a bin', () => {
  // The first version correlated each BIN with the lead and scored 0.011
  // against a floor of 0.35 — a sung note is at a different frequency every
  // time, so one bin holds a lone spike against the lead's twenty.
  const total = frameCount(fixture.length);
  const specL = analyse(fixture.mix[0]!, FIXTURE_SR, 0, total);
  const mag = magnitudes(specL);
  const voice = magnitudes(analyse(fixture.parts.lead[0]!, FIXTURE_SR, 0, total));
  const env = leadEnvelope(voice, voice, specL.frames, specL.bins);
  const lock = phraseLock(mag, env, specL.frames, specL.bins,
    SEPARATION_STFT.fftSize, FIXTURE_SR);

  const backing = magnitudes(analyse(fixture.parts.backing[0]!, FIXTURE_SR, 0, total));
  const pad = magnitudes(analyse(fixture.parts.other[0]!, FIXTURE_SR, 0, total));
  let bSum = 0, bN = 0, pSum = 0, pN = 0;
  for (let i = 0; i < lock.length; i++) {
    const b = backing[i] ?? 0;
    const p = pad[i] ?? 0;
    if (b > 3 * p && b > 1e-3) { bSum += lock[i] ?? 0; bN++; }
    else if (p > 3 * b && p > 1e-3) { pSum += lock[i] ?? 0; pN++; }
  }
  assert(bN > 1000 && pN > 1000, `enough cells of each (${bN}/${pN})`);
  const ratio = (bSum / bN) / Math.max(1e-9, pSum / pN);
  // Measured at 2.6 with the true vocal as the reference envelope, and at 9
  // with the separator's own first-pass mask, which is what actually drives
  // it.  Two is the line between "this cue discriminates" and "this cue is
  // measuring that both are music".
  atLeast(ratio, 2, 'phrase lock at 코러스 cells over the same at pad cells');
});

check('the phrase cue really is per band — one answer for every bin in it', () => {
  // The property, not just its effect: within a third-octave band every bin
  // gets the same gain, and neighbouring bands differ.  A version that read
  // the whole spectrum into every band would still discriminate a little and
  // pass the test above.
  const frames = 64;
  const bins = binsFor(SEPARATION_STFT.fftSize);
  const mag = new Float32Array(frames * bins);
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const on = f % 8 < 4 ? 1 : 0;              // a phrase, on and off
    env[f] = on;
    for (let b = 0; b < bins; b++) {
      const hz = (b * FIXTURE_SR) / SEPARATION_STFT.fftSize;
      // Only 900–1100 Hz phrases with the singer; everything else is steady.
      mag[f * bins + b] = hz > 900 && hz < 1100 ? 0.2 + on : 1;
    }
  }
  const lock = phraseLock(mag, env, frames, bins, SEPARATION_STFT.fftSize, FIXTURE_SR);
  const at = (hz: number): number =>
    lock[2 * bins + Math.round((hz * SEPARATION_STFT.fftSize) / FIXTURE_SR)] ?? 0;
  // Not 1: a third-octave band at 1 kHz spans 891–1122 Hz and the phrasing
  // material only fills part of it, so the correlation is diluted by the
  // steady bins alongside.  That dilution is the price of bands and is why
  // the band width is a stated parameter.
  atLeast(at(1000), 0.5, 'the band that phrases');
  atMost(at(400), 0.05, 'a band two octaves below that does not');
  atMost(at(4000), 0.05, 'nor one two octaves above');
  eq(at(980), at(1010), 'and two bins inside the same band get the same answer');
});

check('a singer who never stops gives the phrase cue nothing, and it says nothing', () => {
  // A flat envelope has no variance to correlate against.  Returning zeros is
  // right; returning ones would hand the whole arrangement to the vocal.
  const flat = new Float32Array(200).fill(3);
  const lock = phraseLock(new Float32Array(200 * 8).fill(1), flat, 200, 8,
    SEPARATION_STFT.fftSize, FIXTURE_SR);
  assert(Array.from(lock).every((v) => v === 0), 'all zero');
  eq(DEFAULT_PHRASE.perOctave >= 2, true, 'and the bands are wide enough to hold a phrase');
});

// ── Report ───────────────────────────────────────────────────────────────────

console.log('\n원본 파트가 어느 스템으로 갔는가 (%)');
console.log('          ' + STEM_KINDS.map((k) => stemLabel(k).padStart(8)).join(''));
for (const truth of STEM_KINDS) {
  console.log(stemLabel(truth).padEnd(8)
    + STEM_KINDS.map((k) => matrix[truth]![k]!.toFixed(0).padStart(8)).join(''));
}
console.log('\n자세히 나눴을 때 (%)');
console.log('           ' + (['lead', 'backing', 'kick', 'kit', 'bass', 'other'] as const)
  .map((k) => stemLabel(k).padStart(11)).join(''));
for (const truth of ['lead', 'backing', 'kick', 'kit', 'bass', 'other'] as const) {
  console.log(stemLabel(truth).padEnd(11)
    + (['lead', 'backing', 'kick', 'kit', 'bass', 'other'] as const)
      .map((k) => deepMatrix[truth]![k]!.toFixed(0).padStart(11)).join(''));
}
console.log(`합 − 원본 = ${report.reconstructionDb.toFixed(0)} dB   `
  + `${(fixture.length / FIXTURE_SR / (report.elapsedMs / 1000)).toFixed(1)}배속   `
  + report.stems.map((s) => `${stemLabel(s.kind)} 확신 ${(s.confidence * 100).toFixed(0)}%`).join(' · '));

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed${passed === results.length ? '' : `, ${results.length - passed} FAILED`}`);
if (passed !== results.length) process.exit(1);
