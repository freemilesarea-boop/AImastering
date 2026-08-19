// TrackLaneCanvas — draws one track's clips: waveform, clip gain line, fades.
//
// One canvas per track lane (not per clip): a 40-track session is 40 canvases
// instead of hundreds, and the whole lane redraws in a single pass when zoom
// or scroll changes.

import React, { useEffect, useRef } from 'react';
import { getMeta } from '../../../daw/engine/audio-cache.js';
import { clipEnd, trackClips } from '../../../daw/model/session-ops.js';
import { fadeCurve } from '../../../daw/engine/clip-player.js';
import type { Clip, Track } from '../../../daw/model/types.js';

export interface LaneViewport {
  scrollSec: number;
  pxPerSec: number;
  width: number;
  height: number;
}

/** Peak value of a clip's source between two clip-relative times. */
function peakBetween(peaks: Float32Array, fileDuration: number, fromSec: number, toSec: number): number {
  if (fileDuration <= 0 || peaks.length === 0) return 0;
  const a = Math.max(0, Math.floor((fromSec / fileDuration) * peaks.length));
  const b = Math.min(peaks.length, Math.max(a + 1, Math.ceil((toSec / fileDuration) * peaks.length)));
  let peak = 0;
  for (let i = a; i < b; i++) peak = Math.max(peak, peaks[i] ?? 0);
  return peak;
}

/** Fade multiplier at a clip-relative position, matching the audio engine. */
export function fadeGainAt(clip: Clip, relSec: number): number {
  let g = 1;
  const fi = clip.fadeIn.durationSec;
  if (fi > 0 && relSec < fi) {
    const curve = fadeCurve(clip.fadeIn.shape);
    const idx = Math.min(curve.length - 1, Math.floor((relSec / fi) * (curve.length - 1)));
    g *= curve[idx] ?? 1;
  }
  const fo = clip.fadeOut.durationSec;
  const fromEnd = clip.durationSec - relSec;
  if (fo > 0 && fromEnd < fo) {
    const curve = fadeCurve(clip.fadeOut.shape);
    const idx = Math.min(curve.length - 1, Math.floor((fromEnd / fo) * (curve.length - 1)));
    g *= curve[idx] ?? 1;
  }
  return g;
}

export default function TrackLaneCanvas({
  track, viewport, selected, decodeTick,
}: {
  track: Track;
  viewport: LaneViewport;
  selected: boolean;
  /** Bump to force a redraw once more files finish decoding. */
  decodeTick: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const { width, height, scrollSec, pxPerSec } = viewport;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const mid = height / 2;
    const toX = (sec: number) => (sec - scrollSec) * pxPerSec;

    for (const clip of trackClips(track)) {
      const x0 = toX(clip.startSec);
      const x1 = toX(clipEnd(clip));
      if (x1 < 0 || x0 > width) continue;

      const left = Math.max(0, x0);
      const right = Math.min(width, x1);
      const w = Math.max(1, right - left);

      // Clip body
      ctx.fillStyle = clip.muted ? 'rgba(90,90,110,0.25)' : hexToRgba(track.color, 0.22);
      ctx.fillRect(left, 2, w, height - 4);
      ctx.strokeStyle = selected ? 'rgba(255,255,255,0.55)' : hexToRgba(track.color, 0.75);
      ctx.lineWidth = 1;
      ctx.strokeRect(left + 0.5, 2.5, w - 1, height - 5);

      // Waveform.  The peak envelope outlives the decoded buffer, so a lane
      // still draws its shape after the audio has been evicted for memory.
      const meta = getMeta(clip.fileId);
      if (meta) {
        const fileDuration = meta.durationSec;
        const gain = Math.pow(10, clip.gainDb / 20);
        ctx.fillStyle = clip.muted ? 'rgba(150,150,170,0.5)' : hexToRgba(track.color, 0.95);
        const step = 1;
        for (let x = left; x < right; x += step) {
          const t0 = scrollSec + (x - 0) / pxPerSec;
          const t1 = t0 + step / pxPerSec;
          const rel0 = t0 - clip.startSec;
          const rel1 = t1 - clip.startSec;
          if (rel1 < 0 || rel0 > clip.durationSec) continue;
          const peak = peakBetween(
            meta.peaks, fileDuration,
            clip.offsetSec + Math.max(0, rel0),
            clip.offsetSec + Math.min(clip.durationSec, rel1),
          );
          const amp = Math.min(1, peak * gain * fadeGainAt(clip, Math.max(0, rel0)));
          const h = Math.max(0.5, amp * (height / 2 - 8));
          ctx.fillRect(x, mid - h, step, h * 2);
        }
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(left, mid - 1, w, 2);
      }

      // Fade shapes
      drawFade(ctx, clip, toX, height, 'in');
      drawFade(ctx, clip, toX, height, 'out');

      // Clip gain line — the horizontal line engineers ride with Ctrl+Shift+↑↓
      if (Math.abs(clip.gainDb) > 0.01) {
        const y = mid - (clip.gainDb / 24) * (height / 2 - 10);
        ctx.strokeStyle = 'rgba(255,255,255,0.65)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(right, y);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Name strip
      if (w > 34) {
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(left, 2, Math.min(w, 160), 12);
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.font = '9px ui-sans-serif, system-ui, sans-serif';
        const label = Math.abs(clip.gainDb) > 0.01
          ? `${clip.name}  ${clip.gainDb > 0 ? '+' : ''}${clip.gainDb.toFixed(1)} dB`
          : clip.name;
        ctx.fillText(label.slice(0, 28), left + 3, 11);
      }
    }
  }, [track, viewport, selected, decodeTick]);

  return <canvas ref={ref} className="block" />;
}

function drawFade(
  ctx: CanvasRenderingContext2D, clip: Clip,
  toX: (sec: number) => number, height: number, side: 'in' | 'out',
): void {
  const duration = side === 'in' ? clip.fadeIn.durationSec : clip.fadeOut.durationSec;
  if (duration <= 0) return;
  const from = side === 'in' ? clip.startSec : clipEnd(clip) - duration;
  const to   = side === 'in' ? clip.startSec + duration : clipEnd(clip);
  const shape = side === 'in' ? clip.fadeIn.shape : clip.fadeOut.shape;
  const curve = fadeCurve(shape, 24);

  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < curve.length; i++) {
    const t = from + ((to - from) * i) / (curve.length - 1);
    const v = side === 'in' ? (curve[i] ?? 0) : (curve[curve.length - 1 - i] ?? 0);
    const x = toX(t);
    const y = height - 2 - v * (height - 6);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m || !m[1]) return `rgba(120,140,200,${alpha})`;
  const int = parseInt(m[1], 16);
  return `rgba(${(int >> 16) & 255},${(int >> 8) & 255},${int & 255},${alpha})`;
}
