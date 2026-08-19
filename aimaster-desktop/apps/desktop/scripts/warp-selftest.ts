/**
 * warp-selftest — Warp: markers, the tempo map, and the time stretch.
 *
 * The three claims:
 *
 *   The map is a bijection.  Source → destination → source has to round-trip,
 *   because the renderer walks it one way and the UI draws it the other.
 *
 *   Time moves, pitch does not.  A 440 Hz tone stretched to twice its length
 *   is still 440 Hz — that is the entire reason WSOLA exists instead of
 *   `playbackRate`.
 *
 *   Beats land where the grid says.  Auto-warping a sloppy performance puts
 *   the hits on the grid, measured by re-detecting the onsets afterwards.
 *
 * Run: pnpm --filter @aimaster/desktop test:warp
 */

import { OfflineAudioContext } from 'node-web-audio-api';

// renderSession reads OfflineAudioContext off globalThis (the browser has it).
(globalThis as unknown as { OfflineAudioContext: unknown }).OfflineAudioContext = OfflineAudioContext;

import {
  DEFAULT_WARP, buildWarpMap, sourceToDest, destToSource, rateAt, resolveBpm,
  beatSeconds, addMarker, removeMarker, moveMarker, clearMarkers, createMarker,
  warpFromBpm, autoWarp, estimateBpm, warpedDuration, retimeClip, clipWarp,
  validateWarp, describeWarp, setSessionTempo, clipSourceSpan,
  type WarpConfig,
} from '../src/renderer/daw/model/warp.js';
import {
  modeOptions, planStretch, renderStretch, stretchChannel, stretchChannels,
} from '../src/renderer/daw/audio/time-stretch.js';
import { renderWarpedClip, warpKey } from '../src/renderer/daw/engine/warp-render.js';
import { yinF0 } from '../src/renderer/daw/audio/pitch-analysis.js';
import { detectTransients } from '../src/renderer/daw/edit/transient.js';
import {
  addFile, addTrack, createClip, createMidiPart, createSession, createTrack, findTrack,
  trackClips, updateClips,
} from '../src/renderer/daw/model/session-ops.js';
import { analyzeBuffer, clearAudioCache } from '../src/renderer/daw/engine/audio-cache.js';
import { clearWarpCache, ensureWarpedBuffer } from '../src/renderer/daw/engine/warp-render.js';
import { renderSession } from '../src/renderer/daw/engine/offline-render.js';
import { resetIds } from '../src/renderer/daw/model/ids.js';
import type { Clip, DawSession } from '../src/renderer/daw/model/types.js';

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
function close(a: number, b: number, m: string, tol = 1e-9): void {
  if (Math.abs(a - b) > tol) throw new Error(`${m} — got ${a}, want ${b} ±${tol}`);
}

const SR = 44100;

function tone(hz: number, seconds: number, amp = 0.5, sampleRate = SR): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return out;
}

/** Goertzel — level at one frequency. */
function toneLevel(x: Float32Array, hz: number, sampleRate = SR): number {
  const n = x.length;
  if (n === 0) return 0;
  const coeff = 2 * Math.cos((2 * Math.PI * hz) / sampleRate);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    const s0 = (x[i] ?? 0) + coeff * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) / (n / 2);
}

/**
 * Pitch, measured with the project's own YIN estimator rather than a hand-
 * rolled autocorrelation — a plain autocorrelation octave-errors on a pure
 * sine, and a test needs a ruler that is already trusted.
 */
function measureHz(x: Float32Array, sampleRate = SR): number {
  return yinF0(x, sampleRate, 80, 2000).hz;
}

function rms(x: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += (x[i] ?? 0) ** 2;
  return x.length > 0 ? Math.sqrt(sum / x.length) : 0;
}

/** Click train — impulses with a short decay, so onsets are detectable. */
function clicks(times: readonly number[], seconds: number, sampleRate = SR): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (const t of times) {
    const start = Math.round(t * sampleRate);
    const len = Math.round(0.02 * sampleRate);
    for (let i = 0; i < len; i++) {
      const index = start + i;
      if (index >= out.length) break;
      const env = Math.exp(-i / (0.004 * sampleRate));
      out[index] = (out[index] ?? 0) + 0.8 * env * Math.sin((2 * Math.PI * 900 * i) / sampleRate);
    }
  }
  return out;
}

