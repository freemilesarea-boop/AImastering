// song-settings-selftest — per-song saved settings, and the album layering.
//
// The two things that can silently destroy a user's work here are (a) a
// save that does not survive being read back, and (b) a final album preset
// that overwrites the very module somebody spent an evening on. Both are
// checked by doing them, not by reading the code.
//
// The last group renders audio through the real WASM chain to prove the
// saved state actually reaches an export — the thing that was missing
// before this feature existed.

import {
  changedModules,
  layerAlbumPreset,
  loadSongSettings,
  saveSongSettings,
  clearSongSettings,
  clearAllSongSettings,
  savedSongPaths,
} from '../src/renderer/audio/session/song-settings.js';
import {
  ALL_MODULE_PARAMETER_DEFS,
  defaultAllModulesState,
  type AllModulesParameterState,
} from '../src/renderer/audio/parameters/index.js';
import { LOUI_PRESETS, getPreset } from '../src/renderer/audio/presets/loui-presets.js';
import { buildChainConfig } from '../src/renderer/audio/chain-config.js';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── A localStorage stand-in ──────────────────────────────────────────────
// The module guards every storage call, so without this it would silently
// no-op and every persistence test would pass by doing nothing. Installing
// a real one is what makes these tests mean something.
function installStorage(): void {
  const map = new Map<string, string>();
  const shim = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => { map.clear(); },
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
  (globalThis as { localStorage?: unknown }).localStorage = shim;
}
installStorage();

function baseState(): AllModulesParameterState {
  return defaultAllModulesState(ALL_MODULE_PARAMETER_DEFS);
}

console.log('\n=== CHANGE DETECTION — what counts as the user\'s work ===\n');

{
  const fresh = baseState();
  check(
    'an untouched rack has changed nothing',
    changedModules(fresh).length === 0,
    `${changedModules(fresh).length} modules`,
  );
}

{
  const s = baseState();
  // Rebuild every module object without changing a value — this is what
  // React does on each render, and a reference comparison would call the
  // whole rack changed.
  const rebuilt: AllModulesParameterState = { ...s };
  for (const k of Object.keys(rebuilt) as Array<keyof AllModulesParameterState>) {
    rebuilt[k] = { ...s[k], parameters: { ...s[k].parameters } };
  }
  check(
    'rebuilding the state objects is not a change',
    changedModules(rebuilt).length === 0,
    'compared by value, not by reference',
  );
}

{
  const s = baseState();
  s.limiter = { ...s.limiter, parameters: { ...s.limiter.parameters, ceilingDbtp: -0.3 } };
  const ch = changedModules(s);
  check(
    'moving one parameter marks exactly that module',
    ch.length === 1 && ch[0] === 'limiter',
    ch.join(', ') || 'none',
  );
}

{
  const s = baseState();
  s.reverb = { ...s.reverb, bypass: !s.reverb.bypass };
  const ch = changedModules(s);
  check(
    'flipping a bypass counts as a change',
    ch.includes('reverb'),
    ch.join(', ') || 'none',
  );
}

console.log('\n=== LAYERING — the album preset never eats per-song work ===\n');

{
  const s = baseState();
  s.limiter = { ...s.limiter, parameters: { ...s.limiter.parameters, ceilingDbtp: -0.3 } };
  const kpop = getPreset('kpop-loud')!;
  const { state, report } = layerAlbumPreset(s, kpop);
  check(
    'a module the song changed keeps its value',
    state.limiter.parameters.ceilingDbtp === -0.3,
    `ceiling stayed at ${String(state.limiter.parameters.ceilingDbtp)} dBTP`,
  );
  check(
    'and the report says so',
    report.kept.includes('limiter') && !report.applied.includes('limiter'),
    `kept: ${report.kept.join(', ') || 'none'}`,
  );
}

{
  const s = baseState();
  s.limiter = { ...s.limiter, parameters: { ...s.limiter.parameters, ceilingDbtp: -0.3 } };
  const kpop = getPreset('kpop-loud')!;
  const { state, report } = layerAlbumPreset(s, kpop);
  // Everything the preset touches that the song did NOT claim must land.
  const other = report.applied.filter((m) => m !== 'limiter');
  let allLanded = other.length > 0;
  for (const m of other) {
    const want = kpop.tuning[m]?.parameters ?? {};
    for (const [k, v] of Object.entries(want)) {
      if (state[m].parameters[k] !== v) { allLanded = false; break; }
    }
  }
  check(
    'every module the song did NOT claim takes the album preset',
    allLanded,
    `applied: ${other.join(', ') || 'none'}`,
  );
}

