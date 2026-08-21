/**
 * spectral-selftest — Spectral Editing + Mastering Reference System.
 *
 * The two claims that have to hold:
 *
 *   Spectral editing is surgical.  Attenuating a click's band kills the click
 *   and leaves the note underneath it playing.  Anything outside the box comes
 *   back bit-for-bit, because the STFT is invertible.
 *
 *   The reference comparison is level-blind.  A quieter mix is not a darker
 *   mix; only LUFS should move when you turn a track down.
 *
 * Run: pnpm --filter @aimaster/desktop test:spectral
 */

import { fft, hannWindow, nextPow2, isPow2, magnitude } from '../src/renderer/daw/audio/fft.js';
import {
  stft, istft, binToHz, hzToBin, frameToSec, secToFrame, frameMagnitude,
  framePhase, setBin, scaleBin, frameMagnitudes, regionEnergy, binCount,
} from '../src/renderer/daw/audio/stft.js';
import {
  applySpectralEdit, applySpectralEditChannels, editSpectrogram, regionBounds,
  spectrogramGrid, findAnomalies, describeSpectralEdit,
  type SpectralRegion,
} from '../src/renderer/daw/audio/spectral-edit.js';
import {
  averageSpectrum, bandLevelDb, analyzeForReference, compareToReference,
  matchSuggestions, spectrumDelta, correlationOf, widthFromCorrelation,
  stereoBands, formatMetric, TONAL_BANDS,
} from '../src/renderer/daw/analysis/reference.js';
import type { AudioBufferLike } from '../src/renderer/audio/loudnessCore.js';

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

/** Narrow-band burst — a "click" that lives in one part of the spectrum. */
function burst(
  base: Float32Array, atSec: number, hz: number, amp: number, ms = 8, sampleRate = SR,
): Float32Array {
  const out = Float32Array.from(base);
  const start = Math.round(atSec * sampleRate);
  const len = Math.round((ms / 1000) * sampleRate);
  for (let i = 0; i < len; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / len);
    const index = start + i;
    if (index >= out.length) break;
    out[index] = (out[index] ?? 0) + amp * w * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  }
  return out;
}

/** Goertzel: energy at one frequency, so the tests measure and not guess. */
function toneLevel(x: Float32Array, hz: number, sampleRate = SR): number {
  const n = x.length;
  const k = (2 * Math.PI * hz) / sampleRate;
  const coeff = 2 * Math.cos(k);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    const s0 = (x[i] ?? 0) + coeff * s1 - s2;
    s2 = s1; s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return Math.sqrt(Math.max(0, power)) / (n / 2);
}

function rms(x: ArrayLike<number>, from = 0, to = x.length): number {
  let sum = 0;
  let n = 0;
  for (let i = Math.max(0, from); i < Math.min(x.length, to); i++) { sum += (x[i] ?? 0) ** 2; n++; }
  return n > 0 ? Math.sqrt(sum / n) : 0;
}

function bufferOf(channels: Float32Array[], sampleRate = SR): AudioBufferLike {
  return {
    sampleRate,
    numberOfChannels: channels.length,
    length: channels[0]?.length ?? 0,
    getChannelData: (c: number) => channels[c] ?? channels[0] ?? new Float32Array(0),
  };
}

// ── FFT ───────────────────────────────────────────────────────────────────────

check('the FFT finds a tone in the bin it belongs to', () => {
  const size = 1024;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const bin = 64;                                    // exactly on a bin, no leakage
  for (let i = 0; i < size; i++) re[i] = Math.sin((2 * Math.PI * bin * i) / size);
  fft(re, im, false);
  let best = 0;
  let bestMag = 0;
  for (let b = 1; b < size / 2; b++) {
    const m = magnitude(re[b] ?? 0, im[b] ?? 0);
    if (m > bestMag) { bestMag = m; best = b; }
  }
  eq(best, bin, 'peak bin');
  close(bestMag, size / 2, 'peak magnitude is N/2 for unit amplitude', 1e-6);
});

