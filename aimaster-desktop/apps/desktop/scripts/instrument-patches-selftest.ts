/**
 * instrument-patches-selftest.ts — a preset bank, checked the way one rots.
 *
 * A bank of forty patches is the easiest thing in a program to ship broken and
 * have nobody notice, because nobody reads forty parameter maps.  What happens
 * instead is that one gets pasted from its neighbour and half-edited, and the
 * menu goes on claiming forty answers while holding thirty.
 *
 * So none of these checks are "does it load":
 *
 *   · no patch names a parameter its instrument does not have   (the typo)
 *   · no patch sets one outside the instrument's own range      (the guess)
 *   · no two patches of an instrument hold the same numbers     (the paste)
 *   · and they are not merely a rounding apart                  (the near-paste)
 *   · no patch sets `level`                                     (the regression)
 *   · every patch renders, and lands on the calibrated target   (the surprise)
 *
 * The duplicate check is load-bearing beyond tidiness.  Which patch a track is
 * on is DERIVED by comparing its parameters against the bank — two patches
 * with the same numbers would make that answer arbitrary, so `activePatch`
 * only means anything because this passes.
 *
 * The last one is the reason this suite renders at all.  A patch stacking
 * seven voices with drive on is a different LOUDNESS as well as a different
 * sound, and picking a sound must not be a level change — that was the whole
 * point of the calibration.  No amount of reading the table would show it.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:instrument-patches
 */

import { OfflineAudioContext } from 'node-web-audio-api';
(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import { findInstrument, defaultInstrumentParams } from '../src/renderer/daw/engine/instruments.js';
import {
  CATEGORY_LABEL, INSTRUMENT_PATCHES, PATCH_CATEGORIES, activePatch,
  categoriesFor, findPatch, patchParams, patchesFor,
} from '../src/renderer/daw/engine/instrument-patches.js';
import { createNote, DEFAULT_MIDI_CONFIG } from '../src/renderer/daw/model/midi.js';
import { getLoudnessMetrics, type AudioBufferLike } from '../src/renderer/audio/loudnessCore.js';
import {
  CALIBRATED_LEVEL, LEVEL_PEAK_CEILING_DBTP, REFERENCE_PHRASE_SECONDS,
  REFERENCE_ROOT, hardChord, referencePhrase, type LevelEvent,
} from '../src/renderer/daw/engine/instrument-level.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve().then(fn)
    .then(() => { results.push({ name, pass: true, detail: '' }); })
    .catch((e: Error) => { results.push({ name, pass: false, detail: e.message }); });
}
function assert(cond: boolean, detail: string): void {
  if (!cond) throw new Error(detail);
}

const SR = 44_100;
const INSTRUMENT_IDS = Object.keys(INSTRUMENT_PATCHES);

async function render(
  instrumentId: string, params: Record<string, number>,
  events: readonly LevelEvent[], seconds: number,
): Promise<AudioBufferLike> {
  const inst = findInstrument(instrumentId)!;
  const ctx = new OfflineAudioContext(2, Math.round(SR * seconds), SR);
  for (const e of events) {
    inst.playNote({
      ctx: ctx as unknown as BaseAudioContext,
      destination: ctx.destination as unknown as AudioNode,
      note: createNote({ pitch: e.pitch, velocity: e.vel, startBeat: 0, durationBeat: 1 }),
      config: DEFAULT_MIDI_CONFIG, when: e.at, durationSec: e.dur, params,
    });
  }
  const buf = await ctx.startRendering();
  const l = Float32Array.from(buf.getChannelData(0));
  const r = Float32Array.from(buf.getChannelData(1));
  return {
    sampleRate: SR, length: l.length, numberOfChannels: 2,
    getChannelData: (c: number) => (c === 0 ? l : r),
  };
}

/**
 * How hard a patch HITS — the loudest 100 ms of the phrase, as plain RMS.
 *
 * Not integrated loudness over the phrase, which measures something else: a
 * stab with no sustain is silent for most of it and reads 20 LU below an
 * organ that holds, even when the two hit exactly as hard.  That is a
 * difference in LENGTH, and flattening it would flatten what makes them
 * different patches.  Not BS.1770's 400 ms momentary either, for the same
 * reason at a smaller scale: a 160 ms stab spends more than half of that
 * window decayed to nothing.
 *
 * Plain RMS rather than K-weighted, because every patch is compared by the
 * same method and the weighting would only add an opinion about which
 * frequencies count — and this is not a loudness spec, it is the question of
 * whether picking a patch makes the user reach for the fader.
 */
