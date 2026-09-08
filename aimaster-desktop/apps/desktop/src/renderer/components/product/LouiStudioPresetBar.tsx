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
  /**
   * Set every module to its recommended starting point.
   *
   * Separate from the presets, and first in the row, because it answers a
   * different question. A preset is "make it sound like X"; this is "I have
   * never mastered anything — put everything somewhere sensible so I can
   * hear what each control does from a working position instead of from
   * neutral."
   */
  onApplyRecommended?: (() => void) | undefined;
  /** What was measured about the loaded song, or null before analysis. */
  analysisSummary?: string | null | undefined;
  /** How many modules the measurement moved off the common value. */
  adaptedCount?: number | undefined;
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

        {props.onApplyRecommended && (
          <button
            type="button"
            onClick={props.onApplyRecommended}
            onPointerEnter={() => setHovered('__recommended__')}
            onPointerLeave={() => setHovered(null)}
            style={{
              appearance: 'none',
              cursor: 'pointer',
              paddingInline: space['3'],
              paddingBlock: 3,
              borderRadius: radius.chip,
              border: '1px solid rgba(52,211,153,0.55)',
              background: 'rgba(52,211,153,0.14)',
              color: '#34D399',
              fontFamily: typography.family.sans,
              fontSize: typography.size.xs,
              fontWeight: typography.weight.medium,
              whiteSpace: 'nowrap',
            }}
          >
            {props.adaptedCount ? '이 곡 맞춤 설정 전체 적용' : '초심자 추천 설정 전체 적용'}
          </button>
        )}

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

      {/* What the engine measured about this song. Shown as numbers rather
          than a verdict: they are the reason the settings below differ from
          the book values, and a user who can read them can argue with them. */}
      {props.analysisSummary && (
        <span style={{
          fontFamily: typography.family.mono,
          fontSize: typography.size.xs,
          color: text.muted,
          lineHeight: 1.6,
        }}>
          <span style={{ fontFamily: typography.family.sans, color: '#34D399' }}>
            {props.adaptedCount ? `곡 분석 완료 · ${props.adaptedCount}개 모듈 맞춤` : '곡 분석'}
          </span>
          {'  '}
          {props.analysisSummary}
        </span>
      )}

      {/* One line about whatever is under the cursor, or what was applied.
          A grid of unlabelled chips is a guessing game. */}
      <span style={{
        fontFamily: typography.family.sans,
        fontSize: typography.size.xs,
        color: text.muted,
        lineHeight: 1.6,
        minHeight: '2.6em',
      }}>
        {focus === '__recommended__'
          ? (
            <>
              <strong style={{ color: text.secondary }}>초심자 추천 설정</strong>
              {' — '}
              모든 모듈을 요즘 상업 음원의 일반적인 값으로 한 번에 맞춥니다. 마스터에 쓰지 않는 기능(리버브·딜레이·테이프)은 꺼진 채로 둡니다.
              {' '}각 모듈을 열면 그 값을 왜 그렇게 잡았는지 설명이 있습니다.
            </>
          )
          : focusPreset && focusKo
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
