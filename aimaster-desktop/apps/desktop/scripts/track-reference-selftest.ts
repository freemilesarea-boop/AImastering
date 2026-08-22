/**
 * track-reference-selftest — comparing ONE track to a reference.
 *
 * The interesting claims here are not "the numbers came out"; they are the
 * refusals, and each one is a thing the obvious version of this feature gets
 * wrong:
 *
 *   a finished master is not a per-track reference       (blocked)
 *   a vocal comparison has no 40 Hz band in it           (structural)
 *   two sources that are both silent at 12 kHz agree     (energy floor)
 *   a mono stem has no width to match                    (skipped)
 *   a track LESS dynamic than its reference gets nothing (no expander guess)
 *   five bands off means three moves, and it says so     (not spectral copy)
 *
 * The audio is synthesised — band-limited noise, sines, bursts — so every
 * measurement is a real FFT and a real BS.1770 reading against a signal whose
 * shape is known by construction.  No fixtures, no recordings, no network.
 *
 * Run: pnpm --filter @aimaster/desktop test:track-ref
 */

import {
  bandsForRole, compareTrackToReference, formatRow, looksLikeFullMix,
  matchTrackActions, resetTrackMatchIds, spectralSpan, trackMatchSummary,
  type TrackReference,
} from '../src/renderer/daw/ai/track-reference.js';
import { analyzeTrackBuffer } from '../src/renderer/daw/ai/analysis.js';
import { analyzeForReference } from '../src/renderer/daw/analysis/reference.js';
import { applyActions } from '../src/renderer/daw/ai/actions.js';
import {
  addTrack, createSession, createTrack, findTrack,
} from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import type { AudioBufferLike } from '../src/renderer/audio/loudnessCore.js';
import type { DawSession, TrackId } from '../src/renderer/daw/model/types.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function eq<T>(a: T, b: T, m: string): void {
  if (a !== b) throw new Error(`${m} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

// ── Synthetic audio ───────────────────────────────────────────────────────────

const SR = 48000;
const SECONDS = 3;

function buffer(channels: Float32Array[]): AudioBufferLike {
  return {
    sampleRate: SR,
    numberOfChannels: channels.length,
    length: channels[0]?.length ?? 0,
    getChannelData: (c: number) => channels[c] ?? channels[0] ?? new Float32Array(0),
  };
}

/** Deterministic noise — a seeded LCG, so a failure is reproducible. */
function noise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return (state / 0x100000000) * 2 - 1;
  };
}

/**
 * Band-limited noise built by summing sines across a span.
 *
 * Additive rather than filtered because a filter's skirt would blur exactly
 * the band edges these tests are asserting about.
 */
function bandNoise(
  lowHz: number, highHz: number, amplitude: number, seed: number, lines = 40,
): Float32Array {
  const n = SR * SECONDS;
  const out = new Float32Array(n);
  const rand = noise(seed);
  for (let k = 0; k < lines; k++) {
    const hz = lowHz * Math.pow(highHz / lowHz, k / Math.max(1, lines - 1));
    const phase = rand() * Math.PI;
    const w = (2 * Math.PI * hz) / SR;
    for (let i = 0; i < n; i++) out[i] = (out[i] ?? 0) + Math.sin(w * i + phase);
  }
  const scale = amplitude / lines;
  for (let i = 0; i < n; i++) out[i] = (out[i] ?? 0) * scale;
  return out;
}

function mixInto(target: Float32Array, source: Float32Array): Float32Array {
  for (let i = 0; i < target.length; i++) target[i] = (target[i] ?? 0) + (source[i] ?? 0);
  return target;
}

const gained = (src: Float32Array, g: number): Float32Array => {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = (src[i] ?? 0) * g;
  return out;
};

/** A vocal-shaped source: energy 150 Hz – 8 kHz, nothing below or above. */
function vocalish(seed: number, airGain = 1): Float32Array {
  const out = new Float32Array(SR * SECONDS);
  mixInto(out, bandNoise(150, 800, 0.30, seed));
  mixInto(out, bandNoise(800, 3000, 0.22, seed + 1));
  mixInto(out, gained(bandNoise(3000, 8000, 0.12, seed + 2), airGain));
  return out;
}

/** A whole arrangement: every octave carries something. */
function fullMix(seed: number): Float32Array {
  const out = new Float32Array(SR * SECONDS);
  mixInto(out, bandNoise(40, 90, 0.30, seed));
  mixInto(out, bandNoise(90, 250, 0.26, seed + 1));
  mixInto(out, bandNoise(250, 900, 0.22, seed + 2));
  mixInto(out, bandNoise(900, 3000, 0.20, seed + 3));
  mixInto(out, bandNoise(3000, 9000, 0.16, seed + 4));
  mixInto(out, bandNoise(9000, 15000, 0.12, seed + 5));
  return out;
}

function mono(samples: Float32Array): AudioBufferLike { return buffer([samples]); }
function stereo(left: Float32Array, right: Float32Array): AudioBufferLike {
  return buffer([left, right]);
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function session(): { session: DawSession; vox: TrackId } {
  resetIds();
  let s = createSession('track ref test', SR);
  const vox = createTrack('Lead Vox', 'audio');
  s = addTrack(s, vox);
  return { session: s, vox: vox.id };
}

const myVocal = (airGain = 1): ReturnType<typeof analyzeTrackBuffer> => {
  const { vox } = session();
  return analyzeTrackBuffer(mono(vocalish(11, airGain)), vox, 'Lead Vox', 'audio');
};

const stemRef = (samples: Float32Array, name = 'ref vocal.wav'): TrackReference =>
  ({ name, kind: 'stem', source: analyzeForReference(mono(samples), name) });

// ── The refusal that makes this honest ────────────────────────────────────────

check('a finished master is refused as a per-track reference', () => {
  const { session: s, vox } = session();
  const mine = analyzeTrackBuffer(mono(vocalish(11)), vox, 'Lead Vox', 'audio');
  const reference: TrackReference = {
    name: 'commercial.wav', kind: 'mix',
    source: analyzeForReference(mono(fullMix(7)), 'commercial.wav'),
  };
  const comparison = compareTrackToReference(mine, reference);
  assert(comparison.blocked, 'blocked');
  eq(comparison.rows.length, 0, 'and produces no rows to act on');
  eq(matchTrackActions(s, comparison).length, 0, 'and no actions either');
  assert(comparison.blocked?.includes('REFERENCE'), 'points at the window that does compare masters');
});

check('a silent track is refused, by name', () => {
  const { vox } = session();
  const mine = analyzeTrackBuffer(mono(new Float32Array(SR)), vox, 'Lead Vox', 'audio');
  const comparison = compareTrackToReference(mine, stemRef(vocalish(3)));
  assert(comparison.blocked?.includes('Lead Vox'), `names the track: ${comparison.blocked}`);
});

check('a reference too short to measure is refused', () => {
  const short = new Float32Array(Math.floor(SR * 0.2));
  for (let i = 0; i < short.length; i++) short[i] = Math.sin(i * 0.05) * 0.3;
  const comparison = compareTrackToReference(myVocal(), stemRef(short));
  assert(comparison.blocked, `blocked: ${comparison.blocked}`);
});

// ── The band table is the safety rail ─────────────────────────────────────────

check('a vocal comparison has no sub-bass band in it at all', () => {
  for (const band of bandsForRole('vocal')) {
    assert(band.lowHz >= 100, `${band.id} starts at ${band.lowHz} Hz, not below 100`);
  }
});

check('a kick comparison does have one', () => {
  const bands = bandsForRole('kick');
  assert(bands.some((b) => b.lowHz <= 40), 'the kick is allowed at 30 Hz');
});

check('backing vocals borrow the vocal bands; an unknown role gets the generic set', () => {
  eq(JSON.stringify(bandsForRole('backing')), JSON.stringify(bandsForRole('vocal')), 'same bands');
  assert(bandsForRole('other').length > 0, 'and nothing is left without a table');
});

check('no proposed EQ move can land outside the role’s bands', () => {
  // The structural claim, checked end to end: a vocal matched against a
  // reference with a hugely different bottom end still never touches 40 Hz.
  const { session: s, vox } = session();
  const mine = analyzeTrackBuffer(mono(vocalish(11)), vox, 'Lead Vox', 'audio');
  const heavy = new Float32Array(SR * SECONDS);
  mixInto(heavy, bandNoise(30, 80, 0.9, 5));
  mixInto(heavy, vocalish(21));
  resetTrackMatchIds();
  const comparison = compareTrackToReference(mine, stemRef(heavy));
  const actions = matchTrackActions(s, comparison).flatMap((sg) => sg.actions);
  const freqs = actions.filter((a) => a.kind === 'insertParam' && a.paramId.endsWith('Hz'))
    .map((a) => (a.kind === 'insertParam' ? a.value : 0));
  for (const hz of freqs) assert(hz >= 100, `proposed ${hz} Hz on a vocal`);
});

// ── The energy floor ──────────────────────────────────────────────────────────

check('a band both sources are empty in is skipped, not compared', () => {
  // Two kick-like sources, neither of which has anything at 2–6 kHz.
  const { vox } = session();
  const thump = (seed: number, g: number): Float32Array => {
    const out = new Float32Array(SR * SECONDS);
    mixInto(out, bandNoise(35, 110, g, seed));
    return out;
  };
  const mine = analyzeTrackBuffer(mono(thump(2, 0.5)), vox, 'Kick', 'audio');
  eq(mine.guess.role, 'kick', 'the fixture is read as a kick');
  const comparison = compareTrackToReference(mine, stemRef(thump(9, 0.5), 'ref kick.wav'));
  const click = comparison.rows.find((r) => r.id === 'click');
  assert(click?.skipped, `the click band is skipped: ${JSON.stringify(click)}`);
  assert(formatRow(click!).includes('에너지'), 'and says why');
});

check('a skipped band never becomes an EQ move', () => {
  const { session: s, vox } = session();
  const thump = (seed: number): Float32Array => {
    const out = new Float32Array(SR * SECONDS);
    mixInto(out, bandNoise(35, 110, 0.5, seed));
    return out;
  };
  const mine = analyzeTrackBuffer(mono(thump(2)), vox, 'Kick', 'audio');
  const comparison = compareTrackToReference(mine, stemRef(thump(9), 'ref kick.wav'));
  resetTrackMatchIds();
  const actions = matchTrackActions(s, comparison).flatMap((sg) => sg.actions);
  const highMoves = actions.filter((a) => a.kind === 'insertParam'
    && a.paramId.endsWith('Hz') && a.value > 1500);
  eq(highMoves.length, 0, 'nothing proposed in the empty band');
});

check('skipped rows do not drag the score down', () => {
  const thump = (seed: number): Float32Array => {
    const out = new Float32Array(SR * SECONDS);
    mixInto(out, bandNoise(35, 110, 0.5, seed));
    return out;
  };
  const { vox } = session();
  const mine = analyzeTrackBuffer(mono(thump(2)), vox, 'Kick', 'audio');
  const comparison = compareTrackToReference(mine, stemRef(thump(2), 'ref kick.wav'));
  // Same signal on both sides: everything that IS compared must match.
  eq(comparison.score, 100, `identical sources score 100, got ${comparison.score}`);
});

// ── Tone, measured ────────────────────────────────────────────────────────────

check('a duller track than its reference is told to add top, not take it away', () => {
  const { session: s, vox } = session();
  const mine = analyzeTrackBuffer(mono(vocalish(11, 0.25)), vox, 'Lead Vox', 'audio');
  const bright = stemRef(vocalish(11, 2.5));
  const comparison = compareTrackToReference(mine, bright);
  const air = comparison.rows.find((r) => r.id === 'air');
  assert(air && !air.skipped, 'the air band is compared');
  eq(air?.verdict, 'under', `mine is darker: delta ${air?.delta.toFixed(2)}`);

  resetTrackMatchIds();
  const suggestions = matchTrackActions(s, comparison);
  const moves = suggestions.flatMap((sg) => sg.actions)
    .filter((a) => a.kind === 'insertParam' && a.paramId.endsWith('Db'));
  assert(moves.length > 0, 'something is proposed');
  const top = moves.find((a) => a.kind === 'insertParam' && a.paramId === 'highDb');
  assert(top && top.kind === 'insertParam' && top.value > 0,
    `top end goes UP, got ${top?.kind === 'insertParam' ? top.value : 'nothing'}`);
});

check('two identical sources propose nothing at all', () => {
  const { session: s, vox } = session();
  const same = vocalish(11);
  const mine = analyzeTrackBuffer(mono(same), vox, 'Lead Vox', 'audio');
  const comparison = compareTrackToReference(mine, stemRef(same));
  eq(comparison.score, 100, 'a perfect match');
  resetTrackMatchIds();
  eq(matchTrackActions(s, comparison).length, 0, 'and nothing to do');
  assert(trackMatchSummary(comparison, []).includes('이미'), 'and says so');
});

check('EQ moves are capped at three bands, and the rest are named', () => {
  const { session: s, vox } = session();
  // Every band different, in different directions and by a lot.
  const mine = analyzeTrackBuffer(mono(vocalish(11, 0.2)), vox, 'Lead Vox', 'audio');
  const other = new Float32Array(SR * SECONDS);
  mixInto(other, bandNoise(150, 300, 0.05, 31));
  mixInto(other, bandNoise(300, 800, 0.40, 32));
  mixInto(other, bandNoise(800, 2000, 0.06, 33));
  mixInto(other, bandNoise(2000, 5000, 0.35, 34));
  mixInto(other, bandNoise(5000, 12000, 0.30, 35));
  resetTrackMatchIds();
  const comparison = compareTrackToReference(mine, stemRef(other));
  const suggestions = matchTrackActions(s, comparison);
  const tone = suggestions.find((sg) => sg.title.includes('음색'));
  assert(tone, 'a tone suggestion exists');
  const dbMoves = tone!.actions.filter((a) => a.kind === 'insertParam' && a.paramId.endsWith('Db'));
  assert(dbMoves.length <= 3, `at most three bands move, got ${dbMoves.length}`);
  assert(tone!.reason.includes('남겨') || dbMoves.length === 3,
    `the skipped bands are named: ${tone!.reason}`);
});

check('every proposed frequency is inside the EQ’s own range for that control', () => {
  const limits: Record<string, [number, number]> = {
    lowHz: [40, 400], b1Hz: [60, 2000], b2Hz: [200, 8000],
    b3Hz: [800, 16000], highHz: [2000, 16000],
  };
  const { session: s, vox } = session();
  const mine = analyzeTrackBuffer(mono(vocalish(11, 0.2)), vox, 'Lead Vox', 'audio');
  const other = new Float32Array(SR * SECONDS);
  mixInto(other, bandNoise(150, 300, 0.05, 41));
  mixInto(other, bandNoise(2000, 5000, 0.40, 42));
  mixInto(other, bandNoise(5000, 12000, 0.35, 43));
  resetTrackMatchIds();
  const comparison = compareTrackToReference(mine, stemRef(other));
  for (const action of matchTrackActions(s, comparison).flatMap((sg) => sg.actions)) {
    if (action.kind !== 'insertParam' || !action.paramId.endsWith('Hz')) continue;
    const range = limits[action.paramId];
    assert(range, `${action.paramId} is a control eq8 has`);
    assert(action.value >= range![0] && action.value <= range![1],
      `${action.paramId} = ${action.value} outside ${range!.join('…')}`);
  }
});

// ── Level, as a relationship ──────────────────────────────────────────────────

check('with no reference mix there is no level row, and it says why', () => {
  const comparison = compareTrackToReference(myVocal(), stemRef(vocalish(3)),
    analyzeForReference(mono(fullMix(2)), 'MY MIX'));
  eq(comparison.rows.some((r) => r.kind === 'level'), false, 'no level row');
  assert(comparison.notes.some((n) => n.includes('레벨')), `and a note: ${comparison.notes.join(' / ')}`);
});

check('with both mixes the level row compares the RELATIONSHIP, not the level', () => {
  const { session: s, vox } = session();
  const mine = analyzeTrackBuffer(mono(gained(vocalish(11), 0.25)), vox, 'Lead Vox', 'audio');
  const myMix = analyzeForReference(mono(fullMix(2)), 'MY MIX');

  // Their vocal sits LOUD in their mix; mine sits quiet in mine.  Both stems
  // are scaled differently in absolute terms, which is exactly the trap: only
  // the relationship is meaningful.
  const theirStem = gained(vocalish(21), 1.0);
  const theirMixSamples = mixInto(fullMix(4), gained(vocalish(21), 1.0));
  const reference: TrackReference = {
    name: 'their vox.wav', kind: 'stemWithMix',
    source: analyzeForReference(mono(theirStem), 'their vox.wav'),
    mix: analyzeForReference(mono(theirMixSamples), 'their mix.wav'),
  };

  const comparison = compareTrackToReference(mine, reference, myMix);
  const level = comparison.rows.find((r) => r.kind === 'level');
  assert(level, 'the level row exists');
  assert(level!.verdict !== 'match', `they differ: ${level!.delta.toFixed(1)} LU`);

  resetTrackMatchIds();
  const fader = matchTrackActions(s, comparison).flatMap((sg) => sg.actions)
    .find((a) => a.kind === 'trackVolume');
  assert(fader, 'a fader move is proposed');
  assert(fader!.kind === 'trackVolume' && Math.abs(fader!.db) <= 6 + 1e-6,
    `and it is capped: ${fader!.kind === 'trackVolume' ? fader!.db : '?'}`);
});

check('the fader move lands on the track, never on the master', () => {
  const { session: s, vox } = session();
  const mine = analyzeTrackBuffer(mono(gained(vocalish(11), 0.25)), vox, 'Lead Vox', 'audio');
  const myMix = analyzeForReference(mono(fullMix(2)), 'MY MIX');
  const reference: TrackReference = {
    name: 'their vox.wav', kind: 'stemWithMix',
    source: analyzeForReference(mono(vocalish(21)), 'their vox.wav'),
    mix: analyzeForReference(mono(mixInto(fullMix(4), vocalish(21))), 'their mix.wav'),
  };
  resetTrackMatchIds();
  const comparison = compareTrackToReference(mine, reference, myMix);
  const suggestions = matchTrackActions(s, comparison);
  for (const action of suggestions.flatMap((sg) => sg.actions)) {
    // Not every IntelAction has a track (a reharmonisation is session-wide),
    // so "targets this track" means it has one AND it is this one.
    assert('trackId' in action, `${action.kind} is not a per-track action`);
    const targeted = action as { trackId: string };
    eq(targeted.trackId, vox, `every action targets ${vox}, not ${targeted.trackId}`);
  }
  const after = applyActions(s, suggestions.flatMap((sg) => sg.actions));
  assert(findTrack(after, vox), 'and it applies cleanly');
});

// ── Dynamics and width ────────────────────────────────────────────────────────

check('a track LESS dynamic than its reference gets no expander guess', () => {
  const { session: s, vox } = session();
  // Bursts of noise are far more dynamic than continuous noise.
  const bursts = new Float32Array(SR * SECONDS);
  const steady = vocalish(21);
  for (let i = 0; i < bursts.length; i++) {
    const inBurst = Math.floor(i / (SR * 0.25)) % 2 === 0;
    bursts[i] = inBurst ? (steady[i] ?? 0) * 2 : 0;
  }
  const mine = analyzeTrackBuffer(mono(steady), vox, 'Lead Vox', 'audio');
  const comparison = compareTrackToReference(mine, stemRef(bursts));
  const crest = comparison.rows.find((r) => r.kind === 'crest');
  assert(crest, 'the crest row exists');
  eq(crest?.verdict === 'over', false, 'mine is the LESS dynamic side');
  resetTrackMatchIds();
  const comp = matchTrackActions(s, comparison).find((sg) => sg.title.includes('컴프'));
  eq(comp, undefined, 'so no compressor is proposed, and no expander either');
});

check('a mono reference means no width row and no widener', () => {
  const { session: s, vox } = session();
  const wide = stereo(vocalish(11), vocalish(77));
  const mine = analyzeTrackBuffer(wide, vox, 'Lead Vox', 'audio');
  const comparison = compareTrackToReference(mine, stemRef(vocalish(21)));
  eq(comparison.rows.some((r) => r.kind === 'width'), false, 'no width row');
  assert(comparison.notes.some((n) => n.includes('모노')), 'and it says the reference is mono');
  resetTrackMatchIds();
  const widener = matchTrackActions(s, comparison)
    .flatMap((sg) => sg.actions)
    .find((a) => a.kind === 'addInsert' && a.pluginId === 'widener');
  eq(widener, undefined, 'so nothing proposes a widener');
});

// ── "Is this really a stem?" ──────────────────────────────────────────────────

check('only a source with BOTH ends occupied reads as a whole arrangement', () => {
  // Counting occupied octaves does not work — measured, a vocal and a full mix
  // both come out around six, because both roll off gently.  Having the bottom
  // AND the top at once is what actually separates them.
  const span = (s: Float32Array) => spectralSpan(analyzeForReference(mono(s), 'x').spectrum);

  const mix = span(fullMix(7));
  assert(mix.full, `a full mix: bottom ${mix.bottomDb.toFixed(0)} top ${mix.topDb.toFixed(0)}`);

  const vox = span(vocalish(11));
  eq(vox.full, false, `a vocal has neither end: bottom ${vox.bottomDb.toFixed(0)} top ${vox.topDb.toFixed(0)}`);

  // A bass has the bottom and no top; a hat the reverse.  Both must read false,
  // or every stem in a session gets the "is this really a stem" note.
  const bass = new Float32Array(SR * SECONDS);
  mixInto(bass, bandNoise(35, 200, 0.5, 51));
  const bassSpan = span(bass);
  eq(bassSpan.full, false, `a bass: bottom ${bassSpan.bottomDb.toFixed(0)} top ${bassSpan.topDb.toFixed(0)}`);

  const hat = new Float32Array(SR * SECONDS);
  mixInto(hat, bandNoise(4000, 16000, 0.3, 52));
  const hatSpan = span(hat);
  eq(hatSpan.full, false, `a hat: bottom ${hatSpan.bottomDb.toFixed(0)} top ${hatSpan.topDb.toFixed(0)}`);

  eq(looksLikeFullMix(analyzeForReference(mono(fullMix(7)), 'mix')), true, 'the mix is flagged');
  eq(looksLikeFullMix(analyzeForReference(mono(vocalish(11)), 'vox')), false, 'the vocal is not');
});

check('a stem that measures like a mix is noted, not blocked', () => {
  const mine = myVocal();
  const suspicious: TrackReference = {
    name: 'stem.wav', kind: 'stem',
    source: analyzeForReference(mono(fullMix(7)), 'stem.wav'),
  };
  const comparison = compareTrackToReference(mine, suspicious);
  eq(comparison.blocked, undefined, 'the user’s word still stands');
  assert(comparison.notes.some((n) => n.includes('풀 믹스')), `but it is said: ${comparison.notes.join(' / ')}`);
});

// ── Report ────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Per-track reference: refusals · bands · relationships ===');
for (const r of results) {
  console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
