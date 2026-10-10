// match-eq-selftest — the route from a reference comparison to a filter.
//
// The Match EQ engine and the reference analysis were both here for a while
// with nothing between them: `matchCurve` had no caller, so every Match EQ
// anyone inserted carried a flat curve and 511 samples of latency. The
// device tested fine — its maths was never the problem — and the panel
// tested fine. What nobody could test was that the two ever met.
//
// So this measures the whole route: two spectra in, a session with a device
// in it out, and the filter that device builds asked what it does to the
// frequencies the reference and the mix disagreed about.
//
// Run: pnpm --filter @aimaster/desktop test:match-eq

import {
  MATCH_BANDS, MATCH_HZ, matchApplied, matchBandId, matchMagnitudeAt, matchStored,
} from '../src/renderer/daw/engine/match-eq.js';
import {
  MATCH_PLUGIN_ID, matchEqFromReference, matchPlacement, matchTargetTrack, slotLetter,
} from '../src/renderer/daw/edit/match-from-reference.js';
import {
  addTrack, createInsert, createSession, createTrack, findTrack, setInsert,
} from '../src/renderer/daw/model/session-ops.js';
import { defaultParams } from '../src/renderer/daw/engine/plugins.js';
import { INSERT_SLOTS, type DawSession } from '../src/renderer/daw/model/types.js';
import type { SpectrumCurve } from '../src/renderer/daw/analysis/reference.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

/** A level-normalised spectrum on the device's own band grid. */
function curve(dbAt: (hz: number) => number): SpectrumCurve {
  return {
    hz: Float32Array.from(MATCH_HZ),
    db: Float32Array.from(MATCH_HZ, (hz) => dbAt(hz)),
  };
}

const FLAT = curve(() => 0);
/** A reference with 4 dB more air above 6 kHz and 2 dB less low end. */
const BRIGHT = curve((hz) => (hz > 6_000 ? 4 : hz < 100 ? -2 : 0));

function session(): DawSession {
  return addTrack(createSession(), createTrack('Vox', 'audio'));
}
const masterOf = (s: DawSession): string => matchTargetTrack(s)!;

console.log('\n=== MATCH EQ — from the comparison to the filter ===\n');

{
  const s = session();
  const out = matchEqFromReference(s, masterOf(s), BRIGHT, FLAT);
  check('a match lands on the master', out.ok && findTrack(out.session, masterOf(s))!.inserts
    .some((i) => i.pluginId === MATCH_PLUGIN_ID),
  out.ok ? `slot ${slotLetter(out.slot)}` : out.reason);

  if (out.ok) {
    const master = findTrack(out.session, masterOf(s))!;
    const insert = master.inserts.find((i) => i.pluginId === MATCH_PLUGIN_ID)!;
    const stored = matchStored(insert.params);

    // The measurement, not a preset: the stored curve is the raw difference.
    check(
      'the stored curve is the difference that was measured',
      Math.abs(Math.max(...stored) - 4) < 1e-6 && Math.abs(Math.min(...stored) + 2) < 1e-6,
      `${Math.min(...stored).toFixed(2)} .. ${Math.max(...stored).toFixed(2)} dB across ${stored.length} bands`,
    );
    check(
      'and the peak it reports is that difference',
      Math.abs(out.peakDb - 4) < 1e-6,
      `${out.peakDb.toFixed(2)} dB`,
    );

    // The point of the whole thing: the FILTER leans the way the gap does.
    const applied = matchApplied(insert.params);
    const air = matchMagnitudeAt(applied, 10_000);
    const low = matchMagnitudeAt(applied, 50);
    const mid = matchMagnitudeAt(applied, 1_000);
    check(
      'the filter boosts where the reference was brighter',
      air > 1.5,
      `${air.toFixed(2)} dB at 10 kHz`,
    );
    check(
      'and cuts where the reference had less',
      low < -0.7,
      `${low.toFixed(2)} dB at 50 Hz`,
    );
    check(
      'and leaves alone what the two agreed about',
      Math.abs(mid) < 0.35,
      `${mid.toFixed(2)} dB at 1 kHz`,
    );
    check(
      'the insert declares the latency the device costs',
      insert.latencySamples > 0,
      `${insert.latencySamples} samples`,
    );
  }
}

