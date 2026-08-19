// Premium surface tokens.
//
// The rest of the app is a working dark UI; these tokens are for the surfaces
// a user looks at while making a creative decision — the Smart Controls, the
// console strips, the stack headers.  The intent is "instrument", not
// "dashboard": deep neutral ground, one warm metal accent, hairline borders,
// and light that always comes from above.
//
// Rules that keep it coherent:
//   • ONE accent family (brass).  Colour is information, not decoration —
//     anything gold is a value the user set.
//   • Elevation is expressed by a lighter surface + a tighter shadow, never
//     by a border alone.
//   • Type: a display serif for module names (engraved-panel feel), a tight
//     sans for labels, tabular figures for anything numeric.

export const premiumSurface = {
  /** Deepest ground — behind panels. */
  abyss:   '#08080C',
  /** Panel body. */
  panel:   '#12121A',
  /** Raised module frame. */
  frame:   '#171722',
  /** Inset well (readouts, tables). */
  well:    '#0D0D14',
  /** Hover / active overlay. */
  overlay: '#1E1E2C',
  hairline:      'rgba(255,255,255,0.07)',
  hairlineStrong: 'rgba(255,255,255,0.14)',
  /** Warm rule used to frame a module group, like an engraved panel. */
  engrave: 'rgba(198,167,104,0.28)',
} as const;

export const premiumAccent = {
  /** Brass — the single accent. */
  base:  '#C6A768',
  light: '#E6D2A0',
  deep:  '#8A6F3C',
  glow:  'rgba(198,167,104,0.35)',
  /** Cool secondary, for informational (not user-set) values. */
  cool:  '#6E9BD6',
  danger: '#D46A6A',
  good:   '#6FBF8F',
} as const;

export const premiumText = {
  primary:   'rgba(255,255,255,0.92)',
  secondary: 'rgba(255,255,255,0.66)',
  muted:     'rgba(255,255,255,0.42)',
  faint:     'rgba(255,255,255,0.26)',
  onAccent:  '#1A1408',
} as const;

export const premiumType = {
  /** Module titles — engraved plate. */
  display: "'Cormorant Garamond', 'Iowan Old Style', Georgia, 'Times New Roman', serif",
  sans:    "'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
  mono:    "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
} as const;

export const premiumShadow = {
  /** Panel lifting off the ground. */
  panel: '0 18px 48px rgba(0,0,0,0.55), 0 1px 0 rgba(255,255,255,0.05) inset',
  /** Module frame. */
  frame: '0 8px 20px rgba(0,0,0,0.45), 0 1px 0 rgba(255,255,255,0.04) inset',
  /** Knob cap. */
  knob:  '0 6px 14px rgba(0,0,0,0.6), 0 1px 1px rgba(255,255,255,0.10) inset',
  /** Focus ring. */
  focus: `0 0 0 1px ${premiumAccent.base}, 0 0 14px ${premiumAccent.glow}`,
} as const;

/** Vertical light: every raised surface is brighter at the top. */
export const premiumGradient = {
  panel: 'linear-gradient(180deg, rgba(255,255,255,0.035) 0%, rgba(255,255,255,0) 42%)',
  frame: 'linear-gradient(180deg, rgba(255,255,255,0.05) 0%, rgba(0,0,0,0.18) 100%)',
  well:  'linear-gradient(180deg, rgba(0,0,0,0.35) 0%, rgba(255,255,255,0.02) 100%)',
  /** Brushed metal for a knob cap. */
  metal:
    'conic-gradient(from 210deg at 50% 50%,'
    + ' #6A6A78 0deg, #B9B9C6 40deg, #7C7C8A 90deg, #C9C9D6 150deg,'
    + ' #6E6E7C 210deg, #ADADBA 280deg, #6A6A78 360deg)',
  brass:
    'conic-gradient(from 210deg at 50% 50%,'
    + ' #7A6234 0deg, #E4CD97 42deg, #9C7F45 96deg, #F0DDAE 152deg,'
    + ' #856A38 214deg, #D8BE86 286deg, #7A6234 360deg)',
} as const;

export const premiumMotion = {
  /** Everything moves like a physical control: quick out, settled in. */
  snap: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
  fast: '120ms',
  base: '200ms',
} as const;

export const premium = {
  surface: premiumSurface,
  accent: premiumAccent,
  text: premiumText,
  type: premiumType,
  shadow: premiumShadow,
  gradient: premiumGradient,
  motion: premiumMotion,
} as const;
