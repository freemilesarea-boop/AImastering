// LouiTogglePill — binary toggle styled as a label + pill.
//
// Two visual modes:
//   • "On"     — accent fill, primary text
//   • "Off"    — muted, surface background
//
// Used for bypass / "low mono" / dither / linear-loudnorm style switches.

import React from 'react';
import { surface, text, typography, meter, space, radius } from '../../../theme/loui-theme.js';

export interface LouiTogglePillProps {
  label: string;
  value: boolean;
  /** Show optional hint under the label. */
  hint?: string;
  /** Override the "Off" / "On" pill text. */
  offLabel?: string;
  onLabel?:  string;
  disabled?: boolean;
  onChange?: (v: boolean) => void;
}

export function LouiTogglePill(props: LouiTogglePillProps) {
  const [hover, setHover] = React.useState(false);
  const on = props.value;
  const onText  = props.onLabel  ?? 'On';
  const offText = props.offLabel ?? 'Off';

  const pillBg = on
    ? hover ? 'rgba(167,139,250,0.28)' : 'rgba(167,139,250,0.20)'
    : hover ? surface.well : 'transparent';
  const pillBorder = on ? meter.accent.foreground : surface.border;
  const pillText   = on ? text.primary : text.tertiary;

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

      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-disabled={props.disabled}
        disabled={props.disabled}
        onClick={() => props.onChange?.(!on)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          height: 28,
          paddingInline: space['3'],
          borderRadius: radius.chip,
          border: `1px solid ${pillBorder}`,
          background: pillBg,
          color: pillText,
          cursor: props.disabled ? 'not-allowed' : 'pointer',
          fontFamily: typography.family.sans,
          fontSize: typography.size.sm,
          fontWeight: typography.weight.medium,
          transition: 'background 120ms ease-out, border-color 120ms ease-out',
        }}
      >
        {/* Indicator dot */}
        <span style={{
          width: 8,
          height: 8,
          borderRadius: 999,
          background: on ? meter.accent.foreground : surface.overlay,
          transition: 'background 120ms ease-out',
        }} />
        <span>{on ? onText : offText}</span>
      </button>
    </div>
  );
}
