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
    | 'exporting'
    | 'asis-no-output'
    | 'asis-success'
    | 'asis-failure'
    | 'asis-saving'
    | 'quality-441-16'
    | 'quality-48-24'
    | 'quality-32-float'
    | 'quality-asis-ignores'
    | 'wav-24-no-dither'
    | 'wav-16-triangular'
    | 'mp3-dither-ignored'
    | 'flac-export'
    | 'transcode-failure'
    | 'asis-transcode';
}

function infoFor(
  scenario: HostArgs['scenario'],
  onReMaster: () => void,
  onAsIs: () => void,
): ReMasterExportInfo {
  const asIs: ReMasterExportInfo['asIs'] = {
    available: true, phase: 'idle', error: null, lastExportPath: null, onExportAsIs: onAsIs,
  };
  const base: ReMasterExportInfo = {
    appliedKeys: ['targetLufs', 'targetTp'],
    skippedParameterIds: [],
    hasUnpreviewedChanges: false,
    phase: 'idle',
    error: null,
    lastExportPath: null,
    onReMasterExport: onReMaster,
    asIs,
    quality: { label: '48 kHz · 24-bit', willApply: false },
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
    case 'asis-no-output':
      return { ...base, appliedKeys: [], asIs: { ...asIs, available: false } };
    case 'asis-success':
      return { ...base, appliedKeys: [], asIs: { ...asIs, phase: 'done', lastExportPath: '/Users/me/Music/song_master.wav' } };
    case 'asis-failure':
      return { ...base, appliedKeys: [], asIs: { ...asIs, phase: 'error', error: 'copy failed: EACCES' } };
    case 'asis-saving':
      return { ...base, appliedKeys: [], asIs: { ...asIs, phase: 'exporting' } };
    case 'quality-441-16':
      return { ...base, appliedKeys: ['sampleRate', 'bitDepth'],
        quality: { label: '44.1 kHz · 16-bit', willApply: true } };
    case 'quality-48-24':
      return { ...base, appliedKeys: [],
        quality: { label: '48 kHz · 24-bit', willApply: false } };
    case 'quality-32-float':
      return { ...base, appliedKeys: ['bitDepth'],
        quality: { label: '96 kHz · 32-bit', willApply: true } };
    case 'quality-asis-ignores':
      // Quality change present; Export As-is keeps current format.
      return { ...base, appliedKeys: ['sampleRate'],
        quality: { label: '192 kHz · 24-bit', willApply: true } };
    // ── Format / dither (5D-2-d) ──
    case 'wav-24-no-dither':
      return { ...base, appliedKeys: [],
        quality: { label: 'WAV · 48 kHz · 24-bit', willApply: false, format: 'wav', transcodeRequired: false, ditherIgnored: false } };
    case 'wav-16-triangular':
      return { ...base, appliedKeys: ['bitDepth'],
        quality: { label: 'WAV · 44.1 kHz · 16-bit', willApply: true, format: 'wav', transcodeRequired: false, ditherIgnored: false } };
    case 'mp3-dither-ignored':
      return { ...base, appliedKeys: [],
        quality: { label: 'MP3 · 48 kHz', willApply: false, format: 'mp3', transcodeRequired: true, ditherIgnored: true } };
    case 'flac-export':
      return { ...base, appliedKeys: [],
        quality: { label: 'FLAC · 48 kHz · 24-bit', willApply: false, format: 'flac', transcodeRequired: true, ditherIgnored: false } };
    case 'transcode-failure':
      return { ...base, appliedKeys: [], phase: 'error', error: 'ffmpeg exited 1: Unknown encoder',
        quality: { label: 'OGG · 48 kHz', willApply: false, format: 'ogg', transcodeRequired: true, ditherIgnored: true } };
    case 'asis-transcode':
      return { ...base, appliedKeys: [],
        quality: { label: 'FLAC · 48 kHz · 24-bit', willApply: false, format: 'flac', transcodeRequired: true, ditherIgnored: false } };
  }
}

function Host({ scenario }: HostArgs) {
  const [log, setLog] = React.useState<string | null>(null);
  const info = infoFor(
    scenario,
    () => setLog('onReMasterExport() fired'),
    () => setLog('onExportAsIs() fired'),
  );
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
      options: [
        'no-changes', 'previewed', 'unpreviewed-warning', 'staged-only-skipped',
        'success', 'failure', 'exporting',
        'asis-no-output', 'asis-success', 'asis-failure', 'asis-saving',
        'quality-441-16', 'quality-48-24', 'quality-32-float', 'quality-asis-ignores',
        'wav-24-no-dither', 'wav-16-triangular', 'mp3-dither-ignored', 'flac-export',
        'transcode-failure', 'asis-transcode',
      ],
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

// Export As-is (M3-P-NEXT-5D-2-b)
export const ExportAsIsDisabledNoOutput: Story = { args: { scenario: 'asis-no-output' } };
export const ExportAsIsSuccess:         Story = { args: { scenario: 'asis-success' } };
export const ExportAsIsFailure:         Story = { args: { scenario: 'asis-failure' } };
export const ExportAsIsSaving:          Story = { args: { scenario: 'asis-saving' } };

// Export quality (M3-P-NEXT-5D-2-c)
export const Quality441k16bit:    Story = { args: { scenario: 'quality-441-16' } };
export const Quality48k24bit:     Story = { args: { scenario: 'quality-48-24' } };
export const Quality32BitFloat:   Story = { args: { scenario: 'quality-32-float' } };
export const QualityAsIsIgnores:  Story = { args: { scenario: 'quality-asis-ignores' } };

// Format / dither (M3-P-NEXT-5D-2-d)
export const Wav24NoDither:       Story = { args: { scenario: 'wav-24-no-dither' } };
export const Wav16Triangular:     Story = { args: { scenario: 'wav-16-triangular' } };
export const Mp3DitherIgnored:    Story = { args: { scenario: 'mp3-dither-ignored' } };
export const FlacExport:          Story = { args: { scenario: 'flac-export' } };
export const TranscodeFailure:    Story = { args: { scenario: 'transcode-failure' } };
export const AsIsTranscode:       Story = { args: { scenario: 'asis-transcode' } };
