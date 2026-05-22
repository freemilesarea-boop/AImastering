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
  rmsDb: number;     // summed mono RMS, dBFS (instantaneous)
  rmsLDb: number;
  rmsRDb: number;
  peakLDb: number;   // instantaneous peak (this frame)
  peakRDb: number;
  peakHoldLDb: number; // decaying peak hold
  peakHoldRDb: number;
  correlation: number; // -1..1 (L/R Pearson correlation)
  // Windowed loudness approximations (RMS-based, dBFS — NOT true LUFS).
  momentaryDb: number;  // ~400 ms
  shortTermDb: number;  // ~3 s
  integratedDb: number; // running gated mean
  // Stereo field.
  midSideRatioDb: number; // 20log10(sideRms/midRms)
  widthPct: number;       // 0 = mono, 100 = normal-ish, >100 wide
  clip: boolean;          // any channel hit ≈ 0 dBFS this frame
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
  peakLDb: -Infinity, peakRDb: -Infinity, peakHoldLDb: -Infinity, peakHoldRDb: -Infinity,
  correlation: 1, momentaryDb: -Infinity, shortTermDb: -Infinity, integratedDb: -Infinity,
  midSideRatioDb: -Infinity, widthPct: 0, clip: false,
};

function ampToDb(x: number): number {
  return x <= 1e-7 ? -Infinity : 20 * Math.log10(x);
}
function powToDb(p: number): number {
  return p <= 1e-12 ? -Infinity : 10 * Math.log10(p);
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
    // Rolling state for windowed loudness + peak hold.
    let momPow = 0, stPow = 0, intSum = 0, intCount = 0;
    let peakHoldL = 0, peakHoldR = 0;
    const A_MOM = 0.04;   // ~400 ms @ 60 fps
    const A_ST = 0.0055;  // ~3 s @ 60 fps
    const HOLD_DECAY = 0.9992;

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const a = analysersRef.current;
      if (!a) return;
      a.left.getFloatTimeDomainData(lBuf);
      a.right.getFloatTimeDomainData(rBuf);

      let sumL = 0, sumR = 0, peakL = 0, peakR = 0, dot = 0, sumMid = 0, sumSide = 0;
      const n = lBuf.length;
      for (let i = 0; i < n; i++) {
        const l = lBuf[i] ?? 0, r = rBuf[i] ?? 0;
        sumL += l * l; sumR += r * r; dot += l * r;
        const mid = (l + r) * 0.5, side = (l - r) * 0.5;
        sumMid += mid * mid; sumSide += side * side;
        const al = Math.abs(l), ar = Math.abs(r);
        if (al > peakL) peakL = al;
        if (ar > peakR) peakR = ar;
      }
      const rmsL = Math.sqrt(sumL / n);
      const rmsR = Math.sqrt(sumR / n);
      const monoPow = (sumL + sumR) / (2 * n);
      const rmsMono = Math.sqrt(monoPow);
      const denom = Math.sqrt(sumL * sumR);
      const corr = denom > 1e-9 ? Math.max(-1, Math.min(1, dot / denom)) : 1;
      const midRms = Math.sqrt(sumMid / n);
      const sideRms = Math.sqrt(sumSide / n);

      // Windowed loudness (power-domain EMA → dB).
      momPow += A_MOM * (monoPow - momPow);
      stPow += A_ST * (monoPow - stPow);
      if (monoPow > 1e-7) { intSum += monoPow; intCount += 1; }
      const intPow = intCount > 0 ? intSum / intCount : 0;

      // Peak hold (decaying).
      peakHoldL = Math.max(peakL, peakHoldL * HOLD_DECAY);
      peakHoldR = Math.max(peakR, peakHoldR * HOLD_DECAY);

      const widthPct = midRms > 1e-6 ? Math.min(300, (sideRms / midRms) * 100) : 0;

      metersRef.current = {
        rmsDb: ampToDb(rmsMono), rmsLDb: ampToDb(rmsL), rmsRDb: ampToDb(rmsR),
        peakLDb: ampToDb(peakL), peakRDb: ampToDb(peakR),
        peakHoldLDb: ampToDb(peakHoldL), peakHoldRDb: ampToDb(peakHoldR),
        correlation: corr,
        momentaryDb: powToDb(momPow), shortTermDb: powToDb(stPow), integratedDb: powToDb(intPow),
        midSideRatioDb: midRms > 1e-6 ? 20 * Math.log10(Math.max(1e-7, sideRms) / midRms) : -Infinity,
        widthPct,
        clip: peakL >= 0.999 || peakR >= 0.999,
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