check('forward then inverse FFT returns the original samples', () => {
  const size = 256;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const original: number[] = [];
  for (let i = 0; i < size; i++) {
    const v = Math.sin(i * 0.31) * 0.4 + Math.cos(i * 1.7) * 0.2;
    re[i] = v;
    original.push(v);
  }
  fft(re, im, false);
  fft(re, im, true);
  let worst = 0;
  for (let i = 0; i < size; i++) worst = Math.max(worst, Math.abs((re[i] ?? 0) - (original[i] ?? 0)));
  assert(worst < 1e-12, `round trip error ${worst}`);
});

check('nextPow2 and isPow2 agree', () => {
  eq(nextPow2(1000), 1024, 'rounds up');
  eq(nextPow2(1024), 1024, 'already a power of two');
  assert(isPow2(2048), '2048 is');
  assert(!isPow2(2000), '2000 is not');
  const w = hannWindow(8);
  close(w[0] ?? -1, 0, 'periodic Hann starts at zero', 1e-12);
  close(w[4] ?? -1, 1, 'and peaks in the middle', 1e-12);
});

// ── STFT ──────────────────────────────────────────────────────────────────────

check('an untouched STFT round trip is transparent', () => {
  const x = tone(440, 0.3);
  const spec = stft(x, SR, { fftSize: 1024, hopSize: 256 });
  const back = istft(spec);
  eq(back.length, x.length, 'same length');
  let worst = 0;
  for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs((back[i] ?? 0) - (x[i] ?? 0)));
  assert(worst < 1e-5, `round trip error ${worst} — the transform is not invertible`);
});

check('bin and frame coordinates convert both ways', () => {
  close(binToHz(hzToBin(1000, 2048, SR), 2048, SR), 1000, 'Hz → bin → Hz', 1e-9);
  close(frameToSec(secToFrame(0.5, 512, SR), 512, SR), 0.5, 'sec → frame → sec', 1e-9);
  eq(binCount(2048), 1025, 'bin count includes DC and Nyquist');
});

check('a tone shows up in the right STFT bin', () => {
  const spec = stft(tone(1000, 0.2), SR, { fftSize: 2048, hopSize: 512 });
  const frame = spec.frames[Math.floor(spec.frames.length / 2)]!;
  const mags = frameMagnitudes(frame, spec.fftSize);
  let best = 0;
  let bestMag = 0;
  for (let b = 1; b < mags.length; b++) {
    if ((mags[b] ?? 0) > bestMag) { bestMag = mags[b] ?? 0; best = b; }
  }
  const hz = binToHz(best, spec.fftSize, SR);
  assert(Math.abs(hz - 1000) < SR / 2048, `peak at ${hz} Hz`);
});

check('setBin and scaleBin keep the inverse real', () => {
  const spec = stft(tone(500, 0.1), SR, { fftSize: 512, hopSize: 128 });
  const frame = spec.frames[3]!;
  const bin = 20;
  setBin(frame, bin, 5, 0.7, spec.fftSize);
  close(frameMagnitude(frame, bin), 5, 'magnitude written', 1e-9);
  close(framePhase(frame, bin), 0.7, 'phase written', 1e-9);
  // Conjugate symmetry: the mirror bin must be the complex conjugate.
  const mirror = spec.fftSize - bin;
  close(frame[mirror * 2] ?? 0, frame[bin * 2] ?? 0, 'mirror real part matches', 1e-12);
  close(frame[mirror * 2 + 1] ?? 0, -(frame[bin * 2 + 1] ?? 0), 'mirror imaginary is negated', 1e-12);
  scaleBin(frame, bin, 0.5, spec.fftSize);
  close(frameMagnitude(frame, bin), 2.5, 'scaled', 1e-9);
});

// ── Spectral editing ──────────────────────────────────────────────────────────

const CLICK_HZ = 5000;
const NOTE_HZ = 440;

check('attenuating the click band kills the click and keeps the note', () => {
  const clean = tone(NOTE_HZ, 1.0, 0.5);
  const dirty = burst(clean, 0.5, CLICK_HZ, 0.6);
  const region: SpectralRegion = { startSec: 0.49, endSec: 0.52, lowHz: 3500, highHz: 7000 };

  const before = toneLevel(dirty.subarray(Math.round(0.49 * SR), Math.round(0.52 * SR)), CLICK_HZ);
  const fixed = applySpectralEdit(dirty, SR, region, { kind: 'attenuate', gainDb: -60 });
  const after = toneLevel(fixed.subarray(Math.round(0.49 * SR), Math.round(0.52 * SR)), CLICK_HZ);

  assert(after < before * 0.15, `click ${before} → ${after} (not attenuated enough)`);
  const note = toneLevel(fixed, NOTE_HZ);
  close(note, 0.5, 'the 440 Hz note survives untouched', 0.01);
});

