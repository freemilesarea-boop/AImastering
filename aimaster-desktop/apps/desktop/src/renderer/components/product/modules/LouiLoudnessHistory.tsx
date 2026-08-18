// LouiLoudnessHistory — sparkline of short-term loudness over the last
// ~30 s, with a target-LUFS reference line.  Helps the user see how
// dynamic / consistent the master is across the song.
//
// Data source: the always-on native analyzer (RMS-derived loudness).
// We sample at ~10 Hz so a 30 s window = 300 points (cheap to draw).
//
// Honest scope:
//   • dBFS-based loudness approximation, NOT a calibrated BS.1770 LUFS
//     line — labelled "Short" so the user knows.
//   • The reference line is the target LUFS the engine was set to (when
//     provided), drawn so the user can see how the song sits around it.

import React, { useEffect, useMemo, useRef } from 'react';
import { surface, text, typography, meterLiteral } from '../../../theme/loui-theme.js';
import { useMediaElement } from '../../../audio/media-element-context.js';
import { useNativeAnalyzer } from '../../../hooks/useNativeAnalyzer.js';

export interface LouiLoudnessHistoryProps {
  /** Reference line — typically the engine target LUFS. */
  targetLufs?: number;
  /** Height of the canvas in CSS px (width fills parent). */
  height?: number;
  /** Window length in seconds. */
  windowSec?: number;
}

const SAMPLE_HZ = 10;

export function LouiLoudnessHistory({ targetLufs, height = 56, windowSec = 30 }: LouiLoudnessHistoryProps) {
  const media = useMediaElement();
  const analyzer = useNativeAnalyzer(media);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const capacity = windowSec * SAMPLE_HZ;
  // Ring buffer: NaN = no sample yet (drawn as a gap).
  const bufferRef = useRef<Float32Array>(new Float32Array(capacity).fill(NaN));
  const headRef = useRef(0);
  const lastSampleAtRef = useRef(0);

  // Reset buffer when the source / capacity changes (avoids stale data from
  // a previous track bleeding into the new one).
  const src = media?.currentSrc ?? '';
  useEffect(() => {
    bufferRef.current = new Float32Array(capacity).fill(NaN);
    headRef.current = 0;
    lastSampleAtRef.current = 0;
  }, [src, capacity]);

  // Sample + redraw on every analyzer state mirror (~15 Hz).  Throttle the
  // ring-buffer write to SAMPLE_HZ so 30 s really maps to 300 points.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const resize = () => {
      const w = wrap.clientWidth;
      const h = height;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    };
    resize();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    ro?.observe(wrap);

    // dBFS range visible on the Y axis.  Wide enough to cover quiet AI
    // material (-30) and loud streaming targets (-8) without clipping the
    // line off the canvas.
    const MIN_DB = -36;
    const MAX_DB = -4;
    const dbToY = (db: number, h: number) => {
      if (!Number.isFinite(db)) return h;
      const t = (db - MIN_DB) / (MAX_DB - MIN_DB);
      return h - Math.max(0, Math.min(1, t)) * h;
    };

    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const now = performance.now();
      // 1) Sample at SAMPLE_HZ.
      if (now - lastSampleAtRef.current >= 1000 / SAMPLE_HZ) {
        lastSampleAtRef.current = now;
        const m = analyzer.meters;
        // Use short-term (≈3 s EMA) as the moving line — it's the same
        // window broadcasters use for "current loudness" feel.
        const v = m.shortTermDb;
        bufferRef.current[headRef.current] = Number.isFinite(v) ? v : NaN;
        headRef.current = (headRef.current + 1) % capacity;
      }
      // 2) Draw.
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);

      // Grid: dashed target line + soft top/bottom guides.
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = dpr;
      ctx.beginPath();
      ctx.moveTo(0, H - dpr); ctx.lineTo(W, H - dpr);
      ctx.moveTo(0, dpr); ctx.lineTo(W, dpr);
      ctx.stroke();

      if (typeof targetLufs === 'number' && Number.isFinite(targetLufs)) {
        const ty = dbToY(targetLufs, H);
        ctx.strokeStyle = 'rgba(167,139,250,0.55)';
        ctx.setLineDash([4 * dpr, 4 * dpr]);
        ctx.lineWidth = dpr;
        ctx.beginPath();
        ctx.moveTo(0, ty); ctx.lineTo(W, ty);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Plot the ring buffer left-to-right (oldest sample on the left).
      const buf = bufferRef.current;
      const head = headRef.current;
      const stepX = W / capacity;
      // Filled area under the line for visual weight.
      ctx.fillStyle = 'rgba(167,139,250,0.16)';
      ctx.beginPath();
      let started = false;
      let lastX = 0;
      for (let i = 0; i < capacity; i++) {
        const idx = (head + i) % capacity;
        const v = buf[idx]!;
        const x = i * stepX;
        if (!Number.isFinite(v)) {
          if (started) {
            ctx.lineTo(lastX, H);
            ctx.closePath();
            ctx.fill();
            ctx.beginPath();
            started = false;
          }
          continue;
        }
        const y = dbToY(v, H);
        if (!started) {
          ctx.moveTo(x, H);
          ctx.lineTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
        lastX = x;
      }
      if (started) {
        ctx.lineTo(lastX, H);
        ctx.closePath();
        ctx.fill();
      }
      // Stroke on top.
      // `meterLiteral`, not `meter`: the themed scale is CSS variables and
      // a canvas cannot resolve one — assigning it would leave whatever
      // colour was set last.
      ctx.strokeStyle = meterLiteral.accent.foreground;
      ctx.lineWidth = Math.max(1, dpr);
      ctx.beginPath();
      started = false;
      for (let i = 0; i < capacity; i++) {
        const idx = (head + i) % capacity;
        const v = buf[idx]!;
        if (!Number.isFinite(v)) {
          if (started) { ctx.stroke(); ctx.beginPath(); started = false; }
          continue;
        }
        const x = i * stepX;
        const y = dbToY(v, H);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      if (started) ctx.stroke();
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); ro?.disconnect(); };
  }, [analyzer, targetLufs, height, capacity]);

  // Numeric readouts beside the graph — current short-term + min/max in
  // the visible window.  Honest "—" when no data has arrived.
  const summary = useMemo(() => {
    const buf = bufferRef.current;
    let min = Infinity, max = -Infinity, last = NaN;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i]!;
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
      last = v;
    }
    return {
      last: Number.isFinite(last) ? last : null,
      min: Number.isFinite(min) ? min : null,
      max: Number.isFinite(max) ? max : null,
    };
    // Refresh on analyzer state mirror so the side readout updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analyzer.frameCount]);

  const fmt = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)}`);
  const range = summary.min !== null && summary.max !== null ? summary.max - summary.min : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        fontFamily: typography.family.mono, fontSize: typography.size.xs,
        color: text.muted, letterSpacing: '0.04em',
      }}>
        <span>Short {fmt(summary.last)} dB</span>
        <span>{windowSec}s · range {range !== null ? `${range.toFixed(1)} dB` : '—'}</span>
      </div>
      <div ref={wrapRef} style={{
        position: 'relative', width: '100%', height,
        background: surface.well, borderRadius: 4, overflow: 'hidden',
      }}>
        <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
      </div>
    </div>
  );
}
