// LouiGainReductionMeter — Limiter / Maximizer GR meter (OZONE-MODULE-NEXT-3).
//
// Visualises the REAL limiter gain reduction (`limiterGrDb` from the Rust
// limiter via worklet metrics).  Shows an honest "unavailable" state when
// the realtime preview isn't running — never fakes a value.
//
// Vertical (full, module panel) or horizontal (compact, rails/cards).
// Peak-hold line + smooth CSS decay; redraws only when props change.

import React from 'react';
import { surface, text, typography, meter as meterTheme } from '../../../theme/loui-theme.js';
import { loui } from '../../../theme/loui-home.js';
import { buildGrMeterModel, type GrSource, type GrState } from '../../../audio/modules/gr-meter-model.js';

export interface LouiGainReductionMeterProps {
  /** Gain reduction magnitude in dB (≥0).  Ignored when `available` is false. */
  grDb: number;
  /** Peak-hold value in dB (≥ grDb).  Optional. */
  peakDb?: number;
  /** True when realtime GR data is flowing. */
  available: boolean;
  source?: GrSource;
  /** Meter range (dB).  Default 12. */
  maxDb?: number;
  orientation?: 'vertical' | 'horizontal';
  /** Compact = rail/card; full = module panel. */
  compact?: boolean;
  /** Label shown above the meter (full mode). */
  label?: string;
}

const STATE_COLOR: Record<GrState, string> = {
  unavailable: surface.overlay,
  idle: meterTheme.safe.foreground,
  active: loui.primaryLavender,
  heavy: meterTheme.warn.foreground,
  'clipping-risk': meterTheme.danger.foreground,
};

const TICKS = [1, 3, 6, 12];

export function LouiGainReductionMeter(props: LouiGainReductionMeterProps) {
  const maxDb = props.maxDb ?? 12;
  const orientation = props.orientation ?? (props.compact ? 'horizontal' : 'vertical');
  const model = buildGrMeterModel({ grDb: props.grDb, available: props.available, ...(props.source ? { source: props.source } : {}), ...(props.peakDb !== undefined ? { peakGrDb: props.peakDb } : {}) });
  const color = STATE_COLOR[model.state];
  const frac = Math.min(1, model.currentGrDb / maxDb);
  const peakFrac = Math.min(1, model.peakGrDb / maxDb);
  const unavailable = model.state === 'unavailable';

  const valueText = unavailable ? '—' : `−${model.currentGrDb.toFixed(1)} dB`;

  if (orientation === 'horizontal') {
    // Reduction grows leftward from 0 dB on the right.
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, opacity: unavailable ? 0.6 : 1 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={{ fontFamily: typography.family.sans, fontSize: typography.size.xs, color: text.muted }}>{props.label ?? 'GR'}</span>
          <span style={{ fontFamily: typography.family.mono, fontSize: typography.size.xs, color, fontVariantNumeric: 'tabular-nums' }}>{valueText}</span>
        </div>
        <div style={{ position: 'relative', height: 8, borderRadius: 4, background: surface.well, overflow: 'hidden', border: `1px solid ${surface.border}` }}>
          {!unavailable && (
            <div style={{ position: 'absolute', top: 0, right: 0, height: '100%', width: `${frac * 100}%`, background: color, transition: 'width 120ms ease-out', boxShadow: model.state === 'clipping-risk' ? `0 0 8px ${color}` : 'none' }} />
          )}
          {!unavailable && peakFrac > 0.01 && (
            <div style={{ position: 'absolute', top: 0, bottom: 0, right: `${peakFrac * 100}%`, width: 2, background: loui.softLavender }} />
          )}
        </div>
      </div>
    );
  }

  // Vertical full meter.
  const H = 150;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center', opacity: unavailable ? 0.6 : 1 }}>
      <span style={{ fontFamily: typography.family.sans, fontSize: typography.size.xs, letterSpacing: '0.1em', textTransform: 'uppercase', color: text.muted }}>
        {props.label ?? 'Gain Reduction'}
      </span>
      <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
        {/* Bar (grows downward from 0 dB at top). */}
        <div style={{ position: 'relative', width: 26, height: H, borderRadius: 6, background: surface.well, border: `1px solid ${surface.border}`, overflow: 'hidden' }}>
          {!unavailable && (
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: `${frac * 100}%`, background: color, transition: 'height 120ms ease-out', boxShadow: model.state === 'clipping-risk' ? `0 0 10px ${color}` : 'none' }} />
          )}
          {!unavailable && peakFrac > 0.01 && (
            <div style={{ position: 'absolute', left: 0, right: 0, top: `${peakFrac * 100}%`, height: 2, background: loui.softLavender }} />
          )}
        </div>
        {/* Ticks */}
        <div style={{ position: 'relative', width: 30, height: H }}>
          {TICKS.filter((t) => t <= maxDb).map((t) => (
            <span key={t} style={{ position: 'absolute', top: `${(t / maxDb) * 100}%`, left: 0, transform: 'translateY(-50%)', fontFamily: typography.family.mono, fontSize: 9, color: text.muted }}>
              −{t}
            </span>
          ))}
        </div>
      </div>
      <span style={{ fontFamily: typography.family.mono, fontSize: typography.size.sm, color, fontVariantNumeric: 'tabular-nums' }}>{valueText}</span>
      {unavailable && (
        <span style={{ fontFamily: typography.family.sans, fontSize: 10, color: text.muted, textAlign: 'center', maxWidth: 130 }}>
          실시간 프리뷰에서 GR 표시
        </span>
      )}
    </div>
  );
}
