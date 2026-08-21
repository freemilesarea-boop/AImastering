/**
 * daw-selftest.ts — the Pro Tools-shaped DAW layer (DAW-CORE-1).
 *
 * Covers every pure layer the Edit and Mix windows stand on: the session
 * model, the editing verbs, transient detection and Tab navigation,
 * automation, mixer maths (pan / solo / VCA / groups), routing + delay
 * compensation, playlists and comping, session import, and WAV encoding.
 *
 * The audio engine classes need a real AudioContext, so they are exercised in
 * the app; everything they DERIVE their behaviour from is tested here.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:daw
 */

import {
  addTrack, createSession, createTrack, createClip, createBus, createGroup, addGroup,
  removeTrack, moveTrack, updateClips, trackClips, activePlaylist, clipAt, clipEnd,
  sessionEndSec, createInsert, setInsert, createSend, setSend, findTrack, addFile,
} from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import { shouldAdoptQueue } from '../src/renderer/daw/model/import-audio.js';
import { planDrop, isEmptyPlan } from '../src/renderer/daw/model/drop-target.js';
import { evictionPlan } from '../src/renderer/daw/engine/audio-cache.js';
import { decodeContext, resetDecodeContext, DECODE_SAMPLE_RATE } from '../src/renderer/audio/decode-context.js';
import {
  separateAt, splitClip, healSeparation, isHealable, trimToSelection, clearRange,
  duplicateSelection, nudgeSelection, slipSelection, setClipGain, nudgeClipGain,
  fadeToCursor, crossfadeAt, clipBoundaries, selectionToClipBounds, trimClipStart,
  trimClipEnd, applyConsolidation, CLIP_GAIN_MAX_DB, type TimeSelection,
} from '../src/renderer/daw/edit/clip-edit.js';
import {
  detectTransients, peakEnvelope, mergeMarks, nextAfter, prevBefore,
} from '../src/renderer/daw/edit/transient.js';
import { editPoints, tabForward, tabBackward, extendToNextPoint } from '../src/renderer/daw/edit/navigation.js';
import {
  createLane, valueAt, insertPoint, removePointsInRange, writeRange, touchWrite,
  trimRange, thinPoints, isWritingMode,
} from '../src/renderer/daw/model/automation.js';
import {
  dbToGain, gainToDb, panGains, vcaChainDb, effectiveFaderDb, anySoloActive,
  isImplicitlyMuted, isAudible, isMutedByVca, setVolumeDb, setPan, toggleMute,
  toggleSolo, clearAllSolo, linkedMembers,
} from '../src/renderer/daw/model/mixer-math.js';
import {
  buildRouteGraph, detectFeedback, wouldFeedback, insertLatency, pathLatency,
  computeDelayCompensation, describePath, trackNode, busNode, MASTER_NODE,
} from '../src/renderer/daw/model/routing.js';
import {
  addPlaylist, duplicatePlaylist, cyclePlaylist, compRange, sliceClips,
  flattenComp, removePlaylist, setActivePlaylist, alternateLanes,
} from '../src/renderer/daw/edit/comping.js';
import {
  serializeDawSession, deserializeDawSession, importSessionData, uniqueName,
} from '../src/renderer/daw/model/session-io.js';
import { encodeWav, interleave } from '../src/renderer/daw/engine/wav.js';
import { PLUGINS, defaultParams, findPlugin, pluginLatencySamples, timeConstantToHz } from '../src/renderer/daw/engine/plugins.js';
import type { Clip, DawSession, Track } from '../src/renderer/daw/model/types.js';

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
  if (Math.abs(a - b) > tol) throw new Error(`${m} — got ${a}, want ${b}`);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Session with one audio track holding one 10 s clip starting at 0. */
function fixture(): { session: DawSession; trackId: string; clipId: string } {
  resetIds();
  let session = createSession('Test');
  const track = createTrack('Vox', 'audio');
  session = addTrack(session, track);
  session = addFile(session, {
    id: 'file-a', path: '/songs/vox.wav', name: 'vox.wav',
    durationSec: 30, sampleRate: 48_000, channels: 2,
  });
  const clip = createClip('file-a', 'vox', { startSec: 0, offsetSec: 0, durationSec: 10 });
  session = updateClips(session, track.id, () => [clip]);
  return { session, trackId: track.id, clipId: clip.id };
}

const sel = (startSec: number, endSec: number, trackIds: string[]): TimeSelection =>
  ({ startSec, endSec, trackIds });

// ── Session model ────────────────────────────────────────────────────────────

check('createSession starts with a master track', () => {
  const s = createSession();
  eq(s.tracks.length, 1, 'one track');
  eq(s.tracks[0]!.kind, 'master', 'is master');
});

check('addTrack keeps the master last, removeTrack refuses the master', () => {
  let s = createSession();
  s = addTrack(s, createTrack('A'));
  s = addTrack(s, createTrack('B'));
  eq(s.tracks.map((t) => t.name).join(','), 'A,B,Master', 'order');
  const master = s.tracks.find((t) => t.kind === 'master')!;
  eq(removeTrack(s, master.id), s, 'master cannot be removed');
  s = removeTrack(s, s.tracks[0]!.id);
  eq(s.tracks.map((t) => t.name).join(','), 'B,Master', 'after remove');
});

check('moveTrack cannot push a track past the master', () => {
  let s = createSession();
  s = addTrack(s, createTrack('A'));
  s = addTrack(s, createTrack('B'));
  s = moveTrack(s, s.tracks[0]!.id, 99);
  eq(s.tracks.map((t) => t.name).join(','), 'B,A,Master', 'clamped before master');
});

check('clips stay sorted and are addressable by time', () => {
  const { session, trackId } = fixture();
  const s = updateClips(session, trackId, (clips) => [
    createClip('file-a', 'late', { startSec: 20, durationSec: 5 }),
    ...clips,
  ]);
  const track = findTrack(s, trackId)!;
  eq(trackClips(track).map((c) => c.startSec).join(','), '0,20', 'sorted');
  eq(clipAt(track, 3)?.name, 'vox', 'clip at 3s');
  eq(clipAt(track, 15), undefined, 'gap has no clip');
  eq(sessionEndSec(s), 25, 'session end');
});

// ── Editing verbs ────────────────────────────────────────────────────────────

