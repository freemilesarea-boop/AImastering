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
  biquadMagnitudeDb, compressorOutputDb, freqToX, limiterOutputDb,
  logFrequencies, reverbEnvelope, type BiquadSpec,
} from '../../../daw/model/plugin-curves.js';
import { irDisplay, spaceAt } from '../../../daw/engine/reverb-spaces.js';
import {
  bandPictureFor, combPictureFor, delayPictureFor, detectorFor, detectorGainDb,
  filterPictureFor, lfoPictureFor, shaperFor, shaperOutput, widthPictureFor,
  type BandPicture, type CombPicture, type DelayPicture, type DetectorSpec,
  type LfoPicture, type ShaperSpec,
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
  picture: DelayPicture, dim: boolean,
): void {
  const mid = h - 14;
  const half = (h - 30) / 2;

  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, mid + 0.5); ctx.lineTo(w, mid + 0.5); ctx.stroke();

  // Repeats that alternate sides are drawn on alternate sides: one row of bars
  // would make a ping-pong look like any other delay, which is the one thing
  // the picture exists to tell them apart by.
  const stereo = picture.taps.some((tap) => tap.pan !== 0);
  const bar = (t: number, gain: number, pan: number, colour: string): void => {
    const x = Math.round((t / picture.spanSec) * (w - 8)) + 4;
    const height = Math.max(2, gain * (stereo ? half : half * 2));
    ctx.fillStyle = colour;
    if (!stereo) { ctx.fillRect(x - 1, mid - height, 3, height); return; }
    // Left above the line, right below it.
    if (pan <= 0) ctx.fillRect(x - 1, mid - height, 3, height);
    if (pan >= 0) ctx.fillRect(x - 1, mid, 3, height);
  };

  bar(0, 1, stereo ? -1 : 0, 'rgba(235,235,245,0.8)');
  for (const tap of picture.taps) {
    bar(tap.timeSec, tap.gain, tap.pan, dim ? 'rgba(140,140,160,0.5)' : premium.accent.base);
  }

  ctx.fillStyle = LABEL;
  ctx.font = '9px ui-monospace, monospace';
  ctx.fillText(picture.caption, 4, 11);
  const spanText = `${picture.spanSec.toFixed(2)} s`;
  ctx.fillText(spanText, w - ctx.measureText(spanText).width - 4, 11);
  // Beside the centre line, not in the corner the span label owns.
  if (stereo) { ctx.fillText('L', w - 9, mid - 4); ctx.fillText('R', w - 9, mid + 11); }
}

/**
 * Several compressors, side by side, each on its own slice of the spectrum.
 *
 * Nine knobs cannot show that the low band is squeezing four times as hard as
 * the top one, which is the entire reason a multiband exists.  Each band gets
 * its own panel with its own transfer curve, in the order the crossovers put
 * them, labelled with the frequencies it covers.
 */
