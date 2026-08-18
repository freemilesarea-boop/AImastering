// TrackColors — a colour per instrument, so a session reads at a glance.
//
// A DAW's arrange window is scanned, not read: an engineer looking for the
// bass looks for the blue block, not for the word "bass". The colours are
// therefore assigned by ROLE rather than by track order — the same
// instrument is the same colour in every session, which is what makes the
// habit worth having. Cubase's own defaults work the same way, and these
// follow the same broad grouping: drums warm, bass blue, voices gold,
// harmony green, effects violet.
//
// # Two palettes, because a colour is only legible against something
//
// The same hue cannot serve a charcoal arrange window and a white one. A
// yellow that reads as gold on #13131A is a pale smear on white, and a
// blue dark enough to label a white clip disappears on charcoal. So each
// role carries a set per surface:
//
//   • `accent` — the block, the stripe, the fader cap. A graphic element,
//     so it is held to 3:1 against its background (WCAG non-text contrast).
//   • `tint`   — the wash behind a row or a clip. Deliberately weak; it
//     groups without shouting, and the accent still has to stand out on it.
//   • `ink`    — label text on that tint, held to 4.5:1.
//
// `track-colors-selftest` measures every one of those ratios rather than
// trusting the eye, and also measures that no two roles land on the same
// hue — a palette where the guitar and the keys are both "green" classifies
// nothing.
//
// # Families are on purpose
//
// Kick, snare and drums are all warm; lead and backing vocal are both gold.
// Instruments that belong together should read as belonging together, and
// within a family they are separated by lightness rather than by hue. That
// is how a mixer with twenty channels stays scannable: five families, not
// twenty unrelated colours.

import type { StemRole } from '../../audio/presets/stem-defaults.js';

export interface RoleColors {
  /** Blocks, stripes, fader caps — graphic, ≥3:1 against the surface. */
  accent: string;
  /** A wash behind a row or clip. Weak by design. */
  tint: string;
  /** Label text on `tint`, ≥4.5:1. */
  ink: string;
}

/** Which backdrop the colours have to work against. */
export type Surface = 'light' | 'dark';

/**
 * The light palette — the DAW's own.
 *
 * Accents sit around the 600 step: dark enough to carry a clip on white,
 * saturated enough to name an instrument. Tints are the 50 step, which is
 * a wash rather than a colour. Ink is 700–800, which is where a label on
 * that wash becomes comfortable rather than merely legible.
 */
const LIGHT: Record<StemRole, RoleColors> = {
  kick:         { accent: '#dc2626', tint: '#fef2f2', ink: '#991b1b' },
  snare:        { accent: '#ea580c', tint: '#fff7ed', ink: '#9a3412' },
  drums:        { accent: '#d97706', tint: '#fffbeb', ink: '#92400e' },
  bass:         { accent: '#2563eb', tint: '#eff6ff', ink: '#1e40af' },
  vocal:        { accent: '#c026d3', tint: '#fdf4ff', ink: '#86198f' },
  'vocal-back': { accent: '#701a75', tint: '#fdf4ff', ink: '#701a75' },
  guitar:       { accent: '#16a34a', tint: '#f0fdf4', ink: '#15803d' },
  keys:         { accent: '#0e7490', tint: '#ecfeff', ink: '#155e75' },
  fx:           { accent: '#7c3aed', tint: '#f5f3ff', ink: '#5b21b6' },
  mid:          { accent: '#71717a', tint: '#fafafa', ink: '#3f3f46' },
  other:        { accent: '#3f3f46', tint: '#fafafa', ink: '#27272a' },
};

/**
 * The dark palette — the stem session and every other charcoal screen.
 *
 * Kept as it was: these are the values those screens were tuned against,
 * and re-tinting them to match the light set would change a screen nobody
 * asked to change.
 */
