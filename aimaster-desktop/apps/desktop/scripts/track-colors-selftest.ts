// track-colors-selftest — the palette is measured, not eyeballed.
//
// Instrument colour is a classification tool: the point is that a glance at
// the arrange window finds the bass. That only works if the colours are
// legible against the surface they sit on and distinguishable from each
// other, and both of those are numbers rather than opinions.
//
// So every accent is measured against its backdrop at the WCAG non-text
// threshold (3:1 — it is a block, not a paragraph), every label against its
// own tint at the text threshold (4.5:1), and every pair of roles for hue
// separation. Families — the three drums, the two vocals — are allowed to
// share a hue and are then required to separate by lightness instead,
// because "these belong together" is information too.
//
// The controls at the end show what a failing palette looks like: the old
// dark accents put on white, which is exactly the mistake this file exists
// to stop.
//
// Run:  pnpm --filter @aimaster/desktop test:track-colors

import {
  ROLE_PALETTE, ROLE_LABEL, trackPalette, trackColor, roleLabel,
  contrast, hue, saturation, luminance, over, parseColor,
  type Surface,
} from '../src/renderer/components/daw/TrackColors.js';
import { STEM_ROLES, type StemRole } from '../src/renderer/audio/presets/stem-defaults.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (ok) { passed++; console.log(`[PASS] ${name} — ${detail}`); }
  else { failed++; console.error(`[FAIL] ${name} — ${detail}`); }
}

const ROLES: StemRole[] = [...STEM_ROLES];

// A guard on the fixture itself. Every lookup below falls back to `other`
// for an unknown role, so a mis-shaped list would let the whole file pass
// while measuring one colour eleven times.
if (ROLES.some((r) => typeof r !== 'string' || !ROLE_LABEL[r])) {
  console.error('[FAIL] the role list is not a list of roles —', JSON.stringify(ROLES));
  process.exit(1);
}

/** The page behind each palette. */
const BACKDROP: Record<Surface, string> = {
  light: '#ffffff',
  dark: '#13131A',
};

/** Roles that are meant to look related. Within one, hue may repeat. */
const FAMILIES: StemRole[][] = [
  ['kick', 'snare', 'drums'],
  ['vocal', 'vocal-back'],
];

function familyOf(role: StemRole): StemRole[] | null {
  return FAMILIES.find((f) => f.includes(role)) ?? null;
}

console.log('\n=== EVERY ROLE HAS COLOURS ===\n');
{
  check('the roles list is not empty', ROLES.length >= 10, `${ROLES.length}개 역할`);
  const missing = ROLES.filter((r) => !ROLE_PALETTE.light[r] || !ROLE_PALETTE.dark[r]);
  check(
    'both palettes cover every role',
    missing.length === 0,
    missing.length === 0 ? `${ROLES.length}개 전부` : `빠진 역할: ${missing.join(', ')}`,
  );
  const unparsed: string[] = [];
  for (const surface of ['light', 'dark'] as Surface[]) {
    for (const r of ROLES) {
      const p = trackPalette(r, surface);
      for (const [k, v] of Object.entries(p)) {
        if (!parseColor(v)) unparsed.push(`${surface}/${r}/${k}=${v}`);
      }
    }
  }
  check('every value parses as a colour', unparsed.length === 0, unparsed.join(', ') || '전부 유효');
  const unlabelled = ROLES.filter((r) => !ROLE_LABEL[r]);
  check('and every role has a Korean label', unlabelled.length === 0, unlabelled.join(', ') || `${ROLES.length}개`);
}

console.log('\n=== THE ACCENT IS VISIBLE ON ITS SURFACE ===\n');
{
  // 3:1 is the WCAG threshold for a graphic element. A clip block, a track
  // stripe and a fader cap are graphic elements.
  for (const surface of ['light', 'dark'] as Surface[]) {
    const bg = BACKDROP[surface];
    const weak: string[] = [];
    let worst = { role: '', ratio: 99 };
    for (const r of ROLES) {
      const ratio = contrast(trackPalette(r, surface).accent, bg);
      if (ratio < 3) weak.push(`${r} ${ratio.toFixed(2)}:1`);
      if (ratio < worst.ratio) worst = { role: r, ratio };
    }
    check(
      `${surface}: every accent clears 3:1 on ${bg}`,
      weak.length === 0,
      weak.length === 0
        ? `가장 낮은 값 ${worst.role} ${worst.ratio.toFixed(2)}:1`
        : `기준 미달: ${weak.join(', ')}`,
    );
  }
}