check('samples outside the box are untouched', () => {
  const dirty = burst(tone(NOTE_HZ, 1.0, 0.5), 0.5, CLICK_HZ, 0.6);
  const fixed = applySpectralEdit(dirty, SR, {
    startSec: 0.49, endSec: 0.52, lowHz: 3500, highHz: 7000,
  }, { kind: 'attenuate', gainDb: -60 });

  // A quarter of a second away from the edit, nothing may have moved.
  let worst = 0;
  for (let i = 0; i < Math.round(0.2 * SR); i++) {
    worst = Math.max(worst, Math.abs((fixed[i] ?? 0) - (dirty[i] ?? 0)));
  }
  assert(worst < 1e-6, `distant samples drifted by ${worst}`);
  eq(fixed.length, dirty.length, 'length preserved');
  assert(fixed !== dirty, 'the edit returns a new buffer');
});

check('repair rebuilds the box from its neighbours', () => {
  const clean = tone(NOTE_HZ, 1.0, 0.5);
  const dirty = burst(clean, 0.5, CLICK_HZ, 0.6);
  const region: SpectralRegion = { startSec: 0.49, endSec: 0.52, lowHz: 3500, highHz: 7000 };
  const fixed = applySpectralEdit(dirty, SR, region, { kind: 'repair' });

  const from = Math.round(0.49 * SR);
  const to = Math.round(0.52 * SR);
  const before = toneLevel(dirty.subarray(from, to), CLICK_HZ);
  const after = toneLevel(fixed.subarray(from, to), CLICK_HZ);
  assert(after < before * 0.2, `click ${before} → ${after}`);
  // The neighbours are near-silent up there, so repair should land near silence
  // rather than just turning the click down a bit.
  close(toneLevel(fixed, NOTE_HZ), 0.5, 'note intact', 0.01);
});

check('replace pastes a band from another moment', () => {
  // 0–0.5 s: 440 Hz only.  0.5–1.0 s: 440 Hz plus a 5 kHz tone.
  const base = tone(NOTE_HZ, 1.0, 0.5);
  const withHigh = Float32Array.from(base);
  for (let i = Math.round(0.5 * SR); i < withHigh.length; i++) {
    withHigh[i] = (withHigh[i] ?? 0) + 0.3 * Math.sin((2 * Math.PI * CLICK_HZ * i) / SR);
  }
  // Take the quiet 5 kHz band from 0.2 s and paste it over 0.7 s.
  const fixed = applySpectralEdit(withHigh, SR, {
    startSec: 0.7, endSec: 0.75, lowHz: 4000, highHz: 6000,
  }, { kind: 'replace', sourceSec: 0.2 });

  const from = Math.round(0.71 * SR);
  const to = Math.round(0.74 * SR);
  const before = toneLevel(withHigh.subarray(from, to), CLICK_HZ);
  const after = toneLevel(fixed.subarray(from, to), CLICK_HZ);
  assert(after < before * 0.4, `pasted band should be quiet: ${before} → ${after}`);
  close(toneLevel(fixed, NOTE_HZ), 0.5, 'the note under the paste is untouched', 0.02);
});

