/**
 * align-selftest.ts — putting a double on top of the lead.
 *
 * The thing worth testing about an aligner is not that it produces markers;
 * it is that the mapping it produces, applied, LANDS the double's syllables
 * on the lead's.  So every case here builds two takes whose true offsets are
 * known, runs the match, and reads the mapping back at each syllable to see
 * how much error is left.
 *
 * The failure modes that matter are the ones that still produce output:
 *
 *   · a path that leaves the diagonal matches the wrong word and reports a
 *     confident answer
 *   · a path allowed to stand still stretches one moment over half a second,
 *     which is the artefact people call "the aligner ate it"
 *   · a mapping that is not strictly increasing divides by zero in the warp
 *     map rather than sounding wrong
 *
 * Run via:  pnpm --filter @aimaster/desktop test:align
 */

import {
  alignFeature, alignHopSec, alignPath, alignPoints, driftOf, DEFAULT_ALIGN,
} from '../src/renderer/daw/audio/align.js';
import { alignMarkers, describeAlign } from '../src/renderer/daw/edit/align-actions.js';
import { createClip } from '../src/renderer/daw/model/session-ops.js';
import { buildWarpMap, sourceToDest } from '../src/renderer/daw/model/warp.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }

const SR = 48000;

/** Bursts of tone — a stand-in for sung syllables, with hard attacks. */
function take(onsets: readonly number[], lengthSec: number, amp = 0.5): Float32Array {
  const out = new Float32Array(Math.round(lengthSec * SR));
  for (const at of onsets) {
    const from = Math.round(at * SR);
    const to = Math.min(out.length, from + Math.round(0.18 * SR));
    for (let i = from; i < to; i++) {
      const t = (i - from) / SR;
      out[i] = Math.sin((2 * Math.PI * 180 * i) / SR) * amp * Math.min(1, t / 0.005) * Math.exp(-t * 6);
    }
  }
  return out;
}

/** Read the mapping at a guide time, the way the warp map will. */
function mapAt(points: ReadonlyArray<{ guideSec: number; targetSec: number }>, guideSec: number): number {
  for (let i = 1; i < points.length; i++) {
    if (points[i]!.guideSec >= guideSec) {
      const a = points[i - 1]!;
      const b = points[i]!;
      const f = (guideSec - a.guideSec) / Math.max(1e-9, b.guideSec - a.guideSec);
      return a.targetSec + f * (b.targetSec - a.targetSec);
    }
  }
  return points[points.length - 1]?.targetSec ?? guideSec;
}

/** Worst error left, in ms, after the alignment is applied. */
function residualMs(guide: readonly number[], target: readonly number[], lengthSec: number): number {
  const g = alignFeature(take(guide, lengthSec), SR);
  const t = alignFeature(take(target, lengthSec), SR);
  const path = alignPath(g, t);
  assert(path !== null, '경로를 찾지 못했습니다');
  const points = alignPoints(path!);
  assert(points.length >= 2, `점이 부족합니다 (${points.length})`);
  let worst = 0;
  for (let k = 0; k < guide.length; k++) {
    const err = Math.abs(mapAt(points, guide[k]!) - target[k]!);
    if (err > worst) worst = err;
  }
  return worst * 1000;
}

const LEAD = [0.5, 1.2, 2.0, 2.8, 3.6, 4.3, 5.1];

// ── Does it actually land? ───────────────────────────────────────────────────

check('the same take maps onto itself exactly', () => {
  const err = residualMs(LEAD, LEAD, 6);
  assert(err <= 1, `${err.toFixed(1)}ms — should be nothing to do`);
});

check('a double that is late by a constant is pulled back', () => {
  const err = residualMs(LEAD, LEAD.map((x) => x + 0.06), 6);
  assert(err <= 15, `${err.toFixed(1)}ms left after a 60 ms offset`);
});

