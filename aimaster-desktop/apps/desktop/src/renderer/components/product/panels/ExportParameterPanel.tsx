// ExportParameterPanel — output format + dither + normalisation summary.

import React from 'react';
import {
  LouiSectionCard,
  LouiTogglePill,
  LouiValueBadge,
} from '../controls/index.js';
import { surface, text, typography, meter, space, radius } from '../../../theme/loui-theme.js';
import { ALL_MODULE_PARAMETER_DEFS } from '../../../audio/parameters/index.js';
import { usePanelStateBridge, type ControlledPanelProps } from './usePanelStateBridge.js';

type ExportFormat = 'wav' | 'flac' | 'mp3' | 'aiff' | 'ogg';
type SampleRateStr = '44100' | '48000' | '88200' | '96000' | '192000';
type BitDepthStr   = '16' | '24' | '32';
type DitherMode    = 'none' | 'tpdf' | 'shaped';

interface ExportState {
  format:     ExportFormat;
  sampleRate: SampleRateStr;
  bitDepth:   BitDepthStr;
  dither:     DitherMode;
}

const findExp = (id: string) =>
  ALL_MODULE_PARAMETER_DEFS.export.parameters.find((p) => p.id === id)!.default;
const DEFAULTS: ExportState = {
  format:     findExp('format')     as ExportFormat,
  sampleRate: findExp('sampleRate') as SampleRateStr,
  bitDepth:   findExp('bitDepth')   as BitDepthStr,
  dither:     findExp('dither')     as DitherMode,
};

const FORMATS: { id: ExportFormat; label: string; hint: string }[] = [
  { id: 'wav',  label: 'WAV',  hint: 'PCM · uncompressed' },
  { id: 'flac', label: 'FLAC', hint: 'Lossless compressed' },
  { id: 'mp3',  label: 'MP3',  hint: 'Lossy · streaming' },
  { id: 'aiff', label: 'AIFF', hint: 'PCM · Apple' },
  { id: 'ogg',  label: 'OGG',  hint: 'Vorbis · open' },
];

const SAMPLE_RATES: { id: SampleRateStr; label: string; hint?: string }[] = [
  { id: '44100',  label: '44.1 kHz' },
  { id: '48000',  label: '48 kHz', hint: 'Default' },
  { id: '88200',  label: '88.2 kHz', hint: 'Hi-res' },
  { id: '96000',  label: '96 kHz', hint: 'Hi-res' },
  { id: '192000', label: '192 kHz', hint: 'Hi-res' },
];

const BIT_DEPTHS: { id: BitDepthStr; label: string; hint: string }[] = [
  { id: '16', label: '16-bit', hint: 'CD / streaming' },
  { id: '24', label: '24-bit', hint: 'Default' },
  { id: '32', label: '32-bit Float', hint: 'Float (no clipping)' },
];

const DITHER_MODES: { id: DitherMode; label: string; hint: string }[] = [
  { id: 'none',   label: 'None',   hint: 'No noise added' },
  { id: 'tpdf',   label: 'TPDF',   hint: 'Standard noise dither' },
  { id: 'shaped', label: 'Shaped', hint: 'Noise-shaped (recommended)' },
];

