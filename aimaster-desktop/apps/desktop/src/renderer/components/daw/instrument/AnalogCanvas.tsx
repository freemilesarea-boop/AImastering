// The four pictures on the analogue synth's panel.
//
// All of them take their points from `analog-views.ts` in 0…1 space and do
// one multiply per axis, so nothing here can disagree with what the engine
// does — the maths is checked in `analog-panel-selftest` and the drawing has
// no arithmetic of its own to be wrong.

import React, { useEffect, useRef } from 'react';
import {
  analogEnvPoints, analogWavePoints, driftPoints, ladderResponseDb, voiceRows,
} from '../../../daw/model/analog-views.js';
import { cutoffHz, type Point } from '../../../daw/model/synth-views.js';
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

/** Two cycles of a VCO, from the engine's own sample function. */
export function AnalogWaveView(
  { shape, width, pw, height }: {
    shape: number; pw: number; width: number; height: number;
  },
): React.ReactElement {
  const ref = useCanvas((ctx, w, h) => {
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath(); ctx.moveTo(0, h / 2 + 0.5); ctx.lineTo(w, h / 2 + 0.5); ctx.stroke();
    ctx.strokeStyle = premium.accent.base;
    ctx.lineWidth = 1.6;
    stroke(ctx, analogWavePoints(shape, pw), w, h);
  }, width, height, [shape, pw]);
  return <canvas ref={ref} />;
}

/**
 * The ladder's response, on a log frequency axis.
 *
 * Two curves, not one: the faint one is the same filter with the resonance
 * at zero, and the gap between them at the bottom is the bass the feedback is
 * taking away.  That loss is the thing everybody knows about a ladder and the
 * thing a number cannot show, and BASS COMP closes the gap in front of you.
 */
export function LadderView(
  { poles, cutoffSemis, res, compensation, width, height }: {
    poles: number; cutoffSemis: number; res: number; compensation: number;
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

    const curve = (r: number, c: number): Point[] => {
      const pts: Point[] = [];
      for (let i = 0; i < w; i++) {
        const hz = min * Math.pow(max / min, i / (w - 1));
        const db = ladderResponseDb(poles, fc, r, c, hz);
        pts.push({ x: i / (w - 1), y: Math.max(0, Math.min(1, (top - db) / (top - bottom))) });
      }
      return pts;
    };

    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    stroke(ctx, curve(0, compensation), w, h);

    ctx.strokeStyle = premium.accent.base;
    ctx.lineWidth = 1.6;
    stroke(ctx, curve(res, compensation), w, h);

    const cx = Math.round((Math.log2(fc / min) / Math.log2(max / min)) * w) + 0.5;
    ctx.strokeStyle = 'rgba(126,200,255,0.45)';
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke();
    ctx.fillStyle = premium.text.muted;
    ctx.font = '8px ui-monospace, monospace';
    ctx.fillText(fc >= 1000 ? `${(fc / 1000).toFixed(1)}k` : `${Math.round(fc)}`, Math.min(w - 22, cx + 3), 9);
  }, width, height, [poles, cutoffSemis, res, compensation]);
  return <canvas ref={ref} />;
}

/**
 * The analogue ADSR, with the straight-line version behind it.
 *
 * The faint line is the same settings at curve 0 — a digital envelope — so
 * the ENV CURVE knob shows what it is buying rather than moving a line by an
 * amount nobody can judge against nothing.
 */
export function AnalogEnvView(
  { attack, decay, sustain, release, curve, width, height }: {
    attack: number; decay: number; sustain: number; release: number; curve: number;
    width: number; height: number;
  },
): React.ReactElement {
  const ref = useCanvas((ctx, w, h) => {
    const shape = analogEnvPoints(attack, decay, sustain, release, curve);
    const gx = shape.releaseAt * w;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    stroke(ctx, analogEnvPoints(attack, decay, sustain, release, 0).points, w, h);

    ctx.strokeStyle = premium.accent.base;
    ctx.lineWidth = 1.6;
    stroke(ctx, shape.points, w, h);
    ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
    ctx.fillStyle = 'rgba(230,210,160,0.10)';
    ctx.fill();
  }, width, height, [attack, decay, sustain, release, curve]);
  return <canvas ref={ref} />;
}

/**
 * Ten seconds of drift, and the voices' component spread beside it.
 *
 * These two are the instrument's whole claim to being analogue and they are
 * the two controls whose numbers say least.  The scale is FIXED at the knob's
 * own maximum, so drift 1 and drift 25 do not draw the same line.
 */
export function AnalogCharacterView(
  { drift, tolerance, voices, width, height }: {
    drift: number; tolerance: number; voices: number; width: number; height: number;
  },
): React.ReactElement {
  const ref = useCanvas((ctx, w, h) => {
    const bandH = h * 0.56;
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath(); ctx.moveTo(0, bandH / 2 + 0.5); ctx.lineTo(w, bandH / 2 + 0.5); ctx.stroke();

    // One line per oscillator of one voice: they drift independently, which
    // is the reason two oscillators at the same pitch beat at all.
    const seeds = [0, 101, 7, 108];
    seeds.forEach((seed, i) => {
      ctx.strokeStyle = i === 0 ? premium.accent.base : `rgba(126,200,255,${(0.32 - i * 0.07).toFixed(2)})`;
      ctx.lineWidth = i === 0 ? 1.4 : 1;
      stroke(ctx, driftPoints(drift, seed), w, bandH);
    });
    ctx.fillStyle = premium.text.faint;
    ctx.font = '8px ui-monospace, monospace';
    ctx.fillText(`±${Math.round(drift)} / 25 ct · 10 s`, 3, 9);

    // The voices, as the heights their components came out at.
    const rows = voiceRows(voices, tolerance);
    const y0 = bandH + 6;
    const barH = Math.max(3, (h - y0 - 2) / Math.max(1, rows.length));
    rows.forEach((row, i) => {
      const dev = (row.cutoff - 1) / Math.max(1e-6, tolerance || 1);
      const mid = w * 0.5;
      const len = dev * w * 0.42;
      ctx.fillStyle = 'rgba(126,200,255,0.55)';
      ctx.fillRect(Math.min(mid, mid + len), y0 + i * barH, Math.max(1, Math.abs(len)), Math.max(1, barH - 1.5));
    });
    ctx.strokeStyle = 'rgba(255,255,255,0.20)';
    ctx.beginPath(); ctx.moveTo(w * 0.5 + 0.5, y0); ctx.lineTo(w * 0.5 + 0.5, h); ctx.stroke();
    ctx.fillStyle = premium.text.faint;
    ctx.fillText(`${rows.length} voices · ±${(tolerance * 100).toFixed(1)}%`, 3, y0 - 1);
  }, width, height, [drift, tolerance, voices]);
  return <canvas ref={ref} />;
}
