// LouiPresetBrowser — category-grouped preset browser (M2-PRESET-TUNING).
//
// The richer counterpart to the compact LouiPresetHeader strip: presets
// grouped by category (Core / Character / AI Special), each card showing
// the loudness target, tone, recommended-genre hint, a short description,
// and badges (AI-optimized / streaming-safe / recommended / last-used).
//
// Pure presentational component — selection is delegated via onSelect.

import React from 'react';
import { surface, text, typography, radius, space, meter } from '../../theme/loui-theme.js';
import {
  LOUI_PRESETS,
  PRESET_CATEGORY_ORDER,
  PRESET_CATEGORY_LABEL,
  isStreamingSafe,
  type LouiPreset,
  type PresetCategory,
} from '../../audio/presets/loui-presets.js';

const MINUS = '−';
function lufsText(p: LouiPreset): string {
  const v = (p.tuning.limiter?.parameters?.['targetLufs'] as number | undefined) ?? -14;
  return `${MINUS}${Math.abs(v).toFixed(0)} LUFS`;
}
const TONE_LABEL: Record<LouiPreset['tonalBalance'], string> = {
  neutral: 'Neutral', warm: 'Warm', bright: 'Bright', punchy: 'Punchy',
};

export interface LouiPresetBrowserProps {
  activeId?: string;
  onSelect?: (id: string) => void;
  /** Preset id to flag with a "Recommended" badge. */
  recommendedId?: string;
  /** Preset id last used (restored from storage) — flagged "Last used". */
  lastUsedId?: string;
  /** Override the preset list (tests / storybook). */
  presets?: readonly LouiPreset[];
}

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span style={{
      fontFamily: typography.family.sans,
      fontSize: 9,
      fontWeight: typography.weight.semi,
      letterSpacing: '0.06em',
      lineHeight: 1,
      padding: '3px 5px',
      borderRadius: 4,
      color,
      border: `1px solid ${color}`,
    }}>
      {label}
    </span>
  );
}

function PresetCard({
  preset, active, recommended, lastUsed, onClick,
}: {
  preset: LouiPreset;
  active: boolean;
  recommended: boolean;
  lastUsed: boolean;
  onClick?: () => void;
}) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        width: 220,
        padding: space['3'],
        textAlign: 'left',
        borderRadius: radius.panel,
        border: `1px solid ${active ? preset.accent : surface.border}`,
        background: active ? 'rgba(255,255,255,0.04)' : hover ? surface.well : surface.panel,
        cursor: 'pointer',
        transition: 'background 120ms ease-out, border-color 120ms ease-out',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: space['2'] }}>
        <span aria-hidden style={{ width: 8, height: 8, borderRadius: 999, background: preset.accent, flexShrink: 0 }} />
        <span style={{
          fontFamily: typography.family.sans, fontSize: typography.size.sm,
          fontWeight: typography.weight.semi, color: text.primary,
        }}>
          {preset.displayName}
        </span>
      </div>
      <span style={{
        fontFamily: typography.family.mono, fontSize: typography.size.xs,
        color: text.tertiary, letterSpacing: '0.02em',
      }}>
        {lufsText(preset)} · {TONE_LABEL[preset.tonalBalance]}
      </span>
      <span style={{
        fontFamily: typography.family.sans, fontSize: typography.size.xs,
        color: text.muted, lineHeight: 1.35, minHeight: 32,
      }}>
        {preset.description}
      </span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 2 }}>
        {recommended && <Badge label="Recommended" color={meter.accent.foreground} />}
        {lastUsed && <Badge label="Last used" color={text.tertiary} />}
        {preset.aiOptimized && <Badge label="AI optimized" color={preset.accent} />}
        {isStreamingSafe(preset) && <Badge label="Streaming-safe" color={meter.safe.foreground} />}
        {preset.monoSafe && <Badge label="Mono-safe" color={text.muted} />}
      </div>
    </button>
  );
}

export function LouiPresetBrowser(props: LouiPresetBrowserProps) {
  const presets = props.presets ?? LOUI_PRESETS;
  const grouped: Record<PresetCategory, LouiPreset[]> = { core: [], character: [], 'ai-special': [] };
  for (const p of presets) grouped[p.category].push(p);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: space['4'],
      padding: space['4'], background: surface.background,
    }}>
      {PRESET_CATEGORY_ORDER.map((cat) => {
        const list = grouped[cat];
        if (list.length === 0) return null;
        return (
          <div key={cat} style={{ display: 'flex', flexDirection: 'column', gap: space['2'] }}>
            <div style={{
              fontFamily: typography.family.sans, fontSize: typography.size.xs,
              fontWeight: typography.weight.medium, letterSpacing: '0.16em',
              textTransform: 'uppercase', color: text.muted,
            }}>
              {PRESET_CATEGORY_LABEL[cat]}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: space['3'] }}>
              {list.map((p) => (
                <PresetCard
                  key={p.id}
                  preset={p}
                  active={p.id === props.activeId}
                  recommended={p.id === props.recommendedId}
                  lastUsed={p.id === props.lastUsedId}
                  onClick={() => props.onSelect?.(p.id)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
