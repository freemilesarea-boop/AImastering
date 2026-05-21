// Storybook QA for the product top bar (UX-FLOW-NEXT-1: Back navigation).

import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { LouiTopBar } from './LouiTopBar';
import { surface } from '../../theme/loui-theme';

const meta: Meta<typeof LouiTopBar> = {
  title: 'Product / Top Bar',
  component: LouiTopBar,
  parameters: { layout: 'fullscreen', backgrounds: { default: 'dark' } },
  decorators: [(Story) => <div style={{ background: surface.background }}><Story /></div>],
  args: { subtitle: 'Result', engineLabel: 'WASM ready' },
};
export default meta;
type Story = StoryObj<typeof LouiTopBar>;

const noop = () => {};

export const WithBack: Story = {
  args: { onBack: noop, onImport: noop, onExport: noop, onSettings: noop },
};

export const WithoutBack: Story = {
  args: { onImport: noop, onExport: noop, onSettings: noop },
};
