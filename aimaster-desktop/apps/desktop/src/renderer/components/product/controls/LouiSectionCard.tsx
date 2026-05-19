// LouiSectionCard — grouping wrapper inside a parameter panel.
//
// Provides:
//   • Section title (uppercase, accent-tinted small)
//   • Optional right-aligned trailing element (e.g. bypass toggle)
//   • Content slot with consistent inner padding

import React from 'react';
import { surface, text, typography, space, radius } from '../../../theme/loui-theme.js';

export interface LouiSectionCardProps {
  title: string;
  trailing?: React.ReactNode;
  children: React.ReactNode;
  /** Optional dim treatment when the section is bypassed. */
  dimmed?: boolean;
}

export function LouiSectionCard(props: LouiSectionCardProps) {
  return (
    <section style={{
      background: surface.panel,
      border: `1px solid ${surface.border}`,
      borderRadius: radius.panel,
      overflow: 'hidden',
      opacity: props.dimmed ? 0.7 : 1,
      transition: 'opacity 120ms ease-out',
    }}>
      <header style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingInline: space['4'],
        paddingBlock: space['2'],
        borderBottom: `1px solid ${surface.border}`,
        background: surface.well,
      }}>
        <span style={{
          fontFamily: typography.family.sans,
          fontSize: typography.size.xs,
          fontWeight: typography.weight.medium,
          color: text.muted,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
        }}>
          {props.title}
        </span>
        {props.trailing}
      </header>
      <div style={{
        padding: space['4'],
        display: 'flex',
        flexDirection: 'column',
        gap: space['3'],
      }}>
        {props.children}
      </div>
    </section>
  );
}
