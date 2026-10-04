/**
 * render-determinism-selftest — "a bounce sounds like the preview", checked.
 *
 * Seven engine modules carry the same promise in a comment, each phrased as a
 * standing rule rather than a preference:
 *
 *   reverb-spaces  "DETERMINISTIC.  Every random number comes from a seeded
 *                   LCG, never from `Math.random`."
 *   string-model   "`Math.random()` would make every render of the same part
 *                   different, and this engine's contract is that a bounce
 *                   sounds like the preview."
 *   struck-string  "Everything here is deterministic — no `Math.random()`
 *                   anywhere."
 *   fm-core        "this engine's bounces are bit-identical to its preview"
 *   mod-matrix     "it is deterministic here — seeded from the note — because
 *                   this engine's standing rule is that a bounce sounds like
 *                   the preview."
 *   bowed-string   "a bounce is bit-identical to the preview, so the hair
 *                   cannot use `Math.random()`."
 *   drum-model     "`Math.random()` would make every bounce" … different.
 *
 * Nothing tested any of it.  Seven comments is seven places a future change
 * can quietly break the one property that makes a mix reproducible, and the
 * failure would not look like a crash — it would look like a bounce that
 * does not quite match what was approved, which is the hardest kind of bug
 * to even notice.
 *
 * So the promise is three checks here: a source sweep that no audio module
 * reaches for `Math.random` at all (immune to the engine's content-keyed
 * caches, which could hide a single draw behind a cache hit), a runtime trap
 * that catches a call from any path a render actually takes, and a render of
 * every instrument twice, compared bit for bit.
 *
 * What is NOT claimed: that a note sounds the same wherever it sits in the
 * bar.  Measured, five instruments differ slightly when the same note starts
 * at a different time — epiano by −36 dB of its own peak, uniformly across
 * the note, which is a sub-sample scheduling difference that FM turns into a
 * sideband difference.  That is not what the comments promise and not what a
 * reproducible mix needs: rendering the SAME arrangement has to be exact,
 * and it is.
 *
 * Run:  pnpm --filter @aimaster/desktop test:render-determinism
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { OfflineAudioContext } from 'node-web-audio-api';
(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import { createNote, DEFAULT_MIDI_CONFIG } from '../src/renderer/daw/model/midi.js';
import { INSTRUMENTS, defaultInstrumentParams } from '../src/renderer/daw/engine/instruments.js';
import { SPACES, renderIr } from '../src/renderer/daw/engine/reverb-spaces.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SR = 44_100;
const SECONDS = 2;

const digest = (x: Float32Array): string =>
  createHash('sha256').update(Buffer.from(x.buffer, x.byteOffset, x.byteLength)).digest('hex');

/** Every .ts under a directory, recursively. */
function filesUnder(rel: string): string[] {
  const root = path.join(DESKTOP, rel);
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** Source with block and line comments removed — the comments SAY no random. */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
}

async function renderNote(id: string, when: number): Promise<Float32Array> {
  const instrument = INSTRUMENTS.find((i) => i.id === id);
  assert(instrument, `instrument ${id} exists`);
  const ctx = new OfflineAudioContext(1, Math.round(SR * SECONDS), SR);
  instrument!.playNote({
    ctx: ctx as unknown as BaseAudioContext,
    destination: ctx.destination as unknown as AudioNode,
    note: createNote({ pitch: 60, velocity: 0.8, startBeat: 0, durationBeat: 1 }),
    config: DEFAULT_MIDI_CONFIG, when, durationSec: 1,
    params: defaultInstrumentParams(id),
  });
  return (await ctx.startRendering()).getChannelData(0) as unknown as Float32Array;
}

