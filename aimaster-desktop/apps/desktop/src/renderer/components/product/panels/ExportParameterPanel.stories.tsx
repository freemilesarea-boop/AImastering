// Storybook stories for ExportParameterPanel's Re-master & Export section
// (M3-P-NEXT-5D-2-a).  Drives the reMasterExport prop through every state.

import React from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';

import { ExportParameterPanel, type ReMasterExportInfo } from './ExportParameterPanel';
import { surface, typography } from '../../../theme/loui-theme';

interface HostArgs {
  scenario:
    | 'no-changes'
    | 'previewed'
    | 'unpreviewed-warning'
    | 'staged-only-skipped'
    | 'success'
    | 'failure'
    | 'exporting';
}

function infoFor(scenario: HostArgs['scenario'], onExport: () => void): ReMasterExportInfo {
  const base: ReMasterExportInfo = {
    appliedKeys: ['targetLufs', 'targetTp'],
    skippedParameterIds: [],
    hasUnpreviewedChanges: false,
    phase: 'idle',
    error: null,
    lastExportPath: null,
    onReMasterExport: onExport,
  };
  switch (scenario) {
    case 'no-changes':
      return { ...base, appliedKeys: [] };
    case 'previewed':
      return base;
    case 'unpreviewed-warning':
      return { ...base, hasUnpreviewedChanges: true };
    case 'staged-only-skipped':
      return { ...base, skippedParameterIds: ['dynamics.ratio', 'eq.adaptive'] };
    case 'success':
      return { ...base, phase: 'done', lastExportPath: '/Users/me/Music/song_master.wav' };
    case 'failure':
      return { ...base, phase: 'error', error: 'bridge process exited' };
    case 'exporting':
      return { ...base, phase: 'exporting' };
  }
}

function Host({ scenario }: HostArgs) {
  const [log, setLog] = React.useState<string | null>(null);
  const info = infoFor(scenario, () => setLog('onReMasterExport() fired'));
  return (
    <div style={{
      background: surface.background,
      width: 480,
      padding: 16,
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
      fontFamily: typography.family.sans,
    }}>
      <ExportParameterPanel targetLufs={-12} targetTp={-0.8} reMasterExport={info} />
      {log && (
        <span style={{ fontFamily: typography.family.mono, fontSize: 11, color: '#a1a1aa' }}>
          {log}
        </span>
      )}
    </div>
  );
}

const meta: Meta<typeof Host> = {
  title: 'Product / Export (Re-master)',
  component: Host,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'The ExportParameterPanel "Re-master & Export" section — reuses ' +
          'the same render override the preview uses, applied to the final ' +
          'WAV via the existing audio:master + file:save-wav channels.',
      },
    },
  },
  argTypes: {
    scenario: {
      control: { type: 'select' },
      options: ['no-changes', 'previewed', 'unpreviewed-warning', 'staged-only-skipped', 'success', 'failure', 'exporting'],
    },
  },
  args: { scenario: 'previewed' },
};
export default meta;
type Story = StoryObj<typeof Host>;

export const NoChangesExport:          Story = { args: { scenario: 'no-changes' } };
export const ExportWithPreviewedChanges: Story = { args: { scenario: 'previewed' } };
export const ExportUnpreviewedWarning: Story = { args: { scenario: 'unpreviewed-warning' } };
export const ExportStagedOnlySkipped:  Story = { args: { scenario: 'staged-only-skipped' } };
export const ExportSuccess:            Story = { args: { scenario: 'success' } };
export const ExportFailure:            Story = { args: { scenario: 'failure' } };
export const ExportDisabledWhileExporting: Story = { args: { scenario: 'exporting' } };