console.log('\n=== A LABEL ON ITS TINT IS READABLE ===\n');
{
  for (const surface of ['light', 'dark'] as Surface[]) {
    const bg = BACKDROP[surface];
    const weak: string[] = [];
    let worst = { role: '', ratio: 99 };
    for (const r of ROLES) {
      const p = trackPalette(r, surface);
      // A translucent tint shows the page through it, so the ratio has to
      // be measured against what is actually on screen.
      const composited = over(p.tint, bg);
      const ratio = contrast(p.ink, composited);
      if (ratio < 4.5) weak.push(`${r} ${ratio.toFixed(2)}:1`);
      if (ratio < worst.ratio) worst = { role: r, ratio };
    }
    check(
      `${surface}: every label clears 4.5:1 on its own tint`,
      weak.length === 0,
      weak.length === 0
        ? `가장 낮은 값 ${worst.role} ${worst.ratio.toFixed(2)}:1`
        : `기준 미달: ${weak.join(', ')}`,
    );
  }
}

console.log('\n=== THE TINT IS A WASH, NOT A COLOUR ===\n');
{
  // A tint that competes with the accent stops being a background. On the
  // light palette it must stay close to the page.
  const loud: string[] = [];
  for (const r of ROLES) {
    const p = trackPalette(r, 'light');
    const ratio = contrast(p.tint, '#ffffff');
    if (ratio > 1.25) loud.push(`${r} ${ratio.toFixed(2)}:1`);
  }
  check(
    'light tints stay within 1.25:1 of the page',
    loud.length === 0,
    loud.length === 0 ? '전부 옅은 워시' : `너무 진한 틴트: ${loud.join(', ')}`,
  );

  // And the accent still has to be visible ON the tint, or a clip on a
  // tinted row disappears.
  const lost: string[] = [];
  for (const surface of ['light', 'dark'] as Surface[]) {
    for (const r of ROLES) {
      const p = trackPalette(r, surface);
      if (contrast(p.accent, over(p.tint, BACKDROP[surface])) < 3) {
        lost.push(`${surface}/${r}`);
      }
    }
  }
  check(
    'and the accent still reads on top of its own tint',
    lost.length === 0,
    lost.length === 0 ? '전부 3:1 이상' : `묻히는 조합: ${lost.join(', ')}`,
  );
}

console.log('\n=== ROLES ARE TOLD APART ===\n');
{
  for (const surface of ['light', 'dark'] as Surface[]) {
    const clashes: string[] = [];
    for (let i = 0; i < ROLES.length; i++) {
      for (let j = i + 1; j < ROLES.length; j++) {
        const a = ROLES[i]!;
        const b = ROLES[j]!;
        const ca = trackPalette(a, surface).accent;
        const cb = trackPalette(b, surface).accent;
        if (ca === cb) { clashes.push(`${a}/${b} 동일 색상`); continue; }

        // How two colours are told apart depends on what they are.
        //
        //   • two greys — nothing but lightness distinguishes them;
        //   • a grey and a colour — chroma already does it, and demanding a
        //     lightness gap between red and grey would be measuring the
        //     wrong thing;
        //   • two colours — hue, unless they are the same instrument family,
        //     in which case sharing a hue is the point and lightness carries
        //     the difference.
        const aNeutral = saturation(ca) < 0.2;
        const bNeutral = saturation(cb) < 0.2;
        const sameFamily = familyOf(a) !== null && familyOf(a) === familyOf(b);

        if (aNeutral !== bNeutral) continue;
        if ((aNeutral && bNeutral) || sameFamily) {
          const dl = Math.abs(luminance(ca) - luminance(cb));
          if (dl < 0.02) clashes.push(`${a}/${b} 명도차 ${dl.toFixed(3)}`);
          continue;
        }
        const dh = Math.abs(hue(ca) - hue(cb));
        const sep = Math.min(dh, 360 - dh);
        if (sep < 25) clashes.push(`${a}/${b} 색상차 ${sep.toFixed(0)}°`);
      }
    }
    check(
      `${surface}: no two roles collide`,
      clashes.length === 0,
      clashes.length === 0
        ? `${(ROLES.length * (ROLES.length - 1)) / 2}쌍 전부 구분됨`
        : clashes.join(', '),
    );
  }
}

