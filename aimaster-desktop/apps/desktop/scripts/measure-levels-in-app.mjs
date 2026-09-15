/**
 * measure-levels-in-app.mjs — where INSTRUMENT_TRIM's numbers come from.
 *
 * The instrument-level suite renders under `node-web-audio-api`, which is not
 * what the app runs on, and the two do not agree: exactly on the guitars
 * (buffers through biquads is arithmetic), and by up to 1.4 dB on the
 * instruments built from oscillators, because a band-limited oscillator is
 * each implementation's own choice.  The user hears Chromium.  So the trims
 * are derived HERE, and the suite's job is only to notice drift afterwards.
 *
 * This is a harness tool, not a test: it needs the app already running with
 * a debugging port, which is why it is not in `pnpm test`.
 *
 *   1. Start the app against the dev server with --remote-debugging-port=9222
 *   2. node scripts/measure-levels-in-app.mjs
 *   3. Put the printed trims in instrument-level.ts, then run it again — the
 *      shifts should all come back at 0
 *   4. Re-run the suite and update NODE_REFERENCE_LUFS with what it prints
 *
 * Step 3 is not ceremony.  The first pass measures with the OLD trims in the
 * page, and a page that has already imported the module keeps its old copy
 * across an edit — so the run reloads first, and the second pass is what
 * says the new numbers actually landed.
 */
// Playwright is NOT a dependency of this repo — nothing in `pnpm test` drives
// a browser, and adding a 300 MB devDependency for a tool run by hand a few
// times a year is the wrong trade.  So it is resolved at run time, and the
// failure says how to supply it rather than reading as a broken script.
const PLAYWRIGHT = process.env['PLAYWRIGHT_MODULE'] ?? 'playwright';
let chromium;
try {
  ({ chromium } = await import(PLAYWRIGHT));
} catch {
  console.error(
    `playwright 를 찾지 못했습니다 (${PLAYWRIGHT}).\n`
    + '  설치하거나:  pnpm add -Dw playwright\n'
    + '  이미 있는 곳을 가리키세요:  PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/measure-levels-in-app.mjs',
  );
  process.exit(1);
}

const PORT = process.env['CDP_PORT'] ?? '9222';

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
const page = browser.contexts()[0].pages().find((p) => !p.url().startsWith('devtools://'));
if (!page) throw new Error('no app page on the debugging port');

// The page may be holding an older copy of the modules from before the edit.
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);

const rows = await page.evaluate(async () => {
  const I = await import('/daw/engine/instruments.ts');
  const M = await import('/daw/model/midi.ts');
  const L = await import('/daw/engine/instrument-level.ts');
  const Lo = await import('/audio/loudnessCore.ts');
  const G = await import('/daw/engine/plugin-presets-genre.ts');
  const D = await import('/daw/engine/drum-presets.ts');
  const SR = 44100;

  const render = async (id, events, seconds, over = {}) => {
    const inst = I.findInstrument(id);
    const params = { ...I.defaultInstrumentParams(id), ...over };
    const ctx = new OfflineAudioContext(2, Math.round(SR * seconds), SR);
    for (const e of events) {
      inst.playNote({
        ctx, destination: ctx.destination,
        note: M.createNote({ pitch: e.pitch, velocity: e.vel, startBeat: 0, durationBeat: 1 }),
        config: M.DEFAULT_MIDI_CONFIG, when: e.at, durationSec: e.dur, params,
      });
    }
    const b = await ctx.startRendering();
    const l = b.getChannelData(0), r = b.getChannelData(1);
    return Lo.getLoudnessMetrics({
      sampleRate: SR, length: l.length, numberOfChannels: 2,
      getChannelData: (c) => (c === 0 ? l : r),
    });
  };

  const T = L.LEVEL_TARGET_LUFS, C = L.LEVEL_PEAK_CEILING_DBTP;
  const out = [];

  for (const id of ['polysynth', 'epiano', 'agtr', 'egtr']) {
    const root = L.REFERENCE_ROOT[id] ?? 48;
    const m = await render(id, L.referencePhrase(root), L.REFERENCE_PHRASE_SECONDS);
    const h = await render(id, L.hardChord(root), 3);
    // Loudness decides, unless that would push the hard hit over the ceiling.
    const shift = Math.min(T - m.integratedLufs, C - h.truePeakDbtp);
    out.push({
      id, lufs: m.integratedLufs, hard: h.truePeakDbtp, shift,
      trim: L.INSTRUMENT_TRIM[id] * Math.pow(10, shift / 20), note: '',
    });
  }

  // The kit is eleven kits.  Loudness is taken from the median of them and
  // the ceiling from the worst of them, so one loud genre cannot clip and one
  // quiet genre cannot drag the family down.
  const kits = [['built-in', 0], ...G.GENRE_ORDER.map((g) => [g, D.kitParamOf(g)])];
  const loud = [];
  let worst = { name: '', hard: -999 };
  for (const [name, kit] of kits) {
    const m = await render('drumkit', L.referenceBeat(), L.REFERENCE_BEAT_SECONDS, { kit });
    const h = await render('drumkit', L.referenceBeat(1.35), L.REFERENCE_BEAT_SECONDS, { kit });
    loud.push(m.integratedLufs);
    if (h.truePeakDbtp > worst.hard) worst = { name, hard: h.truePeakDbtp };
  }
  loud.sort((a, b) => a - b);
  const median = loud[Math.floor(loud.length / 2)];
  const shift = Math.min(T - median, C - worst.hard);
  out.push({
    id: 'drumkit', lufs: median, hard: worst.hard, shift,
    trim: L.INSTRUMENT_TRIM.drumkit * Math.pow(10, shift / 20),
    note: `worst ${worst.name}; kits ${loud[0].toFixed(1)}…${loud[loud.length - 1].toFixed(1)}`,
  });
  return out;
});

console.log('Chromium 에서 측정 — shift 가 전부 0 이면 트림이 맞은 것입니다.\n');
for (const r of rows) {
  console.log(`  ${r.id.padEnd(11)} ${r.lufs.toFixed(3).padStart(8)} LUFS  `
    + `hard ${r.hard.toFixed(3).padStart(8)} dBTP  shift ${r.shift.toFixed(3).padStart(7)} dB`
    + `  → trim ${r.trim.toFixed(4)}${r.note ? '   ' + r.note : ''}`);
}
await browser.close();