check('amount dials an edit back', () => {
  const dirty = burst(tone(NOTE_HZ, 1.0, 0.5), 0.5, CLICK_HZ, 0.6);
  const region: SpectralRegion = { startSec: 0.49, endSec: 0.52, lowHz: 3500, highHz: 7000 };
  const from = Math.round(0.49 * SR);
  const to = Math.round(0.52 * SR);
  const full = toneLevel(
    applySpectralEdit(dirty, SR, region, { kind: 'attenuate', gainDb: -40 }).subarray(from, to), CLICK_HZ);
  const half = toneLevel(
    applySpectralEdit(dirty, SR, region, { kind: 'attenuate', gainDb: -40 }, { amount: 0.5 }).subarray(from, to), CLICK_HZ);
  const none = toneLevel(
    applySpectralEdit(dirty, SR, region, { kind: 'attenuate', gainDb: -40 }, { amount: 0 }).subarray(from, to), CLICK_HZ);
  const original = toneLevel(dirty.subarray(from, to), CLICK_HZ);
  assert(full < half && half < none, `monotonic: ${full} < ${half} < ${none}`);
  close(none, original, 'amount 0 is a no-op', 1e-6);
});

check('feathering avoids a hard edge at the box border', () => {
  const dirty = burst(tone(NOTE_HZ, 1.0, 0.5), 0.5, CLICK_HZ, 0.6);
  const region: SpectralRegion = { startSec: 0.49, endSec: 0.52, lowHz: 3500, highHz: 7000 };
  const feathered = applySpectralEdit(dirty, SR, region, { kind: 'attenuate', gainDb: -60 });
  // Sample-to-sample jumps in the edited zone must stay in the range a
  // 5 kHz-limited signal can produce; a hard spectral edge shows up as a step.
  let worstStep = 0;
  for (let i = Math.round(0.45 * SR); i < Math.round(0.56 * SR); i++) {
    worstStep = Math.max(worstStep, Math.abs((feathered[i] ?? 0) - (feathered[i - 1] ?? 0)));
  }
  assert(worstStep < 0.1, `discontinuity of ${worstStep} at the seam`);
});

check('regionBounds clamps to the spectrogram', () => {
  const spec = stft(tone(440, 0.2), SR, { fftSize: 1024, hopSize: 256 });
  const bounds = regionBounds(spec, { startSec: -1, endSec: 99, lowHz: -100, highHz: 1e6 });
  eq(bounds.fromFrame, 0, 'clamped start');
  eq(bounds.toFrame, spec.frames.length - 1, 'clamped end');
  eq(bounds.lowBin, 0, 'clamped low bin');
  eq(bounds.highBin, binCount(spec.fftSize) - 1, 'clamped high bin');
  // Reversed drags are normalised.
  const flipped = regionBounds(spec, { startSec: 0.1, endSec: 0.05, lowHz: 900, highHz: 300 });
  assert(flipped.fromFrame <= flipped.toFrame, 'time normalised');
  assert(flipped.lowBin <= flipped.highBin, 'frequency normalised');
});

check('editSpectrogram drops energy inside the box only', () => {
  const spec = stft(burst(tone(NOTE_HZ, 1.0, 0.5), 0.5, CLICK_HZ, 0.6), SR, { fftSize: 2048, hopSize: 512 });
  const region: SpectralRegion = { startSec: 0.49, endSec: 0.52, lowHz: 3500, highHz: 7000 };
  const box = regionBounds(spec, region);
  const noteLowBin = Math.floor(hzToBin(400, spec.fftSize, SR));
  const noteHighBin = Math.ceil(hzToBin(480, spec.fftSize, SR));

  const clickBefore = regionEnergy(spec, box.fromFrame, box.toFrame + 1, box.lowBin, box.highBin);
  const noteBefore = regionEnergy(spec, box.fromFrame, box.toFrame + 1, noteLowBin, noteHighBin);
  editSpectrogram(spec, region, { kind: 'attenuate', gainDb: -60 });
  const clickAfter = regionEnergy(spec, box.fromFrame, box.toFrame + 1, box.lowBin, box.highBin);
  const noteAfter = regionEnergy(spec, box.fromFrame, box.toFrame + 1, noteLowBin, noteHighBin);

  assert(clickAfter < clickBefore * 0.05, `box energy ${clickBefore} → ${clickAfter}`);
  close(noteAfter / noteBefore, 1, 'the note band is untouched', 1e-6);
});

