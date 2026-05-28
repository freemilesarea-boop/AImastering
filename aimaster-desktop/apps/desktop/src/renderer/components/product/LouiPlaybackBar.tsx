// LouiPlaybackBar — smooth, rAF-driven transport progress + waveform overlay.
//
// Reads the <audio> element's currentTime directly each animation frame and
// writes the fill width + time label via DOM refs (NO React re-render per
// frame), so the bar flows continuously instead of stepping with the ~4 Hz
// `timeupdate` event.  Dragging takes priority over the rAF paint; on release
// it commits the seek via onSeek and re-syncs to the element.
//
// The waveform overlay is decoded once per src (cached) and drawn to two
// canvases — a dimmed full waveform + a brighter "played" overlay that is
// clipped to the current progress ratio.  Falls back to a plain progress bar
// when the decode fails or hasn't completed yet.

import React, { useEffect, useRef } from 'react';
import { surface, text, typography, meter } from '../../theme/loui-theme.js';
import { useMediaElement } from '../../audio/media-element-context.js';
import { useWaveformPeaks } from '../../hooks/useWaveformPeaks.js';

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

// Bar height in CSS px.  Higher than the plain 6px so the waveform shape is
// readable; still slim enough to stay subordinate to the meters.
const BAR_HEIGHT_PX = 28;
const WAVE_BUCKETS = 1200;

export interface LoopRegion { in: number; out: number }

