// flow.mjs — drive the mastering flow through a running app.
//
//   node scripts/app-smoke/flow.mjs [cdp-port] [workdir]
//
// See README.md for why this exists and what it deliberately does not do.

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const PORT = process.argv[2] ?? '9333';
const WORK = process.argv[3] ?? '/tmp/smoke';
const FF = process.env.AIMASTER_FFMPEG ?? 'ffmpeg';
const SR = 48_000;

let step = 0;
let failed = 0;
let skipped = 0;
/** Report one step. `detail` is what was observed, not what was expected. */
function ok(name, detail = '') {
  step++;
  console.log(`  ${String(step).padStart(2)}. ok    ${name}${detail ? `  — ${detail}` : ''}`);
}
function bad(name, detail = '') {
  step++;
  failed++;
  console.error(`  ${String(step).padStart(2)}. FAIL  ${name}${detail ? `  — ${detail}` : ''}`);
}
function expect(cond, name, detail = '') {
  if (cond) ok(name, detail); else bad(name, detail);
  return cond;
}
/**
 * A step that cannot run because an earlier one failed.
 *
 * Reported as skipped, naming the step it waited on, rather than run anyway.
 * The first smoke run let a failed analysis fall through and the next two
 * steps reported `Cannot read properties of undefined (reading 'loudness')`
 * — three failures for one break, and the real one the least legible of the
 * three. A flow test has to say where the flow stopped.
 */
function skip(name, because) {
  step++;
  skipped++;
  console.log(`  ${String(step).padStart(2)}. skip  ${name}  — needs ${because}`);
}

// ── Test media ───────────────────────────────────────────────────────────
// Generated rather than committed: the stems a real check would want are
// somebody's copyrighted music, and three tones answer the only question
// this flow asks of the audio.
const LOW = 60;
const MID = 1_000;
const AIR = 12_000;

function writeWav(file, seconds, amp) {
  const n = Math.floor(seconds * SR);
  const bytes = n * 2 * 3;
  const buf = Buffer.alloc(44 + bytes);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + bytes, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2 * 3, 28); buf.writeUInt16LE(6, 32); buf.writeUInt16LE(24, 34);
  buf.write('data', 36); buf.writeUInt32LE(bytes, 40);
  let o = 44;
  for (let i = 0; i < n; i++) {
    const v = ((Math.sin((2 * Math.PI * LOW * i) / SR)
              + Math.sin((2 * Math.PI * MID * i) / SR)
              + Math.sin((2 * Math.PI * AIR * i) / SR)) / 3) * amp;
    for (const ch of [v, v]) {
      buf.writeIntLE(Math.round(Math.max(-1, Math.min(1, ch)) * 8_388_607), o, 3);
      o += 3;
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return file;
}

/** Level of one tone in a 24-bit stereo WAV, in dBFS. Back half only. */
function toneLevel(file, hz) {
  const buf = fs.readFileSync(file);
  // Walk the chunks rather than assuming a 44-byte header: the app's own
  // encoder is not the only thing that may have written this.
  let p = 12;
  let data = null;
  let channels = 2;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') channels = buf.readUInt16LE(p + 10);
    if (id === 'data') { data = { at: p + 8, size: Math.min(size, buf.length - p - 8) }; break; }
    p += 8 + size + (size % 2);
  }
  if (!data) return null;
  const frames = Math.floor(data.size / (3 * channels));
  const from = Math.floor(frames / 2);
  let re = 0; let im = 0;
  const n = frames - from;
  for (let i = 0; i < n; i++) {
    const at = data.at + (from + i) * 3 * channels;
    const s = buf.readIntLE(at, 3) / 8_388_607;
    const t = 2 * Math.PI * hz * (i / SR);
    re += s * Math.cos(t);
    im -= s * Math.sin(t);
  }
  return 20 * Math.log10(Math.max((2 * Math.sqrt(re * re + im * im)) / n, 1e-12));
}

// ── The flow ─────────────────────────────────────────────────────────────
const src = writeWav(path.join(WORK, 'media', 'smoke-src.wav'), 6, 0.1);
console.log(`\napp-smoke: the mastering flow, end to end\n  source  ${src}\n`);

const browser = await chromium.connectOverCDP(`http://localhost:${PORT}`);
const page = browser.contexts()[0].pages().find((p) => !p.url().startsWith('devtools://'));

// Everything the renderer threw or logged as an error, from here on.
//
// The flow below drove the whole mastering path and nobody was listening: a
// React error inside a panel, a failed dynamic import, an unhandled
// rejection — all of it was invisible, because every step asserts its own
// result and none of them asks what else happened.  Collected from before
// the first interaction so the last step can account for all of it.
const rendererErrors = [];
if (page) {
  page.on('pageerror', (e) => rendererErrors.push({ kind: 'pageerror', text: String(e?.message ?? e) }));
  page.on('console', (m) => {
    if (m.type() === 'error') rendererErrors.push({ kind: 'console', text: m.text() });
  });
}