check('separate splits a clip and keeps the source offsets exact', () => {
  const { session, trackId } = fixture();
  const s = separateAt(session, [trackId], 4);
  const clips = trackClips(findTrack(s, trackId)!);
  eq(clips.length, 2, 'two clips');
  const [head, tail] = clips as [Clip, Clip];
  close(head.durationSec, 4, 'head length');
  close(tail.startSec, 4, 'tail start');
  close(tail.offsetSec, 4, 'tail reads the source from 4 s');
  close(tail.durationSec, 6, 'tail length');
});

check('separate on a clip boundary is a no-op', () => {
  const { session, trackId } = fixture();
  eq(separateAt(session, [trackId], 0), session, 'at start');
  eq(separateAt(session, [trackId], 10), session, 'at end');
  eq(separateAt(session, [trackId], 50), session, 'past the end');
});

check('splitClip preserves total duration and drops the inner fades', () => {
  const clip = createClip('f', 'c', {
    startSec: 2, offsetSec: 1, durationSec: 8,
    fadeIn: { durationSec: 0.5, shape: 'linear' },
    fadeOut: { durationSec: 0.5, shape: 'linear' },
  });
  const [a, b] = splitClip(clip, 5);
  close(a.durationSec + b.durationSec, 8, 'total length');
  close(b.offsetSec, 4, 'offset follows the cut');
  eq(a.fadeOut.durationSec, 0, 'head loses its fade out');
  eq(b.fadeIn.durationSec, 0, 'tail loses its fade in');
  close(a.fadeIn.durationSec, 0.5, 'outer fade in kept');
  close(b.fadeOut.durationSec, 0.5, 'outer fade out kept');
});

check('heal rejoins an untouched separation but refuses a slipped one', () => {
  const { session, trackId } = fixture();
  const cut = separateAt(session, [trackId], 4);
  const healed = healSeparation(cut, sel(0, 10, [trackId]));
  eq(trackClips(findTrack(healed, trackId)!).length, 1, 'healed back to one');

  const moved = nudgeSelection(cut, sel(4, 10, [trackId]), 1);
  const notHealed = healSeparation(moved, sel(0, 12, [trackId]));
  eq(trackClips(findTrack(notHealed, trackId)!).length, 2, 'moved clips are not healed');
});

check('isHealable refuses clips with different gain or file', () => {
  const a = createClip('f', 'a', { startSec: 0, offsetSec: 0, durationSec: 5 });
  const b = createClip('f', 'b', { startSec: 5, offsetSec: 5, durationSec: 5 });
  assert(isHealable(a, b), 'contiguous');
  assert(!isHealable(a, { ...b, gainDb: 3 }), 'gain differs');
  assert(!isHealable(a, { ...b, fileId: 'other' }), 'file differs');
  assert(!isHealable(a, { ...b, offsetSec: 9 }), 'slipped');
});

check('trim to selection keeps only the selected audio', () => {
  const { session, trackId } = fixture();
  const s = trimToSelection(session, sel(3, 7, [trackId]));
  const clips = trackClips(findTrack(s, trackId)!);
  eq(clips.length, 1, 'one clip');
  close(clips[0]!.startSec, 3, 'start');
  close(clips[0]!.durationSec, 4, 'duration');
  close(clips[0]!.offsetSec, 3, 'source offset follows');
});

check('clear range leaves a gap in slip mode and closes it in shuffle', () => {
  const { session, trackId } = fixture();
  const slip = clearRange(session, sel(2, 4, [trackId]), false);
  const slipClips = trackClips(findTrack(slip, trackId)!);
  eq(slipClips.length, 2, 'split into two');
  close(slipClips[1]!.startSec, 4, 'gap kept');

  const shuffle = clearRange(session, sel(2, 4, [trackId]), true);
  const shuffleClips = trackClips(findTrack(shuffle, trackId)!);
  close(shuffleClips[1]!.startSec, 2, 'gap closed');
  close(shuffleClips[0]!.durationSec + shuffleClips[1]!.durationSec, 8, 'two seconds gone');
});

check('duplicate places copies immediately after the selection', () => {
  const { session, trackId } = fixture();
  const s = duplicateSelection(session, sel(0, 4, [trackId]), 2);
  const clips = trackClips(findTrack(s, trackId)!);
  const starts = clips.map((c) => Math.round(c.startSec * 100) / 100);
  assert(starts.includes(4) && starts.includes(8), `copies at 4 and 8 — got ${starts.join(',')}`);
});

check('nudge moves clips, slip moves the audio inside them', () => {
  const { session, trackId } = fixture();
  const nudged = nudgeSelection(session, sel(0, 10, [trackId]), 1.5);
  close(trackClips(findTrack(nudged, trackId)!)[0]!.startSec, 1.5, 'nudged start');
  close(trackClips(findTrack(nudged, trackId)!)[0]!.offsetSec, 0, 'offset untouched');

  const slipped = slipSelection(session, sel(0, 10, [trackId]), 2);
  close(trackClips(findTrack(slipped, trackId)!)[0]!.startSec, 0, 'position untouched');
  close(trackClips(findTrack(slipped, trackId)!)[0]!.offsetSec, 2, 'source slipped');
});

check('clip gain is clamped and nudges by exact steps', () => {
  const { session, trackId } = fixture();
  let s = setClipGain(session, sel(0, 10, [trackId]), 6);
  close(trackClips(findTrack(s, trackId)!)[0]!.gainDb, 6, 'set');
  s = nudgeClipGain(s, sel(0, 10, [trackId]), -0.5);
  close(trackClips(findTrack(s, trackId)!)[0]!.gainDb, 5.5, 'nudged');
  s = setClipGain(s, sel(0, 10, [trackId]), 999);
  close(trackClips(findTrack(s, trackId)!)[0]!.gainDb, CLIP_GAIN_MAX_DB, 'clamped');
});

check('fade to cursor sets the fade length from the clip edge', () => {
  const { session, trackId } = fixture();
  const inFade = fadeToCursor(session, [trackId], 2, 'in');
  close(trackClips(findTrack(inFade, trackId)!)[0]!.fadeIn.durationSec, 2, 'fade in');
  const outFade = fadeToCursor(session, [trackId], 7, 'out');
  close(trackClips(findTrack(outFade, trackId)!)[0]!.fadeOut.durationSec, 3, 'fade out');
  // A cursor outside the clip changes nothing.
  eq(fadeToCursor(session, [trackId], 50, 'in'), session, 'outside the clip');
});

