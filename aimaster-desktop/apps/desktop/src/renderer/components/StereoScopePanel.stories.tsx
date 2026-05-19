// Storybook stories for StereoScopePanel.
//
// Each preset exercises a distinct verdict label:
//   • MonoSafe       → "Mono Safe"
//   • SpotifyLoud    → "Stereo Balanced"
//   • WarmAcoustic   → "Mono Safe" (high correlation)
//   • AIHarsh        → "Wide" / "Stereo Balanced"
//   • BrokenPhase    → "Phase Risk"

import type { Meta, StoryObj } from '@storybook/react-vite';
import { StereoScopePanel } from './StereoScopePanel';
import { mockFactory, MOCK_PRESETS, type MockPresetId } from '../audio/mock-analyzer-session';

const meta: Meta<typeof StereoScopePanel> = {
  title: 'Audio Panels / Stereo Scope',
  component: StereoScopePanel,
  parameters: {
    docs: {
      description: {
        component:
          'Live stereo health visualiser.  Three rows: correlation needle ' +
          '(with phase-risk zone shaded), width bar, and a categorical ' +
          'verdict chip designed for non-engineers (Mono Safe / Wide / ' +
          'Phase Risk / Stereo Balanced).',
      },
    },
  },
};
export default meta;
type Story = StoryObj<typeof StereoScopePanel>;

function makePreset(preset: MockPresetId): Story {
  return {
    args: { factory: mockFactory(preset) },
    parameters: {
      docs: {
        description: { story: MOCK_PRESETS[preset].description },
      },
    },
  };
}

export const Idle: Story = makePreset('idle');
export const MonoSafe: Story = makePreset('mono-safe');
export const SpotifyLoud: Story = makePreset('spotify-loud');
export const WarmAcoustic: Story = makePreset('warm-acoustic');
export const AIHarsh: Story = makePreset('ai-harsh');
export const BrokenPhase: Story = makePreset('broken-phase');

export const Disconnected: Story = {
  args: { session: null },
};