// ── The map ───────────────────────────────────────────────────────────────────

check('with no markers the map is the identity', () => {
  const map = buildWarpMap(DEFAULT_WARP, 120);
  close(sourceToDest(map, 3.7), 3.7, 'source passes through', 1e-12);
  close(destToSource(map, 3.7), 3.7, 'and back', 1e-12);
  close(rateAt(map, 1), 1, 'rate is 1:1', 1e-12);
});

check('two markers make a constant ratio', () => {
  // 4 source seconds carrying 8 beats.  At 120 BPM 8 beats is 4 seconds → 1:1.
  const warp = warpFromBpm(120, 0, 4);
  const same = buildWarpMap(warp, 120);
  close(rateAt(same, 1), 1, 'same tempo is 1:1', 1e-9);

  // At 60 BPM, 8 beats is 8 seconds → the clip plays twice as long, so it
  // consumes half a source second per destination second.
  const slow = buildWarpMap(warp, 60);
  close(rateAt(slow, 1), 0.5, 'halving the tempo halves the rate', 1e-9);
  close(sourceToDest(slow, 4), 8, 'the end lands at 8 s', 1e-9);
  close(destToSource(slow, 8), 4, 'and maps back', 1e-9);
});

check('source → dest → source round-trips across a piecewise map', () => {
  const warp: WarpConfig = {
    ...DEFAULT_WARP, enabled: true,
    markers: [createMarker(0, 0), createMarker(1, 2), createMarker(1.5, 4), createMarker(4, 6)],
  };
  const map = buildWarpMap(warp, 120);
  for (const s of [0, 0.3, 0.999, 1, 1.2, 1.5, 2.7, 4, 5.5, -0.4]) {
    close(destToSource(map, sourceToDest(map, s)), s, `round trip at ${s}`, 1e-9);
  }
  // The middle segment squeezes 0.5 s into 2 beats — it must read faster.
  assert(rateAt(map, sourceToDest(map, 1.2)) < rateAt(map, sourceToDest(map, 0.5)),
    'the squeezed segment should have a lower rate');
});

check('the map is monotonic, so nothing plays backwards', () => {
  const warp: WarpConfig = {
    ...DEFAULT_WARP, enabled: true,
    markers: [createMarker(0, 0), createMarker(0.9, 1), createMarker(2.5, 2), createMarker(3, 4)],
  };
  const map = buildWarpMap(warp, 140);
  let previous = -Infinity;
  for (let s = -1; s <= 5; s += 0.05) {
    const d = sourceToDest(map, s);
    assert(d > previous, `not increasing at source ${s.toFixed(2)}`);
    previous = d;
  }
});

check('outside the markers the nearest ratio is extended', () => {
  const warp = warpFromBpm(120, 1, 2);           // markers at 1 s and 3 s
  const map = buildWarpMap(warp, 60);            // rate 0.5
  close(sourceToDest(map, 0), sourceToDest(map, 1) - 2, 'before the first marker', 1e-9);
  close(sourceToDest(map, 4), sourceToDest(map, 3) + 2, 'after the last marker', 1e-9);
});

// ── Marker editing ────────────────────────────────────────────────────────────

check('markers stay sorted and refuse to stack', () => {
  resetIds();
  let warp: WarpConfig = { ...DEFAULT_WARP, enabled: true, markers: [] };
  warp = addMarker(warp, 2, 4);
  warp = addMarker(warp, 1, 2);
  warp = addMarker(warp, 3, 6);
  eq(warp.markers.map((m) => m.sourceSec).join(','), '1,2,3', 'sorted by source');
  const dup = addMarker(warp, 2.0005, 9);
  eq(dup, warp, 'a marker on top of another is refused');
  eq(addMarker(warp, 9, 4).markers.length, 3, 'a duplicate beat is refused too');
});

check('dragging a marker cannot cross its neighbours', () => {
  resetIds();
  let warp: WarpConfig = { ...DEFAULT_WARP, enabled: true, markers: [] };
  warp = addMarker(warp, 1, 1);
  warp = addMarker(warp, 2, 2);
  warp = addMarker(warp, 3, 3);
  const middle = warp.markers[1]!;

  const pulled = moveMarker(warp, middle.id, 1.5);
  close(pulled.markers[1]?.beat ?? 0, 1.5, 'a legal drag lands where asked', 1e-9);

  const crossed = moveMarker(warp, middle.id, 9);
  const beat = crossed.markers[1]?.beat ?? 0;
  assert(beat < 3 && beat > 2.99, `clamped just under the next marker, got ${beat}`);

  const back = moveMarker(warp, middle.id, -5);
  const low = back.markers[1]?.beat ?? 0;
  assert(low > 1 && low < 1.01, `clamped just above the previous marker, got ${low}`);
});

