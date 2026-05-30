// Storybook stories for the HomePage lavender hero (DESIGN-POLISH-1).

import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { LouiHomeHero } from './LouiHomeHero';
import { loui } from '../../theme/loui-home';

const meta: Meta<typeof LouiHomeHero> = {
  title: 'Home / Hero',
  component: LouiHomeHero,
  parameters: {
    layout: 'padded',
    backgrounds: { default: 'dark' },
    docs: {
      description: {
        component:
          'Loui Mastering setup-screen hero — brand mark + title + tagline + ' +
          'engine status badge, on a lavender-tinted premium dark surface.',
      },
    },
  },
  decorators: [(Story) => <div style={{ background: loui.deepPanel, padding: 24, maxWidth: 680 }}><Story /></div>],
};
export default meta;
type Story = StoryObj<typeof LouiHomeHero>;

export const Ready: Story = {
  args: { engineReady: true },
};

export const EngineChecking: Story = {
  args: { engineReady: false },
};

export const CustomLabel: Story = {
  args: { engineReady: true, engineLabel: '로컬 엔진 v3.6 · GPU 가속' },
};
