// The picture at the top of a plugin window.
//
// It draws the plugin's actual transfer function, from `plugin-curves.ts` —
// the same maths the engine's filters implement — so the curve moves with the
// knob in real time and cannot drift away from what is being heard.
//
// The live level line comes from the track's own meter, which means the
// picture shows where THIS performance sits against the threshold, not a
// generic diagram.  That is the difference between "ratio 4:1" and "you are
// hitting the knee on every snare".

import React, { useEffect, useRef } from 'react';
import {
  biquadMagnitudeDb, compressorOutputDb, delayTaps, freqToX, limiterOutputDb,
  logFrequencies, reverbEnvelope, type BiquadSpec,
} from '../../../daw/model/plugin-curves.js';
import { irDisplay, spaceAt } from '../../../daw/engine/reverb-spaces.js';
import {
  detectorFor, detectorGainDb, filterPictureFor, shaperFor, shaperOutput, widthPictureFor,
  type DetectorSpec, type ShaperSpec,
} from '../../../daw/model/plugin-shapes.js';
import { premium } from '../../../theme/premium.js';

export interface PluginVisualProps {
  pluginId: string;
  params: Record<string, number>;
  bypassed: boolean;
  /** Track peak, 0..1, sampled while the transport runs.  0 when silent. */
  level: number;
  /** Gain reduction the device reports, in dB (negative), or null. */
  reduction?: number | null;
  /** What a metering device is reading, or null. */
  analysis?: { lufs: number; peakDb: number } | null;
  width: number;
  height: number;
}

const GRID = 'rgba(255,255,255,0.06)';
const AXIS = 'rgba(255,255,255,0.16)';
const LABEL = 'rgba(160,160,175,0.9)';

