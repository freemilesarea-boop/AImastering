/**
 * TrackWaveform — one track's audio, drawn the way a DAW draws it.
 *
 * Canvas rather than SVG: an arrange window holds a dozen of these at two
 * thousand buckets each, and twenty-four thousand DOM nodes is a scroll that
 * stutters. A canvas is one node and redraws in a frame.
 *
 * The shape is the real minimum and maximum of each bucket with the RMS
 * filled inside it — the outline is what the take actually did, and the
 * darker core is where its energy sits. Drawing |x| instead would make
 * every part look like the same symmetric sausage.
 */

import React, { useEffect, useRef } from 'react';

export interface PeakData {
  count: number;
  min: number[];
  max: number[];
  rms: number[];
  durationSec: number;
}

export interface TrackWaveformProps {
  peaks: PeakData | null;
  /** Track accent, used for the outline. */
  color: string;
  height: number;
  /** 1 = the whole file fills the lane; 2 = twice as wide. */
  zoom: number;
  /** Fraction of the file scrolled past the left edge, 0..1. */
  scroll: number;
  /** Drawn dimmer when the track will not be heard. */
  dimmed?: boolean;
  /** Playhead position as a fraction of the file, or null. */
  playhead?: number | null;
  /**
   * The lane's backdrop.
   *
   * The playhead is drawn against the lane rather than against the
   * waveform, so it is the one colour here that cannot be derived from the
   * track's accent: white on charcoal, near-black on white. A single
   * hard-coded value made it invisible on one of the two.
   */
  surface?: 'light' | 'dark';
}

/** Slightly transparent version of a hex colour. */
function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export default function TrackWaveform({
  peaks, color, height, zoom, scroll, dimmed = false, playhead = null,
  surface = 'dark',
}: TrackWaveformProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const box = boxRef.current;
    if (!canvas || !box) return;

    // Backing store at device resolution, or the waveform is a blurry smear
    // on every laptop made in the last decade.
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor(box.clientWidth));
    const h = Math.max(1, height);
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (!peaks || peaks.count === 0) {
      // No peaks yet: a flat centre line, so the lane reads as "loading"
      // rather than as "silent".
      ctx.strokeStyle = withAlpha(color, 0.25);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();
      return;
    }

    const alpha = dimmed ? 0.3 : 1;
    const mid = h / 2;
    const amp = (h / 2) - 2;

    // Which slice of the file is on screen.
    const visible = 1 / Math.max(1, zoom);
    const from = Math.max(0, Math.min(1 - visible, scroll));
    const startBucket = from * peaks.count;
    const bucketsOnScreen = visible * peaks.count;

    ctx.fillStyle = withAlpha(color, 0.28 * alpha);
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const b = Math.floor(startBucket + (x / w) * bucketsOnScreen);
      const i = Math.max(0, Math.min(peaks.count - 1, b));
      const top = mid - (peaks.max[i] ?? 0) * amp;
      const bottom = mid - (peaks.min[i] ?? 0) * amp;
      ctx.rect(x, top, 1, Math.max(1, bottom - top));
    }
    ctx.fill();

    // The RMS core, brighter, inside the outline.
    ctx.fillStyle = withAlpha(color, 0.75 * alpha);
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const b = Math.floor(startBucket + (x / w) * bucketsOnScreen);
      const i = Math.max(0, Math.min(peaks.count - 1, b));
      const r = (peaks.rms[i] ?? 0) * amp;
      ctx.rect(x, mid - r, 1, Math.max(1, r * 2));
    }
    ctx.fill();

    if (playhead !== null && playhead >= from && playhead <= from + visible) {
      const x = ((playhead - from) / visible) * w;
      ctx.strokeStyle = surface === 'light' ? 'rgba(15,23,42,0.85)' : 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
      ctx.stroke();
    }
  }, [peaks, color, height, zoom, scroll, dimmed, playhead, surface]);

  return (
    <div ref={boxRef} className="w-full" style={{ height }}>
      <canvas ref={canvasRef} className="block" />
    </div>
  );
}
