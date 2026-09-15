// LouiAlbumPresetBar — the last decision before rendering a batch.
//
// The workflow this belongs to: import twenty songs, open each one in the
// Studio and shape it, save, then come back here, pick ONE finishing preset,
// and render the lot. This bar is that last pick.
//
// It is deliberately a single choice for the whole queue rather than a
// per-song one. A record is supposed to come out at one loudness, and
// twenty independent loudness choices is twenty chances for one track to sit
// 3 LU below the rest. Per-song intent is not lost — it is carried by each
// song's saved Studio settings, which win over anything chosen here.
//
// That rule is the thing a user has to be able to see, so the bar says in
// words how many songs are protected rather than leaving it to be
// discovered on playback.

import React from 'react';
import { LOUI_PRESETS, type LouiPreset } from '../../audio/presets/loui-presets.js';
import { presetGlossaryFor } from '../../audio/presets/preset-glossary.js';
import { surface, text, typography, space, radius } from '../../theme/loui-theme.js';

export interface LouiAlbumPresetBarProps {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** How many queued songs have saved Studio settings. */
  savedCount: number;
  /** How many songs are in the queue at all. */
  totalCount: number;
  disabled?: boolean | undefined;
}

/**
 * Which presets make sense as a finishing pass.
 *
 * The repair presets (`ai-special`) are per-song work — they answer a defect
 * in one recording, so applying one to a whole queue would treat every song
 * as if it had that defect. They belong in the Studio, and they are left out
 * here on purpose.
 */
const ALBUM_CATEGORIES: ReadonlyArray<LouiPreset['category']> = ['core', 'character'];

export function LouiAlbumPresetBar(props: LouiAlbumPresetBarProps) {
  const items = LOUI_PRESETS.filter((p) => ALBUM_CATEGORIES.includes(p.category));
  const selected = props.selectedId
    ? LOUI_PRESETS.find((p) => p.id === props.selectedId)
    : undefined;
  const ko = selected ? presetGlossaryFor(selected.id) : undefined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space['2'] }}>
      <p style={{
        fontFamily: typography.family.sans,
        fontSize: 10,
        letterSpacing: '0.16em',
        textTransform: 'uppercase',
        color: text.muted,
        margin: 0,
      }}>
        최종 마스터링
        <span style={{ letterSpacing: 'normal', textTransform: 'none' }}>
          {'  ·  전곡 공통'}
        </span>
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: space['1'] }}>
        <Chip
          label="사용 안 함"
          on={props.selectedId === null}
          disabled={props.disabled}
          onClick={() => props.onSelect(null)}
        />
        {items.map((p) => (
          <Chip
            key={p.id}
            label={presetGlossaryFor(p.id)?.ko ?? p.displayName}
            accent={p.accent}
            on={props.selectedId === p.id}
            disabled={props.disabled}
            onClick={() => props.onSelect(p.id)}
          />
        ))}
      </div>

      <p style={{
        fontFamily: typography.family.sans,
        fontSize: typography.size.xs,
        color: text.muted,
        lineHeight: 1.6,
        margin: 0,
      }}>
        {selected && ko
          ? <>{ko.plain}</>
          : '전곡에 똑같이 적용할 마무리 설정입니다. 고르지 않으면 위의 빠른 모드 설정만 적용됩니다.'}
      </p>

      {/* The layering rule, stated rather than discovered. */}
      {props.savedCount > 0 && (
        <p style={{
          fontFamily: typography.family.sans,
          fontSize: typography.size.xs,
          color: text.tertiary,
          lineHeight: 1.6,
          margin: 0,
          paddingInline: space['2'],
          paddingBlock: space['1'],
          background: surface.well,
          borderRadius: radius.chip,
          border: `1px solid ${surface.border}`,
        }}>
          {props.savedCount}곡은 스튜디오에서 저장한 설정이 있습니다.
          {' '}<strong style={{ color: text.secondary }}>직접 조정한 모듈은 위 프리셋이 덮어쓰지 않습니다.</strong>
          {' '}나머지 모듈에만 적용됩니다.
          {props.totalCount > props.savedCount && (
            <> 저장 기록이 없는 {props.totalCount - props.savedCount}곡은 프리셋이 전부 적용됩니다.</>
          )}
        </p>
      )}
    </div>
  );
}

function Chip(props: {
  label: string;
  accent?: string | undefined;
  on: boolean;
  disabled?: boolean | undefined;
  onClick: () => void;
}) {
  const accent = props.accent ?? text.secondary;
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      aria-pressed={props.on}
      className="no-drag"
      style={{
        appearance: 'none',
        cursor: props.disabled ? 'not-allowed' : 'pointer',
        opacity: props.disabled ? 0.5 : 1,
        paddingInline: space['2'],
        paddingBlock: 3,
        borderRadius: radius.chip,
        border: `1px solid ${props.on ? accent : surface.border}`,
        background: props.on ? `${accent}22` : surface.well,
        color: props.on ? accent : text.tertiary,
        fontFamily: typography.family.sans,
        fontSize: typography.size.xs,
        whiteSpace: 'nowrap',
      }}
    >
      {props.label}
    </button>
  );
}