check('crossfade fades both sides of an abutting boundary', () => {
  const { session, trackId } = fixture();
  const cut = separateAt(session, [trackId], 5);
  const faded = crossfadeAt(cut, [trackId], 5, 0.4);
  const clips = trackClips(findTrack(faded, trackId)!);
  close(clips[0]!.fadeOut.durationSec, 0.2, 'head fade out');
  close(clips[1]!.fadeIn.durationSec, 0.2, 'tail fade in');
});

check('trimClipStart / End keep the source aligned', () => {
  const clip = createClip('f', 'c', { startSec: 10, offsetSec: 3, durationSec: 6 });
  const head = trimClipStart(clip, 12);
  close(head.startSec, 12, 'start'); close(head.offsetSec, 5, 'offset'); close(head.durationSec, 4, 'duration');
  const tail = trimClipEnd(clip, 14);
  close(tail.durationSec, 4, 'trimmed duration'); close(tail.offsetSec, 3, 'offset untouched');
});

check('clip boundaries and selection-to-clip-bounds', () => {
  const { session, trackId } = fixture();
  const cut = separateAt(session, [trackId], 4);
  eq(clipBoundaries(cut, [trackId]).join(','), '0,4,10', 'edges');
  const grown = selectionToClipBounds(cut, sel(5, 6, [trackId]));
  close(grown.startSec, 4, 'grew to clip start');
  close(grown.endSec, 10, 'grew to clip end');
});

check('consolidation replaces the range with one clip', () => {
  const { session, trackId } = fixture();
  const cut = separateAt(session, [trackId], 4);
  const done = applyConsolidation(cut, trackId, sel(0, 10, [trackId]), 'file-new', 'merged');
  const clips = trackClips(findTrack(done, trackId)!);
  eq(clips.length, 1, 'single clip');
  eq(clips[0]!.fileId, 'file-new', 'new source');
  close(clips[0]!.durationSec, 10, 'covers the range');
});

// ── Transients ───────────────────────────────────────────────────────────────

/** Impulse train: a decaying hit every `everySec`. */
function impulses(sampleRate: number, seconds: number, everySec: number): Float32Array {
  const out = new Float32Array(Math.floor(sampleRate * seconds));
  for (let t = 0; t < seconds; t += everySec) {
    const at = Math.floor(t * sampleRate);
    for (let i = 0; i < sampleRate * 0.02 && at + i < out.length; i++) {
      out[at + i] = Math.exp(-i / (sampleRate * 0.004)) * Math.sin(i * 0.3);
    }
  }
  return out;
}

check('peakEnvelope reduces to one value per hop', () => {
  const env = peakEnvelope(new Float32Array([0, 0.5, -0.9, 0.1, 0.2, 0]), 2);
  eq(env.length, 3, 'hop count');
  close(env[1] ?? 0, 0.9, 'rectified peak');
});

check('detectTransients finds every hit in an impulse train', () => {
  const sr = 48_000;
  const marks = detectTransients(impulses(sr, 2, 0.5), sr);
  eq(marks.length, 4, `4 hits — got ${marks.length}`);
  close(marks[0] ?? -1, 0, 'first at 0', 0.01);
  close(marks[1] ?? -1, 0.5, 'second at 0.5', 0.01);
});

check('detectTransients ignores silence and respects minimum spacing', () => {
  const sr = 48_000;
  eq(detectTransients(new Float32Array(sr), sr).length, 0, 'silence');
  const dense = detectTransients(impulses(sr, 1, 0.01), sr, { minSpacingSec: 0.2 });
  assert(dense.length <= 6, `spacing honoured — got ${dense.length}`);
});

check('mark navigation moves strictly forward / backward', () => {
  const marks = mergeMarks([0, 1, 2], [1, 3]);
  eq(marks.join(','), '0,1,2,3', 'merged + deduped');
  eq(nextAfter(marks, 1), 2, 'next');
  eq(prevBefore(marks, 1), 0, 'prev');
  eq(nextAfter(marks, 3), null, 'end');
  eq(prevBefore(marks, 0), null, 'start');
});

// ── Tab navigation ───────────────────────────────────────────────────────────

check('editPoints maps transients through the clip offset', () => {
  const { session, trackId } = fixture();
  // Clip plays the file from 0; a transient at 2 s in the file is at 2 s.
  const points = editPoints(session, [trackId], true, () => [2, 40]);
  assert(points.includes(2), 'transient inside the clip');
  assert(!points.includes(40), 'transient past the clip is dropped');

  const slipped = slipSelection(session, sel(0, 10, [trackId]), 1);
  const slippedPoints = editPoints(slipped, [trackId], true, () => [2]);
  assert(slippedPoints.includes(1), 'offset shifts the transient into timeline time');
});

check('Tab moves to the next edit point, then to the session end', () => {
  const { session, trackId } = fixture();
  const cut = separateAt(session, [trackId], 4);
  const points = editPoints(cut, [trackId], false, () => []);
  eq(tabForward(points, 0, 10).timeSec, 4, 'forward to the cut');
  eq(tabForward(points, 4, 10).timeSec, 10, 'forward to the end');
  eq(tabForward(points, 10, 10).kind, 'session-end', 'past the last point');
  eq(tabBackward(points, 10).timeSec, 4, 'backward to the cut');
  eq(tabBackward(points, 0).kind, 'session-start', 'before the first point');
});

check('Tab with a range selected extends the range', () => {
  const points = [0, 2, 4, 6];
  const extended = extendToNextPoint(points, { startSec: 2, endSec: 4 }, 1);
  eq(extended.endSec, 6, 'grew forward');
  const back = extendToNextPoint(points, { startSec: 2, endSec: 4 }, -1);
  eq(back.startSec, 0, 'grew backward');
});

// ── Automation ───────────────────────────────────────────────────────────────

check('lane interpolation is linear with flat ends', () => {
  const lane = { ...createLane({ kind: 'volume' }, 0), points: [
    { timeSec: 1, value: 0 }, { timeSec: 3, value: 10 },
  ] };
  close(valueAt(lane, 0, -99), 0, 'before the first point');
  close(valueAt(lane, 2, -99), 5, 'midpoint');
  close(valueAt(lane, 9, -99), 10, 'after the last point');
  eq(valueAt({ ...lane, mode: 'off' }, 2, -99), -99, 'off → fallback');
});

check('insertPoint replaces a near-duplicate and keeps order', () => {
  let lane = createLane({ kind: 'volume' }, 0);
  lane = insertPoint(lane, { timeSec: 5, value: 3 });
  lane = insertPoint(lane, { timeSec: 2, value: 1 });
  lane = insertPoint(lane, { timeSec: 5.00001, value: 9 });
  eq(lane.points.map((p) => p.timeSec).join(','), '0,2,5.00001', 'sorted, merged');
  close(lane.points[2]!.value, 9, 'replaced value');
});

