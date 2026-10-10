// flow.mjs — drive the mastering flow through a running app.
//
//   node scripts/app-smoke/flow.mjs [cdp-port] [workdir]
//
// See README.md for why this exists and what it deliberately does not do.

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const PORT = process.argv[2] ?? '9333';
const WORK = process.argv[3] ?? '/tmp/smoke';
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
