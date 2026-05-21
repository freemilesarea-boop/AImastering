// EQCurveOverlay — approximate EQ response curve over the spectrum
// (OZONE-STYLE-MODULE-SUITE).
//
// Draws a *visual approximation* of the Loui EQ bands (low cut / low shelf
// / presence / air + output gain) as an SVG path on a log-frequency axis.
// It mirrors the preview EQ's direction (not a sample-accurate biquad
// plot) — labelled "approximate" in the UI so it is never mistaken for a
// measured curve.

import React from 'react';
import { loui, louiAlpha } from '../../../theme/loui-home.js';

export interface EqBands {
  lowCutHz: number;
  lowShelfDb: number;
  presenceDb: number;
  airDb: number;
  outputGainDb: number;
}

export interface EQCurveOverlayProps {
  width: number;
  height: number;
  bands: EqBands;
  /** Frequency axis range. */
  minHz?: number;
  maxHz?: number;
  /** dB range for the vertical axis. */
  dbRange?: number;
  /** Dim the curve when the EQ module is bypassed. */
  bypassed?: boolean;
}

const logF = (f: number, min: number, max: number) =>
  (Math.log10(f) - Math.log10(min)) / (Math.log10(max) - Math.log10(min));

/** Rough magnitude (dB) approximation — visual direction, not exact. */
function responseDb(f: number, b: EqBands): number {
  let db = b.outputGainDb;
  // High-pass: ~12 dB/oct rolloff below the corner.
  if (f < b.lowCutHz) db -= Math.min(24, 12 * Math.log2(b.lowCutHz / Math.max(1, f)));
  // Low shelf at 120 Hz.
  db += b.lowShelfDb / (1 + Math.pow(f / 120, 2));
  // Presence bell at 3 kHz (Q≈1.1).
  db += b.presenceDb * Math.exp(-Math.pow(Math.log2(f / 3000) * 1.1, 2));
  // Air shelf at 12 kHz.
  db += b.airDb / (1 + Math.pow(12000 / Math.max(1, f), 2));
  return db;
}

export function EQCurveOverlay({
  width, height, bands, minHz = 20, maxHz = 20000, dbRange = 12, bypassed = false,
}: EQCurveOverlayProps) {
  if (width <= 0 || height <= 0) return null;
  const steps = 96;
  const dbToY = (db: number) => height / 2 - (db / dbRange) * (height / 2);
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const f = Math.pow(10, Math.log10(minHz) + t * (Math.log10(maxHz) - Math.log10(minHz)));
    const x = logF(f, minHz, maxHz) * width;
    const y = Math.max(2, Math.min(height - 2, dbToY(responseDb(f, bands))));
    d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)} `;
  }
  const stroke = bypassed ? louiAlpha.lav(0.25) : loui.primaryLavender;
  return (
    <svg width={width} height={height} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} aria-hidden>
      {/* 0 dB reference line */}
      <line x1={0} y1={height / 2} x2={width} y2={height / 2} stroke="rgba(255,255,255,0.10)" strokeWidth={1} strokeDasharray="3 4" />
      <path d={d} fill="none" stroke={stroke} strokeWidth={2} strokeLinejoin="round" />
    </svg>
  );
}
