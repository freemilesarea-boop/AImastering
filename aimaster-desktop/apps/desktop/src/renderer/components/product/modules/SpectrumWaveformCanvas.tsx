// SpectrumWaveformCanvas — DPR-aware log-frequency spectrum canvas
// (OZONE-STYLE-MODULE-SUITE).
//
// Draws a charcoal spectrum from magnitude data + optional peak-hold and a
// playhead.  Redraws only when its inputs change (no free-running RAF) so
// the analyzer + UI stay within budget — the caller feeds frames at the
// analyzer's cadence (≤30 Hz).

import React, { useEffect, useRef } from 'react';
import { loui, louiAlpha } from '../../../theme/loui-home.js';

export interface SpectrumWaveformCanvasProps {
  width: number;
  height: number;
  /** Per-bin centre frequencies (Hz), ascending. */
  binCentresHz: number[];
  /** Per-bin magnitude in dB (same length as binCentresHz). */
  magnitudeDb: number[];
  /** Optional peak-hold dB per bin. */
  peakHoldDb?: number[];
  minHz?: number;
  maxHz?: number;
  /** dB display floor / ceiling. */
  minDb?: number;
  maxDb?: number;
  /** Playhead position 0..1 (optional). */
  playhead?: number;
}

const logX = (f: number, min: number, max: number) =>
  (Math.log10(Math.max(1, f)) - Math.log10(min)) / (Math.log10(max) - Math.log10(min));

export function SpectrumWaveformCanvas(props: SpectrumWaveformCanvasProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const {
    width, height, binCentresHz, magnitudeDb, peakHoldDb,
    minHz = 20, maxHz = 20000, minDb = -90, maxDb = 0, playhead,
  } = props;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || width <= 0 || height <= 0) return;
    const dpr = Math.min(2, (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Charcoal backdrop.
    ctx.fillStyle = '#1A1A24';
    ctx.fillRect(0, 0, width, height);

    // Grid (log freq).
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.fillStyle = 'rgba(255,255,255,0.40)';
    ctx.lineWidth = 1;
    ctx.font = '10px ui-monospace';
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
      const x = logX(f, minHz, maxHz) * width;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 2, height - 4);
    }

    const dbToY = (db: number) => {
      const t = (db - minDb) / (maxDb - minDb);
      return height - Math.max(0, Math.min(1, t)) * height;
    };

    // Spectrum fill.
    if (binCentresHz.length > 1 && binCentresHz.length === magnitudeDb.length) {
      ctx.beginPath();
      ctx.moveTo(0, height);
      for (let i = 0; i < binCentresHz.length; i++) {
        const x = logX(binCentresHz[i]!, minHz, maxHz) * width;
        const y = dbToY(magnitudeDb[i]!);
        ctx.lineTo(x, y);
      }
      ctx.lineTo(width, height);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, 0, 0, height);
      grad.addColorStop(0, louiAlpha.lav(0.55));
      grad.addColorStop(1, louiAlpha.lav(0.05));
      ctx.fillStyle = grad;
      ctx.fill();

      // Spectrum line.
      ctx.beginPath();
      for (let i = 0; i < binCentresHz.length; i++) {
        const x = logX(binCentresHz[i]!, minHz, maxHz) * width;
        const y = dbToY(magnitudeDb[i]!);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = loui.primaryLavender;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Peak hold.
    if (peakHoldDb && peakHoldDb.length === binCentresHz.length) {
      ctx.beginPath();
      for (let i = 0; i < binCentresHz.length; i++) {
        const x = logX(binCentresHz[i]!, minHz, maxHz) * width;
        const y = dbToY(peakHoldDb[i]!);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = louiAlpha.lav(0.5);
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Playhead.
    if (typeof playhead === 'number') {
      const px = Math.max(0, Math.min(1, playhead)) * width;
      ctx.strokeStyle = loui.softLavender;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, height); ctx.stroke();
    }
  }, [width, height, binCentresHz, magnitudeDb, peakHoldDb, minHz, maxHz, minDb, maxDb, playhead]);

  return <canvas ref={ref} style={{ width, height, display: 'block', borderRadius: 10 }} />;
}
