// Storybook stories for the redesigned HomePage setup screen
// (DESIGN-POLISH-1).  Seeds the zustand audio store per story so the
// layout can be reviewed in each state without IPC.

import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import HomePage from './HomePage';
import { useAudioStore } from '../stores/audioStore';
import type { MasteringOptions, QueueItem } from '../stores/audioStore';

const baseOptions: MasteringOptions = {
  style: 'balanced',
  targetLufs: -14,
  targetTp: -1.0,
  sampleRate: 44100,
  bitDepth: 24,
  applyAiCorrections: true,
  limiterStrength: 'medium',
};

function pending(id: string, name: string): QueueItem {
  return { id, filePath: `/tmp/${name}`, fileName: name, status: 'pending', progress: 0, progressStage: '' };
}
function mastering(id: string, name: string, progress: number): QueueItem {
  return { id, filePath: `/tmp/${name}`, fileName: name, status: 'mastering', progress, progressStage: 'limiter' };
}

interface Seed {
  queue?: QueueItem[];
  options?: Partial<MasteringOptions> & { quickPreset?: string };
  showAdvanced?: boolean;
  isBatchRunning?: boolean;
}

function seeded(seed: Seed) {
  return function Seeded() {
    // Seed once before the first render of HomePage.
    React.useMemo(() => {
      useAudioStore.setState({
        queue: seed.queue ?? [],
        options: { ...baseOptions, ...(seed.options ?? {}) },
        showAdvanced: seed.showAdvanced ?? false,
        isBatchRunning: seed.isBatchRunning ?? false,
      });
    }, []);
    return <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}><HomePage /></div>;
  };
}

const meta: Meta<typeof HomePage> = {
  title: 'Home / HomePage',
  component: HomePage,
  parameters: { layout: 'fullscreen', backgrounds: { default: 'dark' } },
};
export default meta;
type Story = StoryObj<typeof HomePage>;

export const Empty: Story = { render: seeded({}) };

export const FileSelected: Story = {
  render: seeded({ queue: [pending('1', 'track-01.wav')] }),
};

export const PresetSelected: Story = {
  render: seeded({
    queue: [pending('1', 'ai-vocal-demo.wav')],
    options: { quickPreset: 'streaming_loud', targetLufs: -11 },
  }),
};

export const AdvancedOpen: Story = {
  render: seeded({ queue: [pending('1', 'track-01.wav')], showAdvanced: true }),
};

export const Processing: Story = {
  render: seeded({
    queue: [mastering('1', 'track-01.wav', 62), pending('2', 'track-02.wav')],
    isBatchRunning: true,
  }),
};

export const NarrowLayout: Story = {
  render: seeded({ queue: [pending('1', 'track-01.wav')] }),
  parameters: { viewport: { defaultViewport: 'mobile1' } },
};
