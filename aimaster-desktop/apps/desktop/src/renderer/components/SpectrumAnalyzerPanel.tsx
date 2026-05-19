// SpectrumAnalyzerPanel — live FFT spectrum visualiser.
//
// Subscribes to `FftFrame` events from an AnalyzerSession, draws them on
// a canvas at ~30 fps.  Log-frequency X axis, dB Y axis.  Peak-hold
// overlay.  Resize-safe via ResizeObserver.
//
// This is the foundational component for M3's Ozone-style live spectrum
// panel.  Not yet wired into any page — proves the streaming → canvas
// path works.

import { useEffect, useRef } from 'react';
import { useAnalyzerStream } from '../hooks/useAnalyzerStream.js';
import { SyntheticAnalyzerSessionFactory } from '../audio/analyzer-session-synthetic.js';
import type {
  AnalyzerSessionFactory,
  AnalyzerSessionOptions,
  FftFrame,
} from '@aimaster/shared-types/streaming';

export interface SpectrumAnalyzerPanelProps {
  factory?: AnalyzerSessionFactory;
  sessionOptions?: AnalyzerSessionOptions;
  /** Min/max dB rendered on the Y axis. */
  dbRange?: { min: number; max: number };
  /** Min/max Hz rendered on the X axis (logarithmic). */
  hzRange?: { min: number; max: number };
  /** Whether to draw the peak-hold trace. */
  showPeakHold?: boolean;
}

const DEFAULT_FACTORY = new SyntheticAnalyzerSessionFactory();
const DEFAULT_OPTIONS: AnalyzerSessionOptions = { sampleRate: 48_000, channels: 2 };

/** Log10-X interpolation: convert frequency to a 0..1 X coordinate. */
function freqToX(freq: number, minHz: number, maxHz: number): number {
  const lmin = Math.log10(minHz);
  const lmax = Math.log10(maxHz);
  const lf = Math.log10(Math.max(minHz, Math.min(maxHz, freq)));
  return (lf - lmin) / (lmax - lmin);
}

/** dB to 0..1 Y coordinate (inverted so high dB is at the top). */
function dbToY(db: number, minDb: number, maxDb: number): number {
  if (!Number.isFinite(db)) return 1;
  const t = (db - minDb) / (maxDb - minDb);
  return 1 - Math.max(0, Math.min(1, t));
}

export function SpectrumAnalyzerPanel(props: SpectrumAnalyzerPanelProps = {}) {
  const factory = props.factory ?? DEFAULT_FACTORY;
  const sessionOptions = props.sessionOptions ?? DEFAULT_OPTIONS;
  const dbRange = props.dbRange ?? { min: -90, max: 0 };
  const hzRange = props.hzRange ?? { min: 20, max: 20_000 };
  const showPeakHold = props.showPeakHold ?? true;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dprRef = useRef(1);
  // Keep the latest frame in a ref so the animation loop reads it without
  // forcing React re-renders on every frame.
  const frameRef = useRef<FftFrame | null>(null);

  const { fft } = useAnalyzerStream({
    factory,
    sessionOptions,
    enableFft: true,
  });

  // Stash the frame for the RAF loop.
  useEffect(() => { frameRef.current = fft; }, [fft]);

  // Resize-safe + DPR-aware canvas backing store.
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (!e) return;
      const dpr = window.devicePixelRatio ?? 1;
      dprRef.current = dpr;
      const w = Math.floor(e.contentRect.width  * dpr);
      const h = Math.floor(e.contentRect.height * dpr);
      if (canvas.width !== w)  canvas.width  = w;
      if (canvas.height !== h) canvas.height = h;
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // Render loop — RAF, throttled to ~60 fps.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let stopped = false;
    let lastDraw = 0;

    function draw(ts: number) {
      if (stopped) return;
      if (ts - lastDraw < 16) {
        requestAnimationFrame(draw);
        return;
      }
      lastDraw = ts;
      // Re-fetch the canvas reference inside the loop in case of remount.
      const c = canvasRef.current;
      if (!c) {
        requestAnimationFrame(draw);
        return;
      }
      const ctx = c.getContext('2d');
      const frame = frameRef.current;
      if (!ctx) {
        requestAnimationFrame(draw);
        return;
      }
      const w = c.width;
      const h = c.height;

      ctx.fillStyle = '#09090b';
      ctx.fillRect(0, 0, w, h);

      // Grid (log-frequency).
      ctx.strokeStyle = '#27272a';
      ctx.lineWidth = 1;
      ctx.font = '10px ui-monospace';
      ctx.fillStyle = '#52525b';
      const gridFreqs = [50, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000];
      for (const f of gridFreqs) {
        const x = freqToX(f, hzRange.min, hzRange.max) * w;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
        const label = f >= 1000 ? `${f / 1000}k` : `${f}`;
        ctx.fillText(label, x + 3, h - 4);
      }
      // dB lines every 12 dB.
      for (let d = dbRange.min; d <= dbRange.max; d += 12) {
        const y = dbToY(d, dbRange.min, dbRange.max) * h;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
        if (d !== dbRange.min && d !== dbRange.max) {
          ctx.fillText(`${d}`, 4, y - 3);
        }
      }

      if (frame) {
        const n = frame.binCentresHz.length;
        // Magnitude trace (filled).
        ctx.beginPath();
        ctx.moveTo(0, h);
        for (let i = 0; i < n; i++) {
          const x = freqToX(frame.binCentresHz[i]!, hzRange.min, hzRange.max) * w;
          const y = dbToY(frame.magnitudeDb[i]!, dbRange.min, dbRange.max) * h;
          if (i === 0) ctx.moveTo(x, y);
          else         ctx.lineTo(x, y);
        }
        ctx.lineTo(w, h);
        ctx.closePath();
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, 'rgba(167, 139, 250, 0.55)');
        grad.addColorStop(1, 'rgba(167, 139, 250, 0.05)');
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.strokeStyle = '#a78bfa';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Peak hold (line only).
        if (showPeakHold && frame.peakHoldDb) {
          ctx.beginPath();
          for (let i = 0; i < n; i++) {
            const x = freqToX(frame.binCentresHz[i]!, hzRange.min, hzRange.max) * w;
            const y = dbToY(frame.peakHoldDb[i]!, dbRange.min, dbRange.max) * h;
            if (i === 0) ctx.moveTo(x, y);
            else         ctx.lineTo(x, y);
          }
          ctx.strokeStyle = 'rgba(244, 244, 245, 0.6)';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      requestAnimationFrame(draw);
    }

    requestAnimationFrame(draw);
    return () => { stopped = true; };
  }, [dbRange.min, dbRange.max, hzRange.min, hzRange.max, showPeakHold]);

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <div className="text-sm font-medium text-zinc-200">Spectrum · live FFT</div>
        <div className="text-xs text-zinc-500 font-mono tabular-nums">
          {fft ? `${fft.fftSize} pts · ${fft.binCentresHz.length} bins` : 'awaiting frames…'}
        </div>
      </div>
      <div ref={containerRef} className="relative h-48 w-full overflow-hidden rounded-md bg-black">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full"
          style={{ imageRendering: 'pixelated' }}
        />
      </div>
    </div>
  );
}