check('stereo edits apply to every channel', () => {
  const dirty = burst(tone(NOTE_HZ, 0.5, 0.5), 0.25, CLICK_HZ, 0.6);
  const [l, r] = applySpectralEditChannels([dirty, dirty], SR, {
    startSec: 0.24, endSec: 0.27, lowHz: 3500, highHz: 7000,
  }, { kind: 'attenuate', gainDb: -60 });
  assert(!!l && !!r, 'two channels back');
  const from = Math.round(0.24 * SR);
  const to = Math.round(0.27 * SR);
  close(toneLevel(l!.subarray(from, to), CLICK_HZ), toneLevel(r!.subarray(from, to), CLICK_HZ),
    'both channels edited identically', 1e-9);
});

check('the anomaly finder points at the click', () => {
  const dirty = burst(tone(NOTE_HZ, 1.0, 0.4), 0.5, 6000, 0.7, 4);
  const spec = stft(dirty, SR, { fftSize: 1024, hopSize: 256 });
  const hits = findAnomalies(spec);
  assert(hits.length > 0, 'found nothing');
  const top = hits[0]!;
  assert(Math.abs(top.startSec - 0.5) < 0.05, `top hit at ${top.startSec}s, expected ~0.5s`);
  assert(top.strength > 4, `weak hit: ${top.strength}`);
  // A clean tone has nothing to report.
  eq(findAnomalies(stft(tone(NOTE_HZ, 1.0, 0.4), SR, { fftSize: 1024, hopSize: 256 })).length, 0,
    'clean audio reports no clicks');
});

check('the drawing grid is normalised and oriented bin-major', () => {
  const spec = stft(tone(1000, 0.3, 1.0), SR, { fftSize: 1024, hopSize: 256 });
  const grid = spectrogramGrid(spec, -96, 0);
  eq(grid.width, spec.frames.length, 'one column per frame');
  eq(grid.height, binCount(spec.fftSize), 'one row per bin');
  let min = 1, max = 0;
  for (let i = 0; i < grid.data.length; i++) {
    const v = grid.data[i] ?? 0;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  assert(min >= 0 && max <= 1, `grid out of range: ${min}…${max}`);
  assert(max > 0.9, `a full-scale tone should read near the top: ${max}`);
});

check('edits describe themselves for the history list', () => {
  const region: SpectralRegion = { startSec: 0.49, endSec: 0.52, lowHz: 3500, highHz: 7000 };
  eq(describeSpectralEdit(region, { kind: 'attenuate', gainDb: -12 }),
    'Attenuate -12.0 dB · 30 ms × 3500–7000 Hz', 'attenuate');
  eq(describeSpectralEdit(region, { kind: 'repair' }),
    'Repair · 30 ms × 3500–7000 Hz', 'repair');
  eq(describeSpectralEdit(region, { kind: 'replace', sourceSec: 0.2 }),
    'Replace from 0.200 s · 30 ms × 3500–7000 Hz', 'replace');
});

// ── Reference system ──────────────────────────────────────────────────────────

/** Pink-ish noise so the analyses have something musical to chew on. */
function noise(seconds: number, tilt = 0, seed = 1, sampleRate = SR): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  let s = seed >>> 0;
  const rand = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
  // One-pole tilt: positive brightens, negative darkens.
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const white = rand();
    lp += 0.05 * (white - lp);
    out[i] = 0.3 * (lp * (1 - tilt) + white * (0.3 + tilt));
  }
  return out;
}

check('the average spectrum is level-normalised', () => {
  const x = noise(1.0);
  const quiet = Float32Array.from(x, (v) => v * 0.25);      // −12 dB
  const a = averageSpectrum(x, SR);
  const b = averageSpectrum(quiet, SR);
  let worst = 0;
  for (let i = 0; i < a.db.length; i++) worst = Math.max(worst, Math.abs((a.db[i] ?? 0) - (b.db[i] ?? 0)));
  assert(worst < 0.05, `turning the track down changed the tonal curve by ${worst} dB`);
});

check('a bright signal reads brighter than a dark one', () => {
  const dark = averageSpectrum(noise(1.0, -0.2, 7), SR);
  const bright = averageSpectrum(noise(1.0, 0.6, 7), SR);
  const darkHigh = bandLevelDb(dark, TONAL_BANDS.high.lowHz, TONAL_BANDS.high.highHz);
  const brightHigh = bandLevelDb(bright, TONAL_BANDS.high.lowHz, TONAL_BANDS.high.highHz);
  assert(brightHigh > darkHigh + 3, `high band ${darkHigh} vs ${brightHigh}`);
});