check('writeRange anchors both edges so the rest of the pass survives', () => {
  let lane = createLane({ kind: 'volume' }, 0);
  lane = insertPoint(lane, { timeSec: 10, value: 6 });
  const written = writeRange(lane, 2, 4, [{ timeSec: 3, value: -6 }], 0);
  // The boundary anchor sits 1 ms outside the range, so the pre-range shape is
  // preserved to within that step.
  close(valueAt(written, 1, 0), valueAt(lane, 1, 0), 'before the range untouched', 2e-3);
  close(valueAt(written, 3, 0), -6, 'inside the range written');
  close(valueAt(written, 10, 0), 6, 'after the range untouched');
});

check('touch returns to the underlying pass after the gesture', () => {
  let lane = createLane({ kind: 'volume' }, 0);
  lane = insertPoint(lane, { timeSec: 10, value: 12 });
  const touched = touchWrite(lane, 2, 4, [{ timeSec: 2, value: -20 }, { timeSec: 4, value: -20 }], 0, 0.2);
  close(valueAt(touched, 3, 0), -20, 'held during the touch');
  const after = valueAt(touched, 4.2, 0);
  assert(after > -20, `returns toward the pass — got ${after}`);
});

check('trim shifts only the breakpoints inside the range', () => {
  let lane = createLane({ kind: 'volume' }, 0);
  lane = insertPoint(lane, { timeSec: 2, value: 0 });
  lane = insertPoint(lane, { timeSec: 8, value: 0 });
  const trimmed = trimRange(lane, 1, 3, -3);
  close(valueAt(trimmed, 2, 0), -3, 'inside trimmed');
  close(valueAt(trimmed, 8, 0), 0, 'outside untouched');
});

check('thinPoints keeps the shape and drops redundant breakpoints', () => {
  const dense = Array.from({ length: 101 }, (_, i) => ({ timeSec: i / 100, value: i / 100 }));
  const thin = thinPoints(dense, 0.01);
  assert(thin.length < 10, `straight line collapses — got ${thin.length}`);
  eq(thin[0]!.timeSec, 0, 'keeps the first');
  eq(thin[thin.length - 1]!.timeSec, 1, 'keeps the last');

  const bent = [
    { timeSec: 0, value: 0 }, { timeSec: 1, value: 0 },
    { timeSec: 2, value: 10 }, { timeSec: 3, value: 10 },
  ];
  eq(thinPoints(bent, 0.5).length, 4, 'corners survive');
});

check('write modes are classified correctly', () => {
  assert(!isWritingMode('read') && !isWritingMode('off'), 'read/off do not write');
  for (const m of ['touch', 'latch', 'write', 'trim'] as const) assert(isWritingMode(m), m);
});

// ── Mixer maths ──────────────────────────────────────────────────────────────

check('dB conversion round-trips and −∞ is silence', () => {
  close(dbToGain(0), 1, 'unity');
  close(dbToGain(-6), 0.5011872, '−6 dB', 1e-6);
  close(gainToDb(dbToGain(-12)), -12, 'round trip', 1e-6);
  eq(dbToGain(-Infinity), 0, 'silence');
});

check('equal-power pan holds constant power across the sweep', () => {
  for (const p of [-1, -0.5, 0, 0.5, 1]) {
    const g = panGains(p);
    close(g.left * g.left + g.right * g.right, 1, `power at ${p}`, 1e-6);
  }
  close(panGains(0).left, Math.SQRT1_2, 'centre is −3 dB', 1e-6);
  close(panGains(-1).right, 0, 'hard left kills the right', 1e-6);
});

check('VCA gain folds down the chain and survives a cycle', () => {
  resetIds();
  let s = createSession();
  const vcaTop = createTrack('VCA Top', 'vca', { volumeDb: -3 });
  const vcaSub = createTrack('VCA Sub', 'vca', { volumeDb: -2 });
  s = addTrack(s, vcaTop);
  s = addTrack(s, vcaSub);
  const audio = createTrack('Kick', 'audio', { volumeDb: -1 });
  s = addTrack(s, audio);
  s = { ...s, tracks: s.tracks.map((t) =>
    t.id === audio.id ? { ...t, vcaId: vcaSub.id }
    : t.id === vcaSub.id ? { ...t, vcaId: vcaTop.id } : t) };

  const track = findTrack(s, audio.id)!;
  close(vcaChainDb(s, track), -5, 'nested VCAs sum');
  close(effectiveFaderDb(s, track), -6, 'fader + VCA');

  // Cycle: Top → Sub → Top must terminate.
  const cyclic = { ...s, tracks: s.tracks.map((t) =>
    t.id === vcaTop.id ? { ...t, vcaId: vcaSub.id } : t) };
  const db = vcaChainDb(cyclic, findTrack(cyclic, audio.id)!);
  assert(Number.isFinite(db), 'cycle does not hang or diverge');
});

check('solo in place mutes everyone else except solo-safe channels', () => {
  resetIds();
  let s = createSession();
  const a = createTrack('A'); const b = createTrack('B');
  const rev = createTrack('Rev', 'aux', { soloSafe: true });
  s = addTrack(s, a); s = addTrack(s, b); s = addTrack(s, rev);
  assert(!anySoloActive(s), 'no solo yet');

  s = toggleSolo(s, a.id);
  assert(anySoloActive(s), 'solo active');
  assert(!isImplicitlyMuted(s, findTrack(s, a.id)!), 'soloed track plays');
  assert(isImplicitlyMuted(s, findTrack(s, b.id)!), 'other track muted');
  assert(!isImplicitlyMuted(s, findTrack(s, rev.id)!), 'solo-safe aux keeps playing');
  assert(!isImplicitlyMuted(s, s.tracks.find((t) => t.kind === 'master')!), 'master never implicitly muted');

  s = clearAllSolo(s);
  assert(!anySoloActive(s), 'cleared');
});

check('VCA mute propagates to its members', () => {
  resetIds();
  let s = createSession();
  const vca = createTrack('VCA', 'vca');
  const kick = createTrack('Kick');
  s = addTrack(s, vca); s = addTrack(s, kick);
  s = { ...s, tracks: s.tracks.map((t) => (t.id === kick.id ? { ...t, vcaId: vca.id } : t)) };
  assert(isAudible(s, findTrack(s, kick.id)!), 'audible');
  s = toggleMute(s, vca.id);
  assert(isMutedByVca(s, findTrack(s, kick.id)!), 'VCA mute reaches the member');
  assert(!isAudible(s, findTrack(s, kick.id)!), 'member silenced');
});