function drawBands(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  picture: BandPicture, level: number, dim: boolean,
): void {
  const FLOOR = -48;
  // The caption owns the first line and each band's own label the second, so
  // neither has to be read out of the other.
  const top = 30;
  const bottom = h - 14;
  const n = picture.bands.length;
  const gap = 4;
  const panel = (w - gap * (n - 1)) / n;

  ctx.font = '8px ui-monospace, monospace';
  picture.bands.forEach((band, index) => {
    const left = index * (panel + gap);
    const xFor = (db: number): number => left + ((db - FLOOR) / -FLOOR) * panel;
    const yFor = (db: number): number => bottom - ((db - FLOOR) / -FLOOR) * (bottom - top);

    ctx.strokeStyle = GRID;
    ctx.strokeRect(Math.round(left) + 0.5, Math.round(top) + 0.5, panel, bottom - top);

    // The curve this band's compressor actually runs.
    const spec = {
      thresholdDb: band.thresholdDb,
      ratio: band.ratio,
      kneeDb: band.kneeDb,
      makeupDb: band.makeupDb,
    };
    ctx.beginPath();
    for (let px = 0; px <= panel; px++) {
      const inDb = FLOOR + (px / panel) * -FLOOR;
      const y = yFor(Math.max(FLOOR, Math.min(0, compressorOutputDb(spec, inDb))));
      if (px === 0) ctx.moveTo(left, y); else ctx.lineTo(left + px, y);
    }
    ctx.strokeStyle = dim ? 'rgba(140,140,160,0.5)' : premium.accent.base;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Where it starts working.
    if (band.ratio > 1) {
      const tx = Math.round(xFor(band.thresholdDb)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(tx, top); ctx.lineTo(tx, bottom);
      ctx.strokeStyle = 'rgba(248,113,113,0.45)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Where the track sits, on every band at once — the level is broadband,
    // so this is where each band WOULD be if the music were all in it.
    if (level > 0.0005) {
      const inDb = Math.max(FLOOR, 20 * Math.log10(level));
      ctx.beginPath();
      ctx.arc(xFor(inDb), yFor(Math.max(FLOOR, Math.min(0, compressorOutputDb(spec, inDb)))), 2.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(110,231,183,0.9)';
      ctx.fill();
    }

    const range = band.toHz >= 20_000
      ? `${(band.fromHz / 1000).toFixed(1)}k+`
      : band.fromHz <= 20
        ? `–${band.toHz >= 1000 ? `${(band.toHz / 1000).toFixed(1)}k` : band.toHz.toFixed(0)}`
        : `${(band.fromHz / 1000).toFixed(1)}–${(band.toHz / 1000).toFixed(1)}k`;
    ctx.fillStyle = dim ? 'rgba(140,140,160,0.7)' : LABEL;
    ctx.fillText(`${band.label} ${band.ratio.toFixed(1)}:1`, left + 2, top - 6);
    ctx.fillText(range, left + 2, bottom + 10);
  });

  ctx.fillStyle = LABEL;
  ctx.font = '9px ui-monospace, monospace';
  ctx.fillText(picture.caption, 4, 10);
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


/**
 * A modulator's own movement, over a couple of its own cycles.
 *
 * The time axis is scaled to the rate, so a slow sweep and a fast one look
 * the same width and the SHAPE is what changes — which is the thing the two
 * knobs cannot show between them.
 */
function drawLfo(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  picture: LfoPicture, dim: boolean,
): void {
  const top = 16;
  const bottom = h - 14;
  const span = Math.max(1e-6, picture.max - picture.min);
  const yFor = (v: number): number =>
    bottom - ((Math.max(picture.min, Math.min(picture.max, v)) - picture.min) / span) * (bottom - top);

  ctx.font = '9px ui-monospace, monospace';
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  // One vertical rule per cycle, so the rate is countable rather than read.
  const cycles = 2;
  for (let c = 1; c < cycles; c++) {
    const x = Math.round((c / cycles) * w) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, top - 4); ctx.lineTo(x, bottom); ctx.stroke();
  }
  // The middle of the range, or zero when the range crosses it.
  const restV = picture.min < 0 && picture.max > 0 ? 0 : (picture.min + picture.max) / 2;
  const rest = Math.round(yFor(restV)) + 0.5;
  ctx.strokeStyle = AXIS;
  ctx.beginPath(); ctx.moveTo(0, rest); ctx.lineTo(w, rest); ctx.stroke();

  picture.traces.forEach((trace, index) => {
    ctx.beginPath();
    for (let px = 0; px < w; px++) {
      const t = (px / Math.max(1, w - 1)) * picture.spanSec;
      const y = yFor(trace.at(t));
      if (px === 0) ctx.moveTo(0, y); else ctx.lineTo(px, y);
    }
    ctx.strokeStyle = dim ? 'rgba(140,140,160,0.5)' : trace.colour;
    ctx.lineWidth = 2;
    ctx.stroke();
    if (picture.traces.length > 1) {
      ctx.fillStyle = dim ? 'rgba(140,140,160,0.6)' : trace.colour;
      const text = trace.label;
      ctx.fillText(text, w - ctx.measureText(text).width - 4, 11 + index * 11);
    }
  });

  ctx.fillStyle = LABEL;
  ctx.fillText(picture.caption, 4, 11);
  const fmt = (v: number): string =>
    `${Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2)}${picture.unit}`;
  ctx.fillText(fmt(picture.max), 4, top + 9);
  ctx.fillText(fmt(picture.min), 4, bottom - 3);
  ctx.fillText(`${picture.spanSec.toFixed(2)} s`, w - 32, bottom - 3);
}

/**
 * Interference, and where it travels.
 *
 * A flanger and a phaser both sum a treated path back against the dry one, so
 * what you hear is notches — and the notches MOVE.  A still picture of a
 * moving filter says less than it seems to, so the band behind the line is
 * everywhere the response reaches across the sweep; the line is only where it
 * happens to be at the bottom of that sweep.
 */
function drawComb(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  picture: CombPicture, dim: boolean,
): void {
  const RANGE = 18;
  const yFor = (db: number): number =>
    h / 2 - (Math.max(-RANGE, Math.min(RANGE, db)) / RANGE) * (h / 2 - 8);

  ctx.font = '9px ui-monospace, monospace';
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  for (const hz of [100, 500, 1000, 5000, 10_000]) {
    const x = Math.round(freqToX(hz) * w) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    ctx.fillStyle = LABEL;
    ctx.fillText(hz >= 1000 ? `${hz / 1000}k` : String(hz), x + 3, h - 4);
  }
  ctx.strokeStyle = AXIS;
  ctx.beginPath();
  ctx.moveTo(0, Math.round(yFor(0)) + 0.5); ctx.lineTo(w, Math.round(yFor(0)) + 0.5);
  ctx.stroke();

  const hzAt = (px: number): number => 20 * Math.exp((px / Math.max(1, w - 1)) * Math.log(1000));

  // A comb's teeth are evenly spaced in HERTZ, so on a log axis they crowd
  // together towards the top until several fall inside one pixel.  Sampling
  // once per pixel there does not draw the comb, it draws whichever tooth the
  // sample happened to land on — a different shape at every window width.
  //
  // So each pixel is sampled several times and drawn as the range it covers:
  // where the teeth are wide it comes out a line, and where they are packed it
  // comes out a solid band, which is what "too dense to resolve" looks like.
  const SUB = 8;
  const nowLo: number[] = [];
  const nowHi: number[] = [];
  const sweepLo: number[] = [];
  const sweepHi: number[] = [];
  for (let px = 0; px < w; px++) {
    let nLo = Infinity, nHi = -Infinity, sLo = Infinity, sHi = -Infinity;
    for (let k = 0; k < SUB; k++) {
      const hz = hzAt(px + k / SUB);
      const db = picture.db(hz);
      if (db < nLo) nLo = db;
      if (db > nHi) nHi = db;
      const range = picture.sweep(hz);
      if (range.lo < sLo) sLo = range.lo;
      if (range.hi > sHi) sHi = range.hi;
    }
    nowLo.push(nLo); nowHi.push(nHi);
    sweepLo.push(Math.min(sLo, nLo)); sweepHi.push(Math.max(sHi, nHi));
  }

  const band = (lo: number[], hi: number[], fill: string): void => {
    ctx.beginPath();
    for (let px = 0; px < w; px++) ctx.lineTo(px, yFor(hi[px] ?? 0));
    for (let px = w - 1; px >= 0; px--) ctx.lineTo(px, yFor(lo[px] ?? 0));
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };

  // Everywhere the notches travel, then where they are right now.
  band(sweepLo, sweepHi, dim ? 'rgba(140,140,160,0.10)' : 'rgba(126,200,255,0.18)');
  band(nowLo, nowHi, dim ? 'rgba(140,140,160,0.45)' : 'rgba(230,210,160,0.85)');

  ctx.fillStyle = LABEL;
  ctx.fillText(picture.caption, 4, 11);
  ctx.fillText(`±${RANGE} dB`, w - 42, 11);
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

    // One picture per device, chosen by what the device actually does.  The
    // order is only about which describer gets asked first; each of them
    // answers for its own devices and null for everything else, so a device
    // cannot fall into two branches.
    const specs = eqSpecs(pluginId, params);
    const shaper = shaperFor(pluginId, params);
    const detector = detectorFor(pluginId, params);
    const filter = filterPictureFor(pluginId, params);
    const widthPic = widthPictureFor(pluginId, params);
    const lfoPic = lfoPictureFor(pluginId, params);
    const comb = combPictureFor(pluginId, params);
    const delayPic = delayPictureFor(pluginId, params);
    const bands = bandPictureFor(pluginId, params);

    if (specs.length > 0) {
      drawEq(ctx, width, height, [{ label: '', specs, colour: premium.accent.base }], bypassed);
    } else if (pluginId === 'comp' || pluginId === 'limiter' || pluginId === 'transient'
               || pluginId === 'ducker') {
      drawDynamics(ctx, width, height, pluginId, params, level, bypassed);
      if (reduction !== null && reduction < -0.05) drawReduction(ctx, width, height, reduction);
    } else if (pluginId === 'reverb' || pluginId === 'spacereverb' || pluginId === 'plate'
               || pluginId === 'spring' || pluginId === 'shimmer') {
      drawReverb(ctx, width, height, pluginId, params, bypassed);
    } else if (pluginId === 'loudness') {
      drawLoudness(ctx, width, height, analysis, params);
    } else if (shaper) {
      drawShaper(ctx, width, height, shaper, level, bypassed);
    } else if (detector) {
      drawDetector(ctx, width, height, detector, level, bypassed);
    } else if (filter) {
      drawEq(ctx, width, height, filter.curves, bypassed, filter.fromHz, filter.toHz);
      ctx.fillStyle = LABEL;
      ctx.font = '9px ui-monospace, monospace';
      ctx.fillText(filter.caption, 4, 11);
    } else if (widthPic) {
      drawWidth(ctx, width, height, widthPic, bypassed);
    } else if (lfoPic) {
      drawLfo(ctx, width, height, lfoPic, bypassed);
    } else if (comb) {
      drawComb(ctx, width, height, comb, bypassed);
    } else if (delayPic) {
      drawDelay(ctx, width, height, delayPic, bypassed);
    } else if (bands) {
      drawBands(ctx, width, height, bands, level, bypassed);
    } else {
      drawLevel(ctx, width, height, level);
    }
  }, [pluginId, params, bypassed, level, reduction, analysis, width, height]);

  return <canvas ref={ref} className="block rounded-md" style={{ background: 'rgba(0,0,0,0.28)' }} />;
}