check('correlation maps onto width the way the meter reads it', () => {
  const x = noise(0.5, 0, 11);
  close(correlationOf(x, x), 1, 'identical channels are mono', 1e-6);
  close(widthFromCorrelation(1), 0, 'mono is 0 %', 1e-9);
  close(widthFromCorrelation(0), 100, 'decorrelated is 100 %', 1e-9);
  close(widthFromCorrelation(-1), 200, 'out of phase is 200 %', 1e-9);
  const inverted = Float32Array.from(x, (v) => -v);
  close(correlationOf(x, inverted), -1, 'polarity flip', 1e-6);
});

check('per-band width follows the side content', () => {
  const mid = noise(1.0, 0, 3);
  const side = noise(1.0, 0.8, 4);              // sides only up high
  const left = new Float32Array(mid.length);
  const right = new Float32Array(mid.length);
  for (let i = 0; i < mid.length; i++) {
    left[i] = (mid[i] ?? 0) + (side[i] ?? 0);
    right[i] = (mid[i] ?? 0) - (side[i] ?? 0);
  }
  const bands = stereoBands(left, right, SR, 8);
  eq(bands.length, 8, 'eight bands');
  const low = bands[0]!;
  const high = bands[bands.length - 1]!;
  assert(high.widthPercent > low.widthPercent, `high ${high.widthPercent}% should beat low ${low.widthPercent}%`);
  for (const b of bands) {
    assert(b.correlation >= -1.0001 && b.correlation <= 1.0001, `correlation out of range: ${b.correlation}`);
  }
});

check('a mix and its own reference score a perfect match', () => {
  const l = noise(2.0, 0.1, 21);
  const r = noise(2.0, 0.1, 22);
  const analysis = analyzeForReference(bufferOf([l, r]), 'REFERENCE');
  const same = analyzeForReference(bufferOf([l, r]), 'YOUR MIX');
  const cmp = compareToReference(analysis, same);
  eq(cmp.rows.length, 7, 'LUFS / TP / DR / WIDTH / LOW / MID / HIGH');
  for (const row of cmp.rows) eq(row.verdict, 'match', `${row.label} should match itself`);
  eq(cmp.score, 100, 'perfect score');
  eq(matchSuggestions(cmp).length, 0, 'nothing to suggest');
});

check('turning a mix down moves LUFS and TP, not the tonal rows', () => {
  const l = noise(2.0, 0.1, 31);
  const r = noise(2.0, 0.1, 32);
  const reference = analyzeForReference(bufferOf([l, r]), 'REFERENCE');
  const quiet = analyzeForReference(
    bufferOf([Float32Array.from(l, (v) => v * 0.5), Float32Array.from(r, (v) => v * 0.5)]), 'YOUR MIX');
  const cmp = compareToReference(reference, quiet);
  const row = (id: string): number => cmp.rows.find((x) => x.id === id)!.delta;

  close(row('lufs'), -6.02, 'half amplitude is −6 LU', 0.05);
  close(row('tp'), -6.02, 'true peak follows', 0.05);
  close(row('dr'), 0, 'dynamics unchanged by a gain move', 0.05);
  close(row('low'), 0, 'LOW unchanged', 0.05);
  close(row('mid'), 0, 'MID unchanged', 0.05);
  close(row('high'), 0, 'HIGH unchanged', 0.05);
  close(row('width'), 0, 'width unchanged', 0.5);
});

check('a dark mix against a bright reference reports HIGH under', () => {
  const bright = noise(2.0, 0.7, 41);
  const dark = noise(2.0, -0.2, 41);
  const cmp = compareToReference(
    analyzeForReference(bufferOf([bright, bright]), 'REFERENCE'),
    analyzeForReference(bufferOf([dark, dark]), 'YOUR MIX'),
  );
  const high = cmp.rows.find((r) => r.id === 'high')!;
  eq(high.verdict, 'under', `HIGH delta ${high.delta}`);
  assert(high.delta < -1, `expected a real deficit, got ${high.delta}`);
  assert(cmp.score < 100, 'score should drop');

  const advice = matchSuggestions(cmp).find((s) => s.metric === 'high');
  assert(!!advice, 'no advice for the high band');
  assert(advice!.text.startsWith('Add'), `expected an "Add" suggestion, got: ${advice!.text}`);
  assert(advice!.amount > 0, 'the correction should be positive');
});