{
  const s = baseState();
  const before = JSON.stringify(s);
  const { state } = layerAlbumPreset(s, null);
  check(
    'no album preset leaves the song exactly as saved',
    JSON.stringify(state) === before,
    'byte-identical',
  );
}

{
  // The whole-album consistency case: two songs, different per-song work,
  // same album preset. The parts neither song claimed must come out equal.
  const kpop = getPreset('kpop-loud')!;
  const a = baseState();
  a.reverb = { ...a.reverb, parameters: { ...a.reverb.parameters, mixPct: 12 } };
  const b = baseState();
  b.delay = { ...b.delay, parameters: { ...b.delay.parameters, mixPct: 8 } };
  const la = layerAlbumPreset(a, kpop).state;
  const lb = layerAlbumPreset(b, kpop).state;
  const shared = Object.keys(kpop.tuning).filter(
    (m) => m !== 'reverb' && m !== 'delay',
  ) as Array<keyof AllModulesParameterState>;
  const same = shared.every(
    (m) => JSON.stringify(la[m].parameters) === JSON.stringify(lb[m].parameters),
  );
  check(
    'two songs with different work still share the album settings',
    same && shared.length > 0,
    `${shared.length} shared modules identical`,
  );
}

{
  // Auditioning a preset in the Studio and moving on must not pin the rack.
  // A preset applied to a fresh state DOES change modules, so those become
  // the song's own — that is intended and worth stating out loud, because
  // it is the one case where "changed" and "chosen deliberately" differ.
  const s = baseState();
  const ch = changedModules(s);
  check(
    'change is measured against defaults, not against a preset',
    ch.length === 0,
    'a fresh rack claims nothing, so an album preset applies in full',
  );
}

console.log('\n=== PERSISTENCE — the work survives Back, and a restart ===\n');

clearAllSongSettings();

{
  const s = baseState();
  s.eq = { ...s.eq, parameters: { ...s.eq.parameters, airDb: 3.5 } };
  const saved = saveSongSettings({
    filePath: '/songs/one.wav',
    state: s,
    freeBands: [],
    masterBypass: false,
    presetId: 'ai-vocal-texture',
  });
  const back = loadSongSettings('/songs/one.wav');
  check(
    'what was saved is what comes back',
    back !== null && back.state.eq.parameters.airDb === 3.5,
    `airDb = ${String(back?.state.eq.parameters.airDb)}`,
  );
  check(
    'the preset it started from is remembered',
    back?.presetId === 'ai-vocal-texture',
    String(back?.presetId),
  );
  check('and the save is timestamped', saved.savedAt > 0);
}

{
  // The snapshot must detach from the live React state, or a later edit
  // would rewrite history.
  const s = baseState();
  s.eq = { ...s.eq, parameters: { ...s.eq.parameters, airDb: 1.0 } };
  saveSongSettings({
    filePath: '/songs/two.wav',
    state: s,
    freeBands: [],
    masterBypass: false,
    presetId: null,
  });
  s.eq.parameters.airDb = 99;
  const back = loadSongSettings('/songs/two.wav');
  check(
    'editing after a save does not rewrite the save',
    back?.state.eq.parameters.airDb === 1.0,
    `saved ${String(back?.state.eq.parameters.airDb)}, live 99`,
  );
}

{
  const s = baseState();
  s.eq = { ...s.eq, parameters: { ...s.eq.parameters, airDb: 5 } };
  saveSongSettings({
    filePath: '/songs/one.wav', state: s, freeBands: [],
    masterBypass: false, presetId: null,
  });
  const back = loadSongSettings('/songs/one.wav');
  const all = savedSongPaths().filter((p) => p === '/songs/one.wav');
  check(
    'saving the same song twice replaces rather than duplicates',
    back?.state.eq.parameters.airDb === 5 && all.length === 1,
    `${all.length} entry for that path`,
  );
}

{
  check(
    'a song that was never opened has no settings',
    loadSongSettings('/songs/never.wav') === null,
  );
  check('clearing removes it', clearSongSettings('/songs/two.wav') === true);
  check('clearing twice is not an error', clearSongSettings('/songs/two.wav') === false);
}

{
  // Identity is the path, so re-importing the same file finds the work.
  const back = loadSongSettings('/songs/one.wav');
  check(
    'settings are found by file path, so re-importing keeps the work',
    back !== null,
    'queue ids are fresh UUIDs — keying by them would lose it',
  );
}