check('a double that wanders either way is pulled back', () => {
  // The case a nudge cannot fix: early here, late there.
  const err = residualMs(LEAD, [0.55, 1.14, 2.09, 2.75, 3.68, 4.24, 5.16], 6);
  assert(err <= 15, `${err.toFixed(1)}ms left after ±90 ms of wander`);
});

check('a double that drags further with every phrase is pulled back', () => {
  const err = residualMs(LEAD, LEAD.map((x, i) => x + i * 0.033), 6);
  assert(err <= 20, `${err.toFixed(1)}ms left after a 200 ms drag`);
});

check('a quieter double still matches — the feature is shape, not level', () => {
  // Six dB down.  A linear envelope would call every syllable a poor match.
  const g = alignFeature(take(LEAD, 6, 0.5), SR);
  const t = alignFeature(take(LEAD.map((x) => x + 0.05), 6, 0.25), SR);
  const path = alignPath(g, t);
  assert(path !== null, 'no path');
  const points = alignPoints(path!);
  let worst = 0;
  for (let k = 0; k < LEAD.length; k++) {
    worst = Math.max(worst, Math.abs(mapAt(points, LEAD[k]!) - (LEAD[k]! + 0.05)));
  }
  assert(worst * 1000 <= 20, `${(worst * 1000).toFixed(1)}ms`);
});

check('a soft entry with the wrong loudness contour still lands', () => {
  // The case level alone cannot do.  Both takes enter slowly (80 ms attack,
  // a sung vowel rather than a plosive) and their loud/quiet syllables are
  // the other way round, so matching on level slides along the plateau and
  // lands 17 ms out.  What marks the same moment is where the energy RISES,
  // which is what the onset half of the distance is for.
  const lengthSec = 5;
  const soft = (onsets: readonly number[], amps: readonly number[]): Float32Array => {
    const out = new Float32Array(Math.round(lengthSec * SR));
    onsets.forEach((at, k) => {
      const from = Math.round(at * SR);
      const to = Math.min(out.length, from + Math.round(0.5 * SR));
      for (let i = from; i < to; i++) {
        const t = (i - from) / SR;
        out[i] += Math.sin((2 * Math.PI * 180 * i) / SR)
          * (amps[k] ?? 0.5) * Math.min(1, t / 0.08) * Math.exp(-t * 1.2);
      }
    });
    return out;
  };
  const lead = [0.5, 1.3, 2.1, 2.9, 3.7];
  const dub = lead.map((x) => x + 0.07);
  const points = alignPoints(alignPath(
    alignFeature(soft(lead, [0.5, 0.2, 0.5, 0.2, 0.5]), SR),
    alignFeature(soft(dub, [0.2, 0.5, 0.2, 0.5, 0.2]), SR),
  )!);
  let worst = 0;
  for (let k = 0; k < lead.length; k++) {
    worst = Math.max(worst, Math.abs(mapAt(points, lead[k]!) - dub[k]!));
  }
  assert(worst * 1000 <= 8, `${(worst * 1000).toFixed(1)}ms — level alone leaves 17.5`);
});

// ── The three guards ─────────────────────────────────────────────────────────

check('the band holds, and says so in the cost, when the pairing is wrong', () => {
  // A double 1.5 s out is not a timing difference, it is the wrong take.  The
  // band is what stops the matcher from chasing it: the path is held near the
  // diagonal (so no syllable is matched to one a second and a half away) and
  // the cost goes up by two orders of magnitude, which is how the caller can
  // tell.  Without the band the path follows the content all the way out and
  // reports a confident, wrong answer.
  const near = alignPath(
    alignFeature(take(LEAD, 7), SR),
    alignFeature(take(LEAD.map((x) => x + 0.06), 7), SR),
  )!;
  const far = alignPath(
    alignFeature(take(LEAD, 7), SR),
    alignFeature(take(LEAD.map((x) => x + 1.5), 7), SR),
  )!;
  const deviation = (p: typeof near): number => {
    let max = 0;
    for (let k = 0; k < p.guideSec.length; k++) {
      max = Math.max(max, Math.abs(p.targetSec[k]! - p.guideSec[k]!));
    }
    return max;
  };
  assert(deviation(near) <= DEFAULT_ALIGN.maxDriftSec + near.hopSec,
    `${deviation(near).toFixed(3)}s on a good pairing`);
  assert(deviation(far) <= DEFAULT_ALIGN.maxDriftSec + far.hopSec,
    `${deviation(far).toFixed(3)}s — the band did not hold`);
  assert(far.cost > near.cost * 20,
    `a wrong pairing must cost far more: ${far.cost.toFixed(4)} vs ${near.cost.toFixed(4)}`);
});

