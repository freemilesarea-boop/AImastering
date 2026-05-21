// Storybook QA for the precise EQ curve overlay (OZONE-MODULE-NEXT-2).
// Renders the overlay over a charcoal panel (spectrum stand-in) so the
// curve + band dots + labels can be reviewed per EQ state.

import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { EQCurveOverlay, type EqBands } from './EQCurveOverlay';
import { surface } from '../../../theme/loui-theme';

const FLAT: EqBands = { lowCutHz: 20, lowShelfDb: 0, presenceDb: 0, airDb: 0, outputGainDb: 0 };

function Frame({ bands, bypassed, width = 560, selectedBandId }: { bands: EqBands; bypassed?: boolean; width?: number; selectedBandId?: string }) {
  const height = 240;
  return (
    <div style={{ position: 'relative', width, height, background: '#1A1A24', border: `1px solid ${surface.border}`, borderRadius: 12, overflow: 'hidden' }}>
      <EQCurveOverlay
        width={width} height={height} bands={bands}
        {...(bypassed ? { bypassed: true } : {})}
        {...(selectedBandId ? { selectedBandId } : {})}
      />
    </div>
  );
}

const meta: Meta<typeof EQCurveOverlay> = {
  title: 'Product / EQ Curve',
  component: EQCurveOverlay,
  parameters: { layout: 'centered', backgrounds: { default: 'dark' } },
};
export default meta;
type Story = StoryObj<typeof EQCurveOverlay>;

export const FlatEq: Story = { render: () => <Frame bands={FLAT} /> };
export const LowCutActive: Story = { render: () => <Frame bands={{ ...FLAT, lowCutHz: 90 }} selectedBandId="lowCut" /> };
export const WarmLowShelf: Story = { render: () => <Frame bands={{ ...FLAT, lowShelfDb: 3.5 }} /> };
export const PresenceCut: Story = { render: () => <Frame bands={{ ...FLAT, presenceDb: -3 }} /> };
export const AirBoost: Story = { render: () => <Frame bands={{ ...FLAT, airDb: 3 }} /> };

// AI presets (matching loui-presets tuning).
export const AiVocalCleaner: Story = {
  render: () => <Frame bands={{ lowCutHz: 46, lowShelfDb: -1, presenceDb: -2, airDb: 0.8, outputGainDb: 0 }} />,
};
export const CymbalSmooth: Story = {
  render: () => <Frame bands={{ lowCutHz: 32, lowShelfDb: 0.6, presenceDb: -1, airDb: -3, outputGainDb: 0 }} />,
};

export const BypassedEq: Story = { render: () => <Frame bands={{ lowCutHz: 60, lowShelfDb: 3, presenceDb: -2, airDb: 2, outputGainDb: 1 }} bypassed /> };
export const HighOutputGainWarning: Story = { render: () => <Frame bands={{ lowCutHz: 30, lowShelfDb: 2, presenceDb: 1, airDb: 2, outputGainDb: 6 }} /> };
export const NarrowLayout: Story = { render: () => <Frame bands={{ ...FLAT, lowCutHz: 60, lowShelfDb: 2, airDb: 1.5 }} width={320} /> };
