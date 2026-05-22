// NativeSpectrumCanvas — a self-contained WebAudio spectrum (no WASM, no
// external lib).  Reads a raw AnalyserNode via requestAnimationFrame and
// draws log-spaced frequency bars.  Always renders something: when there is
// no analyser or no audio, the bars decay to a flat baseline (never blank).
//
// This is a REAL product surface, not a debug widget — it is the guaranteed
// fallback spectrum so "no spectrum visible" can never happen.

import React, { useEffect, useRef } from 'react';

export interface NativeSpectrumCanvasProps {
  analyser: AnalyserNode | null;
  /** Number of bars to draw (log-spaced across the audible band). */
  bars?: number;
  /** Accent colour for the bars. */
  color?: string;
}

export function NativeSpectrumCanvas({ analyser, bars = 96, color = '#a78bfa' }: NativeSpectrumCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const analyserRef = useRef<AnalyserNode | null>(analyser);
  analyserRef.current = analyser;
  // Smoothed bar heights (0..1) for a graceful fall when audio stops.
  const heightsRef = useRef<Float32Array>(new Float32Array(bars));

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const resize = () => {
      dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      const w = wrap.clientWidth, h = wrap.clientHeight;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    };
    resize();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    ro?.observe(wrap);

    let raf = 0;
    let freq: Uint8Array<ArrayBuffer> | null = null;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const a = analyserRef.current;
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);

      // Baseline grid line.
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = dpr;
      ctx.beginPath();
      ctx.moveTo(0, H - dpr);
      ctx.lineTo(W, H - dpr);
      ctx.stroke();

      const heights = heightsRef.current;
      if (a) {
        if (!freq || freq.length !== a.frequencyBinCount) freq = new Uint8Array(new ArrayBuffer(a.frequencyBinCount));
        a.getByteFrequencyData(freq);
        const nyquist = a.context.sampleRate / 2;
        const fMin = 20, fMax = Math.min(20_000, nyquist);
        const logMin = Math.log10(fMin), logMax = Math.log10(fMax);
        const bins = freq;
        for (let b = 0; b < bars; b++) {
          // Log-spaced band edges → average the bins inside.
          const f0 = Math.pow(10, logMin + (logMax - logMin) * (b / bars));
          const f1 = Math.pow(10, logMin + (logMax - logMin) * ((b + 1) / bars));
          const i0 = Math.max(0, Math.floor((f0 / nyquist) * bins.length));
          const i1 = Math.max(i0 + 1, Math.ceil((f1 / nyquist) * bins.length));
          let sum = 0, cnt = 0;
          for (let i = i0; i < i1 && i < bins.length; i++) { sum += bins[i] ?? 0; cnt++; }
          const v = cnt > 0 ? (sum / cnt) / 255 : 0;
          // Attack fast, release slow (musical, never jumpy-to-zero).
          const prev = heights[b] ?? 0;
          heights[b] = v > prev ? v : prev * 0.86 + v * 0.14;
        }
      } else {
        for (let b = 0; b < bars; b++) heights[b] = (heights[b] ?? 0) * 0.9;
      }

      const gap = dpr * 1.5;
      const barW = (W - gap * (bars - 1)) / bars;
      for (let b = 0; b < bars; b++) {
        const hv = heights[b] ?? 0;
        const bh = Math.max(dpr, hv * (H - dpr * 2));
        const x = b * (barW + gap);
        const y = H - bh;
        const t = b / bars;
        // Subtle hue shift low→high for readability.
        const g = Math.round(120 + t * 80);
        ctx.fillStyle = hv > 0.001 ? color : `rgba(${g},${g},${g + 20},0.18)`;
        ctx.fillRect(x, y, barW, bh);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); ro?.disconnect(); };
  }, [bars, color]);

  return (
    <div ref={wrapRef} style={{ position: 'absolute', inset: 0 }}>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
    </div>
  );
}
