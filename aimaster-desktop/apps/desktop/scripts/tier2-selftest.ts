/**
 * tier2-selftest.ts — hiding tracks, copying a channel, fading an overlap.
 *
 * Three small verbs whose failures are all silent:
 *
 *   · a hidden track that stops playing is a mute wearing a view control's
 *     clothes, and the person will look for the fault in the mixer
 *   · a pasted channel that shares its insert objects gives two channels
 *     that edit each other, found weeks later
 *   · an auto crossfade shorter than the overlap leaves part of it at
 *     doubled level, which reads as "the edit is louder than the take"
 *
 * Run via:  pnpm --filter @aimaster/desktop test:tier2
 */

import {
  hiddenCount, isHidden, setTracksHidden, showAllTracks, visibleTracks,
} from '../src/renderer/daw/model/stacks.js';
import {
  channelSettings, describeChannel, pasteChannelSettings,
} from '../src/renderer/daw/edit/channel-ops.js';
import {
  autoCrossfadeTrack, describeAutoFade, overlapLength, overlapsOn,
  MAX_AUTO_FADE_SEC, MIN_AUTO_FADE_SEC,
} from '../src/renderer/daw/edit/auto-fade.js';
import {
  addTrack, createClip, createSession, createTrack, findTrack, trackClips, updateClips,
  updateTrack,
} from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import type { Clip, DawSession, Insert, TrackId } from '../src/renderer/daw/model/types.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function near(a: number, b: number, eps: number, m: string): void {
  if (!(Math.abs(a - b) <= eps)) throw new Error(`${m} — ${a} vs ${b}`);
}

function song(): { session: DawSession; ids: Record<string, TrackId> } {
  resetIds();
  let s = createSession('t2', 48_000);
  for (const n of ['Vox', 'Gtr', 'Bass']) s = addTrack(s, createTrack(n, 'audio'));
  const ids = Object.fromEntries(
    s.tracks.filter((t) => t.kind === 'audio').map((t) => [t.name, t.id]),
  ) as Record<string, TrackId>;
  return { session: s, ids };
}

// ── Hiding tracks ────────────────────────────────────────────────────────────

check('a hidden track leaves the arrange rows but stays in the session', () => {
  // The whole point: it is a view control, not a mute.  A track that vanished
  // from `session.tracks` would stop playing and stop bouncing, and the
  // person would go looking in the mixer for a fault that is not there.
  const { session, ids } = song();
  const after = setTracksHidden(session, [ids.Gtr!], true);
  assert(!visibleTracks(after).some((t) => t.id === ids.Gtr), 'gone from the rows');
  assert(after.tracks.some((t) => t.id === ids.Gtr), 'still in the session');
  assert(isHidden(after, ids.Gtr!), 'and it says so');
});

check('the master can never be hidden', () => {
  const { session } = song();
  const master = session.tracks.find((t) => t.kind === 'master')!;
  const after = setTracksHidden(session, [master.id], true);
  assert(!isHidden(after, master.id), 'a session with no master row is unusable');
});

check('showing all brings back everything, and only when there is something to bring', () => {
  const { session, ids } = song();
  const hidden = setTracksHidden(session, [ids.Gtr!, ids.Bass!], true);
  assert(hiddenCount(hidden) === 2, `${hiddenCount(hidden)} hidden`);
  const shown = showAllTracks(hidden);
  assert(hiddenCount(shown) === 0, 'all back');
  // Identity, so a keypress on a session with nothing hidden is not an undo step.
  assert(showAllTracks(shown) === shown, 'nothing to do returns the same session');
});

check('hiding is separate from a collapsed stack', () => {
  const { session, ids } = song();
  const after = setTracksHidden(session, [ids.Vox!], true);
  assert(isHidden(after, ids.Vox!), 'by its own flag');
  assert(!isHidden(after, ids.Gtr!), 'and its neighbours are unaffected');
});

// ── Copying a channel ────────────────────────────────────────────────────────

const insert = (slot: number, pluginId: string, params: Record<string, number>): Insert => ({
  id: `ins-${slot}`, slot, pluginId, label: pluginId, bypass: false,
  latencySamples: 0, params, sidechainSource: null,
});

