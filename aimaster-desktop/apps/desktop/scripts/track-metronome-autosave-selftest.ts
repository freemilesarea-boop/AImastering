/**
 * track-metronome-autosave-selftest — the three Tier-1 gaps.
 *
 * Different features, but two of them turn on a claim that is easy to state
 * and easy to get wrong:
 *
 *   THE CLICK FOLLOWS THE TEMPO MAP.  `scheduleCountIn` multiplies one bpm,
 *   which is right for four bars before a take and wrong for a song: a click
 *   that ignores a ritardando drifts away from the music it is counting.  The
 *   test is that beats stay evenly spaced in BEATS and go uneven in SECONDS.
 *
 *   AUTOSAVE FIRES ON IDLE, NOT ON A TIMER.  A timer writes a file while the
 *   transport rolls and while a clip is being dragged.  Waiting for editing to
 *   stop is what makes it cheap; a hard ceiling is what stops a long
 *   continuous edit from never being saved.
 *
 * Run: pnpm --filter @aimaster/desktop test:track-header
 */

import {
  DEFAULT_TRACK_HEIGHT, MAX_TRACK_HEIGHT, MAX_TRACK_NAME, MIN_TRACK_HEIGHT,
  TRACK_COLORS, TRACK_HEIGHT_PRESETS, cleanTrackName, clampTrackHeight, colorTracks,
  describeHeight, nextTrackColor, renameTrack, setHeights, setTrackColor,
  setTrackHeight, stepTrackHeight, uniqueTrackName,
} from '../src/renderer/daw/model/track-header.js';
import {
  DEFAULT_METRONOME, Metronome, clicksBetween, describeMetronome,
} from '../src/renderer/daw/engine/metronome.js';
import {
  IDLE_MS, INITIAL_AUTOSAVE, MAX_INTERVAL_MS, describeRecovery, isDirty,
  isRecoverable, noteChange, noteSaved, shouldSave,
} from '../src/renderer/daw/model/autosave.js';
import {
  addTempoEvent, beatToSec, defaultTempoMap, secToBeat,
} from '../src/renderer/daw/model/tempo-map.js';
import { addTrack, createSession, createTrack, findTrack } from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import type { DawSession, TrackId } from '../src/renderer/daw/model/types.js';

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

function tracks(n = 3): { session: DawSession; ids: TrackId[] } {
  resetIds();
  let session = createSession('header test', 48000);
  const ids: TrackId[] = [];
  for (let i = 0; i < n; i++) {
    const track = createTrack(`Audio ${i + 1}`, 'audio');
    session = addTrack(session, track);
    ids.push(track.id);
  }
  return { session, ids };
}

// ── Track name ────────────────────────────────────────────────────────────────

check('a track can be renamed, tidied on the way in', () => {
  const { session, ids } = tracks();
  const out = renameTrack(session, ids[0]!, '  Lead    Vox  ');
  eq(findTrack(out, ids[0]!)?.name, 'Lead Vox', 'collapsed and trimmed');
});

check('an empty name is refused', () => {
  // The mixer, the routing menus and the role guesser all read the name.
  // Accepting an empty one quietly breaks three things nowhere near the box.
  const { session, ids } = tracks();
  eq(renameTrack(session, ids[0]!, '   '), session, 'nothing changed');
  eq(findTrack(renameTrack(session, ids[0]!, ''), ids[0]!)?.name, 'Audio 1', 'still named');
});

check('a very long name is capped', () => {
  const { session, ids } = tracks();
  eq(renameTrack(session, ids[0]!, 'y'.repeat(200)).tracks[0]!.name.length, MAX_TRACK_NAME, 'capped');
  eq(cleanTrackName('a\n b'), 'a b', 'and newlines become spaces');
});

check('a unique name is offered, but duplicates are still legal', () => {
  const { session } = tracks();
  const list = session.tracks;
  // A trailing number is a counter, not part of the name.
  eq(uniqueTrackName('Audio 1', list), 'Audio 4', 'steps past Audio 1/2/3');
  eq(uniqueTrackName('Vox', [...list]), 'Vox', 'an untaken name is left alone');

  // Renaming to a duplicate is allowed — sometimes you want two "Gtr".
  const dup = renameTrack(session, list[1]!.id, 'Audio 1');
  eq(dup.tracks[1]!.name, 'Audio 1', 'not enforced on typing');
});

// ── Colour ────────────────────────────────────────────────────────────────────