check('group fader moves are relative and keep member offsets', () => {
  resetIds();
  let s = createSession();
  const a = createTrack('A', 'audio', { volumeDb: 0 });
  const b = createTrack('B', 'audio', { volumeDb: -6 });
  s = addTrack(s, a); s = addTrack(s, b);
  s = addGroup(s, createGroup('Drums', 'a', [a.id, b.id]));
  eq(linkedMembers(s, a.id, 'volume').length, 2, 'both linked');

  s = setVolumeDb(s, a.id, -3);
  close(findTrack(s, a.id)!.volumeDb, -3, 'moved track');
  close(findTrack(s, b.id)!.volumeDb, -9, 'member kept its −6 offset');

  // Pan is not linked by default.
  s = setPan(s, a.id, 0.5);
  close(findTrack(s, b.id)!.pan, 0, 'pan unlinked');
});

// ── Routing + delay compensation ─────────────────────────────────────────────

/** Kick → Drum Bus → (aux) Drum Sum → Master, plus a reverb send. */
function routedSession(): { session: DawSession; kick: Track; aux: Track; busId: string; revBusId: string } {
  resetIds();
  let s = createSession();
  const bus = createBus('Drum Bus');
  const revBus = createBus('Reverb Bus');
  s = { ...s, buses: [bus, revBus] };

  const kick = createTrack('Kick', 'audio', { output: { kind: 'bus', busId: bus.id } });
  const aux = createTrack('Drum Sum', 'aux', { input: bus.id, output: { kind: 'master' } });
  const rev = createTrack('Reverb', 'aux', { input: revBus.id, output: { kind: 'master' } });
  s = addTrack(s, kick); s = addTrack(s, aux); s = addTrack(s, rev);
  s = setSend(s, kick.id, createSend(0, revBus.id, { levelDb: -12, preFader: true }));
  return { session: s, kick, aux, busId: bus.id, revBusId: revBus.id };
}

check('route graph carries outputs, inputs and sends', () => {
  const { session, kick, aux, busId, revBusId } = routedSession();
  const graph = buildRouteGraph(session);
  const has = (from: string, to: string, kind: string) =>
    graph.edges.some((e) => e.from === from && e.to === to && e.kind === kind);
  assert(has(trackNode(kick.id), busNode(busId), 'output'), 'kick → drum bus');
  assert(has(busNode(busId), trackNode(aux.id), 'input'), 'drum bus → aux');
  assert(has(trackNode(aux.id), MASTER_NODE, 'output'), 'aux → master');
  assert(has(trackNode(kick.id), busNode(revBusId), 'send'), 'kick send → reverb bus');
  assert(graph.edges.find((e) => e.kind === 'send')?.preFader === true, 'send is pre-fader');
});

check('feedback detection catches an aux routed back into its own input', () => {
  const { session, aux, busId } = routedSession();
  assert(detectFeedback(session).length === 0, 'clean session has no cycle');
  assert(wouldFeedback(session, aux.id, busId), 'aux → its own input bus is a loop');
  const looped = { ...session, tracks: session.tracks.map((t) =>
    (t.id === aux.id ? { ...t, output: { kind: 'bus' as const, busId } } : t)) };
  assert(detectFeedback(looped).length > 0, 'cycle reported');
});

/** A limiter insert whose look-ahead sets its reported latency. */
function limiterInsert(slot: number, lookaheadMs: number) {
  return createInsert(slot, 'limiter', 'Limiter', {
    params: { ...defaultParams('limiter'), lookaheadMs },
  });
}

check('insert latency comes from the plugin, not a stale stored field', () => {
  const { session, kick } = routedSession();
  // 2 ms look-ahead at 48 k = 96 samples, whatever the cached field says.
  const s = setInsert(session, kick.id, createInsert(0, 'limiter', 'Limiter', {
    params: { ...defaultParams('limiter'), lookaheadMs: 2 },
    latencySamples: 99999,
  }));
  eq(insertLatency(findTrack(s, kick.id)!, 48_000), 96, 'derived from the look-ahead');

  // An unknown plugin (a session from a build with more plugins) falls back
  // to the value stored in the file.
  const foreign = setInsert(session, kick.id, createInsert(0, 'some.vendor.plugin', 'X', {
    latencySamples: 512,
  }));
  eq(insertLatency(findTrack(foreign, kick.id)!, 48_000), 512, 'stored fallback');
});

check('path latency accumulates through the bus chain', () => {
  const { session, kick, aux } = routedSession();
  let s = setInsert(session, kick.id, limiterInsert(0, 2));    // 96 samples
  s = setInsert(s, aux.id, limiterInsert(0, 4));               // 192 samples
  eq(insertLatency(findTrack(s, kick.id)!, s.sampleRate), 96, 'own inserts');
  eq(pathLatency(s, kick.id), 288, 'kick + aux downstream');
  eq(pathLatency(s, aux.id), 192, 'aux alone');

  // A bypassed plugin reports nothing.
  const bypassed = setInsert(s, kick.id, { ...findTrack(s, kick.id)!.inserts[0]!, bypass: true });
  eq(pathLatency(bypassed, kick.id), 192, 'bypass removes the latency');
});

check('delay compensation lines every path up to the longest one', () => {
  const { session, kick, aux } = routedSession();
  let s = setInsert(session, kick.id, limiterInsert(0, 2));
  s = setInsert(s, aux.id, limiterInsert(0, 4));
  const adc = computeDelayCompensation(s);
  eq(adc.maxSamples, 288, 'longest path');
  eq(adc.perTrack.get(kick.id), 0, 'longest path needs no delay');
  eq(adc.perTrack.get(aux.id), 288 - 192, 'aux delayed to match');

  const off = computeDelayCompensation({ ...s, delayCompensation: false });
  eq(off.maxSamples, 0, 'switch off reports nothing');
  eq(off.perTrack.get(aux.id), 0, 'no delay applied');
});

check('describePath reads the signal flow left to right', () => {
  const { session, kick } = routedSession();
  eq(describePath(session, kick.id), 'Kick → Drum Bus → Drum Sum → Master', 'flow');
});

// ── Playlists / comping ──────────────────────────────────────────────────────

