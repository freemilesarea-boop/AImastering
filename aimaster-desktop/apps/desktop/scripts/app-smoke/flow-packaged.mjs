// Drive the PACKAGED app through its IPC surface.
//
//   node flow-packaged.mjs <cdp-port> <workdir>
//
// The dev smoke (flow.mjs) imports renderer modules by Vite path.  A packaged
// renderer has no module graph to import, so this drives only the preload
// bridge — which is exactly where the packaging bugs live: resource
// resolution from `process.resourcesPath`, `__dirname` arithmetic inside
// `dist-electron/main`, and binaries that are shipped but cannot run.
//
// Every one of those was a real defect found by running this:
//
//   · `resources/bin/engine` absent    → first audio:analyze died ENOENT
//   · `resources/bin/engine` present   → died on startup, "No module named
//     and built with CI's command        'backports'" (pyi_rth_pkgres)
//   · the chain resolved from the dev  → the shipped resources copy was
//     tree when launched in place        never exercised; boot-packaged.sh
//                                        now copies the app out first
//
// The render step is judged by the OUTPUT AUDIO, not by the handler's
// `chainConfigHonored` flag.  The flag is set by the branch that was taken,
// so it cannot tell you the chain did anything; a +6 dB low shelf showing up
// at 60 Hz can.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import asarApi from '@electron/asar';

const PORT = process.argv[2] ?? '9444';
const WORK = process.argv[3] ?? '/tmp/loui-pkg-smoke';
/** Where boot-packaged.sh copied the app to.  Overridable as argv[4]. */
const RESOURCES = process.argv[4] ?? path.join(WORK, 'installed', 'linux-unpacked', 'resources');

let step = 0, failed = 0;
const ok  = (n, d = '') => { step++; console.log(`  ${String(step).padStart(2)}. ok    ${n}${d ? `  — ${d}` : ''}`); };
const bad = (n, d = '') => { step++; failed++; console.error(`  ${String(step).padStart(2)}. FAIL  ${n}${d ? `  — ${d}` : ''}`); };
const expect = (c, n, d = '') => { c ? ok(n, d) : bad(n, d); return c; };

// ── a source with a tone in each band the chain is asked to move ────────────
const SR = 48000, SECS = 3;
const TONES = [60, 1000, 9000, 14000];
function writeSource(file) {
  const n = SR * SECS, amp = 0.2 / TONES.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const f of TONES) v += amp * Math.sin(2 * Math.PI * f * i / SR);
    const s = Math.max(-1, Math.min(1, v)) * 32767 | 0;
    buf.writeInt16LE(s, 44 + i * 4); buf.writeInt16LE(s, 44 + i * 4 + 2);
  }
  fs.writeFileSync(file, buf);
  return file;
}

/** Read a PCM/float WAV's left channel.  Enough of the format for our own
 *  source and for what the engine writes (24-bit by default). */
function readLeft(file) {
  const b = fs.readFileSync(file);
  if (b.toString('latin1', 0, 4) !== 'RIFF') throw new Error('not RIFF');
  let p = 12, fmt = null, data = null;
  while (p + 8 <= b.length) {
    const id = b.toString('latin1', p, p + 4), sz = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { tag: b.readUInt16LE(p + 8), ch: b.readUInt16LE(p + 10), sr: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') data = { off: p + 8, size: Math.min(sz, b.length - p - 8) };
    p += 8 + sz + (sz & 1);
  }
  if (!fmt || !data) throw new Error('no fmt/data chunk');
  const bytes = fmt.bits >> 3, frame = bytes * fmt.ch, n = Math.floor(data.size / frame);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const o = data.off + i * frame;
    if (fmt.tag === 3 && fmt.bits === 32) out[i] = b.readFloatLE(o);
    else if (fmt.bits === 16) out[i] = b.readInt16LE(o) / 32768;
    else if (fmt.bits === 24) out[i] = ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 24 >> 8)) << 8 >> 8) / 8388608;
    else if (fmt.bits === 32) out[i] = b.readInt32LE(o) / 2147483648;
    else throw new Error(`unhandled ${fmt.tag}/${fmt.bits}`);
  }
  return { x: out, sr: fmt.sr };
}

