// LouiPlaybackBar — smooth, rAF-driven transport progress.
//
// Reads the <audio> element's currentTime directly each animation frame and
// writes the fill width + time label via DOM refs (NO React re-render per
// frame), so the bar flows continuously instead of stepping with the ~4 Hz
// `timeupdate` event.  Dragging takes priority over the rAF paint; on release
// it commits the seek via onSeek and re-syncs to the element.

import React, { useEffect, useRef } from 'react';
import { surface, text, typography } from '../../theme/loui-theme.js';
import { useMediaElement } from '../../audio/media-element-context.js';

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export function LouiPlaybackBar({ isPlaying, onSeek }: { isPlaying: boolean; onSeek?: (ratio: number) => void }) {
  const media = useMediaElement();
  const trackRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const draggingRef = useRef(false);
  const lastLabelRef = useRef('');

  const paint = React.useCallback(() => {
    const el = media;
    if (!el) return;
    const d = el.duration;
    const t = el.currentTime;
    const p = (Number.isFinite(d) && d > 0) ? Math.max(0, Math.min(1, t / d)) : 0;
    if (!draggingRef.current && fillRef.current) fillRef.current.style.width = `${(p * 100).toFixed(2)}%`;
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
    return ratio;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!onSeek) return;
    draggingRef.current = true;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    seekRatioFromX(e.clientX);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    seekRatioFromX(e.clientX);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    const ratio = seekRatioFromX(e.clientX);
    if (ratio !== undefined) onSeek?.(ratio);
  };

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
          flex: 1, height: 6, background: surface.well, borderRadius: 3,
          cursor: onSeek ? 'pointer' : 'default', overflow: 'hidden', touchAction: 'none',
        }}
      >
        <div ref={fillRef} style={{ width: '0%', height: '100%', background: text.tertiary }} />
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