check('playlists add, cycle and never drop to zero', () => {
  const { session, trackId } = fixture();
  let s = addPlaylist(session, trackId);
  eq(findTrack(s, trackId)!.playlists.length, 2, 'two lanes');
  const second = findTrack(s, trackId)!.activePlaylistId;
  s = cyclePlaylist(s, trackId, 1);
  assert(findTrack(s, trackId)!.activePlaylistId !== second, 'cycled');
  s = removePlaylist(s, trackId, findTrack(s, trackId)!.activePlaylistId);
  eq(findTrack(s, trackId)!.playlists.length, 1, 'one left');
  const only = findTrack(s, trackId)!.activePlaylistId;
  s = removePlaylist(s, trackId, only);
  eq(findTrack(s, trackId)!.playlists.length, 1, 'never removes the last lane');
});

check('duplicatePlaylist copies the clips with fresh ids', () => {
  const { session, trackId } = fixture();
  const s = duplicatePlaylist(session, trackId);
  const track = findTrack(s, trackId)!;
  eq(track.playlists.length, 2, 'two lanes');
  const [a, b] = track.playlists;
  eq(a!.clips.length, b!.clips.length, 'same clip count');
  assert(a!.clips[0]!.id !== b!.clips[0]!.id, 'new clip ids');
  eq(track.activePlaylistId, b!.id, 'the copy becomes active');
});

check('sliceClips trims the source to the requested window', () => {
  const clips = [createClip('f', 'c', { startSec: 0, offsetSec: 0, durationSec: 10 })];
  const slice = sliceClips(clips, 3, 6);
  eq(slice.length, 1, 'one piece');
  close(slice[0]!.startSec, 3, 'start');
  close(slice[0]!.durationSec, 3, 'duration');
  close(slice[0]!.offsetSec, 3, 'source offset');
  eq(sliceClips(clips, 20, 30).length, 0, 'outside the clip');
});

check('comping drops an alternate take into the main playlist', () => {
  const { session, trackId } = fixture();
  // Lane 2 holds a different file across the same span.
  let s = addPlaylist(session, trackId, false);
  const track = findTrack(s, trackId)!;
  const altId = track.playlists[1]!.id;
  s = setActivePlaylist(s, trackId, altId);
  s = updateClips(s, trackId, () => [createClip('file-b', 'take2', {
    startSec: 0, offsetSec: 0, durationSec: 10,
  })]);
  s = setActivePlaylist(s, trackId, track.playlists[0]!.id);

  s = compRange(s, trackId, altId, sel(3, 6, [trackId]));
  const main = activePlaylist(findTrack(s, trackId)!)!;
  const sorted = [...main.clips].sort((a, b) => a.startSec - b.startSec);
  eq(sorted.length, 3, 'head + comp + tail');
  eq(sorted[1]!.fileId, 'file-b', 'comped section comes from take 2');
  close(sorted[1]!.startSec, 3, 'comp start');
  close(sorted[1]!.durationSec, 3, 'comp length');
  eq(sorted[0]!.fileId, 'file-a', 'head is the original take');
  eq(sorted[2]!.fileId, 'file-a', 'tail is the original take');
  close(sorted[0]!.durationSec + sorted[1]!.durationSec + sorted[2]!.durationSec, 10, 'no gaps');
});

check('flattenComp keeps only the active lane', () => {
  const { session, trackId } = fixture();
  let s = addPlaylist(session, trackId);
  s = addPlaylist(s, trackId);
  eq(alternateLanes(findTrack(s, trackId)!).length, 2, 'two alternates');
  s = flattenComp(s, trackId);
  eq(findTrack(s, trackId)!.playlists.length, 1, 'flattened');
});

// ── Session IO / import ──────────────────────────────────────────────────────

check('session round-trips through JSON', () => {
  const { session } = fixture();
  const parsed = deserializeDawSession(serializeDawSession(session));
  assert(parsed.ok, 'parsed');
  if (parsed.ok) {
    eq(parsed.session.tracks.length, session.tracks.length, 'tracks');
    eq(trackClips(parsed.session.tracks[0]!).length, 1, 'clips survive');
  }
});

check('deserialize rejects junk and wrong versions', () => {
  assert(!deserializeDawSession('not json').ok, 'junk');
  assert(!deserializeDawSession('{"version":99,"tracks":[]}').ok, 'version');
  assert(!deserializeDawSession('{"version":1}').ok, 'missing tracks');
});

check('session import remaps ids and folds duplicate buses and files', () => {
  const { session: source, kick } = routedSession();
  const target = createSession('Target');

  const first = importSessionData(target, source, {});
  eq(first.importedTrackIds.length, 3, 'kick + 2 auxes imported, master skipped');
  const imported = findTrack(first.session, first.importedTrackIds[0]!)!;
  assert(imported.id !== kick.id, 'track id remapped');
  eq(first.session.buses.length, 2, 'both buses came across');
  assert(imported.output.kind === 'bus', 'kick still outputs to a bus');
  if (imported.output.kind === 'bus') {
    const busId = imported.output.busId;
    assert(first.session.buses.some((b) => b.id === busId), 'output points at an imported bus');
    assert(!source.buses.some((b) => b.id === busId), 'and not at the source session bus id');
  }
  assert(imported.sends.every((snd) => first.session.buses.some((b) => b.id === snd.target)),
    'send targets remapped too');
  eq(first.session.files.length, target.files.length + source.files.length, 'files carried over');

  // Importing the same session again reuses the buses (matched by name).
  const second = importSessionData(first.session, source, {});
  eq(second.session.buses.length, 2, 'buses deduped by name');
  eq(second.session.tracks.filter((t) => t.kind !== 'master').length, 6, 'tracks doubled');
});

check('imported tracks get unique names', () => {
  const tracks = [createTrack('Vox'), createTrack('Vox 2')];
  eq(uniqueName('Vox', tracks), 'Vox 3', 'skips taken names');
  eq(uniqueName('Kick', tracks), 'Kick', 'free name kept');
});

// ── WAV ──────────────────────────────────────────────────────────────────────

check('interleave orders samples frame-major', () => {
  const l = new Float32Array([1, 3]);
  const r = new Float32Array([2, 4]);
  eq(Array.from(interleave([l, r], 2)).join(','), '1,2,3,4', 'LRLR');
});

