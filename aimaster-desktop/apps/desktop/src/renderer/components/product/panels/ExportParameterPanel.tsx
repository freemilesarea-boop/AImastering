// ExportParameterPanel — output format + dither + normalisation summary.
//
// Sections:
//   1. Format (WAV / FLAC / MP3 / AIFF / OGG)
//   2. Sample Rate · Bit Depth
//   3. Dither (on / off + algorithm)
//   4. Normalize target summary (read-only echo of LimiterParameterPanel
//      target LUFS + ceiling for confidence before export)
//
// NOTE: this panel is editorial — the actual file-render is driven by
// the Electron main process today.  When wired in M3-P-NEXT-5 it will
// build an export descriptor object that `file:save-wav` consumes.
//
// TODO(M3-P-NEXT-5 binding):
//   • format       → export.format
//   • sampleRate   → export.sampleRate
//   • bitDepth     → export.bitDepth
//   • ditherMode   → export.dither
//   • exportButton.onClick → existing `file:save-wav` IPC

import React from 'react';
import {
  LouiSectionCard,
  LouiTogglePill,
  LouiValueBadge,
} from '../controls/index.js';
import { surface, text, typography, meter, space, radius } from '../../../theme/loui-theme.js';

type ExportFormat = 'wav' | 'flac' | 'mp3' | 'aiff' | 'ogg';
type SampleRate   = 44100 | 48000 | 88200 | 96000 | 192000;
type BitDepth     = 16 | 24 | 32;
type DitherMode   = 'none' | 'tpdf' | 'shaped';

interface ExportState {
  format:     ExportFormat;
  sampleRate: SampleRate;
  bitDepth:   BitDepth;
  dither:     DitherMode;
  comingSoon: boolean;
}

const DEFAULTS: ExportState = {
  format:     'wav',
  sampleRate:  48000,
  bitDepth:    24,
  dither:     'tpdf',
  comingSoon:  true,
};

const FORMATS: { id: ExportFormat; label: string; hint: string }[] = [
  { id: 'wav',  label: 'WAV',  hint: 'PCM · uncompressed' },
  { id: 'flac', label: 'FLAC', hint: 'Lossless compressed' },
  { id: 'mp3',  label: 'MP3',  hint: 'Lossy · streaming' },
  { id: 'aiff', label: 'AIFF', hint: 'PCM · Apple' },
  { id: 'ogg',  label: 'OGG',  hint: 'Vorbis · open' },
];

const SAMPLE_RATES: SampleRate[] = [44100, 48000, 88200, 96000, 192000];
const BIT_DEPTHS:   BitDepth[]   = [16, 24, 32];
const DITHER_MODES: { id: DitherMode; label: string; hint: string }[] = [
  { id: 'none',   label: 'None',   hint: 'No noise added' },
  { id: 'tpdf',   label: 'TPDF',   hint: 'Standard noise dither' },
  { id: 'shaped', label: 'Shaped', hint: 'Noise-shaped (recommended)' },
];

function ChipRow<T extends string | number>({
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

export interface ExportParameterPanelProps {
  /** Optional — show the target summary from external state. */
  targetLufs?: number;
  targetTp?:   number;
  /** Click → export.  No-op in the shell. */
  onExport?:   () => void;
}

export function ExportParameterPanel(props: ExportParameterPanelProps = {}) {
  const [s, setS] = React.useState<ExportState>(DEFAULTS);
  const update = <K extends keyof ExportState>(k: K) => (v: ExportState[K]) => {
    setS((prev) => ({ ...prev, [k]: v }));
  };

  const tLufs = props.targetLufs ?? -14;
  const tTp   = props.targetTp ?? -1;

  return (
    <>
      <LouiSectionCard title="Format">
        <ChipRow
          options={FORMATS}
          active={s.format}
          onChange={update('format')}
          ariaLabel="Export format"
        />
      </LouiSectionCard>

      <LouiSectionCard title="Sample Rate">
        <ChipRow
          options={SAMPLE_RATES.map((r) => ({
            id: r,
            label: `${(r / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} kHz`,
            hint: r === 48000 ? 'Default' : r >= 88200 ? 'Hi-res' : '',
          }))}
          active={s.sampleRate}
          onChange={update('sampleRate')}
          ariaLabel="Sample rate"
        />
      </LouiSectionCard>

      <LouiSectionCard title="Bit Depth">
        <ChipRow
          options={BIT_DEPTHS.map((d) => ({
            id: d,
            label: `${d}-bit`,
            hint: d === 16 ? 'CD / streaming' : d === 24 ? 'Default' : 'Float (no clipping)',
          }))}
          active={s.bitDepth}
          onChange={update('bitDepth')}
          ariaLabel="Bit depth"
        />
      </LouiSectionCard>

      <LouiSectionCard
        title="Dither"
        trailing={
          <LouiTogglePill
            label=""
            value={s.dither !== 'none'}
            onChange={(v) => update('dither')(v ? 'tpdf' : 'none')}
          />
        }
      >
        <ChipRow
          options={DITHER_MODES}
          active={s.dither}
          onChange={update('dither')}
          ariaLabel="Dither mode"
        />
        {s.bitDepth === 32 && s.dither !== 'none' && (
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

      {s.comingSoon ? (
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
          Live binding lands in M3-P-NEXT-5.
        </span>
      ) : (
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
      )}
    </>
  );
}