function withChain(session: DawSession, trackId: TrackId): DawSession {
  return updateTrack(session, trackId, (t) => ({
    ...t,
    volumeDb: -4.5,
    pan: -0.3,
    inserts: [insert(0, 'eq8', { gain1: 3 }), insert(1, 'comp', { ratio: 4 })],
  }));
}

check('the processing comes across', () => {
  const { session, ids } = song();
  const from = withChain(session, ids.Vox!);
  const settings = channelSettings(from, ids.Vox!)!;
  const after = pasteChannelSettings(from, ids.Gtr!, settings);
  const gtr = findTrack(after, ids.Gtr!)!;
  assert(gtr.inserts.length === 2, `${gtr.inserts.length} inserts`);
  near(gtr.volumeDb, -4.5, 1e-9, 'the fader');
  near(gtr.pan, -0.3, 1e-9, 'the pan');
  near(gtr.inserts[0]!.params.gain1 ?? 0, 3, 1e-9, 'and the settings inside them');
});

check('the pasted inserts share NO ids with the source', () => {
  // Otherwise the two channels edit each other, and it is weeks before
  // anyone works out why moving one threshold moved another.
  const { session, ids } = song();
  const from = withChain(session, ids.Vox!);
  const after = pasteChannelSettings(from, ids.Gtr!, channelSettings(from, ids.Vox!)!);
  const source = findTrack(after, ids.Vox!)!;
  const copy = findTrack(after, ids.Gtr!)!;
  const sourceIds = new Set(source.inserts.map((i) => i.id));
  for (const i of copy.inserts) assert(!sourceIds.has(i.id), `insert ${i.id} is shared`);
  assert(copy.inserts[0]!.params !== source.inserts[0]!.params, 'nor the params object');
});

check('what makes the channel that channel stays put', () => {
  const { session, ids } = song();
  let from = withChain(session, ids.Vox!);
  from = updateClips(from, ids.Gtr!, () => [
    createClip('f', 'riff', { startSec: 0, offsetSec: 0, durationSec: 4 }),
  ]);
  const after = pasteChannelSettings(from, ids.Gtr!, channelSettings(from, ids.Vox!)!);
  const gtr = findTrack(after, ids.Gtr!)!;
  assert(gtr.name === 'Gtr', 'the name');
  assert(trackClips(gtr).length === 1, 'the clips');
});

check('keepLevels pastes the processing and leaves the balance alone', () => {
  const { session, ids } = song();
  const from = withChain(session, ids.Vox!);
  const target = updateTrack(from, ids.Gtr!, (t) => ({ ...t, volumeDb: -12, pan: 0.5 }));
  const after = pasteChannelSettings(target, ids.Gtr!, channelSettings(from, ids.Vox!)!, { keepLevels: true });
  const gtr = findTrack(after, ids.Gtr!)!;
  near(gtr.volumeDb, -12, 1e-9, 'the fader stayed');
  near(gtr.pan, 0.5, 1e-9, 'and the pan');
  assert(gtr.inserts.length === 2, 'but the chain arrived');
});

check('the clipboard describes what is on it', () => {
  const { session, ids } = song();
  const settings = channelSettings(withChain(session, ids.Vox!), ids.Vox!)!;
  const text = describeChannel(settings);
  assert(text.includes('Vox'), text);
  assert(text.includes('2'), text);
});

check('copying a track that is not there gives nothing to paste', () => {
  const { session } = song();
  assert(channelSettings(session, 'nope') === null, 'null, not a half-copy');
});

// ── Auto crossfade ───────────────────────────────────────────────────────────

const clip = (startSec: number, durationSec: number, name = 'c'): Clip =>
  createClip('f', name, { startSec, offsetSec: 0, durationSec });

function twoClips(a: Clip, b: Clip): { session: DawSession; id: TrackId } {
  resetIds();
  let s = createSession('x', 48_000);
  s = addTrack(s, createTrack('A', 'audio'));
  const id = s.tracks.find((t) => t.kind === 'audio')!.id;
  s = updateClips(s, id, () => [a, b]);
  return { session: s, id };
}

