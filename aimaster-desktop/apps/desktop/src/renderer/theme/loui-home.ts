// Loui Mastering — lavender identity tokens for the setup (Home) screen.
//
// A premium dark-audio palette built around Loui's signature lavender.
// Kept deliberately small + flat so the HomePage (which is Tailwind-based)
// can apply them via inline styles / arbitrary classes without a config
// change.  Reused by the Storybook story for the hero.

export const loui = {
  /** Primary brand lavender — titles, active accents, focus glow. */
  primaryLavender: '#A78BFA',
  /** Pressed / strong active state. */
  activeViolet: '#8B5CF6',
  /** Soft tint — secondary text accents, gradients. */
  softLavender: '#C4B5FD',

  // ── Charcoal surface ladder (DESIGN-POLISH-2) ──────────────────────
  /** App root background — charcoal, never pure black. */
  appBackground: '#13131A',
  /** Main panel surface. */
  mainPanel: '#1A1A24',
  /** Elevated card surface (raised above the main panel). */
  elevatedPanel: '#222230',
  /** Lightest subtle surface (hover / inset). */
  surfaceSubtle: '#2A2A36',

  /** @deprecated alias of appBackground — kept for existing call sites. */
  deepPanel: '#13131A',
  /** @deprecated alias of elevatedPanel — kept for existing call sites. */
  panelElevated: '#222230',

  /** Hairline border. */
  borderSubtle: 'rgba(255,255,255,0.08)',
  /** Stronger border for elevated / active surfaces. */
  borderElevated: 'rgba(255,255,255,0.14)',
  /** Lavender glow — kept SUBTLE (not gaming-RGB). */
  glowLavender: 'rgba(167,139,250,0.18)',

  /** Status colours. */
  successMint: '#34D399',
  warningAmber: '#FBBF24',

  // ── Text (alpha-on-charcoal hierarchy) ─────────────────────────────
  textPrimary: 'rgba(255,255,255,0.92)',
  textSecondary: 'rgba(255,255,255,0.62)',
  textMuted: 'rgba(255,255,255,0.42)',
} as const;

/** Lavender-tinted alpha helpers (for borders / fills / glows). */
export const louiAlpha = {
  lav: (a: number) => `rgba(167,139,250,${a})`,
  violet: (a: number) => `rgba(139,92,246,${a})`,
} as const;
