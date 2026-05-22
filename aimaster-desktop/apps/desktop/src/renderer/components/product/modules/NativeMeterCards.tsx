// NativeMeterCards — always-on, WASM-free meters driven by the shared
// graph's AnalyserNodes (useNativeAnalyzer).  Guarantees the Loudness /
// Stereo / Levels cards always show moving values (never an empty card),
// even when the WASM loudness/stereo analyzers fail to start.
//
// Values are RMS/peak-based dBFS approximations (clearly labelled "native");
// the precise BS.1770 LUFS comes from the WASM path when available.

import React from 'react';
import { surface, text, typography, meter as meterTokens } from '../../../theme/loui-theme.js';
import { useMediaElement } from '../../../audio/media-element-context.js';
import { useNativeAnalyzer } from '../../../hooks/useNativeAnalyzer.js';

function fmt(db: number, suffix = ''): string {
  if (!Number.isFinite(db)) return '−∞';
  return `${db > 0 ? '+' : ''}${db.toFixed(1)}${suffix}`;
}
function frac(db: number, lo = -60, hi = 0): number {
  if (!Number.isFinite(db)) return 0;
  return Math.max(0, Math.min(1, (db - lo) / (hi - lo)));
}

function Row({ label, value, f, tone }: { label: string; value: string; f?: number; tone?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ width: 70, fontFamily: typography.family.mono, fontSize: 11, color: text.muted }}>{label}</span>
      {f !== undefined ? (
        <div style={{ position: 'relative', flex: 1, height: 8, background: surface.well, borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ position: 'absolute', inset: 0, width: `${f * 100}%`, background: tone ?? meterTokens.safe.foreground, transition: 'width 60ms linear' }} />
        </div>
      ) : <div style={{ flex: 1 }} />}
      <span style={{ width: 56, textAlign: 'right', fontFamily: typography.family.mono, fontSize: 11, color: text.secondary, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

function useMeters() {
  const media = useMediaElement();
  return useNativeAnalyzer(media);
}

export function NativeLoudnessMeter() {
  const { meters: m, status } = useMeters();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      <Row label="Momentary" value={fmt(m.momentaryDb)} f={frac(m.momentaryDb)} />
      <Row label="Short-term" value={fmt(m.shortTermDb)} f={frac(m.shortTermDb)} tone={meterTokens.warn.foreground} />
      <Row label="Integrated" value={fmt(m.integratedDb)} f={frac(m.integratedDb)} tone={text.tertiary} />
      <Row label="Peak L/R" value={`${fmt(m.peakLDb)}/${fmt(m.peakRDb)}`} f={frac(Math.max(m.peakLDb, m.peakRDb))} tone={m.clip ? meterTokens.danger.foreground : meterTokens.safe.foreground} />
      <Row label="TP (est)" value={fmt(Math.max(m.peakHoldLDb, m.peakHoldRDb))} />
      <Row label="LRA" value="estimating" />
      <span style={{ fontFamily: typography.family.mono, fontSize: 10, color: text.muted }}>
        native dBFS · {status === 'connected' ? 'live' : status}
      </span>
    </div>
  );
}

export function NativeStereoMeter() {
  const { meters: m } = useMeters();
  const corrFrac = (m.correlation + 1) / 2;
  const corrTone = m.correlation < 0 ? meterTokens.danger.foreground
    : m.correlation < 0.3 ? meterTokens.warn.foreground : meterTokens.safe.foreground;
  const monoWarn = m.correlation < 0.2 && Number.isFinite(m.midSideRatioDb) && m.midSideRatioDb > -6;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      <Row label="L" value={fmt(m.rmsLDb)} f={frac(m.rmsLDb)} />
      <Row label="R" value={fmt(m.rmsRDb)} f={frac(m.rmsRDb)} />
      <Row label="M/S" value={fmt(m.midSideRatioDb, ' dB')} />
      <Row label="Width" value={`${Math.round(m.widthPct)}%`} f={Math.min(1, m.widthPct / 200)} tone={text.tertiary} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 70, fontFamily: typography.family.mono, fontSize: 11, color: text.muted }}>Corr Φ</span>
        <div style={{ position: 'relative', flex: 1, height: 8, background: surface.well, borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: surface.border }} />
          <div style={{ position: 'absolute', left: `${Math.min(corrFrac, 0.5) * 100}%`, width: `${Math.abs(corrFrac - 0.5) * 100}%`, top: 0, bottom: 0, background: corrTone, transition: 'all 80ms linear' }} />
        </div>
        <span style={{ width: 56, textAlign: 'right', fontFamily: typography.family.mono, fontSize: 11, color: text.secondary, fontVariantNumeric: 'tabular-nums' }}>{m.correlation.toFixed(2)}</span>
      </div>
      {monoWarn && (
        <span style={{ fontFamily: typography.family.mono, fontSize: 10, color: meterTokens.warn.foreground }}>
          ⚠ low correlation — check mono compatibility
        </span>
      )}
    </div>
  );
}

export function NativeLevelsMeter({ grDb }: { grDb?: number }) {
  const { meters: m, frameCount } = useMeters();
  const peakHold = Math.max(m.peakHoldLDb, m.peakHoldRDb);
  const headroom = Number.isFinite(peakHold) ? Math.max(0, -peakHold) : Infinity;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      <Row label="Out RMS" value={fmt(m.rmsDb)} f={frac(m.rmsDb)} />
      <Row label="Peak L" value={fmt(m.peakHoldLDb)} f={frac(m.peakHoldLDb)} tone={m.peakLDb >= 0.999 ? meterTokens.danger.foreground : meterTokens.safe.foreground} />
      <Row label="Peak R" value={fmt(m.peakHoldRDb)} f={frac(m.peakHoldRDb)} tone={m.peakRDb >= 0.999 ? meterTokens.danger.foreground : meterTokens.safe.foreground} />
      <Row label="Headroom" value={Number.isFinite(headroom) ? `${headroom.toFixed(1)} dB` : '−'} />
      {typeof grDb === 'number' && <Row label="GR" value={`−${Math.max(0, grDb).toFixed(1)} dB`} f={Math.min(1, Math.max(0, grDb) / 12)} tone={meterTokens.warn.foreground} />}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 70, fontFamily: typography.family.mono, fontSize: 11, color: text.muted }}>Clip</span>
        <span style={{
          fontFamily: typography.family.mono, fontSize: 11, fontWeight: 600,
          color: m.clip ? meterTokens.danger.foreground : meterTokens.safe.foreground,
        }}>{m.clip ? 'CLIP' : 'ok'}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: typography.family.mono, fontSize: 10, color: text.muted }}>#{frameCount}</span>
      </div>
    </div>
  );
}