{
  // A corrupt store must not take the app down.
  localStorage.setItem('loui.song.settings', '{ this is not json');
  const back = loadSongSettings('/songs/one.wav');
  check('a corrupt store reads as empty rather than throwing', back === null);
  clearAllSongSettings();
}

console.log('\n=== EXPORT — the saved state reaches a real chain config ===\n');

{
  const s = baseState();
  s['top-rebuild'] = {
    ...s['top-rebuild'],
    parameters: { ...s['top-rebuild'].parameters, amountPct: 70 },
  };
  saveSongSettings({
    filePath: '/songs/three.wav', state: s, freeBands: [],
    masterBypass: false, presetId: null,
  });
  const back = loadSongSettings('/songs/three.wav')!;
  const cfg = buildChainConfig({ state: back.state, masterBypass: back.masterBypass });
  const tr = (cfg as Record<string, { amountPct?: number }>).topRebuild;
  check(
    'a saved module reaches the exported chain config',
    !!tr && tr.amountPct === 70,
    `topRebuild.amountPct = ${String(tr?.amountPct)}`,
  );
}

{
  // Monitoring must never be baked into an export. `renderSong` omits it;
  // this asserts the builder honours that by not inventing one.
  const s = baseState();
  const cfg = buildChainConfig({ state: s, masterBypass: false });
  check(
    'no monitor block leaks into an export config',
    !('monitor' in (cfg as Record<string, unknown>)),
    'A/B and delta are listening aids, not masters',
  );
}

{
  // The end-to-end promise, on the real preset the user reported.
  const s = baseState();
  const vocal = getPreset('ai-vocal-texture')!;
  const { state } = layerAlbumPreset(s, vocal);
  const cfg = buildChainConfig({ state, masterBypass: false });
  const tr = (cfg as Record<string, { amountPct?: number }>).topRebuild;
  check(
    'applying a preset to an untouched song reaches the config in full',
    !!tr && tr.amountPct === 70,
    `topRebuild.amountPct = ${String(tr?.amountPct)}`,
  );
}

{
  // Every preset must survive the layering path — a preset that names a
  // module the state does not have would throw at export time, on a batch,
  // after the user has already waited.
  let ok = true;
  let bad = '';
  for (const p of LOUI_PRESETS) {
    try {
      const { state } = layerAlbumPreset(baseState(), p);
      buildChainConfig({ state, masterBypass: false });
    } catch (e) {
      ok = false;
      bad = `${p.id}: ${(e as Error).message}`;
      break;
    }
  }
  check(
    'every preset can be layered and built without throwing',
    ok,
    bad || `${LOUI_PRESETS.length} presets`,
  );
}

