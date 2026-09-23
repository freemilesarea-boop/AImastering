// told-the-truth-selftest — does the app say what happened, and does the
// saying survive long enough to be read?
//
// Two findings from running all 213 DAW commands for the first time. The
// command map had never been imported by a test — only matched with a regex
// against its own source, which proves a key exists and nothing else.
//
//   · Arming announced its result before it had one. `toggleArm` puts the
//     flag on so the meter can open and takes it off again if the input will
//     not open, and the command reported the pre-call flag and dropped the
//     promise. The only correction was an effect watching the error STRING,
//     which does not change when the same interface is unplugged twice.
//   · `notify` has one slot, and every call also started a bare timer that
//     cleared whatever was showing when it fired — including a later
//     message. Measured in the app: a message 3.3 s after another got 0.2 s.
//
// Run: pnpm --filter @aimaster/desktop test:told-the-truth

// Every import here is dynamic, so without this the file is a SCRIPT rather
// than a module and its top-level names land in the same global scope as
// every other selftest's — which `typecheck:scripts`, compiling them as one
// program, rightly refuses.
export {};

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

const wait = (ms: number) => new Promise((r) => { setTimeout(r, ms); });

async function main(): Promise<void> {
  const { useAppStore, NOTIFY_MS } = await import('../src/renderer/stores/appStore.js');
  const { useDawStore } = await import('../src/renderer/stores/dawStore.js');
  const { useRecordingStore } = await import('../src/renderer/stores/recordingStore.js');
  const { buildDawCommands } = await import('../src/renderer/shortcuts/daw-commands.js');
  const { createTrack, addTrack, findTrack } = await import('../src/renderer/daw/model/session-ops.js');

  console.log('\n=== ONE MESSAGE DOES NOT CUT ANOTHER SHORT ===\n');

  const shown = (): string | null => useAppStore.getState().notification?.message ?? null;

  {
    useAppStore.getState().notify('first');
    // Arrive just before the first message's own timer would fire.
    await wait(NOTIFY_MS - 250);
    useAppStore.getState().notify('second');
    check('the newer message replaces the older', shown() === 'second', `${shown()}`);

    await wait(500); // the first message's timer has now fired
    check(
      "and the older one's timer does not take it away",
      shown() === 'second',
      shown() === null ? `gone after ${500} ms of its ${NOTIFY_MS}` : `${shown()} still up`,
    );
  }

  {
    // And a message still goes away on its own.
    useAppStore.getState().notify('lonely');
    await wait(NOTIFY_MS + 300);
    check('a message left alone still expires', shown() === null, `${shown() ?? '(none)'}`);
  }

  console.log('\n=== ARMING SAYS WHAT ARMING DID ===\n');

  {
    // There is no audio input in this harness, which is the same road a user
    // walks with nothing plugged in or permission refused: `openInput` fails,
    // the optimistic arm is taken back off.
    useDawStore.getState().apply((s) => addTrack(s, createTrack('Vox', 'audio')));
    const id = useDawStore.getState().session.tracks[0]!.id;
    const armed = () => findTrack(useDawStore.getState().session, id)?.recordArm ?? false;

    const outcome = await useRecordingStore.getState().toggleArm(id);
    check(
      'a refused arm is reported as refused',
      outcome.armed === false && outcome.changed === false && Boolean(outcome.error),
      JSON.stringify(outcome),
    );
    check(
      'and the track really is not armed',
      armed() === false,
      `recordArm=${armed()}`,
    );

    const said: string[] = [];
    const commands = buildDawCommands({
      notify: (m: string, t?: string) => { said.push(`${t ?? 'info'}: ${m}`); },
      openWorkspace: () => { /* the window is not what is being tested */ },
      daw: () => useDawStore.getState(),
      invoke: async () => null,
    });

    for (const attempt of [1, 2]) {
      said.length = 0;
      await (commands['daw.toggleArm'] as () => Promise<void>)();
      check(
        `press ${attempt} of the arm key says it failed, not that it worked`,
        said.length === 1 && said[0]!.startsWith('warning:') && !said[0]!.includes('녹음 무장'),
        said[0] ?? '(said nothing)',
      );
      check(
        `and after press ${attempt} the track is still not armed`,
        armed() === false,
        `recordArm=${armed()}`,
      );
    }

    // Disarming cannot fail, so it is still announced plainly.
    useDawStore.getState().apply((s) => {
      const t = findTrack(s, id)!;
      return { ...s, tracks: s.tracks.map((x) => (x.id === id ? { ...t, recordArm: true } : x)) };
    });
    said.length = 0;
    await (commands['daw.toggleArm'] as () => Promise<void>)();
    check(
      'disarming is announced as disarming',
      said.length === 1 && said[0]!.includes('무장 해제'),
      said[0] ?? '(said nothing)',
    );
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

void main();