check('the reference table reads like the spec sheet', () => {
  const x = noise(2.0, 0.1, 51);
  const cmp = compareToReference(
    analyzeForReference(bufferOf([x, x]), 'REFERENCE'),
    analyzeForReference(bufferOf([Float32Array.from(x, (v) => v * 0.5)]), 'YOUR MIX'),
  );
  eq(cmp.rows.map((r) => r.label).join(' '), 'LUFS TP DR WIDTH LOW MID HIGH', 'row order');
  const low = cmp.rows.find((r) => r.id === 'low')!;
  eq(low.reference, 0, 'the reference is +0 on tonal rows by definition');
  eq(formatMetric(low, 0), '+0.0', 'tonal rows carry a sign');
  eq(formatMetric(cmp.rows[3]!, 118.4), '118 %', 'width is a whole percent');
  eq(formatMetric(cmp.rows[0]!, -8.7), '-8.7', 'LUFS keeps one decimal');
  eq(formatMetric(cmp.rows[0]!, -Infinity), '—', 'silence has no number');
});

check('DR is the peak-to-loudness ratio, and compression shrinks it', () => {
  const x = noise(2.0, 0.1, 61);
  const open = analyzeForReference(bufferOf([x, x]), 'OPEN');
  // Hard clip: peaks come down, loudness stays — DR must fall.
  const squashed = Float32Array.from(x, (v) => Math.max(-0.05, Math.min(0.05, v)));
  const loud = analyzeForReference(bufferOf([squashed, squashed]), 'SQUASHED');
  close(open.dr, open.truePeakDbtp - open.integratedLufs, 'DR is TP − LUFS', 1e-9);
  assert(loud.dr < open.dr - 1, `clipping should cut DR: ${open.dr} → ${loud.dr}`);
});

check('the overlay curves line up bin for bin', () => {
  const a = averageSpectrum(noise(1.0, 0.5, 71), SR);
  const b = averageSpectrum(noise(1.0, -0.1, 72), SR);
  const delta = spectrumDelta(a, b);
  eq(delta.hz.length, a.hz.length, 'same band count');
  close(delta.db[10] ?? 0, (b.db[10] ?? 0) - (a.db[10] ?? 0), 'delta is mix − reference', 1e-6);
  const self = spectrumDelta(a, a);
  for (let i = 0; i < self.db.length; i++) close(self.db[i] ?? 1, 0, 'a curve against itself is flat', 1e-9);
});

check('the short-term series tracks the arrangement', () => {
  // Two seconds quiet, two seconds loud.
  const x = new Float32Array(SR * 4);
  for (let i = 0; i < x.length; i++) {
    const amp = i < SR * 2 ? 0.05 : 0.5;
    x[i] = amp * Math.sin((2 * Math.PI * 440 * i) / SR);
  }
  const analysis = analyzeForReference(bufferOf([x, x]), 'RAMP');
  assert(analysis.shortTerm.length > 20, `expected a series, got ${analysis.shortTerm.length}`);
  const early = analysis.shortTerm[Math.floor(analysis.shortTerm.length * 0.3)] ?? 0;
  const late = analysis.shortTerm[analysis.shortTerm.length - 1] ?? 0;
  assert(late > early + 10, `loud section should read higher: ${early} → ${late}`);
});

check('mono input still analyses', () => {
  const x = noise(1.0, 0, 81);
  const analysis = analyzeForReference(bufferOf([x]), 'MONO');
  eq(analysis.channels, 1, 'one channel');
  close(analysis.correlation, 1, 'mono correlates perfectly', 1e-9);
  close(analysis.widthPercent, 0, 'and reads 0 % wide', 1e-9);
  eq(analysis.stereo.length, 0, 'no per-band stereo for mono');
});

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log('\n=== Spectral Editing · Mastering Reference ===');
for (const r of results) console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
console.log(`\n${passed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
if (failed > 0) process.exit(1);
