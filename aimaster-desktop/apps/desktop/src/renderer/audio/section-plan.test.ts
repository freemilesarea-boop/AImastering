import { describe, it, expect } from 'vitest';
import {
  defaultSectionPlan, isSectionPlanUnity, buildSectionPlanFromAnalysis,
  sanitizeSectionPlan, setSectionGain, SECTION_GAIN_RANGE,
} from './section-plan.js';
import type { SectionSegment } from '@aimaster/shared-types';

const seg = (start: number, end: number, kind: SectionSegment['kind'] = 'verse'): SectionSegment => ({ start, end, kind, energy: 'mid' });

describe('section-plan model', () => {
  it('default is disabled + empty → unity', () => {
    const p = defaultSectionPlan();
    expect(p.enabled).toBe(false);
    expect(isSectionPlanUnity(p)).toBe(true);
  });

  it('builds a 0 dB gain per detected section', () => {
    const p = buildSectionPlanFromAnalysis([seg(0, 10), seg(10, 20, 'chorus')]);
    expect(p.gains).toHaveLength(2);
    expect(p.gains.every((g) => g.gainDb === 0)).toBe(true);
    expect(p.gains[1]!.startSec).toBe(10);
  });

  it('build drops degenerate ranges', () => {
    const p = buildSectionPlanFromAnalysis([seg(0, 10), seg(20, 20), { start: NaN, end: 5, kind: 'verse', energy: 'mid' }]);
    expect(p.gains).toHaveLength(1);
  });

  it('build preserves prior gains for unchanged ranges', () => {
    const prev = setSectionGain(buildSectionPlanFromAnalysis([seg(0, 10), seg(10, 20)]), 1, 4);
    const next = buildSectionPlanFromAnalysis([seg(0, 10), seg(10, 20)], prev);
    expect(next.gains[1]!.gainDb).toBe(4);
  });

  it('build resets gain when a section range changes', () => {
    const prev = setSectionGain(buildSectionPlanFromAnalysis([seg(10, 20)]), 0, 5);
    const next = buildSectionPlanFromAnalysis([seg(12, 22)], prev); // different range
    expect(next.gains[0]!.gainDb).toBe(0);
  });

  it('setSectionGain clamps to range and is bounds-safe', () => {
    const p = buildSectionPlanFromAnalysis([seg(0, 10)]);
    expect(setSectionGain(p, 0, 99).gains[0]!.gainDb).toBe(SECTION_GAIN_RANGE.max);
    expect(setSectionGain(p, 5, 3)).toBe(p); // out-of-range index → unchanged
  });

  it('isSectionPlanUnity tracks enabled + non-zero gains', () => {
    let p = buildSectionPlanFromAnalysis([seg(0, 10)]);
    expect(isSectionPlanUnity(p)).toBe(true);   // disabled
    p = { ...p, enabled: true };
    expect(isSectionPlanUnity(p)).toBe(true);    // all zero
    p = setSectionGain({ ...p }, 0, 3);
    expect(isSectionPlanUnity(p)).toBe(false);
  });

  it('sanitize clamps crossfade + gains', () => {
    const s = sanitizeSectionPlan({ enabled: true, crossfadeMs: -10, gains: [{ startSec: 0, endSec: 1, gainDb: 50 }] });
    expect(s.crossfadeMs).toBe(0);
    expect(s.gains[0]!.gainDb).toBe(SECTION_GAIN_RANGE.max);
  });
});
