/**
 * aaf-selftest — interchange, which is only worth anything if it interoperates.
 *
 * A format you can read back yourself proves nothing.  The whole point of an
 * AAF is that a DIFFERENT application wrote it, so the centre of this file is
 * `scripts/fixtures/reference.aaf` — a real AAF written by pyaaf2, an
 * independent implementation, containing the three cases that actually turn
 * up in post:
 *
 *   • audio clips with linked media, a gap between them, and a fade
 *   • a clip whose media has no locator — the "essence is inside the AAF"
 *     case, which must be REPORTED rather than guessed at
 *   • a picture track, which an audio application skips and says so
 *
 * Underneath that sits the container.  MS-CFB is a filesystem in a file with
 * two allocation schemes and a directory ordered by a rule nobody expects, so
 * it is tested on its own before anything is built on it.
 *
 * Run: pnpm --filter @aimaster/desktop test:aaf
 */

import { readFileSync } from 'node:fs';
import { compareNames, readCfb, writeCfb, CfbError } from '../src/renderer/daw/io/cfb.js';
import type { CfbNode } from '../src/renderer/daw/io/cfb.js';
import { readAaf, looksLikeAaf } from '../src/renderer/daw/io/aaf-read.js';
import { writeAaf } from '../src/renderer/daw/io/aaf-write.js';
import { OMF_REFUSAL, looksLikeOmf } from '../src/renderer/daw/io/omf.js';
import { exportAaf, importAaf } from '../src/renderer/daw/io/aaf-actions.js';
import {
  interchangeFromSession, pathToUrl, sessionFromInterchange, urlToPath,
} from '../src/renderer/daw/io/interchange.js';
import type { InterchangeSession } from '../src/renderer/daw/io/interchange.js';
import {
  addFile, addTrack, createClip, createInsert, createSession, createTrack,
  setInsert, trackClips, updateClips, updateTrack,
} from '../src/renderer/daw/model/session-ops.js';
import { createLane } from '../src/renderer/daw/model/automation.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import type { DawSession } from '../src/renderer/daw/model/types.js';

