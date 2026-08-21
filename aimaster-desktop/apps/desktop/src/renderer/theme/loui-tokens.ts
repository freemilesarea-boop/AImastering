// Loui Mastering — guided-flow design tokens (PROTOTYPE-PORT T1).
//
// Extends theme/loui-home.ts with the values the guided flow needs:
// the default lavender accent and the KPOP Loud "signature" accent.
// Kept as flat values + CSSProperties so Tailwind-based components can
// apply them via inline `style={}` without a tailwind.config change.
//
// Mirrors design/loui-mockups-v2.html + design/loui-interactive-prototype.html.

import type { CSSProperties } from 'react';
import type { MasteringStyle } from '@aimaster/shared-types';

/** Default lavender accent (matches loui-home primaryLavender/activeViolet). */
export const accent = {
  a: '#6C5CE7',
  b: '#8B7BFF',
  grad: 'linear-gradient(180deg,#8B7BFF,#6C5CE7)',
  glow: 'rgba(108,92,231,0.32)',
} as const;

/** KPOP Loud signature accent (magenta → orange). */
export const kpop = {
  a: '#FF3D77',
  b: '#FF8A3D',
  grad: 'linear-gradient(90deg,#FF3D77,#FF8A3D)',
  glow: 'rgba(255,61,119,0.30)',
} as const;

/** Loudness target line / marker colour. */
export const targetLine = '#7C8AFF';

export interface StyleAccent {
  isKpop: boolean;
  a: string;
  b: string;
  /** Full gradient (buttons / fills). */
  grad: string;
  /** Soft glow rgba for shadows. */
  glow: string;
}

/** Resolve the accent for a given mastering style (KPOP Loud = signature). */
export function styleAccent(style: MasteringStyle | string | null | undefined): StyleAccent {
  if (style === 'kpop_loud') {
    return { isKpop: true, a: kpop.a, b: kpop.b, grad: kpop.grad, glow: kpop.glow };
  }
  return { isKpop: false, a: accent.a, b: accent.b, grad: accent.grad, glow: accent.glow };
}

/** Inline style for a primary CTA in the given style's accent. */
export function ctaStyle(style: MasteringStyle | string | null | undefined): CSSProperties {
  const s = styleAccent(style);
  return {
    background: s.grad,
    color: s.isKpop ? '#1A0A10' : '#FFFFFF',
    boxShadow: `0 10px 30px ${s.glow}`,
  };
}

/** Inline style for a gradient text fill (achievement number / KPOP name). */
export function gradientTextStyle(style: MasteringStyle | string | null | undefined): CSSProperties {
  const s = styleAccent(style);
  const grad = s.isKpop
    ? 'linear-gradient(90deg,#FFFFFF,#FFD0B0)'
    : 'linear-gradient(90deg,#FFFFFF,#CDBCFF)';
  return {
    background: grad,
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    color: 'transparent',
  };
}
