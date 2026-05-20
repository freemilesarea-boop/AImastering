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
  /** Deepest surface (page background blends). */
  deepPanel: '#111118',
  /** Elevated card surface. */
  panelElevated: '#181820',
  /** Hairline border. */
  borderSubtle: 'rgba(255,255,255,0.08)',
  /** Lavender glow for active cards / CTA. */
  glowLavender: 'rgba(167,139,250,0.28)',
  /** Status colours. */
  successMint: '#34D399',
  warningAmber: '#FBBF24',
} as const;

/** Lavender-tinted alpha helpers (for borders / fills / glows). */
export const louiAlpha = {
  lav: (a: number) => `rgba(167,139,250,${a})`,
  violet: (a: number) => `rgba(139,92,246,${a})`,
} as const;
