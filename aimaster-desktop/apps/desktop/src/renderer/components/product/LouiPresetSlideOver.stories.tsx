// Storybook stories for the preset browser slide-over (M2-PRESET-NEXT-1).

import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { LouiPresetSlideOver } from './LouiPresetSlideOver';
import { LOUI_PRESETS, DEFAULT_PRESET_ID } from '../../audio/presets/loui-presets';
import { surface } from '../../theme/loui-theme';

const core = LOUI_PRESETS.filter((p) => p.category === 'core');
const aiSpecial = LOUI_PRESETS.filter((p) => p.category === 'ai-special');

const meta: Meta<typeof LouiPresetSlideOver> = {
  title: 'Product / Preset SlideOver',
  component: LouiPresetSlideOver,
  parameters: {
    layout: 'fullscreen',
    backgrounds: { default: 'dark' },
    docs: {
      description: {
        component:
          'Preset browser hosted in the standard slide-over (ESC / backdrop / ' +
          'focus-trap). Category-grouped cards with badges + an optional ' +
          'previous→current change summary.',
      },
    },
  },
  decorators: [(Story) => <div style={{ background: surface.background, minHeight: '100vh' }}><Story /></div>],
};
export default meta;
type Story = StoryObj<typeof LouiPresetSlideOver>;

const noop = () => {};

export const Closed: Story = {
  args: { open: false, onClose: noop, recommendedId: DEFAULT_PRESET_ID },
};

export const Open: Story = {
  args: { open: true, onClose: noop, recommendedId: DEFAULT_PRESET_ID, activeId: DEFAULT_PRESET_ID },
};

export const CoreCategory: Story = {
  args: { open: true, onClose: noop, presets: core, recommendedId: DEFAULT_PRESET_ID, activeId: 'streaming-pro' },
};

export const AiSpecialCategory: Story = {
  args: { open: true, onClose: noop, presets: aiSpecial, activeId: 'ai-vocal-cleaner' },
};

export const SelectedPreset: Story = {
  args: { open: true, onClose: noop, activeId: 'kpop-loud', recommendedId: DEFAULT_PRESET_ID },
};

export const LastUsedPreset: Story = {
  args: { open: true, onClose: noop, activeId: 'ai-pop', lastUsedId: 'lofi-warm', recommendedId: DEFAULT_PRESET_ID },
};

export const ChangeSummary: Story = {
  name: 'Preset apply state (change summary)',
  args: { open: true, onClose: noop, previousId: 'streaming-pro', activeId: 'kpop-loud', recommendedId: DEFAULT_PRESET_ID },
};

export const AiOptimizedBadge: Story = {
  args: { open: true, onClose: noop, previousId: 'streaming-pro', activeId: 'ai-vocal-cleaner' },
};

export const NarrowLayout: Story = {
  args: { open: true, onClose: noop, width: 360, activeId: 'ai-pop', recommendedId: DEFAULT_PRESET_ID },
  parameters: { viewport: { defaultViewport: 'mobile1' } },
};

export const Interactive: Story = {
  render: (args) => {
    const [open, setOpen] = React.useState(true);
    const [active, setActive] = React.useState<string>('streaming-pro');
    const [previous, setPrevious] = React.useState<string | undefined>(undefined);
    return (
      <LouiPresetSlideOver
        {...args}
        open={open}
        onClose={() => setOpen(false)}
        activeId={active}
        {...(previous ? { previousId: previous } : {})}
        recommendedId={DEFAULT_PRESET_ID}
        onSelect={(id) => { setPrevious(active); setActive(id); }}
      />
    );
  },
};
