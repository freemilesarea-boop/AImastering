// LouiMiniMeter — horizontal mini level bar.
//
// Used inside parameter panels for "live" indicators — gain reduction,
// limiter activity, etc.  Driven by a `value` prop (0..1, clamped).
//
// Two visual modes:
//   • bar (default) — fill grows from left to right
//   • mirror        — fill grows from centre outward, signed value support
//     (passed as -1..+1)

import React from 'react';
import { surface, text, typography, meter } from '../../../theme/loui-theme.js';

export interface LouiMiniMeterProps {
  /** 0..1 (bar) or -1..+1 (mirror). */
  value: number;
  /** Optional label drawn above the bar. */
  label?: string;
  /** Optional readout drawn at the right. */
  readout?: string;
  /** Bar style — bar (default) or mirror. */
  mode?: 'bar' | 'mirror';
  /** Bar height in px.  Default 8. */
  height?: number;
  /** Status colour.  Default 'accent'. */
  status?: 'accent' | 'ok' | 'warn' | 'danger';
}

function fillFor(status: NonNullable<LouiMiniMeterProps['status']>): string {
  switch (status) {
    case 'ok':     return meter.safe.foreground;
    case 'warn':   return meter.warn.foreground;
    case 'danger': return meter.danger.foreground;
    case 'accent':
    default:       return meter.accent.foreground;
  }
}

export function LouiMiniMeter(props: LouiMiniMeterProps) {
  const mode = props.mode ?? 'bar';
  const h = props.height ?? 8;
  const fill = fillFor(props.status ?? 'accent');

  let leftPct: number;
  let widthPct: number;
  if (mode === 'mirror') {
    const v = Math.max(-1, Math.min(1, props.value));
    if (v >= 0) {
      leftPct = 50;
      widthPct = v * 50;
    } else {
      leftPct = 50 + v * 50;
      widthPct = Math.abs(v) * 50;
    }
  } else {
    leftPct = 0;
    widthPct = Math.max(0, Math.min(1, props.value)) * 100;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {(props.label || props.readout) && (
        <div style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          fontFamily: typography.family.sans,
          fontSize: typography.size.xs,
          color: text.muted,
          letterSpacing: '0.04em',
        }}>
          {props.label && (
            <span style={{ textTransform: 'uppercase' }}>{props.label}</span>
          )}
          {props.readout && (
            <span style={{
              fontFamily: typography.family.mono,
              color: text.tertiary,
              fontVariantNumeric: 'tabular-nums',
            }}>
              {props.readout}
            </span>
          )}
        </div>
      )}
      <div style={{
        position: 'relative',
        width: '100%',
        height: h,
        background: surface.well,
        borderRadius: h / 2,
        overflow: 'hidden',
        border: `1px solid ${surface.border}`,
      }}>
        {mode === 'mirror' && (
          <div style={{
            position: 'absolute',
            left: '50%',
            top: 0,
            bottom: 0,
            width: 1,
            background: surface.border,
          }} />
        )}
        <div style={{
          position: 'absolute',
          left: `${leftPct}%`,
          top: 0,
          width: `${widthPct}%`,
          height: '100%',
          background: fill,
          borderRadius: h / 2,
          transition: 'left 100ms linear, width 100ms linear',
        }} />
      </div>
    </div>
  );
}