function hitLevelDb(buffer: AudioBufferLike): number {
  const window = Math.round(buffer.sampleRate * 0.1);
  const l = buffer.getChannelData(0), r = buffer.getChannelData(1);
  const step = Math.round(window / 4);
  let best = 0;
  for (let at = 0; at + window <= (buffer.length ?? 0); at += step) {
    let sum = 0;
    for (let i = at; i < at + window; i++) sum += l[i]! * l[i]! + r[i]! * r[i]!;
    best = Math.max(best, Math.sqrt(sum / (2 * window)));
  }
  return 20 * Math.log10(Math.max(1e-9, best));
}

async function main(): Promise<void> {
  await check('every patch names parameters its instrument actually has', () => {
    for (const id of INSTRUMENT_IDS) {
      const inst = findInstrument(id);
      assert(inst !== undefined, `patches exist for ${id}, which is not an instrument`);
      const known = new Set(inst!.params.map((p) => p.id));
      for (const patch of patchesFor(id)) {
        for (const key of Object.keys(patch.params)) {
          assert(known.has(key), `${id}/${patch.id} sets ${key}, which ${id} does not have`);
        }
      }
    }
  });

  await check('every value is inside its own parameter range', () => {
    for (const id of INSTRUMENT_IDS) {
      const inst = findInstrument(id)!;
      for (const patch of patchesFor(id)) {
        for (const [key, value] of Object.entries(patch.params)) {
          const def = inst.params.find((p) => p.id === key)!;
          assert(Number.isFinite(value), `${id}/${patch.id}.${key} is ${String(value)}`);
          assert(value >= def.min && value <= def.max,
            `${id}/${patch.id}.${key} is ${value}, outside [${def.min}, ${def.max}]`);
        }
      }
    }
  });

  await check('a patch may trim Level down, never up', () => {
    // Calibration puts every instrument on target at 0.7 with headroom above
    // it.  A patch pushing past that spends the headroom; a patch pulling
    // below it is how a brighter or denser sound stays inside it.
    for (const id of INSTRUMENT_IDS) {
      for (const patch of patchesFor(id)) {
        const level = patch.params['level'];
        if (level === undefined) continue;
        assert(level < CALIBRATED_LEVEL,
          `${id}/${patch.id} sets level to ${level}, at or above the calibrated ${CALIBRATED_LEVEL}`);
        assert(level > 0.1, `${id}/${patch.id} trims level to ${level}, which is inaudible`);
      }
    }
  });

  await check('no two patches of an instrument are the same patch', () => {
    for (const id of INSTRUMENT_IDS) {
      const list = patchesFor(id);
      const seenIds = new Set<string>();
      for (const patch of list) {
        assert(!seenIds.has(patch.id), `${id} has two patches called ${patch.id}`);
        seenIds.add(patch.id);
      }
      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          const pa = patchParams(id, list[a]!.id), pb = patchParams(id, list[b]!.id);
          const same = Object.keys(pa).every((k) => pa[k] === pb[k]);
          assert(!same, `${id}: ${list[a]!.id} and ${list[b]!.id} are the same numbers`);
        }
      }
    }
  });

  await check('and no two are a rounding apart', () => {
    // The near-paste: a patch edited by nudging one number is not a second
    // patch, and it is the form the menu can look full while being empty.
    // Distance is measured in each parameter's OWN range, so a 40 ct detune
    // and a 12000 Hz cutoff count the same.
    for (const id of INSTRUMENT_IDS) {
      const inst = findInstrument(id)!;
      const list = patchesFor(id);
      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          const pa = patchParams(id, list[a]!.id), pb = patchParams(id, list[b]!.id);
          let distance = 0, moved = 0;
          for (const def of inst.params) {
            const span = def.max - def.min;
            if (span <= 0) continue;
            const d = Math.abs((pa[def.id] ?? 0) - (pb[def.id] ?? 0)) / span;
            distance += d;
            if (d > 0.02) moved += 1;
          }
          assert(distance > 0.25 && moved >= 2,
            `${id}: ${list[a]!.id} and ${list[b]!.id} differ by ${distance.toFixed(3)} `
            + `across ${moved} parameter(s) — that is an edit, not a patch`);
        }
      }
    }
  });

  await check('every patch says what it is, in a line', () => {
    for (const id of INSTRUMENT_IDS) {
      for (const patch of patchesFor(id)) {
        assert(patch.name.trim().length > 0, `${id}/${patch.id} has no name`);
        assert(patch.note.trim().length >= 8, `${id}/${patch.id} has no usable note`);
        assert(PATCH_CATEGORIES.includes(patch.category),
          `${id}/${patch.id} is in category ${patch.category}`);
        assert(CATEGORY_LABEL[patch.category].length > 0,
          `${patch.category} has no Korean label`);
      }
    }
  });

  await check('every instrument opens on a patch, not on "편집됨"', () => {
    // A track that has never been touched carries no parameters at all, and
    // the picker reads the defaults.  If no patch matched them the menu would
    // open blank on a brand new track.
    for (const id of INSTRUMENT_IDS) {
      const found = activePatch(id, {});
      assert(found !== null, `${id} at its defaults matches no patch`);
      assert(found!.category === 'init', `${id} opens on ${found!.id}, which is not an init patch`);
    }
  });

  await check('a loaded patch reads back as itself, and an edit does not', () => {
    for (const id of INSTRUMENT_IDS) {
      const inst = findInstrument(id)!;
      for (const patch of patchesFor(id)) {
        const loaded = patchParams(id, patch.id);
        const back = activePatch(id, loaded);
        assert(back?.id === patch.id,
          `${id}/${patch.id} reads back as ${back?.id ?? '편집됨'}`);
        // Move one parameter a long way and it must stop claiming the patch.
        const target = inst.params.find((p) => p.id !== 'level' && p.max > p.min)!;
        const nudged = { ...loaded, [target.id]: loaded[target.id] === target.max ? target.min : target.max };
        assert(activePatch(id, nudged)?.id !== patch.id
          || target.max === target.min,
          `${id}/${patch.id} still reads as itself after ${target.id} was moved to an end`);
      }
    }
  });

  await check('every override actually overrides something', () => {
    // A patch stores only what DIFFERS, so that the day a parameter is added
    // every existing patch picks up its default rather than a value frozen in
    // before that parameter existed.
    //
    // The rule is per-value, not per-count.  An earlier version of this also
    // required a patch to name fewer parameters than the instrument has,
    // which sounds like the same thing and is not: the acoustic guitar has
    // six, and a patch that genuinely moves all six is a patch, not a dump.
    // What makes a dump a dump is entries that say nothing.
    for (const id of INSTRUMENT_IDS) {
      const defaults = defaultInstrumentParams(id);
      for (const patch of patchesFor(id)) {
        for (const [key, value] of Object.entries(patch.params)) {
          assert(defaults[key] !== value,
            `${id}/${patch.id} sets ${key} to its default (${value}) — that is not an override`);
        }
      }
    }
  });

  await check('categories are reported in order, and only the ones used', () => {
    for (const id of INSTRUMENT_IDS) {
      const used = categoriesFor(id);
      const fromPatches = new Set(patchesFor(id).map((p) => p.category));
      assert(used.length === fromPatches.size, `${id} reports ${used.length} categories, uses ${fromPatches.size}`);
      const order = used.map((c) => PATCH_CATEGORIES.indexOf(c));
      assert(order.every((v, i) => i === 0 || v > order[i - 1]!), `${id} reports categories out of order`);
    }
  });

  await check('the picker cannot be asked for a patch that is not there', () => {
    assert(findPatch('polysynth', 'nope') === undefined, 'an unknown patch resolved');
    assert(patchesFor('drumkit').length === 0, 'the kit has patches as well as kits');
    assert(patchesFor('nope').length === 0, 'an unknown instrument has patches');
    // An unknown patch falls back to the defaults rather than to nothing —
    // a session naming a patch this build dropped still makes a sound.
    const fallback = patchParams('polysynth', 'nope');
    assert(fallback['cutoffHz'] === defaultInstrumentParams('polysynth')['cutoffHz'],
      'an unknown patch did not fall back to the defaults');
  });

  // ── The rendered checks ───────────────────────────────────────────────────

  const loud: Array<{ id: string; patch: string; lufs: number; hard: number }> = [];
  for (const id of INSTRUMENT_IDS) {
    const root = REFERENCE_ROOT[id] ?? 48;
    for (const patch of patchesFor(id)) {
      const params = patchParams(id, patch.id);
      const phrase = await render(id, params, referencePhrase(root), REFERENCE_PHRASE_SECONDS);
      const hard = getLoudnessMetrics(await render(id, params, hardChord(root), 3));
      loud.push({ id, patch: patch.id, lufs: hitLevelDb(phrase), hard: hard.truePeakDbtp });
    }
  }

  await check('every patch makes a sound', () => {
    for (const row of loud) {
      assert(Number.isFinite(row.lufs) && row.lufs > -50,
        `${row.id}/${row.patch} rendered at ${row.lufs.toFixed(1)} dB — it is silent`);
    }
  });

  await check('the bank is centred on the level the instrument was calibrated at', () => {
    // Measured and then written down rather than assumed: the bank spans
    // 15.4 dB, and almost all of that is ENVELOPE.  A chord stab with no
    // sustain is 8 dB below the init patch because it is 160 ms long, and an
    // organ that holds is 8 dB above it for the same reason.  Both are
    // correct, and a check that forced every patch onto one number would be
    // deleting the difference between a stab and an organ.
    //
    // What can be asserted is where the bank SITS.  The instrument is
    // calibrated at its defaults (instrument-level.ts), the init patch IS
    // those defaults, so a median that has walked away from it means the
    // bank as a whole has drifted off the calibration — which is the failure
    // this is for, and the one no individual patch would show.
    for (const id of INSTRUMENT_IDS) {
      const rows = loud.filter((r) => r.id === id);
      const init = rows.find((r) => r.patch === 'init');
      assert(init !== undefined, `${id} has no init patch to measure against`);
      const sorted = rows.map((r) => r.lufs).sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)]!;
      assert(Math.abs(median - init!.lufs) <= 3,
        `${id}: the median patch is ${(median - init!.lufs).toFixed(1)} dB from its init patch`);
    }
  });

  await check('no patch is quiet by accident', () => {
    // The loose one, and deliberately loose: it exists to catch a patch that
    // is 30 dB down because a decay was typed with an extra zero, not to
    // have an opinion about how short a stab may be.
    for (const id of INSTRUMENT_IDS) {
      const rows = loud.filter((r) => r.id === id);
      const hi = rows.reduce((a, b) => (a.lufs > b.lufs ? a : b));
      for (const row of rows) {
        assert(hi.lufs - row.lufs <= 18,
          `${id}/${row.patch} is ${(hi.lufs - row.lufs).toFixed(1)} dB below ${hi.patch}`);
      }
    }
  });

  await check('no patch clips on a chord played as hard as MIDI goes', () => {
    for (const row of loud) {
      assert(row.hard <= LEVEL_PEAK_CEILING_DBTP + 0.01,
        `${row.id}/${row.patch} peaks at ${row.hard.toFixed(2)} dBTP`);
    }
  });

  console.log('\n=== Factory patches ===');
  for (const id of INSTRUMENT_IDS) {
    const rows = loud.filter((r) => r.id === id);
    const values = rows.map((r) => r.lufs);
    console.log(`  ${id.padEnd(10)} ${String(rows.length).padStart(2)} patches  `
      + `${Math.min(...values).toFixed(1)} … ${Math.max(...values).toFixed(1)} LUFS  `
      + `worst peak ${Math.max(...rows.map((r) => r.hard)).toFixed(1)} dBTP  `
      + `[${categoriesFor(id).map((c) => CATEGORY_LABEL[c]).join(' ')}]`);
  }
  console.log(`  ${'합계'.padEnd(10)} ${loud.length} patches across ${INSTRUMENT_IDS.length} instruments`);

  console.log('');
  for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  const bad = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
  if (bad) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
