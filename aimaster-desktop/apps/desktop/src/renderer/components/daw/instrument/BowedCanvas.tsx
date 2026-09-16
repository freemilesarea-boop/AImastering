// The three pictures on the bowed string's panel.
//
// All three take their numbers from `bowed-views.ts`, which takes them from
// the engine — the cycle straight out of the loop that makes the sound, the
// spectrum from a rendered note, the body from the same filter cascade the
// signal goes through.  Nothing here computes anything about the instrument;
// it multiplies by the width and the height.

import React, { useEffect, useRef } from 'react';
import {
  bodyCurve, bodyX, type BowCycle, type BowRegime, type BowSpectrum,
} from '../../../daw/model/bowed-views.js';
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
  pts.forEach((pt, i) => {
    const x = pt.x * w;
    const y = pt.y * h;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

export const REGIME_LABEL: Readonly<Record<BowRegime, string>> = {
  surface: '표면음',
  helmholtz: '헬름홀츠',
  pressed: '과압',
};

export const REGIME_NOTE: Readonly<Record<BowRegime, string>> = {
  surface: '활 압력이 최소 아래입니다 — 한 주기에 여러 번 놓쳐서 바람 소리가 납니다. '
    + '초보자의 소리이자 술 타스토의 소리이고, 둘 다 일부러 쓰는 것입니다',
  helmholtz: '붙었다 한 번 놓고 돌아옵니다 — 이게 현악기 소리의 전부입니다',
  pressed: '활을 너무 눌렀습니다 — 붙어 있는 구간이 길어져 소리가 억지스러워집니다',
};

const REGIME_COLOUR: Readonly<Record<BowRegime, string>> = {
  surface: 'rgba(150,170,210,0.9)',
  helmholtz: 'rgba(230,210,160,0.95)',
  pressed: 'rgba(225,150,120,0.95)',
};

/**
 * The stick-slip cycle at the bow, for one period.
 *
 * The plateau is the string riding with the bow; the excursion is it flying
 * back.  Helmholtz motion is one of each per period and the plateau's share
 * of the width is (1−β), which is drawn as a marker so the picture says what
 * it should be as well as what it is.
 */
export function CycleView(
  { cycle, width, height }: { cycle: BowCycle; width: number; height: number },
): React.ReactElement {
  const ref = useCanvas((ctx, w, h) => {
    const pad = 12;
    const inner = h - pad;

    // Where the stick SHOULD end, if the motion is Helmholtz.
    const markX = cycle.idealStuck * w;
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(0, 0, markX, inner);
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(markX, 0); ctx.lineTo(markX, inner); ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = REGIME_COLOUR[cycle.regime];
    ctx.lineWidth = 1.4;
    stroke(ctx, cycle.points.map((q) => ({ x: q.x, y: q.y * (inner / h) })), w, h);

    ctx.font = '8px ui-monospace, monospace';
    ctx.fillStyle = premium.text.faint;
    ctx.fillText('붙음 ↔ 미끄러짐', 2, h - 2);
    const right = `${cycle.periodMs.toFixed(1)} ms · 한 주기`;
    ctx.fillText(right, Math.max(0, w - ctx.measureText(right).width - 2), h - 2);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillText(`1−β = ${(cycle.idealStuck * 100).toFixed(0)}%`, Math.min(w - 52, markX + 3), 9);
  }, width, height, [cycle]);
  return <canvas ref={ref} />;
}

/**
 * The bridge's harmonics against the sawtooth they are supposed to be.
 *
 * Bars for what the string does, a stepped line for 1/n.  Two things show:
 * that the spectrum IS a sawtooth, and the notch the bow's position puts at
 * harmonic 1/β — which is the whole of sul ponticello and sul tasto.
 */
export function SpectrumView(
  { spec, width, height }: { spec: BowSpectrum; width: number; height: number },
): React.ReactElement {
  const ref = useCanvas((ctx, w, h) => {
    const pad = 11;
    const inner = h - pad;
    const n = spec.harmonics.length;
    const step = w / n;
    const yOf = (dbv: number): number =>
      inner * (1 - (Math.max(spec.floorDb, Math.min(0, dbv)) - spec.floorDb) / -spec.floorDb);

    for (let k = 0; k < n; k++) {
      const v = spec.harmonics[k]!;
      const x = k * step;
      const isComb = k + 1 === spec.combAt || k + 1 === spec.combAt * 2;
      ctx.fillStyle = isComb ? 'rgba(225,150,120,0.75)' : 'rgba(230,210,160,0.55)';
      if (Number.isFinite(v)) {
        const y = yOf(v);
        ctx.fillRect(x + 1, y, Math.max(1, step - 2), inner - y);
      }
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.setLineDash([3, 2]);
    ctx.beginPath();
    for (let k = 0; k < n; k++) {
      const y = yOf(spec.sawtooth[k]!);
      const x = k * step;
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      ctx.lineTo(x + step, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = '8px ui-monospace, monospace';
    ctx.fillStyle = premium.text.faint;
    ctx.fillText('배음 · 점선은 톱니파 1/n', 2, h - 2);
    const right = `빗살 h${spec.combAt}`;
    ctx.fillStyle = 'rgba(225,150,120,0.9)';
    ctx.fillText(right, Math.max(0, w - ctx.measureText(right).width - 2), h - 2);
  }, width, height, [spec]);
  return <canvas ref={ref} />;
}

/**
 * The body, as the response the string is heard through.
 *
 * The corpus modes and the bridge hill, marked — because which instrument
 * this is, is those four numbers and nothing else about the string.
 */
export function BodyView(
  { params, width, height }: {
    params: Readonly<Record<string, number>>; width: number; height: number;
  },
): React.ReactElement {
  const body = bodyCurve(params);
  const ref = useCanvas((ctx, w, h) => {
    const pad = 11;
    const inner = h - pad;
    const zero = inner * (1 - (0 - body.bottomDb) / (body.topDb - body.bottomDb));
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath(); ctx.moveTo(0, zero + 0.5); ctx.lineTo(w, zero + 0.5); ctx.stroke();

    ctx.strokeStyle = 'rgba(230,210,160,0.9)';
    ctx.lineWidth = 1.4;
    stroke(ctx, body.curve.map((q) => ({ x: q.x, y: q.y * (inner / h) })), w, h);

    ctx.font = '8px ui-monospace, monospace';
    for (const m of body.marks) {
      const x = bodyX(m.hz, body.fromHz, body.toHz) * w;
      ctx.strokeStyle = 'rgba(255,255,255,0.16)';
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, inner); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.fillText(m.label, Math.min(w - 26, x + 2), 9);
    }
    ctx.fillStyle = premium.text.faint;
    ctx.fillText('30 Hz', 2, h - 2);
    const right = '12 kHz';
    ctx.fillText(right, Math.max(0, w - ctx.measureText(right).width - 2), h - 2);
  }, width, height, [params]);
  return <canvas ref={ref} />;
}
