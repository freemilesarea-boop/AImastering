// autosave-reach-selftest — does the autosave see the edit, whichever way
// the edit was made?
//
// The driver is told rather than polled, which is the right design and has
// one failure mode: a path that changes the session and does not say so.
// That is not visible in the store (the edit is on screen), not visible in
// undo (the edit is in the stack) and not visible in any test of the pure
// decision model (it is a pure function of a revision counter nobody
// bumped).  It is visible here, and nowhere else: this drives the REAL
// store and the REAL driver, with a clock it controls, and asks what
// reached the disk.
//
// `applyTransient` is the path every drag takes — clip moves, fades, clip
// gain, automation curves, tempo nodes, chord and section lanes, MIDI and
// vocal note drags, plugin and instrument parameters, the control surface.
// It used to say nothing, so a mixing pass made entirely of drags autosaved
// nothing at all.  Undo said nothing either, so the file kept the thing the
// user had just taken back.
//
// Run: pnpm --filter @aimaster/desktop test:autosave-reach

import { useDawStore } from '../src/renderer/stores/dawStore.js';
import { autosaveDriver } from '../src/renderer/daw/engine/autosave-driver.js';
import { createTrack, addTrack, createSession } from '../src/renderer/daw/model/session-ops.js';
import { IDLE_MS, MAX_INTERVAL_MS } from '../src/renderer/daw/model/autosave.js';
import type { DawSession } from '../src/renderer/daw/model/types.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

let now = 1_000_000;
/** Every autosave write, as the track names it put on disk. */
let written: string[] = [];

autosaveDriver.start({
  session: () => useDawStore.getState().session,
  invoke: async (channel, payload) => {
    if (channel === 'autosave:write') {
      const { data } = payload as { data: string };
      written.push(names(JSON.parse(data) as DawSession));
    }
    return undefined;
  },
  now: () => now,
});

function names(session: DawSession): string {
  return session.tracks.map((t) => t.name).join('+') || '(none)';
}

const store = () => useDawStore.getState();
const wait = (ms: number) => new Promise((r) => { setTimeout(r, ms); });

/** Move the clock past the idle gate and let one poll run. */
async function idle(): Promise<void> {
  now += IDLE_MS * 2;
  await wait(1_400);
}

/** Rename a track without touching the undo stack — what a drag does. */
function renameTransient(name: string): void {
  const id = store().session.tracks[0]!.id;
  store().applyTransient((s) => ({
    ...s,
    tracks: s.tracks.map((t) => (t.id === id ? { ...t, name } : t)),
  }));
}

async function main(): Promise<void> {
  console.log('\n=== AUTOSAVE REACH — every path that changes the session ===\n');

  store().loadSession(createSession());
  store().apply((s) => addTrack(s, createTrack('Kick', 'audio')));
  await idle();
  check(
    'an edit through apply() reaches the disk',
    written.at(-1)?.includes('Kick') === true,
    `on disk: ${written.at(-1)}`,
  );

  {
    // A drag: many transient writes, then the commit that makes it one
    // undo step.  Nothing may be written DURING it — that is the idle gate
    // doing its job — and the state must land once the hand stops.
    const before = written.length;
    for (let i = 0; i < 20; i++) {
      now += 16;
      renameTransient(`Dragging ${i}`);
      // The poll cannot run inside a synchronous loop, so ask the decision
      // the same way the driver does: nothing is due while changes keep
      // arriving and the ceiling is far off.
    }
    store().commitEdit();
    await wait(1_400); // a poll tick, but the clock has barely moved
    check(
      'nothing is written mid-drag',
      written.length === before,
      `${written.length - before} writes during 20 moves in 320 ms`,
    );

    await idle();
    check(
      'a drag reaches the disk once the hand stops',
      written.at(-1) === 'Dragging 19+Master' || written.at(-1)?.includes('Dragging 19') === true,
      `on disk: ${written.at(-1)}`,
    );
  }

  {
    // A pass that never goes idle must still be saved: that is what the
    // ceiling is for, and it can only fire if the changes are being heard.
    //
    // Any write in this block is a ceiling write by construction: the clock
    // advances 500 ms per change and the loop yields between them, so
    // whenever a poll does run the last change is 500 ms old — a twentieth
    // of the idle gate — while the time since the last save runs past the
    // ceiling.
    const before = written.length;
    const start = now;
    while (now - start < MAX_INTERVAL_MS * 2) {
      now += 500;
      renameTransient(`Pass ${now - start}`);
      await wait(0);
      if (now - start === 30_000) await wait(1_200);
    }
    await wait(1_400);
    check(
      'a continuous pass is forced through by the ceiling',
      written.length > before,
      `${written.length - before} writes across ${MAX_INTERVAL_MS * 2 / 1000} s of unbroken editing`,
    );
  }

  {
    // Undo changes what the project is.  The disk has to follow it back.
    store().apply((s) => addTrack(s, createTrack('Snare', 'audio')));
    await idle();
    const withSnare = written.at(-1);
    store().undo();
    await idle();
    check(
      'undo reaches the disk',
      withSnare?.includes('Snare') === true && written.at(-1)?.includes('Snare') === false,
      `before undo: ${withSnare} · after: ${written.at(-1)}`,
    );

    store().redo();
    await idle();
    check(
      'redo reaches the disk',
      written.at(-1)?.includes('Snare') === true,
      `on disk: ${written.at(-1)}`,
    );
  }

  {
    // Opening another project must not make it dirty, and must not let the
    // previous project's pending edit write THIS project's file.
    renameTransient('Unsaved work');
    const before = written.length;
    store().loadSession(createSession());
    await idle();
    check(
      'opening a project does not autosave it unedited',
      written.length === before,
      `${written.length - before} writes after a load with an edit pending`,
    );
    check(
      'and the driver is no longer dirty',
      !autosaveDriver.dirty,
      `dirty=${autosaveDriver.dirty}`,
    );
  }

  autosaveDriver.stop();
  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

void main();
