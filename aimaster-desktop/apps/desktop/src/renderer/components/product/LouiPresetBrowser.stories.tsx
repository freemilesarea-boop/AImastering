// Storybook stories for the category-grouped preset browser
// (M2-PRESET-TUNING).

import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { LouiPresetBrowser } from './LouiPresetBrowser';
import { DEFAULT_PRESET_ID } from '../../audio/presets/loui-presets';
import { surface } from '../../theme/loui-theme';

const meta: Meta<typeof LouiPresetBrowser> = {
  title: 'Product / Preset Browser',
  component: LouiPresetBrowser,
  parameters: {
    layout: 'fullscreen',
    backgrounds: { default: 'dark' },
    docs: {
      description: {
        component:
          'Category-grouped Loui preset browser — Core / Character / AI Special, ' +
          'with loudness target, tone, description, and badges (AI optimized, ' +
          'streaming-safe, mono-safe, recommended, last used).',
      },
    },
  },
  decorators: [(Story) => <div style={{ background: surface.background, minHeight: '100vh' }}><Story /></div>],
};
export default meta;
type Story = StoryObj<typeof LouiPresetBrowser>;

export const Default: Story = {
  args: { recommendedId: DEFAULT_PRESET_ID },
};

export const WithSelection: Story = {
  args: { activeId: 'ai-pop', recommendedId: DEFAULT_PRESET_ID },
};

export const WithLastUsed: Story = {
  args: { activeId: 'kpop-loud', recommendedId: DEFAULT_PRESET_ID, lastUsedId: 'lofi-warm' },
};

export const Interactive: Story = {
  render: (args) => {
    const [active, setActive] = React.useState<string>('streaming-pro');
    return <LouiPresetBrowser {...args} activeId={active} onSelect={setActive} recommendedId={DEFAULT_PRESET_ID} />;
  },
};
