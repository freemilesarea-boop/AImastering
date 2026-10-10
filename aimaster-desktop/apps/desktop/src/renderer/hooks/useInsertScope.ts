// The live stereo picture for one insert, advanced at frame rate.
//
// A sibling of `useInsertSpectrum` and the same shape for the same reasons:
// the numbers live in a ref because they change every frame and React has no
// business re-rendering a window of knobs to move a dot; the loop runs while
// the transport does, because a requestAnimationFrame loop redrawing a still
// scope is a laptop fan nobody asked for.
//
// What it adds is the part a magnitude display cannot have.  Two mixes with
// identical spectra can be mono-compatible and unlistenable respectively, and
// the only thing that separates them is the phase between the channels.

import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import { dawRuntime } from '../daw/engine/daw-runtime.js';
import {
  goniometerPoints, scopeReading, type ScopeReading,
} from '../daw/model/analyzer-view.js';
import type { TrackId } from '../daw/model/types.js';

export interface ScopeFrame {
  /** x, y pairs in −1…1, mid vertical and side horizontal. */
  points: Float32Array;
  /** How many of `points` are valid this frame. */
  count: number;
  reading: ScopeReading;
  /** False until a frame has actually been read. */
  live: boolean;
}

/** Samples read per frame.  Matches the device's own analyser. */
const BLOCK = 2048;

export interface UseInsertScopeOptions {
  trackId: TrackId;
  insertId: string | null;
  enabled: boolean;
  /** How many dots to draw.  Fewer than the block, spread across it. */
  points?: number;
}

export function useInsertScope(
  options: UseInsertScopeOptions,
): { frame: MutableRefObject<ScopeFrame>; onFrame: (fn: (() => void) | null) => void } {
  const { trackId, insertId, enabled, points = 512 } = options;

  const frame = useRef<ScopeFrame>({
    points: new Float32Array(points * 2),
    count: 0,
    reading: { correlation: 1, widthPct: 0, peak: 0 },
    live: false,
  });
  const listener = useRef<(() => void) | null>(null);
  const onFrame = useCallback((fn: (() => void) | null) => { listener.current = fn; }, []);

  useEffect(() => {
    if (frame.current.points.length !== points * 2) {
      frame.current = {
        points: new Float32Array(points * 2),
        count: 0,
        reading: { correlation: 1, widthPct: 0, peak: 0 },
        live: false,
      };
    }
    if (!enabled || !insertId) {
      frame.current.live = false;
      return;
    }
    const left = new Float32Array(BLOCK);
    const right = new Float32Array(BLOCK);
    let raf = 0;

    const step = (): void => {
      raf = requestAnimationFrame(step);
      if (!dawRuntime.insertScope(trackId, insertId, left, right)) {
        // Nothing to read.  The last picture stays up — a scope that blanked
        // between blocks would flicker at exactly the rate of the frame loop.
        return;
      }
      frame.current.count = goniometerPoints(left, right, frame.current.points);
      frame.current.reading = scopeReading(left, right);
      frame.current.live = true;
      listener.current?.();
    };
    raf = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(raf); frame.current.live = false; };
  }, [trackId, insertId, enabled, points]);

  return { frame, onFrame };
}
