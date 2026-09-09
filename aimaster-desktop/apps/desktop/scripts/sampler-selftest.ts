/**
 * sampler-selftest.ts — which recording plays, and how fast.
 *
 * A sampler has two decisions it cannot be wrong about, and everything else
 * about a sampled instrument is the quality of the recordings.  Both of them
 * fail QUIETLY, which is why they are worth this much test:
 *
 *   · pick the wrong zone and the instrument still makes a sound, so nothing
 *     looks broken — it is just the wrong take, or the wrong velocity layer,
 *     or the same take every time because the round robin never moved.
 *   · get the pitch maths wrong by an octave and every note is still IN TUNE
 *     with itself.  A whole library in the wrong register sounds like a
 *     choice until you play it against something else.
 *
 * The SFZ fixtures below are written the way real libraries write them —
 * inherited groups, `key=` shorthand, note names instead of numbers, Windows
 * separators, comments mid-line — rather than the way that is easiest to
 * parse.  A parser tested only against its own output is not tested.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:sampler
 */

import { parseSfz, parseKey } from '../src/renderer/daw/engine/sfz.js';
import {
  buildSampleSet, describeSampleSet, pickZone, playbackRateFor,
  resolveSamplePath, zonesFor,
} from '../src/renderer/daw/engine/sampler.js';
import { samplePathIn, SamplePathError } from '../src/main/utils/samplePath.js';
import { readFileSync } from 'node:fs';