const results: { name: string; pass: boolean }[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true }); console.log(`[PASS] ${name}`); }
  catch (err) {
    results.push({ name, pass: false });
    console.log(`[FAIL] ${name} — ${err instanceof Error ? err.message : String(err)}`);
  }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function eq(a: unknown, b: unknown, m: string): void {
  if (a !== b) throw new Error(`${m} — got ${String(a)}, want ${String(b)}`);
}
function close(a: number, b: number, m: string, tol = 1e-6): void {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${m} — got ${a}, want ${b} ±${tol}`);
}
function throws(fn: () => unknown, needle: string, m: string): void {
  try { fn(); } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (!text.includes(needle)) throw new Error(`${m} — wrong reason: ${text}`);
    return;
  }
  throw new Error(`${m} — nothing was thrown`);
}

// ── The container ─────────────────────────────────────────────────────────────

check('a container round-trips both allocation schemes and an empty stream', () => {
  const big = new Uint8Array(9000);
  for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
  const tree: CfbNode[] = [
    { name: 'Header-2', type: 'stream', data: new TextEncoder().encode('small enough for the mini stream') },
    { name: 'Content', type: 'storage', children: [
      { name: 'properties', type: 'stream', data: new Uint8Array([1, 2, 3]) },
      { name: 'big', type: 'stream', data: big },
    ] },
    { name: 'empty', type: 'stream', data: new Uint8Array(0) },
  ];
  const file = readCfb(writeCfb(tree));
  eq(new TextDecoder().decode(file.streams.get('Header-2')!), 'small enough for the mini stream',
    'a stream under 4096 bytes comes back');
  const back = file.streams.get('Content/big')!;
  eq(back.length, big.length, 'and one over it');
  assert(back.every((v, i) => v === big[i]), 'byte for byte');
  eq(file.streams.get('Content/properties')!.join(','), '1,2,3', 'a three-byte stream');
  eq(file.streams.get('empty')!.length, 0, 'and an empty one');
});

check('siblings sort by LENGTH first — the rule a reader binary-searches by', () => {
  // Not lexicographic.  "bb" before "aaa" because it is shorter, and a
  // container that sorts the other way loses half its entries to a
  // conforming reader.
  eq(['aaa', 'bb', 'a', 'ab'].sort(compareNames).join(','), 'a,ab,bb,aaa', 'ordering');
  eq(compareNames('Header-2', 'MetaDictionary-1') < 0, true, 'and it is why Header comes first');
});

check('the header says what it is, in the bytes a reader checks', () => {
  const bytes = writeCfb([{ name: 'x', type: 'stream', data: new Uint8Array([1]) }]);
  eq([...bytes.subarray(0, 8)].map((b) => b.toString(16)).join(' '), 'd0 cf 11 e0 a1 b1 1a e1', 'signature');
  const view = new DataView(bytes.buffer);
  eq(view.getUint16(28, true), 0xFFFE, 'little-endian marker');
  eq(view.getUint16(30, true), 9, '512-byte sectors');
  eq(view.getUint16(32, true), 6, '64-byte mini sectors');
  eq(view.getUint32(56, true), 4096, 'and the mini-stream cutoff');
  eq(bytes.length % 512, 0, 'the file is a whole number of sectors');
});

check('rubbish is refused before it can be walked', () => {
  throws(() => readCfb(new Uint8Array(600)), 'CFB 서명', 'a file of zeroes');
  throws(() => readCfb(new Uint8Array(4)), '너무 짧습니다', 'a file of four bytes');
  const truncated = writeCfb([{ name: 'x', type: 'stream', data: new Uint8Array(9000) }]);
  throws(() => readCfb(truncated.subarray(0, 1024)), '', 'a file cut in half');
});

check('a name too long for the directory is refused, not truncated', () => {
  throws(
    () => writeCfb([{ name: 'x'.repeat(40), type: 'stream', data: new Uint8Array(1) }]),
    '이름이 너무 깁니다', 'a 40-character name');
});

// ── Reading someone else's AAF ────────────────────────────────────────────────

const reference = (): Uint8Array => {
  const buf = readFileSync(new URL('./fixtures/reference.aaf', import.meta.url));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
};

check('a real AAF from another application reads as the edit it is', () => {
  const bytes = reference();
  assert(looksLikeAaf(bytes), 'it looks like an AAF');
  const ic = readAaf(bytes);
  eq(ic.name, 'Reel 1', 'the composition name');
  eq(ic.sampleRate, 48_000, 'the edit rate');
  eq(ic.tracks.map((t) => t.name).join(','), 'Dialogue,Music', 'the audio tracks, in slot order');

  const dialogue = ic.tracks[0]!;
  eq(dialogue.clips.length, 2, 'two clips');
  close(dialogue.clips[0]!.startSec, 0, 'the first at the top');
  close(dialogue.clips[0]!.durationSec, 2, 'two seconds long');
  close(dialogue.clips[0]!.fadeInSec, 0.25, 'with the fade it was given');
  // The eight-second Filler between them is not a clip — it is the gap.
  close(dialogue.clips[1]!.startSec, 10, 'the second after the gap');
  close(dialogue.clips[1]!.durationSec, 4, 'four seconds long');
  close(dialogue.clips[1]!.sourceOffsetSec, 3, 'three seconds into its file');
  eq(dialogue.clips[0]!.sourceUrl, 'file:///Volumes/Media/dx01.wav', 'and the media it names');
});

check('media that is not linked is REPORTED, never invented', () => {
  const ic = readAaf(reference());
  const music = ic.tracks.find((t) => t.name === 'Music')!;
  eq(music.clips[0]!.sourceUrl, null, 'no url was made up');
  close(music.clips[0]!.startSec, 1, 'but the clip is still placed');
  close(music.clips[0]!.durationSec, 8, 'at its real length');
  assert(ic.problems.some((p) => p.includes('원본 미디어를 찾지 못했습니다')),
    `and it is said out loud: ${ic.problems.join(' | ')}`);
});

check('a picture track is skipped, and named as skipped', () => {
  const ic = readAaf(reference());
  eq(ic.tracks.length, 2, 'the video slot did not become a track');
  assert(ic.problems.some((p) => p.includes('영상 트랙 1개')),
    `and the user is told: ${ic.problems.join(' | ')}`);
});

check('the fixture really is somebody else\'s file', () => {
  // If this ever starts failing it means the fixture was replaced by one of
  // our own, and every test above it stops proving interoperability.
  const file = readCfb(reference());
  const metaStreams = [...file.streams.keys()].filter((k) => k.startsWith('MetaDictionary-1/'));
  assert(metaStreams.length > 100,
    `a full meta dictionary, which this writer does not produce — got ${metaStreams.length}`);
});

// ── Writing ───────────────────────────────────────────────────────────────────

const sample = (): InterchangeSession => ({
  name: 'Reel 1', sampleRate: 48_000, problems: [],
  tracks: [
    { name: 'Dialogue', clips: [
      { name: 'dx01', startSec: 0, durationSec: 2, sourceOffsetSec: 0,
        sourceUrl: 'file:///media/dx01.wav', sourceName: 'dx01.wav', fadeInSec: 0.25, fadeOutSec: 0 },
      { name: 'dx02', startSec: 10, durationSec: 4, sourceOffsetSec: 3,
        sourceUrl: 'file:///media/dx02.wav', sourceName: 'dx02.wav', fadeInSec: 0, fadeOutSec: 0.5 },
    ] },
    { name: 'Music', clips: [
      { name: 'mx01', startSec: 1, durationSec: 8, sourceOffsetSec: 0,
        sourceUrl: 'file:///media/mx01.wav', sourceName: 'mx01.wav', fadeInSec: 0, fadeOutSec: 0 },
    ] },
  ],
});

check('what is written comes back — positions, offsets and fades', () => {
  const { bytes } = writeAaf(sample());
  assert(looksLikeAaf(bytes), 'it is an AAF');
  const ic = readAaf(bytes);
  eq(ic.name, 'Reel 1', 'name');
  eq(ic.tracks.map((t) => t.name).join(','), 'Dialogue,Music', 'tracks in order');
  const dx = ic.tracks[0]!;
  close(dx.clips[0]!.startSec, 0, 'first clip');
  close(dx.clips[0]!.fadeInSec, 0.25, 'its fade in');
  close(dx.clips[1]!.startSec, 10, 'second clip after its gap');
  close(dx.clips[1]!.sourceOffsetSec, 3, 'and into its file');
  close(dx.clips[1]!.fadeOutSec, 0.5, 'and its fade out');
  eq(dx.clips[1]!.sourceUrl, 'file:///media/dx02.wav', 'pointing where it was told');
});

check('the same session written twice is the same file', () => {
  // An export nobody can diff is an export nobody can check.  The mob ids
  // come from a counter and a fixed seed, not from a clock.
  const when = new Date(Date.UTC(2020, 0, 1));
  const a = writeAaf(sample(), { now: when }).bytes;
  const b = writeAaf(sample(), { now: when }).bytes;
  eq(a.length, b.length, 'same length');
  assert(a.every((v, i) => v === b[i]), 'and the same bytes');
});

check('one pair of mobs per file, however many clips use it', () => {
  const twice = sample();
  twice.tracks[0]!.clips.push({
    name: 'dx01 again', startSec: 20, durationSec: 1, sourceOffsetSec: 5,
    sourceUrl: 'file:///media/dx01.wav', sourceName: 'dx01.wav', fadeInSec: 0, fadeOutSec: 0,
  });
  const file = readCfb(writeAaf(twice).bytes);
  const mobs = [...file.clsids.keys()].filter((k) => /Mobs-1901\{[0-9a-f]+\}$/.test(k));
  // three files → three source mobs + three master mobs + one composition
  eq(mobs.length, 7, 'seven mobs for three distinct files and four clips');
  const ic = readAaf(writeAaf(twice).bytes);
  eq(ic.tracks[0]!.clips.length, 3, 'and all three clips are on the track');
  close(ic.tracks[0]!.clips[2]!.sourceOffsetSec, 5, 'the reused file at its own offset');
});

check('an export with nothing to export says so instead of writing an empty file', () => {
  resetIds();
  const empty = createSession('nothing', 48_000);
  throws(() => exportAaf(empty), '내보낼 오디오 클립이 없습니다', 'an empty session');
});

// ── A DAW session, out and back ───────────────────────────────────────────────

function studioSession(): DawSession {
  resetIds();
  let s = createSession('Mix', 48_000);
  const vox = createTrack('Vox', 'audio');
  s = addTrack(s, vox);
  s = addFile(s, {
    id: 'f1', path: '/Volumes/Media/vox.wav', name: 'vox.wav',
    durationSec: 60, sampleRate: 48_000, channels: 2,
  });
  s = updateClips(s, vox.id, () => [
    createClip('f1', 'verse', { startSec: 4, offsetSec: 2, durationSec: 6 }),
  ]);
  s = setInsert(s, vox.id, createInsert(0, 'comp', 'Comp'));
  s = updateTrack(s, vox.id, (t) => ({
    ...t, volumeDb: -3, automation: [createLane({ kind: 'volume' }, 0)],
  }));
  return s;
}

check('a session becomes an edit, and everything else is named as left behind', () => {
  const ic = interchangeFromSession(studioSession());
  eq(ic.tracks.length, 1, 'one audio track');
  close(ic.tracks[0]!.clips[0]!.startSec, 4, 'the clip where it sits');
  close(ic.tracks[0]!.clips[0]!.sourceOffsetSec, 2, 'and where it starts in the file');
  assert(ic.problems.some((p) => p.includes('인서트')), `plugins: ${ic.problems.join(' | ')}`);
  assert(ic.problems.some((p) => p.includes('오토메이션')), 'automation');
  assert(ic.problems.some((p) => p.includes('페이더')), 'fader and pan');
});

check('a clip with no file on disk is not written as a phantom', () => {
  resetIds();
  let s = createSession('Mix', 48_000);
  const t = createTrack('Vox', 'audio');
  s = addTrack(s, t);
  s = addFile(s, { id: 'f1', path: '', name: 'recording', durationSec: 5, sampleRate: 48_000, channels: 2 });
  s = updateClips(s, t.id, () => [createClip('f1', 'take', { startSec: 0, durationSec: 5 })]);
  const ic = interchangeFromSession(s);
  eq(ic.tracks.length, 0, 'nothing to export');
  assert(ic.problems.some((p) => p.includes('원본 파일 경로가 없어')), `and it says why: ${ic.problems}`);
});

check('an imported AAF becomes a session whose clips are where the file said', () => {
  const result = importAaf(reference());
  const audio = result.session.tracks.filter((t) => t.kind === 'audio');
  eq(audio.length, 2, 'two tracks');
  const clips = trackClips(audio[0]!);
  close(clips[0]!.startSec, 0, 'first clip');
  close(clips[1]!.startSec, 10, 'second clip');
  close(clips[1]!.offsetSec, 3, 'at its source offset');
  eq(result.mediaPaths[0], '/Volumes/Media/dx01.wav', 'and the media path it came with');
  // The audio is NOT here — the paths are somebody else's machine.
  assert(result.session.files.every((f) => f.path === '' || f.path.startsWith('/')),
    'file references were built from the URLs');
});

check('a round trip through the format keeps the edit', () => {
  const before = studioSession();
  const written = exportAaf(before, new Date(0));
  const back = importAaf(written.bytes);
  const track = back.session.tracks.find((t) => t.kind === 'audio')!;
  const clip = trackClips(track)[0]!;
  eq(track.name, 'Vox', 'the track name survived');
  close(clip.startSec, 4, 'the clip position');
  close(clip.offsetSec, 2, 'the source offset');
  close(clip.durationSec, 6, 'the length');
});

// ── OMF ───────────────────────────────────────────────────────────────────────

check('an OMF is recognised as an OMF and refused with the reason', () => {
  // A Bento container: the tag at the front, the label at the back.
  const omf = new Uint8Array(4096);
  omf.set([0x4F, 0x4D, 0x46, 0x49], 8);              // "OMFI"
  omf.set([0xA4, 0x43, 0x4D, 0xA4], omf.length - 64); // Bento label
  assert(looksLikeOmf(omf), 'detected');
  assert(!looksLikeAaf(omf), 'and not mistaken for an AAF');
  throws(() => importAaf(omf), 'OMF 파일입니다', 'refused as OMF');
  assert(OMF_REFUSAL.includes('AAF 로 다시'), 'and it says what to ask for instead');
});

check('a file that is neither gets a different answer', () => {
  const noise = new TextEncoder().encode('this is a text file, not an interchange format at all');
  assert(!looksLikeOmf(noise) && !looksLikeAaf(noise), 'neither');
  throws(() => importAaf(noise), 'AAF 파일이 아닙니다', 'refused as not-an-AAF');
});

check('an AAF is never mistaken for an OMF', () => {
  const bytes = reference();
  assert(looksLikeAaf(bytes), 'it is an AAF');
  // Even if the letters O M F I happen to appear in a path inside it.
  const ic = importAaf(bytes);
  eq(ic.interchange.tracks.length, 2, 'and it imports');
});

// ── Paths ─────────────────────────────────────────────────────────────────────

check('URLs and paths convert both ways, including the awkward characters', () => {
  eq(urlToPath('file:///Volumes/Media/dx01.wav'), '/Volumes/Media/dx01.wav', 'plain');
  eq(urlToPath('file:///a/b%20c.wav'), '/a/b c.wav', 'an escaped space');
  eq(urlToPath('/already/a/path.wav'), '/already/a/path.wav', 'something that is not a URL');
  eq(pathToUrl('/a/b c.wav'), 'file:///a/b%20c.wav', 'and back again');
  eq(urlToPath(pathToUrl('/Volumes/한글 폴더/보컬.wav')), '/Volumes/한글 폴더/보컬.wav', 'round trip');
});

check('an interchange session builds real tracks, clips and file references', () => {
  resetIds();
  const built = sessionFromInterchange(sample());
  eq(built.session.tracks.filter((t) => t.kind === 'audio').length, 2, 'two tracks');
  eq(built.session.files.length, 3, 'three files');
  eq(built.mediaUrls.length, 3, 'three media urls to relink');
  const first = trackClips(built.session.tracks.find((t) => t.name === 'Dialogue')!)[0]!;
  close(first.fadeIn.durationSec, 0.25, 'and the fade came across');
});

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} passed${passed === results.length ? '' : `, ${results.length - passed} FAILED`}`);
if (passed !== results.length) process.exit(1);