/** Level of one frequency, in dB, by direct correlation (Goertzel-equivalent). */
function toneDb({ x, sr }, f, secs = 2) {
  const n = Math.min(x.length, Math.floor(sr * secs));
  let re = 0, im = 0;
  for (let i = 0; i < n; i++) {
    const a = -2 * Math.PI * f * i / sr;
    re += x[i] * Math.cos(a); im += x[i] * Math.sin(a);
  }
  return 20 * Math.log10(2 * Math.hypot(re, im) / n + 1e-12);
}

// ── the suite config the Studio sends, with two shelves turned up ───────────
// The same shape `render-song.ts` posts: `{ suiteConfig }`, camelCase, the
// module-suite config the Rust chain deserializes with serde.
const SUITE = {
  declick: { sensitivity: 6, maxRunSamples: 16, bypass: true },
  eq: {
    lowCutHz: 32, lowCutQ: 0.707,
    lowShelfHz: 120, lowShelfDb: 6, lowShelfQ: 0.707,
    presenceHz: 3000, presenceDb: 0, presenceQ: 1.1,
    airHz: 12000, airDb: 6, airQ: 0.707,
    adaptive: false, bypass: false,
  },
  dynamics: { thresholdDb: -14, ratio: 2, attackMs: 10, releaseMs: 120, mixPct: 100, bypass: false },
  imager: { widthPct: 100, lowMonoHz: 120, stereoize: false, bandWidthPct: [100, 100, 100, 100], bypass: false },
  limiter: { ceilingDbtp: -1, lookaheadMs: 2.5, isp: true, driveDb: 0, character: 'smooth', bypass: false },
  loudness: { enabled: false, targetLufs: -14, maxBoostDb: 12, maxCutDb: 18, speedMs: 3000, bypass: false },
};

fs.mkdirSync(WORK, { recursive: true });
const WAV = writeSource(path.join(WORK, 'pkg-src.wav'));

const b = await chromium.connectOverCDP(`http://localhost:${PORT}`);
const pages = b.contexts()[0].pages();
const page = pages.find((p) => !p.url().startsWith('devtools://')) ?? pages[0];

// Everything the PACKAGED renderer threw or logged as an error.
//
// The dev smoke grew this step and it earned its place on the first run.  A
// packaged renderer has its own failure modes that a dev server cannot show
// at all: an asset served from `file://` instead of Vite, a read out of the
// asar, a Content-Security-Policy that only the packaged page carries.  Each
// of those surfaces as a console error and nothing was listening.
//
// Attaching this LATE is the one limit worth stating: by the time Playwright
// connects over CDP the window has already booted, so anything thrown during
// the first paint is already gone.  What this catches is everything the
// steps below provoke — which is the part the harness controls.
const rendererErrors = [];
if (page) {
  page.on('pageerror', (e) => rendererErrors.push({ kind: 'pageerror', text: String(e?.message ?? e) }));
  page.on('console', (m) => {
    if (m.type() === 'error') rendererErrors.push({ kind: 'console', text: m.text() });
  });
}