/** Read code, not prose: a claim must not be satisfied by a comment. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps;

// A piano the way a library ships one: global release, velocity groups, and
// three round-robin takes on one key.
const PIANO_SFZ = `
// Salamander-shaped: two velocity layers, inherited release
<control>
default_path=samples/

<global>
ampeg_release=0.6

<group> lovel=1 hivel=63
<region> sample=A0v1.wav lokey=21 hikey=23 pitch_keycenter=21
<region> sample=C1v1.wav lokey=24 hikey=26 pitch_keycenter=24 tune=-8

<group> lovel=64 hivel=127
<region> sample=A0v2.wav lokey=21 hikey=23 pitch_keycenter=21
<region> sample=C1v2.wav lokey=24 hikey=26 pitch_keycenter=24

// A round robin on one key, and a release sample
<group> lovel=1 hivel=127
<region> sample=D1rr1.wav key=27 seq_length=3 seq_position=1
<region> sample=D1rr2.wav key=27 seq_length=3 seq_position=2
<region> sample=D1rr3.wav key=27 seq_length=3 seq_position=3
<region> sample=rel\\D1.wav key=27 trigger=release
`;

check('note names and numbers both mean the same key', () => {
  assert(parseKey('60') === 60, `60 -> ${parseKey('60')}`);
  assert(parseKey('c4') === 60, `c4 should be middle C (60), got ${parseKey('c4')}`);
  assert(parseKey('C4') === 60, 'case should not matter');
  assert(parseKey('c#4') === 61, `c#4 -> ${parseKey('c#4')}`);
  assert(parseKey('db4') === 61, `db4 -> ${parseKey('db4')}`);
  assert(parseKey('a0') === 21, `a0 is the bottom of a piano, got ${parseKey('a0')}`);
  assert(parseKey('c-1') === 0, `c-1 -> ${parseKey('c-1')}`);
  assert(parseKey('') === null && parseKey('wat') === null, 'nonsense should be null');
});

check('a region inherits its group, and a group its global', () => {
  const sfz = parseSfz(PIANO_SFZ);
  assert(sfz.regions.length === 8, `expected 8 regions, got ${sfz.regions.length}`);
  const a0v1 = sfz.regions.find((r) => r.sample === 'A0v1.wav')!;
  assert(a0v1.loVel === 1 && a0v1.hiVel === 63, `A0v1 velocity ${a0v1.loVel}-${a0v1.hiVel}`);
  assert(near(a0v1.ampegRelease, 0.6), `global release did not reach the region: ${a0v1.ampegRelease}`);
  const a0v2 = sfz.regions.find((r) => r.sample === 'A0v2.wav')!;
  assert(a0v2.loVel === 64, 'the second group did not replace the first');
});

check('`key=` sets the range and the recorded pitch at once', () => {
  const sfz = parseSfz(PIANO_SFZ);
  const rr1 = sfz.regions.find((r) => r.sample === 'D1rr1.wav')!;
  assert(rr1.loKey === 27 && rr1.hiKey === 27 && rr1.keyCenter === 27,
    `key= gave ${rr1.loKey}..${rr1.hiKey} centre ${rr1.keyCenter}`);
});

check('a Windows path in the file is a path here', () => {
  const sfz = parseSfz(PIANO_SFZ);
  const rel = sfz.regions.find((r) => r.trigger === 'release')!;
  assert(rel.sample === 'rel/D1.wav', `backslashes survived: ${rel.sample}`);
});

check('default_path joins without doubling or dropping a separator', () => {
  assert(resolveSamplePath('/lib/piano', 'samples/', 'A0.wav') === '/lib/piano/samples/A0.wav',
    resolveSamplePath('/lib/piano', 'samples/', 'A0.wav'));
  assert(resolveSamplePath('/lib/piano/', '', 'A0.wav') === '/lib/piano/A0.wav',
    resolveSamplePath('/lib/piano/', '', 'A0.wav'));
  assert(resolveSamplePath('', '', 'A0.wav') === 'A0.wav', 'a bare name should survive');
});

check('opcodes that were not acted on are reported, not swallowed', () => {
  const sfz = parseSfz('<region> sample=x.wav key=60 fil_type=lpf_2p cutoff=800 cutoff=900');
  assert(sfz.unsupported['fil_type'] === 1, 'fil_type was not reported');
  assert(sfz.unsupported['cutoff'] === 2, `cutoff counted ${sfz.unsupported['cutoff']}, expected 2`);
  assert(sfz.regions[0]!.raw['cutoff'] === '900', 'the raw value was dropped');
});

check('a region with no sample is not a region', () => {
  const sfz = parseSfz('<region> lokey=0 hikey=127\n<region> sample=real.wav key=60');
  assert(sfz.regions.length === 1, `a sampleless region became playable (${sfz.regions.length})`);
});

// ── Choosing ────────────────────────────────────────────────────────────────

const SET = buildSampleSet('Piano', '/lib/piano', parseSfz(PIANO_SFZ));

check('velocity picks the layer the library meant', () => {
  const soft = zonesFor(SET, 21, 0.3);
  const hard = zonesFor(SET, 21, 0.9);
  assert(soft.length === 1 && soft[0]!.sample === 'A0v1.wav', `soft got ${soft.map((z) => z.sample)}`);
  assert(hard.length === 1 && hard[0]!.sample === 'A0v2.wav', `hard got ${hard.map((z) => z.sample)}`);
});

check('the quietest layer is reachable', () => {
  // SFZ counts velocity 1..127 and the note model works in 0..1.  Rounding
  // the bottom of that range to 0 leaves a library's softest samples
  // unplayable, and the instrument merely sounds like it has no quiet end.
  const whisper = zonesFor(SET, 21, 0.001);
  assert(whisper.length === 1, `velocity 0.001 matched ${whisper.length} zones`);
  assert(whisper[0]!.sample === 'A0v1.wav', `got ${whisper[0]!.sample}`);
});

check('a key outside the library plays nothing rather than something wrong', () => {
  assert(zonesFor(SET, 108, 0.8).length === 0, 'a key above the library matched');
  assert(zonesFor(SET, 12, 0.8).length === 0, 'a key below the library matched');
});

check('a round robin advances, and comes back round', () => {
  const takes: string[] = [];
  for (let i = 0; i < 7; i++) {
    takes.push(pickZone(zonesFor(SET, 27, 0.8), i)!.sample);
  }
  assert(takes[0] === 'D1rr1.wav' && takes[1] === 'D1rr2.wav' && takes[2] === 'D1rr3.wav',
    `first three takes were ${takes.slice(0, 3)}`);
  assert(takes[3] === 'D1rr1.wav', `the fourth note did not come back round: ${takes[3]}`);
  assert(new Set(takes).size === 3, `a repeated note used ${new Set(takes).size} takes`);
});

check('release samples are held back until the key comes up', () => {
  const down = zonesFor(SET, 27, 0.8, 'attack');
  const up = zonesFor(SET, 27, 0.8, 'release');
  assert(down.every((z) => z.trigger === 'attack'), 'a release sample played on key down');
  assert(up.length === 1 && up[0]!.sample === 'rel/D1.wav', `key-up got ${up.map((z) => z.sample)}`);
});

// ── Pitch ───────────────────────────────────────────────────────────────────

check('a sample stretched an octave plays twice as fast', () => {
  const z = zonesFor(SET, 21, 0.3)[0]!;
  assert(near(playbackRateFor(z, 21), 1), `at its own pitch: ${playbackRateFor(z, 21)}`);
  assert(near(playbackRateFor(z, 33), 2), `an octave up: ${playbackRateFor(z, 33)}`);
  assert(near(playbackRateFor(z, 9), 0.5), `an octave down: ${playbackRateFor(z, 9)}`);
});

check('a semitone is a semitone, not a twelfth of a doubling of speed', () => {
  const z = zonesFor(SET, 21, 0.3)[0]!;
  assert(near(playbackRateFor(z, 22), Math.pow(2, 1 / 12), 1e-12),
    `one semitone up gave ${playbackRateFor(z, 22)}`);
});

check("the library's own fine tuning is applied at every pitch, not just the root", () => {
  // C1v1 asks for tune=-8 cents.  Stretched two semitones it must still be
  // 8 cents flat — the cents belong in the exponent, not added to the rate.
  const z = zonesFor(SET, 24, 0.3)[0]!;
  assert(z.tuneCents === -8, `tune did not parse: ${z.tuneCents}`);
  const atRoot = playbackRateFor(z, 24);
  const upTwo = playbackRateFor(z, 26);
  assert(near(1200 * Math.log2(atRoot), -8, 1e-6), `root is ${1200 * Math.log2(atRoot)} cents off`);
  assert(near(1200 * Math.log2(upTwo) - 200, -8, 1e-6),
    `two semitones up is ${1200 * Math.log2(upTwo) - 200} cents off, not -8`);
});

// ── Telling the truth about a library ───────────────────────────────────────

check('the report says what the library actually covers', () => {
  const r = describeSampleSet(SET);
  assert(r.lowestKey === 21 && r.highestKey === 27, `range ${r.lowestKey}..${r.highestKey}`);
  // Three, not two: the round-robin group declares its own 1-127 band, and
  // that IS a third distinct velocity range in the file.  The first version
  // of this assertion said two because I counted the layers I had meant to
  // write rather than the ones the fixture contains.
  assert(r.velocityLayers === 3, `velocity layers: ${r.velocityLayers}`);
  assert(r.roundRobin === 3, `round robin: ${r.roundRobin}`);
  assert(r.releaseZones === 1, `release zones: ${r.releaseZones}`);
  assert(r.unsupported.length === 0, `unexpected unsupported: ${r.unsupported}`);
});

check('a hole in the middle of a library is named, not hidden', () => {
  // Half of the free libraries stop short somewhere.  A sampler that plays
  // silence there is indistinguishable from one that is broken.
  const holed = buildSampleSet('Holed', '/x', parseSfz(
    '<region> sample=a.wav lokey=60 hikey=62 pitch_keycenter=60\n'
    + '<region> sample=b.wav lokey=66 hikey=67 pitch_keycenter=66',
  ));
  const r = describeSampleSet(holed);
  assert(r.gaps.join(',') === '63,64,65', `gaps reported as ${r.gaps}`);
});

check('an empty library reports empty rather than throwing', () => {
  const r = describeSampleSet(buildSampleSet('None', '/x', parseSfz('// nothing here')));
  assert(r.zones === 0 && r.gaps.length === 0, 'an empty set did not describe cleanly');
});

// ── What a library is allowed to read ───────────────────────────────────────

check('a library cannot read outside itself', () => {
  // An .sfz is somebody else's text and every `sample=` in it is a path this
  // process will open.  This is the obvious attack on any sampler, and
  // nothing downstream would catch it: the bytes come back, decodeAudioData
  // rejects them, and the file has already been read.
  const root = '/libs/piano';
  const refused = [
    '../../../../etc/passwd',
    'samples/../../../../etc/passwd',
    '/etc/passwd',
    '',
  ];
  for (const bad of refused) {
    let threw = false;
    try { samplePathIn(root, bad); } catch (e) { threw = e instanceof SamplePathError; }
    assert(threw, `"${bad}" was allowed out of the library`);
  }
});

check('a normal sample path still resolves', () => {
  assert(samplePathIn('/libs/piano', 'samples/A0.wav') === '/libs/piano/samples/A0.wav',
    samplePathIn('/libs/piano', 'samples/A0.wav'));
  // Traversal that stays inside is fine — libraries really are laid out this
  // way, with an .sfz in a subfolder reaching a shared samples directory.
  assert(samplePathIn('/libs/piano', 'sfz/../samples/A0.wav') === '/libs/piano/samples/A0.wav',
    samplePathIn('/libs/piano', 'sfz/../samples/A0.wav'));
});

check('a null byte is not a path', () => {
  let threw = false;
  try { samplePathIn('/libs/piano', 'a\0.wav'); } catch { threw = true; }
  assert(threw, 'a null byte got through');
});

check('the picker and the loader stay separable', () => {
  // Two things depend on this split, both learned the hard way in the running
  // app.  `window.electronAPI` is FROZEN by contextBridge, so the dialog
  // cannot be stubbed from a page — and a native dialog under a headless X
  // server never returns, so a harness that has to go through the picker
  // hangs forever instead of failing.  Folding `loadLibraryFrom` back into
  // `openSampleLibrary` would make the load untestable outside a human hand.
  const src = readFileSync(new URL('../src/renderer/daw/engine/sample-library.ts', import.meta.url), 'utf8');
  assert(/export async function loadLibraryFrom\(/.test(src), 'loadLibraryFrom is not exported');
  assert(/export async function pickSfz\(/.test(src), 'pickSfz is not exported');
  const body = stripComments(src);
  const load = body.slice(body.indexOf('export async function loadLibraryFrom('));
  assert(!/daw:sfz-open/.test(load), 'the loader still opens the dialog itself');
});

check('nothing opens an output device just to decode', () => {
  // Measured: `new AudioContext()` on a machine with no working audio output
  // BLOCKS the renderer thread — the whole window wedged and stayed wedged.
  // Loading a library must not be able to do that, so the decode-only context
  // is offline.  It also must not wait for the DAW's own context: that one
  // does not exist until the first play, and loading a piano is something
  // people do before they press play.
  const src = stripComments(
    readFileSync(new URL('../src/renderer/daw/engine/sample-library.ts', import.meta.url), 'utf8'));
  assert(!/new AudioContext\(/.test(src), 'a live AudioContext is constructed during load');
  assert(/new OfflineAudioContext\(/.test(src), 'no offline context to decode with');
  // `indexOf` here would find the IMPORT of openSampleLibrary, not the call —
  // which is how the first version of this check passed a break it was
  // written to catch.  Look for the refusal itself, anywhere in the file.
  const ui = stripComments(
    readFileSync(new URL('../src/renderer/components/daw/midi/KeyEditor.tsx', import.meta.url), 'utf8'));
  assert(ui.includes('openSampleLibrary('), 'the load button no longer calls the loader');
  assert(!/엔진이 아직 준비되지/.test(ui), 'the load button still refuses when the engine is not running');
});

console.log('\n=== Sampler — which recording, and how fast ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
if (bad) process.exit(1);
