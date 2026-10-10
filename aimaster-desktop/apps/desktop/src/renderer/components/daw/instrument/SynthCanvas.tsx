// The three pictures on the wavetable synth's panel.
//
// All of them take their points from `synth-views.ts` in 0…1 space and do one
// multiply per axis, so nothing here can disagree with what the engine does —
// the maths is checked in `synth-panel-selftest` and the drawing has no
// arithmetic of its own to be wrong.

import React, { useEffect, useRef } from 'react';
import {
  cutoffHz, envelopeShape, lfoShape, surfaceMarker, svfResponseDb, tableSurface,
  type Point,
} from '../../../daw/model/synth-views.js';
import { wavetableAt } from '../../../daw/engine/wavetable.js';
import { premium } from '../../../theme/premium.js';

function useCanvas(
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  width: number, height: number, deps: readonly unknown[],
): React.MutableRefObject<HTMLCanvasElement | null> {
  const ref = useRef<HTMLCanvasElement | null>(null);
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
    draw(ctx, width, height);
    // `draw` is rebuilt every render by design; the deps the caller passes are
    // what decides when this runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height, ...deps]);
  return ref;
}

function stroke(ctx: CanvasRenderingContext2D, pts: readonly Point[], w: number, h: number): void {
  ctx.beginPath();
  pts.forEach((p, i) => {
    const x = p.x * w;
    const y = p.y * h;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

/**
 * The wavetable, as a stack of slices going back into the picture.
 *
 * The slice at the current position is drawn last and bright; the rest fade
 * with depth.  That is the whole information the display carries: what the
 * table holds, and where in it you are — and the second one is continuous
 * even though the frames are not, which is the thing this instrument can do
 * and the poly synth beside it cannot.
 */
export function WavetableView(
  { tableIndex, pos, width, height }: {
    tableIndex: number; pos: number; width: number; height: number;
  },
): React.ReactElement {
  const table = wavetableAt(tableIndex);
  const ref = useCanvas((ctx, w, h) => {
    const pad = 4;
    const iw = w - pad * 2;
    const ih = h - pad * 2;
    ctx.save();
    ctx.translate(pad, pad);
    for (const line of tableSurface(table, 128)) {
      const near = 1 - line.depth;
      ctx.strokeStyle = `rgba(126,200,255,${(0.12 + near * 0.28).toFixed(3)})`;
      ctx.lineWidth = 1;
      stroke(ctx, line.points, iw, ih);
    }
    const marker = surfaceMarker(table, pos);
    ctx.strokeStyle = premium.accent.base;
    ctx.lineWidth = 1.8;
    stroke(ctx, marker.points, iw, ih);
    ctx.restore();
  }, width, height, [tableIndex, pos]);
  return <canvas ref={ref} />;
}

/** The filter's real magnitude, on a log frequency axis. */
export function FilterView(
  { mode, poles, cutoffSemis, res, width, height }: {
    mode: number; poles: number; cutoffSemis: number; res: number;
    width: number; height: number;
  },
): React.ReactElement {
  const ref = useCanvas((ctx, w, h) => {
    const min = 20; const max = 20_000;
    const top = 18; const bottom = -42;
    const fc = cutoffHz(cutoffSemis);
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    for (const hz of [100, 1000, 10_000]) {
      const x = Math.round((Math.log2(hz / min) / Math.log2(max / min)) * w) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    const zero = ((top - 0) / (top - bottom)) * h;
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.beginPath(); ctx.moveTo(0, zero + 0.5); ctx.lineTo(w, zero + 0.5); ctx.stroke();

    const pts: Point[] = [];
    for (let i = 0; i < w; i++) {
      const hz = min * Math.pow(max / min, i / (w - 1));
      const db = svfResponseDb(mode, poles, fc, res, hz);
      pts.push({ x: i / (w - 1), y: Math.max(0, Math.min(1, (top - db) / (top - bottom))) });
    }
    ctx.strokeStyle = premium.accent.base;
    ctx.lineWidth = 1.6;
    stroke(ctx, pts, w, h);

    // Where the cutoff is, because the number on the knob is in semitones and
    // nobody thinks in semitones about a filter.
    const cx = Math.round((Math.log2(fc / min) / Math.log2(max / min)) * w) + 0.5;
    ctx.strokeStyle = 'rgba(126,200,255,0.45)';
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke();
    ctx.fillStyle = premium.text.muted;
    ctx.font = '8px ui-monospace, monospace';
    ctx.fillText(fc >= 1000 ? `${(fc / 1000).toFixed(1)}k` : `${Math.round(fc)}`, Math.min(w - 22, cx + 3), 9);
  }, width, height, [mode, poles, cutoffSemis, res]);
  return <canvas ref={ref} />;
}

/** An ADSR, with the moment the key lifts marked. */
export function EnvelopeView(
  { attack, decay, sustain, release, width, height }: {
    attack: number; decay: number; sustain: number; release: number;
    width: number; height: number;
  },
): React.ReactElement {
  const ref = useCanvas((ctx, w, h) => {
    const shape = envelopeShape(attack, decay, sustain, release);
    const gx = shape.releaseAt * w;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = premium.accent.base;
    ctx.lineWidth = 1.6;
    stroke(ctx, shape.points, w, h);
    ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
    ctx.fillStyle = 'rgba(230,210,160,0.10)';
    ctx.fill();
  }, width, height, [attack, decay, sustain, release]);
  return <canvas ref={ref} />;
}

/** Two cycles of an LFO, as the shape and skew leave it. */
export function LfoView(
  { shape, skew, width, height }: {
    shape: number; skew: number; width: number; height: number;
  },
): React.ReactElement {
  const ref = useCanvas((ctx, w, h) => {
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath(); ctx.moveTo(0, h / 2 + 0.5); ctx.lineTo(w, h / 2 + 0.5); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.beginPath(); ctx.moveTo(w / 2 + 0.5, 0); ctx.lineTo(w / 2 + 0.5, h); ctx.stroke();
    ctx.strokeStyle = premium.accent.base;
    ctx.lineWidth = 1.6;
    stroke(ctx, lfoShape(shape, skew), w, h);
  }, width, height, [shape, skew]);
  return <canvas ref={ref} />;
}