check('markers can be removed and cleared', () => {
  resetIds();
  let warp: WarpConfig = { ...DEFAULT_WARP, enabled: true, markers: [] };
  warp = addMarker(warp, 1, 1);
  warp = addMarker(warp, 2, 2);
  const id = warp.markers[0]!.id;
  eq(removeMarker(warp, id).markers.length, 1, 'removed');
  eq(removeMarker(warp, 'nope'), warp, 'removing nothing changes nothing');
  const cleared = clearMarkers(warp);
  eq(cleared.markers.length, 0, 'cleared');
  eq(clearMarkers(cleared), cleared, 'clearing an empty warp returns the same object');
});

// ── Tempo detection and auto-warp ─────────────────────────────────────────────

check('tempo is estimated from onset spacing', () => {
  const beats: number[] = [];
  for (let i = 0; i < 16; i++) beats.push(i * 0.5);          // 120 BPM
  close(estimateBpm(beats) ?? 0, 120, 'straight 120', 0.5);

  const fast: number[] = [];
  for (let i = 0; i < 16; i++) fast.push(i * 0.3);            // 200 BPM
  const measured = estimateBpm(fast) ?? 0;
  // 200 is inside the 70–180 fold, so it reports the half-time 100.
  close(measured, 100, 'folded into the musical range', 0.5);
  eq(estimateBpm([0, 1]), null, 'too few onsets to guess');
});

check('auto-warp puts a marker on each hit and snaps it to the grid', () => {
  // 120 BPM eighths, but every second hit is 30 ms late.
  const sloppy: number[] = [];
  for (let i = 0; i < 8; i++) sloppy.push(i * 0.25 + (i % 2 === 1 ? 0.03 : 0));
  const warp = autoWarp(sloppy, 120, 0, 2, { gridBeats: 0.5 });

  assert(warp.enabled, 'auto-warp arms the clip');
  assert(warp.markers.length >= 8, `expected a marker per hit, got ${warp.markers.length}`);
  for (const m of warp.markers) {
    const snapped = Math.abs(m.beat / 0.5 - Math.round(m.beat / 0.5));
    close(snapped, 0, `beat ${m.beat} is off the grid`, 1e-9);
  }
  // The late hits keep their real source time — that is what gets corrected.
  const second = warp.markers.find((m) => Math.abs(m.beat - 0.5) < 1e-9);
  close(second?.sourceSec ?? 0, 0.28, 'the late hit is where the player put it', 1e-6);
});

check('auto-warp never emits two markers on one beat', () => {
  // A flam: two hits 8 ms apart both snap to the same sixteenth.
  const flam = [0, 0.008, 0.25, 0.5, 0.75, 1.0];
  const warp = autoWarp(flam, 120, 0, 1.5, { gridBeats: 0.25 });
  const beats = warp.markers.map((m) => m.beat);
  eq(new Set(beats).size, beats.length, 'duplicate beats would divide by zero');
});

// ── Validation ────────────────────────────────────────────────────────────────

check('validation catches reversed markers and extreme stretches', () => {
  const reversed: WarpConfig = {
    ...DEFAULT_WARP, enabled: true,
    markers: [createMarker(0, 0), createMarker(1, 4), createMarker(2, 2)],
  };
  const problems = validateWarp(reversed, 120);
  assert(problems.some((p) => p.severity === 'error'), 'a reversed marker is an error');

  // 4 source seconds crushed into a tenth of a beat — 80× is sound design.
  const extreme: WarpConfig = {
    ...DEFAULT_WARP, enabled: true,
    markers: [createMarker(0, 0), createMarker(4, 0.1)],
  };
  const warnings = validateWarp(extreme, 120);
  assert(warnings.some((p) => p.severity === 'warning'), `an 80× stretch should warn: ${JSON.stringify(warnings)}`);

  eq(validateWarp(warpFromBpm(120, 0, 4), 120).length, 0, 'a sane warp is clean');
  const bare: WarpConfig = { ...DEFAULT_WARP, enabled: true };
  assert(validateWarp(bare, 120).some((p) => p.message.includes('마커')), 'no markers is worth saying');
});

