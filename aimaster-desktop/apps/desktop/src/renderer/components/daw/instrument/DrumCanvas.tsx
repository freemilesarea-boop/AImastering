// The two pictures on the drum machine's panel.
//
// Both take their points from `drum-views.ts` in 0…1 space and do one
// multiply per axis, so nothing here can disagree with what the engine does.

import React, { useEffect, useRef } from 'react';
import { hitShape, kickSweep } from '../../../daw/model/drum-views.js';
import type { DrumVoice } from '../../../daw/engine/drum-machine.js';
import type { Point } from '../../../daw/model/synth-views.js';
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

/**
 * The hit itself, as a waveform.
 *
 * There is no filter in this instrument, so there is no curve to draw.  What
 * a drum voice IS, is a shape a few hundred milliseconds long — and since a
 * drum hit is already short, rendering it and plotting it is not an
 * approximation of the sound, it is the sound.
 *
 * The window is the voice's LONGEST possible tail and the time axis is a
 * square root, so the decay knob visibly shortens the hit and the clap's four
 * bursts are still wide enough to see.  The label carries both: the window in
 * milliseconds and a √t to say the axis is not linear.
 */
export function HitView(
  { voice, params, width, height }: {
    voice: DrumVoice; params: Readonly<Record<string, number>>;
    width: number; height: number;
  },
): React.ReactElement {
  const ref = useCanvas((ctx, w, h) => {
    const shape = hitShape(voice, params, Math.max(60, Math.round(w)));
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath(); ctx.moveTo(0, h / 2 + 0.5); ctx.lineTo(w, h / 2 + 0.5); ctx.stroke();

    ctx.fillStyle = 'rgba(230,210,160,0.18)';
    ctx.beginPath();
    shape.top.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x * w, p.y * h); else ctx.lineTo(p.x * w, p.y * h);
    });
    for (let i = shape.bottom.length - 1; i >= 0; i--) {
      const p = shape.bottom[i]!;
      ctx.lineTo(p.x * w, p.y * h);
    }
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = premium.accent.base;
    ctx.lineWidth = 1;
    stroke(ctx, shape.top, w, h);
    stroke(ctx, shape.bottom, w, h);

    ctx.fillStyle = premium.text.faint;
    ctx.font = '8px ui-monospace, monospace';
    ctx.fillText(`${(shape.seconds * 1000).toFixed(0)} ms · \u221at`, 3, 9);
  }, width, height, [voice, params]);
  return <canvas ref={ref} />;
}

/**
 * The kick's pitch, falling.
 *
 * The one thing a waveform picture cannot show — at fifty hertz a column is
 * wider than a cycle — and the whole difference between this kick and a sine
 * with an envelope on it.  The scale is fixed at the Bend knob's maximum, so
 * Bend 0 and Bend 48 do not draw the same line.
 */
export function SweepView(
  { tuneHz, bend, decay, master, width, height }: {
    tuneHz: number; bend: number; decay: number; master: number;
    width: number; height: number;
  },
): React.ReactElement {
  const ref = useCanvas((ctx, w, h) => {
    const sweep = kickSweep(tuneHz, bend, decay, master);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath(); ctx.moveTo(0, h - 0.5); ctx.lineTo(w, h - 0.5); ctx.stroke();
    ctx.strokeStyle = premium.accent.base;
    ctx.lineWidth = 1.6;
    stroke(ctx, sweep.points, w, h);
    ctx.fillStyle = premium.text.faint;
    ctx.font = '8px ui-monospace, monospace';
    ctx.fillText(`${sweep.topHz.toFixed(0)} → ${sweep.baseHz.toFixed(0)} Hz`, 3, 9);
  }, width, height, [tuneHz, bend, decay, master]);
  return <canvas ref={ref} />;
}