console.log('\n=== FAMILIES READ AS FAMILIES ===\n');
{
  for (const family of FAMILIES) {
    const hues = family.map((r) => hue(trackPalette(r, 'light').accent));
    const spread = Math.max(...hues) - Math.min(...hues);
    check(
      `${family.join(' · ')} share a hue family`,
      spread <= 60,
      `색상 범위 ${spread.toFixed(0)}° — 같이 묶여 보여야 한다`,
    );
    // …but are still individually findable.
    const lums = family.map((r) => luminance(trackPalette(r, 'light').accent));
    const gaps = lums.slice(1).map((l, i) => Math.abs(l - lums[i]!));
    check(
      `and are still separable within it`,
      gaps.every((g) => g > 0.01),
      `명도 간격 ${gaps.map((g) => g.toFixed(3)).join(', ')}`,
    );
  }
}

console.log('\n=== THE API ===\n');
{
  check(
    'trackColor defaults to the dark palette',
    trackColor('bass') === ROLE_PALETTE.dark.bass.accent,
    '기존 화면은 그대로다',
  );
  check(
    'and takes the light one when asked',
    trackColor('bass', 'light') === ROLE_PALETTE.light.bass.accent,
    `${trackColor('bass', 'light')}`,
  );
  check(
    'an unknown role falls back rather than returning undefined',
    trackPalette('not-a-role' as StemRole, 'light').accent === ROLE_PALETTE.light.other.accent,
    '미분류 색상으로',
  );
  check('roleLabel is Korean', roleLabel('kick') === '킥', roleLabel('kick'));
}

console.log('\n=== THE CONTROLS ===\n');
{
  // 1. The measurement works: white on white must fail.
  check(
    'control — contrast() rejects white on white',
    contrast('#ffffff', '#ffffff') === 1,
    `${contrast('#ffffff', '#ffffff').toFixed(2)}:1 — 측정이 실제로 동작한다`,
  );

  // 2. The mistake this palette exists to avoid: the charcoal-tuned accents
  //    used on a white page.
  const wouldFail = ROLES.filter((r) => contrast(ROLE_PALETTE.dark[r].accent, '#ffffff') < 3);
  check(
    'control — the dark accents would fail on white',
    wouldFail.length > 0,
    `${wouldFail.length}개 역할(${wouldFail.slice(0, 4).join(', ')}…)이 3:1 미만 — 팔레트를 나눈 이유`,
  );

  // 3. And the light ones would be no good on charcoal, which is why the
  //    stem session keeps its own.
  const wouldFailDark = ROLES.filter((r) => contrast(ROLE_PALETTE.light[r].accent, '#13131A') < 3);
  check(
    'control — the light accents would fail on charcoal',
    wouldFailDark.length > 0,
    `${wouldFailDark.length}개 역할이 3:1 미만 — 한 팔레트로는 두 화면을 못 쓴다`,
  );

  check(
    'control — hue() separates red from blue',
    Math.abs(hue('#ff0000') - hue('#0000ff')) > 200,
    `${hue('#ff0000').toFixed(0)}° vs ${hue('#0000ff').toFixed(0)}°`,
  );
  check(
    'control — over() composites a translucent tint',
    over('rgba(0,0,0,0.5)', '#ffffff') === 'rgb(128,128,128)',
    over('rgba(0,0,0,0.5)', '#ffffff'),
  );
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