const DARK: Record<StemRole, RoleColors> = {
  kick:         { accent: '#ef4444', tint: 'rgba(239,68,68,0.12)',  ink: '#fca5a5' },
  snare:        { accent: '#f97316', tint: 'rgba(249,115,22,0.12)', ink: '#fdba74' },
  drums:        { accent: '#fbbf24', tint: 'rgba(251,191,36,0.12)', ink: '#fde68a' },
  bass:         { accent: '#3b82f6', tint: 'rgba(59,130,246,0.12)', ink: '#93c5fd' },
  vocal:        { accent: '#e879f9', tint: 'rgba(232,121,249,0.12)', ink: '#f5d0fe' },
  'vocal-back': { accent: '#c026d3', tint: 'rgba(192,38,211,0.12)', ink: '#f0abfc' },
  guitar:       { accent: '#22c55e', tint: 'rgba(34,197,94,0.12)',  ink: '#86efac' },
  keys:         { accent: '#22d3ee', tint: 'rgba(34,211,238,0.12)', ink: '#a5f3fc' },
  fx:           { accent: '#a78bfa', tint: 'rgba(167,139,250,0.12)', ink: '#ddd6fe' },
  mid:          { accent: '#a1a1aa', tint: 'rgba(161,161,170,0.10)', ink: '#e4e4e7' },
  other:        { accent: '#71717a', tint: 'rgba(113,113,122,0.10)', ink: '#d4d4d8' },
};

export const ROLE_PALETTE: Record<Surface, Record<StemRole, RoleColors>> = {
  light: LIGHT,
  dark: DARK,
};

/** Backwards-compatible accent map — the dark screens' colours. */
export const ROLE_COLOR: Record<StemRole, string> = Object.fromEntries(
  (Object.keys(DARK) as StemRole[]).map((r) => [r, DARK[r].accent]),
) as Record<StemRole, string>;

export const ROLE_LABEL: Record<StemRole, string> = {
  kick: '킥', snare: '스네어', drums: '드럼/퍼커션', bass: '베이스',
  vocal: '리드 보컬', 'vocal-back': '백 보컬', guitar: '기타',
  keys: '건반/신스', fx: '효과음', mid: '중역 악기', other: '미분류',
};

/**
 * Every colour a role needs on one surface.
 *
 * `dark` is the default so existing callers keep the screen they had.
 */
export function trackPalette(role: StemRole, surface: Surface = 'dark'): RoleColors {
  const set = ROLE_PALETTE[surface];
  return set[role] ?? set.other;
}

/** The accent alone — the common case. */
export function trackColor(role: StemRole, surface: Surface = 'dark'): string {
  return trackPalette(role, surface).accent;
}

export function roleLabel(role: StemRole): string {
  return ROLE_LABEL[role] ?? ROLE_LABEL.other;
}

// ── Contrast ────────────────────────────────────────────────────────────────
//
// Exported because the selftest measures the palette with them, and because
// a colour picked by eye and a colour that passes are not the same thing.

/** Parse `#rgb` / `#rrggbb` / `rgba(r,g,b,a)` into 0..255 components. */
export function parseColor(css: string): { r: number; g: number; b: number; a: number } | null {
  const hex = css.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1]!;
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
      a: 1,
    };
  }
  const rgba = css.trim().match(/^rgba?\(([^)]+)\)$/i);
  if (rgba) {
    const parts = rgba[1]!.split(',').map((p) => Number(p.trim()));
    if (parts.length < 3 || parts.some((p) => !Number.isFinite(p))) return null;
    return { r: parts[0]!, g: parts[1]!, b: parts[2]!, a: parts[3] ?? 1 };
  }
  return null;
}

/** Composite a possibly-translucent colour over an opaque one. */
export function over(fg: string, bg: string): string {
  const f = parseColor(fg);
  const b = parseColor(bg);
  if (!f || !b) return fg;
  const mix = (x: number, y: number): number => Math.round(x * f.a + y * (1 - f.a));
  return `rgb(${mix(f.r, b.r)},${mix(f.g, b.g)},${mix(f.b, b.b)})`;
}

/** WCAG relative luminance. */
export function luminance(css: string): number {
  const c = parseColor(css);
  if (!c) return 0;
  const ch = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

/** WCAG contrast ratio, 1..21. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Hue in degrees, 0..360. Used to check two roles are told apart. */
export function hue(css: string): number {
  const c = parseColor(css);
  if (!c) return 0;
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

/** Saturation, 0..1 — a neutral has no hue worth comparing. */
export function saturation(css: string): number {
  const c = parseColor(css);
  if (!c) return 0;
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}