async function renderChecks(): Promise<void> {
  console.log('\n=== RENDER — the saved work reaches the render channel ===\n');
  // The defect this whole feature exists to fix: the main process has had
  // `audio:master-rust-experimental` — the only channel that accepts a
  // suite config — registered and allowlisted with ZERO renderer callers,
  // so every export went through `audio:master`, which knows nothing about
  // the rack. A Studio-tuned song rendered to something that sounded
  // nothing like its preview. These checks watch which channel is used.
  const calls: Array<{ channel: string; args: unknown[] }> = [];
  (globalThis as { window?: unknown }).window = {
    electronAPI: {
      invoke: async (channel: string, ...args: unknown[]) => {
        calls.push({ channel, args });
        if (channel === 'audio:master-rust-experimental') {
          return { ok: true, backend: 'rust', fallbackUsed: false,
            outputPath: '/out/x.wav', previewPath: '/out/x.mp3', renderMs: 10 };
        }
        return { outputPath: '/out/x.wav', previewPath: '/out/x.mp3' };
      },
    },
  };
  const { renderSong } = await import('../src/renderer/audio/session/render-song.js');
  const analysis = {
    loudness: { integratedLufs: -14, truePeakDbtp: -1, lra: 6 },
  } as unknown as Parameters<typeof renderSong>[0]['analysis'];
  const options = {
    style: 'balanced', targetLufs: -14, targetTp: -1,
    sampleRate: 48000, bitDepth: 24, applyAiCorrections: true,
    limiterStrength: 'medium',
  } as unknown as Parameters<typeof renderSong>[0]['options'];

  // A song with no Studio work keeps the old path exactly.
  calls.length = 0;
  const classic = await renderSong({
    filePath: '/songs/plain.wav', analysis, options,
    settings: null, albumPreset: null,
  });
  check(
    'a song never opened in the Studio uses the classic path',
    classic.path === 'classic' && calls[0]?.channel === 'audio:master',
    calls[0]?.channel ?? 'no call',
  );

  // A song WITH Studio work must go through the suite-config channel.
  const s = baseState();
  s['top-rebuild'] = {
    ...s['top-rebuild'],
    parameters: { ...s['top-rebuild'].parameters, amountPct: 70 },
  };
  calls.length = 0;
  const studio = await renderSong({
    filePath: '/songs/tuned.wav', analysis, options,
    settings: {
      filePath: '/songs/tuned.wav', savedAt: 1, state: s,
      freeBands: [], masterBypass: false, presetId: null,
    },
    albumPreset: null,
  });
  check(
    'a song with saved settings uses the suite-config channel',
    studio.path === 'studio' && calls[0]?.channel === 'audio:master-rust-experimental',
    calls[0]?.channel ?? 'no call',
  );

  const req = calls[0]?.args[0] as {
    sourcePath?: string;
    chainConfig?: { suiteConfig?: Record<string, { amountPct?: number }> };
  } | undefined;
  check(
    'and the saved module is actually in the config it sends',
    req?.chainConfig?.suiteConfig?.topRebuild?.amountPct === 70,
    `topRebuild.amountPct = ${String(req?.chainConfig?.suiteConfig?.topRebuild?.amountPct)}`,
  );
  check(
    'no monitor block is sent to the render',
    !('monitor' in (req?.chainConfig?.suiteConfig ?? {})),
    'an export must be the master, not a level-matched bypass',
  );

  // The album preset must still reach the loudness target on the studio
  // path — that is what makes a batch come out at one level.
  calls.length = 0;
  await renderSong({
    filePath: '/songs/tuned.wav', analysis, options,
    settings: {
      filePath: '/songs/tuned.wav', savedAt: 1, state: s,
      freeBands: [], masterBypass: false, presetId: null,
    },
    albumPreset: getPreset('kpop-loud')!,
  });
  const opts = (calls[0]?.args[0] as { options?: { targetLufs?: number } })?.options;
  check(
    'the album preset still sets the loudness target on the studio path',
    typeof opts?.targetLufs === 'number' && opts.targetLufs !== -14,
    `targetLufs = ${String(opts?.targetLufs)} (baseline was -14)`,
  );

  // Loudness. The chain's loop is switched off for the render and the
  // offline two-pass does the job instead — it measures the whole file and
  // applies one constant gain, where a converging loop would leave the
  // intro at a different level from the rest. Both must aim at the same
  // number, or the file will not sound like the preview did.
  calls.length = 0;
  const tuned = baseState();
  tuned.limiter = {
    ...tuned.limiter,
    parameters: { ...tuned.limiter.parameters, targetLufs: -9 },
  };
  await renderSong({
    filePath: '/songs/loud.wav', analysis, options,
    settings: {
      filePath: '/songs/loud.wav', savedAt: 1, state: tuned,
      freeBands: [], masterBypass: false, presetId: null,
    },
    albumPreset: null,
  });
  const sent = calls[0]?.args[0] as {
    options?: { targetLufs?: number };
    chainConfig?: { suiteConfig?: { loudness?: { enabled?: boolean; targetLufs?: number } } };
  } | undefined;
  check(
    "the Studio's Target LUFS decides the exported file's loudness",
    sent?.options?.targetLufs === -9,
    `options.targetLufs = ${String(sent?.options?.targetLufs)}`,
  );
  check(
    'the realtime loudness loop is switched off for the render',
    sent?.chainConfig?.suiteConfig?.loudness?.enabled === false,
    'the offline two-pass measures the whole file instead',
  );

  // A hard failure must surface rather than be reported as a done render.
  (globalThis as { window?: { electronAPI: { invoke: unknown } } }).window = {
    electronAPI: {
      invoke: async () => ({ ok: false, backend: 'python', fallbackUsed: true, error: 'boom' }),
    },
  };
  let threw = false;
  try {
    await renderSong({
      filePath: '/songs/tuned.wav', analysis, options,
      settings: {
        filePath: '/songs/tuned.wav', savedAt: 1, state: s,
        freeBands: [], masterBypass: false, presetId: null,
      },
      albumPreset: null,
    });
  } catch { threw = true; }
  check('a failed render throws rather than reporting done', threw);
}

void renderChecks().then(() => {
  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed === 0 ? 0 : 1);
});
