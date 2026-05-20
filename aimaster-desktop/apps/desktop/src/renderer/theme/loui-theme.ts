// Loui Mastering — design system tokens v1.
//
// Centralises the colour / spacing / typography / motion scales that the
// V2 analyzer panels currently encode as Tailwind utility classes.  By
// pulling them out here we get:
//   • one place to tune the visual identity across panels
//   • Storybook docs auto-generated from the same tokens
//   • a hand-off surface for a future visual-design pass
//
// IMPORTANT — additive only:
//   This module is NOT yet referenced by the production panels.  Existing
//   Tailwind classes continue to work.  Migration happens panel-by-panel
//   in M3-P-NEXT-3 (Product Layout); refactoring the V2 panels to consume
//   these tokens is incremental.

// ── Colour scale ─────────────────────────────────────────────────────────

/**
 * Neutral backdrop scale.  Inspired by Logic Pro / Ableton Live 12 /
 * Apple Pro Apps: a charcoal (NOT pure-black) base with clear surface
 * elevation steps so panels read as layered, not flat.
 *
 * Elevation ladder:  background < panel < well < overlay
 */
export const surface = {
  /** Page background — charcoal, never pure black. */
  background: '#13131A',
  /** Card / panel background (main panel). */
  panel:      '#1A1A24',
  /** Panel border (hairline). */
  border:     'rgba(255,255,255,0.08)',
  /** Stronger border for elevated / focused surfaces. */
  borderElevated: 'rgba(255,255,255,0.14)',
  /** Inset wells / raised secondary surfaces. */
  well:       '#222230',
  /** Tooltip / hover overlay — the lightest surface step. */
  overlay:    '#2A2A36',
} as const;

/**
 * Text scale.  Alpha-on-charcoal so emphasis reads as hierarchy, not as
 * harsh pure-white — comfortable for long late-night sessions.
 */
export const text = {
  primary:   'rgba(255,255,255,0.92)',
  secondary: 'rgba(255,255,255,0.70)',
  tertiary:  'rgba(255,255,255,0.55)',
  muted:     'rgba(255,255,255,0.42)',
  disabled:  'rgba(255,255,255,0.30)',
} as const;

/**
 * Loudness verdict colour scale — mirrors the V2 meter / scope panels.
 * Used by the bar fills and verdict chips.
 *
 * Restraint policy:
 *   • Saturation kept moderate (no neon).
 *   • Each colour has a 30 %-opacity background variant for fills.
 *   • Pure red is reserved for safety violations only (e.g. true-peak
 *     overshoot, phase risk).
 */
export const meter = {
  /** Safe streaming range (≤ -14 LUFS for streaming target). */
  safe: {
    foreground: '#10b981',
    background: 'rgba(16, 185, 129, 0.18)',
  },
  /** Warning zone (peaking, hot transients). */
  warn: {
    foreground: '#f59e0b',
    background: 'rgba(245, 158, 11, 0.22)',
  },
  /** Hot — over typical streaming targets. */
  hot: {
    foreground: '#fb923c',
    background: 'rgba(251, 146, 60, 0.20)',
  },
  /** Danger — TP at ceiling, clipping risk. */
  danger: {
    foreground: '#ef4444',
    background: 'rgba(239, 68, 68, 0.22)',
  },
  /** Cool — quiet content / acoustic targets. */
  cool: {
    foreground: '#3b82f6',
    background: 'rgba(59, 130, 246, 0.18)',
  },
  /** Accent — Loui's signature violet for spectrum / chart fills. */
  accent: {
    foreground: '#a78bfa',
    background: 'rgba(167, 139, 250, 0.55)',
    fade:       'rgba(167, 139, 250, 0.05)',
  },
} as const;

// ── Spacing scale ────────────────────────────────────────────────────────

/**
 * 4-step spacing scale.  Matches the panel layouts already in use.
 * Pixel values commit to a 4 px base unit so cards align on a grid.
 */
export const space = {
  '1':  '0.25rem',  //  4 px — chip padding
  '2':  '0.5rem',   //  8 px — meter row gap
  '3':  '0.75rem',  // 12 px — panel inner padding (default)
  '4':  '1rem',     // 16 px — panel-to-panel
  '5':  '1.25rem',  // 20 px — page section
  '6':  '1.5rem',   // 24 px — page-level margin
} as const;

// ── Border radius ────────────────────────────────────────────────────────

/** Two-step radius scale.  Bars / chips use the small one; panels the larger. */
export const radius = {
  bar:    '0.125rem', //  2 px — meter bars
  chip:   '0.375rem', //  6 px — verdict chip
  panel:  '0.75rem',  // 12 px — panel container
} as const;

// ── Elevation ────────────────────────────────────────────────────────────

/**
 * Panel elevation is purely tonal in Loui's dark theme — no drop shadows.
 * Higher elevation = brighter surface (Material's tonal-elevation model).
 */
export const elevation = {
  /** Page background — no elevation. */
  0: surface.background,
  /** Panel surface. */
  1: surface.panel,
  /** Inset well / well-of-well. */
  2: surface.well,
  /** Hover / focus inset. */
  3: surface.overlay,
} as const;

// ── Typography ───────────────────────────────────────────────────────────

/**
 * Type ramp.  Two families:
 *   • UI text — system-ui stack
 *   • Numeric / mono — tabular numbers for stable meter alignment
 */
export const typography = {
  family: {
    sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  },
  /** Use tabular-nums everywhere a number changes value live. */
  liveNumeric: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontVariantNumeric: 'tabular-nums' as const,
  },
  size: {
    /** Smallest — meter row labels, footer hints. */
    xs:  '0.625rem', // 10 px
    /** Default — panel body. */
    sm:  '0.75rem',  // 12 px
    /** Panel header. */
    md:  '0.875rem', // 14 px
    /** Top-bar title. */
    lg:  '1rem',     // 16 px
  },
  weight: {
    normal: 400,
    medium: 500,
    semi:   600,
  },
} as const;

// ── Motion ───────────────────────────────────────────────────────────────

/**
 * Animation durations.  Audio panels prefer "fast and linear" — bars
 * snapping into position feels responsive; eased curves feel laggy
 * for meter content.
 */
export const motion = {
  /** Meter bar follow-up — bar width animations. */
  meterFollow:  '100ms linear',
  /** Verdict chip swap — short fade. */
  chipSwap:     '150ms ease-out',
  /** Page-level transitions — pages, modals. */
  pageTransition: '200ms ease-out',
  /** Spectrum smoothing is handled in DSP; visual transition is none. */
  spectrumRender: '0ms',
} as const;

// ── Convenience: the full theme object ──────────────────────────────────

/**
 * Combined token surface — useful for theme-aware components that take
 * a theme prop, or for design-system docs.
 */
export const louiTheme = {
  surface,
  text,
  meter,
  space,
  radius,
  elevation,
  typography,
  motion,
} as const;

export type LouiTheme = typeof louiTheme;
