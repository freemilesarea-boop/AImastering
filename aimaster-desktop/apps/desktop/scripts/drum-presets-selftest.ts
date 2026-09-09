/**
 * drum-presets-selftest.ts — ten kits, and whether they are actually ten.
 *
 * A preset menu is the easiest place in a program to ship something that
 * looks finished and is not.  Ten entries that load ten slightly different
 * numbers pass every structural check anyone writes and sound like one kit.
 * So most of what is here RENDERS the kits and measures them against the
 * claim each one makes in its own comment:
 *
 *   · 힙합's kick is an 808 — it has to ring long enough to be a bass note,
 *     and much longer than K-POP's, which has to get out of the way.
 *   · 재즈's ride is the timekeeper, so it outlasts and outweighs its kick.
 *   · 로파이 has no air, so its cymbals carry far less high end than K-POP's.
 *   · 클래식's kick is a concert bass drum: the lowest here, and the longest.
 *   · 앰비언트 has no front edge: the longest tails and the softest attack.
 *
 * And one structural claim that matters more than it looks: the kit is stored
 * as an INDEX into GENRE_ORDER.  Shifting that order by one would silently
 * swap every saved session's kit for its neighbour, with nothing to report it
 * — so the mapping is pinned here by name.
 *
 * Run via:  pnpm --filter @aimaster/desktop test:drum-presets
 */

import { OfflineAudioContext } from 'node-web-audio-api';
(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import { readFileSync } from 'node:fs';
import { findInstrument, defaultInstrumentParams } from '../src/renderer/daw/engine/instruments.js';
import { DRUM_KIT, kitPitches } from '../src/renderer/daw/engine/drum-model.js';
import {
  DRUM_GENRE_PRESETS, KIT_DEFAULT, describeKitPreset, drumSpecIn,
  kitGenreOf, kitParamOf, kitPresetParams,
} from '../src/renderer/daw/engine/drum-presets.js';
import { GENRE_ORDER, GENRE_LABEL, type GenreId } from '../src/renderer/daw/engine/plugin-presets-genre.js';
import { rackSlots } from '../src/renderer/daw/model/instrument-rack.js';
import {
  addTrack, createSession, createTrack, updateTrack,
} from '../src/renderer/daw/model/session-ops.js';
import { createNote, DEFAULT_MIDI_CONFIG } from '../src/renderer/daw/model/midi.js';

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

const SR = 48_000;
const KICK = 36, SNARE = 38, HAT = 42, CRASH = 49, RIDE = 51;

/** Render one hit in one kit, mono. */
async function hit(genre: GenreId | null, pitch: number, seconds = 3): Promise<Float32Array> {
  const kit = findInstrument('drumkit')!;
  const ctx = new OfflineAudioContext(2, Math.round(SR * seconds), SR);
  kit.playNote({
    ctx: ctx as unknown as BaseAudioContext,
    destination: ctx.destination as unknown as AudioNode,
    note: createNote({ pitch, velocity: 0.9, startBeat: 0, durationBeat: 1 }),
    config: DEFAULT_MIDI_CONFIG, when: 0, durationSec: 0.5,
    params: { ...defaultInstrumentParams('drumkit'), ...kitPresetParams(genre) },
  });
  const buf = await ctx.startRendering();
  const l = buf.getChannelData(0), r = buf.getChannelData(1);
  const out = new Float32Array(l.length);
  for (let i = 0; i < l.length; i++) out[i] = (l[i]! + r[i]!) * 0.5;
  return out;
}

function peak(x: Float32Array): number {
  let p = 0; for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i]!));
  return p;
}

/** Time to 40 dB below the hit's own peak — windowed peak, not RMS. */
function decaySec(x: Float32Array): number {
  const p = peak(x);
  if (p <= 0) return 0;
  const floor = p * 0.01;
  const win = Math.round(SR * 0.01);
  for (let i = x.length - win; i > 0; i -= win) {
    let w = 0;
    for (let j = i; j < i + win && j < x.length; j++) w = Math.max(w, Math.abs(x[j]!));
    if (w > floor) return (i + win) / SR;
  }
  return 0;
}

