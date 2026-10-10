// The four pictures on the FM synth's panel.
//
// All of them take their points from `fm-views.ts` in 0…1 space and do one
// multiply per axis, so nothing here can disagree with what the engine does —
// the maths is checked in `fm-panel-selftest` and the drawing has no
// arithmetic of its own to be wrong.

import React, { useEffect, useRef } from 'react';
import {
  layoutAt, operatorEnvPoints, operatorWavePoints, patchSpectrum,
  SPECTRUM_RATE,
} from '../../../daw/model/fm-views.js';
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
 * The algorithm, as the graph it is.
 *
 * The picture this panel exists for.  "Algorithm 15" is a page reference and
 * not a description; six boxes with arrows between them is the description,
 * and it is drawn from the same connection list the render loop walks.
 *
 * Carriers are filled, because they are the ones you hear.  The selected
 * operator is outlined, so the controls below always have a visible subject.
 * The feedback operator gets a loop back into itself, which is the only
 * backwards path the engine has.
 */
export function AlgorithmView(
  { algo, selected, feedbackOp, feedback, onPick, width, height }: {
    algo: number; selected: number; feedbackOp: number; feedback: number;
    onPick?: (op: number) => void; width: number; height: number;
  },
): React.ReactElement {
  const layout = layoutAt(algo);
  const ref = useCanvas((ctx, w, h) => {
    const bw = layout.halfW * 2 * w;
    const bh = Math.min(layout.halfH * 2 * h, 22);
    const at = (op: number): Point => {
      const b = layout.boxes[op];
      return { x: (b?.x ?? 0.5) * w, y: (b?.y ?? 0.5) * h };
    };

    ctx.lineWidth = 1;
    for (const e of layout.edges) {
      const from = at(e.from);
      const to = at(e.to);
      ctx.strokeStyle = 'rgba(126,200,255,0.42)';
      ctx.beginPath();
      ctx.moveTo(from.x, from.y + bh / 2);
      // A vertical drop, a horizontal run at the midpoint, then a vertical
      // arrival — an orthogonal route, so two edges crossing read as crossing
      // rather than as a join.
      const mid = (from.y + bh / 2 + to.y - bh / 2) / 2;
      ctx.lineTo(from.x, mid);
      ctx.lineTo(to.x, mid);
      ctx.lineTo(to.x, to.y - bh / 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(to.x - 3, to.y - bh / 2 - 4);
      ctx.lineTo(to.x, to.y - bh / 2);
      ctx.lineTo(to.x + 3, to.y - bh / 2 - 4);
      ctx.stroke();
    }

    if (feedback > 0.001) {
      const f = at(feedbackOp);
      ctx.strokeStyle = premium.accent.base;
      ctx.beginPath();
      ctx.moveTo(f.x + bw / 2, f.y - bh / 4);
      ctx.lineTo(f.x + bw / 2 + 7, f.y - bh / 4);
      ctx.lineTo(f.x + bw / 2 + 7, f.y + bh / 4);
      ctx.lineTo(f.x + bw / 2, f.y + bh / 4);
      ctx.stroke();
    }

    for (const b of layout.boxes) {
      const x = b.x * w;
      const y = b.y * h;
      ctx.fillStyle = b.carrier ? 'rgba(126,200,255,0.22)' : 'rgba(255,255,255,0.05)';
      ctx.strokeStyle = b.op === selected ? premium.accent.base : 'rgba(255,255,255,0.22)';
      ctx.lineWidth = b.op === selected ? 1.8 : 1;
      ctx.beginPath();
      ctx.rect(x - bw / 2, y - bh / 2, bw, bh);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = b.carrier ? premium.accent.light : premium.text.muted;
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(b.op + 1), x, y + 0.5);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }, width, height, [algo, selected, feedbackOp, feedback]);

  // Clicking a box selects that operator, which is the shortest path from
  // "that one is too bright" to the knob that fixes it.
  const click = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    if (!onPick) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    let best = -1;
    let bestD = Infinity;
    for (const b of layout.boxes) {
      const d = Math.hypot((b.x - x) * 2, b.y - y);
      if (d < bestD) { bestD = d; best = b.op; }
    }
    if (best >= 0 && bestD < 0.35) onPick(best);
  };
  return <canvas ref={ref} onClick={click} style={{ cursor: onPick ? 'pointer' : 'default' }} />;
}

/** One operator's envelope, with the moment the key lifts marked. */
export function FmEnvView(
  { attack, decay, sustain, release, width, height }: {
    attack: number; decay: number; sustain: number; release: number;
    width: number; height: number;
  },
): React.ReactElement {
  const ref = useCanvas((ctx, w, h) => {
    const shape = operatorEnvPoints(attack, decay, sustain, release);
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

/** Two cycles of the selected operator's wave. */
export function FmWaveView(
  { wave, width, height }: { wave: number; width: number; height: number },
): React.ReactElement {
  const ref = useCanvas((ctx, w, h) => {
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath(); ctx.moveTo(0, h / 2 + 0.5); ctx.lineTo(w, h / 2 + 0.5); ctx.stroke();
    ctx.strokeStyle = premium.accent.base;
    ctx.lineWidth = 1.5;
    stroke(ctx, operatorWavePoints(wave), w, h);
  }, width, height, [wave]);
  return <canvas ref={ref} />;
}

/**
 * The patch's own spectrum, rendered through the engine.
 *
 * The one thing about an FM patch that cannot be read off its controls: six
 * ratios and six levels do not say where the partials will land.  A fifth of
 * a second at 16 kHz costs about a millisecond and a half, so this redraws
 * whenever a knob is released.
 */
export function FmSpectrumView(
  { params, width, height }: {
    params: Readonly<Record<string, number>>; width: number; height: number;
  },
): React.ReactElement {
  const ref = useCanvas((ctx, w, h) => {
    const bins = patchSpectrum(params);
    const min = 40;
    const max = SPECTRUM_RATE / 2;
    const top = 0;
    const bottom = -78;
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    for (const hz of [100, 1000]) {
      const x = Math.round((Math.log2(hz / min) / Math.log2(max / min)) * w) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    }
    ctx.strokeStyle = premium.accent.base;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const b of bins) {
      if (b.hz < min) continue;
      const x = (Math.log2(b.hz / min) / Math.log2(max / min)) * w;
      const y = Math.max(0, Math.min(h, ((top - b.db) / (top - bottom)) * h));
      ctx.moveTo(x, h);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = premium.text.faint;
    ctx.font = '8px ui-monospace, monospace';
    ctx.fillText('C4 · 8 kHz 까지', 3, 9);
  }, width, height, [params]);
  return <canvas ref={ref} />;
}