check('a colour is set, and nonsense is refused', () => {
  const { session, ids } = tracks();
  eq(findTrack(setTrackColor(session, ids[0]!, '#C6A768'), ids[0]!)?.color, '#C6A768', 'set');
  eq(setTrackColor(session, ids[0]!, 'red'), session, 'a name is not a hex');
  eq(setTrackColor(session, ids[0]!, '#GGG'), session, 'and neither is that');
});

check('two tracks added in a row never come out the same colour', () => {
  // Random choice does that about one time in twelve.
  const seen = new Set<string>();
  for (let n = 0; n < TRACK_COLORS.length; n++) {
    seen.add(nextTrackColor(new Array(n).fill(null) as never[]));
  }
  eq(seen.size, TRACK_COLORS.length, 'the palette is walked, not sampled');
});

check('a whole stack can be coloured at once', () => {
  const { session, ids } = tracks();
  const out = colorTracks(session, ids, '#4F8A6B');
  for (const id of ids) eq(findTrack(out, id)?.color, '#4F8A6B', `${id} coloured`);
});

check('every palette entry is a real hex the model accepts', () => {
  const { session, ids } = tracks();
  for (const entry of TRACK_COLORS) {
    eq(findTrack(setTrackColor(session, ids[0]!, entry.hex), ids[0]!)?.color, entry.hex,
      `${entry.id} is usable`);
  }
});

// ── Height ────────────────────────────────────────────────────────────────────

check('height is clamped to something you can actually edit in', () => {
  eq(clampTrackHeight(2), MIN_TRACK_HEIGHT, 'below the floor');
  eq(clampTrackHeight(9999), MAX_TRACK_HEIGHT, 'above the ceiling');
  eq(clampTrackHeight(Number.NaN), DEFAULT_TRACK_HEIGHT, 'and NaN falls back');
  eq(clampTrackHeight(80.6), 81, 'rounded to whole pixels');
});

check('a height is set on one track and on many', () => {
  const { session, ids } = tracks();
  eq(findTrack(setTrackHeight(session, ids[0]!, 120), ids[0]!)?.height, 120, 'one');
  const all = setHeights(session, ids, 48);
  for (const id of ids) eq(findTrack(all, id)?.height, 48, `${id} resized`);
});

check('stepping works from a dragged height that matches no preset', () => {
  // The current height is often a number from a drag, so the nearest preset
  // decides where "one size up" starts.
  eq(stepTrackHeight(75, 1), 120, 'nearest is 72 → next is 120');
  eq(stepTrackHeight(75, -1), 48, 'and down is 48');
  eq(stepTrackHeight(28, -1), 28, 'the smallest does not go smaller');
  eq(stepTrackHeight(200, 1), 200, 'nor the largest larger');
});

check('presets are ordered and inside the limits', () => {
  let previous = 0;
  for (const preset of TRACK_HEIGHT_PRESETS) {
    assert(preset.px > previous, `${preset.id} is bigger than the last`);
    assert(preset.px >= MIN_TRACK_HEIGHT && preset.px <= MAX_TRACK_HEIGHT, `${preset.id} in range`);
    previous = preset.px;
  }
  assert(describeHeight(72).includes('보통'), 'a preset names itself');
  assert(describeHeight(83).includes('83'), 'and a dragged height reads as pixels');
});

// ── Metronome: the tempo map is the point ─────────────────────────────────────

check('at a steady tempo the clicks are evenly spaced', () => {
  const map = defaultTempoMap(120, [4, 4]);          // a beat every 0.5 s
  // Half-open [0, 4): beats at 0, 0.5 … 3.5 — the beat at 4.0 belongs to the
  // next window, which is what stops the seam being clicked twice.
  const clicks = clicksBetween(map, 0, 4);
  eq(clicks.length, 8, 'eight beats in the half-open window');
  for (let i = 1; i < clicks.length; i++) {
    close(clicks[i]!.timeSec - clicks[i - 1]!.timeSec, 0.5, `gap ${i}`, 1e-6);
  }
});

check('THE CLICK FOLLOWS THE TEMPO MAP', () => {
  // The claim a bpm multiplication cannot make.  A tempo change at beat 8
  // must make the clicks uneven in SECONDS and still even in BEATS.
  const map = addTempoEvent(defaultTempoMap(120, [4, 4]), 8, 60);
  const clicks = clicksBetween(map, 0, beatToSec(map, 16));

  const beats = clicks.map((c) => secToBeat(map, c.timeSec));
  for (let i = 1; i < beats.length; i++) {
    close(beats[i]! - beats[i - 1]!, 1, `beat gap ${i} is exactly one beat`, 1e-4);
  }
  const early = clicks[2]!.timeSec - clicks[1]!.timeSec;
  const late = clicks[clicks.length - 1]!.timeSec - clicks[clicks.length - 2]!.timeSec;
  close(early, 0.5, 'before the change: 120 bpm');
  close(late, 1.0, 'after it: 60 bpm — twice as long');
});

