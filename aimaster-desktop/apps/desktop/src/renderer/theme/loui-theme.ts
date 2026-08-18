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
//
// The surface and text scales are CSS custom properties with the charcoal
// values as fallbacks, rather than literals. That is what lets a subtree —
// the DAW, which is a white workspace — be re-skinned by setting variables
// on one element, without every component that inlines these tokens having
// to learn about themes.
//
// Deliberately NOT the accent scales below. Those are read into `<canvas>`
// fill and stroke styles in a couple of places, and a canvas cannot resolve
// `var(...)`: it would silently keep the previous colour. Accents also mean
// the same thing on either backdrop — a warning is amber whatever the page
// is — so there is nothing to switch.

/**
 * Neutral backdrop scale.  Inspired by Logic Pro / Ableton Live 12 /
 * Apple Pro Apps: a charcoal (NOT pure-black) base with clear surface
 * elevation steps so panels read as layered, not flat.
 *
 * Elevation ladder:  background < panel < well < overlay
 */
export const surface = {
  /** Page background — charcoal, never pure black. */
  background: 'var(--loui-surface-background, #13131A)',
  /** Card / panel background (main panel). */
  panel:      'var(--loui-surface-panel, #1A1A24)',
  /** Panel border (hairline). */
  border:     'var(--loui-surface-border, rgba(255,255,255,0.08))',
  /** Stronger border for elevated / focused surfaces. */
  borderElevated: 'var(--loui-surface-border-elevated, rgba(255,255,255,0.14))',
  /** Inset wells / raised secondary surfaces. */
  well:       'var(--loui-surface-well, #222230)',
  /** Tooltip / hover overlay — the lightest surface step. */
  overlay:    'var(--loui-surface-overlay, #2A2A36)',
} as const;

/**
 * Text scale.  Alpha-on-charcoal so emphasis reads as hierarchy, not as
 * harsh pure-white — comfortable for long late-night sessions.
 */
export const text = {
  primary:   'var(--loui-text-primary, rgba(255,255,255,0.92))',
  secondary: 'var(--loui-text-secondary, rgba(255,255,255,0.70))',
  tertiary:  'var(--loui-text-tertiary, rgba(255,255,255,0.55))',
  muted:     'var(--loui-text-muted, rgba(255,255,255,0.42))',
  disabled:  'var(--loui-text-disabled, rgba(255,255,255,0.30))',
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
    foreground: 'var(--loui-meter-safe, #10b981)',
    background: 'var(--loui-meter-safe-bg, rgba(16, 185, 129, 0.18))',
  },
  /** Warning zone (peaking, hot transients). */
  warn: {
    foreground: 'var(--loui-meter-warn, #f59e0b)',
    background: 'var(--loui-meter-warn-bg, rgba(245, 158, 11, 0.22))',
  },
  /** Hot — over typical streaming targets. */
  hot: {
    foreground: 'var(--loui-meter-hot, #fb923c)',
    background: 'var(--loui-meter-hot-bg, rgba(251, 146, 60, 0.20))',
  },
  /** Danger — TP at ceiling, clipping risk. */
  danger: {
    foreground: 'var(--loui-meter-danger, #ef4444)',
    background: 'var(--loui-meter-danger-bg, rgba(239, 68, 68, 0.22))',
  },
  /** Cool — quiet content / acoustic targets. */
  cool: {
    foreground: 'var(--loui-meter-cool, #3b82f6)',
    background: 'var(--loui-meter-cool-bg, rgba(59, 130, 246, 0.18))',
  },
  /** Accent — Loui's signature violet for spectrum / chart fills. */
  accent: {
    foreground: 'var(--loui-meter-accent, #a78bfa)',
    background: 'var(--loui-meter-accent-bg, rgba(167, 139, 250, 0.55))',
    fade:       'var(--loui-meter-accent-fade, rgba(167, 139, 250, 0.05))',
  },
} as const;

/**
 * The same scale as literal colours, for `<canvas>`.
 *
 * A canvas cannot resolve `var(...)`: assigning one to `fillStyle` is
 * ignored and the previous colour silently stays. Anything drawing to a
 * canvas has to read from here instead — and gets the charcoal values,
 * which is correct, because the canvases that use them are on charcoal
 * screens.
 */
export const meterLiteral = {
  safe:   { foreground: '#10b981' },
  warn:   { foreground: '#f59e0b' },
  hot:    { foreground: '#fb923c' },
  danger: { foreground: '#ef4444' },
  cool:   { foreground: '#3b82f6' },
  accent: { foreground: '#a78bfa' },
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
