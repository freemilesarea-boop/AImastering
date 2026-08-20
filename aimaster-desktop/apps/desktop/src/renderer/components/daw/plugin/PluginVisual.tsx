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
import { premium } from '../../../theme/premium.js';

export interface PluginVisualProps {
  pluginId: string;
  params: Record<string, number>;
  bypassed: boolean;
  /** Track peak, 0..1, sampled while the transport runs.  0 when silent. */
  level: number;
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

/** The filters an EQ plugin is running, in engine order. */
function eqSpecs(pluginId: string, params: Record<string, number>): BiquadSpec[] {
  if (pluginId === 'eq3') {
    return [
      // The engine leaves Q at the Web Audio default of 1 dB on this filter.
      { type: 'highpass',  freq: param(params, 'hpfHz', 20),   gain: 0, q: 1 },
      { type: 'lowshelf',  freq: 120,                          gain: param(params, 'lowDb', 0),  q: 0.707 },
      { type: 'peaking',   freq: param(params, 'midHz', 1000), gain: param(params, 'midDb', 0),  q: 1 },
      { type: 'highshelf', freq: 8000,                         gain: param(params, 'highDb', 0), q: 0.707 },
    ];
  }
  if (pluginId === 'exciter') {
    return [{ type: 'highshelf', freq: param(params, 'freqHz', 6000), gain: param(params, 'amountDb', 0), q: 0.707 }];
  }
  if (pluginId === 'deesser') {
    return [{ type: 'peaking', freq: param(params, 'freqHz', 6500), gain: -param(params, 'amountDb', 0), q: 2 }];
  }
  if (pluginId === 'dyneq') {
    return [{ type: 'peaking', freq: param(params, 'freqHz', 300), gain: param(params, 'rangeDb', 0), q: param(params, 'q', 1) }];
  }
  return [];
}

function drawEq(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  specs: BiquadSpec[], dim: boolean,
): void {
  const RANGE = 24;                                // ±24 dB visible
  const yFor = (db: number): number => h / 2 - (db / RANGE) * (h / 2 - 6);

  // Decade grid, labelled where there is room.
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.font = '9px ui-monospace, monospace';
  ctx.fillStyle = LABEL;
  for (const hz of [50, 100, 500, 1000, 5000, 10_000]) {
    const x = Math.round(freqToX(hz) * w) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    ctx.fillText(hz >= 1000 ? `${hz / 1000}k` : String(hz), x + 3, h - 4);
  }
  for (const db of [-12, 12]) {
    const y = Math.round(yFor(db)) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  ctx.strokeStyle = AXIS;
  ctx.beginPath();
  ctx.moveTo(0, Math.round(yFor(0)) + 0.5); ctx.lineTo(w, Math.round(yFor(0)) + 0.5);
  ctx.stroke();

  // The response itself, evaluated at one point per pixel column.
  const points = logFrequencies(w);
  ctx.beginPath();
  points.forEach((hz, i) => {
    let db = 0;
    for (const spec of specs) db += biquadMagnitudeDb(spec, hz);
    const y = yFor(Math.max(-RANGE, Math.min(RANGE, db)));
    if (i === 0) ctx.moveTo(0, y); else ctx.lineTo(i, y);
  });
  ctx.strokeStyle = dim ? 'rgba(140,140,160,0.5)' : premium.accent.base;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Fill to the zero line so a cut and a boost are different shapes.
  ctx.lineTo(w, yFor(0));
  ctx.lineTo(0, yFor(0));
  ctx.closePath();
  ctx.fillStyle = dim ? 'rgba(140,140,160,0.06)' : 'rgba(230,210,160,0.10)';
  ctx.fill();
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
    kneeDb: 6,
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

function drawReverb(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  params: Record<string, number>, dim: boolean,
): void {
  const decay = param(params, 'decaySec', 1.8);
  const env = reverbEnvelope(decay, w);

  ctx.beginPath();
  env.forEach((g, i) => {
    const y = h - 8 - g * (h - 20);
    if (i === 0) ctx.moveTo(0, y); else ctx.lineTo(i, y);
  });
  ctx.strokeStyle = dim ? 'rgba(140,140,160,0.5)' : premium.accent.base;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.lineTo(w, h - 8); ctx.lineTo(0, h - 8); ctx.closePath();
  ctx.fillStyle = 'rgba(230,210,160,0.08)';
  ctx.fill();

  ctx.fillStyle = LABEL;
  ctx.font = '9px ui-monospace, monospace';
  ctx.fillText(`RT60 ${decay.toFixed(2)} s`, 4, 11);
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
  pluginId, params, bypassed, level, width, height,
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
    if (specs.length > 0) drawEq(ctx, width, height, specs, bypassed);
    else if (pluginId === 'comp' || pluginId === 'limiter' || pluginId === 'transient') {
      drawDynamics(ctx, width, height, pluginId, params, level, bypassed);
    } else if (pluginId === 'delay') drawDelay(ctx, width, height, params, bypassed);
    else if (pluginId === 'reverb') drawReverb(ctx, width, height, params, bypassed);
    else drawLevel(ctx, width, height, level);
  }, [pluginId, params, bypassed, level, width, height]);

  return <canvas ref={ref} className="block rounded-md" style={{ background: 'rgba(0,0,0,0.28)' }} />;
}
