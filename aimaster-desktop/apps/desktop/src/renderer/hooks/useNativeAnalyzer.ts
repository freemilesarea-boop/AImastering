// useNativeAnalyzer — WASM-free WebAudio analyzer (the always-on fallback).
//
// Builds (or reuses) the shared audio graph for a media element and reads
// its native AnalyserNodes.  Provides:
//   • the AnalyserNodes themselves (for a canvas spectrum to read directly),
//   • RMS / peak per channel (dBFS) and a stereo correlation estimate,
//   • a live frame counter + last-frame-age so the UI can prove movement.
//
// This works with ONLY core WebAudio (AnalyserNode) — no worklet, no WASM —
// so the spectrum/meters are never blank, even when the WASM analyzer or
// the realtime DSP worklet fail to load.

import { useEffect, useRef, useState } from 'react';
import {
  ensureElementGraph,
  type NativeAnalysers,
} from '../audio/shared-audio-graph.js';

export interface NativeMeters {
  rmsDb: number;     // summed mono RMS, dBFS
  rmsLDb: number;
  rmsRDb: number;
  peakLDb: number;
  peakRDb: number;
  correlation: number; // -1..1 (L/R Pearson correlation)
}

export type NativeAnalyzerStatus = 'no-element' | 'connected' | 'error';

export interface NativeAnalyzerState {
  status: NativeAnalyzerStatus;
  error: string | null;
  analysers: NativeAnalysers | null;
  meters: NativeMeters;
  /** Increments every analysis tick while audio is flowing. */
  frameCount: number;
  /** performance.now() of the last non-silent frame, or null. */
  lastFrameAt: number | null;
}

const SILENT: NativeMeters = {
  rmsDb: -Infinity, rmsLDb: -Infinity, rmsRDb: -Infinity,
  peakLDb: -Infinity, peakRDb: -Infinity, correlation: 1,
};

function toDb(x: number): number {
  return x <= 1e-7 ? -Infinity : 20 * Math.log10(x);
}

export function useNativeAnalyzer(media: HTMLMediaElement | null): NativeAnalyzerState {
  const [status, setStatus] = useState<NativeAnalyzerStatus>('no-element');
  const [error, setError] = useState<string | null>(null);
  const analysersRef = useRef<NativeAnalysers | null>(null);
  const [, force] = useState(0);

  // Live values kept in refs (RAF) + mirrored to state at ~15 Hz for the
  // numeric readouts (the canvas reads the AnalyserNodes directly for 60fps).
  const metersRef = useRef<NativeMeters>(SILENT);
  const frameCountRef = useRef(0);
  const lastFrameAtRef = useRef<number | null>(null);
  const [meters, setMeters] = useState<NativeMeters>(SILENT);
  const [frameCount, setFrameCount] = useState(0);
  const [lastFrameAt, setLastFrameAt] = useState<number | null>(null);

  useEffect(() => {
    if (!media) { setStatus('no-element'); analysersRef.current = null; return; }
    let analysers: NativeAnalysers;
    try {
      analysers = ensureElementGraph(media).analysers;
      analysersRef.current = analysers;
      setStatus('connected');
      setError(null);
      force((n) => n + 1);
    } catch (e) {
      setStatus('error');
      setError(e instanceof Error ? e.message : String(e));
      return;
    }

    const lBuf = new Float32Array(analysers.left.fftSize);
    const rBuf = new Float32Array(analysers.right.fftSize);
    let raf = 0;
    let mirrorAt = 0;

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const a = analysersRef.current;
      if (!a) return;
      a.left.getFloatTimeDomainData(lBuf);
      a.right.getFloatTimeDomainData(rBuf);

      let sumL = 0, sumR = 0, peakL = 0, peakR = 0, dot = 0;
      const n = lBuf.length;
      for (let i = 0; i < n; i++) {
        const l = lBuf[i] ?? 0, r = rBuf[i] ?? 0;
        sumL += l * l; sumR += r * r; dot += l * r;
        const al = Math.abs(l), ar = Math.abs(r);
        if (al > peakL) peakL = al;
        if (ar > peakR) peakR = ar;
      }
      const rmsL = Math.sqrt(sumL / n);
      const rmsR = Math.sqrt(sumR / n);
      const rmsMono = Math.sqrt((sumL + sumR) / (2 * n));
      const denom = Math.sqrt(sumL * sumR);
      const corr = denom > 1e-9 ? Math.max(-1, Math.min(1, dot / denom)) : 1;

      metersRef.current = {
        rmsDb: toDb(rmsMono), rmsLDb: toDb(rmsL), rmsRDb: toDb(rmsR),
        peakLDb: toDb(peakL), peakRDb: toDb(peakR), correlation: corr,
      };
      frameCountRef.current += 1;
      const nonSilent = rmsMono > 1e-5;
      if (nonSilent) lastFrameAtRef.current = performance.now();

      const now = performance.now();
      if (now - mirrorAt >= 66) { // ~15 Hz state mirror for numeric readouts
        mirrorAt = now;
        setMeters(metersRef.current);
        setFrameCount(frameCountRef.current);
        setLastFrameAt(lastFrameAtRef.current);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); };
  }, [media]);

  return { status, error, analysers: analysersRef.current, meters, frameCount, lastFrameAt };
}
