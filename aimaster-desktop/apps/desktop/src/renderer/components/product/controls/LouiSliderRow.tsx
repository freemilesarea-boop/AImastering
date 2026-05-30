// LouiSliderRow — label + horizontal slider + value badge.
//
// One-row primitive for parameters that don't benefit from a knob — e.g.
// "Width", "Mix", "Lookahead".  Uses the native <input type="range">
// for built-in keyboard + screen-reader accessibility, with the track
// styled via inline CSS variables.
//
// TODO(M3-P-NEXT-5 binding): caller-supplied `onChange` will pipe into
// engine parameter writes.  For now: pure UI state.

import React from 'react';
import { surface, text, typography, meter, space } from '../../../theme/loui-theme.js';

export interface LouiSliderRowProps {
  label: string;
  value: number;
  min:   number;
  max:   number;
  step?: number;
  unit?: string;
  /** Optional value formatter — same shape as LouiKnob.format. */
  format?: (v: number) => string;
  disabled?: boolean;
  /** Optional descriptive subtitle under the label. */
  hint?: string;
  onChange?: (v: number) => void;
}

export function LouiSliderRow(props: LouiSliderRowProps) {
  const fmt = props.format ?? ((v: number) => v.toFixed(1));
  const norm = Math.max(0, Math.min(1, (props.value - props.min) / (props.max - props.min)));
  const fillPct = norm * 100;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: space['3'],
      opacity: props.disabled ? 0.45 : 1,
    }}>
      <div style={{ flex: '0 0 120px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{
          fontFamily: typography.family.sans,
          fontSize: typography.size.sm,
          color: text.secondary,
          fontWeight: typography.weight.medium,
        }}>
          {props.label}
        </span>
        {props.hint && (
          <span style={{
            fontFamily: typography.family.sans,
            fontSize: typography.size.xs,
            color: text.muted,
            lineHeight: 1.2,
          }}>
            {props.hint}
          </span>
        )}
      </div>

      <div style={{
        flex: 1,
        position: 'relative',
        height: 24,
        display: 'flex',
        alignItems: 'center',
      }}>
        {/* Track background */}
        <div style={{
          position: 'absolute',
          inset: '11px 0',
          height: 2,
          borderRadius: 1,
          background: surface.border,
        }} />
        {/* Filled portion */}
        <div style={{
          position: 'absolute',
          left: 0,
          right: `${100 - fillPct}%`,
          top: 11,
          height: 2,
          borderRadius: 1,
          background: meter.accent.foreground,
          transition: 'right 100ms linear',
        }} />
        {/* Native input range — overlays the visual track for accessibility */}
        <input
          type="range"
          aria-label={props.label}
          min={props.min}
          max={props.max}
          step={props.step ?? (props.max - props.min) / 100}
          value={props.value}
          disabled={props.disabled}
          onChange={(e) => props.onChange?.(Number(e.target.value))}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            margin: 0,
            opacity: 0,
            cursor: props.disabled ? 'not-allowed' : 'pointer',
          }}
        />
        {/* Visible thumb */}
        <div
          style={{
            position: 'absolute',
            left: `calc(${fillPct}% - 7px)`,
            top: 5,
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: text.primary,
            border: `2px solid ${meter.accent.foreground}`,
            boxShadow: `0 0 0 2px ${surface.background}`,
            pointerEvents: 'none',
            transition: 'left 100ms linear',
          }}
        />
      </div>

      <span style={{
        flex: '0 0 64px',
        textAlign: 'right',
        fontFamily: typography.family.mono,
        fontSize: typography.size.sm,
        color: text.primary,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {fmt(props.value)}{props.unit && (
          <span style={{ color: text.muted, marginLeft: 3 }}>{props.unit}</span>
        )}
      </span>
    </div>
  );
}
