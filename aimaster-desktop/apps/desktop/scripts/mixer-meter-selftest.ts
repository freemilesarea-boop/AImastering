/**
 * mixer-meter-selftest — whether the console's meters say what is happening.
 *
 * They did not.  The old channel meter was a single `AnalyserNode` on the
 * post-fader tap, read as RMS, drawn on a scale whose top was labelled 0 dBFS.
 * Two separate losses stacked up, both measured rather than argued:
 *
 *   · RMS on a peak scale — programme material with a 15.7 dB crest read
 *     15.7 dB below where it was.
 *   · the analyser's own down-mix — `AnalyserNode` sums to mono as (L+R)/2,
 *     so panning a channel hard subtracted 6.02 dB from the reading at the
 *     moment the pan had made one side LOUDER.
 *
 * The consequence was not a cosmetic offset.  To light the red zone (`> -1
 * dB`) a centred channel had to peak at +13.6 dBFS and a hard-panned one at
 * +20.7 dBFS, so the console could not show clipping at all — and nothing
 * else in the app could either, since a `grep` for a clip indicator found
 * zero.
 *
 * This suite pins both halves of the fix: the readings, rendered through the
 * real MixerEngine graph, and the latch, which is the only part of a meter
 * with state that outlives the analyser's window.
 *
 * WHAT THIS SUITE CANNOT DO, said up front: it cannot poll mid-render.
 * `OfflineAudioContext.suspend` exists in node-web-audio-api and panics when
 * called, so every rendered check here reads ONE window — the last one.  That
 * is why the latch is a pure function in the model rather than private state
 * in the engine: the across-time behaviour is tested where it can be tested
 * properly, and the engine's job is reduced to feeding it the right numbers,
 * which the rendered checks verify.
 *
 * Run: pnpm --filter @aimaster/desktop test:mixer-meter
 */

import { OfflineAudioContext } from 'node-web-audio-api';

import {
  CLIP_CEILING, METER_FLOOR_DB, METER_POLL_MS, METER_TOP_DB,
  advanceLatch, clearLatch, emptyReading, meterDb, meterFftSize, meterFraction,
  newLatch, readingPeak,
} from '../src/renderer/daw/model/channel-meter.js';
import { MixerEngine } from '../src/renderer/daw/engine/mixer-engine.js';
import { addTrack, createSession, createTrack, updateTrack } from '../src/renderer/daw/model/session-ops.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import type { DawSession, Track } from '../src/renderer/daw/model/types.js';

const SR = 48_000;