export function LouiPlaybackBar({
  isPlaying,
  onSeek,
  loopRegion,
  loopActive,
  onLoopRegion,
}: {
  isPlaying: boolean;
  onSeek?: (ratio: number) => void;
  loopRegion?: LoopRegion | null;
  loopActive?: boolean;
  onLoopRegion?: (r: LoopRegion | null) => void;
}) {
  const media = useMediaElement();
  const trackRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const waveCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);
  const draggingRef = useRef(false);
  // Loop-drag state: Shift+drag defines a new loop region.
  const loopDraggingRef = useRef(false);
  const loopDragStartRef = useRef<number | null>(null);
  const loopPreviewRef = useRef<HTMLDivElement>(null);
  const lastLabelRef = useRef('');
  const lastProgressRef = useRef(-1);

  // Track the audio element's `currentSrc` (which only changes on a real
  // src load, not on attribute writes for the same value).  The audio
  // element's `loadstart` event fires on every new src, so we mirror it
  // into local state to trigger a peaks-decode for the new file.
  const [currentSrc, setCurrentSrc] = React.useState<string>(() => media?.currentSrc ?? '');
  useEffect(() => {
    if (!media) { setCurrentSrc(''); return; }
    setCurrentSrc(media.currentSrc || '');
    const sync = () => setCurrentSrc(media.currentSrc || '');
    media.addEventListener('loadstart', sync);
    media.addEventListener('loadedmetadata', sync);
    media.addEventListener('emptied', sync);
    return () => {
      media.removeEventListener('loadstart', sync);
      media.removeEventListener('loadedmetadata', sync);
      media.removeEventListener('emptied', sync);
    };
  }, [media]);

  const peaks = useWaveformPeaks(currentSrc || null, WAVE_BUCKETS);

  // Draw the base + overlay waveform onto the two canvases.  Called whenever
  // peaks change (new src decoded) or the canvas size changes.
  const drawWaveform = React.useCallback(() => {
    const wave = waveCanvasRef.current;
    const over = overlayCanvasRef.current;
    if (!wave || !over) return;
    const rect = wave.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.floor(rect.width  * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    for (const c of [wave, over]) {
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    }
    const drawTo = (canvas: HTMLCanvasElement, color: string) => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      const data = peaks.data;
      if (!data || data.length === 0) return;
      const cx = h / 2;
      const barW = Math.max(1, Math.floor(w / data.length));
      const gap = barW >= 2 ? 1 : 0;
      ctx.fillStyle = color;
      const useW = Math.max(1, barW - gap);
      for (let i = 0; i < data.length; i++) {
        const v = data[i]!;
        const half = Math.max(0.5, v * (cx - 1));
        const x = Math.floor(i * (w / data.length));
        ctx.fillRect(x, cx - half, useW, half * 2);
      }
    };
    drawTo(wave, 'rgba(148, 163, 184, 0.32)');
    drawTo(over, meter.accent.foreground);
  }, [peaks.data]);

  // Re-draw waveform when peaks land OR when the bar resizes.
  useEffect(() => {
    drawWaveform();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => drawWaveform()) : null;
    if (ro && trackRef.current) ro.observe(trackRef.current);
    return () => { ro?.disconnect(); };
  }, [drawWaveform]);

  const paint = React.useCallback(() => {
    const el = media;
    if (!el) return;
    const d = el.duration;
    const t = el.currentTime;
    const p = (Number.isFinite(d) && d > 0) ? Math.max(0, Math.min(1, t / d)) : 0;
    if (!draggingRef.current && fillRef.current) fillRef.current.style.width = `${(p * 100).toFixed(2)}%`;
    // Update overlay clip on progress change.  Compare cheaply with a ref.
    if (!draggingRef.current && overlayCanvasRef.current && Math.abs(p - lastProgressRef.current) > 0.0005) {
      overlayCanvasRef.current.style.clipPath = `inset(0 ${((1 - p) * 100).toFixed(2)}% 0 0)`;
      lastProgressRef.current = p;
    }
    const label = `${fmtTime(t)} / ${fmtTime(d)}`;
    if (labelRef.current && label !== lastLabelRef.current) {
      labelRef.current.textContent = label;
      lastLabelRef.current = label;
    }
  }, [media]);

  // rAF loop while playing — stops on pause (CPU); always paints once so a
  // pause/seek lands immediately, and 'seeked'/'loadedmetadata' repaint when
  // paused.
  useEffect(() => {
    if (!media) return;
    paint();
    let raf = 0;
    const tick = () => { paint(); raf = requestAnimationFrame(tick); };
    if (isPlaying) raf = requestAnimationFrame(tick);
    const onMeta = () => paint();
    media.addEventListener('seeked', onMeta);
    media.addEventListener('loadedmetadata', onMeta);
    media.addEventListener('timeupdate', onMeta);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      media.removeEventListener('seeked', onMeta);
      media.removeEventListener('loadedmetadata', onMeta);
      media.removeEventListener('timeupdate', onMeta);
    };
  }, [media, isPlaying, paint]);

  const seekRatioFromX = (clientX: number): number | undefined => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return undefined;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    if (fillRef.current) fillRef.current.style.width = `${(ratio * 100).toFixed(2)}%`;
    if (overlayCanvasRef.current) {
      overlayCanvasRef.current.style.clipPath = `inset(0 ${((1 - ratio) * 100).toFixed(2)}% 0 0)`;
      lastProgressRef.current = ratio;
    }
    return ratio;
  };

  const ratioFromX = (clientX: number): number | undefined => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return undefined;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };

  const updateLoopPreview = (start: number, end: number) => {
    const el = loopPreviewRef.current;
    if (!el) return;
    const lo = Math.min(start, end);
    const hi = Math.max(start, end);
    el.style.left = `${(lo * 100).toFixed(2)}%`;
    el.style.width = `${((hi - lo) * 100).toFixed(2)}%`;
    el.style.display = hi - lo > 0.005 ? 'block' : 'none';
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    if (e.shiftKey && onLoopRegion) {
      // Shift+drag = define loop region.
      const ratio = ratioFromX(e.clientX);
      if (ratio !== undefined) {
        loopDraggingRef.current = true;
        loopDragStartRef.current = ratio;
        updateLoopPreview(ratio, ratio);
      }
      return;
    }
    if (!onSeek) return;
    draggingRef.current = true;
    seekRatioFromX(e.clientX);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (loopDraggingRef.current) {
      const ratio = ratioFromX(e.clientX);
      const start = loopDragStartRef.current;
      if (ratio !== undefined && start !== null) updateLoopPreview(start, ratio);
      return;
    }
    if (!draggingRef.current) return;
    seekRatioFromX(e.clientX);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (loopDraggingRef.current) {
      loopDraggingRef.current = false;
      const ratio = ratioFromX(e.clientX);
      const start = loopDragStartRef.current;
      if (ratio !== undefined && start !== null) {
        const lo = Math.min(start, ratio);
        const hi = Math.max(start, ratio);
        onLoopRegion?.(hi - lo > 0.005 ? { in: lo, out: hi } : null);
      }
      // Hide preview overlay — committed region is shown by the loopRegion prop.
      if (loopPreviewRef.current) loopPreviewRef.current.style.display = 'none';
      loopDragStartRef.current = null;
      return;
    }
    if (!draggingRef.current) return;
    draggingRef.current = false;
    const ratio = seekRatioFromX(e.clientX);
    if (ratio !== undefined) onSeek?.(ratio);
  };

  // Plain (no-waveform) fallback used when peaks haven't decoded yet or
  // decode failed — keeps the bar functional and slim.
  const hasWaveform = !!peaks.data;

  return (
    <>
      <div
        ref={trackRef}
        className="no-drag"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          flex: 1, position: 'relative',
          height: hasWaveform ? BAR_HEIGHT_PX : 6,
          background: surface.well, borderRadius: hasWaveform ? 4 : 3,
          cursor: onSeek ? 'pointer' : 'default',
          overflow: 'hidden', touchAction: 'none',
          transition: 'height 200ms ease-out',
        }}
      >
        {/* Waveform: dim base + clipped accent overlay.  Hidden until peaks land. */}
        <canvas
          ref={waveCanvasRef}
          style={{
            position: 'absolute', inset: 0, width: '100%', height: '100%',
            display: 'block', pointerEvents: 'none',
            opacity: hasWaveform ? 1 : 0,
            transition: 'opacity 200ms ease-out',
          }}
        />
        <canvas
          ref={overlayCanvasRef}
          style={{
            position: 'absolute', inset: 0, width: '100%', height: '100%',
            display: 'block', pointerEvents: 'none',
            clipPath: 'inset(0 100% 0 0)',
            opacity: hasWaveform ? 1 : 0,
            transition: 'opacity 200ms ease-out',
          }}
        />
        {/* Plain progress fill — visible only when no waveform is loaded. */}
        <div
          ref={fillRef}
          style={{
            position: 'absolute', left: 0, top: 0,
            width: '0%', height: '100%',
            background: text.tertiary,
            opacity: hasWaveform ? 0 : 1,
            transition: 'opacity 200ms ease-out',
            pointerEvents: 'none',
          }}
        />
        {/* Committed loop region overlay (from loopRegion prop). */}
        {loopRegion && (
          <div style={{
            position: 'absolute',
            left: `${(loopRegion.in * 100).toFixed(2)}%`,
            width: `${((loopRegion.out - loopRegion.in) * 100).toFixed(2)}%`,
            top: 0, bottom: 0,
            background: loopActive ? 'rgba(250,204,21,0.22)' : 'rgba(250,204,21,0.10)',
            borderLeft: `1px solid ${loopActive ? 'rgba(250,204,21,0.70)' : 'rgba(250,204,21,0.35)'}`,
            borderRight: `1px solid ${loopActive ? 'rgba(250,204,21,0.70)' : 'rgba(250,204,21,0.35)'}`,
            pointerEvents: 'none',
            transition: 'background 150ms, border-color 150ms',
          }} />
        )}
        {/* In-progress loop drag preview (before pointer-up commits). */}
        <div
          ref={loopPreviewRef}
          style={{
            display: 'none',
            position: 'absolute', top: 0, bottom: 0,
            background: 'rgba(250,204,21,0.18)',
            borderLeft: '1px solid rgba(250,204,21,0.5)',
            borderRight: '1px solid rgba(250,204,21,0.5)',
            pointerEvents: 'none',
          }}
        />
      </div>
      <span
        ref={labelRef}
        style={{
          fontFamily: typography.family.mono, fontSize: typography.size.xs, color: text.muted,
          fontVariantNumeric: 'tabular-nums', minWidth: 88, textAlign: 'right',
        }}
      >
        0:00 / 0:00
      </span>
    </>
  );
}