check('encodeWav writes a valid 24-bit header', () => {
  const data = new Float32Array([0, 0.5, -0.5, 1]);
  const wav = encodeWav([data, data], 48_000, 24);
  const view = new DataView(wav.buffer);
  eq(String.fromCharCode(...wav.slice(0, 4)), 'RIFF', 'RIFF');
  eq(String.fromCharCode(...wav.slice(8, 12)), 'WAVE', 'WAVE');
  eq(view.getUint16(20, true), 1, 'PCM');
  eq(view.getUint16(22, true), 2, 'stereo');
  eq(view.getUint32(24, true), 48_000, 'sample rate');
  eq(view.getUint16(34, true), 24, 'bit depth');
  eq(view.getUint32(40, true), 4 * 2 * 3, 'data size');
  eq(wav.length, 44 + 24, 'total size');
});

check('encodeWav clamps overs instead of wrapping', () => {
  const wav = encodeWav([new Float32Array([2, -2])], 48_000, 16);
  const view = new DataView(wav.buffer);
  eq(view.getInt16(44, true), 32767, 'positive clamp');
  eq(view.getInt16(46, true), -32767, 'negative clamp');
});

check('float renders declare IEEE float', () => {
  const wav = encodeWav([new Float32Array([0.25])], 48_000, 32);
  const view = new DataView(wav.buffer);
  eq(view.getUint16(20, true), 3, 'format tag 3');
  close(view.getFloat32(44, true), 0.25, 'sample preserved', 1e-7);
});

// ── Plugins ──────────────────────────────────────────────────────────────────

check('every plugin default sits inside its own range', () => {
  for (const p of PLUGINS) {
    for (const param of p.params) {
      assert(param.default >= param.min && param.default <= param.max,
        `${p.id}.${param.id} default out of range`);
    }
    const defaults = defaultParams(p.id);
    eq(Object.keys(defaults).length, p.params.length, `${p.id} default set`);
  }
});

check('the limiter reports its look-ahead as real latency', () => {
  const params = defaultParams('limiter');
  eq(pluginLatencySamples('limiter', params, 48_000), Math.round(0.002 * 48_000), '2 ms at 48 k');
  eq(pluginLatencySamples('limiter', { ...params, lookaheadMs: 5 }, 44_100), Math.round(0.005 * 44_100), '5 ms at 44.1 k');
  eq(pluginLatencySamples('eq3', {}, 48_000), 0, 'EQ is zero latency');
  eq(pluginLatencySamples('unknown', {}, 48_000), 0, 'unknown plugin');
});

check('detector time constants map to sane corner frequencies', () => {
  assert(timeConstantToHz(10) > timeConstantToHz(100), 'faster attack → higher corner');
  close(timeConstantToHz(1000 / (2 * Math.PI)), 1, '1 s/2π → 1 Hz', 1e-3);
  // Sidechain moved to its own device: Web Audio's compressor cannot take an
  // external key, and a plugin that changes its DSP depending on how it is
  // wired is a plugin you cannot trust.
  assert(findPlugin('ducker')?.hasSidechain === true, 'the ducker takes a key input');
  assert(findPlugin('comp')?.hasSidechain === false, 'and the compressor does not pretend to');
});

// ── Home screen → DAW ─────────────────────────────────────────────────────────

check('an empty DAW adopts the files loaded on the home screen', () => {
  resetIds();
  const empty = createSession('fresh');
  // A brand-new session has only a master track — nothing to overwrite.
  assert(shouldAdoptQueue(empty, 5), 'five loaded songs are adopted');
  assert(!shouldAdoptQueue(empty, 0), 'and nothing is adopted from an empty home screen');
});

check('a session with work in it is never overwritten by the home screen', () => {
  resetIds();
  const withAudio = addTrack(createSession('working'), createTrack('Vox', 'audio'));
  assert(!shouldAdoptQueue(withAudio, 5), 'audio already there — the user is in charge');

  const withMidi = addTrack(createSession('working'), createTrack('Keys', 'instrument'));
  assert(!shouldAdoptQueue(withMidi, 5), 'an instrument track counts as work too');

  // A bus or an aux is scaffolding, not material — a session that only has
  // those is still empty as far as the user is concerned.
  const scaffolding = addTrack(createSession('working'), createTrack('Bus', 'aux'));
  assert(shouldAdoptQueue(scaffolding, 5), 'buses alone do not block the adoption');
});

// ── Decoded-audio budget ──────────────────────────────────────────────────────
// Twenty five-minute songs decode to well over two gigabytes.  Holding them
// all is what killed the renderer — a black window with no error, because the
// process that would have reported one was gone.

check('the cache is bounded by bytes, not by how many files it holds', () => {
  const MB = 1024 * 1024;
  // Twelve short loops fit comfortably; the count rule alone would keep them.
  const loops = Array.from({ length: 12 }, (_, i) => ({ id: `f${i}`, bytes: 4 * MB }));
  assert(evictionPlan(loops, 'f11', 12, 700 * MB).length === 0,
    'twelve small files are inside both budgets');

  // The same twelve entries as full-length songs are 1.4 GB and must be cut.
  const songs = Array.from({ length: 12 }, (_, i) => ({ id: `f${i}`, bytes: 115 * MB }));
  const dropped = evictionPlan(songs, 'f11', 12, 700 * MB);
  assert(dropped.length > 0, 'twelve songs exceed the byte budget');
  const kept = songs.filter((e) => !dropped.includes(e.id));
  const keptBytes = kept.reduce((sum, e) => sum + e.bytes, 0);
  assert(keptBytes <= 700 * MB, `what survives fits the budget — ${(keptBytes / MB) | 0} MB`);
});

check('eviction takes the oldest first and never the file just asked for', () => {
  const MB = 1024 * 1024;
  const entries = Array.from({ length: 5 }, (_, i) => ({ id: `f${i}`, bytes: 200 * MB }));
  const dropped = evictionPlan(entries, 'f4', 12, 700 * MB);
  assert(dropped[0] === 'f0', 'the least-recently-used goes first');
  assert(!dropped.includes('f4'), 'the file the caller wants is never the one evicted');
  assert(dropped.length === 2, `two of five 200 MB files go — got ${dropped.length}`);
});

check('a cache already inside its budget evicts nothing', () => {
  assert(evictionPlan([], 'f0', 12, 1).length === 0, 'an empty cache has nothing to drop');
  assert(evictionPlan([{ id: 'a', bytes: 10 }], 'a', 12, 1000).length === 0,
    'one small file stays');
});