check('warp describes itself', () => {
  eq(describeWarp(null, 120), 'Warp off', 'off');
  const constant = warpFromBpm(120, 0, 4);
  eq(describeWarp(constant, 60), 'Warp · tones · 2.000× @ 60.0 BPM', 'constant ratio reads as a factor');
  const many: WarpConfig = {
    ...DEFAULT_WARP, enabled: true,
    markers: [createMarker(0, 0), createMarker(1, 1), createMarker(1.4, 2)],
  };
  assert(describeWarp(many, 120).includes('마커 3개'), 'a varying warp counts markers');
});

// ── Time stretch ──────────────────────────────────────────────────────────────

check('stretching to twice the length keeps the pitch', () => {
  const input = tone(440, 1.0);
  const outLength = input.length * 2;
  const stretched = stretchChannel(input, outLength, (out) => out / 2, modeOptions('tones', SR));

  eq(stretched.length, outLength, 'output length');
  close(measureHz(stretched.subarray(SR, SR * 1.5)), 440, 'pitch unchanged', 3);
  // Level is preserved: Hann at 50 % overlap sums to 1.
  close(rms(stretched.subarray(1000, outLength - 1000)), rms(input.subarray(1000, input.length - 1000)),
    'level preserved', 0.03);
});

check('compressing to half the length keeps the pitch', () => {
  const input = tone(330, 1.0);
  const outLength = Math.round(input.length / 2);
  const squeezed = stretchChannel(input, outLength, (out) => out * 2, modeOptions('tones', SR));
  eq(squeezed.length, outLength, 'output length');
  close(measureHz(squeezed.subarray(2000, outLength - 2000)), 330, 'pitch unchanged', 3);
});

check('ratio 1 is transparent', () => {
  const input = tone(440, 0.5);
  const same = stretchChannel(input, input.length, (out) => out, modeOptions('tones', SR));
  close(measureHz(same.subarray(2000, same.length - 2000)), 440, 'pitch', 1);
  close(rms(same.subarray(2000, same.length - 2000)), rms(input.subarray(2000, input.length - 2000)),
    'level', 0.01);
});

check('a stereo pair is stretched with ONE plan', () => {
  const left = tone(440, 0.5);
  const right = tone(440, 0.5, 0.25);           // same waveform, quieter
  const out = stretchChannels([left, right], left.length * 2, (o) => o / 2, modeOptions('tones', SR));
  eq(out.length, 2, 'two channels back');
  const l = out[0]!;
  const r = out[1]!;
  // Identical read positions ⇒ the channels stay exactly proportional.  If
  // each channel searched on its own they would drift apart and phase.
  let worst = 0;
  for (let i = 2000; i < l.length - 2000; i++) {
    worst = Math.max(worst, Math.abs((l[i] ?? 0) * 0.5 - (r[i] ?? 0)));
  }
  assert(worst < 1e-6, `channels drifted apart by ${worst}`);
});

check('each warp mode picks a different window', () => {
  const beats = modeOptions('beats', SR);
  const tones = modeOptions('tones', SR);
  const texture = modeOptions('texture', SR);
  const complex = modeOptions('complex', SR);
  assert(beats.windowSamples < tones.windowSamples, 'beats uses a shorter window');
  assert(texture.windowSamples > tones.windowSamples, 'texture uses a longer one');
  assert(!texture.similaritySearch, 'texture is plain overlap-add');
  assert(complex.searchSamples > tones.searchSamples, 'complex searches wider');
  for (const o of [beats, tones, texture, complex]) {
    eq(o.windowSamples % 2, 0, 'windows are even');
  }
});

check('a plan can be reused to render another channel', () => {
  const input = tone(440, 0.4);
  const plan = planStretch(input, input.length * 2, (o) => o / 2, modeOptions('tones', SR));
  const a = renderStretch(input, input.length * 2, plan);
  const b = renderStretch(input, input.length * 2, plan);
  for (let i = 0; i < a.length; i += 97) close(a[i] ?? 0, b[i] ?? 0, 'deterministic', 1e-12);
  eq(plan.hopSamples * 2, plan.windowSamples, '50 % overlap');
});