async function main(): Promise<void> {
// ── The source, which is the airtight half ────────────────────────────────────

  await check('no audio module reaches for Math.random', () => {
    // A source sweep rather than only a runtime trap, because the engine caches
    // its noise and string buffers by content: a single draw behind a cache hit
    // is invisible to the second render.  Not a worry, a measurement — swapping
    // the plucked string's seeded PRNG for `Math.random` leaves the
    // render-twice check below PASSING, because the cache hands the second
    // render the first one's buffer.  This check and the trap below are what
    // catch it, and they name all four affected instruments.
    const bad: string[] = [];
    for (const file of [...filesUnder('src/renderer/daw/engine'), ...filesUnder('src/renderer/daw/audio')]) {
      const code = withoutComments(fs.readFileSync(file, 'utf8'));
      if (/Math\s*\.\s*random/.test(code)) bad.push(path.relative(DESKTOP, file));
    }
    assert(bad.length === 0, `these call Math.random: ${bad.join(', ')}`);
  });

  await check('the seven modules that promise this still say so', () => {
    // If one of them loses its comment the promise is still kept by the checks
    // above — but the next person has no way to know it is a rule rather than
    // an accident, and the rule is what stops a plausible change breaking it.
    const promised = [
      'engine/reverb-spaces.ts', 'engine/string-model.ts', 'engine/struck-string.ts',
      'engine/fm-core.ts', 'engine/mod-matrix.ts', 'engine/bowed-string.ts',
      'engine/drum-model.ts',
    ];
    for (const rel of promised) {
      const src = fs.readFileSync(path.join(DESKTOP, 'src/renderer/daw', rel), 'utf8');
      assert(/Math\.random/.test(src),
        `${rel} no longer explains why it does not use Math.random`);
    }
  });

// ── The runtime, which is the half that catches a path the sweep cannot read ──

  await check('no render path calls Math.random, for any instrument', () => {
    // Covers an indirect call the regex cannot see — through a helper in
    // another directory, or a dependency.
    const real = Math.random;
    const offenders: string[] = [];
    try {
      for (const inst of INSTRUMENTS) {
        let stack = '';
        Math.random = () => {
          if (!stack) stack = (new Error('random').stack ?? '').split('\n').slice(1, 3).join(' ');
          return 0.5;
        };
        const ctx = new OfflineAudioContext(1, 256, SR);
        inst.playNote({
          ctx: ctx as unknown as BaseAudioContext,
          destination: ctx.destination as unknown as AudioNode,
          note: createNote({ pitch: 60, velocity: 0.8, startBeat: 0, durationBeat: 1 }),
          config: DEFAULT_MIDI_CONFIG, when: 0, durationSec: 0.5,
          params: defaultInstrumentParams(inst.id),
        });
        if (stack) offenders.push(`${inst.id} (${stack.replace(/\s+/g, ' ').slice(0, 90)})`);
      }
    } finally {
      Math.random = real;
    }
    assert(offenders.length === 0, offenders.join(' | '));
  });

// ── The property itself ───────────────────────────────────────────────────────

  await check('every instrument renders the same note identically, twice', async () => {
    const bad: string[] = [];
    for (const inst of INSTRUMENTS) {
      const a = await renderNote(inst.id, 0.1);
      const b = await renderNote(inst.id, 0.1);
      if (digest(a) !== digest(b)) {
        let worst = 0;
        for (let i = 0; i < a.length; i += 1) worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
        bad.push(`${inst.id} differs by ${worst.toExponential(2)}`);
      }
    }
    assert(bad.length === 0, bad.join(', '));
  });

  await check('an instrument that makes a sound at all is being measured', async () => {
    // A silent render is identical to another silent render, so the check above
    // would pass on an engine that produced nothing at all.  This is what
    // stops it being vacuous — and it already earned its place: it named the
    // sampler, which is silent for a reason rather than by accident.
    //
    // The SFZ sampler plays the zones of a loaded instrument, and there is no
    // library in a bare render, so it has nothing to sound.  It is exempt
    // here BY NAME rather than by a peak threshold, so that an engine that
    // went silent would still be caught; sampler-selftest covers the loaded
    // case, including the tail length each zone asks for.
    const expectedSilent = new Set(['sampler']);
    const silent: string[] = [];
    const sounded: string[] = [];
    for (const inst of INSTRUMENTS) {
      const a = await renderNote(inst.id, 0.1);
      let peak = 0;
      for (let i = 0; i < a.length; i += 1) peak = Math.max(peak, Math.abs(a[i]!));
      if (peak < 1e-4) silent.push(`${inst.id} peaked at ${peak.toExponential(2)}`);
      else sounded.push(inst.id);
    }
    const unexpected = silent.filter((s) => !expectedSilent.has(s.split(' ')[0] ?? ''));
    assert(unexpected.length === 0, `silent without a reason: ${unexpected.join(', ')}`);
    // And the exemption cannot grow quietly: everything else has to sound.
    assert(sounded.length === INSTRUMENTS.length - expectedSilent.size,
      `${sounded.length} of ${INSTRUMENTS.length} instruments sounded`);
  });

  await check('every reverb space builds the same impulse twice', () => {
    // The one non-instrument module that makes the same promise, and the one
    // where a stray draw would be hardest to hear: a room is noise by design.
    const bad: string[] = [];
    for (const space of SPACES) {
      const a = renderIr(space, { sampleRate: SR });
      const b = renderIr(space, { sampleRate: SR });
      if (digest(a.left) !== digest(b.left) || digest(a.right) !== digest(b.right)) {
        bad.push(space.id);
      }
    }
    assert(bad.length === 0, `these rooms are not reproducible: ${bad.join(', ')}`);
  });

// ── Report ────────────────────────────────────────────────────────────────────

  let pass = 0;
  for (const r of results) {
    if (r.pass) { pass += 1; console.log(`  PASS  ${r.name}`); }
    else console.log(`  FAIL  ${r.name}\n        ${r.detail}`);
  }
  console.log(`\nrender-determinism-selftest: ${pass}/${results.length}`);
  if (pass !== results.length) process.exit(1);
}

void main();