check('no emitted span stretches beyond the musical range', () => {
  const g = alignFeature(take(LEAD, 6), SR);
  const t = alignFeature(take([0.55, 1.14, 2.09, 2.75, 3.68, 4.24, 5.16], 6), SR);
  const points = alignPoints(alignPath(g, t)!);
  for (let i = 1; i < points.length; i++) {
    const ratio = (points[i]!.targetSec - points[i - 1]!.targetSec)
      / (points[i]!.guideSec - points[i - 1]!.guideSec);
    assert(ratio >= DEFAULT_ALIGN.minRatio && ratio <= DEFAULT_ALIGN.maxRatio,
      `local ratio ${ratio.toFixed(2)}`);
  }
});

check('the points increase strictly on both axes', () => {
  const g = alignFeature(take(LEAD, 6), SR);
  const t = alignFeature(take(LEAD.map((x) => x + 0.04), 6), SR);
  const points = alignPoints(alignPath(g, t)!);
  for (let i = 1; i < points.length; i++) {
    assert(points[i]!.guideSec > points[i - 1]!.guideSec, 'guide axis');
    assert(points[i]!.targetSec > points[i - 1]!.targetSec, 'target axis');
  }
});

check('markers refuse a mapping that stands still', () => {
  // buildWarpMap divides by the gap between markers.  This is the one place
  // the guarantee has to hold, because it is the last thing between the
  // matcher and the renderer.
  resetIds();
  const guide = createClip('f', 'lead', { startSec: 0, offsetSec: 0, durationSec: 4 });
  const target = createClip('f', 'dub', { startSec: 0, offsetSec: 0, durationSec: 4 });
  const markers = alignMarkers([
    { guideSec: 0, targetSec: 0 },
    { guideSec: 1, targetSec: 1 },
    { guideSec: 2, targetSec: 1 },     // stands still on the source axis
    { guideSec: 2, targetSec: 1.5 },   // and here on the musical one
    { guideSec: 3, targetSec: 2 },
  ], guide, target, 120);
  for (let i = 1; i < markers.length; i++) {
    assert(markers[i]!.sourceSec > markers[i - 1]!.sourceSec, 'source axis increases');
    assert(markers[i]!.beat > markers[i - 1]!.beat, 'and so does the beat');
  }
  // Only ONE point is dropped, and getting that wrong first time is worth
  // recording: the fourth point stands still on the GUIDE axis, but both of
  // the axes a marker actually has — source seconds and beats — advance past
  // the last marker that was kept, so it is a legitimate marker.  What the
  // guard rejects is a repeat on the marker's own axes, which is the third.
  assert(markers.length === 4, `one stall dropped, got ${markers.length}`);
});

check('a take too short to match reports nothing rather than guessing', () => {
  const tiny = alignFeature(new Float32Array(10), SR);
  assert(alignPath(tiny, tiny) === null, 'one hop is not an alignment');
});

// ── Long material ────────────────────────────────────────────────────────────

check('the hop grows so a long take does not blow the matrix', () => {
  const short = alignHopSec(10, 10);
  const long = alignHopSec(1200, 1200);
  assert(short === DEFAULT_ALIGN.hopSec, `short takes keep 10 ms, got ${short}`);
  assert(long > short, `a twenty-minute take needs a coarser hop, got ${long}`);
  const rows = Math.ceil(1200 / long);
  const width = 2 * Math.ceil(DEFAULT_ALIGN.maxDriftSec / long) + 1;
  assert(rows * width <= DEFAULT_ALIGN.maxCells, `${rows * width} cells is over the ceiling`);
});

