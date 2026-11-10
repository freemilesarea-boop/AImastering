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
  // Node has no localStorage, and three things here keep records in it: the
  // manual-save time (the staleness rule asks at startup about a run that
  // already ended), the key-hint counts, and the demo-mode flag.  Without a
  // store the writes are swallowed and the reads come back empty, and a check
  // then blames the product for being right — which is exactly what happened
  // twice while these were written.  One shim, before anything reads.
  const mem = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, v); },
    removeItem: (k: string) => { mem.delete(k); },
    clear: () => { mem.clear(); },
    key: () => null,
    length: 0,
  };

  const { useAppStore, NOTIFY_MS } = await import('../src/renderer/stores/appStore.js');
  const { useDawStore } = await import('../src/renderer/stores/dawStore.js');
  const { useRecordingStore } = await import('../src/renderer/stores/recordingStore.js');
  const { buildDawCommands, buildDawOverrides } = await import('../src/renderer/shortcuts/daw-commands.js');
  const { SHORTCUTS } = await import('../src/renderer/shortcuts/definitions.js');
  const { lastManualSaveMs } = await import('../src/renderer/daw/model/manual-save.js');
  const { createTrack, addTrack, findTrack, addFile, createClip, updateClips } = await import('../src/renderer/daw/model/session-ops.js');

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

  // ── 시연 모드는 꺼져 있으면 아무 일도 하지 않는다 ────────────────────────
  //
  // A chip announcing every keystroke is right for a projector and wrong for
  // working alone, so the feature's most important property is that it is
  // INVISIBLE by default — and that is a property a test can hold, while
  // "looks good on a projector" is not.
  {
    console.log('\n=== 시연 모드 ===\n');
    const { demoModeOn, setDemoMode } = await import('../src/renderer/shortcuts/demo-mode.js');
    const { runCommand, setCommandMap } = await import('../src/renderer/shortcuts/command-runner.js');

    // The flag lives in localStorage so a class spanning days keeps it; the
    // shim above gives it somewhere to live.
    check('기본값은 꺼짐', !demoModeOn(), String(demoModeOn()));

    let ran = 0;
    setCommandMap({ 'daw.freeze': () => { ran += 1; } });
    useAppStore.setState({ demoCast: null });
    check('꺼져 있을 때 명령은 돌지만 아무것도 띄우지 않는다',
      runCommand('daw.freeze') && ran === 1 && useAppStore.getState().demoCast === null,
      `ran=${ran} cast=${JSON.stringify(useAppStore.getState().demoCast)}`);

    setDemoMode(true);
    check('켜면 켜진 것으로 읽힌다', demoModeOn(), String(demoModeOn()));
    useAppStore.setState({ demoCast: null });
    runCommand('daw.freeze');
    const cast = useAppStore.getState().demoCast;
    check('그리고 명령 이름과 그 키가 함께 올라간다',
      cast !== null && cast.label === '프리즈 / 해제' && typeof cast.chord === 'string'
        && cast.chord.includes('F'),
      JSON.stringify(cast));

    // Off again, and the record is gone rather than set to "0" — a stale
    // truthy value in storage is how a flag comes back on by itself.
    setDemoMode(false);
    check('끄면 다시 조용해진다', !demoModeOn(), String(demoModeOn()));
    useAppStore.setState({ demoCast: null });
    runCommand('daw.freeze');
    check('그리고 끈 뒤에는 띄우지 않는다',
      useAppStore.getState().demoCast === null,
      JSON.stringify(useAppStore.getState().demoCast));
    setCommandMap(null);
  }

  // ── SAVING BY HAND DOES BOTH HALVES, WHICHEVER DOORWAY ──────────────────
  //
  // There were two implementations and each did half.  The button took the
  // name from the file the person had just chosen (not doing that is why the
  // mastering list read "Untitled Session.wav") and never told the autosave
  // driver, so the recovery file stayed and the next launch could offer an
  // older copy under a crash banner that was not true.  The key told the
  // driver and never took the name.  One implementation now, and this is the
  // check that keeps it one: both halves, from the id the button runs.
  {
    console.log('\n=== SAVING BY HAND DOES BOTH HALVES ===\n');
    const said: string[] = [];
    const overrides = buildDawOverrides({
      notify: (m: string) => { said.push(m); },
      openWorkspace: () => { /* not what is being tested */ },
      daw: () => useDawStore.getState(),
      // What the save dialog returns: the person typed a new name for it.
      invoke: async (channel: string) => (channel === 'session:save' ? '/tmp/Night Drive.louisession' : null),
    });
    const id = useDawStore.getState().session.id;
    const before = useDawStore.getState().session.name;
    await (overrides['file.save'] as () => Promise<void>)();
    check('the chosen file name becomes the session name',
      useDawStore.getState().session.name === 'Night Drive',
      `${before} → ${useDawStore.getState().session.name}`);
    check('and the autosave driver is told, so no stale recovery copy is offered',
      lastManualSaveMs(id) !== null,
      `lastManualSaveMs=${lastManualSaveMs(id) === null ? 'null' : 'recorded'}`);
    check('and it says the save landed',
      said.some((m) => m.includes('저장 완료')), said.join(' | ') || '(silent)');

    // A cancelled dialog must do neither.
    const quiet = buildDawOverrides({
      notify: (m: string) => { said.push(m); },
      openWorkspace: () => { /* not what is being tested */ },
      daw: () => useDawStore.getState(),
      invoke: async () => null,
    });
    useDawStore.getState().apply((sess) => ({ ...sess, name: 'Night Drive' }));
    const n0 = said.length;
    await (quiet['file.save'] as () => Promise<void>)();
    check('a cancelled save renames nothing and claims nothing',
      useDawStore.getState().session.name === 'Night Drive' && said.length === n0,
      `name=${useDawStore.getState().session.name} · said ${said.length - n0} more`);
  }

  // ── THE THREE DIALOG COMMANDS ASK FOR THE RIGHT THING ───────────────────
  //
  // These three moved out of DawPage so a key could reach them, and the move
  // is the kind that goes wrong quietly: a wrong channel name opens no dialog
  // and reports nothing, which looks exactly like a cancelled one.  So each is
  // run with a fake IPC that answers "the user cancelled" and asked what it
  // requested.  The cancel path is worth pinning too: two of them say nothing
  // (nothing happened) and the export says so, and that difference is easy to
  // lose.  Verified separately in the app for the three that need no dialog —
  // Alt+Shift+B added an aux track, Alt+Shift+W a VCA, Alt+Shift+Y toggled the
  // template panel.  A frozen contextBridge object cannot be stubbed in the
  // app, which is why these three are here instead.
  {
    console.log('\n=== THE THREE DIALOG COMMANDS ASK FOR THE RIGHT THING ===\n');
    const cases = [
      { id: 'daw.importMidi', channel: 'file:open-dialog-midi', speaksOnCancel: false },
      { id: 'daw.importAaf', channel: 'daw:aaf-open', speaksOnCancel: false },
      { id: 'daw.exportAaf', channel: 'daw:aaf-save', speaksOnCancel: true },
      // The cheat sheet is the fourth: a wrong channel name here writes no
      // file and says nothing, which looks exactly like a cancelled dialog.
      { id: 'daw.cheatSheet', channel: 'daw:cheatsheet-export', speaksOnCancel: false },
    ] as const;
    // An AAF of nothing is refused before any dialog — correctly, and the
    // first run of this block proved it by failing.  So give the session one
    // real clip, which is what "export this edit" means.
    {
      const track = createTrack('Vox', 'audio');
      useDawStore.getState().apply((sess) => {
        let next = addTrack(sess, track);
        next = addFile(next, {
          id: 'f-told', path: '/tmp/vox.wav', name: 'vox.wav',
          durationSec: 60, sampleRate: 48_000, channels: 2,
        });
        return updateClips(next, track.id, () => [
          createClip('f-told', 'verse', { startSec: 1, durationSec: 4 }),
        ]);
      });
    }

    for (const c of cases) {
      const asked: string[] = [];
      const said: string[] = [];
      const cmds = buildDawCommands({
        notify: (m: string) => { said.push(m); },
        openWorkspace: () => { /* not what is being tested */ },
        daw: () => useDawStore.getState(),
        invoke: async (channel: string) => { asked.push(channel); return null; },
      });
      const before = JSON.stringify(useDawStore.getState().session);
      await (cmds[c.id] as () => Promise<void>)();
      check(`${c.id} asks for ${c.channel}`,
        asked.includes(c.channel), asked.join(' · ') || '(asked for nothing)');
      check(`${c.id} leaves the session alone when the dialog is cancelled`,
        JSON.stringify(useDawStore.getState().session) === before,
        'session unchanged');
      check(`${c.id} ${c.speaksOnCancel ? 'says it was cancelled' : 'says nothing when nothing happened'}`,
        c.speaksOnCancel
          ? said.some((m) => m.includes('취소'))
          : said.length === 0,
        said.join(' | ') || '(silent)');
    }
  }

  // ── A KEY THAT IS REGISTERED IS NOT A KEY THAT WORKS ────────────────────
  //
  // `buildCommands` gives every group:'daw' id a fallback toast so the key
  // explains itself on the mastering screen instead of doing nothing.  That
  // is right, and it also blinds the shortcut selftest's "every CommandId has
  // an implementation": the id is callable either way.  Measured by adding a
  // declared command with no implementation anywhere — typecheck clean,
  // 38/38 shortcut checks green, and in the DAW the key would answer "DAW
  // 워크스페이스에서 사용할 수 있습니다" with the workspace already open.
  //
  // So ask the DAW's own map, which is the thing that would have to have it.
  {
    console.log('\n=== EVERY DAW KEY HAS SOMETHING BEHIND IT ===\n');
    const deps = {
      notify: () => { /* nothing is being read here, only presence */ },
      openWorkspace: () => { /* not what is being tested */ },
      daw: () => useDawStore.getState(),
      invoke: async () => null,
    };
    const map = buildDawCommands(deps) as unknown as Record<string, unknown>;
    const overrides = buildDawOverrides(deps) as unknown as Record<string, unknown>;
    const declared = SHORTCUTS.filter((s) => s.group === 'daw');
    const missing = declared
      .filter((s) => typeof map[s.id] !== 'function' && typeof overrides[s.id] !== 'function')
      .map((s) => s.id);
    check(
      'every daw-group command is implemented, not just registered',
      missing.length === 0,
      missing.length > 0
        ? `구현이 없는데 키가 붙어 있다: ${missing.join(', ')}`
        : `${declared.length}개 선언 · ${declared.length - missing.length}개 구현`,
    );
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

void main();