function ChipRow<T extends string>({
  options,
  active,
  onChange,
  ariaLabel,
}: {
  options: { id: T; label: string; hint?: string }[];
  active: T;
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: space['2'],
      }}
    >
      {options.map((o) => {
        const sel = o.id === active;
        return (
          <button
            key={String(o.id)}
            type="button"
            role="radio"
            aria-checked={sel}
            onClick={() => onChange(o.id)}
            style={{
              display: 'inline-flex',
              flexDirection: 'column',
              alignItems: 'flex-start',
              gap: 2,
              minWidth: 84,
              paddingInline: space['3'],
              paddingBlock: space['2'],
              background: sel ? 'rgba(167,139,250,0.10)' : surface.well,
              border: `1px solid ${sel ? meter.accent.foreground : surface.border}`,
              borderRadius: radius.chip,
              cursor: 'pointer',
              transition: 'background 120ms ease-out, border-color 120ms ease-out',
              textAlign: 'left',
            }}
          >
            <span style={{
              fontFamily: typography.family.sans,
              fontSize: typography.size.sm,
              fontWeight: typography.weight.semi,
              color: sel ? text.primary : text.secondary,
            }}>
              {o.label}
            </span>
            {o.hint && (
              <span style={{
                fontFamily: typography.family.sans,
                fontSize: typography.size.xs,
                color: text.muted,
              }}>
                {o.hint}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** Re-master & Export descriptor (M3-P-NEXT-5D-2-a). */
export interface ReMasterExportInfo {
  /** Renderable changes that WILL be applied to the export. */
  appliedKeys: string[];
  /** UI parameter ids staged but NOT applied (no MasteringOptions mapping). */
  skippedParameterIds: string[];
  /** Renderable changes not yet heard in the preview (warning). */
  hasUnpreviewedChanges: boolean;
  phase: 'idle' | 'exporting' | 'done' | 'error';
  error?: string | null;
  lastExportPath?: string | null;
  onReMasterExport: () => void;
}

export interface ExportParameterPanelProps extends ControlledPanelProps {
  /** Optional — show the target summary from external state. */
  targetLufs?: number;
  targetTp?:   number;
  /** Hide the "coming soon" notice and reveal an Export CTA. */
  showExportButton?: boolean;
  /** Click → export action.  Pure UI today. */
  onExport?:   () => void;
  /** Re-master & Export wiring (production path only). */
  reMasterExport?: ReMasterExportInfo;
}

export function ExportParameterPanel(props: ExportParameterPanelProps = {}) {
  const { state: s, setParam } = usePanelStateBridge<ExportState>(DEFAULTS, props);
  const tLufs = props.targetLufs ?? -14;
  const tTp   = props.targetTp ?? -1;

  return (
    <>
      <LouiSectionCard title="Format">
        <ChipRow
          options={FORMATS}
          active={s.format}
          onChange={(v) => setParam('format', v)}
          ariaLabel="Export format"
        />
      </LouiSectionCard>

      <LouiSectionCard title="Sample Rate">
        <ChipRow
          options={SAMPLE_RATES}
          active={s.sampleRate}
          onChange={(v) => setParam('sampleRate', v)}
          ariaLabel="Sample rate"
        />
      </LouiSectionCard>

      <LouiSectionCard title="Bit Depth">
        <ChipRow
          options={BIT_DEPTHS}
          active={s.bitDepth}
          onChange={(v) => setParam('bitDepth', v)}
          ariaLabel="Bit depth"
        />
      </LouiSectionCard>

      <LouiSectionCard
        title="Dither"
        trailing={
          <LouiTogglePill
            label=""
            value={s.dither !== 'none'}
            onChange={(v) => setParam('dither', v ? 'tpdf' : 'none')}
          />
        }
      >
        <ChipRow
          options={DITHER_MODES}
          active={s.dither}
          onChange={(v) => setParam('dither', v)}
          ariaLabel="Dither mode"
        />
        {s.bitDepth === '32' && s.dither !== 'none' && (
          <span style={{
            fontFamily: typography.family.sans,
            fontSize: typography.size.xs,
            color: meter.warn.foreground,
            lineHeight: 1.4,
          }}>
            ⚠ Dither has no audible effect at 32-bit float depth.
          </span>
        )}
      </LouiSectionCard>

      <LouiSectionCard
        title="Normalize Target"
        trailing={
          <LouiValueBadge label="Echo" status="neutral">
            from limiter
          </LouiValueBadge>
        }
      >
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: space['2'],
        }}>
          <LouiValueBadge label="Target LUFS">
            {tLufs.toFixed(1)} LUFS
          </LouiValueBadge>
          <LouiValueBadge label="Ceiling">
            {tTp.toFixed(1)} dBTP
          </LouiValueBadge>
        </div>
        <span style={{
          fontFamily: typography.family.sans,
          fontSize: typography.size.xs,
          color: text.muted,
          lineHeight: 1.4,
        }}>
          These values mirror the limiter's targets.  Open the Limiter
          module to adjust.
        </span>
      </LouiSectionCard>

      {props.reMasterExport ? (
        <ReMasterExportSection info={props.reMasterExport} />
      ) : props.showExportButton ? (
        <button
          type="button"
          onClick={props.onExport}
          style={{
            height: 36,
            paddingInline: space['4'],
            background: meter.accent.foreground,
            color: surface.background,
            border: 'none',
            borderRadius: radius.chip,
            fontFamily: typography.family.sans,
            fontSize: typography.size.sm,
            fontWeight: typography.weight.semi,
            cursor: 'pointer',
          }}
        >
          Export
        </button>
      ) : (
        <span style={{
          fontFamily: typography.family.sans,
          fontSize: typography.size.xs,
          color: meter.accent.foreground,
          background: 'rgba(167,139,250,0.10)',
          border: `1px solid rgba(167,139,250,0.45)`,
          borderRadius: radius.chip,
          padding: `${space['2']} ${space['3']}`,
          lineHeight: 1.4,
        }}>
          ✦ Format / sample-rate / dither selection is a UI shell — actual
          export still routes through the existing WAV / MP3 save buttons.
          Live binding lands in M3-P-NEXT-5B.
        </span>
      )}
    </>
  );
}

// ── Re-master & Export section (M3-P-NEXT-5D-2-a) ─────────────────────────

function ReMasterExportSection({ info }: { info: ReMasterExportInfo }) {
  const exporting = info.phase === 'exporting';
  const appliedCount = info.appliedKeys.length;
  const skippedCount = info.skippedParameterIds.length;
  const hasChanges = appliedCount > 0;

  return (
    <LouiSectionCard title="Re-master & Export">
      {/* Summary line */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space['2'] }}>
        <LouiValueBadge label="Apply" status={hasChanges ? 'accent' : 'neutral'}>
          {appliedCount} change{appliedCount === 1 ? '' : 's'}
        </LouiValueBadge>
        {skippedCount > 0 && (
          <LouiValueBadge label="Skip" status="neutral">
            {skippedCount} staged-only
          </LouiValueBadge>
        )}
      </div>

      {/* Applied keys */}
      {hasChanges && (
        <span style={{
          fontFamily: typography.family.mono,
          fontSize: typography.size.xs,
          color: text.tertiary,
          lineHeight: 1.5,
        }}>
          Applies: {info.appliedKeys.join(', ')}
        </span>
      )}

      {/* Staged-only notice */}
      {skippedCount > 0 && (
        <span style={{
          fontFamily: typography.family.sans,
          fontSize: typography.size.xs,
          color: text.muted,
          lineHeight: 1.4,
        }}>
          {skippedCount} staged-only change{skippedCount === 1 ? '' : 's'} not applied to this export
          (no render mapping yet).
        </span>
      )}

      {/* Unpreviewed warning */}
      {info.hasUnpreviewedChanges && hasChanges && (
        <span style={{
          fontFamily: typography.family.sans,
          fontSize: typography.size.xs,
          color: meter.warn.foreground,
          lineHeight: 1.4,
        }}>
          ⚠ This export includes changes not previewed yet.
        </span>
      )}

      {/* Status */}
      {info.phase === 'done' && (
        <span style={{ fontFamily: typography.family.sans, fontSize: typography.size.xs, color: meter.safe.foreground }}>
          ✓ Exported{info.lastExportPath ? ` → ${info.lastExportPath}` : ''}
        </span>
      )}
      {info.phase === 'error' && (
        <span style={{ fontFamily: typography.family.sans, fontSize: typography.size.xs, color: meter.danger.foreground }}>
          ✗ Export failed{info.error ? ` · ${info.error}` : ''}
        </span>
      )}

      {/* Action */}
      <button
        type="button"
        onClick={info.onReMasterExport}
        disabled={exporting || !hasChanges}
        style={{
          height: 36,
          paddingInline: space['4'],
          background: (exporting || !hasChanges) ? 'transparent' : meter.accent.foreground,
          color: (exporting || !hasChanges) ? text.disabled : surface.background,
          border: (exporting || !hasChanges) ? `1px solid ${surface.border}` : 'none',
          borderRadius: radius.chip,
          fontFamily: typography.family.sans,
          fontSize: typography.size.sm,
          fontWeight: typography.weight.semi,
          cursor: (exporting || !hasChanges) ? 'not-allowed' : 'pointer',
        }}
      >
        {exporting ? 'Re-mastering…' : hasChanges ? 'Re-master & Export' : 'No changes to export'}
      </button>
      <span style={{
        fontFamily: typography.family.sans,
        fontSize: typography.size.xs,
        color: text.muted,
        lineHeight: 1.4,
      }}>
        Re-renders the master with your changes via the existing pipeline,
        then saves a WAV.  "Export As-is" (unchanged master) lands in
        M3-P-NEXT-5D-2-b.
      </span>
    </LouiSectionCard>
  );
}