check('the downbeat is accented, and the meter decides which beat that is', () => {
  const four = clicksBetween(defaultTempoMap(120, [4, 4]), 0, 4);
  eq(four.filter((c) => c.accent).length, 2, 'a downbeat every four beats');
  eq(four[0]!.accent, true, 'starting with one');
  eq(four[1]!.accent, false, 'and not the next');

  const three = clicksBetween(defaultTempoMap(120, [3, 4]), 0, 4);
  const accentGaps: number[] = [];
  three.forEach((c, i) => { if (c.accent) accentGaps.push(i); });
  eq(accentGaps[1]! - accentGaps[0]!, 3, 'in 3/4 the accent is every three beats');
});

check('subdivisions are weak and never accented', () => {
  // 120 bpm is two beats a second, so subdivision 2 is four clicks a second:
  // 0, 0.25, 0.5, 0.75 in the half-open window [0, 1).
  const clicks = clicksBetween(defaultTempoMap(120, [4, 4]), 0, 1,
    { ...DEFAULT_METRONOME, subdivision: 2 });
  eq(clicks.length, 4, 'twice as many clicks as beats');
  eq(clicks[1]!.weak, true, 'the off-beat is weak');
  eq(clicks[1]!.accent, false, 'and never accented');
});

check('a window starting mid-beat does not re-click the beat it passed', () => {
  // The rule that stops three clicks stacking on one beat as the transport
  // ticks through it.
  const map = defaultTempoMap(120, [4, 4]);
  const clicks = clicksBetween(map, 0.2, 0.9);
  eq(clicks.length, 1, 'only the beat at 0.5');
  close(clicks[0]!.timeSec, 0.5, 'which is the one inside the window');
});

check('an empty or backwards window produces nothing', () => {
  const map = defaultTempoMap(120, [4, 4]);
  eq(clicksBetween(map, 2, 2).length, 0, 'zero length');
  eq(clicksBetween(map, 3, 1).length, 0, 'backwards');
});

check('the scheduler never clicks the same beat twice', () => {
  // The transport ticks far more often than a beat goes by.
  const map = defaultTempoMap(120, [4, 4]);
  let scheduled = 0;
  const ctx = {
    currentTime: 0,
    destination: {} as AudioNode,
    createOscillator: () => {
      scheduled++;
      return {
        frequency: { value: 0 }, connect: () => ({ connect: () => undefined }),
        start: () => undefined, stop: () => undefined,
      } as unknown as OscillatorNode;
    },
    createGain: () => ({
      gain: {
        setValueAtTime: () => undefined,
        linearRampToValueAtTime: () => undefined,
        exponentialRampToValueAtTime: () => undefined,
      },
      connect: (n: unknown) => n,
    } as unknown as GainNode),
  };
  const metro = new Metronome();
  metro.attach(ctx);
  metro.setEnabled(true);
  // Tick every 50 ms across two seconds with a 1 s lookahead.
  for (let t = 0; t < 2; t += 0.05) metro.tick(map, t, 1, 0);
  // The last tick is at 1.95 with a 1 s lookahead, so the covered window is
  // [0, 2.95): beats at 0, 0.5, 1.0, 1.5, 2.0, 2.5 — six, each exactly once.
  eq(scheduled, 6, `each beat once, got ${scheduled}`);
});

check('a disabled metronome makes no sound at all', () => {
  let scheduled = 0;
  const ctx = {
    currentTime: 0, destination: {} as AudioNode,
    createOscillator: () => { scheduled++; return {} as OscillatorNode; },
    createGain: () => ({} as GainNode),
  };
  const metro = new Metronome();
  metro.attach(ctx);
  metro.tick(defaultTempoMap(120, [4, 4]), 0, 1, 0);
  eq(scheduled, 0, 'off means off');
  eq(metro.enabled, false, 'and it says so');
});

check('the read-out names the bar, the meter and the state', () => {
  const map = defaultTempoMap(120, [4, 4]);
  const text = describeMetronome(map, 0, true);
  assert(text.includes('1|1'), `bar and beat: ${text}`);
  assert(text.includes('4/4'), 'the meter');
  assert(text.includes('켜짐'), 'and whether it is on');
});

// ── Autosave: when, not how ───────────────────────────────────────────────────

