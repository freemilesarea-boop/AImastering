// The live spectrum for one insert, advanced at frame rate.
//
// ── Why this is a ref and not state ─────────────────────────────────────────
//
// The spectrum changes every frame.  Putting it in `useState` would re-render
// the plugin window sixty times a second — the knobs, the preset chips, the
// whole thing — to update a picture that is drawn on a canvas by hand anyway.
// So the arrays live in a ref, the frame loop writes them, and the canvas
// reads them.  React is not involved in the part that moves.
//
// ── Why the loop stops ──────────────────────────────────────────────────────
//
// An analyser with nothing playing into it returns its floor, and a
// requestAnimationFrame loop that runs forever to redraw a flat line is a
// window that keeps a laptop's fan on while nobody is looking at it.  The
// loop runs while the transport does and stops when it does not.

import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import { dawRuntime } from '../daw/engine/daw-runtime.js';
import {
  DEFAULT_SCALE, advanceHold, advanceSpectrum, spectrumColumns,
  type SpectrumScale,
} from '../daw/model/spectrum-view.js';
import type { TrackId } from '../daw/model/types.js';

export interface SpectrumFrame {
  /** One dB value per pixel column, after ballistics. */
  display: Float32Array;
  /** The slower line that remembers a peak. */
  hold: Float32Array;
  /** False until a frame has actually been read, so nothing draws a fake floor. */
  live: boolean;
}

export interface UseInsertSpectrumOptions {
  trackId: TrackId;
  insertId: string | null;
  /** Pixel columns to produce — the canvas width. */
  columns: number;
  /** Off entirely, e.g. the transport is stopped or the window is a picture. */
  enabled: boolean;
  slopeDbPerOct?: number;
  scale?: SpectrumScale;
}

/**
 * Returns a ref holding the current frame, and a subscribe function.
 *
 * The caller draws from the ref inside its own animation frame; this hook
 * only keeps the numbers current.  `onFrame` is called after each update so a
 * canvas that is not otherwise animating knows to redraw.
 */
export function useInsertSpectrum(
  options: UseInsertSpectrumOptions,
): { frame: MutableRefObject<SpectrumFrame>; onFrame: (fn: (() => void) | null) => void } {
  const {
    trackId, insertId, columns, enabled,
    slopeDbPerOct = 4.5, scale = DEFAULT_SCALE,
  } = options;

  const frame = useRef<SpectrumFrame>({
    display: new Float32Array(Math.max(1, columns)).fill(scale.bottomDb),
    hold: new Float32Array(Math.max(1, columns)).fill(scale.bottomDb),
    live: false,
  });
  const listener = useRef<(() => void) | null>(null);
  const onFrame = useCallback((fn: (() => void) | null) => { listener.current = fn; }, []);

  useEffect(() => {
    const width = Math.max(1, columns);
    if (frame.current.display.length !== width) {
      frame.current = {
        display: new Float32Array(width).fill(scale.bottomDb),
        hold: new Float32Array(width).fill(scale.bottomDb),
        live: false,
      };
    }
    if (!enabled || !insertId) {
      frame.current.live = false;
      return;
    }
    const bins = new Float32Array(Math.max(1, dawRuntime.spectrumBins()));
    const target = new Float32Array(width);
    const ages = new Float32Array(width);
    let raf = 0;
    let previous = 0;

    const step = (now: number): void => {
      raf = requestAnimationFrame(step);
      const dt = previous === 0 ? 1 / 60 : Math.max(0, (now - previous) / 1000);
      previous = now;
      if (!dawRuntime.insertSpectrum(trackId, insertId, bins)) {
        // Nothing to read — the channel was rebuilt, or metering is off.  The
        // last frame stays up rather than being replaced by a floor, which
        // would read as "this is silent" instead of "this is not known".
        return;
      }
      spectrumColumns(bins, dawRuntime.sampleRate, target, scale, slopeDbPerOct);
      advanceSpectrum(frame.current.display, target, dt, scale.bottomDb);
      advanceHold(frame.current.hold, ages, target, dt, scale.bottomDb);
      frame.current.live = true;
      listener.current?.();
    };
    raf = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(raf); frame.current.live = false; };
  }, [trackId, insertId, columns, enabled, slopeDbPerOct, scale]);

  return { frame, onFrame };
}