check('an overlap is found, and its length is the overlap', () => {
  const overlaps = overlapsOn([clip(0, 4), clip(3, 4)]);
  assert(overlaps.length === 1, `${overlaps.length} overlaps`);
  near(overlapLength(overlaps[0]!), 1, 1e-9, 'one second of it');
});

check('clips that only touch are not an overlap', () => {
  assert(overlapsOn([clip(0, 4), clip(4, 4)]).length === 0, 'butting is the manual crossfade’s job');
});

check('the fade covers the WHOLE overlap', () => {
  // Anything shorter leaves part of the overlap at doubled level, which is
  // the loudness bump people hear as "the edit is louder than the take".
  const { session, id } = twoClips(clip(0, 4), clip(3.7, 4));
  const after = autoCrossfadeTrack(session, id);
  const clips = trackClips(findTrack(after, id)!);
  near(clips[0]!.fadeOut.durationSec, 0.3, 1e-9, 'the earlier clip fades out over it');
  near(clips[1]!.fadeIn.durationSec, 0.3, 1e-9, 'and the later one in');
  assert(clips[0]!.fadeOut.shape === 'equalPower', 'equal power, not linear');
});

check('a long overlap is capped rather than blended for seconds', () => {
  const { session, id } = twoClips(clip(0, 8), clip(2, 8));
  const clips = trackClips(findTrack(autoCrossfadeTrack(session, id), id)!);
  near(clips[0]!.fadeOut.durationSec, MAX_AUTO_FADE_SEC, 1e-9, 'held at the cap');
});

check('a rounding-error overlap is left alone', () => {
  const { session, id } = twoClips(clip(0, 4), clip(4 - MIN_AUTO_FADE_SEC / 2, 4));
  assert(autoCrossfadeTrack(session, id) === session, 'nothing worth fading');
});

check('a fade drawn by hand is never shortened', () => {
  // An "auto" feature that quietly undoes a decision is one people switch off.
  const long = { ...clip(0, 4), fadeOut: { durationSec: 1.5, shape: 'sCurve' as const } };
  const { session, id } = twoClips(long, clip(3.8, 4));
  const clips = trackClips(findTrack(autoCrossfadeTrack(session, id), id)!);
  near(clips[0]!.fadeOut.durationSec, 1.5, 1e-9, 'the hand-drawn one survived');
});

check('a fade can never be longer than half its clip', () => {
  // The two fades on one clip must not pass through each other.
  const { session, id } = twoClips(clip(0, 0.2), clip(0.05, 4));
  const clips = trackClips(findTrack(autoCrossfadeTrack(session, id), id)!);
  assert(clips[0]!.fadeOut.durationSec <= 0.1 + 1e-9,
    `${clips[0]!.fadeOut.durationSec} on a 0.2 s clip`);
});

check('a track with no overlaps is returned untouched', () => {
  const { session, id } = twoClips(clip(0, 2), clip(4, 2));
  assert(autoCrossfadeTrack(session, id) === session, 'the same session back');
});

check('three stacked clips fade adjacent pairs only', () => {
  const { session, id } = twoClips(clip(0, 4), clip(2, 4));
  const three = updateClips(session, id, (clips) => [...clips, clip(3, 4, 'third')]);
  const after = autoCrossfadeTrack(three, id);
  const clips = trackClips(findTrack(after, id)!);
  assert(clips.every((c) => c.fadeIn.durationSec >= 0 && c.fadeOut.durationSec >= 0), 'no negatives');
  assert(clips[1]!.fadeIn.durationSec > 0 && clips[1]!.fadeOut.durationSec > 0,
    'the middle one fades both ways');
});

check('the report counts the fades it would write', () => {
  const text = describeAutoFade(overlapsOn([clip(0, 4), clip(3, 4)]));
  assert(text.includes('1군데'), text);
  assert(describeAutoFade([]).includes('겹친 곳이 없습니다'), describeAutoFade([]));
});

// ─────────────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Hide · channel copy · auto crossfade ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