{
  // Identical spectra are a legitimate answer, and must not be dressed up as
  // one: a flat curve is what the old device always had.
  const s = session();
  const out = matchEqFromReference(s, masterOf(s), FLAT, FLAT);
  const stored = out.ok
    ? matchStored(findTrack(out.session, masterOf(s))!.inserts
      .find((i) => i.pluginId === MATCH_PLUGIN_ID)!.params)
    : [];
  check(
    'two spectra that agree measure as no correction',
    out.ok && Math.max(...stored.map(Math.abs)) < 1e-9 && out.peakDb < 1e-9,
    out.ok ? `peak ${out.peakDb.toFixed(6)} dB` : out.reason,
  );
}

{
  // Re-measuring must not stack a second device, and must not throw away the
  // controls the user rode after the first match.
  const s = session();
  const first = matchEqFromReference(s, masterOf(s), BRIGHT, FLAT);
  if (!first.ok) { check('re-measure setup', false, first.reason); }
  else {
    const master = masterOf(first.session);
    const ridden = setInsert(first.session, master, {
      ...findTrack(first.session, master)!.inserts.find((i) => i.pluginId === MATCH_PLUGIN_ID)!,
      params: {
        ...findTrack(first.session, master)!.inserts.find((i) => i.pluginId === MATCH_PLUGIN_ID)!.params,
        amount: 0.35, limitDb: 3,
      },
    });
    const again = matchEqFromReference(ridden, master, curve((hz) => (hz > 6_000 ? -5 : 0)), FLAT);
    const inserts = again.ok
      ? findTrack(again.session, master)!.inserts.filter((i) => i.pluginId === MATCH_PLUGIN_ID)
      : [];
    check(
      're-measuring replaces the match rather than stacking a second one',
      again.ok && inserts.length === 1 && again.replaced,
      again.ok ? `${inserts.length} Match EQ on the master, replaced=${again.replaced}` : again.reason,
    );
    const params = inserts[0]?.params ?? {};
    check(
      'and keeps the controls the user rode',
      params['amount'] === 0.35 && params['limitDb'] === 3,
      `amount ${params['amount']}, limit ${params['limitDb']}`,
    );
    check(
      'while the measured bands are the new measurement',
      Math.abs(Math.min(...matchStored(params)) + 5) < 1e-6,
      `${Math.min(...matchStored(params)).toFixed(2)} dB at the bottom`,
    );
  }
}

{
  // Every refusal has to name itself.
  const s = session();
  const master = masterOf(s);
  let full = s;
  for (let slot = 0; slot < INSERT_SLOTS; slot++) {
    full = setInsert(full, master, createInsert(slot, 'hum', 'Hum', { params: defaultParams('hum') }));
  }
  const out = matchEqFromReference(full, master, BRIGHT, FLAT);
  check('a full rack is refused with a reason', !out.ok && out.reason.includes('슬롯'),
    out.ok ? 'it went in anyway' : out.reason);

  const missing = matchEqFromReference(s, 'trk-nope', BRIGHT, FLAT);
  check('an unknown track is refused with a reason', !missing.ok,
    missing.ok ? 'it went in anyway' : missing.reason);

  const empty = matchEqFromReference(s, master, { hz: new Float32Array(), db: new Float32Array() }, FLAT);
  check('an empty analysis is refused with a reason', !empty.ok,
    empty.ok ? 'it went in anyway' : empty.reason);
}

{
  // Placement: the free slot, or the one already taken by a match.
  const s = session();
  const master = masterOf(s);
  const withHum = setInsert(s, master, createInsert(0, 'hum', 'Hum', { params: defaultParams('hum') }));
  check('a match takes the first free slot', matchPlacement(withHum, master)?.slot === 1,
    `slot ${matchPlacement(withHum, master)?.slot}`);

  const withMatch = setInsert(withHum, master, createInsert(4, MATCH_PLUGIN_ID, 'Match EQ', {
    params: defaultParams(MATCH_PLUGIN_ID),
  }));
  check('and an existing match keeps its own slot', matchPlacement(withMatch, master)?.slot === 4,
    `slot ${matchPlacement(withMatch, master)?.slot}`);
}

{
  // The band grid the device stores on has to be the one the analysis
  // measures on, or every match is resampled twice for nothing.
  check(
    'the device stores as many bands as it declares',
    Object.keys(defaultParams(MATCH_PLUGIN_ID)).filter((k) => /^m\d+$/.test(k)).length === MATCH_BANDS,
    `${MATCH_BANDS} bands, ids ${matchBandId(0)}..${matchBandId(MATCH_BANDS - 1)}`,
  );
}

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
