/**
 * clip-dsp-selftest — rename, normalize, reverse.
 *
 * Three operations that look like one feature and are three different kinds
 * of thing, which is what most of these tests are really about:
 *
 *   NORMALIZE IS A GAIN, NOT A RENDER.  Doing it as clip gain makes it
 *   instant, free, one undo step and — the real point — REVERSIBLE.  So the
 *   tests check that normalizing twice is the same as normalizing once, which
 *   a baked render could never be.
 *
 *   THE TARGET IS TRUE PEAK.  A sample peak of −0.1 dBFS can reconstruct to
 *   +0.5 dBTP in a converter.  Normalizing to sample peak produces files that
 *   measure clean and clip on playback.
 *
 *   REVERSING SWAPS THE FADES.  A fade-in at the head of a passage is a
 *   fade-out at its tail once the passage runs backwards.  Leaving them alone
 *   puts the fade on the wrong end, and it sounds like a broken edit.
 *
 * The audio is synthesised at known levels, so every level assertion is
 * arithmetic against a signal whose peak is known by construction.
 *
 * Run: pnpm --filter @aimaster/desktop test:clip-dsp
 */

import {
  DEFAULT_NORMALIZE, MAX_CLIP_NAME, applyNormalize, cleanClipName, describeNormalize,
  findClipIn, measureClip, normalizePlan, renameClip, renameSelection, replaceClip,
  reverseChannels, reversedClip, selectedAudioClips, spanOf,
} from '../src/renderer/daw/edit/clip-dsp.js';
import {
  CLIP_GAIN_MAX_DB, type TimeSelection,
} from '../src/renderer/daw/edit/clip-edit.js';
import {
  addFile, addTrack, createClip, createSession, createTrack, updateClips,
} from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import type { AudioBufferLike } from '../src/renderer/audio/loudnessCore.js';
import type { Clip, DawSession, TrackId } from '../src/renderer/daw/model/types.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function eq<T>(a: T, b: T, m: string): void {
  if (a !== b) throw new Error(`${m} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}
function close(a: number, b: number, m: string, tol = 1e-6): void {
  if (Math.abs(a - b) > tol) throw new Error(`${m} — got ${a}, want ${b} ±${tol}`);
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const RATE = 48000;

/** A sine at a known amplitude, so the peak is known by construction. */
function tone(seconds: number, amplitude: number, hz = 440): Float32Array {
  const n = Math.round(seconds * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / RATE) * amplitude;
  return out;
}

function buffer(channels: Float32Array[]): AudioBufferLike {
  return {
    sampleRate: RATE,
    numberOfChannels: channels.length,
    length: channels[0]?.length ?? 0,
    getChannelData: (c) => channels[c] ?? channels[0] ?? new Float32Array(0),
  };
}

/** A ten-second file: quiet for the first half, loud for the second. */
function twoLevelFile(): AudioBufferLike {
  const quiet = tone(5, 0.05);       // ≈ −26 dBFS
  const loud = tone(5, 0.5);         // ≈ −6 dBFS
  const all = new Float32Array(quiet.length + loud.length);
  all.set(quiet, 0);
  all.set(loud, quiet.length);
  return buffer([all, all]);
}

function session(clipOver: Partial<Clip> = {}): {
  session: DawSession; trackId: TrackId; clip: Clip;
} {
  resetIds();
  let s = createSession('clip dsp', RATE);
  const track = createTrack('Vox', 'audio');
  s = addTrack(s, track);
  s = addFile(s, {
    id: 'f1', path: '/v/take.wav', name: 'take.wav',
    durationSec: 10, sampleRate: RATE, channels: 2,
  });
  const clip = { ...createClip('f1', 'Vox 1', { startSec: 0, offsetSec: 0, durationSec: 5 }), ...clipOver };
  s = updateClips(s, track.id, () => [clip]);
  return { session: s, trackId: track.id, clip };
}

// ── Rename ────────────────────────────────────────────────────────────────────

check('a clip can be renamed', () => {
  const { session: s, trackId, clip } = session();
  const out = renameClip(s, trackId, clip.id, '  Lead   Vox  take 4 ');
  eq(findClipIn(out, trackId, clip.id)?.name, 'Lead Vox take 4', 'tidied and set');
});

check('an empty name is refused, not accepted', () => {
  // A clip with no name draws as a blank block, and "I cleared the box and
  // now I cannot tell which take is which" is worse than not being allowed to.
  const { session: s, trackId, clip } = session();
  eq(renameClip(s, trackId, clip.id, '   '), s, 'nothing changed');
  eq(findClipIn(renameClip(s, trackId, clip.id, ''), trackId, clip.id)?.name, 'Vox 1', 'still named');
});

check('a very long name is capped rather than overflowing the lane', () => {
  const { session: s, trackId, clip } = session();
  const out = renameClip(s, trackId, clip.id, 'x'.repeat(400));
  eq(findClipIn(out, trackId, clip.id)?.name.length, MAX_CLIP_NAME, 'capped');
  eq(cleanClipName('a\n\tb'), 'a b', 'and whitespace is normalised');
});

check('a selection renames in order, numbered', () => {
  resetIds();
  let s = createSession('multi', RATE);
  const track = createTrack('Vox', 'audio');
  s = addTrack(s, track);
  s = addFile(s, { id: 'f1', path: '/v/a.wav', name: 'a', durationSec: 30, sampleRate: RATE, channels: 1 });
  s = updateClips(s, track.id, () => [0, 5, 10].map((at) =>
    createClip('f1', 'x', { startSec: at, offsetSec: 0, durationSec: 4 })));
  const sel: TimeSelection = { startSec: 0, endSec: 20, trackIds: [track.id] };
  const out = renameSelection(s, sel, 'Chorus');
  const names = (out.tracks[0]!.playlists[0]!.clips).map((c) => c.name).sort();
  eq(names.join(','), 'Chorus 1,Chorus 2,Chorus 3', 'numbered in order');
});

// ── Measuring ─────────────────────────────────────────────────────────────────

check('a clip is measured over ITS OWN span, not the whole file', () => {
  // The file is quiet for 5 s then loud for 5 s.  A clip on the quiet half
  // must measure quiet; one on the loud half must measure loud.
  const file = twoLevelFile();
  const { clip } = session();

  const quiet = measureClip(file, { ...clip, offsetSec: 0, durationSec: 5 });
  const loud = measureClip(file, { ...clip, offsetSec: 5, durationSec: 5 });
  assert(loud.truePeakDbtp - quiet.truePeakDbtp > 15,
    `the loud half really is louder: ${quiet.truePeakDbtp.toFixed(1)} vs ${loud.truePeakDbtp.toFixed(1)} dBTP`);
  // 0.5 amplitude ≈ −6 dBFS; true peak sits at or a touch above that.
  assert(Math.abs(loud.truePeakDbtp - -6) < 1.5, `loud reads ≈ -6 dBTP, got ${loud.truePeakDbtp.toFixed(2)}`);
});

check('digital silence measures as silent rather than as a very quiet clip', () => {
  const silent = buffer([new Float32Array(RATE * 2)]);
  const { clip } = session();
  const measure = measureClip(silent, { ...clip, offsetSec: 0, durationSec: 2 });
  eq(measure.silent, true, 'silent');
});

check('a span past the end of the file is empty, not a crash', () => {
  const file = buffer([tone(1, 0.5)]);
  const span = spanOf(file, 10, 5);
  eq(span.getChannelData(0).length, 0, 'nothing there');
  eq(measureClip(file, { ...session().clip, offsetSec: 10, durationSec: 5 }).silent, true, 'and it says so');
});

// ── Normalize ─────────────────────────────────────────────────────────────────

check('normalize computes the gain that puts the peak on target', () => {
  const file = twoLevelFile();
  const { clip } = session();
  const measure = measureClip(file, { ...clip, offsetSec: 5, durationSec: 5 });   // ≈ −6 dBTP
  const plan = normalizePlan(measure);                                             // target −1 dBTP
  close(plan.gainDb, -1 - measure.truePeakDbtp, 'gain closes the gap exactly', 1e-9);
  assert(plan.gainDb > 4 && plan.gainDb < 6, `about +5 dB, got ${plan.gainDb.toFixed(2)}`);
  eq(plan.clamped, false, 'well inside the clip-gain range');
});

check('normalizing twice is the same as normalizing once', () => {
  // The property a baked render could never have.  The plan is an ABSOLUTE
  // gain, so pressing it again after an edit does not stack.
  const file = twoLevelFile();
  const { session: s, trackId, clip } = session({ offsetSec: 5, durationSec: 5 });
  const measure = measureClip(file, clip);
  const once = applyNormalize(s, trackId, clip.id, normalizePlan(measure));
  const twice = applyNormalize(once, trackId, clip.id, normalizePlan(measure));
  eq(findClipIn(once, trackId, clip.id)?.gainDb, findClipIn(twice, trackId, clip.id)?.gainDb,
    'idempotent');
});

check('normalize targets TRUE peak, not sample peak', () => {
  // The distinction that stops a file measuring clean and clipping on
  // playback.  An inter-sample peak reads higher than any single sample.
  const file = twoLevelFile();
  const { clip } = session();
  const span = spanOf(file, 5, 5);
  let samplePeak = 0;
  const data = span.getChannelData(0);
  for (let i = 0; i < data.length; i++) samplePeak = Math.max(samplePeak, Math.abs(data[i]!));
  const samplePeakDb = 20 * Math.log10(samplePeak);
  const measure = measureClip(file, { ...clip, offsetSec: 5, durationSec: 5 });
  assert(measure.truePeakDbtp >= samplePeakDb - 1e-6,
    `true peak ${measure.truePeakDbtp.toFixed(3)} is not below sample peak ${samplePeakDb.toFixed(3)}`);
});

check('a take that needs more gain than the fader has is TOLD, not quietly maxed', () => {
  // −66 dBFS: quiet enough to need +65 dB, loud enough to be real audio.
  // (−94 would trip the silence guard instead, which is a different answer.)
  const veryQuiet = buffer([tone(2, 0.0005)]);
  const { clip } = session();
  const measure = measureClip(veryQuiet, { ...clip, offsetSec: 0, durationSec: 2 });
  const plan = normalizePlan(measure);
  eq(plan.clamped, true, 'clamped');
  eq(plan.gainDb, CLIP_GAIN_MAX_DB, 'to the top of the range');
  assert(plan.wantedDb > CLIP_GAIN_MAX_DB, 'and it remembers what it wanted');
  assert(describeNormalize(measure, plan).includes('한계'), 'and says so out loud');
});

check('a silent clip is refused with a reason, and nothing is set', () => {
  const silent = buffer([new Float32Array(RATE)]);
  const { session: s, trackId, clip } = session();
  const plan = normalizePlan(measureClip(silent, clip));
  assert(plan.refused, 'refused');
  eq(applyNormalize(s, trackId, clip.id, plan), s, 'and the session is untouched');
});

check('loudness mode normalizes to LUFS instead of peak', () => {
  const file = twoLevelFile();
  const { clip } = session();
  const measure = measureClip(file, { ...clip, offsetSec: 5, durationSec: 5 });
  const plan = normalizePlan(measure, { mode: 'loudness', targetDb: -14 });
  close(plan.gainDb, -14 - measure.integratedLufs, 'closes the LUFS gap', 1e-9);
  assert(describeNormalize(measure, plan, { mode: 'loudness', targetDb: -14 }).includes('LUFS'),
    'and says which unit it used');
});

check('the description names the before and after', () => {
  const file = twoLevelFile();
  const { clip } = session();
  const measure = measureClip(file, { ...clip, offsetSec: 5, durationSec: 5 });
  const text = describeNormalize(measure, normalizePlan(measure));
  assert(text.includes('dBTP'), `${text}`);
  assert(text.includes('-1.0'), 'and the target');
  eq(DEFAULT_NORMALIZE.targetDb, -1, 'which leaves converter headroom');
});

// ── Reverse ───────────────────────────────────────────────────────────────────

check('reversing really reverses, and does not change the length', () => {
  const original = new Float32Array([1, 2, 3, 4, 5]);
  const [flipped] = reverseChannels([original]);
  eq(flipped!.length, 5, 'same length');
  eq(Array.from(flipped!).join(), '5,4,3,2,1', 'backwards');
  eq(Array.from(original).join(), '1,2,3,4,5', 'and the input is untouched');
});

check('every channel is reversed, independently', () => {
  const out = reverseChannels([new Float32Array([1, 2]), new Float32Array([9, 8])]);
  eq(Array.from(out[0]!).join(), '2,1', 'left');
  eq(Array.from(out[1]!).join(), '8,9', 'right');
});

check('reversing twice returns the original samples exactly', () => {
  const source = tone(0.01, 0.7);
  const back = reverseChannels(reverseChannels([source]))[0]!;
  for (let i = 0; i < source.length; i++) eq(back[i], source[i], `sample ${i} identical`);
});

check('THE FADES SWAP ENDS', () => {
  // A fade-in at the head of a passage is a fade-out at its tail once the
  // passage runs backwards.  Leaving them alone puts the fade on the wrong
  // end and sounds like a broken edit.
  const { clip } = session();
  const withFades: Clip = {
    ...clip,
    fadeIn: { durationSec: 0.5, shape: 'linear' },
    fadeOut: { durationSec: 2.0, shape: 'equalPower' },
  };
  const next = reversedClip(withFades, 'f-rev');
  close(next.fadeIn.durationSec, 2.0, 'the old fade-out is the new fade-in');
  eq(next.fadeIn.shape, 'equalPower', 'shape and all');
  close(next.fadeOut.durationSec, 0.5, 'and the old fade-in is the new fade-out');
});

check('the replacement points at offset 0, because the file IS the span', () => {
  // Pointing part way into it would play part way into the reversed passage.
  const { clip } = session({ offsetSec: 5, durationSec: 5 });
  const next = reversedClip(clip, 'f-rev');
  close(next.offsetSec, 0, 'offset reset');
  eq(next.fileId, 'f-rev', 'and it points at the new file');
  close(next.startSec, clip.startSec, 'while staying where it was on the timeline');
  close(next.durationSec, clip.durationSec, 'and the same length');
});

check('a reversed clip says so in its name', () => {
  const { clip } = session();
  assert(reversedClip(clip, 'f').name.includes('↩'), 'marked');
  assert(reversedClip(clip, 'f').name.startsWith('Vox 1'), 'and still recognisable');
});

check('replacing a clip leaves the others alone', () => {
  resetIds();
  let s = createSession('two', RATE);
  const track = createTrack('T', 'audio');
  s = addTrack(s, track);
  s = addFile(s, { id: 'f1', path: '/a.wav', name: 'a', durationSec: 30, sampleRate: RATE, channels: 1 });
  const a = createClip('f1', 'A', { startSec: 0, offsetSec: 0, durationSec: 4 });
  const b = createClip('f1', 'B', { startSec: 5, offsetSec: 0, durationSec: 4 });
  s = updateClips(s, track.id, () => [a, b]);
  const out = replaceClip(s, track.id, a.id, { ...a, name: 'changed' });
  eq(findClipIn(out, track.id, a.id)?.name, 'changed', 'the target changed');
  eq(findClipIn(out, track.id, b.id)?.name, 'B', 'and the other did not');
});

// ── Selection helper ──────────────────────────────────────────────────────────

check('only AUDIO clips inside the selection come back', () => {
  resetIds();
  let s = createSession('mixed', RATE);
  const audio = createTrack('Audio', 'audio');
  const midi = createTrack('Keys', 'instrument');
  s = addTrack(addTrack(s, audio), midi);
  s = addFile(s, { id: 'f1', path: '/a.wav', name: 'a', durationSec: 30, sampleRate: RATE, channels: 1 });
  s = updateClips(s, audio.id, () => [
    createClip('f1', 'in', { startSec: 0, offsetSec: 0, durationSec: 4 }),
    createClip('f1', 'out', { startSec: 20, offsetSec: 0, durationSec: 4 }),
  ]);
  const sel: TimeSelection = { startSec: 0, endSec: 10, trackIds: [audio.id, midi.id] };
  const found = selectedAudioClips(s, sel);
  eq(found.length, 1, 'only the one inside the range');
  eq(found[0]!.clip.name, 'in', 'and it is the right one');
});

// ── Report ────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Clip DSP: rename · normalize · reverse ===');
for (const r of results) {
  console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
