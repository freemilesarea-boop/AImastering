// NativeBandMeter — 6-band RMS horizontal bar meter driven by the native
// AnalyserNode FFT.  Covers Sub→Air so the user can see how the master
// sits across the audible spectrum without needing the WASM analyzer.
//
// Bands are computed in power domain (float frequency data → per-bin power
// → band-average → dBFS) so the result is true RMS per band, not peak.
// Bars use the Loui theme colour tokens for safe / warn / danger states.

import React, { useEffect, useRef } from 'react';
import { surface, text, typography, meter as meterTheme } from '../../../theme/loui-theme.js';
import { useMediaElement } from '../../../audio/media-element-context.js';
import { useNativeAnalyzer } from '../../../hooks/useNativeAnalyzer.js';

// 6 bands: label, low-Hz edge, high-Hz edge.
const BANDS: readonly { label: string; lo: number; hi: number }[] = [
  { label: 'Sub',   lo: 20,    hi: 80   },
  { label: 'Low',   lo: 80,    hi: 300  },
  { label: 'Mid-L', lo: 300,   hi: 1000 },
  { label: 'Mid-H', lo: 1000,  hi: 4000 },
  { label: 'High',  lo: 4000,  hi: 12000},
  { label: 'Air',   lo: 12000, hi: 20000},
] as const;

const MIN_DB = -60;
const MAX_DB = 0;

function dbToRatio(db: number): number {
  return Math.max(0, Math.min(1, (db - MIN_DB) / (MAX_DB - MIN_DB)));
}

export function NativeBandMeter() {
  const media = useMediaElement();
  const analyzer = useNativeAnalyzer(media);
  // Smoothed per-band dBFS (attack fast, release slow).
  const smoothedRef = useRef<Float32Array>(new Float32Array(BANDS.length).fill(-60));
  const rafRef = useRef(0);
  // Per-band bar refs for direct DOM writes (no React re-render per frame).
  const barRefs = useRef<(HTMLDivElement | null)[]>(Array(BANDS.length).fill(null));
  const labelRefs = useRef<(HTMLSpanElement | null)[]>(Array(BANDS.length).fill(null));
  const connected = analyzer.status === 'connected';

  useEffect(() => {
    let floatBuf: Float32Array<ArrayBuffer> | null = null;

    const tick = () => {
      rafRef.current = requestAnimationFrame(tick);
      const a = analyzer.analysers?.main;
      const smoothed = smoothedRef.current;

      if (a) {
        const bins = a.frequencyBinCount;
        if (!floatBuf || floatBuf.length !== bins) { const ab = new ArrayBuffer(bins * 4); floatBuf = new Float32Array(ab); }
        a.getFloatFrequencyData(floatBuf);
        const sr = a.context.sampleRate;
        const nyquist = sr / 2;
        const hzPerBin = nyquist / bins;

        for (let b = 0; b < BANDS.length; b++) {
          const { lo, hi } = BANDS[b]!;
          const i0 = Math.max(0, Math.floor(lo / hzPerBin));
          const i1 = Math.min(bins - 1, Math.ceil(hi / hzPerBin));
          let sumPow = 0, cnt = 0;
          for (let i = i0; i <= i1; i++) {
            const db = floatBuf[i] ?? -Infinity;
            if (Number.isFinite(db)) { sumPow += Math.pow(10, db / 10); cnt++; }
          }
          const db = cnt > 0 ? Math.max(MIN_DB, 10 * Math.log10(sumPow / cnt)) : MIN_DB;
          const prev = smoothed[b] ?? MIN_DB;
          // Attack: 1 frame; release: ~1.2s half-life at 60fps.
          smoothed[b] = db > prev ? db : prev * 0.984 + db * 0.016;
        }
      } else {
        // Decay to silence when no analyser.
        for (let b = 0; b < BANDS.length; b++) {
          smoothed[b] = (smoothed[b] ?? MIN_DB) * 0.96 + MIN_DB * 0.04;
        }
      }

      // Write to DOM refs directly — no React re-render.
      for (let b = 0; b < BANDS.length; b++) {
        const db = smoothed[b] ?? MIN_DB;
        const ratio = dbToRatio(db);
        const bar = barRefs.current[b];
        const lbl = labelRefs.current[b];
        if (bar) bar.style.width = `${(ratio * 100).toFixed(1)}%`;
        if (lbl) lbl.textContent = db <= MIN_DB ? '—' : `${db.toFixed(0)}`;
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(rafRef.current); };
  // Re-wire when the analyser changes; band count / theme never change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analyzer.analysers]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {BANDS.map((band, b) => (
        <div key={band.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            fontFamily: typography.family.mono, fontSize: 9,
            color: text.muted, letterSpacing: '0.04em', width: 30, textAlign: 'right', flexShrink: 0,
          }}>
            {band.label}
          </span>
          {/* Track */}
          <div style={{
            flex: 1, height: 6, background: surface.well, borderRadius: 3,
            overflow: 'hidden', position: 'relative',
            opacity: connected ? 1 : 0.35,
          }}>
            {/* Fill — color set by tick() via barRefs */}
            <div
              ref={(el) => { barRefs.current[b] = el; }}
              style={{
                position: 'absolute', left: 0, top: 0, height: '100%',
                width: '0%', borderRadius: 3,
                background: meterTheme.safe.foreground,
                transition: 'background 200ms',
              }}
            />
          </div>
          {/* dB readout */}
          <span
            ref={(el) => { labelRefs.current[b] = el; }}
            style={{
              fontFamily: typography.family.mono, fontSize: 9,
              color: text.muted, width: 22, textAlign: 'right', flexShrink: 0,
            }}
          >
            —
          </span>
        </div>
      ))}
    </div>
  );
}
