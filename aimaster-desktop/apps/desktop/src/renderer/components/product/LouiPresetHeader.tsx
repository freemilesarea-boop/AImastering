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
import { LOUI_PRESETS, isStreamingSafe, type LouiPreset } from '../../audio/presets/loui-presets.js';

const MINUS = '−';
function lufsLabel(v: number): string { return `${MINUS}${Math.abs(v).toFixed(0)} LUFS`; }
function tpLabel(v: number): string { return `${MINUS}${Math.abs(v).toFixed(1)} dBTP`; }
const TONE_LABEL: Record<LouiPreset['tonalBalance'], string> = {
  neutral: 'Neutral', warm: 'Warm', bright: 'Bright', punchy: 'Punchy',
};

export interface PresetTarget {
  id: string;
  label: string;
  /** Integrated LUFS target (display string, e.g. "−14 LUFS"). */
  lufs: string;
  /** True peak ceiling (display string, e.g. "−1 dBTP"). */
  truePeak: string;
  /** Optional tone hint (e.g. "Bright" / "Warm") shown under the label. */
  tone?: string;
  /** Tuned for AI-generated music — shows an "AI" badge. */
  aiOptimized?: boolean;
  /** Loudness won't be heavily turned down by platform normalization. */
  streamingSafe?: boolean;
  /** One-line description (chip title / tooltip). */
  description?: string;
}

/** Map the official Loui preset lineup → compact header targets. */
export function presetTargetsFromLineup(presets: readonly LouiPreset[] = LOUI_PRESETS): PresetTarget[] {
  return presets.map((p) => {
    const lim = p.tuning.limiter?.parameters ?? {};
    const lufs = typeof lim['targetLufs'] === 'number' ? (lim['targetLufs'] as number) : -14;
    const tp = typeof lim['ceilingDbtp'] === 'number' ? (lim['ceilingDbtp'] as number) : -1;
    return {
      id: p.id,
      label: p.displayName,
      lufs: lufsLabel(lufs),
      truePeak: tpLabel(tp),
      tone: TONE_LABEL[p.tonalBalance],
      aiOptimized: p.aiOptimized,
      streamingSafe: isStreamingSafe(p),
      description: p.description,
    };
  });
}

/** Built-in target list — sourced from the official preset lineup. */
export const LOUI_PRESET_TARGETS: PresetTarget[] = presetTargetsFromLineup();

export interface LouiPresetHeaderProps {
  /** Active preset id. */
  activeId?: string;
  /** Click handler — the row only mutates local visual state. */
  onTargetChange?: (id: string) => void;
  /** Override the preset list (e.g. for tests / storybook). */
  presets?: PresetTarget[];
  /** When provided, renders a "Browse Presets" button that opens the
   *  full category-grouped preset browser. */
  onBrowse?: () => void;
}

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span style={{
      fontFamily: typography.family.sans,
      fontSize: 8,
      fontWeight: typography.weight.semi,
      letterSpacing: '0.08em',
      lineHeight: 1,
      padding: '2px 4px',
      borderRadius: 4,
      color,
      border: `1px solid ${color}`,
      opacity: 0.85,
    }}>
      {label}
    </span>
  );
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
      title={preset.description ?? preset.label}
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
      {(preset.aiOptimized || preset.streamingSafe) && (
        <div style={{ position: 'absolute', bottom: 6, right: 6, display: 'flex', gap: 4 }}>
          {preset.aiOptimized && <Badge label="AI" color={accent} />}
          {preset.streamingSafe && <Badge label="SAFE" color={meter.safe.foreground} />}
        </div>
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
        position: 'relative',
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
      {/* Loudness spectrum cue — safe (green) → loud (amber) → aggressive
          (red).  A subtle bottom strip framing the streaming targets. */}
      <div aria-hidden style={{
        position: 'absolute',
        left: 0, right: 0, bottom: 0,
        height: 2,
        background: 'linear-gradient(90deg, rgba(16,185,129,0.55) 0%, rgba(245,158,11,0.55) 55%, rgba(239,68,68,0.55) 100%)',
        opacity: 0.7,
      }} />
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

      {props.onBrowse && (
        <button
          type="button"
          onClick={props.onBrowse}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            height: 56,
            paddingInline: space['3'],
            borderRadius: radius.chip,
            border: `1px solid ${surface.border}`,
            background: surface.well,
            color: text.secondary,
            cursor: 'pointer',
            fontFamily: typography.family.sans,
            fontSize: typography.size.sm,
            fontWeight: typography.weight.medium,
            flexShrink: 0,
            transition: 'background 120ms ease-out, color 120ms ease-out',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = surface.overlay; e.currentTarget.style.color = text.primary; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = surface.well; e.currentTarget.style.color = text.secondary; }}
        >
          <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="2.5" width="5" height="5" rx="1" />
            <rect x="9" y="2.5" width="5" height="5" rx="1" />
            <rect x="2" y="8.5" width="5" height="5" rx="1" />
            <rect x="9" y="8.5" width="5" height="5" rx="1" />
          </svg>
          Browse Presets
        </button>
      )}
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
