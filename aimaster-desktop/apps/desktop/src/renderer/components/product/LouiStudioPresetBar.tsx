// LouiStudioPresetBar — the starting points, above the rack.
//
// The Studio is twenty-three modules and two hundred parameters. For an
// engineer that is the product; for someone taking a course it is a wall.
// A preset is where they start, so the bar sits above the chain rather than
// behind a menu, and each chip carries its Korean name with one sentence of
// what picking it does.
//
// Applying a preset is a normal edit: it writes parameters and bypasses
// into the same state a slider writes, so it is heard immediately, it can
// be undone by moving anything, and nothing about it is a separate mode.

import React, { useState } from 'react';
import { LOUI_PRESETS, type LouiPreset } from '../../audio/presets/loui-presets.js';
import { presetGlossaryFor } from '../../audio/presets/preset-glossary.js';
import { surface, text, typography, space, radius } from '../../theme/loui-theme.js';

export interface LouiStudioPresetBarProps {
  /** Id of the preset last applied, for the active mark. */
  appliedId: string | null;
  onApply: (preset: LouiPreset) => void;
}

/** Categories, in the order a person picks from them. */
const GROUPS: Array<{ key: LouiPreset['category']; label: string; ko: string }> = [
  { key: 'ai-special', label: 'AI fixes', ko: 'AI 음원 문제 해결' },
  { key: 'core', label: 'Core', ko: '기본' },
  { key: 'character', label: 'Character', ko: '색깔' },
];

export function LouiStudioPresetBar(props: LouiStudioPresetBarProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const focus = hovered ?? props.appliedId;
  const focusPreset = focus ? LOUI_PRESETS.find((p) => p.id === focus) : undefined;
  const focusKo = focusPreset ? presetGlossaryFor(focusPreset.id) : undefined;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: space['2'],
      paddingInline: space['4'],
      paddingBlock: space['3'],
      background: surface.panel,
      border: `1px solid ${surface.border}`,
      borderRadius: radius.panel,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: space['3'], flexWrap: 'wrap' }}>
        <span style={{
          fontFamily: typography.family.sans,
          fontSize: typography.size.xs,
          color: text.muted,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
        }}>
          Presets
          <span style={{ letterSpacing: 'normal', textTransform: 'none' }}>{'  프리셋'}</span>
        </span>

        {GROUPS.map((g) => {
          const items = LOUI_PRESETS.filter((p) => p.category === g.key);
          if (items.length === 0) return null;
          return (
            <div key={g.key} style={{ display: 'flex', alignItems: 'center', gap: space['1'], flexWrap: 'wrap' }}>
              <span style={{
                fontFamily: typography.family.sans,
                fontSize: 9,
                color: text.disabled,
                whiteSpace: 'nowrap',
                marginRight: 2,
              }}>
                {g.ko}
              </span>
              {items.map((p) => {
                const ko = presetGlossaryFor(p.id);
                const on = props.appliedId === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => props.onApply(p)}
                    onPointerEnter={() => setHovered(p.id)}
                    onPointerLeave={() => setHovered(null)}
                    aria-pressed={on}
                    style={{
                      appearance: 'none',
                      cursor: 'pointer',
                      paddingInline: space['2'],
                      paddingBlock: 3,
                      borderRadius: radius.chip,
                      border: `1px solid ${on ? p.accent : surface.border}`,
                      background: on ? `${p.accent}22` : surface.well,
                      color: on ? p.accent : text.tertiary,
                      fontFamily: typography.family.sans,
                      fontSize: typography.size.xs,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {ko?.ko ?? p.displayName}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* One line about whatever is under the cursor, or what was applied.
          A grid of unlabelled chips is a guessing game. */}
      <span style={{
        fontFamily: typography.family.sans,
        fontSize: typography.size.xs,
        color: text.muted,
        lineHeight: 1.6,
        minHeight: '2.6em',
      }}>
        {focusPreset && focusKo
          ? (
            <>
              <strong style={{ color: text.secondary }}>
                {focusPreset.displayName}
                {'  '}
                {focusKo.ko}
              </strong>
              {' — '}
              {focusKo.plain}
            </>
          )
          : '프리셋을 고르면 여러 모듈이 한 번에 설정됩니다. 고른 뒤에도 각 모듈을 자유롭게 수정할 수 있습니다.'}
      </span>
    </div>
  );
}
