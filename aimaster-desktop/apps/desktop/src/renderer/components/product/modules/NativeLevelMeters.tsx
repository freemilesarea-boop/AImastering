// NativeLevelMeters — WASM-free RMS / peak / stereo-correlation meters.
//
// Reads the shared graph's native AnalyserNodes (via useNativeAnalyzer) and
// renders L/R level bars + a correlation indicator.  Always present and
// always moving while audio plays, so the meter column is never dead — even
// if the WASM loudness/stereo analyzers fail to initialise.

import React from 'react';
import { surface, text, typography, meter as meterTokens } from '../../../theme/loui-theme.js';
import { useMediaElement } from '../../../audio/media-element-context.js';
import { useNativeAnalyzer } from '../../../hooks/useNativeAnalyzer.js';

function dbToFrac(db: number): number {
  // Map -60..0 dBFS → 0..1.
  if (!Number.isFinite(db)) return 0;
  return Math.max(0, Math.min(1, (db + 60) / 60));
}

function fmtDb(db: number): string {
  if (!Number.isFinite(db)) return '−∞';
  return `${db <= 0 ? '' : '+'}${db.toFixed(1)}`;
}

function LevelBar({ label, rmsDb, peakDb }: { label: string; rmsDb: number; peakDb: number }) {
  const rmsFrac = dbToFrac(rmsDb);
  const peakFrac = dbToFrac(peakDb);
  const tone = peakDb > -1 ? meterTokens.danger.foreground
    : peakDb > -6 ? meterTokens.warn.foreground : meterTokens.safe.foreground;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ width: 14, fontFamily: typography.family.mono, fontSize: 11, color: text.muted }}>{label}</span>
      <div style={{ position: 'relative', flex: 1, height: 10, background: surface.well, borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${rmsFrac * 100}%`, background: tone, transition: 'width 60ms linear' }} />
        <div style={{ position: 'absolute', left: `${peakFrac * 100}%`, top: 0, bottom: 0, width: 2, background: text.primary }} />
      </div>
      <span style={{ width: 42, textAlign: 'right', fontFamily: typography.family.mono, fontSize: 11, color: text.secondary, fontVariantNumeric: 'tabular-nums' }}>
        {fmtDb(rmsDb)}
      </span>
    </div>
  );
}

export function NativeLevelMeters() {
  const media = useMediaElement();
  const native = useNativeAnalyzer(media);
  const m = native.meters;
  // Correlation −1..+1 → 0..1 for the bar; centre = 0.5.
  const corrFrac = (m.correlation + 1) / 2;
  const corrTone = m.correlation < 0 ? meterTokens.danger.foreground
    : m.correlation < 0.3 ? meterTokens.warn.foreground : meterTokens.safe.foreground;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <LevelBar label="L" rmsDb={m.rmsLDb} peakDb={m.peakLDb} />
      <LevelBar label="R" rmsDb={m.rmsRDb} peakDb={m.peakRDb} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
        <span style={{ width: 14, fontFamily: typography.family.mono, fontSize: 11, color: text.muted }}>Φ</span>
        <div style={{ position: 'relative', flex: 1, height: 8, background: surface.well, borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: surface.border }} />
          <div style={{ position: 'absolute', left: `${Math.min(corrFrac, 0.5) * 100}%`, width: `${Math.abs(corrFrac - 0.5) * 100}%`, top: 0, bottom: 0, background: corrTone, transition: 'all 80ms linear' }} />
        </div>
        <span style={{ width: 42, textAlign: 'right', fontFamily: typography.family.mono, fontSize: 11, color: text.secondary, fontVariantNumeric: 'tabular-nums' }}>
          {m.correlation.toFixed(2)}
        </span>
      </div>
      <span style={{ fontFamily: typography.family.mono, fontSize: 10, color: text.muted }}>
        {native.status === 'connected'
          ? `native · frames ${native.frameCount}`
          : native.status === 'error' ? `error: ${native.error}` : 'no audio element'}
      </span>
    </div>
  );
}
