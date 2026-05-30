// useSecondaryAnalyzer — second muted media element + its native analyser.
//
// Powers the dual-spectrum (Pre/Post) view: the primary <audio> element
// plays the master and the user hears it; this hook owns a hidden second
// element pointed at the source file, runs through the shared audio graph
// with masterGain=0 (silent), and exposes its AnalyserNode for the
// "Pre" spectrum canvas.
//
// Sync contract:
//   When `primary.currentTime` / play / pause / playbackRate changes, the
//   secondary mirrors it — no master clock needed because both elements
//   feed the SAME shared AudioContext (one sample clock).  Drift over a
//   short pre/post comparison window is bounded by the browser's media
//   scheduler and well below the eye's resolution for FFT averaging.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ensureElementGraph, getMasterGain } from '../audio/shared-audio-graph.js';

export interface SecondaryAnalyzer {
  /** Hidden second media element — must be rendered into the DOM tree. */
  element: HTMLAudioElement | null;
  /** Native AnalyserNode for the spectrum canvas, or null until wired. */
  analyser: AnalyserNode | null;
  status: 'idle' | 'connected' | 'error';
  error: string | null;
}

/**
 * Build a muted secondary audio element + analyser.
 *
 * @param primary   The audible <audio> element to sync from.
 * @param secondarySrc  The file URL for the pre/source side (null = disabled).
 * @param enabled   When false, no element is created (returns idle state).
 */
export function useSecondaryAnalyzer(
  primary: HTMLAudioElement | null,
  secondarySrc: string | null,
  enabled: boolean,
): SecondaryAnalyzer {
  // Create a single, stable HTMLAudioElement we own for the lifetime of the hook.
  const element = useMemo<HTMLAudioElement | null>(() => {
    if (typeof document === 'undefined') return null;
    if (!enabled) return null;
    const el = document.createElement('audio');
    el.preload = 'auto';
    el.crossOrigin = 'anonymous';
    el.style.display = 'none';
    return el;
  // We deliberately key on `enabled` so we recreate cleanly on toggle.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [status, setStatus] = useState<SecondaryAnalyzer['status']>('idle');
  const [error, setError] = useState<string | null>(null);

  // Attach element to DOM + ensure its graph + mute its bus.
  useEffect(() => {
    if (!element || !enabled) { setAnalyser(null); setStatus('idle'); return; }
    document.body.appendChild(element);
    return () => {
      try { element.pause(); } catch { /* ignore */ }
      try { document.body.removeChild(element); } catch { /* ignore */ }
    };
  }, [element, enabled]);

  // Update src + (re)build the graph when it changes.
  useEffect(() => {
    if (!element || !enabled) return;
    if (!secondarySrc) { element.removeAttribute('src'); setAnalyser(null); setStatus('idle'); return; }
    element.src = secondarySrc;
    element.load();
    // When metadata loads, wire the graph and mute the bus.
    const onMeta = () => {
      try {
        const graph = ensureElementGraph(element);
        // Silence this element's bus so only the primary is heard.
        const gain = getMasterGain(element);
        if (gain) gain.gain.value = 0;
        setAnalyser(graph.analysers.main);
        setStatus('connected');
        setError(null);
      } catch (e) {
        setStatus('error');
        setError(e instanceof Error ? e.message : String(e));
      }
    };
    element.addEventListener('loadedmetadata', onMeta);
    // Some browsers fire `loadeddata` first; try eagerly too.
    if (element.readyState >= 1) onMeta();
    return () => { element.removeEventListener('loadedmetadata', onMeta); };
  }, [element, secondarySrc, enabled]);

  // Sync play / pause / seek / rate from primary to secondary.
  const lastSyncRef = useRef(0);
  useEffect(() => {
    if (!element || !primary || !enabled) return;
    const playSecondary = () => {
      try {
        // Re-align time before play to keep drift bounded.
        if (Math.abs(element.currentTime - primary.currentTime) > 0.05) {
          element.currentTime = primary.currentTime;
        }
        element.playbackRate = primary.playbackRate;
        void element.play().catch(() => { /* ignore autoplay rejection */ });
      } catch { /* ignore */ }
    };
    const pauseSecondary = () => { try { element.pause(); } catch { /* ignore */ } };
    const seekSecondary = () => {
      try {
        element.currentTime = primary.currentTime;
        lastSyncRef.current = Date.now();
      } catch { /* ignore */ }
    };
    const rateSecondary = () => { try { element.playbackRate = primary.playbackRate; } catch { /* ignore */ } };

    // Slow drift-corrector: while playing, periodically nudge currentTime
    // back into alignment if it drifts beyond a tolerance (~80 ms).
    let raf = 0;
    const driftTick = () => {
      raf = requestAnimationFrame(driftTick);
      if (primary.paused || element.paused) return;
      const drift = element.currentTime - primary.currentTime;
      if (Math.abs(drift) > 0.08 && Date.now() - lastSyncRef.current > 250) {
        try { element.currentTime = primary.currentTime; lastSyncRef.current = Date.now(); } catch { /* ignore */ }
      }
    };

    // Initial alignment.
    if (!primary.paused) playSecondary();

    primary.addEventListener('play', playSecondary);
    primary.addEventListener('pause', pauseSecondary);
    primary.addEventListener('seeked', seekSecondary);
    primary.addEventListener('ratechange', rateSecondary);
    raf = requestAnimationFrame(driftTick);
    return () => {
      primary.removeEventListener('play', playSecondary);
      primary.removeEventListener('pause', pauseSecondary);
      primary.removeEventListener('seeked', seekSecondary);
      primary.removeEventListener('ratechange', rateSecondary);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [element, primary, enabled, secondarySrc]);

  return { element, analyser, status, error };
}