function param(params: Record<string, number>, id: string, fallback: number): number {
  const v = params[id];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * The filters behind a device that draws its response but is not edited on it.
 *
 * Everything with grabbable bands — the parametric, the three-band, the
 * dynamic EQ — is an editor now, in `EqCurveEditor`, and describes its bands
 * in `eq-nodes.ts`.  What is left here is the tilt, whose one knob writes two
 * shelves at once: there is no single handle for that, so it stays a picture.
 */
function eqSpecs(pluginId: string, params: Record<string, number>): BiquadSpec[] {
  if (pluginId === 'tilt') {
    // Tilt up is bright: the low shelf goes down by exactly what the high
    // shelf goes up by, both at the pivot.
    const tilt = param(params, 'tiltDb', 0);
    const pivot = param(params, 'pivotHz', 1000);
    return [
      { type: 'lowshelf',  freq: pivot, gain: -tilt, q: 0.707 },
      { type: 'highshelf', freq: pivot, gain: tilt,  q: 0.707 },
    ];
  }
  return [];
}

function drawEq(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  curves: ReadonlyArray<{ label: string; specs: BiquadSpec[]; colour: string }>,
  dim: boolean, fromHz = 20, toHz = 20_000, rangeDb = 24,
): void {
  const yFor = (db: number): number => h / 2 - (db / rangeDb) * (h / 2 - 6);
  const xOf = (hz: number): number => freqToX(hz, fromHz, toHz) * w;

  // Decade grid, labelled where there is room, over whatever span is visible.
  const ticks = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000]
    .filter((hz) => hz > fromHz * 1.2 && hz < toHz * 0.85);
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.font = '9px ui-monospace, monospace';
  for (const hz of ticks) {
    const x = Math.round(xOf(hz)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    ctx.fillStyle = LABEL;
    ctx.fillText(hz >= 1000 ? `${hz / 1000}k` : String(hz), x + 3, h - 4);
  }
  for (const db of [-rangeDb / 2, rangeDb / 2]) {
    const y = Math.round(yFor(db)) + 0.5;
    ctx.strokeStyle = GRID;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  ctx.strokeStyle = AXIS;
  ctx.beginPath();
  ctx.moveTo(0, Math.round(yFor(0)) + 0.5); ctx.lineTo(w, Math.round(yFor(0)) + 0.5);
  ctx.stroke();

  // One point per pixel column, per curve.
  const points = logFrequencies(w, fromHz, toHz);
  curves.forEach((curve, index) => {
    ctx.beginPath();
    points.forEach((hz, i) => {
      let db = 0;
      for (const spec of curve.specs) db += biquadMagnitudeDb(spec, hz);
      const y = yFor(Math.max(-rangeDb, Math.min(rangeDb, db)));
      if (i === 0) ctx.moveTo(0, y); else ctx.lineTo(i, y);
    });
    ctx.strokeStyle = dim ? 'rgba(140,140,160,0.5)' : curve.colour;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Fill to the zero line so a cut and a boost are different shapes. Only
    // for a single curve: two overlapping fills read as a third shape that is
    // not either of them.
    if (curves.length === 1) {
      ctx.lineTo(w, yFor(0));
      ctx.lineTo(0, yFor(0));
      ctx.closePath();
      ctx.fillStyle = dim ? 'rgba(140,140,160,0.06)' : 'rgba(230,210,160,0.10)';
      ctx.fill();
    } else if (curve.label) {
      // Top right, because the caption owns the top left on every picture.
      ctx.fillStyle = dim ? 'rgba(140,140,160,0.6)' : curve.colour;
      const text = curve.label;
      ctx.fillText(text, w - ctx.measureText(text).width - 4, 11 + index * 11);
    }
  });
}

/**
 * How wide a device leaves each frequency.
 *
 * A width knob is a number; what the device does is a curve, because both of
 * these filter the SIDE component before scaling it.  Drawn against a 1.0 line
 * that means "as it came in", so mono is the floor and the corner where the
 * sides disappear is a place on the picture rather than a second knob.
 */
function drawWidth(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  picture: { widthAt: (hz: number) => number; cornerHz: number; maxWidth: number; caption: string },
  dim: boolean,
): void {
  const top = 16;
  const bottom = h - 16;
  const yFor = (width: number): number =>
    bottom - (Math.max(0, Math.min(picture.maxWidth, width)) / picture.maxWidth) * (bottom - top);

  ctx.font = '9px ui-monospace, monospace';
  ctx.strokeStyle = GRID;
  for (const hz of [50, 100, 200, 500, 1000, 5000]) {
    const x = Math.round(freqToX(hz) * w) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, top - 4); ctx.lineTo(x, bottom); ctx.stroke();
    ctx.fillStyle = LABEL;
    ctx.fillText(hz >= 1000 ? `${hz / 1000}k` : String(hz), x + 3, h - 4);
  }

  // "As it came in".
  const unity = Math.round(yFor(1)) + 0.5;
  ctx.strokeStyle = AXIS;
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(0, unity); ctx.lineTo(w, unity); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = LABEL;
  ctx.fillText('1.0×', w - 26, unity - 3);

  ctx.beginPath();
  for (let px = 0; px < w; px++) {
    const hz = 20 * Math.exp((px / Math.max(1, w - 1)) * Math.log(1000));
    const y = yFor(picture.widthAt(hz));
    if (px === 0) ctx.moveTo(0, y); else ctx.lineTo(px, y);
  }
  ctx.strokeStyle = dim ? 'rgba(140,140,160,0.5)' : premium.accent.base;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.lineTo(w, bottom);
  ctx.lineTo(0, bottom);
  ctx.closePath();
  ctx.fillStyle = dim ? 'rgba(140,140,160,0.06)' : 'rgba(126,200,255,0.10)';
  ctx.fill();

  // Where the sides go.
  const cx = Math.round(freqToX(picture.cornerHz) * w) + 0.5;
  ctx.beginPath();
  ctx.moveTo(cx, top - 4); ctx.lineTo(cx, bottom);
  ctx.strokeStyle = 'rgba(248,113,113,0.5)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = LABEL;
  ctx.fillText(picture.caption, 4, 11);
  ctx.fillText('MONO', 4, bottom - 3);
}

function drawDynamics(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  pluginId: string, params: Record<string, number>, level: number, dim: boolean,
): void {
  const FLOOR = -60;
  const xFor = (db: number): number => ((db - FLOOR) / -FLOOR) * w;
  const yFor = (db: number): number => h - ((db - FLOOR) / -FLOOR) * h;

  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  for (const db of [-48, -36, -24, -12]) {
    const x = Math.round(xFor(db)) + 0.5;
    const y = Math.round(yFor(db)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  // Unity — the line the curve departs from.
  ctx.strokeStyle = AXIS;
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(xFor(FLOOR), yFor(FLOOR)); ctx.lineTo(xFor(0), yFor(0)); ctx.stroke();
  ctx.setLineDash([]);

  const isLimiter = pluginId === 'limiter';
  const spec = {
    thresholdDb: param(params, 'thresholdDb', -18),
    ratio: param(params, 'ratio', 4),
    // Read, not assumed.  This was hard-coded at 6 dB, so turning the Knee
    // knob moved the sound and left the drawing where it was — the curve
    // stopped being a picture of the device and became a picture of a
    // device with the same threshold.
    kneeDb: param(params, 'kneeDb', 6),
    makeupDb: param(params, 'makeupDb', 0),
  };
  const ceiling = param(params, 'ceilingDb', -1);

  ctx.beginPath();
  for (let px = 0; px <= w; px++) {
    const inDb = FLOOR + (px / w) * -FLOOR;
    const outDb = isLimiter ? limiterOutputDb(ceiling, inDb) : compressorOutputDb(spec, inDb);
    const y = yFor(Math.max(FLOOR, Math.min(0, outDb)));
    if (px === 0) ctx.moveTo(0, y); else ctx.lineTo(px, y);
  }
  ctx.strokeStyle = dim ? 'rgba(140,140,160,0.5)' : premium.accent.base;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Threshold / ceiling marker.
  const markDb = isLimiter ? ceiling : spec.thresholdDb;
  const mx = Math.round(xFor(markDb)) + 0.5;
  ctx.strokeStyle = 'rgba(248,113,113,0.55)';
  ctx.beginPath(); ctx.moveTo(mx, 0); ctx.lineTo(mx, h); ctx.stroke();

  // Where the track actually is, right now.
  if (level > 0.0005) {
    const inDb = Math.max(FLOOR, 20 * Math.log10(level));
    const outDb = isLimiter ? limiterOutputDb(ceiling, inDb) : compressorOutputDb(spec, inDb);
    const lx = xFor(inDb);
    const ly = yFor(Math.max(FLOOR, Math.min(0, outDb)));
    ctx.fillStyle = 'rgba(110,231,183,0.95)';
    ctx.beginPath(); ctx.arc(lx, ly, 4, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(110,231,183,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(lx, h); ctx.lineTo(lx, ly); ctx.stroke();
  }

  ctx.fillStyle = LABEL;
  ctx.font = '9px ui-monospace, monospace';
  ctx.fillText('IN', 4, h - 4);
  ctx.fillText('OUT', 4, 11);
}

/**
 * Gain reduction, as reported by the device itself.
 *
 * Down from the top, like every hardware GR meter: more light means more
 * squeeze.  The number is measured, not derived from the knobs, so it tells
 * you what this take is actually doing rather than what the settings imply.
 */
function drawReduction(
  ctx: CanvasRenderingContext2D, w: number, h: number, reductionDb: number,
): void {
  const SPAN = 24;                                 // 24 dB of meter
  const amount = Math.min(1, Math.abs(reductionDb) / SPAN);
  const x = w - 12;
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(x, 4, 6, h - 8);
  ctx.fillStyle = amount > 0.75 ? 'rgba(248,113,113,0.9)' : 'rgba(198,167,104,0.9)';
  ctx.fillRect(x, 4, 6, Math.max(1, amount * (h - 8)));

  ctx.fillStyle = 'rgba(230,210,160,0.95)';
  ctx.font = '9px ui-monospace, monospace';
  ctx.textAlign = 'right';
  ctx.fillText(`GR ${reductionDb.toFixed(1)}`, x - 4, 11);
  ctx.textAlign = 'left';
}

function drawDelay(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  params: Record<string, number>, dim: boolean,
): void {
  const delaySec = param(params, 'timeMs', 300) / 1000;
  const taps = delayTaps(delaySec, param(params, 'feedback', 0.35));
  const span = Math.max(0.5, delaySec * (taps.length + 1));

  ctx.strokeStyle = GRID;
  ctx.beginPath(); ctx.moveTo(0, h - 12.5); ctx.lineTo(w, h - 12.5); ctx.stroke();

  const bar = (t: number, gain: number, colour: string): void => {
    const x = Math.round((t / span) * (w - 8)) + 4;
    const height = Math.max(2, gain * (h - 24));
    ctx.fillStyle = colour;
    ctx.fillRect(x - 1, h - 12 - height, 3, height);
  };
  bar(0, 1, 'rgba(235,235,245,0.8)');
  for (const tap of taps) {
    bar(tap.timeSec, tap.gain, dim ? 'rgba(140,140,160,0.5)' : premium.accent.base);
  }

  ctx.fillStyle = LABEL;
  ctx.font = '9px ui-monospace, monospace';
  ctx.fillText(`${taps.length} repeats · ${(delaySec * 1000).toFixed(0)} ms`, 4, 11);
}

/**
 * The room, drawn from the numbers that build it.
 *
 * For the convolution devices this is not an illustration: the early
 * reflections are the taps the image-source model actually produced, at the
 * times it produced them, and the curve behind them is the envelope the tail
 * actually decays with.  A gated room's picture stops because the room stops.
 *
 * For the plate and the spring there is no impulse response to draw — they are
 * delay networks — so the curve is their decay law and the front is marked as
 * dense from the first millisecond, which is what they are.
 */
function drawReverb(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  pluginId: string, params: Record<string, number>, dim: boolean,
): void {
  const floor = h - 8;
  const top = 12;
  const stroke = dim ? 'rgba(140,140,160,0.5)' : premium.accent.base;

  const convolved = pluginId === 'spacereverb' || pluginId === 'shimmer';
  const preDelaySec = param(params, 'preDelayMs', 0) / 1000;

  let envelope: number[];
  let lengthSec: number;
  let taps: Array<{ timeSec: number; gain: number }> = [];
  let caption: string;

  if (convolved) {
    const space = spaceAt(param(params, 'space', 0));
    const display = irDisplay(space, {
      sampleRate: 48_000,
      sizeScale: param(params, 'sizePct', 100) / 100,
      decayScale: param(params, 'decayPct', 100) / 100,
      holdMs: param(params, 'holdMs', 260),
    }, w);
    envelope = display.envelope;
    lengthSec = display.lengthSec + preDelaySec;
    caption = `${space.name} · RT60 ${display.rt60Sec.toFixed(2)} s`;
    // Early reflections are only drawn where they are audible as reflections;
    // a plate's are 18 dB down and would just be noise on the picture.
    if (param(params, 'erDb', 0) > -18) {
      taps = display.taps.map((tap) => ({ timeSec: tap.timeSec, gain: tap.gain }));
    }
  } else {
    const decay = param(params, 'decaySec', 1.8);
    lengthSec = decay * 1.05 + preDelaySec;
    envelope = reverbEnvelope(decay, w);
    caption = `RT60 ${decay.toFixed(2)} s`;
  }

  const xOf = (seconds: number): number => (seconds / Math.max(1e-6, lengthSec)) * w;
  const preX = xOf(preDelaySec);
  const span = Math.max(1, w - preX);

  // The tail.
  ctx.beginPath();
  ctx.moveTo(preX, floor);
  envelope.forEach((g, i) => {
    const x = preX + (i / Math.max(1, envelope.length - 1)) * span;
    ctx.lineTo(x, floor - g * (floor - top));
  });
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.lineTo(w, floor);
  ctx.lineTo(preX, floor);
  ctx.closePath();
  ctx.fillStyle = 'rgba(230,210,160,0.08)';
  ctx.fill();

  // The reflections, where there are any to show.
  const loudest = taps.reduce((max, tap) => Math.max(max, tap.gain), 0);
  for (const tap of taps) {
    const x = xOf(preDelaySec + tap.timeSec);
    if (x > w) continue;
    const height = (tap.gain / Math.max(1e-9, loudest)) * (floor - top) * 0.8;
    ctx.beginPath();
    ctx.moveTo(x, floor);
    ctx.lineTo(x, floor - height);
    ctx.strokeStyle = dim ? 'rgba(140,140,160,0.35)' : 'rgba(126,200,255,0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Where the direct sound is, and how far behind it the room starts.
  if (preX > 1) {
    ctx.beginPath();
    ctx.moveTo(preX, top - 4);
    ctx.lineTo(preX, floor);
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  ctx.fillStyle = LABEL;
  ctx.font = '9px ui-monospace, monospace';
  ctx.fillText(caption, 4, 11);
  ctx.fillText(`${lengthSec.toFixed(2)} s`, w - 34, floor - 2);
}

/**
 * Loudness against the delivery target.
 *
 * The number a master is finished against, next to the number it is aimed at,
 * because "how loud is it" is only ever asked relative to a target.
 */
function drawLoudness(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  analysis: { lufs: number; peakDb: number } | null, params: Record<string, number>,
): void {
  const target = param(params, 'targetLufs', -14);
  const FLOOR = -40;
  const xFor = (lufs: number): number =>
    ((Math.max(FLOOR, Math.min(0, lufs)) - FLOOR) / -FLOOR) * w;

  ctx.strokeStyle = GRID;
  for (const mark of [-30, -20, -10]) {
    const x = Math.round(xFor(mark)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, 20); ctx.lineTo(x, h - 20); ctx.stroke();
  }

  // The target, and the bar that has to reach it.
  const tx = Math.round(xFor(target)) + 0.5;
  ctx.strokeStyle = 'rgba(198,167,104,0.8)';
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(tx, 12); ctx.lineTo(tx, h - 12); ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = LABEL;
  ctx.font = '9px ui-monospace, monospace';
  ctx.fillText(`TARGET ${target.toFixed(1)}`, 4, 11);

  if (!analysis || analysis.lufs <= -60) {
    ctx.fillText('재생하면 측정됩니다', 4, h / 2 + 4);
    return;
  }

  const level = xFor(analysis.lufs);
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(0, h / 2 - 10, w, 20);
  const over = analysis.lufs > target;
  ctx.fillStyle = over ? 'rgba(248,113,113,0.85)' : 'rgba(110,231,183,0.85)';
  ctx.fillRect(0, h / 2 - 10, level, 20);

  ctx.fillStyle = 'rgba(240,240,245,0.95)';
  ctx.font = '11px ui-monospace, monospace';
  ctx.fillText(`${analysis.lufs.toFixed(1)} LUFS`, 4, h / 2 + 4);

  // True peak matters as much as loudness: a limiter that hits the target and
  // clips the converter has not finished the job.
  const peakOver = analysis.peakDb > -1;
  ctx.fillStyle = peakOver ? 'rgba(248,113,113,0.95)' : LABEL;
  ctx.font = '9px ui-monospace, monospace';
  ctx.fillText(`PEAK ${analysis.peakDb.toFixed(1)} dBFS`, 4, h - 6);
}


/**
 * A waveshaper's transfer curve: what goes in, against what comes out.
 *
 * Linear axes, ±1 full scale, because that is the space the curve lives in —
 * a decibel axis would hide the one thing worth seeing, which is how the line
 * bends away from the diagonal as the drive comes up.  The faint diagonal is
 * "unchanged", so the distance from it IS the effect.
 *
 * The curve is read out of the same Float32Array the WaveShaperNode is loaded
 * with, so the bit crusher's staircase has exactly the steps the converter has
 * and the tube's asymmetry leans the way the tube leans.
 */
function drawShaper(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  spec: ShaperSpec, level: number, dim: boolean,
): void {
  const pad = 10;
  const size = Math.min(w, h) - pad * 2;
  const left = (w - size) / 2;
  const top = (h - size) / 2;
  const xFor = (v: number): number => left + ((v + 1) / 2) * size;
  const yFor = (v: number): number => top + (1 - (v + 1) / 2) * size;

  // The box, its middle, and the "unchanged" diagonal.
  ctx.strokeStyle = GRID;
  ctx.strokeRect(Math.round(left) + 0.5, Math.round(top) + 0.5, size, size);
  ctx.beginPath();
  ctx.moveTo(left, yFor(0)); ctx.lineTo(left + size, yFor(0));
  ctx.moveTo(xFor(0), top);  ctx.lineTo(xFor(0), top + size);
  ctx.stroke();
  ctx.beginPath();
  ctx.setLineDash([3, 3]);
  ctx.moveTo(xFor(-1), yFor(-1)); ctx.lineTo(xFor(1), yFor(1));
  ctx.strokeStyle = 'rgba(255,255,255,0.30)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);

  // The transfer curve. Sampled per pixel so a staircase reads as a staircase.
  ctx.beginPath();
  for (let px = 0; px <= size; px++) {
    const x = (px / size) * 2 - 1;
    const y = Math.max(-1.2, Math.min(1.2, shaperOutput(spec, x)));
    if (px === 0) ctx.moveTo(xFor(x), yFor(y)); else ctx.lineTo(xFor(x), yFor(y));
  }
  ctx.strokeStyle = dim ? 'rgba(140,140,160,0.5)' : premium.accent.base;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Where the track is sitting on that curve right now, both polarities,
  // because an asymmetric shaper does different things to the two of them.
  if (level > 0.0005) {
    const x = Math.min(1, level);
    for (const sign of [1, -1]) {
      const y = Math.max(-1.2, Math.min(1.2, shaperOutput(spec, sign * x)));
      ctx.beginPath();
      ctx.arc(xFor(sign * x), yFor(y), 3, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(110,231,183,0.95)';
      ctx.fill();
    }
  }

  ctx.fillStyle = LABEL;
  ctx.font = '9px ui-monospace, monospace';
  ctx.fillText(spec.caption, 4, 11);
  ctx.fillText(level > 0.0005 ? `${(20 * Math.log10(level)).toFixed(1)} dBFS` : '재생하면 표시됩니다', 4, h - 5);
  // Which way is which, in the two corners the curve never reaches: it runs
  // bottom-left to top-right, so top-left and bottom-right are always free.
  ctx.fillText('OUT', left + 4, top + 11);
  ctx.fillText('IN', left + size - 15, top + size - 4);
}

/**
 * A gate or an expander: input level against the gain it earns.
 *
 * The compressor's axes, but the curve falls away BELOW the threshold instead
 * of above it, which is the whole difference between the two families and is
 * invisible on a row of knobs.
 */
function drawDetector(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  spec: DetectorSpec, level: number, dim: boolean,
): void {
  const FLOOR = -80;
  const xFor = (db: number): number => ((db - FLOOR) / -FLOOR) * w;
  const yFor = (db: number): number => h - ((db - FLOOR) / -FLOOR) * h;

  ctx.strokeStyle = GRID;
  for (const db of [-60, -40, -20]) {
    const x = Math.round(xFor(db)) + 0.5;
    const y = Math.round(yFor(db)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  // Output level against input level, so a closed gate is a floor and an open
  // one is the diagonal.
  ctx.beginPath();
  for (let px = 0; px <= w; px++) {
    const inDb = FLOOR + (px / w) * -FLOOR;
    const outDb = inDb + detectorGainDb(spec, inDb);
    const y = yFor(Math.max(FLOOR, Math.min(0, outDb)));
    if (px === 0) ctx.moveTo(0, y); else ctx.lineTo(px, y);
  }
  ctx.strokeStyle = dim ? 'rgba(140,140,160,0.5)' : premium.accent.base;
  ctx.lineWidth = 2;
  ctx.stroke();

  const tx = Math.round(xFor(spec.thresholdDb)) + 0.5;
  ctx.beginPath();
  ctx.moveTo(tx, 0); ctx.lineTo(tx, h);
  ctx.strokeStyle = 'rgba(248,113,113,0.55)';
  ctx.lineWidth = 1;
  ctx.stroke();

  if (level > 0.00005) {
    const inDb = Math.max(FLOOR, 20 * Math.log10(level));
    const outDb = inDb + detectorGainDb(spec, inDb);
    ctx.beginPath();
    ctx.arc(xFor(inDb), yFor(Math.max(FLOOR, Math.min(0, outDb))), 3.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(110,231,183,0.95)';
    ctx.fill();
  }

  ctx.fillStyle = LABEL;
  ctx.font = '9px ui-monospace, monospace';
  ctx.fillText(spec.caption, 4, 11);
  ctx.fillText('IN', 4, h - 4);
  ctx.fillText('OUT', w - 22, 20);
}

/** A level bar, for plugins whose behaviour is not a curve. */
function drawLevel(ctx: CanvasRenderingContext2D, w: number, h: number, level: number): void {
  const db = level > 0.0005 ? 20 * Math.log10(level) : -60;
  const t = Math.max(0, Math.min(1, (db + 60) / 60));
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.fillRect(8, h / 2 - 6, w - 16, 12);
  ctx.fillStyle = db > -3 ? 'rgba(248,113,113,0.9)' : 'rgba(110,231,183,0.85)';
  ctx.fillRect(8, h / 2 - 6, (w - 16) * t, 12);
  ctx.fillStyle = LABEL;
  ctx.font = '9px ui-monospace, monospace';
  ctx.fillText(level > 0.0005 ? `${db.toFixed(1)} dBFS` : '— 재생하면 신호가 보입니다', 8, h / 2 + 24);
}

export default function PluginVisual({
  pluginId, params, bypassed, level, reduction = null, analysis = null, width, height,
}: PluginVisualProps) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const specs = eqSpecs(pluginId, params);
    if (specs.length > 0) {
      drawEq(ctx, width, height, [{ label: '', specs, colour: premium.accent.base }], bypassed);
    }
    else if (pluginId === 'comp' || pluginId === 'limiter' || pluginId === 'transient'
             || pluginId === 'ducker') {
      drawDynamics(ctx, width, height, pluginId, params, level, bypassed);
      if (reduction !== null && reduction < -0.05) drawReduction(ctx, width, height, reduction);
    } else if (pluginId === 'delay') drawDelay(ctx, width, height, params, bypassed);
    else if (pluginId === 'reverb' || pluginId === 'spacereverb' || pluginId === 'plate'
             || pluginId === 'spring' || pluginId === 'shimmer') {
      drawReverb(ctx, width, height, pluginId, params, bypassed);
    }
    else if (pluginId === 'loudness') drawLoudness(ctx, width, height, analysis, params);
    else {
      const shaper = shaperFor(pluginId, params);
      const detector = shaper ? null : detectorFor(pluginId, params);
      const filter = filterPictureFor(pluginId, params);
      const width01 = widthPictureFor(pluginId, params);
      if (shaper) drawShaper(ctx, width, height, shaper, level, bypassed);
      else if (detector) drawDetector(ctx, width, height, detector, level, bypassed);
      else if (filter) {
        drawEq(ctx, width, height, filter.curves, bypassed, filter.fromHz, filter.toHz);
        ctx.fillStyle = LABEL;
        ctx.font = '9px ui-monospace, monospace';
        ctx.fillText(filter.caption, 4, 11);
      } else if (width01) drawWidth(ctx, width, height, width01, bypassed);
      else drawLevel(ctx, width, height, level);
    }
  }, [pluginId, params, bypassed, level, reduction, analysis, width, height]);

  return <canvas ref={ref} className="block rounded-md" style={{ background: 'rgba(0,0,0,0.28)' }} />;
}