check('one oversized file is kept rather than evicted into uselessness', () => {
  // A single file bigger than the whole budget still has to be playable.
  const plan = evictionPlan([{ id: 'huge', bytes: 900 * 1024 * 1024 }], 'huge', 12, 700 * 1024 * 1024);
  assert(plan.length === 0, 'the only file present is the one the caller needs');
});

check('decoding prefers a live AudioContext over a one-frame offline one', () => {
  const g = globalThis as Record<string, unknown>;
  const originalLive = g.AudioContext;
  const originalOffline = g.OfflineAudioContext;

  try {
    // A one-frame OfflineAudioContext also has decodeAudioData, and decoding a
    // real song through it kills the renderer outright — so when a live context
    // exists it must win, every time.
    const built: string[] = [];
    resetDecodeContext();
    g.AudioContext = class { constructor() { built.push('live'); } };
    g.OfflineAudioContext = class { constructor() { built.push('offline'); } };
    assert(decodeContext() !== null, 'a context is produced');
    assert(built.length === 1 && built[0] === 'live', `live context chosen — got ${built.join()}`);

    // Second call reuses it rather than opening another hardware context.
    decodeContext();
    assert(built.length === 1, 'the context is a singleton');

    // Node self-tests have no AudioContext at all; the offline one is the
    // fallback so the suites still decode.
    built.length = 0;
    resetDecodeContext();
    delete g.AudioContext;
    delete g.webkitAudioContext;
    assert(decodeContext() !== null, 'the offline fallback still yields a context');
    assert(built[0] === 'offline', 'and only when there is no live context');

    // Nothing available at all is a null, never a throw.
    resetDecodeContext();
    delete g.OfflineAudioContext;
    assert(decodeContext() === null, 'no audio at all reports null instead of throwing');
  } finally {
    resetDecodeContext();
    if (originalLive === undefined) delete g.AudioContext; else g.AudioContext = originalLive;
    if (originalOffline === undefined) delete g.OfflineAudioContext; else g.OfflineAudioContext = originalOffline;
    resetDecodeContext();
  }
});

check('the decode context runs at the session sample rate', () => {
  assert(DECODE_SAMPLE_RATE === 48_000, 'sources are resampled to 48 kHz on the way in');
});

// ── Where a dropped file goes ─────────────────────────────────────────────────
// Dropping a stem while you are inside the DAW used to throw you back to the
// home screen — the single most disruptive thing the app did.

check('a drop inside the DAW stays inside the DAW', () => {
  const plan = planDrop(['/a/kick.wav', '/a/riff.mid'], 'daw', 20);
  assert(plan.destination === 'daw', 'the session takes it, not the mastering queue');
  assert(plan.audio.length === 1 && plan.audio[0] === '/a/kick.wav', 'audio is sorted out');
  assert(plan.midi.length === 1 && plan.midi[0] === '/a/riff.mid', 'MIDI is sorted out');
});

check('the same drop anywhere else feeds the mastering queue', () => {
  const plan = planDrop(['/a/song.wav', '/a/riff.mid'], 'home', 20);
  assert(plan.destination === 'queue', 'home means the mastering list');
  assert(plan.audio.length === 1, 'the song is queued');
  assert(plan.midi.length === 0, 'mastering has no use for MIDI');
  assert(plan.ignored.includes('/a/riff.mid'), 'and says the MIDI was skipped');
});

check('the DAW takes more files than the mastering queue has room for', () => {
  const many = Array.from({ length: 30 }, (_, i) => `/a/${i}.wav`);
  // The queue has a hard limit and reports what did not fit.
  const queued = planDrop(many, 'home', 20);
  assert(queued.audio.length === 20, `queue caps at its remaining slots — got ${queued.audio.length}`);
  assert(queued.ignored.length === 10, 'the overflow is reported, not silently dropped');

  // A session is a workspace: thirty tracks is a decision, not an accident.
  const session = planDrop(many, 'daw', 20);
  assert(session.audio.length === 30, `the DAW takes them all — got ${session.audio.length}`);
  assert(session.ignored.length === 0, 'nothing skipped');
});

check('a full queue still reports what it could not take', () => {
  const plan = planDrop(['/a/song.wav'], 'home', 0);
  assert(plan.audio.length === 0, 'no slots left');
  assert(isEmptyPlan(plan), 'the drop has nothing to do');
  assert(plan.ignored.length === 1, 'and the file is accounted for');
});

check('unknown file types are skipped, not guessed at', () => {
  const plan = planDrop(['/a/notes.txt', '/a/cover.png', '/a/mix.WAV'], 'daw', 20);
  assert(plan.audio.length === 1, 'only the audio file is taken');
  assert(plan.audio[0] === '/a/mix.WAV', 'extension matching ignores case');
  assert(plan.ignored.length === 2, 'the other two are reported');
  assert(!isEmptyPlan(plan), 'one usable file is still a usable drop');
});

check('a dotfile without an extension is not mistaken for audio', () => {
  const plan = planDrop(['/a/.wav', '/a/noext'], 'daw', 20);
  assert(plan.audio.length === 0, 'a leading dot is a name, not an extension');
  assert(isEmptyPlan(plan), 'nothing to import');
});

check('a pinned entry is never the one evicted', () => {
  const MB = 1024 * 1024;
  // Four stems of an open session plus one stale file, well over the budget.
  const entries = [
    { id: 'stale', bytes: 200 * MB },
    { id: 'vox',   bytes: 200 * MB, pinned: true },
    { id: 'drums', bytes: 200 * MB, pinned: true },
    { id: 'bass',  bytes: 200 * MB, pinned: true },
    { id: 'gtr',   bytes: 200 * MB, pinned: true },
  ];
  const dropped = evictionPlan(entries, 'gtr', 12, 700 * MB);
  assert(dropped.length === 1 && dropped[0] === 'stale',
    `only the unreferenced file goes — dropped ${dropped.join() || 'nothing'}`);
});

check('a session bigger than the budget keeps playing rather than going silent', () => {
  const MB = 1024 * 1024;
  // Eight four-minute stereo stems are ~740 MB — past any sane cache budget.
  // Evicting them would mute those tracks, so the budget yields instead.
  const stems = Array.from({ length: 8 }, (_, i) => ({
    id: `stem${i}`, bytes: 92 * MB, pinned: true,
  }));
  assert(evictionPlan(stems, 'stem7', 12, 700 * MB).length === 0,
    'every stem survives — an evicted stem is a track missing from the mix');
});

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== DAW core (model · edit · mix · routing · render) ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
