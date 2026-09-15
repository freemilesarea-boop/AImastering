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

/**
 * Energy in 1/3-octave bands over one window, normalised.
 *
 * Normalised because this asks whether two patches SOUND different, and a
 * patch that is merely 3 dB louder does not.  Level is the other checks' job.
 */
function bands(x: Float32Array, fromSec: number, toSec: number): number[] {
  const out: number[] = [];
  const a = Math.round(SR * fromSec), b = Math.round(SR * toSec);
  for (let i = 0; i < 24; i++) {
    const f = 60 * Math.pow(2, i / 3);
    if (f >= SR / 2) { out.push(0); continue; }
    const w = (2 * Math.PI * f) / SR, c = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (let k = a; k < b; k++) {
      const win = 0.5 * (1 - Math.cos((2 * Math.PI * (k - a)) / (b - a - 1)));
      const s = x[k]! * win + c * s1 - s2;
      s2 = s1; s1 = s;
    }
    out.push(Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2)));
  }
  const total = out.reduce((p, q) => p + q, 0) || 1;
  return out.map((v) => v / total);
}

/**
 * What a patch SOUNDS like, as a number per band and per slice.
 *
 * Timbre in TWO windows, not one.  A single window starting after the attack
 * misses most of what a struck instrument is: the Rhodes' FM index has its
 * own fast decay and is down to a few percent within 400 ms, so two patches
 * with completely different attacks measured 0.25 apart while sounding
 * nothing alike.  The attack gets a window of its own.
 *
 * Plus the ENVELOPE, normalised to its own peak, because a stab and a pad can
 * hold the same spectrum and still be two patches.
 */
function fingerprint(x: Float32Array): { spectrum: number[]; envelope: number[] } {
  const spectrum = [...bands(x, 0, 0.35), ...bands(x, 0.35, 3)];
  const span = Math.round(SR * 1.6), n = 16, step = Math.floor(span / n);
  const envelope: number[] = [];
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = i * step; k < (i + 1) * step; k++) sum += x[k]! * x[k]!;
    envelope.push(Math.sqrt(sum / step));
  }
  const peak = Math.max(...envelope) || 1;
  return { spectrum, envelope: envelope.map((v) => v / peak) };
}

function distance(a: ReturnType<typeof fingerprint>, b: ReturnType<typeof fingerprint>): number {
  let d = 0;
  for (let i = 0; i < a.spectrum.length; i++) d += Math.abs(a.spectrum[i]! - b.spectrum[i]!);
  for (let i = 0; i < a.envelope.length; i++) {
    d += Math.abs(a.envelope[i]! - b.envelope[i]!) / a.envelope.length;
  }
  return d;
}

/**
 * How far apart two patches have to sound.
 *
 * Measured, not chosen.  Across the four banks the closest genuine pair sits
 * at 0.40, and the one pair that WAS a near-copy — a clav and a marimba
 * separated by little more than their tine level — came in at 0.223 before it
 * was fixed.  0.30 sits between the two with room on both sides.
 */
const MIN_DISTINCTNESS = 0.30;

/**
 * How wide a bank has to be, end to end.
 *
 * 2.0 sits above the acoustic guitar's 1.79 before this work and below every
 * bank's width after it — so it fails on the condition that was actually
 * found, which is what a threshold has to do to be worth writing down.
 */