check('warping a click train moves the hits onto the new grid', () => {
  // Four hits at 0.5 s (120 BPM quarters).  Warp to 180 BPM → 0.333 s apart.
  const times = [0.1, 0.6, 1.1, 1.6];
  const input = clicks(times, 2.2);
  const warp = warpFromBpm(120, 0, 2.2);
  const map = buildWarpMap(warp, 180);
  const ratio = 120 / 180;
  const outLength = Math.round(input.length * ratio);
  const stretched = stretchChannel(
    input, outLength, (out) => destToSource(map, out / SR) * SR, modeOptions('beats', SR));

  const onsets = detectTransients(stretched, SR);
  assert(onsets.length >= 4, `expected 4 hits, found ${onsets.length}`);
  for (let i = 0; i < 4; i++) {
    const expected = (times[i] ?? 0) * ratio;
    const found = onsets[i] ?? -1;
    assert(Math.abs(found - expected) < 0.03,
      `hit ${i}: expected ${expected.toFixed(3)}s, found ${found.toFixed(3)}s`);
  }
});

// ── Clip rendering ────────────────────────────────────────────────────────────

function warpedClip(over: Partial<Clip> = {}): Clip {
  return createClip('file-1', 'loop', { offsetSec: 0, durationSec: 2, ...over });
}

check('renderWarpedClip returns null when the clip is not warped', () => {
  resetIds();
  eq(renderWarpedClip([tone(440, 2)], SR, warpedClip(), 120), null, 'no warp, no render');
  const off = warpedClip({ warp: { ...DEFAULT_WARP, enabled: false } });
  eq(renderWarpedClip([tone(440, 2)], SR, off, 120), null, 'disabled warp is the same as none');
});

check('a warped clip renders to its own length, starting at sample 0', () => {
  resetIds();
  const source = tone(440, 4);
  // 4 source seconds of 120 BPM material, played at 60 → 8 seconds.
  const warp = warpFromBpm(120, 0, 4);
  const clip = warpedClip({ warp, durationSec: 8 });
  const rendered = renderWarpedClip([source], SR, clip, 60);
  assert(rendered !== null, 'rendered');
  eq(rendered!.channels.length, 1, 'one channel');
  eq(rendered!.channels[0]!.length, Math.round(8 * SR), 'length matches the clip');
  close(measureHz(rendered!.channels[0]!.subarray(SR * 2, SR * 3)), 440, 'pitch held', 3);
});

check('a 1:1 warp is copied, not stretched', () => {
  resetIds();
  const source = tone(440, 4);
  const warp = warpFromBpm(120, 1, 2);          // markers at 1 s and 3 s
  const clip = warpedClip({ warp, offsetSec: 1, durationSec: 2 });
  const rendered = renderWarpedClip([source], SR, clip, 120)!;
  // Identity path: sample-exact copy from the source offset.
  const from = Math.round(1 * SR);
  let worst = 0;
  for (let i = 0; i < 1000; i++) {
    worst = Math.max(worst, Math.abs((rendered.channels[0]?.[i] ?? 0) - (source[from + i] ?? 0)));
  }
  assert(worst < 1e-7, `identity warp should copy verbatim, worst ${worst}`);
});

check('the render key changes with tempo but not with position', () => {
  resetIds();
  const warp = warpFromBpm(120, 0, 2);
  const clip = warpedClip({ warp });
  const key = warpKey(clip, 120);
  assert(key !== null, 'warped clips have a key');
  eq(warpKey({ ...clip, startSec: 99 }, 120), key, 'moving the clip does not re-render');
  eq(warpKey({ ...clip, gainDb: -6 }, 120), key, 'clip gain does not re-render');
  assert(warpKey(clip, 140) !== key, 'a tempo change does');
  assert(warpKey({ ...clip, warp: { ...warp, mode: 'beats' } }, 120) !== key, 'so does the mode');
  // A clip pinned to its own tempo ignores the session's.
  const fixed = warpedClip({ warp: { ...warp, followTempo: false } });
  eq(warpKey(fixed, 140), warpKey(fixed, 90), 'a non-following clip has one key');
});

