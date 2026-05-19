// LouiPresetHeader — streaming-target preset row.
//
// Visual layout (left → right):
//   • Section label ("TARGET")
//   • Target chips (one per streaming platform / use case)
//   • Optional secondary control: ceiling / true-peak readout
//
// All chips are UI shells — selecting one updates local state and fires
// `onTargetChange(id)`.  Real preset wiring (style + numeric target)
// happens elsewhere and lives outside this component for M3-P-NEXT-3.

import React from 'react';
import { surface, text, typography, radius, space, meter } from '../../theme/loui-theme.js';

export interface PresetTarget {
  id: string;
  label: string;
  /** Integrated LUFS target (display string, e.g. "−14 LUFS"). */
  lufs: string;
  /** True peak ceiling (display string, e.g. "−1 dBTP"). */
  truePeak: string;
  /** Optional tone hint (e.g. "Bright" / "Warm") shown under the label. */
  tone?: string;
}

/** Built-in target list — copy is editorial, UI-only. */
export const LOUI_PRESET_TARGETS: PresetTarget[] = [
  { id: 'streaming-loud',  label: 'Streaming Loud',  lufs: '−14 LUFS', truePeak: '−1.0 dBTP', tone: 'Balanced' },
  { id: 'streaming-warm',  label: 'Streaming Warm',  lufs: '−16 LUFS', truePeak: '−1.0 dBTP', tone: 'Warm' },
  { id: 'youtube-music',   label: 'YouTube Music',   lufs: '−14 LUFS', truePeak: '−1.0 dBTP' },
  { id: 'spotify',         label: 'Spotify',         lufs: '−14 LUFS', truePeak: '−1.0 dBTP' },
  { id: 'apple-music',     label: 'Apple Music',     lufs: '−16 LUFS', truePeak: '−1.0 dBTP' },
  { id: 'club',            label: 'Club / Loud',     lufs: '−9 LUFS',  truePeak: '−0.8 dBTP', tone: 'Pumped' },
  { id: 'ai-clean',        label: 'AI Clean',        lufs: '−14 LUFS', truePeak: '−1.5 dBTP', tone: 'Stable' },
];

export interface LouiPresetHeaderProps {
  /** Active preset id. */
  activeId?: string;
  /** Click handler — the row only mutates local visual state. */
  onTargetChange?: (id: string) => void;
  /** Override the preset list (e.g. for tests / storybook). */
  presets?: PresetTarget[];
}

function PresetChip({
  preset,
  active,
  onClick,
}: {
  preset: PresetTarget;
  active: boolean;
  onClick?: () => void;
}) {
  const [hover, setHover] = React.useState(false);
  const accent = meter.accent.foreground;
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 2,
        height: 56,
        paddingInline: space['3'],
        paddingBlock: space['2'],
        borderRadius: radius.chip,
        border: `1px solid ${active ? accent : surface.border}`,
        background: active
          ? 'rgba(167,139,250,0.10)'
          : hover ? surface.well : 'transparent',
        cursor: 'pointer',
        transition: 'background 120ms ease-out, border-color 120ms ease-out',
        textAlign: 'left',
        minWidth: 132,
        flexShrink: 0,
      }}
    >
      <span style={{
        fontFamily: typography.family.sans,
        fontSize: typography.size.sm,
        fontWeight: typography.weight.semi,
        color: active ? text.primary : text.secondary,
        lineHeight: 1.2,
      }}>
        {preset.label}
      </span>
      <span style={{
        fontFamily: typography.family.mono,
        fontSize: typography.size.xs,
        color: active ? text.tertiary : text.muted,
        letterSpacing: '0.02em',
      }}>
        {preset.lufs} · {preset.truePeak}
      </span>
      {preset.tone && (
        <span style={{
          position: 'absolute',
          top: 6,
          right: 6,
          fontFamily: typography.family.sans,
          fontSize: 9,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: active ? accent : text.muted,
        }}>
          {preset.tone}
        </span>
      )}
    </button>
  );
}

export function LouiPresetHeader(props: LouiPresetHeaderProps) {
  const presets = props.presets ?? LOUI_PRESET_TARGETS;
  const [internalActive, setInternalActive] = React.useState<string>(
    props.activeId ?? presets[0]?.id ?? '',
  );
  const active = props.activeId ?? internalActive;
  const onPick = (id: string) => {
    setInternalActive(id);
    props.onTargetChange?.(id);
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: space['3'],
        height: 80,
        paddingInline: space['4'],
        paddingBlock: space['3'],
        background: surface.background,
        borderBottom: `1px solid ${surface.border}`,
        flexShrink: 0,
        overflowX: 'auto',
      }}
    >
      <div style={{
        fontFamily: typography.family.sans,
        fontSize: typography.size.xs,
        fontWeight: typography.weight.medium,
        letterSpacing: '0.16em',
        textTransform: 'uppercase',
        color: text.muted,
        flexShrink: 0,
        paddingRight: space['2'],
      }}>
        Target
      </div>
      <div style={{
        display: 'flex',
        alignItems: 'stretch',
        gap: space['2'],
        flex: 1,
      }}>
        {presets.map((p) => (
          <PresetChip
            key={p.id}
            preset={p}
            active={p.id === active}
            onClick={() => onPick(p.id)}
          />
        ))}
      </div>
    </div>
  );
}
