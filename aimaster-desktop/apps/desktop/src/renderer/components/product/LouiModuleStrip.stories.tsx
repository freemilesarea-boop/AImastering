// Storybook stories for LouiModuleStrip — UI shell only, no DSP wiring.

import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';

import {
  LouiModuleStrip,
  LOUI_DEFAULT_MODULES,
  type ModuleCardDef,
} from './LouiModuleStrip';

function StripHost(props: { modules?: ModuleCardDef[] }) {
  const [selected, setSelected] = useState<ModuleCardDef['id'] | undefined>(undefined);
  return (
    <div style={{
      background: '#13131A',
      paddingBlock: 16,
      width: '100%',
      minHeight: 180,
    }}>
      <LouiModuleStrip
        modules={props.modules ?? LOUI_DEFAULT_MODULES}
        {...(selected ? { selectedId: selected } : {})}
        onSelect={setSelected}
      />
    </div>
  );
}

const meta: Meta<typeof StripHost> = {
  title: 'Product / Module Strip',
  component: StripHost,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Bottom-of-page module rack.  Five cards — EQ, Dynamics, ' +
          'Imager, Limiter, Export — each in one of four states ' +
          '(active / bypass / locked / coming-soon).  No real DSP ' +
          'wiring; click events surface the module id for future ' +
          'parameter-panel routing.',
      },
    },
  },
};
export default meta;
type Story = StoryObj<typeof StripHost>;

export const Default: Story = {};

export const AllActive: Story = {
  args: {
    modules: LOUI_DEFAULT_MODULES.map((m) => ({ ...m, state: 'active' })),
  },
};

export const AllBypassed: Story = {
  args: {
    modules: LOUI_DEFAULT_MODULES.map((m) => ({ ...m, state: 'bypass' })),
  },
};

export const AllLocked: Story = {
  args: {
    modules: LOUI_DEFAULT_MODULES.map((m) => ({ ...m, state: 'locked' })),
  },
};

export const ComingSoonHeavy: Story = {
  args: {
    modules: LOUI_DEFAULT_MODULES.map((m, i) => ({
      ...m,
      state: i < 2 ? 'active' : 'coming-soon',
    })),
  },
};
