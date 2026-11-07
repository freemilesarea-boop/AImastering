// recovery-offer-selftest — what the app offers to restore, and when it
// stops offering.
//
// The decision model has always been tested. What could not be was whether
// the app ever ASKS it the right question: `findRecoveries` passed `null`
// for the manual-save time on every call, so the rule that keeps a stale
// autosave out of the prompt — the one thing standing between a deliberate
// save and an older copy of it — could not fire in production, while a test
// exercised it with a number nothing supplied.
//
// So this drives the real scan over real records, with a real localStorage,
// and asks what came back.
//
// Run: pnpm --filter @aimaster/desktop test:recovery-offer

// Every import here is dynamic, so without this the file is a SCRIPT rather
// than a module and its top-level names land in the same global scope as
// every other selftest's — which `typecheck:scripts`, compiling them as one
// program, rightly refuses.
export {};

const store = new Map<string, string>();
(globalThis as { localStorage?: Storage }).localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k)! : null),
  setItem: (k, v) => { store.set(k, v); },
  removeItem: (k) => { store.delete(k); },
  clear: () => store.clear(),
  key: (i) => Array.from(store.keys())[i] ?? null,
  get length() { return store.size; },
} satisfies Storage;

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

async function main(): Promise<void> {
  // Imported here, not at the top: the localStorage shim above has to be in
  // place before the modules that read it are evaluated.
  const { findRecoveries } = await import('../src/renderer/daw/engine/autosave-driver.js');
  const { noteManualSave, lastManualSaveMs } =
    await import('../src/renderer/daw/model/manual-save.js');
  const { isRecoverable, pairGenerations } = await import('../src/renderer/daw/model/autosave.js');

  const T = 1_700_000_000_000;
  const record = (over: Partial<{
    path: string; savedAtMs: number; sessionName: string; bytes: number; sessionId: string;
    generation: 'latest' | 'previous';
  }> = {}) => ({
    path: '/autosave/ses-1.louisession',
    savedAtMs: T,
    sessionName: '내 곡',
    bytes: 40_000,
    sessionId: 'ses-1',
    ...over,
  });

  /** Stand in for the main process's `autosave:list`. */
  const listing = (rows: unknown[]) =>
    (channel: string): Promise<unknown> =>
      Promise.resolve(channel === 'autosave:list' ? rows : null);

  console.log('\n=== RECOVERY OFFER — what the scan asks, and what it answers ===\n');

  {
    store.clear();
    const offers = await findRecoveries(listing([record()]), T + 60_000);
    check(
      'an autosave from a project never saved by hand is offered',
      offers.length === 1 && offers[0]!.label.includes('내 곡'),
      offers[0]?.label ?? '(nothing offered)',
    );
  }

  {
    // The whole point: saved by hand AFTER the autosave, so the autosave is a
    // copy of an older state and must not be put in front of the user.
    store.clear();
    noteManualSave('ses-1', T + 30_000);
    const offers = await findRecoveries(listing([record()]), T + 60_000);
    check(
      'an autosave older than a deliberate save is not offered',
      offers.length === 0,
      offers.length ? `offered anyway: ${offers[0]!.label}` : 'nothing offered',
    );
  }

  {
    // And the other way: a crash after a save leaves work the save does not
    // have, which is exactly what the prompt is for.
    store.clear();
    noteManualSave('ses-1', T - 30_000);
    const offers = await findRecoveries(listing([record()]), T + 60_000);
    check(
      'an autosave written after the save is still offered',
      offers.length === 1,
      offers.length ? offers[0]!.label : 'nothing offered',
    );
  }

  {
    // One project's save must not silence another project's crash.
    store.clear();
    noteManualSave('ses-1', T + 30_000);
    const offers = await findRecoveries(
      listing([record(), record({ sessionId: 'ses-2', sessionName: '다른 곡' })]), T + 60_000,
    );
    check(
      "one project's save does not hide another project's autosave",
      offers.length === 1 && offers[0]!.label.includes('다른 곡'),
      offers.map((o) => o.label).join(' · ') || '(nothing offered)',
    );
  }

  {
    // A file from a build that did not record an id has nothing to compare, so
    // it is offered — the safe direction.
    store.clear();
    noteManualSave('ses-1', T + 30_000);
    const offers = await findRecoveries(listing([record({ sessionId: undefined })]), T + 60_000);
    check(
      'a record with no session id is still offered',
      offers.length === 1,
      offers.length ? offers[0]!.label : 'nothing offered',
    );
  }

  {
    store.clear();
    const offers = await findRecoveries(listing([record({ bytes: 12 })]), T);
    check('a truncated file is still refused', offers.length === 0, `${offers.length} offers`);
  }

  console.log('\n=== THE SAVE THAT MAKES IT UNNECESSARY ===\n');

  {
    // The other half, and the one that was missing entirely: nothing in the
    // app called `clear`, so a clean save left the recovery file standing.
    const { buildDawOverrides } = await import('../src/renderer/shortcuts/daw-commands.js');
    const { autosaveDriver } = await import('../src/renderer/daw/engine/autosave-driver.js');
    const { useDawStore } = await import('../src/renderer/stores/dawStore.js');

    const cleared: string[] = [];
    autosaveDriver.start({
      session: () => useDawStore.getState().session,
      invoke: async (channel, arg) => {
        if (channel === 'autosave:clear') cleared.push(String(arg));
        return undefined;
      },
      now: () => T,
    });

    const run = async (savedTo: string | null): Promise<void> => {
      store.clear();
      cleared.length = 0;
      const commands = buildDawOverrides({
        notify: () => { /* the toast is not what is being tested */ },
        openWorkspace: () => { /* nor is the window */ },
        daw: () => useDawStore.getState(),
        invoke: async (channel) => (channel === 'session:save' ? savedTo : null),
      });
      await commands['file.save']!();
    };

    const id = useDawStore.getState().session.id;

    await run('/somewhere/my song.louisession');
    check(
      'a save that lands clears the recovery file',
      cleared.length === 1 && cleared[0] === id,
      cleared.length ? `cleared ${cleared[0]}` : 'nothing cleared',
    );
    check(
      'and records when it happened',
      lastManualSaveMs(id) !== null,
      `${lastManualSaveMs(id)}`,
    );

    await run(null);
    check(
      'a save the user cancelled clears nothing',
      cleared.length === 0 && lastManualSaveMs(id) === null,
      `${cleared.length} cleared, time ${lastManualSaveMs(id)}`,
    );

    autosaveDriver.stop();
  }

  console.log('\n=== THE RECORD ITSELF ===\n');

  {
    store.clear();
    noteManualSave('ses-9', T);
    check('a save time is remembered', lastManualSaveMs('ses-9') === T, `${lastManualSaveMs('ses-9')}`);
    check('and an unknown project has none', lastManualSaveMs('ses-nope') === null, 'null');
    // The record is per project and bounded: a machine that has opened a lot
    // of them does not grow this file without end.
    for (let i = 0; i < 80; i++) noteManualSave(`ses-bulk-${i}`, T + i);
    const kept = Object.keys(JSON.parse(store.get('loui.daw.lastManualSave') ?? '{}') as object);
    check('the record keeps the newest and drops the rest', kept.length === 64,
      `${kept.length} ids kept`);
    check('and what it keeps is the newest', kept.includes('ses-bulk-79') && !kept.includes('ses-bulk-0'),
      'newest in, oldest out');
  }

  {
    // The store is somebody else's to break: a private window, a cleared
    // profile, or junk under our key. None of that may throw at startup.
    store.clear();
    store.set('loui.daw.lastManualSave', 'not json at all');
    check('junk in the store reads as nothing', lastManualSaveMs('ses-1') === null, 'null');
    store.set('loui.daw.lastManualSave', '[1,2,3]');
    check('and so does the wrong shape', lastManualSaveMs('ses-1') === null, 'null');
    store.set('loui.daw.lastManualSave', '{"ses-1":"yesterday"}');
    check('and so does a non-number', lastManualSaveMs('ses-1') === null, 'null');

    const broken = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { /* no */ }, clear: () => { /* no */ },
      key: () => null, length: 0,
    } satisfies Storage;
    const real = globalThis.localStorage;
    (globalThis as { localStorage?: Storage }).localStorage = broken;
    let threw = false;
    try { noteManualSave('ses-1', T); lastManualSaveMs('ses-1'); } catch { threw = true; }
    (globalThis as { localStorage?: Storage }).localStorage = real;
    check('a store that refuses does not throw', !threw, 'no throw');
  }

  {
    // The rule itself, asked the way the app now asks it.
    check(
      'the staleness rule is what refuses, and says so',
      isRecoverable(record(), T + 1).offer === false
        && (isRecoverable(record(), T + 1).reason ?? '').includes('수동 저장'),
      isRecoverable(record(), T + 1).reason ?? '(no reason)',
    );
  }

  console.log('\n=== THE COPY BEFORE THE NEWEST ONE ===\n');

  // The main process keeps the autosave before last as a `.bak` for the case
  // its own header describes: the newest copy faithfully preserves a session
  // that was already broken.  For a long time `autosave:list` filtered
  // `*.louisession`, which excludes `*.louisession.bak`, so that copy was
  // written, swept and deleted without anything ever being able to offer it.
  const prev = (over: Parameters<typeof record>[0] = {}) =>
    record({ path: '/autosave/ses-1.louisession.bak', generation: 'previous', ...over });

  {
    store.clear();
    const offers = await findRecoveries(
      listing([record({ generation: 'latest' }), prev({ savedAtMs: T - 300_000 })]),
      T + 60_000,
    );
    check(
      'the previous generation rides along with its own project, not as a row',
      offers.length === 1 && offers[0]!.previous !== undefined,
      `${offers.length} offer(s), previous ${offers[0]?.previous ? 'present' : 'absent'}`,
    );
    check(
      'and it is labelled without repeating the project name',
      (offers[0]?.previous?.label ?? '').startsWith('그 전 ·')
        && !(offers[0]?.previous?.label ?? '').includes('내 곡'),
      offers[0]?.previous?.label ?? '(no label)',
    );
  }

  {
    // The banner shows offers[0].  A `.bak` is sorted by time with everything
    // else, so one project's older copy can land ahead of another project's
    // newest — and must still never be what the banner offers.
    store.clear();
    const offers = await findRecoveries(
      listing([
        prev({ sessionId: 'ses-1', savedAtMs: T + 50_000 }),
        record({ path: '/autosave/ses-1.louisession', generation: 'latest', savedAtMs: T }),
        record({ path: '/autosave/ses-2.louisession', sessionId: 'ses-2',
                 sessionName: '다른 곡', generation: 'latest', savedAtMs: T + 10_000 }),
      ]),
      T + 60_000,
    );
    check(
      'a previous copy never becomes the offer the banner shows',
      offers.length === 2 && offers.every((o) => !o.info.path.endsWith('.bak')),
      offers.map((o) => o.info.path.split('/').pop()).join(' · '),
    );
  }

  {
    // Orphans: a `.bak` whose own newest copy is not in the listing is not a
    // project the user was asked about, so it is dropped rather than promoted.
    store.clear();
    const offers = await findRecoveries(listing([prev()]), T + 60_000);
    check(
      'a previous copy with no newest copy is dropped, not promoted',
      offers.length === 0,
      offers.length ? `offered anyway: ${offers[0]!.info.path}` : 'nothing offered',
    );
  }

  {
    // The two rules that refuse the newest refuse the older copy as well: an
    // interrupted write is no more useful for being older, and a manual save
    // newer than the newest autosave is newer than this one too.
    store.clear();
    const offers = await findRecoveries(
      listing([record({ generation: 'latest' }), prev({ savedAtMs: T - 300_000, bytes: 12 })]),
      T + 60_000,
    );
    check(
      'an empty previous copy is not offered as a way out',
      offers.length === 1 && offers[0]!.previous === undefined,
      `previous ${offers[0]?.previous ? 'offered' : 'withheld'} at 12 bytes`,
    );
  }

  {
    // Pairing is by path, because the listing is sorted by time across every
    // project and one session's copies need not be adjacent.
    const pairs = pairGenerations([
      { path: '/a/x.louisession', savedAtMs: 3, sessionName: 'x', bytes: 1000, generation: 'latest' },
      { path: '/a/y.louisession', savedAtMs: 2, sessionName: 'y', bytes: 1000, generation: 'latest' },
      { path: '/a/x.louisession.bak', savedAtMs: 1, sessionName: 'x', bytes: 1000, generation: 'previous' },
    ]);
    check(
      'pairing follows the path, not the position in the listing',
      pairs.length === 2
        && pairs[0]!.previous?.path === '/a/x.louisession.bak'
        && pairs[1]!.previous === undefined,
      `${pairs.length} pair(s): `
      + pairs.map((p) => `${p.latest.path.split('/').pop()}${p.previous ? ' +prev' : ''}`).join(', '),
    );
    check(
      'a listing from a build that reported no generation is all latest',
      pairGenerations([
        { path: '/a/x.louisession', savedAtMs: 3, sessionName: 'x', bytes: 1000 },
      ]).length === 1,
      'one offer, no previous',
    );
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

void main();
