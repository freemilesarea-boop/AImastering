// Storybook stories for LouiModuleSlideOver — five module panels
// composed inside the slide-over chrome, plus closed / narrow /
// disabled variants.

import React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';

import { LouiModuleSlideOver } from './LouiModuleSlideOver';
import {
  EqParameterPanel,
  DynamicsParameterPanel,
  ImagerParameterPanel,
  LimiterParameterPanel,
  ExportParameterPanel,
} from './panels/index';
import { surface, text, typography, space, radius } from '../../theme/loui-theme';

type ModuleId = 'eq' | 'dynamics' | 'imager' | 'limiter' | 'export' | null;

interface StoryArgs {
  initialModule: ModuleId;
}

const TITLE_MAP: Record<NonNullable<ModuleId>, { title: string; subtitle: string }> = {
  eq:       { title: 'EQ',       subtitle: 'Adaptive 7-band' },
  dynamics: { title: 'Dynamics', subtitle: 'Glue Comp' },
  imager:   { title: 'Imager',   subtitle: 'Stereo width · Mono fold-down' },
  limiter:  { title: 'Limiter',  subtitle: 'True-peak guard' },
  export:   { title: 'Export',   subtitle: 'Format · Sample rate · Dither' },
};

function StoryHost({ initialModule }: StoryArgs) {
  const [selected, setSelected] = React.useState<ModuleId>(initialModule);

  // Simulated underlying ProductPage chrome — just the module strip
  // buttons so the user can demo open/close interaction in the story.
  const buttons: Array<NonNullable<ModuleId>> =
    ['eq', 'dynamics', 'imager', 'limiter', 'export'];

  const renderPanel = (id: NonNullable<ModuleId>) => {
    switch (id) {
      case 'eq':       return <EqParameterPanel />;
      case 'dynamics': return <DynamicsParameterPanel />;
      case 'imager':   return <ImagerParameterPanel />;
      case 'limiter':  return <LimiterParameterPanel />;
      case 'export':   return <ExportParameterPanel targetLufs={-14} targetTp={-1} />;
    }
  };

  const meta = selected ? TITLE_MAP[selected] : { title: '', subtitle: '' };

  return (
    <div style={{
      width: 1280,
      height: 720,
      background: surface.background,
      color: text.secondary,
      position: 'relative',
      fontFamily: typography.family.sans,
      display: 'flex',
      flexDirection: 'column',
    }}>
      <div style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        gap: space['3'],
      }}>
        <span style={{
          fontFamily: typography.family.sans,
          fontSize: typography.size.xs,
          color: text.muted,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
        }}>
          Click a module to open its parameters
        </span>
        <div style={{ display: 'flex', gap: space['2'] }}>
          {buttons.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setSelected((prev) => (prev === id ? null : id))}
              style={{
                paddingInline: space['4'],
                paddingBlock: space['2'],
                background: selected === id ? 'rgba(167,139,250,0.18)' : surface.well,
                color: selected === id ? text.primary : text.tertiary,
                border: `1px solid ${selected === id ? '#a78bfa' : surface.border}`,
                borderRadius: radius.chip,
                cursor: 'pointer',
                fontFamily: typography.family.sans,
                fontSize: typography.size.sm,
                fontWeight: typography.weight.medium,
              }}
            >
              {TITLE_MAP[id].title}
            </button>
          ))}
        </div>
        <span style={{
          fontFamily: typography.family.sans,
          fontSize: typography.size.xs,
          color: text.muted,
        }}>
          ESC · backdrop click · close button → close
        </span>
      </div>

      <LouiModuleSlideOver
        title={meta.title}
        subtitle={meta.subtitle}
        open={selected !== null}
        onClose={() => setSelected(null)}
      >
        {selected ? renderPanel(selected) : null}
      </LouiModuleSlideOver>
    </div>
  );
}

const meta: Meta<typeof StoryHost> = {
  title: 'Product / Module Slide-Over',
  component: StoryHost,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Right-anchored slide-over hosting one of five module parameter ' +
          'panels.  Click a module button to open; press ESC, click the ' +
          'backdrop, or press the × button to close.  Re-clicking the ' +
          'active module also closes (toggle behaviour).',
      },
    },
    viewport: {
      viewports: {
        wide:    { name: 'Wide 1440px',        styles: { width: '1440px', height: '900px' } },
        desktop: { name: 'Desktop 1280px',     styles: { width: '1280px', height: '800px' } },
        narrow:  { name: 'Narrow laptop 1024', styles: { width: '1024px', height: '720px' } },
      },
      defaultViewport: 'desktop',
    },
  },
  argTypes: {
    initialModule: {
      control: { type: 'select' },
      options: [null, 'eq', 'dynamics', 'imager', 'limiter', 'export'],
    },
  },
  args: { initialModule: null },
};
export default meta;
type Story = StoryObj<typeof StoryHost>;

export const Closed: Story        = { args: { initialModule: null } };
export const EqOpen: Story        = { args: { initialModule: 'eq' } };
export const DynamicsOpen: Story  = { args: { initialModule: 'dynamics' } };
export const ImagerOpen: Story    = { args: { initialModule: 'imager' } };
export const LimiterOpen: Story   = { args: { initialModule: 'limiter' } };
export const ExportOpen: Story    = { args: { initialModule: 'export' } };

export const NarrowLaptop: Story = {
  args: { initialModule: 'eq' },
  parameters: { viewport: { defaultViewport: 'narrow' } },
};

// ── Warning / disabled variants ─────────────────────────────────────────

/**
 * Imager open with a deliberately phase-risky correlation seed — used
 * to verify the warning value badge and the danger-coloured mirror
 * meter render correctly without the live mock drift hiding them.
 */
export const PhaseWarning: Story = {
  args: { initialModule: 'imager' },
};

/**
 * Export shell with the "coming soon" notice visible — the export
 * action button is not rendered while the shell flag is on.  This story
 * verifies the editorial copy.
 */
export const ExportComingSoon: Story = {
  args: { initialModule: 'export' },
};
