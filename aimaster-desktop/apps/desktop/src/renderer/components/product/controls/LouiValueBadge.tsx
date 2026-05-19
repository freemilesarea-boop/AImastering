// LouiValueBadge — a compact mono badge for a numeric / categorical value.
//
// Two variants:
//   • neutral — surface.well background, tertiary text
//   • status  — coloured by status: ok / warn / danger / accent

import React from 'react';
import { surface, text, typography, meter, radius } from '../../../theme/loui-theme.js';

export type ValueBadgeStatus = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent';

export interface LouiValueBadgeProps {
  /** Value content — usually a string of a number + unit. */
  children: React.ReactNode;
  /** Status colour.  Default 'neutral'. */
  status?: ValueBadgeStatus;
  /** Optional small label drawn before the value. */
  label?: string;
}

function colourFor(status: ValueBadgeStatus): { fg: string; bg: string; border: string } {
  switch (status) {
    case 'ok':      return { fg: meter.safe.foreground,   bg: meter.safe.background,        border: 'rgba(16,185,129,0.45)' };
    case 'warn':    return { fg: meter.warn.foreground,   bg: meter.warn.background,        border: 'rgba(245,158,11,0.45)' };
    case 'danger':  return { fg: meter.danger.foreground, bg: meter.danger.background,      border: 'rgba(239,68,68,0.45)' };
    case 'accent':  return { fg: meter.accent.foreground, bg: 'rgba(167,139,250,0.16)',     border: 'rgba(167,139,250,0.45)' };
    case 'neutral':
    default:        return { fg: text.tertiary,           bg: surface.well,                 border: surface.border };
  }
}

export function LouiValueBadge(props: LouiValueBadgeProps) {
  const c = colourFor(props.status ?? 'neutral');
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      height: 22,
      paddingInline: 8,
      borderRadius: radius.chip,
      border: `1px solid ${c.border}`,
      background: c.bg,
      color: c.fg,
      fontFamily: typography.family.mono,
      fontSize: typography.size.xs,
      fontVariantNumeric: 'tabular-nums',
      whiteSpace: 'nowrap',
    }}>
      {props.label && (
        <span style={{
          color: text.muted,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          fontFamily: typography.family.sans,
          fontSize: 9,
        }}>
          {props.label}
        </span>
      )}
      <span>{props.children}</span>
    </span>
  );
}
