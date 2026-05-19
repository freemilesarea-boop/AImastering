// Storybook stories for LoudnessMeterPanelV2.
//
// Each story is driven by a deterministic mock session — no AudioContext,
// no WASM, no real audio.  Visual states are reproducible across runs.

import type { Meta, StoryObj } from '@storybook/react-vite';
import { LoudnessMeterPanelV2 } from './LoudnessMeterPanelV2';
import { mockFactory, MOCK_PRESETS, type MockPresetId } from '../audio/mock-analyzer-session';

const meta: Meta<typeof LoudnessMeterPanelV2> = {
  title: 'Audio Panels / Loudness Meter (V2)',
  component: LoudnessMeterPanelV2,
  parameters: {
    docs: {
      description: {
        component:
          'Live LUFS / TP / RMS meter driven by an `AnalyzerSession` stream.\n\n' +
          'In production, the session is owned by `WasmAnalyzerProvider`. ' +
          'In Storybook, the session is a deterministic mock — values follow ' +
          'a scripted timeline.',
      },
    },
  },
  argTypes: {
    tickRate: {
      control: { type: 'select' },
      options: ['60Hz', '30Hz', '10Hz'],
      description: 'How often the panel re-reads the session snapshot.',
    },
    targetLufs: {
      control: { type: 'number', min: -24, max: -6, step: 0.5 },
      description: 'Optional integrated-LUFS target for colour coding.',
    },
  },
  args: {
    tickRate: '30Hz',
  },
};
export default meta;
type Story = StoryObj<typeof LoudnessMeterPanelV2>;

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

// ── Stories — one per timeline preset ────────────────────────────────────

export const Idle: Story = makePreset('idle');
export const SpotifyLoud: Story = makePreset('spotify-loud');
export const WarmAcoustic: Story = makePreset('warm-acoustic');
export const ClippingRisk: Story = makePreset('clipping-risk');
export const MonoSafe: Story = makePreset('mono-safe');
export const BrokenPhase: Story = makePreset('broken-phase');
export const AIHarsh: Story = makePreset('ai-harsh');
export const Loading: Story = makePreset('loading');

/** Renders the panel with no session at all — exercises the "disconnected" path. */
export const Disconnected: Story = {
  args: {
    session: null,
  },
  parameters: {
    docs: {
      description: { story: 'Panel rendered with `session={null}` — the empty / disconnected state.' },
    },
  },
};