try {
  // 1 — the app is up and the bridge is there.
  const url = page ? page.url() : '(no page)';
  expect(
    !!page && await page.evaluate(() => typeof window.electronAPI?.invoke === 'function'),
    'the renderer is up with its IPC bridge',
    url,
  );

  // 2 — a dropped file reaches the queue, through the action the DropZone
  //     calls. The queue is cleared first, because the app dedupes by path
  //     and a second run of this script against the same window would
  //     otherwise look like a failure to add — which is what happened, and
  //     a smoke test you cannot run twice is a bad tool. The dedupe is
  //     asserted here instead of being tripped over.
  const queued = await page.evaluate(async (p) => {
    const mod = await import('/stores/audioStore.ts');
    mod.useAudioStore.getState().clearQueue();
    mod.useAudioStore.getState().addFilesToQueue([p]);
    const once = mod.useAudioStore.getState().queue;
    mod.useAudioStore.getState().addFilesToQueue([p]);   // the same file again
    const twice = mod.useAudioStore.getState().queue;
    return {
      count: once.length, again: twice.length,
      item: once[once.length - 1] ?? null,
    };
  }, src);
  expect(
    queued.count === 1 && queued.item?.filePath === src,
    'a dropped file is queued',
    `${queued.count} row, status '${queued.item?.status}', name '${queued.item?.fileName}'`,
  );
  expect(
    queued.again === 1,
    'and dropping the same file again does not add a second row',
    `${queued.again} row after the second drop`,
  );
  const itemId = queued.item?.id;

  // 3 — analysis. The queue's first real work, and what every later step reads.
  const analysis = await page.evaluate(async (p) => {
    try { return { ok: true, v: await window.electronAPI.invoke('audio:analyze', p) }; }
    catch (e) { return { ok: false, e: String(e?.message ?? e) }; }
  }, src);
  expect(
    analysis.ok && typeof analysis.v?.loudness?.integratedLufs === 'number',
    'the source is analysed',
    analysis.ok
      ? `${analysis.v.loudness.integratedLufs.toFixed(2)} LUFS, true peak ${analysis.v.loudness.truePeakDbtp?.toFixed(2)} dBTP`
      : analysis.e,
  );

  // 4 — the song profile, which the Studio's adaptive defaults need. It
  //     returned ok:false on every call in every build until the loader was
  //     fixed, so a smoke run should say which it is today.
  const profile = await page.evaluate(async (p) => {
    try { return await window.electronAPI.invoke('audio:song-profile', p); }
    catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
  }, src);
  expect(
    profile?.ok === true && Array.isArray(profile.profile?.curveDb),
    'the song is profiled, so the defaults can be about this song',
    profile?.ok ? `crest ${profile.profile.crestDb.toFixed(2)} dB, ${profile.profile.curveDb.length} bands`
                : String(profile?.error),
  );

  // 5 — a Studio move, saved. The reported bug lived between here and 7.
  const saved = await page.evaluate(async (p) => {
    const pm = await import('/audio/parameters/index.ts');
    const ss = await import('/audio/session/song-settings.ts');
    const state = pm.defaultAllModulesState(pm.ALL_MODULE_PARAMETER_DEFS);
    state.eq = { ...state.eq, bypass: false,
      parameters: { ...state.eq.parameters, lowShelfDb: 6, airDb: 6 } };
    const res = ss.saveSongSettings({
      filePath: p, state, freeBands: [], masterBypass: false, presetId: null,
    });
    const back = ss.loadSongSettings(p);
    return {
      stored: res.stored,
      evicted: res.evicted,
      readBack: back?.state?.eq?.parameters?.lowShelfDb ?? null,
      changed: ss.changedModules(back?.state ?? {}).length,
    };
  }, src);
  expect(
    saved.stored === true && saved.readBack === 6,
    'the Studio move is saved and reads back',
    `stored=${saved.stored}, evicted=${saved.evicted}, lowShelfDb reads ${saved.readBack}, ${saved.changed} module(s) changed`,
  );

  // 6 — the render, through the path the queue uses. Needs the analysis:
  //     `renderSong` reads its loudness for the before/after report.
  const rendered = !analysis.ok ? { ok: false, skipped: true } : await page.evaluate(async ([p, an]) => {
    const rs = await import('/audio/session/render-song.ts');
    const ss = await import('/audio/session/song-settings.ts');
    try {
      const out = await rs.renderSong({
        filePath: p,
        analysis: an,
        options: { style: 'balanced', targetLufs: -14, targetTp: -1, sampleRate: 48000,
                   bitDepth: 24, applyAiCorrections: false, limiterStrength: 'medium' },
        settings: ss.loadSongSettings(p),
        albumPreset: null,
      });
      return { ok: true, path: out.path, backend: out.backend,
               outputPath: out.result.outputPath,
               warnings: out.result.pipelineWarnings?.map((w) => w.code) ?? [],
               after: out.result.loudnessAfter ?? null };
    } catch (e) { return { ok: false, e: String(e?.message ?? e) }; }
  }, [src, analysis.v]);
  if (rendered.skipped) {
    skip('the render takes the studio path, on the chain engine', 'the analysis step');
  } else {
    expect(
      rendered.ok && rendered.path === 'studio' && rendered.backend === 'rust'
        && rendered.warnings.length === 0,
      'the render takes the studio path, on the chain engine',
      rendered.ok
        ? `path '${rendered.path}', backend '${rendered.backend}', warnings [${rendered.warnings}]`
        : rendered.e,
    );
  }

  // 7 — and the move is in the file. The step every other test stops before.
  if (rendered.ok && rendered.outputPath && fs.existsSync(rendered.outputPath)) {
    const base = writeWav(path.join(WORK, 'media', 'smoke-ref.wav'), 6, 0.1);
    const dLow = toneLevel(rendered.outputPath, LOW) - toneLevel(base, LOW);
    const dMid = toneLevel(rendered.outputPath, MID) - toneLevel(base, MID);
    const dAir = toneLevel(rendered.outputPath, AIR) - toneLevel(base, AIR);
    // Measured as a TILT against the tone nothing asked about, not as an
    // absolute rise against the source.
    //
    // The first version compared each band to the source and failed: the
    // render normalises, and from a -24.05 LUFS source to a -14 target that
    // is about +10 dB on every band at once (measured: +12.49 / +7.30 /
    // +10.19). The EQ move is a tilt, and a tilt is what survives a gain
    // change — so the question is whether the shelves are lifted RELATIVE
    // to the middle, which is immune to however loud the master came out.
    const tiltLow = dLow - dMid;
    const tiltAir = dAir - dMid;
    expect(
      tiltLow > 2 && tiltAir > 1,
      'the saved move is in the exported file',
      `tilt vs ${MID} Hz: ${LOW} Hz +${tiltLow.toFixed(2)} dB, ${AIR} Hz +${tiltAir.toFixed(2)} dB `
      + `(absolute vs source ${dLow.toFixed(2)} / ${dMid.toFixed(2)} / ${dAir.toFixed(2)} dB — `
      + 'the common part is the loudness normalisation)',
    );
    expect(
      fs.statSync(rendered.outputPath).size > 44,
      'the exported file is a real file',
      `${(fs.statSync(rendered.outputPath).size / 1024 / 1024).toFixed(2)} MB at ${rendered.outputPath}`,
    );
  } else if (!rendered.ok || !rendered.outputPath) {
    // Any reason the render did not produce a file — it was skipped, it
    // threw, it refused. One break should cost one failure, and the render
    // has already reported its own.
    const because = rendered.skipped ? 'the analysis' : 'the render';
    skip('the saved move is in the exported file', `the step before it (${because})`);
    skip('the exported file is a real file', `the step before it (${because})`);
  } else {
    bad('the saved move is in the exported file', `no file at ${rendered.outputPath}`);
  }

  // 8 — and the queue row ends up saying what happened.
  if (itemId) {
    const row = await page.evaluate(async ([id, out]) => {
      const mod = await import('/stores/audioStore.ts');
      mod.useAudioStore.getState().updateQueueItem(id, {
        status: 'done', progress: 100, renderedPath: 'studio',
        masteringResult: { outputPath: out, previewPath: '', appliedCorrections: [],
          loudnessBefore: { integratedLufs: 0, truePeakDbtp: 0, lra: 0 },
          loudnessAfter: { integratedLufs: 0, truePeakDbtp: 0, lra: 0 },
          spectralBalance: null, analysisReport: null, pipelineWarnings: [],
          processingTimeSec: 0 },
      });
      const it = mod.useAudioStore.getState().queue.find((q) => q.id === id);
      return { status: it?.status, renderedPath: it?.renderedPath };
    }, [itemId, rendered.outputPath ?? '']);
    expect(
      row.status === 'done' && row.renderedPath === 'studio',
      'the queue row records which path rendered it',
      `status '${row.status}', renderedPath '${row.renderedPath}'`,
    );
  }
  // 9 — and it is still there after a reload.  The reported bug's own
  //     words were "원본으로 돌아간다" — saved, came back, gone — and every
  //     step above proves the save only within one page.  `song-settings`
  //     stores into `localStorage`, which the headless tests stub, so
  //     whether a real renderer hands the same bytes back after a reload is
  //     a question only the real app can answer.  Reuses the entry step 5
  //     wrote rather than saving a second one: the assertion is that the
  //     value a user set is the value that survives.
  //
  //     Last, because a reload throws away the store the steps above built.
  if (saved.stored) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    const fresh = browser.contexts()[0].pages().find((q) => q.url().includes("5173")) ?? page;
    let reloaded = { found: false, readBack: null, e: 'the page never came back' };
    for (let i = 0; i < 20; i++) {
      try {
        reloaded = await fresh.evaluate(async (f) => {
          const ss = await import('/audio/session/song-settings.ts');
          const back = ss.loadSongSettings(f);
          return {
            found: back !== null,
            readBack: back?.state?.eq?.parameters?.lowShelfDb ?? null,
            savedPaths: ss.savedSongPaths().length,
            e: null,
          };
        }, src);
        break;
      } catch (e) { reloaded = { found: false, readBack: null, e: String(e?.message ?? e) }; }
      await fresh.waitForTimeout(1_000);
    }
    expect(
      reloaded.found && reloaded.readBack === 6,
      'the saved move is still there after a reload',
      reloaded.e ?? `found=${reloaded.found}, lowShelfDb reads ${reloaded.readBack}`
        + `, ${reloaded.savedPaths} song(s) saved`,
    );
  } else {
    skip('the saved move is still there after a reload', 'the save step');
  }

  // 10 — every control can hold the value the app opens it with.
  //
  //      A range input's reachable values are `min + n*step`, anchored at
  //      `min`.  `parameter-grid-selftest` checks the definitions against
  //      that rule — but it checks them against the rule AS WRITTEN DOWN
  //      HERE, so if the rule were misread both would be wrong together.
  //      This asks the browser instead: set each control to its own
  //      default and read back what it holds.  That is how the bus
  //      compressor's Attack was caught holding 10.1 where the state said
  //      10, and it is the only version of this check with an independent
  //      judge.
  const held = await page.evaluate(async () => {
    const mod = await import('/audio/parameters/module-parameter-definitions.ts');
    const suite = await import('/audio/parameters/suite-parameter-definitions.ts');
    const el = document.createElement('input');
    el.type = 'range';
    document.body.appendChild(el);
    const bad = [];
    let checked = 0;
    for (const bundle of [mod.ALL_MODULE_PARAMETER_DEFS, suite.SUITE_PARAMETER_DEFS]) {
      for (const m of Object.values(bundle)) {
        for (const d of m.parameters) {
          if (d.kind !== 'number') continue;
          checked++;
          el.min = String(d.min); el.max = String(d.max); el.step = String(d.step);
          el.value = String(d.default);
          if (Number(el.value) !== Number(d.default)) {
            bad.push(`${m.moduleId}.${d.id} default ${d.default} -> control holds ${el.value}`);
          }
        }
      }
    }
    el.remove();
    return { checked, bad };
  });
  expect(
    held.checked > 300 && held.bad.length === 0,
    'every control can hold the value the app opens it with',
    held.bad.length === 0
      ? `${held.checked} numeric controls, all reachable`
      : `${held.bad.length} of ${held.checked}: ${held.bad.slice(0, 4).join('; ')}`,
  );
  // 13 — the worklet assets the preview needs are actually servable.
  //
  //      Packaged Electron loads the renderer from file:// inside app.asar,
  //      where fetching a relative asset is unreliable — so the main process
  //      reads these with Node fs (which understands asar) and hands the
  //      bytes over IPC.  That path has three parties: the renderer asks by
  //      name, `loui:read-worklet-asset` allow-lists the name, and the build
  //      has to have put the file in dist/renderer.  Nothing checked that
  //      they agree, and a disagreement is invisible until the packaged app
  //      tries to start its preview engine — which is the same shape as the
  //      bug this whole directory exists for.
  //
  //      `preview-worklet-selftest` proves the wasm WORKS; this proves it
  //      can be DELIVERED.  Asked through the real bridge, in the real app.
  const assets = await page.evaluate(async () => {
    const names = [
      'loui-mastering-wasm.nomodules.wasm',
      'loui-mastering-wasm.nomodules.js',
      'mastering-chain.worklet.js',
      'analyzer-tap.worklet.js',
    ];
    const bridge = window.louiAssets;
    if (!bridge || typeof bridge.read !== 'function') {
      return { bridge: false, rows: [] };
    }
    const rows = [];
    for (const name of names) {
      try {
        const p = await bridge.read(name);
        rows.push({ name, ok: p.size > 0, kind: p.kind, size: p.size });
      } catch (e) {
        rows.push({ name, ok: false, kind: 'error', size: 0, e: String(e?.message ?? e) });
      }
    }
    return { bridge: true, rows };
  });
  if (!assets.bridge) {
    skip('every worklet asset the preview needs is servable', 'the louiAssets preload bridge');
  } else {
    const bad = assets.rows.filter((r) => !r.ok);
    expect(
      bad.length === 0 && assets.rows.length === 4,
      'every worklet asset the preview needs is servable',
      bad.length === 0
        ? assets.rows.map((r) => `${r.name.replace('loui-mastering-wasm.', '')} ${Math.round(r.size / 1024)}KB`).join(', ')
        : bad.map((r) => `${r.name}: ${r.e ?? r.kind}`).join('; '),
    );
  }
  // ── Every page the app can route to actually mounts ───────────────────
  //
  // The flow above never leaves home, and the headless suite tests DAW,
  // mixer and arrangement MODELS — a `DawPage` that throws on mount would
  // leave all of it green and the feature dead.  So each route is visited
  // for real, through the store the app routes with.
  //
  // Three of the eight require data and bounce to home without it; by this
  // point the flow has queued and rendered a file, so they should mount.
  // The step records where each one landed rather than assuming.
  const ROUTES = ['home', 'mastering', 'result', 'tweak', 'studio', 'qc', 'daw', 'settings'];
  const visits = [];
  for (const route of ROUTES) {
    const before = rendererErrors.length;
    let landed;
    try {
      landed = await page.evaluate(async (r) => {
        const m = await import('/stores/appStore.ts');
        m.useAppStore.getState().setPage(r);
        await new Promise((res) => setTimeout(res, 450));
        const root = document.getElementById('root');
        return {
          page: m.useAppStore.getState().currentPage,
          nodes: root ? root.querySelectorAll('*').length : -1,
        };
      }, route);
    } catch (e) {
      landed = { page: '(threw)', nodes: -1, e: String(e?.message ?? e) };
    }
    visits.push({ route, ...landed, errors: rendererErrors.length - before });
  }
  const emptyPage = visits.filter((v) => v.nodes < 10);
  const threw = visits.filter((v) => v.page === '(threw)' || v.errors > 0);
  expect(
    emptyPage.length === 0 && threw.length === 0,
    'every page the app can route to mounts something',
    emptyPage.length === 0 && threw.length === 0
      ? visits.map((v) => `${v.route}${v.page === v.route ? '' : `→${v.page}`} ${v.nodes}`).join(', ')
      : [...emptyPage, ...threw].map((v) => `${v.route}: landed ${v.page}, ${v.nodes} nodes, ${v.errors} error(s)${v.e ? ` — ${v.e}` : ''}`).join('; '),
  );

  // ── The DAW, driven rather than merely mounted ────────────────────────
  //
  // The step above proves `DawPage` renders.  These drive it: the headless
  // suite has eighty-odd tests over the DAW's MODELS, and not one of them
  // can tell whether the transport clock is actually wired to anything.
  //
  // The rate is sampled IN FLIGHT — two readings while already playing —
  // and the reason is a measurement that went wrong first.  Sampling from
  // before `play()` gave 1.502 s of wall clock for 1.401 s of playhead, a
  // ratio of 0.933, which reads as a 7%-slow clock; the missing 0.101 s was
  // the rAF loop starting.  In flight it measures 0.9962–0.9997 over four
  // runs, so the band below is wide enough for a loaded machine and still
  // catches a clock that does not move (0) or runs away (2).
  const daw = await page.evaluate(async () => {
    const app = await import('/stores/appStore.ts');
    app.useAppStore.getState().setPage('daw');
    await new Promise((r) => setTimeout(r, 600));
    const m = await import('/stores/dawStore.ts');
    const S = () => m.useDawStore.getState();

    const tracksAtOpen = S().session.tracks?.length ?? -1;

    // An edit, and the undo that takes it back.
    S().addTrackHere('audio');
    await new Promise((r) => setTimeout(r, 150));
    const afterAdd = S().session.tracks?.length ?? -1;
    const canUndo = S().canUndo();
    S().undo();
    await new Promise((r) => setTimeout(r, 150));
    const afterUndo = S().session.tracks?.length ?? -1;

    // The clock.
    S().stop(); S().seek(0);
    S().play();
    await new Promise((r) => setTimeout(r, 400));
    const w0 = performance.now(), h0 = S().playheadSec;
    await new Promise((r) => setTimeout(r, 1200));
    const w1 = performance.now(), h1 = S().playheadSec;
    const playing = S().isPlaying;
    S().stop();
    await new Promise((r) => setTimeout(r, 400));
    const stoppedAt = S().playheadSec, stillPlaying = S().isPlaying;
    const rate = (h1 - h0) / ((w1 - w0) / 1000);

    // The loop, entered from just inside its end so a wrap has to happen.
    const LOOP_FROM = 1.0, LOOP_TO = 2.0;
    S().seek(0);
    S().setLoop(LOOP_FROM, LOOP_TO);
    if (!S().loopEnabled) S().toggleLoop();
    S().seek(LOOP_TO - 0.2);
    S().play();
    const samples = [];
    for (let i = 0; i < 14; i++) {
      await new Promise((r) => setTimeout(r, 120));
      samples.push(S().playheadSec);
    }
    S().stop();
    if (S().loopEnabled) S().toggleLoop();

    return { tracksAtOpen, afterAdd, canUndo, afterUndo,
             rate, playing, stoppedAt, stillPlaying, h1,
             loop: { from: LOOP_FROM, to: LOOP_TO, samples } };
  });

  expect(
    daw.tracksAtOpen >= 1 && daw.afterAdd === daw.tracksAtOpen + 1
      && daw.canUndo === true && daw.afterUndo === daw.tracksAtOpen,
    'the DAW takes an edit and gives it back',
    `${daw.tracksAtOpen} track(s) at open → ${daw.afterAdd} after add → ${daw.afterUndo} after undo`,
  );

  expect(
    daw.playing === true && daw.rate > 0.9 && daw.rate < 1.1,
    'the playhead runs at real time while playing',
    `${daw.rate.toFixed(4)} playhead-seconds per wall second, sampled in flight`,
  );

  expect(
    daw.stillPlaying === false && Math.abs(daw.stoppedAt - daw.h1) < 0.05,
    'and stop freezes it where it was',
    `isPlaying ${daw.stillPlaying}, playhead ${daw.h1.toFixed(3)} → ${daw.stoppedAt.toFixed(3)} over 400 ms`,
  );

  {
    // A wrap must happen, every sample must stay inside the loop (plus one
    // sampling interval of slop at the top), and the landing carries the
    // remainder rather than snapping to the start — measured 1.921 → 1.059,
    // which is the loop end plus the overshoot, not the loop start.
    const { from, to, samples } = daw.loop;
    const wraps = samples.filter((v, i) => i > 0 && v < samples[i - 1] - 0.3).length;
    const outside = samples.filter((v) => v < from - 0.02 || v > to + 0.2);
    const landings = samples.filter((v, i) => i > 0 && v < samples[i - 1] - 0.3);
    const snapped = landings.filter((v) => Math.abs(v - from) < 0.005);
    expect(
      wraps >= 1 && outside.length === 0 && snapped.length === 0,
      'a loop keeps the playhead inside it, carrying the remainder',
      `${wraps} wrap(s) in [${from}, ${to}], range ${Math.min(...samples).toFixed(3)}–${Math.max(...samples).toFixed(3)}`
      + (outside.length ? `, OUTSIDE: ${outside.map((v) => v.toFixed(3)).join(', ')}` : '')
      + (snapped.length ? `, snapped to start: ${snapped.map((v) => v.toFixed(3)).join(', ')}` : ''),
    );
  }

  // ── The decoded-audio store, with ffmpeg and a real disk ──────────────
  //
  // `daw:pcm-source` decodes a source once and keeps the samples on disk
  // under a 12 GB cap.  The sweep that enforces the cap counted `*.f32` only,
  // so a `.part` file left by a killed decode — up to ~4 GB for a file at the
  // handler's three-hour ceiling — was counted by nothing and deleted by
  // nothing.  Driven here rather than only in a temp directory, because the
  // store's directory, its ffmpeg and its sweep all live in the main process.
  {
    const decode = async (rate) => page.evaluate(async ([w, r]) => {
      try { return { ok: true, r: await window.electronAPI.invoke('daw:pcm-source', { path: w, sampleRate: r }) }; }
      catch (e) { return { ok: false, e: String(e?.message ?? e) }; }
    }, [src, rate]);

    const first = await decode(48000);
    const info = first.r ?? {};
    const sizeOk = first.ok && typeof info.pcmPath === 'string' && fs.existsSync(info.pcmPath)
      && fs.statSync(info.pcmPath).size === info.frames * info.channels * 4;
    expect(
      sizeOk && Array.isArray(info.peaks) && info.peaks.length > 0,
      'ffmpeg decodes a source into the store, and the file size IS the frame count',
      first.ok
        ? `${info.frames} frames x ${info.channels}ch, ${(fs.statSync(info.pcmPath).size / 1e6).toFixed(2)} MB, `
          + `${info.peaks?.length} peaks`
        : first.e.slice(0, 140),
    );

    if (sizeOk) {
      const dir = path.dirname(info.pcmPath);
      const key = path.basename(info.pcmPath).replace(/\.f32$/, '');
      expect(
        fs.existsSync(path.join(dir, `${key}.json`)),
        'and writes the sidecar the next session reads instead of decoding again',
        `${key.slice(0, 10)}….json beside ${key.slice(0, 10)}….f32`,
      );

      // A decode that died: ffmpeg had written most of the file and nothing
      // ever came back to remove it.  Aged two hours so the sweep can tell it
      // from one being written right now.
      const orphan = path.join(dir, `${'f'.repeat(40)}.11111111-2222-3333-4444-555555555555.part`);
      fs.writeFileSync(orphan, Buffer.alloc(3 * 1024 * 1024));
      const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
      fs.utimesSync(orphan, old, old);

      // A different rate is a different store, so this one misses the cache
      // and the sweep runs for real.
      const second = await decode(44100);
      expect(
        second.ok && !fs.existsSync(orphan),
        'and the next decode sweeps out a part-file no request could ever use',
        second.ok
          ? (fs.existsSync(orphan) ? 'the orphan is STILL THERE' : 'orphan gone, 3 MB reclaimed')
          : second.e.slice(0, 140),
      );
      // Leave the profile as it was found.
      for (const n of fs.readdirSync(dir)) {
        if (n.startsWith(key) || n.startsWith(path.basename(String(second.r?.pcmPath ?? '')).slice(0, 40))) {
          try { fs.rmSync(path.join(dir, n), { force: true }); } catch { /* fine */ }
        }
      }
    } else {
      bad('and writes the sidecar the next session reads instead of decoding again', 'no store');
      bad('and the next decode sweeps out a part-file no request could ever use', 'no store');
    }
  }

  // ── Crash recovery, end to end ────────────────────────────────────────
  //
  // The app writes an autosave, keeps the one before it as a `.bak`, and
  // offers them back at startup.  Nothing had ever driven that chain: the
  // decision model was tested with hand-made records, and the main process's
  // half — the atomic write, the kept generation, the listing — could not be
  // imported outside Electron at all.  So the `.bak` was written, swept after
  // thirty days and deleted on a clean save while `autosave:list` filtered
  // `*.louisession`, which excludes it, and no code path could reach it.
  //
  // Both writes here go through the real IPC handler, so the previous
  // generation this reads back is one the app made, not one the test planted.
  {
    const sessionJson = (name) => JSON.stringify({
      version: 3, id: 'smoke-recovery', name,
      sampleRate: 48000, tempoBpm: 120, timeSignature: [4, 4],
      files: [], tracks: [], padding: 'x'.repeat(2000),
    }, null, 2);

    const written = await page.evaluate(async ([first, second]) => {
      const api = window.electronAPI;
      const a = await api.invoke('autosave:write', { id: 'smoke-recovery', data: first });
      // A distinct second write is what produces the backup: the handler
      // copies the current target aside before the new bytes land.
      const b = await api.invoke('autosave:write', { id: 'smoke-recovery', data: second });
      const list = await api.invoke('autosave:list');
      return { a, b, list };
    }, [sessionJson('스모크 복구 — 먼저'), sessionJson('스모크 복구 — 나중')]);

    const mine = (written.list ?? []).filter((r) => String(r.path ?? '').includes('smoke-recovery'));
    const latest = mine.find((r) => r.generation === 'latest');
    const previous = mine.find((r) => r.generation === 'previous');
    expect(
      latest !== undefined && previous !== undefined
        && previous.path === `${latest.path}.bak`
        && latest.sessionName === '스모크 복구 — 나중'
        && previous.sessionName === '스모크 복구 — 먼저'
        && latest.savedAtMs >= previous.savedAtMs,
      'the app keeps the autosave before last, and the listing hands back both',
      mine.map((r) => `${r.generation}:${r.sessionName}`).join(' | ')
      + (latest && previous ? `, latest leads by ${(latest.savedAtMs - previous.savedAtMs).toFixed(0)} ms` : ''),
    );

    // Now the prompt itself, after a reload — it scans once, on mount.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    const prompt = await page.evaluate(async () => {
      const m = await import('/stores/appStore.ts');
      m.useAppStore.getState().setPage('daw');
      await new Promise((res) => setTimeout(res, 900));
      const text = document.body.innerText ?? '';
      const banner = text.includes('복구할 세션이 있습니다');
      const buttons = Array.from(document.querySelectorAll('button')).map((b) => b.innerText.trim());
      return { banner, previousControl: buttons.find((t) => t.startsWith('그 전 ·')) ?? null, buttons: buttons.slice(0, 40) };
    });
    expect(
      prompt.banner && prompt.previousControl !== null,
      'and the restore prompt offers the previous copy as a second choice',
      prompt.banner
        ? `banner up, "${prompt.previousControl ?? 'NO PREVIOUS CONTROL'}"`
        : 'no recovery banner at all',
    );

    // Leave the profile as it was found, so a second run of this flow is not
    // greeted by the first run's leftovers.
    await page.evaluate(async () => {
      await window.electronAPI.invoke('autosave:clear', 'smoke-recovery');
    });
  }

  // ── What the engine noticed about the file ────────────────────────────
  // `analyze` has always returned `warnings` — Korean, written for the user —
  // and shared-types did not declare the field, so no renderer code could
  // read it and none did.  Measured on a mono 22.05 kHz wav: three warnings
  // crossed the IPC boundary and the user was told none of them.
  //
  // Driven through the real engine here, because the warnings are the engine's
  // judgement about the file and a stub would only prove the markup renders.
  {
    const mono = path.join(WORK, 'media', 'mono-22k.wav');
    fs.writeFileSync(mono, Buffer.alloc(0));
    const built = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-ar', '22050', '-ac', '1', '-acodec', 'pcm_s16le', mono], { encoding: 'utf8' });

    const shown = await page.evaluate(async (monoPath) => {
      const api = window.electronAPI;
      const analysis = await api.invoke('audio:analyze', monoPath);
      const store = await import('/stores/audioStore.ts');
      const app = await import('/stores/appStore.ts');
      app.useAppStore.getState().setPage('home');
      store.useAudioStore.getState().clearQueue();
      store.useAudioStore.getState().addFilesToQueue([monoPath]);
      const id = store.useAudioStore.getState().queue[0]?.id;
      store.useAudioStore.getState().updateQueueItem(id, { analysis });
      await new Promise((r) => setTimeout(r, 400));
      const list = document.querySelector('[data-testid="analysis-warnings"]');
      const text = list ? list.innerText.trim() : '';
      store.useAudioStore.getState().clearQueue();
      return {
        codes: (analysis.warnings ?? []).map((w) => w.code),
        rendered: text,
        lines: list ? list.querySelectorAll('li').length : 0,
      };
    }, mono);

    expect(
      built.status === 0 && shown.codes.includes('MONO_INPUT')
        && shown.codes.includes('NON_STANDARD_SAMPLE_RATE'),
      'the engine says what is wrong with a mono 22 kHz file',
      built.status === 0 ? shown.codes.join(', ') : `could not build the file: ${built.stderr}`,
    );
    expect(
      shown.lines === shown.codes.length && /22050|모노/.test(shown.rendered),
      'and the queue row the file sits on says it to the user',
      shown.lines > 0
        ? `${shown.lines} line(s) on the row: "${shown.rendered.replace(/\n/g, ' / ').slice(0, 110)}"`
        : 'nothing was rendered on the row',
    );
    fs.rmSync(mono, { force: true });
  }

  // ── A file the app cannot decode ──────────────────────────────────────
  // The reason has to survive two hand-offs to be worth anything: main has to
  // turn ffmpeg's English stderr into a sentence, and the renderer has to keep
  // it.  Measured before this was fixed: main rejected with
  // `ffmpeg exited 1: ... Invalid data found ...` and the renderer replaced it
  // with "소스를 준비하지 못했습니다" — the same words for a file that is not
  // audio, a file that has moved, and a disk with no room left.
  //
  // Through the real IPC with the real ffmpeg, because the classification runs
  // in main and nothing in the renderer can stand in for it.
  {
    const bad = path.join(WORK, 'media', 'not-audio.wav');
    fs.writeFileSync(bad, Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) % 256)));
    const gone = path.join(WORK, 'media', '사라진 파일.wav');

    const said = await page.evaluate(async ([badPath, gonePath]) => {
      const ask = async (p) => {
        try {
          await window.electronAPI.invoke('daw:pcm-source', { path: p, sampleRate: 48000 });
          return '(no error at all)';
        } catch (e) { return String(e?.message ?? e); }
      };
      const store = await import('/daw/engine/audio-cache.ts');
      store.clearAudioCache();
      const report = await store.decodeForDisplay([{ id: 'smoke-bad', path: badPath }]);
      const remembered = store.missingFiles().find((f) => f.id === 'smoke-bad');
      return {
        corrupt: await ask(badPath),
        missing: await ask(gonePath),
        reason: remembered?.reason ?? '(nothing was remembered)',
        failed: report.failed.length,
      };
    }, [bad, gone]);

    expect(
      /손상|지원하지 않는/.test(said.corrupt) && !/ffmpeg exited/.test(said.corrupt),
      'a file that is not audio comes back as a sentence, not as ffmpeg stderr',
      said.corrupt.slice(0, 120),
    );
    expect(
      /찾을 수 없습니다/.test(said.missing) && said.missing.includes('사라진 파일.wav')
        && !/ENOENT|no such file/i.test(said.missing),
      'and so does a file that is not there — naming it, before ffmpeg is involved',
      said.missing.slice(0, 120),
    );
    expect(
      said.failed === 1 && /손상|지원하지 않는/.test(said.reason),
      'and the DAW remembers that reason against the track, not a placeholder',
      `failed=${said.failed}, reason="${said.reason.slice(0, 90)}"`,
    );
    fs.rmSync(bad, { force: true });
  }

  // ── The licence, on the real store ────────────────────────────────────
  // license-core-selftest drives the service against a Map.  This asks the
  // running app, where the store is electron-store on disk and the machine id
  // comes from the machine: `_readTrialUsed` calls `machineIdSync` OUTSIDE its
  // try block, so a host that cannot produce an id rejects `license:status`
  // rather than answering free, and the only place that shows up is here.
  //
  // `remaining` is Infinity, which CDP serialises as null — compared as a
  // string so a missing value cannot read as a pass.
  {
    const lic = await page.evaluate(async () => {
      const api = window.electronAPI;
      const before = await api.invoke('license:status');
      const gate = await api.invoke('license:can-process');
      await api.invoke('license:decrement-trial');
      const after = await api.invoke('license:status');
      const remaining = await api.invoke('license:get-remaining');
      return { before, gate: { ...gate, remaining: String(gate.remaining) }, after, remaining: String(remaining) };
    });
    expect(
      lic.before?.tier === 'free' && lic.before?.trialUsed === 0 && lic.before?.trialMax === 3
        && lic.before?.canSaveMasterWav === true,
      'the app reads its own licence store and reports an honest free build',
      JSON.stringify(lic.before),
    );
    expect(
      lic.gate?.allowed === true && lic.gate?.isPaid === true && lic.gate?.remaining === 'Infinity'
        && lic.remaining === 'Infinity' && lic.after?.trialUsed === 0,
      'and a processing run is allowed without counting anything',
      `gate=${JSON.stringify(lic.gate)}, trialUsed after a run=${String(lic.after?.trialUsed)}`,
    );
  }

  // ── And nothing was thrown along the way ──────────────────────────────
  // CDP delivers console events asynchronously, so a message logged by the
  // last step can still be in flight when that step's promise settles.  The
  // packaged flow measured it: with this wait removed and errors injected
  // into the page, a `pageerror` from a setTimeout never arrived and the step
  // read `clean`.
  // ── The Home a release actually ships ─────────────────────────────────
  //
  // ── Eight tracks, and how many of them the window shows ────────────────
  //
  // The report: "7개 이상의 트랙을 올리면 7개부터는 UX 에서 짤려서 오디오 파형이
  // 보이지 않는다".  It was not the waveform.  Four lanes above the tracks —
  // sections, chords, picture, tempo — sit INSIDE the track scroller and took
  // its first 190 px whether or not the session had anything to put in them,
  // and 190 px is two lanes at 96.  Measured here at 1920×1080: six tracks
  // fitted and the seventh was cut.
  //
  // So the window is forced to a real full-screen size — the Electron window
  // this harness boots is 1100×715, which shows two and would have called the
  // bug fixed at any point — eight stems are imported, and the lanes are
  // counted against the scroller that actually holds them.
  {
    const cdp = await browser.contexts()[0].newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    await page.waitForTimeout(400);

    const stems = Array.from({ length: 8 }, (_, i) =>
      writeWav(path.join(WORK, 'media', `stem${i + 1}.wav`), 3 + i * 0.5, 0.2));

    const seen = await page.evaluate(async (paths) => {
      const app = await import('/stores/appStore.ts');
      app.useAppStore.getState().setPage('daw');
      await new Promise((r) => setTimeout(r, 700));
      const daw = await import('/stores/dawStore.ts');
      daw.useDawStore.getState().setWindow('edit');
      // From a known session, not from whatever the last run left on disk:
      // the app restores the previous session, and counting lanes in a
      // session that already had nine of them is a check that passes for the
      // wrong reason.
      const ops = await import('/daw/model/session-ops.ts');
      daw.useDawStore.getState().loadSession(ops.createSession('smoke-eight'));
      await new Promise((r) => setTimeout(r, 300));
      const si = await import('/daw/edit/session-import.ts');
      const report = await si.importIntoSession(paths, [], 0);
      await new Promise((r) => setTimeout(r, 1500));

      const read = () => {
        const divs = [...document.querySelectorAll('div')];
        const sc = divs.find((d) => typeof d.className === 'string'
          && d.className.includes('overflow-y-auto') && d.className.includes('flex-1'));
        if (!sc) return null;
        const box = sc.getBoundingClientRect();
        // TRACK lanes only.  The global lanes draw canvases too, so counting
        // every canvas in the column called the tempo lane a track — which is
        // exactly the confusion this step exists to measure.
        const lanes = [...sc.children[1].querySelectorAll(
          'div.border-b.border-zinc-900 > canvas')]
          .map((c) => c.getBoundingClientRect())
          .filter((r) => r.height > 0);
        // The two columns are two renderings of one list: every row that is
        // built must start at the same y in both, or a header names a lane
        // that is not beside it.
        // In-flow children only.  The lane column also holds the playhead and
        // the empty-session notice, both ABSOLUTE and neither a row — counting
        // them made the two columns look one apart when they were not.
        const inFlow = (el) => [...el.children]
          .filter((c) => getComputedStyle(c).position !== 'absolute')
          .map((c) => Math.round(c.getBoundingClientRect().top));
        const heads = inFlow(sc.children[0]);
        const rows = inFlow(sc.children[1]);
        return {
          scroller: Math.round(box.height),
          scrollHeight: sc.scrollHeight,
          fully: lanes.filter((r) => r.top >= box.top && r.bottom <= box.bottom).length,
          aligned: heads.length === rows.length && heads.every((t, i) => t === rows[i]),
          columns: `${heads.length} header rows / ${rows.length} lane rows`,
        };
      };

      const before = read();
      // FIT, by the button the user has — not by calling the store.
      const fit = [...document.querySelectorAll('button')]
        .find((b) => (b.getAttribute('title') ?? '').startsWith('세로 맞춤'));
      fit?.click();
      await new Promise((r) => setTimeout(r, 600));
      const after = read();
      return { tracks: report.audioTracks, failed: report.failed, before, after,
               rows: daw.useDawStore.getState().session.tracks.length,
               hasFit: Boolean(fit) };
    }, stems);

    expect(
      seen.tracks === 8 && seen.failed.length === 0 && seen.rows === 9,
      'eight stems import as eight tracks, in a session of nine rows',
      `${seen.tracks} imported, ${seen.failed.length} refused, ${seen.rows} rows with the master`,
    );
    expect(
      seen.before !== null && seen.before.fully >= 8,
      'and at 1920×1080 the seventh and eighth are on screen, not below it',
      seen.before
        ? `${seen.before.fully} whole lanes in a ${seen.before.scroller} px scroller`
        : 'no track scroller found',
    );
    expect(
      seen.before !== null && seen.before.aligned,
      'headers and lanes are still the same list, row for row',
      seen.before ? seen.before.columns : '—',
    );
    expect(
      seen.hasFit && seen.after !== null && seen.after.scrollHeight <= seen.after.scroller,
      'and FIT puts every row inside the window, with nothing left to scroll',
      seen.after
        ? `${seen.after.fully} whole lanes, content ${seen.after.scrollHeight} px in ${seen.after.scroller} px`
        : 'FIT button not found',
    );

    // ── and twenty of them ──────────────────────────────────────────────
    //
    // Twenty is what FIT aims for: below 28 px a lane is a stripe, and
    // twenty of those need 560 px of scroller.  Three toolbars used to wrap
    // onto second and third lines as the window narrowed — 284 px of chrome
    // at 1280 px wide against 188 at 1920 — so the narrow windows were the
    // ones that could show the fewest tracks.  They scroll sideways now.
    const twenty = await page.evaluate(async (paths) => {
      const si = await import('/daw/edit/session-import.ts');
      const daw = await import('/stores/dawStore.ts');
      await si.importIntoSession(paths, [], 0);
      await new Promise((r) => setTimeout(r, 2000));
      [...document.querySelectorAll('button')]
        .find((b) => (b.getAttribute('title') ?? '').startsWith('세로 맞춤'))?.click();
      await new Promise((r) => setTimeout(r, 800));
      const divs = [...document.querySelectorAll('div')];
      const sc = divs.find((d) => typeof d.className === 'string'
        && d.className.includes('overflow-y-auto') && d.className.includes('flex-1'));
      const box = sc.getBoundingClientRect();
      const lanes = [...sc.children[1].querySelectorAll('div.border-b.border-zinc-900 > canvas')]
        .map((c) => c.getBoundingClientRect()).filter((r) => r.height > 0);
      return {
        rows: daw.useDawStore.getState().session.tracks.length,
        whole: lanes.filter((r) => r.top >= box.top && r.bottom <= box.bottom).length,
        laneH: lanes.length ? Math.round(lanes[0].height) : 0,
        scroller: Math.round(box.height),
        chromeAbove: Math.round(box.top),
      };
    }, stems.concat(stems).slice(0, 12));

    expect(
      twenty.rows === 21,
      'twelve more stems make a twenty-track session',
      `${twenty.rows} rows with the master`,
    );
    expect(
      twenty.whole >= 20,
      'and FIT puts twenty of them on screen at once',
      `${twenty.whole} whole lanes at ${twenty.laneH} px in a ${twenty.scroller} px scroller`,
    );
    expect(
      twenty.chromeAbove <= 200,
      'with the chrome above the tracks holding at one line each',
      `${twenty.chromeAbove} px above the scroller`,
    );

    // The size that used to be worst.  At 1280 px wide the three toolbars
    // wrapped onto second and third lines — 284 px of chrome against 188 at
    // 1920 — and only seventeen lanes could be reached however small they
    // got.  Measured here rather than at 1920, because at 1920 nothing
    // wrapped and the check would pass with the wrapping put back.
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await page.waitForTimeout(600);
    const narrow = await page.evaluate(async () => {
      [...document.querySelectorAll('button')]
        .find((b) => (b.getAttribute('title') ?? '').startsWith('세로 맞춤'))?.click();
      await new Promise((r) => setTimeout(r, 800));
      const divs = [...document.querySelectorAll('div')];
      const sc = divs.find((d) => typeof d.className === 'string'
        && d.className.includes('overflow-y-auto') && d.className.includes('flex-1'));
      const box = sc.getBoundingClientRect();
      const lanes = [...sc.children[1].querySelectorAll('div.border-b.border-zinc-900 > canvas')]
        .map((c) => c.getBoundingClientRect()).filter((r) => r.height > 0);
      return {
        chromeAbove: Math.round(box.top),
        scroller: Math.round(box.height),
        whole: lanes.filter((r) => r.top >= box.top && r.bottom <= box.bottom).length,
        laneH: lanes.length ? Math.round(lanes[0].height) : 0,
      };
    });

    expect(
      narrow.chromeAbove <= 200,
      'a 1280 px wide window spends no more chrome than a 1920 one',
      `${narrow.chromeAbove} px above the scroller, ${narrow.scroller} px of scroller`,
    );
    expect(
      narrow.whole >= 20,
      'and twenty tracks still fit in it',
      `${narrow.whole} whole lanes at ${narrow.laneH} px`,
    );

    await cdp.send('Emulation.clearDeviceMetricsOverride');
  }

  // ── 악기별 기본 체인, through the mixer strip ──────────────────────────
  //
  // The chains are data checked by `instrument-chains-selftest`; what this
  // checks is the thing that data exists for — that picking "보컬" in the
  // console puts six devices on the channel, in order, with the settings
  // that were written rather than the defaults.  Through the strip's own
  // <select>, because that is the control a beginner uses.
  {
    const chain = await page.evaluate(async () => {
      const app = await import('/stores/appStore.ts');
      app.useAppStore.getState().setPage('daw');
      await new Promise((r) => setTimeout(r, 400));
      const daw = await import('/stores/dawStore.ts');
      const ops = await import('/daw/model/session-ops.ts');
      const vox = ops.createTrack('Lead Vox', 'audio');
      daw.useDawStore.getState().loadSession(ops.addTrack(ops.createSession('chains'), vox));
      daw.useDawStore.getState().setWindow('mix');
      await new Promise((r) => setTimeout(r, 900));

      const pick = [...document.querySelectorAll('select')]
        .find((el) => (el.getAttribute('title') ?? '').startsWith('악기를 고르면'));
      if (!pick) return { error: '악기 체인 picker not in the mixer strip' };
      // The option list is built on first interaction — a lazy <select>.
      pick.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      const options = [...pick.options].map((o) => o.value).filter(Boolean);
      pick.value = 'vocal';
      pick.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 600));

      const chains = await import('/daw/model/instrument-chains.ts');
      const wanted = chains.findInstrumentChain('vocal');
      const track = ops.findTrack(daw.useDawStore.getState().session, vox.id);
      const got = [...(track?.inserts ?? [])].sort((a, b) => a.slot - b.slot);
      const wrong = [];
      wanted.devices.forEach((device, i) => {
        if (got[i]?.pluginId !== device.pluginId) {
          wrong.push(`slot ${i}: ${got[i]?.pluginId ?? '(empty)'} ≠ ${device.pluginId}`);
          return;
        }
        // Resolved the way the app resolves it: a device the instrument
        // presets answer takes its settings from there, not from the chain.
        for (const [id, value] of Object.entries(chains.chainDeviceParams(wanted, device))) {
          if (got[i].params[id] !== value) wrong.push(`${device.pluginId}.${id}`);
        }
      });
      return {
        options: options.length,
        order: got.map((i) => i.pluginId),
        wanted: wanted.devices.map((d) => d.pluginId),
        wrong,
      };
    });

    expect(
      !chain.error && chain.options === 12,
      'the mixer strip offers twelve instrument chains',
      chain.error ?? `${chain.options} options`,
    );
    expect(
      !chain.error && chain.order.join('>') === chain.wanted.join('>'),
      'and picking 보컬 builds the vocal chain in order',
      chain.error ?? `${chain.order.join(' → ')}`,
    );
    expect(
      !chain.error && chain.wrong.length === 0,
      'with the settings the chain carries, not the devices\' defaults',
      chain.error ?? (chain.wrong.length === 0 ? 'every value as written' : chain.wrong.slice(0, 4).join(', ')),
    );
  }

  // ── 공간계는 센드로, through the same strip ────────────────────────────
  //
  // `chain-sends-selftest` checks the model.  What that cannot check is the
  // part that decides whether anybody ever gets there: the SEND toggle lives
  // in the workspace store and is read by two different panels, so the thing
  // worth driving in a real renderer is "press the button in the console, pick
  // the same chain, and the reverb is now on an aux".
  //
  // Pressed on the strip that just loaded the chain as inserts, so this also
  // exercises the replace path over an existing channel rather than a clean
  // one.
  {
    const routed = await page.evaluate(async () => {
      const daw = await import('/stores/dawStore.ts');
      const ops = await import('/daw/model/session-ops.ts');
      const before = daw.useDawStore.getState().session;
      const vox = before.tracks.find((t) => t.kind === 'audio');
      if (!vox) return { error: 'the audio track from the previous step is gone' };

      const toggle = [...document.querySelectorAll('button')]
        .find((el) => (el.getAttribute('title') ?? '').startsWith('공간계(리버브'));
      if (!toggle) return { error: 'SEND toggle not in the mixer strip' };
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));

      const ws = await import('/stores/workspaceStore.ts');
      const flagOn = ws.useWorkspaceStore.getState().chainSendRouting === true;

      const pick = [...document.querySelectorAll('select')]
        .find((el) => (el.getAttribute('title') ?? '').startsWith('악기를 고르면'));
      if (!pick) return { error: '악기 체인 picker not in the mixer strip' };
      pick.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      pick.value = 'vocal';
      pick.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 700));

      const after = daw.useDawStore.getState().session;
      const track = ops.findTrack(after, vox.id);
      const auxes = after.tracks.filter((t) => t.kind === 'aux');
      const sends = (track?.sends ?? []).map((x) => ({ target: x.target, db: x.levelDb, pre: x.preFader }));
      // Read the aux's own mix the way the module does: off the descriptor's
      // declared range, which is 0..1 on the delay and 0..100 on the plate.
      const plugins = await import('/daw/engine/plugins.ts');
      const wets = auxes.map((a) => {
        const only = a.inserts[0];
        const def = plugins.findPlugin(only?.pluginId ?? '')?.params
          .find((x) => x.id === 'mix' || x.id === 'mixPct');
        if (!only || !def) return null;
        return (only.params[def.id] - def.min) / (def.max - def.min);
      });

      return {
        flagOn,
        inserts: [...(track?.inserts ?? [])].sort((a, b) => a.slot - b.slot).map((i) => i.pluginId),
        auxes: auxes.map((a) => a.inserts[0]?.pluginId ?? '(empty)').sort(),
        auxFedByBus: auxes.every((a) => a.input !== null && after.buses.some((b) => b.id === a.input)),
        buses: after.buses.length,
        sends,
        sendsHitAuxes: sends.length > 0
          && sends.every((x) => auxes.some((a) => a.input === x.target)),
        wets,
      };
    });

    expect(
      !routed.error && routed.flagOn,
      'the SEND toggle in the console sets the workspace flag both pickers read',
      routed.error ?? 'chainSendRouting = true after one click',
    );
    expect(
      !routed.error && routed.inserts.join('>') === 'eq8>comp>deesser>tube'
        && routed.auxes.join(',') === 'delay,plate',
      'and the vocal chain\'s tail moves out of the channel onto two auxes',
      routed.error ?? `channel ${routed.inserts.join(' → ')} · auxes ${routed.auxes.join(', ')}`,
    );
    expect(
      !routed.error && routed.auxFedByBus && routed.sendsHitAuxes && routed.buses === 2,
      'wired end to end — track → bus → aux, in the live session',
      routed.error ?? `${routed.buses} buses, sends ${routed.sends
        .map((x) => `${x.db.toFixed(1)}dB${x.pre ? ' PRE' : ''}`).join(', ')}`,
    );
    expect(
      !routed.error && routed.wets.length === 2
        && routed.wets.every((w) => w !== null && Math.abs(w - 1) < 1e-9),
      'with both auxes fully wet, so the return is effect and not a second dry path',
      routed.error ?? `aux mix ${routed.wets.map((w) => (w === null ? '?' : `${(w * 100).toFixed(0)}%`)).join(', ')}`,
    );
  }

  // ── Cubase 격차 1~3, in the real renderer ──────────────────────────────
  //
  // Driven with Playwright's REAL mouse and keyboard, not synthetic events.
  // Two of these three gestures are defined by what the browser does when
  // nobody stops it — Ctrl + wheel is page zoom, a drag is a sequence the
  // event system assembles — so a hand-built MouseEvent would be testing my
  // idea of the gesture rather than the gesture.
  {
    const setup = await page.evaluate(async () => {
      const app = await import('/stores/appStore.ts');
      app.useAppStore.getState().setPage('daw');
      await new Promise((r) => setTimeout(r, 300));
      const daw = await import('/stores/dawStore.ts');
      const ops = await import('/daw/model/session-ops.ts');

      const clip = ops.createClip('ux-file', 'ux.wav', { startSec: 4, durationSec: 3 });
      const a = ops.createTrack('UX A', 'audio');
      const withClip = { ...a, playlists: a.playlists.map((p) => ({ ...p, clips: [clip] })) };
      const b = ops.createTrack('UX B', 'audio');
      daw.useDawStore.getState().loadSession(
        ops.addTrack(ops.addTrack(ops.createSession('ux'), withClip), b));
      daw.useDawStore.getState().setWindow('edit');
      daw.useDawStore.getState().setPxPerSec(60);
      daw.useDawStore.getState().setScrollSec(0);
      await new Promise((r) => setTimeout(r, 800));

      // Scoped to the row scroller.  The bare class combo also matches
      // EditWindow's OUTER container — whose children are the toolbar, the
      // ruler and the status bar — and a probe that measured those put the
      // drag's coordinates on the toolbar while reporting no error at all.
      const lanes = document.querySelectorAll(
        'div.flex-1.flex.overflow-y-auto > div.flex-1.relative.overflow-hidden');
      if (lanes.length !== 1) return { error: `lane column selector matched ${lanes.length}` };
      const lane = lanes[0];
      const rect = lane.getBoundingClientRect();
      // In-flow children only: the padding spacers are zero-height and the
      // playhead is absolutely positioned over the whole column.
      const rows = [...lane.children]
        .filter((el) => getComputedStyle(el).position !== 'absolute')
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.height > 20);
      if (rows.length < 2) return { error: `only ${rows.length} lane row(s)` };
      return {
        lane: { left: rect.left, top: rect.top, width: rect.width },
        rowA: { top: rows[0].top, height: rows[0].height },
        rowB: { top: rows[1].top, height: rows[1].height },
        trackA: withClip.id, trackB: b.id, clipId: clip.id,
        innerWidth: window.innerWidth,
      };
    });

    if (setup.error) {
      expect(false, 'the arrange lane and two track rows are on screen', setup.error);
    } else {
      const read = () => page.evaluate(async () => {
        const daw = await import('/stores/dawStore.ts');
        const st = daw.useDawStore.getState();
        return { px: st.pxPerSec, scroll: st.scrollSec, innerWidth: window.innerWidth };
      });

      // ── 2a. Ctrl + wheel → zoom, and NOT browser page zoom ──────────────
      const anchorX = setup.lane.left + 300;
      const anchorY = setup.rowA.top + setup.rowA.height * 0.5;
      const before = await read();
      const timeUnder = (st) => st.scroll + 300 / st.px;
      const wantTime = timeUnder(before);

      await page.mouse.move(anchorX, anchorY);
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -120);
      await page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 300));
      const afterZoom = await read();

      expect(
        afterZoom.px > before.px,
        'Ctrl + wheel zooms the arrange window',
        `${before.px} → ${afterZoom.px.toFixed(1)} px/s`,
      );
      expect(
        Math.abs(timeUnder(afterZoom) - wantTime) < 1e-6,
        'and the time under the pointer does not move while it zooms',
        `drift ${Math.abs(timeUnder(afterZoom) - wantTime).toExponential(1)} s`,
      );
      // The two zooms must stay separate: the timeline's and the window's.
      // Measured, not assumed — and the measurement says this build does not
      // page-zoom on Ctrl + wheel even with the listener made passive, so
      // this is a guard against that changing rather than a fix for it.
      expect(
        afterZoom.innerWidth === before.innerWidth,
        'and the window itself did not scale — the timeline zoom and UI 배율 stay separate',
        `innerWidth held at ${afterZoom.innerWidth} CSS px`,
      );

      // ── 2b. Shift + wheel → sideways ────────────────────────────────────
      await page.evaluate(async () => {
        const daw = await import('/stores/dawStore.ts');
        daw.useDawStore.getState().setPxPerSec(60);
        daw.useDawStore.getState().setScrollSec(10);
      });
      await new Promise((r) => setTimeout(r, 200));
      await page.keyboard.down('Shift');
      await page.mouse.wheel(0, 120);
      await page.keyboard.up('Shift');
      await new Promise((r) => setTimeout(r, 300));
      const afterScroll = await read();
      expect(
        Math.abs(afterScroll.scroll - 12) < 1e-6,
        'Shift + wheel scrolls the timeline sideways',
        `10 s + 120 px at 60 px/s → ${afterScroll.scroll} s`,
      );

      // ── 2c. A plain wheel must be left for the track list ───────────────
      const beforePlain = await read();
      await page.mouse.wheel(0, 120);
      await new Promise((r) => setTimeout(r, 250));
      const afterPlain = await read();
      expect(
        afterPlain.px === beforePlain.px && afterPlain.scroll === beforePlain.scroll,
        'and a plain wheel is left alone, so the track list still scrolls',
        `zoom and position unchanged at ${afterPlain.px} px/s / ${afterPlain.scroll} s`,
      );

      // ── 3. Drag a clip onto the other lane ──────────────────────────────
      await page.evaluate(async () => {
        const daw = await import('/stores/dawStore.ts');
        daw.useDawStore.getState().setPxPerSec(60);
        daw.useDawStore.getState().setScrollSec(0);
      });
      await new Promise((r) => setTimeout(r, 300));

      // The clip starts at 4 s; grab its UPPER half, which is the 'move'
      // zone (the lower half starts a marquee and the corners are fades).
      const grabX = setup.lane.left + 4 * 60 + 25;
      await page.mouse.move(grabX, setup.rowA.top + setup.rowA.height * 0.25);
      await page.mouse.down();
      await page.mouse.move(grabX + 60, setup.rowA.top + setup.rowA.height * 0.25, { steps: 4 });
      await page.mouse.move(grabX + 120, setup.rowB.top + setup.rowB.height * 0.5, { steps: 8 });
      await new Promise((r) => setTimeout(r, 200));
      await page.mouse.up();
      await new Promise((r) => setTimeout(r, 400));

      const drag = await page.evaluate(async (ids) => {
        const daw = await import('/stores/dawStore.ts');
        const ops = await import('/daw/model/session-ops.ts');
        const s = daw.useDawStore.getState().session;
        const onA = ops.findTrack(s, ids.trackA);
        const onB = ops.findTrack(s, ids.trackB);
        return {
          aCount: ops.trackClips(onA).length,
          bCount: ops.trackClips(onB).length,
          landedId: ops.trackClips(onB)[0]?.id ?? null,
          landedSec: ops.trackClips(onB)[0]?.startSec ?? null,
        };
      }, { trackA: setup.trackA, trackB: setup.trackB });

      expect(
        drag.aCount === 0 && drag.bCount === 1 && drag.landedId === setup.clipId,
        'dragging a clip onto another lane moves it there — the same clip, not a copy',
        `A ${drag.aCount} clip(s), B ${drag.bCount} clip(s), id ${
          drag.landedId === setup.clipId ? 'kept' : `CHANGED (${drag.landedId})`}`,
      );
      expect(
        drag.landedSec !== null && drag.landedSec > 4,
        'and it kept the horizontal half of the gesture too',
        `started at 4 s, landed at ${drag.landedSec === null ? 'nowhere' : drag.landedSec.toFixed(2)} s`,
      );
    }
  }

  // ── UI 배율, which only the main process can apply ─────────────────────
  //
  // Measured rather than asserted from the setting: `setZoomFactor` changes
  // how many CSS pixels fit the window, so a window that did not change its
  // innerWidth did not scale, whatever the store says it stored.
  {
    const scale = await page.evaluate(async () => {
      const at100 = window.innerWidth;
      await window.electronAPI.invoke('settings:set', 'uiScale', 1.4);
      await new Promise((r) => setTimeout(r, 400));
      const at140 = window.innerWidth;
      const readBack = await window.electronAPI.invoke('settings:get', 'uiScale');
      let refused = null;
      try {
        await window.electronAPI.invoke('settings:set', 'uiScale', 1.3);
        refused = 'accepted 1.3';
      } catch { refused = 'refused'; }
      await window.electronAPI.invoke('settings:set', 'uiScale', 1);
      await new Promise((r) => setTimeout(r, 400));
      return { at100, at140, back: window.innerWidth, readBack, refused };
    });

    expect(
      scale.at140 < scale.at100 && scale.readBack === 1.4,
      'the UI 배율 setting actually scales the window, not just the store',
      `innerWidth ${scale.at100} → ${scale.at140} CSS px at 140 %, stored ${scale.readBack}`,
    );
    expect(
      scale.refused === 'refused',
      'and a step that is not on the list is refused by the main process',
      `1.3 → ${scale.refused}`,
    );
    expect(
      scale.back === scale.at100,
      'back to 100 % restores the window exactly',
      `${scale.at140} → ${scale.back} CSS px (was ${scale.at100})`,
    );
  }

  // ── Cubase 격차 4·5, in the real renderer ──────────────────────────────
  //
  // A right-click menu and a key remap are both "wiring" features: the model
  // tests cover what the menus contain and what an override resolves to, and
  // cannot cover whether a real secondary click opens anything or whether a
  // rebound key actually runs the command afterwards.  Both are driven here
  // with real input.
  {
    const surfaces = await page.evaluate(async () => {
      const app = await import('/stores/appStore.ts');
      app.useAppStore.getState().setPage('daw');
      await new Promise((r) => setTimeout(r, 300));
      const daw = await import('/stores/dawStore.ts');
      const ops = await import('/daw/model/session-ops.ts');
      const clip = ops.createClip('ctx-file', 'ctx.wav', { startSec: 2, durationSec: 4 });
      const a = ops.createTrack('CTX A', 'audio');
      const withClip = { ...a, playlists: a.playlists.map((p) => ({ ...p, clips: [clip] })) };
      daw.useDawStore.getState().loadSession(
        ops.addTrack(ops.createSession('ctx'), withClip));
      daw.useDawStore.getState().setWindow('edit');
      daw.useDawStore.getState().setPxPerSec(60);
      daw.useDawStore.getState().setScrollSec(0);
      await new Promise((r) => setTimeout(r, 800));

      const lanes = document.querySelectorAll(
        'div.flex-1.flex.overflow-y-auto > div.flex-1.relative.overflow-hidden');
      if (lanes.length !== 1) return { error: `lane selector matched ${lanes.length}` };
      const lane = lanes[0];
      const rect = lane.getBoundingClientRect();
      const rows = [...lane.children]
        .filter((el) => getComputedStyle(el).position !== 'absolute')
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.height > 20);
      if (rows.length < 1) return { error: 'no lane rows' };
      // The track header column is the sibling before the lane.
      const header = lane.previousElementSibling?.getBoundingClientRect() ?? null;
      return {
        clipX: rect.left + 3 * 60, rowY: rows[0].top + rows[0].height * 0.5,
        headerX: header ? header.left + header.width / 2 : null,
        trackId: withClip.id, clipId: clip.id,
      };
    });

    if (surfaces.error) {
      expect(false, 'the arrange lane and a track row are on screen', surfaces.error);
    } else {
      const readMenu = () => page.evaluate(async () => {
        const store = await import('/stores/contextMenuStore.ts');
        const m = store.useContextMenuStore.getState().menu;
        if (!m) return { open: false };
        const box = [...document.querySelectorAll('div.fixed')]
          .find((el) => el.textContent?.includes(m.title));
        const buttons = box ? [...box.querySelectorAll('button')] : [];
        return {
          open: true, title: m.title, items: m.items.length,
          rendered: buttons.length,
          labels: buttons.slice(0, 4).map((b) => b.textContent?.trim() ?? ''),
          /** Accelerators shown on the rows — the shortcut being taught. */
          accels: buttons.map((b) => b.querySelector('span.font-mono')?.textContent?.trim() ?? '')
            .filter(Boolean),
        };
      });

      // ── A real secondary click on the clip ──────────────────────────────
      await page.mouse.click(surfaces.clipX, surfaces.rowY, { button: 'right' });
      await new Promise((r) => setTimeout(r, 300));
      const clipMenuState = await readMenu();
      expect(
        clipMenuState.open === true && clipMenuState.rendered > 8,
        'a right-click on a clip opens a menu — the surface had none before',
        clipMenuState.open
          ? `"${clipMenuState.title}" · ${clipMenuState.items} items, ${clipMenuState.rendered} rows`
          : 'no menu opened',
      );
      expect(
        clipMenuState.accels !== undefined && clipMenuState.accels.length > 4,
        'and it shows each command\'s shortcut, which is where the app teaches them',
        `${clipMenuState.accels?.length ?? 0} accelerators on the rows: ${
          (clipMenuState.accels ?? []).slice(0, 3).join(' · ')}`,
      );
      // The right-click also selected the clip, which is why the entries can
      // be command ids at all.
      // The arrange window's selection lives in dawStore — it carries
      // trackIds, which the workspace's plain TimeRange does not.
      const selected = await page.evaluate(async () => {
        const daw = await import('/stores/dawStore.ts');
        return daw.useDawStore.getState().selection;
      });
      expect(
        selected !== null && Math.abs(selected.startSec - 2) < 0.01
          && Math.abs(selected.endSec - 6) < 0.01,
        'and it selected the clip it was about, so the commands act on that clip',
        selected ? `selection ${selected.startSec.toFixed(2)}–${selected.endSec.toFixed(2)} s` : 'nothing selected',
      );

      // Escape dismisses it.
      await page.keyboard.press('Escape');
      await new Promise((r) => setTimeout(r, 250));
      const afterEsc = await readMenu();
      expect(
        afterEsc.open === false,
        'Escape closes the menu',
        'dismissed',
      );

      // ── And on the track header, which is a different menu ──────────────
      if (surfaces.headerX !== null) {
        await page.mouse.click(surfaces.headerX, surfaces.rowY, { button: 'right' });
        await new Promise((r) => setTimeout(r, 300));
        const headerMenu = await readMenu();
        expect(
          headerMenu.open === true && headerMenu.title === 'CTX A',
          'a right-click on the track header opens the track\'s menu, not the clip\'s',
          headerMenu.open ? `"${headerMenu.title}" · ${headerMenu.items} items` : 'no menu opened',
        );
        await page.keyboard.press('Escape');
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  // ── A remapped key actually runs the command ───────────────────────────
  //
  // Measured end to end: store an override, press the NEW chord, and check
  // the thing the command does.  `view.zoomInH` is the one picked because its
  // effect is a number in the store rather than a window opening.
  {
    const remap = await page.evaluate(async () => {
      const ko = await import('/shortcuts/key-overrides.ts');
      const ss = await import('/stores/shortcutStore.ts');
      const daw = await import('/stores/dawStore.ts');
      // Find a chord nothing holds, the same way the selftest does.
      // The whole alphabet across three modifier sets: of 78 candidates only
      // nine are free, so a narrower search finds nothing and reads as the
      // feature being broken.  Measured — the first draft of this probe
      // searched twenty and all twenty were taken.
      let spare = null;
      for (const mods of ['Mod+Alt+Shift+', 'Mod+Alt+', 'Alt+Shift+']) {
        for (const letter of 'QWERTYUIOPASDFGHJKLZXCVBNM'.split('')) {
          const spec = `${mods}Key${letter}`;
          if (ko.conflictOf(spec, 'file.new', ko.loadOverrides()) === null) { spare = spec; break; }
        }
        if (spare) break;
      }
      if (!spare) return { error: 'no free chord' };
      const result = ss.useShortcutStore.getState().setChords('view.zoomInH', [spare]);
      daw.useDawStore.getState().setPxPerSec(60);
      await new Promise((r) => setTimeout(r, 300));
      return { spare, ok: result.ok, reason: result.reason ?? null, before: 60 };
    });

    if (remap.error || remap.ok !== true) {
      expect(false, 'a binding can be remapped', remap.error ?? remap.reason ?? 'refused');
    } else {
      // Press the new chord with real keys.
      const chord = remap.spare.split('+');
      const key = chord[chord.length - 1].replace('Key', '');
      if (chord.includes('Mod')) await page.keyboard.down('Control');
      if (chord.includes('Alt')) await page.keyboard.down('Alt');
      if (chord.includes('Shift')) await page.keyboard.down('Shift');
      await page.keyboard.press(`Key${key}`);
      if (chord.includes('Shift')) await page.keyboard.up('Shift');
      if (chord.includes('Alt')) await page.keyboard.up('Alt');
      if (chord.includes('Mod')) await page.keyboard.up('Control');
      await new Promise((r) => setTimeout(r, 300));

      const after = await page.evaluate(async () => {
        const daw = await import('/stores/dawStore.ts');
        return daw.useDawStore.getState().pxPerSec;
      });
      expect(
        after > remap.before,
        'a remapped key runs its command on the next keystroke, with no relaunch',
        `${remap.spare} → zoom ${remap.before} → ${after.toFixed(1)} px/s`,
      );

      // The old chord must no longer do it.
      await page.evaluate(async () => {
        const daw = await import('/stores/dawStore.ts');
        daw.useDawStore.getState().setPxPerSec(60);
      });
      await new Promise((r) => setTimeout(r, 200));
      await page.keyboard.press('KeyF');
      await new Promise((r) => setTimeout(r, 300));
      const afterOld = await page.evaluate(async () => {
        const daw = await import('/stores/dawStore.ts');
        return daw.useDawStore.getState().pxPerSec;
      });
      expect(
        afterOld === 60,
        'and the chord it used to answer to no longer does',
        `F → ${afterOld} px/s (was 화면 가로 확대 before the remap)`,
      );

      // Put it back, so nothing after this runs on a remapped keyboard.
      await page.evaluate(async () => {
        const ss = await import('/stores/shortcutStore.ts');
        ss.useShortcutStore.getState().resetAll();
      });
      await new Promise((r) => setTimeout(r, 200));
      await page.evaluate(async () => {
        const daw = await import('/stores/dawStore.ts');
        daw.useDawStore.getState().setPxPerSec(60);
      });
      await page.keyboard.press('KeyF');
      await new Promise((r) => setTimeout(r, 300));
      const restored = await page.evaluate(async () => {
        const daw = await import('/stores/dawStore.ts');
        return daw.useDawStore.getState().pxPerSec;
      });
      expect(
        restored > 60,
        'and resetting the remap gives the default key its command back',
        `F → ${restored.toFixed(1)} px/s after reset`,
      );
    }
  }

  // `VITE_LOUI_GUIDED_FLOW` is set by CI on tag builds only, and it swaps the
  // whole front of the app: App.tsx renders <GuidedHome /> instead of
  // <HomePage />, and MasteringPage and ResultPage take guided branches.  No
  // smoke run ever set it — not this one, not the packaged one — so every step
  // above exercised the legacy Home while every release shipped the other one.
  //
  // Asserted through the flag module and the DOM, not through one string of
  // copy: `isGuidedFlowEnabled()` must flip, the render must change, and the
  // guided front must actually appear.  `window.__LOUI_GUIDED_FLOW__` is the
  // runtime half of the same flag, which is what makes this testable at all.
  {
    const GUIDED_MARKERS = ['트랙을 올리면', '오디오 파일 올리기', '어디서나 무난한 표준'];

    const readHome = async (markers) => page.evaluate(async (needles) => {
      const app = await import('/stores/appStore.ts');
      app.useAppStore.getState().setPage('home');
      await new Promise((r) => setTimeout(r, 500));
      const flag = await import('/audio/guided-flow-flag.ts');
      const root = document.getElementById('root');
      const text = root ? (root.textContent ?? '') : '';
      return {
        flagOn: flag.isGuidedFlowEnabled(),
        nodes: root ? root.querySelectorAll('*').length : -1,
        guided: needles.some((n) => text.includes(n)),
      };
    }, markers);

    const before = await readHome(GUIDED_MARKERS);
    expect(
      before.flagOn === false && before.guided === false,
      'the 31 steps above ran on the legacy Home, as every smoke run has',
      `flag=${before.flagOn}, guided markers=${before.guided}, ${before.nodes} nodes`,
    );

    await page.addInitScript(() => { window.__LOUI_GUIDED_FLOW__ = true; });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const after = await readHome(GUIDED_MARKERS);

    expect(
      after.flagOn === true,
      'and with the release flag on, the app agrees it is on',
      `isGuidedFlowEnabled()=${after.flagOn}`,
    );
    expect(
      after.guided === true && after.nodes > 0,
      'and the guided Home is what renders then — the UI a tagged build ships',
      after.guided
        ? `${after.nodes} nodes, guided front present`
        : `${after.nodes} nodes and none of ${GUIDED_MARKERS.join(' / ')} — GuidedHome did not mount`,
    );
    expect(
      after.nodes !== before.nodes,
      'and it is a different render, not the same page with a flag set',
      `${before.nodes} nodes legacy → ${after.nodes} nodes guided`,
    );
  }

  await page.waitForTimeout(500);
  expect(
    rendererErrors.length === 0,
    'the renderer logged no errors through any of it',
    rendererErrors.length === 0
      ? 'clean'
      : rendererErrors.slice(0, 6).map((e) => `[${e.kind}] ${e.text.slice(0, 120)}`).join(' | ')
        + (rendererErrors.length > 6 ? ` … and ${rendererErrors.length - 6} more` : ''),
  );
} finally {
  await browser.close();
}

console.log(
  `\n  ${step - failed - skipped}/${step} steps ok`
  + (failed ? `, ${failed} FAILED` : '')
  + (skipped ? `, ${skipped} skipped` : '')
  + '\n',
);
process.exit(failed === 0 ? 0 : 1);