check('warpedDuration and clipSourceSpan agree with the map', () => {
  const warp = warpFromBpm(120, 0, 4);
  close(warpedDuration(warp, 60, 4), 8, 'half tempo doubles the length', 1e-9);
  close(warpedDuration(warp, 120, 4), 4, 'same tempo keeps it', 1e-9);
  const clip = createClip('f', 'c', { offsetSec: 0, durationSec: 8, warp });
  const span = clipSourceSpan(clip, 60);
  close(span.fromSec, 0, 'span starts at the offset', 1e-9);
  close(span.toSec, 4, 'and consumes 4 source seconds', 1e-6);
});

// ── Tempo change ──────────────────────────────────────────────────────────────

function sessionWith(clips: Clip[]): { session: DawSession; trackId: string } {
  resetIds();
  const base = createSession('warp test');
  const track = createTrack('Audio 1', 'audio');
  const session = updateClips(addTrack(base, track), track.id, () => clips);
  return { session, trackId: track.id };
}

check('halving the tempo doubles a warped clip and moves the arrangement', () => {
  const warp = warpFromBpm(120, 0, 2);
  const clip = createClip('f', 'loop', { startSec: 4, durationSec: 2, warp });
  const { session, trackId } = sessionWith([clip]);
  eq(session.tempoBpm, 120, 'starts at 120');

  const { session: slower, unwarpedClipIds } = setSessionTempo(session, 60);
  eq(slower.tempoBpm, 60, 'tempo written');
  eq(unwarpedClipIds.length, 0, 'the warped clip followed');
  const moved = trackClips(findTrack(slower, trackId)!)[0]!;
  close(moved.startSec, 8, 'bar position preserved', 1e-9);
  close(moved.durationSec, 4, 'and the clip stretched', 1e-9);
});

check('an unwarped clip moves but cannot stretch, and says so', () => {
  const clip = createClip('f', 'vocal', { startSec: 4, durationSec: 2 });
  const { session, trackId } = sessionWith([clip]);
  const { session: slower, unwarpedClipIds } = setSessionTempo(session, 60);
  eq(unwarpedClipIds.length, 1, 'reported');
  eq(unwarpedClipIds[0], clip.id, 'the right clip');
  const moved = trackClips(findTrack(slower, trackId)!)[0]!;
  close(moved.startSec, 8, 'position is musical', 1e-9);
  close(moved.durationSec, 2, 'length is not', 1e-9);
});

check('a clip pinned to its own tempo does not stretch', () => {
  const warp: WarpConfig = { ...warpFromBpm(120, 0, 2), followTempo: false };
  const clip = createClip('f', 'oneshot', { startSec: 0, durationSec: 2, warp });
  const { session, trackId } = sessionWith([clip]);
  const { session: slower, unwarpedClipIds } = setSessionTempo(session, 60);
  eq(unwarpedClipIds.length, 1, 'a pinned clip is reported like an unwarped one');
  close(trackClips(findTrack(slower, trackId)!)[0]!.durationSec, 2, 'length held', 1e-9);
  close(resolveBpm(warp, 60), 120, 'and it still resolves at its own tempo', 1e-9);
});

check('MIDI parts follow the tempo, notes and all', () => {
  const part = createMidiPart('part', {
    startSec: 2, durationSec: 4,
    notes: [{
      id: 'n1', pitch: 60, pitchOffsetSemitones: 0, startSec: 1, durationSec: 0.5,
      velocity: 0.8, releaseVelocity: 0.5, channel: 0, muted: false,
      expression: [], articulation: null, playProbability: 1,
    }],
  });
  const { session, trackId } = sessionWith([part]);
  const { session: slower } = setSessionTempo(session, 60);
  const moved = trackClips(findTrack(slower, trackId)!)[0]!;
  close(moved.startSec, 4, 'part moved', 1e-9);
  close(moved.durationSec, 8, 'part stretched', 1e-9);
  close(moved.notes[0]?.startSec ?? 0, 2, 'note moved', 1e-9);
  close(moved.notes[0]?.durationSec ?? 0, 1, 'note stretched', 1e-9);
});

check('setting the same tempo changes nothing but is still safe', () => {
  const { session } = sessionWith([createClip('f', 'c', { startSec: 3, durationSec: 1 })]);
  const { session: same, unwarpedClipIds } = setSessionTempo(session, 120);
  eq(same.tempoBpm, 120, 'tempo held');
  eq(unwarpedClipIds.length, 0, 'nothing to report');
  const clamped = setSessionTempo(session, 5000).session;
  assert(clamped.tempoBpm <= 300, `tempo clamped, got ${clamped.tempoBpm}`);
});