// ── Into warp markers ────────────────────────────────────────────────────────

check('markers put the double where the guide sounds, not where it sits', () => {
  resetIds();
  // The guide starts at 10 s, the double's clip at 9 s.  A marker that
  // forgot the difference would be a second out — and would look right in
  // every session where the two clips happen to start together.
  const guide = createClip('f', 'lead', { startSec: 10, offsetSec: 0, durationSec: 4 });
  const target = createClip('f', 'dub', { startSec: 9, offsetSec: 2, durationSec: 5 });
  const markers = alignMarkers(
    [{ guideSec: 0, targetSec: 1 }, { guideSec: 2, targetSec: 2.9 }], guide, target, 120,
  );
  assert(markers.length === 2, `two markers, got ${markers.length}`);
  // guideSec 0 sounds at 10 s; the target clip starts at 9 s → 1 s in → 2 beats at 120.
  assert(Math.abs(markers[0]!.beat - 2) < 1e-9, `first beat ${markers[0]!.beat}`);
  assert(Math.abs(markers[0]!.sourceSec - 3) < 1e-9, `first source ${markers[0]!.sourceSec}`);
  assert(Math.abs(markers[1]!.beat - 6) < 1e-9, `second beat ${markers[1]!.beat}`);
});

check('a guide moment before the target clip starts is dropped, not inverted', () => {
  resetIds();
  const guide = createClip('f', 'lead', { startSec: 0, offsetSec: 0, durationSec: 4 });
  const target = createClip('f', 'dub', { startSec: 2, offsetSec: 0, durationSec: 4 });
  const markers = alignMarkers(
    [{ guideSec: 0, targetSec: 0 }, { guideSec: 3, targetSec: 2 }], guide, target, 120,
  );
  assert(markers.length === 1, `the first point is off the front, got ${markers.length}`);
  assert(markers[0]!.beat >= 0, 'and no negative beat survived');
});

check('markers the warp map can read back', () => {
  resetIds();
  const guide = createClip('f', 'lead', { startSec: 0, offsetSec: 0, durationSec: 4 });
  const target = createClip('f', 'dub', { startSec: 0, offsetSec: 0, durationSec: 4 });
  const markers = alignMarkers(
    [{ guideSec: 0, targetSec: 0.1 }, { guideSec: 1, targetSec: 1.05 }, { guideSec: 2, targetSec: 2.2 }],
    guide, target, 120,
  );
  const map = buildWarpMap(
    { enabled: true, mode: 'tones', markers, baseBpm: 120, followTempo: false }, 120,
  );
  // Source 1.05 s is the double's second syllable; it must come out at 1 s,
  // which is where the lead's is.
  const at = sourceToDest(map, 1.05);
  assert(Math.abs(at - 1) < 1e-6, `landed at ${at.toFixed(4)}s, wanted 1s`);
});

check('the report names both the average and the worst', () => {
  const text = describeAlign({ markerCount: 42, maxDriftMs: 98, meanDriftMs: 31, cost: 0.1, hopMs: 10 });
  assert(text.includes('42'), text);
  assert(text.includes('31'), text);
  assert(text.includes('98'), text);
});

check('drift is measured against the guide, both directions', () => {
  const d = driftOf([{ guideSec: 1, targetSec: 1.1 }, { guideSec: 2, targetSec: 1.9 }]);
  assert(Math.abs(d.maxSec - 0.1) < 1e-9, `max ${d.maxSec}`);
  assert(Math.abs(d.meanSec - 0.1) < 1e-9, `early counts as much as late — ${d.meanSec}`);
});

// ─────────────────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Audio alignment (DTW) ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
