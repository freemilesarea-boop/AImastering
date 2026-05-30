// Storybook QA for the gain-reduction meter (OZONE-MODULE-NEXT-3).

import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { LouiGainReductionMeter } from './LouiGainReductionMeter';
import { surface } from '../../../theme/loui-theme';

const meta: Meta<typeof LouiGainReductionMeter> = {
  title: 'Product / Gain Reduction Meter',
  component: LouiGainReductionMeter,
  parameters: { layout: 'centered', backgrounds: { default: 'dark' } },
  decorators: [(Story) => <div style={{ background: surface.panel, padding: 24, borderRadius: 12 }}><Story /></div>],
};
export default meta;
type Story = StoryObj<typeof LouiGainReductionMeter>;

export const Unavailable: Story = { args: { grDb: 0, available: false } };
export const Idle: Story = { args: { grDb: 0, available: true } };
export const LightReduction: Story = { args: { grDb: 1.5, available: true } };
export const ActiveReduction: Story = { args: { grDb: 3, peakDb: 4.2, available: true } };
export const HeavyReduction: Story = { args: { grDb: 6, peakDb: 7.5, available: true } };
export const ExtremeWarning: Story = { args: { grDb: 11.5, peakDb: 12, available: true } };
export const PeakHold: Story = { args: { grDb: 2, peakDb: 9, available: true } };

export const CompactActive: Story = { args: { grDb: 3.2, peakDb: 5, available: true, compact: true, label: 'Maximizer GR' } };
export const CompactUnavailable: Story = { args: { grDb: 0, available: false, compact: true, label: 'Maximizer GR' } };

export const ModulePanelRow: Story = {
  name: 'Module panel integration',
  render: () => (
    <div style={{ display: 'flex', gap: 32, alignItems: 'flex-start' }}>
      <LouiGainReductionMeter grDb={2.3} peakDb={4} available label="Limiter GR" />
      <LouiGainReductionMeter grDb={6.8} peakDb={8} available label="Maximizer GR" />
      <LouiGainReductionMeter grDb={0} available={false} label="Limiter GR" />
    </div>
  ),
};