const MIN_BANK_WIDTH = 2.0;

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
  const prints = new Map<string, ReturnType<typeof fingerprint>>();
  for (const id of INSTRUMENT_IDS) {
    const root = REFERENCE_ROOT[id] ?? 48;
    for (const patch of patchesFor(id)) {
      const params = patchParams(id, patch.id);
      const phrase = await render(id, params, referencePhrase(root), REFERENCE_PHRASE_SECONDS);
      const hard = getLoudnessMetrics(await render(id, params, hardChord(root), 3));
      loud.push({ id, patch: patch.id, lufs: hitLevelDb(phrase), hard: hard.truePeakDbtp });

      const l = phrase.getChannelData(0), r = phrase.getChannelData(1);
      const mono = new Float32Array(phrase.length ?? 0);
      for (let i = 0; i < mono.length; i++) mono[i] = (l[i]! + r[i]!) / 2;
      prints.set(`${id}/${patch.id}`, fingerprint(mono));
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

  await check('no patch is loud by accident either', () => {
    // The asymmetric one, and the asymmetry is the point.  A patch being
    // quiet costs the user a fader move; a patch being much LOUDER than the
    // instrument was calibrated at spends the headroom the calibration
    // exists to guarantee, and it does it without clipping — density, not
    // peak, so the ceiling check never sees it.
    //
    // Measured against the init patch because that IS the calibrated sound.
    // Written after an FM bass came out 10.2 dB above it — a 1:1 ratio with
    // the pickup driven hard is simply dense — which nothing in the suite
    // noticed, because the bank's total spread was still inside every bound
    // there was.
    //
    // 9 dB, and the first attempt at 7 is why it is written down: that
    // flagged the poly synth's organ at +7.7, which is not an accident but
    // an ENVELOPE — a patch that holds at full level against an init patch
    // that decays, the same difference this suite already refuses to flatten
    // elsewhere.  So the bound sits between the loudest legitimate patch
    // (7.7) and the accident (10.2), with room on both sides.
    for (const id of INSTRUMENT_IDS) {
      const rows = loud.filter((r) => r.id === id);
      const init = rows.find((r) => r.patch === 'init')!;
      for (const row of rows) {
        assert(row.lufs - init.lufs <= 9,
          `${id}/${row.patch} is ${(row.lufs - init.lufs).toFixed(1)} dB above its init patch`);
      }
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

  await check('no two patches of an instrument SOUND the same', () => {
    // The parameter-distance checks above catch a patch pasted from its
    // neighbour.  They cannot catch the other half of the problem: two
    // patches whose numbers differ everywhere and whose sound differs
    // nowhere, which is what a bank looks like when the engine has run out of
    // axes to differ ON.
    //
    // What this does NOT catch is stated below, in the check that does: a
    // floor on the closest pair says nothing about whether the bank is wide.
    // This one is for the near-copy — two patches nudged apart by a value or
    // two, which measured 0.223 when it was real (a clav and a marimba
    // separated by little more than their tine level).
    for (const id of INSTRUMENT_IDS) {
      const list = patchesFor(id);
      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          const pa = prints.get(`${id}/${list[a]!.id}`)!;
          const pb = prints.get(`${id}/${list[b]!.id}`)!;
          const d = distance(pa, pb);
          assert(d >= MIN_DISTINCTNESS,
            `${id}: ${list[a]!.id} and ${list[b]!.id} are ${d.toFixed(3)} apart — `
            + 'they are the same sound under two names');
        }
      }
    }
  });

  await check('the bank uses the width the engine has', () => {
    // The other half of the question, and the half a floor on the closest
    // pair cannot answer: a bank can have no two patches alike and still be
    // one sound with the knobs nudged, if the engine has no axes to differ
    // ON.  That is a property of the FURTHEST pair.
    //
    // Which is the condition that was actually found here, and not by any
    // threshold — by comparing the banks' ranges.  The acoustic guitar's five
    // patches spanned 1.79 where the poly synth's twenty spanned 3.70,
    // because damping and brightness, the two things that make a string a
    // different string, were fixed per instrument and no patch could reach
    // them: every "nylon" was a steel string behind a darker EQ.
    //
    // Measured on the same fingerprint, with the contributions separated:
    //
    //     1.790   five patches, before
    //     2.236   the nine patches now, with the new axes switched off
    //     2.714   the nine patches now
    //
    // — so for the acoustic roughly half the gain is bolder authoring and
    // half is the new axes.  For the electric (2.734 → 2.803 → 3.458) it is
    // almost entirely the axes.
    for (const id of INSTRUMENT_IDS) {
      const list = patchesFor(id);
      let widest = 0, pair = '';
      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          const d = distance(prints.get(`${id}/${list[a]!.id}`)!, prints.get(`${id}/${list[b]!.id}`)!);
          if (d > widest) { widest = d; pair = `${list[a]!.id} ↔ ${list[b]!.id}`; }
        }
      }
      assert(widest >= MIN_BANK_WIDTH,
        `${id}: its widest pair is only ${widest.toFixed(3)} apart (${pair}) — `
        + 'the engine has run out of ways for a patch to differ');
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