check('nothing changed means nothing written', () => {
  // The rule that stops the transport writing a file on every tick: playback,
  // scrolling and selecting all re-render and none of them touch the session.
  const clean = noteSaved(noteChange(INITIAL_AUTOSAVE, 0), 1, 0);
  eq(shouldSave(clean, 999_999).save, false, 'clean stays clean forever');
  eq(isDirty(clean), false, 'and knows it');
});

check('a save fires when editing PAUSES', () => {
  let state = noteChange(INITIAL_AUTOSAVE, 1000);
  eq(shouldSave(state, 1000 + IDLE_MS - 1).save, false, 'still typing');
  const decision = shouldSave(state, 1000 + IDLE_MS);
  eq(decision.save, true, 'stopped');
  eq(decision.reason, 'idle', 'for the right reason');
});

check('a drag that never goes idle is still saved, by the ceiling', () => {
  // Drawing a five-minute automation pass never pauses.  Without the ceiling
  // it would never be written.
  let state = INITIAL_AUTOSAVE;
  let now = 0;
  let saved = false;
  // A change every 100 ms for two minutes.
  for (; now < 120_000; now += 100) {
    state = noteChange(state, now);
    const decision = shouldSave(state, now);
    if (decision.save) {
      eq(decision.reason, 'ceiling', 'never idle, so it must be the ceiling');
      saved = true;
      state = noteSaved(state, state.revision, now);
    }
  }
  assert(saved, 'a continuous edit was still written');
  assert(now / MAX_INTERVAL_MS >= 2, 'and the run was long enough to prove it');
});

check('edits arriving DURING a write belong to the next save', () => {
  // A write is asynchronous.  Marking the current revision clean when an older
  // one was written is exactly how an autosave loses the last thing you did.
  let state = noteChange(INITIAL_AUTOSAVE, 0);       // revision 1
  const writing = state.revision;
  state = noteChange(state, 10);                      // revision 2, mid-write
  state = noteSaved(state, writing, 20);              // the write of rev 1 lands
  eq(isDirty(state), true, 'rev 2 is still unsaved');
  eq(shouldSave(state, 10 + IDLE_MS).save, true, 'and will be written next');
});

check('a save resets the clock, so two saves are not back to back', () => {
  let state = noteChange(INITIAL_AUTOSAVE, 0);
  state = noteSaved(state, state.revision, IDLE_MS);
  eq(shouldSave(state, IDLE_MS + 1).save, false, 'clean and quiet');
  state = noteChange(state, IDLE_MS + 10);
  eq(shouldSave(state, IDLE_MS + 11).save, false, 'a fresh edit waits its turn');
});

// ── Autosave: what is worth offering back ─────────────────────────────────────

const record = (over: Partial<{ path: string; savedAtMs: number; sessionName: string; bytes: number }> = {}) => ({
  path: '/tmp/autosave/x.louisession', savedAtMs: 1_000_000, sessionName: '내 곡', bytes: 40_000, ...over,
});

check('a truncated autosave is not offered', () => {
  // Offering one is offering to replace a session with nothing.
  eq(isRecoverable(record({ bytes: 0 }), null).offer, false, 'empty');
  eq(isRecoverable(record({ bytes: 12 }), null).offer, false, 'nearly empty');
  assert(isRecoverable(record({ bytes: 4 }), null).reason?.includes('비어'), 'and says why');
});

check('an autosave older than a manual save is not offered', () => {
  // Offering a stale one is how people lose the save they deliberately made.
  const result = isRecoverable(record({ savedAtMs: 1000 }), 5000);
  eq(result.offer, false, 'refused');
  assert(result.reason?.includes('수동'), `for the right reason: ${result.reason}`);
  eq(isRecoverable(record({ savedAtMs: 9000 }), 5000).offer, true, 'but a newer one is offered');
});

check('with no manual save at all, a healthy autosave is offered', () => {
  eq(isRecoverable(record(), null).offer, true, 'offered');
  eq(isRecoverable(null, null).offer, false, 'and nothing is not');
});

check('the prompt says how old it is, in words', () => {
  const info = record({ savedAtMs: 1_000_000 });
  assert(describeRecovery(info, 1_000_000 + 30_000).includes('방금'), 'seconds ago');
  assert(describeRecovery(info, 1_000_000 + 5 * 60_000).includes('5분'), 'minutes');
  assert(describeRecovery(info, 1_000_000 + 3 * 3_600_000).includes('3시간'), 'hours');
  assert(describeRecovery(info, 1_000_000).includes('내 곡'), 'and which project');
});

// ── Report ────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Track header · metronome · autosave ===');
for (const r of results) {
  console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