check('retimeClip only touches clips that follow', () => {
  const warp = warpFromBpm(120, 0, 2);
  const following = createClip('f', 'a', { durationSec: 2, warp });
  close(retimeClip(following, 120, 60).durationSec, 4, 'followed', 1e-9);
  const plain = createClip('f', 'b', { durationSec: 2 });
  eq(retimeClip(plain, 120, 60), plain, 'untouched');
  eq(clipWarp(plain), null, 'and reports no warp');
  close(beatSeconds(120), 0.5, 'a beat at 120 BPM', 1e-12);
});

// ── The whole path: session → engine → rendered audio ─────────────────────────

/** Every check below is async, so they run in sequence and report at the end. */
async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); results.push({ name, pass: true, detail: '' }); }
  catch (e) { results.push({ name, pass: false, detail: e instanceof Error ? e.message : String(e) }); }
}

function bufferOf(channels: Float32Array[], sampleRate = SR): AudioBuffer {
  const ctx = new OfflineAudioContext(channels.length, channels[0]?.length ?? 1, sampleRate);
  const buffer = ctx.createBuffer(channels.length, channels[0]?.length ?? 1, sampleRate);
  for (let c = 0; c < channels.length; c++) buffer.getChannelData(c).set(channels[c] ?? new Float32Array(0));
  return buffer;
}

async function runEngineChecks(): Promise<void> {
await checkAsync('a warped clip renders through the real engine, stretched and in tune', async () => {
  resetIds();
  clearAudioCache();
  clearWarpCache();

  const source = tone(440, 4);
  const buffer = bufferOf([source]);

  const base = createSession('warp render');
  const track = createTrack('Loop', 'audio');
  // 4 source seconds of 120 BPM material, played by a 60 BPM session → 8 s.
  const warp = warpFromBpm(120, 0, 4);
  const clip = createClip('file-warp', 'loop', { startSec: 0, offsetSec: 0, durationSec: 8, warp });

  const withFile = addFile(base, {
    id: 'file-warp', path: '/virtual/loop.wav', name: 'loop.wav',
    durationSec: 4, sampleRate: SR, channels: 1,
  });
  analyzeBuffer('file-warp', buffer);
  const session: DawSession = {
    ...updateClips(addTrack(withFile, track), track.id, () => [clip]),
    tempoBpm: 60,
    sampleRate: SR,
  };

  const rendered = await renderSession(session, { startSec: 0, endSec: 8 }, { tailSec: 0 });
  const out = rendered.getChannelData(0);
  eq(rendered.sampleRate, SR, 'rendered at the session rate');

  // Second 6 is past the end of the SOURCE — it only exists because the clip
  // was stretched.  If warp were ignored the clip would have run out at 4 s.
  const late = out.subarray(Math.round(6 * SR), Math.round(6.5 * SR));
  assert(rms(late) > 0.05, `the stretched tail should still be sounding, rms ${rms(late)}`);
  close(measureHz(late), 440, 'and still be 440 Hz', 4);
});

await checkAsync('the warped buffer is cached and reused', async () => {
  resetIds();
  clearAudioCache();
  clearWarpCache();

  const buffer = bufferOf([tone(440, 4)]);
  analyzeBuffer('file-cache', buffer);
  const warp = warpFromBpm(120, 0, 4);
  const clip = createClip('file-cache', 'loop', { offsetSec: 0, durationSec: 8, warp });
  const ctx = new OfflineAudioContext(1, 128, SR);

  const first = ensureWarpedBuffer(ctx, clip, 60);
  assert(first !== null, 'rendered');
  eq(first!.length, Math.round(8 * SR), 'stretched to the clip length');
  eq(ensureWarpedBuffer(ctx, clip, 60), first, 'a second call hits the cache');
  assert(ensureWarpedBuffer(ctx, clip, 90) !== first, 'a tempo change renders again');

  clearAudioCache();
  clearWarpCache();
  eq(ensureWarpedBuffer(ctx, clip, 60), null, 'with no decoded source there is nothing to render');
});

}

void runEngineChecks().then(() => {
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log('\n=== Warp: markers · tempo map · time stretch ===');
  for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
  if (failed > 0) process.exit(1);
});