try {
  expect(page.url().startsWith('file://'), 'the renderer is the packaged file:// bundle',
    `${page.url().slice(0, 56)}…`);

  const bridges = await page.evaluate(() => ({
    api: typeof window.electronAPI?.invoke === 'function',
    assets: typeof window.louiAssets?.read === 'function',
  }));
  expect(bridges.api && bridges.assets, 'both preload bridges are present',
    `electronAPI=${bridges.api} louiAssets=${bridges.assets}`);

  const assets = await page.evaluate(async () => {
    const out = [];
    for (const n of ['loui-mastering-wasm.nomodules.wasm', 'loui-mastering-wasm.nomodules.js',
                     'mastering-chain.worklet.js', 'analyzer-tap.worklet.js']) {
      try { const p = await window.louiAssets.read(n); out.push({ n, size: p.size }); }
      catch (e) { out.push({ n, size: 0, e: String(e?.message ?? e) }); }
    }
    return out;
  });
  expect(assets.every((a) => a.size > 0), 'every worklet asset is served out of the asar',
    assets.map((a) => `${a.n.replace('loui-mastering-wasm.', '')} ${Math.round(a.size / 1024)}KB`).join(', '));

  // The engine the main process will spawn, started the way the main process
  // starts it.  A separate step from `audio:analyze` because when both fail
  // this one says which of the two is broken — and because the binary that
  // shipped is not necessarily the one the gate checked.
  //
  // The path comes from the workdir, not from an IPC call: there is no
  // `app:resources-path` channel, and a step that shrugs when it cannot find
  // the file is not a step.  `boot-packaged.sh` always installs to
  // <workdir>/installed/linux-unpacked.
  const engineBin = path.join(RESOURCES, 'bin', process.platform === 'win32' ? 'engine.exe' : 'engine');
  if (!fs.existsSync(engineBin)) {
    bad('the shipped engine binary starts and reaches READY', `nothing at ${engineBin}`);
  } else {
    const r = spawnSync(engineBin, [], { input: '', timeout: 120000, encoding: 'utf8', maxBuffer: 1 << 22 });
    const txt = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    expect(r.status === 0 && txt.includes('READY'), 'the shipped engine binary starts and reaches READY',
      r.status === 0 ? 'exit 0, READY' : `exit ${r.status}: ${txt.trim().split('\n').pop()}`);
  }

  const an = await page.evaluate(async (w) => {
    try { const r = await window.electronAPI.invoke('audio:analyze', w); return { ok: true, r }; }
    catch (e) { return { ok: false, e: String(e?.message ?? e) }; }
  }, WAV);
  const lufs = an.ok ? (an.r?.loudness?.integratedLufs ?? an.r?.integratedLufs) : null;
  expect(an.ok && typeof lufs === 'number', 'the bundled Python engine analyses a file',
    an.ok ? `${lufs?.toFixed?.(2)} LUFS` : an.e.slice(0, 150));

  // ── The separation runtime, inside the asar ───────────────────────────
  // electron-builder.yml has said for a while that this is the one thing
  // needing a real packaging run: `daw:model-runtime` reads the ONNX runtime's
  // own .wasm out of the asar by path, trying `app.getAppPath()` first, and a
  // 13 MB file resolved from the wrong place is exactly the kind of thing that
  // works on one machine and not another.  This is that run.
  //
  // It also holds the narrowing that came out of it.  Naming one file in
  // `files:` adds that file; it does not subtract the rest, and the asar was
  // carrying all four runtime variants plus the package's TypeScript sources —
  // 137.8 MB of a 165.2 MB asar, for ONE file main reads.  Excluding the two
  // packages and putting that file back took the content to 48.3 MB.  The size
  // check is the ratchet: it is the user's download.
  {
    const runtime = await page.evaluate(async () => {
      try {
        const r = await window.electronAPI.invoke('daw:model-runtime');
        return { ok: true, from: r.from, size: r.size, bytes: r.bytes?.byteLength ?? r.bytes?.length ?? 0 };
      } catch (e) { return { ok: false, e: String(e?.message ?? e) }; }
    });
    expect(
      runtime.ok && runtime.size > 10e6 && runtime.bytes === runtime.size
        && /app\.asar[\\/]node_modules[\\/]onnxruntime-web/.test(String(runtime.from)),
      'the separation runtime is found inside the asar, by the path main tries first',
      runtime.ok
        ? `${(runtime.size / 1e6).toFixed(1)} MB from ${String(runtime.from).replace(RESOURCES, '<resources>')}`
        : runtime.e.slice(0, 160),
    );

    // The reason excluding the package is safe, stated as a fact about the
    // artifact rather than a belief about the build: the worker carries the
    // runtime's own code, and asks for nothing by name at runtime.
    //
    // Two more things make that safe, both already true before this change
    // and both found by trying to break this check: `model.worker.js` is a
    // COMMITTED build output (src/renderer/public/) that vite copies
    // verbatim, and `test:model-dispatch` runs `build-model-worker.mjs
    // --check` so it cannot drift from the TypeScript — which is why editing
    // the worker's source does not move this check, and why the suite is
    // where that drift is caught.  And `model-session.loadRuntime()`, the one
    // path that would need the package resolvable at runtime, has no caller:
    // every `openModel` call injects the runtime (the worker its bundled one,
    // the selftests a fake).
    const asar = path.join(RESOURCES, 'app.asar');
    let worker = '';
    try { worker = asarApi.extractFile(asar, 'dist/renderer/model.worker.js').toString('utf8'); }
    catch { worker = ''; }
    expect(
      worker.length > 50_000 && /wasmBinary|_OrtCreateSession/.test(worker)
        && !/require\(['"]onnxruntime|import\(['"]onnxruntime/.test(worker),
      'because the worker in the asar carries the runtime and asks for nothing by name',
      worker
        ? `model.worker.js is ${(worker.length / 1e3).toFixed(0)} KB with the runtime folded in, `
          + 'and no bare onnxruntime import left in it'
        : 'could not read dist/renderer/model.worker.js out of the asar',
    );

    const bytes = fs.existsSync(asar) ? fs.statSync(asar).size : 0;
    const CAP_MB = 70;
    expect(
      bytes > 0 && bytes < CAP_MB * 1e6,
      'and the asar still carries only the one copy of it',
      `app.asar is ${(bytes / 1e6).toFixed(1)} MB (cap ${CAP_MB} MB — it was 166 MB while the `
      + 'whole runtime was in there; lower the cap if it shrinks again)',
    );
  }

  // ── Whose ffmpeg was that? ────────────────────────────────────────────
  // The step above proves the engine analysed the file.  It does NOT prove it
  // used the ffmpeg this build SHIPS: on any machine with ffmpeg on PATH —
  // every developer's, and this container's — a packaged build that had lost
  // its bundled binary, or lost `applyBundledFfmpegEnv`, would resolve the
  // bare name and pass that step exactly the same way.  The user who has no
  // system ffmpeg is the one who would find out.
  //
  // Both halves of the app say which binary they picked, and until now nobody
  // read either: main logs `FFmpeg status` with the resolved path and version,
  // and the Python engine logs its own two paths at startup.  Measured on this
  // run — the bundled build is 7.0.2-static while the host's is 6.1.1, so the
  // version is a second, independent discriminator.
  {
    const logPath = path.join(WORK, 'electron.log');
    const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    const bundled = path.join(RESOURCES, 'bin');
    const status = /FFmpeg status (\{[^\n]*\})/.exec(log);
    let main = null;
    try { main = status ? JSON.parse(status[1]) : null; } catch { main = null; }
    expect(
      main !== null && typeof main.path === 'string' && main.path.startsWith(bundled)
        && main.available === true && main.ffprobeAvailable === true,
      'the main process resolved the ffmpeg it shipped, not the one on PATH',
      main === null
        ? (log ? 'no "FFmpeg status" line in the log' : `no log at ${logPath}`)
        : `${main.path} (version ${String(main.version)})`,
    );

    // The engine logs the path it was GIVEN, which is not the same claim as
    // "it ran that binary": with the shipped ffmpeg deleted and
    // `applyBundledFfmpegEnv` still exporting its path, this check passed
    // while the analysis above failed.  So it asserts the two halves that
    // make the claim true — the engine was pointed inside resources, and
    // there is a binary there — and leaves "it worked" to the step above.
    const engineFfmpeg = /\[INFO\] ffmpeg\s+binary: (\S+)/.exec(log);
    const engineFfprobe = /\[INFO\] ffprobe binary: (\S+)/.exec(log);
    const present = ['ffmpeg', 'ffprobe']
      .filter((n) => fs.existsSync(path.join(bundled, process.platform === 'win32' ? `${n}.exe` : n)));
    expect(
      engineFfmpeg?.[1]?.startsWith(bundled) === true
        && engineFfprobe?.[1]?.startsWith(bundled) === true
        && present.length === 2,
      'and the engine was pointed at the pair that is actually in resources',
      engineFfmpeg
        ? `engine told ${engineFfmpeg[1]} / ${String(engineFfprobe?.[1])}; `
          + `present in resources: ${present.join(' + ') || 'NEITHER'}`
        : 'the engine never logged which binary it picked',
    );
  }

  const prof = await page.evaluate(async (w) => {
    try { const r = await window.electronAPI.invoke('audio:song-profile', w); return { ok: true, keys: Object.keys(r ?? {}).slice(0, 6) }; }
    catch (e) { return { ok: false, e: String(e?.message ?? e) }; }
  }, WAV);
  expect(prof.ok, 'and profiles it', prof.ok ? prof.keys.join(', ') : prof.e.slice(0, 120));

  // The step this harness exists for: does the Rust chain load from
  // `process.resourcesPath` in the packaged layout?  The loader's counted
  // path was right from `src/main/offline` and wrong from
  // `dist-electron/main`, so every packaged build silently took the Python
  // path — and the fix was only ever verified in a dev Electron app.
  const rendered = await page.evaluate(async ([w, suite]) => {
    try {
      const r = await window.electronAPI.invoke('audio:master-rust-experimental', {
        sourcePath: w, chainConfig: { suiteConfig: suite },
        options: { style: 'balanced', targetLufs: -14, targetTp: -1, sampleRate: 48000,
                   bitDepth: 24, applyAiCorrections: false, limiterStrength: 'medium' },
      });
      return { ok: true, r };
    } catch (e) { return { ok: false, e: String(e?.message ?? e) }; }
  }, [WAV, SUITE]);
  const rr = rendered.r ?? {};
  const renderOk = expect(rendered.ok && rr.ok !== false && rr.chainConfigHonored !== false,
    'the Studio render runs on the Rust chain, resolved from resources',
    rendered.ok ? `backend=${rr.backend ?? '?'} honored=${rr.chainConfigHonored ?? '?'}`
      : rendered.e.slice(0, 180));

  // And the audio, because the flag above only reports which branch ran.
  if (renderOk && typeof rr.outputPath === 'string' && fs.existsSync(rr.outputPath)) {
    const src = readLeft(WAV), out = readLeft(rr.outputPath);
    const rel = (f) => (toneDb(out, f) - toneDb(out, 1000)) - (toneDb(src, f) - toneDb(src, 1000));
    const low = rel(60), air = rel(14000);
    // Relative to 1 kHz, so the limiter's and the loudness stage's overall
    // gain cancels out and what is left is the shelf.  Both shelves are
    // +6 dB; measured +5.27 and +4.41 dB on this source, with the 32 Hz low cut
    // and the limiter taking the rest.  The bar is deliberately well below
    // that and well above zero.
    expect(low > 2 && air > 2, 'and the file carries the two shelves that were asked for',
      `60 Hz ${low >= 0 ? '+' : ''}${low.toFixed(2)} dB, 14 kHz ${air >= 0 ? '+' : ''}${air.toFixed(2)} dB (rel. 1 kHz, +6 asked)`);
    expect(fs.statSync(rr.outputPath).size > 100_000, 'and writes a real file',
      `${(fs.statSync(rr.outputPath).size / 1e6).toFixed(2)} MB`);
  } else {
    bad('and the file carries the two shelves that were asked for', `no output at ${String(rr.outputPath)}`);
    bad('and writes a real file', 'no output');
  }
  // CDP delivers console events asynchronously, so a message logged by the
  // last `evaluate` can still be in flight when that call's promise settles.
  // Measured, not assumed: with a thrown error and a console.error injected
  // into the page and this wait removed, the list held only the synchronous
  // console.error — the `pageerror` and the app's own window-error line were
  // both still in flight.  An error thrown asynchronously would have been
  // reported as `clean`.
  await page.waitForTimeout(500);
  expect(
    rendererErrors.length === 0,
    'the packaged renderer logged no errors while all that happened',
    rendererErrors.length === 0
      ? 'clean'
      : rendererErrors.slice(0, 6).map((e) => `[${e.kind}] ${e.text.slice(0, 130)}`).join(' | ')
        + (rendererErrors.length > 6 ? ` … and ${rendererErrors.length - 6} more` : ''),
  );
} finally {
  await b.close();
}
console.log(`\n  ${step - failed}/${step} steps ok${failed ? `, ${failed} FAILED` : ''}\n`);
process.exit(failed === 0 ? 0 : 1);