function bandEnergy(x: Float32Array, lo: number, hi: number, seconds = 0.35): number {
  let total = 0;
  const n = Math.min(x.length, Math.round(SR * seconds));
  for (let k = 0; k < 20; k++) {
    const hz = lo * Math.pow(hi / lo, k / 19);
    const w = 2 * Math.PI * hz / SR, c = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < n; i++) { const s0 = x[i]! + c * s1 - s2; s2 = s1; s1 = s0; }
    total += Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2);
  }
  return total / 20;
}

/** Rough fundamental, measured after the sweep has settled. */
function pitchNear(x: Float32Array, expectHz: number): number {
  let best = expectHz, bestP = -Infinity;
  const from = Math.round(SR * 0.12), to = Math.min(x.length, Math.round(SR * 0.35));
  for (let cents = -900; cents <= 900; cents += 5) {
    const hz = expectHz * Math.pow(2, cents / 1200);
    const w = 2 * Math.PI * hz / SR, c = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (let i = from; i < to; i++) { const s0 = x[i]! + c * s1 - s2; s2 = s1; s1 = s0; }
    const p = s1 * s1 + s2 * s2 - c * s1 * s2;
    if (p > bestP) { bestP = p; best = hz; }
  }
  return best;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

async function main(): Promise<void> {
  // ── The table ──────────────────────────────────────────────────────────────

  await check('there is a kit for every genre the app knows', () => {
    for (const g of GENRE_ORDER) {
      const preset = DRUM_GENRE_PRESETS[g];
      assert(preset !== undefined, `no kit for ${GENRE_LABEL[g]}`);
      assert(preset.id === g, `${GENRE_LABEL[g]}'s preset says it is ${preset.id}`);
      assert(preset.note.trim().length > 6, `${GENRE_LABEL[g]} has no note`);
      assert(Object.keys(preset.pieces).length >= 5,
        `${GENRE_LABEL[g]} patches only ${Object.keys(preset.pieces).length} pieces`);
    }
    assert(Object.keys(DRUM_GENRE_PRESETS).length === GENRE_ORDER.length,
      'there are kits for genres the app does not have');
  });

  await check('every piece a kit patches is a piece the kit has', () => {
    // A patch on a pitch the base table does not define is dead: `drumSpecIn`
    // keys on the resolved piece, so the row would never be read and the
    // genre would silently not do the thing its comment claims.
    const known = new Set(kitPitches());
    for (const g of GENRE_ORDER) {
      for (const key of Object.keys(DRUM_GENRE_PRESETS[g].pieces)) {
        assert(known.has(Number(key)),
          `${GENRE_LABEL[g]} patches pitch ${key}, which the kit does not have`);
      }
    }
  });

  await check('the kit index survives being a number', () => {
    // This mapping is in every saved session.  Reordering GENRE_ORDER would
    // swap every one of them for its neighbour with nothing to report it, so
    // the two ends are pinned by NAME here, not by index arithmetic.
    assert(kitGenreOf(KIT_DEFAULT) === null, 'kit 0 is not the built-in kit');
    assert(kitGenreOf(undefined) === null, 'a track with no kit param is not the built-in kit');
    assert(kitGenreOf(1) === 'jazz', `kit 1 is ${kitGenreOf(1)}, not jazz`);
    assert(kitGenreOf(10) === 'jpop', `kit 10 is ${kitGenreOf(10)}, not jpop`);
    assert(kitGenreOf(11) === null, 'an out-of-range kit is not the built-in kit');
    assert(kitGenreOf(-3) === null, 'a negative kit is not the built-in kit');
    for (const g of GENRE_ORDER) {
      assert(kitGenreOf(kitParamOf(g)) === g, `${GENRE_LABEL[g]} does not round trip`);
    }
    assert(kitParamOf(null) === KIT_DEFAULT, 'null is not the built-in kit');
  });

  await check('a genre says what it wants and inherits the rest', () => {
    // 재즈 patches the kick; it says nothing about the cowbell.
    const jazzKick = drumSpecIn('jazz', KICK);
    assert(jazzKick.hz === 68, `jazz kick is ${jazzKick.hz} Hz`);
    assert(jazzKick.pan === DRUM_KIT[KICK]!.pan, 'the patch dropped the base pan');
    assert(jazzKick.family === 'kick', 'the patch changed the family');
    const jazzCowbell = drumSpecIn('jazz', 56);
    assert(jazzCowbell === DRUM_KIT[56], 'an unpatched piece is not the base piece');
    assert(drumSpecIn(null, KICK) === DRUM_KIT[KICK], 'the built-in kit is not the base table');
  });

  await check('an unmapped pitch picks up the genre of the piece it fell back to', () => {
    // GM 60 is a bongo, which this kit does not have; it resolves to the
    // nearest piece.  Keying the patch on the WRITTEN pitch instead of the
    // resolved one would hand it the built-in piece inside a genre kit.
    const base = drumSpecIn(null, 60);
    const inJazz = drumSpecIn('jazz', 60);
    const patched = DRUM_GENRE_PRESETS.jazz.pieces[59];
    if (patched) {
      assert(inJazz !== base, 'a fallback piece ignored the genre');
    }
    // Whatever the patch says, the family must survive the lookup.
    assert(inJazz.family === base.family, 'the fallback changed family');
  });

  await check('a preset writes the whole parameter set, not a diff', () => {
    for (const g of GENRE_ORDER) {
      const p = kitPresetParams(g);
      for (const key of ['kit', 'level', 'tune', 'decay', 'tone', 'snap']) {
        assert(typeof p[key] === 'number', `${GENRE_LABEL[g]} leaves ${key} unset`);
      }
      assert(p['kit'] === kitParamOf(g), `${GENRE_LABEL[g]} writes the wrong kit index`);
    }
    const off = kitPresetParams(null);
    assert(off['kit'] === KIT_DEFAULT, 'turning the kit off does not clear the index');
    assert(describeKitPreset(null) === '기본 킷', describeKitPreset(null));
    assert(describeKitPreset('hiphop').startsWith('힙합'), describeKitPreset('hiphop'));
  });

  // ── The sound ──────────────────────────────────────────────────────────────

  await check('no two kits are the same kit', async () => {
    // Ten menu entries that load ten slightly different numbers pass every
    // structural check and sound like one kit.  This is the check that
    // actually costs something to satisfy.
    const fingerprints = new Map<GenreId, number[]>();
    for (const g of GENRE_ORDER) {
      const f: number[] = [];
      for (const p of [KICK, SNARE, HAT, CRASH]) {
        const x = await hit(g, p);
        f.push(peak(x), decaySec(x), bandEnergy(x, 4000, 12000) / Math.max(1e-12, bandEnergy(x, 40, 200)));
      }
      fingerprints.set(g, f);
    }
    for (let i = 0; i < GENRE_ORDER.length; i++) {
      for (let j = i + 1; j < GENRE_ORDER.length; j++) {
        const a = fingerprints.get(GENRE_ORDER[i]!)!;
        const b = fingerprints.get(GENRE_ORDER[j]!)!;
        // Relative distance, so a loud kit and a quiet one are not "different"
        // for being loud.
        let worst = 0;
        for (let k = 0; k < a.length; k++) {
          const d = Math.abs(a[k]! - b[k]!) / Math.max(1e-9, Math.abs(a[k]!) + Math.abs(b[k]!));
          worst = Math.max(worst, d);
        }
        assert(worst > 0.05,
          `${GENRE_LABEL[GENRE_ORDER[i]!]} and ${GENRE_LABEL[GENRE_ORDER[j]!]} differ by only ${(worst * 100).toFixed(1)}%`);
      }
    }
  });

  await check('힙합 kick is an 808 and K-POP kick gets out of the way', async () => {
    const trap = decaySec(await hit('hiphop', KICK));
    const kpop = decaySec(await hit('kpop', KICK));
    assert(trap > kpop * 2.5,
      `힙합 kick ${trap.toFixed(2)}s vs K-POP ${kpop.toFixed(2)}s — not an 808`);
    // And it is low enough to be a bass note rather than a thud.
    const hz = pitchNear(await hit('hiphop', KICK), DRUM_GENRE_PRESETS.hiphop.pieces[KICK]!.hz!);
    assert(hz < 55, `힙합 kick sits at ${hz.toFixed(0)} Hz`);
  });

  await check('재즈 ride is the timekeeper', async () => {
    const ride = await hit('jazz', RIDE);
    const kick = await hit('jazz', KICK);
    assert(peak(ride) > peak(kick) * 0.9,
      `jazz ride peaks at ${peak(ride).toFixed(3)} against a kick at ${peak(kick).toFixed(3)}`);
    assert(decaySec(ride) > decaySec(kick) * 4,
      `jazz ride ${decaySec(ride).toFixed(2)}s vs kick ${decaySec(kick).toFixed(2)}s`);
    // A pop ride does not have to win that fight.
    const popRide = await hit('pop', RIDE);
    const popKick = await hit('pop', KICK);
    assert(peak(ride) / peak(kick) > peak(popRide) / peak(popKick),
      'the jazz ride is no more prominent than the pop one');
  });

  await check('로파이 has no air and K-POP is nothing but', async () => {
    const lofiHat = await hit('lofi', HAT);
    const kpopHat = await hit('kpop', HAT);
    const air = (x: Float32Array): number => bandEnergy(x, 9000, 16000, 0.2);
    assert(air(kpopHat) > air(lofiHat) * 3,
      `K-POP hat has only ${(air(kpopHat) / Math.max(1e-12, air(lofiHat))).toFixed(1)}x the air of 로파이`);
    const lofiCrash = await hit('lofi', CRASH);
    const kpopCrash = await hit('kpop', CRASH);
    assert(peak(kpopCrash) > peak(lofiCrash) * 1.3,
      `로파이 crash is not pulled back (${peak(lofiCrash).toFixed(3)} vs ${peak(kpopCrash).toFixed(3)})`);
  });

  await check('클래식 kick is a concert bass drum', async () => {
    const hz = pitchNear(await hit('classic', KICK), 40);
    assert(hz < 48, `classic kick sits at ${hz.toFixed(0)} Hz`);
    const classic = decaySec(await hit('classic', KICK));
    const pop = decaySec(await hit('pop', KICK));
    assert(classic > pop * 2, `classic kick ${classic.toFixed(2)}s vs pop ${pop.toFixed(2)}s`);
  });

  await check('앰비언트 has the longest tails and the softest edge', async () => {
    const tails = new Map<GenreId, number>();
    for (const g of GENRE_ORDER) tails.set(g, decaySec(await hit(g, CRASH, 8)));
    const longest = [...tails.entries()].sort((a, b) => b[1] - a[1])[0]!;
    assert(longest[0] === 'ambient',
      `the longest crash belongs to ${GENRE_LABEL[longest[0]]}, not 앰비언트`);
    // Softest edge: how much BEATER there is on the front of the kick, which
    // is what `snap` controls.  Comparing peak-of-head to peak-of-whole reads
    // 1.000 for every kit — the envelope attacks in 1.5 ms, so the peak is
    // always in the head — and that version of this check compared 1.000 to
    // 1.000 and called it a pass.
    const edge = async (g: GenreId): Promise<number> => {
      const x = await hit(g, KICK);
      const head = x.slice(0, Math.round(SR * 0.012));
      return bandEnergy(head, 1500, 6000, 0.012)
        / Math.max(1e-12, bandEnergy(head, 40, 120, 0.012));
    };
    const ambient = await edge('ambient');
    const kpop = await edge('kpop');
    assert(ambient < kpop * 0.5,
      `앰비언트 beater ${ambient.toExponential(1)} is not softer than K-POP's ${kpop.toExponential(1)}`);
  });

  await check('EDM kick is more note than thump', async () => {
    // A small sweep is what makes it tonal: a four-on-the-floor kick has to
    // hold a pitch, which is why the sidechain exists.
    const head = (x: Float32Array): Float32Array => x.slice(0, Math.round(SR * 0.025));
    const edm = head(await hit('edm', KICK));
    const pop = head(await hit('pop', KICK));
    const spread = (x: Float32Array): number =>
      bandEnergy(x, 150, 400, 0.025) / Math.max(1e-12, bandEnergy(x, 40, 80, 0.025));
    assert(spread(edm) < spread(pop),
      `the EDM kick sweeps as much as the pop one (${spread(edm).toExponential(1)} vs ${spread(pop).toExponential(1)})`);
    assert(decaySec(await hit('edm', KICK)) > decaySec(await hit('pop', KICK)) * 1.5,
      'the EDM kick is no longer than the pop one');
  });

  await check('every kit still plays every piece', async () => {
    // A patch that zeroes a level, or tunes a piece out of the audible band,
    // silences a drum in one genre only — the kind of thing nobody finds
    // until they write a fill.
    for (const g of GENRE_ORDER) {
      const silent: number[] = [];
      const loud: number[] = [];
      for (const p of kitPitches()) {
        const v = peak(await hit(g, p, 1.5));
        if (v < 0.003) silent.push(p);
        if (v > 1.0) loud.push(p);
      }
      assert(silent.length === 0, `${GENRE_LABEL[g]} is silent on: ${silent.join(', ')}`);
      assert(loud.length === 0, `${GENRE_LABEL[g]} clips on: ${loud.join(', ')}`);
    }
  });

  // ── Reachability ───────────────────────────────────────────────────────────

  await check('choosing a kit actually lands on the track', () => {
    // Built as a session and read back, not grepped for.  `instrumentParams`
    // has been on the Track and read by the engine since instruments landed,
    // with NOTHING in the app ever writing it — so this is the first time the
    // field has been anything but its defaults.
    const track = createTrack('Drum Kit 1', 'instrument', { instrumentId: 'drumkit' });
    let session = addTrack(createSession('x'), track);
    session = updateTrack(session, track.id, (t) => ({
      ...t, instrumentParams: kitPresetParams('hiphop'),
    }));
    const slot = rackSlots(session)[0]!;
    assert(slot.kit === 'hiphop', `the slot reads ${slot.kit}`);
    assert(slot.instrumentId === 'drumkit', slot.instrumentId);
    const back = kitGenreOf(session.tracks[0]!.instrumentParams['kit']);
    assert(back === 'hiphop', `the track carries ${back}`);

    const cleared = updateTrack(session, track.id, (t) => ({
      ...t, instrumentParams: kitPresetParams(null),
    }));
    assert(rackSlots(cleared)[0]!.kit === null, 'the kit could not be turned off');
  });

  await check('the rack offers the kits, and only on the kit slot', () => {
    const rack = stripComments(
      readFileSync(new URL('../src/renderer/components/daw/InstrumentRack.tsx', import.meta.url), 'utf8'));
    const at = rack.indexOf("slot.instrumentId === 'drumkit'");
    assert(at > 0, 'the rack does not gate the kit picker on a drum slot');
    const near = rack.slice(at, at + 900);
    assert(/GENRE_ORDER\.map/.test(near), 'the kit picker does not enumerate the genres');
    assert(/setKit\(/.test(near), 'the kit picker changes nothing');
    // Hardcoding the list here is how it would go stale the first time a
    // genre is added — the same trap the instrument picker avoids.
    assert(!/'jazz'\s*,\s*'lofi'/.test(rack), 'the rack hardcodes a genre list');
    assert(/instrumentParams:/.test(rack), 'nothing in the rack writes instrumentParams');
  });

  console.log('\n=== Drum kits by genre — ten, or one wearing ten hats ===');
  for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  const bad = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - bad}/${results.length} passed${bad ? `, ${bad} FAILED` : ''}`);
  if (bad) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
