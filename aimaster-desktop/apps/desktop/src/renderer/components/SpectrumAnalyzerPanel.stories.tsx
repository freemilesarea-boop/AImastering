// Storybook stories for SpectrumAnalyzerPanel.

import type { Meta, StoryObj } from '@storybook/react-vite';
import { SpectrumAnalyzerPanel } from './SpectrumAnalyzerPanel';
import { mockFactory, MOCK_PRESETS, type MockPresetId } from '../audio/mock-analyzer-session';

const meta: Meta<typeof SpectrumAnalyzerPanel> = {
  title: 'Audio Panels / Spectrum Analyzer',
  component: SpectrumAnalyzerPanel,
  parameters: {
    docs: {
      description: {
        component:
          'Live FFT visualiser rendered to a canvas.  Log-frequency X axis, ' +
          'dB Y axis, peak-hold overlay.  60 fps RAF loop reads the latest ' +
          'frame from a ref so React re-renders are not required per frame.',
      },
    },
  },
  argTypes: {
    showPeakHold: { control: 'boolean' },
    dbRange: { control: 'object' },
    hzRange: { control: 'object' },
  },
  args: {
    showPeakHold: true,
    dbRange: { min: -90, max: 0 },
    hzRange: { min: 20, max: 20_000 },
  },
};
export default meta;
type Story = StoryObj<typeof SpectrumAnalyzerPanel>;

function makePreset(preset: MockPresetId): Story {
  return {
    args: {
      factory: mockFactory(preset),
    },
    parameters: {
      docs: {
        description: { story: MOCK_PRESETS[preset].description },
      },
    },
  };
}

export const Idle: Story = makePreset('idle');
export const SpotifyLoud: Story = makePreset('spotify-loud');
export const WarmAcoustic: Story = makePreset('warm-acoustic');
export const AIHarsh: Story = makePreset('ai-harsh');
export const Loading: Story = makePreset('loading');

export const Disconnected: Story = {
  args: { session: null },
  parameters: {
    docs: {
      description: { story: 'No session — canvas shows grid only.' },
    },
  },
};
