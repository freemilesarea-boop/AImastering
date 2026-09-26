// match-tracks-selftest — "make this track sound like that one".
//
// The Match EQ could only ever be handed a WHOLE-MIX measurement, onto the
// master bus, from the Reference panel. The question a DAW user actually asks
// — this snare against that snare — had no route: `matchTargetTrack` returns
// the master by design, and nothing else called `matchCurve`.
//
// What is checked here is not the maths (match-eq-selftest has that) but the
// two things this join can get wrong and look fine doing:
//
//   · WHICH TRACK the correction lands on. A master-bus habit carried into a
//     track-to-track action puts an instrument's correction on the mix.
//   · WHETHER IT CAN BE PRESSED TWICE. If the target is measured THROUGH the
//     Match EQ it already carries, the remaining gap reads as nothing, and
//     the second press stores a flat curve over the first one's work. The
//     feature would appear to work exactly once per track.
//
// The second is the reason `matchTrackToTrack` takes a `measure` seam: a stub
// can report what it was asked to measure, which is the only way to see the
// difference between a button that is idempotent and one that erases itself.
//
// Run: pnpm --filter @aimaster/desktop test:match-tracks

import { OfflineAudioContext } from 'node-web-audio-api';
(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import {
  MATCH_BANDS, MATCH_HZ, matchBandId, matchStored,
} from '../src/renderer/daw/engine/match-eq.js';
import {
  MATCH_PLUGIN_ID, matchTargetTrack, slotLetter,
} from '../src/renderer/daw/edit/match-from-reference.js';
import {
  MATCH_WINDOW_SEC, matchEqBetweenTracks, matchTrackToTrack, spectrumIsSilent,
  type MatchMeasure,
} from '../src/renderer/daw/edit/match-between-tracks.js';
import {
  addFile, addTrack, createClip, createInsert, createSession, createTrack, findTrack,
  setInsert, updateClips,
} from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import { analyzeBuffer, clearAudioCache } from '../src/renderer/daw/engine/audio-cache.js';
import { measureTrackForMatch } from '../src/renderer/daw/edit/match-between-tracks.js';
import { defaultParams, findPlugin } from '../src/renderer/daw/engine/plugins.js';
import { INSERT_SLOTS, type DawSession, type TrackId } from '../src/renderer/daw/model/types.js';
import type { SpectrumCurve } from '../src/renderer/daw/analysis/reference.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

function curve(dbAt: (hz: number) => number): SpectrumCurve {
  return {
    hz: Float32Array.from(MATCH_HZ),
    db: Float32Array.from(MATCH_HZ, (hz) => dbAt(hz)),
  };
}
const FLAT = curve(() => 0);
/** A model with 4 dB more air above 6 kHz and 2 dB less low end. */
const BRIGHT = curve((hz) => (hz > 6_000 ? 4 : hz < 100 ? -2 : 0));
/** What `averageSpectrum` returns when there is nothing to measure. */
const SILENT = curve(() => -120);

/** Two audio tracks, a model and a target, plus the master the session has. */
function twoTracks(): { session: DawSession; model: TrackId; target: TrackId } {
  let s = addTrack(createSession(), createTrack('Ref Gtr', 'audio'));
  s = addTrack(s, createTrack('Gtr', 'audio'));
  const audio = s.tracks.filter((t) => t.kind === 'audio');
  return { session: s, model: audio[0]!.id, target: audio[1]!.id };
}
const matchOn = (s: DawSession, id: TrackId) =>
  findTrack(s, id)!.inserts.find((i) => i.pluginId === MATCH_PLUGIN_ID);

console.log('\n=== MATCH EQ — one track against another ===\n');

// ── Where the correction goes ──────────────────────────────────────────────
{
  const { session: s, model, target } = twoTracks();
  const out = matchEqBetweenTracks(s, model, target, BRIGHT, FLAT);
  check('the correction lands on the target track',
    out.ok && matchOn(out.session, target) !== undefined,
    out.ok ? `slot ${slotLetter(out.slot)}, peak ${out.peakDb.toFixed(1)} dB` : out.reason);

  // The bug this exists to stop: a master-bus habit carried across.
  check('…and not on the master, and not on the model',
    out.ok
      && matchOn(out.session, matchTargetFor(out.session)) === undefined
      && matchOn(out.session, model) === undefined,
    out.ok ? 'master and model both untouched' : out.reason);
}
function matchTargetFor(s: DawSession): TrackId { return matchTargetTrack(s)!; }

// ── Which way round the correction points ──────────────────────────────────
{
  const { session: s, model, target } = twoTracks();
  const out = matchEqBetweenTracks(s, model, target, BRIGHT, FLAT);
  const stored = out.ok ? matchStored(matchOn(out.session, target)!.params) : [];
  const airBand = MATCH_HZ.findIndex((hz) => hz > 8_000);
  const lowBand = MATCH_HZ.findIndex((hz) => hz > 60);
  // The target must be GIVEN the model's air, so the stored number is
  // positive up top.  A sign error here is a device that makes the gap worse
  // and still reports a match.
  check('a brighter model asks the target for MORE air, not less',
    (stored[airBand] ?? 0) > 3 && (stored[lowBand] ?? 0) < -1,
    `air ${(stored[airBand] ?? 0).toFixed(2)} dB, low ${(stored[lowBand] ?? 0).toFixed(2)} dB`);

  const flipped = matchEqBetweenTracks(s, target, model, FLAT, BRIGHT);
  const back = flipped.ok ? matchStored(matchOn(flipped.session, model)!.params) : [];
  check('…and swapping the two tracks swaps the sign',
    Math.abs((back[airBand] ?? 0) + (stored[airBand] ?? 0)) < 1e-4,
    `${(stored[airBand] ?? 0).toFixed(2)} dB one way, ${(back[airBand] ?? 0).toFixed(2)} dB the other`);
}

// ── The stored curve is the raw difference ─────────────────────────────────
{
  const { session: s, model, target } = twoTracks();
  const out = matchEqBetweenTracks(s, model, target, BRIGHT, FLAT);
  const stored = out.ok ? matchStored(matchOn(out.session, target)!.params) : [];
  check('every band the device declares is written',
    stored.length === MATCH_BANDS
      && stored.every((v) => Number.isFinite(v)),
    `${stored.length} bands, all finite`);

  const declared = out.ok ? matchOn(out.session, target)!.latencySamples : -1;
  const expected = findPlugin(MATCH_PLUGIN_ID)!
    .latencyFor(matchOn(out.ok ? out.session : s, target)!.params, s.sampleRate);
  check('the insert declares the latency the device will take',
    declared === expected && declared > 0,
    `${declared} samples`);
}

// ── Every refusal names itself ─────────────────────────────────────────────
{
  const { session: s, model, target } = twoTracks();
  const cases: Array<[string, () => { ok: boolean; reason?: string }]> = [
    ['a track matched to itself', () => matchEqBetweenTracks(s, target, target, BRIGHT, FLAT)],
    ['a model that is not there', () => matchEqBetweenTracks(s, 'trk-nope', target, BRIGHT, FLAT)],
    ['a target that is not there', () => matchEqBetweenTracks(s, model, 'trk-nope', BRIGHT, FLAT)],
    ['a silent model', () => matchEqBetweenTracks(s, model, target, SILENT, FLAT)],
    ['a silent target', () => matchEqBetweenTracks(s, model, target, BRIGHT, SILENT)],
    ['an empty analysis', () => matchEqBetweenTracks(
      s, model, target, { hz: new Float32Array(), db: new Float32Array() }, FLAT)],
  ];
  const unnamed: string[] = [];
  const accepted: string[] = [];
  for (const [name, run] of cases) {
    const r = run() as { ok: boolean; reason?: string };
    if (r.ok) accepted.push(name);
    else if (!r.reason || r.reason.length < 4) unnamed.push(name);
  }
  check('nothing impossible is accepted', accepted.length === 0,
    accepted.length === 0 ? `${cases.length} refused` : `accepted: ${accepted.join(', ')}`);
  check('…and every refusal says which end was wrong', unnamed.length === 0,
    unnamed.length === 0 ? 'all named' : `silent: ${unnamed.join(', ')}`);

  // The two ends must not give the SAME sentence, or the message cannot tell
  // the user which track to go and look at.
  const silentModel = matchEqBetweenTracks(s, model, target, SILENT, FLAT);
  const silentTarget = matchEqBetweenTracks(s, model, target, BRIGHT, SILENT);
  check('…and a silent model does not read like a silent target',
    !silentModel.ok && !silentTarget.ok && silentModel.reason !== silentTarget.reason,
    !silentModel.ok && !silentTarget.ok ? `"${silentModel.reason}" vs "${silentTarget.reason}"` : 'one was accepted');
}

// ── A full rack ───────────────────────────────────────────────────────────
{
  let { session: s, model, target } = twoTracks();
  for (let slot = 0; slot < INSERT_SLOTS; slot++) {
    s = setInsert(s, target, createInsert(slot, 'eq', 'EQ'));
  }
  const out = matchEqBetweenTracks(s, model, target, BRIGHT, FLAT);
  check('a target with no free slot is told so',
    !out.ok && out.reason.includes('슬롯'),
    out.ok ? 'it found a slot that does not exist' : out.reason);
}

// ── Silence, as a predicate ───────────────────────────────────────────────
{
  check('silence is the floor at every band, not merely a quiet curve',
    spectrumIsSilent(SILENT)
    && !spectrumIsSilent(FLAT)
    && !spectrumIsSilent(curve((hz) => (hz > 1000 ? -120 : -40)))
    && spectrumIsSilent({ hz: new Float32Array(), db: new Float32Array() }),
    'a curve with one live band is not silence');
}

// ── Pressed twice ─────────────────────────────────────────────────────────
//
// The stub stands in for a renderer, and answers the way one would: asked for
// the target WITHOUT a `beforeSlot` it reports the channel as it now sounds —
// already corrected, so flat against the model — and asked for it in front of
// a slot it reports the raw material.  That is exactly the difference between
// the two readings a real render would give.
function stubMeasure(log: Array<{ trackId: TrackId; beforeSlot?: number }>,
  modelId: TrackId, corrected: SpectrumCurve): MatchMeasure {
  return (s, trackId, beforeSlot) => {
    log.push({ trackId, ...(beforeSlot === undefined ? {} : { beforeSlot }) });
    if (trackId === modelId) return Promise.resolve(BRIGHT);
    // In front of a slot: the raw material, which is what a render truncated
    // at the Match EQ would give.  Otherwise the channel as it now sounds —
    // which is the raw material too until something is correcting it.
    if (beforeSlot !== undefined) return Promise.resolve(FLAT);
    return Promise.resolve(matchOn(s, trackId) ? corrected : FLAT);
  };
}

async function pressedTwice(): Promise<void> {
  const { session: s0, model, target } = twoTracks();
  const log: Array<{ trackId: TrackId; beforeSlot?: number }> = [];
  const measure = stubMeasure(log, model, BRIGHT);

  const first = await matchTrackToTrack(s0, model, target, measure);
  if (!first.ok) { check('a first match is taken', false, first.reason); return; }
  const firstCurve = matchStored(matchOn(first.session, target)!.params);
  check('a first match is taken', firstCurve.some((v) => Math.abs(v) > 1),
    `peak ${Math.max(...firstCurve.map(Math.abs)).toFixed(2)} dB in slot ${slotLetter(first.slot)}`);

  check('the first pass measures the target with no slot to stop at',
    log.filter((e) => e.trackId === target).every((e) => e.beforeSlot === undefined),
    'nothing to skip yet');

  log.length = 0;
  const second = await matchTrackToTrack(first.session, model, target, measure);
  if (!second.ok) { check('a second match is taken', false, second.reason); return; }
  const secondCurve = matchStored(matchOn(second.session, target)!.params);

  const slot = matchOn(first.session, target)!.slot;
  check('the second pass measures the target IN FRONT OF its Match EQ',
    log.some((e) => e.trackId === target && e.beforeSlot === slot),
    `beforeSlot ${slotLetter(slot)}`);

  // The claim: same two tracks, same answer.  Not "roughly" — the measurement
  // is of the same material, so it is the same number.
  const drift = Math.max(...firstCurve.map((v, i) => Math.abs(v - (secondCurve[i] ?? 0))));
  check('pressing it twice gives the same curve, not a flat one',
    drift < 1e-6 && secondCurve.some((v) => Math.abs(v) > 1),
    `largest change ${drift.toExponential(1)} dB, peak still `
    + `${Math.max(...secondCurve.map(Math.abs)).toFixed(2)} dB`);

  // And what it would look like if the target were measured through the
  // correction instead — the bug this design avoids, shown rather than
  // asserted about.
  const throughLog: Array<{ trackId: TrackId; beforeSlot?: number }> = [];
  const ignoresTheSlot = stubMeasure(throughLog, model, BRIGHT);
  const throughIt = await matchTrackToTrack(first.session, model, target,
    (s, trackId) => ignoresTheSlot(s, trackId));
  const collapsed = throughIt.ok ? matchStored(matchOn(throughIt.session, target)!.params) : [];
  check('…and measuring it THROUGH the correction is what would flatten it',
    collapsed.every((v) => Math.abs(v) < 1e-6),
    `that path stores ${Math.max(...collapsed.map(Math.abs)).toExponential(1)} dB — the match erased`);
}

// ── What the user rides survives a re-measure ─────────────────────────────
async function ridingSurvives(): Promise<void> {
  const { session: s0, model, target } = twoTracks();
  const log: Array<{ trackId: TrackId; beforeSlot?: number }> = [];
  const measure = stubMeasure(log, model, BRIGHT);
  const first = await matchTrackToTrack(s0, model, target, measure);
  if (!first.ok) { check('riding survives a re-measure', false, first.reason); return; }

  // The user then rides the controls the measurement does not own.
  const ridden = setInsert(first.session, target, {
    ...matchOn(first.session, target)!,
    params: {
      ...matchOn(first.session, target)!.params,
      amount: 0.35, smoothOct: 1.4, limitDb: 3, mix: 0.6, outDb: -2.5,
    },
  });
  const again = await matchTrackToTrack(ridden, model, target, measure);
  if (!again.ok) { check('riding survives a re-measure', false, again.reason); return; }
  const p = matchOn(again.session, target)!.params;
  check('re-measuring keeps the controls the user rode',
    p['amount'] === 0.35 && p['smoothOct'] === 1.4 && p['limitDb'] === 3
    && p['mix'] === 0.6 && p['outDb'] === -2.5,
    `amount ${p['amount']}, smooth ${p['smoothOct']}, limit ${p['limitDb']}, `
    + `mix ${p['mix']}, out ${p['outDb']}`);
  check('…and does not add a second Match EQ beside the first',
    findTrack(again.session, target)!.inserts
      .filter((i) => i.pluginId === MATCH_PLUGIN_ID).length === 1,
    'one device, re-measured');

  // Defaults underneath, for a device stored by a build that predates a control.
  const stripped = setInsert(first.session, target, {
    ...matchOn(first.session, target)!,
    params: { [matchBandId(0)]: 1 },
  });
  const healed = await matchTrackToTrack(stripped, model, target, measure);
  const hp = healed.ok ? matchOn(healed.session, target)!.params : {};
  const defaults = defaultParams(MATCH_PLUGIN_ID);
  const missing = Object.keys(defaults).filter((k) => hp[k] === undefined);
  check('a device missing a control comes back with every one the engine reads',
    missing.length === 0, missing.length === 0 ? `${Object.keys(defaults).length} params present`
      : `missing ${missing.join(', ')}`);
}

// ── Self-match is refused before anything is rendered ─────────────────────
async function selfMatchCostsNothing(): Promise<void> {
  const { session: s, target } = twoTracks();
  const log: Array<{ trackId: TrackId; beforeSlot?: number }> = [];
  const out = await matchTrackToTrack(s, target, target, stubMeasure(log, target, FLAT));
  check('matching a track to itself renders nothing and says why',
    !out.ok && log.length === 0,
    out.ok ? 'it went ahead' : `${out.reason} (${log.length} renders)`);
}

// ── The window is bounded ────────────────────────────────────────────────
{
  check('the measurement window is bounded, so the button stays pressable',
    MATCH_WINDOW_SEC > 0 && MATCH_WINDOW_SEC <= 60,
    `${MATCH_WINDOW_SEC} s per side`);
}

// ── The whole route, with the real renderer ───────────────────────────────
//
// Everything above measures the DECISIONS with a stub, which is the only way
// to see them.  This one renders: two tracks of real audio, one brighter than
// the other, measured by `measureTrackForMatch` through `renderTrackWindow`
// and `averageSpectrum`, and asks whether the curve that comes out the far end
// points where it should.  Without this the suite would prove that the join is
// wired correctly to a renderer it never spoke to.
const SR = 48_000;

/** Noise shaped by a one-pole tilt: `tilt > 0` is brighter. */
function tiltedNoise(id: string, tilt: number): void {
  const ctx = new OfflineAudioContext(2, SR * 2, SR);
  const buffer = ctx.createBuffer(2, SR * 2, SR);
  for (let c = 0; c < 2; c++) {
    const d = buffer.getChannelData(c);
    let seed = 12_345 + c * 977;
    let lp = 0;
    for (let i = 0; i < d.length; i++) {
      seed = (Math.imul(seed ^ (seed >>> 15), 1 | seed) + 0x6d2b79f5) >>> 0;
      const white = (seed >>> 8) / 8_388_608 - 1;
      lp += 0.05 * (white - lp);
      // Mixing in the low-passed copy darkens; subtracting it brightens.
      d[i] = 0.2 * (white * (1 + tilt) - lp * tilt * 2);
    }
  }
  analyzeBuffer(id, buffer as unknown as AudioBuffer);
}

async function theRealRoute(): Promise<void> {
  clearAudioCache();
  resetIds();
  tiltedNoise('bright', 1);
  tiltedNoise('dull', -1);
  let s = createSession('match', SR);
  const modelTrack = createTrack('Bright', 'audio', { output: { kind: 'master' } });
  const targetTrack = createTrack('Dull', 'audio', { output: { kind: 'master' } });
  s = addTrack(s, modelTrack);
  s = addTrack(s, targetTrack);
  for (const id of ['bright', 'dull']) {
    s = addFile(s, {
      id, path: `/virtual/${id}.wav`, name: id,
      durationSec: 2, sampleRate: SR, channels: 2,
    });
  }
  s = updateClips(s, modelTrack.id,
    () => [createClip('bright', 'bright', { startSec: 0, offsetSec: 0, durationSec: 2 })]);
  s = updateClips(s, targetTrack.id,
    () => [createClip('dull', 'dull', { startSec: 0, offsetSec: 0, durationSec: 2 })]);

  const measured = await measureTrackForMatch(s, modelTrack.id);
  check('the renderer really is behind the measurement',
    !spectrumIsSilent(measured) && measured.db.length > 0,
    `${measured.db.length} bands measured from a rendered channel`);

  const out = await matchTrackToTrack(s, modelTrack.id, targetTrack.id);
  if (!out.ok) { check('a real match closes a real gap', false, out.reason); return; }
  const stored = matchStored(matchOn(out.session, targetTrack.id)!.params);
  const air = MATCH_HZ.findIndex((hz) => hz > 8_000);
  const low = MATCH_HZ.findIndex((hz) => hz > 60);
  // The target is the darker of the two, so the measurement has to ask for
  // top and give back bottom.  A sign or direction error anywhere in the
  // render → spectrum → curve path lands here.
  check('a real match asks the darker track for the brighter one\'s top',
    (stored[air] ?? 0) > 1 && (stored[air] ?? 0) > (stored[low] ?? 0),
    `${(stored[air] ?? 0).toFixed(2)} dB at ${Math.round(MATCH_HZ[air]!)} Hz, `
    + `${(stored[low] ?? 0).toFixed(2)} dB at ${Math.round(MATCH_HZ[low]!)} Hz`);

  // And the same two tracks, matched the other way, has to ask for the
  // opposite — measured, not assumed from the first answer's sign.
  const back = await matchTrackToTrack(s, targetTrack.id, modelTrack.id);
  const backCurve = back.ok ? matchStored(matchOn(back.session, modelTrack.id)!.params) : [];
  check('…and the other way round asks for the opposite',
    back.ok && (backCurve[air] ?? 0) < -1,
    back.ok ? `${(backCurve[air] ?? 0).toFixed(2)} dB at the same band` : 'the reverse match was refused');

  // `beforeSlot` HONOURED, not merely passed.
  //
  // The stub above proves `matchTrackToTrack` hands the right slot down.  It
  // cannot prove the measurement obeys it — and dropping that one spread in
  // `measureTrackForMatch` leaves every check above green while the real app
  // goes back to erasing its own match on the second press.  Found by
  // breaking it, so it is checked here: the same track, read two ways, has to
  // read differently.
  const airBand = MATCH_HZ.findIndex((hz) => hz > 8_000);
  const bandDb = (c: SpectrumCurve, b: number): number => c.db[
    // The measured curve is on averageSpectrum's 48-band grid, not the
    // device's 32 — find the nearest band rather than assuming they align.
    c.hz.reduce((best, hz, i) =>
      Math.abs(hz - MATCH_HZ[b]!) < Math.abs((c.hz[best] ?? 0) - MATCH_HZ[b]!) ? i : best, 0)
  ] ?? 0;

  const rawTarget = await measureTrackForMatch(s, targetTrack.id);
  const lifted = setInsert(s, targetTrack.id, createInsert(0, MATCH_PLUGIN_ID, 'Match EQ', {
    params: {
      ...defaultParams(MATCH_PLUGIN_ID),
      amount: 1, limitDb: 18, smoothOct: 0.1,
      ...Object.fromEntries(MATCH_HZ.map((hz, b) => [matchBandId(b), hz > 4_000 ? 12 : 0])),
    },
  }));
  const throughIt = await measureTrackForMatch(lifted, targetTrack.id);
  const inFront = await measureTrackForMatch(lifted, targetTrack.id, 0);
  check('measuring THROUGH a Match EQ reads the correction it is applying',
    bandDb(throughIt, airBand) - bandDb(rawTarget, airBand) > 3,
    `+${(bandDb(throughIt, airBand) - bandDb(rawTarget, airBand)).toFixed(2)} dB at `
    + `${Math.round(MATCH_HZ[airBand]!)} Hz with the device live`);
  check('…and beforeSlot is OBEYED, giving the material back unchanged',
    Math.abs(bandDb(inFront, airBand) - bandDb(rawTarget, airBand)) < 0.5
    && bandDb(throughIt, airBand) - bandDb(inFront, airBand) > 3,
    `in front ${bandDb(inFront, airBand).toFixed(2)} dB vs raw `
    + `${bandDb(rawTarget, airBand).toFixed(2)} dB, through it `
    + `${bandDb(throughIt, airBand).toFixed(2)} dB`);

  // A plugin on a track nobody is matching must not move the answer.
  //
  // `renderTrackWindow` mutes the other tracks but delay compensation still
  // counts their latency, so before `onlyThisTrackProcesses` a 511-sample
  // device on an unrelated muted track shifted a band reading by 0.0495 dB
  // while a zero-latency device on the same track shifted it by 0.0000 — the
  // mechanism is latency, and the measured difference is what says so.
  const elsewhere = createTrack('Unrelated', 'audio', { output: { kind: 'master' } });
  let withNeighbour = addTrack(s, elsewhere);
  withNeighbour = updateClips(withNeighbour, elsewhere.id,
    () => [createClip('bright', 'bright', { startSec: 0, offsetSec: 0, durationSec: 2 })]);
  const quiet = await measureTrackForMatch(withNeighbour, modelTrack.id);
  const loaded = setInsert(withNeighbour, elsewhere.id,
    createInsert(0, 'linphase', 'Linear Phase EQ', {
      params: defaultParams('linphase'),
      latencySamples: findPlugin('linphase')!.latencyFor(defaultParams('linphase'), SR),
    }));
  const afterPlugin = await measureTrackForMatch(loaded, modelTrack.id);
  const moved = Math.max(...Array.from(quiet.db, (v, i) => Math.abs(v - (afterPlugin.db[i] ?? 0))));
  check('a latent plugin on a track nobody is matching does not move the answer',
    moved < 1e-9,
    `largest band change ${moved.toExponential(1)} dB with a `
    + `${findPlugin('linphase')!.latencyFor(defaultParams('linphase'), SR)}-sample device next door`);

  const silent = createTrack('Empty', 'audio', { output: { kind: 'master' } });
  const withEmpty = addTrack(s, silent);
  const refused = await matchTrackToTrack(withEmpty, silent.id, targetTrack.id);
  check('a track with no audio at all is refused rather than rendered to noise',
    !refused.ok, refused.ok ? 'it matched against nothing' : refused.reason);
}

async function main(): Promise<void> {
  await pressedTwice();
  await ridingSurvives();
  await selfMatchCostsNothing();
  await theRealRoute();
  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  if (failed) process.exit(1);
}
void main();