interface T { name: string; pass: boolean; detail: string }
const results: T[] = [];
function check(name: string, fn: () => void): void {
  try { fn(); results.push({ name, pass: true, detail: '' }); } catch (e: unknown) {
    results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) });
  }
}
async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); results.push({ name, pass: true, detail: '' }); } catch (e: unknown) {
    results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) });
  }
}
function assert(c: unknown, m: string): void { if (!c) throw new Error(m); }
function close(a: number, b: number, m: string, tol: number): void {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${m} — got ${a.toFixed(5)}, want ${b.toFixed(5)} ±${tol}`);
}

// ── The scale and the window ─────────────────────────────────────────────────

check('the analyser window always outlasts the gap between two polls', () => {
  // The reason this matters: `getFloatTimeDomainData` returns the most recent
  // `fftSize` samples and NOTHING before them.  A window shorter than the
  // polling interval leaves samples that no reader ever sees, and an over in
  // that hole is an over the latch never hears about.  The old meter had one:
  // 2048 samples is 42.7 ms at 48 kHz against a 50 ms poll.
  for (const sr of [44_100, 48_000, 88_200, 96_000, 192_000]) {
    const size = meterFftSize(sr);
    const windowMs = (size / sr) * 1000;
    assert(windowMs >= 2 * METER_POLL_MS,
      `at ${sr} Hz the window is ${windowMs.toFixed(1)} ms, short of the `
      + `${2 * METER_POLL_MS} ms two polls need to overlap`);
  }
});

check('and is a legal fftSize — a power of two, within the spec range', () => {
  for (const sr of [44_100, 48_000, 96_000, 192_000, 384_000]) {
    const size = meterFftSize(sr);
    assert(Number.isInteger(Math.log2(size)), `${size} is not a power of two at ${sr} Hz`);
    assert(size >= 32 && size <= 32_768, `${size} is outside the AnalyserNode range at ${sr} Hz`);
  }
});

check('the over ceiling is full scale itself, not a dB of slack below it', () => {
  // Deliberate: everything the mix is eventually WRITTEN to clips at 1.0, even
  // though the float graph does not.  A ceiling set below full scale would be
  // a taste setting pretending to be a fact.
  assert(CLIP_CEILING === 1, `clip ceiling is ${CLIP_CEILING}`);
});

check('dB conversion is exact where it is checkable, and floors instead of diverging', () => {
  close(meterDb(1), 0, 'full scale is 0 dBFS', 1e-9);
  close(meterDb(0.5), -6.0206, 'half amplitude is -6.02 dB', 1e-3);
  close(meterDb(2), 6.0206, 'and the meter keeps reading above full scale', 1e-3);
  assert(meterDb(0) === METER_FLOOR_DB, 'silence floors rather than returning -Infinity');
  assert(meterDb(1e-12) === METER_FLOOR_DB, 'and so does anything below the floor');
});

check('the drawn scale puts full scale where the red zone starts', () => {
  close(meterFraction(METER_FLOOR_DB), 0, 'the floor is the bottom', 1e-9);
  close(meterFraction(METER_TOP_DB), 1, 'the top is the top', 1e-9);
  close(meterFraction(0), -METER_FLOOR_DB / (METER_TOP_DB - METER_FLOOR_DB),
    '0 dBFS sits at its share of the scale', 1e-9);
  assert(meterFraction(0) < 1, 'with over-zone left above it — a meter that cannot draw an over cannot show one');
  close(meterFraction(-200), 0, 'below the floor clamps', 1e-9);
  close(meterFraction(99), 1, 'and above the top clamps', 1e-9);
});

// ── The latch ────────────────────────────────────────────────────────────────

check('the latch takes the louder SIDE, never the average of the two', () => {
  // This is the bug in one line.  A channel panned hard left with L at full
  // scale and R at silence IS over; (L+R)/2 says it is 6 dB clear.
  const latch = newLatch();
  advanceLatch(latch, 1, 0);
  assert(latch.clipped, 'full scale on one side alone is an over');
  close(latch.holdPeak, 1, 'and the hold is that side, not the mean', 1e-9);
});

check('an over stays latched after the signal that caused it is gone', () => {
  const latch = newLatch();
  advanceLatch(latch, 1.4, 1.4);
  for (let i = 0; i < 100; i++) advanceLatch(latch, 0.01, 0.01);
  assert(latch.clipped, 'the light went out on its own');
  close(latch.holdPeak, 1.4, 'and the hold followed the signal down', 1e-9);
});

check('below full scale does not trip it, at any distance above the amber line', () => {
  const latch = newLatch();
  for (const v of [0.5, 0.9, 0.99, 0.999999]) advanceLatch(latch, v, v);
  assert(!latch.clipped, 'a channel with headroom left was called an over');
  close(latch.holdPeak, 0.999999, 'though the hold still tracks the loudest of them', 1e-9);
});

check('exactly full scale trips it — the boundary is closed, not open', () => {
  const latch = newLatch();
  advanceLatch(latch, 1, 1);
  assert(latch.clipped, '1.0 is the value a converter clips at, so it counts');
});

check('clearing puts both halves back, and the next over lights it again', () => {
  const latch = newLatch();
  advanceLatch(latch, 2, 2);
  clearLatch(latch);
  assert(!latch.clipped && latch.holdPeak === 0, 'clear left something behind');
  advanceLatch(latch, 0.2, 0.2);
  assert(!latch.clipped, 'and did not leave it primed to re-trip on a quiet signal');
  advanceLatch(latch, 1.1, 0);
  assert(latch.clipped, 'but a real over after a clear still lights it');
});

check('an empty reading is silent, unclipped and readable', () => {
  const r = emptyReading();
  assert(r.peakL === 0 && r.peakR === 0 && r.rmsL === 0 && r.rmsR === 0, 'not silent');
  assert(!r.clipped && r.holdPeak === 0, 'a channel nobody has metered yet is not clipping');
  assert(readingPeak(r) === 0, 'and its peak is zero');
});

check('readingPeak takes the louder side', () => {
  close(readingPeak({ ...emptyReading(), peakL: 0.3, peakR: 0.8 }), 0.8, 'right side won', 1e-9);
  close(readingPeak({ ...emptyReading(), peakL: 0.8, peakR: 0.3 }), 0.8, 'left side won', 1e-9);
});

// ── Through the real graph ───────────────────────────────────────────────────

interface Rendered {
  engine: MixerEngine;
  track: Track;
  /** A single analyser on the same tap, wired the way the old meter was. */
  legacy: AnalyserNode;
}

/**
 * Render one mono tone into one channel and hand back the engine.
 *
 * Fed straight into `channel.input` rather than through ClipPlayer: what is
 * under test is the tap, and a clip scheduler between the signal and the
 * meter would only add ways for the test to be wrong about what it sent.
 */
async function render(
  amp: number, pan: number, volumeDb = 0, stereo = false,
): Promise<Rendered> {
  resetIds();
  const ctx = new OfflineAudioContext(2, SR, SR);
  const engine = new MixerEngine(
    ctx as unknown as BaseAudioContext, ctx.destination as unknown as AudioNode, { meters: true },
  );
  const track = createTrack('Meter', 'audio');
  let session: DawSession = addTrack(createSession('meter', SR), track);
  session = updateTrack(session, track.id, (t) => ({ ...t, pan, volumeDb }));
  engine.sync(session);

  const channel = engine.channel(track.id);
  assert(channel !== undefined, 'the channel was not built');

  const buffer = ctx.createBuffer(stereo ? 2 : 1, SR, SR);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) data[i] = amp * Math.sin((2 * Math.PI * 1000 * i) / SR);
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(channel!.input as unknown as AudioNode);
  src.start(0);

  // The meter as it used to be, on the very same node, so the two readings can
  // be compared rather than the old one described from memory.
  const legacy = ctx.createAnalyser();
  legacy.fftSize = 2048;
  (channel!.postFaderTap as unknown as AudioNode).connect(legacy as unknown as AudioNode);

  await ctx.startRendering();
  return { engine, track, legacy: legacy as unknown as AnalyserNode };
}

function analyserPeak(a: AnalyserNode): number {
  const d = new Float32Array(a.fftSize);
  a.getFloatTimeDomainData(d);
  let pk = 0;
  for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i] ?? 0); if (v > pk) pk = v; }
  return pk;
}

async function main(): Promise<void> {
  await checkAsync('a hard-panned channel meters the side the pan made loud', async () => {
    const { engine, track } = await render(1, -1);
    const r = engine.pollMeters().get(track.id);
    assert(r !== undefined, 'no reading');
    close(r!.peakL, 1, 'the loud side reads full scale', 0.02);
    close(r!.peakR, 0, 'and the silent side reads silence', 0.02);
  });

  await checkAsync('which the meter it replaced could not do — 6 dB low, measured here', async () => {
    // The load-bearing comparison.  Both numbers come out of the same render
    // off the same node, so this is the bug rather than a description of it:
    // one analyser on a stereo tap reports (L+R)/2.
    const { engine, track, legacy } = await render(1, -1);
    const r = engine.pollMeters().get(track.id)!;
    const old = analyserPeak(legacy);
    close(old, 0.5, 'a single analyser halves a hard-panned channel', 0.02);
    const gap = 20 * Math.log10(readingPeak(r) / old);
    close(gap, 6.02, 'so the old meter sat 6 dB below the truth', 0.2);
  });

  await checkAsync('a centred channel meters equal power on both sides', async () => {
    const { engine, track } = await render(1, 0);
    const r = engine.pollMeters().get(track.id)!;
    close(r.peakL, Math.SQRT1_2, 'left', 0.02);
    close(r.peakR, Math.SQRT1_2, 'right', 0.02);
  });

  await checkAsync('peak and RMS are reported apart, and a sine proves they are not the same read', async () => {
    // A meter that says "peak" and computes RMS is the whole original defect.
    // On a sine the two are exactly sqrt(2) apart, so this cannot pass by
    // wiring the same number into both fields.
    const { engine, track } = await render(1, 0);
    const r = engine.pollMeters().get(track.id)!;
    close(r.peakL / r.rmsL, Math.SQRT2, 'left peak-to-RMS', 0.02);
    close(r.peakR / r.rmsR, Math.SQRT2, 'right peak-to-RMS', 0.02);
  });

  await checkAsync('the meter is post-fader, so pulling the fader moves it', async () => {
    const { engine, track } = await render(1, 0, -12);
    const r = engine.pollMeters().get(track.id)!;
    close(meterDb(readingPeak(r)), -12 + meterDb(Math.SQRT1_2), 'fader plus pan law', 0.2);
  });

  await checkAsync('a channel driven over full scale latches through the real graph', async () => {
    // Stereo in, panned hard: StereoPanner folds R into L, so this is a
    // channel the mixer itself pushed over — the case a user creates with a
    // pan move and never sees coming.
    const { engine, track } = await render(0.8, -1, 0, true);
    const r = engine.pollMeters().get(track.id)!;
    assert(r.peakL > 1, `the left side should be over, got ${r.peakL.toFixed(3)}`);
    assert(r.clipped, 'and the latch should have caught it');
    close(r.holdPeak, r.peakL, 'with the hold at the loud side', 1e-6);
  });

  await checkAsync('and one that stays under does not', async () => {
    const { engine, track } = await render(0.9, 0);
    const r = engine.pollMeters().get(track.id)!;
    assert(!r.clipped, `a channel peaking at ${meterDb(readingPeak(r)).toFixed(2)} dBFS was called an over`);
  });

  await checkAsync('clearing the hold clears the channel the user clicked, alone', async () => {
    const { engine, track } = await render(0.8, -1, 0, true);
    assert(engine.pollMeters().get(track.id)!.clipped, 'setup');
    engine.clearMeterHold(track.id);
    const after = engine.meterReadings().get(track.id)!;
    assert(!after.clipped && after.holdPeak === 0, 'the light stayed on after a reset');
  });

  await checkAsync('the last reading is available without re-reading the analysers', async () => {
    const { engine, track } = await render(1, 0);
    const polled = engine.pollMeters().get(track.id)!;
    const cached = engine.meterReadings().get(track.id)!;
    close(cached.peakL, polled.peakL, 'the cached reading is the polled one', 1e-9);
  });

  await checkAsync('an offline render builds no meters at all', async () => {
    // Bounce and Freeze run this same engine.  Metering there would be pure
    // cost: nothing reads it, and it is per channel per render.
    resetIds();
    const ctx = new OfflineAudioContext(2, SR, SR);
    const engine = new MixerEngine(
      ctx as unknown as BaseAudioContext, ctx.destination as unknown as AudioNode,
    );
    const track = createTrack('Silent', 'audio');
    engine.sync(addTrack(createSession('nometer', SR), track));
    assert(engine.pollMeters().size === 0, 'an offline render was paying for meters');
    assert(engine.meterReadings().size === 0, 'and reporting them');
  });

  const failed = results.filter((r) => !r.pass);
  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(`${r.pass ? '[PASS]' : '[FAIL]'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  // eslint-disable-next-line no-console
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exit(1);
}

void main();
