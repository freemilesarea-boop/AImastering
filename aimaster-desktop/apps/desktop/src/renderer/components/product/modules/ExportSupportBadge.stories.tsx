// Storybook QA for export-support badges + summary (OZONE-MODULE-NEXT-4).

import type { Meta, StoryObj } from '@storybook/react-vite';
import React from 'react';

import { ExportSupportBadge, ExportSupportSummary } from './ExportSupportBadge';
import { surface } from '../../../theme/loui-theme';

const meta: Meta = {
  title: 'Product / Export Support',
  parameters: { layout: 'centered', backgrounds: { default: 'dark' } },
  decorators: [(Story) => <div style={{ background: surface.panel, padding: 24, borderRadius: 12, minWidth: 320 }}><Story /></div>],
};
export default meta;
type Story = StoryObj;

export const BadgeStates: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <ExportSupportBadge support="exact" />
      <ExportSupportBadge support="approximate" />
      <ExportSupportBadge support="export-only" />
      <ExportSupportBadge support="preview-only" />
      <ExportSupportBadge support="planned" />
    </div>
  ),
};

export const ExactOnly: Story = { render: () => <ExportSupportSummary exact={4} previewOnly={0} /> };
export const PreviewOnlyChanges: Story = { render: () => <ExportSupportSummary exact={0} previewOnly={3} /> };
export const MixedSummary: Story = { render: () => <ExportSupportSummary exact={2} exportOnly={1} previewOnly={3} /> };
export const UnsupportedWarning: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <ExportSupportSummary exact={1} previewOnly={5} />
      <span style={{ color: '#FBBF24', fontSize: 11 }}>5 preview-only edits won't reach the exported file.</span>
    </div>
  ),
};
export const NoChanges: Story = { render: () => <ExportSupportSummary exact={0} previewOnly={0} /> };
