import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SectionMasteringPanel from './SectionMasteringPanel.js';
import { useAudioStore } from '../stores/audioStore.js';
import { defaultSectionPlan } from '../audio/section-plan.js';
import type { MasteringResult } from '@aimaster/shared-types';

function seedSections(): void {
  useAudioStore.setState({
    masteringResult: {
      sectionAnalysis: {
        sections: [
          { start: 0, end: 10, kind: 'verse', energy: 'mid' },
          { start: 10, end: 20, kind: 'chorus', energy: 'high' },
        ],
        dynamicRangeLu: null, alternationScore: null,
        sectionCounts: { high: 1, mid: 1, low: 0 },
      },
    } as unknown as MasteringResult,
    sectionPlan: defaultSectionPlan(),
  });
}

describe('<SectionMasteringPanel>', () => {
  beforeEach(() => {
    useAudioStore.setState({ masteringResult: null, sectionPlan: defaultSectionPlan() });
  });

  it('prompts when there is no section analysis', () => {
    render(<SectionMasteringPanel />);
    expect(screen.getByText(/구간 분석 결과가 없습니다/)).toBeTruthy();
  });

  it('renders a gain slider per detected section', () => {
    seedSections();
    render(<SectionMasteringPanel />);
    // one slider per section
    expect(screen.getAllByRole('slider').length).toBe(2);
    expect(screen.getByText(/코러스/)).toBeTruthy();
  });

  it('enabling + moving a slider updates the plan (non-unity)', () => {
    seedSections();
    render(<SectionMasteringPanel />);
    fireEvent.click(screen.getByRole('checkbox', { name: '구간별 마스터링 사용' }));
    const sliders = screen.getAllByRole('slider');
    fireEvent.change(sliders[1]!, { target: { value: '4' } });
    const plan = useAudioStore.getState().sectionPlan;
    expect(plan.enabled).toBe(true);
    expect(plan.gains[1]!.gainDb).toBe(4);
  });

  it('reset returns to the default plan', () => {
    seedSections();
    useAudioStore.getState().toggleSectionPlan(true);
    render(<SectionMasteringPanel />);
    fireEvent.click(screen.getByRole('button', { name: '초기화' }));
    expect(useAudioStore.getState().sectionPlan.enabled).toBe(false);
  });
});
